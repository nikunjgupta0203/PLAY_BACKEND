/**
 * bookings — court availability, bookings and the venue desk
 * (docs/modules/19-bookings.md).
 *
 * The same shape as `registration`: hold, then pay, confirm only on a verified
 * capture (R2). The court is the inventory and Postgres's exclusion constraint
 * is what stops two groups getting one court (R1). Money is `payments`'s:
 * this module asks it for an order and for refunds, and is told when a
 * capture lands.
 *
 * Who runs a venue: its creator, anyone with a `venue_staff` grant
 * (owner | manager | desk, R7), and PL4Y staff on a portal session. Grants
 * are read per request, like event grants. (The spec puts the grant table in
 * identity, R17; it lives here because nothing else reads it yet.)
 */
import type { Db } from '../../../platform/db.js';
import { SystemError, UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import { LIVE, isOverlap, isRaceAbort, type BookingRow, type BookingsRepo } from '../repo/index.js';
import {
  cancellationShareBps,
  localDate,
  localMidnight,
  localMinutes,
  quote,
  ruleFor,
  slotsFor,
  courtPrice,
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
} as const;

/** R2 — a hold lasts this long before payment. */
export const HOLD_MINUTES = 10;
/** R10 — per user, per venue, per local day. */
export const MAX_MINUTES_PER_DAY = 180;
/** R10 — open holds per user at once. */
export const MAX_OPEN_HOLDS = 2;
/** Completed this long after the slot ends, so the desk can still mark a no-show that day. */
export const COMPLETE_AFTER_MS = 6 * 3_600_000;

export type VenueRole = 'owner' | 'manager' | 'desk';
const RANK: Record<VenueRole, number> = { desk: 1, manager: 2, owner: 3 };

export type BookingStatus = 'held' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'expired' | 'no_show' | 'payment_failed';

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
  courtsFor(venueId: string): Promise<{ id: string; venueId: string | null; name: string; active: boolean; sportIds: string[] }[]>;
  courtById(courtId: string): Promise<{ id: string; venueId: string | null; name: string; active: boolean } | null>;
}

export interface PaymentsPort {
  refundForBooking(input: { bookingId: string; reason: string; courtShareBps: number; includePlatformFee: boolean }): Promise<{ amountPaise: bigint } | null>;
}

export interface BookingsDeps {
  db: Db;
  repo: BookingsRepo;
  venues: VenuesPort;
  payments: PaymentsPort;
  users: { findByEmail(email: string): Promise<{ id: string } | null>; namesByIds(ids: string[]): Promise<Map<string, string>> };
  queue: { releaseHold(bookingId: string, delayMs: number): Promise<void> };
  notify?(userId: string, template: 'booking.confirmed' | 'booking.cancelled', payload: Record<string, string | null>, bookingId: string): Promise<void>;
  now?: () => Date;
}

