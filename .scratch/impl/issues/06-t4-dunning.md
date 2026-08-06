# 06 — T4: Dunning (billing retries)

**What to build:** Failed recurring charges retried before cancel. Driver `retryable` classification branches; retryable keeps trying on schedule → past_due → auto-cancel at budget end. Mid-cycle changes prorate via credit_balance. Cancel modes: cancel_at_period_end / cancel_at / immediate.

**Blocked by:** 03 (T3 — subscription creation).

**Status:** ready-for-ticket

- [ ] `dunning_attempt` table + durable outbox-driven retry scheduling (T06 D4/D10).
- [ ] Retryable vs non-retryable on `GatewayError.retryable` (T03).
- [ ] past_due escalation; auto-cancel past budget.
- [ ] cancel modes with canceled_at timestamps.
- [ ] Mid-cycle prorations → customer credit_balance (T05).
- [ ] subscription.past_due / canceled / trial_will_end → outbox.
- [ ] Tests (retryable→past_due→cancel; non-retryable stop); typecheck + lint clean.

GitHub: #19
