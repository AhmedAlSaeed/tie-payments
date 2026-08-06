# 02 — T1: Invoice lifecycle (draft→finalize)

**What to build:** Draft an invoice with line items and finalize it. Drafts editable; finalize snaps totals (T05 amount model), assigns number + issue date, produces `hosted_invoice_url`. Line-then-invoice discounts + explicit tax rates (seed BH 5% VAT inclusive).

**Blocked by:** 01 (F0).

**Status:** resolved (implemented 2026-08-06, delegated to `backend` subagent)

## Resolution

Landed in `src/modules/invoicing/` (model/service/repository/seed) + `test/integration/invoicing.test.ts`. Mounted on the `/v1` router. 10 new integration tests; full suite 86 green; typecheck + lint clean.

- [x] `invoice` + `invoice_tax_rate` tables — already in `src/core/schema.surql` (F0); no schema changes.
- [x] Draft create with line items (description, quantity decimal, unit_price int, discountable gate) + Idempotency-Key.
- [x] `finalize` snaps amount_subtotal/discount/tax/shipment/due/remaining; sets `number` (`INV-…`), `issued_at`, `hosted_invoice_url`, `status_transitions.finalized_at` (in-repo query, not service).
- [x] Drafts editable (`PATCH`) / deletable (`DELETE`); finalized → 409 `conflict`.
- [x] Tax via `invoice_tax_rate`, seeded **Bahrain VAT 5% inclusive** per (merchant, env); per-line `taxes` + `amount_tax`.
- [x] `invoice.created` / `invoice.finalized` events → `outbox_event` in-tx (one atomic multi-statement query with the invoice write).
- [x] Tests + typecheck + lint clean.

**Tax formula (inclusive BH VAT 5%):** `unit_price` is the tax-inclusive charged price. Per line `charged = unit_price × quantity`, extracted VAT `lineTax = round(charged·5/105)`, net base `net = charged − lineTax`. Invoice `amount_subtotal = Σnet`, `amount_tax = ΣlineTax` (== 5% of net), `amount_due = subtotal + tax − discount` (restores the inclusive total).

**Notes:** `invoice.customer` is non-option `record<customer>` in the schema, so an omitted body customer is auto-linked to a placeholder `customer:<uuid>` (no phantom rows). `due_date` bound as JS `Date` (ISO strings not coerced on v3).

GitHub: #16
