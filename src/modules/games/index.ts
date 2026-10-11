/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { UserError } from '../../platform/errors/index.js';
import { createGamesRepo } from './repo/index.js';
import { createGamesService } from './service/index.js';
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

/** "game 2 (11–10) is not a finished game" → a sentence a player reads. */
const sentence = (reason: string): string => `${reason.charAt(0).toUpperCase()}${reason.slice(1).replace(/\.$/, '')}.`;

export const gameResults = createGameResults({
  db,
  games: { byId: (gameId) => games.byId(gameId) },
  rules: {
    async supported(sportId) {
      const rule = await ruleOf(sportId).catch(() => null);
      // A race or a scorecard is scored in heats: there are no two sides to a result.
      return rule !== null && rule.kind !== 'performance' && rule.kind !== 'scorecard';
    },
    async judge(sportId, units: UnitScore[]) {
      const { casualWinnerOf, ScoringInputError } = await import('../scoring/index.js');
      try {
        return casualWinnerOf(units, await ruleOf(sportId));
      } catch (err) {
        if (err instanceof ScoringInputError) throw new UserError(ResultCode.INVALID_RESULT, sentence(err.message));
        throw err;
      }
    },
    async finishes(sportId) {
      const rule = await ruleOf(sportId);
      return rule.kind === 'bouts' ? rule.finishes : [];
    },
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
export type { Game, GameComment, GameInput, GamePatch, GameStatus, GamesService } from './service/index.js';
export { RESULT_AUTO_CONFIRM_MS, RESULTS_OPEN_AFTER_MS, ResultCode } from './service/results.js';
export type { GameResult, GameResultsService, Tally } from './service/results.js';
