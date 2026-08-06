# 03 — T3: Price + Subscription creation

**What to build:** Define prices and subscribe a customer. `Price` CRUD (per_unit/metered/tiered, interval + interval_count). Create subscription with items + optional trial; period-close automation generates the cycle invoice from items.

**Blocked by:** 02 (T1 — invoice engine provides finalize).

**Status:** ready-for-ticket

- [ ] `price` table (billing_scheme, tiers, interval + interval_count) + CRUD.
- [ ] `subscription` + `subscription_item` tables (status, trial_end, billing_cycle_anchor, current_period_*, collection_method, items).
- [ ] Create subscription with items; trial defers first charge to first end-of-cycle invoice.
- [ ] Period-close automation: rolls periods, creates + finalizes cycle invoice honoring collection_method.
- [ ] Tiered pricing from `tiers`; metered items → `usage_record`.
- [ ] `subscription.created` / `subscription.period.closed` (+ invoice.*) → outbox.
- [ ] Tests + typecheck + lint clean.

GitHub: #18
