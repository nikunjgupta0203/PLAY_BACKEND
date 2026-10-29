/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { profile } from '../profile/index.js';
import { createRatingRepo } from './repo/index.js';
import {
  createRatingService,
  type ConfirmedResult,
  type MatchesPort,
  type MatchSide,
} from './service/index.js';

/**
 * `matches` and `match_results` belong to `tournament` and `scoring`; rating
 * asks rather than reads (conventions.md §1 — table ownership is exclusive).
 *
 * Loaded lazily: scoring → tournament → rating is already an import chain, and
 * a static import back into scoring from here would close it into a cycle that
 * leaves one side's singleton undefined at module scope.
 */
async function sidesOf(result: {
  matchId: string;
  winnerRegistrationId: string | null;
  loserRegistrationId: string | null;
}): Promise<{ winner: MatchSide; loser: MatchSide; drawn: boolean } | null> {
  // A draw names neither side; the match does.
  let pair: [string, string] | null = null;
  if (result.winnerRegistrationId === null) {
    const { tournament } = await import('../tournament/index.js');
    const match = await tournament.matchById(result.matchId).catch(() => null);
    if (match?.sideARegistrationId && match.sideBRegistrationId) {
      pair = [match.sideARegistrationId, match.sideBRegistrationId];
    }
  } else if (result.loserRegistrationId) {
    pair = [result.winnerRegistrationId, result.loserRegistrationId];
  }
  if (!pair) return null;
  const { registration } = await import('../registration/index.js');
  const side = async (registrationId: string): Promise<MatchSide> => {
    const team = await registration.teamFor(registrationId);
    const userIds =
      team.length > 0
        ? team.map((m) => m.userId)
        : [(await registration.findById(registrationId))?.captainUserId].filter(
            (id): id is string => typeof id === 'string',
          );
    const playerIds: string[] = [];
    for (const userId of userIds) {
      const player = await profile.findByUserId(userId);
      if (player) playerIds.push(player.id);
    }
    // A walk-in guest (F20) or a deleted account has no player profile. Such
    // a side is not rated at all: half a team is not the team that played,
    // and a guest the host typed in is nobody's rating to beat.
    return { registrationId, playerIds: userIds.length > 0 && playerIds.length === userIds.length ? playerIds : [] };
  };
  return {
    winner: await side(pair[0]),
    loser: await side(pair[1]),
    drawn: result.winnerRegistrationId === null,
  };
}

/**
 * F26 — whether a result may move a rating. Every match is ranked (v1.0 issue
 * list): any confirmed result is, whatever the size of its draw, except a
 * dispute nobody settled.
 */
async function ratable(result: { matchId: string; confirmedVia: string | null; submitterRole: string }): Promise<boolean> {
  const { isRatable } = await import('../scoring/finality.js');
  return isRatable(result);
}

/**
 * games R19 — a confirmed casual result, as rating sees a match. Its sides
 * are user ids; a side with anyone who has no player profile is not rated,
 * exactly as a tournament side with a walk-in guest is not.
 */
async function casualResult(r: {
  id: string;
  sportId: string;
  sideA: string[];
  sideB: string[];
  winner: 'a' | 'b' | null;
  confirmedAt: Date | null;
}): Promise<ConfirmedResult | null> {
  if (!r.confirmedAt) return null;
  const side = async (key: 'a' | 'b', userIds: string[]): Promise<MatchSide> => {
    const playerIds: string[] = [];
    for (const userId of userIds) {
      const player = await profile.findByUserId(userId);
      if (player) playerIds.push(player.id);
    }
    return { registrationId: `${r.id}:${key}`, playerIds: playerIds.length === userIds.length ? playerIds : [] };
  };
  const a = await side('a', r.sideA);
  const b = await side('b', r.sideB);
  return {
    matchId: r.id,
    sportId: r.sportId,
    outcome: 'played',
    confirmedAt: r.confirmedAt,
    ratable: true,
    winner: r.winner === 'b' ? b : a,
    loser: r.winner === 'b' ? a : b,
    drawn: r.winner === null,
  };
}

const matches: MatchesPort = {
  async confirmedResult(matchId) {
    const { scoring } = await import('../scoring/index.js');
    const result = await scoring.confirmedResult(matchId).catch(() => null);
    if (!result) {
      // Not a tournament match: perhaps a casual game's result (games R19).
      const { gameResults } = await import('../games/index.js');
      const casual = await gameResults.confirmedById(matchId);
      return casual ? casualResult(casual) : null;
    }
    if (!result.confirmedAt) return null;
    const sides = await sidesOf(result);
    if (!sides) return null;
    return {
      matchId,
      sportId: result.sportId,
      outcome: result.outcome,
      confirmedAt: result.confirmedAt,
      ratable: await ratable(result),
      ...sides,
    };
  },
  async confirmedBetween(sportId, from, to) {
    const { scoring } = await import('../scoring/index.js');
    const rows = await scoring.confirmedBetween(sportId, from, to);
    const out: ConfirmedResult[] = [];
    for (const r of rows) {
      const sides = await sidesOf(r);
      if (!sides || !r.confirmedAt) continue;
      out.push({
        matchId: r.matchId,
        sportId,
        outcome: r.outcome,
        confirmedAt: r.confirmedAt,
        ratable: await ratable(r),
        ...sides,
      });
    }
    // games R19 — the week's confirmed casual results are rated with it.
    const { gameResults } = await import('../games/index.js');
    for (const g of await gameResults.confirmedBetween(sportId, from, to)) {
      const casual = await casualResult(g);
      if (casual) out.push(casual);
    }
    out.sort((x, y) => x.confirmedAt.getTime() - y.confirmedAt.getTime() || x.matchId.localeCompare(y.matchId));
    return out;
  },
};

export const rating = createRatingService({
  db,
  repo: createRatingRepo(db),
  matches,
  profile: {
    applyRating: (playerId, sportId, values) => profile.applyRating(playerId, sportId, values),
    async cityOf(playerId) {
      const found = await profile.findById(playerId);
      return found?.city ?? null;
    },
  },
  // No board cache: every read is Postgres (docs/superpowers/specs/2026-09-29-drop-redis-design.md).
});

export {
  ALGO_VERSION,
  MOVEMENT_THRESHOLD,
  RANKED_MINIMUM,
  RatingCode,
  UNRATED,
  parseScope,
  scopeKey,
  weekStart,
} from './service/index.js';
export type {
  BoardCachePort,
  ConfirmedResult,
  MatchSide,
  MatchesPort,
  Page,
  PlayerRating,
  RankingRow,
  RankingScope,
  RatingEvent,
  RatingService,
  Standing,
} from './service/index.js';
