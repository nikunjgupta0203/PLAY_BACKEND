/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { profile } from '../profile/index.js';
import { createChatService } from './service/index.js';

export const chat = createChatService({
  db,
  // Speed — chat needs only id, userId and visibility: one query, not three.
  profiles: {
    findByUserId: (userId) => profile.briefByUserId(userId),
    findById: (playerId) => profile.briefById(playerId),
  },
  sharedPlay: {
    // chat R2. registration imports profile, which chat imports, so it is
    // reached lazily like every other cross-module port. Both asked at once.
    async sharePlay(a, b) {
      const [played, teammates] = await Promise.all([
        profile.havePlayedTogether(a.id, b.id),
        import('../registration/index.js').then(({ registration }) => registration.areTeammates(a.userId, b.userId)),
      ]);
      return played || teammates;
    },
  },
  limiter: { consume },
});

export {
  ChatCode,
  MESSAGE_MAX,
  MESSAGE_WINDOW,
  PREVIEW_MAX,
  REQUEST_WINDOW,
} from './service/index.js';
export type {
  ChatMessage,
  ChatService,
  ConversationView,
  Messaging,
} from './service/index.js';
