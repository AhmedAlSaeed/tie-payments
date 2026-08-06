/**
 * Outbox drainer (T07 D3–D5) — moves canonical outbox events to subscribed
 * webhook endpoints, with HMAC signing, at-least-once dedup and exponential
 * backoff + dead-lettering.
 *
 * One drain pass:
 *   1. Load outbox events + endpoints for the scope.
 *   2. For every *enabled* endpoint whose `events` allow-list includes the
 *      event's type, ensure an `event_delivery` row exists (at-least-once,
 *      `attempt` starts at 1). Already-settled (delivered / dead-lettered) rows
 *      are skipped.
 *   3. Attempt each pending delivery: sign the raw envelope and POST it.
 *         - 2xx  → `delivered_at` + `response_status` set.
 *         - fail → `attempt` incremented; when `attempt >= max_attempts` the row
 *                   is dead-lettered (`deadlettered_at`), otherwise a retry is
 *                   scheduled with exponential backoff (10s × 2, cap ~1.8h).
 *
 * Retry scheduling: the `event_delivery` table carries a `next_attempt_at`
 * column (schema.surql) ready for a durable drainer, but this slice tracks the
 * backoff window in-process via a cooldown map keyed by delivery record id —
 * correct within the single-process monolith. The monolith tick calls
 * `drainAll` with `respectBackoff:true` so due retries fire on schedule; tests
 * call `drain(..., { respectBackoff:false })` to advance deterministically.
 */
import type { Surreal } from "surrealdb";
import type { Environment } from "../../shared/constants";
import { toStripeEvent, type OutboxEventRow } from "./model";
import { WebhooksRepository, type DeliveryRow, type EndpointRow, type Scope } from "./repository";
import { signPayload } from "./signer";

/** Base 10s, factor 2, capped at ~1.8h (6480s). attempt is 1-based. */
export function delayForAttempt(attempt: number): number {
  return Math.min(10 * Math.pow(2, attempt - 1), 6480);
}

/** One delivery attempt's outcome. */
export interface DeliveryResult {
  deliveryId: string;
  status: "delivered" | "failed" | "deadlettered";
  statusCode?: number;
  attempt: number;
}

export interface DrainOptions {
  /** Respect in-memory backoff cooldown (the production tick); default true. */
  respectBackoff?: boolean;
  /** Wall-clock `Date.now()` to compare cooldowns against. */
  now?: number;
}

/** In-memory retry cooldown: delivery-id → earliest epoch-ms it may be retried. */
const cooldownMs = new Map<string, number>();

/**
 * Deliver one (event, endpoint) pair's event_delivery: send the stored envelope
 * to `endpoint.url` (HMAC-signed) then reflect success / increment / dead-letter
 * on the row. Shared by the drainer and the replay endpoint.
 */
export async function attemptDelivery(
  db: Surreal,
  scope: Scope,
  delivery: DeliveryRow,
  eventRow: OutboxEventRow,
  endpoint: EndpointRow,
): Promise<DeliveryResult> {
  const repo = new WebhooksRepository(db);
  const payload = JSON.stringify(toStripeEvent(eventRow, scope.merchantId));
  const { headers } = signPayload(endpoint.secret ?? "", payload);
  const fullHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };

  let statusCode = 0;
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: fullHeaders,
      body: payload,
    });
    statusCode = response.status;
  } catch {
    statusCode = 0; // network / DNS failure
  }

  const is2xx = statusCode >= 200 && statusCode < 300;
  if (is2xx) {
    await repo.markDelivered(scope, delivery.id, statusCode, headers["tie-signature"]);
    cooldownMs.delete(delivery.id);
    return { deliveryId: delivery.id, status: "delivered", statusCode, attempt: delivery.attempt };
  }

  // Non-2xx / unreachable: retry or dead-letter once max_attempts is reached.
  if (delivery.attempt >= endpoint.max_attempts) {
    await repo.markDeadlettered(
      scope,
      delivery.id,
      statusCode,
      delivery.attempt,
      headers["tie-signature"],
    );
    cooldownMs.delete(delivery.id);
    return {
      deliveryId: delivery.id,
      status: "deadlettered",
      statusCode,
      attempt: delivery.attempt,
    };
  }

  const nextAttempt = delivery.attempt + 1;
  await repo.markFailed(scope, delivery.id, statusCode, nextAttempt, headers["tie-signature"]);
  cooldownMs.set(delivery.id, Date.now() + delayForAttempt(delivery.attempt) * 1000);
  return { deliveryId: delivery.id, status: "failed", statusCode, attempt: nextAttempt };
}

/**
 * Run one drain pass for a merchant+environment scope. Returns per-attempt
 * outcomes in the order the drainer processed them.
 */
export async function drain(
  db: Surreal,
  merchantId: string,
  environment: Environment,
  opts: DrainOptions = {},
): Promise<DeliveryResult[]> {
  const scope: Scope = { merchantId, environment };
  const { respectBackoff = true, now = Date.now() } = opts;
  const repo = new WebhooksRepository(db);

  const events = await repo.listEvents(scope);
  const endpoints = await repo.listEndpoints(scope);
  const deliveries = await repo.listDeliveries(scope);
  const pendingByPair = new Map<string, DeliveryRow>();
  for (const d of deliveries) pendingByPair.set(`${d.event}::${d.endpoint}`, d);

  // All (event, endpoint) pairs an enabled, subscribed endpoint must deliver.
  const pairs: Array<{ event: OutboxEventRow; endpoint: EndpointRow }> = [];
  for (const event of events) {
    const subscribed = endpoints.filter((ep) => ep.enabled && ep.events.includes(event.type));
    for (const endpoint of subscribed) pairs.push({ event, endpoint });
  }

  // Create any missing at-least-once delivery rows (attempt starts at 1).
  const missing = pairs.filter((p) => !pendingByPair.has(`${p.event.id}::${p.endpoint.id}`));
  await Promise.all(missing.map((p) => repo.createDelivery(scope, p.event.id, p.endpoint.id)));

  // Re-read so every pair now (likely) has a delivery row, then pick due work.
  const settled = await repo.listDeliveries(scope);
  const deliveryByPair = new Map<string, DeliveryRow>();
  for (const d of settled) deliveryByPair.set(`${d.event}::${d.endpoint}`, d);

  const work: Array<{ event: OutboxEventRow; endpoint: EndpointRow; delivery: DeliveryRow }> = [];
  for (const { event, endpoint } of pairs) {
    const delivery = deliveryByPair.get(`${event.id}::${endpoint.id}`);
    if (!delivery || delivery.delivered_at || delivery.deadlettered_at) continue;
    const due = respectBackoff ? (cooldownMs.get(delivery.id) ?? 0) <= now : true;
    if (!due) continue;
    work.push({ event, endpoint, delivery });
  }

  return Promise.all(
    work.map((item) => attemptDelivery(db, scope, item.delivery, item.event, item.endpoint)),
  );
}

/** Drain every scope that has outbox events; returns the number of attempts. */
export async function drainAll(db: Surreal, opts: DrainOptions = {}): Promise<number> {
  const repo = new WebhooksRepository(db);
  const scopes = await repo.listScopesWithEvents();
  const perScope = await Promise.all(
    scopes.map((scope) => drain(db, scope.merchantId, scope.environment, opts)),
  );
  return perScope.reduce((sum, results) => sum + results.length, 0);
}

/** Reset in-process backoff cooldowns (test isolation). */
export function resetCooldowns(): void {
  cooldownMs.clear();
}
