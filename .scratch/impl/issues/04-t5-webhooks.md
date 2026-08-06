# 04 — T5: Webhook engine (outbox + delivery)

**What to build:** Canonical events become real webhook deliveries. Outbox drainer emits Stripe v1 envelopes; `webhook_endpoint` CRUD; HMAC-SHA256 signing; at-least-once with backoff + dead-letter; queryable + replayable.

**Blocked by:** 01 (F0).

**Status:** ready-for-ticket

- [ ] Outbox drainer + `GET /v1/events` (Stripe v1 envelope).
- [ ] `webhook_endpoint` CRUD (url, events allow-list, secret, enabled, max_attempts).
- [ ] HMAC-SHA256 signing (`tie-timestamp` + `tie-signature`), per-attempt `event_delivery`.
- [ ] At-least-once, exp backoff (10s ×2 cap ~1.8h), dead-letter.
- [ ] Inbound gateway webhook de-dup (UNIQUE merchant+env+driver+gatewayEventId → 200 no-op) + canonical normalization.
- [ ] Replay `POST /v1/webhook_endpoints/:id/events/:event_id/redeliver`.
- [ ] `GET /v1/event_deliveries`; tests with local echo endpoint; typecheck + lint clean.

GitHub: #20
