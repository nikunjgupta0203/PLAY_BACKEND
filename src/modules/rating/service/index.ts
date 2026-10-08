/**
 * rating — service layer (docs/modules/08-rating.md).
 *
 * Glicko-2 per player per sport, written append-only, with `rankings` as a
 * cache rebuilt on write. THE ALGORITHM IS REPLACEABLE; THE LOG IS NOT.
 *
 * Two numbers exist and they are labelled differently (R2). The PROVISIONAL one
 * moves the instant a result is confirmed, because a player who just won wants
 * to see it. The SETTLED one is computed weekly over a whole rating period,
 * which is what Glicko-2 is actually defined over, and it is the only input to
 * a ranking. Both live in the same log so a player's history reads
 * continuously, and the settled row supersedes the provisional one rather than
 * overwriting it.
 *
 * Nothing here issues an UPDATE against another module's table: a player's
 * rating reaches `player_sports` only through `profile.applyRating()` (R12).
 */
import { SystemError, UserError } from '../../../platform/errors/index.js';
import type { Db, Tx } from '../../../platform/db.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import {
  ALGO_VERSION,
  UNRATED,
  decay,
  quantise,
  updateTeam,
  type Opponent,
  type Rating,
} from '../glicko2.js';
import type { RatingEventRow, RatingRepo } from '../repo/index.js';

export { ALGO_VERSION, UNRATED } from '../glicko2.js';

export const RatingCode = {
  /** R9 — fewer than five settled matches. */
  RATING_UNAVAILABLE: 'RATING_UNAVAILABLE',
  PERIOD_ALREADY_RUN: 'PERIOD_ALREADY_RUN',
  UNKNOWN_ALGO_VERSION: 'UNKNOWN_ALGO_VERSION',
  PERIOD_NOT_FOUND: 'PERIOD_NOT_FOUND',
} as const;

/** R9 — below this a profile reads *unranked* rather than a misleading number. */
export const RANKED_MINIMUM = 5;

/** R11 — how far a player must move before notifications care. */
export const MOVEMENT_THRESHOLD = 5;

/** The engines this build knows how to run. R8 — a replay names one of these. */
const ENGINES = new Set<string>([ALGO_VERSION]);

// --- scopes (R10) ------------------------------------------------------------

export type RankingScope =
  | { kind: 'national' }
  | { kind: 'city'; value: string }
  | { kind: 'age'; value: string };

/**
 * R10 — the scope vocabulary is closed, and this is the only place a scope
 * string is built. An open-ended scope is an unbounded table, and `rankings` is
 * a cache: a cache with no bound on its key count is a memory leak with a
 * primary key.
 */
export function scopeKey(scope: RankingScope): string {
  switch (scope.kind) {
    case 'national':
      return 'national';
    case 'city':
      return `city:${scope.value.trim()}`;
    case 'age':
      return `age:${scope.value.trim()}`;
  }
}

export function parseScope(key: string): RankingScope {
  if (key === 'national') return { kind: 'national' };
  if (key.startsWith('city:')) return { kind: 'city', value: key.slice(5) };
  if (key.startsWith('age:')) return { kind: 'age', value: key.slice(4) };
  throw new SystemError('INVALID_SCOPE', `${key} is not a ranking scope.`);
}

// --- domain ------------------------------------------------------------------

export interface RatingEvent {
  id: bigint;
  playerId: string;
  sportId: string;
  matchId: string | null;
  ratingBefore: number;
  ratingAfter: number;
  rdBefore: number;
  rdAfter: number;
  isProvisional: boolean;
  algoVersion: string;
  createdAt: Date;
}

export interface PlayerRating extends Rating {
  playerId: string;
  sportId: string;
  matchesPlayed: number;
  /** R2, R9 — true while the number is not fit to rank on. */
  provisional: boolean;
}

export interface RankingRow {
  rank: number;
  playerId: string;
  rating: number;
  matchesPlayed: number;
  movement: number;
}

