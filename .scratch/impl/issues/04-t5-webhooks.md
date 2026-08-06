# 04 — T5: Webhook engine (outbox + delivery)

**What to build:** Canonical events become real webhook deliveries. Outbox drainer emits Stripe v1 envelopes; `webhook_endpoint` CRUD; HMAC-SHA256 signing; at-least-once with backoff + dead-letter; queryable + replayable.

**Blocked by:** 01 (F0).

**Status:** resolved (implemented 2026-08-06, delegated to `backend` subagent)

## Resolution

Landed in `src/modules/webhooks/` (model/service/repository/signer/drainer) + `test/integration/webhooks.test.ts`. Mounted on the `/v1` router. 9 new integration tests; full suite 86 green; typecheck + lint clean.

- [x] Outbox drainer + `GET /v1/events` / `GET /v1/events/:id` (Stripe v1 envelope `{id,type,api_version,created_at,livemode,account,data:{object_type,object_id,object}}`).
- [x] `webhook_endpoint` CRUD (url, events allow-list, secret returned once + masked on reads, enabled, max_attempts default 3).
- [x] HMAC-SHA256 signing (`tie-timestamp` + `tie-signature: t=<ts>,v1=<hex>` over `<ts>.<body>`), timing-safe verify + tolerance.
- [x] At-least-once via `event_delivery` UNIQUE (merchant, env, event, endpoint) — one row per pair, `attempt` increments; exp backoff (10s ×2 cap ~1.8h); dead-letter (`deadlettered_at`) on exhaustion.
- [x] Inbound gateway webhook dedup — `inbound_webhook` UNIQUE (merchant, env, driver, gateway_event_id) → replay 200 no-op; atomic dedup-INSERT + canonical `outbox_event` emit.
- [x] Replay `POST /v1/webhook_endpoints/:id/events/:event_id/redeliver` (re-sends stored envelope, no recompute).
- [x] `GET /v1/event_deliveries`; tests with a local `Bun.serve` echo endpoint; typecheck + lint clean.

**Schema additions (applied centrally):** `inbound_webhook` table + `event_delivery` UNIQUE dedup index were added to `schema.surql` before dispatch (T07 D5/D6); `event_delivery.next_attempt_at` added post-hoc for durable retry scheduling.

**Retry scheduling note:** the drainer tracks backoff in an in-process cooldown map (correct within the single-process monolith); the `event_delivery.next_attempt_at` column is ready for a durable drainer later.

GitHub: #20
