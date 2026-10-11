/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { createGamesRepo } from './repo/index.js';
import { createGamesService } from './service/index.js';

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