/** Where one player stands on one board (rating R9, R11). */
export interface Standing {
  /** Null when the player is not on this board — unranked, or another city. */
  row: RankingRow | null;
  /** The place directly above; null at the top or when unranked. */
  next: { rank: number; rating: number } | null;
  /** The board's last rebuild; null for a board nobody is on yet. */
  updatedAt: Date | null;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// --- ports -------------------------------------------------------------------

/** One side of a match, resolved to the players whose ratings move. */
export interface MatchSide {
  registrationId: string;
  playerIds: string[];
}

/**
 * A confirmed result, as `scoring` will hand it over in Sprint 8.
 *
 * `outcome` is on this shape rather than filtered by the caller because R7 is
 * this module's rule: walkovers, retirements and forfeits do not affect either
 * player's rating, and the decision belongs where the rule is written.
 */
export interface ConfirmedResult {
  matchId: string;
  sportId: string;
  outcome: 'played' | 'walkover' | 'retired' | 'forfeit';
  /** For a draw, simply the two sides — neither won. */
  winner: MatchSide;
  loser: MatchSide;
  /** A league or group match that ended level: half a win each (Glicko's s = 0.5). */
  drawn?: boolean;
  confirmedAt: Date;
  /** F26 — false for a result nobody neutral or opposing confirmed, or from a tiny draw. Absent = true. */
  ratable?: boolean;
}

/**
 * What `rating` needs from `scoring`, and nothing more.
 *
 * scoring lands in Sprint 8. Until then this port has no production
 * implementation and the module is developed against the seeded tournament
 * fixture, exactly as the doc says — the same shape venues used for its court
 * scheduling port a sprint before tournament existed.
 */
export interface MatchesPort {
  confirmedResult(matchId: string): Promise<ConfirmedResult | null>;
  /** Every played result in a window — the rating period's input (R4). */
  confirmedBetween(sportId: string, from: Date, to: Date): Promise<ConfirmedResult[]>;
}

/** R12 — the ONLY way a rating reaches `player_sports`. */
export interface ProfilePort {
  applyRating(
    playerId: string,
    sportId: string,
    values: { rating: number; rd: number; volatility: number; matchesPlayed: number },
  ): Promise<unknown>;
  /** The cities a leaderboard is built per, and a player's own. */
  cityOf(playerId: string): Promise<string | null>;
}

/** An optional copy of the top of each board. A cache of a cache; may be absent. */
export interface BoardCachePort {
  put(key: string, rows: RankingRow[]): Promise<void>;
  get(key: string): Promise<RankingRow[] | null>;
  drop(key: string): Promise<void>;
}

export interface RatingDeps {
  db: Db;
  repo: RatingRepo;
  matches: MatchesPort;
  profile: ProfilePort;
  cache?: BoardCachePort;
  /** How many rows of each board are kept hot. The doc says 200. */
  cachedRows?: number;
  now?: () => Date;
}

const asRating = (row: RatingEventRow | null): Rating =>
  row
    ? { rating: row.ratingAfter, rd: row.rdAfter, volatility: row.volatilityAfter }
    : { ...UNRATED };

export function createRatingService(deps: RatingDeps) {
  const { db, repo, matches, profile, cache } = deps;
  const now = deps.now ?? (() => new Date());
  const cachedRows = deps.cachedRows ?? 200;

  // --- the provisional path (R3) ---------------------------------------------

  /**
   * R3 — the number that moves the moment a result is confirmed.
   *
   * Rated as a one-match rating period, which is a legitimate special case of
   * Glicko-2 rather than a different formula. The period job will rate the same
   * match again alongside its neighbours and write the settled row that
   * supersedes this one; both stay in the log.
   *
   * Idempotent: a redelivered `result.confirmed` finds the provisional rows
   * already written and changes nothing.
   */
  async function applyMatch(matchId: string): Promise<RatingEvent[]> {
    const result = await matches.confirmedResult(matchId);
    if (!result) return [];

    // R7 — only `played` reaches the engine. A walkover says nothing about how
    // well anybody plays, and rating it would punish a player for an opponent's
    // flat tyre.
    if (result.outcome !== 'played') {
      logger.info({ matchId, outcome: result.outcome }, 'rating skipped — not played');
      return [];
    }
    // F26 — confirmed by nobody, or from a draw too small to mean anything.
    if (result.ratable === false || !bothSidesRated(result)) {
      logger.info({ matchId }, 'rating skipped — not ratable');
      return [];
    }

    const already = await db.ratingEvent.count({ where: { matchId, isProvisional: true } });
    if (already > 0) return [];

    const written = await db.$transaction(async (tx) => {
      const winner = await sideRatings(tx, result.winner, result.sportId);
      const loser = await sideRatings(tx, result.loser, result.sportId);

      const won = result.drawn ? 0.5 : 1;
      const winnerAfter = updateTeam(winner.ratings, [opponentOf(loser.ratings, won)]);
      const loserAfter = updateTeam(loser.ratings, [opponentOf(winner.ratings, 1 - won)]);

      return [
        ...(await writeSide(tx, result, winner, winnerAfter, { provisional: true })),
        ...(await writeSide(tx, result, loser, loserAfter, { provisional: true })),
      ];
    });

    // R12 — the rating columns move through profile, outside the log's
    // transaction: a failure there must not lose the log entry, which is the
    // durable record. The period job repairs a divergence within the week.
    await pushToProfiles(written, result.sportId);
    return written.map(toEvent);
  }

  /**
   * scoring R8 (gap #18) — an organizer corrected a confirmed result. The
   * provisional preview for the match is taken back and the match rated again
   * as it now stands (a walkover, or a different winner).
   *
   * Only the preview is redone here. If the weekly period has already rated
   * the match, the settled history is what changed, and correcting that is a
   * replay (R8) — logged for staff rather than guessed at.
   */
  async function reapplyMatch(matchId: string): Promise<RatingEvent[]> {
    const result = await matches.confirmedResult(matchId);
    if (result) {
      const period = await repo.periodFor(result.sportId, weekStart(result.confirmedAt));
      if (period?.ranAt) {
        logger.warn({ matchId, periodId: period.id }, 'corrected result already settled — needs a rating replay');
        return [];
      }
    }

    const old = await db.ratingEvent.findMany({ where: { matchId, isProvisional: true } });
    if (old.length > 0) await db.ratingEvent.deleteMany({ where: { matchId, isProvisional: true } });

    const written = await applyMatch(matchId);
    // Players the old preview moved who are not in the new one go back to
    // their settled number.
    const stillRated = new Set(written.map((w) => w.playerId));
    for (const row of old) {
      if (stillRated.has(row.playerId)) continue;
      const settled = asRating(await repo.lastSettled(db, row.playerId, row.sportId));
      try {
        await profile.applyRating(row.playerId, row.sportId, {
          rating: settled.rating,
          rd: settled.rd,
          volatility: settled.volatility,
          matchesPlayed: await repo.countSettledMatches(db, row.playerId, row.sportId),
        });
      } catch (err) {
        logger.warn({ err, playerId: row.playerId }, 'applyRating skipped after correction');
      }
    }
    return written;
  }

  /**
   * The opposing team as the engine sees it: one composite competitor, with the
   * score this side achieved against it.
   */
  /** A side with no rated players (a walk-in guest, a deleted account) means the match is not rated. */
  function bothSidesRated(r: ConfirmedResult): boolean {
    return r.winner.playerIds.length > 0 && r.loser.playerIds.length > 0;
  }

  function opponentOf(members: Rating[], score: number): Opponent {
    const mean = members.reduce((s, m) => s + m.rating, 0) / members.length;
    const rms = Math.sqrt(members.reduce((s, m) => s + m.rd * m.rd, 0) / members.length);
    return { rating: mean, rd: rms, score };
  }

  interface SideState {
    playerIds: string[];
    ratings: Rating[];
  }

  async function sideRatings(tx: Tx, side: MatchSide, sportId: string): Promise<SideState> {
    const ratings: Rating[] = [];
    for (const playerId of side.playerIds) {
      ratings.push(asRating(await repo.lastSettled(tx, playerId, sportId)));
    }
    return { playerIds: side.playerIds, ratings };
  }

  async function writeSide(
    tx: Tx,
    result: ConfirmedResult,
    before: SideState,
    after: Rating[],
    opts: { provisional: boolean; periodId?: string },
  ): Promise<RatingEventRow[]> {
    const rows: RatingEventRow[] = [];
    for (const [i, playerId] of before.playerIds.entries()) {
      const from = before.ratings[i]!;
      const to = quantise(after[i]!);
      rows.push(
        await repo.insertEvent(tx, {
          playerId,
          sportId: result.sportId,
          matchId: result.matchId,
          ratingPeriodId: opts.periodId ?? null,
          algoVersion: ALGO_VERSION,
          ratingBefore: from.rating,
          ratingAfter: to.rating,
          rdBefore: from.rd,
          rdAfter: to.rd,
          volatilityAfter: to.volatility,
          // A provisional row covers exactly the one match it previews. It is
          // excluded from the settled sum, so it never inflates R9's count.
          matchesPlayed: 1,
          isProvisional: opts.provisional,
        }),
      );
      await outboxWrite(tx, {
        topic: 'rating.changed',
        payload: {
          playerId,
          sportId: result.sportId,
          matchId: result.matchId,
          ratingBefore: from.rating,
          ratingAfter: to.rating,
          isProvisional: opts.provisional,
        },
      });
    }
    return rows;
  }

  /** R12 — every rating column write in this module goes through here. */
  async function pushToProfiles(rows: RatingEventRow[], sportId: string): Promise<void> {
    for (const row of rows) {
      const matchesPlayed = await repo.countSettledMatches(db, row.playerId, sportId);
      try {
        await profile.applyRating(row.playerId, sportId, {
          rating: row.ratingAfter,
          rd: row.rdAfter,
          volatility: row.volatilityAfter,
          matchesPlayed,
        });
      } catch (err) {
        // The player may not have selected this sport. The log is still right,
        // and the next period run reconciles it.
        logger.warn({ err, playerId: row.playerId, sportId }, 'applyRating skipped');
      }
    }
  }

  // --- the settled path (R4) -------------------------------------------------

  /**
   * R4 — the weekly rating period, over every match confirmed since the last
   * one.
   *
   * This is the number Glicko-2 is actually defined over: a player's whole card
   * for the week is rated in one update from their position at the start of it,
   * not match by match. Rating four matches one at a time gives a different
   * answer from rating them together, and the together answer is the correct
   * one.
   *
   * The claim on `ran_at` is a conditional UPDATE, so a second worker that
   * picked the same period up gets PERIOD_ALREADY_RUN rather than rating
   * everyone twice. The whole period is one transaction: a retry after a
   * partial run finds nothing half-written.
   */
  async function runPeriod(periodId: string): Promise<{ playersUpdated: number }> {
    const period = await repo.periodById(periodId);
    if (!period) {
      throw new SystemError(RatingCode.PERIOD_NOT_FOUND, `No rating period ${periodId}`);
    }
    if (period.ranAt) {
      throw new SystemError(
        RatingCode.PERIOD_ALREADY_RUN,
        `Rating period ${periodId} ran at ${period.ranAt.toISOString()}`,
      );
    }
    if (!ENGINES.has(period.algoVersion)) {
      throw new SystemError(
        RatingCode.UNKNOWN_ALGO_VERSION,
        `This build cannot run ${period.algoVersion}`,
      );
    }

    const written = await db.$transaction(async (tx) => {
      if (!(await repo.claimPeriod(tx, periodId, now()))) {
        throw new SystemError(RatingCode.PERIOD_ALREADY_RUN, `Period ${periodId} was claimed`);
      }
      return settle(tx, period.sportId, period.startsAt, period.endsAt, periodId);
    });

    await pushToProfiles(written, period.sportId);
    return { playersUpdated: written.length };
  }

  /**
   * The period arithmetic, shared by `runPeriod` and `replay`.
   *
   * Every player who competed gets ONE update built from every opponent they
   * faced, starting from the rating they carried into the period. A player who
   * did not compete is not touched here — their deviation grows through
   * `decay()` when they next appear, which keeps the log free of a row per
   * absent player per week.
   */
  async function settle(
    tx: Tx,
    sportId: string,
    from: Date,
    to: Date,
    periodId: string,
  ): Promise<RatingEventRow[]> {
    const results = (await matches.confirmedBetween(sportId, from, to)).filter(
      // R7, again and on purpose: the period is a second door into the engine,
      // and a rule enforced at one door only is a rule with a hole in it.
      (r) => r.outcome === 'played' && r.ratable !== false && bothSidesRated(r),
    );
    if (results.length === 0) return [];

    const playerIds = [
      ...new Set(results.flatMap((r) => [...r.winner.playerIds, ...r.loser.playerIds])),
    ];
    const opening = await repo.lastSettledForAll(tx, sportId, playerIds);
    const start = new Map<string, Rating>(
      playerIds.map((id) => [id, asRating(opening.get(id) ?? null)]),
    );

    // Each player's card for the period: the composite opponent they faced in
    // every match, scored from their side.
    const cards = new Map<string, Opponent[]>(playerIds.map((id) => [id, []]));
    const partners = new Map<string, string[]>(playerIds.map((id) => [id, []]));
    const played = new Map<string, number>(playerIds.map((id) => [id, 0]));
    const lastMatch = new Map<string, string>();

    for (const result of results) {
      for (const [side, other, score] of [
        [result.winner, result.loser, result.drawn ? 0.5 : 1],
        [result.loser, result.winner, result.drawn ? 0.5 : 0],
      ] as const) {
        const opponent = opponentOf(
          other.playerIds.map((id) => start.get(id)!),
          score,
        );
        for (const playerId of side.playerIds) {
          cards.get(playerId)!.push(opponent);
          played.set(playerId, played.get(playerId)! + 1);
          lastMatch.set(playerId, result.matchId);
          for (const mate of side.playerIds) {
            if (mate !== playerId) partners.get(playerId)!.push(mate);
          }
        }
      }
    }

    // A player is rated as their own team over the period. For singles that is
    // a team of one and the split is the identity; for doubles the share still
    // has to reflect who the pair was, so it is taken against the partners
    // actually played with (R5).
    const rows: RatingEventRow[] = [];
    for (const playerId of playerIds) {
      const before = start.get(playerId)!;
      const card = cards.get(playerId)!;
      const mates = [...new Set(partners.get(playerId)!)].map((id) => start.get(id)!);
      const after = quantise(
        mates.length === 0
          ? updateTeam([before], card)[0]!
          : updateTeam([before, ...mates], card)[0]!,
      );

      rows.push(
        await repo.insertEvent(tx, {
          playerId,
          sportId,
          matchId: null,
          ratingPeriodId: periodId,
          algoVersion: ALGO_VERSION,
          ratingBefore: before.rating,
          ratingAfter: after.rating,
          rdBefore: before.rd,
          rdAfter: after.rd,
          volatilityAfter: after.volatility,
          // R9 counts MATCHES, not weeks: one settled row covers a whole card,
          // so it carries how many matches that card was.
          matchesPlayed: played.get(playerId) ?? 0,
          isProvisional: false,
        }),
      );
      await outboxWrite(tx, {
        topic: 'rating.changed',
        payload: {
          playerId,
          sportId,
          matchId: null,
          ratingBefore: before.rating,
          ratingAfter: after.rating,
          isProvisional: false,
        },
      });
    }
    return rows;
  }

  /**
   * Opens the period covering `at`, or returns the one already open. Weeks run
   * Monday to Monday in IST, because that is when the job runs (R4).
   */
  async function periodFor(sportId: string, at: Date): Promise<{ id: string; startsAt: Date }> {
    const startsAt = weekStart(at);
    const existing = await repo.periodFor(sportId, startsAt);
    if (existing) return existing;
    return repo.insertPeriod({
      id: newId(),
      sportId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 7 * 86_400_000),
      ranAt: null,
      algoVersion: ALGO_VERSION,
    });
  }

