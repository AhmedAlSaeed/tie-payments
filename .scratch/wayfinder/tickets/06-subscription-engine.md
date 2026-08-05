# T06 — Subscription & recurring billing engine

```yaml
id: subscription-engine
parent: map-001
type: grilling
status: resolved
resolved: 2026-08-06
blocked-by: [invoice-engine]
```

## Question

What is the subscription engine design (Pillar 3): schedule modeling (daily/weekly/monthly/annual/custom cron), pricing models (flat, seat-based, usage/metered, tiered), and the smart-dunning retry flow before cancellation?

## Deliverables

- Subscription schedule model and recurrence calculation.
- Pricing model representation for each of the four types — including how usage/metered events are reported and billed.
- Dunning: retry schedules, failure escalation, cancellation triggers, integration with the invoice engine and webhook engine.
- Draft SurrealDB schema (aligned with T01).

## Resolution

**Decided via grill, 2026-08-06 — adopt Stripe's Subscriptions model wholesale** (D1–D10), self-consistent with T05's invoicing model and T03's gateway abstraction.

### D1 — Reference model = Stripe Subscriptions
- `Subscription { status, items[], current_period_start/end, billing_cycle_anchor, cancel_at, cancel_at_period_end, default_payment_method, collection_method }`, separate `Price` objects carrying `billing_scheme`.

### D2 — Recurrence
- Schedule is `interval (day|week|month|year)` + `interval_count` (offers daily/weekly/monthly/quarterly/annual). **No raw cron strings in v1** — SPEC's "custom cron" is satisfied by interval+interval_count. `billing_cycle_anchor` defaults to `created_at`; `current_period_*` roll at each cycle close.

### D3 — Pricing mapped to `billing_scheme` (one mechanism, no parallel enum)
- **flat** → `per_unit` + unit_amount, quantity 1.
- **seat** → `per_unit` + quantity = seat count (updates on subscription item quantity change).
- **usage/metered** → `metered`: no unit_amount; usage reported to `usage_record`, billed at period end.
- **tiered** → `tiered`: `tiers [{up_to, flat_amount|unit_amount}]`, `tiers_mode graduated|volume`.

### D4 — Dunning = Stripe dunning automation
- Per-Price `retry_schedule` (delays e.g. `[2025, 4075]` minutes) with a max-attempt budget; escalate to `past_due`.
- Drive classification from T03 driver `retryable`: retryable (`card_declined`) → keep trying up to budget; non-retryable (`authentication_required`) → stop.
- **Auto cancel** when attempts/max exhausted (`payment-dunning` flow). Durable, **outbox-driven** (D10).

### D5 — Trial
- `trial_end` / `trial_period_days`; status `trialing`; **first charge deferred to first end-of-cycle invoice** (not trial start).

### D6 — Proration
- Mid-cycle plan/quantity changes produce prorated credit/charge via customer `credit_balance` (reuses T05 overpayment handling), defaulting to Stripe `create_prorations`.

### D7 — Cancellation modes (all three)
- `cancel_at_period_end=true` (end of current period), `cancel_at` (scheduled), immediate cancel → `canceled_at`. Status → `canceled`; canceled subs stop generating invoices; open-cycle handled at roll.

### D8 — Invoice wiring = period-close automation (not manual)
- Automation tick (durable) closes each period → creates the cycle's invoice from subscription items (flat/seat from period quantities; metered from usage records), applies proration, finalizes (`draft → open`, via T05 invoice engine), then threads collection via the payment/dunning pipeline. `collection_method` copied down to each generated invoice.

### D9 — Schema (SurrealDB, approved)
- Four SCHEMAFULL tables scoped `merchant`+`environment`, money as minor-units `int`, composite indexes, `readonly` fields, explicit `BEGIN/COMMIT` on money/state moves. Full blocks in ticket.

### D10 — Durable dunning
- Retry attempts scheduled as a durable outbox flow (consistent with T01 outbox rows + T07 event stream); feeds subscription status transition and webhook events.

### Dataflow / status evolution
```
trialing ──trial_end──▶ active
active   ──dunning fail (>0)────▶ past_due
past_due ──retryable attempt────▶ (stays) → auto-cancel when budget exhausted
active/past_due ──cancel(immediate / at_period_end / at)──▶ canceled
```
- Events emitted → T07: `customer.subscription.created`, `subscription.updated`, `subscription.period.closed`, `subscription.past_due`, `subscription.trial_will_end`, `subscription.canceled`, plus invoice events re-used from T05.

### SurrealDB schema for subscriptions (draft)

