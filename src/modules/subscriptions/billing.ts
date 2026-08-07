/**
 * Billing computations (pure) — minor-units `int` money, never float.
 *
 * Per-unit (flat/seat), tiered (volume vs graduated) and metered (usage × rate)
 * amount calculations for the period-close invoice line items. These are
 * deliberately side-effect free so they can be unit tested in isolation and
 * recomputed deterministically every cycle.
 */
import type { PricePeriod, Tier } from "./model";

/** Compute the billed amount (minor units) for a per_unit item. */
export function computePerUnit(unitAmount: number, quantity: number): number {
  return Math.round(unitAmount * quantity);
}

/**
 * Compute the billed amount (minor units) for a tiered item.
 *
 *  - `volume`: a single bucket rate applies to the total quantity. The bucket
 *    is the tier whose `up_to` first covers `quantity` (or the last tier); if
 *    that tier has a flat_amount it is charged once, otherwise its unit_amount
 *    times the full quantity.
 *  - `graduated`: the quantity is split into per-increment buckets bounded by
 *    each tier's `up_to`. Each contributing tier contributes its flat_amount
 *    (once, when it is entered) plus its unit_amount times the units it covers.
 */
export function computeTiered(
  mode: "graduated" | "volume",
  tiers: Tier[],
  quantity: number,
): number {
  if (quantity <= 0) return 0;
  const sorted = [...tiers].toSorted((a, b) => (a.up_to ?? Infinity) - (b.up_to ?? Infinity));

  if (mode === "volume") {
    const bucket = sorted.find((t) => t.up_to === undefined || quantity <= (t.up_to ?? 0));
    const tier = bucket ?? sorted[sorted.length - 1];
    if (tier.flat_amount !== undefined) return tier.flat_amount;
    return Math.round((tier.unit_amount ?? 0) * quantity);
  }

  // graduated — increment buckets
  let total = 0;
  let remaining = quantity;
  let prevUpTo = 0;
  for (const tier of sorted) {
    if (remaining <= 0) break;
    const ceiling = tier.up_to ?? Infinity;
    const units = Math.min(remaining, ceiling - prevUpTo);
    if (units > 0) {
      if (tier.flat_amount !== undefined) total += tier.flat_amount;
      if (tier.unit_amount !== undefined) total += Math.round(tier.unit_amount * units);
      remaining -= units;
    }
    prevUpTo = ceiling;
  }
  return total;
}

/** Compute the billed amount (minor units) for metered usage. */
export function computeMetered(unitAmount: number, usageTotal: number): number {
  return Math.round(unitAmount * usageTotal);
}

/**
 * Roll a point-in-time (ms) forward by a price period (interval × count).
 * Calendar-aware for month/year (overflows into the next month/year).
 */
export function addPeriod(startMs: number, period: PricePeriod): number {
  const intervalCount = period.interval_count ?? 1;
  const d = new Date(startMs);
  switch (period.interval) {
    case "day":
      d.setUTCDate(d.getUTCDate() + intervalCount);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() + intervalCount * 7);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() + intervalCount);
      break;
    case "year":
      d.setUTCFullYear(d.getUTCFullYear() + intervalCount);
      break;
  }
  return d.getTime();
}