  // --- rankings (R9, R10, R11) -----------------------------------------------

  /**
   * R11 — rank and movement are STORED, so the leaderboard's up/down arrow
   * costs no second query. Movement is the previous rank minus the new one:
   * positive is up, which is the direction the arrow points.
   */
  async function rebuildRankings(
    sportId: string,
    scope: RankingScope,
  ): Promise<{ ranked: number }> {
    const key = scopeKey(scope);
    const at = now();
    const ranked = await repo.rebuild(
      {
        sportId,
        scope: key,
        city: scope.kind === 'city' ? scope.value : null,
        minMatches: RANKED_MINIMUM,
      },
      at,
    );

    // Anyone the rebuild did not touch is no longer on this board.
    await repo.pruneStale(sportId, key, at);

    const top = await repo.board(sportId, key, { limit: cachedRows });
    const rows = top.map(toRankingRow);
    await cache?.put(cacheKey(sportId, key), rows).catch((err: unknown) => {
      // The board is served from Postgres when the cache is not there. A cold cache
      // is slower; a wrong one would be worse.
      logger.warn({ err, sportId, scope: key }, 'ranking cache write failed');
    });

    for (const row of rows) {
      if (Math.abs(row.movement) >= MOVEMENT_THRESHOLD) {
        await outboxWrite(db, {
          topic: 'ranking.moved',
          payload: {
            playerId: row.playerId,
            sportId,
            scope: key,
            rank: row.rank,
            movement: row.movement,
          },
        });
      }
    }

    return { ranked: rows.length === 0 ? 0 : Math.max(ranked, 0) };
  }

