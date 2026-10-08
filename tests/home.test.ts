/**
 * home — service tests against a real Postgres (conventions.md §5).
 *
 * Home owns no tables, so what is under test is the composition: that the
 * regions come out of real events, registrations and profiles in the order and
 * with the exclusions docs/modules/21-home.md specifies.
 *
 * Every numbered rule has at least one test that names it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import type { Event, EventService } from '../src/modules/events/service/index.js';
import type { ProfileService, StatsSnapshot } from '../src/modules/profile/service/index.js';
import type {
  Registration,
  RegistrationService,
} from '../src/modules/registration/service/index.js';
import { createHomeService, type HomeService } from '../src/modules/home/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let events: EventService;
let registration: RegistrationService;
let profile: ProfileService;
let sport: SportService;
let home: HomeService<Event, Registration, StatsSnapshot>;
let pickleballId: string;

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

interface Player {
  userId: string;
  playerId: string;
  actor: { userId: string };
}

let organizer: Player;

async function makePlayer(name: string, city: string | null = 'Bengaluru'): Promise<Player> {
  const userId = newId();
  const address = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({ data: { playerId, sportId: pickleballId, skillBand: '3.5' } });
  const player = { userId, playerId, actor: { userId } };
  if (city) await profile.updateLocation(player.actor, { city });
  return player;
}

/** A published event with one singles category. Free unless a fee is given. */
async function publishedEvent(
  opts: { startsInDays?: number; city?: string; feePaise?: bigint; title?: string } = {},
): Promise<{ eventId: string; categoryId: string }> {
  const startsAt = soon(opts.startsInDays ?? 30);
  const event = await events.create(organizer.actor, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: opts.title ?? `Open ${newId().slice(0, 8)}`,
    city: opts.city ?? 'Bengaluru',
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    registrationClosesAt: new Date(startsAt.getTime() - DAY / 2),
    cancellationCutoffAt: null,
  });
  const fee = opts.feePaise ?? 0n;
  const category = await events.addCategory(organizer.actor, event.id, {
    name: 'Open Singles',
    format: 'singles',
    capacity: 16,
    minEntries: 4,
    entryFeePaise: fee,
    platformFeePaise: fee > 0n ? 5_000n : 0n,
    taxBps: 1800,
    skillMin: null,
    skillMax: null,
  });
  await events.publish(organizer.actor, event.id);
  return { eventId: event.id, categoryId: category.id };
}

/** A free entry is confirmed in the transaction that seats it (registration R18). */
const enter = (player: Player, categoryId: string) =>
  registration.begin(player.actor, { eventCategoryId: categoryId });

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  events = wired.events;
  registration = wired.registration;
  profile = wired.profile;
  sport = wired.sport;
  // Wired exactly as src/modules/home/index.ts wires the production singletons.
  home = createHomeService<Event, Registration, StatsSnapshot>({
    events: {
      async discoverable(filter, first) {
        return (await events.search(filter, { first })).nodes;
      },
      byIds: (ids) => events.findByIds(ids),
    },
    registrations: { committedForUser: (userId) => registration.committedForUser(userId) },
    profile: {
      async findByUserId(userId) {
        const p = await profile.findByUserId(userId);
        return p ? { id: p.id, city: p.city, sportIds: p.sports.map((s) => s.sportId) } : null;
      },
      statsSnapshot: (playerId, sportId) => profile.statsSnapshot(playerId, sportId),
    },
  });
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  organizer = await makePlayer('Organizer');
});

describe('home — Done when: one query fills every region', () => {
  it('R1: a single call returns hero, live, upcoming, featured and stats together', async () => {
    const player = await makePlayer('Asha');
    const live = await publishedEvent({ startsInDays: 1, title: 'Live Open' });
    const next = await publishedEvent({ startsInDays: 3, title: 'Next Open' });
    const later = await publishedEvent({ startsInDays: 9, title: 'Later Open' });
    const shelf = await publishedEvent({ startsInDays: 5, title: 'Shelf Open' });
    for (const e of [live, next, later]) await enter(player, e.categoryId);
    await events.markLive(live.eventId);

    const feed = await home.feed(player.actor, {});

    expect(feed.hero?.event.id).toBe(next.eventId);
    expect(feed.liveNow.map((e) => e.id)).toEqual([live.eventId]);
    expect(feed.upcoming.map((u) => u.event.id)).toEqual([next.eventId, later.eventId]);
    expect(feed.featured.map((e) => e.id)).toEqual([shelf.eventId]);
    expect(feed.stats).toBeNull();
    expect(feed.firstRun).toBe(false);
  });
});

