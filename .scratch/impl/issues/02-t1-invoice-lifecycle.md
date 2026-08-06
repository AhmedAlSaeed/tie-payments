# 02 — T1: Invoice lifecycle (draft→finalize)

**What to build:** Draft an invoice with line items and finalize it. Drafts editable; finalize snaps totals (T05 amount model), assigns number + issue date, produces `hosted_invoice_url`. Line-then-invoice discounts + explicit tax rates (seed BH 5% VAT inclusive).

**Blocked by:** 01 (F0).

**Status:** ready-for-ticket

- [ ] `invoice` + `invoice_tax_rate` tables per T05 block (minor-units int; draft|open|paid|voided|uncollectible).
- [ ] Draft create with line items (description, quantity, unit amount, discountable gate).
- [ ] `finalize` snaps amount_subtotal/discount/tax/shipment/due/remaining; sets number, issued_at, hosted_invoice_url.
- [ ] Drafts editable/deletable; finalized are not.
- [ ] Tax via explicit `invoice_tax_rate` (seed BH 5% VAT inclusive), per-line + default.
- [ ] `invoice.created` / `invoice.finalized` events → outbox (in-tx).
- [ ] Tests + typecheck + lint clean.

GitHub: #16
