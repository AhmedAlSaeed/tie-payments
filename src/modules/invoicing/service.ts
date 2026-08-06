/**
 * Invoicing service — invoice lifecycle business logic (draft → finalize).
 *
 * Deliberately Elysia-free: takes a plain MerchantContext + validated body and
 * returns typed results or throws ProblemError. Persistence goes through the
 * injected `InvoiceStore` (SurrealDB repository); the default per-tenant tax
 * rate is injected via `seedTaxRate` (seed.ts) so the service stays DB- and
 * Elysia-free.
 *
 * Tax formula (T05 — Bahrain VAT 5% `inclusive`):
 *   The `unit_price` a customer pays ALREADY contains VAT. For each line:
 *     charged  = round(unit_price * quantity)          // what the customer pays
 *     lineTax  = round(charged * pct / (100 + pct))    // VAT embedded in charged
 *     net      = charged - lineTax                     // taxable base
 *   Invoice totals aggregate the net bases and the tax separately:
 *     amount_subtotal = Σ net          (pre-tax)
 *     amount_tax       = Σ lineTax     (== pct% of the taxable base ✓)
 *     amount_due       = subtotal + tax - discount      (restores inclusive charged)
 *   This keeps `amount_tax` exactly `pct%` of the (net) taxable amount while
 *   `amount_due` equals the sum the customer actually pays.
 */
import { problem } from "../../core/errors";
import type { MerchantContext } from "../../core/context";
import type {
  CreateInvoice,
  CreateInvoiceLineItem,
  InvoiceLineItem,
  InvoiceResource,
  UpdateInvoice,
} from "./model";
import type { InvoiceRecord, OutboxEventData } from "./repository";

/** Persistence seam (implemented by InvoiceRepository). */
export interface InvoiceStore {
  create(record: InvoiceRecord, event: OutboxEventData): Promise<void>;
  findById(merchantId: string, environment: string, id: string): Promise<InvoiceRecord | undefined>;
  updateDraft(record: InvoiceRecord): Promise<void>;
  deleteDraft(merchantId: string, environment: string, id: string): Promise<boolean>;
  finalize(record: InvoiceRecord, event: OutboxEventData): Promise<void>;
}

/** Default per-(merchant, env) tax rate resolver (injected from seed.ts). */
export interface TaxRate {
  percentage: number;
  inclusive: boolean;
  jurisdiction: string;
}
export type SeedTaxRate = (ctx: MerchantContext) => Promise<TaxRate>;

export class InvoiceService {
  constructor(
    private readonly store: InvoiceStore,
    private readonly seedTaxRate: SeedTaxRate,
  ) {}

  async createInvoice(ctx: MerchantContext, body: CreateInvoice): Promise<InvoiceResource> {
    const taxRate = await this.seedTaxRate(ctx);
    const id = `in_${crypto.randomUUID()}`;
    const customerId = this.normalizeCustomer(body.customer);

    const { lines, totals } = this.compute(body.line_items, taxRate);
    const record: InvoiceRecord = {
      id,
      merchantId: ctx.merchantId,
      environment: ctx.environment,
      customerId,
      status: "draft",
      currency: body.currency,
      collection_method: body.collection_method,
      lineItems: lines,
      ...totals,
      status_transitions: undefined,
      dueDate: body.due_date,
      metadata: body.metadata,
      createdAt: new Date().toISOString(),
    };

    const resource = this.toResource(record);
    const event: OutboxEventData = { type: "invoice.created", snapshot: resource };
    await this.store.create(record, event);
    return resource;
  }

