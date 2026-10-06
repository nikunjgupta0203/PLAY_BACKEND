/**
 * rating — repository (conventions.md §1).
 *
 * `rating_events` is APPEND-ONLY. There is deliberately no update method on it:
 * a rating is superseded by a later row, never edited, which is what makes R8's
 * "replace the model by replaying the log" true rather than aspirational.
 *
 * `rankings` is the opposite — a derived cache, rebuilt in one statement.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';

export interface RatingEventRow {
  id: bigint;
  playerId: string;
  sportId: string;
  matchId: string | null;
  ratingPeriodId: string | null;
  algoVersion: string;
  ratingBefore: number;
  ratingAfter: number;
  rdBefore: number;
  rdAfter: number;
  volatilityAfter: number;
  matchesPlayed: number;
  isProvisional: boolean;
  createdAt: Date;
}

export interface PeriodRow {
  id: string;
  sportId: string;
  startsAt: Date;
  endsAt: Date;
  ranAt: Date | null;
  algoVersion: string;
}

export interface RankingRow {
  sportId: string;
  scope: string;
  playerId: string;
  rank: number;
  rating: number;
  matchesPlayed: number;
  movement: number;
  computedAt: Date;
}

/** Every number in this module is decimal in the database and float in TS. */
const num = (v: Prisma.Decimal | number | null): number => (v === null ? 0 : Number(v));

