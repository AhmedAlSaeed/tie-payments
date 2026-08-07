# 03 — T3: Price + Subscription creation

**What to build:** Define prices and subscribe a customer. `Price` CRUD (per_unit/metered/tiered, interval + interval_count). Create subscription with items + optional trial; period-close automation generates the cycle invoice from items.

**Blocked by:** 02 (T1 — invoice engine provides finalize).

**Status:** resolved (implemented 2026-08-06, `backend` subagent; first attempt cancelled mid-flight, take-over agent fixed to green)

## Resolution

New `src/modules/subscriptions/` (model/service/repository/billing/index) + `test/integration/subscriptions.test.ts`. Mounted on `/v1`. 19 tests; full suite 125 green; typecheck + lint clean.

- [x] `price` CRUD (billing_scheme per_unit/metered/tiered, period interval + interval_count).
- [x] `subscription` + `subscription_item` tables + creation (items linked, `billing_cycle_anchor` → `current_period_*`), trial → `trialing`.
- [x] Create subscription with items; trial defers first charge to first end-of-cycle invoice (trial close flips to `active` without an invoice).
- [x] Period-close automation: rolls periods, creates + finalizes the cycle invoice through the invoicing `InvoiceService` (per_unit/seat = qty × unit_amount; tiered volume/graduated; metered from `usage_record` sums), honoring `collection_method`.
- [x] Tiered pricing from `tiers`; metered items → `usage_record` (`POST /v1/usage_records`).
- [x] `subscription.created` / `subscription.period.closed` (+ invoice.* via invoicing) → outbox (in-tx).
- [x] Tests + typecheck + lint clean.

**Key fixes (take-over):** record-id readback stripping (`⟨⟩` brackets via core `recordIdToString`); rollPeriod SurrealQL params renamed to index-suffixed (no hyphens — tokenized as subtraction); metered sum via `SELECT VALUE math::sum(...) GROUP ALL` (single-row scalar vs array); test-data cleanup for re-runnability; `latestInvoice` orders by `issued_at`.

**Scope note:** cancel modes, proration (D6/D7), durable dunning (D10) land under later tickets.

GitHub: #18
