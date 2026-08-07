/**
 * T3 — Price + Subscription creation (integration).
 *
 * Uses a TEST-LOCAL app (this module + shared error/auth plugins over an
 * isolated SurrealDB database) — NOT src/app.ts. Mounts both the subscriptions
 * and invoicing modules so `close_period` can build + finalize the cycle invoice
 * through the real T1 service in-process.
 *
 * Pricing under test:
 *   per_unit  → amount = unit_rate × quantity (rate from price.unit_amount)
 *   tiered    → computeTiered (volume = single bucket; graduated = increments)
 *   metered   → sum of usage_record.quantity × unit_rate over the period
 *
 * Invoicing applies inclusive Bahrain VAT 5%: for a line the customer pays
 * `unit_price × quantity`; `amount_due` restores that charged total (subtotal
 * = net base, amount_tax = extracted VAT).
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
import { createSubscriptionsModule } from "../../src/modules/subscriptions";
import { recordIdOf } from "../../src/core/records";

process.env.SURREAL_TEST_DATABASE = "payments_test_t3";

const reachable = await isSurrealAvailable();

function perUnitPrice(overrides: Record<string, unknown> = {}) {
  return {
    nickname: "Pro",
    currency: "BHD",
    billing_scheme: "per_unit",
    unit_amount: 10000, // 10 BHD (BHD minor units = 3 → 10000 fils)
    period: { interval: "month" },
    ...overrides,
  };
}

function tieredPrice(
  mode: "graduated" | "volume",
  tiers: Array<{ up_to?: number; flat_amount?: number; unit_amount?: number }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    nickname: "tiered",
    currency: "BHD",
    billing_scheme: "tiered",
    period: { interval: "month" },
    tiered: { mode, tiers },
    ...overrides,
  };
}

function meteredPrice(overrides: Record<string, unknown> = {}) {
  return {
    nickname: "usage",
    currency: "BHD",
    billing_scheme: "metered",
    unit_amount: 250,
    period: { interval: "month" },
    ...overrides,
  };
}

describe.skipIf(!reachable)(
  "subscriptions API — price + subscription creation (integration)",
  () => {
    let app: Elysia;
    let db: { db: Surreal; database: string; close: () => Promise<void | boolean> };
    let merchant: ProvisionedMerchant;
    const customer = "cus_t3_one";

    beforeAll(async () => {
      db = await createTestDb();
      // Re-runnability: the suite uses fixed ids (customer:cus_t3_one) and the
      // test database persists across runs, so wipe subscription/outbox/invoice
      // data we own before provisioning. Mirrors sandbox/webhooks cleanup.
      await db.db.query(
        `DELETE FROM usage_record;
       DELETE FROM subscription_item;
       DELETE FROM subscription;
       DELETE FROM price;
       DELETE FROM customer;
       DELETE FROM invoice_tax_rate;
       DELETE FROM event_delivery;
       DELETE FROM outbox_event;`,
      );
      merchant = await provisionMerchant(db.db);
      await db.db.query(
        "INSERT INTO customer { id: $id, name: $name, email: $email, merchant: $merchant, environment: $env }",
        {
          id: customer,
          name: "T3 Test",
          email: "t3@test.bh",
          merchant: recordIdOf(merchant.merchantId),
          env: "test",
        },
      );
      app = new Elysia({ prefix: "/v1" })
        .use(errorHandling)
        .use(createContextAuth(db.db))
        .use(createSubscriptionsModule(db.db))
        .use(createInvoicingModule(db.db));
      merchant = await provisionMerchant(db.db);
    });

    afterAll(async () => {
      await db.close();
    });

    const auth = (extra: Record<string, string> = {}) => ({
      authorization: `Bearer ${merchant.skTest}`,
      ...extra,
    });

    async function createPrice(body: Record<string, unknown>): Promise<string> {
      const res = await http(app, "POST", "/v1/prices", { headers: auth(), body });
      expect(res.status).toBe(201);
      return (res.json as { id: string }).id;
    }

    /** Latest finalized (open) invoice for the merchant, or undefined. */
    async function latestInvoice(): Promise<Record<string, unknown> | undefined> {
      // Invoices don't carry `created_at` on create (only `issued_at` is stamped
      // at finalize via time::now()), so order by issued_at to find the most
      // recently finalized cycle invoice.
      const [rows] = await db.db
        .query(
          `SELECT * FROM invoice WHERE merchant = $m AND environment = $env
         ORDER BY issued_at DESC LIMIT 1`,
          { m: recordIdOf(merchant.merchantId), env: "test" },
        )
        .collect<[Array<Record<string, unknown>>]>();
      return rows?.[0];
    }

    async function outboxTypes(): Promise<string[]> {
      const [rows] = await db.db
        .query("SELECT type FROM outbox_event WHERE merchant = $m AND environment = $env", {
          m: recordIdOf(merchant.merchantId),
          env: "test",
        })
        .collect<[Array<{ type: string }>]>();
      return (rows ?? []).map((r) => r.type);
    }

    // ---- Price CRUD ------------------------------------------------------

    it("creates a per_unit price", async () => {
      const id = await createPrice(perUnitPrice());
      const got = await http(app, "GET", `/v1/prices/${id}`, { headers: auth() });
      expect(got.status).toBe(200);
      const p = got.json as {
        object: string;
        billing_scheme: string;
        unit_amount: number;
        active: boolean;
        period: { interval: string; interval_count: number };
      };
      expect(p.object).toBe("price");
      expect(p.billing_scheme).toBe("per_unit");
      expect(p.unit_amount).toBe(10000);
      expect(p.active).toBe(true);
      expect(p.period.interval).toBe("month");
      expect(p.period.interval_count).toBe(1);
    });

    it("creates a tiered price (volume + graduated round-trip)", async () => {
      const vol = await createPrice(
        tieredPrice("volume", [{ up_to: 10, unit_amount: 1000 }, { unit_amount: 900 }]),
      );
      const grad = await createPrice(
        tieredPrice("graduated", [
          { up_to: 2, flat_amount: 500, unit_amount: 500 },
          { unit_amount: 750 },
        ]),
      );
      const got = await http(app, "GET", `/v1/prices/${grad}`, { headers: auth() });
      const p = got.json as { tiered: { mode: string; tiers: unknown[] } };
      expect(p.tiered.mode).toBe("graduated");
      expect(p.tiered.tiers).toHaveLength(2);
      expect(vol).toBeTruthy();
    });

    it("creates a metered price (unit_amount is the per-unit rate)", async () => {
      const id = await createPrice(meteredPrice());
      const got = await http(app, "GET", `/v1/prices/${id}`, { headers: auth() });
      const p = got.json as { billing_scheme: string; unit_amount: number };
      expect(p.billing_scheme).toBe("metered");
      expect(p.unit_amount).toBe(250);
    });

    it("rejects a per_unit price without unit_amount (400 validation)", async () => {
      const res = await http(app, "POST", "/v1/prices", {
        headers: auth(),
        body: perUnitPrice({ unit_amount: undefined }),
      });
      expect(res.status).toBe(400);
      expect((res.json as { code: string }).code).toBe("validation_error");
    });

    it("rejects a tiered price without tiers (400 validation)", async () => {
      const res = await http(app, "POST", "/v1/prices", {
        headers: auth(),
        body: {
          nickname: "bad",
          currency: "BHD",
          billing_scheme: "tiered",
          period: { interval: "month" },
        },
      });
      expect(res.status).toBe(400);
    });

    it("lists prices", async () => {
      const res = await http(app, "GET", "/v1/prices", { headers: auth() });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
    });

    it("PATCH deactivates a price", async () => {
      const id = await createPrice(perUnitPrice());
      const patched = await http(app, "PATCH", `/v1/prices/${id}`, {
        headers: auth(),
        body: { active: false },
      });
      expect(patched.status).toBe(200);
      expect((patched.json as { active: boolean }).active).toBe(false);
    });

    it("DELETE a price", async () => {
      const id = await createPrice(perUnitPrice());
      const del = await http(app, "DELETE", `/v1/prices/${id}`, { headers: auth() });
      expect(del.status).toBe(200);
      const got = await http(app, "GET", `/v1/prices/${id}`, { headers: auth() });
      expect(got.status).toBe(404);
    });

    // ---- Subscription creation -------------------------------------------

    it("creates an ACTIVE subscription with a linked per_unit item + outbox event", async () => {
      const priceId = await createPrice(perUnitPrice());
      const res = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId, quantity: 3 }] },
      });
      expect(res.status).toBe(201);
      const sub = res.json as {
        object: string;
        status: string;
        customer: string;
        items: Array<{ price: string; quantity: number; period_start: string; period_end: string }>;
        current_period_start: string;
        current_period_end: string;
      };
      expect(sub.object).toBe("subscription");
      expect(sub.status).toBe("active");
      expect(sub.customer).toBe(customer);
      expect(sub.items).toHaveLength(1);
      expect(sub.items[0].quantity).toBe(3);
      expect(sub.items[0].price).toContain(priceId);
      expect(sub.items[0].period_start).toBeDefined();
      expect(sub.items[0].period_end).toBeDefined();
      expect(sub.current_period_start).toBeDefined();
      expect(sub.current_period_end).toBeDefined();

      const [rows] = await db.db
        .query(
          "SELECT type, object_id FROM outbox_event WHERE merchant = $m AND environment = $env AND type = 'subscription.created' AND object_id = $id",
          { m: recordIdOf(merchant.merchantId), env: "test", id: sub.id },
        )
        .collect<[Array<{ type: string; object_id: string }>]>();
      expect(rows?.[0]?.type).toBe("subscription.created");
    });

    it("creates a trial subscription → status trialing, trial_end set", async () => {
      const priceId = await createPrice(perUnitPrice());
      const res = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId }], trial_period_days: 14 },
      });
      expect(res.status).toBe(201);
      const sub = res.json as { status: string; trial_end?: string };
      expect(sub.status).toBe("trialing");
      expect(sub.trial_end).toBeDefined();
    });

    it("GET a subscription; cross-tenant GET returns 404", async () => {
      const priceId = await createPrice(perUnitPrice());
      const created = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId }] },
      });
      const id = (created.json as { id: string }).id;

      const got = await http(app, "GET", `/v1/subscriptions/${id}`, { headers: auth() });
      expect(got.status).toBe(200);
      expect((got.json as { id: string }).id).toBe(id);

      const other = await provisionMerchant(db.db, "Other Merchant");
      const crossTenant = await http(app, "GET", `/v1/subscriptions/${id}`, {
        headers: { authorization: `Bearer ${other.skTest}` },
      });
      expect(crossTenant.status).toBe(404);
    });

    it("Idempotency-Key replay returns the same subscription", async () => {
      const priceId = await createPrice(perUnitPrice());
      const headers = auth({ "idempotency-key": "req-sub-1" });
      const body = { customer, items: [{ price: priceId }] };
      const first = await http(app, "POST", "/v1/subscriptions", { headers, body });
      const second = await http(app, "POST", "/v1/subscriptions", { headers, body });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
    });

    // ---- Period close ----------------------------------------------------

    it("close_period generates + finalizes an invoice for a per_unit item", async () => {
      const priceId = await createPrice(perUnitPrice()); // rate 10000 fils
      const subRes = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: {
          customer,
          items: [{ price: priceId, quantity: 2 }],
          collection_method: "send_invoice",
        },
      });
      const subId = (subRes.json as { id: string }).id;

      const closed = await http(app, "POST", `/v1/subscriptions/${subId}/close_period`, {
        headers: auth(),
      });
      expect(closed.status).toBe(200);
      const sub = closed.json as {
        status: string;
        items: Array<{ period_start: string; period_end: string }>;
      };
      expect(sub.status).toBe("active");
      expect(sub.items[0].period_start).toBeDefined();
      expect(sub.items[0].period_end).toBeDefined();

      // billed: qty 2 × 10000 = 20000 fils (incl VAT).
      const inv = await latestInvoice();
      expect(inv).toBeDefined();
      expect(inv.status).toBe("open");
      expect(inv.collection_method).toBe("send_invoice");
      expect(Number(inv.amount_due)).toBe(20000);
      expect(Number(inv.amount_subtotal)).toBe(19048); // 20000 - round(20000*5/105)=952
      expect(Number(inv.amount_tax)).toBe(952);

      const types = await outboxTypes();
      expect(types).toContain("invoice.finalized");
      expect(types).toContain("subscription.period.closed");
    });

    it("tiered volume: single bucket rate on total quantity", async () => {
      // volume: qty 5 covered by tier up_to 10 @1000 → 1000×5 = 5000.
      const priceId = await createPrice(
        tieredPrice("volume", [{ up_to: 10, unit_amount: 1000 }, { unit_amount: 900 }]),
      );
      const subRes = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId, quantity: 5 }] },
      });
      const subId = (subRes.json as { id: string }).id;
      await http(app, "POST", `/v1/subscriptions/${subId}/close_period`, { headers: auth() });
      const inv = await latestInvoice();
      expect(Number(inv.amount_due)).toBe(5000);
    });

    it("tiered graduated: per-bucket increments", async () => {
      // graduated at qty 5: bucket1 (up_to 2) = 500 flat + 2×500 = 1500;
      // bucket2 (3 units) = 3×750 = 2250 → total 3750.
      const priceId = await createPrice(
        tieredPrice("graduated", [
          { up_to: 2, flat_amount: 500, unit_amount: 500 },
          { unit_amount: 750 },
        ]),
      );
      const subRes = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId, quantity: 5 }] },
      });
      const subId = (subRes.json as { id: string }).id;
      await http(app, "POST", `/v1/subscriptions/${subId}/close_period`, { headers: auth() });
      const inv = await latestInvoice();
      expect(Number(inv.amount_due)).toBe(3750);
    });

    it("metered: report usage then close → billed from usage", async () => {
      const priceId = await createPrice(meteredPrice()); // rate 250
      const subRes = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId }] },
      });
      const subId = (subRes.json as { id: string }).id;
      const itemId = (subRes.json as { items: Array<{ id: string }> }).items[0].id;

      const used = await http(app, "POST", "/v1/usage_records", {
        headers: auth(),
        body: { subscription_item: itemId, quantity: 120 },
      });
      expect(used.status).toBe(201);

      await http(app, "POST", `/v1/subscriptions/${subId}/close_period`, { headers: auth() });
      const inv = await latestInvoice();
      expect(Number(inv.amount_due)).toBe(120 * 250); // 30000
    });

    it("usage_records on a non-metered item → 409 conflict", async () => {
      const priceId = await createPrice(perUnitPrice());
      const subRes = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId }] },
      });
      const itemId = (subRes.json as { items: Array<{ id: string }> }).items[0].id;
      const res = await http(app, "POST", "/v1/usage_records", {
        headers: auth(),
        body: { subscription_item: itemId, quantity: 10 },
      });
      expect(res.status).toBe(409);
      expect((res.json as { code: string }).code).toBe("conflict");
    });

    it("close_period on a trial subscription flips to active without an invoice (D5)", async () => {
      const priceId = await createPrice(perUnitPrice());
      const subRes = await http(app, "POST", "/v1/subscriptions", {
        headers: auth(),
        body: { customer, items: [{ price: priceId }], trial_period_days: 7 },
      });
      expect((subRes.json as { status: string }).status).toBe("trialing");
      const subId = (subRes.json as { id: string }).id;

      const closed = await http(app, "POST", `/v1/subscriptions/${subId}/close_period`, {
        headers: auth(),
      });
      expect(closed.status).toBe(200);
      expect((closed.json as { status: string }).status).toBe("active");
    });

    it("close_period on a missing subscription → 404", async () => {
      const res = await http(app, "POST", "/v1/subscriptions/sub_does_not_exist/close_period", {
        headers: auth(),
      });
      expect(res.status).toBe(404);
    });
  },
);