  /** Every board a rebuild has to touch after a period: national and each city. */
  async function rebuildAll(sportId: string): Promise<{ boards: number }> {
    const cities = await db.$queryRaw<{ city: string }[]>`
      SELECT DISTINCT pp.city AS city
        FROM player_sports ps
        JOIN player_profiles pp ON pp.id = ps.player_id
       WHERE ps.sport_id = ${sportId}::uuid
         AND ps.matches_played >= ${RANKED_MINIMUM}
         AND ps.is_provisional = false
         AND pp.city IS NOT NULL
    `;

    await rebuildRankings(sportId, { kind: 'national' });
    for (const { city } of cities) {
      await rebuildRankings(sportId, { kind: 'city', value: city });
    }
    return { boards: cities.length + 1 };
  }

  /** R11 — the viewer's own place, read straight from Postgres (never the cache). */
  async function myStanding(sportId: string, scope: RankingScope, playerId: string): Promise<Standing> {
    const key = scopeKey(scope);
    const [mine, updatedAt] = await Promise.all([
      repo.rankOf(sportId, key, playerId),
      repo.boardComputedAt(sportId, key),
    ]);
    if (!mine) return { row: null, next: null, updatedAt };
    const above = await repo.rowAbove(sportId, key, mine.rank);
    return {
      row: toRankingRow(mine),
      next: above ? { rank: above.rank, rating: above.rating } : null,
      updatedAt,
    };
  }

