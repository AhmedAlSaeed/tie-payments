# 07 — T6: Schema engine & theme

**What to build:** Merchants define custom fields (JSON Schema 2020-12) per (merchant, environment, target_entity); values validate on write and store in `metadata`. SDK-ready contract serves schema + `ui:` extensions. `theme` table for future HPP.

**Blocked by:** 01 (F0).

**Status:** ready-for-ticket

- [ ] `field_schema` table + PUT/GET/DELETE CRUD with optimistic concurrency (If-Match).
- [ ] Service-layer metadata validation against target schema at write (fail-fast problem error).
- [ ] `GET /v1/schema/:target_entity` returns schema + ui extensions.
- [ ] Deletion stops validating, keeps values.
- [ ] `theme` table per (merchant, environment).
- [ ] Tests (valid/invalid writes, version conflict); typecheck + lint clean.

GitHub: #21
