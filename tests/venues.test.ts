/**
 * venues — service tests against a real Postgres (conventions.md §5).
 *
 * A mocked database is banned here for a reason this module makes concrete:
 * the radius search is a PostGIS predicate against a gist index, and a mock
 * would happily return whatever the test wanted while `ST_DWithin` was wrong.
 *
 * Every numbered rule has at least one test that names it, so `grep 'R4:'`
 * finds the test for venues R4.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, type FakeMedia, type FakeSchedule } from './helpers/modules.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { VenueService } from '../src/modules/venues/service/index.js';
import {
  REVIEW_WINDOW_MS,
  VenueCode,
  createVenueRepo,
  createVenueService,
} from '../src/modules/venues/service/index.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let venues: VenueService;
let sport: SportService;
let schedule: FakeSchedule;
let media: FakeMedia;
let pickleballId: string;

/** Indiranagar, Bengaluru. Every distance below is measured from here. */
const CENTRE = { lat: 12.9784, lng: 77.6408 };
/** Koramangala — about 4 km south. */
const NEARBY = { lat: 12.9352, lng: 77.6245 };
/** Mysuru — about 130 km away, well outside any legal radius. */
const FAR = { lat: 12.2958, lng: 76.6394 };

let owner: { userId: string };
let stranger: { userId: string };

async function makeUser(email: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email, displayName: email.split('@')[0]! } });
  return { userId };
}

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? 'THREW';
  }
  return 'NO_ERROR';
};

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  venues = wired.venues;
  sport = wired.sport;
  schedule = wired.schedule;
  media = wired.media;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  schedule.reset();
  media.reset();
  owner = await makeUser('organizer@example.com');
  stranger = await makeUser('someone-else@example.com');
});

