/**
 * The ONLY surface other modules may import (conventions.md §1).
 *
 * The leaderboard scopes need three sets of people this module does not own:
 * who a player chats with, who shares their communities, who lives in their
 * city. They are read-only id lookups, done here at the composition edge so
 * the service stays testable with plain functions.
 */
import { db } from '../../platform/db.js';
import { createPredictionsService } from './service/index.js';

export const predictions = createPredictionsService({
  db,
  async matchSport(matchId) {
    const { pro } = await import('../pro/index.js');
    return (await pro.match(matchId))?.sportId ?? null;
  },
  async friendsOf(userId) {
    const rows = await db.$queryRaw<{ user_id: string }[]>`
      SELECT other.user_id
        FROM player_profiles me
        JOIN conversations c
          ON c.status = 'active' AND (c.player_low_id = me.id OR c.player_high_id = me.id)
        JOIN player_profiles other
          ON other.id = CASE WHEN c.player_low_id = me.id THEN c.player_high_id ELSE c.player_low_id END
       WHERE me.user_id = ${userId}::uuid`;
    return rows.map((r) => r.user_id);
  },
  async communityMembers(userId, communityId) {
    const rows = communityId
      ? await db.$queryRaw<{ user_id: string }[]>`
          SELECT m.user_id FROM community_members m
           WHERE m.community_id = ${communityId}::uuid AND m.status = 'active'
             AND EXISTS (SELECT 1 FROM community_members me
                          WHERE me.community_id = m.community_id AND me.user_id = ${userId}::uuid AND me.status = 'active')`
      : await db.$queryRaw<{ user_id: string }[]>`
          SELECT DISTINCT m.user_id FROM community_members m
            JOIN community_members me ON me.community_id = m.community_id AND me.user_id = ${userId}::uuid AND me.status = 'active'
           WHERE m.status = 'active'`;
    return rows.map((r) => r.user_id);
  },
  async cityPeers(userId) {
    const mine = await db.playerProfile.findUnique({ where: { userId }, select: { city: true } });
    const city = mine?.city?.trim() || null;
    if (!city) return { city: null, userIds: [] };
    const rows = await db.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM player_profiles WHERE lower(btrim(city)) = lower(${city})`;
    return { city, userIds: rows.map((r) => r.user_id) };
  },
  async notify(userIds, payload) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(userIds, 'prediction.settled', payload, { kind: 'route', route: 'predictions' });
  },
});

export {
  BADGES,
  DAILY_BONUS,
  MAX_OPTIONS,
  OUTCOMES,
  PredictionCode,
  suggestAnswer,
  istDay,
  istDayBounds,
  rankRows,
  scorePick,
  streaks,
} from './service/index.js';
export type {
  Badge,
  Board,
  BoardEntry,
  BoardScope,
  Challenge,
  ChallengeTask,
  FinalResult,
  Outcome as PredictionOutcome,
  Option as PredictionOption,
  Pick as PredictionPick,
  PredictionsService,
  Question as PredictionQuestion,
  QuestionInput,
  QuestionKind,
  QuestionStatus,
  Split,
  Stats as PredictionStats,
} from './service/index.js';
