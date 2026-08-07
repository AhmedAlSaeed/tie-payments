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
  ChargeInvoice,
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
  findCustomerCredit(
    merchantId: string,
    environment: string,
    customerId: string,
  ): Promise<number | undefined>;
  transition(
    record: InvoiceRecord,
    event: OutboxEventData | null,
    opts?: { customer?: { id: string; creditBalance: number } },
  ): Promise<void>;
  insertEvent(record: InvoiceRecord, event: OutboxEventData): Promise<void>;
}

/**
 * Normalized gateway charge outcome surfaced to the service. The driver seam
 * (T03) + `PaymentService.createPayment` are injected (pays the payment row and
 * routes to a driver); the service only sees this closed outcome set.
 */
export interface GatewayOutcome {
  kind: "succeeded" | "requires_action" | "gateway_error";
  /** Payment resource status when terminal/actionable (`succeeded`/`requires_action`). */
  status?: string;
  /** The `action` a payer must perform for `requires_action` (3DS redirect / QR). */
  action?: { kind: string; [k: string]: unknown };
  /** Set on `gateway_error`; drives dunning (T06) branching. */
  retryable?: boolean;
  code?: string;
  message?: string;
}

export type ChargeViaGateway = (input: {
  ctx: MerchantContext;
  method: string;
  amountMinor: number;
  currency: string;
}) => Promise<GatewayOutcome>;

interface CustomerCredit {
  id: string;
  creditBalance: number;
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
    private readonly chargeGateway: ChargeViaGateway,
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

  /**
   * T2 — collect money on an OPEN `charge_automatically` invoice. Applies the
   * customer's credit balance first (T05), then charges the routed gateway for
   * the remainder; `succeeded` moves `amount_paid` (+ `paid` at zero, overpay →
   * credit), `requires_action` and gateway failures keep the invoice `open`.
   */
  async charge(ctx: MerchantContext, id: string, body: ChargeInvoice): Promise<InvoiceResource> {
    const record = await this.store.findById(ctx.merchantId, ctx.environment, id);
    if (!record) {
      throw problem("resource_not_found", "Invoice not found.");
    }
    if (record.collection_method !== "charge_automatically") {
      // send_invoice is the HPP / payment-link rail: charged via hosted_invoice_url.
      throw problem(
        "conflict",
        "send_invoice invoices are paid via hosted_invoice_url; direct charges are not allowed.",
      );
    }
    if (record.status !== "open") {
      throw problem("conflict", "Only open invoices can be charged.");
    }

    const remaining = record.amount_due - record.amount_paid;
    if (remaining <= 0) {
      throw problem("conflict", "Invoice has no remaining balance to charge.");
    }

    // T05 credit application: reduce the amount charged by the customer's
    // available credit (never charging more than the requested amount).
    const creditAvailable = record.customerId
      ? ((await this.store.findCustomerCredit(
          ctx.merchantId,
          ctx.environment,
          record.customerId,
        )) ?? 0)
      : 0;
    const requested = body.amount ?? remaining;
    const creditApplied = Math.min(creditAvailable, requested);
    const gatewayAmount = requested - creditApplied;

    // Entirely covered by credit — settle with no gateway charge.
    if (gatewayAmount <= 0) {
      const next = this.applyPaid(record, creditApplied, 0);
      const resource = this.toResource(next);
      await this.store.transition(
        next,
        { type: "invoice.paid", snapshot: resource },
        { customer: { id: record.customerId!, creditBalance: creditAvailable - creditApplied } },
      );
      return resource;
    }

    const outcome = await this.chargeGateway({
      ctx,
      method: body.method,
      amountMinor: gatewayAmount,
      currency: record.currency,
    });

    if (outcome.kind === "requires_action") {
      // 3DS / QR sandbox completion lands via a later webhook (T7); here just
      // persist the payment and surface the action. The invoice stays open.
      const snapshot = {
        ...this.toResource(record),
        payment_action: { kind: outcome.action?.kind, action: outcome.action },
      } as InvoiceResource;
      await this.store.insertEvent(record, { type: "invoice.payment_action_required", snapshot });
      return this.toResource(record);
    }

    if (outcome.kind === "gateway_error") {
      const snapshot = {
        ...this.toResource(record),
        payment_failure: {
          retryable: outcome.retryable ?? false,
          code: outcome.code,
          message: outcome.message,
        },
      } as InvoiceResource;
      await this.store.insertEvent(record, { type: "invoice.payment_failed", snapshot });
      return this.toResource(record);
    }

    // succeeded — move amount_paid; close to `paid` at zero, return overpay to credit.
    const next = this.applySuccess(record, creditApplied, gatewayAmount);
    const paidOut = next.status === "paid";
    const overpayCredit = next.amount_overpaid;
    const customer: CustomerCredit = {
      id: record.customerId!,
      creditBalance: creditAvailable - creditApplied + overpayCredit,
    };
    const event: OutboxEventData | null = paidOut
      ? { type: "invoice.paid", snapshot: this.toResource(next) }
      : null;
    await this.store.transition(next, event, { customer });
    return this.toResource(next);
  }

