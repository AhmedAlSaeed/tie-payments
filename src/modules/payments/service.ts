/**
 * Payments service — business logic for the payments pillar.
 *
 * Deliberately Elysia-free: receives a plain request context, returns typed
 * results or throws ProblemError. Gateway dispatch goes through the T03
 * abstraction (core/gateway): a driver is routed by currency/method rules,
 * invoked, and its normalized outcome maps onto the payment resource.
 */
import { problem } from "../../core/errors";
import type { Money } from "../../shared/constants";
import type { MerchantContext } from "../../core/context";
import type { GatewayDriver } from "../../core/gateway";
import type { CreatePayment, PaymentResource } from "./model";

export interface PaymentServiceDeps {
  /** Insert a payment row. Stub until the SurrealDB store (T001). */
  insert: (payment: PaymentRecord) => Promise<PaymentRecord>;
}

export interface PaymentRecord {
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
  idempotencyKey?: string;
}

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

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
    };

    const saved = await this.deps.insert(record);
    return this.toResource(saved);
  }

  private assertUsableMoney(money: Money): void {
    // Currency exponent check (BHD=3) is a validation concern; keep a
    // defensive invariant here so money never silently loses precision.
    const MAX_MINOR = 1_000_000_000_000;
    if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor > MAX_MINOR) {
      throw problem("validation_error", `amountMinor must be a safe integer <= ${MAX_MINOR}`);
    }
  }

  private toResource(r: PaymentRecord): PaymentResource {
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
