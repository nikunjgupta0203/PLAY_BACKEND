/**
 * bookings — the pure parts: local time, slot generation, the quote (R5) and
 * the cancellation share (R6). No database, no clock: the service passes both
 * in, so these are tested as plain functions.
 *
 * Venues are in India, which has one offset and no daylight saving
 * (notifications R3 does the same arithmetic). `venue_booking_policies.timezone`
 * is kept for the day a venue is not.
 */
import { isTest } from '../../../platform/config.js';

export const IST_OFFSET_MIN = 330;
const MIN = 60_000;
const DAY = 86_400_000;

export interface Rule {
  courtId: string;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Minutes after local midnight. */
  opensMin: number;
  closesMin: number;
  pricePerHourPaise: bigint;
}

export interface Busy {
  /** Null: the whole venue (a venue-wide blackout). */
  courtId: string | null;
  startsAt: Date;
  endsAt: Date;
}

export interface Slot {
  courtId: string;
  startsAt: Date;
  endsAt: Date;
  pricePaise: bigint;
  available: boolean;
}

export type PaymentOptions = 'online' | 'at_venue' | 'both';
export type PaymentChoice = 'online' | 'at_venue';

export interface Policy {
  bookable: boolean;
  advanceDays: number;
  minSlotMinutes: number;
  fullRefundHours: number;
  partialRefundHours: number;
  partialRefundBps: number;
  platformFeePaise: bigint;
  taxBps: number;
  /** 058 — start times every this many minutes after local midnight. */
  slotStepMinutes: number;
  /** 058 — the durations offered, e.g. [30, 40, 60, 90]. Empty: any multiple of the step from the minimum. */
  durationOptions: number[];
  /** 058 — how a player may pay: online now, at the venue, or either. */
  paymentOptions: PaymentOptions;
}

export const DEFAULT_POLICY: Policy = {
  bookable: false,
  advanceDays: 14,
  minSlotMinutes: 60,
  fullRefundHours: 24,
  partialRefundHours: 6,
  partialRefundBps: 5000,
  platformFeePaise: 0n,
  taxBps: 0,
  slotStepMinutes: 60,
  durationOptions: [60, 90, 120],
  paymentOptions: 'online',
};

export const SLOT_STEPS = [5, 10, 15, 20, 30, 60] as const;
export const MAX_DURATION_MINUTES = 360;

/** The durations a player can pick here, shortest first. */
export function allowedDurations(policy: Pick<Policy, 'minSlotMinutes' | 'slotStepMinutes' | 'durationOptions'>): number[] {
  if (policy.durationOptions.length > 0) {
    return [...new Set(policy.durationOptions)].filter((d) => d >= policy.minSlotMinutes && d <= MAX_DURATION_MINUTES).sort((a, b) => a - b);
  }
  const out: number[] = [];
  const step = Math.max(policy.slotStepMinutes, 5);
  for (let d = policy.minSlotMinutes; d <= 240; d += step) out.push(d);
  return out;
}

/** Which ways of paying the player may choose. */
export function paymentChoices(options: PaymentOptions): PaymentChoice[] {
  // 2026-11-04 founder: a table booking is always paid online (QR + slot held). Paying at the
  // venue is the walk-in `venuepay` flow, with no slot. The stored option is kept, not used, and
  // bookings already made to pay at the desk still settle there (Collect on the desk).
  if (onlineOnlyBookings()) return ['online'];
  return options === 'both' ? ['online', 'at_venue'] : [options];
}

/**
 * Tests keep the pay-at-desk paths (old bookings still settle that way), so online-only applies
 * outside tests, or when a test asks for it — as `sport/service/offered.ts` does.
 */
let onlineOnlyOverride: boolean | null = null;

export function setOnlineOnlyBookingsForTests(on: boolean | null): void {
  onlineOnlyOverride = on;
}

export function onlineOnlyBookings(): boolean {
  if (onlineOnlyOverride !== null) return onlineOnlyOverride;
  return !isTest;
}

