# tie-payments — agent instructions

## Agent skills

### Issue tracker

Local-markdown tracker under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. `CONTEXT.md` at root. See `docs/agents/domain.md`.

## Repo

- New standalone product: Payment Orchestration, Invoicing & Billing platform (Bahrain/GCC).
- Not part of the `tie` monorepo. Stack: Bun + ElysiaJS + SurrealDB (modular monolith, minimal deps).
- Seed spec: `SPEC.md`.

## Specialized agents

Project subagents in `.opencode/agent/` — delegate to the right one for the domain:

- **db-ops** — SurrealDB specialist: schema, SurrealQL, indexes, migrations, DB-side of the plan.
- **backend** — ElysiaJS/Bun engineer: API surface, modular monolith, drivers, validation.
- **payments-gcc** — GCC/payments domain expert: Stripe, Tap, BenefitPay, regulations, driver abstraction.

## Skills

Installed globally in `~/.agents/skills/` (auto-loaded), most relevant: `elysiajs`, `surrealql`, `surrealql-performance`, `surrealql-functions`, `surrealkit`, `surrealdb-js`, `surrealdb-cli`, `stripe-best-practices`, `find-docs`.

## MCP servers

Configured in `opencode.json`:

- **surrealdb** — SurrealDB built-in MCP (stdio, embedded memory DB). Needs `surreal` binary v3.1+ on PATH (install from surrealdb.com/install).
- **stripe** — Stripe official remote MCP (`https://mcp.stripe.com`).

## Wayfinder

Active planning map. Maps and tickets under `.scratch/wayfinder/`. See `docs/agents/issue-tracker.md` "Wayfinding operations". Map is `.scratch/wayfinder/map/map.md`.