```surql
DEFINE TABLE price SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id                 ON price TYPE record<price>;
DEFINE FIELD merchant           ON price TYPE record<merchant> READONLY;
DEFINE FIELD environment        ON price TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD nickname           ON price TYPE option<string>;
DEFINE FIELD currency           ON price TYPE string;
DEFINE FIELD billing_scheme     ON price TYPE string ASSERT $value IN ["per_unit","metered","tiered"];
DEFINE FIELD unit_amount        ON price TYPE option<int>;            -- per_unit / seat; None for metered/tiered
DEFINE FIELD tiered             ON price TYPE option<object> FLEXIBLE; -- {tiers:[{up_to, flat_amount|unit_amount}], mode:"graduated|volume"}
DEFINE FIELD period             ON price TYPE object FLEXIBLE;         -- {interval, interval_count}
DEFINE FIELD period.interval    ON price TYPE string ASSERT $value IN ["day","week","month","year"];
DEFINE FIELD period.interval_count ON price TYPE int DEFAULT 1;
DEFINE FIELD active             ON price TYPE bool DEFAULT true;
DEFINE FIELD metadata           ON price TYPE object FLEXIBLE;
DEFINE INDEX price_scope_currency ON price FIELDS merchant, environment, currency;

DEFINE TABLE subscription SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id                       ON subscription TYPE record<subscription>;
DEFINE FIELD merchant                 ON subscription TYPE record<merchant> READONLY;
DEFINE FIELD environment              ON subscription TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD customer                 ON subscription TYPE record<customer>;
DEFINE FIELD status                   ON subscription TYPE string ASSERT $value IN ["trialing","active","past_due","incomplete","canceled"];
DEFINE FIELD collection_method        ON subscription TYPE string ASSERT $value IN ["send_invoice","charge_automatically"] DEFAULT "charge_automatically";
DEFINE FIELD items                    ON subscription TYPE array<record<subscription_item>>;
DEFINE FIELD billing_cycle_anchor     ON subscription TYPE datetime;
DEFINE FIELD current_period_start     ON subscription TYPE datetime;
DEFINE FIELD current_period_end       ON subscription TYPE datetime;
DEFINE FIELD trial_end                ON subscription TYPE option<datetime>;
DEFINE FIELD cancel_at                ON subscription TYPE option<datetime>;
DEFINE FIELD cancel_at_period_end     ON subscription TYPE bool DEFAULT false;
DEFINE FIELD canceled_at              ON subscription TYPE option<datetime>;
DEFINE FIELD default_payment_method   ON subscription TYPE option<record<payment_method>>;
DEFINE FIELD proration_behavior       ON subscription TYPE string ASSERT $value IN ["create_prorations","always_invoice","none"] DEFAULT "create_prorations";
DEFINE FIELD status_transitions       ON subscription TYPE object FLEXIBLE;  -- started_at, past_due_at, canceled_at, trial_ended_at
DEFINE FIELD metadata                 ON subscription TYPE object FLEXIBLE;
DEFINE INDEX sub_scope_status         ON subscription FIELDS merchant, environment, status;
DEFINE INDEX sub_scope_customer       ON subscription FIELDS merchant, environment, customer;
DEFINE INDEX sub_scope_period_end     ON subscription FIELDS merchant, environment, current_period_end;

DEFINE TABLE subscription_item SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id            ON subscription_item TYPE record<subscription_item>;
DEFINE FIELD merchant      ON subscription_item TYPE record<merchant> READONLY;
DEFINE FIELD environment   ON subscription_item TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD subscription  ON subscription_item TYPE record<subscription>;
DEFINE FIELD price         ON subscription_item TYPE record<price>;
DEFINE FIELD quantity      ON subscription_item TYPE int;                    -- seat count / metered intensity
DEFINE FIELD tax_rates     ON subscription_item TYPE option<array<record<invoice_tax_rate>>>;
DEFINE FIELD period_start  ON subscription_item TYPE datetime;
DEFINE FIELD period_end    ON subscription_item TYPE datetime;

DEFINE TABLE usage_record SCHEMAFULL
  PERMISSIONS FOR select, create WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id                 ON usage_record TYPE record<usage_record>;
DEFINE FIELD merchant           ON usage_record TYPE record<merchant>;
DEFINE FIELD environment        ON usage_record TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD subscription_item  ON usage_record TYPE record<subscription_item>;  -- metered item
DEFINE FIELD quantity           ON usage_record TYPE int;                        -- reported units
DEFINE FIELD recorded_at        ON usage_record TYPE datetime;
DEFINE INDEX usage_item_time    ON usage_record FIELDS subscription_item, recorded_at;

-- Dunning retry attempts (durable outbox-style; feeds T03 retryable + T07)
DEFINE TABLE dunning_attempt SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id            ON dunning_attempt TYPE record<dunning_attempt>;
DEFINE FIELD merchant      ON dunning_attempt TYPE record<merchant> READONLY;
DEFINE FIELD environment   ON dunning_attempt TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD subscription  ON dunning_attempt TYPE record<subscription>;
DEFINE FIELD attempt       ON dunning_attempt TYPE int DEFAULT 0;
DEFINE FIELD max_attempts  ON dunning_attempt TYPE int DEFAULT 3;
DEFINE FIELD due_at        ON dunning_attempt TYPE datetime;
DEFINE FIELD state         ON dunning_attempt TYPE string;   -- pending | past_due | canceled
```

> Money is minor-units `int` per `Money` in `src/shared/constants.ts`, aligning with T04/IPC. Per-item tax rates reference `invoice_tax_rate` from T05.

### Follow-ups
- **T07** consumes the expanded event set (required `subscription.*` stream).
- **Automation/billing** runner (tick worker) not defined here — lands with subs module `src/modules/subscriptions/` per T004 layout (implement/TDD later).
