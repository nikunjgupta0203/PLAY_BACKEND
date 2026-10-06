/**
 * tournament — repository (conventions.md §1).
 *
 * Three things in here are not ordinary Prisma calls, and each is load-bearing:
 *
 *   · `lockTournament` takes a TRANSACTION-scoped advisory lock (R9). Under
 *     Neon's pooled endpoint a session-scoped lock would leak onto the next
 *     borrower of the connection (ADR 0001 §C3), so there is deliberately no
 *     variant of this that outlives a COMMIT.
 *   · `feedsSlot` answers "will anything ever fill this side?", which is how a
 *     bye is told apart from a side that has simply not been played yet. A bye
 *     is a slot nothing is wired into (draw.ts), so the question is a lookup on
 *     the wiring rather than a flag anybody has to remember to set.
 *   · `assignCourt` writes through the `EXCLUDE USING gist` constraint. The
 *     database, not the scheduler, is what stops a court being double-booked —
 *     R13 lets organizers reassign by hand all day, and they do.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';

export type Client = Db | Tx;

export interface TournamentRow {
  id: string;
  eventId: string;
  eventCategoryId: string;
  drawType: string;
  bracketSize: number;
  plateSize: number;
  drawnAt: Date;
  completedAt: Date | null;
}

export interface MatchRow {
  id: string;
  tournamentId: string;
  eventCategoryId: string;
  sportId: string;
  bracket: string;
  round: number;
  slot: number;
  groupNo: number | null;
  tallyA: number | null;
  tallyB: number | null;
  sideARegistrationId: string | null;
  sideBRegistrationId: string | null;
  winnerRegistrationId: string | null;
  winnerMatchId: string | null;
  winnerSlot: number | null;
  loserMatchId: string | null;
  loserSlot: number | null;
  courtId: string | null;
  scheduledAt: Date | null;
  status: string;
  scoreSeq: number;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AssignmentRow {
  matchId: string;
  courtId: string;
  startsAt: Date;
  endsAt: Date | null;
  assignedBy: string;
}

/**
 * Postgres raises SQLSTATE 23P01 when an exclusion constraint rejects a write.
 *
 * Prisma has no typed error for it — it arrives as a known request error with
 * the driver's message attached, or as an unknown one — so the code is matched
 * in the text. Matching the constraint name as well keeps a future exclusion
 * constraint elsewhere from being reported as a double-booked court.
 */
export const EXCLUSION_VIOLATION = '23P01';
const OVERLAP_CONSTRAINT = 'court_assignments_no_overlap';

