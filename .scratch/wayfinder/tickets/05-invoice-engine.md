# T05 — Invoice engine state machine & VAT

```yaml
id: invoice-engine
parent: map-001
type: prototype
status: resolved
resolved: 2026-08-06
blocked-by: []
```

## Question

What is the exact invoice engine design (Pillar 2): the enforced lifecycle state machine (draft → issued → partially_paid → paid → voided / overdue), line-item/tax/discount/multi-currency rules, Bahrain 5% VAT + TIN itemization, and the HPP/payment-link flow that drives state transitions?

## Deliverables

- Invoice state machine: states, legal transitions, who can trigger each, what events they emit.
- Line-item model: unit amounts, quantity, VAT 5% + VAT-inclusive/exclusive handling, percentage/flat discounts, currency conversion.
- HPP + payment-link flow: session creation, hosted page lifecycle, how payment outcome moves the invoice state.
- Draft SurrealDB schema for invoices (aligned with T01).

## Resolution

**Decided via grill, 2026-08-06 — adopt Stripe's Invoicing model** (invoice lifecycle, line-item/tax/discount rules, amount model) in preference to SPEC's simplified `draft → issued → partially_paid → paid → voided / overdue` sketch. D1–D3 locked in the session:

- **D1 — Status vocabulary = Stripe's.** Stored statuses `draft | open | paid | voided | uncollectible`. `overdue` is **derived** (`open` + `due_date` in the past + `amount_remaining > 0`), not a *stored* state; "partial" is not a status either, it's `open` with `amount_paid > 0`. Stripe emits `invoice.overdue` via automations (feed T07). Supersedes the `$INVOICE_STATUSES` sketch in the T01 research.
- **D2 — No currency conversion in the engine.** Invoice is strictly single-`currency`; all lines and payments are that currency (matches Stripe — It does not convert). SPEC's "multi-currency" is satisfied by per-invoice `currency` selection, not conversion. Cross-currency conversion, if ever needed, is a metadata/rounding-layer concern and out of scope here.
- **D3 — Two terminal rail-retrievers out of `open`.** `void` (merchant reversed/cancelled invoice) and `mark_uncollectible` (won't pay; kept as historical). Each with its own timestamp (`voided_at`, `marked_uncollectible_at`) and event, mirroring Stripe.

### Statuses model of an invoice

```
stored:  draft | open | paid | voided | uncollectible
derived: overdue  (= open ∧ due_date past ∧ amount_remaining>0)
         partial  (= open ∧ amount_paid>0)

draft ──finalize──▶ open ──pay to zero──▶ paid
   │                 │
   │                 ├──void──▶ voided
   │                 └──mark_uncollectible──▶ uncollectible
   └──DELETE (draft invoices can be removed)
```

- Who triggers each transition
  - **finalize** (`draft → open`): merchant API or automation. Recomputes & snaps totals, sets `number`/`issued_at`.
  - **paid**: payment events (webhook → gateway charge succeeds → `amount_paid` reaches `amount_due`).
  - **voided / uncollectible**: merchant API.
  - **overdue**: automation tick, derived, no write.
- **Events emitted** (the stream T07 normalizes): `invoice.created`, `invoice.updated`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.overdue` (derived signal).
- **`status_transitions` timestamps** (Stripe): `finalized_at`, `paid_at`, `voided_at`, `marked_uncollectible_at` — mirrored for audit.

### Line items, tax & discount (Stripe-mapped)

- **Line item** = `{ id, description, quantity_decimal, unit_amount, subtotal, discount_amounts[], taxes[] , discountable bool, period {start,end} }` where `subtotal` is pre-discount/pre-tax.
- **Amount model per invoice** (all minor-units `int`, matching `Money` in `src/shared/constants.ts` / T03):
  `amount_subtotal`, `amount_discount`, `amount_tax`, `amount_shipment`, `amount_due`, `amount_paid`, `amount_remaining = amount_due - amount_paid`, `amount_overpaid`.
- **Overpayment → customer credit balance** (Stripe behaviour): any `amount_paid > amount_due` moved to the customer's credit, applied to the next invoice. No stored "overpaid" state.
- **Tax**: a **tax rate** per the vehicle: `{ name, percentage, inclusive: true|false, jurisdiction, country }`. Seed one: **Bahrain VAT 5%, `inclusive` default, jurisdiction `country:BH`, TIN on merchant**. Invoices carry `default_tax_rates`; lines carry per-line tax (`amount`, `tax_behavior: inclusive|exclusive`, `taxable_amount`). `automatic_tax`-style lookup is **out of scope** for the invoice engine — tax is applied explicitly via configured rates.
- **Discounts**: line-item discounts applied **before** invoice-wide discounts. A line is `discountable` or not. `total_discount_amounts` aggregates.

### Collection & HPP / payment-link & tax (Stripe-parallel)

- `collection_method: charge_automatically` (saved card / customer default PM) vs `send_invoice` (the **HPP / payment-link** path).
  - `finalize` produces `hosted_invoice_url` (the HPP on the merchant's theme, T09) and, for this path, the channel the merchant shares via SMS/WhatsApp (the **payment link**). `invoice_pdf` mirrors the invoice.
  - On first charge attempt, a **payment** (the T03 gateway seam — `PaymentService.createPayment`) is created for the invoice; the charge outcome moves `amount_paid`.
- **Payment outcome → invoice state**: `succeeded` → `amount_paid += amount`, invoice `paid` when zero; `failed` → `invoice.payment_failed` (feed to smart-dunning in T06, branching on the driver's `retryable` from T03); `requires_action` → `invoice.payment_action_required`.

### SurrealDB schema for invoices (aligned T01 + codebase)

Revises the T01 sketch's `invoice` block to (a) new status vocabulary from D1, (b) **minor-units `int`** for all money (matches `Money` in `src/shared/constants.ts`, the Payments module, and T03 — overriding T01's `decimal` draft; **money is never `float`**, one convention), (c) Stripe-shaped line items/totals and `null`-able timestamps, (d) the customary `merchant` + `environment` scope + composite indexes.

```surql
DEFINE PARAM $PAYMENT_STATUSES VALUE ["pending","processing","requires_action","succeeded","failed","refunded","voided"];

DEFINE TABLE invoice SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id                       ON invoice TYPE record<invoice>;
DEFINE FIELD merchant                 ON invoice TYPE record<merchant>            READONLY;
DEFINE FIELD environment              ON invoice TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD customer                 ON invoice TYPE record<customer>;
DEFINE FIELD status                   ON invoice TYPE string ASSERT $value IN ["draft","open","paid","voided","uncollectible"];
DEFINE FIELD number                   ON invoice TYPE option<string>;              -- human invoice number / prefix
DEFINE FIELD currency                 ON invoice TYPE string;
DEFINE FIELD collection_method        ON invoice TYPE string ASSERT $value IN ["send_invoice","charge_automatically"];
DEFINE FIELD amount_subtotal          ON invoice TYPE int;                          -- minor units
DEFINE FIELD amount_discount          ON invoice TYPE int DEFAULT 0;
DEFINE FIELD amount_tax               ON invoice TYPE int DEFAULT 0;
DEFINE FIELD amount_shipment          ON invoice TYPE int DEFAULT 0;
DEFINE FIELD amount_due               ON invoice TYPE int;
DEFINE FIELD amount_paid              ON invoice TYPE int DEFAULT 0;
DEFINE FIELD amount_remaining         ON invoice TYPE int;
DEFINE FIELD amount_overpaid          ON invoice TYPE int DEFAULT 0;
DEFINE FIELD due_date                 ON invoice TYPE option<datetime>;
DEFINE FIELD issued_at                ON invoice TYPE option<datetime>;
DEFINE FIELD hosted_invoice_url       ON invoice TYPE option<string>;
DEFINE FIELD invoice_pdf              ON invoice TYPE option<string>;
DEFINE FIELD line_items               ON invoice TYPE array<object> FLEXIBLE;
DEFINE FIELD line_items.*.description ON invoice TYPE string;
DEFINE FIELD line_items.*.quantity    ON invoice TYPE decimal;
DEFINE FIELD line_items.*.unit_price  ON invoice TYPE int;
DEFINE FIELD line_items.*.subtotal    ON invoice TYPE int;
DEFINE FIELD line_items.*.discountable ON invoice TYPE bool DEFAULT true;
DEFINE FIELD status_transitions       ON invoice TYPE object FLEXIBLE;              -- finalized_at, paid_at, voided_at, marked_uncollectible_at
DEFINE FIELD metadata                 ON invoice TYPE object FLEXIBLE;              -- custom-fields engine (SPEC §3.2)
DEFINE INDEX invoice_scope_status     ON invoice FIELDS merchant, environment, status;
DEFINE INDEX invoice_scope_customer  ON invoice FIELDS merchant, environment, customer;
DEFINE INDEX invoice_scope_due        ON invoice FIELDS merchant, environment, due_date;
DEFINE INDEX invoice_metadata_po_number ON invoice FIELDS metadata.po_number;

-- Child: a tax rate applied to lines (seed BH5% VAT). Not a join table.
DEFINE TABLE invoice_tax_rate SCHEMAFULL
  PERMISSIONS FOR select WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id             ON invoice_tax_rate TYPE record<invoice_tax_rate>;
DEFINE FIELD merchant       ON invoice_tax_rate TYPE record<merchant>;
DEFINE FIELD environment    ON invoice_tax_rate TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD name           ON invoice_tax_rate TYPE string;         -- "Bahrain VAT"
DEFINE FIELD percentage_gross ON invoice_tax_rate TYPE decimal;       -- 5.0
DEFINE FIELD inclusive      ON invoice_tax_rate TYPE bool;            -- true → price already includes VAT
DEFINE FIELD jurisdiction    ON invoice_tax_rate TYPE string;           -- country:BH
DEFINE FIELD tin             ON invoice_tax_rate TYPE option<string>;    -- merchant TIN (NBR)
```

All money moves (status transitions, invoice+payment + outbox rows) go inside explicit `BEGIN/COMMIT TRANSACTION` per T01 §4.

### Money convention note

The codebase already picked **minor-units `int` for the `Money` scalar (T004/T03/`constants.ts`, Payments module), so invoice money is `int` minor units. T01's `decimal` draft is superseded for the invoice module; `decimal` remains valid where arbitrary-precision exists in one record (e.g. tax percentages, fractional quantity). Implementations should carry `CURRENCY_EXPONENT` (BHD=3) — never hardcoded ×100.

### Follow-ups

- **T06** consumes `invoice.overdue` (derived) + `invoice.payment_failed` + `$retryable` from T03 for dunning.
- **T07** consumes the event stream above.
- **HPP/theme** surfacing (`hosted_invoice_url`, invoice PDF) depends on Pillar-5 (T09).
- Endpoints land with the invoicing module in `src/modules/invoicing/` (per T004 layout) — a later implement/TDD slice.
