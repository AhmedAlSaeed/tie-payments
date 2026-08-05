import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { createApp } from "../../src/app";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { http } from "../helpers/http";
import { generateKey } from "../../src/core/apikey";

const reachable = await isSurrealAvailable();

describe.skipIf(!reachable)("payments API (integration)", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const testDb = await createTestDb();
    app = createApp(testDb.db);
    close = testDb.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("rejects a payment without a key (401 problem)", async () => {
    const res = await http(app, "POST", "/v1/payments", {
      body: { amountMinor: 100, currency: "BHD" },
    });
    expect(res.status).toBe(401);
    expect((res.json as { code: string }).code).toBe("unauthenticated");
  });

  it("creates a payment with a valid test secret key", async () => {
    const res = await http(app, "POST", "/v1/payments", {
      headers: { authorization: `Bearer ${generateKey("sk", "test")}` },
      body: { amountMinor: 100, currency: "BHD" },
    });
    expect(res.status).toBe(201);
    const json = res.json as { object: string; environment: string; amountMinor: number };
    expect(json.object).toBe("payment");
    expect(json.environment).toBe("test");
    expect(json.amountMinor).toBe(100);
  });

  it("replays the identical cached response for an Idempotency-Key", async () => {
    const headers = {
      authorization: `Bearer ${generateKey("sk", "test")}`,
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
});