  /** A player's place on one board, or null when they are not on it. */
  async function rankFor(sportId: string, scope: RankingScope, playerId: string): Promise<number | null> {
    const row = await repo.rankOf(sportId, scopeKey(scope), playerId);
    return row?.rank ?? null;
  }

  async function leaderboard(
    sportId: string,
    scope: RankingScope,
    page: { first: number; after?: string | null },
  ): Promise<Page<RankingRow>> {
    const key = scopeKey(scope);
    const first = Math.min(Math.max(page.first, 1), 100);
    const after = page.after ? Number(page.after) : null;

    // The hot copy answers the first page of every board, which is the page
    // almost everybody asks for. Deep pages fall through to Postgres.
    if (!after && cache) {
      const hot = await cache.get(cacheKey(sportId, key)).catch(() => null);
      if (hot && hot.length >= Math.min(first + 1, cachedRows)) {
        const nodes = hot.slice(0, first);
        return {
          nodes,
          hasNextPage: hot.length > first,
          endCursor: nodes.at(-1)?.rank.toString() ?? null,
        };
      }
    }

    const rows = await repo.board(sportId, key, { after, limit: first + 1 });
    const nodes = rows.slice(0, first).map(toRankingRow);
    return {
      nodes,
      hasNextPage: rows.length > first,
      endCursor: nodes.at(-1)?.rank.toString() ?? null,
    };
  }

