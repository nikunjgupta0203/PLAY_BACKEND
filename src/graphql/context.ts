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
import type { Event } from '../modules/events/index.js';
import { logger } from '../platform/logging/index.js';

export interface Loaders {
  /** identity R10 — memoised for this request only, never across requests. */
  grant: DataLoader<{ userId: string; eventId: string }, Grant | null, string>;
  /** identity R15 — read per request, never a JWT claim. */
  platformRole: DataLoader<string, PlatformRole | null>;
  /** Speed — a feed of cards reads each event once, however many categories it lists. */
  event: DataLoader<string, Event | null>;
}

export interface Ctx {
  requestId: string;
  /** Client IP behind the load balancer. Feeds identity R3's per-IP windows. */
  ip: string;
  actor: Actor | null;
  loaders: Loaders;
}

function buildLoaders(): Loaders {
  return {
    grant: new DataLoader(
      async (keys) =>
        Promise.all(keys.map((k) => identity.grantsFor(k.userId, k.eventId))),
      { cacheKeyFn: (k) => `${k.userId}:${k.eventId}` },
    ),
    platformRole: new DataLoader(async (userIds) =>
      Promise.all(userIds.map((userId) => identity.platformRoleFor(userId))),
    ),
    event: new DataLoader(async (eventIds) => {
      const { events } = await import('../modules/events/index.js');
      return Promise.all(eventIds.map((id) => events.findById(id)));
    }),
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

  return { requestId, ip: req.ip ?? 'unknown', actor, loaders: buildLoaders() };
}