  async getById(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<InvoiceResource | undefined> {
    const record = await this.store.findById(merchantId, environment, id);
    return record ? this.toResource(record) : undefined;
  }

  async updateDraft(
    ctx: MerchantContext,
    ctxId: string,
    body: UpdateInvoice,
  ): Promise<InvoiceResource> {
    const record = await this.requireDraft(ctx, ctxId);
    const taxRate = await this.seedTaxRate(ctx);

    const next: InvoiceRecord = {
      ...record,
      customerId:
        body.customer !== undefined ? this.normalizeCustomer(body.customer) : record.customerId,
      currency: body.currency ?? record.currency,
      collection_method: body.collection_method ?? record.collection_method,
      dueDate: body.due_date !== undefined ? body.due_date : record.dueDate,
      metadata: body.metadata ?? record.metadata,
    };
    if (body.line_items !== undefined) {
      const { lines, totals } = this.compute(body.line_items, taxRate);
      next.lineItems = lines;
      Object.assign(next, totals);
    }

    await this.store.updateDraft(next);
    const refreshed = await this.store.findById(ctx.merchantId, ctx.environment, ctxId);
    return refreshed ? this.toResource(refreshed) : this.toResource(next);
  }

  async deleteDraft(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const record = await this.store.findById(merchantId, environment, id);
    if (!record) {
      throw problem("resource_not_found", "Invoice not found.");
    }
    if (record.status !== "draft") {
      throw problem("conflict", "Only draft invoices can be deleted.");
    }
    await this.store.deleteDraft(merchantId, environment, id);
    return { id, deleted: true };
  }

  async finalize(ctx: MerchantContext, id: string): Promise<InvoiceResource> {
    const record = await this.store.findById(ctx.merchantId, ctx.environment, id);
    if (!record) {
      throw problem("resource_not_found", "Invoice not found.");
    }
    if (record.status !== "draft") {
      throw problem("conflict", "Only draft invoices can be finalized.");
    }
    const taxRate = await this.seedTaxRate(ctx);
    const { lines, totals } = this.compute(record.lineItems, taxRate);

    const next: InvoiceRecord = {
      ...record,
      status: "open",
      lineItems: lines,
      ...totals,
      number: this.nextInvoiceNumber(id),
      hostedInvoiceUrl: `https://pay.tie.bh/i/${id}`,
      status_transitions: { finalized_at: undefined },
    };

    const resource = this.toResource(next);
    const event: OutboxEventData = { type: "invoice.finalized", snapshot: resource };
    await this.store.finalize(next, event);

    const refreshed = await this.store.findById(ctx.merchantId, ctx.environment, id);
    return refreshed ? this.toResource(refreshed) : resource;
  }

  /** Compute per-line items + invoice totals for a set of body lines. */
  private compute(
    rawLines: CreateInvoiceLineItem[] | InvoiceLineItem[],
    taxRate: TaxRate,
  ): { lines: InvoiceLineItem[]; totals: Totals } {
    const lines: InvoiceLineItem[] = rawLines.map((raw) => {
      const description = raw.description;
      const unitPrice = raw.unit_price;
      const quantity = raw.quantity;
      const discountable = raw.discountable !== false;
      const charged = Math.round(unitPrice * quantity);

      // Inclusive default: pct is embedded; lineNet = charged - extracted tax.
      const taxAmount = roundTax((charged * taxRate.percentage) / (100 + taxRate.percentage));
      const netSubtotal = charged - taxAmount;

      return {
        id: `li_${crypto.randomUUID()}`,
        description,
        unit_price: unitPrice,
        quantity,
        subtotal: netSubtotal,
        discountable,
        taxes: [
          {
            name: "Bahrain VAT",
            percentage: taxRate.percentage,
            tax_behavior: taxRate.inclusive ? "inclusive" : "exclusive",
            taxable_amount: netSubtotal,
            amount: taxAmount,
          },
        ],
      };
    });

    const amount_subtotal = lines.reduce((sum, l) => sum + l.subtotal, 0);
    const amount_tax = lines.reduce((sum, l) => sum + taxOf(l), 0);
    const amount_discount = 0;
    const amount_shipment = 0;
    const amount_due = amount_subtotal + amount_tax - amount_discount;
    const amount_paid = 0;
    const amount_remaining = amount_due - amount_paid;
    const amount_overpaid = 0;

    return {
      lines,
      totals: {
        amount_subtotal,
        amount_tax,
        amount_discount,
        amount_shipment,
        amount_due,
        amount_paid,
        amount_remaining,
        amount_overpaid,
      },
    };
  }

  /** Load a DRAFT invoice; 404 when missing, 409 when already finalized. */
  private async requireDraft(ctx: MerchantContext, id: string): Promise<InvoiceRecord> {
    const record = await this.store.findById(ctx.merchantId, ctx.environment, id);
    if (!record) {
      throw problem("resource_not_found", "Invoice not found.");
    }
    if (record.status !== "draft") {
      throw problem("conflict", "Only draft invoices can be edited.");
    }
    return record;
  }

  private normalizeCustomer(customer?: string): string {
    if (customer) return customer.includes(":") ? customer : `customer:${customer}`;
    return `customer:${crypto.randomUUID()}`;
  }

  private nextInvoiceNumber(id: string): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const tag = (id.slice(-6) || crypto.randomUUID().slice(0, 6)).toUpperCase();
    return `INV-${stamp}${tag}`;
  }

  toResource(r: InvoiceRecord): InvoiceResource {
    return {
      id: r.id,
      object: "invoice",
      status: r.status,
      customer: r.customerId,
      number: r.number,
      currency: r.currency,
      collection_method: r.collection_method as InvoiceResource["collection_method"],
      amount_subtotal: r.amount_subtotal,
      amount_discount: r.amount_discount,
      amount_tax: r.amount_tax,
      amount_shipment: r.amount_shipment,
      amount_due: r.amount_due,
      amount_paid: r.amount_paid,
      amount_remaining: r.amount_remaining,
      amount_overpaid: r.amount_overpaid,
      line_items: r.lineItems,
      status_transitions: r.status_transitions,
      due_date: r.dueDate,
      issued_at: r.issuedAt,
      hosted_invoice_url: r.hostedInvoiceUrl,
      metadata: r.metadata,
      created: r.createdAt,
      environment: r.environment as "test" | "live",
    };
  }
}

interface Totals {
  amount_subtotal: number;
  amount_tax: number;
  amount_discount: number;
  amount_shipment: number;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  amount_overpaid: number;
}

function roundTax(n: number): number {
  return Math.round(n);
}
function taxOf(line: InvoiceLineItem): number {
  return (line.taxes ?? []).reduce((sum, t) => sum + t.amount, 0);
}
