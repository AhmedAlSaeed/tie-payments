/**
 * T7 — Sandbox onboarding + mock flows integration tests.
 *
 * Uses a TEST-LOCAL app (NOT `src/app.ts`): errorHandling + createContextAuth +
 * the sandbox module + the webhooks module (autostart:false) + the Better Auth
 * identity surface. `createAuth(db, { onUserCreated: sandboxProvisioningHook(db) })`
 * means a sign-up auto-provisions the merchant scaffold (T08 D1), so the auth
 * sign-up path is exercised end-to-end. A local `Bun.serve` echo captures the
 * payload the outbox drainer POSTs for the delivery assertion.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { createSandboxModule, sandboxProvisioningHook } from "../../src/modules/sandbox";
import { createWebhooksModule } from "../../src/modules/webhooks";
import { drain, resetCooldowns } from "../../src/modules/webhooks/drainer";
import { errorHandling } from "../../src/core/errors-plugin";
import { recordIdOf } from "../../src/core/records";
import { createAuth, createIdentity } from "../../src/auth";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { http } from "../helpers/http";
import { getSession, randomEmail, sessionCookie, signUp } from "../helpers/auth";

process.env.SURREAL_TEST_DATABASE = "payments_test_t7";

const reachable = await isSurrealAvailable();

const echo = {
  url: "",
  count: 0,
  body: "",
  headers: {} as Record<string, string>,
  server: null as unknown as ReturnType<typeof Bun.serve>,
};

const bearer = (sk: string) => ({ authorization: `Bearer ${sk}` });

/** A developer + their session + their one-time raw test keys. */
interface SandboxDeveloper {
  email: string;
  cookie: string;
  userId: string;
  merchantId: string;
  skTest: string;
  pkTest: string;
}

