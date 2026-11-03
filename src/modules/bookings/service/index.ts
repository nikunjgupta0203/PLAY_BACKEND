/**
 * bookings — court/table availability, bookings and the venue desk
 * (docs/modules/19-bookings.md; cue-sports launch: docs/plans/2026-11-03-cue-launch.md).
 *
 * The same shape as `registration`: hold, then pay, confirm only on a verified
 * capture (R2). The court is the inventory and Postgres's exclusion constraint
 * is what stops two groups getting one court (R1). Money is `payments`'s:
 * this module asks it for an order and for refunds, and is told when a
 * capture lands.
 *
 * 058 adds, without changing any of that:
 *   · PAY AT VENUE bookings — when the venue allows it, the player books now
 *     and pays at the desk (or later in the app). The booking is confirmed at
 *     once, so it passes the same exclusion constraint; it is `due` until the
 *     desk marks it paid or the player pays in the app.
 *   · OFFERS — the price comes from `pricing`: the venue's best offer and
 *     PL4Y's best offer, separately, both shown on the booking.
 *   · COMMISSION — frozen per booking from `pricing` (0% in a venue's first
 *     30 days). The venue earns the price after its own discount only.
 *   · booking codes, receipts, reminders, and a venue dashboard with revenue,
 *     customers and analytics.
 *
 * Who runs a venue: its creator, anyone with a `venue_staff` grant
 * (owner | manager | desk, R7), and PL4Y staff on a portal session. Grants
 * are read per request, like event grants.
 */
