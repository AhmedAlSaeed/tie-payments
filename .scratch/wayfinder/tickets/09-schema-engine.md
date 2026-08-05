# T09 — Dynamic schema engine & SDK auto-render

```yaml
id: schema-engine
parent: map-001
type: prototype
status: resolved
resolved: 2026-08-06
blocked-by: [research-surrealdb, api-surface]
```

## Question

What is the dynamic customization & schema engine design (Pillar 5): the schema-driven custom-field model on core entities (invoice example in SPEC section 3.2), storage/querying in SurrealDB (JSONB/EAV equivalent), and the schema-driven form-generation contract that the SDK auto-renders from?

## Deliverables

- Custom-field model: JSON schema definition format, target entities, validation, storage, indexed querying.
- How merchant-defined schemas live per-tenant and interact with the `environment` isolation.
- The rendering contract (schema → form inputs) that browsers/SDK render — exact format so it's SDK-ready even though SDK ships later.
- Note the theme/branding/config API surface (what the API-only admin exposes), aligned with T04.

## Resolution

**Decided via grill, 2026-08-06** (D1–D5), aligned with T01's indexed-`metadata` storage, T08's env isolation, and T04's API/RFC-9127 conventions. T09 is the last map ticket.

### D1 — Schema representation = JSON Schema (2020-12)
- The custom-field contract IS **JSON Schema draft 2020-12** — merchant submits `{ type: object, properties, required }` on a `target_entity`. No new DSL. Validate values with a small hand-rolled validator subset (minimal-deps); feeds the SDK auto-renderer directly.
- Values stored per T01 in each aggregate's `metadata` `object FLEXIBLE`; merchant define/persist via `field_schema`.

### D2 — Environments partitioned (test/live)
- `field_schema` stored per `(merchant, environment, target_entity)` — full isolation, mirroring T08-D2 zero-leak. A merchant tunes the schema shape in test, promotes independently to live.

### D3 — Value validation enforced in the service layer, not DB
- Reuse existing indexed-`metadata`-path pattern (SurrealDB `object FLEXIBLE` + `DEFINE INDEX ... metadata.<key>` = the "JSONB/EAV" equivalent). No EAV table.
- At create/update time, the **Bun service layer** validates values against the merchant's `field_schema` for that target, failing fast with a problem error; DB `metadata` typing stays as the backstop.

### D4 — SDK-ready render contract (raw schema + ui-extensions)
- `GET /v1/schema/{target_entity}` (auth: `pk_`) serves the **JSON Schema plus a small per-field extension object** (label, placeholder, helper, choices/ordering, disabled, locale/RTL default).
- Format matches SPEC §3.2 exactly so future SDK renders properties→inputs with no re-spec or re-description.

### D5 — Schema admin API + versioned concurrency
- `PUT /v1/schema/{target_entity}` (store/update full schema + validations), `GET /v1/schema/{target_entity}`, `DELETE /v1/schema/{target_entity}`.
- `version` + `updated_at` on the record; optimistic concurrency (`If-Match`) so two editors don't clobber. Honors `Idempotency-Key` + RFC-9127 problem JSON (T04). Deletion keeps stored `metadata` values (no cascade) but stops validating them.

### Theme & branding config (per-SPEC §3.1)
- A lightweight `theme` table per `(merchant, environment)` holding colors, radius, dark/light, CSS, logo, name, locale — admin-configurable via API, served to the **HPP when it lands** (out of scope until Pillar-5 shape). Aligned with the deferred HPP/T-customization effort.

### SurrealDB schema (draft)

```surql
/// Merchant-defined dynamic schema for a target entity (SPEC §3.2)
DEFINE TABLE field_schema SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id             ON field_schema TYPE record<field_schema>;
DEFINE FIELD merchant       ON field_schema TYPE record<merchant> READONLY;
DEFINE FIELD environment    ON field_schema TYPE string ASSERT $value IN ["test","live"] READONLY;
DEFINE FIELD target_entity  ON field_schema TYPE string;            -- invoice | payment | subscription | customer ...
DEFINE FIELD schema         ON field_schema TYPE object FLEXIBLE;   -- JSON Schema 2020-12 (properties, required, ...)
DEFINE FIELD ui             ON field_schema TYPE object FLEXIBLE;    -- per-field label/placeholder/helper/choices/disabled/locale
DEFINE FIELD version        ON field_schema TYPE int DEFAULT 1;      -- optimistic concurrency (D5)
DEFINE FIELD updated_at     ON field_schema TYPE datetime;
DEFINE INDEX field_schema_scope ON field_schema FIELDS merchant, environment, target_entity UNIQUE;

/// Render-time branding (SPEC §3.1) fed to the HPP when it ships
DEFINE TABLE theme SCHEMAFULL
  PERMISSIONS FOR select, update WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id             ON theme TYPE record<theme>;
DEFINE FIELD merchant       ON theme TYPE record<merchant> READONLY;
DEFINE FIELD environment    ON theme TYPE string READONLY;
DEFINE FIELD primary_color  ON theme TYPE string;
DEFINE FIELD radius         ON theme TYPE string;                -- border-radius token
DEFINE FIELD dark_mode      ON theme TYPE bool DEFAULT false;
DEFINE FIELD css            ON theme TYPE option<string>;       -- custom CSS injection
DEFINE FIELD branding       ON theme TYPE object FLEXIBLE;      -- name, logo(url), support_email, locales
DEFINE INDEX theme_scope    ON theme FIELDS merchant, environment;
```
> Custom-field VALUES continue to live in each aggregate's `metadata` `object FLEXIBLE` with per-path indexes (T01). `field_schema` is the definition/metadata, `theme` the render appearance.

### Follow-ups
- HPP + SDK renderers are out of scope (API-only); these tables + `GET /v1/schema/*` are the departure surface. Lands with `src/modules/customization/` per T004 layout.