# 07 — T6: Schema engine & theme

**What to build:** Merchants define custom fields (JSON Schema 2020-12) per (merchant, environment, target_entity); values validate on write and store in `metadata`. SDK-ready contract serves schema + `ui:` extensions. `theme` table for future HPP.

**Blocked by:** 01 (F0).

**Status:** resolved (implemented 2026-08-06, delegated to `backend` subagent)

## Resolution

Landed in `src/modules/customization/` (model/service/repository/validator) + `test/integration/customization.test.ts`. Mounted on the `/v1` router. 15 new integration tests; full suite 86 green; typecheck + lint clean.

- [x] `field_schema` table + PUT/GET/DELETE CRUD with optimistic concurrency (`If-Match`); first write creates v1, subsequent writes require matching version → else 409 `conflict`.
- [x] Service-layer metadata validation against the target schema at write (`validateMetadata` — throws `validation_error` fail-fast, D3).
- [x] `GET /v1/schema/:target_entity` returns `{ schema, ui, version }` — the SDK auto-render contract (SPEC §3.2).
- [x] Deletion stops validating, keeps stored values (no cascade).
- [x] `theme` table per (merchant, environment): `GET /v1/theme` / `PUT /v1/theme` (upsert; sensible defaults).
- [x] Tests (valid/invalid writes, version conflict); typecheck + lint clean.

**Validator subset (zero deps):** `type` (string/number/integer/boolean/object/array), `properties`, `required`, `items`, `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `pattern`. Unknown keywords ignored per JSON Schema semantics.

**Notes:** `ui`/`css`/`branding` optional fields are omitted from INSERT/UPDATE (stored as SurrealDB `NONE`) — v3 `option<T>` rejects `NULL` at coercion.

GitHub: #21
