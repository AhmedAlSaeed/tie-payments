# T08 — Sandbox, mock gateway & testing environment

```yaml
id: sandbox
parent: map-001
type: prototype
status: resolved
resolved: 2026-08-06
blocked-by: [gateway-abstraction]
```

## Question

What is the sandbox/testing environment design (section 4 of SPEC.md): dual-environment data partitioning (test/live API keys, `environment` enum, zero-leak isolation), the under-60-seconds onboarding flow, and the mock gateway driver with the full test-card matrix including the BenefitPay QR "Simulate Scan & Pay"?

## Deliverables

- Env partitioning mechanics: key generation, `environment` enum enforcement in every query, isolation guarantees.
- Onboarding flow: signup → auto-generate sk_test → pre-activated mock driver → 1-line SDK snippet → simulated payments + admin log stream reveal.
- Mock gateway driver: implements the T03 abstraction, produces the SPEC section 4.3 matrix (4242/0002/9999/3D01/BenefitPay QR), drives webhook emission for the admin streamer.
- Draft schema (aligned with T01).

## Resolution

**Decided via grill, 2026-08-06** (D1–D7), aligned with the shipped kernel: `MockGatewayDriver` (all five SPEC §4.3 scenarios — `4242/0002/9999/3D01`/QR), `apikey.ts` (prefix-partitioned test/live), `context.ts` (env from key), and Better Auth (`auth/`).

### D1 — Onboarding gates on Better Auth + auto-provisioning
- Merchant signs up via **Better Auth** (email+password). On success, the sandbox provisions: a `merchant` row, one `sk_test_...` + one `pk_test_...` key (hashed in DB), and a default **mock `RoutingRule`** (driver `mock`, sandbox env). Returns the 1-line SDK snippet. No merchant setup before they can test.

### D2 — Zero-leak isolation = DB row-level PERMISSIONS
- Enforcement is the already-defined **DB `PERMISSIONS` scoping** (`WHERE merchant = $auth.merchant AND environment = $auth.environment`) on every schema table (T01/T04/T05–07 pattern). Env is **always derived from the key prefix**, never from the request body. Query-layer `AND environment = ?` is a defensive extra where convenient, not the guarantee.
- **No cross-env leak**: a `test` key reads only `test` rows; `live` key only `live`. `$auth.merchant` is bound once the `api_key→merchant` lookup lands (T04), so a key can't spoof a merchant/env.

### D3 — Simulated payments surface through the REAL pipeline
- The sandbox test-pay action calls `PaymentService.createPayment`, then feeds the result back through the **same inbound `webhook→canonical` pipeline (`normalizeWebhook` + outbox)** a real gateway uses (T07). The event stream a merchant observes (`payment.succeeded/failed/action_required`) is the genuine end-to-end pipeline — not a test-only shortcut.

### D4 — Interactive 3DS challenge (guarded mock page)
- `3D01` returns a `redirect` to a **guarded `/mock/3ds` challenge page** (sandbox-only). "Confirm" posts the success back through the same inbound path (Q3/D3) — idempotent, canonical completion. No fake success path.

### D5 — Admin streamer = API-only surface
- `GET /v1/event_deliveries?environment=...` (T07) **is** the streamer surface; the UI is **out of scope** (API-only platform). The mock's emitted canonical events land on deliveries for a future streamer to render.

### D6 — API-key + context binding (replaces T044 stub)
- Tables: `api_key { id, merchant_id, role (user|pk), type (user|pk), prefix, hash (store only), active, created_at, rotated_at }`, `merchant` (links Better Auth user, name + TIN). `context.ts` reads env + `merchantId` from the key record (not the hash stub). One key each default; rotation policy deferred to map "Not yet specified".

### D7 — Sandbox table set
- Add `api_key` + wire existing `merchant` + `routing_rule`; **reuse T07 `outbox_event`/`event_delivery`** for the stream. Mock driver stays **stateless** (no per-tenant persistence). Env + composite UNIQUE scoped per table.

### SurrealDB schema (draft)

```surql
/// Merchant principal (links Better Auth identity) — name + TIN for invoicing/VAT (§NBR)
DEFINE TABLE merchant SCHEMAFULL
  PERMISSIONS FOR select, update WHERE id = $auth.merchant;
DEFINE FIELD id       ON merchant TYPE record<merchant>;
DEFINE FIELD auth_user ON merchant TYPE record<user>;   -- Better Auth user id
DEFINE FIELD name     ON merchant TYPE string;
DEFINE FIELD tin       ON merchant TYPE option<string>;  -- TIN (NBR) for VAT invoices

/// API keys — hash stored, never raw.
DEFINE TABLE api_key SCHEMAFULL
  PERMISSIONS FOR select, update WHERE merchant = $auth.merchant;
DEFINE FIELD id          ON api_key TYPE record<api_key>;
DEFINE FIELD merchant    ON api_key TYPE record<merchant>;
DEFINE FIELD environment ON api_key TYPE string READONLY;-- test|live (from prefix)
DEFINE FIELD role        ON api_key TYPE string ASSERT $value IN ["sk","pk"];
DEFINE FIELD prefix      ON api_key TYPE string READONLY; -- sk_test_ | pk_live_ ...
DEFINE FIELD hash        ON api_key TYPE string;          -- hashed secret (never raw)
DEFINE FIELD active      ON api_key TYPE bool DEFAULT true;
DEFINE FIELD created_at  ON api_key TYPE datetime;
DEFINE FIELD rotated_at  ON api_key TYPE option<datetime>;
DEFINE INDEX api_key_scope  ON api_key FIELDS merchant, environment, active;
DEFINE INDEX api_key_hash   ON api_key FIELDS hash UNIQUE;

/// Default routing rule for sandbox — mock driver (T03 routing_rule shape)
DEFINE TABLE routing_rule SCHEMAFULL
  PERMISSIONS FOR select, update, delete WHERE merchant = $auth.merchant AND environment = $auth.environment;
DEFINE FIELD id          ON routing_rule TYPE record<routing_rule>;
DEFINE FIELD merchant    ON routing_rule TYPE record<merchant> READONLY;
DEFINE FIELD environment ON routing_rule TYPE string READONLY;
DEFINE FIELD if          ON routing_rule TYPE object FLEXIBLE;  -- {} (matches all) for sandbox
DEFINE FIELD driver      ON routing_rule TYPE string;            -- "mock"
```
> Reuses T07 `outbox_event`/`event_delivery` for stream + replay; mock driver is stateless.

### Follow-ups
- `context.ts` binding depends on `api_key→merchant` lookup (T001/T04) — land with the sandbox module (`src/modules/sandbox/`).