/**
 * Sandbox repository — SurrealDB persistence for the onboarding scaffold.
 *
 * Owns write/read of the `merchant`, `api_key` and `routing_rule` rows that the
 * sandbox provisions. API keys store ONLY SHA-256 hashes + prefix + role + env
 * (never raw secrets — PCI SAQ-A / T08 D6). Raw secrets are held purely in a
 * service-layer return value and are never written to the DB.
 *
 * Record links bind via `recordIdOf`; datetimes are stamped with `time::now()`
 * in SurrealQL (v3 gotcha — datetime params are not coerced).
 */
import type { Surreal } from "surrealdb";
import { recordIdOf, recordIdToString } from "../../core/records";

export interface MerchantRow {
  id: string;
  auth_user?: string;
  name?: string;
  settings?: Record<string, unknown>;
}

export interface ApiKeyRow {
  role: string;
  environment: string;
  prefix: string;
  hash: string;
  active: boolean;
}

export interface RoutingRuleRow {
  id: string;
  driver: string;
  position: number;
}

const bareUserId = (v: unknown): string => recordIdToString(v as string).replace(/^user:/, "");

export class SandboxRepository {
  constructor(private readonly db: Surreal) {}

  // ---------------------------------------------------------------------------
  // merchant
  // ---------------------------------------------------------------------------

  /** Find a merchant linked to a Better Auth user id. */
  async findMerchantByAuthUser(authUserId: string): Promise<MerchantRow | undefined> {
    const [rows] = await this.db
      .query("SELECT * FROM merchant WHERE auth_user = type::record('user', $id) LIMIT 1", {
        id: authUserId,
      })
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? this.mapMerchant(row) : undefined;
  }

  async findMerchantById(merchantId: string): Promise<MerchantRow | undefined> {
    const [rows] = await this.db
      .query("SELECT * FROM merchant WHERE id = type::record('merchant', $mid) LIMIT 1", {
        mid: recordIdToString(merchantId).replace(/^merchant:/, ""),
      })
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? this.mapMerchant(row) : undefined;
  }

  /** Create a merchant row for a Better Auth user. Idempotent at the app layer. */
  async createMerchant(params: {
    merchantKey: string;
    authUserId: string;
    name: string;
  }): Promise<void> {
    await this.db
      .query(
        `INSERT INTO merchant {
           id: $id,
           auth_user: $authUser,
           name: $name
         }`,
        {
          id: params.merchantKey,
          authUser: recordIdOf(`user:${params.authUserId}`),
          name: params.name,
        },
      )
      .collect();
  }

  // ---------------------------------------------------------------------------
  // api_key (hash-only storage)
  // ---------------------------------------------------------------------------

  /** Insert a hashed api_key row (raw secret never touches the DB). */
  async createApiKey(params: {
    merchantId: string;
    environment: "test" | "live";
    role: "sk" | "pk";
    prefix: string;
    hash: string;
  }): Promise<void> {
    await this.db
      .query(
        `INSERT INTO api_key {
           merchant: $merchant,
           environment: $environment,
           role: $role,
           prefix: $prefix,
           hash: $hash,
           active: true
         }`,
        {
          merchant: recordIdOf(params.merchantId),
          environment: params.environment,
          role: params.role,
          prefix: params.prefix,
          hash: params.hash,
        },
      )
      .collect();
  }

  /** Rotate (deactivate) every currently active test key pair. */
  async deactivateActiveTestKeys(merchantId: string): Promise<void> {
    await this.db
      .query(
        `UPDATE api_key SET active = false, rotated_at = time::now()
         WHERE merchant = $merchant AND environment = "test" AND active = true`,
        { merchant: recordIdOf(merchantId) },
      )
      .collect();
  }

  /** Active test keys a merchant holds (used for masked-prefix reads). */
  async listActiveTestKeys(merchantId: string): Promise<ApiKeyRow[]> {
    const [rows] = await this.db
      .query(
        'SELECT role, environment, prefix, hash, active FROM api_key WHERE merchant = $merchant AND environment = "test" AND active = true ORDER BY role',
        { merchant: recordIdOf(merchantId) },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map((r) => ({
      role: String(r.role),
      environment: String(r.environment),
      prefix: String(r.prefix),
      hash: String(r.hash),
      active: Boolean(r.active),
    }));
  }

  /** Mark a merchant's sandbox secrets as revealed (one-time read stamp). */
  async markSecretsRevealed(merchantId: string): Promise<void> {
    await this.db
      .query(
        `UPDATE merchant SET settings = { sandbox_keys_revealed_at: time::now() }
         WHERE id = type::record('merchant', $mid)`,
        { mid: recordIdToString(merchantId).replace(/^merchant:/, "") },
      )
      .collect();
  }

  // ---------------------------------------------------------------------------
  // routing_rule (default mock, match-all)
  // ---------------------------------------------------------------------------

  async createRoutingRule(params: {
    merchantId: string;
    environment: string;
    driver: string;
    position: number;
    conditions: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .query(
        `INSERT INTO routing_rule {
           merchant: $merchant,
           environment: $environment,
           position: $position,
           conditions: $conditions,
           driver: $driver,
           active: true
         }`,
        {
          merchant: recordIdOf(params.merchantId),
          environment: params.environment,
          position: params.position,
          conditions: params.conditions,
          driver: params.driver,
        },
      )
      .collect();
  }

  /** The merchant's default mock routing rule, if any. */
  async listRoutingRules(merchantId: string, environment: string): Promise<RoutingRuleRow[]> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM routing_rule WHERE merchant = $merchant AND environment = $environment ORDER BY position ASC",
        { merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    return (rows ?? []).map((r) => ({
      id: recordIdToString(r.id as string).replace(/^routing_rule:/, ""),
      driver: String(r.driver),
      position: Number(r.position),
    }));
  }

  // ---------------------------------------------------------------------------

  private mapMerchant(row: Record<string, unknown>): MerchantRow {
    const settings =
      row.settings && typeof row.settings === "object"
        ? (row.settings as Record<string, unknown>)
        : undefined;
    return {
      id: recordIdToString(row.id as string),
      auth_user: row.auth_user ? bareUserId(row.auth_user as string) : undefined,
      name: (row.name as string | undefined) ?? undefined,
      settings,
    };
  }
}