export function createRatingRepo(db: Db) {
  // --- the log ---------------------------------------------------------------

  async function insertEvent(
    tx: Tx | Db,
    row: Omit<RatingEventRow, 'id' | 'createdAt'> & { createdAt?: Date },
  ): Promise<RatingEventRow> {
    const created = await tx.ratingEvent.create({
      data: {
        playerId: row.playerId,
        sportId: row.sportId,
        matchId: row.matchId,
        ratingPeriodId: row.ratingPeriodId,
        algoVersion: row.algoVersion,
        ratingBefore: row.ratingBefore,
        ratingAfter: row.ratingAfter,
        rdBefore: row.rdBefore,
        rdAfter: row.rdAfter,
        volatilityAfter: row.volatilityAfter,
        matchesPlayed: row.matchesPlayed,
        isProvisional: row.isProvisional,
        ...(row.createdAt ? { createdAt: row.createdAt } : {}),
      },
    });
    return toEvent(created);
  }

  /**
   * The rating a player carries INTO a calculation: the most recent SETTLED
   * row.
   *
   * Provisional rows are excluded on purpose. They are a preview of one match's
   * effect, and feeding a preview back in as an input would compound it — the
   * period job would rate the same match twice, once through the log and once
   * through the starting position (R3).
   */
  async function lastSettled(
    tx: Tx | Db,
    playerId: string,
    sportId: string,
  ): Promise<RatingEventRow | null> {
    const row = await tx.ratingEvent.findFirst({
      where: { playerId, sportId, isProvisional: false },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? toEvent(row) : null;
  }

  /** The same, for the whole field at once — the period job's opening read. */
  async function lastSettledForAll(
    tx: Tx | Db,
    sportId: string,
    playerIds: string[],
  ): Promise<Map<string, RatingEventRow>> {
    if (playerIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      {
        id: bigint;
        player_id: string;
        rating_after: Prisma.Decimal;
        rd_after: Prisma.Decimal;
        volatility_after: Prisma.Decimal;
        created_at: Date;
        algo_version: string;
      }[]
    >`
      SELECT DISTINCT ON (player_id)
             id, player_id, rating_after, rd_after, volatility_after,
             created_at, algo_version
        FROM rating_events
       WHERE sport_id = ${sportId}::uuid
         AND is_provisional = false
         AND player_id = ANY(${playerIds}::uuid[])
       ORDER BY player_id, created_at DESC, id DESC
    `;
    const out = new Map<string, RatingEventRow>();
    for (const r of rows) {
      out.set(r.player_id, {
        id: r.id,
        playerId: r.player_id,
        sportId,
        matchId: null,
        ratingPeriodId: null,
        algoVersion: r.algo_version,
        ratingBefore: 0,
        ratingAfter: num(r.rating_after),
        rdBefore: 0,
        rdAfter: num(r.rd_after),
        volatilityAfter: num(r.volatility_after),
        matchesPlayed: 0,
        isProvisional: false,
        createdAt: r.created_at,
      });
    }
    return out;
  }

  async function historyFor(
    playerId: string,
    sportId: string,
    page: { after?: bigint | null; limit: number },
  ): Promise<RatingEventRow[]> {
    const rows = await db.ratingEvent.findMany({
      where: {
        playerId,
        sportId,
        ...(page.after ? { id: { lt: page.after } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit,
    });
    return rows.map(toEvent);
  }

  /** Everything ever written for a sport, oldest first — the replay input. */
  async function allEvents(sportId: string): Promise<RatingEventRow[]> {
    const rows = await db.ratingEvent.findMany({
      where: { sportId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toEvent);
  }

  /** R8 — a replay under a new engine drops what the old engine settled. */
  async function deleteSettledForPeriods(
    tx: Tx | Db,
    sportId: string,
    periodIds: string[],
  ): Promise<number> {
    if (periodIds.length === 0) return 0;
    const { count } = await tx.ratingEvent.deleteMany({
      where: { sportId, isProvisional: false, ratingPeriodId: { in: periodIds } },
    });
    return count;
  }

  /**
   * R9 — how many matches a player has SETTLED in a sport.
   *
   * A sum rather than a count: one settled row covers a whole rating period, so
   * counting rows would count weeks. Derived entirely from the log, which is
   * what lets a replay reproduce it along with everything else.
   */
  async function countSettledMatches(
    tx: Tx | Db,
    playerId: string,
    sportId: string,
  ): Promise<number> {
    const { _sum } = await tx.ratingEvent.aggregate({
      _sum: { matchesPlayed: true },
      where: { playerId, sportId, isProvisional: false },
    });
    return _sum.matchesPlayed ?? 0;
  }

  // --- periods ---------------------------------------------------------------

  async function insertPeriod(row: PeriodRow): Promise<PeriodRow> {
    const created = await db.ratingPeriod.create({ data: row });
    return created;
  }

  async function periodById(id: string): Promise<PeriodRow | null> {
    return db.ratingPeriod.findUnique({ where: { id } });
  }

  async function periodFor(sportId: string, startsAt: Date): Promise<PeriodRow | null> {
    return db.ratingPeriod.findUnique({
      where: { sportId_startsAt: { sportId, startsAt } },
    });
  }

  /**
   * Every period a replay from `from` has to redo — including the one `from`
   * falls inside. Selecting on `starts_at >= from` would silently skip the
   * current week, which is the week most likely to be the reason for a replay.
   */
  async function periodsFrom(sportId: string, from: Date): Promise<PeriodRow[]> {
    return db.ratingPeriod.findMany({
      where: { sportId, endsAt: { gt: from } },
      orderBy: { startsAt: 'asc' },
    });
  }

  /**
   * Claims the period for this run. A conditional UPDATE, so two workers that
   * both picked it up cannot both believe they ran it: the loser gets zero rows
   * and raises PERIOD_ALREADY_RUN.
   */
  async function claimPeriod(tx: Tx | Db, periodId: string, at: Date): Promise<boolean> {
    const affected = await tx.$executeRaw`
      UPDATE rating_periods SET ran_at = ${at}
       WHERE id = ${periodId}::uuid AND ran_at IS NULL
    `;
    return affected > 0;
  }

  /** A replay re-runs periods that have already run, so it unclaims them. */
  async function unclaimPeriods(tx: Tx | Db, periodIds: string[]): Promise<void> {
    if (periodIds.length === 0) return;
    await tx.ratingPeriod.updateMany({
      where: { id: { in: periodIds } },
      data: { ranAt: null },
    });
  }

  // --- rankings --------------------------------------------------------------

  /**
   * rating R9, R11 — the rebuild, as one statement.
   *
   * `dense_rank()` because two players on the same rating are both in that
   * place, and `movement` is the previous rank minus the new one, so a positive
   * number means "up", which is the direction the arrow points.
   *
   * The `matches_played >= 5` filter is R9: below that the profile shows
   * *unranked* rather than a number nobody should act on. `is_provisional` is
   * the same rule from the other side — a settled rating or no rating at all.
   *
   * A city scope adds one predicate; a national scope adds none. Everything
   * else about the statement is identical, which is why the scope vocabulary is
   * closed (R10).
   */
  async function rebuild(
    scope: { sportId: string; scope: string; city: string | null; minMatches: number },
    at: Date,
  ): Promise<number> {
    const cityFilter = scope.city
      ? Prisma.sql`AND pp.city = ${scope.city}`
      : Prisma.empty;

    const affected = await db.$executeRaw`
      INSERT INTO rankings (sport_id, scope, player_id, rank, rating,
                            matches_played, movement, computed_at)
      SELECT ${scope.sportId}::uuid,
             ${scope.scope},
             ps.player_id,
             dense_rank() OVER (ORDER BY ps.rating DESC NULLS LAST),
             ps.rating,
             ps.matches_played,
             coalesce(prev.rank, dense_rank() OVER (ORDER BY ps.rating DESC NULLS LAST))
               - dense_rank() OVER (ORDER BY ps.rating DESC NULLS LAST),
             ${at}
        FROM player_sports ps
        JOIN player_profiles pp ON pp.id = ps.player_id
        LEFT JOIN rankings prev
          ON prev.sport_id = ${scope.sportId}::uuid
         AND prev.scope = ${scope.scope}
         AND prev.player_id = ps.player_id
       WHERE ps.sport_id = ${scope.sportId}::uuid
         AND ps.matches_played >= ${scope.minMatches}
         AND ps.is_provisional = false
         AND ps.rating IS NOT NULL
         ${cityFilter}
      ON CONFLICT (sport_id, scope, player_id) DO UPDATE
         SET rank = EXCLUDED.rank,
             rating = EXCLUDED.rating,
             matches_played = EXCLUDED.matches_played,
             movement = EXCLUDED.movement,
             computed_at = EXCLUDED.computed_at
    `;
    return affected;
  }

  /**
   * A player who fell below the bar — retired, or the minimum moved — must
   * leave the board rather than sit on it at a stale rank.
   */
  async function pruneStale(sportId: string, scope: string, at: Date): Promise<number> {
    const { count } = await db.ranking.deleteMany({
      where: { sportId, scope, computedAt: { lt: at } },
    });
    return count;
  }

  async function board(
    sportId: string,
    scope: string,
    page: { after?: number | null; limit: number },
  ): Promise<RankingRow[]> {
    const rows = await db.ranking.findMany({
      where: { sportId, scope, ...(page.after ? { rank: { gt: page.after } } : {}) },
      orderBy: [{ rank: 'asc' }, { playerId: 'asc' }],
      take: page.limit,
    });
    return rows.map(toRanking);
  }

  async function rankOf(
    sportId: string,
    scope: string,
    playerId: string,
  ): Promise<RankingRow | null> {
    const row = await db.ranking.findUnique({
      where: { sportId_scope_playerId: { sportId, scope, playerId } },
    });
    return row ? toRanking(row) : null;
  }

  /** The nearest place above `rank` on a board — ranks are dense, so it is rank − 1. */
  async function rowAbove(sportId: string, scope: string, rank: number): Promise<RankingRow | null> {
    const row = await db.ranking.findFirst({
      where: { sportId, scope, rank: { lt: rank } },
      orderBy: [{ rank: 'desc' }, { playerId: 'asc' }],
    });
    return row ? toRanking(row) : null;
  }

  /** When the board was last rebuilt; null for a board that has never had anyone on it. */
  async function boardComputedAt(sportId: string, scope: string): Promise<Date | null> {
    const agg = await db.ranking.aggregate({ where: { sportId, scope }, _max: { computedAt: true } });
    return agg._max.computedAt;
  }

  const toEvent = (r: {
    id: bigint;
    playerId: string;
    sportId: string;
    matchId: string | null;
    ratingPeriodId: string | null;
    algoVersion: string;
    ratingBefore: Prisma.Decimal;
    ratingAfter: Prisma.Decimal;
    rdBefore: Prisma.Decimal;
    rdAfter: Prisma.Decimal;
    volatilityAfter: Prisma.Decimal;
    matchesPlayed: number;
    isProvisional: boolean;
    createdAt: Date;
  }): RatingEventRow => ({
    id: r.id,
    playerId: r.playerId,
    sportId: r.sportId,
    matchId: r.matchId,
    ratingPeriodId: r.ratingPeriodId,
    algoVersion: r.algoVersion,
    ratingBefore: num(r.ratingBefore),
    ratingAfter: num(r.ratingAfter),
    rdBefore: num(r.rdBefore),
    rdAfter: num(r.rdAfter),
    volatilityAfter: num(r.volatilityAfter),
    matchesPlayed: r.matchesPlayed,
    isProvisional: r.isProvisional,
    createdAt: r.createdAt,
  });

  const toRanking = (r: {
    sportId: string;
    scope: string;
    playerId: string;
    rank: number;
    rating: Prisma.Decimal;
    matchesPlayed: number;
    movement: number;
    computedAt: Date;
  }): RankingRow => ({
    sportId: r.sportId,
    scope: r.scope,
    playerId: r.playerId,
    rank: r.rank,
    rating: num(r.rating),
    matchesPlayed: r.matchesPlayed,
    movement: r.movement,
    computedAt: r.computedAt,
  });

  return {
    insertEvent,
    lastSettled,
    lastSettledForAll,
    historyFor,
    allEvents,
    deleteSettledForPeriods,
    countSettledMatches,
    insertPeriod,
    periodById,
    periodFor,
    periodsFrom,
    claimPeriod,
    unclaimPeriods,
    rebuild,
    pruneStale,
    board,
    rankOf,
    rowAbove,
    boardComputedAt,
  };
}

export type RatingRepo = ReturnType<typeof createRatingRepo>;
