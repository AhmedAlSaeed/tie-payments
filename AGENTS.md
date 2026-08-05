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

## Hard conventions

- **Never use Python** — not for scripts, tooling, JSON parsing, or anything. Use Bun/TypeScript or `jq` instead. This is a hard rule, no exceptions.
- **Stacked PRs for big features** — use `gh stack` (GitHub CLI extension, skill in `.agents/skills/gh-stack/`) to split large changes into a chain of small reviewable PRs. Never open one giant PR. Each branch maps to one PR based on the branch below it.

## Specialized agents

Project subagents in `.opencode/agent/` — delegate to the right one for the domain:

- **db-ops** — SurrealDB specialist: schema, SurrealQL, indexes, migrations, DB-side of the plan.
- **backend** — ElysiaJS/Bun engineer: API surface, modular monolith, drivers, validation.
- **payments-gcc** — GCC/payments domain expert: Stripe, Tap, BenefitPay, regulations, driver abstraction.

## Skills

Installed globally in `~/.agents/skills/` (auto-loaded), most relevant: `elysiajs`, `surrealql`, `surrealql-performance`, `surrealql-functions`, `surrealkit`, `surrealdb-js`, `surrealdb-cli`, `stripe-best-practices`, `find-docs`.

## MCP servers

Configured in `opencode.json`:

- **surrealdb** — SurrealDB MCP over the dockerized server's HTTP `/mcp` endpoint (`http://127.0.0.1:8000/mcp`, Basic auth from `SURREALDB_BASIC_AUTH` env / `.env`). Server runs via `docker compose up -d` (see `docker-compose.yml`). Requires Docker Desktop running.
- **stripe** — Stripe official remote MCP (`https://mcp.stripe.com`).

## Wayfinder

Active planning map. Maps and tickets under `.scratch/wayfinder/`. See `docs/agents/issue-tracker.md` "Wayfinding operations". Map is `.scratch/wayfinder/map/map.md`.
