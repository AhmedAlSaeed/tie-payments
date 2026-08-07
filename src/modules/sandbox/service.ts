/**
 * Sandbox service — onboarding + mock-flow business logic (Elysia-free).
 *
 * Owns:
 *   - `provisionScaffold`   — idempotent sign-up provisioning (merchant + hashed
 *     sk/pk test keys + default mock routing rule). Does NOT return raw secrets;
 *     used by the Better Auth sign-up hook.
 *   - `onboard`             — the one-time credential reveal for `GET
 *     /v1/sandbox/onboarding`: ensures the scaffold exists, then the FIRST read
 *     rotates in a fresh hashed key pair and returns the raw values exactly
 *     once (stamped in `merchant.settings.sandbox_keys_revealed_at`). Later
 *     reads return only masked prefixes.
 *   - `testPay`             — drive a payment through the REAL `PaymentService`
 *     (routed to the mock), returning the payment resource (3DS redirect URL
 *     augmented with the payment id so the browser challenge can complete it).
 *   - `completeMockAction`  — complete a requires_action (3DS/QR) payment by
 *     feeding the mock's completion payload through the SAME inbound
 *     `normalizeWebhook → de-dup → outbox` path a real gateway webhook uses.
 *
 * Secrets discipline: raw keys live ONLY in return values; the `api_key` table
 * always stores SHA-256 hashes. The one-time reveal is implemented as a
 * rotation (deactivate the provisional pair, insert a fresh pair) so raw values
 * exist nowhere at rest (T08 D6 / PCI SAQ-A).
 */
import type { Surreal } from "surrealdb";
import { generateKey, parseKey } from "../../core/apikey";
import type { MerchantContext } from "../../core/context";
import { problem } from "../../core/errors";
import { GatewayError } from "../../core/gateway";
import { PaymentsRepository } from "../payments/repository";
import { PaymentService } from "../payments/service";
import { routeDriver } from "../payments";
import { WebhooksService } from "../webhooks/service";
import { SandboxRepository } from "./repository";
import type { SandboxTestPayBody } from "./model";
import type { PaymentResource } from "../payments/model";

/** A freshly generated test credential pair — return-only, never stored. */
export interface RevealedKeyPair {
  skTest: string;
  pkTest: string;
}

/** Redaction shown on reads after the secrets were already revealed. */
export const SANDBOX_MASK = "••••••••••";

/** Mask a stored key for display: keep the `sk_test_` prefix, redact the rest. */
export function maskSecretPrefix(prefix: string): string {
  return `${prefix}${SANDBOX_MASK}`;
}

/** Build the 1-line SDK usage snippet (SPEC §4.2). */
export function buildSnippet(skTest: string): string {
  return `const tie = new Tie("${skTest}"); await tie.payments.create({ amountMinor: 100, currency: "BHD" });`;
}

/**
 * Better Auth `onUserCreated` callback for sign-up auto-provisioning (T08 D1).
 * Pass to `createAuth(db, { onUserCreated: sandboxProvisioningHook(db) })`.
 * Errors are swallowed (the auth layer + `provisionScaffold` never throw on a
 * provisioning failure) so a sign-up is never blocked by onboarding.
 */
export function sandboxProvisioningHook(db: Surreal) {
  const service = new SandboxService(db);
  return (user: { id: string; name?: string | null }): Promise<void> =>
    service.provisionScaffold({ id: user.id, name: user.name }).then(() => undefined);
}

export class SandboxService {
  private readonly repo: SandboxRepository;
  private readonly payments: PaymentService;
  private readonly paymentsRepo: PaymentsRepository;
  private readonly webhooks: WebhooksService;

  constructor(private readonly db: Surreal) {
    this.repo = new SandboxRepository(db);
    this.paymentsRepo = new PaymentsRepository(db);
    this.payments = new PaymentService(this.paymentsRepo);
    this.webhooks = new WebhooksService(db);
  }

  // ---------------------------------------------------------------------------
  // Sign-up provisioning (T08 D1)
  // ---------------------------------------------------------------------------

  /**
   * Ensure a merchant + hashed test keys + default mock routing rule exist for
   * a Better Auth user. Idempotent: a second call for an already-provisioned
   * user is a no-op.
   */
  async provisionScaffold(opts: {
    id: string;
    name?: string | null;
  }): Promise<{ merchantId: string }> {
    const existing = await this.repo.findMerchantByAuthUser(opts.id);
    if (existing) return { merchantId: existing.id };

    const merchantKey = crypto.randomUUID();
    const merchantId = `merchant:${merchantKey}`;
    await this.repo.createMerchant({
      merchantKey,
      authUserId: opts.id,
      name: opts.name ?? "Sandbox Merchant",
    });

    // One sk_test + one pk_test (hash-only) + default mock routing rule.
    await this.issueKeyPair(merchantId);
    await this.repo.createRoutingRule({
      merchantId,
      environment: "test",
      driver: "mock",
      position: 0,
      conditions: {}, // match-all
    });

    return { merchantId };
  }

  // ---------------------------------------------------------------------------
  // Onboarding read (one-time reveal)
  // ---------------------------------------------------------------------------

