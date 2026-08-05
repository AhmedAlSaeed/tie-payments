# T01 — SurrealDB modeling for the payments domain

```yaml
id: research-surrealdb
parent: map-001
type: research
status: closed
resolved: 2026-08-05
```

## Question

How should the core payment domain (merchants, customers, payment methods/tokens, transactions, invoices, subscriptions, webhook events, custom-field metadata) be modeled in SurrealDB, given the whole-platform scope and the schema-engine (Pillar 5) requirement of JSONB-style extensible metadata?

## What we need to know

- Table/schema design for each core entity — SurrealDB table definitions, fields, indexes, and record-link vs foreign-key patterns.
- How to model the dynamic-schema / custom-fields requirement (EAV/JSONB equivalent) in SurrealDB — flexible schemas, `OBJECT`/`FLEXIBLE` types, path queries, indexing of dynamic fields.
- Multi-tenant isolation (per-merchant data) and the test/live environment partitioning requirement — how to scope queries strictly by environment.
- Transactions and consistency guarantees (money-moving writes, invoice state transitions) in SurrealDB — does it support the guarantees the state machine needs?
- Enumerations / state machines (invoice lifecycle, subscription status) — SurrealDB enum support or convention.
- Record versioning / idempotency keys for webhooks.

Resolved by a research subagent reading SurrealDB docs. Findings recorded here; assets (a draft schema sketch) linked, not pasted.

## Resolution

Research complete. Asset: `.scratch/wayfinder/research/T01-surrealdb-modeling.md`.

Key findings:
- **SCHEMAFULL + `DEFINE FIELD`** for business entities; SCHEMALESS / `object FLEXIBLE` only for payload bags (webhook/token payloads).
- **Custom-fields engine**: `metadata object FLEXIBLE` = no-migration arbitrary KV; fast lookup needs a named `DEFINE INDEX` per filterable path (no auto-index). Pre-index hot keys (po_number) or use an EAV side table for unlimited arbitrary fields.
- **Tenancy + env**: shared-schema with `merchant` + `environment` on every table, composite UNIQUE indexes including both, `PERMISSIONS WHERE merchant = $auth.merchant`; optionally split test/live into separate physical databases.
- **Atomicity**: multi-statement writes atomic only inside explicit `BEGIN/COMMIT TRANSACTION` in one request; money-moving flows (ledger + invoice status + outbox) always wrapped. Money = `decimal`, never float.
- **State machines**: no native enum; `string` + `ASSERT` gates values; transition legality (draft→paid) lives in Bun/Elysia domain layer.
- **Idempotency/outbox**: composite UNIQUE `(merchant, environment, idempotency_key)` + `UPSERT`; write `webhook_delivery` rows in same transaction as the domain change; dispatch on `(status, next_retry_at)`.
- **Relational pragmatics**: denormalize hot read fields, `:ulid()` sortable record IDs, no `->>` operator — adopt `.`/`.?` idiom access as platform convention.
