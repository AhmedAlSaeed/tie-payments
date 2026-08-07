/**
 * Subscriptions repository — SurrealDB persistence for price, subscription,
 * subscription_item, usage_record and outbox events (T3).
 *
 * Tenancy (F0): every query scopes by `merchant` + `environment` derived from
 * the authenticated request context (DB write permissions aren't enforced on
 * this build).
 *
 * Mutations that create a subscription (or close a period) write the business
 * rows AND an `outbox_event` row in a single multi-statement `db.query` (atomic,
 * mirroring the invoicing repo). Datetimes are bound as JS `Date`; id values are
 * always explicit (`sub_<uuid>`, `si_<uuid>`, `usi_<uuid>`).
 */
import type { Surreal } from "surrealdb";
import { recordIdOf, recordIdToString } from "../../core/records";
import type { PricePeriod, TieredConfig, BillingScheme } from "./model";

/** A versioned outbox event payload (type + full resource snapshot). */
export interface OutboxEventData {
  type: string;
  snapshot: Record<string, unknown>;
}

/** DB-mapped price row (snake_case → camelCase). */
export interface PriceRow {
  id: string; // bare `price_<uuid>`
  merchantId: string;
  environment: string;
  nickname?: string;
  currency: string;
  billing_scheme: BillingScheme;
  unitAmount?: number;
  tiered?: TieredConfig;
  period: PricePeriod;
  active: boolean;
  metadata?: Record<string, string>;
  createdAt: string;
}

/** DB-mapped subscription_item row. */
export interface SubscriptionItemRow {
  id: string;
  merchantId: string;
  environment: string;
  subscriptionId: string;
  /** Bare price id (`price_<uuid>`). */
  priceId: string;
  quantity: number;
  periodStart: string;
  periodEnd: string;
}

/** DB-mapped subscription row. */
export interface SubscriptionRow {
  id: string;
  merchantId: string;
  environment: string;
  /** Bare customer id (`cus_<uuid>`). */
  customerId: string;
  status: "trialing" | "active" | "past_due" | "incomplete" | "canceled";
  collectionMethod: "send_invoice" | "charge_automatically";
  billingCycleAnchor: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  trialEnd?: string;
  cancelAtPeriodEnd: boolean;
  prorationBehavior: string;
  metadata?: Record<string, string>;
  createdAt: string;
}

export class SubscriptionsRepository {
  constructor(private readonly db: Surreal) {}

  /** INSERT a price. */
  async createPrice(p: PriceRow): Promise<void> {
    await this.db.query(
      `INSERT INTO price {
         id: $id, merchant: $merchant, environment: $environment,
         nickname: $nickname, currency: $currency, billing_scheme: $billingScheme,
         unit_amount: $unitAmount, tiered: $tiered, period: $period,
         active: $active, metadata: $metadata
       }`,
      this.priceParams(p),
    );
  }

  async updatePrice(p: PriceRow): Promise<void> {
    await this.db.query(
      `UPDATE price SET
         nickname = $nickname, unit_amount = $unitAmount, tiered = $tiered,
         period = $period, active = $active, metadata = $metadata
       WHERE id = type::record('price', $id) AND merchant = $merchant AND environment = $environment`,
      this.priceParams(p),
    );
  }

