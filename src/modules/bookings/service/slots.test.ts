import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  cancellationShareBps,
  localDate,
  localMidnight,
  localWeekday,
  quote,
  ruleFor,
  slotsFor,
  type Policy,
  type Rule,
} from './slots.js';

const policy: Policy = { ...DEFAULT_POLICY, bookable: true };
// Monday 2026-10-12, 06:00–10:00 IST, ₹600/h.
const rules: Rule[] = [{ courtId: 'c1', weekday: 0, opensMin: 6 * 60, closesMin: 10 * 60, pricePerHourPaise: 60_000n }];
const at = (iso: string) => new Date(iso);

describe('bookings — local time', () => {
  it('midnight in India is 18:30 UTC the day before', () => {
    expect(localMidnight('2026-10-12')!.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(localMidnight('12-10-2026')).toBeNull();
  });
  it('weekday and date are local', () => {
    // 20:00 UTC Sunday is 01:30 Monday in India.
    expect(localWeekday(at('2026-10-11T20:00:00Z'))).toBe(0);
    expect(localDate(at('2026-10-11T20:00:00Z'))).toBe('2026-10-12');
  });
});

describe('bookings R4 — slots are derived', () => {
  const now = at('2026-10-10T00:00:00Z');
  it('rules make hourly slots priced from the rule', () => {
    const slots = slotsFor({ date: '2026-10-12', courtIds: ['c1'], rules, busy: [], policy, durationMinutes: 60, now });
    expect(slots).toHaveLength(4);
    expect(slots[0]!.startsAt.toISOString()).toBe('2026-10-12T00:30:00.000Z');
    expect(slots.every((s) => s.available && s.pricePaise === 60_000n)).toBe(true);
  });
  it('a blackout or a live booking makes overlapping slots unavailable — and only those', () => {
    const busy = [{ courtId: 'c1', startsAt: at('2026-10-12T01:30:00Z'), endsAt: at('2026-10-12T02:30:00Z') }];
    const slots = slotsFor({ date: '2026-10-12', courtIds: ['c1'], rules, busy, policy, durationMinutes: 60, now });
    expect(slots.map((s) => s.available)).toEqual([true, false, true, true]);
  });
  it('a venue-wide blackout covers every court', () => {
    const busy = [{ courtId: null, startsAt: at('2026-10-11T18:30:00Z'), endsAt: at('2026-10-12T18:30:00Z') }];
    const slots = slotsFor({ date: '2026-10-12', courtIds: ['c1'], rules, busy, policy, durationMinutes: 60, now });
    expect(slots.some((s) => s.available)).toBe(false);
  });
  it('R10 — beyond the booking window, in the past, or not bookable: unavailable', () => {
    const far = slotsFor({ date: '2026-10-12', courtIds: ['c1'], rules, busy: [], policy: { ...policy, advanceDays: 1 }, durationMinutes: 60, now });
    expect(far.some((s) => s.available)).toBe(false);
    const past = slotsFor({ date: '2026-10-12', courtIds: ['c1'], rules, busy: [], policy, durationMinutes: 60, now: at('2026-10-13T00:00:00Z') });
    expect(past.some((s) => s.available)).toBe(false);
    const closed = slotsFor({ date: '2026-10-12', courtIds: ['c1'], rules, busy: [], policy: DEFAULT_POLICY, durationMinutes: 60, now });
    expect(closed.some((s) => s.available)).toBe(false);
  });
});

describe('bookings R5 — the quote', () => {
  it('a booking inside one rule finds it; one that straddles does not', () => {
    expect(ruleFor(rules, 'c1', at('2026-10-12T00:30:00Z'), at('2026-10-12T02:30:00Z'))).not.toBeNull();
    expect(ruleFor(rules, 'c1', at('2026-10-12T04:00:00Z'), at('2026-10-12T05:00:00Z'))).toBeNull();
  });
  it('tax is on court and fee together', () => {
    expect(quote(60_000n, { platformFeePaise: 2_000n, taxBps: 1800 })).toEqual({
      courtPaise: 60_000n,
      platformFeePaise: 2_000n,
      taxPaise: 11_160n,
      totalPaise: 73_160n,
    });
  });
});

describe('bookings R6 — cancellation share', () => {
  const start = at('2026-10-12T12:00:00Z');
  it('full at 24 h, half at 6 h, nothing after', () => {
    expect(cancellationShareBps(policy, start, at('2026-10-11T11:00:00Z'))).toBe(10_000);
    expect(cancellationShareBps(policy, start, at('2026-10-12T05:00:00Z'))).toBe(5_000);
    expect(cancellationShareBps(policy, start, at('2026-10-12T09:00:00Z'))).toBe(0);
  });
});
