/**
 * Webhooks repository — SurrealDB persistence for the T07 outbox + delivery
 * tables (`outbox_event`, `event_delivery`, `webhook_endpoint`,
 * `inbound_webhook`).
 *
 * Every read/write binds `merchant` + `environment` from the authenticated
 * request context (the F0 query-layer tenancy guarantee). Record links are
 * bound as SDK `RecordId` objects via `recordIdOf` — never bare strings.
 *
 * The `event_delivery` UNIQUE (merchant, environment, event, endpoint) index
 * is the at-least-once guard: one delivery row per (event, endpoint) pair,
 * `attempt` incrementing on retry. The `inbound_webhook` UNIQUE
 * (merchant, environment, driver, gateway_event_id) index makes a replayed
 * gateway webhook a 200 no-op instead of a re-emitted canonical event.
 */
import type { Surreal } from "surrealdb";
import { RecordId } from "surrealdb";
import { recordIdOf, recordIdToString } from "../../core/records";
import type { Environment } from "../../shared/constants";
import type { OutboxEventRow } from "./model";

export interface Scope {
  merchantId: string;
  environment: Environment;
}

/** A `webhook_endpoint` row read back from the DB (secret included). */
export interface EndpointRow {
  id: string;
  url: string;
  secret?: string;
  enabled: boolean;
  events: string[];
  max_attempts: number;
  created_at: Date | string;
}

/** An `event_delivery` row; `event`/`endpoint` are record-link values. */
export interface DeliveryRow {
  id: string;
  event: string;
  endpoint: string;
  attempt: number;
  delivered_at?: Date | string;
  response_status?: number;
  signature: string;
  deadlettered_at?: Date | string;
}

const bareId = (value: unknown, table: string): string => {
  const s = value instanceof RecordId ? recordIdToString(value) : String(value);
  return s.replace(new RegExp(`^${table}:`), "");
};

export class WebhooksRepository {
  constructor(private readonly db: Surreal) {}

  // ---------------------------------------------------------------------------
  // outbox_event
  // ---------------------------------------------------------------------------

  async createOutboxEvent(entry: {
    id: string;
    scope: Scope;
    type: string;
    objectType: string;
    objectId: string;
    object: Record<string, unknown>;
  }): Promise<void> {
    // `created_at` + `window` default to / are stamped with time::now() in
    // SurrealQL — datetime params are not coerced by the server (v3 gotcha).
    await this.db
      .query(
        `INSERT INTO outbox_event {
           id: $id,
           merchant: $merchant,
           environment: $environment,
           type: $type,
           object_type: $objectType,
           object_id: $objectId,
           object: $object,
           window: time::now()
         }`,
        {
          id: entry.id,
          merchant: recordIdOf(entry.scope.merchantId),
          environment: entry.scope.environment,
          type: entry.type,
          objectType: entry.objectType,
          objectId: entry.objectId,
          object: entry.object,
        },
      )
      .collect();
  }

  async listEvents(scope: Scope): Promise<OutboxEventRow[]> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM outbox_event WHERE merchant = $merchant AND environment = $environment ORDER BY created_at ASC",
        { merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map(mapEventRow);
  }

  async findEvent(scope: Scope, id: string): Promise<OutboxEventRow | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM outbox_event WHERE id = type::record('outbox_event', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapEventRow(row) : undefined;
  }

  // ---------------------------------------------------------------------------
  // webhook_endpoint
  // ---------------------------------------------------------------------------

  async createEndpoint(entry: {
    id: string;
    scope: Scope;
    url: string;
    secret: string;
    enabled: boolean;
    events: string[];
    maxAttempts: number;
  }): Promise<void> {
    await this.db
      .query(
        `INSERT INTO webhook_endpoint {
           id: $id,
           merchant: $merchant,
           environment: $environment,
           url: $url,
           secret: $secret,
           enabled: $enabled,
           events: $events,
           max_attempts: $maxAttempts
         }`,
        {
          id: entry.id,
          merchant: recordIdOf(entry.scope.merchantId),
          environment: entry.scope.environment,
          url: entry.url,
          secret: entry.secret,
          enabled: entry.enabled,
          events: entry.events,
          maxAttempts: entry.maxAttempts,
        },
      )
      .collect();
  }

  async listEndpoints(scope: Scope): Promise<EndpointRow[]> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM webhook_endpoint WHERE merchant = $merchant AND environment = $environment ORDER BY created_at ASC",
        { merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map(mapEndpointRow);
  }

  async findEndpoint(scope: Scope, id: string): Promise<EndpointRow | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM webhook_endpoint WHERE id = type::record('webhook_endpoint', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapEndpointRow(row) : undefined;
  }

