/**
 * Subscriptions service — business logic for the subscriptions pillar (T3).
 *
 * Elysia-free: receives a plain MerchantContext + validated body, returns typed
 * results or throws ProblemError. Persistence flows through the injected store
 * (a `SubscriptionsRepository`); the invoicing service is injected for period-
 * close (creates + finalizes the cycle invoice) so this module stays DB- and
 * Elysia-free while co-operating in-process with T1.
 *
 * Pricing: per_unit/seat (+ quantity), metered (usage × unit_rate), tiered
 * (volume vs graduated bucket math in billing.ts). Money stays minor-units
 * `int`. The per-unit rate for metered lives in `price.unit_amount`.
 *
 * Period-close (D8): rolls `current_period_*` forward by each item's price
 * period, builds the cycle's line items (flat/seat / tiered / metered), creates
 * the draft invoice via the invoicing service, finalizes it (draft → open),
 * then records `subscription.period.closed` in the outbox. A TRIAL period
 * produces no invoice (D5 — the first charge defers to the first end-of-cycle
 * invoice); closing a trialing subscription flips it to `active` and starts the
 * first billed cycle instead (minimal edge handling per T3).
 */
import { problem } from "../../core/errors";
import type { MerchantContext } from "../../core/context";
import { addPeriod, computeMetered, computeTiered } from "./billing";
import type {
  CreatePrice,
  CreateSubscription,
  CreateUsageRecord,
  Currency,
  PriceResource,
  SubscriptionItemResource,
  SubscriptionResource,
  UpdatePrice,
  UpdateSubscription,
  UsageRecordResource,
} from "./model";
import type { PriceRow, SubscriptionItemRow, SubscriptionRow } from "./repository";

