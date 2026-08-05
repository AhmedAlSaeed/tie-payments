# tie-payments — Shared Context

Payment orchestration, invoicing and billing platform for Bahrain/GCC: a modular
monolith (Bun + ElysiaJS + SurrealDB) that routes money through gateway drivers,
issues and collects invoices, runs subscriptions, and delivers signed webhooks.

## Language

### Invoicing

**Invoice**:
A statement of amounts owed by a customer, generated one-off or from a
subscription. The root aggregate of Pillar 2.
_Avoid_: Bill, payment request, statement-of-charge

**Line item**:
An individual accountable charge on an invoice, carrying its own quantity, unit
price, subtotal, discounts and tax.
_Avoid_: Charge, SKU line

**Finalization**:
The one-way `draft → open` transition that freezes an invoice's amounts and
assigns its number and issue date. After finalization the shipped totals are shelf-stable.
_Avoid_: Issue, send, publish

**Draft**:
The mutable, pre-finalization invoice state. Only drafts may be edited or deleted.
**Open**:
A finalized invoice awaiting full payment. The only normal state from which an
invoice can still be paid.
**Paid**:
An invoice whose recorded `amount_paid` equals its `amount_due`. Terminal.
**Voided**:
An invoice the merchant reversed/cancelled after finalization. Terminal.
**Uncollectible**:
An open invoice the merchant has given up collecting (kept as a debt, not
cancelled). Terminal.
_Avoid_: Bad debt, write-off

**Overdue**:
A *derived* indicator — an `open` invoice with a due date in the past and a
nonzero remaining balance. Not a stored status.
**Partial**:
A *derived* indicator — an `open` invoice that has received some but not all of
its money. Not a stored status.

**Due date**:
The moment an `open` invoice becomes `overdue`. Applies to the
`send_invoice` collection method only.
**Credit balance**:
Money a customer overpaid; automatically credited against and applied to the
next invoice. Where `amount_overpaid` goes.
_Avoid_: Store credit, prepayment

**Collection method**:
How an invoice's money is obtained. `send_invoice` (the hosted page / payment
link) or `charge_automatically` (a saved card / customer payment method).
**Hosted payment page (HPP)**:
The white-labelled page a customer is sent to pay a finalized invoice — its URL
is `hosted_invoice_url`. The human-shared copy of it is a **payment link**.

**Tax rate**:
A configured percentage/% or flat charge with an explicit inclusive/exclusive
behaviour and jurisdiction. Bahrain's default is 5% VAT. The invoice engine applies
configured rates; it does not auto-discover tax.
**TIN (Taxpayer Identification Number)**:
The merchant's tax registration number, printed on the invoice; required for
Bahrain VAT (NBR).
_Avoid_: VAT certificate, tax ID number

**Discount**:
An amount or percent reductions the charge. Line-level discounts apply before
the invoice-wide reduction; a line marked non-discountable is excluded from both.

### Events & webhooks

**Canonical event**: A first-class domain event (e.g. `invoice.paid`, `subscription.canceled`) that the webhook API exposes to merchants. The only event source — gateway webhooks are normalized away before reaching the surface.
_Avoid_: Gateway payload, raw webhook

**Event envelope**: Stripe's v1 shape `{ id, type, api_version, created_at, data: { object_type, object_id, object } }` where `object` is the full snapshot of the changed aggregate.

**Outbox**: The SurrealDB table written in the same transaction as a domain state change (T01 pattern); a worker drains it to emit canonical events and schedule deliveries. Gives a replayable event log with no separate broker.
_Avoid_: Message queue

**Webhook endpoint**: A merchant destination allow-listed to event types, with an HMAC signing secret. Deliveries carry `tie-timestamp` / `tie-signature`.
**Dead-letter**: A delivery that exhausted its retry attempts, marked failed rather than silently dropped.

### Sandbox & environment

**API key**: A `pk_/sk_` credential whose prefix encodes the environment (`sk_test_...`). Env is always derived from the prefix and bound via the `api_key` record; raw secrets are never stored, only hashed.
_Avoid_: token, credential string

**Test/live partitioning**: Row-level DB `PERMISSIONS` scoping every table by `merchant` + `environment`, so a test key can never read live rows and vice versa.

**Mock gateway**: The sandbox-default driver (`mock`) implementing the full test-card matrix — 4242 success, 0002 decline, 9999 timeout, 3D01 3DS challenge, QR BenefitPay "Simulate Scan & Pay" — with no real HTTP.

**Onboarding**: The under-60-second flow: Better Auth signup auto-provisions a merchant, `sk_test`/`pk_test` keys, a default mock routing rule, and the 1-line SDK snippet.
_Avoid_: provisioning, signup setup

### Customization & schema engine

**Field schema**: A merchant-defined [JSON Schema 2020-12] definition for custom fields on a target entity (e.g. `invoice`), stored per `(merchant, environment, target_entity)`. The SDK renders form inputs from it. Values live in each aggregate's `metadata` object.
_Avoid_: JSONB column, EAV model

**UI extensions**: The per-field hints riding alongside the raw JSON Schema (`label`, `placeholder`, `helper`, `choices`, `disabled`, `locale`) that let SDKs render inputs without guessing.

**Theme**: Per-merchant render branding (colors, radius, dark/light, CSS, logo, locale) served to the hosted payment page when it ships.
_Avoid_: Storefront, skin

### Subscriptions

**Subscription**:
A recurring billing agreement against a customer's payment method or an email-
sent invoice; the root aggregate of Pillar 3. Owns items (prices) and the billing
cycle anchors.
_Avoid_: Plan, recurring mandate

**Price**:
A configured sellable with a `billing_scheme` (per_unit / metered / tiered) and
a recurrence `interval` + `interval_count`. The unit a subscription item points at.
_Avoid_: SKU, tariff

**Billing cycle anchor**:
The point (typically the subscription's start) the recurring periods are pinned
to — each `current_period_start/end` rolls from it.

**Proration**:
The mid-cycle credit/charge produced when a plan or quantity changes before the
period ends; credited against the customer's credit balance.

**Dunning**:
The automatic retry loop for a failed recurring charge (payment method classified
retryable or not) escalating to `past_due` and finally auto-cancelling.

### Gateway & money

**Payment**:
A discrete charge performed through a gateway, optionally linked to an invoice.
**Money**:
An amount in that currency's smallest unit (minor units) plus an ISO-4217
currency code. Always integer minor units, never float.
**Currency**:
An invoices is strictly one currency; all its lines and payments are that
currency. There is no currency conversion in the engine.