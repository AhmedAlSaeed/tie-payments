# 05 — T2: Invoice collection & payment outcome

**What to build:** Money moves on an invoice. `charge_automatically` charges via routed gateway; outcome moves amount_paid → paid. `send_invoice` via hosted_invoice_url. Overpay → credit_balance → next invoice. `void` / `mark_uncollectible`.

**Blocked by:** 02 (T1 — finalize).

**Status:** resolved (implemented 2026-08-06, `backend` subagent)

## Resolution

Extended `src/modules/invoicing/` (service/repository/model/index) + new `test/integration/collection.test.ts`. Mounted on `/v1` (already mounted). 11 new tests; full suite 125 green; typecheck + lint clean.

- [x] `collection_method` honored — `charge_automatically` → routed gateway charge; `send_invoice` direct charge → 409 (paid via `hosted_invoice_url`).
- [x] Success → `amount_paid`; `paid` when `amount_paid >= amount_due` (`paid_at`); overpay → `customer.credit_balance`.
- [x] `void` + `mark_uncollectible` from `open` with timestamps (`voided_at` / `marked_uncollectible_at`) + events.
- [x] Emits `invoice.paid` / `payment_failed` / `payment_action_required` / `voided` / `marked_uncollectible` → outbox (in-tx via `transition`; non-transitional outcomes via `insertEvent`).
- [x] Credit balance applied first (reduces amount charged), overpay returns to credit; never negative.
- [x] Mock matrix tests (4242 paid / 0002 failed(retryable=false) / 3D01 action-required) + overpay→next-invoice; typecheck + lint clean.

**Notes:** `InvoiceService` gained a third constructor arg `chargeViaGateway` (the `PaymentService`-wired seam) — consumers reconciled. Partial payments update `amount_paid`/credit but emit no event (only paid/failed/action-required per ticket).

GitHub: #17
