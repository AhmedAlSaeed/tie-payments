# T04 — API surface & modular monolith layout

```yaml
id: api-surface
parent: map-001
type: prototype
status: open
blocked-by: []
```

## Question

What does the public REST API surface look like (endpoints, versioning, auth/API-key model, environment partitioning, idempotency) and how is the modular monolith laid out on Bun + ElysiaJS so the five pillars stay decoupled inside one deployable?

## Deliverables

- Modular monolith layout: module boundaries, shared kernel (what's shared vs per-pillar), how pillars communicate in-process.
- API design: `pk_test_/sk_test_` key namespacing, auth, environment enum enforced per request, idempotency-key semantics, error taxonomy, versioning policy.
- ElysiaJS plugin/controller structure — justified against the minimal-deps constraint (is Elysia's plugin system enough, or do we need extra deps?).

Raise fidelity with a prototype: ElysiaJS app skeleton + route map + one worked endpoint end-to-end.
