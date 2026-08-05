# T03 — Unified gateway abstraction contract

```yaml
id: gateway-abstraction
parent: map-001
type: prototype
status: open
blocked-by: [research-gateways, research-surrealdb]
```

## Question

What is the exact shape of the unified gateway driver abstraction (Pillar 1) — the interface every driver (mock, Stripe, Tap, BENEFIT…) implements, the normalized request/response payloads, the routing-rule inputs, and the cross-gateway tokenization mapping?

## Context

Blocked by T02 (gateway landscape facts) and T01 (SurrealDB modeling, for the unified token record). Resolution should raise fidelity with a concrete artifact: a TypeScript driver interface + one normalized payload schema + a worked routing-rule sketch.

## Deliverable

A prototype artifact (interface + schema + routing sketch) linked as an asset, plus the decision on:
- driver interface methods and error contract
- normalized charge/tokenize/refund/webhook payload shape
- routing rule inputs and evaluation semantics
- cross-gateway token record mapping
