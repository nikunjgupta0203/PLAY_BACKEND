/**
 * bookings — repository (conventions.md §1).
 *
 * `insertHeld` carries the module's guarantee. It expires stale holds on the
 * same court and range, then inserts, in ONE transaction; the exclusion
 * constraint `court_bookings_no_overlap` decides who gets the court
 * (bookings R1, R3). Nothing else about availability is trusted.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import type { Busy, Policy, Rule } from '../service/slots.js';
import { DEFAULT_POLICY } from '../service/slots.js';

export interface BookingRow {
  id: string;
  venueId: string;
  courtId: string;
  userId: string | null;
  walkInName: string | null;
  walkInPhone: string | null;
  startsAt: Date;
  endsAt: Date;
  status: string;
  paymentMode: string;
  holdExpiresAt: Date | null;
  courtPaise: bigint;
  platformFeePaise: bigint;
  taxPaise: bigint;
  amountPaise: bigint;
  cancelledBy: string | null;
  cancelReason: string | null;
  cancelledAt: Date | null;
  checkedInAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Live rows: the exclusion constraint's own predicate. */
export const LIVE = ['held', 'confirmed', 'checked_in'] as const;

const timeToMinutes = (t: Date) => t.getUTCHours() * 60 + t.getUTCMinutes();
const minutesToTime = (m: number) => new Date(Date.UTC(1970, 0, 1, Math.floor(m / 60), m % 60));

const text = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError
    ? `${err.message} ${JSON.stringify(err.meta ?? {})}`
    : err instanceof Error
      ? err.message
      : String(err);

/** Postgres's exclusion_violation: somebody else holds the court then (R1). */
export function isOverlap(err: unknown): boolean {
  const t = text(err);
  return t.includes('23P01') || t.includes('court_bookings_no_overlap');
}

/**
 * Two inserts racing on an exclusion constraint can each wait for the other;
 * Postgres then aborts one with deadlock_detected (40P01). It is the same
 * race as an overlap, lost differently, and safe to try once more.
 */
export function isRaceAbort(err: unknown): boolean {
  const t = text(err);
  return t.includes('40P01') || t.includes('deadlock detected') || t.includes('40001');
}

