/**
 * Sandbox session-authenticated surface (T08 D2 + D4).
 *
 * These routes are gated by a Better Auth session cookie (via the shared
 * `createSessionAuth` plugin) — they are the human/portal seam, distinct from
 * the `sk_|pk_` Bearer-key machine surface in `index.ts`.
 *
 * Routes:
 *   - `GET  /v1/sandbox/onboarding` — returns `merchant_id`, test keys (RAW on
 *     the first-ever read, masked thereafter), and the 1-line SDK snippet.
 *   - `GET  /mock/3ds`              — the guarded mock 3DS challenge page.
 *   - `POST /mock/3ds/confirm`      — "Confirm" completes the requires_action
 *     payment through the real inbound pipeline (same WebhooksService path as
 *     a gateway webhook), idempotent per payment.
 */
import { Elysia } from "elysia";
import type { Surreal } from "surrealdb";
import { createSessionAuth } from "../../auth/session";
import type { Auth } from "../../auth";
import type { MerchantContext } from "../../core/context";
import { SandboxService } from "./service";
import {
  Mock3dsConfirmBody,
  Mock3dsQuery,
  OnboardingResource,
  type OnboardingResource as OnboardingResourceType,
} from "./model";

/** Minimal branded mock 3DS challenge page (returns raw HTML). */
function render3dsPage(query: {
  token?: string;
  amount?: number;
  currency?: string;
  payment?: string;
}): string {
  const payload = JSON.stringify({
    payment_id: query.payment,
    token: query.token,
    amount: query.amount,
    currency: query.currency,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mock 3DS Challenge — tie-payments sandbox</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 420px; margin: 64px auto; padding: 0 16px; }
  .card { border: 1px solid rgba(127,127,127,.4); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.15rem; margin: 0 0 8px; }
  p { color: #666; }
  #status { min-height: 1.2em; margin: 12px 0; font-size: .9rem; }
  button {
    width: 100%; padding: 12px; border: 0; border-radius: 8px; font: inherit;
    background: #2563eb; color: #fff; cursor: pointer;
  }
  button[disabled] { opacity: .5; }
</style>
</head>
<body>
<div class="card">
  <h1>Mock 3DS Challenge</h1>
  <p>Simulated bank authentication for your sandbox payment of
     ${query.amount ?? "…"} ${query.currency ?? ""}.</p>
  <div id="status">Ready</div>
  <button id="confirm">Confirm</button>
</div>
<script>
  const payload = ${payload};
  document.getElementById("confirm").addEventListener("click", async () => {
    const btn = document.getElementById("confirm");
    btn.disabled = true;
    const status = document.getElementById("status");
    status.textContent = "Confirming…";
    try {
      const res = await fetch("/mock/3ds/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      status.textContent = json.replayed
        ? "Already completed (replayed)."
        : "Payment authenticated — canonical event emitted.";
    } catch (e) {
      status.textContent = "Confirmation failed.";
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}

export function createSandboxOnboardingModule(
  _db: Surreal,
  service: SandboxService,
  auth: Auth,
): Elysia {
  // NOTE: the session `derive` must stay scoped to the portal subtrees. A
  // root-level `createSessionAuth` would apply its unauthenticated guard to
  // EVERY route mounted after this module (including `/api/auth/*`), exactly
  // the leak the production `app.ts` avoids by mounting `createSessionAuth`
  // inside a prefixed instance (`/console`). Each portal surface therefore
  // gets its own prefix-scoped instance, and we deliberately do NOT
  // `.as("plugin")` these instances: publishing them would propagate the
  // session guard to the mounting parent (and the assembled sandbox module),
  // breaking the identity surface in exactly that way.
  const portalApi = new Elysia({ prefix: "/v1/sandbox" })
    .use(createSessionAuth(auth))

    .get(
      "/onboarding",
      { response: OnboardingResource },
      async ({ user }): Promise<OnboardingResourceType> => {
        const data = await service.onboard({ id: user.id, name: user.name });
        const sk = data.raw ? data.raw.skTest : data.skMasked;
        const pk = data.raw ? data.raw.pkTest : data.pkMasked;
        return {
          merchant_id: data.merchantId,
          environment: "test",
          test_keys: { sk_test: sk, pk_test: pk },
          secrets_shown: !data.raw,
          snippet: `const tie = new Tie("${sk}"); await tie.payments.create({ amountMinor: 100, currency: "BHD" });`,
        };
      },
    ) as unknown as Elysia;

  const mockPortal = new Elysia({ prefix: "/mock" })
    .use(createSessionAuth(auth))

    // Guarded mock 3DS challenge page (sandbox-only, session-authenticated).
    .get(
      "/3ds",
      { query: Mock3dsQuery },
      ({ query }) =>
        new Response(render3dsPage(query), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    )

    // Confirmation: complete the requires_action payment through the same
    // inbound pipeline (WebhooksService.ingestInboundWebhook) a real gateway
    // webhook uses — idempotent per payment.
    .post("/3ds/confirm", { body: Mock3dsConfirmBody }, async ({ body, user }) => {
      const { merchantId } = await service.provisionScaffold({ id: user.id });
      const ctx: MerchantContext = {
        merchantId,
        environment: "test",
        role: "secret",
        scopes: [],
        traceId: crypto.randomUUID(),
      };
      // payment_id is authoritative; otherwise reconstruct the mock 3DS ref.
      const reference =
        body.payment_id !== undefined
          ? undefined
          : body.amount !== undefined && body.currency !== undefined
            ? `mock_3ds_${body.amount}_${body.currency}`
            : undefined;
      const result = await service.completeMockAction(ctx, {
        paymentId: body.payment_id,
        reference,
        scenario: "3ds",
      });
      return { handled: true, replayed: result.replayed, event_id: result.eventId ?? null };
    }) as unknown as Elysia;

  return new Elysia({ name: "modules.sandbox.onboarding" }).use(portalApi).use(mockPortal);
}
