# T07 — Event bus & webhook dispatch engine

```yaml
id: webhook-engine
parent: map-001
type: grilling
status: open
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