describe.skipIf(!reachable)("sandbox (integration)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Elysia;
  // Shared sign-up-provisioned merchant, onboarded once (lazily) in the first
  // dependent test. Merchant + api_key rows persist across beforeEach.
  let merchant: SandboxDeveloper | undefined;

  async function signUpDeveloper(prefix = "dev"): Promise<SandboxDeveloper> {
    const email = randomEmail(prefix);
    const up = await signUp(app, {
      email,
      password: "SuperSecret123!",
      name: "Sandbox Developer",
    });
    expect(up.status).toBe(200);
    const cookie = sessionCookie(up.setCookies);
    expect(cookie).toBeDefined();

    const session = await getSession(app, cookie!);
    expect(session.status).toBe(200);
    const userId = (session.json as { user: { id: string } }).user.id;

    // First-ever onboarding read reveals raw secrets (`secrets_shown: false`).
    const on = await http(app, "GET", "/v1/sandbox/onboarding", { cookie });
    expect(on.status).toBe(200);
    const json = on.json as {
      merchant_id: string;
      test_keys: { sk_test: string; pk_test: string };
      secrets_shown: boolean;
      snippet: string;
    };
    expect(json.secrets_shown).toBe(false);
    expect(json.test_keys.sk_test.startsWith("sk_test_")).toBe(true);
    expect(json.test_keys.pk_test.startsWith("pk_test_")).toBe(true);
    expect(json.snippet).toContain("new Tie(");

    return {
      email,
      cookie: cookie!,
      userId,
      merchantId: json.merchant_id,
      skTest: json.test_keys.sk_test,
      pkTest: json.test_keys.pk_test,
    };
  }

  beforeAll(async () => {
    db = await createTestDb();
    const auth = createAuth(db.db, { onUserCreated: sandboxProvisioningHook(db.db) });
    app = new Elysia()
      .use(errorHandling)
      .use(createSandboxModule(db.db, { auth }))
      .use(createWebhooksModule(db.db, { autostart: false }))
      .use(createIdentity(auth));

    // Fresh slice per run (the test DB persists across runs / sessions).
    await db.db.query(
      `DELETE FROM payment;
       DELETE FROM api_key;
       DELETE FROM routing_rule;
       DELETE FROM outbox_event;
       DELETE FROM event_delivery;
       DELETE FROM webhook_endpoint;
       DELETE FROM inbound_webhook;
       DELETE FROM merchant;
       DELETE FROM account;
       DELETE FROM session;
       DELETE FROM user;
       DELETE FROM verification;`,
    );

    echo.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        echo.body = await request.text();
        echo.headers = Object.fromEntries(request.headers.entries());
        echo.count += 1;
        return new Response("ok", { status: 200 });
      },
    });
    echo.url = `http://127.0.0.1:${echo.server.port}`;
  });

  afterAll(async () => {
    echo.count = 0;
    echo.server?.stop();
    await db?.close();
  });

  // Keep the webhook/outbox slice clean between tests; merchant + keys persist.
  beforeEach(async () => {
    await db.db.query(
      `DELETE FROM payment;
       DELETE FROM outbox_event;
       DELETE FROM event_delivery;
       DELETE FROM webhook_endpoint;
       DELETE FROM inbound_webhook;`,
    );
    echo.count = 0;
    resetCooldowns();
  });

  /** Low-level outbox rows for a merchant (optionally by canonical object id). */
  async function outboxEvents(merchantId: string, objectId?: string) {
    const [rows] = await db.db
      .query(
        `SELECT type, object_id, id, created_at FROM outbox_event
         WHERE merchant = $merchant AND environment = "test"
           ${objectId ? "AND object_id = $objectId" : ""} ORDER BY created_at ASC`,
        { merchant: recordIdOf(merchantId), ...(objectId ? { objectId } : {}) },
      )
      .collect<[Array<{ type: string; object_id: string; id: string; created_at: unknown }>]>();
    return rows ?? [];
  }

  async function createEndpoint(events: string[]) {
    const res = await http(app, "POST", "/v1/webhook_endpoints", {
      headers: bearer(merchant!.skTest),
      body: { url: echo.url, events },
    });
    expect(res.status).toBe(201);
    return res.json as { id: string; secret: string };
  }

  // ---------------------------------------------------------------------------
  // 1) sign-up auto-provisioning (T08 D1)
  // ---------------------------------------------------------------------------
  it("sign-up auto-provisions a merchant, hashed test keys, and mock routing rule", async () => {
    const dev = await signUpDeveloper("provision");

    const [merchants] = await db.db
      .query("SELECT * FROM merchant WHERE auth_user = type::record('user', $id) LIMIT 1", {
        id: dev.userId,
      })
      .collect<[Array<Record<string, unknown>>]>();
    expect(merchants.length).toBe(1);

    const [keys] = await db.db
      .query(
        `SELECT role, prefix, hash FROM api_key
         WHERE merchant = $merchant AND environment = "test" AND active = true ORDER BY role`,
        { merchant: recordIdOf(dev.merchantId) },
      )
      .collect<[Array<{ role: string; prefix: string; hash: string }>]>();
    expect(keys.length).toBe(2);
    const sk = keys.find((k) => k.role === "sk");
    const pk = keys.find((k) => k.role === "pk");
    expect(sk?.prefix).toBe("sk_test_");
    expect(pk?.prefix).toBe("pk_test_");
    for (const k of keys) expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    // Raw secret never stored at rest: hash is independent of the raw value.
    const rawSecret = dev.skTest.replace(/^sk_test_/, "");
    expect(sk?.hash).not.toContain(rawSecret);
    expect(sk?.hash).not.toBe(dev.skTest);

    const [rules] = await db.db
      .query(
        `SELECT driver, position, conditions FROM routing_rule
         WHERE merchant = $merchant AND environment = "test"`,
        { merchant: recordIdOf(dev.merchantId) },
      )
      .collect<[Array<{ driver: string; position: number; conditions: unknown }>]>();
    expect(rules.length).toBe(1);
    expect(rules[0].driver).toBe("mock");
    expect(rules[0].position).toBe(0);
    expect(rules[0].conditions).toEqual({});
  });

  it("subsequent onboarding reads return masked keys (secrets shown once)", async () => {
    const dev = await signUpDeveloper("eager");
    const second = await http(app, "GET", "/v1/sandbox/onboarding", { cookie: dev.cookie });
    expect(second.status).toBe(200);
    const json = second.json as { test_keys: { sk_test: string }; secrets_shown: boolean };
    expect(json.secrets_shown).toBe(true);
    // Masked: prefix + dots only — far shorter than the raw 40-hex.
    expect(json.test_keys.sk_test.length).toBeLessThan(20);
  });

  // ---------------------------------------------------------------------------
  // 2) test_pay success + canonical event → delivery (real inbound path)
  // ---------------------------------------------------------------------------
  it("test_pay (tok_mock_4242) succeeds; inbound completion reaches a delivery", async () => {
    if (!merchant) merchant = await signUpDeveloper("pay");
    const headers = bearer(merchant.skTest);

    const pay = await http(app, "POST", "/v1/sandbox/test_pay", {
      headers,
      body: { amountMinor: 100, currency: "BHD", method: "tok_mock_4242" },
    });
    expect(pay.status).toBe(201);
    const resource = pay.json as {
      id: string;
      object: string;
      status: string;
      providerReference: string;
      environment: string;
    };
    expect(resource.object).toBe("payment");
    expect(resource.status).toBe("succeeded");
    expect(resource.environment).toBe("test");
    expect(resource.providerReference).toMatch(/^mock_pay_/);

    // Drive completion through the same inbound path a real gateway uses.
    const inbound = await http(app, "POST", "/v1/gateway/webhooks/mock", {
      headers,
      body: { id: "mock_evt_success", reference: resource.providerReference, type: "payment" },
    });
    expect(inbound.status).toBe(200);
    expect((inbound.json as { replayed: boolean }).replayed).toBe(false);
    const eventId = (inbound.json as { event_id?: string }).event_id;
    expect(eventId).toBeTruthy();

    // Subscribed endpoint + drain → delivery log exposes the canonical event.
    const ep = await createEndpoint(["payment.succeeded"]);
    const results = await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });
    expect(results.some((r) => r.status === "delivered")).toBe(true);
    expect(echo.count).toBe(1);

    const deliveries = await http(app, "GET", "/v1/event_deliveries", { headers });
    expect(deliveries.status).toBe(200);
    const rows = deliveries.json as Array<Record<string, unknown>>;
    expect(rows.some((r) => String(r.event).includes(eventId!))).toBe(true);
    expect(rows.some((r) => String(r.endpoint).includes(ep.id))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3) 3DS requires_action → guarded page + inbound completion (idempotent)
  // ---------------------------------------------------------------------------
  it("tok_mock_3d01 returns requires_action redirect; inbound completion emits payment.succeeded", async () => {
    if (!merchant) merchant = await signUpDeveloper("3ds");
    const headers = bearer(merchant.skTest);

    const pay = await http(app, "POST", "/v1/sandbox/test_pay", {
      headers,
      body: { amountMinor: 250, currency: "BHD", method: "tok_mock_3d01" },
    });
    expect(pay.status).toBe(201);
    const resource = pay.json as {
      id: string;
      status: string;
      action: { kind: string; url: string };
      providerReference: string;
    };
    expect(resource.status).toBe("requires_action");
    expect(resource.action.kind).toBe("redirect");
    // Redirect hits the REAL guarded route with the payment id in the query.
    expect(resource.action.url).toMatch(/^\/mock\/3ds\?/);
    expect(resource.action.url).toContain(`payment=${resource.id}`);

    // Complete through the real inbound ingress (T08 D4 — HTTP level).
    const payload = {
      id: "mock_evt_3ds_t1",
      reference: resource.providerReference,
      type: "payment",
    };
    const first = await http(app, "POST", "/v1/gateway/webhooks/mock", { headers, body: payload });
    expect((first.json as { replayed: boolean }).replayed).toBe(false);

    const events = await outboxEvents(merchant.merchantId, resource.providerReference);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("payment.succeeded");

    // Idempotency: replay is a 200 no-op, still a single canonical event.
    const replay = await http(app, "POST", "/v1/gateway/webhooks/mock", { headers, body: payload });
    expect((replay.json as { replayed: boolean }).replayed).toBe(true);
    expect((await outboxEvents(merchant.merchantId, resource.providerReference)).length).toBe(1);
  });

  it("serves the guarded mock 3DS challenge page (session required)", async () => {
    if (!merchant) merchant = await signUpDeveloper("page");

    const anon = await http(app, "GET", "/mock/3ds?payment=pay_x");
    expect(anon.status).toBe(401);

    const page = await http(app, "GET", "/mock/3ds?amount=250&currency=BHD&payment=pay_x", {
      cookie: merchant.cookie,
    });
    expect(page.status).toBe(200);
    expect(String(page.headers.get("content-type"))).toContain("text/html");
    expect(page.text).toContain("Mock 3DS Challenge");
  });

  it("mock 3DS confirm completes a requires_action payment through the inbound pipeline", async () => {
    if (!merchant) merchant = await signUpDeveloper("confirm");
    const cookie = merchant.cookie;

    const pay = await http(app, "POST", "/v1/sandbox/test_pay", {
      headers: bearer(merchant.skTest),
      body: { amountMinor: 300, currency: "BHD", method: "tok_mock_3d01" },
    });
    const resource = pay.json as { id: string; providerReference: string };

    const confirm = await http(app, "POST", "/mock/3ds/confirm", {
      cookie,
      body: { payment_id: resource.id, amount: 300, currency: "BHD" },
    });
    expect(confirm.status).toBe(200);
    expect((confirm.json as { handled: boolean }).handled).toBe(true);

    const events = await outboxEvents(merchant.merchantId, resource.providerReference);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("payment.succeeded");

    // Idempotent: confirming again is a replayed no-op, still one event.
    const replay = await http(app, "POST", "/mock/3ds/confirm", {
      cookie,
      body: { payment_id: resource.id, amount: 300, currency: "BHD" },
    });
    expect((replay.json as { replayed: boolean }).replayed).toBe(true);
    expect((await outboxEvents(merchant.merchantId, resource.providerReference)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 4) QR "Simulate Scan & Pay" → completes through the real inbound pipeline
  // ---------------------------------------------------------------------------
  it("qr_ method returns a QR requires_action and qr_complete emits payment.succeeded", async () => {
    if (!merchant) merchant = await signUpDeveloper("qr");
    const headers = bearer(merchant.skTest);

    const pay = await http(app, "POST", "/v1/sandbox/test_pay", {
      headers,
      body: { amountMinor: 42, currency: "BHD", method: "qr_benefitpay" },
    });
    expect(pay.status).toBe(201);
    const resource = pay.json as {
      id: string;
      status: string;
      action: { kind: string; code: string };
      providerReference: string;
    };
    expect(resource.status).toBe("requires_action");
    expect(resource.action.kind).toBe("qr");
    expect(resource.action.code).toMatch(/^mock-fawri:/);

    const done = await http(app, "POST", "/v1/sandbox/test_pay/qr_complete", {
      headers,
      body: { payment_id: resource.id },
    });
    expect(done.status).toBe(200);
    expect((done.json as { handled: boolean }).handled).toBe(true);

    const events = await outboxEvents(merchant.merchantId, resource.providerReference);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("payment.succeeded");

    // Idempotent completion.
    const again = await http(app, "POST", "/v1/sandbox/test_pay/qr_complete", {
      headers,
      body: { payment_id: resource.id },
    });
    expect((again.json as { replayed: boolean }).replayed).toBe(true);
    expect((await outboxEvents(merchant.merchantId, resource.providerReference)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 5) auth guards
  // ---------------------------------------------------------------------------
  it("rejects an unknown API key with 401 on test_pay", async () => {
    const res = await http(app, "POST", "/v1/sandbox/test_pay", {
      headers: bearer(`sk_test_${"a".repeat(40)}`),
      body: { amountMinor: 100, currency: "BHD", method: "tok_mock_4242" },
    });
    expect(res.status).toBe(401);
  });

  it("gates session onboarding behind a session (401 unauthenticated)", async () => {
    const res = await http(app, "GET", "/v1/sandbox/onboarding");
    expect(res.status).toBe(401);
  });
});
