# Map: Buildable Implementation Plan — tie-payments core platform

```yaml
id: map-001
label: wayfinder:map
status: open
```

## Destination

A buildable, phased implementation plan (engineering spec) for the tie-payments **core platform**: the 5-pillar payment orchestration + invoicing + subscriptions + webhooks + dynamic schema engine, plus sandbox/mock-gateway and Hosted Payment Pages — **API-only** (no merchant Admin UI), delivered as a **modular monolith** on **Bun + ElysiaJS + SurrealDB**, with minimal, justified dependencies. Plan is "clear" when every decision below is resolved and nothing is left to decide before implementation starts.

## Notes

- **Domain**: Payment orchestration / TSP. GCC + Bahrain regulatory posture (CBB PS-1.1.3, PCI SAQ A via client-side tokenization, PDPL, VAT 5%). See `SPEC.md`.
- **Stack fixed**: Bun runtime (latest, `1.3.x`), ElysiaJS framework, SurrealDB. Minimal deps is a hard constraint — **every** dependency choice must be justified in the ticket's resolution (what it buys, what breaks without it, what it costs).
- **Elysia 2.0** (daydream, full rewrite, still beta): target `elysia@next` for the plan; AOT build-mode compilation, `@elysia/` scoped plugins, new error API (Problem Details RFC 9457), `derive` replaces `resolve`, lifecycle renames (`onError→error`). See blog `elysiajs.com/blog/elysia-20.html`; migrate legacy examples with `bunx @elysia/codemod`. Backend agent + `elysiajs` skill must follow 2.0 syntax.
- **Skills to consult**: `elysiajs` for backend patterns; `find-docs`/`ctx7` for library facts; `grilling` + `domain-modeling` for design tickets.
- **Tooling (project setup)**: specialized subagents in `.opencode/agent/` — `db-ops` (SurrealDB), `backend` (ElysiaJS/Bun), `payments-gcc` (GCC/payments domain). Skills installed globally in `~/.agents/skills/` (surrealdb/agent-skills set, elysiajs, stripe-best-practices). MCP: `surrealdb` (built-in stdio MCP, needs `surreal` binary v3.1+ on PATH) and `stripe` (remote mcp.stripe.com). See `AGENTS.md`. Sessions must delegate to the matching subagent and use the matching skill.
- **Scope**: core platform only. SDKs, ecosystem plugins, merchant Admin UI are **out of scope**.
- **Delivery**: phased milestones (sandbox+mock → invoicing → subs → webhooks → schema/theme).
- **Tracker**: GitHub issues in `AhmedAlSaeed/tie-payments` (this repo). Map = issue #1 (label `wayfinder:map`); tickets = sub-issues; blocking = native GitHub issue deps. Local mirrors under `.scratch/wayfinder/`. See `docs/agents/issue-tracker.md` "Wayfinding operations".

## Decisions so far

<!-- one line per closed ticket: enough to judge relevance, then zoom the link for the detail -->

- [SurrealDB modeling for the payments domain](.scratch/wayfinder/tickets/01-surrealdb-modeling.md) — SCHEMAFULL + DEFINE FIELD for entities, `object FLEXIBLE` for payload bags; custom fields via indexed metadata paths; per-table `merchant`+`environment` composite indexes + `PERMISSIONS WHERE merchant`; money = `decimal`; explicit `BEGIN/COMMIT TRANSACTION` for money moves; state machines enforced in the Bun domain layer; idempotency = composite UNIQUE key + outbox rows written in-transaction; `:ulid()` record IDs.
- [Gateway landscape: which drivers for v1](.scratch/wayfinder/tickets/02-gateway-landscape.md) — v1 driver set: Mock (sandbox default), **Tap** (primary, Bahrain), **Stripe** (global), **Moyasar** (KSA); stretch Checkout.com. Jaywan + direct BENEFIT are NOT drivers (UAE scheme / ISO 20022 rail). Abstraction seams: createPayment→action, tokenize (client-side), auth/capture/refund/void, webhook→event. Currency exponent carried (BHD=3 decimals). Mock matrix mapped to real cards.

## Not yet specified

- **Deployment/infra**: Bun hosting model, SurrealDB hosting (managed vs self), CI/CD, environments. Not sharp enough to ticket until the monolith + API surface are shaped.
- **Security detail**: PCI SAQ-A attestation process, PDPL data-processing agreement, API-key rotation/lifecycle policy. Depends on API-surface decision.
- **HPP & theme contract**: how merchant branding/theme config surfaces through the API into hosted pages; localization/RTL contract. Depends on customization-engine decision.
- **Smart-routing rule model**: how routing rules are expressed/evaluated (which inputs, precedence, failover semantics). Depends on gateway-abstraction decision.
- **Idempotency & API versioning policy**: persistence + key semantics; versioning strategy. Depends on API-surface decision.
- **Error taxonomy**: unified API error model across pillars. Depends on API-surface decision.

## Out of scope

- **Merchant Admin Portal UI** — API-only was decided; admin features (webhook replay, schema editor, theme config) are API resources.
- **Official SDKs** (Node/TS, Python) and **ecosystem plugins** (Odoo/Magento/WooCommerce) — a later effort.
- **Global-gateway deep integrations beyond the v1 driver set** — deferred behind the gateway ticket.
- **PCI certification process** — compliance posture is designed in, certification itself is out.
