/**
 * home — the one query behind the Home screen (docs/modules/21-home.md).
 *
 * A read-only composition. It owns no tables and writes nothing: every region
 * is assembled from `events`, `registration` and `profile` through their
 * service surfaces (conventions.md §1). Nothing imports this module, so it can
 * depend on all three without closing a cycle.
 */

export type EventStatus = 'draft' | 'published' | 'live' | 'completed' | 'cancelled';

/** The parts of an event the feed decides on. The resolver hands the full event to GraphQL. */
export interface FeedEvent {
  id: string;
  sportId: string;
  city: string;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
}

export interface FeedRegistration {
  id: string;
  eventId: string;
  status: string;
}

export interface FeedStats {
  sportId: string;
  matchesPlayed: number;
}

// --- ports -------------------------------------------------------------------

export interface EventsPort<E extends FeedEvent> {
  /** events R6 — published and live events only, soonest first. */
  discoverable(filter: { city: string | null; sportId: string | null; from: Date }, first: number): Promise<E[]>;
  byId(eventId: string): Promise<E>;
}

export interface RegistrationsPort<R extends FeedRegistration> {
  listForUser(userId: string): Promise<R[]>;
}

export interface ProfilePort<S extends FeedStats> {
  findByUserId(userId: string): Promise<{ id: string; city: string | null; sportIds: string[] } | null>;
  statsSnapshot(playerId: string, sportId: string): Promise<S>;
}

export interface HomeDeps<E extends FeedEvent, R extends FeedRegistration, S extends FeedStats> {
  events: EventsPort<E>;
  registrations: RegistrationsPort<R>;
  profile: ProfilePort<S>;
  now?: () => Date;
}

// --- the feed ------------------------------------------------------------------

export interface Entry<E, R> {
  registration: R;
  event: E;
}

/** home R3 — the viewer's next commitment, else the city's headline event. */
export type Hero<E, R> = { event: E; registration: R | null };

export interface HomeFeed<E, R, S> {
  hero: Hero<E, R> | null;
  liveNow: E[];
  upcoming: Entry<E, R>[];
  featured: E[];
  stats: S | null;
  /** home R6 — the viewer has never entered anything. */
  firstRun: boolean;
  /** The city the feed was built for — the argument, else the profile's (home R2). */
  city: string | null;
}

/** home R4 — seated entries only. A pending payment is not a commitment yet. */
export const COMMITTED = new Set(['confirmed', 'checked_in']);

/** What fits on a phone screen. Featured is a shelf, not a search result. */
export const FEATURED_LIMIT = 10;
export const UPCOMING_LIMIT = 10;

const byStart = <T extends { startsAt: Date }>(a: T, b: T) =>
  a.startsAt.getTime() - b.startsAt.getTime();

export function createHomeService<
  E extends FeedEvent,
  R extends FeedRegistration,
  S extends FeedStats,
>(deps: HomeDeps<E, R, S>) {
  const now = deps.now ?? (() => new Date());

  async function feed(
    viewer: { userId: string } | null,
    args: { city?: string | null; sportId?: string | null },
  ): Promise<HomeFeed<E, R, S>> {
    const at = now();
    const player = viewer ? await deps.profile.findByUserId(viewer.userId) : null;

    // home R2 — an explicit city wins; the profile's is the default. A viewer
    // browsing another city from the header is not editing their profile.
    const city = args.city?.trim() || player?.city || null;
    const sportId = args.sportId ?? null;

    const [mine, discoverable] = await Promise.all([
      viewer ? deps.registrations.listForUser(viewer.userId) : Promise.resolve([] as R[]),
      // One over the shelf, because the hero may take the first.
      deps.events.discoverable({ city, sportId, from: at }, FEATURED_LIMIT + 1),
    ]);

    // home R4 — committed entries in events that have not finished. Each event
    // is read once even if the viewer holds two entries in it.
    const committed = mine.filter((r) => COMMITTED.has(r.status));
    const eventById = new Map<string, E>();
    await Promise.all(
      [...new Set(committed.map((r) => r.eventId))].map(async (id) => {
        eventById.set(id, await deps.events.byId(id));
      }),
    );
    const entries: Entry<E, R>[] = committed
      .map((registration) => ({ registration, event: eventById.get(registration.eventId)! }))
      .filter(({ event }) => isOngoing(event, at) && (!sportId || event.sportId === sportId))
      .sort((a, b) => byStart(a.event, b.event));

    // home R5 — live events the viewer is in, each once.
    const liveNow = dedupe(entries.filter((e) => e.event.status === 'live').map((e) => e.event));
    const ahead = entries.filter((e) => e.event.status !== 'live');

    // Featured never repeats an event the viewer has already entered.
    const entered = new Set(entries.map((e) => e.event.id));
    const cityEvents = discoverable
      .filter((e) => isOngoing(e, at) && !entered.has(e.id))
      .sort(byStart);

    // home R3 — the hero is the next commitment, else the city's headline event.
    const hero: Hero<E, R> | null = ahead[0]
      ? { event: ahead[0].event, registration: ahead[0].registration }
      : cityEvents[0]
        ? { event: cityEvents[0], registration: null }
        : null;

    const upcoming = (hero?.registration ? ahead.slice(1) : ahead).slice(0, UPCOMING_LIMIT);
    const featured = (hero && !hero.registration ? cityEvents.slice(1) : cityEvents).slice(
      0,
      FEATURED_LIMIT,
    );

    return {
      hero,
      liveNow,
      upcoming,
      featured,
      stats: player ? await statsFor(player, sportId) : null,
      firstRun: mine.length === 0,
      city,
    };
  }

  /**
   * home R7 — the materialised snapshot (profile R8) for the chosen sport, else
   * the player's first. Null until the player has finished a match: a region of
   * zeroes reads as broken, where an absent one reads as new.
   */
  async function statsFor(
    player: { id: string; sportIds: string[] },
    sportId: string | null,
  ): Promise<S | null> {
    const chosen = sportId ?? player.sportIds[0];
    if (!chosen || (sportId && !player.sportIds.includes(sportId))) return null;
    const snapshot = await deps.profile.statsSnapshot(player.id, chosen);
    return snapshot.matchesPlayed > 0 ? snapshot : null;
  }

  return { feed };
}

/** Cancelled and finished events never appear on Home. */
function isOngoing(event: FeedEvent, at: Date): boolean {
  return event.status !== 'cancelled' && event.status !== 'draft' && event.endsAt > at;
}

function dedupe<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export type HomeService<
  E extends FeedEvent = FeedEvent,
  R extends FeedRegistration = FeedRegistration,
  S extends FeedStats = FeedStats,
> = ReturnType<typeof createHomeService<E, R, S>>;
