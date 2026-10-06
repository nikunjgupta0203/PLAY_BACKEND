/**
 * payouts R9 — what a host is owed for one event. Pure over ledger rows, so
 * the number on the manage screen, the number transferred and the settlement
 * report can never disagree.
 *
 * Every row is signed (payments R6): refund, fee_reversal and tax_reversal are
 * already negative. A full refund reverses fee and tax too, so it nets the
 * entry fee to zero; a partial refund writes no reversal, so all of it comes
 * out of the entry fee — the host bears it, never the platform fee or the tax.
 */

export interface QuoteRow {
  registrationId: string;
  kind: string;
  amountPaise: bigint;
  /** The category's frozen commission_bps (migration 031). */
  commissionBps: number;
}

export interface QuoteRates {
  commissionGstBps: number;
  tdsBps: number;
  /** F27 — the host cancelled this event, so the gateway's fees on it are theirs. */
  hostBearsGatewayFees?: boolean;
}

export interface PayoutQuote {
  entryFeesPaise: bigint;
  refundsPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  tdsPaise: bigint;
  receivablesPaise: bigint;
  /** F27 — gateway fees charged to the host (a cancelled event only). */
  gatewayFeesPaise: bigint;
  /** May be negative: the caller carries the shortfall as a receivable. */
  amountPaise: bigint;
}

/** Half-up in integers; every base here is non-negative. */
export const roundBps = (base: bigint, bps: number): bigint => (base * BigInt(bps) + 5_000n) / 10_000n;

interface Entry {
  fee: bigint;
  refunded: bigint;
  bps: number;
}

export function payoutQuote(rows: QuoteRow[], openReceivablesPaise: bigint, rates: QuoteRates): PayoutQuote {
  const entries = new Map<string, Entry>();
  let gatewayFeesPaise = 0n;
  for (const row of rows) {
    if (row.kind === 'gateway_fee') {
      if (rates.hostBearsGatewayFees) gatewayFeesPaise += row.amountPaise;
      continue;
    }
    const e = entries.get(row.registrationId) ?? { fee: 0n, refunded: 0n, bps: row.commissionBps };
    switch (row.kind) {
      case 'charge':
        e.fee += row.amountPaise;
        break;
      case 'platform_fee':
      case 'tax':
        e.fee -= row.amountPaise;
        break;
      case 'refund':
        e.refunded -= row.amountPaise;
        break;
      case 'fee_reversal':
      case 'tax_reversal':
        e.refunded += row.amountPaise;
        break;
      default:
        continue;
    }
    entries.set(row.registrationId, e);
  }

  let entryFeesPaise = 0n;
  let refundsPaise = 0n;
  let commissionPaise = 0n;
  for (const e of entries.values()) {
    const refunded = e.refunded < e.fee ? e.refunded : e.fee;
    const net = e.fee - refunded;
    entryFeesPaise += e.fee;
    refundsPaise += refunded;
    commissionPaise += roundBps(net, e.bps);
  }

  const commissionTaxPaise = roundBps(commissionPaise, rates.commissionGstBps);
  const tdsPaise = roundBps(entryFeesPaise - refundsPaise, rates.tdsBps);
  const amountPaise =
    entryFeesPaise - refundsPaise - commissionPaise - commissionTaxPaise - tdsPaise - openReceivablesPaise - gatewayFeesPaise;

  return {
    entryFeesPaise,
    refundsPaise,
    commissionPaise,
    commissionTaxPaise,
    tdsPaise,
    receivablesPaise: openReceivablesPaise,
    gatewayFeesPaise,
    amountPaise,
  };
}