/** "2026-10-12" → the UTC instant of local midnight that day. Null for a malformed date. */
export function localMidnight(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(utc - IST_OFFSET_MIN * MIN);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The local calendar date of an instant, "YYYY-MM-DD". */
export function localDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MIN * MIN).toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday, in local time. */
export function localWeekday(at: Date): number {
  const sundayFirst = new Date(at.getTime() + IST_OFFSET_MIN * MIN).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/** Minutes after local midnight. */
export function localMinutes(at: Date): number {
  const shifted = new Date(at.getTime() + IST_OFFSET_MIN * MIN);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

const overlaps = (a0: Date, a1: Date, b0: Date, b1: Date) => a0 < b1 && b0 < a1;

/**
 * The rule a booking falls inside, or null. A booking never straddles two
 * rules (two price bands, or a gap between them): that is two bookings.
 */
export function ruleFor(rules: Rule[], courtId: string, startsAt: Date, endsAt: Date): Rule | null {
  if (localDate(startsAt) !== localDate(new Date(endsAt.getTime() - 1))) return null;
  const weekday = localWeekday(startsAt);
  const from = localMinutes(startsAt);
  const to = from + Math.round((endsAt.getTime() - startsAt.getTime()) / MIN);
  return rules.find((r) => r.courtId === courtId && r.weekday === weekday && r.opensMin <= from && to <= r.closesMin) ?? null;
}

/** R5 — the court price for a span inside one rule. */
export function courtPrice(rule: Rule, minutes: number): bigint {
  return (rule.pricePerHourPaise * BigInt(minutes)) / 60n;
}

/**
 * 058 — the price of a span that may run across price bands (off-peak into
 * peak): each minute at the rate of the rule it falls in. Null when any part
 * of the span is outside the opening hours, or it crosses midnight. The
 * paise are summed before dividing, so splitting a span never loses a paisa.
 */
export function priceAcross(rules: Rule[], courtId: string, startsAt: Date, endsAt: Date): bigint | null {
  if (endsAt <= startsAt || localDate(startsAt) !== localDate(new Date(endsAt.getTime() - 1))) return null;
  const weekday = localWeekday(startsAt);
  const day = rules.filter((r) => r.courtId === courtId && r.weekday === weekday).sort((a, b) => a.opensMin - b.opensMin);
  let at = localMinutes(startsAt);
  const to = at + Math.round((endsAt.getTime() - startsAt.getTime()) / MIN);
  let numerator = 0n;
  while (at < to) {
    const rule = day.find((r) => r.opensMin <= at && at < r.closesMin);
    if (!rule) return null;
    const until = Math.min(rule.closesMin, to);
    numerator += rule.pricePerHourPaise * BigInt(until - at);
    at = until;
  }
  return numerator / 60n;
}

/** A court's opening on one weekday as continuous spans: back-to-back price bands join up. */
function openSpans(rules: Rule[]): { opensMin: number; closesMin: number }[] {
  const sorted = [...rules].sort((a, b) => a.opensMin - b.opensMin);
  const spans: { opensMin: number; closesMin: number }[] = [];
  for (const r of sorted) {
    const last = spans.at(-1);
    if (last && r.opensMin <= last.closesMin) last.closesMin = Math.max(last.closesMin, r.closesMin);
    else spans.push({ opensMin: r.opensMin, closesMin: r.closesMin });
  }
  return spans;
}

/**
 * R5 — the only place booking money is computed. Tax is on the court and
 * the platform fee together, like events R3.
 */
export function quote(courtPaise: bigint, policy: Pick<Policy, 'platformFeePaise' | 'taxBps'>) {
  const platformFeePaise = policy.platformFeePaise;
  const taxPaise = ((courtPaise + platformFeePaise) * BigInt(policy.taxBps)) / 10_000n;
  return { courtPaise, platformFeePaise, taxPaise, totalPaise: courtPaise + platformFeePaise + taxPaise };
}

/**
 * R4 — availability is derived: opening rules, minus blackouts, minus live
 * bookings, minus the past and anything beyond the booking window. Slots are
 * `durationMinutes` long and start every `minSlotMinutes`.
 */
export function slotsFor(input: {
  date: string;
  courtIds: string[];
  rules: Rule[];
  busy: Busy[];
  policy: Policy;
  durationMinutes: number;
  now: Date;
}): Slot[] {
  const midnight = localMidnight(input.date);
  if (!midnight) return [];
  const step = Math.max(input.policy.slotStepMinutes, 5);
  const duration = input.durationMinutes;
  const horizon = new Date(input.now.getTime() + input.policy.advanceDays * DAY);
  const weekday = localWeekday(new Date(midnight.getTime() + 12 * 60 * MIN));
  const out: Slot[] = [];
  for (const courtId of input.courtIds) {
    const own = input.rules.filter((r) => r.courtId === courtId && r.weekday === weekday);
    for (const span of openSpans(own)) {
      // Start times line up on the step from midnight, so a booking's start is always on the grid.
      for (let m = Math.ceil(span.opensMin / step) * step; m + duration <= span.closesMin; m += step) {
        const startsAt = new Date(midnight.getTime() + m * MIN);
        const endsAt = new Date(startsAt.getTime() + duration * MIN);
        const price = priceAcross(own, courtId, startsAt, endsAt);
        if (price === null) continue;
        const blocked = input.busy.some(
          (b) => (b.courtId === null || b.courtId === courtId) && overlaps(startsAt, endsAt, b.startsAt, b.endsAt),
        );
        out.push({
          courtId,
          startsAt,
          endsAt,
          pricePaise: price,
          available: input.policy.bookable && !blocked && startsAt > input.now && startsAt <= horizon,
        });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.courtId.localeCompare(b.courtId));
}

/**
 * R6 — how much of the court money comes back when the player cancels:
 * all of it far enough ahead, a share closer in, nothing after.
 */
export function cancellationShareBps(policy: Policy, startsAt: Date, at: Date): number {
  const hours = (startsAt.getTime() - at.getTime()) / 3_600_000;
  if (hours >= policy.fullRefundHours) return 10_000;
  if (hours >= policy.partialRefundHours) return policy.partialRefundBps;
  return 0;
}
