/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { logger } from '../../platform/logging/index.js';
import { realtime } from '../../platform/pusher.js';
import { consume } from '../../platform/rateLimit.js';
import { createProService } from './service/index.js';
import { createFeedRunner, feedBudget, scoreAdapters } from './feeds/index.js';

/** pro R5 — one channel per match, open to any signed-in player (platform/realtime/auth.ts). */
export const proMatchChannel = (matchId: string): string => `private-pro-match-${matchId}`;

export const pro = createProService({
  db,
  limiter: { consume },
  async publish(matchId, event, data) {
    if (!realtime.enabled) return;
    try {
      await realtime.publish([proMatchChannel(matchId)], event, data);
    } catch (err) {
      logger.warn({ matchId, event, err }, 'pro match publish failed — dropped');
    }
  },
  async wentLive(match, fanUserIds, teams) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(
      fanUserIds,
      'pro.match_live',
      { home: teams.home.name, away: teams.away.name, league: match.league },
      { kind: 'route', route: 'pro_match', id: match.id },
    );
  },
  // pro R9 → predictions R8, R9.
  async finished(match) {
    const { predictions } = await import('../predictions/index.js');
    const n = await predictions.suggestForMatch(match.id, { homeScore: match.homeScore, awayScore: match.awayScore, winner: match.winner });
    if (n > 0) logger.info({ matchId: match.id, suggested: n }, 'settle suggestions ready');
    // predictions R10 — the system's own "Who wins?" settles from the result.
    const settled = await predictions.autoSettleMatch(match.id);
    if (settled > 0) logger.info({ matchId: match.id, settled }, 'system questions settled');
  },
  async abandoned(match) {
    const { predictions } = await import('../predictions/index.js');
    const n = await predictions.voidOpenForMatch(match.id);
    if (n > 0) logger.info({ matchId: match.id, voided: n }, 'abandoned match: open questions voided');
  },
});

/** G1 — the feed jobs, writing through `pro` above. The worker and the portal call these. */
export const proFeeds = createFeedRunner({ db, pro, budget: feedBudget, adapters: scoreAdapters(), log: logger });
export { feedBudget, FOLLOW_PROVIDERS, feedPatch, parseCricMatch, parseCricScorecard, parseFootballFixture, parseSnookerMatch, parseSnookerPlayers, parseSnookerRounds, codeFor } from './feeds/index.js';
export type { FeedFollow, FeedMatch, RunSummary } from './feeds/index.js';

export {
  MAX_FAVOURITE_TEAMS,
  MESSAGE_MAX as PRO_MESSAGE_MAX,
  MOMENT_KINDS,
  PRO_STATUSES,
  ProCode,
  WINNERS,
  boardOrder,
} from './service/index.js';
export type {
  ChatMessage as ProChatMessage,
  Fact as ProFact,
  Innings,
  Squad as ProSquad,
  LivePatch,
  MatchInput,
  Moment as ProMoment,
  MomentKind,
  ProMatch,
  ProService,
  ProStatus,
  Stat as ProStat,
  Team as ProTeam,
  Winner as ProWinner,
} from './service/index.js';
