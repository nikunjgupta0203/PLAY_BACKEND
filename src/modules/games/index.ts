/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { UserError } from '../../platform/errors/index.js';
import { createGamesRepo } from './repo/index.js';
import { createGamesService, GameCode, type MatchFormat } from './service/index.js';
import { createGameResults, ResultCode, type UnitScore } from './service/results.js';

export const games = createGamesService({
  db,
  repo: createGamesRepo(db),
  sport: {
    async findById(sportId) {
      const { sport } = await import('../sport/index.js');
      return sport.byId(sportId).catch(() => null);
    },
    async hasSkillBand(sportId, key) {
      const { sport } = await import('../sport/index.js');
      return sport.hasSkillBand(sportId, key);
    },
    checkFormat: (sportId, format) => checkFormatFor(sportId, format, GameCode.INVALID_GAME),
  },
  venues: {
    async findById(venueId) {
      const { venues } = await import('../venues/index.js');
      return venues.findById(venueId);
    },
  },
  users: {
    async namesByIds(ids) {
      const { identity } = await import('../identity/index.js');
      return new Map((await identity.usersByIds(ids)).map((u) => [u.id, u.displayName]));
    },
    async inactive(ids) {
      const { identity } = await import('../identity/index.js');
      return identity.inactiveUserIds(ids);
    },
    async phoneOf(userId) {
      const { identity } = await import('../identity/index.js');
      return (await identity.contactsByIds([userId]))[0]?.phone ?? null;
    },
    async findByPhone(phone) {
      const { identity } = await import('../identity/index.js');
      return identity.findByPhone(phone);
    },
  },
  limiter: { consume },
  // The feed row and the push, told inline like bookings: nothing here can fail a join.
  async notify(userIds, template, payload, gameId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(userIds, template, payload as never, { kind: 'game', id: gameId });
  },
});

/** The sport's own rule, for a casual result (games R14). */
async function ruleOf(sportId: string) {
  const { sport } = await import('../sport/index.js');
  return sport.scoringRuleFor(sportId);
}

/**
 * games R14 — the rule a casual result is held to. Null when the sport has no
 * rule, or is scored in heats (a race, a scorecard): there are no two sides to
 * a result, and no match rule for a client to count with.
 */
export async function matchRuleOf(sportId: string) {
  const rule = await ruleOf(sportId).catch(() => null);
  return rule && rule.kind !== 'performance' && rule.kind !== 'scorecard' ? rule : null;
}

/** "game 2 (11–10) is not a finished game" → a sentence a player reads. */
const sentence = (reason: string): string => `${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/\.$/, '')}.`;

/** games R18 — a format held to the sport's rule. Null when the sport has none to choose (one final score). */
async function checkFormatFor(sportId: string, format: MatchFormat, code: string): Promise<MatchFormat | null> {
  const rule = await matchRuleOf(sportId);
  const { checkFormat, formatOptions, ScoringInputError } = await import('../scoring/index.js');
  if (!rule || !formatOptions(rule)) return null;
  try {
    return checkFormat(rule, format);
  } catch (err) {
    if (err instanceof ScoringInputError) throw new UserError(code, sentence(err.message));
    throw err;
  }
}

/**
 * games R18 — the rule a casual match is held to: the sport's, with the
 * players' format in (or the sport's usual format, which still drops a game's
 * points cap). Null for a sport with no match rule.
 */
export async function effectiveRuleOf(sportId: string, format: MatchFormat | null) {
  const rule = await matchRuleOf(sportId);
  if (!rule) return null;
  const { defaultFormat, withFormat } = await import('../scoring/index.js');
  return withFormat(rule, format ?? defaultFormat(rule));
}

/** games R18 — what one unit of a match is called: game, set, frame, map… Null when the sport has no format to choose. */
export async function matchUnitOf(sportId: string): Promise<string | null> {
  const rule = await matchRuleOf(sportId);
  if (!rule) return null;
  const { formatOptions } = await import('../scoring/index.js');
  if (!formatOptions(rule)) return null;
  return rule.kind === 'rally' ? 'game' : rule.kind === 'sets' ? 'set' : rule.kind === 'series' ? rule.unitName : null;
}

/** The format a game is played to: its own, or the sport's usual. Null when the sport has none to choose. */
export async function formatOf(sportId: string, format: MatchFormat | null): Promise<MatchFormat | null> {
  const rule = await matchRuleOf(sportId);
  if (!rule) return null;
  const { defaultFormat, formatOptions } = await import('../scoring/index.js');
  if (!formatOptions(rule)) return null;
  return format ?? defaultFormat(rule);
}

export const gameResults = createGameResults({
  db,
  games: { byId: (gameId) => games.byId(gameId) },
  rules: {
    async supported(sportId) {
      return (await matchRuleOf(sportId)) !== null;
    },
    async judge(sportId, units: UnitScore[], format) {
      const { casualWinnerOf, ScoringInputError } = await import('../scoring/index.js');
      try {
        const rule = await ruleOf(sportId);
        const played = await formatOf(sportId, format);
        return casualWinnerOf(units, (await effectiveRuleOf(sportId, played)) ?? rule, played);
      } catch (err) {
        if (err instanceof ScoringInputError) throw new UserError(ResultCode.INVALID_RESULT, sentence(err.message));
        throw err;
      }
    },
    async finishes(sportId) {
      const rule = await ruleOf(sportId);
      return rule.kind === 'bouts' ? rule.finishes : [];
    },
    checkFormat: (sportId, format) => checkFormatFor(sportId, format, ResultCode.INVALID_RESULT),
  },
  users: {
    async namesByIds(ids) {
      const { identity } = await import('../identity/index.js');
      return new Map((await identity.usersByIds(ids)).map((u) => [u.id, u.displayName]));
    },
  },
  async sportName(sportId) {
    const { sport } = await import('../sport/index.js');
    return sport
      .byId(sportId)
      .then((s) => s.name)
      .catch(() => 'Game');
  },
  async notify(userIds, template, payload, gameId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(userIds, template, payload as never, { kind: 'game', id: gameId });
  },
});

export {
  COMMENT_MAX,
  GameCode,
  MAX_OPEN_GAMES,
  MAX_PLAYERS,
  NOTES_MAX,
  PLACE_NAME_MAX,
  REMINDER_MS,
  effectiveStatus,
  gameCursor,
} from './service/index.js';
export type { Game, GameComment, GameInput, GamePatch, GameStatus, GamesService, MatchFormat } from './service/index.js';
export { RESULT_AUTO_CONFIRM_MS, RESULTS_OPEN_AFTER_MS, ResultCode } from './service/results.js';
export type { GameResult, GameResultsService, Tally } from './service/results.js';
