/**
 * home — GraphQL surface (docs/modules/21-home.md).
 *
 * One field, `Query.home`, fills every region of the Home screen in one round
 * trip (architecture.md §1, home R1). `recommended` is deliberately absent:
 * `discovery` adds it with `extend type HomeFeed` when it lands (discovery R4),
 * and an empty list here would read as "we have nothing for you" rather than
 * "not built yet".
 */
import { builder } from '../../../graphql/builder.js';
import type { Event } from '../../events/index.js';
import { EventRef } from '../../events/schema/index.js';
import type { StatsSnapshot } from '../../profile/index.js';
import { StatsSnapshotRef } from '../../profile/schema/index.js';
import type { Registration } from '../../registration/index.js';
import { RegistrationRef } from '../../registration/schema/index.js';
import { home } from '../index.js';
import type { Entry, Hero, HomeFeed } from '../index.js';

type Feed = HomeFeed<Event, Registration, StatsSnapshot>;

const HomeHeroRef = builder.objectRef<Hero<Event, Registration>>('HomeHero').implement({
  description:
    'home R3 — the viewer\'s next confirmed entry, or when there is none the city\'s ' +
    'headline event. `registration` is null for the headline case.',
  fields: (t) => ({
    event: t.field({ type: EventRef, resolve: (h) => h.event }),
    registration: t.field({
      type: RegistrationRef,
      nullable: true,
      resolve: (h) => h.registration,
    }),
  }),
});

const HomeEntryRef = builder.objectRef<Entry<Event, Registration>>('HomeEntry').implement({
  description: 'home R4 — one confirmed or checked-in entry, with its event.',
  fields: (t) => ({
    registration: t.field({ type: RegistrationRef, resolve: (e) => e.registration }),
    event: t.field({ type: EventRef, resolve: (e) => e.event }),
  }),
});

const HomeFeedRef = builder.objectRef<Feed>('HomeFeed').implement({
  description:
    'Every region of the Home screen, in its fixed order. A region with nothing in it is ' +
    'null or empty, and the client removes it from the layout (home R1).',
  fields: (t) => ({
    hero: t.field({ type: HomeHeroRef, nullable: true, resolve: (f) => f.hero }),
    liveNow: t.field({
      type: [EventRef],
      description: 'home R5 — LIVE events the viewer has an entry in.',
      resolve: (f) => f.liveNow,
    }),
    upcoming: t.field({
      type: [HomeEntryRef],
      description: 'home R4 — confirmed entries, soonest first, excluding the hero and live ones.',
      resolve: (f) => f.upcoming,
    }),
    featured: t.field({
      type: [EventRef],
      description: 'Published events in the city, soonest first, excluding ones already entered.',
      resolve: (f) => f.featured,
    }),
    stats: t.field({
      type: StatsSnapshotRef,
      nullable: true,
      description: 'home R7 — null until the viewer has played a match in the sport.',
      resolve: (f) => f.stats,
    }),
    firstRun: t.exposeBoolean('firstRun', {
      description: 'home R6 — the viewer has never entered an event.',
    }),
    city: t.exposeString('city', {
      nullable: true,
      description: 'The city the feed was built for: the argument, else the profile\'s.',
    }),
  }),
});

builder.queryFields((t) => ({
  home: t.field({
    type: HomeFeedRef,
    description:
      'Fills the entire Home screen (home R1). `city` defaults to the viewer\'s profile ' +
      'city; passing one browses without editing the profile (home R2). Signed-out ' +
      'viewers get the city shelf only.',
    args: {
      city: t.arg.string(),
      sportId: t.arg.id(),
    },
    resolve: (_root, args, ctx) =>
      home.feed(ctx.actor ? { userId: ctx.actor.userId } : null, {
        city: args.city ?? null,
        sportId: args.sportId ? String(args.sportId) : null,
      }),
  }),
}));
