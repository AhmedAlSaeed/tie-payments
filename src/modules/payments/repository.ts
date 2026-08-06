/**
 * Payments repository — SurrealDB persistence for the payment aggregate (F0).
 *
 * Every read/write binds `merchant` + `environment` from the authenticated
 * request context (the F0 tenancy guarantee; see core/context.ts). The UNIQUE
 * index on (merchant, environment, idempotency_key) is the duplicate guard for
 * the Idempotency-Key backstop.
 */
import type { Surreal } from "surrealdb";
import { recordIdOf, recordIdToString } from "../../core/records";
import type { PaymentRecord } from "./service";

export class PaymentsRepository {
  constructor(private readonly db: Surreal) {}

  /**
   * Insert a payment row. If a duplicate idempotency_key already exists (e.g.
   * an expired claim was re-claimed after a crash), returns the existing row
   * instead of throwing — the caller treats that as a replay.
   */
  async create(record: PaymentRecord): Promise<PaymentRecord> {
    try {
      // `created_at` is omitted — it defaults to time::now() in the schema
      // (datetime params are not coerced by the server).
      await this.db.query(
        `INSERT INTO payment {
           id: $id,
           merchant: $merchant,
           environment: $environment,
           amount_minor: $amountMinor,
           currency: $currency,
           status: $status,
           action: $action,
           provider_reference: $providerReference,
           idempotency_key: $idempotencyKey,
           metadata: $metadata
         }`,
        {
          id: record.id,
          merchant: recordIdOf(record.merchantId),
          environment: record.environment,
          amountMinor: record.amountMinor,
          currency: record.currency,
          status: record.status,
          action: record.action,
          providerReference: record.providerReference,
          idempotencyKey: record.idempotencyKey,
          metadata: record.metadata,
        },
      );
      return record;
    } catch (error) {
      if (record.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(
          record.merchantId,
          record.environment,
          record.idempotencyKey,
        );
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Fetch a payment scoped to merchant+environment; undefined if absent. */
  async findById(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<PaymentRecord | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM payment WHERE id = type::record('payment', $id) AND merchant = $merchant AND environment = $environment LIMIT 1",
        { id, merchant: recordIdOf(merchantId), environment },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapRow(row) : undefined;
  }

  /** Fetch by the Idempotency-Key value (the payment-table UNIQUE guard). */
  async findByIdempotencyKey(
    merchantId: string,
    environment: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM payment WHERE merchant = $merchant AND environment = $environment AND idempotency_key = $key LIMIT 1",
        { merchant: recordIdOf(merchantId), environment, key: idempotencyKey },
      )
      .collect<[Array<Record<string, unknown>>]>();
    const row = rows?.[0];
    return row ? mapRow(row) : undefined;
  }
}

/** Map a SurrealDB row (snake_case) to the service PaymentRecord shape. */
function mapRow(row: Record<string, unknown>): PaymentRecord {
  return {
    id: recordIdToString(row.id as string).replace(/^payment:/, ""),
    merchantId: recordIdToString(row.merchant as string),
    environment: row.environment as PaymentRecord["environment"],
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    status: row.status as PaymentRecord["status"],
    action: row.action as PaymentRecord["action"],
    providerReference: (row.provider_reference as string) ?? undefined,
    createdAt: String(row.created_at),
    idempotencyKey: (row.idempotency_key as string) ?? undefined,
    metadata: (row.metadata as Record<string, string>) ?? undefined,
  };
}
