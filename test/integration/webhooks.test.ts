/**
 * T5 — Webhook engine (outbox + delivery) integration tests.
 *
 * Runs against a dedicated `payments_test_t5` database via `createTestDb`; a
 * local `Bun.serve` echo captures the raw body + headers the drainer POSTs so
 * we can assert signature + envelope end-to-end. Uses a test-local app (NOT
 * `src/app.ts`) so this pillar is exercised in isolation with the real auth +
 * error plugins.
 */
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { createWebhooksModule } from "../../src/modules/webhooks";
import { drain, resetCooldowns } from "../../src/modules/webhooks/drainer";
import { signPayload, verifySignature } from "../../src/modules/webhooks/signer";
import { errorHandling } from "../../src/core/errors-plugin";
import { createContextAuth } from "../../src/core/context";
import { recordIdOf } from "../../src/core/records";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { provisionMerchant, type ProvisionedMerchant } from "../helpers/merchant";
import { http } from "../helpers/http";

process.env.SURREAL_TEST_DATABASE = "payments_test_t5";

const reachable = await isSurrealAvailable();

const echo = {
  url: "",
  count: 0,
  body: "",
  headers: {} as Record<string, string>,
  server: null as unknown as ReturnType<typeof Bun.serve>,
};
const failEcho = {
  url: "",
  count: 0,
  body: "",
  headers: {} as Record<string, string>,
  server: null as unknown as ReturnType<typeof Bun.serve>,
};