  async updateEndpoint(
    scope: Scope,
    id: string,
    patch: Partial<Pick<EndpointRow, "url" | "enabled" | "events" | "max_attempts">>,
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: Record<string, unknown> = {
      merchant: recordIdOf(scope.merchantId),
      environment: scope.environment,
      id,
    };
    if (patch.url !== undefined) {
      sets.push("url = $url");
      params.url = patch.url;
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = $enabled");
      params.enabled = patch.enabled;
    }
    if (patch.events !== undefined) {
      sets.push("events = $events");
      params.events = patch.events;
    }
    if (patch.max_attempts !== undefined) {
      sets.push("max_attempts = $maxAttempts");
      params.maxAttempts = patch.max_attempts;
    }
    if (sets.length === 0) return true;

    const [info] = await this.db
      .query(
        `UPDATE webhook_endpoint SET ${sets.join(", ")}
         WHERE id = type::record('webhook_endpoint', $id) AND merchant = $merchant AND environment = $environment`,
        params,
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (info ?? []).length > 0;
  }

  async deleteEndpoint(scope: Scope, id: string): Promise<boolean> {
    const [info] = await this.db
      .query(
        "DELETE webhook_endpoint WHERE id = type::record('webhook_endpoint', $id) AND merchant = $merchant AND environment = $environment RETURN BEFORE",
        { id, merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (info ?? []).length > 0;
  }

  // ---------------------------------------------------------------------------
  // event_delivery
  // ---------------------------------------------------------------------------

  /** All delivery rows for a scope (delivered, pending, and dead-lettered). */
  async listDeliveries(scope: Scope): Promise<DeliveryRow[]> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM event_delivery WHERE merchant = $merchant AND environment = $environment ORDER BY attempt ASC",
        { merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map(mapDeliveryRow);
  }

  async findDeliveryFor(
    scope: Scope,
    eventId: string,
    endpointId: string,
  ): Promise<DeliveryRow | undefined> {
    const [rows] = await this.db
      .query(
        `SELECT * FROM event_delivery
         WHERE merchant = $merchant AND environment = $environment
           AND event = type::record('outbox_event', $eventId)
           AND endpoint = type::record('webhook_endpoint', $endpointId)
         LIMIT 1`,
        {
          merchant: recordIdOf(scope.merchantId),
          environment: scope.environment,
          eventId,
          endpointId,
        },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapDeliveryRow(row) : undefined;
  }

  async findDeliveryById(scope: Scope, id: string): Promise<DeliveryRow | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM event_delivery WHERE id = type::record('event_delivery', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapDeliveryRow(row) : undefined;
  }

  /** Create the first attempt (attempt = 1) of a delivery for an (event, endpoint) pair. */
  async createDelivery(
    scope: Scope,
    eventId: string,
    endpointId: string,
  ): Promise<DeliveryRow | undefined> {
    try {
      await this.db
        .query(
          `INSERT INTO event_delivery {
             merchant: $merchant,
             environment: $environment,
             event: type::record('outbox_event', $eventId),
             endpoint: type::record('webhook_endpoint', $endpointId),
             attempt: 1,
             signature: ''
           }`,
          {
            merchant: recordIdOf(scope.merchantId),
            environment: scope.environment,
            eventId,
            endpointId,
          },
        )
        .collect();
      return this.findDeliveryFor(scope, eventId, endpointId);
    } catch {
      // Unique (merchant, env, event, endpoint) — the pair already exists.
      return this.findDeliveryFor(scope, eventId, endpointId);
    }
  }

  async markDelivered(
    scope: Scope,
    id: string,
    statusCode: number,
    signature: string,
  ): Promise<void> {
    await this.db
      .query(
        `UPDATE event_delivery SET
           delivered_at = time::now(),
           response_status = $statusCode,
           signature = $signature
         WHERE id = type::record('event_delivery', $id) AND merchant = $merchant AND environment = $environment`,
        {
          id,
          merchant: recordIdOf(scope.merchantId),
          environment: scope.environment,
          statusCode,
          signature,
        },
      )
      .collect();
  }

  async markFailed(
    scope: Scope,
    id: string,
    statusCode: number,
    attempt: number,
    signature: string,
  ): Promise<void> {
    await this.db
      .query(
        `UPDATE event_delivery SET
           attempt = $attempt,
           response_status = $statusCode,
           signature = $signature
         WHERE id = type::record('event_delivery', $id) AND merchant = $merchant AND environment = $environment`,
        {
          id,
          merchant: recordIdOf(scope.merchantId),
          environment: scope.environment,
          attempt,
          statusCode,
          signature,
        },
      )
      .collect();
  }

  async markDeadlettered(
    scope: Scope,
    id: string,
    statusCode: number,
    attempt: number,
    signature: string,
  ): Promise<void> {
    await this.db
      .query(
        `UPDATE event_delivery SET
           attempt = $attempt,
           response_status = $statusCode,
           signature = $signature,
           deadlettered_at = time::now()
         WHERE id = type::record('event_delivery', $id) AND merchant = $merchant AND environment = $environment`,
        {
          id,
          merchant: recordIdOf(scope.merchantId),
          environment: scope.environment,
          attempt,
          statusCode,
          signature,
        },
      )
      .collect();
  }

  /** Reset a delivery so replay re-sends the stored envelope from attempt 1. */
  async resetForReplay(scope: Scope, id: string): Promise<void> {
    await this.db
      .query(
        `UPDATE event_delivery SET
           attempt = 1,
           delivered_at = NONE,
           deadlettered_at = NONE,
           response_status = NONE
         WHERE id = type::record('event_delivery', $id) AND merchant = $merchant AND environment = $environment`,
        { id, merchant: recordIdOf(scope.merchantId), environment: scope.environment },
      )
      .collect();
  }

  // ---------------------------------------------------------------------------
  // inbound_webhook (dedup + canonical emit)
  // ---------------------------------------------------------------------------

  async isInboundSeen(scope: Scope, driver: string, gatewayEventId: string): Promise<boolean> {
    const [rows] = await this.db
      .query(
        `SELECT id FROM inbound_webhook
         WHERE merchant = $merchant AND environment = $environment
           AND driver = $driver AND gateway_event_id = $gatewayEventId
         LIMIT 1`,
        {
          merchant: recordIdOf(scope.merchantId),
          environment: scope.environment,
          driver,
          gatewayEventId,
        },
      )
      .collect<[Array<{ id: string }>]>();
    return (rows ?? []).length > 0;
  }

  /**
   * Record a seen gateway webhook AND emit its canonical outbox event in one
   * atomic multi-statement query (T01/T07 idempotency-in-transaction). The
   * `inbound_webhook` UNIQUE index is the dedup gate: a replayed gateway
   * delivery violates it, the whole batch rolls back, and we return `false` —
   * the caller replies 200 no-op without re-emitting.
   */
  async ingestInboundAndEmit(params: {
    scope: Scope;
    driver: string;
    gatewayEventId: string;
    providerReference: string;
    canonicalType: string;
    event: {
      id: string;
      type: string;
      objectType: string;
      objectId: string;
      object: Record<string, unknown>;
    };
  }): Promise<boolean> {
    // Pre-check dedup before the atomic batch (belt) — the UNIQUE index is the
    // backstop, and the batch rollback is the braces. A replay returns here.
    if (await this.isInboundSeen(params.scope, params.driver, params.gatewayEventId)) {
      return false;
    }
    try {
      await this.db
        .query(
          `INSERT INTO inbound_webhook {
             merchant: $merchant,
             environment: $environment,
             driver: $driver,
             gateway_event_id: $gatewayEventId,
             provider_reference: $providerReference,
             canonical_type: $canonicalType,
             created_at: time::now()
           };
           INSERT INTO outbox_event {
             id: $eventId,
             merchant: $merchant,
             environment: $environment,
             type: $eventType,
             object_type: $objectType,
             object_id: $objectId,
             object: $object,
             window: time::now()
           };`,
          {
            merchant: recordIdOf(params.scope.merchantId),
            environment: params.scope.environment,
            driver: params.driver,
            gatewayEventId: params.gatewayEventId,
            providerReference: params.providerReference,
            canonicalType: params.canonicalType,
            eventId: params.event.id,
            eventType: params.event.type,
            objectType: params.event.objectType,
            objectId: params.event.objectId,
            object: params.event.object,
          },
        )
        .collect();
      return true;
    } catch {
      return false;
    }
  }

  /** Distinct (merchant, environment) scopes with outbox events — ticker cursor. */
  async listScopesWithEvents(): Promise<Scope[]> {
    const [rows] = await this.db
      .query("SELECT DISTINCT merchant, environment FROM outbox_event")
      .collect<[Array<{ merchant: string; environment: string }>]>();
    return (rows ?? []).map((row) => ({
      merchantId: recordIdToString(row.merchant),
      environment: row.environment as Environment,
    }));
  }
}

/** Map a raw `outbox_event` row to the OutboxEventRow shape (bare canonical ids). */
function mapEventRow(row: Record<string, unknown>): OutboxEventRow {
  return {
    id: bareId(row.id, "outbox_event"),
    merchant: recordIdToString(row.merchant as string),
    environment: row.environment as Environment,
    type: String(row.type),
    object_type: String(row.object_type),
    object_id: String(row.object_id),
    object: (row.object as Record<string, unknown>) ?? {},
    created_at: row.created_at as Date,
  };
}

function mapEndpointRow(row: Record<string, unknown>): EndpointRow {
  return {
    id: bareId(row.id, "webhook_endpoint"),
    url: String(row.url),
    secret: (row.secret as string | undefined) ?? undefined,
    enabled: Boolean(row.enabled),
    events: Array.isArray(row.events) ? (row.events as string[]) : [],
    max_attempts: Number(row.max_attempts),
    created_at: row.created_at as Date,
  };
}

function mapDeliveryRow(row: Record<string, unknown>): DeliveryRow {
  return {
    id: bareId(row.id, "event_delivery"),
    event: bareId(row.event, "outbox_event"),
    endpoint: bareId(row.endpoint, "webhook_endpoint"),
    attempt: Number(row.attempt),
    delivered_at: row.delivered_at as Date | string | undefined,
    response_status: row.response_status === undefined ? undefined : Number(row.response_status),
    signature: String(row.signature ?? ""),
    deadlettered_at: row.deadlettered_at as Date | string | undefined,
  };
}