  async deletePrice(merchantId: string, environment: string, id: string): Promise<boolean> {
    const [rows] = await this.db
      .query(
        `DELETE price
         WHERE id = type::record('price', $id) AND merchant = $merchant AND environment = $environment
         RETURN BEFORE`,
        { id, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<PriceRowLike>]>();
    return Array.isArray(rows) && rows.length > 0;
  }

  async findPrice(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<PriceRow | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM price WHERE id = type::record('price', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapPrice(row) : undefined;
  }

  async listPrices(merchantId: string, environment: string): Promise<PriceRow[]> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM price WHERE merchant = $merchant AND environment = $environment ORDER BY created_at ASC",
        { merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map(mapPrice);
  }

  /**
   * Create a subscription + its items + outbox event atomically.
   * `itemRefs` are `subscription_item` record-id strings written to `subscription.items`.
   */
  async createSubscription(
    sub: SubscriptionRow,
    items: SubscriptionItemRow[],
    itemRefs: string[],
    event: OutboxEventData,
  ): Promise<void> {
    await this.db.query(
      `BEGIN TRANSACTION;
       INSERT INTO subscription {
         id: $subId, merchant: $merchant, environment: $environment,
         customer: $customer, status: $status,
         collection_method: $collectionMethod,
         billing_cycle_anchor: $anchor,
         current_period_start: $currentPeriodStart,
         current_period_end: $currentPeriodEnd,
         cancel_at_period_end: false,
         proration_behavior: $prorationBehavior,
         items: $itemRefs,
         status_transitions: { started_at: time::now() },
         trial_end: $trialEnd,
         metadata: $metadata
       };
       INSERT INTO subscription_item $items;
       INSERT INTO outbox_event {
         merchant: $merchant, environment: $environment,
         type: $eventType, object_type: "subscription",
         object_id: $subId, object: $eventObject, window: time::now()
       };
       COMMIT TRANSACTION;`,
      {
        subId: sub.id,
        merchant: recordIdOf(sub.merchantId),
        environment: sub.environment,
        customer: recordIdOf(`customer:${sub.customerId}`),
        status: sub.status,
        collectionMethod: sub.collectionMethod,
        anchor: new Date(sub.billingCycleAnchor),
        currentPeriodStart: new Date(sub.currentPeriodStart),
        currentPeriodEnd: new Date(sub.currentPeriodEnd),
        trialEnd: sub.trialEnd ? new Date(sub.trialEnd) : undefined,
        prorationBehavior: sub.prorationBehavior,
        metadata: sub.metadata ?? undefined,
        itemRefs: itemRefs.map((r) => recordIdOf(r)),
        items: items.map((it) => ({
          id: it.id,
          merchant: recordIdOf(it.merchantId),
          environment: it.environment,
          subscription: recordIdOf(`subscription:${it.subscriptionId}`),
          price: recordIdOf(`price:${it.priceId}`),
          quantity: it.quantity,
          period_start: new Date(it.periodStart),
          period_end: new Date(it.periodEnd),
        })),
        eventType: event.type,
        eventObject: event.snapshot,
      },
    );
  }

  /** Fetch a subscription scoped to merchant+env, including its items. */
  async findSubscription(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<{ sub: SubscriptionRow; items: SubscriptionItemRow[] } | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM subscription WHERE id = type::record('subscription', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    if (!row) return undefined;
    const sub = mapSubscription(row);
    const items = await this.findItemsBySubscription(merchantId, environment, id);
    return { sub, items };
  }

  /** Fetch all subscription_item rows belonging to a subscription. */
  async findItemsBySubscription(
    merchantId: string,
    environment: string,
    subscriptionId: string,
  ): Promise<SubscriptionItemRow[]> {
    const [rows] = await this.db
      .query(
        `SELECT * FROM subscription_item
         WHERE subscription = type::record('subscription', $sub)
           AND merchant = $merchant AND environment = $environment`,
        { sub: subscriptionId, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map(mapItem);
  }

  async listSubscriptions(
    merchantId: string,
    environment: string,
  ): Promise<Array<{ sub: SubscriptionRow; items: SubscriptionItemRow[] }>> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM subscription WHERE merchant = $merchant AND environment = $environment ORDER BY created_at ASC",
        { merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const subs = (rows ?? []).map(mapSubscription);
    const nested = await Promise.all(
      subs.map(async (sub) => ({
        sub,
        items: await this.findItemsBySubscription(merchantId, environment, sub.id),
      })),
    );
    return nested;
  }

  /** Minimal subscription metadata / cancel_at_period_end update. */
  async updateSubscription(
    merchantId: string,
    environment: string,
    id: string,
    fields: { metadata?: Record<string, string>; cancelAtPeriodEnd?: boolean },
  ): Promise<void> {
    await this.db.query(
      `UPDATE subscription SET
         metadata = $metadata,
         cancel_at_period_end = $cancelAtPeriodEnd
       WHERE id = type::record('subscription', $id) AND merchant = $merchant AND environment = $environment`,
      {
        id,
        merchant: recordIdOf(merchantId),
        environment,
        metadata: fields.metadata ?? undefined,
        cancelAtPeriodEnd: fields.cancelAtPeriodEnd ?? false,
      },
    );
  }

  /**
   * Roll a closed period forward: update the subscription's period/status + each
   * item's period, and emit `subscription.period.closed`, atomically.
   */
  async rollPeriod(
    merchantId: string,
    environment: string,
    sub: SubscriptionRow,
    items: SubscriptionItemRow[],
    event: OutboxEventData,
  ): Promise<void> {
    // Index-based params (s0/e0/id0, s1/e1/id1, …) — item id params would embed
    // the uuid's hyphens, which SurrealQL treats as a subtraction and fails to
    // parse (records ids wrap hyphens in ⟨⟩ for the same reason).
    const itemUpdates = items
      .map(
        (_, i) =>
          `UPDATE subscription_item SET period_start = $s${i}, period_end = $e${i} WHERE id = type::record('subscription_item', $id${i}) AND merchant = $merchant AND environment = $environment;`,
      )
      .join("\n");

    const itemParams: Record<string, unknown> = {};
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      itemParams[`s${i}`] = new Date(it.periodStart);
      itemParams[`e${i}`] = new Date(it.periodEnd);
      itemParams[`id${i}`] = it.id;
    }

    await this.db.query(
      `BEGIN TRANSACTION;
       UPDATE subscription SET
         status = $status,
         current_period_start = $currentPeriodStart,
         current_period_end = $currentPeriodEnd,
         status_transitions = $statusTransitions
       WHERE id = type::record('subscription', $id)
         AND merchant = $merchant AND environment = $environment;
       ${itemUpdates}
       INSERT INTO outbox_event {
         merchant: $merchant, environment: $environment,
         type: $eventType, object_type: "subscription",
         object_id: $subId, object: $eventObject, window: time::now()
       };
       COMMIT TRANSACTION;`,
      {
        id: sub.id,
        merchant: recordIdOf(merchantId),
        environment,
        status: sub.status,
        currentPeriodStart: new Date(sub.currentPeriodStart),
        currentPeriodEnd: new Date(sub.currentPeriodEnd),
        statusTransitions: sub.status === "active" ? { trial_ended_at: undefined } : undefined,
        subId: sub.id,
        eventType: event.type,
        eventObject: event.snapshot,
        ...itemParams,
      },
    );
  }

  /** INSERT a usage_record row. */
  async createUsageRecord(
    merchantId: string,
    environment: string,
    subscriptionItemId: string,
    quantity: number,
    recordedAt?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO usage_record {
         merchant: $merchant, environment: $environment,
         subscription_item: $item,
         quantity: $quantity,
         recorded_at: $recordedAt
       }`,
      {
        merchant: recordIdOf(merchantId),
        environment,
        item: recordIdOf(`subscription_item:${subscriptionItemId}`),
        quantity,
        recordedAt: recordedAt ? new Date(recordedAt) : undefined,
      },
    );
  }

  /** Verify a subscription_item exists for the tenant and return its bare price id. */
  async findUsageItem(
    merchantId: string,
    environment: string,
    subscriptionItemId: string,
  ): Promise<{ priceId: string } | undefined> {
    const [rows] = await this.db
      .query(
        `SELECT price FROM subscription_item
         WHERE id = type::record('subscription_item', $id)
           AND merchant = $merchant AND environment = $environment LIMIT 1`,
        { id: subscriptionItemId, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    if (!row) return undefined;
    return { priceId: bareId(row.price) };
  }

  /** Sum `usage_record.quantity` for an item between [startMs, endMs). */
  async sumUsage(
    merchantId: string,
    environment: string,
    subscriptionItemId: string,
    startMs: number,
    endMs: number,
  ): Promise<number> {
    const [rows] = await this.db
      .query(
        `SELECT VALUE math::sum(quantity) FROM usage_record
         WHERE subscription_item = type::record('subscription_item', $item)
           AND merchant = $merchant AND environment = $environment
           AND recorded_at >= $start AND recorded_at < $end
         GROUP ALL`,
        {
          item: subscriptionItemId,
          merchant: recordIdOf(merchantId),
          environment,
          start: new Date(startMs),
          end: new Date(endMs),
        },
      )
      .collect<[Array<number | null>]>();

    // `GROUP ALL` forces the aggregate to run over the (possibly single-row) set
    // as an array; without it math::sum receives a scalar and errors on the
    // "one row" path. Zero rows → a single null/empty row, coerced to 0.
    return Number(rows?.[0] ?? 0);
  }

  // Private -------------------------------------------------------------

  private priceParams(p: PriceRow) {
    return {
      id: p.id,
      merchant: recordIdOf(p.merchantId),
      environment: p.environment,
      nickname: p.nickname ?? undefined,
      currency: p.currency,
      billingScheme: p.billing_scheme,
      unitAmount: p.unitAmount ?? undefined,
      tiered: p.tiered ?? undefined,
      period: { interval: p.period.interval, interval_count: p.period.interval_count ?? 1 },
      active: p.active,
      metadata: p.metadata ?? undefined,
    };
  }
}

// Row mappers ------------------------------------------------------------

type PriceRowLike = Record<string, unknown>;

/**
 * Canonical bare record id (<table>:<⟨key⟩> → <key>). SurrealDB wraps record-id
 * keys containing hyphens in angle brackets (`merchant:⟨uuid⟩`), which the SDK
 * surfaces as `RecordId`/string; canonicalize to the bracket-free bare key.
 */
function bareId(v: unknown): string {
  const s = recordIdToString(v as never);
  const idx = s.indexOf(":");
  return idx === -1 ? s : s.slice(idx + 1);
}

/** Map a price row (snake_case → camelCase). */
function mapPrice(row: PriceRowLike): PriceRow {
  const period = (row.period ?? {}) as Record<string, unknown>;
  return {
    id: bareId(row.id),
    merchantId: bareId(row.merchant),
    environment: String(row.environment),
    nickname: (row.nickname as string) ?? undefined,
    currency: String(row.currency),
    billing_scheme: row.billing_scheme as PriceRow["billing_scheme"],
    unitAmount:
      row.unit_amount === undefined || row.unit_amount === null
        ? undefined
        : Number(row.unit_amount),
    tiered: (row.tiered as PriceRow["tiered"]) ?? undefined,
    period: {
      interval: String(period.interval ?? "month") as PricePeriod["interval"],
      interval_count: period.interval_count === undefined ? 1 : Number(period.interval_count),
    },
    active: row.active === undefined || row.active === null ? true : Boolean(row.active),
    metadata: (row.metadata as Record<string, string>) ?? undefined,
    createdAt: String(row.created_at),
  };
}

/** Map a subscription_item row. */
function mapItem(row: Record<string, unknown>): SubscriptionItemRow {
  return {
    id: bareId(row.id),
    merchantId: bareId(row.merchant),
    environment: String(row.environment),
    subscriptionId: bareId(row.subscription),
    priceId: bareId(row.price),
    quantity: Number(row.quantity),
    periodStart: isoDate(row.period_start),
    periodEnd: isoDate(row.period_end),
  };
}

/** Map a subscription row. */
function mapSubscription(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: bareId(row.id),
    merchantId: bareId(row.merchant),
    environment: String(row.environment),
    customerId: bareId(row.customer),
    status: row.status as SubscriptionRow["status"],
    collectionMethod: row.collection_method as SubscriptionRow["collectionMethod"],
    billingCycleAnchor: isoDate(row.billing_cycle_anchor),
    currentPeriodStart: isoDate(row.current_period_start),
    currentPeriodEnd: isoDate(row.current_period_end),
    trialEnd: row.trial_end ? isoDate(row.trial_end) : undefined,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    prorationBehavior: String(row.proration_behavior ?? "create_prorations"),
    metadata: (row.metadata as Record<string, string>) ?? undefined,
    createdAt: isoDate(row.created_at),
  };
}

/** Normalize a SurrealDB datetime readback (native Date or string) → ISO. */
function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