/** Persistence seam (implemented by SubscriptionsRepository). */
export interface SubscriptionsStore {
  createPrice(row: PriceRow): Promise<void>;
  updatePrice(row: PriceRow): Promise<void>;
  deletePrice(merchantId: string, environment: string, id: string): Promise<boolean>;
  findPrice(merchantId: string, environment: string, id: string): Promise<PriceRow | undefined>;
  listPrices(merchantId: string, environment: string): Promise<PriceRow[]>;
  createSubscription(
    sub: SubscriptionRow,
    items: SubscriptionItemRow[],
    itemRefs: string[],
    event: { type: string; snapshot: Record<string, unknown> },
  ): Promise<void>;
  findSubscription(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<{ sub: SubscriptionRow; items: SubscriptionItemRow[] } | undefined>;
  listSubscriptions(
    merchantId: string,
    environment: string,
  ): Promise<Array<{ sub: SubscriptionRow; items: SubscriptionItemRow[] }>>;
  updateSubscription(
    merchantId: string,
    environment: string,
    id: string,
    fields: { metadata?: Record<string, string>; cancelAtPeriodEnd?: boolean },
  ): Promise<void>;
  rollPeriod(
    merchantId: string,
    environment: string,
    sub: SubscriptionRow,
    items: SubscriptionItemRow[],
    event: { type: string; snapshot: Record<string, unknown> },
  ): Promise<void>;
  createUsageRecord(
    merchantId: string,
    environment: string,
    subscriptionItemId: string,
    quantity: number,
    recordedAt?: string,
  ): Promise<void>;
  findUsageItem(
    merchantId: string,
    environment: string,
    subscriptionItemId: string,
  ): Promise<{ priceId: string } | undefined>;
  sumUsage(
    merchantId: string,
    environment: string,
    subscriptionItemId: string,
    startMs: number,
    endMs: number,
  ): Promise<number>;
}

/** Invoicing seam (implemented by the T1 InvoiceService). */
export interface SubscriptionInvoicing {
  createInvoice(
    ctx: MerchantContext,
    body: {
      customer: string;
      currency: string;
      collection_method: string;
      line_items: Array<{ description: string; quantity: number; unit_price: number }>;
      due_date?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<{ id: string; status: string }>;
  finalize(ctx: MerchantContext, id: string): Promise<{ id: string; status: string }>;
}

export class SubscriptionService {
  constructor(
    private readonly store: SubscriptionsStore,
    private readonly invoicing: SubscriptionInvoicing,
  ) {}

  // ---- Price CRUD ------------------------------------------------------

  async createPrice(ctx: MerchantContext, body: CreatePrice): Promise<PriceResource> {
    this.assertPrice(body);
    const row: PriceRow = {
      id: `price_${crypto.randomUUID()}`,
      merchantId: ctx.merchantId,
      environment: ctx.environment,
      nickname: body.nickname,
      currency: body.currency,
      billing_scheme: body.billing_scheme,
      unitAmount: body.unit_amount,
      tiered: body.tiered,
      period: body.period,
      active: body.active ?? true,
      metadata: body.metadata,
      createdAt: new Date().toISOString(),
    };
    await this.store.createPrice(row);
    return this.toPriceResource(row, ctx.environment);
  }

  async getPrice(ctx: MerchantContext, id: string): Promise<PriceResource | undefined> {
    const row = await this.store.findPrice(ctx.merchantId, ctx.environment, id);
    return row ? this.toPriceResource(row, ctx.environment) : undefined;
  }

  async listPrices(ctx: MerchantContext): Promise<PriceResource[]> {
    const rows = await this.store.listPrices(ctx.merchantId, ctx.environment);
    return rows.map((r) => this.toPriceResource(r, ctx.environment));
  }

  async updatePrice(ctx: MerchantContext, id: string, body: UpdatePrice): Promise<PriceResource> {
    const existing = await this.store.findPrice(ctx.merchantId, ctx.environment, id);
    if (!existing) {
      throw problem("resource_not_found", "Price not found.");
    }
    const next: PriceRow = { ...existing };
    if (body.nickname !== undefined) next.nickname = body.nickname;
    if (body.unit_amount !== undefined) next.unitAmount = body.unit_amount;
    if (body.tiered !== undefined) next.tiered = body.tiered;
    if (body.period !== undefined) next.period = body.period;
    if (body.active !== undefined) next.active = body.active;
    if (body.metadata !== undefined) next.metadata = body.metadata;
    this.assertPrice(next);
    await this.store.updatePrice(next);
    return this.toPriceResource(next, ctx.environment);
  }

  async deletePrice(ctx: MerchantContext, id: string): Promise<{ id: string; deleted: true }> {
    const ok = await this.store.deletePrice(ctx.merchantId, ctx.environment, id);
    if (!ok) throw problem("resource_not_found", "Price not found.");
    return { id, deleted: true };
  }

  // ---- Subscriptions ---------------------------------------------------

  async createSubscription(
    ctx: MerchantContext,
    body: CreateSubscription,
  ): Promise<SubscriptionResource> {
    const nowMs = Date.now();
    const anchorMs = body.billing_cycle_anchor ? Date.parse(body.billing_cycle_anchor) : nowMs;
    if (!Number.isFinite(anchorMs)) {
      throw problem("validation_error", "billing_cycle_anchor must be a parseable datetime.");
    }
    const customerId = stripPrefix(body.customer, "customer");
    const collectionMethod = body.collection_method ?? "charge_automatically";
    const trialEnd =
      body.trial_period_days != null
        ? new Date(nowMs + body.trial_period_days * 86_400_000).toISOString()
        : undefined;
    const status: SubscriptionRow["status"] = body.trial_period_days ? "trialing" : "active";

    const id = `sub_${crypto.randomUUID()}`;
    const refs: string[] = [];
    const items: SubscriptionItemRow[] = [];

    const resolved = await Promise.all(
      body.items.map(async (raw) => {
        const priceId = stripPrefix(raw.price, "price");
        const price = await this.store.findPrice(ctx.merchantId, ctx.environment, priceId);
        if (!price) throw problem("resource_not_found", `Price ${priceId} not found.`);
        return { raw, priceId, price };
      }),
    );

    for (const { raw, priceId, price } of resolved) {
      const quantity = raw.quantity ?? 1;
      const itemId = `si_${crypto.randomUUID()}`;
      refs.push(`subscription_item:${itemId}`);
      items.push({
        id: itemId,
        merchantId: ctx.merchantId,
        environment: ctx.environment,
        subscriptionId: id,
        priceId,
        quantity,
        periodStart: toIso(new Date(anchorMs)),
        periodEnd: toIso(new Date(addPeriod(anchorMs, price.period))),
      });
    }

    const sub: SubscriptionRow = {
      id,
      merchantId: ctx.merchantId,
      environment: ctx.environment,
      customerId,
      status,
      collectionMethod,
      billingCycleAnchor: toIso(new Date(anchorMs)),
      currentPeriodStart: toIso(new Date(anchorMs)),
      currentPeriodEnd: items[0]?.periodEnd ?? toIso(new Date(anchorMs)),
      trialEnd,
      cancelAtPeriodEnd: false,
      prorationBehavior: "create_prorations",
      metadata: body.metadata,
      createdAt: toIso(new Date(nowMs)),
    };

    const resource = this.toSubscriptionResource(sub, items);
    await this.store.createSubscription(sub, items, refs, {
      type: "subscription.created",
      snapshot: resource,
    });
    return resource;
  }

  async getSubscription(
    ctx: MerchantContext,
    id: string,
  ): Promise<SubscriptionResource | undefined> {
    const found = await this.store.findSubscription(ctx.merchantId, ctx.environment, id);
    return found ? this.toSubscriptionResource(found.sub, found.items) : undefined;
  }

  async listSubscriptions(ctx: MerchantContext): Promise<SubscriptionResource[]> {
    const rows = await this.store.listSubscriptions(ctx.merchantId, ctx.environment);
    return rows.map((r) => this.toSubscriptionResource(r.sub, r.items));
  }

  async updateSubscription(
    ctx: MerchantContext,
    id: string,
    body: UpdateSubscription,
  ): Promise<SubscriptionResource> {
    const found = await this.store.findSubscription(ctx.merchantId, ctx.environment, id);
    if (!found) throw problem("resource_not_found", "Subscription not found.");
    await this.store.updateSubscription(ctx.merchantId, ctx.environment, id, {
      metadata: body.metadata,
      cancelAtPeriodEnd: body.cancel_at_period_end,
    });
    const reloaded = await this.store.findSubscription(ctx.merchantId, ctx.environment, id);
    return this.toSubscriptionResource(reloaded!.sub, reloaded!.items);
  }

  /** Report usage for a metered item (409 when the price isn't metered). */
  async recordUsage(ctx: MerchantContext, body: CreateUsageRecord): Promise<UsageRecordResource> {
    const itemId = stripPrefix(body.subscription_item, "subscription_item");
    const item = await this.store.findUsageItem(ctx.merchantId, ctx.environment, itemId);
    if (!item) throw problem("resource_not_found", "Subscription item not found.");
    const price = await this.store.findPrice(ctx.merchantId, ctx.environment, item.priceId);
    if (!price || price.billing_scheme !== "metered") {
      throw problem("conflict", "Usage records are only accepted for metered prices.", [
        { field: "subscription_item", message: "item's price is not metered" },
      ]);
    }
    const recordedAt = body.recorded_at ?? new Date().toISOString();
    await this.store.createUsageRecord(
      ctx.merchantId,
      ctx.environment,
      itemId,
      body.quantity,
      recordedAt,
    );
    return {
      id: `usi_${crypto.randomUUID()}`,
      object: "usage_record",
      subscription_item: `subscription_item:${itemId}`,
      quantity: body.quantity,
      recorded_at: recordedAt,
    };
  }

  /**
   * Period-close (5): roll the cycle forward, build + finalize the cycle
   * invoice via the invoicing service, then emit `subscription.period.closed`.
   * Trials close without an invoice (D5 — first charge deferred).
   */
  async closePeriod(ctx: MerchantContext, id: string): Promise<SubscriptionResource> {
    const found = await this.store.findSubscription(ctx.merchantId, ctx.environment, id);
    if (!found) throw problem("resource_not_found", "Subscription not found.");
    const { sub, items } = found;
    if (sub.status === "canceled") {
      throw problem("conflict", "A canceled subscription cannot close a period.");
    }

    const wasTrialing = sub.status === "trialing";
    const next = { ...sub };
    const nextItems = items.map((it) => ({ ...it }));

    if (!wasTrialing && next.status === "active") {
      const lineItems = await this.buildLineItems(ctx, items);
      if (lineItems.length > 0) {
        const invoice = await this.invoicing.createInvoice(ctx, {
          customer: sub.customerId,
          currency: await this.currencyOf(ctx, items),
          collection_method: sub.collectionMethod,
          line_items: lineItems,
        });
        await this.invoicing.finalize(ctx, invoice.id);
      }
    } else if (wasTrialing) {
      next.status = "active"; // trial ends → first billed cycle begins
    }

    // Advance period on the subscription + each item.
    const startMs = Date.parse(sub.currentPeriodEnd);
    const periods = await Promise.all(
      nextItems.map(async (it) => {
        const period = await this.periodOf(ctx, it.priceId);
        return { it, period };
      }),
    );
    let maxEndMs = startMs;
    for (const { it, period } of periods) {
      it.periodStart = new Date(startMs).toISOString();
      const endMs = addPeriod(startMs, period);
      if (endMs > maxEndMs) maxEndMs = endMs;
      it.periodEnd = new Date(endMs).toISOString();
    }
    next.currentPeriodStart = sub.currentPeriodEnd;
    next.currentPeriodEnd = new Date(maxEndMs).toISOString();

    const resource = this.toSubscriptionResource(next, nextItems);
    await this.store.rollPeriod(ctx.merchantId, ctx.environment, next, nextItems, {
      type: "subscription.period.closed",
      snapshot: resource,
    });
    return resource;
  }

  // Private --------------------------------------------------------------

  private assertPrice(p: {
    billing_scheme: string;
    unit_amount?: number;
    unitAmount?: number;
    tiered?: { tiers: unknown[]; mode: string };
  }): void {
    // Accept both the snake_case request body (createPrice) and the camelCase
    // stored row (updatePrice).
    const unitAmount = p.unitAmount ?? p.unit_amount;
    if (p.billing_scheme === "per_unit" || p.billing_scheme === "metered") {
      if (unitAmount === undefined) {
        throw problem("validation_error", `${p.billing_scheme} prices require unit_amount.`, [
          { field: "unit_amount", message: "required for per_unit and metered prices" },
        ]);
      }
    }
    if (p.billing_scheme === "tiered") {
      if (!p.tiered || !Array.isArray(p.tiered.tiers) || p.tiered.tiers.length === 0) {
        throw problem("validation_error", "tiered prices require a non-empty tiered config.", [
          { field: "tiered", message: "required for tiered prices" },
        ]);
      }
    }
  }

  private async currencyOf(ctx: MerchantContext, items: SubscriptionItemRow[]): Promise<string> {
    const prices = await Promise.all(
      items.map((it) => this.store.findPrice(ctx.merchantId, ctx.environment, it.priceId)),
    );
    return prices.find((p) => p)?.currency ?? "BHD";
  }

  private async periodOf(ctx: MerchantContext, priceId: string) {
    const price = await this.store.findPrice(ctx.merchantId, ctx.environment, priceId);
    return price?.period ?? { interval: "month", interval_count: 1 };
  }

  /** Build the cycle's invoice line items from the closing items. */
  private async buildLineItems(
    ctx: MerchantContext,
    items: SubscriptionItemRow[],
  ): Promise<Array<{ description: string; quantity: number; unit_price: number }>> {
    const lines = await Promise.all(
      items.map(async (it) => {
        const price = await this.store.findPrice(ctx.merchantId, ctx.environment, it.priceId);
        if (!price) return undefined;
        const unitAmount = price.unitAmount ?? 0;
        switch (price.billing_scheme) {
          case "per_unit":
            return {
              description: price.nickname ?? `Seat ${price.currency}`,
              quantity: it.quantity,
              unit_price: unitAmount,
            };
          case "tiered":
            return {
              description: price.nickname ?? `Tiered ${price.currency}`,
              quantity: 1,
              unit_price: computeTiered(price.tiered!.mode, price.tiered!.tiers, it.quantity),
            };
          case "metered": {
            const usage = await this.store.sumUsage(
              ctx.merchantId,
              ctx.environment,
              it.id,
              Date.parse(it.periodStart),
              Date.parse(it.periodEnd),
            );
            return {
              description: price.nickname ?? `Usage ${price.currency}`,
              quantity: 1,
              unit_price: computeMetered(unitAmount, usage),
            };
          }
          default:
            return undefined;
        }
      }),
    );
    return lines.filter(
      (l): l is { description: string; quantity: number; unit_price: number } => l != null,
    );
  }

  private toPriceResource(row: PriceRow, environment: string): PriceResource {
    return {
      id: row.id,
      object: "price",
      nickname: row.nickname,
      currency: row.currency as Currency,
      billing_scheme: row.billing_scheme,
      unit_amount: row.unitAmount ?? 0,
      tiered: row.tiered,
      period: { interval: row.period.interval, interval_count: row.period.interval_count ?? 1 },
      active: row.active,
      metadata: row.metadata,
      created: row.createdAt,
      environment: environment as "test" | "live",
    };
  }

  private toSubscriptionResource(
    sub: SubscriptionRow,
    items: SubscriptionItemRow[],
  ): SubscriptionResource {
    const resItems: SubscriptionItemResource[] = items.map((it) => ({
      id: it.id,
      object: "subscription_item",
      price: `price:${it.priceId}`,
      quantity: it.quantity,
      period_start: it.periodStart,
      period_end: it.periodEnd,
    }));
    return {
      id: sub.id,
      object: "subscription",
      customer: sub.customerId,
      status: sub.status,
      collection_method: sub.collectionMethod,
      billing_cycle_anchor: sub.billingCycleAnchor,
      current_period_start: sub.currentPeriodStart,
      current_period_end: sub.currentPeriodEnd,
      trial_end: sub.trialEnd,
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      items: resItems,
      metadata: sub.metadata,
      created: sub.createdAt,
    };
  }
}

// Small helpers -----------------------------------------------------------

/** Strip `table:` prefix from an inbound ref, returning the bare id. */
function stripPrefix(ref: string, table: string): string {
  return ref.startsWith(`${table}:`) ? ref.slice(table.length + 1) : ref;
}

/** Normalize a Date → ISO string (deterministic storage/readback). */
function toIso(d: Date): string {
  return d.toISOString();
}
