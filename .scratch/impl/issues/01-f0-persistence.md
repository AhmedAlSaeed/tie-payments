# 01 — F0: Persistence layer + tenancy (foundation)

**What to build:** A merchant can create a payment, invoice, or subscription and it **actually persists** in SurrealDB; an authenticated API key resolves to a real merchant row. Replaces the in-memory idempotency store + stub `insert` in the payments module. End-to-end: `POST /v1/payments` → durable row → `GET /v1/payments/:id` returns it. Test keys read test rows only, live keys live rows.

**Blocked by:** None — can start immediately.

**Status:** resolved (implemented 2026-08-06)

## Resolution

Landed in one slice. `git log` → "feat(F0): SurrealDB persistence + tenancy (#15)".

- [x] **Full `.surql` schema artifact bootstrapped** — `src/core/schema.surql` assembles the T01/T05–09 blocks + F0 tables (`tenant`, `merchant`, `api_key`, `payment`, `idempotency`, plus `customer`, `payment_method`, `routing_rule`, `invoice`, `invoice_tax_rate`, `price`, `subscription`, `subscription_item`, `usage_record`, `dunning_attempt`, `outbox_event`, `event_delivery`, `webhook_endpoint`, `field_schema`, `theme`). Idempotent (`IF NOT EXISTS`), SCHEMAFULL, merchant+environment PERMISSIONS, money as minor-units `int`. Applied via `applySchema()` at bootstrap and in the test DB.
- [x] **SurrealDB store replaces `InMemoryIdempotencyStore` + payments `insert` stub** — `SurrealIdempotencyStore` (claim/commit/get over the `idempotency` table, UNIQUE (merchant, env, namespaced_key) gate, TTL re-claim) and `PaymentsRepository` (INSERT/`findById`/`findByIdempotencyKey`). Idempotency survives restart — a fresh app instance over the same DB replays the cached response. In-memory store kept as an async reference double.
- [x] **`merchant`, `api_key` (hash-only), `tenant` tables; `context.ts` resolves key → merchant** — `api_key` stores SHA-256 of the secret (was xxHash32), `createContextAuth(db)` looks the key up by hash and binds `merchantId` + env (env still from key prefix). `/v1/me` and every `/v1/payments` route resolve through the DB.
- [x] **`GET /v1/payments/:id` returns the persisted payment** — scoped by merchant+environment; cross-env and cross-tenant reads 404.
- [x] **Integration tests green** — `bun test` 52 pass (payments flow, env isolation, tenant isolation, unknown-key 401, restart-surviving idempotency), `bun run typecheck` + `lint` clean.

### Adaptation note — tenancy enforcement vs the design (important)

The design (T01/T08) makes **DB row-level `PERMISSIONS`** the isolation guarantee. On the SurrealDB build currently shipped by `surrealdb:latest` (v3.2.4+20260803, a nightly), **write permissions (create/update/delete) are NOT enforced for record-user sessions** while read (select) row-filtering IS. Empirically confirmed with both `TYPE RECORD … WITH JWT` and `SIGNIN`-based record accesses: cross-tenant `CREATE`/`UPDATE`/`DELETE` were allowed; `SELECT` filtered correctly.

F0 therefore enforces tenancy in the **Bun store layer**: every store query binds `merchant` + `environment` derived from the authenticated key (never from the body). The schema's `PERMISSIONS` clauses are retained verbatim as defense-in-depth (and already gate reads) for a fixed server release / per-tenant DB deployment. This satisfies the observable acceptance criteria ("test key reads test rows only, live key reads live rows") at the query layer.

Also discovered: v3 rejects `DEFINE FIELD id … TYPE record<table>` and `table:$param` record-id keys (use `type::record(...)` or SDK `RecordId`); `if` is unusable as a field name (routing rule selector stored as `conditions`); `datetime` params are not coerced (let schema `DEFAULT time::now()` fill them).

GitHub: #15
