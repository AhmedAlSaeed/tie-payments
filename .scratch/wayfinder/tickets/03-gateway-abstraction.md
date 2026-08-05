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

## Resolution

Prototype landed as the T03 kernel under `src/core/gateway/` on Elysia 2.0.0-beta.1. Gates green: `bun run typecheck`/`lint`/`fmt --check`/`test` (44 pass). Unblocks T08 (sandbox/mock).

### Driver interface & error contract (`driver.ts`, `index.ts`)
- `GatewayDriver` port: `createPayment`, optional `tokenize`/`capture`/`refund`/`void`, and optional `normalizeWebhook`. `id`, `label`, and `capabilities` (currencies, methods, 3DS/manual-capture/tokenization booleans) describe the driver for routing.
- Error contract (`types.ts`): a **closed set** `GatewayErrorCode` (`card_declined`, `insufficient_funds`, `expired_card`, `invalid_card`, `gateway_timeout`, `gateway_unavailable`, `invalid_request`, `authentication_failed`, `rate_limited`, `amount_mismatch`, `processing_error`) carried on a `GatewayError` (`instanceof Error`) with a **`retryable` flag** and optional `providerCode`. `retryable` is the single signal routing failover and dunning (T06) branch on — no per-gateway internals leak up.
- `isRetryableCode` maps a code to a retryable default if a driver omits the flag.

### Normalized payloads (`types.ts`)
- Money always travels as **minor units + `currency`**, exponent derived from `CURRENCY_EXPONENT` (BHD=3 fils) — never hardcoded ×100 (T02 gotcha).
- `ChargeAction` = `redirect | qr | client_secret | hosted_page | none`; `ChargeResult` = `{ status, providerReference, authorizedAmountMinor, action, raw` (raw kept verbatim for audit/normalizer). `CaptureRequest`/`RefundRequest`/`RevokeRequest` reference by `providerReference`.

### Routing (`routing.ts`)
- A `RoutingRule` = `{ id, if: {currency[], methodPrefix?, amountMinorMax?, preferredDriver?}, driver, failover? }`. Evaluated **in array order** — precedence = caller sorts the array; `matchRule` returns the first matching driver id or falls back to `ctx.preferredDriver`. `defaultSandboxRules` routes everything to `mock`. `resolveDriver` looks a driver id up against the registry.
- Dependency-free: no DSL/interpreter per `minimal deps`.

### Cross-gateway token (`token.ts`)
- A unified token holds multiple `GatewayToken`s (`driverId → token`) so one `tok_…` works across every routed gateway; `upsertGatewayToken`/`tokenForDriver` helpers. In-memory now, durable store at T001.

### Mock driver (`mock.ts` — SPEC 4.3)
- Implements the full seam with no HTTP + 30ms latency. Classifies the token: ends **4242 success / ends 0002 → non-retryable decline, 9999 retryable timeout, 3D01 redirect 3DS (requires_action), or **QR BenefitPay QR for the mock (requires_action scan). tokenize echoes last-4. Default sandbox registry (`registry. prepopulated + `defaultFor('test')→mock`).

### Wiring
- `PaymentService` (Elysia-free) now takes the `GatewayDriver` per method and maps the normalized outcome onto `PaymentResource` (added `action` + `providerReference` + `method`). `PaymentsPlugin` builds it (registry + mock); `routeDriver` chooses the per-request driver from routing rules; throws `gateway_error` (502) if none configured for the env.

## Follow-up / not yet
- **SurrealDB `TokenStore`** replaces the in-memory unified-token map (T001).
- **Per-merchant routing config + failover loop** (retry next-matched driver on `retryable`) — lands with DB-backed config (T05/T08).
- **Real Tap/Stripe/Moyasar drivers** — each implements the same seam; registered in place of mock for `live`.
- **`normalizeWebhook`** gets exercised end-to-end by T07 (event bus).
