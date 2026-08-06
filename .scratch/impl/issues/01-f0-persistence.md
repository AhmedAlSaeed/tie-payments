# 01 — F0: Persistence layer + tenancy (foundation)

**What to build:** A merchant can create a payment, invoice, or subscription and it **actually persists** in SurrealDB; an authenticated API key resolves to a real merchant row. Replaces the in-memory idempotency store + stub `insert` in the payments module. End-to-end: `POST /v1/payments` → durable row → `GET /v1/payments/:id` returns it. Test keys read test rows only, live keys live rows.

**Blocked by:** None — can start immediately.

**Status:** ready-for-ticket

- [ ] Full `.surql` schema artifact bootstrapped (T01/T05–09 blocks) — idempotent, SCHEMAFULL, merchant+environment PERMISSIONS, `:ulid()`.
- [ ] SurrealDB store replaces `InMemoryIdempotencyStore` + payments `insert` stub; idempotency survives restart (UNIQUE + outbox-in-tx, T01).
- [ ] `merchant`, `api_key` (hash-only), `tenant` tables; `context.ts` resolves key → merchant (drops hash stub).
- [ ] `GET /v1/payments/:id` returns the persisted payment.
- [ ] Integration tests green against dockerized SurrealDB; `bun test` + `typecheck` + `lint` clean.

GitHub: #15
