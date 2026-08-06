/**
 * Payments service — business logic for the payments pillar.
 *
 * Deliberately Elysia-free: receives a plain request context, returns typed
 * results or throws ProblemError. Gateway dispatch goes through the T03
 * abstraction (core/gateway): a driver is routed by currency/method rules,
 * invoked, and its normalized outcome maps onto the payment resource. The
 * created payment is persisted via the injected `PaymentStore` (F0 — SurrealDB
 * repository, previously a stub).
 */
import { problem } from "../../core/errors";
import type { Money } from "../../shared/constants";
import type { MerchantContext } from "../../core/context";
import type { GatewayDriver } from "../../core/gateway";
import type { CreatePayment, PaymentResource } from "./model";

/** Persistence seam for a payment (implemented by PaymentsRepository). */
export interface PaymentStore {
  create(record: PaymentRecord): Promise<PaymentRecord>;
  findById(merchantId: string, environment: string, id: string): Promise<PaymentRecord | undefined>;
}

export interface PaymentRecord {
  /** API-facing id (`pay_<uuid>`); stored as `payment:pay_<uuid>`. */
  id: string;
  merchantId: string;
  environment: "test" | "live";
  amountMinor: number;
  currency: string;
  status: PaymentResource["status"];
  /** Next action the caller must perform (redirect URL, QR code, …). */
  action?: PaymentResource["action"];
  /** Gateway reference for confirm/capture/refund later. */
  providerReference?: string;
  createdAt: string;
  /** Raw Idempotency-Key value (echoed on the resource). */
  idempotencyKey?: string;
  metadata?: Record<string, string>;
}

export class PaymentService {
  constructor(private readonly store: PaymentStore) {}

  async createPayment(
    ctx: MerchantContext,
    body: CreatePayment,
    gateway: GatewayDriver,
    idempotencyKey?: string,
  ): Promise<PaymentResource> {
    const money: Money = { amountMinor: body.amountMinor, currency: body.currency };
    this.assertUsableMoney(money);

    const result = await gateway.createPayment(
      {
        amountMinor: money.amountMinor,
        currency: money.currency,
        environment: ctx.environment,
        captureMode: "automatic",
        method: body.method,
        description: body.description,
        metadata: body.metadata,
      },
      money,
    );

    const record: PaymentRecord = {
      id: `pay_${crypto.randomUUID()}`,
      merchantId: ctx.merchantId,
      environment: ctx.environment,
      amountMinor: body.amountMinor,
      currency: body.currency,
      status: result.status,
      action: result.action,
      providerReference: result.providerReference,
      createdAt: new Date().toISOString(),
      idempotencyKey,
      metadata: body.metadata,
    };

    const saved = await this.store.create(record);
    return this.toResource(saved);
  }

  /** Look up a persisted payment by id; undefined when not found/out of scope. */
  async getById(
    merchantId: string,
    environment: string,
    id: string,
  ): Promise<PaymentResource | undefined> {
    const record = await this.store.findById(merchantId, environment, id);
    return record ? this.toResource(record) : undefined;
  }

  private assertUsableMoney(money: Money): void {
    // Currency exponent check (BHD=3) is a validation concern; keep a
    // defensive invariant here so money never silently loses precision.
    const MAX_MINOR = 1_000_000_000_000;
    if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor > MAX_MINOR) {
      throw problem("validation_error", `amountMinor must be a safe integer <= ${MAX_MINOR}`);
    }
  }

  toResource(r: PaymentRecord): PaymentResource {
    return {
      id: r.id,
      object: "payment",
      status: r.status,
      amountMinor: r.amountMinor,
      currency: r.currency,
      action: r.action,
      providerReference: r.providerReference,
      created: r.createdAt,
      environment: r.environment,
      idempotencyKey: r.idempotencyKey,
    };
  }
}
