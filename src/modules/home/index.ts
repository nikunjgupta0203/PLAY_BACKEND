/** The ONLY surface other modules may import (conventions.md §1). Nothing does: home is a leaf. */
import { events } from '../events/index.js';
import type { Event } from '../events/index.js';
import { profile } from '../profile/index.js';
import type { StatsSnapshot } from '../profile/index.js';
import { registration } from '../registration/index.js';
import type { Registration } from '../registration/index.js';
import { createHomeService } from './service/index.js';

export const home = createHomeService<Event, Registration, StatsSnapshot>({
  events: {
    async discoverable(filter, first) {
      const page = await events.search(
        { city: filter.city, sportId: filter.sportId, from: filter.from },
        { first },
      );
      return page.nodes;
    },
    byId: (eventId) => events.byId(eventId),
  },
  registrations: {
    committedForUser: (userId) => registration.committedForUser(userId),
  },
  profile: {
    async findByUserId(userId) {
      const found = await profile.findByUserId(userId);
      return found
        ? { id: found.id, city: found.city, sportIds: found.sports.map((s) => s.sportId) }
        : null;
    },
    statsSnapshot: (playerId, sportId) => profile.statsSnapshot(playerId, sportId),
  },
});

export { COMMITTED, FEATURED_LIMIT, UPCOMING_LIMIT } from './service/index.js';
export type { Entry, Hero, HomeFeed, HomeService } from './service/index.js';
