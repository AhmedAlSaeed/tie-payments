/**
 * Payments service — business logic for the payments pillar.
 *
 * Deliberately Elysia-free: receives a plain request context, returns typed
 * results or throws ProblemError. This is the seam where T03 (gateway
 * abstraction) plugs in: `createPayment` currently records a payment and
 * returns `requires_action`; the gateway driver dispatch is stubbed until T03.
 */
import { problem } from "../../core/errors";
import type { Money } from "../../shared/constants";
import type { MerchantContext } from "../../core/context";
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
  createdAt: string;
  idempotencyKey?: string;
}

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  async createPayment(
    ctx: MerchantContext,
    body: CreatePayment,
    idempotencyKey?: string,
  ): Promise<PaymentResource> {
    const money: Money = { amountMinor: body.amountMinor, currency: body.currency };
    this.assertUsableMoney(money);

    const record: PaymentRecord = {
      id: `pay_${crypto.randomUUID()}`,
      merchantId: ctx.merchantId,
      environment: ctx.environment,
      amountMinor: body.amountMinor,
      currency: body.currency,
      // T03: dispatch to gateway driver → requires_action for 3DS, else succeeded.
      status: "requires_action",
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
      created: r.createdAt,
      environment: r.environment,
      idempotencyKey: r.idempotencyKey,
    };
  }
}
