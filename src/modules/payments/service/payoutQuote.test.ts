import { describe, expect, it } from 'vitest';
import { payoutQuote, roundBps, type QuoteRow } from './payoutQuote.js';

const ZERO = { commissionGstBps: 0, tdsBps: 0 };

/** One paid entry as payments R6 writes it: ₹500 fee + ₹50 platform fee + 18% tax. */
const paid = (id: string, bps = 1000): QuoteRow[] => [
  { registrationId: id, kind: 'charge', amountPaise: 64_900n, commissionBps: bps },
  { registrationId: id, kind: 'platform_fee', amountPaise: 5_000n, commissionBps: bps },
  { registrationId: id, kind: 'tax', amountPaise: 9_900n, commissionBps: bps },
];

const fullRefund = (id: string, bps = 1000): QuoteRow[] => [
  { registrationId: id, kind: 'refund', amountPaise: -64_900n, commissionBps: bps },
  { registrationId: id, kind: 'fee_reversal', amountPaise: -5_000n, commissionBps: bps },
  { registrationId: id, kind: 'tax_reversal', amountPaise: -9_900n, commissionBps: bps },
];

describe('payouts R9 — payoutQuote', () => {
  it('pays the entry fees less 10%', () => {
    const q = payoutQuote([...paid('a'), ...paid('b')], 0n, ZERO);
    expect(q).toEqual({
      entryFeesPaise: 100_000n,
      refundsPaise: 0n,
      commissionPaise: 10_000n,
      commissionTaxPaise: 0n,
      tdsPaise: 0n,
      receivablesPaise: 0n,
      gatewayFeesPaise: 0n,
      amountPaise: 90_000n,
    });
  });

  it('F27 — gateway fees are informational, unless the host cancelled the event', () => {
    const fee = (id: string): QuoteRow => ({ registrationId: id, kind: 'gateway_fee', amountPaise: 1_180n, commissionBps: 1000 });
    const rows = [...paid('a'), fee('a'), ...paid('b'), fee('b')];
    expect(payoutQuote(rows, 0n, ZERO).amountPaise).toBe(90_000n);
    const cancelled = payoutQuote([...rows, ...fullRefund('a'), ...fullRefund('b')], 0n, { ...ZERO, hostBearsGatewayFees: true });
    expect(cancelled.gatewayFeesPaise).toBe(2_360n);
    expect(cancelled.amountPaise).toBe(-2_360n);
  });

  it('a full refund nets the entry to nothing, commission included', () => {
    const q = payoutQuote([...paid('a'), ...fullRefund('a'), ...paid('b')], 0n, ZERO);
    expect(q.entryFeesPaise).toBe(100_000n);
    expect(q.refundsPaise).toBe(50_000n);
    expect(q.commissionPaise).toBe(5_000n);
    expect(q.amountPaise).toBe(45_000n);
  });

  it('a partial refund comes out of the entry fee only', () => {
    const q = payoutQuote(
      [...paid('a'), { registrationId: 'a', kind: 'refund', amountPaise: -20_000n, commissionBps: 1000 }],
      0n,
      ZERO,
    );
    expect(q.refundsPaise).toBe(20_000n);
    expect(q.commissionPaise).toBe(3_000n); // 10% of 30_000 left
    expect(q.amountPaise).toBe(27_000n);
  });

  it('never lets a refund push an entry below zero', () => {
    const q = payoutQuote(
      [...paid('a'), { registrationId: 'a', kind: 'refund', amountPaise: -60_000n, commissionBps: 1000 }],
      0n,
      ZERO,
    );
    expect(q.commissionPaise).toBe(0n);
    expect(q.amountPaise).toBe(0n);
  });

  it('uses each category frozen rate', () => {
    const q = payoutQuote([...paid('a', 1000), ...paid('b', 0)], 0n, ZERO);
    expect(q.commissionPaise).toBe(5_000n);
  });

  it('applies GST on the commission and TDS on the net fees', () => {
    const q = payoutQuote([...paid('a'), ...paid('b')], 0n, { commissionGstBps: 1800, tdsBps: 10 });
    expect(q.commissionTaxPaise).toBe(1_800n);
    expect(q.tdsPaise).toBe(100n);
    expect(q.amountPaise).toBe(100_000n - 10_000n - 1_800n - 100n);
  });

  it('nets open receivables, and may go negative for the caller to carry', () => {
    const q = payoutQuote(paid('a'), 60_000n, ZERO);
    expect(q.receivablesPaise).toBe(60_000n);
    expect(q.amountPaise).toBe(45_000n - 60_000n);
  });

  it('rounds half a paisa up', () => {
    expect(roundBps(5n, 1000)).toBe(1n); // 0.5 → 1
    expect(roundBps(4n, 1000)).toBe(0n); // 0.4 → 0
  });

  it('ignores rows that are not entry money', () => {
    const q = payoutQuote(
      [...paid('a'), { registrationId: 'a', kind: 'host_payout', amountPaise: -45_000n, commissionBps: 1000 }],
      0n,
      ZERO,
    );
    expect(q.amountPaise).toBe(45_000n);
  });
});
