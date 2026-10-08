/**
 * Request context. DataLoaders are built here and die with the request
 * (conventions.md §4) — no cross-request cache, so no cross-user leak.
 */
import DataLoader from 'dataloader';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import type { Actor } from '../platform/auth/actor.js';
import { verifyAccessToken } from '../platform/auth/tokens.js';
import { SharedCode, SystemError } from '../platform/errors/index.js';
import { identity } from '../modules/identity/index.js';
import type { Grant, PlatformRole } from '../modules/identity/index.js';
import type { Capacity, Event, EventCategory } from '../modules/events/index.js';
import type { Venue } from '../modules/venues/index.js';
import type { GeoPoint } from '../platform/geo.js';
import type { Registration } from '../modules/registration/index.js';
import type { PublicProfile } from '../modules/profile/index.js';
import type { ChatMessage, ConversationView } from '../modules/chat/index.js';
import { logger } from '../platform/logging/index.js';

export interface Loaders {
  /** identity R10 — memoised for this request only, never across requests. */
  grant: DataLoader<{ userId: string; eventId: string }, Grant | null, string>;
  /** identity R15 — read per request, never a JWT claim. */
  platformRole: DataLoader<string, PlatformRole | null>;
  /** Speed — a feed of cards reads each event once, however many categories it lists. */
  event: DataLoader<string, Event | null>;
  /** Speed — a draw's entries (both sides of every match, every standing) in one read. */
  registration: DataLoader<string, Registration | null>;
  /** Speed — a list of entries reads each one's category in one query. */
  category: DataLoader<string, EventCategory | null>;
  /** Speed — every card's categories in one query, not one per card. */
  categories: DataLoader<string, EventCategory[]>;
  /** Speed — seat counts for every category on screen in one round trip (events R5). */
  capacity: DataLoader<EventCategory, Capacity, string>;
  /** Speed — every card's own map pin in one query (the venue's is the fallback). */
  eventLocation: DataLoader<string, GeoPoint | null>;
  /** Speed — every card's venue in one query. */
  venue: DataLoader<string, Venue | null>;
  /** Speed — every player on screen (an inbox row each) in a fixed number of queries. */
  publicProfile: DataLoader<string, PublicProfile | null>;
  /** Speed — an inbox page's last messages in one query. */
  chatLastMessage: DataLoader<string, ChatMessage | null>;
  /** Speed — an inbox page's unread counts in one query. */
  chatUnread: DataLoader<ConversationView, number, string>;
}

export interface Ctx {
  requestId: string;
  /** Client IP behind the load balancer. Feeds identity R3's per-IP windows. */
  ip: string;
  actor: Actor | null;
  loaders: Loaders;
}

function buildLoaders(actor: Actor | null): Loaders {
  return {
    // Speed — a screen of event cards asks for its grants in one query.
    grant: new DataLoader(async (keys) => identity.grantsForPairs(keys), {
      cacheKeyFn: (k) => `${k.userId}:${k.eventId}`,
    }),
    platformRole: new DataLoader(async (userIds) =>
      Promise.all(userIds.map((userId) => identity.platformRoleFor(userId))),
    ),
    event: new DataLoader(async (eventIds) => {
      const { events } = await import('../modules/events/index.js');
      const found = await events.findByIds(eventIds);
      return eventIds.map((id) => found.get(id) ?? null);
    }),
    registration: new DataLoader(async (registrationIds) => {
      const { registration } = await import('../modules/registration/index.js');
      const found = await registration.findByIds(registrationIds);
      return registrationIds.map((id) => found.get(id) ?? null);
    }),
    category: new DataLoader(async (categoryIds) => {
      const { events } = await import('../modules/events/index.js');
      const found = await events.findCategoriesByIds(categoryIds);
      return categoryIds.map((id) => found.get(id) ?? null);
    }),
    categories: new DataLoader(async (eventIds) => {
      const { events } = await import('../modules/events/index.js');
      const found = await events.categoriesForEvents(eventIds);
      return eventIds.map((id) => found.get(id) ?? []);
    }),
    capacity: new DataLoader(
      async (categories) => {
        const { events } = await import('../modules/events/index.js');
        const found = await events.capacitiesOf(categories);
        return categories.map((c) => found.get(c.id)!);
      },
      { cacheKeyFn: (c) => c.id },
    ),
    eventLocation: new DataLoader(async (eventIds) => {
      const { events } = await import('../modules/events/index.js');
      const found = await events.ownLocations(eventIds);
      return eventIds.map((id) => found.get(id) ?? null);
    }),
    venue: new DataLoader(async (venueIds) => {
      const { venues } = await import('../modules/venues/index.js');
      const found = new Map((await venues.byIds([...venueIds])).map((v) => [v.id, v]));
      return venueIds.map((id) => found.get(id) ?? null);
    }),
    publicProfile: new DataLoader(async (playerIds) => {
      const { profile } = await import('../modules/profile/index.js');
      const found = await profile.publicViews(actor?.userId ?? null, playerIds);
      return playerIds.map((id) => found.get(id) ?? null);
    }),
    chatLastMessage: new DataLoader(async (conversationIds) => {
      const { chat } = await import('../modules/chat/index.js');
      const found = await chat.lastMessages(conversationIds);
      return conversationIds.map((id) => found.get(id) ?? null);
    }),
    chatUnread: new DataLoader(
      async (views) => {
        const { chat } = await import('../modules/chat/index.js');
        const found = await chat.unreadCounts(views);
        return views.map((v) => found.get(v.id) ?? 0);
      },
      { cacheKeyFn: (v) => `${v.viewerId}:${v.id}` },
    ),
  };
}

export async function buildContext({ req }: { req: Request }): Promise<Ctx> {
  const requestId = (req as Request & { id?: string }).id ?? randomUUID();

  let actor: Actor | null = null;
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) {
    try {
      const claims = await verifyAccessToken(header.slice(7));
      actor = { userId: claims.sub, sessionId: claims.sid, client: claims.client ?? 'app' };
    } catch {
      // A token that no longer verifies (usually expired) is UNAUTHENTICATED
      // for the whole request — not a quiet anonymous one. Otherwise a read
      // with optional auth (`me`, an event's viewer fields) answers as a
      // stranger and the app, which refreshes only on this code (auth R6),
      // never learns its token went stale. No header at all is anonymous.
      // HTTP 200 like every other GraphQL error the app reads.
      logger.debug({ requestId }, 'rejected access token');
      throw new SystemError(SharedCode.UNAUTHENTICATED, 'Your session has expired. Sign in again.', {
        http: { status: 200 },
      });
    }
  }

  return { requestId, ip: req.ip ?? 'unknown', actor, loaders: buildLoaders(actor) };
}