describe('home — rules', () => {
  it('R2: city defaults to the profile, and an explicit city browses another without editing it', async () => {
    const player = await makePlayer('Ravi', 'Pune');
    const pune = await publishedEvent({ city: 'Pune' });
    const blr = await publishedEvent({ city: 'Bengaluru' });

    const own = await home.feed(player.actor, {});
    expect(own.city).toBe('Pune');
    expect(own.hero?.event.id).toBe(pune.eventId);

    const away = await home.feed(player.actor, { city: 'Bengaluru' });
    expect(away.city).toBe('Bengaluru');
    expect(away.hero?.event.id).toBe(blr.eventId);
    expect((await profile.findByUserId(player.userId))?.city).toBe('Pune');
  });

  it('R2: a city with nothing on falls back to events from every city', async () => {
    const player = await makePlayer('Mira', 'Egyara');
    const elsewhere = await publishedEvent({ city: 'Ahmedabad' });

    const feed = await home.feed(player.actor, {});

    expect(feed.city).toBe('Egyara');
    expect(feed.hero?.event.id).toBe(elsewhere.eventId);
  });

  it('R2: a city under another spelling is the same city', async () => {
    const player = await makePlayer('Dev', 'bangalore ');
    const blr = await publishedEvent({ city: 'Bengaluru' });

    const feed = await home.feed(player.actor, {});

    expect(feed.hero?.event.id).toBe(blr.eventId);
  });

  it('R3: with no entry, the hero is the city\'s soonest event and it is not repeated in featured', async () => {
    const player = await makePlayer('Meera');
    const first = await publishedEvent({ startsInDays: 2 });
    const second = await publishedEvent({ startsInDays: 4 });

    const feed = await home.feed(player.actor, {});

    expect(feed.hero?.event.id).toBe(first.eventId);
    expect(feed.hero?.registration).toBeNull();
    expect(feed.featured.map((e) => e.id)).toEqual([second.eventId]);
  });

  it('R3: an entry beats a sooner headline event, and featured never lists an entered event', async () => {
    const player = await makePlayer('Kabir');
    const headline = await publishedEvent({ startsInDays: 1 });
    const mine = await publishedEvent({ startsInDays: 6 });
    const reg = await enter(player, mine.categoryId);

    const feed = await home.feed(player.actor, {});

    expect(feed.hero?.event.id).toBe(mine.eventId);
    expect(feed.hero?.registration?.id).toBe(reg.id);
    expect(feed.featured.map((e) => e.id)).toEqual([headline.eventId]);
  });

  it('R4: a single entry is the hero and is still listed under upcoming', async () => {
    const player = await makePlayer('Tara');
    const first = await publishedEvent({ startsInDays: 2 });
    const second = await publishedEvent({ startsInDays: 4 });
    await enter(player, first.categoryId);
    await enter(player, second.categoryId);

    const feed = await home.feed(player.actor, {});

    expect(feed.hero?.event.id).toBe(first.eventId);
    expect(feed.upcoming.map((u) => u.event.id)).toEqual([first.eventId, second.eventId]);
  });

  it('R4: a pending payment is not a commitment and does not reach hero or upcoming', async () => {
    const player = await makePlayer('Isha');
    const paid = await publishedEvent({ feePaise: 50_000n });
    const pending = await enter(player, paid.categoryId);
    expect(pending.status).toBe('payment_pending');

    const feed = await home.feed(player.actor, {});

    expect(feed.hero?.registration).toBeNull();
    expect(feed.upcoming).toEqual([]);
    // Not committed, so the event stays on the shelf where the player can finish paying.
    expect(feed.hero?.event.id).toBe(paid.eventId);
    expect(feed.firstRun).toBe(false);
  });

  it('R4: cancelled events leave every region', async () => {
    const player = await makePlayer('Neel');
    const gone = await publishedEvent({ startsInDays: 2 });
    await enter(player, gone.categoryId);
    await events.cancel(organizer.actor, gone.eventId, 'Venue flooded');

    const feed = await home.feed(player.actor, {});

    expect(feed.hero).toBeNull();
    expect(feed.upcoming).toEqual([]);
    expect(feed.featured).toEqual([]);
  });

  it('R5: a live event the viewer is in sits in liveNow and nowhere else', async () => {
    const player = await makePlayer('Zoya');
    const live = await publishedEvent({ startsInDays: 1 });
    await enter(player, live.categoryId);
    await events.markLive(live.eventId);

    const feed = await home.feed(player.actor, {});

    expect(feed.liveNow.map((e) => e.id)).toEqual([live.eventId]);
    expect(feed.hero).toBeNull();
    expect(feed.upcoming).toEqual([]);
  });

  it('R6: a player who has never entered anything is on their first run', async () => {
    const player = await makePlayer('New');
    await publishedEvent();

    const feed = await home.feed(player.actor, {});

    expect(feed.firstRun).toBe(true);
  });

  it('R7: stats are null until a match is played, then the materialised snapshot', async () => {
    const player = await makePlayer('Dev');
    expect((await home.feed(player.actor, {})).stats).toBeNull();

    await profile.recordStatsSnapshot(player.playerId, {
      sportId: pickleballId,
      matchesPlayed: 4,
      wins: 3,
      losses: 1,
      winRate: 0.75,
      currentStreak: 2,
      tournamentsPlayed: 1,
      bestFinish: 'Semi-final',
    });

    const stats = (await home.feed(player.actor, {})).stats;
    expect(stats?.matchesPlayed).toBe(4);
    expect(stats?.winRate).toBe(0.75);
  });

  it('R8: a signed-out viewer gets the city shelf and nothing personal', async () => {
    const shelf = await publishedEvent({ city: 'Mumbai' });

    const feed = await home.feed(null, { city: 'Mumbai' });

    expect(feed.hero?.event.id).toBe(shelf.eventId);
    expect(feed.upcoming).toEqual([]);
    expect(feed.liveNow).toEqual([]);
    expect(feed.stats).toBeNull();
    expect(feed.firstRun).toBe(true);
  });
});
