import { describe, expect, it } from 'vitest';
import {
  commissionBpsFor,
  ineligibility,
  offerDiscount,
  offerSummary,
  priceWithOffers,
  settlementFor,
  type BookingFacts,
  type OfferRule,
  type StackingSettings,
} from './engine.js';

const AT = new Date('2026-11-10T08:00:00Z'); // a Tuesday, 13:30 IST
const offer = (o: Partial<OfferRule> & Pick<OfferRule, 'id' | 'fundedBy'>): OfferRule => ({
  venueId: o.fundedBy === 'venue' ? 'v1' : null,
  title: 'Offer',
  kind: 'percent',
  percentBps: 1000,
  flatPaise: 0n,
  maxDiscountPaise: null,
  minAmountPaise: 0n,
  minMinutes: 0,
  weekdays: [],
  timeFromMin: null,
  timeToMin: null,
  firstBookingOnly: false,
  startsAt: new Date('2026-11-01T00:00:00Z'),
  endsAt: null,
  usageLimit: null,
  perUserLimit: null,
  active: true,
  ...o,
});
const facts = (f: Partial<BookingFacts> = {}): BookingFacts => ({
  venueId: 'v1',
  basePaise: 100_000n, // ₹1,000
  minutes: 60,
  weekday: 1,
  startMin: 14 * 60,
  endMin: 15 * 60,
  at: AT,
  firstAtVenue: false,
  firstAnywhere: false,
  usedByUser: new Map(),
  usedTotal: new Map(),
  ...f,
});
const STACK: StackingSettings = { allowStacking: true, platformDiscountBase: 'after_venue', maxDiscountBps: 10_000 };

describe('pricing engine — combining venue and PL4Y discounts (§7)', () => {
  it('the brief’s example: venue 20% off, then PL4Y 10% more up to ₹100 — both apply, calculated separately', () => {
    const p = priceWithOffers({
      facts: facts(),
      venueOffers: [offer({ id: 'v20', fundedBy: 'venue', percentBps: 2000 })],
      platformOffers: [offer({ id: 'p10', fundedBy: 'platform', percentBps: 1000, maxDiscountPaise: 10_000n })],
      settings: STACK,
    });
    expect(p.venueDiscountPaise).toBe(20_000n); // ₹200
    expect(p.platformDiscountPaise).toBe(8_000n); // 10% of ₹800 = ₹80, under the ₹100 cap
    expect(p.courtPaise).toBe(72_000n);
    expect(p.venueOffer?.id).toBe('v20');
    expect(p.platformOffer?.id).toBe('p10');
  });

  it('PL4Y’s cap bites on a bigger booking', () => {
    const p = priceWithOffers({
      facts: facts({ basePaise: 300_000n }),
      venueOffers: [offer({ id: 'v20', fundedBy: 'venue', percentBps: 2000 })],
      platformOffers: [offer({ id: 'p10', fundedBy: 'platform', percentBps: 1000, maxDiscountPaise: 10_000n })],
      settings: STACK,
    });
    expect(p.platformDiscountPaise).toBe(10_000n);
    expect(p.courtPaise).toBe(300_000n - 60_000n - 10_000n);
  });

  it('PL4Y’s percentage can be taken off the original price instead', () => {
    const p = priceWithOffers({
      facts: facts(),
      venueOffers: [offer({ id: 'v20', fundedBy: 'venue', percentBps: 2000 })],
      platformOffers: [offer({ id: 'p10', fundedBy: 'platform', percentBps: 1000 })],
      settings: { ...STACK, platformDiscountBase: 'original' },
    });
    expect(p.platformDiscountPaise).toBe(10_000n);
  });

  it('without stacking only the bigger discount applies', () => {
    const p = priceWithOffers({
      facts: facts(),
      venueOffers: [offer({ id: 'v10', fundedBy: 'venue', percentBps: 1000 })],
      platformOffers: [offer({ id: 'p15', fundedBy: 'platform', percentBps: 1500 })],
      settings: { ...STACK, allowStacking: false },
    });
    expect(p.venueOffer).toBeNull();
    expect(p.platformDiscountPaise).toBe(15_000n);
  });

  it('never takes more than the configured share, trimming PL4Y’s discount first', () => {
    const p = priceWithOffers({
      facts: facts(),
      venueOffers: [offer({ id: 'v40', fundedBy: 'venue', percentBps: 4000 })],
      platformOffers: [offer({ id: 'p40', fundedBy: 'platform', percentBps: 4000 })],
      settings: { ...STACK, maxDiscountBps: 5000 },
    });
    expect(p.venueDiscountPaise).toBe(40_000n);
    expect(p.platformDiscountPaise).toBe(10_000n);
    expect(p.courtPaise).toBe(50_000n);
  });

  it('never exceeds the booking amount: a paid booking keeps the ₹1 minimum charge', () => {
    const p = priceWithOffers({
      facts: facts({ basePaise: 30_000n }),
      venueOffers: [offer({ id: 'flat', fundedBy: 'venue', kind: 'flat', percentBps: 0, flatPaise: 25_000n })],
      platformOffers: [offer({ id: 'pflat', fundedBy: 'platform', kind: 'flat', percentBps: 0, flatPaise: 25_000n })],
      settings: STACK,
    });
    expect(p.courtPaise).toBe(100n);
    expect(p.venueDiscountPaise).toBe(25_000n);
    expect(p.platformDiscountPaise).toBe(4_900n);
  });

  it('picks the venue’s best offer and ignores another venue’s', () => {
    const p = priceWithOffers({
      facts: facts(),
      venueOffers: [
        offer({ id: 'small', fundedBy: 'venue', percentBps: 500 }),
        offer({ id: 'big', fundedBy: 'venue', kind: 'flat', percentBps: 0, flatPaise: 15_000n }),
        offer({ id: 'elsewhere', fundedBy: 'venue', venueId: 'v2', percentBps: 9000 }),
      ],
      platformOffers: [],
      settings: STACK,
    });
    expect(p.venueOffer?.id).toBe('big');
  });
});

