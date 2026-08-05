# T04 — API surface & modular monolith layout

```yaml
id: api-surface
parent: map-001
type: prototype
status: resolved
blocked-by: []
```

## Question

What does the public REST API surface look like (endpoints, versioning, auth/API-key model, environment partitioning, idempotency) and how is the modular monolith laid out on Bun + ElysiaJS so the five pillars stay decoupled inside one deployable?

## Resolution

Prototype landed in `src/` on Elysia **2.0.0-beta.1** (`elysia@next`). Gates green: `bun run typecheck` (0), `bun run lint` (oxlint), `bun run fmt`+`--check` (oxfmt).

### Modular monolith layout

```
src/
  index.ts                 entry → listen({ port })
  app.ts                   assembly: /v1 versioned router
  core/                    SHARED KERNEL (no pillar deps)
    apikey.ts              pk_/sk_ namespacing, parseBearer, generateKey, hashSecret
    errors.ts              ProblemError (RFC 9457) + problem() factory
    errors-plugin.ts       global .error(...) lifecycle → errorHandling plugin
    context.ts             auth derive → MerchantContext
    idempotency.ts         Idempotency-Key namespacing + IdempotencyStore
  shared/                  domain scalars (Money, Environment, currency exponent)
    constants.ts
  modules/                 ONE FOLDER PER PILLAR, each a named Elysia plugin
    payments/  (model.ts, service.ts, index.ts)
    (invoicing, subscriptions, webhooks, schema-engine land with their tickets)
```

- **Module boundaries**: each pillar is a self-contained Elysia plugin (named for dedup). One worked pivot: `payments`.
- **Shared kernel vs per-pillar**: kernel owns API-key parse/derive, error taxonomy, idempotency contract, money scalar. Pillars own business rules + their own TypeBox DTOs.
- **In-process comms**: pillars communicate by importing each other's **services** (plain TS modules) — no IPC/event bus byte, matching the minimal-deps constraint. The gateway driver seam (T03) plugs into `PaymentService.deps.insert`.
- **Persistence border**: all stores are behind interfaces (`IdempotencyStore`, `PaymentService.deps.insert`) so DurDB impl lands in T001 without touching the API layer.

## API design decisions

- **Key namespacing**: `sk_test_|<type>_<env>_<40 hex>`. `sk`=secret (server-side, all routes), `pk`=publishable (client-side tokenization only, `GET /v1/me` for now). Raw secrets never stored; `hashSecret` via `Bun.hash`; only the hash held in the (future) api_key table.
- **Auth**: `Authorization: Bearer <key>`. `auth` derive parses the key per request and builds `MerchantContext`.
- **Environment enum + enforcement**: `environment` is **always** derived from the key prefix (`test|live`), never from the body/query. `sk_live_…` ⇒ `environment:"live"`; verified end-to-end (two keys → two envs in the same process). DB-side isolation lands per U01 composite indexes.
- **Idempotency-Key**: mutating methods accept `Idempotency-Key` (8–128 chars). Namespaced by `hash(merchantId::env::route::key)`; first run → 200/201, replay → stored response, concurrent same-key → `409 idempotency_conflict`. Semantics documented in `core/idempotency.ts`.
- **Error taxonomy (RFC 9457)**: every error = `{ type, title, status, detail, code, instance?, errors? }` with stable machine `code`. Cover: `validation_error`(400), `invalid_api_key`/`unauthenticated`(401), `insufficient_permissions`(403), `resource_not_found`(404), `idempotency_conflict`/`conflict`(409), `rate_limited`(429), `gateway_error`(502), `internal_error`(500).
- **Versioning**: all current routes behind `/v1`. A major bump = a second versioned router mounted alongside; old majors live until sunset. `/health` unversioned.

## Elysia 2.0 plugin/controller structure — findings (the interesting bit)

Prototype surfaced three real Elysia 2.0.0-beta API breaking facts vs 1.x docs:

1. **Handler/hook argument order is reversed vs 1.x.** In 2.0-beta the overload is `get/post(path, hook, fn)` (base.d.ts `get`, `post` overloads). The 1.x style `(path, fn, hook)` fails every route with `TS2559 … LocalHook<InputSchema<never>…>`. Report showed the remembered 1.x shape, migrate to `(path, hook, fn)`. *(Fixed in `payments/index.ts`.)*
2. **`.error(...)` API + error context**: there is **no** `.error({ Class })` object form (that overload is runtime-only for naming). Correct 2.0: `.error(Class, fn)` registers a handler narrowed to `InstanceType`, and a bare `.error(fn)` is the catch-all. The context has **no `code` string** — built-ins are discriminated by `instanceof` (`ValidationError` → 400, `NotFound` → 404, generic → 500). Also `.as('plugin')` must be applied for registerable handlers to publish to `.use()`-ers. *(Implemented in `errors-plugin.ts`.)*
3. **Derived header whitelisting**: declaring a `headers` schema on a route (here `idempotency-key`) makes Elysia **replace `context.headers`** with only the declared keys — silently dropping `authorization`, so auth breaks. Fix: read `authorization` via `request.headers.get(...)` in the derive (always intact). *(Fixed in `context.ts`.)*

Dependency justification (minimal-deps constraint):
- `elysia@next` (2.0.0-beta.1) — framework.
- `typebox` — transitive dep of Elysia, added as a direct dep only because models import `type { Static }` from it. No other runtime deps.
- `oxlint`/`oxfmt` (dev) — lint/format.
- **Bearer/JWT plugins unnecessary** — hand-rolled parse is ~15 lines and keeps keys opaque. No CORS (API-only, no browser origin needed yet). No OpenAPI plugin in v1 core (SDK/Admin out of scope).

## Prototype scope delivered

- Elysia app skeleton (modular monolith assembly) + route map.
- Working phones: `/health`, `/v1/me`, `POST /v1/payments` (create), `GET /v1/payments/:id`.
- `POST /v1/payments` end-to-end: auth → env isolation → body validation → idempotency → in-memory payment record → `PaymentResource`.
- Toolchain: `bun, oxlint, oxfmt, tsc` all green.

## Follow-up / not yet

- **Persist IdempotencyStore + PaymentService deps to SurrealDB (T001/U01)** — replace in-memory.
- **Gateway driver seam in PaymentService** (T03) — currently returns `requires_action` stub.
- **Rate limiting / sensitive-route policy** on `pk` keys.
- **Merchant↔key resolution + key lifecycle/rotation/revoke** — depends on DB-backed api_key table.
- **OpenAPI spec generation** — when first real clients land.