export function isCourtOverlap(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${
    err instanceof Prisma.PrismaClientKnownRequestError ? JSON.stringify(err.meta ?? {}) : ''
  }`;
  return text.includes(EXCLUSION_VIOLATION) || text.includes(OVERLAP_CONSTRAINT);
}

const MATCH_SELECT = {
  id: true,
  tournamentId: true,
  eventCategoryId: true,
  sportId: true,
  bracket: true,
  round: true,
  slot: true,
  groupNo: true,
  tallyA: true,
  tallyB: true,
  sideARegistrationId: true,
  sideBRegistrationId: true,
  winnerRegistrationId: true,
  winnerMatchId: true,
  winnerSlot: true,
  loserMatchId: true,
  loserSlot: true,
  courtId: true,
  scheduledAt: true,
  status: true,
  scoreSeq: true,
  createdAt: true,
  completedAt: true,
} as const;

export function createTournamentRepo(db: Db) {
  // --- serialisation (R9) ----------------------------------------------------

  /**
   * R9 — two courts finishing in the same millisecond must not write the same
   * next-match slot concurrently. `pg_advisory_xact_lock` is released at COMMIT;
   * `pg_advisory_lock` would ride the pooled connection into somebody else's
   * request (ADR 0001 §C3, and scripts/guard.ts greps for it).
   */
  async function lockTournament(tx: Tx, tournamentId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tournamentId}))`;
  }

  // --- tournaments -----------------------------------------------------------

  async function byId(client: Client, id: string): Promise<TournamentRow | null> {
    return client.tournament.findUnique({ where: { id } });
  }

  async function byCategory(
    client: Client,
    eventCategoryId: string,
  ): Promise<TournamentRow | null> {
    return client.tournament.findUnique({ where: { eventCategoryId } });
  }

  async function createTournament(tx: Tx, row: TournamentRow): Promise<TournamentRow> {
    return tx.tournament.create({ data: row });
  }

  async function markCompleted(tx: Tx, id: string, at: Date): Promise<void> {
    await tx.tournament.update({ where: { id }, data: { completedAt: at } });
  }

  async function deleteDraw(tx: Tx, tournamentId: string): Promise<void> {
    // The wiring is self-referential, so the rows cannot go in one statement
    // while they still point at each other.
    await tx.$executeRaw`
      UPDATE matches
         SET winner_match_id = NULL, winner_slot = NULL,
             loser_match_id = NULL, loser_slot = NULL
       WHERE tournament_id = ${tournamentId}::uuid
    `;
    await tx.courtAssignment.deleteMany({ where: { match: { tournamentId } } });
    await tx.match.deleteMany({ where: { tournamentId } });
    await tx.tournament.delete({ where: { id: tournamentId } });
  }

  // --- matches ---------------------------------------------------------------

  async function createMatches(tx: Tx, rows: MatchRow[]): Promise<void> {
    if (rows.length === 0) return;
    // Two passes: the wiring points at rows in the same batch, and a foreign
    // key cannot reference a row that does not exist yet.
    await tx.match.createMany({
      data: rows.map((r) => ({
        ...r,
        winnerMatchId: null,
        winnerSlot: null,
        loserMatchId: null,
        loserSlot: null,
      })),
    });
    for (const row of rows) {
      if (!row.winnerMatchId && !row.loserMatchId) continue;
      await tx.match.update({
        where: { id: row.id },
        data: {
          winnerMatchId: row.winnerMatchId,
          winnerSlot: row.winnerSlot,
          loserMatchId: row.loserMatchId,
          loserSlot: row.loserSlot,
        },
      });
    }
  }

  async function matchById(client: Client, id: string): Promise<MatchRow | null> {
    return client.match.findUnique({ where: { id }, select: MATCH_SELECT });
  }

  async function matchesFor(client: Client, tournamentId: string): Promise<MatchRow[]> {
    return client.match.findMany({
      where: { tournamentId },
      select: MATCH_SELECT,
      orderBy: [{ bracket: 'asc' }, { round: 'asc' }, { slot: 'asc' }],
    });
  }

  async function matchesForCategory(
    client: Client,
    eventCategoryId: string,
  ): Promise<MatchRow[]> {
    return client.match.findMany({
      where: { eventCategoryId },
      select: MATCH_SELECT,
      orderBy: [{ bracket: 'asc' }, { round: 'asc' }, { slot: 'asc' }],
    });
  }

  /** Live Mode: what is on court, or about to be, across a whole event. */
  async function liveForEvent(client: Client, eventId: string): Promise<MatchRow[]> {
    return client.match.findMany({
      where: {
        tournament: { eventId },
        status: { in: ['ready', 'live', 'awaiting_confirm'] },
      },
      select: MATCH_SELECT,
      orderBy: [{ scheduledAt: 'asc' }, { round: 'asc' }, { slot: 'asc' }],
    });
  }

  /**
   * R8 — the draw is immutable once a match has started.
   *
   * The rule says "left `scheduled`", but three of the statuses outside it are
   * reached at DRAW TIME rather than by anybody playing: `ready` is set the
   * moment both sides are known, which for round 1 is immediately; a bye is
   * written as `walkover` (R3); and a Plate position nobody can reach is
   * `void`. Locking a draw on those would mean no draw with a bye in it could
   * ever be regenerated, which is the opposite of what R8 protects.
   *
   * What R8 actually protects is a played result, so that is what this asks
   * for.
   */
  async function hasStartedMatch(client: Client, tournamentId: string): Promise<boolean> {
    const count = await client.match.count({
      where: {
        tournamentId,
        OR: [
          { status: { in: ['live', 'awaiting_confirm', 'completed'] } },
          { scoreSeq: { gt: 0 } },
          // gap #35 — a walkover between two real entries is a recorded
          // result (a no-show). A bye is a walkover with one side empty.
          { status: 'walkover', sideARegistrationId: { not: null }, sideBRegistrationId: { not: null } },
        ],
      },
    });
    return count > 0;
  }

  async function placeSide(
    tx: Tx,
    matchId: string,
    side: 0 | 1,
    registrationId: string,
  ): Promise<MatchRow> {
    return tx.match.update({
      where: { id: matchId },
      data:
        side === 0
          ? { sideARegistrationId: registrationId }
          : { sideBRegistrationId: registrationId },
      select: MATCH_SELECT,
    });
  }

  async function setStatus(tx: Tx, matchId: string, status: string): Promise<void> {
    await tx.match.update({ where: { id: matchId }, data: { status } });
  }

  /** The one write that finishes a match: status, winner and time, together. */
  async function finish(
    tx: Tx,
    matchId: string,
    input: {
      status: string;
      winnerRegistrationId: string | null;
      completedAt: Date;
      tallyA?: number | null;
      tallyB?: number | null;
    },
  ): Promise<void> {
    await tx.match.update({
      where: { id: matchId },
      data: {
        status: input.status,
        winnerRegistrationId: input.winnerRegistrationId,
        completedAt: input.completedAt,
        tallyA: input.tallyA ?? null,
        tallyB: input.tallyB ?? null,
      },
    });
  }

  /**
   * Cut a wire that will never carry anybody — a bye has no loser to send, and
   * a void match has no winner.
   *
   * This is not tidying. A slot fed by nothing IS a bye (see `feedsSlot`), so
   * leaving the wire in place would make a finished position look like one that
   * is still waiting for a player, and the match downstream would never resolve.
   */
  async function cutLoserWire(tx: Tx, matchId: string): Promise<void> {
    await tx.match.update({
      where: { id: matchId },
      data: { loserMatchId: null, loserSlot: null },
    });
  }

  async function cutWinnerWire(tx: Tx, matchId: string): Promise<void> {
    await tx.match.update({
      where: { id: matchId },
      data: { winnerMatchId: null, winnerSlot: null },
    });
  }

  /**
   * Is anything wired into this side of this match?
   *
   * A `false` here means the slot is a BYE: no match can ever produce a player
   * for it, so a match with one filled side and one unfed side is finished
   * before it starts (R3). This is why byes need no column of their own — the
   * wiring already knows.
   */
  async function feedsSlot(client: Client, matchId: string, side: 0 | 1): Promise<boolean> {
    const count = await client.match.count({
      where: {
        OR: [
          { winnerMatchId: matchId, winnerSlot: side },
          { loserMatchId: matchId, loserSlot: side },
        ],
      },
    });
    return count > 0;
  }

  // --- scheduling ------------------------------------------------------------

  /** R11 — the scheduler only ever places matches whose sides are both known. */
  async function readyUnscheduled(client: Client, tournamentId: string): Promise<MatchRow[]> {
    return client.match.findMany({
      where: { tournamentId, status: 'ready', courtId: null },
      select: MATCH_SELECT,
      // R12 — round order is the scheduling order, so a bracket cannot wait on
      // itself.
      orderBy: [{ round: 'asc' }, { bracket: 'asc' }, { slot: 'asc' }],
    });
  }

  async function assignmentsFor(client: Client, tournamentId: string): Promise<AssignmentRow[]> {
    return client.courtAssignment.findMany({
      where: { match: { tournamentId } },
      orderBy: { startsAt: 'asc' },
    });
  }

  async function assignmentFor(client: Client, matchId: string): Promise<AssignmentRow | null> {
    return client.courtAssignment.findUnique({ where: { matchId } });
  }

  /**
   * Everything already booked on these courts from `from` onwards — across
   * every tournament, not just this one.
   *
   * A venue runs eight draws on the same courts, so a scheduler that only knew
   * about its own bracket would propose a time the exclusion constraint then
   * rejects, and the organizer would watch half a schedule appear.
   */
  async function bookedWindows(
    client: Client,
    courtIds: string[],
    from: Date,
  ): Promise<{ courtId: string; startsAt: Date; endsAt: Date | null }[]> {
    if (courtIds.length === 0) return [];
    return client.courtAssignment.findMany({
      where: { courtId: { in: courtIds }, OR: [{ endsAt: null }, { endsAt: { gt: from } }] },
      select: { courtId: true, startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * When each player is next free, from the matches already on a schedule.
   * R11's minimum rest is measured against this, and it spans the whole event:
   * a player entered in two categories is one body.
   *
   * A COMPLETED match counts too. Rest is a fact about legs, not about status —
   * a quarter-final finished ten minutes ago is exactly the match the next one
   * has to be kept away from.
   */
  async function scheduledSidesFor(
    client: Client,
    eventId: string,
    from: Date,
  ): Promise<{ matchId: string; startsAt: Date; sideA: string | null; sideB: string | null }[]> {
    const rows = await client.match.findMany({
      where: { tournament: { eventId }, scheduledAt: { not: null } },
      select: {
        id: true,
        scheduledAt: true,
        sideARegistrationId: true,
        sideBRegistrationId: true,
      },
    });
    return rows
      .filter((r) => r.scheduledAt !== null && r.scheduledAt >= from)
      .map((r) => ({
        matchId: r.id,
        startsAt: r.scheduledAt as Date,
        sideA: r.sideARegistrationId,
        sideB: r.sideBRegistrationId,
      }));
  }

  /**
   * One court booking. The unique primary key makes re-assigning a match an
   * upsert; the exclusion constraint makes booking an occupied court an error
   * rather than a quietly overlapping pair of matches.
   */
  async function assignCourt(
    tx: Tx,
    input: {
      matchId: string;
      courtId: string;
      startsAt: Date;
      endsAt: Date | null;
      assignedBy: 'scheduler' | 'organizer';
    },
  ): Promise<void> {
    await tx.courtAssignment.upsert({
      where: { matchId: input.matchId },
      create: {
        matchId: input.matchId,
        courtId: input.courtId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        assignedBy: input.assignedBy,
      },
      update: {
        courtId: input.courtId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        assignedBy: input.assignedBy,
      },
    });
    await tx.match.update({
      where: { id: input.matchId },
      data: { courtId: input.courtId, scheduledAt: input.startsAt },
    });
  }

  /** F14 — a time with no court (the court, if any, is kept). */
  async function setScheduledAt(tx: Tx, matchId: string, startsAt: Date): Promise<void> {
    await tx.match.update({ where: { id: matchId }, data: { scheduledAt: startsAt } });
    await tx.courtAssignment.updateMany({ where: { matchId }, data: { startsAt, endsAt: null } });
  }

  async function clearAssignment(tx: Tx, matchId: string): Promise<void> {
    await tx.courtAssignment.deleteMany({ where: { matchId } });
    await tx.match.update({
      where: { id: matchId },
      data: { courtId: null, scheduledAt: null },
    });
  }

  // --- the ports other modules read through ----------------------------------

  /** venues R4 — courts already booked inside THIS tournament in this window. */
  async function assignedCourtIds(input: {
    venueId: string;
    tournamentId: string;
    from: Date;
    to: Date;
  }): Promise<string[]> {
    const rows = await db.$queryRaw<{ courtId: string }[]>`
      SELECT DISTINCT ca.court_id AS "courtId"
        FROM court_assignments ca
        JOIN matches m       ON m.id = ca.match_id
        JOIN venue_courts vc ON vc.id = ca.court_id
       WHERE m.tournament_id = ${input.tournamentId}::uuid
         AND vc.venue_id = ${input.venueId}::uuid
         AND court_booking_window(ca.starts_at, ca.ends_at)
             && tstzrange(${input.from}, ${input.to})
    `;
    return rows.map((r) => r.courtId);
  }

  /** venues R4 — a court with matches on it cannot be retired underneath them. */
  async function courtHasScheduledMatches(courtId: string): Promise<boolean> {
    const count = await db.match.count({
      where: { courtId, status: { notIn: ['completed', 'walkover', 'void'] } },
    });
    return count > 0;
  }

  return {
    lockTournament,
    byId,
    byCategory,
    createTournament,
    markCompleted,
    deleteDraw,
    createMatches,
    matchById,
    matchesFor,
    matchesForCategory,
    liveForEvent,
    hasStartedMatch,
    placeSide,
    setStatus,
    finish,
    cutLoserWire,
    cutWinnerWire,
    feedsSlot,
    setScheduledAt,
    readyUnscheduled,
    assignmentsFor,
    assignmentFor,
    bookedWindows,
    scheduledSidesFor,
    assignCourt,
    clearAssignment,
    assignedCourtIds,
    courtHasScheduledMatches,
  };
}

export type TournamentRepo = ReturnType<typeof createTournamentRepo>;