  /** T2 — OPEN → voided; sets `voided_at`; emits `invoice.voided`. */
  async voidInvoice(ctx: MerchantContext, id: string): Promise<InvoiceResource> {
    const record = await this.requireOpen(ctx, id);
    const next: InvoiceRecord = {
      ...record,
      status: "voided",
      status_transitions: {
        ...record.status_transitions,
        voided_at: new Date().toISOString(),
      },
    };
    await this.store.transition(next, { type: "invoice.voided", snapshot: this.toResource(next) });
    return this.toResource(next);
  }

  /** T2 — OPEN → uncollectible; `marked_uncollectible_at`; `invoice.marked_uncollectible`. */
  async markUncollectible(ctx: MerchantContext, id: string): Promise<InvoiceResource> {
    const record = await this.requireOpen(ctx, id);
    const next: InvoiceRecord = {
      ...record,
      status: "uncollectible",
      status_transitions: {
        ...record.status_transitions,
        marked_uncollectible_at: new Date().toISOString(),
      },
    };
    await this.store.transition(next, {
      type: "invoice.marked_uncollectible",
      snapshot: this.toResource(next),
    });
    return this.toResource(next);
  }

  /** Load an OPEN invoice; 404 when missing, 409 when not open/chargeable. */
  private async requireOpen(ctx: MerchantContext, id: string): Promise<InvoiceRecord> {
    const record = await this.store.findById(ctx.merchantId, ctx.environment, id);
    if (!record) {
      throw problem("resource_not_found", "Invoice not found.");
    }
    if (record.status !== "open") {
      throw problem("conflict", "Only open invoices can be updated by collection.");
    }
    return record;
  }

  /**
   * Recompute the money buckets after a successful charge. `creditApplied` was
   * already deducted from `amount_due` (Stripe credit-application model); the
   * gateway cash adds to `amount_paid`. `paid` when covered; the excess over
   * the reduced `amount_due` becomes `amount_overpaid` (returned as customer
   * credit). `amount_overpaid` is 0 unless the charge overpaid.
   */
  private applyPaid(
    record: InvoiceRecord,
    creditApplied: number,
    gatewayAmount: number,
  ): InvoiceRecord {
    const amountDue = Math.max(0, record.amount_due - creditApplied);
    const amountPaid = record.amount_paid + gatewayAmount;
    const overpaid = Math.max(0, amountPaid - amountDue);
    const amountRemaining = Math.max(0, amountDue - amountPaid);
    return {
      ...record,
      amount_due: amountDue,
      amount_paid: amountPaid,
      amount_remaining: amountRemaining,
      amount_overpaid: overpaid,
      status: "paid",
      status_transitions: {
        ...record.status_transitions,
        paid_at: new Date().toISOString(),
      },
    };
  }

  /** `applyPaid` alias kept as the single success-path money mover. */
  private applySuccess(
    record: InvoiceRecord,
    creditApplied: number,
    gatewayAmount: number,
  ): InvoiceRecord {
    const amountDue = Math.max(0, record.amount_due - creditApplied);
    const amountPaid = record.amount_paid + gatewayAmount;
    const fullyPaid = amountPaid >= amountDue;
    const overpaid = fullyPaid ? amountPaid - amountDue : 0;
    const amountRemaining = fullyPaid ? 0 : amountDue - amountPaid;
    return {
      ...record,
      amount_due: amountDue,
      amount_paid: amountPaid,
      amount_remaining: amountRemaining,
      amount_overpaid: overpaid,
      status: fullyPaid ? "paid" : "open",
      status_transitions: fullyPaid
        ? { ...record.status_transitions, paid_at: new Date().toISOString() }
        : record.status_transitions,
    };
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
