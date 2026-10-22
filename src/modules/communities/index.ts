/** The ONLY surface other modules may import (conventions.md §1). */
import { config } from '../../platform/config.js';
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { createCommunitiesRepo } from './repo/index.js';
import { createCommunityFeed } from './service/feed.js';
import { createCommunityPayouts } from './service/payouts.js';
import { createCommunitiesService } from './service/index.js';

export const communities = createCommunitiesService({
  db,
  repo: createCommunitiesRepo(db),
  sport: {
    async findById(sportId) {
      const { sport } = await import('../sport/index.js');
      return sport.byId(sportId).catch(() => null);
    },
  },
  users: {
    async namesByIds(ids) {
      const { identity } = await import('../identity/index.js');
      return new Map((await identity.usersByIds(ids)).map((u) => [u.id, u.displayName]));
    },
  },
  limiter: { consume },
  // The feed row and the push, told inline like games: nothing here can fail a join.
  async notify(userIds, template, payload, communityId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(userIds, template, payload as never, { kind: 'community', id: communityId });
  },
});

/** communities R9 — the members' feed and chat. */
export const communityFeed = createCommunityFeed({
  db,
  limiter: { consume },
  roleOf: (communityId, userId) => communities.roleOf(communityId, userId),
});

/** communities R10 — monthly creator payouts, paid by hand like host payouts. */
export const communityPayouts = createCommunityPayouts({
  db,
  async accountOf(userId) {
    const { payouts } = await import('../payments/index.js');
    const account = await payouts.myAccount(userId);
    return account ? { id: account.id, status: account.status, detailsChangedAt: account.detailsChangedAt } : null;
  },
  rates: { commissionGstBps: config.COMMISSION_GST_BPS, tdsBps: config.HOST_TDS_BPS },
  async notify(userId, template, payload, communityId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, template, payload as never, { kind: 'community', id: communityId });
  },
  async alert(subject, text) {
    const { opsAlert } = await import('../payments/index.js');
    await opsAlert(subject, text);
  },
});

export { CommunityPayoutCode, communityPayoutQuote, periodOf, previousPeriod } from './service/payouts.js';
export type { CommunityPayout, CommunityPayouts } from './service/payouts.js';
export { FeedCode, MESSAGE_MAX, POST_MAX, cursorOf as feedCursor } from './service/feed.js';
export type { CommunityFeed, Message, Post } from './service/feed.js';
export {
  APPROVAL_TTL_MS,
  COMMISSION_BPS,
  commissionOf,
  BENEFITS_MAX,
  CommunityCode,
  MAX_MEMBERS,
  MAX_OWNED,
  REQUEST_TTL_MS,
  communityCursor,
  viewerStateOf,
} from './service/index.js';
export type {
  Access,
  Billing,
  CommunitiesService,
  Community,
  CommunityInput,
  CommunityPatch,
  CommunityPayment,
  Earnings,
  JoinRequest,
  Membership,
  Role,
  SortKey,
  Viewer,
  ViewerState,
  Visibility,
} from './service/index.js';
