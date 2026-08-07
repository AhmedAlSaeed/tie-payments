/**
 * Sandbox module — Elysia plugin (module) for onboarding + mock flows (T7/T08).
 *
 * Two surfaces:
 *   - API-key (Bearer `sk_`) machine routes under `/v1/sandbox`: `test_pay` and
 *     `test_pay/qr_complete`. These reuse the REAL `PaymentService` (routed to
 *     the mock) so simulated payments run the genuine pipeline.
 *   - Session-authenticated portal routes (onboarding + guarded mock 3DS page),
 *     assembled by `createSandboxOnboardingModule` in `onboarding.ts`.
 *
 * Mounting note: production mounts this on the versioned router via `app.ts`
 * (central; outside this slice). The factory here stands alone so tests wire it
 * directly with an isolated DB + a Better Auth instance for session auth.
 *
 * Sign-up auto-provisioning (T08 D1) is wired through `sandboxProvisioningHook`,
 * passed to `createAuth(db, { onUserCreated })` — see `service.ts`/`auth.ts`.
 */
import { Elysia } from "elysia";
import type { Surreal } from "surrealdb";
import { createContextAuth } from "../../core/context";
import type { Auth } from "../../auth";
import { createSandboxOnboardingModule } from "./onboarding";
import { SandboxService } from "./service";
import { SandboxTestPayBody, QrCompleteBody } from "./model";

export interface SandboxModuleOptions {
  /** Better Auth instance for the session-authenticated portal surface. */
  auth: Auth;
}

/**
 * The module carries two distinct `derive` contexts (API-key `core.auth` and
 * Better Auth session) mounted under the shared `/v1/sandbox` path subtree.
 * Elysia's type-level plugin merge cannot reconcile two different derives on
 * one path node, so the assembled result is relaxed to the bare `Elysia` type
 * (a plugin): route handler typing lives in `index.ts`/`onboarding.ts`, and
 * callers (tests, central app.ts mount) treat it as an opaque plugin.
 */
export function createSandboxModule(db: Surreal, opts: SandboxModuleOptions): Elysia {
  const service = new SandboxService(db);
  const onboarding = createSandboxOnboardingModule(db, service, opts.auth);

  const keyRoutes = new Elysia({ prefix: "/v1/sandbox" })
    .use(createContextAuth(db))

    // POST /v1/sandbox/test_pay — real payment through the mock (T08 D3).
    .post(
      "/test_pay",
      { body: SandboxTestPayBody },
      async ({ body, merchantId, environment, role, scopes, traceId, set }) => {
        const ctx = { merchantId, environment, role, scopes, traceId };
        // Mirror the payments pillar: creating a payment is a resource creation
        // answered with 201 Created (the sandbox route must match the `/payments`
        // route's status semantics so consumers observe one contract).
        set.status = 201;
        return service.testPay(ctx, body);
      },
    )

    // POST /v1/sandbox/test_pay/qr_complete — "Simulate Scan & Pay" for a
    // `qr_`-method payment: complete it through the real inbound pipeline.
    .post(
      "/test_pay/qr_complete",
      { body: QrCompleteBody },
      async ({ body, merchantId, environment, role, scopes, traceId }) => {
        const ctx = { merchantId, environment, role, scopes, traceId };
        const result = await service.completeMockAction(ctx, {
          paymentId: body.payment_id,
          scenario: "qr",
        });
        return { handled: true, replayed: result.replayed, event_id: result.eventId ?? null };
      },
    );

  // NOTE: the assembled module deliberately does NOT `.as("plugin")` the inner
  // instances. Each sub-instance's derive guard (API-key `createContextAuth`
  // for the key routes; the Better Auth session guard for the portal) must stay
  // scoped to ITS OWN routes. `.as("plugin")` publishes those derives to the
  // mounting parent, and a full plugin chain (`keyRoutes → module → app`) would
  // leak the session/auth guards onto unrelated root routes — including
  // `/api/auth/*` — breaking the Better Auth identity surface (sign-up would
  // 401 because the session/API-key guards run before a session exists). The
  // module is self-contained: callers mount it and keep identity separate, as in
  // `src/app.ts` where `createSessionAuth` is consumed inside `/console` only.
  return new Elysia({ name: "modules.sandbox" })
    .use(keyRoutes as unknown as Elysia)
    .use(onboarding);
}

export { SandboxService, sandboxProvisioningHook, maskSecretPrefix, buildSnippet } from "./service";
export * from "./model";