import type { Db } from '../../../platform/db.js';
import { SystemError, UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import { LIVE, isOverlap, isRaceAbort, type BookingRow, type BookingsRepo } from '../repo/index.js';
import { operatorBookingEmail, playerBookingEmail, type BookingFacts } from './emails.js';
import {
  MAX_DURATION_MINUTES,
  SLOT_STEPS,
  allowedDurations,
  cancellationShareBps,
  localDate,
  localMidnight,
  localMinutes,
  localWeekday,
  paymentChoices,
  priceAcross,
  quote,
  slotsFor,
  type PaymentChoice,
  type Policy,
  type Rule,
  type Slot,
} from './slots.js';

export const BookingCode = {
  SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  BOOKING_HOLD_EXPIRED: 'BOOKING_HOLD_EXPIRED',
  OUTSIDE_BOOKING_WINDOW: 'OUTSIDE_BOOKING_WINDOW',
  BOOKING_LIMIT_EXCEEDED: 'BOOKING_LIMIT_EXCEEDED',
  VENUE_NOT_BOOKABLE: 'VENUE_NOT_BOOKABLE',
  CANCELLATION_WINDOW_CLOSED: 'CANCELLATION_WINDOW_CLOSED',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  INVALID_SLOT: 'INVALID_SLOT',
  INVALID_RULES: 'INVALID_RULES',
  INVALID_POLICY: 'INVALID_POLICY',
  NOT_CANCELLABLE: 'NOT_CANCELLABLE',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  PAYMENT_OPTION_UNAVAILABLE: 'PAYMENT_OPTION_UNAVAILABLE',
  ALREADY_PAID: 'BOOKING_ALREADY_PAID',
  INVALID_TABLE: 'INVALID_TABLE',
} as const;

/** R2 — a hold lasts this long before payment. */
export const HOLD_MINUTES = 10;
/** R10 — per user, per venue, per local day. */
export const MAX_MINUTES_PER_DAY = 180;
/** R10 — open holds per user at once. */
export const MAX_OPEN_HOLDS = 2;
/** 058 — unpaid pay-at-venue bookings a player may hold ahead at once. */
export const MAX_UNPAID_AT_VENUE = 2;
/** 058 — this many no-shows in 60 days and a player books online only (R12 records the signal). */
export const AT_VENUE_NO_SHOW_LIMIT = 2;
/** 058 — the reminder goes out this long before the start. */
export const REMINDER_BEFORE_MS = 2 * 3_600_000;
/** Completed this long after the slot ends, so the desk can still mark a no-show that day. */
export const COMPLETE_AFTER_MS = 6 * 3_600_000;

export type VenueRole = 'owner' | 'manager' | 'desk';
const RANK: Record<VenueRole, number> = { desk: 1, manager: 2, owner: 3 };

export type BookingStatus = 'held' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'expired' | 'no_show' | 'payment_failed';
export type PaymentStatus = 'pending' | 'paid' | 'due' | 'failed' | 'void' | 'waived' | 'refunded' | 'partially_refunded';
export type DeskMethod = 'cash' | 'upi' | 'card' | 'other';

export interface Booking extends BookingRow {
  status: BookingStatus;
}

export interface Actor {
  userId: string;
  /** PL4Y staff on a portal session act as a venue's owner. */
  platformStaff?: boolean;
}

export interface VenuesPort {
  byId(venueId: string): Promise<{ id: string; name: string; createdBy: string }>;
  courtsFor(venueId: string): Promise<{ id: string; venueId: string | null; name: string; active: boolean; sportIds: string[]; kind?: string }[]>;
  courtById(courtId: string): Promise<{ id: string; venueId: string | null; name: string; active: boolean } | null>;
  /** 058 — tables, added and changed from the venue dashboard by managers (bookings checks the role). */
  addCourt?(venueId: string, input: { name: string; sportIds: string[]; kind: string }): Promise<{ id: string }>;
  updateCourt?(courtId: string, patch: { name?: string; sportIds?: string[]; active?: boolean }): Promise<{ id: string }>;
}

export interface PaymentsPort {
  refundForBooking(input: { bookingId: string; reason: string; courtShareBps: number; includePlatformFee: boolean }): Promise<{ amountPaise: bigint } | null>;
}

/** 058 — what `pricing` answers. Absent (most tests): no offers, no commission. */
export interface PricingPort {
  priceBooking(input: { userId: string | null; venueId: string; basePaise: bigint; startsAt: Date; endsAt: Date }): Promise<{
    basePaise: bigint;
    venueOffer: { id: string; title: string } | null;
    venueDiscountPaise: bigint;
    platformOffer: { id: string; title: string } | null;
    platformDiscountPaise: bigint;
    courtPaise: bigint;
  }>;
  reserve(input: { bookingId: string; userId: string; priced: unknown }): Promise<void>;
  redeem(bookingId: string): Promise<void>;
  release(bookingId: string): Promise<void>;
  releaseDead(): Promise<number>;
  commissionFor(venueId: string, kind: 'booking'): Promise<number>;
  ensureTerms(venueId: string): Promise<unknown>;
  rewardsWithPromos(): Promise<boolean>;
  offerTitles(ids: string[]): Promise<Map<string, string>>;
}

export interface BookingsDeps {
  db: Db;
  repo: BookingsRepo;
  venues: VenuesPort;
  payments: PaymentsPort;
  pricing?: PricingPort;
  users: {
    findByEmail(email: string): Promise<{ id: string } | null>;
    namesByIds(ids: string[]): Promise<Map<string, string>>;
    contactsByIds?(ids: string[]): Promise<{ id: string; displayName: string; email: string }[]>;
  };
  email?: { send(msg: { to: string; subject: string; text: string; html?: string }): Promise<unknown> };
  queue: { releaseHold(bookingId: string, delayMs: number): Promise<void> };
  notify?(userId: string, template: string, payload: Record<string, unknown>, bookingId: string): Promise<void>;
  /** 058 — to the venue's owner and managers; the target is the venue desk. */
  notifyVenue?(userId: string, template: string, payload: Record<string, unknown>, venueId: string): Promise<void>;
  /** 058 — the venue's pay-at-venue payments, for the transaction history. */
  venuePayments?(venueId: string, from: Date, to: Date): Promise<VenuePaymentLine[]>;
  now?: () => Date;
}

export interface VenuePaymentLine {
  id: string;
  userId: string;
  label: string;
  minutes: number;
  amountPaise: bigint;
  commissionPaise: bigint;
  status: string;
  paidAt: Date | null;
}

/** One line of a venue's transaction history: a booking's money, or a pay-at-venue payment. */
export interface Transaction {
  kind: 'booking' | 'venue_payment';
  id: string;
  reference: string;
  at: Date;
  playerName: string;
  description: string;
  /** The original price of the time. */
  grossPaise: bigint;
  venueDiscountPaise: bigint;
  platformDiscountPaise: bigint;
  /** What the player paid (or owes), before any PL4Y reward. */
  playerPaise: bigint;
  commissionPaise: bigint;
  /** What the venue keeps: its price after its own discount, less commission. */
  venueEarningsPaise: bigint;
  refundedPaise: bigint;
  paymentStatus: string;
  paymentMode: string;
  collectedBy: string | null;
  method: string | null;
}

const MIN = 60_000;
const DAY = 86_400_000;
const PLAYED: string[] = ['confirmed', 'checked_in', 'completed', 'no_show'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** "BK-7K3Q9XA2" — read aloud at the desk, so no 0/O or 1/I/L. */
export function makeBookingCode(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]!;
  return `BK-${s}`;
}

/** What the venue earned on a booking: its price after its own discount (online or app), or the walk-in's money. */
export function earnedPaise(b: Pick<BookingRow, 'userId' | 'paymentMode' | 'amountPaise' | 'venueGrossPaise' | 'courtPaise' | 'paymentStatus'>): bigint {
  if (b.paymentMode === 'comp') return 0n;
  if (b.userId === null) return b.paymentMode === 'offline' ? b.amountPaise : 0n;
  if (!['paid', 'partially_refunded'].includes(b.paymentStatus)) return 0n;
  // Bookings made before 058 have no settlement frozen on them.
  return b.venueGrossPaise > 0n ? b.venueGrossPaise : b.courtPaise;
}

export function createBookingsService(deps: BookingsDeps) {
  const { db, repo, venues } = deps;
  const now = deps.now ?? (() => new Date());

  // --- R7 — who runs a venue ---------------------------------------------------

  async function roleAt(actor: Actor, venueId: string): Promise<VenueRole | null> {
    if (actor.platformStaff) return 'owner';
    const venue = await venues.byId(venueId);
    if (venue.createdBy === actor.userId) return 'owner';
    const row = await db.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: actor.userId } } });
    return (row?.role as VenueRole | undefined) ?? null;
  }

  async function requireRole(actor: Actor, venueId: string, at: VenueRole): Promise<VenueRole> {
    const role = await roleAt(actor, venueId);
    if (!role || RANK[role] < RANK[at]) throw forbidden();
    return role;
  }

  /** The venues this person runs, for the desk entry in the Hosting tab. */
  async function myVenues(userId: string): Promise<{ venueId: string; role: VenueRole }[]> {
    const [granted, created] = await Promise.all([
      db.venueStaff.findMany({ where: { userId }, select: { venueId: true, role: true } }),
      db.venue.findMany({ where: { createdBy: userId, deletedAt: null }, select: { id: true } }),
    ]);
    const out = new Map<string, VenueRole>();
    for (const v of created) out.set(v.id, 'owner');
    for (const g of granted) if (!out.has(g.venueId)) out.set(g.venueId, g.role as VenueRole);
    return [...out].map(([venueId, role]) => ({ venueId, role }));
  }

  /**
   * hosting R1 — the Hosting tab also shows for someone who runs a venue: a
   * desk or manager grant, or a venue of their own. 058: any venue of their
   * own, so an owner can switch bookings on from the dashboard in the first place.
   */
  async function runsAVenue(userId: string): Promise<boolean> {
    if (await db.venueStaff.findFirst({ where: { userId }, select: { venueId: true } })) return true;
    return (await db.venue.count({ where: { createdBy: userId, deletedAt: null } })) > 0;
  }

  async function staffOf(actor: Actor, venueId: string) {
    await requireRole(actor, venueId, 'manager');
    const rows = await db.venueStaff.findMany({ where: { venueId }, orderBy: { createdAt: 'asc' } });
    const names = await deps.users.namesByIds(rows.map((r) => r.userId));
    return rows.map((r) => ({ userId: r.userId, role: r.role as VenueRole, name: names.get(r.userId) ?? 'Unknown', createdAt: r.createdAt }));
  }

  /** R7 — owners manage staff. By email; the person must already have an account. */
  async function setStaff(actor: Actor, venueId: string, email: string, role: VenueRole | null) {
    await requireRole(actor, venueId, 'owner');
    const user = await deps.users.findByEmail(email.trim());
    if (!user) throw new UserError(BookingCode.USER_NOT_FOUND, 'Nobody has a PL4Y account with that email. Ask them to sign up first.');
    if (role === null) {
      await db.venueStaff.deleteMany({ where: { venueId, userId: user.id } });
    } else {
      await db.venueStaff.upsert({
        where: { venueId_userId: { venueId, userId: user.id } },
        create: { venueId, userId: user.id, role, grantedBy: actor.userId },
        update: { role, grantedBy: actor.userId },
      });
    }
    return staffOf(actor, venueId);
  }

  // --- R4 — set-up: policy, rules, blackouts, tables -------------------------------------

  const policyFor = (venueId: string) => repo.policy(venueId);

  /** Why a policy is wrong, or null. 058 widens the shape: any step, any listed durations. */
  function policyProblem(p: Policy): string | null {
    if (p.advanceDays < 1 || p.advanceDays > 60) return 'Bookings can open 1 to 60 days ahead.';
    if (!(SLOT_STEPS as readonly number[]).includes(p.slotStepMinutes)) return 'Start times are every 5, 10, 15, 20, 30 or 60 minutes.';
    if (!Number.isInteger(p.minSlotMinutes) || p.minSlotMinutes < 10 || p.minSlotMinutes > MAX_DURATION_MINUTES || p.minSlotMinutes % 5 !== 0) {
      return 'The shortest booking is 10 minutes to 6 hours, in steps of 5 minutes.';
    }
    if (p.durationOptions.length > 10) return 'Offer up to 10 durations.';
    if (p.durationOptions.some((d) => !Number.isInteger(d) || d < p.minSlotMinutes || d > MAX_DURATION_MINUTES || d % 5 !== 0)) {
      return `Each duration is at least the shortest booking (${p.minSlotMinutes} minutes), at most 6 hours, in steps of 5 minutes.`;
    }
    if (allowedDurations(p).length === 0) return 'Offer at least one duration.';
    if (!['online', 'at_venue', 'both'].includes(p.paymentOptions)) return 'Choose online payments, pay at venue, or both.';
    if (p.partialRefundHours > p.fullRefundHours || p.partialRefundHours < 0) return 'Refund hours must be in order.';
    if (p.partialRefundBps < 0 || p.partialRefundBps > 10_000) return 'The partial refund is between 0% and 100%.';
    if (p.taxBps < 0 || p.taxBps > 10_000 || p.platformFeePaise < 0n) return 'Check the fee and tax.';
    return null;
  }

  async function setPolicy(actor: Actor, venueId: string, patch: Partial<Policy>): Promise<Policy> {
    await requireRole(actor, venueId, 'manager');
    const current = await repo.policy(venueId);
    const next: Policy = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)) };
    next.durationOptions = [...new Set(next.durationOptions)].sort((a, b) => a - b);
    const problem = policyProblem(next);
    if (problem) throw new UserError(BookingCode.INVALID_POLICY, problem);
    await repo.upsertPolicy(venueId, next);
    // 058 — a venue's introductory period starts when it first takes bookings.
    if (next.bookable && !current.bookable) await deps.pricing?.ensureTerms(venueId);
    return next;
  }

  async function courtOfVenue(courtId: string) {
    const court = await venues.courtById(courtId);
    if (!court?.venueId) throw new UserError(BookingCode.INVALID_SLOT, 'That court is not part of a venue.');
    return court as typeof court & { venueId: string };
  }

  /** R4 — a court's weekly opening rules, replaced as a whole. Several bands a day make peak and off-peak prices. */
  async function setRules(actor: Actor, courtId: string, rules: Omit<Rule, 'courtId'>[]): Promise<Rule[]> {
    const court = await courtOfVenue(courtId);
    await requireRole(actor, court.venueId, 'manager');
    for (const r of rules) {
      if (r.weekday < 0 || r.weekday > 6 || r.opensMin < 0 || r.closesMin > 24 * 60 || r.closesMin <= r.opensMin || r.pricePerHourPaise < 0n) {
        throw new UserError(BookingCode.INVALID_RULES, 'Each opening needs a day, an opening time before its closing time, and a price.');
      }
    }
    for (const day of new Set(rules.map((r) => r.weekday))) {
      const sorted = rules.filter((r) => r.weekday === day).sort((a, b) => a.opensMin - b.opensMin);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i]!.opensMin < sorted[i - 1]!.closesMin) {
          throw new UserError(BookingCode.INVALID_RULES, 'Two openings on the same day overlap.');
        }
      }
    }
    await repo.replaceRules(courtId, rules, newId);
    return repo.rulesFor([courtId]);
  }

  async function rulesForVenue(venueId: string): Promise<Rule[]> {
    const courts = await venues.courtsFor(venueId);
    return repo.rulesFor(courts.map((c) => c.id));
  }

  /**
   * 058 — a venue's tables, from the dashboard: add one, rename it, change
   * its sport, or take it out of service. Managers and owners. A table is
   * never deleted: a booking on it must keep saying where it was.
   */
  async function saveTable(
    actor: Actor,
    venueId: string,
    input: { id?: string | null; name?: string | null; sportIds?: string[] | null; active?: boolean | null },
  ): Promise<{ id: string }> {
    await requireRole(actor, venueId, 'manager');
    if (!venues.addCourt || !venues.updateCourt) throw new SystemError('INTERNAL', 'Tables cannot be edited here.');
    const name = input.name?.trim().replace(/\s+/g, ' ');
    if (name !== undefined && (name.length < 1 || name.length > 40)) throw new UserError(BookingCode.INVALID_TABLE, 'A table name is 1 to 40 characters.');
    const existing = await venues.courtsFor(venueId);
    if (name && existing.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== input.id)) {
      throw new UserError(BookingCode.INVALID_TABLE, `This venue already has a table called ${name}.`);
    }
    if (input.id) {
      const court = existing.find((c) => c.id === input.id);
      if (!court) throw new UserError(BookingCode.INVALID_TABLE, 'That table is not at this venue.');
      if (input.active === false) {
        const upcoming = await db.courtBooking.count({ where: { courtId: court.id, status: { in: [...LIVE] }, endsAt: { gt: now() } } });
        if (upcoming > 0) {
          throw new UserError(BookingCode.INVALID_TABLE, `This table has ${upcoming} upcoming booking(s). Cancel or move them first, or block the table for a time instead.`);
        }
      }
      return venues.updateCourt(court.id, {
        ...(name ? { name } : {}),
        ...(input.sportIds ? { sportIds: input.sportIds } : {}),
        ...(input.active !== null && input.active !== undefined ? { active: input.active } : {}),
      });
    }
    if (!name) throw new UserError(BookingCode.INVALID_TABLE, 'Name the table, e.g. “Snooker 1”.');
    if (existing.filter((c) => c.active).length >= 60) throw new UserError(BookingCode.INVALID_TABLE, 'A venue can have up to 60 tables.');
    return venues.addCourt(venueId, { name, sportIds: input.sportIds ?? [], kind: 'table' });
  }

  async function addBlackout(
    actor: Actor,
    input: { venueId: string; courtId?: string | null; kind: 'maintenance' | 'event' | 'private' | 'holiday'; startsAt: Date; endsAt: Date; note?: string | null; eventId?: string | null },
  ) {
    await requireRole(actor, input.venueId, 'manager');
    if (input.endsAt <= input.startsAt) throw new UserError(BookingCode.INVALID_SLOT, 'The end must be after the start.');
    if (input.courtId) {
      const court = await courtOfVenue(input.courtId);
      if (court.venueId !== input.venueId) throw new UserError(BookingCode.INVALID_SLOT, 'That court is not at this venue.');
    }
    return db.courtBlackout.create({
      data: {
        id: newId(),
        venueId: input.venueId,
        courtId: input.courtId ?? null,
        kind: input.kind,
        eventId: input.eventId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        note: input.note?.trim() || null,
        createdBy: actor.userId,
      },
    });
  }

  async function removeBlackout(actor: Actor, blackoutId: string): Promise<void> {
    const row = await db.courtBlackout.findUnique({ where: { id: blackoutId } });
    if (!row) return;
    await requireRole(actor, row.venueId, 'manager');
    await db.courtBlackout.delete({ where: { id: blackoutId } });
  }

  // --- R4 — availability ---------------------------------------------------------

  function checkDuration(policy: Policy, minutes: number): void {
    if (!allowedDurations(policy).includes(minutes)) {
      throw new UserError(BookingCode.INVALID_SLOT, `This venue takes bookings of ${allowedDurations(policy).join(', ')} minutes.`);
    }
  }

  async function availability(venueId: string, date: string, opts: { durationMinutes?: number; sportId?: string | null } = {}): Promise<Slot[]> {
    const midnight = localMidnight(date);
    if (!midnight) throw new UserError(BookingCode.INVALID_SLOT, 'That is not a date.');
    const policy = await repo.policy(venueId);
    const duration = opts.durationMinutes ?? allowedDurations(policy)[0] ?? policy.minSlotMinutes;
    checkDuration(policy, duration);
    const courts = (await venues.courtsFor(venueId)).filter(
      (c) => c.active && (!opts.sportId || c.sportIds.length === 0 || c.sportIds.includes(opts.sportId)),
    );
    const at = now();
    const [rules, busy] = await Promise.all([
      repo.rulesFor(courts.map((c) => c.id)),
      repo.busy(venueId, midnight, new Date(midnight.getTime() + DAY), at),
    ]);
    return slotsFor({ date, courtIds: courts.map((c) => c.id), rules, busy, policy, durationMinutes: duration, now: at });
  }

  /** The first date from `from` with anything available, within the window: the "next available" offer. */
  async function nextAvailableDate(venueId: string, from: string, durationMinutes?: number): Promise<string | null> {
    const policy = await repo.policy(venueId);
    if (!policy.bookable) return null;
    const start = localMidnight(from);
    if (!start) return null;
    for (let d = 0; d < policy.advanceDays + 1; d++) {
      const date = localDate(new Date(start.getTime() + d * DAY + 12 * 3_600_000));
      if ((await availability(venueId, date, { durationMinutes })).some((s) => s.available)) return date;
    }
    return null;
  }

  /** 058 — what the booking screen needs before the grid: durations, the interval, how a player can pay. */
  async function bookingOptions(venueId: string) {
    const policy = await repo.policy(venueId);
    return {
      bookable: policy.bookable,
      durations: allowedDurations(policy),
      slotStepMinutes: policy.slotStepMinutes,
      paymentChoices: paymentChoices(policy.paymentOptions),
      advanceDays: policy.advanceDays,
      fullRefundHours: policy.fullRefundHours,
      partialRefundHours: policy.partialRefundHours,
      partialRefundBps: policy.partialRefundBps,
    };
  }

  // --- R5 — the quote ------------------------------------------------------------------

  /**
   * R5 — the only place booking money is computed. 058: the base price runs
   * across price bands (peak and off-peak), then `pricing` takes off the
   * venue's offer and PL4Y's offer, then the fee and tax go on.
   */
  async function quoteFor(courtId: string, startsAt: Date, endsAt: Date, userId: string | null = null) {
    const court = await courtOfVenue(courtId);
    const [policy, rules] = await Promise.all([repo.policy(court.venueId), repo.rulesFor([courtId])]);
    const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / MIN);
    const basePaise = minutes > 0 ? priceAcross(rules, courtId, startsAt, endsAt) : null;
    if (basePaise === null) throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'That court is not open then.');
    const priced = deps.pricing
      ? await deps.pricing.priceBooking({ userId, venueId: court.venueId, basePaise, startsAt, endsAt })
      : { basePaise, venueOffer: null, venueDiscountPaise: 0n, platformOffer: null, platformDiscountPaise: 0n, courtPaise: basePaise };
    return { court, policy, minutes, priced, ...quote(priced.courtPaise, policy) };
  }

  /** 058 — the price breakdown before booking, for the player who will book (offers depend on who). */
  async function quoteForPlayer(actor: Actor | null, input: { courtId: string; startsAt: Date; endsAt: Date }) {
    const q = await quoteFor(input.courtId, input.startsAt, input.endsAt, actor?.userId ?? null);
    return {
      courtId: input.courtId,
      venueId: q.court.venueId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      minutes: q.minutes,
      basePaise: q.priced.basePaise,
      venueDiscountPaise: q.priced.venueDiscountPaise,
      venueOfferId: q.priced.venueOffer?.id ?? null,
      venueOfferTitle: q.priced.venueOffer?.title ?? null,
      platformDiscountPaise: q.priced.platformDiscountPaise,
      platformOfferId: q.priced.platformOffer?.id ?? null,
      platformOfferTitle: q.priced.platformOffer?.title ?? null,
      courtPaise: q.courtPaise,
      platformFeePaise: q.platformFeePaise,
      taxPaise: q.taxPaise,
      totalPaise: q.totalPaise,
      paymentChoices: paymentChoices(q.policy.paymentOptions),
    };
  }

  // --- R1, R2, R3, R10 — booking a court ----------------------------------------------

  async function checkSlotShape(policy: Policy, startsAt: Date, endsAt: Date, at: Date): Promise<void> {
    const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / MIN);
    checkDuration(policy, minutes);
    if (localMinutes(startsAt) % policy.slotStepMinutes !== 0) {
      throw new UserError(BookingCode.INVALID_SLOT, `Bookings start every ${policy.slotStepMinutes} minutes.`);
    }
    if (startsAt <= at) throw new UserError(BookingCode.OUTSIDE_BOOKING_WINDOW, 'That time has passed.');
    if (startsAt.getTime() > at.getTime() + policy.advanceDays * DAY) {
      throw new UserError(BookingCode.OUTSIDE_BOOKING_WINDOW, `This venue takes bookings up to ${policy.advanceDays} days ahead.`);
    }
  }

  /** A fresh, unused booking code. Collisions are one in a trillion; the unique index is the backstop. */
  async function freshCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = makeBookingCode();
      if (!(await db.courtBooking.findUnique({ where: { bookingCode: code }, select: { id: true } }))) return code;
    }
    return makeBookingCode();
  }

  /**
   * R1, R2 — the player books. Online: the court is held for 10 minutes while
   * they pay. 058 pay at venue: confirmed now, `due` until it is paid.
   */
  async function hold(actor: Actor, input: { courtId: string; startsAt: Date; endsAt: Date; payment?: PaymentChoice | null }): Promise<Booking> {
    const at = now();
    const q = await quoteFor(input.courtId, input.startsAt, input.endsAt, actor.userId);
    const venueId = q.court.venueId;
    if (!q.policy.bookable) throw new UserError(BookingCode.VENUE_NOT_BOOKABLE, 'This venue does not take bookings.');
    await checkSlotShape(q.policy, input.startsAt, input.endsAt, at);

    const choices = paymentChoices(q.policy.paymentOptions);
    const payment: PaymentChoice = input.payment ?? choices[0]!;
    if (!choices.includes(payment)) {
      throw new UserError(
        BookingCode.PAYMENT_OPTION_UNAVAILABLE,
        payment === 'at_venue' ? 'This venue takes online payments only.' : 'This venue takes payment at the venue only.',
      );
    }

    // R10 — anti-hoarding.
    const dayStart = localMidnight(localDate(input.startsAt))!;
    const usage = await repo.usage(actor.userId, venueId, dayStart, new Date(dayStart.getTime() + DAY), at);
    if (payment === 'online' && usage.holds >= MAX_OPEN_HOLDS) {
      throw new UserError(BookingCode.BOOKING_LIMIT_EXCEEDED, 'You have two bookings waiting for payment. Pay for or cancel one first.');
    }
    if (usage.minutes + q.minutes > MAX_MINUTES_PER_DAY) {
      throw new UserError(BookingCode.BOOKING_LIMIT_EXCEEDED, 'You can book up to 3 hours a day at one venue.');
    }
    if (payment === 'at_venue') {
      if ((await repo.unpaidAtVenue(actor.userId, at)) >= MAX_UNPAID_AT_VENUE) {
        throw new UserError(BookingCode.BOOKING_LIMIT_EXCEEDED, 'You have two bookings to pay at the venue already. Pay for one, or pay online.');
      }
      if ((await repo.noShowsSince(actor.userId, new Date(at.getTime() - 60 * DAY))) >= AT_VENUE_NO_SHOW_LIMIT) {
        throw new UserError(BookingCode.PAYMENT_OPTION_UNAVAILABLE, 'After missed bookings, pay online to book. Thanks for understanding.');
      }
    }
    // R4 — a blackout (an event's courts among them) is never bookable.
    if (await repo.blackoutsAt(venueId, input.courtId, input.startsAt, input.endsAt)) {
      throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'Someone just took that slot. Pick another.');
    }

    const commissionBps = deps.pricing ? await deps.pricing.commissionFor(venueId, 'booking') : 0;
    const venueGrossPaise = q.priced.basePaise - q.priced.venueDiscountPaise;
    const commissionPaise = (venueGrossPaise * BigInt(commissionBps) + 5_000n) / 10_000n;

    // A free court needs no payment: it is booked at once.
    const free = q.totalPaise === 0n;
    const atVenue = !free && payment === 'at_venue';
    let row: BookingRow;
    try {
      row = await repo.insertLive(
        {
          id: newId(),
          venueId,
          courtId: input.courtId,
          userId: actor.userId,
          walkInName: null,
          walkInPhone: null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status: free || atVenue ? 'confirmed' : 'held',
          paymentMode: free ? 'comp' : payment,
          holdExpiresAt: free || atVenue ? null : new Date(at.getTime() + HOLD_MINUTES * MIN),
          courtPaise: q.courtPaise,
          platformFeePaise: q.platformFeePaise,
          taxPaise: q.taxPaise,
          amountPaise: q.totalPaise,
          createdBy: actor.userId,
          bookingCode: await freshCode(),
          basePaise: q.priced.basePaise,
          venueOfferId: q.priced.venueOffer?.id ?? null,
          venueDiscountPaise: q.priced.venueDiscountPaise,
          platformOfferId: q.priced.platformOffer?.id ?? null,
          platformDiscountPaise: q.priced.platformDiscountPaise,
          paymentStatus: free ? 'waived' : atVenue ? 'due' : 'pending',
          paymentMethod: null,
          collectedBy: null,
          venueGrossPaise: free ? 0n : venueGrossPaise,
          commissionBps,
          commissionPaise: free ? 0n : commissionPaise,
        },
        at,
      );
    } catch (err) {
      // R1 — the exclusion constraint decided: somebody else has the court.
      if (isOverlap(err) || isRaceAbort(err)) {
        throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'Someone just took that slot. Pick another.');
      }
      throw err;
    }

    // 058 — the offers' uses are reserved; the last use of an offer goes to one player only.
    if (deps.pricing && (q.priced.venueOffer || q.priced.platformOffer)) {
      try {
        await deps.pricing.reserve({ bookingId: row.id, userId: actor.userId, priced: q.priced });
      } catch (err) {
        await repo.transition(row.id, ['held', 'confirmed'], { status: row.status === 'held' ? 'expired' : 'cancelled', holdExpiresAt: null, paymentStatus: 'void', cancelReason: 'offer_unavailable' });
        throw err;
      }
    }

    if (free || atVenue) {
      await announceConfirmed(row);
    } else {
      await deps.queue.releaseHold(row.id, HOLD_MINUTES * MIN + 5_000).catch(() => undefined);
    }
    return row as Booking;
  }

  // --- payments' port (R2) --------------------------------------------------------------

  async function byId(bookingId: string): Promise<Booking | null> {
    return (await repo.byId(bookingId)) as Booking | null;
  }

  async function forPayments(bookingId: string) {
    const row = await repo.byId(bookingId);
    if (!row) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    const venue = await venues.byId(row.venueId);
    // 058 — whether PL4Y's rewards stack on a PL4Y offer is a setting.
    const rewardsAllowed = row.platformDiscountPaise === 0n || !deps.pricing || (await deps.pricing.rewardsWithPromos());
    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      paymentMode: row.paymentMode,
      paymentStatus: row.paymentStatus,
      amountPaise: row.amountPaise,
      courtPaise: row.courtPaise,
      platformFeePaise: row.platformFeePaise,
      taxPaise: row.taxPaise,
      holdExpiresAt: row.holdExpiresAt,
      venueName: venue.name,
      bookingCode: row.bookingCode,
      rewardsAllowed,
    };
  }

  /** Keeps the court held while the player pays. Never revives a hold that already lapsed. */
  async function extendHold(bookingId: string, minutes: number): Promise<void> {
    const at = now();
    await db.courtBooking.updateMany({
      where: { id: bookingId, status: 'held', holdExpiresAt: { gt: at, lt: new Date(at.getTime() + minutes * MIN) } },
      data: { holdExpiresAt: new Date(at.getTime() + minutes * MIN), updatedAt: at },
    });
  }

  async function methodOf(paymentId: string): Promise<string | null> {
    return (await db.payment.findUnique({ where: { id: paymentId }, select: { method: true } }))?.method ?? null;
  }

  /**
   * R2 — only `payments` calls this, on a verified capture. A held booking
   * confirms. One whose hold lapsed confirms too if the court is still free —
   * the exclusion constraint decides — and otherwise this throws
   * ILLEGAL_TRANSITION so payments refunds the capture in full.
   *
   * 058 — a pay-at-venue booking paid in the app becomes paid. If the desk
   * already took the money, this throws ILLEGAL_TRANSITION and payments
   * refunds the duplicate in full.
   */
  async function confirmFromPayment(input: { bookingId: string; paymentId: string }): Promise<{ confirmedNow: boolean }> {
    const row = await repo.byId(input.bookingId);
    if (!row) throw new SystemError('ILLEGAL_TRANSITION', 'No such booking');
    const at = now();
    const method = await methodOf(input.paymentId);

    if (row.paymentMode === 'at_venue' && PLAYED.includes(row.status)) {
      if (row.paymentStatus === 'paid') {
        if (row.collectedBy === 'pl4y') return { confirmedNow: false };
        throw new SystemError('ILLEGAL_TRANSITION', `booking ${row.id} was already paid at the venue`);
      }
      const moved = await repo.transition(row.id, [row.status], { paymentStatus: 'paid', collectedBy: 'pl4y', paidAt: at, paymentMethod: method });
      if (!moved || moved.paymentStatus !== 'paid') return { confirmedNow: false };
      await deps.pricing?.redeem(row.id);
      await announcePaid(moved);
      return { confirmedNow: true };
    }

    if (PLAYED.includes(row.status)) return { confirmedNow: false };
    if (row.status === 'cancelled') throw new SystemError('ILLEGAL_TRANSITION', `booking ${row.id} is ${row.status}`);
    let moved: BookingRow | null;
    try {
      moved = await repo.transition(row.id, ['held', 'expired', 'payment_failed'], {
        status: 'confirmed',
        holdExpiresAt: null,
        paymentStatus: 'paid',
        collectedBy: 'pl4y',
        paidAt: at,
        paymentMethod: method,
      });
    } catch (err) {
      if (isOverlap(err)) throw new SystemError('ILLEGAL_TRANSITION', `court for booking ${row.id} was taken after its hold lapsed`);
      throw err;
    }
    if (!moved) return { confirmedNow: false };
    await deps.pricing?.redeem(row.id);
    await announceConfirmed(moved);
    return { confirmedNow: true };
  }

  /**
   * A failed attempt changes nothing about the court: the hold lives on, so a
   * retry keeps it (as registration R8). 058 — the booking says the last
   * attempt failed, and the player is told while there is time to retry.
   */
  async function failFromPayment(input: { bookingId: string; paymentId: string; reason: string }): Promise<void> {
    const row = await repo.byId(input.bookingId);
    if (!row) return;
    if (row.status === 'held') {
      const moved = await repo.transition(row.id, ['held'], { paymentStatus: 'failed' });
      if (moved && row.paymentStatus !== 'failed' && row.userId && deps.notify) {
        const [venue, court] = await Promise.all([venues.byId(row.venueId), venues.courtById(row.courtId)]);
        await deps
          .notify(row.userId, 'booking.payment_failed', { venueName: venue.name, courtName: court?.name ?? 'Table', startsAt: row.startsAt.toISOString() }, row.id)
          .catch(() => undefined);
      }
    }
    // A pay-at-venue booking whose in-app payment failed is still due: nothing to change.
  }

  async function operatorsOf(venueId: string): Promise<string[]> {
    const venue = await venues.byId(venueId);
    const staff = await db.venueStaff.findMany({ where: { venueId, role: { in: ['owner', 'manager'] } }, select: { userId: true } });
    return [...new Set([venue.createdBy, ...staff.map((s) => s.userId)])];
  }

  /** The facts every booking message is written from. */
  async function factsOf(row: BookingRow): Promise<BookingFacts> {
    const [venue, court, names, titles, order] = await Promise.all([
      venues.byId(row.venueId),
      venues.courtById(row.courtId),
      row.userId ? deps.users.namesByIds([row.userId]) : Promise.resolve(new Map<string, string>()),
      deps.pricing ? deps.pricing.offerTitles([row.venueOfferId, row.platformOfferId].filter((x): x is string => !!x)) : Promise.resolve(new Map<string, string>()),
      db.paymentOrder.findFirst({
        where: { bookingId: row.id, status: 'paid' },
        select: { discountPaise: true, payments: { where: { status: { not: 'failed' } }, select: { gatewayPaymentId: true }, take: 1 } },
      }),
    ]);
    return {
      bookingCode: row.bookingCode,
      venueName: venue.name,
      courtName: court?.name ?? 'Table',
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      playerName: (row.userId ? names.get(row.userId) : row.walkInName) ?? 'A player',
      basePaise: row.basePaise,
      venueDiscountPaise: row.venueDiscountPaise,
      venueOfferTitle: row.venueOfferId ? (titles.get(row.venueOfferId) ?? null) : null,
      platformDiscountPaise: row.platformDiscountPaise,
      platformOfferTitle: row.platformOfferId ? (titles.get(row.platformOfferId) ?? null) : null,
      rewardDiscountPaise: order?.discountPaise ?? 0n,
      platformFeePaise: row.platformFeePaise,
      taxPaise: row.taxPaise,
      amountPaise: row.amountPaise,
      paymentMode: row.paymentMode as BookingFacts['paymentMode'],
      paymentStatus: row.paymentStatus,
      collectedBy: row.collectedBy as BookingFacts['collectedBy'],
      reference: order?.payments[0]?.gatewayPaymentId ?? null,
      paidAt: row.paidAt,
    };
  }

  async function sendEmails(row: BookingRow, toOperators: boolean): Promise<void> {
    if (!deps.email || !deps.users.contactsByIds) return;
    const facts = await factsOf(row);
    const operators = toOperators ? await operatorsOf(row.venueId) : [];
    const contacts = await deps.users.contactsByIds([...(row.userId ? [row.userId] : []), ...operators]);
    const sends: Promise<unknown>[] = [];
    const player = row.userId ? contacts.find((c) => c.id === row.userId) : undefined;
    if (player?.email) sends.push(deps.email.send({ to: player.email, ...playerBookingEmail(player.email, facts) }));
    for (const id of operators) {
      const c = contacts.find((x) => x.id === id);
      if (c?.email) sends.push(deps.email.send({ to: c.email, ...operatorBookingEmail(c.email, facts, row.commissionBps) }));
    }
    for (const r of await Promise.allSettled(sends)) if (r.status === 'rejected') logger.warn({ err: r.reason, bookingId: row.id }, 'booking email failed');
  }

  /** A booking went ahead: the player, the venue, the feed and the inbox hear once. */
  async function announceConfirmed(row: BookingRow): Promise<void> {
    await outboxWrite(db, { topic: 'booking.confirmed', payload: { bookingId: row.id, venueId: row.venueId } });
    try {
      const [venue, court] = await Promise.all([venues.byId(row.venueId), venues.courtById(row.courtId)]);
      const courtName = court?.name ?? 'Table';
      const due = row.paymentStatus === 'due' ? row.amountPaise.toString() : null;
      if (row.userId && deps.notify) {
        await deps
          .notify(row.userId, 'booking.confirmed', { venueName: venue.name, courtName, startsAt: row.startsAt.toISOString(), bookingCode: row.bookingCode, dueAtVenuePaise: due }, row.id)
          .catch(() => undefined);
      }
      if (row.userId && deps.notifyVenue) {
        const name = (await deps.users.namesByIds([row.userId])).get(row.userId) ?? 'A player';
        for (const op of await operatorsOf(row.venueId)) {
          await deps
            .notifyVenue(
              op,
              'venue.booking_received',
              { venueName: venue.name, playerName: name, courtName, startsAt: row.startsAt.toISOString(), amountPaise: row.amountPaise.toString(), payment: row.paymentMode === 'at_venue' && row.paymentStatus !== 'paid' ? 'at_venue' : 'online' },
              row.venueId,
            )
            .catch(() => undefined);
        }
      }
      if (row.userId) await sendEmails(row, true);
    } catch (err) {
      logger.error({ err, bookingId: row.id }, 'booking confirmation messages failed');
    }
  }

  /** 058 — a pay-at-venue booking was paid (in the app or at the desk): the player's receipt. */
  async function announcePaid(row: BookingRow): Promise<void> {
    try {
      const venue = await venues.byId(row.venueId);
      if (row.userId && deps.notify) {
        await deps
          .notify(row.userId, 'booking.paid', { venueName: venue.name, bookingCode: row.bookingCode, amountPaise: row.amountPaise.toString(), collectedBy: row.collectedBy ?? 'pl4y' }, row.id)
          .catch(() => undefined);
      }
      if (row.userId) await sendEmails(row, false);
    } catch (err) {
      logger.error({ err, bookingId: row.id }, 'booking receipt failed');
    }
  }

  // --- R2, R3 — holds lapse; reminders ----------------------------------------------------------

  /** The `release-booking-hold` job. A hold extended while paying is left alone until it lapses. */
  async function expireHold(bookingId: string): Promise<void> {
    const at = now();
    const { count } = await db.courtBooking.updateMany({
      where: { id: bookingId, status: 'held', holdExpiresAt: { lte: at } },
      data: { status: 'expired', holdExpiresAt: null, paymentStatus: 'void', updatedAt: at },
    });
    if (count > 0) await deps.pricing?.release(bookingId);
  }

  /** 058 — two hours before: the player hears once, with what is still to pay at the desk. */
  async function sendReminders(at: Date): Promise<number> {
    if (!deps.notify) return 0;
    let sent = 0;
    for (const row of await repo.dueReminders(at, new Date(at.getTime() + REMINDER_BEFORE_MS))) {
      if (!(await repo.claimReminder(row.id, at))) continue;
      const [venue, court] = await Promise.all([venues.byId(row.venueId), venues.courtById(row.courtId)]);
      await deps
        .notify(
          row.userId!,
          'booking.reminder',
          {
            venueName: venue.name,
            courtName: court?.name ?? 'Table',
            startsAt: row.startsAt.toISOString(),
            bookingCode: row.bookingCode,
            dueAtVenuePaise: row.paymentStatus === 'due' ? row.amountPaise.toString() : null,
          },
          row.id,
        )
        .catch(() => undefined);
      sent += 1;
    }
    return sent;
  }

  async function sweep(): Promise<{ expired: number; completed: number; reminded: number; released: number }> {
    const at = now();
    const expired = await repo.expireStale(at);
    if (expired.length > 0) {
      await db.courtBooking.updateMany({ where: { id: { in: expired }, paymentStatus: { in: ['pending', 'failed'] } }, data: { paymentStatus: 'void' } });
    }
    const completed = await repo.completeFinished(new Date(at.getTime() - COMPLETE_AFTER_MS));
    const reminded = await sendReminders(at);
    const released = (await deps.pricing?.releaseDead()) ?? 0;
    return { expired: expired.length, completed: completed.length, reminded, released };
  }

  // --- R6 — cancelling ----------------------------------------------------------------------

  /** What PL4Y holds for this booking and could refund: paid through PL4Y. */
  const paidThroughPl4y = (row: BookingRow) => row.paymentStatus === 'paid' && row.collectedBy === 'pl4y' && row.amountPaise > 0n;

  /** R6, app R10 — what cancelling now would give back, before the player confirms. */
  async function cancelPreview(actor: Actor, bookingId: string): Promise<{ refundPaise: bigint; shareBps: number }> {
    const row = await repo.byId(bookingId);
    if (!row || row.userId !== actor.userId) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    if (row.status === 'held' || !paidThroughPl4y(row)) return { refundPaise: 0n, shareBps: row.status === 'held' ? 0 : 10_000 };
    const policy = await repo.policy(row.venueId);
    const shareBps = cancellationShareBps(policy, row.startsAt, now());
    const { bookingRefundAmount } = await import('../../payments/service/index.js');
    const captured = await db.payment.findFirst({
      where: { paymentOrder: { bookingId: row.id }, status: { in: ['captured', 'partially_refunded'] } },
      select: { amountPaise: true },
    });
    const refundPaise = bookingRefundAmount({
      courtPaise: row.courtPaise,
      platformFeePaise: row.platformFeePaise,
      taxPaise: row.taxPaise,
      capturedPaise: captured?.amountPaise ?? row.amountPaise,
      courtShareBps: shareBps,
      includePlatformFee: false,
    });
    return { refundPaise, shareBps };
  }

  /**
   * After a cancellation the venue keeps its share of what was retained: the
   * part of its price the player did not get back. Commission follows it.
   */
  function settlementAfterRefund(row: BookingRow, keptBps: number) {
    const venueGrossPaise = (row.venueGrossPaise * BigInt(keptBps)) / 10_000n;
    return { venueGrossPaise, commissionPaise: (venueGrossPaise * BigInt(row.commissionBps) + 5_000n) / 10_000n };
  }

  /**
   * R6 — the player cancels. A held booking just lets go of the court. A paid
   * one gets back its share by the venue's policy; the platform fee stays.
   * 058 — an unpaid pay-at-venue booking is simply released; one the desk
   * already took money for is the venue's to refund, so the player asks them.
   */
  async function cancel(actor: Actor, bookingId: string): Promise<{ booking: Booking; refundPaise: bigint }> {
    const row = await repo.byId(bookingId);
    if (!row || row.userId !== actor.userId) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    if (row.status === 'held') {
      const moved = await repo.transition(row.id, ['held'], { status: 'expired', holdExpiresAt: null, paymentStatus: 'void' });
      await deps.pricing?.release(row.id);
      return { booking: (moved ?? row) as Booking, refundPaise: 0n };
    }
    if (row.status !== 'confirmed') {
      throw new UserError(BookingCode.NOT_CANCELLABLE, 'This booking can no longer be cancelled.');
    }
    if (row.startsAt <= now()) throw new UserError(BookingCode.CANCELLATION_WINDOW_CLOSED, 'This booking has already started.');
    if (row.paymentStatus === 'paid' && row.collectedBy === 'venue') {
      throw new UserError(BookingCode.NOT_CANCELLABLE, 'You paid the venue at the desk, so the venue handles this cancellation. Please contact them.');
    }

    const viaPl4y = paidThroughPl4y(row);
    const { refundPaise, shareBps } = viaPl4y ? await cancelPreview(actor, bookingId) : { refundPaise: 0n, shareBps: 10_000 };
    const settled = viaPl4y ? settlementAfterRefund(row, 10_000 - shareBps) : { venueGrossPaise: 0n, commissionPaise: 0n };
    const moved = await repo.transition(row.id, ['confirmed'], {
      status: 'cancelled',
      cancelledBy: actor.userId,
      cancelReason: 'player',
      cancelledAt: now(),
      paymentStatus: viaPl4y ? (shareBps === 0 ? 'paid' : shareBps === 10_000 ? 'refunded' : 'partially_refunded') : 'void',
      ...settled,
    });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'This booking can no longer be cancelled.');
    let refunded = 0n;
    if (shareBps > 0 && viaPl4y) {
      const r = await deps.payments.refundForBooking({ bookingId: row.id, reason: 'booking_cancelled', courtShareBps: shareBps, includePlatformFee: false });
      refunded = r?.amountPaise ?? 0n;
      if (refunded > 0n) await repo.transition(row.id, ['cancelled'], { refundedPaise: refunded });
    }
    await deps.pricing?.release(row.id);
    await announceCancelled(moved, 'player', refunded || refundPaise);
    return { booking: ((await repo.byId(row.id)) ?? moved) as Booking, refundPaise: refunded || refundPaise };
  }

  /** R6 — the venue cancels: everything goes back, the platform fee too. */
  async function venueCancel(actor: Actor, bookingId: string, reason: string): Promise<Booking> {
    const row = await repo.byId(bookingId);
    if (!row) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    await requireRole(actor, row.venueId, 'manager');
    const viaPl4y = row.status === 'confirmed' && paidThroughPl4y(row);
    const moved = await repo.transition(row.id, ['held', 'confirmed'], {
      status: 'cancelled',
      holdExpiresAt: null,
      cancelledBy: actor.userId,
      cancelReason: reason.trim() || 'venue',
      cancelledAt: now(),
      // Paid at the desk: the venue gives the cash back itself.
      paymentStatus: row.paymentStatus === 'paid' ? 'refunded' : 'void',
      venueGrossPaise: 0n,
      commissionPaise: 0n,
    });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'This booking can no longer be cancelled.');
    let refunded: bigint | null = null;
    if (viaPl4y) {
      const r = await deps.payments.refundForBooking({ bookingId: row.id, reason: 'booking_venue_cancelled', courtShareBps: 10_000, includePlatformFee: true });
      refunded = r?.amountPaise ?? null;
      if (refunded) await repo.transition(row.id, ['cancelled'], { refundedPaise: refunded });
    } else if (row.paymentStatus === 'paid' && row.collectedBy === 'venue') {
      await repo.transition(row.id, ['cancelled'], { refundedPaise: row.amountPaise });
    }
    await deps.pricing?.release(row.id);
    await announceCancelled(moved, 'venue', refunded ?? 0n);
    return ((await repo.byId(row.id)) ?? moved) as Booking;
  }

  async function announceCancelled(row: BookingRow, by: 'player' | 'venue', refundPaise: bigint): Promise<void> {
    await outboxWrite(db, { topic: 'booking.cancelled', payload: { bookingId: row.id, venueId: row.venueId, by } });
    if (!row.userId) return;
    const [venue, court] = await Promise.all([venues.byId(row.venueId), venues.courtById(row.courtId)]);
    if (deps.notify) {
      await deps
        .notify(
          row.userId,
          'booking.cancelled',
          { venueName: venue.name, courtName: court?.name ?? 'Table', startsAt: row.startsAt.toISOString(), by, refundPaise: refundPaise.toString() },
          row.id,
        )
        .catch(() => undefined);
    }
    if (by === 'player' && deps.notifyVenue) {
      const name = (await deps.users.namesByIds([row.userId])).get(row.userId) ?? 'A player';
      for (const op of await operatorsOf(row.venueId)) {
        await deps
          .notifyVenue(op, 'venue.booking_cancelled', { venueName: venue.name, playerName: name, courtName: court?.name ?? 'Table', startsAt: row.startsAt.toISOString() }, row.venueId)
          .catch(() => undefined);
      }
    }
  }

  // --- R7, R8, R12 — the desk ---------------------------------------------------------------

  /** R8 — walk-ins and phone bookings pass through the same exclusion constraint. No bypass. */
  async function walkIn(
    actor: Actor,
    input: { courtId: string; startsAt: Date; endsAt: Date; name: string; phone?: string | null; paymentMode: 'offline' | 'comp' },
  ): Promise<Booking> {
    const at = now();
    const q = await quoteFor(input.courtId, input.startsAt, input.endsAt);
    await requireRole(actor, q.court.venueId, 'desk');
    const name = input.name.trim();
    if (name.length < 2) throw new UserError(BookingCode.INVALID_SLOT, 'Enter the name the court is booked under.');
    if (input.endsAt <= at) throw new UserError(BookingCode.OUTSIDE_BOOKING_WINDOW, 'That time has passed.');
    if (await repo.blackoutsAt(q.court.venueId, input.courtId, input.startsAt, input.endsAt)) {
      throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'That court is blocked out then.');
    }
    const comp = input.paymentMode === 'comp';
    // The desk charges its own price: no PL4Y offers, no fee, no commission.
    const base = q.priced.basePaise;
    try {
      const row = await repo.insertLive(
        {
          id: newId(),
          venueId: q.court.venueId,
          courtId: input.courtId,
          userId: null,
          walkInName: name,
          walkInPhone: input.phone?.trim() || null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          status: 'confirmed',
          paymentMode: input.paymentMode,
          holdExpiresAt: null,
          courtPaise: base,
          platformFeePaise: 0n,
          taxPaise: 0n,
          amountPaise: comp ? 0n : base,
          createdBy: actor.userId,
          bookingCode: await freshCode(),
          basePaise: base,
          venueOfferId: null,
          venueDiscountPaise: 0n,
          platformOfferId: null,
          platformDiscountPaise: 0n,
          paymentStatus: comp ? 'waived' : 'paid',
          paymentMethod: comp ? null : 'cash',
          collectedBy: comp ? null : 'venue',
          paidAt: comp ? null : at,
          venueGrossPaise: 0n,
          commissionBps: 0,
          commissionPaise: 0n,
        },
        at,
      );
      return row as Booking;
    } catch (err) {
      if (isOverlap(err) || isRaceAbort(err)) {
        throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'That court is already booked or held then.');
      }
      throw err;
    }
  }

  /**
   * 058 — the desk took the money for a pay-at-venue booking: cash, UPI to
   * the venue, a card. The booking is paid; the player gets a receipt.
   */
  async function markPaidAtDesk(actor: Actor, bookingId: string, method: DeskMethod): Promise<Booking> {
    const row = await repo.byId(bookingId);
    if (!row) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    await requireRole(actor, row.venueId, 'desk');
    if (row.paymentStatus === 'paid') throw new UserError(BookingCode.ALREADY_PAID, row.collectedBy === 'pl4y' ? 'This booking was already paid in the app.' : 'This booking is already marked paid.');
    if (row.paymentMode !== 'at_venue' || !['due', 'failed'].includes(row.paymentStatus) || !PLAYED.includes(row.status)) {
      throw new UserError(BookingCode.NOT_CANCELLABLE, 'Only a pay-at-venue booking that is due can be marked paid.');
    }
    const moved = await db.courtBooking.updateMany({
      where: { id: row.id, paymentStatus: { in: ['due', 'failed'] } },
      data: { paymentStatus: 'paid', collectedBy: 'venue', paymentMethod: method, paidAt: now(), updatedAt: now() },
    });
    if (moved.count === 0) throw new UserError(BookingCode.ALREADY_PAID, 'This booking was just paid.');
    await deps.pricing?.redeem(row.id);
    const paid = (await repo.byId(row.id))!;
    await announcePaid(paid);
    return paid as Booking;
  }

  async function checkIn(actor: Actor, bookingId: string): Promise<Booking> {
    const row = await repo.byId(bookingId);
    if (!row) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    await requireRole(actor, row.venueId, 'desk');
    if (row.status === 'checked_in') return row as Booking;
    const moved = await repo.transition(row.id, ['confirmed'], { status: 'checked_in', checkedInAt: now() });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'Only a confirmed booking can be checked in.');
    return moved as Booking;
  }

  /** R12 — the desk marks it; the fraud detector counts them (admin R8). No automatic ban. */
  async function markNoShow(actor: Actor, bookingId: string): Promise<Booking> {
    const row = await repo.byId(bookingId);
    if (!row) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    await requireRole(actor, row.venueId, 'desk');
    if (row.startsAt > now()) throw new UserError(BookingCode.NOT_CANCELLABLE, 'A booking can be marked a no-show only once it has started.');
    // An unpaid pay-at-venue booking leaves nothing to settle.
    const unpaid = row.paymentStatus === 'due' || row.paymentStatus === 'failed';
    const moved = await repo.transition(row.id, ['confirmed'], {
      status: 'no_show',
      ...(unpaid ? { paymentStatus: 'void', venueGrossPaise: 0n, commissionPaise: 0n } : {}),
    });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'Only a confirmed booking that was not checked in can be a no-show.');
    if (unpaid) await deps.pricing?.release(row.id);
    await outboxWrite(db, { topic: 'booking.no_show', payload: { bookingId: row.id, userId: row.userId } });
    return moved as Booking;
  }

  /** R7 — the desk's day: every court, its bookings and blackouts. */
  async function schedule(actor: Actor, venueId: string, date: string) {
    await requireRole(actor, venueId, 'desk');
    const midnight = localMidnight(date);
    if (!midnight) throw new UserError(BookingCode.INVALID_SLOT, 'That is not a date.');
    const end = new Date(midnight.getTime() + DAY);
    const [courts, bookings, blackouts, rules] = await Promise.all([
      venues.courtsFor(venueId),
      repo.forVenueBetween(venueId, midnight, end),
      db.courtBlackout.findMany({ where: { venueId, startsAt: { lt: end }, endsAt: { gt: midnight } }, orderBy: { startsAt: 'asc' } }),
      rulesForVenue(venueId),
    ]);
    const names = await deps.users.namesByIds(bookings.map((b) => b.userId).filter((u): u is string => !!u));
    return {
      date,
      courts: courts.filter((c) => c.active),
      bookings: bookings
        .filter((b) => b.status !== 'expired')
        .map((b) => ({ ...(b as Booking), bookedBy: b.userId ? (names.get(b.userId) ?? 'Player') : (b.walkInName ?? 'Walk-in') })),
      blackouts,
      rules,
    };
  }

  /** 058 — the venue's bookings over a range, for the management list. Desk and up. */
  async function venueBookings(
    actor: Actor,
    venueId: string,
    input: { from: string; to: string; status?: 'upcoming' | 'cancelled' | 'unpaid' | null; first?: number },
  ) {
    await requireRole(actor, venueId, 'desk');
    const start = localMidnight(input.from);
    const endDay = localMidnight(input.to);
    if (!start || !endDay || endDay < start) throw new UserError(BookingCode.INVALID_SLOT, 'Pick a valid date range.');
    const rows = await db.courtBooking.findMany({
      where: {
        venueId,
        startsAt: { gte: start, lt: new Date(endDay.getTime() + DAY) },
        ...(input.status === 'cancelled'
          ? { status: 'cancelled' }
          : input.status === 'unpaid'
            ? { paymentStatus: { in: ['due', 'failed'] }, status: { in: ['confirmed', 'checked_in'] } }
            : input.status === 'upcoming'
              ? { status: { in: ['confirmed', 'checked_in', 'held'] }, endsAt: { gt: now() } }
              : { status: { not: 'expired' } }),
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(input.first ?? 200, 1), 500),
    });
    const names = await deps.users.namesByIds(rows.map((b) => b.userId).filter((u): u is string => !!u));
    return rows.map((b) => ({ ...(b as Booking), bookedBy: b.userId ? (names.get(b.userId) ?? 'Player') : (b.walkInName ?? 'Walk-in') }));
  }

  /**
   * R7, R8 — occupancy and money, online and offline kept apart. 058 adds
   * revenue (today, this week, this month, and per day), customers and repeat
   * customers, discounts by who paid for them, commission, and when and where
   * people play.
   */
  async function dashboard(actor: Actor, venueId: string, from: string, to: string) {
    await requireRole(actor, venueId, 'manager');
    const start = localMidnight(from);
    const endDay = localMidnight(to);
    if (!start || !endDay || endDay < start) throw new UserError(BookingCode.INVALID_SLOT, 'Pick a valid date range.');
    if (endDay.getTime() - start.getTime() > 400 * DAY) throw new UserError(BookingCode.INVALID_SLOT, 'Pick a range of a year or less.');
    const end = new Date(endDay.getTime() + DAY);
    const at = now();
    const today = localMidnight(localDate(at))!;
    const weekStart = new Date(today.getTime() - localWeekday(at) * DAY);
    const monthStart = localMidnight(`${localDate(at).slice(0, 8)}01`)!;
    const periodStart = new Date(Math.min(start.getTime(), weekStart.getTime(), monthStart.getTime()));

    const [inRange, forPeriods, rules, courts, payments] = await Promise.all([
      repo.forVenueBetween(venueId, start, end),
      repo.forVenueBetween(venueId, periodStart, new Date(today.getTime() + DAY)),
      rulesForVenue(venueId),
      venues.courtsFor(venueId),
      deps.venuePayments ? deps.venuePayments(venueId, periodStart, new Date(Math.max(end.getTime(), today.getTime() + DAY))) : Promise.resolve([]),
    ]);
    const bookings = inRange.filter((b) => b.startsAt >= start && b.startsAt < end);
    const played = bookings.filter((b) => PLAYED.includes(b.status));
    const minutes = (b: BookingRow) => (b.endsAt.getTime() - b.startsAt.getTime()) / MIN;
    let openMinutes = 0;
    for (let t = start.getTime(); t < end.getTime(); t += DAY) {
      const weekday = localWeekday(new Date(t + 12 * 3_600_000));
      openMinutes += rules.filter((r) => r.weekday === weekday).reduce((m, r) => m + (r.closesMin - r.opensMin), 0);
    }
    const bookedMinutes = played.reduce((m, b) => m + minutes(b), 0);
    const paidPayments = payments.filter((p) => p.status === 'paid' && p.paidAt);

    // Money a booking earned the venue, counted on the day it is played. Pay-at-venue payments on the day paid.
    const earnedIn = (from: Date, until: Date) =>
      forPeriods.filter((b) => b.startsAt >= from && b.startsAt < until).reduce((s, b) => s + earnedPaise(b), 0n) +
      paidPayments.filter((p) => p.paidAt! >= from && p.paidAt! < until).reduce((s, p) => s + p.amountPaise, 0n);

    // Customers: distinct players; repeat customers have booked or paid here more than once, ever.
    const customerIds = new Set(played.filter((b) => b.userId).map((b) => b.userId!));
    for (const p of paidPayments) if (p.paidAt! >= start && p.paidAt! < end) customerIds.add(p.userId);
    const repeatRows = customerIds.size
      ? await db.$queryRaw<{ userId: string }[]>`
          SELECT user_id::text AS "userId" FROM (
            SELECT user_id FROM court_bookings
             WHERE venue_id = ${venueId}::uuid AND user_id = ANY(${[...customerIds]}::uuid[])
               AND status IN ('confirmed', 'checked_in', 'completed', 'no_show') AND starts_at < ${end}
            UNION ALL
            SELECT user_id FROM venue_payments
             WHERE venue_id = ${venueId}::uuid AND user_id = ANY(${[...customerIds]}::uuid[]) AND status = 'paid' AND paid_at < ${end}
          ) x GROUP BY user_id HAVING count(*) > 1`
      : [];

    const daily: { date: string; bookings: number; revenuePaise: bigint }[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += DAY) {
      const dayFrom = new Date(t);
      const dayTo = new Date(t + DAY);
      daily.push({
        date: localDate(new Date(t + 12 * 3_600_000)),
        bookings: played.filter((b) => b.startsAt >= dayFrom && b.startsAt < dayTo).length,
        revenuePaise: earnedIn(dayFrom, dayTo),
      });
    }
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, bookings: 0 }));
    for (const b of played) byHour[Math.floor(localMinutes(b.startsAt) / 60)]!.bookings += 1;
    const byTable = courts.map((c) => {
      const mine = played.filter((b) => b.courtId === c.id);
      return { courtId: c.id, name: c.name, bookings: mine.length, hours: mine.reduce((m, b) => m + minutes(b), 0) / 60, revenuePaise: mine.reduce((s, b) => s + earnedPaise(b), 0n) };
    });
    const sum = (xs: BookingRow[], f: (b: BookingRow) => bigint) => xs.reduce((s, b) => s + f(b), 0n);
    const paidOnline = played.filter((b) => b.paymentStatus === 'paid' && b.collectedBy === 'pl4y');
    const paidAtDesk = played.filter((b) => b.paymentStatus === 'paid' && b.collectedBy === 'venue');

    return {
      from,
      to,
      bookings: played.length,
      cancelled: bookings.filter((b) => b.status === 'cancelled').length,
      noShows: bookings.filter((b) => b.status === 'no_show').length,
      bookedHours: bookedMinutes / 60,
      openHours: openMinutes / 60,
      occupancy: openMinutes > 0 ? Math.min(1, bookedMinutes / openMinutes) : 0,
      // Kept as before: online = court money PL4Y collected; offline = walk-in and desk money.
      onlinePaise: sum(paidOnline, (b) => b.courtPaise),
      offlinePaise: sum(played.filter((b) => b.paymentMode === 'offline'), (b) => b.amountPaise) + sum(paidAtDesk, (b) => b.amountPaise),
      revenuePaise: sum(played, earnedPaise) + paidPayments.filter((p) => p.paidAt! >= start && p.paidAt! < end).reduce((s, p) => s + p.amountPaise, 0n),
      duePaise: sum(played.filter((b) => b.paymentStatus === 'due' || b.paymentStatus === 'failed'), (b) => b.amountPaise),
      venueDiscountPaise: sum(played, (b) => b.venueDiscountPaise),
      platformDiscountPaise: sum(played, (b) => b.platformDiscountPaise),
      commissionPaise: sum(bookings, (b) => b.commissionPaise) + paidPayments.filter((p) => p.paidAt! >= start && p.paidAt! < end).reduce((s, p) => s + p.commissionPaise, 0n),
      refundedPaise: sum(bookings, (b) => b.refundedPaise),
      customers: customerIds.size,
      repeatCustomers: repeatRows.length,
      todayPaise: earnedIn(today, new Date(today.getTime() + DAY)),
      weekPaise: earnedIn(weekStart, new Date(today.getTime() + DAY)),
      monthPaise: earnedIn(monthStart, new Date(today.getTime() + DAY)),
      onlineBookings: played.filter((b) => b.paymentMode === 'online').length,
      atVenueBookings: played.filter((b) => b.paymentMode === 'at_venue').length,
      walkIns: played.filter((b) => b.userId === null).length,
      daily,
      byHour,
      byTable,
    };
  }

  /**
   * 058 — every money line at the venue, newest first: bookings (paid, due,
   * refunded) and pay-at-venue payments, with what each discount was and who
   * paid for it, PL4Y's commission and what the venue keeps.
   */
  async function transactions(actor: Actor, venueId: string, input: { from: string; to: string; first?: number }): Promise<Transaction[]> {
    await requireRole(actor, venueId, 'manager');
    const start = localMidnight(input.from);
    const endDay = localMidnight(input.to);
    if (!start || !endDay || endDay < start) throw new UserError(BookingCode.INVALID_SLOT, 'Pick a valid date range.');
    const end = new Date(endDay.getTime() + DAY);
    const [rows, payments, courts] = await Promise.all([
      db.courtBooking.findMany({
        // Money lines by the day the money moved; what is still due, by the day it is played.
        where: {
          venueId,
          paymentStatus: { in: ['paid', 'due', 'refunded', 'partially_refunded'] },
          OR: [{ paidAt: { gte: start, lt: end } }, { paidAt: null, startsAt: { gte: start, lt: end } }],
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      deps.venuePayments ? deps.venuePayments(venueId, start, end) : Promise.resolve([]),
      venues.courtsFor(venueId),
    ]);
    const names = await deps.users.namesByIds([...rows.map((b) => b.userId).filter((u): u is string => !!u), ...payments.map((p) => p.userId)]);
    const courtName = new Map(courts.map((c) => [c.id, c.name]));
    const methods = await db.payment.findMany({
      where: { paymentOrder: { bookingId: { in: rows.map((r) => r.id) } }, status: { not: 'failed' } },
      select: { method: true, paymentOrder: { select: { bookingId: true } } },
    });
    const methodOfBooking = new Map(methods.map((m) => [m.paymentOrder.bookingId, m.method]));
    const lines: Transaction[] = rows.map((b) => {
      const earned = earnedPaise(b);
      return {
        kind: 'booking',
        id: b.id,
        reference: b.bookingCode,
        at: b.paidAt ?? b.createdAt,
        playerName: b.userId ? (names.get(b.userId) ?? 'Player') : (b.walkInName ?? 'Walk-in'),
        description: `${courtName.get(b.courtId) ?? 'Table'} · ${Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / MIN)} min`,
        grossPaise: b.basePaise,
        venueDiscountPaise: b.venueDiscountPaise,
        platformDiscountPaise: b.platformDiscountPaise,
        playerPaise: b.amountPaise,
        commissionPaise: b.commissionPaise,
        venueEarningsPaise: earned > b.commissionPaise ? earned - b.commissionPaise : 0n,
        refundedPaise: b.refundedPaise,
        paymentStatus: b.paymentStatus,
        paymentMode: b.paymentMode,
        collectedBy: b.collectedBy,
        method: b.paymentMethod ?? methodOfBooking.get(b.id) ?? null,
      };
    });
    for (const p of payments) {
      if (!['paid', 'refunded'].includes(p.status) || !p.paidAt) continue;
      lines.push({
        kind: 'venue_payment',
        id: p.id,
        reference: p.id.slice(0, 8).toUpperCase(),
        at: p.paidAt,
        playerName: names.get(p.userId) ?? 'Player',
        description: `${p.label} · ${p.minutes} min (pay at venue)`,
        grossPaise: p.amountPaise,
        venueDiscountPaise: 0n,
        platformDiscountPaise: 0n,
        playerPaise: p.amountPaise,
        commissionPaise: p.commissionPaise,
        venueEarningsPaise: p.status === 'paid' ? p.amountPaise - p.commissionPaise : 0n,
        refundedPaise: p.status === 'refunded' ? p.amountPaise : 0n,
        paymentStatus: p.status,
        paymentMode: 'pay_at_venue',
        collectedBy: 'pl4y',
        method: null,
      });
    }
    return lines.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, Math.min(Math.max(input.first ?? 200, 1), 500));
  }

  async function listForUser(
    userId: string,
    page: { first: number; offset: number },
    filter: 'upcoming' | 'past' | 'cancelled' | null = null,
  ): Promise<Booking[]> {
    return (await repo.forUser(userId, page, filter, now())) as Booking[];
  }

  /** 058 — what the player's checkout took off on top (PL4Y's reward), and what they actually paid. */
  async function paymentFacts(bookingIds: string[]): Promise<Map<string, { rewardDiscountPaise: bigint; reference: string | null; method: string | null }>> {
    const out = new Map<string, { rewardDiscountPaise: bigint; reference: string | null; method: string | null }>();
    if (bookingIds.length === 0) return out;
    const orders = await db.paymentOrder.findMany({
      where: { bookingId: { in: bookingIds }, status: 'paid' },
      select: { bookingId: true, discountPaise: true, payments: { where: { status: { not: 'failed' } }, select: { gatewayPaymentId: true, method: true }, take: 1 } },
    });
    for (const o of orders) {
      if (!o.bookingId || out.has(o.bookingId)) continue;
      out.set(o.bookingId, { rewardDiscountPaise: o.discountPaise, reference: o.payments[0]?.gatewayPaymentId ?? null, method: o.payments[0]?.method ?? null });
    }
    return out;
  }

  const bookableVenueIds = (venueIds: string[]) => repo.bookableVenueIds(venueIds);

  return {
    roleAt,
    myVenues,
    runsAVenue,
    staffOf,
    setStaff,
    policyFor,
    setPolicy,
    setRules,
    rulesForVenue,
    saveTable,
    addBlackout,
    removeBlackout,
    availability,
    nextAvailableDate,
    bookingOptions,
    quoteFor,
    quoteForPlayer,
    hold,
    byId,
    forPayments,
    extendHold,
    confirmFromPayment,
    failFromPayment,
    expireHold,
    sweep,
    cancelPreview,
    cancel,
    venueCancel,
    walkIn,
    markPaidAtDesk,
    checkIn,
    markNoShow,
    schedule,
    venueBookings,
    dashboard,
    transactions,
    listForUser,
    paymentFacts,
    bookableVenueIds,
    LIVE,
  };
}

export type BookingsService = ReturnType<typeof createBookingsService>;