describe.skipIf(!reachable)("webhook engine (integration)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: Elysia;
  let merchant: ProvisionedMerchant;

  beforeAll(async () => {
    db = await createTestDb();
    app = new Elysia()
      .use(errorHandling)
      .use(createContextAuth(db.db))
      .use(createWebhooksModule(db.db, { autostart: false }));
    merchant = await provisionMerchant(db.db);
    resetCooldowns();

    // Fresh slice per run so re-runs are idempotent (the test DB persists).
    await db.db.query(
      `DELETE FROM outbox_event;
       DELETE FROM event_delivery;
       DELETE FROM webhook_endpoint;
       DELETE FROM inbound_webhook;`,
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
    const echoUrl = `http://127.0.0.1:${echo.server.port}`;

    failEcho.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        failEcho.body = await request.text();
        failEcho.headers = Object.fromEntries(request.headers.entries());
        failEcho.count += 1;
        return new Response("nope", { status: 500 });
      },
    });
    const failUrl = `http://127.0.0.1:${failEcho.server.port}`;
    echo.url = echoUrl;
    failEcho.url = failUrl;
  });

  afterAll(async () => {
    echo.count = 0;
    failEcho.count = 0;
    echo.server.stop();
    failEcho.server.stop();
    await db?.close();
  });

  // Every test starts from a clean webhook slice (the DB persists across tests).
  beforeEach(async () => {
    await db.db.query(
      `DELETE FROM outbox_event;
       DELETE FROM event_delivery;
       DELETE FROM webhook_endpoint;
       DELETE FROM inbound_webhook;`,
    );
    resetCooldowns();
  });

  async function createEndpoint(url: string, events: string[], maxAttempts?: number) {
    const res = await http(app, "POST", "/v1/webhook_endpoints", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { url, events, ...(maxAttempts !== undefined ? { max_attempts: maxAttempts } : {}) },
    });
    expect(res.status).toBe(201);
    return res.json as { id: string; secret: string };
  }

  async function seedOutbox(type: string, objectId: string): Promise<string> {
    const id = `evt_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.db.query(
      `INSERT INTO outbox_event {
         id: $id, merchant: $merchant, environment: "test",
         type: $type, object_type: "payment", object_id: $objectId, object: $object, window: time::now()
       }`,
      {
        id,
        merchant: recordIdOf(merchant.merchantId),
        type,
        objectId,
        object: { reference: objectId },
      },
    );
    return id;
  }

  async function deliveryRows(eventId: string, endpointId: string) {
    const [rows] = await db.db
      .query(
        `SELECT * FROM event_delivery
         WHERE merchant = $merchant AND environment = "test"
           AND event = type::record('outbox_event', $eventId)
           AND endpoint = type::record('webhook_endpoint', $endpointId)`,
        { merchant: recordIdOf(merchant.merchantId), eventId, endpointId },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return rows ?? [];
  }

  it("rejects unauthenticated requests (401)", async () => {
    const res = await http(app, "GET", "/v1/webhook_endpoints");
    expect(res.status).toBe(401);
  });

  it("creates an endpoint, returns the secret once, and masks it on reads", async () => {
    const created = await createEndpoint(echo.url, ["payment.succeeded"]);
    expect(created.id).toBeTruthy();
    expect(created.secret.startsWith("whsec_")).toBe(true);

    const list = await http(app, "GET", "/v1/webhook_endpoints", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(list.status).toBe(200);
    for (const row of list.json as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty("secret");
    }

    const got = await http(app, "GET", `/v1/webhook_endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect((got.json as { secret?: string }).secret).toBeUndefined();

    const patched = await http(app, "PATCH", `/v1/webhook_endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { enabled: false },
    });
    expect(patched.status).toBe(200);
    expect((patched.json as { enabled: boolean }).enabled).toBe(false);

    const del = await http(app, "DELETE", `/v1/webhook_endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(del.status).toBe(200);

    const gone = await http(app, "GET", `/v1/webhook_endpoints/${created.id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(gone.status).toBe(404);
  });

  it("signs and verifies; rejects tampered body and wrong secret", () => {
    const secret = "whsec_test_secret";
    const body = `{"id":"evt_1"}`;
    const { timestamp, signature } = signPayload(secret, body);
    expect(verifySignature(secret, body, timestamp, signature, 300)).toBe(true);
    expect(verifySignature(secret, `{"id":"evt_2"}`, timestamp, signature, 300)).toBe(false);
    expect(verifySignature("whsec_other", body, timestamp, signature, 300)).toBe(false);
  });

  it("drains a seeded outbox event to the echo with a signed payload + delivered_at", async () => {
    echo.count = 0;
    resetCooldowns();
    const ep = await createEndpoint(echo.url, ["payment.succeeded"]);
    const eventId = await seedOutbox("payment.succeeded", "pay_seed_1");

    const results = await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("delivered");
    expect(echo.count).toBe(1);

    const body = JSON.parse(echo.body) as { id: string };
    expect(body.id).toBe(eventId);
    expect(echo.headers["tie-timestamp"]).toBeTruthy();
    expect(echo.headers["tie-signature"]).toBeTruthy();
    expect(
      verifySignature(
        ep.secret,
        echo.body,
        echo.headers["tie-timestamp"],
        echo.headers["tie-signature"],
        300,
      ),
    ).toBe(true);

    const rows = await deliveryRows(eventId, ep.id);
    expect(rows.length).toBe(1);
    expect(rows[0].delivered_at).toBeTruthy();
  });

  it("at-least-once: draining twice yields one delivery row and one echo hit", async () => {
    echo.count = 0;
    resetCooldowns();
    const ep = await createEndpoint(echo.url, ["payment.dedup"]);
    const eventId = await seedOutbox("payment.dedup", "pay_dedup");

    const first = await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });
    const second = await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });

    expect(first.length).toBe(1);
    expect(second.length).toBe(0); // already delivered → nothing due
    expect(echo.count).toBe(1);
    const rows = await deliveryRows(eventId, ep.id);
    expect(rows.length).toBe(1); // UNIQUE (event, endpoint) dedup held
  });

  it("retries on failure and dead-letters after max_attempts", async () => {
    failEcho.count = 0;
    resetCooldowns();
    const ep = await createEndpoint(failEcho.url, ["payment.retry"]); // default max_attempts = 3
    const eventId = await seedOutbox("payment.retry", "pay_retry");

    await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });
    await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });
    await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });

    expect(failEcho.count).toBe(3);
    const rows = await deliveryRows(eventId, ep.id);
    expect(rows.length).toBe(1);
    expect(rows[0].deadlettered_at).toBeTruthy();
    expect(rows[0].response_status).toBe(500);
    expect(rows[0].attempt).toBe(3);
  });

  it("returns the Stripe v1 envelope from GET /v1/events", async () => {
    const evtId = await seedOutbox("payment.env", "pay_env");
    const res = await http(app, "GET", "/v1/events", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(res.status).toBe(200);
    const events = res.json as Array<Record<string, unknown>>;
    const match = events.find((e) => e.id === evtId);
    expect(match).toBeTruthy();
    expect(match!.api_version).toBe("2026-08-01");
    expect(match!.livemode).toBe(false);
    expect(match!.account).toBe(merchant.merchantId);
    const data = match!.data as Record<string, unknown>;
    expect(data.object_type).toBe("payment");
    expect(data.object_id).toBe("pay_env");
    expect(data.object).toEqual({ reference: "pay_env" });
  });

  it("inbound gateway webhook: first flight emits a canonical event, replay is a 200 no-op", async () => {
    const headers = { authorization: `Bearer ${merchant.skTest}` };
    const body = { id: "gwexp_1", reference: "ref_in_1", type: "payment" };

    const first = await http(app, "POST", "/v1/gateway/webhooks/mock", { headers, body });
    expect(first.status).toBe(200);
    expect((first.json as { replayed: boolean }).replayed).toBe(false);
    expect((first.json as { event_id: string }).event_id).toBeTruthy();

    const second = await http(app, "POST", "/v1/gateway/webhooks/mock", { headers, body });
    expect(second.status).toBe(200);
    expect((second.json as { replayed: boolean }).replayed).toBe(true);

    const [events] = await db.db
      .query(
        `SELECT * FROM outbox_event
         WHERE merchant = $merchant AND environment = "test" AND object_id = "ref_in_1"`,
        { merchant: recordIdOf(merchant.merchantId) },
      )
      .collect<[Array<{ type: string; object_id: string }>]>();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("payment.succeeded");
  });

  it("redeliver re-sends the stored envelope through the endpoint", async () => {
    echo.count = 0;
    resetCooldowns();
    const ep = await createEndpoint(echo.url, ["payment.refunded"]);
    const eventId = await seedOutbox("payment.refunded", "pay_redeliver");

    await drain(db.db, merchant.merchantId, "test", { respectBackoff: false });
    expect(echo.count).toBe(1);

    const replay = await http(
      app,
      "POST",
      `/v1/webhook_endpoints/${ep.id}/events/${eventId}/redeliver`,
      { headers: { authorization: `Bearer ${merchant.skTest}` } },
    );
    expect(replay.status).toBe(200);
    expect(echo.count).toBe(2);
  });
});
