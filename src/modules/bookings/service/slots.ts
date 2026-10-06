/**
 * bookings — the pure parts: local time, slot generation, the quote (R5) and
 * the cancellation share (R6). No database, no clock: the service passes both
 * in, so these are tested as plain functions.
 *
 * Venues are in India, which has one offset and no daylight saving
 * (notifications R3 does the same arithmetic). `venue_booking_policies.timezone`
 * is kept for the day a venue is not.
 */

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

export interface Policy {
  bookable: boolean;
  advanceDays: number;
  minSlotMinutes: number;
  fullRefundHours: number;
  partialRefundHours: number;
  partialRefundBps: number;
  platformFeePaise: bigint;
  taxBps: number;
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
};

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
  const step = input.policy.minSlotMinutes;
  const duration = input.durationMinutes;
  const horizon = new Date(input.now.getTime() + input.policy.advanceDays * DAY);
  const weekday = localWeekday(new Date(midnight.getTime() + 12 * 60 * MIN));
  const out: Slot[] = [];
  for (const courtId of input.courtIds) {
    for (const rule of input.rules.filter((r) => r.courtId === courtId && r.weekday === weekday)) {
      for (let m = rule.opensMin; m + duration <= rule.closesMin; m += step) {
        const startsAt = new Date(midnight.getTime() + m * MIN);
        const endsAt = new Date(startsAt.getTime() + duration * MIN);
        const blocked = input.busy.some(
          (b) => (b.courtId === null || b.courtId === courtId) && overlaps(startsAt, endsAt, b.startsAt, b.endsAt),
        );
        out.push({
          courtId,
          startsAt,
          endsAt,
          pricePaise: courtPrice(rule, duration),
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