describe('pricing engine — eligibility (§6)', () => {
  const o = (x: Partial<OfferRule>) => offer({ id: 'o', fundedBy: 'venue', ...x });
  it('time-slot offers: the booking must sit inside the window', () => {
    expect(ineligibility(o({ timeFromMin: 14 * 60, timeToMin: 17 * 60 }), facts())).toBeNull();
    expect(ineligibility(o({ timeFromMin: 14 * 60, timeToMin: 17 * 60 }), facts({ startMin: 16 * 60 + 30, endMin: 17 * 60 + 30 }))).toBe('wrong_time');
  });
  it('weekday and weekend offers', () => {
    expect(ineligibility(o({ weekdays: [5, 6] }), facts())).toBe('wrong_day');
    expect(ineligibility(o({ weekdays: [0, 1, 2, 3, 4] }), facts())).toBeNull();
  });
  it('first-time customers only', () => {
    expect(ineligibility(o({ firstBookingOnly: true }), facts())).toBe('not_first_booking');
    expect(ineligibility(o({ firstBookingOnly: true }), facts({ firstAtVenue: true }))).toBeNull();
    // A PL4Y offer for every venue means first on PL4Y.
    expect(ineligibility(offer({ id: 'p', fundedBy: 'platform', firstBookingOnly: true }), facts({ firstAtVenue: true }))).toBe('not_first_booking');
  });
  it('minimum value, minimum duration, dates and limits', () => {
    expect(ineligibility(o({ minAmountPaise: 150_000n }), facts())).toBe('below_min_amount');
    expect(ineligibility(o({ minMinutes: 90 }), facts())).toBe('below_min_minutes');
    expect(ineligibility(o({ startsAt: new Date('2026-12-01') }), facts())).toBe('not_started');
    expect(ineligibility(o({ endsAt: new Date('2026-11-09') }), facts())).toBe('ended');
    expect(ineligibility(o({ usageLimit: 3 }), facts({ usedTotal: new Map([['o', 3]]) }))).toBe('used_up');
    expect(ineligibility(o({ perUserLimit: 1 }), facts({ usedByUser: new Map([['o', 1]]) }))).toBe('used_by_you');
    expect(ineligibility(o({ active: false }), facts())).toBe('inactive');
  });
  it('a discount is capped and never more than the price', () => {
    expect(offerDiscount({ kind: 'percent', percentBps: 2000, flatPaise: 0n, maxDiscountPaise: 5_000n }, 100_000n)).toBe(5_000n);
    expect(offerDiscount({ kind: 'flat', percentBps: 0, flatPaise: 50_000n, maxDiscountPaise: null }, 20_000n)).toBe(20_000n);
  });
  it('summarises an offer for a card', () => {
    expect(offerSummary({ kind: 'percent', percentBps: 1000, flatPaise: 0n, maxDiscountPaise: 10_000n, minAmountPaise: 0n, minMinutes: 60 })).toBe(
      '10% off up to ₹100 for 60 minutes or longer',
    );
  });
});

describe('pricing engine — commission and settlement (§5)', () => {
  const S = { bookingCommissionBps: 1000, venuePayCommissionBps: 1000, introEnabled: true, introCommissionBps: 0 };
  const terms = { introStartsAt: new Date('2026-11-03'), introEndsAt: new Date('2026-12-03'), commissionBpsOverride: null };
  it('0% inside the venue’s first 30 days, the default after', () => {
    expect(commissionBpsFor(S, terms, 'booking', AT)).toBe(0);
    expect(commissionBpsFor(S, terms, 'booking', new Date('2026-12-04'))).toBe(1000);
    expect(commissionBpsFor({ ...S, introEnabled: false }, terms, 'booking', AT)).toBe(1000);
  });
  it('a venue’s own rate wins', () => {
    expect(commissionBpsFor(S, { ...terms, commissionBpsOverride: 500 }, 'booking', AT)).toBe(500);
  });
  it('the venue is paid on its price after its own discount; PL4Y’s discount costs it nothing', () => {
    expect(settlementFor({ basePaise: 100_000n, venueDiscountPaise: 20_000n }, 1000)).toEqual({
      venueGrossPaise: 80_000n,
      commissionBps: 1000,
      commissionPaise: 8_000n,
    });
    expect(settlementFor({ basePaise: 100_000n, venueDiscountPaise: 0n }, 0).commissionPaise).toBe(0n);
  });
});