export function createBookingsRepo(db: Db) {
  async function policy(venueId: string): Promise<Policy> {
    const row = await db.venueBookingPolicy.findUnique({ where: { venueId } });
    if (!row) return DEFAULT_POLICY;
    return {
      bookable: row.bookable,
      advanceDays: row.advanceDays,
      minSlotMinutes: row.minSlotMinutes,
      fullRefundHours: row.fullRefundHours,
      partialRefundHours: row.partialRefundHours,
      partialRefundBps: row.partialRefundBps,
      platformFeePaise: row.platformFeePaise,
      taxBps: row.taxBps,
    };
  }

  async function upsertPolicy(venueId: string, p: Policy): Promise<void> {
    const data = { ...p, updatedAt: new Date() };
    await db.venueBookingPolicy.upsert({ where: { venueId }, create: { venueId, ...data }, update: data });
  }

  async function bookableVenueIds(venueIds: string[]): Promise<Set<string>> {
    const rows = await db.venueBookingPolicy.findMany({ where: { venueId: { in: venueIds }, bookable: true }, select: { venueId: true } });
    return new Set(rows.map((r) => r.venueId));
  }

  async function rulesFor(courtIds: string[]): Promise<Rule[]> {
    if (courtIds.length === 0) return [];
    const rows = await db.courtAvailabilityRule.findMany({
      where: { courtId: { in: courtIds } },
      orderBy: [{ weekday: 'asc' }, { opensAt: 'asc' }],
    });
    return rows.map((r) => ({
      courtId: r.courtId,
      weekday: r.weekday,
      opensMin: timeToMinutes(r.opensAt),
      closesMin: timeToMinutes(r.closesAt),
      pricePerHourPaise: r.pricePerHourPaise,
    }));
  }

  async function replaceRules(courtId: string, rules: Omit<Rule, 'courtId'>[], newId: () => string): Promise<void> {
    await db.$transaction(async (tx) => {
      await tx.courtAvailabilityRule.deleteMany({ where: { courtId } });
      if (rules.length === 0) return;
      await tx.courtAvailabilityRule.createMany({
        data: rules.map((r) => ({
          id: newId(),
          courtId,
          weekday: r.weekday,
          opensAt: minutesToTime(r.opensMin),
          closesAt: minutesToTime(r.closesMin),
          pricePerHourPaise: r.pricePerHourPaise,
        })),
      });
    });
  }

  /** Blackouts and live bookings that touch [from, to) at a venue. Held rows count only while their hold lasts. */
  async function busy(venueId: string, from: Date, to: Date, at: Date): Promise<Busy[]> {
    const [blackouts, bookings] = await Promise.all([
      db.courtBlackout.findMany({
        where: { venueId, startsAt: { lt: to }, endsAt: { gt: from } },
        select: { courtId: true, startsAt: true, endsAt: true },
      }),
      db.courtBooking.findMany({
        where: {
          venueId,
          startsAt: { lt: to },
          endsAt: { gt: from },
          OR: [{ status: { in: ['confirmed', 'checked_in'] } }, { status: 'held', holdExpiresAt: { gt: at } }],
        },
        select: { courtId: true, startsAt: true, endsAt: true },
      }),
    ]);
    return [...blackouts, ...bookings];
  }

  async function blackoutsAt(venueId: string, courtId: string, startsAt: Date, endsAt: Date): Promise<number> {
    return db.courtBlackout.count({
      where: { venueId, OR: [{ courtId }, { courtId: null }], startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    });
  }

  /**
   * R1, R3 — expire stale holds that overlap, then insert, so an expired hold
   * frees its slot for this very insert without waiting for the sweep.
   *
   * Two plain statements, not an interactive transaction: the first only
   * moves rows whose hold already lapsed, which is right whether or not the
   * insert follows, and the exclusion constraint alone decides the insert.
   *
   * The insert takes a transaction-scoped advisory lock on the court in the
   * same statement (conventions §2: `pg_advisory_xact_lock`, released at the
   * statement's commit). Without it, racing inserts on one exclusion
   * constraint deadlock each other and each deadlock costs a second of
   * detection: fifty players on one slot then queue past the pool timeout.
   * With it they line up, and every loser gets a clean overlap at once.
   * Throws on overlap (`isOverlap`).
   */
  async function insertLive(row: Omit<BookingRow, 'createdAt' | 'updatedAt' | 'cancelledBy' | 'cancelReason' | 'cancelledAt' | 'checkedInAt'>, at: Date): Promise<BookingRow> {
    await db.$executeRaw`
      UPDATE court_bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ${at}
       WHERE court_id = ${row.courtId}::uuid AND status = 'held' AND hold_expires_at <= ${at}
         AND tstzrange(starts_at, ends_at) && tstzrange(${row.startsAt}::timestamptz, ${row.endsAt}::timestamptz)`;
    const insert = () => db.$queryRaw<{ id: string }[]>`
      WITH court_lock AS (SELECT pg_advisory_xact_lock(hashtext(${row.courtId})) AS locked)
      INSERT INTO court_bookings (
        id, venue_id, court_id, user_id, walk_in_name, walk_in_phone, starts_at, ends_at, status,
        payment_mode, hold_expires_at, court_paise, platform_fee_paise, tax_paise, amount_paise, created_by
      )
      SELECT ${row.id}::uuid, ${row.venueId}::uuid, ${row.courtId}::uuid, ${row.userId}::uuid, ${row.walkInName},
             ${row.walkInPhone}, ${row.startsAt}::timestamptz, ${row.endsAt}::timestamptz, ${row.status},
             ${row.paymentMode}, ${row.holdExpiresAt}::timestamptz, ${row.courtPaise}, ${row.platformFeePaise},
             ${row.taxPaise}, ${row.amountPaise}, ${row.createdBy}::uuid
        FROM court_lock
      RETURNING id::text AS id`;
    try {
      await insert();
    } catch (err) {
      if (!isRaceAbort(err)) throw err;
      // Lost a deadlock to a racing insert: once more, and the constraint decides.
      await insert();
    }
    return (await db.courtBooking.findUnique({ where: { id: row.id } }))!;
  }

  async function byId(id: string, conn: Db | Tx = db): Promise<BookingRow | null> {
    return conn.courtBooking.findUnique({ where: { id } });
  }

  /** A conditional move. Returns the row when it moved, null when it was not in `from`. */
  async function transition(
    id: string,
    from: string[],
    data: Partial<Omit<BookingRow, 'id'>>,
    conn: Db | Tx = db,
  ): Promise<BookingRow | null> {
    const { count } = await conn.courtBooking.updateMany({
      where: { id, status: { in: from } },
      data: { ...data, updatedAt: new Date() },
    });
    return count === 1 ? conn.courtBooking.findUnique({ where: { id } }) : null;
  }

  /** R10 — a user's live bookings at one venue on one local day, and their open holds anywhere. */
  async function usage(userId: string, venueId: string, dayStart: Date, dayEnd: Date, at: Date) {
    const [sameDay, holds] = await Promise.all([
      db.courtBooking.findMany({
        where: {
          userId,
          venueId,
          startsAt: { gte: dayStart, lt: dayEnd },
          OR: [{ status: { in: ['confirmed', 'checked_in'] } }, { status: 'held', holdExpiresAt: { gt: at } }],
        },
        select: { startsAt: true, endsAt: true },
      }),
      db.courtBooking.count({ where: { userId, status: 'held', holdExpiresAt: { gt: at } } }),
    ]);
    const minutes = sameDay.reduce((m, b) => m + (b.endsAt.getTime() - b.startsAt.getTime()) / 60_000, 0);
    return { minutes, holds };
  }

  async function expireStale(at: Date): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE court_bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ${at}
       WHERE status = 'held' AND hold_expires_at <= ${at}
      RETURNING id::text AS id`;
    return rows.map((r) => r.id);
  }

  async function completeFinished(before: Date): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE court_bookings SET status = 'completed', updated_at = now()
       WHERE status IN ('confirmed', 'checked_in') AND ends_at <= ${before}
      RETURNING id::text AS id`;
    return rows.map((r) => r.id);
  }

  async function forVenueBetween(venueId: string, from: Date, to: Date): Promise<BookingRow[]> {
    return db.courtBooking.findMany({
      where: { venueId, startsAt: { lt: to }, endsAt: { gt: from } },
      orderBy: [{ startsAt: 'asc' }, { courtId: 'asc' }],
    });
  }

  async function forUser(userId: string, page: { first: number; offset: number }): Promise<BookingRow[]> {
    return db.courtBooking.findMany({
      where: { userId, status: { notIn: ['expired'] } },
      orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.first,
    });
  }

  return {
    policy,
    upsertPolicy,
    bookableVenueIds,
    rulesFor,
    replaceRules,
    busy,
    blackoutsAt,
    insertLive,
    byId,
    transition,
    usage,
    expireStale,
    completeFinished,
    forVenueBetween,
    forUser,
  };
}

export type BookingsRepo = ReturnType<typeof createBookingsRepo>;
