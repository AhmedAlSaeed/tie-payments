# tie-payments

Payment Orchestration, Invoicing & Billing platform for Bahrain and the GCC.

A Payment Technical Service Provider (TSP) / orchestration engine in the vein of Hyperswitch, Spreedly, or Primer — a single API/SDK integration point for merchants over local (BenefitPay), regional (Tap, Moyasar, HyperPay, PayTabs) and global (Stripe, Checkout.com, Adyen) gateways.

## Stack

- **Bun** runtime (latest `1.3.x`)
- **ElysiaJS 2.0** (`elysia@next`, beta) — type-safe, AOT-compiled backend
- **SurrealDB** — multi-model database, built-in MCP server

## Status

Planning phase. The buildable implementation plan is charted as a **wayfinder map** — GitHub issue #1 in this repo, with decision tickets as sub-issues. See `docs/agents/issue-tracker.md` for wayfinding operations.

## Project setup

- `SPEC.md` — the product specification
- `.opencode/agent/` — specialized subagents: `db-ops` (SurrealDB), `backend` (ElysiaJS/Bun), `payments-gcc` (GCC payments domain)
- `opencode.json` — SurrealDB + Stripe MCP servers
- `.scratch/wayfinder/` — local mirror of the map, tickets, and research assets

See `AGENTS.md` for agent instructions.