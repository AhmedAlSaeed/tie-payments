/**
 * Invoicing seeds — per-tenant default tax rate.
 *
 * T05: tax is applied explicitly via configured `invoice_tax_rate` records (no
 * automatic_tax lookup). Each (merchant, environment) gets a guaranteed default
 * — Bahrain VAT 5% inclusive, jurisdiction `country:BH`, TIN from the merchant
 * row. `ensureDefaultTaxRate` is idempotent: it reads the merchant's TIN, then
 * inserts the rate only when no rate already exists for the scope.
 */
import type { Surreal } from "surrealdb";
import { recordIdOf } from "../../core/records";

export interface TaxRate {
  /** Record id string `invoice_tax_rate:<id>`. */
  id: string;
  percentage: number;
  inclusive: boolean;
  jurisdiction: string;
}

/** Name of the seeded default rate (shared by every tenant). */
export const DEFAULT_TAX_RATE_NAME = "Bahrain VAT";

/** INSERT the default BH VAT rate for a scope if none exists. Returns it. */
export async function ensureDefaultTaxRate(
  db: Surreal,
  merchantId: string,
  environment: "test" | "live",
): Promise<TaxRate> {
  const merchant = recordIdOf(merchantId);

  // Read the merchant's TIN (if any) to stamp on the rate. Scoped tenancy noted
  // in the tix — the merchant row is resolved from the authed context.
  const [merchantRows] = await db
    .query("SELECT tin FROM merchant WHERE id = $merchant", { merchant })
    .collect<[Array<{ tin?: string }>]>();
  const tin = merchantRows?.[0]?.tin ?? undefined;

  // Snapshot the scope's default before writing (the seeding is per-create).
  const [existing] = await db
    .query(
      "SELECT * FROM invoice_tax_rate WHERE merchant = $merchant AND environment = $environment AND name = $name LIMIT 1",
      { merchant, environment, name: DEFAULT_TAX_RATE_NAME },
    )
    .collect<[Array<TaxRateRow>]>();

  if (existing?.[0]) return mapTax(existing[0]);

  const id = `txr_${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO invoice_tax_rate {
       id: $id,
       merchant: $merchant,
       environment: $environment,
       name: $name,
       percentage: $percentage,
       inclusive: $inclusive,
       jurisdiction: "country:BH",
       tin: $tin
     }`,
    {
      id,
      merchant: merchant,
      environment,
      name: DEFAULT_TAX_RATE_NAME,
      percentage: 5,
      // Inclusive: the line unit_price already contains the 5% VAT.
      inclusive: true,
      tin: tin,
    },
  );

  return {
    id: `invoice_tax_rate:${id}`,
    percentage: 5,
    inclusive: true,
    jurisdiction: "country:BH",
  };
}

interface TaxRateRow {
  id: string;
  percentage: unknown;
  inclusive: unknown;
  jurisdiction: string;
}

function mapTax(row: TaxRateRow): TaxRate {
  return {
    id: String(row.id),
    percentage: typeof row.percentage === "number" ? row.percentage : Number(row.percentage),
    inclusive: Boolean(row.inclusive),
    jurisdiction: String(row.jurisdiction),
  };
}
