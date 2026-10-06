/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { profile } from '../profile/index.js';
import { createChatService, type ChatProfile } from './service/index.js';

const asChatProfile = (p: { id: string; userId: string; visibility: ChatProfile['visibility'] } | null) =>
  p ? { id: p.id, userId: p.userId, visibility: p.visibility } : null;

export const chat = createChatService({
  db,
  profiles: {
    findByUserId: async (userId) => asChatProfile(await profile.findByUserId(userId)),
    findById: async (playerId) => asChatProfile(await profile.findById(playerId)),
  },
  sharedPlay: {
    // chat R2. registration imports profile, which chat imports, so it is
    // reached lazily like every other cross-module port.
    async sharePlay(a, b) {
      if (await profile.havePlayedTogether(a.id, b.id)) return true;
      const { registration } = await import('../registration/index.js');
      return registration.areTeammates(a.userId, b.userId);
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
