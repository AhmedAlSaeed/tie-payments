# 06 — T4: Dunning (billing retries)

**What to build:** Failed recurring charges retried before cancel. Driver `retryable` classification branches; retryable keeps trying on schedule → past_due → auto-cancel at budget end. Mid-cycle changes prorate via credit_balance. Cancel modes: cancel_at_period_end / cancel_at / immediate.

**Blocked by:** 03 (T3 — subscription creation).

**Status:** resolved (implemented 2026-08-06, `backend` subagent; first two dispatches returned empty/no-op, resume of the session completed it)

## Resolution

Extended `src/modules/subscriptions/` (service/repository/model/index) + new `test/integration/dunning.test.ts`. 8 new tests (27 with the T3 regression); full suite 133 green; typecheck + lint clean.

- [x] `dunning_attempt` table + durable scheduling — `due_at`-scanned ticker (`runDunningTick(db)`, in-proc interval opt-in via `{ autostart }`); `POST /v1/subscriptions/:id/dunning/on_failed_charge` is the durable hook (dedup: one active attempt per subscription, renews on new failure).
- [x] Retryable vs non-retryable on `GatewayError.retryable` — re-charge via T2 `InvoiceService.charge`; classification read from the invoice's `payment_failure.retryable` outbox event; `tok_mock_9999` retryable / `tok_mock_0002` non-retryable.
- [x] past_due escalation (`subscription.past_due` + `status_transitions.past_due_at`); auto-cancel past budget (`attempt > max_attempts` → `canceled` + `canceled_at` + `subscription.canceled`).
- [x] Cancel modes — `POST /v1/subscriptions/:id/cancel` immediate / at_period_end / at, with `canceled_at` timestamps.
- [x] Mid-cycle proration — `POST /v1/subscriptions/:id/items/:item_id/quantity` → prorated delta (daily rate × remaining fraction) applied to `customer.credit_balance`.
- [x] `subscription.past_due` / `canceled` / `trial_will_end` → outbox (in-tx); `maintain` seam emits `trial_will_end` once (status_transitions marker).
- [x] Tests (retryable→past_due→cancel; non-retryable stop; success reactivate; requires_action not burned) + typecheck + lint clean.

**Schema additions (applied centrally pre-dispatch):** `invoice.subscription` (option<record<subscription>>) + index; `dunning_attempt.invoice` + `dunning_attempt.method` (retry method). Period-close now stamps `invoice.subscription`.

GitHub: #19
