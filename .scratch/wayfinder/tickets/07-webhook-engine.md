# T07 — Event bus & webhook dispatch engine

```yaml
id: webhook-engine
parent: map-001
type: grilling
status: resolved
resolved: 2026-08-06
blocked-by: [api-surface]
```

## Question

What is the event bus + webhook dispatch design (Pillar 4): the canonical event model (payment.succeeded, invoice.payment_failed, subscription.canceled…), gateway-webhook normalization, HMAC-SHA256 signing, exponential backoff retries, idempotency verification, and replay capability — all within the minimal-deps constraint on Bun + SurrealDB?

## Deliverables

- Canonical event taxonomy and schema.
- Gateway webhook → platform event normalization mapping.
- Delivery pipeline: signing, retries/backoff, dead-lettering, idempotency keys, replay API.
- Whether an in-process event bus (vs a message broker dependency) satisfies the requirement — justify against minimal deps.
- Departure surface for the (out-of-scope, API-only) admin webhook log streamer.

## Resolution

**Decided via grill, 2026-08-06** (D1–D8), aligned with T01/T04/T05/T06 and the already-shipped `core/gateway.normalizeWebhook` seam (`src/core/gateway/driver.ts:83`).

### D1 — Canonical-only event taxonomy (source of truth)
- The only exposed event source is **canonical domain events** (`invoice.*`, `subscription.*`, `payment.*`). Inbound gateway webhooks are only *ingested* — de-duplicated, used to update the domain aggregate, which then **re-emits** canonical events via the outbox. No ad-hoc gateway payloads surface as first-class events.

### D2 — Transport = in-proc EventBus + SurrealDB outbox (minimal-deps)
- A tiny in-process `EventBus` (subscription map) for low-latency in-monolith dispatch, **plus** a durable **outbox table** written atomically in the same transaction as the domain state change (T01/T05/T06 pattern — idempotency-in-transaction).
- A small drainer persists and delivers; SurrealDB is the replayable durable log. **No broker dependency**.

### D3 — Delivery model = Svix/Stripe
- Per-merchant `webhook_endpoint { id, url, events[], secret, enabled, max_attempts, created_at }`.
- Payload signed **HMAC-SHA256 over the raw body**, headers `tie-timestamp` + `tie-signature: t=<ts>,v1=<hex>`; per-attempt `event_delivery` records.
- Signature verification + timestamp tolerance (STRIPE-style) on every delivery — verify before dispatch.

### D4 — Retry: exponential backoff + dead-letter
- Base delay **10s**, factor **2** (10s → 20s → 40s → 80s → …), capped ~1.8h. `max_attempts` configurable per endpoint (default **3**). Dead-lettered (marked `failed`, never silently dropped) when exhausted.
- A tick/scheduler scans `next_attempt_at <= now` to fire due retries.

### D5 — Delivery guarantee: at-least-once + `event_id`
- **At-least-once** per event (outbox + per-attempt `event_delivery` rows). Merchants de-dupe by the delivered **`event_id`**.
- **Ordering**: per-endpoint, by `created_at`, for the same `object_id` (Stripe-style), maintained by the drainer.

### D6 — Inbound (gateway webhook) de-dup
- Dedup key = **(merchant, environment, driver_id, `gatewayEventId`)** with a UNIQUE composite index. A replay returns HTTP **200** (already processed) **no-op** without re-emitting.
- Recorded as a seen/outbox row, in the same transaction as the state update (idempotency-in-transaction, per T01).
- `normalizeWebhook` must verify the gateway signature first (raw-body HMAC / in-payload) and return the reference; re-key on `gatewayEventId + providerReference`.

### D7 — Canonical event taxonomy + Stripe v1 envelope
Envelope: `{ id, type, api_version, created_at, livemode, account, data: { object_type, object_id, object } }` — `object` is the **full snapshot** of the changed aggregate.

