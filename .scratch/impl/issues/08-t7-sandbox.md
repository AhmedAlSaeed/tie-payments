# 08 — T7: Sandbox onboarding + mock flows (T08)

**What to build:** Under-60-second onboarding. Better Auth signup auto-provisions merchant + sk_test/pk_test (hash-stored) + default mock RoutingRule + 1-line snippet. Simulated payments drive the real pipeline (events reach streamer). 3D01 → guarded mock 3DS challenge page. QR → "Simulate Scan & Pay".

**Blocked by:** 01 (F0), 04 (T5 — webhook engine).

**Status:** resolved (implemented 2026-08-06, `backend` subagent; first attempt cancelled mid-flight, take-over agent fixed to green)

## Resolution

New `src/modules/sandbox/` (model/service/repository/onboarding/index) + `test/integration/sandbox.test.ts`; `src/auth/auth.ts` extended with `createAuth(db, { onUserCreated })` using Better Auth `databaseHooks.user.create.after`. Mounted at the app root (portal is session-authenticated, outside the `/v1` API-key router). 9 tests (+ auth-flow regression 7/7); full suite 125 green; typecheck + lint clean.

- [x] Signup auto-provisions merchant + `sk_test`/`pk_test` (SHA-256 hash-only) + default mock `routing_rule` (`conditions {}`, driver `mock`, position 0) — hook best-effort (never fails signup).
- [x] `context.ts` binds merchantId/env from the key record — already landed in F0 (verified, not redone).
- [x] `test_pay` (4242/0002/3d01/qr_) routes through the REAL payment + inbound webhook → canonical pipeline; visible in `GET /v1/event_deliveries` when a `webhook_endpoint` is configured.
- [x] Guarded `/mock/3ds` challenge (session-authenticated page) + `POST /mock/3ds/confirm` completes requires_action via the same inbound path (WebhooksService ingest), idempotent per payment.
- [x] Mock QR → `qr_complete` ("Simulate Scan & Pay") through the same inbound pipeline.
- [x] Tests (onboarding + streamer visibility) + typecheck + lint clean.

**Key fixes (take-over):** Elysia `.as("plugin")` guard leak — publishing the API-key + session derives to the parent made `POST /api/auth/sign-up/email` 401 before Better Auth saw it; scoped each sub-instance's derive instead. `test_pay` now returns 201 (payments contract). Test helper projection fixed (`created_at` in ORDER BY).

**Notes:** `routeDriver` still defaults to the mock for sandbox (DB-backed routing-rule load deferred). Cancel modes / dunning remain later tickets.

GitHub: #22
