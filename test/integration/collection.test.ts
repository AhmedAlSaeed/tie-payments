/**
 * T2 — Invoice collection & payment outcome (charge / void / mark_uncollectible).
 *
 * Exercises the collection endpoints on an OPEN invoice against the routed mock
 * gateway matrix (T03): 4242 succeeds, 0002 declines (throws GatewayError
 * card_declined, retryable=false), 3D01 requires_action (3DS redirect). Also
 * covers the T05 credit-balance mechanics (overpay → customer credit → applied
 * to the next invoice) and the state-transition routes.
 *
 * Uses a TEST-LOCAL app (the invoicing module + shared auth/error plugins over
 * an isolated SurrealDB database) — NOT src/app.ts. Run only this file with the
 * invoicing suite per the parallel-agent gate:
 *   bun test test/integration/collection.test.ts test/integration/invoicing.test.ts
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { Surreal } from "surrealdb";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { provisionMerchant, type ProvisionedMerchant } from "../helpers/merchant";
import { http } from "../helpers/http";
import { errorHandling } from "../../src/core/errors-plugin";
import { createContextAuth } from "../../src/core/context";
import { createInvoicingModule } from "../../src/modules/invoicing";
import { recordIdOf } from "../../src/core/records";

process.env.SURREAL_TEST_DATABASE = "payments_test_t2";

const reachable = await isSurrealAvailable();

describe.skipIf(!reachable)("invoicing API — collection & payment outcome (integration)", () => {
  let app: Elysia;
  let db: { db: Surreal; database: string; close: () => Promise<void | boolean> };
  let merchant: ProvisionedMerchant;
  /** Seed a customer row so credit-balance assertions have a target. */
  let customerKey: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = new Elysia({ prefix: "/v1" })
      .use(errorHandling)
      .use(createContextAuth(db.db))
      .use(createInvoicingModule(db.db));
    merchant = await provisionMerchant(db.db);

    customerKey = crypto.randomUUID();
    await db.db.query(
      "INSERT INTO customer { id: $id, merchant: $m, environment: $env, credit_balance: $cb }",
      { id: customerKey, m: recordIdOf(merchant.merchantId), env: "test", cb: 0 },
    );
  });

  afterAll(async () => {
    await db.close();
  });

  const auth = () => ({ authorization: `Bearer ${merchant.skTest}` });

  const create = (overrides: Record<string, unknown> = {}) =>
    http(app, "POST", "/v1/invoices", {
      headers: auth(),
      body: {
        customer: customerKey,
        currency: "BHD",
        collection_method: "charge_automatically",
        line_items: [{ description: "Consulting", quantity: 1, unit_price: 105000 }],
        ...overrides,
      },
    });

  const finalize = (id: string) =>
    http(app, "POST", `/v1/invoices/${id}/finalize`, { headers: auth() });

  const charge = (id: string, method: string, body: Record<string, unknown> = {}) =>
    http(app, "POST", `/v1/invoices/${id}/charge`, {
      headers: auth(),
      body: { method, ...body },
    });

  const outbox = async (type: string, objectId: string) => {
    const [rows] = await db.db
      .query(
        "SELECT type, object_id, object FROM outbox_event WHERE merchant = $m AND environment = $env AND type = $type AND object_id = $id LIMIT 1",
        { m: recordIdOf(merchant.merchantId), env: "test", type, id: objectId },
      )
      .collect<[Array<{ type: string; object_id: string; object: Record<string, unknown> }>]>();
    if (!rows || !rows[0]) {
      throw new Error(`expected outbox_event ${type} for ${objectId}`);
    }
    return rows[0];
  };

  async function creditBalance(): Promise<number> {
    const [rows] = await db.db
      .query(
        "SELECT credit_balance FROM customer WHERE id = type::record('customer', $id) AND merchant = $m AND environment = $env",
        { id: customerKey, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ credit_balance: unknown }>]>();
    return Number(rows?.[0]?.credit_balance ?? 0);
  }

  it("charge 4242 on an OPEN invoice → paid, amount_paid == amount_due, invoice.paid outbox", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const charged = await charge(id, "tok_mock_4242");
    expect(charged.status).toBe(200);
    const inv = charged.json as Record<string, unknown>;
    expect(inv.status).toBe("paid");
    expect(inv.amount_due).toBe(105000);
    expect(inv.amount_paid).toBe(105000);
    expect(inv.amount_remaining).toBe(0);
    expect((inv.status_transitions as Record<string, unknown>).paid_at).toBeDefined();

    const ev = await outbox("invoice.paid", id);
    expect(ev.type).toBe("invoice.paid");
    expect((ev.object as Record<string, unknown>).status).toBe("paid");
  });

  it("overpay moves the excess to credit_balance, applied to the next invoice", async () => {
    // Invoice A: charge 205000 against a 105000 due → 100000 overpay → credit.
    const a = ((await create()).json as { id: string }).id;
    await finalize(a);
    const payA = await charge(a, "tok_mock_4242", { amount: 205000 });
    const invA = payA.json as Record<string, unknown>;
    expect(invA.status).toBe("paid");
    expect(invA.amount_paid).toBe(205000);
    expect(invA.amount_overpaid).toBe(100000);
    expect(await creditBalance()).toBe(100000);

    // Invoice B: the credit now covers part of its due; gateway charged the rest.
    const b = ((await create()).json as { id: string }).id;
    await finalize(b);
    const payB = await charge(b, "tok_mock_4242");
    const invB = payB.json as Record<string, unknown>;
    expect(invB.status).toBe("paid");
    expect(invB.amount_paid).toBe(5000); // 100000 credit + 5000 cash
    // Credit fully consumed this invoice.
    expect(await creditBalance()).toBe(0);
  });

  it("charge 0002 stays OPEN; outbox invoice.payment_failed with retryable=false", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const charged = await charge(id, "tok_mock_0002");
    expect(charged.status).toBe(200);
    const inv = charged.json as Record<string, unknown>;
    expect(inv.status).toBe("open");
    expect(inv.amount_paid).toBe(0);

    const ev = await outbox("invoice.payment_failed", id);
    expect(ev.type).toBe("invoice.payment_failed");
    const failure = (ev.object as Record<string, unknown>).payment_failure as Record<
      string,
      unknown
    >;
    expect(failure?.retryable).toBe(false);
  });

  it("charge 3D01 → requires_action recorded (invoice.payment_action_required), stays OPEN", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const charged = await charge(id, "tok_mock_3d01");
    expect(charged.status).toBe(200);
    const inv = charged.json as Record<string, unknown>;
    expect(inv.status).toBe("open");
    expect(inv.amount_paid).toBe(0);

    const ev = await outbox("invoice.payment_action_required", id);
    const action = (ev.object as Record<string, unknown>).payment_action as { kind: string };
    expect(ev.type).toBe("invoice.payment_action_required");
    expect(action?.kind).toBe("redirect");
  });

  it("void → voided with timestamp + invoice.voided outbox", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const res = await http(app, "POST", `/v1/invoices/${id}/void`, { headers: auth() });
    expect(res.status).toBe(200);
    const inv = res.json as Record<string, unknown>;
    expect(inv.status).toBe("voided");
    expect((inv.status_transitions as Record<string, string>).voided_at).toBeDefined();
    expect((await outbox("invoice.voided", id))?.type).toBe("invoice.voided");
  });

  it("void on a DRAFT → 409 conflict", async () => {
    const id = ((await create()).json as { id: string }).id;
    const res = await http(app, "POST", `/v1/invoices/${id}/void`, { headers: auth() });
    expect(res.status).toBe(409);
    expect((res.json as { code: string }).code).toBe("conflict");
  });

  it("mark_uncollectible → uncollectible with timestamp + invoice.marked_uncollectible", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const res = await http(app, "POST", `/v1/invoices/${id}/mark_uncollectible`, {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const inv = res.json as Record<string, unknown>;
    expect(inv.status).toBe("uncollectible");
    expect(
      (inv.status_transitions as Record<string, string>).marked_uncollectible_at,
    ).toBeDefined();
    expect((await outbox("invoice.marked_uncollectible", id))?.type).toBe(
      "invoice.marked_uncollectible",
    );
  });

  it("charge on a DRAFT → 409 conflict", async () => {
    const id = ((await create()).json as { id: string }).id;
    const res = await charge(id, "tok_mock_4242");
    expect(res.status).toBe(409);
    expect((res.json as { code: string }).code).toBe("conflict");
  });

  it("charge after paid → 409 conflict (no remaining balance)", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);
    await charge(id, "tok_mock_4242");
    const again = await charge(id, "tok_mock_4242");
    expect(again.status).toBe(409);
  });

  it("send_invoice invoices cannot be charged directly → 409", async () => {
    const id = ((await create({ collection_method: "send_invoice" })).json as { id: string }).id;
    await finalize(id);
    const res = await charge(id, "tok_mock_4242");
    expect(res.status).toBe(409);
    expect((res.json as { code: string }).code).toBe("conflict");
  });

  it("cross-tenant access returns 404 on GET", async () => {
    const id = ((await create()).json as { id: string }).id;
    const other = await provisionMerchant(db.db, "Other Tenant");
    const got = await http(app, "GET", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(got.status).toBe(404);
  });
});