const MIN = 60_000;

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
   * desk or manager grant, or a venue of their own that takes bookings.
   */
  async function runsAVenue(userId: string): Promise<boolean> {
    if (await db.venueStaff.findFirst({ where: { userId }, select: { venueId: true } })) return true;
    const own = await db.venue.findMany({ where: { createdBy: userId, deletedAt: null }, select: { id: true } });
    if (own.length === 0) return false;
    return (await repo.bookableVenueIds(own.map((v) => v.id))).size > 0;
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

  // --- R4 — set-up: policy, rules, blackouts -------------------------------------

  const policyFor = (venueId: string) => repo.policy(venueId);

  async function setPolicy(actor: Actor, venueId: string, patch: Partial<Policy>): Promise<Policy> {
    await requireRole(actor, venueId, 'manager');
    const next: Policy = { ...(await repo.policy(venueId)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)) };
    const bad =
      next.advanceDays < 1 || next.advanceDays > 60 ||
      next.minSlotMinutes < 30 || next.minSlotMinutes % 30 !== 0 ||
      next.partialRefundHours > next.fullRefundHours || next.partialRefundHours < 0 ||
      next.partialRefundBps < 0 || next.partialRefundBps > 10_000 ||
      next.taxBps < 0 || next.taxBps > 10_000 || next.platformFeePaise < 0n;
    if (bad) throw new UserError(BookingCode.INVALID_POLICY, 'Check the booking settings: window 1–60 days, slots in steps of 30 minutes, refund hours in order.');
    await repo.upsertPolicy(venueId, next);
    return next;
  }

  async function courtOfVenue(courtId: string) {
    const court = await venues.courtById(courtId);
    if (!court?.venueId) throw new UserError(BookingCode.INVALID_SLOT, 'That court is not part of a venue.');
    return court as typeof court & { venueId: string };
  }

  /** R4 — a court's weekly opening rules, replaced as a whole. */
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

  async function availability(venueId: string, date: string, opts: { durationMinutes?: number; sportId?: string | null } = {}): Promise<Slot[]> {
    const midnight = localMidnight(date);
    if (!midnight) throw new UserError(BookingCode.INVALID_SLOT, 'That is not a date.');
    const policy = await repo.policy(venueId);
    const duration = opts.durationMinutes ?? policy.minSlotMinutes;
    if (duration < policy.minSlotMinutes || duration % 30 !== 0 || duration > 240) {
      throw new UserError(BookingCode.INVALID_SLOT, `Book at least ${policy.minSlotMinutes} minutes, in steps of 30.`);
    }
    const courts = (await venues.courtsFor(venueId)).filter(
      (c) => c.active && (!opts.sportId || c.sportIds.length === 0 || c.sportIds.includes(opts.sportId)),
    );
    const at = now();
    const [rules, busy] = await Promise.all([
      repo.rulesFor(courts.map((c) => c.id)),
      repo.busy(venueId, midnight, new Date(midnight.getTime() + 86_400_000), at),
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
      const date = localDate(new Date(start.getTime() + d * 86_400_000 + 12 * 3_600_000));
      if ((await availability(venueId, date, { durationMinutes })).some((s) => s.available)) return date;
    }
    return null;
  }

  // --- R5 — the quote ------------------------------------------------------------------

  async function quoteFor(courtId: string, startsAt: Date, endsAt: Date) {
    const court = await courtOfVenue(courtId);
    const [policy, rules] = await Promise.all([repo.policy(court.venueId), repo.rulesFor([courtId])]);
    const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / MIN);
    const rule = ruleFor(rules, courtId, startsAt, endsAt);
    if (!rule || minutes <= 0) throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'That court is not open then.');
    return { court, policy, rule, minutes, ...quote(courtPrice(rule, minutes), policy) };
  }

  // --- R1, R2, R3, R10 — holding a court ----------------------------------------------

  async function checkSlotShape(policy: Policy, startsAt: Date, endsAt: Date, at: Date): Promise<void> {
    const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / MIN);
    if (minutes < policy.minSlotMinutes || minutes % 30 !== 0 || localMinutes(startsAt) % 30 !== 0) {
      throw new UserError(BookingCode.INVALID_SLOT, `Book at least ${policy.minSlotMinutes} minutes, starting on the hour or half hour.`);
    }
    if (startsAt <= at) throw new UserError(BookingCode.OUTSIDE_BOOKING_WINDOW, 'That time has passed.');
    if (startsAt.getTime() > at.getTime() + policy.advanceDays * 86_400_000) {
      throw new UserError(BookingCode.OUTSIDE_BOOKING_WINDOW, `This venue takes bookings up to ${policy.advanceDays} days ahead.`);
    }
  }

  async function hold(actor: Actor, input: { courtId: string; startsAt: Date; endsAt: Date }): Promise<Booking> {
    const at = now();
    const q = await quoteFor(input.courtId, input.startsAt, input.endsAt);
    const venueId = q.court.venueId;
    if (!q.policy.bookable) throw new UserError(BookingCode.VENUE_NOT_BOOKABLE, 'This venue does not take court bookings.');
    await checkSlotShape(q.policy, input.startsAt, input.endsAt, at);

    // R10 — anti-hoarding.
    const dayStart = localMidnight(localDate(input.startsAt))!;
    const usage = await repo.usage(actor.userId, venueId, dayStart, new Date(dayStart.getTime() + 86_400_000), at);
    if (usage.holds >= MAX_OPEN_HOLDS) {
      throw new UserError(BookingCode.BOOKING_LIMIT_EXCEEDED, 'You have two bookings waiting for payment. Pay for or cancel one first.');
    }
    if (usage.minutes + q.minutes > MAX_MINUTES_PER_DAY) {
      throw new UserError(BookingCode.BOOKING_LIMIT_EXCEEDED, 'You can book up to 3 hours a day at one venue.');
    }
    // R4 — a blackout (an event's courts among them) is never bookable.
    if (await repo.blackoutsAt(venueId, input.courtId, input.startsAt, input.endsAt)) {
      throw new UserError(BookingCode.SLOT_UNAVAILABLE, 'Someone just took that slot. Pick another.');
    }

    // A free court needs no payment: it is booked at once.
    const free = q.totalPaise === 0n;
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
          status: free ? 'confirmed' : 'held',
          paymentMode: free ? 'comp' : 'online',
          holdExpiresAt: free ? null : new Date(at.getTime() + HOLD_MINUTES * MIN),
          courtPaise: q.courtPaise,
          platformFeePaise: q.platformFeePaise,
          taxPaise: q.taxPaise,
          amountPaise: q.totalPaise,
          createdBy: actor.userId,
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
    if (free) {
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
    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      amountPaise: row.amountPaise,
      courtPaise: row.courtPaise,
      platformFeePaise: row.platformFeePaise,
      taxPaise: row.taxPaise,
      holdExpiresAt: row.holdExpiresAt,
      venueName: venue.name,
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

  /**
   * R2 — only `payments` calls this, on a verified capture. A held booking
   * confirms. One whose hold lapsed confirms too if the court is still free —
   * the exclusion constraint decides — and otherwise this throws
   * ILLEGAL_TRANSITION so payments refunds the capture in full.
   */
  async function confirmFromPayment(input: { bookingId: string; paymentId: string }): Promise<{ confirmedNow: boolean }> {
    const row = await repo.byId(input.bookingId);
    if (!row) throw new SystemError('ILLEGAL_TRANSITION', 'No such booking');
    if (row.status === 'confirmed' || row.status === 'checked_in' || row.status === 'completed') return { confirmedNow: false };
    if (row.status === 'cancelled' || row.status === 'no_show') {
      throw new SystemError('ILLEGAL_TRANSITION', `booking ${row.id} is ${row.status}`);
    }
    let moved: BookingRow | null;
    try {
      moved = await repo.transition(row.id, ['held', 'expired', 'payment_failed'], { status: 'confirmed', holdExpiresAt: null });
    } catch (err) {
      if (isOverlap(err)) throw new SystemError('ILLEGAL_TRANSITION', `court for booking ${row.id} was taken after its hold lapsed`);
      throw err;
    }
    if (!moved) return { confirmedNow: false };
    await announceConfirmed(moved);
    return { confirmedNow: true };
  }

  /** A failed attempt changes nothing: the hold lives on, so a retry keeps the court (as registration R8). */
  async function failFromPayment(_input: { bookingId: string; paymentId: string; reason: string }): Promise<void> {}

  async function announceConfirmed(row: BookingRow): Promise<void> {
    await outboxWrite(db, { topic: 'booking.confirmed', payload: { bookingId: row.id, venueId: row.venueId } });
    if (row.userId && deps.notify) {
      const [venue, court] = await Promise.all([venues.byId(row.venueId), venues.courtById(row.courtId)]);
      await deps
        .notify(row.userId, 'booking.confirmed', { venueName: venue.name, courtName: court?.name ?? 'Court', startsAt: row.startsAt.toISOString() }, row.id)
        .catch(() => undefined);
    }
  }

  // --- R2, R3 — holds lapse ----------------------------------------------------------

  /** The `release-booking-hold` job. A hold extended while paying is left alone until it lapses. */
  async function expireHold(bookingId: string): Promise<void> {
    const at = now();
    await db.courtBooking.updateMany({
      where: { id: bookingId, status: 'held', holdExpiresAt: { lte: at } },
      data: { status: 'expired', holdExpiresAt: null, updatedAt: at },
    });
  }

  async function sweep(): Promise<{ expired: number; completed: number }> {
    const at = now();
    const expired = await repo.expireStale(at);
    const completed = await repo.completeFinished(new Date(at.getTime() - COMPLETE_AFTER_MS));
    return { expired: expired.length, completed: completed.length };
  }

  // --- R6 — cancelling ----------------------------------------------------------------------

  /** R6, app R10 — what cancelling now would give back, before the player confirms. */
  async function cancelPreview(actor: Actor, bookingId: string): Promise<{ refundPaise: bigint; shareBps: number }> {
    const row = await repo.byId(bookingId);
    if (!row || row.userId !== actor.userId) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    if (row.status === 'held') return { refundPaise: 0n, shareBps: 0 };
    const policy = await repo.policy(row.venueId);
    const shareBps = cancellationShareBps(policy, row.startsAt, now());
    const { bookingRefundAmount } = await import('../../payments/service/index.js');
    const refundPaise =
      row.paymentMode === 'online'
        ? bookingRefundAmount({
            courtPaise: row.courtPaise,
            platformFeePaise: row.platformFeePaise,
            taxPaise: row.taxPaise,
            capturedPaise: row.amountPaise,
            courtShareBps: shareBps,
            includePlatformFee: false,
          })
        : 0n;
    return { refundPaise, shareBps };
  }

  /**
   * R6 — the player cancels. A held booking just lets go of the court. A paid
   * one gets back its share by the venue's policy; the platform fee stays.
   */
  async function cancel(actor: Actor, bookingId: string): Promise<{ booking: Booking; refundPaise: bigint }> {
    const row = await repo.byId(bookingId);
    if (!row || row.userId !== actor.userId) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    if (row.status === 'held') {
      const moved = await repo.transition(row.id, ['held'], { status: 'expired', holdExpiresAt: null });
      return { booking: (moved ?? row) as Booking, refundPaise: 0n };
    }
    if (row.status !== 'confirmed') {
      throw new UserError(BookingCode.NOT_CANCELLABLE, 'This booking can no longer be cancelled.');
    }
    if (row.startsAt <= now()) throw new UserError(BookingCode.CANCELLATION_WINDOW_CLOSED, 'This booking has already started.');
    const { refundPaise, shareBps } = await cancelPreview(actor, bookingId);
    const moved = await repo.transition(row.id, ['confirmed'], {
      status: 'cancelled',
      cancelledBy: actor.userId,
      cancelReason: 'player',
      cancelledAt: now(),
    });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'This booking can no longer be cancelled.');
    if (shareBps > 0 && row.paymentMode === 'online') {
      await deps.payments.refundForBooking({ bookingId: row.id, reason: 'booking_cancelled', courtShareBps: shareBps, includePlatformFee: false });
    }
    await announceCancelled(moved, 'player', refundPaise);
    return { booking: moved as Booking, refundPaise };
  }

  /** R6 — the venue cancels: everything goes back, the platform fee too. */
  async function venueCancel(actor: Actor, bookingId: string, reason: string): Promise<Booking> {
    const row = await repo.byId(bookingId);
    if (!row) throw new UserError(BookingCode.BOOKING_NOT_FOUND, 'That booking could not be found.');
    await requireRole(actor, row.venueId, 'manager');
    const moved = await repo.transition(row.id, ['held', 'confirmed'], {
      status: 'cancelled',
      holdExpiresAt: null,
      cancelledBy: actor.userId,
      cancelReason: reason.trim() || 'venue',
      cancelledAt: now(),
    });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'This booking can no longer be cancelled.');
    let refunded: bigint | null = null;
    if (row.status === 'confirmed' && row.paymentMode === 'online') {
      const r = await deps.payments.refundForBooking({ bookingId: row.id, reason: 'booking_venue_cancelled', courtShareBps: 10_000, includePlatformFee: true });
      refunded = r?.amountPaise ?? null;
    }
    await announceCancelled(moved, 'venue', refunded ?? 0n);
    return moved as Booking;
  }

  async function announceCancelled(row: BookingRow, by: 'player' | 'venue', refundPaise: bigint): Promise<void> {
    await outboxWrite(db, { topic: 'booking.cancelled', payload: { bookingId: row.id, venueId: row.venueId, by } });
    if (row.userId && deps.notify) {
      const [venue, court] = await Promise.all([venues.byId(row.venueId), venues.courtById(row.courtId)]);
      await deps
        .notify(
          row.userId,
          'booking.cancelled',
          { venueName: venue.name, courtName: court?.name ?? 'Court', startsAt: row.startsAt.toISOString(), by, refundPaise: refundPaise.toString() },
          row.id,
        )
        .catch(() => undefined);
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
          courtPaise: q.courtPaise,
          platformFeePaise: 0n,
          taxPaise: 0n,
          amountPaise: input.paymentMode === 'comp' ? 0n : q.courtPaise,
          createdBy: actor.userId,
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
    const moved = await repo.transition(row.id, ['confirmed'], { status: 'no_show' });
    if (!moved) throw new UserError(BookingCode.NOT_CANCELLABLE, 'Only a confirmed booking that was not checked in can be a no-show.');
    await outboxWrite(db, { topic: 'booking.no_show', payload: { bookingId: row.id, userId: row.userId } });
    return moved as Booking;
  }

  /** R7 — the desk's day: every court, its bookings and blackouts. */
  async function schedule(actor: Actor, venueId: string, date: string) {
    await requireRole(actor, venueId, 'desk');
    const midnight = localMidnight(date);
    if (!midnight) throw new UserError(BookingCode.INVALID_SLOT, 'That is not a date.');
    const end = new Date(midnight.getTime() + 86_400_000);
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

  /** R7, R8 — occupancy and money, online and offline kept apart. */
  async function dashboard(actor: Actor, venueId: string, from: string, to: string) {
    await requireRole(actor, venueId, 'manager');
    const start = localMidnight(from);
    const endDay = localMidnight(to);
    if (!start || !endDay || endDay < start) throw new UserError(BookingCode.INVALID_SLOT, 'Pick a valid date range.');
    const end = new Date(endDay.getTime() + 86_400_000);
    const [bookings, rules] = await Promise.all([repo.forVenueBetween(venueId, start, end), rulesForVenue(venueId)]);
    const played = bookings.filter((b) => ['confirmed', 'checked_in', 'completed', 'no_show'].includes(b.status));
    const minutes = (b: BookingRow) => (b.endsAt.getTime() - b.startsAt.getTime()) / MIN;
    let openMinutes = 0;
    for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) {
      const weekday = (new Date(t + 12 * 3_600_000 + 330 * MIN).getUTCDay() + 6) % 7;
      openMinutes += rules.filter((r) => r.weekday === weekday).reduce((m, r) => m + (r.closesMin - r.opensMin), 0);
    }
    const bookedMinutes = played.reduce((m, b) => m + minutes(b), 0);
    return {
      from,
      to,
      bookings: played.length,
      cancelled: bookings.filter((b) => b.status === 'cancelled').length,
      noShows: bookings.filter((b) => b.status === 'no_show').length,
      bookedHours: bookedMinutes / 60,
      openHours: openMinutes / 60,
      occupancy: openMinutes > 0 ? Math.min(1, bookedMinutes / openMinutes) : 0,
      onlinePaise: played.filter((b) => b.paymentMode === 'online').reduce((s, b) => s + b.courtPaise, 0n),
      offlinePaise: played.filter((b) => b.paymentMode === 'offline').reduce((s, b) => s + b.amountPaise, 0n),
    };
  }

  async function listForUser(userId: string, page: { first: number; offset: number }): Promise<Booking[]> {
    return (await repo.forUser(userId, page)) as Booking[];
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
    addBlackout,
    removeBlackout,
    availability,
    nextAvailableDate,
    quoteFor,
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
    checkIn,
    markNoShow,
    schedule,
    dashboard,
    listForUser,
    bookableVenueIds,
    LIVE,
  };
}

export type BookingsService = ReturnType<typeof createBookingsService>;