  // --- reads -----------------------------------------------------------------

  /**
   * R2, R9 — the settled rating, and honest about whether it means anything
   * yet. Fewer than five settled matches is `provisional: true`, which the UI
   * renders as *unranked* rather than as a number.
   */
  async function ratingFor(playerId: string, sportId: string): Promise<PlayerRating> {
    const last = await repo.lastSettled(db, playerId, sportId);
    const matchesPlayed = await repo.countSettledMatches(db, playerId, sportId);
    const rating = asRating(last);
    return {
      playerId,
      sportId,
      ...rating,
      matchesPlayed,
      provisional: matchesPlayed < RANKED_MINIMUM,
    };
  }

  /** R9 — asking for a rating that is not fit to show is an error, not a zero. */
  async function rankedRatingFor(playerId: string, sportId: string): Promise<PlayerRating> {
    const found = await ratingFor(playerId, sportId);
    if (found.provisional) {
      throw new UserError(
        RatingCode.RATING_UNAVAILABLE,
        `A rating needs ${RANKED_MINIMUM} matches. This one has ${found.matchesPlayed}.`,
      );
    }
    return found;
  }

  async function historyFor(
    playerId: string,
    sportId: string,
    page: { first: number; after?: string | null },
  ): Promise<Page<RatingEvent>> {
    const first = Math.min(Math.max(page.first, 1), 100);
    const rows = await repo.historyFor(playerId, sportId, {
      after: page.after ? BigInt(page.after) : null,
      limit: first + 1,
    });
    const nodes = rows.slice(0, first).map(toEvent);
    return {
      nodes,
      hasNextPage: rows.length > first,
      endCursor: nodes.at(-1)?.id.toString() ?? null,
    };
  }

