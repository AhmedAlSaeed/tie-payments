/**
 * Invoicing pillar DTOs (TypeBox schemas + derived types).
 *
 * Money is minor-units `int` (`Money` / `CURRENCY_EXPONENT` in shared/constants),
 * never float. Line `quantity` is a decimal (fractional units), `unit_price` is
 * an int in minor units; the charged amount is `round(unit_price * quantity)`.
 *
 * Tax model (T05): a per-tenant seed — Bahrain VAT 5% `inclusive` — is applied
 * to every line at create/recompute. Inclusive means the `unit_price` the
 * customer pays ALREADY contains VAT: the tax portion is extracted from it
 * (`charged * pct / (100 + pct)`), the line's taxable base is `charged - tax`,
 * and invoice `amount_subtotal` is the SUM of net bases (pre-tax) while
 * `amount_due = amount_subtotal + amount_tax` restores the inclusive charged
 * total. `amount_tax` is therefore exactly `pct%` of the taxable base.
 */
import { t } from "elysia";
import type { Static } from "typebox";

export const InvoiceStatus = t.Union([
  t.Literal("draft"),
  t.Literal("open"),
  t.Literal("paid"),
  t.Literal("voided"),
  t.Literal("uncollectible"),
]);
export type InvoiceStatus = Static<typeof InvoiceStatus>;

/** ISO-4217 currencies supported by the engine (matches shared/constants). */
const Currency = t.Union([
  t.Literal("BHD"),
  t.Literal("USD"),
  t.Literal("SAR"),
  t.Literal("AED"),
  t.Literal("KWD"),
  t.Literal("QAR"),
  t.Literal("OMR"),
]);

/** Body line item — charged to the customer (incl. embedded VAT when taxed). */
export const CreateInvoiceLineItem = t.Object({
  description: t.String({ minLength: 1, maxLength: 512 }),
  /** Fractional quantity allowed (decimal). */
  quantity: t.Number({ minimum: 0 }),
  /** Minor-units unit price, charged price (incl. embedded VAT for inclusive tax). */
  unit_price: t.Number({ minimum: 0 }),
  discountable: t.Optional(t.Boolean({ default: true })),
});
export type CreateInvoiceLineItem = Static<typeof CreateInvoiceLineItem>;

export const CreateInvoice = t.Object({
  customer: t.Optional(t.String({ maxLength: 128 })),
  currency: Currency,
  collection_method: t.Union([t.Literal("send_invoice"), t.Literal("charge_automatically")]),
  line_items: t.Array(CreateInvoiceLineItem, { minItems: 1 }),
  due_date: t.Optional(t.String()),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type CreateInvoice = Static<typeof CreateInvoice>;

/** Per-line stored tax entry (Stripe-shaped). */
export const InvoiceTax = t.Object({
  name: t.String(),
  percentage: t.Number(),
  tax_behavior: t.Union([t.Literal("inclusive"), t.Literal("exclusive")]),
  taxable_amount: t.Number(),
  amount: t.Number(),
});
export type InvoiceTax = Static<typeof InvoiceTax>;

/** Stored/resolved line item on an invoice. */
export const InvoiceLineItem = t.Object({
  id: t.String(),
  description: t.String(),
  quantity: t.Number(),
  unit_price: t.Number(),
  /** Net (pre-tax) amount for this line. */
  subtotal: t.Number(),
  discountable: t.Boolean({ default: true }),
  taxes: t.Optional(t.Array(InvoiceTax)),
});
export type InvoiceLineItem = Static<typeof InvoiceLineItem>;

export const InvoiceStatusTransitions = t.Optional(
  t.Object(
    {
      finalized_at: t.Optional(t.String()),
      paid_at: t.Optional(t.String()),
      voided_at: t.Optional(t.String()),
      marked_uncollectible_at: t.Optional(t.String()),
    },
    { additionalProperties: true },
  ),
);
export type InvoiceStatusTransitions = Static<typeof InvoiceStatusTransitions>;

export const InvoiceResource = t.Object({
  id: t.String(),
  object: t.Literal("invoice"),
  status: InvoiceStatus,
  customer: t.Optional(t.String()),
  number: t.Optional(t.String()),
  currency: t.String(),
  collection_method: t.Union([t.Literal("send_invoice"), t.Literal("charge_automatically")]),
  amount_subtotal: t.Number(),
  amount_discount: t.Number(),
  amount_tax: t.Number(),
  amount_shipment: t.Number(),
  amount_due: t.Number(),
  amount_paid: t.Number(),
  amount_remaining: t.Number(),
  amount_overpaid: t.Number(),
  line_items: t.Array(InvoiceLineItem),
  status_transitions: InvoiceStatusTransitions,
  due_date: t.Optional(t.String()),
  issued_at: t.Optional(t.String()),
  hosted_invoice_url: t.Optional(t.String()),
  metadata: t.Optional(t.Record(t.String(), t.String())),
  created: t.String(),
  environment: t.Union([t.Literal("test"), t.Literal("live")]),
});
export type InvoiceResource = Static<typeof InvoiceResource>;

/** Body for PATCH — partial edits on DRAFT invoices (whole-array replaces). */
export const UpdateInvoice = t.Object({
  customer: t.Optional(t.String({ maxLength: 128 })),
  currency: t.Optional(Currency),
  collection_method: t.Optional(
    t.Union([t.Literal("send_invoice"), t.Literal("charge_automatically")]),
  ),
  line_items: t.Optional(t.Array(CreateInvoiceLineItem, { minItems: 1 })),
  due_date: t.Optional(t.String()),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type UpdateInvoice = Static<typeof UpdateInvoice>;