  /**
   * Build the onboarding payload. If the merchant scaffold is missing (e.g. a
   * pre-feature user whose sign-up hook never ran) it is provisioned now; the
   * first-ever read rotates credentials and returns RAW secrets once.
   */
  async onboard(opts: { id: string; name?: string | null }): Promise<{
    merchantId: string;
    environment: "test";
    raw: RevealedKeyPair | undefined;
    skMasked: string;
    pkMasked: string;
  }> {
    const { merchantId } = await this.provisionScaffold(opts);
    const merchant = await this.repo.findMerchantById(merchantId);
    const revealed = Boolean(merchant?.settings?.sandbox_keys_revealed_at);

    let raw: RevealedKeyPair | undefined;
    if (!revealed) {
      // Issue a fresh pair (rotate out any provisional keys) + stamp revealed.
      await this.repo.deactivateActiveTestKeys(merchantId);
      raw = await this.issueKeyPair(merchantId);
      await this.repo.markSecretsRevealed(merchantId);
    }

    const keys = await this.repo.listActiveTestKeys(merchantId);
    const sk = keys.find((k) => k.role === "sk");
    const pk = keys.find((k) => k.role === "pk");
    const skMasked = sk ? maskSecretPrefix(sk.prefix) : (raw?.skTest ?? "");
    const pkMasked = pk ? maskSecretPrefix(pk.prefix) : (raw?.pkTest ?? "");

    return { merchantId, environment: "test", raw, skMasked, pkMasked };
  }

  // ---------------------------------------------------------------------------
  // Test payments (T08 D3)
  // ---------------------------------------------------------------------------

  /**
   * Create a payment through the real PaymentService, routed to the mock
   * (sandbox default). For `requires_action` redirect (3DS) the action URL is
   * augmented with the payment id + amount + currency so `/mock/3ds` can
   * complete it in a browser.
   */
  async testPay(ctx: MerchantContext, body: SandboxTestPayBody): Promise<PaymentResource> {
    if (ctx.environment !== "test") {
      throw problem("insufficient_permissions", "Sandbox test_pay is test-environment only.");
    }
    if (ctx.role !== "secret") {
      throw problem("insufficient_permissions", "test_pay requires a secret (sk_) API key.");
    }

    const gateway = routeDriver("test", body.currency, body.amountMinor, body.method);
    let resource: PaymentResource;
    try {
      resource = await this.payments.createPayment(ctx, body, gateway);
    } catch (error) {
      // Normalize any gateway outcome (decline / timeout) into the problem
      // taxonomy. The mock throws GatewayError for 0002 / 9999.
      if (error instanceof GatewayError) {
        throw problem("gateway_error", error.message);
      }
      throw error;
    }

    // Augment the mock 3DS redirect with the payment id for browser completion.
    if (resource.action?.kind === "redirect" && resource.action.url.startsWith("/mock/3ds")) {
      // Normalize to the exposed guarded route `GET /mock/3ds` (the driver
      // returns `/mock/3ds/<method>`, which no route matches) + query params so
      // a browser navigation completes the challenge against a real route.
      const url = new URL("/mock/3ds", "http://localhost");
      url.searchParams.set("payment", resource.id);
      url.searchParams.set("amount", String(resource.amountMinor));
      url.searchParams.set("currency", resource.currency);
      if (body.method) url.searchParams.set("token", body.method);
      resource = {
        ...resource,
        action: { kind: "redirect", url: `${url.pathname}${url.search}` },
      };
    }
    return resource;
  }

  /**
   * Complete a requires_action (3DS or mock QR) payment by feeding the mock's
   * completion payload through the REAL inbound webhook pipeline — the same
   * `normalizeWebhook → inbound_webhook dedup → outbox_event` path as
   * `POST /v1/gateway/webhooks/:driver`. Idempotent per payment: the gateway
   * event id is derived deterministically from the reference, so a second
   * complete is a 200 no-op (replayed).
   */
  async completeMockAction(
    ctx: MerchantContext,
    opts: { paymentId?: string; reference?: string; scenario: "3ds" | "qr" },
  ): Promise<{ replayed: boolean; eventId?: string }> {
    let reference = opts.reference;
    if (!reference && opts.paymentId) {
      const record = await this.paymentsRepo.findById(
        ctx.merchantId,
        ctx.environment,
        opts.paymentId,
      );
      if (!record) throw problem("resource_not_found", "Payment not found.");
      reference = record.providerReference;
    }
    if (!reference) {
      throw problem(
        "validation_error",
        "A payment reference (or the payment_id) is required to complete the action.",
      );
    }
    const rawBody = JSON.stringify({
      id: `mock_evt_${opts.scenario}_${reference}`,
      reference,
      type: "payment",
    });
    return this.webhooks.ingestInboundWebhook(ctx, "mock", rawBody, {});
  }

  // ---------------------------------------------------------------------------

  /** Generate + persist a fresh sk/pk test pair (hash-only); returns raw once. */
  private async issueKeyPair(merchantId: string): Promise<RevealedKeyPair> {
    const skRaw = generateKey("sk", "test");
    const pkRaw = generateKey("pk", "test");
    await Promise.all(
      [skRaw, pkRaw].map(async (raw) => {
        const parsed = parseKey(raw);
        await this.repo.createApiKey({
          merchantId,
          environment: parsed.env,
          role: parsed.type,
          prefix: `${parsed.type}_${parsed.env}_`,
          hash: parsed.hash,
        });
      }),
    );
    return { skTest: skRaw, pkTest: pkRaw };
  }
}