- `payment.*`: `payment.succeeded`, `payment.failed`, `payment.refunded`, `payment.action_required`
- `invoice.*` (T05): `invoice.created`, `invoice.updated`, `invoice.finalized`, `invoice.sent`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, `invoice.overdue`
- `subscription.*` (T06): `subscription.created`, `subscription.updated`, `subscription.period.closed`, `subscription.past_due`, `subscription.trial_will_end`, `subscription.canceled`
- meta: `ping` (endpoint test)

### D8 — Replay & admin departure surface (API-only, tile for later UI)
- **Replay = re-send the stored envelope (no recompute).** `POST /v1/webhook_endpoints/{id}/events/{event_id}/redeliver`.
- Query APIs ship now (the future streamer just consumes them): `GET /v1/events`, `GET /v1/events/{id}`, `GET /v1/event_deliveries`.
- Admin webhook **log streamer UI is out of scope** (API-only decided); the query API is the departure seam.

### SurrealDB schema (draft)

```surql
/// Outbox — durable event log, same-transaction with state change (T01/T05/T06 pattern)
DEFINE TABLE outbox_event SCHEMAFULL
  PERMISSIONS FOR select WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id                ON outbox_event TYPE record<outbox_event>;
DEFINE FIELD merchant          ON outbox_event TYPE record<merchant>;
DEFINE FIELD environment       ON outbox_event TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD type              ON outbox_event TYPE string;                         -- canonical: invoice.*, subscription.*, payment.*, ping
DEFINE FIELD object_type       ON outbox_event TYPE string;
DEFINE FIELD object_id         ON outbox_event TYPE string;
DEFINE FIELD object            ON outbox_event TYPE object FLEXIBLE;                 -- STRIPE v1 `data.object` full snapshot
DEFINE FIELD created_at        ON outbox_event TYPE datetime;
DEFINE FIELD window             ON outbox_event TYPE datetime;                      -- drainer cursor
DEFINE INDEX outbox_created     ON outbox_event FIELDS merchant, environment, created_at;

/// Per-delivery attempt record for a webhook endpoint
DEFINE TABLE event_delivery SCHEMAFULL
  PERMISSIONS FOR select WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id             ON event_delivery TYPE record<event_delivery>;
DEFINE FIELD merchant       ON event_delivery TYPE record<merchant>;
DEFINE FIELD environment    ON event_delivery TYPE string ASSERT $value IN ["test","live"];
DEFINE FIELD event          ON event_delivery TYPE record<event>;
DEFINE FIELD endpoint       ON event_delivery TYPE record<webhook_endpoint>;
DEFINE FIELD attempt        ON event_delivery TYPE int;
DEFINE FIELD delivered_at   ON event_delivery TYPE option<datetime>;
DEFINE FIELD response_status ON event_delivery TYPE option<int>;
DEFINE FIELD signature      ON event_delivery TYPE string;                            -- HMAC hex `v1=...`
DEFINE FIELD deadlettered_at ON event_delivery TYPE option<datetime>;

/// Webhook endpoint — one merchant destination (per Q3)
DEFINE TABLE webhook_endpoint SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id            ON webhook_endpoint TYPE record<webhook_endpoint>;
DEFINE FIELD merchant      ON webhook_endpoint TYPE record<merchant> READONLY;
DEFINE FIELD environment   ON webhook_endpoint TYPE string READONLY;
DEFINE FIELD url           ON webhook_endpoint TYPE string;
DEFINE FIELD secret        ON webhook_endpoint TYPE option<string>;   -- HMAC signing secret (write-once, masked in reads)
DEFINE FIELD enabled       ON webhook_endpoint TYPE bool DEFAULT true;
DEFINE FIELD events        ON webhook_endpoint TYPE array<string>;     -- allow-listed event types
```
> Money is a `decimal`-per-T01? No — the outbox `object` is a snapshot only; all underlying aggregates keep their own money convention (invoice `int`, per T05). Envelope is read-mostly delivery metadata.