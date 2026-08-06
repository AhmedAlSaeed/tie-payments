/**
 * T1 — Invoice lifecycle (draft → finalize): integration tests.
 *
 * Uses a TEST-LOCAL app (this module + shared error/auth plugins over an
 * isolated SurrealDB database) — NOT src/app.ts, so upstream wiring is never
 * touched. Run with `SURREAL_TEST_DATABASE` set to a dedicated database so the
 * suite never collides with dev data (see helpers/db.ts).
 *
 * Tax arithmetic (inclusive BH VAT 5%): for a line the customer pays
 * `charged = unit_price * quantity`; VAT embedded = `charged * 5/105`; so
 * `amount_tax` = 5% of the NET taxable base while `amount_due` restores the
 * inclusive charged total. Example below uses unit_price 105000 × qty 1:
 *   charged 105000 → tax 5000, net 100000 → amount_subtotal 100000,
 *   amount_tax 5000, amount_due 105000.
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

process.env.SURREAL_TEST_DATABASE = "payments_test_t1";

const reachable = await isSurrealAvailable();

describe.skipIf(!reachable)("invoicing API — invoice lifecycle (integration)", () => {
  let app: Elysia;
  let db: { db: Surreal; database: string; close: () => Promise<void | boolean> };
  let merchant: ProvisionedMerchant;

  beforeAll(async () => {
    db = await createTestDb();
    app = new Elysia({ prefix: "/v1" }) // route `/invoices/*` behind the versioned prefix, as app.ts does.
      .use(errorHandling)
      .use(createContextAuth(db.db))
      .use(createInvoicingModule(db.db));
    merchant = await provisionMerchant(db.db);
  });

  afterAll(async () => {
    await db.close();
  });

  const create = (overrides: Record<string, unknown> = {}) =>
    http(app, "POST", "/v1/invoices", {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: {
        currency: "BHD",
        collection_method: "send_invoice",
        line_items: [{ description: "Consulting", quantity: 1, unit_price: 105000 }],
        ...overrides,
      },
    });

  it("creates a DRAFT invoice (status, totals, outbox invoice.created)", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    const inv = res.json as Record<string, unknown>;
    expect(inv.object).toBe("invoice");
    expect(inv.status).toBe("draft");
    expect(inv.environment).toBe("test");
    expect(inv.currency).toBe("BHD");
    // Inclusive tax math for unit_price 105000 × 1:
    expect(inv.amount_subtotal).toBe(100000);
    expect(inv.amount_tax).toBe(5000);
    expect(inv.amount_due).toBe(105000);
    expect(inv.amount_remaining).toBe(105000);
    expect(inv.number).toBeUndefined();

    // outbox got the created event (in-tx), scoped to this merchant/env.
    const [rows] = await db.db
      .query(
        "SELECT type FROM outbox_event WHERE merchant = $m AND environment = $env AND type = 'invoice.created' LIMIT 1",
        { m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ type: string }>]>();
    expect(rows?.[0]?.type).toBe("invoice.created");
  });

  it("GET returns the persisted draft", async () => {
    const created = await create();
    const id = (created.json as { id: string }).id;
    const got = await http(app, "GET", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(200);
    const inv = got.json as { id: string; status: string; line_items: unknown[] };
    expect(inv.id).toBe(id);
    expect(inv.status).toBe("draft");
    expect(inv.line_items.length).toBe(1);
  });

  it("PATCH edits line items (recompute totals) on a draft", async () => {
    const created = await create();
    const id = (created.json as { id: string }).id;

    const patched = await http(app, "PATCH", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: {
        line_items: [{ description: "Strategy", quantity: 2, unit_price: 105000 }],
      },
    });
    expect(patched.status).toBe(200);
    const inv = patched.json as Record<string, unknown>;
    expect(inv.line_items).toHaveLength(1);
    // charged 210000 → tax 10000, net 200000.
    expect(inv.amount_subtotal).toBe(200000);
    expect(inv.amount_tax).toBe(10000);
    expect(inv.amount_due).toBe(210000);

    // PATCH of a draft also leaves it editable (still draft).
    expect(inv.status).toBe("draft");
  });

  it("finalize flips draft → open and snaps number/issued_at/hosted_url + totals", async () => {
    const created = await create();
    const id = (created.json as { id: string }).id;

    const fin = await http(app, "POST", `/v1/invoices/${id}/finalize`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(fin.status).toBe(200);
    const inv = fin.json as Record<string, unknown>;
    expect(inv.status).toBe("open");
    expect(inv.number).toMatch(/^INV-/);
    expect(inv.issued_at).toBeDefined();
    expect(inv.hosted_invoice_url).toBe(`https://pay.tie.bh/i/${id}`);
    // Inclusive-tax recompute at finalize.
    expect(inv.amount_subtotal).toBe(100000);
    expect(inv.amount_tax).toBe(5000);
    expect(inv.amount_due).toBe(105000);
    expect(inv.amount_remaining).toBe(105000);
    expect((inv.status_transitions as { finalized_at?: string })?.finalized_at).toBeDefined();
  });

  it("finalize twice → 409 conflict", async () => {
    const created = await create();
    const id = (created.json as { id: string }).id;
    await http(app, "POST", `/v1/invoices/${id}/finalize`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    const again = await http(app, "POST", `/v1/invoices/${id}/finalize`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(again.status).toBe(409);
    expect((again.json as { code: string }).code).toBe("conflict");
  });

  it("PATCH/DELETE on a finalized invoice → 409", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const patch = await http(app, "PATCH", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
      body: { metadata: { a: "b" } },
    });
    expect(patch.status).toBe(409);

    const del = await http(app, "DELETE", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(del.status).toBe(409);
  });

  it("DELETE a draft removes it", async () => {
    const id = ((await create()).json as { id: string }).id;
    const del = await http(app, "DELETE", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(del.status).toBe(200);
    expect((del.json as { deleted: boolean }).deleted).toBe(true);

    const got = await http(app, "GET", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
    expect(got.status).toBe(404);
  });

  it("outbox_event records invoice.finalized scoped to merchant+env", async () => {
    const id = ((await create()).json as { id: string }).id;
    await finalize(id);

    const [rows] = await db.db
      .query(
        "SELECT type, object_type, object_id FROM outbox_event WHERE merchant = $m AND environment = $env AND type = 'invoice.finalized'",
        { m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ type: string; object_type: string; object_id: string }>]>();
    const hit = rows?.find((r) => r.object_id === id);
    expect(hit?.type).toBe("invoice.finalized");
    expect(hit?.object_type).toBe("invoice");
  });

  it("Idempotency-Key replay returns the same invoice id", async () => {
    const headers = {
      authorization: `Bearer ${merchant.skTest}`,
      "idempotency-key": "req-inv-1",
    };
    const body = {
      currency: "BHD",
      collection_method: "send_invoice",
      line_items: [{ description: "Retainer", quantity: 1, unit_price: 4200 }],
    };
    const first = await http(app, "POST", "/v1/invoices", { headers, body });
    const second = await http(app, "POST", "/v1/invoices", { headers, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
  });

  it("a second merchant cannot read another merchant's invoice (tenant isolation)", async () => {
    const id = (await create()).json as { id: string };
    const other = await provisionMerchant(db.db, "Other Merchant");
    const got = await http(app, "GET", `/v1/invoices/${id}`, {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(got.status).toBe(404);
  });

  // --- helpers (bound to `app`/`merchant`) --------------------------------

  async function finalize(id: string) {
    return http(app, "POST", `/v1/invoices/${id}/finalize`, {
      headers: { authorization: `Bearer ${merchant.skTest}` },
    });
  }
});
