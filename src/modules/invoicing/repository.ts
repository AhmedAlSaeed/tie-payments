/**
 * Invoicing repository — SurrealDB persistence for the invoice aggregate.
 *
 * Every write/read binds `merchant` + `environment` from the authenticated
 * request context (the F0 tenancy guarantee — the DB build does not enforce
 * write PERMISSIONS, so the query layer scopes by these two fields).
 *
 * In-transaction events (T01): `create`/`finalize` write the invoice row AND an
 * `outbox_event` row in a single multi-statement `db.query` call, which SurrealDB
 * executes atomically. `object_id` is the invoice's API id (bare, no table
 * prefix); `object` is a snapshot of the full invoice resource.
 *
 * All money is minor-units `int`. Datetimes are computed server-side
 * (`time::now()`) or bound as JS `Date` (ISO strings are not coerced).
 */
import type { Surreal } from "surrealdb";
import { recordIdOf, recordIdToString } from "../../core/records";
import type {
  InvoiceLineItem,
  InvoiceResource,
  InvoiceStatus,
  InvoiceStatusTransitions,
} from "./model";

export interface OutboxEventData {
  type: string;
  /** Full invoice resource snapshot to embed on the outbox row. */
  snapshot: InvoiceResource;
}

/** DB-mapped invoice record shape (snake_case rows → camelCase service DTO). */
export interface InvoiceRecord {
  /** API-facing id `in_<uuid>` (stored as `invoice:in_<uuid>`). */
  id: string;
  merchantId: string;
  environment: string;
  customerId?: string;
  status: InvoiceStatus;
  number?: string;
  currency: string;
  collection_method: string;
  amount_subtotal: number;
  amount_discount: number;
  amount_tax: number;
  amount_shipment: number;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  amount_overpaid: number;
  lineItems: InvoiceLineItem[];
  status_transitions?: InvoiceStatusTransitions;
  dueDate?: string;
  issuedAt?: string;
  hostedInvoiceUrl?: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export class InvoiceRepository {
  constructor(private readonly db: Surreal) {}

  /** Insert a DRAFT invoice + `invoice.created` outbox row (atomic). */
  async create(record: InvoiceRecord, event: OutboxEventData): Promise<void> {
    await this.db.query(
      `INSERT INTO invoice {
         id: $id,
         merchant: $merchant,
         environment: $environment,
         customer: $customer,
         status: $status,
         currency: $currency,
         collection_method: $collectionMethod,
         amount_subtotal: $amountSubtotal,
         amount_discount: $amountDiscount,
         amount_tax: $amountTax,
         amount_shipment: $amountShipment,
         amount_due: $amountDue,
         amount_paid: $amountPaid,
         amount_remaining: $amountRemaining,
         amount_overpaid: $amountOverpaid,
         due_date: $dueDate,
         line_items: $lineItems,
         status_transitions: $statusTransitions,
         metadata: $metadata
       };
       INSERT INTO outbox_event {
         merchant: $merchant,
         environment: $environment,
         type: $eventType,
         object_type: "invoice",
         object_id: $eventObjectId,
         object: $eventObject,
         window: time::now()
       }`,
      {
        ...this.params(record),
        eventType: event.type,
        eventObjectId: record.id,
        eventObject: event.snapshot,
      },
    );
  }

  /** Fetch a single invoice scoped to merchant+environment; undefined if absent. */
  async findById(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<InvoiceRecord | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM invoice WHERE id = type::record('invoice', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapRow(row) : undefined;
  }

  /** Replace a DRAFT's mutable fields (line items + totals + headers). */
  async updateDraft(record: InvoiceRecord): Promise<void> {
    await this.db.query(
      `UPDATE invoice SET
         customer = $customer,
         currency = $currency,
         collection_method = $collectionMethod,
         amount_subtotal = $amountSubtotal,
         amount_discount = $amountDiscount,
         amount_tax = $amountTax,
         amount_shipment = $amountShipment,
         amount_due = $amountDue,
         amount_paid = $amountPaid,
         amount_remaining = $amountRemaining,
         amount_overpaid = $amountOverpaid,
         due_date = $dueDate,
         line_items = $lineItems,
         metadata = $metadata
       WHERE id = type::record('invoice', $id)
         AND merchant = $merchant
         AND environment = $environment
         AND status = 'draft'`,
      this.params(record),
    );
  }

  /**
   * Read the customer's credit balance (T05 overpay sink). Scoped to
   * merchant + environment; unresolved customer → undefined (treated as 0).
   */
  async findCustomerCredit(
    merchantId: string,
    environment: string,
    customerId: string,
  ): Promise<number | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT credit_balance FROM customer WHERE id = type::record('customer', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id: customerId, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<{ credit_balance?: unknown }>]>();
    const row = rows?.[0];
    return row ? Number(row.credit_balance) : undefined;
  }

  /**
   * Apply a state transition + `outbox_event` in ONE transaction. Mirrors
   * the T01 in-tx pattern of create/finalize: the invoice row (money bucket
   * updates `amount_due`/`amount_paid`/`amount_remaining`/`amount_overpaid`,
   * `status`, `status_transitions`) is updated and an outbox row inserted
   * atomically. When `event` is null only the invoice is updated (e.g. a
   * partial payment that does not close the invoice). Optionally atomically
   * sets the customer's `credit_balance` (credit application / overpay, T05).
   */
  async transition(
    record: InvoiceRecord,
    event: OutboxEventData | null,
    opts?: { customer?: { id: string; creditBalance: number } },
  ): Promise<void> {
    const customerStmt = opts?.customer
      ? `UPDATE customer SET credit_balance = $customerCredit
         WHERE id = type::record('customer', $customerId)
           AND merchant = $merchant AND environment = $environment;
      `
      : "";
    const outboxStmt = event
      ? `INSERT INTO outbox_event {
           merchant: $merchant,
           environment: $environment,
           type: $eventType,
           object_type: "invoice",
           object_id: $eventObjectId,
           object: $eventObject,
           window: time::now()
         }`
      : "";
    await this.db.query(
      `UPDATE invoice SET
         amount_due = $amountDue,
         amount_paid = $amountPaid,
         amount_remaining = $amountRemaining,
         amount_overpaid = $amountOverpaid,
         status = $status,
         status_transitions = $statusTransitions
       WHERE id = type::record('invoice', $id)
         AND merchant = $merchant AND environment = $environment;
       ${customerStmt}
       ${outboxStmt}`,
      {
        ...this.params(record),
        customerId: opts?.customer?.id,
        customerCredit: opts?.customer?.creditBalance,
        ...(event
          ? {
              eventType: event.type,
              eventObjectId: record.id,
              eventObject: event.snapshot,
            }
          : {}),
      },
    );
  }

  /**
   * Insert an `outbox_event` WITHOUT changing invoice state — used for the
   * non-transitional payment outcomes (payment_failed / payment_action_required)
   * where the invoice stays `open`. Atomic single-statement insert.
   */
  async insertEvent(record: InvoiceRecord, event: OutboxEventData): Promise<void> {
    await this.db.query(
      `INSERT INTO outbox_event {
         merchant: $merchant,
         environment: $environment,
         type: $eventType,
         object_type: "invoice",
         object_id: $eventObjectId,
         object: $eventObject,
         window: time::now()
       }`,
      {
        merchant: recordIdOf(record.merchantId),
        environment: record.environment,
        eventType: event.type,
        eventObjectId: record.id,
        eventObject: event.snapshot,
      },
    );
  }

  /** Delete a DRAFT (finalized invoices conflict at the service layer). */
  async deleteDraft(merchantId: string, environment: string, id: string): Promise<boolean> {
    const [rows] = await this.db
      .query(
        `DELETE invoice
         WHERE id = type::record('invoice', $id)
           AND merchant = $merchant
           AND environment = $environment
           AND status = 'draft' RETURN BEFORE`,
        { id, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return Array.isArray(rows) && rows.length > 0;
  }

  /** Finalize a DRAFT → open: snap totals + number/issued_at/hosted url + tx. */
  async finalize(record: InvoiceRecord, event: OutboxEventData): Promise<void> {
    await this.db.query(
      `UPDATE invoice SET
         status = "open",
         number = $number,
         issued_at = time::now(),
         hosted_invoice_url = $hostedInvoiceUrl,
         amount_subtotal = $amountSubtotal,
         amount_discount = $amountDiscount,
         amount_tax = $amountTax,
         amount_shipment = $amountShipment,
         amount_due = $amountDue,
         amount_paid = $amountPaid,
         amount_remaining = $amountRemaining,
         amount_overpaid = $amountOverpaid,
         status_transitions = { finalized_at: time::now() }
       WHERE id = type::record('invoice', $id)
         AND merchant = $merchant
         AND environment = $environment
         AND status = 'draft';
       INSERT INTO outbox_event {
         merchant: $merchant,
         environment: $environment,
         type: $eventType,
         object_type: "invoice",
         object_id: $eventObjectId,
         object: $eventObject,
         window: time::now()
       }`,
      {
        ...this.params(record),
        number: record.number,
        hostedInvoiceUrl: record.hostedInvoiceUrl,
        eventType: event.type,
        eventObjectId: record.id,
        eventObject: event.snapshot,
      },
    );
  }

  /** Shared param plumbing for INSERT/UPDATE of an invoice row. */
  private params(record: InvoiceRecord) {
    return {
      id: record.id,
      merchant: recordIdOf(record.merchantId),
      environment: record.environment,
      customer: record.customerId
        ? recordIdOf(
            record.customerId.includes(":") ? record.customerId : `customer:${record.customerId}`,
          )
        : undefined,
      status: record.status,
      currency: record.currency,
      collectionMethod: record.collection_method,
      amountSubtotal: record.amount_subtotal,
      amountDiscount: record.amount_discount,
      amountTax: record.amount_tax,
      amountShipment: record.amount_shipment,
      amountDue: record.amount_due,
      amountPaid: record.amount_paid,
      amountRemaining: record.amount_remaining,
      amountOverpaid: record.amount_overpaid,
      dueDate: record.dueDate ? new Date(record.dueDate) : undefined,
      lineItems: record.lineItems,
      statusTransitions: record.status_transitions ?? undefined,
      metadata: record.metadata ?? undefined,
    };
  }
}

/** Map a SurrealDB invoice row (snake_case) to the service InvoiceRecord shape. */
function mapRow(row: Record<string, unknown>): InvoiceRecord {
  const lineItems = (row.line_items as Array<Record<string, unknown>>) ?? [];
  return {
    id: recordIdToString(row.id as string).replace(/^invoice:/, ""),
    merchantId: recordIdToString(row.merchant as string),
    environment: String(row.environment),
    customerId: row.customer
      ? recordIdToString(row.customer as string).replace(/^customer:/, "")
      : undefined,
    status: row.status as InvoiceStatus,
    number: (row.number as string) ?? undefined,
    currency: String(row.currency),
    collection_method: String(row.collection_method),
    amount_subtotal: Number(row.amount_subtotal),
    amount_discount: Number(row.amount_discount),
    amount_tax: Number(row.amount_tax),
    amount_shipment: Number(row.amount_shipment),
    amount_due: Number(row.amount_due),
    amount_paid: Number(row.amount_paid),
    amount_remaining: Number(row.amount_remaining),
    amount_overpaid: Number(row.amount_overpaid),
    lineItems: lineItems.map((l) => ({
      id: String(l.id),
      description: String(l.description),
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      subtotal: Number(l.subtotal),
      discountable: l.discountable !== false,
      taxes: Array.isArray(l.taxes)
        ? (l.taxes as Array<Record<string, unknown>>).map((tax) => ({
            name: String(tax.name),
            percentage: Number(tax.percentage),
            tax_behavior: tax.tax_behavior as "inclusive" | "exclusive",
            taxable_amount: Number(tax.taxable_amount),
            amount: Number(tax.amount),
          }))
        : undefined,
    })),
    status_transitions: stringifyTimestamps(row.status_transitions as InvoiceStatusTransitions),
    dueDate: row.due_date ? String(row.due_date) : undefined,
    issuedAt: row.issued_at ? String(row.issued_at) : undefined,
    hostedInvoiceUrl: (row.hosted_invoice_url as string) ?? undefined,
    metadata: (row.metadata as Record<string, string>) ?? undefined,
    createdAt: String(row.created_at),
  };
}

/** Coerce native `Date` timestamp values in the status transitions to strings. */
function stringifyTimestamps(tx?: InvoiceStatusTransitions): InvoiceStatusTransitions | undefined {
  if (!tx) return tx;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tx as unknown as Record<string, unknown>)) {
    next[k] = v instanceof Date ? v.toISOString() : v;
  }
  return next as InvoiceStatusTransitions;
}
