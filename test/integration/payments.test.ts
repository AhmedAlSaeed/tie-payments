import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createApp } from "../../src/app";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { provisionMerchant, type ProvisionedMerchant } from "../helpers/merchant";
import { http } from "../helpers/http";
import { generateKey } from "../../src/core/apikey";

const reachable = await isSurrealAvailable();

describe.skipIf(!reachable)("payments API (integration)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let merchant: ProvisionedMerchant;

  beforeAll(async () => {
    db = await createTestDb();
    app = createApp(db.db);
    merchant = await provisionMerchant(db.db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("rejects a payment without a key (401 problem)", async () => {
    const res = await http(app, "POST", "/v1/payments", {
      body: { amountMinor: 100, currency: "BHD" },
    });
    expect(res.status).toBe(401);
    expect((res.json as { code: string }).code).toBe("unauthenticated");
  });

  it("rejects an unknown key (401 invalid_api_key)", async () => {
    const res = await http(app, "POST", "/v1/payments", {
      headers: { authorization: `Bearer ${generateKey("sk", "test")}` },
      body: { amountMinor: 100, currency: "BHD" },
    });
    expect(res.status).toBe(401);
    expect((res.json as { code: string }).code).toBe("invalid_api_key");
  });

  it("creates a payment with a valid test secret key", async () => {
    const res = await http(app, "POST", "/v1/payments", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { amountMinor: 100, currency: "BHD" },
    });
    expect(res.status).toBe(201);
    const json = res.json as { object: string; environment: string; amountMinor: number };
    expect(json.object).toBe("payment");
    expect(json.environment).toBe("test");
    expect(json.amountMinor).toBe(100);
  });

  it("GET /v1/payments/:id returns the persisted payment", async () => {
    const created = await http(app, "POST", "/v1/payments", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { amountMinor: 250, currency: "BHD" },
    });
    expect(created.status).toBe(201);
    const { id } = created.json as { id: string };

    const got = await http(app, "GET", `/v1/payments/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(200);
    const json = got.json as {
      id: string;
      object: string;
      amountMinor: number;
      environment: string;
    };
    expect(json.id).toBe(id);
    expect(json.object).toBe("payment");
    expect(json.amountMinor).toBe(250);
    expect(json.environment).toBe("test");
  });

  it("returns 404 for an unknown payment id", async () => {
    const got = await http(app, "GET", "/v1/payments/pay_missing", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(404);
    expect((got.json as { code: string }).code).toBe("resource_not_found");
  });

  it("a test key cannot read a live payment (environment isolation)", async () => {
    const live = await http(app, "POST", "/v1/payments", {
      headers: { authorization: `Bearer ${merchant.skLive}` },
      body: { amountMinor: 700, currency: "USD" },
    });
    expect(live.status).toBe(201);
    expect((live.json as { environment: string }).environment).toBe("live");

    const got = await http(app, "GET", `/v1/payments/${(live.json as { id: string }).id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(404);
  });

  it("merchant B cannot read merchant A's payment (tenant isolation)", async () => {
    const created = await http(app, "POST", "/v1/payments", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { amountMinor: 50, currency: "SAR" },
    });
    const other = await provisionMerchant(db.db, "Other Merchant");

    const got = await http(app, "GET", `/v1/payments/${(created.json as { id: string }).id}`, {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(got.status).toBe(404);
  });

  it("replays the identical cached response for an Idempotency-Key", async () => {
    const headers = {
      authorization: `Bearer ${merchant.skTest}`,
      "idempotency-key": "req-payments-1",
    };
    const body = { amountMinor: 250, currency: "BHD" };

    const first = await http(app, "POST", "/v1/payments", { headers, body });
    const second = await http(app, "POST", "/v1/payments", { headers, body });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.json as { id: string }).id).toBe(
      (first.json as { id: string }).id,
    );
  });

  it("idempotency survives a process restart (fresh store, same DB)", async () => {
    const headers = {
      authorization: `Bearer ${merchant.skTest}`,
      "idempotency-key": "req-payments-restart-1",
    };
    const body = { amountMinor: 900, currency: "KWD" };

    const first = await http(app, "POST", "/v1/payments", { headers, body });
    expect(first.status).toBe(201);

    // A brand-new app instance over the same database — no shared in-memory state.
    const app2 = createApp(db.db);
    const replay = await http(app2, "POST", "/v1/payments", { headers, body });
    expect(replay.status).toBe(201);
    expect((replay.json as { id: string }).id).toBe((first.json as { id: string }).id);
  });
});
