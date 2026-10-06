/**
 * events R3 — the price quote is the one place money is computed, so it is the
 * one piece of this module that is worth testing without a database at all.
 *
 * The cases below are the ones that produce a rupee of drift between the
 * confirm screen and the gateway charge if the arithmetic is done in floats or
 * rounded in the wrong direction.
 */
import { describe, expect, it } from 'vitest';
import { CURRENCY, HOST_COMMISSION_BPS, hostEarnings, priceQuote } from './priceQuote.js';

const GST = 1800; // 18%

describe('events priceQuote', () => {
  it('R3: total is entry + platform fee + tax on both', () => {
    const quote = priceQuote({
      entryFeePaise: 50_000n, // ₹500
      platformFeePaise: 5_000n, // ₹50
      taxBps: GST,
    });
    expect(quote.taxPaise).toBe(9_900n); // 18% of ₹550
    expect(quote.totalPaise).toBe(64_900n);
    expect(quote.currency).toBe(CURRENCY);
  });

  it('R3: tax is charged on the platform fee too, not on the entry fee alone', () => {
    const withFee = priceQuote({
      entryFeePaise: 50_000n,
      platformFeePaise: 5_000n,
      taxBps: GST,
    });
    const withoutFee = priceQuote({
      entryFeePaise: 50_000n,
      platformFeePaise: 0n,
      taxBps: GST,
    });
    expect(withFee.taxPaise - withoutFee.taxPaise).toBe(900n); // 18% of ₹50
  });

  it('R3: a free draw quotes zero, not NaN and not a rounding artefact', () => {
    const quote = priceQuote({ entryFeePaise: 0n, platformFeePaise: 0n, taxBps: GST });
    expect(quote.taxPaise).toBe(0n);
    expect(quote.totalPaise).toBe(0n);
  });

  it('R3: a zero tax rate adds nothing', () => {
    const quote = priceQuote({ entryFeePaise: 49_950n, platformFeePaise: 0n, taxBps: 0 });
    expect(quote.taxPaise).toBe(0n);
    expect(quote.totalPaise).toBe(49_950n);
  });

  it('R3: rounding is half-up in integer paise, never a float', () => {
    // 18% of 49,950 paise is 8,991 exactly — the case a naive float gets right.
    expect(priceQuote({ entryFeePaise: 49_950n, platformFeePaise: 0n, taxBps: GST }).taxPaise).toBe(
      8_991n,
    );

    // 18% of 1 paisa is 0.18 → 0. Half-up rounds at .5, not at .18.
    expect(priceQuote({ entryFeePaise: 1n, platformFeePaise: 0n, taxBps: GST }).taxPaise).toBe(0n);

    // 5% of 10 paise is 0.5 exactly — the boundary. Half-up takes it to 1.
    expect(priceQuote({ entryFeePaise: 10n, platformFeePaise: 0n, taxBps: 500 }).taxPaise).toBe(1n);

    // And just under the boundary stays down.
    expect(priceQuote({ entryFeePaise: 9n, platformFeePaise: 0n, taxBps: 500 }).taxPaise).toBe(0n);
  });

  it('R3: the amount survives values that would lose precision as a float', () => {
    // ₹90,071,992.54 — past Number.MAX_SAFE_INTEGER once expressed in paise.
    const entryFeePaise = 9_007_199_254_740_993n;
    const quote = priceQuote({ entryFeePaise, platformFeePaise: 0n, taxBps: GST });
    expect(quote.entryFeePaise).toBe(entryFeePaise);
    expect(quote.totalPaise).toBe(entryFeePaise + quote.taxPaise);
    // The exact value matters: Number() on either side of this would drift.
    expect(quote.taxPaise).toBe(1_621_295_865_853_379n);
  });

  it('R3: the quote is pure — the same row always quotes the same total', () => {
    const category = { entryFeePaise: 123_456n, platformFeePaise: 7_890n, taxBps: GST };
    expect(priceQuote(category)).toEqual(priceQuote(category));
  });
});

describe('events hostEarnings', () => {
  it('hosting H1: 10% of a paid entry is the commission, the rest is the host’s', () => {
    expect(hostEarnings({ entryFeePaise: 50_000n, commissionBps: HOST_COMMISSION_BPS })).toEqual({
      commissionPaise: 5_000n,
      hostReceivesPaise: 45_000n,
    });
  });

  it('hosting H1: a free entry earns nobody anything', () => {
    expect(hostEarnings({ entryFeePaise: 0n, commissionBps: HOST_COMMISSION_BPS })).toEqual({
      commissionPaise: 0n,
      hostReceivesPaise: 0n,
    });
  });

  it('hosting H1: commission rounds half up in integer paise', () => {
    expect(hostEarnings({ entryFeePaise: 49_950n, commissionBps: 1000 }).commissionPaise).toBe(4_995n);
    expect(hostEarnings({ entryFeePaise: 5n, commissionBps: 1000 }).commissionPaise).toBe(1n);
    expect(hostEarnings({ entryFeePaise: 4n, commissionBps: 1000 }).commissionPaise).toBe(0n);
  });

  it('hosting H1: the platform keeps 10%', () => {
    expect(HOST_COMMISSION_BPS).toBe(1000);
  });
});
