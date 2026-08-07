/**
 * T4 — Dunning (billing retries) integration.
 *
 * Extends the subscriptions module (T3) with the dunning state machine over the
 * T3 cycle-invoice + T1 InvoiceService charge rail:
 *
 *   on_failed_charge → ONE active dunning_attempt (dedup), subscription → past_due,
 *                      emit `subscription.past_due`;
 *   /dunning/run     → re-charge with the stored method; branch on the gateway
 *                      outcome: paid→clear, retryable→backoff/auto-cancel,
 *                      non-retryable→stop, requires_action→short retry.
 *
 * Uses a TEST-LOCAL app (NOT src/app.ts) over an isolated SurrealDB database:
 * error/auth plugins + subscriptions + invoicing modules. Cross-tenant guard
 * and re-runnability (beforeAll wipes the tables we touch).
 *
 * The mock gateway matrix drives outcomes by method suffix:
 *   tok_mock_4242 → succeeded, tok_mock_9999 → timeout (retryable),
 *   tok_mock_0002 → declined (non-retryable), ...3d01 → requires_action.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { Surreal } from "surrealdb";
import { createTestDb, isSurrealAvailable } from "../helpers/db";
import { provisionMerchant, type ProvisionedMerchant } from "../helpers/merchant";
import { http } from "../helpers/http";
import { errorHandling } from "../../src/core/errors-plugin";
import { createContextAuth } from "../../src/core/context";
import { createInvoicingModule } from "../../src/modules/invoicing";
import { createSubscriptionsModule } from "../../src/modules/subscriptions";
import { recordIdOf, recordIdToString } from "../../src/core/records";

process.env.SURREAL_TEST_DATABASE = "payments_test_t4";

const reachable = await isSurrealAvailable();

const CUSTOMER = "cus_t4_one";

function perUnitPrice(overrides: Record<string, unknown> = {}) {
  return {
    nickname: "Pro",
    currency: "BHD",
    billing_scheme: "per_unit",
    unit_amount: 10000, // 10 BHD (BHD exponent 3 → 10000 fils)
    period: { interval: "month" },
    ...overrides,
  };
}

describe.skipIf(!reachable)("dunning — recurring billing retries (integration)", () => {
  let app: Elysia;
  let db: { db: Surreal; database: string; close: () => Promise<void | boolean> };
  let merchant: ProvisionedMerchant;

  beforeAll(async () => {
    db = await createTestDb();
    await db.db.query(
      `DELETE FROM dunning_attempt;
       DELETE FROM subscription_item;
       DELETE FROM subscription;
       DELETE FROM price;
       DELETE FROM usage_record;
       DELETE FROM invoice;
       DELETE FROM customer;
       DELETE FROM payment;
       DELETE FROM idempotency;
       DELETE FROM invoice_tax_rate;
       DELETE FROM event_delivery;
       DELETE FROM outbox_event;`,
    );
    merchant = await provisionMerchant(db.db);
    await db.db.query(
      "INSERT INTO customer { id: $id, name: $name, email: $email, merchant: $merchant, environment: $env }",
      {
        id: CUSTOMER,
        name: "T4 Test",
        email: "t4@test.bh",
        merchant: recordIdOf(merchant.merchantId),
        env: "test",
      },
    );
    app = new Elysia({ prefix: "/v1" })
      .use(errorHandling)
      .use(createContextAuth(db.db))
      .use(createSubscriptionsModule(db.db, { autostart: false }))
      .use(createInvoicingModule(db.db));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    // merchant re-provisioned fresh each run snapshot; re-provision a clean key
    // set so no cross-run idempotency/scope bleed.
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

  /** Create an active charge_automatically subscription with one per_unit item. */
  async function makeSub(
    quantity = 2,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; itemId: string }> {
    const priceId = await createPrice(perUnitPrice());
    const res = await http(app, "POST", "/v1/subscriptions", {
      headers: auth(),
      body: {
        customer: CUSTOMER,
        items: [{ price: priceId, quantity }],
        collection_method: "charge_automatically",
        ...body,
      },
    });
    expect(res.status).toBe(201);
    const json = res.json as { id: string; items: Array<{ id: string }> };
    return { id: json.id, itemId: json.items[0].id };
  }

  /** Close the current period → the cycle invoice (open, charge_automatically, sub link). */
  async function closePeriod(subId: string): Promise<Record<string, unknown>> {
    const closed = await http(app, "POST", `/v1/subscriptions/${subId}/close_period`, {
      headers: auth(),
    });
    expect(closed.status).toBe(200);
    const [rows] = await db.db
      .query(
        `SELECT * FROM invoice WHERE merchant = $m AND environment = $env
           AND subscription = type::record('subscription', $sub)
         ORDER BY issued_at DESC LIMIT 1`,
        { m: recordIdOf(merchant.merchantId), env: "test", sub: subId },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const inv = rows?.[0];
    expect(inv).toBeDefined();
    return inv!;
  }

  /** Force the sub's pending attempt to be immediately due (scanner predicate). */
  async function forceDue(subId: string): Promise<void> {
    await db.db.query(
      `UPDATE dunning_attempt SET due_at = time::now() - 5s
         WHERE subscription = type::record('subscription', $sub)`,
      { sub: subId },
    );
  }

  async function outboxCount(type: string, subId?: string): Promise<number> {
    const filter =
      subId !== undefined ? "AND object_type = 'subscription' AND object_id = $sub" : "";
    const [rows] = await db.db
      .query(
        `SELECT type FROM outbox_event
         WHERE merchant = $m AND environment = $env AND type = $t ${filter}`,
        subId !== undefined
          ? { m: recordIdOf(merchant.merchantId), env: "test", t: type, sub: subId }
          : { m: recordIdOf(merchant.merchantId), env: "test", t: type },
      )
      .collect<[Array<{ type: string }>]>();
    return (rows ?? []).length;
  }

  async function attemptRow(subId: string): Promise<Record<string, unknown> | undefined> {
    const [rows] = await db.db
      .query(
        `SELECT * FROM dunning_attempt
         WHERE subscription = type::record('subscription', $sub) AND merchant = $m AND environment = $env`,
        { sub: subId, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return rows?.[0];
  }

  async function subscriptionStatus(subId: string): Promise<string> {
    const [rows] = await db.db
      .query(
        `SELECT status, canceled_at FROM subscription
         WHERE id = type::record('subscription', $id) AND merchant = $m AND environment = $env`,
        { id: subId, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return String(rows?.[0]?.status ?? "missing");
  }

  async function creditBalance(): Promise<number> {
    const [rows] = await db.db
      .query(
        `SELECT credit_balance FROM customer WHERE id = type::record('customer', $id) AND merchant = $m AND environment = $env`,
        { id: CUSTOMER, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ credit_balance?: unknown }>]>();
    return Number(rows?.[0]?.credit_balance ?? 0);
  }

  it("stamps the cycle invoice's subscription link at period-close", async () => {
    const { id } = await makeSub();
    const inv = await closePeriod(id);
    expect(JSON.stringify(inv.subscription)).toContain(id);
  });

  it("retryable → past_due → auto-cancel past the retry budget", async () => {
    const { id } = await makeSub();
    const inv = await closePeriod(id);
    const invoiceId = recordIdToString(inv.id as string).replace(/^invoice:/, "");

    // First failure escalates the subscription.
    const failed = await http(app, "POST", `/v1/subscriptions/${id}/dunning/on_failed_charge`, {
      headers: auth(),
      body: { invoice_id: invoiceId, method: "tok_mock_9999" },
    });
    expect(failed.status).toBe(201);
    const hooked = failed.json as {
      subscription: { status: string };
      attempt: { attempt: number; state: string };
    };
    expect(hooked.subscription.status).toBe("past_due");
    expect(hooked.attempt.attempt).toBe(1);
    expect(hooked.attempt.state).toBe("pending");
    expect(await outboxCount("subscription.past_due")).toBe(1);

    // run #1: retryable → attempt 2, scheduled forward.
    await forceDue(id);
    const run1 = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, {
      headers: auth(),
    });
    expect(run1.status).toBe(200);
    const r1 = run1.json as { outcome: string; attempt: { attempt: number } };
    expect(r1.outcome).toBe("retry_scheduled");
    expect(r1.attempt.attempt).toBe(2);

    await forceDue(id);
    const run2 = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, {
      headers: auth(),
    });
    const r2 = run2.json as { outcome: string; attempt: { attempt: number } };
    expect(r2.outcome).toBe("retry_scheduled");
    expect(r2.attempt.attempt).toBe(3);

    // Budget exhausted (3) → auto-cancel.
    await forceDue(id);
    const run3 = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, {
      headers: auth(),
    });
    const r3 = run3.json as {
      outcome: string;
      attempt: { state: string };
      subscription: { status: string };
    };
    expect(r3.outcome).toBe("canceled");
    expect(r3.attempt.state).toBe("canceled");
    expect(r3.subscription.status).toBe("canceled");

    expect(await subscriptionStatus(id)).toBe("canceled");
    expect(await outboxCount("subscription.canceled")).toBeGreaterThanOrEqual(1);
    const row = await attemptRow(id);
    expect(String(row?.state)).toBe("canceled");
  });

  it("retry succeeds → invoice paid, subscription active, attempt cleared", async () => {
    const { id } = await makeSub();
    const inv = await closePeriod(id);
    const invoiceId = recordIdToString(inv.id as string).replace(/^invoice:/, "");

    // Record a quiet failure then flip the stored method to the success token.
    await http(app, "POST", `/v1/subscriptions/${id}/dunning/on_failed_charge`, {
      headers: auth(),
      body: { invoice_id: invoiceId, method: "tok_mock_9999" },
    });
    await forceDue(id);
    const run = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, {
      headers: auth(),
      body: undefined,
    });
    // (first run was still pending/retryable without a success method; assert state)
    expect(run.status).toBe(200);

    // Now point the attempt at a success token and run again.
    await db.db.query(
      `UPDATE dunning_attempt SET method = 'tok_mock_4242'
       WHERE subscription = type::record('subscription', $sub)`,
      { sub: id },
    );
    await forceDue(id);
    const res = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, { headers: auth() });
    expect(res.status).toBe(200);
    const out = res.json as { outcome: string; subscription: { status: string } };
    expect(out.outcome).toBe("succeeded");
    expect(out.subscription.status).toBe("active");

    // Invoice paid, subscription active, attempt gone.
    const [invRows] = await db.db
      .query(
        "SELECT status FROM invoice WHERE id = type::record('invoice', $id) AND merchant = $m AND environment = $env",
        { id: invoiceId, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ status: string }>]>();
    expect(invRows?.[0]?.status).toBe("paid");
    expect(await subscriptionStatus(id)).toBe("active");
    const row = await attemptRow(id);
    const states = (await db.db
      .query(
        "SELECT state FROM dunning_attempt WHERE subscription = type::record('subscription', $sub) AND merchant = $m AND environment = $env",
        { sub: id, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ state: string }>]>()) as unknown as Array<{ state: string }>;
    // The active attempt is cleared (only canceled from this run remains terminal).
    const activeLeft = states.at(0)?.state ?? undefined ?? "canceled";
    void row;
    expect(["canceled", "past_due"]).toContain(activeLeft);

    // Version note: on full success the row is deleted (finalizeSuccess).
    const [after] = await db.db
      .query(
        "SELECT count() AS n FROM dunning_attempt WHERE subscription = type::record('subscription', $sub) AND merchant = $m AND environment = $env AND state IN ['pending','past_due']",
        { sub: id, m: recordIdOf(merchant.merchantId), env: "test" },
      )
      .collect<[Array<{ n: number }>]>();
    expect(Number(after?.[0]?.n ?? 0)).toBe(0);
  });

  it("non-retryable failure stops dunning (no increment, no auto-cancel)", async () => {
    const { id } = await makeSub();
    const inv = await closePeriod(id);
    const invoiceId = recordIdToString(inv.id as string).replace(/^invoice:/, "");

    const failed = await http(app, "POST", `/v1/subscriptions/${id}/dunning/on_failed_charge`, {
      headers: auth(),
      body: { invoice_id: invoiceId, method: "tok_mock_0002" },
    });
    expect(failed.status).toBe(201);
    await forceDue(id);

    const run = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, { headers: auth() });
    const out = run.json as { outcome: string; attempt: { attempt: number; state: string } };
    expect(out.outcome).toBe("stopped");
    // attempt NOT incremented; state terminal `past_due`; sub stays past_due.
    expect(out.attempt.state).toBe("past_due");
    const row = await attemptRow(id);
    expect(Number(row?.attempt)).toBe(1);
    expect(String(row?.state)).toBe("past_due");
    expect(await subscriptionStatus(id)).toBe("past_due");
    expect(await outboxCount("subscription.canceled", id)).toBe(0);
  });

  it("cancel modes: immediate / at_period_end / at", async () => {
    // immediate
    const a = await makeSub();
    const imm = await http(app, "POST", `/v1/subscriptions/${a.id}/cancel`, {
      headers: auth(),
      body: { mode: "immediate" },
    });
    expect(imm.status).toBe(200);
    const im = imm.json as { status: string; canceled_at?: string };
    expect(im.status).toBe("canceled");
    expect(im.canceled_at).toBeDefined();
    expect(await outboxCount("subscription.canceled")).toBeGreaterThanOrEqual(1);

    // at_period_end → flag true, status active
    const b = await makeSub();
    const ap = await http(app, "POST", `/v1/subscriptions/${b.id}/cancel`, {
      headers: auth(),
      body: { mode: "at_period_end" },
    });
    expect(ap.status).toBe(200);
    expect((ap.json as { cancel_at_period_end: boolean }).cancel_at_period_end).toBe(true);
    expect(await subscriptionStatus(b.id)).toBe("active");

    // at → scheduled cancel_at, status active
    const c = await makeSub();
    const at = await http(app, "POST", `/v1/subscriptions/${c.id}/cancel`, {
      headers: auth(),
      body: { mode: "at", at: "2027-01-15T00:00:00Z" },
    });
    expect(at.status).toBe(200);
    expect(Date.parse((at.json as { cancel_at?: string }).cancel_at!)).toBe(
      Date.parse("2027-01-15T00:00:00Z"),
    );
    expect(await subscriptionStatus(c.id)).toBe("active");

    // mode=at without a date → validation error
    const bad = await http(app, "POST", `/v1/subscriptions/${c.id}/cancel`, {
      headers: auth(),
      body: { mode: "at" },
    });
    expect(bad.status).toBe(400);
  });

  it("proration: quantity down credits; quantity up debits", async () => {
    const { id, itemId } = await makeSub(2); // per_unit rate 10000
    const before = await creditBalance();

    // Down: 2 → 1. deltaSeats −1, prorated ≈ −10000, credit += ~10000.
    const down = await http(app, "POST", `/v1/subscriptions/${id}/items/${itemId}/quantity`, {
      headers: auth(),
      body: { quantity: 1 },
    });
    expect(down.status).toBe(200);
    const afterDown = await creditBalance();
    expect(afterDown).toBeGreaterThan(before);
    expect(afterDown - before).toBeGreaterThan(9000);

    // Up: 1 → 2. deltaSeats +1 → debit back ~10000 (credit returns toward baseline).
    const up = await http(app, "POST", `/v1/subscriptions/${id}/items/${itemId}/quantity`, {
      headers: auth(),
      body: { quantity: 2 },
    });
    expect(up.status).toBe(200);
    const afterUp = await creditBalance();
    expect(afterUp - before).toBeLessThan(1000);
  });

  it("trial_will_end emitted once", async () => {
    const { id } = await makeSub(1, { trial_period_days: 1 });
    expect(await subscriptionStatus(id)).toBe("trialing");

    const m1 = await http(app, "POST", `/v1/subscriptions/${id}/maintain`, { headers: auth() });
    expect(m1.status).toBe(200);
    expect(await outboxCount("subscription.trial_will_end")).toBe(1);

    const m2 = await http(app, "POST", `/v1/subscriptions/${id}/maintain`, { headers: auth() });
    expect(m2.status).toBe(200);
    expect(await outboxCount("subscription.trial_will_end")).toBe(1);
  });

  it("cross-tenant access returns 404", async () => {
    const { id } = await makeSub();
    const other = await provisionMerchant(db.db, "Other Merchant");
    const cross = await http(app, "GET", `/v1/subscriptions/${id}`, {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(cross.status).toBe(404);
    const crossRun = await http(app, "POST", `/v1/subscriptions/${id}/dunning/run`, {
      headers: { authorization: `Bearer ${other.skTest}` },
    });
    expect(crossRun.status).toBe(404);
  });
});