describe('venues', () => {
  it('creates a venue with courts and reads its location back', async () => {
    const venue = await venues.create(owner, {
      name: 'Indiranagar Club',
      address: '100 Feet Road',
      city: 'Bengaluru',
      location: CENTRE,
      amenities: ['parking', 'showers'],
      courts: [
        { name: 'Court 1', surface: 'acrylic', indoor: false, sportIds: [pickleballId] },
        { name: 'Court 2', surface: 'acrylic', indoor: true, sportIds: [pickleballId] },
      ],
    });

    expect(venue.location.lat).toBeCloseTo(CENTRE.lat, 5);
    expect(venue.location.lng).toBeCloseTo(CENTRE.lng, 5);
    expect(venue.amenities).toEqual(['parking', 'showers']);
    expect((await venues.courtsFor(venue.id)).map((c) => c.name)).toEqual([
      'Court 1',
      'Court 2',
    ]);
  });

  // --- R1 --------------------------------------------------------------------

  it('R1: a radius search finds venues inside the radius and not outside it', async () => {
    const near = await venues.create(owner, {
      name: 'Koramangala Courts',
      address: '5th Block',
      city: 'Bengaluru',
      location: NEARBY,
    });
    await venues.create(owner, {
      name: 'Mysuru Sports Club',
      address: 'JLB Road',
      city: 'Mysuru',
      location: FAR,
    });

    const page = await venues.search({ near: CENTRE, radiusKm: 10 }, { first: 20 });
    expect(page.nodes.map((v) => v.id)).toEqual([near.id]);
    // The distance rides along so a client can render "4 km away" without a
    // second round trip.
    expect(page.nodes[0]!.distanceM).toBeGreaterThan(0);
    expect(page.nodes[0]!.distanceM!).toBeLessThan(10_000);
  });

  it('R1: the radius is capped at 50 km', async () => {
    expect(await errorCode(() => venues.search({ near: CENTRE, radiusKm: 51 }, { first: 20 }))).toBe(
      VenueCode.RADIUS_TOO_LARGE,
    );
    // 50 itself is legal — the cap is inclusive, and an off-by-one here would
    // reject the default "search my whole city" case on some devices.
    await expect(
      venues.search({ near: CENTRE, radiusKm: 50 }, { first: 20 }),
    ).resolves.toBeDefined();
  });

  it('R1: results come back nearest first', async () => {
    const far = await venues.create(owner, {
      name: 'Whitefield Arena',
      address: 'ITPL Road',
      city: 'Bengaluru',
      location: { lat: 12.9698, lng: 77.7499 },
    });
    const close = await venues.create(owner, {
      name: 'Indiranagar Club',
      address: '100 Feet Road',
      city: 'Bengaluru',
      location: CENTRE,
    });

    const page = await venues.search({ near: CENTRE, radiusKm: 30 }, { first: 20 });
    expect(page.nodes.map((v) => v.id)).toEqual([close.id, far.id]);
  });

  it('R1: the distance cursor pages without repeating or skipping a venue', async () => {
    for (let i = 0; i < 5; i += 1) {
      await venues.create(owner, {
        name: `Court Complex ${i}`,
        address: 'Somewhere',
        city: 'Bengaluru',
        // Each one a little further east than the last.
        location: { lat: CENTRE.lat, lng: CENTRE.lng + i * 0.01 },
      });
    }

    const first = await venues.search({ near: CENTRE, radiusKm: 50 }, { first: 2 });
    expect(first.nodes).toHaveLength(2);
    expect(first.hasNextPage).toBe(true);

    const second = await venues.search(
      { near: CENTRE, radiusKm: 50 },
      { first: 10, after: first.endCursor },
    );
    const seen = [...first.nodes, ...second.nodes].map((v) => v.id);
    expect(new Set(seen).size).toBe(5);
  });

  // --- R2 --------------------------------------------------------------------

  it('R2: one court can serve several sports, and the venue reports their union', async () => {
    const tennisId = newId();
    await prisma.sport.create({
      data: { id: tennisId, slug: 'tennis', name: 'Tennis', sortOrder: 2 },
    });
    sport.refresh();

    const venue = await venues.create(owner, {
      name: 'Multi Sport Centre',
      address: 'Old Airport Road',
      city: 'Bengaluru',
      location: CENTRE,
      courts: [
        { name: 'Court 1', sportIds: [pickleballId, tennisId] },
        { name: 'Court 2', sportIds: [pickleballId] },
      ],
    });

    expect((await venues.sportsAt(venue.id)).sort()).toEqual([pickleballId, tennisId].sort());
    const found = await venues.search({ sportId: tennisId }, { first: 20 });
    expect(found.nodes.map((v) => v.id)).toEqual([venue.id]);
  });

  it('R2: a retired court stops contributing its sports to the venue', async () => {
    const venue = await venues.create(owner, {
      name: 'Single Court Club',
      address: 'Church Street',
      city: 'Bengaluru',
      location: CENTRE,
      courts: [{ name: 'Court 1', sportIds: [pickleballId] }],
    });
    const [court] = await venues.courtsFor(venue.id);

    await venues.updateCourt(owner, court!.id, { active: false });

    expect(await venues.sportsAt(venue.id)).toEqual([]);
    const found = await venues.search({ sportId: pickleballId }, { first: 20 });
    expect(found.nodes).toHaveLength(0);
  });

  // --- R3 --------------------------------------------------------------------

  it('R3: a venue is visible to everyone, but only its creator may edit it', async () => {
    const venue = await venues.create(owner, {
      name: 'Indiranagar Club',
      address: '100 Feet Road',
      city: 'Bengaluru',
      location: CENTRE,
    });

    expect(await venues.findById(venue.id)).not.toBeNull();
    expect(await errorCode(() => venues.update(stranger, venue.id, { name: 'Mine now' }))).toBe(
      'FORBIDDEN',
    );
    const renamed = await venues.update(owner, venue.id, { name: 'Indiranagar Sports Club' });
    expect(renamed.name).toBe('Indiranagar Sports Club');
  });

  it('R3, portal: staff add a venue for its owner, and manage any venue', async () => {
    const staff = { ...stranger, platformStaff: true };
    const venue = await venues.create(
      staff,
      { name: 'Smash Arena', address: '80 Feet Road', city: 'Bengaluru', location: CENTRE, courts: [{ name: 'Court 1' }] },
      { ownerId: owner.userId },
    );
    // The owner runs it as if they had added it.
    expect(venue.createdBy).toBe(owner.userId);
    await venues.update(owner, venue.id, { name: 'Smash Arena Indiranagar' });

    await venues.addCourt(staff, venue.id, { name: 'Court 2' });
    expect((await venues.courtsFor(venue.id)).map((c) => c.name)).toEqual(['Court 1', 'Court 2']);
    // The same person outside the portal is nobody special.
    expect(await errorCode(() => venues.addCourt(stranger, venue.id, { name: 'Court 3' }))).toBe('FORBIDDEN');
  });

  // --- R4 --------------------------------------------------------------------

  it('R4: availability means "not assigned within THIS tournament", not booked', async () => {
    const venue = await venues.create(owner, {
      name: 'Tournament Venue',
      address: 'Cubbon Road',
      city: 'Bengaluru',
      location: CENTRE,
      courts: [
        { name: 'Court 1', sportIds: [pickleballId] },
        { name: 'Court 2', sportIds: [pickleballId] },
      ],
    });
    const courts = await venues.courtsFor(venue.id);
    const window = {
      from: new Date('2026-10-10T03:30:00Z'),
      to: new Date('2026-10-10T12:00:00Z'),
    };

    const summerCup = newId();
    const winterOpen = newId();
    schedule.assign(courts[0]!.id, summerCup);

    // Taken inside the Summer Cup...
    expect((await venues.freeCourts(venue.id, window, summerCup)).map((c) => c.id)).toEqual([
      courts[1]!.id,
    ]);
    // ...and still free for a different tournament, because this is scheduling
    // and not booking. Two tournaments at one venue is the organizers' problem.
    expect((await venues.freeCourts(venue.id, window, winterOpen)).map((c) => c.id)).toEqual(
      courts.map((c) => c.id),
    );
  });

  it('R4: a retired court is never offered to the scheduler', async () => {
    const venue = await venues.create(owner, {
      name: 'Tournament Venue',
      address: 'Cubbon Road',
      city: 'Bengaluru',
      location: CENTRE,
      courts: [{ name: 'Court 1' }, { name: 'Court 2' }],
    });
    const courts = await venues.courtsFor(venue.id);
    await venues.updateCourt(owner, courts[0]!.id, { active: false });

    const free = await venues.freeCourts(
      venue.id,
      { from: new Date(), to: new Date(Date.now() + 3_600_000) },
      newId(),
    );
    expect(free.map((c) => c.id)).toEqual([courts[1]!.id]);
  });

  it('COURT_IN_USE: a court with scheduled matches cannot be retired', async () => {
    const venue = await venues.create(owner, {
      name: 'Tournament Venue',
      address: 'Cubbon Road',
      city: 'Bengaluru',
      location: CENTRE,
      courts: [{ name: 'Court 1' }],
    });
    const [court] = await venues.courtsFor(venue.id);
    schedule.assign(court!.id, newId());

    expect(await errorCode(() => venues.updateCourt(owner, court!.id, { active: false }))).toBe(
      VenueCode.COURT_IN_USE,
    );
    // Renaming it is still fine — the guard is about capacity, not about edits.
    const renamed = await venues.updateCourt(owner, court!.id, { name: 'Centre Court' });
    expect(renamed.name).toBe('Centre Court');
  });

  // --- R5 --------------------------------------------------------------------

  it('R5: a deleted venue disappears from every read path', async () => {
    const venue = await venues.create(owner, {
      name: 'Closed Down Club',
      address: 'Residency Road',
      city: 'Bengaluru',
      location: CENTRE,
      courts: [{ name: 'Court 1', sportIds: [pickleballId] }],
    });

    await venues.remove(owner, venue.id);

    expect(await venues.findById(venue.id)).toBeNull();
    expect(await errorCode(() => venues.byId(venue.id))).toBe(VenueCode.VENUE_NOT_FOUND);
    expect((await venues.search({ city: 'Bengaluru' }, { first: 20 })).nodes).toHaveLength(0);
    expect((await venues.search({ near: CENTRE, radiusKm: 10 }, { first: 20 })).nodes).toHaveLength(
      0,
    );
  });

  it('R5: the row survives, so a completed tournament can still resolve it', async () => {
    const venue = await venues.create(owner, {
      name: 'Closed Down Club',
      address: 'Residency Road',
      city: 'Bengaluru',
      location: CENTRE,
    });
    await venues.remove(owner, venue.id);

    const row = await prisma.venue.findUnique({ where: { id: venue.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  // --- media (ADR 0003) ------------------------------------------------------

  it('ADR 0003 §C2: a public_id from another venue’s folder is rejected', async () => {
    const mine = await venues.create(owner, {
      name: 'My Club',
      address: 'A Road',
      city: 'Bengaluru',
      location: CENTRE,
    });
    const theirs = await venues.create(stranger, {
      name: 'Their Club',
      address: 'B Road',
      city: 'Bengaluru',
      location: NEARBY,
    });

    const signature = await venues.photoUploadSignature(owner, mine.id);
    expect(signature.folder).toContain(mine.id);

    expect(
      await errorCode(() =>
        venues.addPhoto(owner, mine.id, `pl4y/venues/${theirs.id}/0/whatever`),
      ),
    ).toBe(VenueCode.VENUE_NOT_FOUND);

    const updated = await venues.addPhoto(owner, mine.id, `pl4y/venues/${mine.id}/0/photo`);
    expect(updated.photoPublicIds).toEqual([`pl4y/venues/${mine.id}/0/photo`]);
  });

  it('discovery R1: free text finds a venue by name or address, with % literal', async () => {
    const club = await venues.create(owner, { name: 'Indiranagar Club', address: '100 Feet Road', city: 'Bengaluru', location: CENTRE });
    await venues.create(owner, { name: 'Koramangala Courts', address: '80 Feet Road', city: 'Bengaluru', location: NEARBY });
    const byName = await venues.search({ query: 'indira' }, { first: 20 });
    expect(byName.nodes.map((v) => v.id)).toEqual([club.id]);
    const byAddress = await venues.search({ query: '100 feet' }, { first: 20 });
    expect(byAddress.nodes.map((v) => v.id)).toEqual([club.id]);
    expect((await venues.search({ query: '%' }, { first: 20 })).nodes).toEqual([]);
  });

  describe('details, playing areas and reviews (R6–R8, R10, R12)', () => {
    /** A service whose "played here" answers come from the test, at a fixed clock. */
    const NOW = new Date('2026-09-28T12:00:00Z');
    const played = new Map<string, { venueId: string; userIds: string[]; at: Date }>();
    const withVisits = () =>
      createVenueService({
        repo: createVenueRepo(prisma as unknown as Db),
        schedule,
        media,
        visits: { forMatch: async (matchId) => played.get(matchId) ?? null },
        now: () => NOW,
      });

    const playAt = async (svc: VenueService, venueId: string, userId: string, at = NOW) => {
      const matchId = newId();
      played.set(matchId, { venueId, userIds: [userId], at });
      await svc.recordMatchVisit(matchId);
      await svc.recordMatchVisit(matchId); // R6 — the projection is idempotent
    };

    const club = (svc: VenueService) =>
      svc.create(owner, { name: 'Indiranagar Club', address: '100 Feet Road', city: 'Bengaluru', location: CENTRE });

    beforeEach(() => played.clear());

    it('R6: only a player who played here in the last 12 months may review', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const player = await makeUser('player@example.com');

      expect(await errorCode(() => svc.review(player, venue.id, { stars: 5 }))).toBe(
        VenueCode.REVIEW_NOT_ELIGIBLE,
      );

      await playAt(svc, venue.id, player.userId, new Date(NOW.getTime() - REVIEW_WINDOW_MS - 86_400_000));
      expect(await svc.canReview(player.userId, venue.id)).toBe(false);

      await playAt(svc, venue.id, player.userId);
      expect(await svc.canReview(player.userId, venue.id)).toBe(true);
      const review = await svc.review(player, venue.id, { stars: 4, body: '  Great lights  ' });
      expect(review).toMatchObject({ stars: 4, body: 'Great lights' });
    });

    it('R6: one review per player per venue — a second call edits it', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const player = await makeUser('player@example.com');
      await playAt(svc, venue.id, player.userId);

      const first = await svc.review(player, venue.id, { stars: 2 });
      const edited = await svc.review(player, venue.id, { stars: 5, body: 'Resurfaced!' });
      expect(edited.id).toBe(first.id);
      expect(await prisma.venueReview.count()).toBe(1);
      expect((await svc.reviewBy(player.userId, venue.id))?.stars).toBe(5);
    });

    it('R6: stars must be 1-5 and the body at most 1,000 characters', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const player = await makeUser('player@example.com');
      await playAt(svc, venue.id, player.userId);
      expect(await errorCode(() => svc.review(player, venue.id, { stars: 0 }))).toBe(VenueCode.INVALID_REVIEW);
      expect(await errorCode(() => svc.review(player, venue.id, { stars: 3.5 }))).toBe(VenueCode.INVALID_REVIEW);
      expect(
        await errorCode(() => svc.review(player, venue.id, { stars: 3, body: 'x'.repeat(1001) })),
      ).toBe(VenueCode.INVALID_REVIEW);
    });

    it('R7: the rating appears only from the third review, and tracks every edit', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const stars = [5, 4, 3];
      const players = [];
      for (const [i, n] of stars.entries()) {
        const p = await makeUser(`p${i}@example.com`);
        await playAt(svc, venue.id, p.userId);
        await svc.review(p, venue.id, { stars: n });
        players.push(p);
        const v = await svc.byId(venue.id);
        expect(v.reviewCount).toBe(i + 1);
        expect(v.rating).toBe(i < 2 ? null : 4);
      }
      await svc.review(players[2]!, venue.id, { stars: 5 });
      expect((await svc.byId(venue.id)).rating).toBeCloseTo(4.67, 2);
    });

    it('R8: the venue may reply once; nobody else may', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const player = await makeUser('player@example.com');
      await playAt(svc, venue.id, player.userId);
      const review = await svc.review(player, venue.id, { stars: 3 });

      expect(await errorCode(() => svc.replyToReview(stranger, review.id, 'Thanks'))).toBe('FORBIDDEN');
      const replied = await svc.replyToReview(owner, review.id, 'Thanks — lights fixed.');
      expect(replied.replyBody).toBe('Thanks — lights fixed.');
      expect(await errorCode(() => svc.replyToReview(owner, review.id, 'Again'))).toBe(
        VenueCode.ALREADY_REPLIED,
      );
    });

    it('reviews page newest first without repeating or skipping one', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      for (let i = 0; i < 5; i += 1) {
        const p = await makeUser(`r${i}@example.com`);
        await playAt(svc, venue.id, p.userId);
        await svc.review(p, venue.id, { stars: 1 + i });
      }
      const seen: number[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await svc.reviews(venue.id, { first: 2, after });
        seen.push(...page.nodes.map((r) => r.stars));
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      expect(seen).toEqual([5, 4, 3, 2, 1]);
    });

    it('R12: description and opening hours are stored; a bad window is refused', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const updated = await svc.update(owner, venue.id, {
        description: '  Six floodlit courts.  ',
        openingHours: [
          { day: 0, opens: '06:00', closes: '10:00' },
          { day: 0, opens: '17:00', closes: '22:00' },
        ],
        contactPhone: '+91 98765 43210',
      });
      expect(updated.description).toBe('Six floodlit courts.');
      expect(updated.openingHours).toHaveLength(2);
      expect(updated.contactPhone).toBe('+91 98765 43210');
      expect(
        await errorCode(() =>
          svc.update(owner, venue.id, { openingHours: [{ day: 7, opens: '06:00', closes: '10:00' }] }),
        ),
      ).toBe(VenueCode.INVALID_OPENING_HOURS);
      expect(
        await errorCode(() =>
          svc.update(owner, venue.id, { openingHours: [{ day: 1, opens: '22:00', closes: '06:00' }] }),
        ),
      ).toBe(VenueCode.INVALID_OPENING_HOURS);
    });

    it('R10: a playing area has a kind, defaulting to court', async () => {
      const svc = withVisits();
      const venue = await club(svc);
      const court = await svc.addCourt(owner, venue.id, { name: 'Court 1' });
      const turf = await svc.addCourt(owner, venue.id, { name: 'Turf A', kind: 'turf' });
      expect(court.kind).toBe('court');
      expect(turf.kind).toBe('turf');
      expect((await svc.updateCourt(owner, court.id, { kind: 'table' })).kind).toBe('table');
    });
  });
});
