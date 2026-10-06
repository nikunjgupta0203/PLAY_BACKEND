/**
 * events R3 — the ONE place money is computed.
 *
 * `registration` freezes a quote onto the registration; `payments` recomputes
 * one server-side before asking the gateway for an order. Both call THIS function
 * over the same category row, which is what makes "the price on the confirm
 * screen is byte-identical to the amount the gateway is asked to charge" a
 * property rather than a hope.
 *
 * Pure, synchronous, and takes a plain row: it has to be callable from a
 * resolver, a service and a worker without any of them owning it.
 *
 * Everything is bigint paise. No float touches money anywhere (conventions.md
 * §2), because 18% of ₹499.50 in IEEE-754 is a rounding argument waiting to be
 * had against a payment gateway that has already settled.
 */

export interface Priced {
  entryFeePaise: bigint;
  platformFeePaise: bigint;
  /** Tax in basis points. 1800 = 18% GST. */
  taxBps: number;
}

export interface PriceQuote {
  entryFeePaise: bigint;
  platformFeePaise: bigint;
  taxPaise: bigint;
  totalPaise: bigint;
  currency: string;
}

/** The only currency Phase 1 sells in. The gateway is asked for it explicitly. */
export const CURRENCY = 'INR';

const BPS = 10_000n;

/**
 * Round half up, in integers. `(x * bps + 5000) / 10000` with bigint division
 * truncating toward zero is exactly half-up for non-negative amounts, and every
 * amount here is non-negative.
 */
const taxOn = (basePaise: bigint, bps: number): bigint =>
  (basePaise * BigInt(bps) + BPS / 2n) / BPS;

/**
 * GST is charged on the whole consideration — entry fee AND platform fee — not
 * on the entry fee alone. Taxing only part of what the player pays is a filing
 * problem later, and correcting it after tickets are sold means reissuing them.
 */
export function priceQuote(category: Priced): PriceQuote {
  const entryFeePaise = category.entryFeePaise;
  const platformFeePaise = category.platformFeePaise;
  const base = entryFeePaise + platformFeePaise;
  const taxPaise = taxOn(base, category.taxBps);

  return {
    entryFeePaise,
    platformFeePaise,
    taxPaise,
    totalPaise: base + taxPaise,
    currency: CURRENCY,
  };
}

/** The platform's cut of every paid entry, taken from the host's share. */
export const HOST_COMMISSION_BPS = 1000;

export interface HostEarnings {
  commissionPaise: bigint;
  hostReceivesPaise: bigint;
}

/**
 * What the host keeps per entry. The commission comes out of the entry fee and
 * never raises the player's price, so it is not part of `priceQuote`.
 */
export function hostEarnings(category: {
  entryFeePaise: bigint;
  commissionBps: number;
}): HostEarnings {
  const commissionPaise = taxOn(category.entryFeePaise, category.commissionBps);
  return {
    commissionPaise,
    hostReceivesPaise: category.entryFeePaise - commissionPaise,
  };
}
