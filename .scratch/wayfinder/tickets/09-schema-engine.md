# T09 — Dynamic schema engine & SDK auto-render

```yaml
id: schema-engine
parent: map-001
type: prototype
status: open
blocked-by: [research-surrealdb, api-surface]
```

## Question

What is the dynamic customization & schema engine design (Pillar 5): the schema-driven custom-field model on core entities (invoice example in SPEC section 3.2), storage/querying in SurrealDB (JSONB/EAV equivalent), and the schema-driven form-generation contract that the SDK auto-renders from?

## Deliverables

- Custom-field model: JSON schema definition format, target entities, validation, storage, indexed querying.
- How merchant-defined schemas live per-tenant and interact with the `environment` isolation.
- The rendering contract (schema → form inputs) that browsers/SDK render — exact format so it's SDK-ready even though SDK ships later.
- Note the theme/branding/config API surface (what the API-only admin exposes), aligned with T04.