  // --- replay (R8) -----------------------------------------------------------

  /**
   * R8 — the whole point of the append-only design.
   *
   * Replacing the model means writing a new engine, registering its version and
   * replaying, rather than migrating stored numbers that no longer mean what
   * they meant. Under the SAME version it is a determinism check: every settled
   * row is recomputed from the same inputs in the same order, and must land on
   * the same number to the last decimal. If it does not, "swappable algorithm"
   * was a claim rather than a property.
   */
  async function replay(
    sportId: string,
    fromDate: Date,
    algoVersion: string = ALGO_VERSION,
  ): Promise<{ periods: number; playersUpdated: number }> {
    if (!ENGINES.has(algoVersion)) {
      throw new SystemError(
        RatingCode.UNKNOWN_ALGO_VERSION,
        `This build cannot run ${algoVersion}`,
      );
    }

    const periods = await repo.periodsFrom(sportId, fromDate);
    const periodIds = periods.map((p) => p.id);
    let playersUpdated = 0;

    const written = await db.$transaction(async (tx) => {
      // The settled rows for these periods are about to be recomputed, so they
      // are addressed by PERIOD rather than by date: a row's `created_at` is
      // when the job ran, which for a late or re-run period is not when the
      // matches were played.
      //
      // Provisional rows are left alone. They are a record of what a player was
      // shown at the time, and rewriting that is not what replay means.
      await repo.deleteSettledForPeriods(tx, sportId, periodIds);
      await repo.unclaimPeriods(tx, periodIds);

      const all: RatingEventRow[] = [];
      for (const period of periods) {
        if (!(await repo.claimPeriod(tx, period.id, now()))) continue;
        const rows = await settle(tx, sportId, period.startsAt, period.endsAt, period.id);
        all.push(...rows);
      }
      return all;
    });

    playersUpdated = written.length;
    await pushToProfiles(written, sportId);
    return { periods: periods.length, playersUpdated };
  }

  // --- helpers ---------------------------------------------------------------

  const cacheKey = (sportId: string, scope: string): string => `rankings:${sportId}:${scope}`;

  const toEvent = (r: RatingEventRow): RatingEvent => ({
    id: r.id,
    playerId: r.playerId,
    sportId: r.sportId,
    matchId: r.matchId,
    ratingBefore: r.ratingBefore,
    ratingAfter: r.ratingAfter,
    rdBefore: r.rdBefore,
    rdAfter: r.rdAfter,
    isProvisional: r.isProvisional,
    algoVersion: r.algoVersion,
    createdAt: r.createdAt,
  });

  const toRankingRow = (r: {
    rank: number;
    playerId: string;
    rating: number;
    matchesPlayed: number;
    movement: number;
  }): RankingRow => ({
    rank: r.rank,
    playerId: r.playerId,
    rating: r.rating,
    matchesPlayed: r.matchesPlayed,
    movement: r.movement,
  });

  return {
    applyMatch,
    reapplyMatch,
    runPeriod,
    periodFor,
    rebuildRankings,
    rebuildAll,
    leaderboard,
    myStanding,
    rankFor,
    ratingFor,
    rankedRatingFor,
    historyFor,
    replay,
    scopeKey,
    /** Exposed for the worker's inactivity sweep and for tests. */
    decay,
  };
}

/**
 * R4 — periods are Monday-to-Monday in IST, because that is when the job runs.
 * Computed in UTC against the IST offset rather than with a timezone library:
 * India has one offset and has never observed daylight saving.
 */
const IST_OFFSET_MS = 5.5 * 3_600_000;

export function weekStart(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay(); // 0 Sunday … 1 Monday
  const daysSinceMonday = (day + 6) % 7;
  const midnightIst = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate() - daysSinceMonday,
  );
  // 03:00 IST on that Monday, expressed as the UTC instant it happens at.
  return new Date(midnightIst + 3 * 3_600_000 - IST_OFFSET_MS);
}

export type RatingService = ReturnType<typeof createRatingService>;
