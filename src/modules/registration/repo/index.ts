/**
 * registration — repository (conventions.md §1).
 *
 * `acquireHold` below is the single most important query in the codebase. Read
 * it before changing anything in this module.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import { SEATED_STATUSES, type RegistrationStatus } from '../service/transitions.js';

export interface RegistrationRow {
  id: string;
  eventId: string;
  eventCategoryId: string;
  sportId: string;
  captainUserId: string;
  teamId: string | null;
  status: string;
  seed: number | null;
  amountPaise: bigint;
  createdAt: Date;
  confirmedAt: Date | null;
  paymentMode: string;
  checkedInAt: Date | null;
  checkedInBy: string | null;
  withdrawnReason: string | null;
}

/** What `insert` needs. Everything else has a column default. */
export type NewRegistrationRow = Omit<
  RegistrationRow,
  'createdAt' | 'confirmedAt' | 'paymentMode' | 'checkedInAt' | 'checkedInBy' | 'withdrawnReason'
> & { paymentMode?: string };

export interface SeatHoldRow {
  id: string;
  eventCategoryId: string;
  registrationId: string;
  seats: number;
  expiresAt: Date;
  releasedAt: Date | null;
}

export interface InviteRow {
  id: string;
  registrationId: string;
  invitedEmail: string;
  invitedUserId: string | null;
  token: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

const statusList = (statuses: RegistrationStatus[]) =>
  Prisma.join(statuses.map((s) => Prisma.sql`${s}`));

export interface CategoryStatsRow {
  eventId: string;
  categoryId: string;
  begun: number;
  confirmed: number;
  checkedIn: number;
  withdrawn: number;
  abandoned: number;
  waitlisted: number;
  offline: number;
  /** Paid through PL4Y: the entries a host payout is made of. */
  onlinePaid: number;
}

export function createRegistrationRepo(db: Db) {
  /**
   * registration R4 — capacity is decided INSIDE this statement.
   *
   * `FOR UPDATE` on the category row serialises every concurrent attempt on one
   * draw, so the count and the insert cannot straddle another transaction's
   * commit. Fifty taps on a ten-entry draw queue behind that lock and exactly
   * ten of them get a row back.
   *
   * Returning ZERO ROWS is how "full" is reported (R4). Not an exception, not a
   * retry loop: the caller maps an empty result to CATEGORY_FULL. An exception
   * here would tempt somebody to retry, and a retry loop against a lock is how
   * a full draw becomes a stalled one.
   *
   * `expires_at > now()` is R5 in one predicate: an expired hold stops blocking
   * capacity the instant it expires, whether or not the release job has run.
   * The job flips `released_at` and moves the registration to `expired`; it is
   * NOT what makes capacity correct.
   *
   * Must be called inside a transaction, or the FOR UPDATE releases at the end
   * of this statement and guarantees nothing.
   */
  async function acquireHold(
    tx: Tx,
    input: {
      holdId: string;
      eventCategoryId: string;
      registrationId: string;
      seats?: number;
      ttlSeconds: number;
      /** F20 — an organizer's walk-in may take a seat after registration closed, until the draw. */
      allowClosed?: boolean;
    },
  ): Promise<{ id: string; expiresAt: Date } | null> {
    const seats = input.seats ?? 1;
    const seatable = input.allowClosed ? ['open', 'full', 'closed'] : ['open', 'full'];
    const rows = await tx.$queryRaw<{ id: string; expiresAt: Date }[]>`
      WITH locked AS (
        -- gap #3 — the friendly "is it open?" check runs before this
        -- transaction and can race with closing. Under the lock, a closed or
        -- cancelled draw has no seat to give.
        SELECT id, capacity FROM event_categories
         WHERE id = ${input.eventCategoryId}::uuid
           AND status IN (${Prisma.join(seatable.map((st) => Prisma.sql`${st}`))})
         FOR UPDATE
      ),
      used AS (
        SELECT
          (SELECT count(*) FROM registrations
            WHERE event_category_id = ${input.eventCategoryId}::uuid
              AND status IN (${statusList(SEATED_STATUSES)}))                    AS taken,
          (SELECT coalesce(sum(seats), 0) FROM seat_holds
            WHERE event_category_id = ${input.eventCategoryId}::uuid
              AND released_at IS NULL
              AND expires_at > now())                                          AS held
      )
      INSERT INTO seat_holds (id, event_category_id, registration_id, seats, expires_at)
      SELECT ${input.holdId}::uuid,
             locked.id,
             ${input.registrationId}::uuid,
             ${seats}::smallint,
             now() + make_interval(secs => ${input.ttlSeconds}::double precision)
        FROM locked, used
       WHERE used.taken + used.held + ${seats}::bigint <= locked.capacity
      RETURNING id, expires_at AS "expiresAt"
    `;
    return rows[0] ?? null;
  }

  /**
   * registration R4 — the category's exclusive lock, taken as the FIRST
   * statement of any transaction that will end in a seat hold.
   *
   * The ORDER is the whole point. Inserting a registration or a team takes a
   * `FOR KEY SHARE` lock on this same category row through its foreign key, so
   * asking for `FOR UPDATE` afterwards is a lock UPGRADE — and two transactions
   * that each hold the shared lock and each want the exclusive one deadlock.
   * Postgres reports 40P01, kills one of them, and on a draw that fifty people
   * are tapping at once it kills most of them.
   *
   * Taking the exclusive lock first means every concurrent attempt queues on it
   * before it touches anything else, which is what R4 says happens and what
   * makes "exactly ten of fifty get a seat" true rather than hoped for.
   */
  async function lockCategory(tx: Tx, eventCategoryId: string): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM event_categories WHERE id = ${eventCategoryId}::uuid FOR UPDATE
    `;
  }

  /**
   * The hold a registration already has. `takeHold` consults this first, so a
   * payment retry reuses its live hold rather than asking for a second seat it
   * would then be refused (R8).
   */
  async function liveHoldFor(
    tx: Tx | Db,
    registrationId: string,
  ): Promise<SeatHoldRow | null> {
    const rows = await tx.$queryRaw<SeatHoldRow[]>`
      SELECT id,
             event_category_id AS "eventCategoryId",
             registration_id AS "registrationId",
             seats,
             expires_at AS "expiresAt",
             released_at AS "releasedAt"
        FROM seat_holds
       WHERE registration_id = ${registrationId}::uuid
         AND released_at IS NULL
         AND expires_at > now()
       ORDER BY expires_at DESC
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * gap #22 — a player who is paying keeps their seat while they pay. Only a
   * live hold moves, and only later: an expired hold is not revived.
   */
  async function extendHold(registrationId: string, until: Date): Promise<Date | null> {
    const rows = await db.$queryRaw<{ expiresAt: Date }[]>`
      UPDATE seat_holds SET expires_at = GREATEST(expires_at, ${until})
       WHERE registration_id = ${registrationId}::uuid
         AND released_at IS NULL
         AND expires_at > now()
      RETURNING expires_at AS "expiresAt"
    `;
    return rows[0]?.expiresAt ?? null;
  }

  /** Every entry in a draw in one of `statuses` (gap #2: what a cancellation closes out). */
  async function inCategoryWithStatus(
    eventCategoryId: string,
    statuses: RegistrationStatus[],
  ): Promise<RegistrationRow[]> {
    return db.registration.findMany({
      where: { eventCategoryId, status: { in: statuses } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function holdById(holdId: string): Promise<SeatHoldRow | null> {
    const row = await db.seatHold.findUnique({ where: { id: holdId } });
    return row;
  }

  /** Consuming and releasing are the same write; only the reason differs. */
  async function releaseHold(tx: Tx | Db, holdId: string): Promise<boolean> {
    const affected = await tx.$executeRaw`
      UPDATE seat_holds SET released_at = now()
       WHERE id = ${holdId}::uuid AND released_at IS NULL
    `;
    return affected > 0;
  }

  /** registration R5 — the safety net behind the delayed release job. */
  async function staleHolds(limit = 200): Promise<SeatHoldRow[]> {
    return db.$queryRaw<SeatHoldRow[]>`
      SELECT id,
             event_category_id AS "eventCategoryId",
             registration_id AS "registrationId",
             seats,
             expires_at AS "expiresAt",
             released_at AS "releasedAt"
        FROM seat_holds
       WHERE released_at IS NULL AND expires_at <= now()
       ORDER BY expires_at
       LIMIT ${limit}
    `;
  }

  // --- registrations ---------------------------------------------------------

  async function insert(tx: Tx, row: NewRegistrationRow): Promise<RegistrationRow> {
    return tx.registration.create({ data: row });
  }

  async function byId(registrationId: string): Promise<RegistrationRow | null> {
    return db.registration.findUnique({ where: { id: registrationId } });
  }

  /**
   * registration R11 — the ONLY place `status` is written. A conditional UPDATE
   * on the expected current status, so two workers racing to confirm the same
   * registration cannot both believe they did it: the loser gets zero rows.
   */
  async function transition(
    tx: Tx,
    registrationId: string,
    from: RegistrationStatus,
    to: RegistrationStatus,
    extra: {
      confirmedAt?: Date | null;
      teamId?: string | null;
      checkedInAt?: Date | null;
      checkedInBy?: string | null;
      withdrawnReason?: string | null;
    } = {},
  ): Promise<boolean> {
    const sets: Prisma.Sql[] = [Prisma.sql`status = ${to}`];
    if (extra.confirmedAt !== undefined) {
      sets.push(Prisma.sql`confirmed_at = ${extra.confirmedAt}`);
    }
    if (extra.teamId !== undefined) sets.push(Prisma.sql`team_id = ${extra.teamId}::uuid`);
    if (extra.checkedInAt !== undefined) {
      sets.push(Prisma.sql`checked_in_at = ${extra.checkedInAt}`);
    }
    if (extra.checkedInBy !== undefined) {
      sets.push(Prisma.sql`checked_in_by = ${extra.checkedInBy}::uuid`);
    }
    if (extra.withdrawnReason !== undefined) {
      sets.push(Prisma.sql`withdrawn_reason = ${extra.withdrawnReason}`);
    }

    const affected = await tx.$executeRaw`
      UPDATE registrations
         SET ${Prisma.join(sets, ', ')}
       WHERE id = ${registrationId}::uuid AND status = ${from}
    `;
    return affected > 0;
  }

  async function forCaptainInCategory(
    captainUserId: string,
    eventCategoryId: string,
  ): Promise<RegistrationRow[]> {
    return db.registration.findMany({
      where: { captainUserId, eventCategoryId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Includes team members, so a partner cannot enter the same draw twice. */
  async function playerHasLiveEntry(
    userId: string,
    eventCategoryId: string,
    liveStatuses: RegistrationStatus[],
    client: Tx | Db = db,
  ): Promise<boolean> {
    const count = await client.registration.count({
      where: {
        eventCategoryId,
        status: { in: liveStatuses },
        OR: [
          { captainUserId: userId },
          { team: { members: { some: { userId } } } },
        ],
      },
    });
    return count > 0;
  }

  async function confirmedForCategory(eventCategoryId: string): Promise<RegistrationRow[]> {
    return db.registration.findMany({
      where: { eventCategoryId, status: { in: ['confirmed', 'checked_in'] } },
      orderBy: { confirmedAt: 'asc' },
    });
  }

  async function countConfirmed(eventCategoryId: string): Promise<number> {
    return db.registration.count({
      where: { eventCategoryId, status: { in: ['confirmed', 'checked_in'] } },
    });
  }

  /**
   * The number `events.capacityOf` subtracts (events R5). Counts SEATS, not
   * rows: a hold is per registration and a registration is per team.
   */
  async function countLiveHoldSeats(eventCategoryId: string): Promise<number> {
    const rows = await db.$queryRaw<{ held: bigint }[]>`
      SELECT coalesce(sum(seats), 0)::bigint AS held
        FROM seat_holds
       WHERE event_category_id = ${eventCategoryId}::uuid
         AND released_at IS NULL
         AND expires_at > now()
    `;
    return Number(rows[0]?.held ?? 0n);
  }

  async function forUser(userId: string): Promise<RegistrationRow[]> {
    return db.registration.findMany({
      where: {
        OR: [{ captainUserId: userId }, { team: { members: { some: { userId } } } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function forEvent(
    eventId: string,
    filter: { status?: RegistrationStatus[]; categoryId?: string | null },
    page: { after?: { createdAt: Date; id: string } | null; limit: number },
  ): Promise<RegistrationRow[]> {
    return db.registration.findMany({
      where: {
        eventId,
        ...(filter.status ? { status: { in: filter.status } } : {}),
        ...(filter.categoryId ? { eventCategoryId: filter.categoryId } : {}),
        ...(page.after
          ? {
              OR: [
                { createdAt: { gt: page.after.createdAt } },
                { createdAt: page.after.createdAt, id: { gt: page.after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: page.limit,
    });
  }

  /** R13 — every entry that can walk up to the desk, for the offline roster. */
  async function rosterFor(eventId: string): Promise<RegistrationRow[]> {
    return db.registration.findMany({
      where: { eventId, status: { in: ['confirmed', 'checked_in'] } },
      orderBy: [{ eventCategoryId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  // --- waitlist (R17) ----------------------------------------------------------

  /**
   * Whether anybody is still queued for this draw. Read under the category
   * lock, so a seat that frees up is offered to the head of the queue rather
   * than to whoever taps "register" first.
   */
  async function hasWaiting(tx: Tx, eventCategoryId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM waitlist_entries w
          JOIN registrations r ON r.id = w.registration_id
         WHERE w.event_category_id = ${eventCategoryId}::uuid
           AND w.offered_at IS NULL
           AND r.status = 'waitlisted'
      ) AS waiting
    `;
    return rows[0]?.waiting ?? false;
  }

  async function enqueueWaitlist(
    tx: Tx,
    input: { registrationId: string; eventCategoryId: string },
  ): Promise<void> {
    await tx.waitlistEntry.create({ data: input });
  }

  /** The head of the queue. Call under the category lock. */
  async function waitlistHead(tx: Tx, eventCategoryId: string): Promise<RegistrationRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT w.registration_id AS id
        FROM waitlist_entries w
        JOIN registrations r ON r.id = w.registration_id
       WHERE w.event_category_id = ${eventCategoryId}::uuid
         AND w.offered_at IS NULL
         AND r.status = 'waitlisted'
       ORDER BY w.created_at, w.registration_id
       LIMIT 1
    `;
    const id = rows[0]?.id;
    return id ? tx.registration.findUnique({ where: { id } }) : null;
  }

  async function markOffered(tx: Tx, registrationId: string, at: Date): Promise<void> {
    await tx.waitlistEntry.update({ where: { registrationId }, data: { offeredAt: at } });
  }

  async function removeFromWaitlist(tx: Tx, registrationId: string): Promise<void> {
    await tx.waitlistEntry.deleteMany({ where: { registrationId } });
  }

  /** True when this entry reached payment through a waitlist offer. */
  async function wasOffered(registrationId: string): Promise<boolean> {
    const entry = await db.waitlistEntry.findUnique({ where: { registrationId } });
    return entry?.offeredAt != null;
  }

  /** 1-based, among entries still waiting. Null once promoted or gone. */
  async function waitlistPosition(registrationId: string): Promise<number | null> {
    const rows = await db.$queryRaw<{ position: bigint }[]>`
      SELECT (
        SELECT count(*)
          FROM waitlist_entries o
          JOIN registrations r ON r.id = o.registration_id
         WHERE o.event_category_id = me.event_category_id
           AND o.offered_at IS NULL
           AND r.status = 'waitlisted'
           AND (o.created_at, o.registration_id) <= (me.created_at, me.registration_id)
      ) AS position
        FROM waitlist_entries me
       WHERE me.registration_id = ${registrationId}::uuid
         AND me.offered_at IS NULL
    `;
    const position = rows[0]?.position;
    return position === undefined ? null : Number(position);
  }

  // --- teams -----------------------------------------------------------------

  async function createTeam(
    tx: Tx,
    input: { id: string; eventCategoryId: string; name: string | null; members: { userId: string; isCaptain: boolean }[] },
  ): Promise<void> {
    await tx.team.create({
      data: {
        id: input.id,
        eventCategoryId: input.eventCategoryId,
        name: input.name,
        members: { create: input.members },
      },
    });
  }

  /** Plan 3b — one more teammate on a team still filling up. */
  async function addTeamMember(tx: Tx, teamId: string, userId: string): Promise<void> {
    await tx.teamMember.create({ data: { teamId, userId, isCaptain: false } });
  }

  /** Inside the caller's transaction, so a member added a moment ago is counted. */
  async function countTeamMembers(tx: Tx, teamId: string): Promise<number> {
    return tx.teamMember.count({ where: { teamId } });
  }

  /** Plan 3b — a team that is still filling up belongs to its entry before it takes a seat. */
  async function attachTeam(tx: Tx, registrationId: string, teamId: string): Promise<void> {
    await tx.registration.update({ where: { id: registrationId }, data: { teamId } });
  }

  async function teamMembers(teamId: string): Promise<{ userId: string; isCaptain: boolean }[]> {
    return db.teamMember.findMany({
      where: { teamId },
      select: { userId: true, isCaptain: true },
      orderBy: { isCaptain: 'desc' },
    });
  }

  async function membersOfTeams(
    teamIds: string[],
  ): Promise<{ teamId: string; userId: string; isCaptain: boolean }[]> {
    if (teamIds.length === 0) return [];
    return db.teamMember.findMany({
      where: { teamId: { in: teamIds } },
      select: { teamId: true, userId: true, isCaptain: true },
      orderBy: { isCaptain: 'desc' },
    });
  }

  /** Two users on one team of a registration in one of `statuses` (chat R2). */
  async function shareTeam(userA: string, userB: string, statuses: readonly string[]): Promise<boolean> {
    const found = await db.teamMember.findFirst({
      where: {
        userId: userA,
        team: {
          members: { some: { userId: userB } },
          registrations: { some: { status: { in: [...statuses] } } },
        },
      },
      select: { teamId: true },
    });
    return found !== null;
  }

  // --- invites ---------------------------------------------------------------

  async function createInvite(tx: Tx, row: Omit<InviteRow, 'createdAt'>): Promise<InviteRow> {
    return tx.registrationInvite.create({ data: row });
  }

  async function inviteById(inviteId: string): Promise<InviteRow | null> {
    return db.registrationInvite.findUnique({ where: { id: inviteId } });
  }

  async function inviteByToken(token: string): Promise<InviteRow | null> {
    return db.registrationInvite.findUnique({ where: { token } });
  }

  async function invitesFor(registrationId: string): Promise<InviteRow[]> {
    return db.registrationInvite.findMany({
      where: { registrationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Conditional on `pending`, so accept and expiry cannot both win. */
  async function settleInvite(
    tx: Tx,
    inviteId: string,
    status: 'accepted' | 'declined' | 'expired',
  ): Promise<boolean> {
    const affected = await tx.$executeRaw`
      UPDATE registration_invites SET status = ${status}
       WHERE id = ${inviteId}::uuid AND status = 'pending'
    `;
    return affected > 0;
  }

  async function staleInvites(limit = 200): Promise<InviteRow[]> {
    return db.registrationInvite.findMany({
      where: { status: 'pending', expiresAt: { lte: new Date() } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * organizers R8 — entry counts per draw, for host analytics. `begun` is
   * every entry ever started; the rest are where they ended up.
   */
  async function statsForEvents(eventIds: string[]): Promise<CategoryStatsRow[]> {
    if (eventIds.length === 0) return [];
    return db.$queryRaw<CategoryStatsRow[]>`
      SELECT r.event_id::text AS "eventId",
             r.event_category_id::text AS "categoryId",
             count(*)::int AS "begun",
             count(*) FILTER (WHERE r.status IN ('confirmed', 'checked_in'))::int AS "confirmed",
             count(*) FILTER (WHERE r.checked_in_at IS NOT NULL)::int AS "checkedIn",
             count(*) FILTER (WHERE r.status = 'withdrawn')::int AS "withdrawn",
             count(*) FILTER (WHERE r.status IN ('expired', 'payment_failed'))::int AS "abandoned",
             count(*) FILTER (WHERE r.status = 'waitlisted')::int AS "waitlisted",
             count(*) FILTER (WHERE r.payment_mode = 'offline' AND r.status IN ('confirmed', 'checked_in'))::int AS "offline",
             count(*) FILTER (WHERE r.payment_mode = 'online' AND r.status IN ('confirmed', 'checked_in'))::int AS "onlinePaid"
        FROM registrations r
       WHERE r.event_id = ANY(${eventIds}::uuid[])
       GROUP BY r.event_id, r.event_category_id
    `;
  }

  return {
    statsForEvents,
    acquireHold,
    lockCategory,
    liveHoldFor,
    extendHold,
    inCategoryWithStatus,
    holdById,
    releaseHold,
    staleHolds,
    insert,
    byId,
    transition,
    forCaptainInCategory,
    playerHasLiveEntry,
    confirmedForCategory,
    countConfirmed,
    countLiveHoldSeats,
    forUser,
    forEvent,
    rosterFor,
    hasWaiting,
    enqueueWaitlist,
    shareTeam,
    waitlistHead,
    markOffered,
    removeFromWaitlist,
    wasOffered,
    waitlistPosition,
    createTeam,
    addTeamMember,
    countTeamMembers,
    attachTeam,
    teamMembers,
    membersOfTeams,
    createInvite,
    inviteById,
    inviteByToken,
    invitesFor,
    settleInvite,
    staleInvites,
  };
}

export type RegistrationRepo = ReturnType<typeof createRegistrationRepo>;
