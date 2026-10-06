/**
 * The Hosting tab (PLAY_FRONTEND/docs/modules/26-hosting-tab.md): whether a
 * user gets the tab, and everything waiting on them across every event they
 * help run. Composed here because it reads events, scoring, tournament,
 * registration and organisations, and none of them owns "hosting".
 */
import { builder } from '../../../graphql/builder.js';
import { db } from '../../../platform/db.js';
import { events } from '../../events/index.js';
import type { Event } from '../../events/index.js';
import { identity } from '../../identity/index.js';
import { ViewerRef } from '../../identity/schema/index.js';
import { organisations } from '../index.js';

/** hosting R1 — the tab stays this long after a host's last event ends. */
export const HOSTING_TAB_GRACE_MS = 90 * 24 * 3_600_000;

const RUNS = new Set(['owner', 'manager']);

interface HostedWithRole {
  event: Event;
  role: string;
}

async function hostedWithRoles(userId: string): Promise<HostedWithRole[]> {
  const [grants, hosted] = await Promise.all([identity.grantsForUser(userId), events.hostedBy(userId)]);
  const roleOf = new Map(grants.map((g) => [g.eventId, g.role]));
  return hosted.map((event) => ({ event, role: roleOf.get(event.id) ?? 'scorer' }));
}

/** hosting R1 — owns or manages anything recent (a draft counts), scores something not over, or is in an organisation. */
export async function isHosting(userId: string, now = new Date()): Promise<boolean> {
  if ((await organisations.membershipsOf(userId)).length > 0) return true;
  // 19-bookings R7 — the venue desk lives in the Hosting tab.
  const { bookings } = await import('../../bookings/index.js');
  if (await bookings.runsAVenue(userId)) return true;
  const since = now.getTime() - HOSTING_TAB_GRACE_MS;
  return (await hostedWithRoles(userId)).some(({ event, role }) =>
    RUNS.has(role)
      ? event.status === 'draft' || event.endsAt.getTime() > since
      : event.endsAt.getTime() > now.getTime(),
  );
}

export type NeedsYouKind = 'dispute' | 'result' | 'draw' | 'short';

export interface NeedsYouItem {
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  kind: NeedsYouKind;
  count: number;
  /** For `short`: the draw, and how many it has of how many it needs. */
  detail: string | null;
}

const ORDER: Record<NeedsYouKind, number> = { dispute: 0, result: 1, draw: 2, short: 3 };

/**
 * hosting R3 — the same items an event's own "Needs you" shows (23-organizer
 * run R3), for every published or live event at once. Scorers see results
 * only (R5).
 */
export async function needsYou(userId: string): Promise<NeedsYouItem[]> {
  const running = (await hostedWithRoles(userId)).filter(
    ({ event }) => event.status === 'published' || event.status === 'live',
  );
  const [{ scoring }, { tournament }, { registration }] = await Promise.all([
    import('../../scoring/index.js'),
    import('../../tournament/index.js'),
    import('../../registration/index.js'),
  ]);

  const items: NeedsYouItem[] = [];
  for (const { event, role } of running) {
    const base = { eventId: event.id, eventSlug: event.slug, eventTitle: event.title };

    const pending = await scoring.pendingForEvent({ userId }, event.id).catch(() => [] as string[]);
    if (pending.length > 0) {
      const disputes = await db.matchResult.count({ where: { matchId: { in: pending }, disputedAt: { not: null } } });
      if (disputes > 0) items.push({ ...base, kind: 'dispute', count: disputes, detail: null });
      if (pending.length > disputes) items.push({ ...base, kind: 'result', count: pending.length - disputes, detail: null });
    }

    if (!RUNS.has(role)) continue;
    const categories = await events.categoriesFor(event.id);
    let toDraw = 0;
    for (const c of categories) {
      if (c.status === 'closed' && !(await tournament.findByCategory(c.id))) toDraw += 1;
      if (event.status === 'published' && (c.status === 'open' || c.status === 'full')) {
        const have = await registration.entries.confirmedCount(c.id);
        if (have < c.minEntries) {
          items.push({ ...base, kind: 'short', count: 1, detail: `${c.name}: ${have} of ${c.minEntries}` });
        }
      }
    }
    if (toDraw > 0) items.push({ ...base, kind: 'draw', count: toDraw, detail: null });
  }

  return items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

const NeedsYouKindEnum = builder.enumType('HostingNeedsYouKind', {
  values: {
    DISPUTE: { value: 'dispute' },
    RESULT: { value: 'result' },
    DRAW: { value: 'draw' },
    SHORT: { value: 'short' },
  } as const,
});

const NeedsYouRef = builder.objectRef<NeedsYouItem>('HostingNeedsYouItem').implement({
  description: 'hosting R3 — one thing waiting on the host, on one event.',
  fields: (t) => ({
    eventId: t.exposeID('eventId'),
    eventSlug: t.exposeString('eventSlug'),
    eventTitle: t.exposeString('eventTitle'),
    kind: t.field({ type: NeedsYouKindEnum, resolve: (i) => i.kind }),
    count: t.exposeInt('count'),
    detail: t.string({ nullable: true, resolve: (i) => i.detail }),
  }),
});

builder.objectField(ViewerRef, 'isHosting', (t) =>
  t.boolean({
    description: 'hosting R1 — whether the app shows the Hosting tab.',
    resolve: (v) => isHosting(v.id),
  }),
);

builder.objectField(ViewerRef, 'hostingNeedsYou', (t) =>
  t.field({
    type: [NeedsYouRef],
    description: 'hosting R3, R4 — everything waiting on the viewer across their running events, most urgent first.',
    resolve: (v) => needsYou(v.id),
  }),
);
