/**
 * Merchant provisioning for integration tests.
 *
 * Seeds a `merchant` row plus hashed `api_key` rows (sk/pk × test/live) the way
 * the sandbox onboarding (T7) will, so API tests exercise the real
 * `api_key → merchant` resolution path in core/context.ts.
 */
import type { Surreal } from "surrealdb";
import { RecordId } from "surrealdb";
import { generateKey, parseKey } from "../../src/core/apikey";

export interface ProvisionedMerchant {
  /** Record id string: `merchant:<uuid>`. */
  merchantId: string;
  skTest: string;
  pkTest: string;
  skLive: string;
  pkLive: string;
}

export async function provisionMerchant(
  db: Surreal,
  name = "Test Merchant",
): Promise<ProvisionedMerchant> {
  const key = crypto.randomUUID();
  const merchantId = `merchant:${key}`;
  const merchant = new RecordId("merchant", key);

  await db.query("INSERT INTO merchant { id: $mid, name: $name }", { mid: key, name });

  const skTest = generateKey("sk", "test");
  const pkTest = generateKey("pk", "test");
  const skLive = generateKey("sk", "live");
  const pkLive = generateKey("pk", "live");

  const rows = [
    { raw: skTest, merchant },
    { raw: pkTest, merchant },
    { raw: skLive, merchant },
    { raw: pkLive, merchant },
  ];

  for (const { raw, merchant } of rows) {
    const parsed = parseKey(raw);
    await db.query(
      `INSERT INTO api_key {
         merchant: $merchant,
         environment: $env,
         role: $role,
         prefix: $prefix,
         hash: $hash
       }`,
      {
        merchant,
        env: parsed.env,
        role: parsed.type,
        prefix: `${parsed.type}_${parsed.env}_`,
        hash: parsed.hash,
      },
    );
  }

  return { merchantId, skTest, pkTest, skLive, pkLive };
}
