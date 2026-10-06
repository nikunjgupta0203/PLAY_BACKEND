/**
 * events — service tests against a real Postgres (conventions.md §5).
 *
 * Every numbered rule has at least one test that names it, so `grep 'R5:'`
 * finds the test for events R5.
 *
 * `registration` lands in Sprint 4, so confirmed entries and live seat holds
 * arrive through the FakeEntries port. That is not a shortcut around R2 and R5
 * — those rules are entirely about what those two numbers do to capacity and to
 * frozen fields, and driving the port directly is what makes both testable
 * before there is anything to register for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, type FakeEntries } from './helpers/modules.js';
import type { EventDeps, EventService, PublishGate } from '../src/modules/events/service/index.js';
import { EventCode, createEventService } from '../src/modules/events/service/index.js';
import { HOST_COMMISSION_BPS } from '../src/modules/events/service/priceQuote.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { VenueService } from '../src/modules/venues/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let events: EventService;
let venues: VenueService;
let sport: SportService;
let entries: FakeEntries;
let eventDeps: EventDeps;
let pickleballId: string;

let organizer: { userId: string };
let stranger: { userId: string };

const CENTRE = { lat: 12.9784, lng: 77.6408 };

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

/**
 * Publish insists the deadline is still ahead (gap #10); these tests are
 * about what happens once it has passed, so time "passes" in the row.
 */
const deadlinePassed = (eventId: string) =>
  prisma.event.update({ where: { id: eventId }, data: { registrationClosesAt: soon(-1) } });

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

/** A draft with sensible dates. Publishing it is the caller's business. */
async function draft(overrides: Partial<Parameters<EventService['create']>[1]> = {}) {
  // The window is derived from startsAt so that moving an event closer does not
  // silently leave registrationClosesAt after it — publish would then refuse the
  // event (events R1) for a reason the test is not about.
  const startsAt = overrides.startsAt ?? soon(30);
  return events.create(organizer, {
    sportId: pickleballId,
    title: 'Bengaluru Pickleball Open',
    city: 'Bengaluru',
    location: CENTRE,
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    registrationClosesAt: new Date(startsAt.getTime() - 5 * DAY),
    contactPhone: '9876543210',
    acceptHostTerms: true,
    ...overrides,
  });
}

const CATEGORY = {
  name: "Men's Doubles 3.5",
  format: 'doubles',
  capacity: 16,
  entryFeePaise: 50_000n,
  platformFeePaise: 5_000n,
  taxBps: 1800,
};

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  events = wired.events;
  venues = wired.venues;
  sport = wired.sport;
  entries = wired.entries;
  eventDeps = wired.eventDeps as unknown as EventDeps;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  entries.reset();
  organizer = await makeUser('organizer@example.com');
  stranger = await makeUser('player@example.com');
});

describe('events', () => {
  // --- R1 --------------------------------------------------------------------

  it('R1: publish refuses an event with no categories', async () => {
    const event = await draft();
    expect(await errorCode(() => events.publish(organizer, event.id))).toBe(
      EventCode.INVALID_EVENT_WINDOW,
    );
    expect((await events.byId(event.id)).status).toBe('draft');
  });

  it('R1: publish refuses a registration window that closes after the event starts', async () => {
    const event = await draft({ registrationClosesAt: soon(31) });
    await events.addCategory(organizer, event.id, CATEGORY);

    expect(await errorCode(() => events.publish(organizer, event.id))).toBe(
      EventCode.INVALID_EVENT_WINDOW,
    );
  });

  it('R1: publish refuses an event with neither a city nor a venue', async () => {
    const event = await draft({ city: null, location: null });
    await events.addCategory(organizer, event.id, CATEGORY);

    expect(await errorCode(() => events.publish(organizer, event.id))).toBe(
      EventCode.INVALID_EVENT_WINDOW,
    );
  });

  it('R1: a draft may be incomplete — publish is the only gate', async () => {
    // No category, no city, and it still saves. That is the point of a draft.
    const event = await draft({ city: null, location: null });
    expect(event.status).toBe('draft');
    expect(await events.findById(event.id)).not.toBeNull();
  });

  it('R1: a complete event publishes and emits event.published', async () => {
    const event = await draft();
    await events.addCategory(organizer, event.id, CATEGORY);

    const published = await events.publish(organizer, event.id);
    expect(published.status).toBe('published');

    const emitted = await prisma.outbox.findMany({ where: { topic: 'event.published' } });
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as { eventId: string }).eventId).toBe(event.id);
  });

  // --- R2 --------------------------------------------------------------------

  it('R2: dates are editable while nobody has paid', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);
    expect(await entries.confirmedCount(category.id)).toBe(0);

    const moved = await events.update(organizer, event.id, { startsAt: soon(40), endsAt: soon(41) });
    expect(moved.startsAt.getTime()).toBeCloseTo(soon(40).getTime(), -4);
  });

  it('gap #10: an edit after publishing must still make a window publish would accept', async () => {
    const event = await draft();
    await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);
    // Starting after it ends is refused, and nothing is saved.
    expect(await errorCode(() => events.update(organizer, event.id, { startsAt: soon(400) }))).toBe(
      EventCode.INVALID_EVENT_WINDOW,
    );
    expect((await events.byId(event.id)).startsAt.getTime()).toBe(event.startsAt.getTime());
  });

  it('gap #9: an early close-registration run after the deadline moved does nothing', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, { ...CATEGORY, minEntries: 4 });
    await events.publish(organizer, event.id);
    // The job scheduled for the old deadline fires; the deadline is now later.
    const result = await events.closeRegistration(event.id);
    expect(result).toEqual({ closed: [], cancelled: [] });
    expect((await events.categoryById(category.id)).status).toBe('open');
  });

  it('F18: once a category has a confirmed entry, moving the dates is a change of terms entrants are told about', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);

    entries.confirmed.set(category.id, 1);

    const moved = await events.update(organizer, event.id, { startsAt: soon(40), endsAt: soon(41) });
    expect(moved.termsChangedAt).not.toBeNull();
    const notice = await prisma.outbox.findFirst({ where: { topic: 'event.terms_changed' } });
    expect(notice?.payload).toMatchObject({ eventId: event.id, datesChanged: true, placeChanged: false });

    // Sending the same instant again is not a change.
    const again = await events.update(organizer, event.id, { startsAt: moved.startsAt });
    expect(again.termsChangedAt?.getTime()).toBe(moved.termsChangedAt?.getTime());
    // The title is not a term anybody agreed to; fixing a typo stays allowed.
    const renamed = await events.update(organizer, event.id, { title: 'Bengaluru Open 2026' });
    expect(renamed.title).toBe('Bengaluru Open 2026');
  });

  it('R2: fee and capacity freeze once that category has a confirmed entry', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);

    entries.confirmed.set(category.id, 1);

    expect(
      await errorCode(() =>
        events.updateCategory(organizer, category.id, { entryFeePaise: 90_000n }),
      ),
    ).toBe(EventCode.EVENT_HAS_ENTRIES);
    expect(
      await errorCode(() => events.updateCategory(organizer, category.id, { capacity: 32 })),
    ).toBe(EventCode.EVENT_HAS_ENTRIES);

    const renamed = await events.updateCategory(organizer, category.id, {
      name: "Men's Doubles 3.5 (Open)",
    });
    expect(renamed.name).toBe("Men's Doubles 3.5 (Open)");
  });

  it('R2: a draft is never frozen, whatever the entries port says', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);
    entries.confirmed.set(category.id, 3);

    const widened = await events.updateCategory(organizer, category.id, { capacity: 32 });
    expect(widened.capacity).toBe(32);
  });

  // --- R3 --------------------------------------------------------------------

  it('R3: priceQuote is computed from the category row, entry + platform fee + tax', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);

    const quote = await events.priceQuote(category.id);
    expect(quote.entryFeePaise).toBe(50_000n);
    expect(quote.platformFeePaise).toBe(5_000n);
    expect(quote.taxPaise).toBe(9_900n);
    expect(quote.totalPaise).toBe(64_900n);
    expect(quote.currency).toBe('INR');
  });

  it('R3: the quote follows a fee change, so nothing can cache a stale total', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);

    await events.updateCategory(organizer, category.id, { entryFeePaise: 100_000n });
    expect((await events.priceQuote(category.id)).totalPaise).toBe(123_900n);
  });

  // --- R4 --------------------------------------------------------------------

  it('R4: availability is derived — OPEN, ALMOST_FULL, then FULL', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, {
      ...CATEGORY,
      capacity: 20,
    });
    await events.publish(organizer, event.id);

    expect((await events.availabilityOf(category.id)).availability).toBe('OPEN');

    // 10% of 20 is 2, so two remaining is the boundary.
    entries.confirmed.set(category.id, 18);
    expect((await events.availabilityOf(category.id)).availability).toBe('ALMOST_FULL');

    entries.confirmed.set(category.id, 20);
    expect((await events.availabilityOf(category.id)).availability).toBe('FULL');
  });

  it('R4: past registrationClosesAt it is CLOSED even with seats left', async () => {
    const event = await draft({
      startsAt: soon(2),
      endsAt: soon(3),
      registrationClosesAt: soon(-1),
    });
    const category = await events.addCategory(organizer, event.id, CATEGORY);

    const { availability, capacity } = await events.availabilityOf(category.id);
    expect(availability).toBe('CLOSED');
    // CLOSED wins over the seat count, and the seat count is still honest.
    expect(capacity.remaining).toBe(16);
  });

  it('R4: a cancelled event reads CLOSED', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);
    await events.cancel(organizer, event.id, 'rain');

    expect((await events.availabilityOf(category.id)).availability).toBe('CLOSED');
  });

  // --- R5 --------------------------------------------------------------------

  it('R5: capacity subtracts live seat holds as well as confirmed entries', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, { ...CATEGORY, capacity: 4 });
    await events.publish(organizer, event.id);

    entries.confirmed.set(category.id, 1);
    entries.holds.set(category.id, 2);

    const capacity = await events.capacityOf(category.id);
    expect(capacity).toEqual({ capacity: 4, taken: 1, held: 2, remaining: 1 });
  });

  it('R5: two people in checkout make the last two seats unavailable, not oversold', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, { ...CATEGORY, capacity: 4 });
    await events.publish(organizer, event.id);

    entries.confirmed.set(category.id, 2);
    entries.holds.set(category.id, 2);

    // Without R5 this would read 2 remaining, the third player would pay, and
    // we would refund them. Worst case here is "full briefly, then reopens".
    expect((await events.capacityOf(category.id)).remaining).toBe(0);
    expect((await events.availabilityOf(category.id)).availability).toBe('FULL');
    expect(await errorCode(() => events.assertRegistrationOpen(category.id))).toBe(
      EventCode.CATEGORY_FULL,
    );
  });

  it('R5: remaining never goes negative, however the counts arrive', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, { ...CATEGORY, capacity: 4 });
    entries.confirmed.set(category.id, 4);
    entries.holds.set(category.id, 3);

    expect((await events.capacityOf(category.id)).remaining).toBe(0);
  });

  // --- R6 --------------------------------------------------------------------

  it('R6: discovery lists only published and live events', async () => {
    const drafted = await draft({ title: 'Still A Draft' });
    await events.addCategory(organizer, drafted.id, CATEGORY);

    const published = await draft({ title: 'Published Open' });
    await events.addCategory(organizer, published.id, CATEGORY);
    await events.publish(organizer, published.id);

    const cancelled = await draft({ title: 'Called Off' });
    await events.addCategory(organizer, cancelled.id, CATEGORY);
    await events.publish(organizer, cancelled.id);
    await events.cancel(organizer, cancelled.id, 'rain');

    const page = await events.search({}, { first: 20 });
    expect(page.nodes.map((e) => e.id)).toEqual([published.id]);
  });

  it('R6: a draft reads as missing to anyone but its own staff', async () => {
    const event = await draft();

    expect(await events.findBySlug(event.slug, stranger.userId)).toBeNull();
    expect(await events.findBySlug(event.slug, null)).toBeNull();
    expect(await events.findBySlug(event.slug, organizer.userId)).not.toBeNull();
  });

  it('R6: the radius filter is capped at 50 km, like every other one', async () => {
    expect(
      await errorCode(() => events.search({ near: CENTRE, radiusKm: 80 }, { first: 20 })),
    ).toBe(EventCode.RADIUS_TOO_LARGE);
  });

  it('R6: a filter combining sport, city, date, skill and price returns the right draw', async () => {
    const match = await draft({ title: 'Matching Open', city: 'Bengaluru' });
    await events.addCategory(organizer, match.id, {
      ...CATEGORY,
      skillMin: 3.0,
      skillMax: 4.0,
      entryFeePaise: 40_000n,
    });
    await events.publish(organizer, match.id);

    const tooExpensive = await draft({ title: 'Pricey Open', city: 'Bengaluru' });
    await events.addCategory(organizer, tooExpensive.id, {
      ...CATEGORY,
      skillMin: 3.0,
      skillMax: 4.0,
      entryFeePaise: 500_000n,
    });
    await events.publish(organizer, tooExpensive.id);

    const wrongCity = await draft({ title: 'Chennai Open', city: 'Chennai', location: null });
    await events.addCategory(organizer, wrongCity.id, { ...CATEGORY, entryFeePaise: 40_000n });
    await events.publish(organizer, wrongCity.id);

    const page = await events.search(
      {
        sportId: pickleballId,
        city: 'Bengaluru',
        from: soon(1),
        to: soon(60),
        skillBand: '3.5',
        format: 'doubles',
        maxPricePaise: 50_000n,
      },
      { first: 20 },
    );
    expect(page.nodes.map((e) => e.id)).toEqual([match.id]);
  });

  it('R6: results are ordered by start time and page without repeating', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const event = await draft({ title: `Open ${i}`, startsAt: soon(10 + i), endsAt: soon(11 + i) });
      await events.addCategory(organizer, event.id, CATEGORY);
      await events.publish(organizer, event.id);
      ids.push(event.id);
    }

    const first = await events.search({}, { first: 2 });
    expect(first.nodes.map((e) => e.id)).toEqual(ids.slice(0, 2));
    expect(first.hasNextPage).toBe(true);

    const second = await events.search({}, { first: 10, after: first.endCursor });
    expect(second.nodes.map((e) => e.id)).toEqual(ids.slice(2));
    expect(second.hasNextPage).toBe(false);
  });

  // --- R7 --------------------------------------------------------------------

  it('R7: cancelling is irreversible and enqueues a full refund', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);

    const cancelled = await events.cancel(organizer, event.id, 'venue flooded');
    expect(cancelled.status).toBe('cancelled');
    expect((await events.categoryById(category.id)).status).toBe('cancelled');

    const emitted = await prisma.outbox.findMany({ where: { topic: 'event.cancelled' } });
    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!.payload as { reason: string; refundPlatformFee: boolean };
    expect(payload.reason).toBe('venue flooded');
    // The platform fee goes back too — the player did not choose this.
    expect(payload.refundPlatformFee).toBe(true);

    // There is no un-cancel. Publishing again does nothing.
    const republished = await events.publish(organizer, event.id);
    expect(republished.status).toBe('cancelled');
  });

  it('R7: cancelling twice emits one refund instruction, not two', async () => {
    const event = await draft();
    await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);

    await events.cancel(organizer, event.id, 'rain');
    await events.cancel(organizer, event.id, 'rain');

    expect(await prisma.outbox.count({ where: { topic: 'event.cancelled' } })).toBe(1);
  });

  // --- R8 --------------------------------------------------------------------

  it('R8: the slug is unique and survives a title change', async () => {
    const first = await draft({ title: 'Bengaluru Pickleball Open' });
    const second = await draft({ title: 'Bengaluru Pickleball Open' });

    expect(first.slug).toBe('bengaluru-pickleball-open');
    expect(second.slug).not.toBe(first.slug);

    await events.addCategory(organizer, first.id, CATEGORY);
    await events.publish(organizer, first.id);
    const renamed = await events.update(organizer, first.id, { title: 'Something Else Entirely' });

    // The link in somebody's WhatsApp still resolves.
    expect(renamed.slug).toBe('bengaluru-pickleball-open');
    expect(await events.findBySlug('bengaluru-pickleball-open')).not.toBeNull();
  });

  // --- R9 --------------------------------------------------------------------

  it('R9: a category under min_entries at close is cancelled and refunded', async () => {
    const event = await draft({ startsAt: soon(2), endsAt: soon(3), registrationClosesAt: soon(1) });
    const healthy = await events.addCategory(organizer, event.id, {
      ...CATEGORY,
      name: "Men's Doubles 3.5",
      minEntries: 4,
    });
    const thin = await events.addCategory(organizer, event.id, {
      ...CATEGORY,
      name: "Women's Doubles 4.0",
      minEntries: 4,
    });
    await events.publish(organizer, event.id);
    await deadlinePassed(event.id);

    entries.confirmed.set(healthy.id, 8);
    entries.confirmed.set(thin.id, 2);

    const result = await events.closeRegistration(event.id);
    expect(result.closed).toEqual([healthy.id]);
    expect(result.cancelled).toEqual([thin.id]);
    expect((await events.categoryById(healthy.id)).status).toBe('closed');
    expect((await events.categoryById(thin.id)).status).toBe('cancelled');

    const emitted = await prisma.outbox.findMany({ where: { topic: 'category.cancelled' } });
    expect(emitted).toHaveLength(1);
    const payload = emitted[0]!.payload as { categoryId: string; refundPlatformFee: boolean };
    expect(payload.categoryId).toBe(thin.id);
    expect(payload.refundPlatformFee).toBe(true);
  });

  it('R9: closing twice does not refund twice', async () => {
    const event = await draft({ startsAt: soon(2), endsAt: soon(3), registrationClosesAt: soon(1) });
    const category = await events.addCategory(organizer, event.id, { ...CATEGORY, minEntries: 4 });
    await events.publish(organizer, event.id);
    await deadlinePassed(event.id);
    entries.confirmed.set(category.id, 1);

    await events.closeRegistration(event.id);
    const second = await events.closeRegistration(event.id);

    expect(second.cancelled).toEqual([]);
    expect(await prisma.outbox.count({ where: { topic: 'category.cancelled' } })).toBe(1);
  });

  it('R9: dueForClose finds an event whose deadline has passed', async () => {
    const overdue = await draft({ startsAt: soon(2), endsAt: soon(3), registrationClosesAt: soon(1) });
    await events.addCategory(organizer, overdue.id, CATEGORY);
    await events.publish(organizer, overdue.id);
    await deadlinePassed(overdue.id);

    const future = await draft({ title: 'Next Month' });
    await events.addCategory(organizer, future.id, CATEGORY);
    await events.publish(organizer, future.id);

    expect(await events.dueForClose()).toEqual([overdue.id]);
  });

  // --- authorization and lifecycle -------------------------------------------

  it('FORBIDDEN: a non-organizer cannot edit, publish or cancel an event', async () => {
    const event = await draft();
    await events.addCategory(organizer, event.id, CATEGORY);

    expect(await errorCode(() => events.update(stranger, event.id, { title: 'Mine' }))).toBe(
      'FORBIDDEN',
    );
    expect(await errorCode(() => events.publish(stranger, event.id))).toBe('FORBIDDEN');
    expect(await errorCode(() => events.cancel(stranger, event.id, 'nope'))).toBe('FORBIDDEN');
  });

  it('the creator is staff on their own event from the first instant', async () => {
    const event = await draft();
    const grant = await prisma.eventStaff.findUnique({
      where: {
        eventId_userId_source: { eventId: event.id, userId: organizer.userId, source: 'direct' },
      },
    });
    expect(grant?.role).toBe('owner');
  });

  it('a category must use a format the sport actually defines', async () => {
    const event = await draft();
    expect(
      await errorCode(() =>
        events.addCategory(organizer, event.id, { ...CATEGORY, format: 'quintuples' }),
      ),
    ).toBe(EventCode.INVALID_FORMAT);
  });

  it('team size comes from the sport’s format, not from the organizer', async () => {
    const event = await draft();
    const singles = await events.addCategory(organizer, event.id, {
      ...CATEGORY,
      name: "Men's Singles",
      format: 'singles',
    });
    const doubles = await events.addCategory(organizer, event.id, CATEGORY);

    expect(singles.teamSize).toBe(1);
    expect(doubles.teamSize).toBe(2);
  });

  it('an event at a venue takes the venue’s city, not the organizer’s typo', async () => {
    const venue = await venues.create(organizer, {
      name: 'Indiranagar Club',
      address: '100 Feet Road',
      city: 'Bengaluru',
      location: CENTRE,
    });
    const event = await draft({ venueId: venue.id, city: 'Bangalore' });
    expect(event.city).toBe('Bengaluru');
  });

  it('markLive flips a published event and emits event.live, idempotently', async () => {
    const event = await draft();
    await events.addCategory(organizer, event.id, CATEGORY);
    await events.publish(organizer, event.id);

    expect((await events.markLive(event.id)).status).toBe('live');
    await events.markLive(event.id);

    expect(await prisma.outbox.count({ where: { topic: 'event.live' } })).toBe(1);
  });

  it('category.full is emitted once, when the last seat goes', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, { ...CATEGORY, capacity: 4 });
    await events.publish(organizer, event.id);

    entries.confirmed.set(category.id, 3);
    expect(await events.refreshCategoryFullness(category.id)).toBe('open');
    expect(await prisma.outbox.count({ where: { topic: 'category.full' } })).toBe(0);

    entries.confirmed.set(category.id, 4);
    expect(await events.refreshCategoryFullness(category.id)).toBe('full');
    await events.refreshCategoryFullness(category.id);
    expect(await prisma.outbox.count({ where: { topic: 'category.full' } })).toBe(1);

    // And it reopens when a hold expires, without a second notification.
    entries.confirmed.set(category.id, 3);
    expect(await events.refreshCategoryFullness(category.id)).toBe('open');
    expect(await prisma.outbox.count({ where: { topic: 'category.full' } })).toBe(1);
  });

  describe('discovery search (discovery R1, events R11)', () => {
    const published = async (title: string, extra: Partial<Parameters<EventService['create']>[1]> = {}) => {
      const e = await draft({ title, ...extra });
      await events.addCategory(organizer, e.id, CATEGORY);
      await events.publish(organizer, e.id);
      return e;
    };

    it('R1: free text matches the title, case-insensitively and mid-word', async () => {
      const open = await published('Bengaluru Pickleball Open');
      await published('Indiranagar Badminton Smash');
      const page = await events.search({ query: '  pickleb ' }, { first: 20 });
      expect(page.nodes.map((e) => e.id)).toEqual([open.id]);
    });

    it('R1: free text matches the venue name too', async () => {
      const venue = await venues.create(organizer, {
        name: 'SG Highway Courts',
        address: 'SG Highway',
        city: 'Bengaluru',
        location: CENTRE,
      });
      const atVenue = await published('Weekend Ladder', { venueId: venue.id });
      await published('Another Ladder');
      const page = await events.search({ query: 'sg highway' }, { first: 20 });
      expect(page.nodes.map((e) => e.id)).toEqual([atVenue.id]);
    });

    it('R1: % and _ in the text are literal, and blank text is no filter', async () => {
      const off = await published('50% Off Doubles');
      await published('500 Club Singles');
      expect((await events.search({ query: '50%' }, { first: 20 })).nodes.map((e) => e.id)).toEqual([off.id]);
      expect((await events.search({ query: '_' }, { first: 20 })).nodes).toEqual([]);
      expect((await events.search({ query: '   ' }, { first: 20 })).nodes).toHaveLength(2);
    });

    it('R11: events are tournaments by default, and kind filters', async () => {
      const t = await published('Club Tournament');
      expect(t.kind).toBe('tournament');
      expect((await events.search({ kind: 'tournament' }, { first: 20 })).nodes.map((e) => e.id)).toEqual([t.id]);
      expect((await events.search({ kind: 'league_season' }, { first: 20 })).nodes).toEqual([]);
    });
  });

  // --- hosting (docs/superpowers/specs/2026-10-01-host-an-event-design.md) ---

  describe('hosting', () => {
    const FREE = { name: 'Open Singles', format: 'singles', capacity: 16, entryFeePaise: 0n };
    const PAID = { name: 'Open Doubles', format: 'doubles', capacity: 16, entryFeePaise: 50_000n };

    const gatedEvents = (gate: PublishGate) => createEventService({ ...eventDeps, publishGate: gate });
    const closedGate: PublishGate = {
      async canPublishPaid() {
        return { ok: false, missing: ['host verification', 'payout account'] };
      },
    };

    it('H1: a paid category takes the platform commission, a free one none', async () => {
      const event = await draft();
      const paid = await events.addCategory(organizer, event.id, PAID);
      const free = await events.addCategory(organizer, event.id, FREE);
      expect(paid.commissionBps).toBe(HOST_COMMISSION_BPS);
      expect(free.commissionBps).toBe(0);
    });

    it('H1: changing the fee moves the commission with it', async () => {
      const event = await draft();
      const cat = await events.addCategory(organizer, event.id, FREE);
      const nowPaid = await events.updateCategory(organizer, cat.id, { entryFeePaise: 20_000n });
      expect(nowPaid.commissionBps).toBe(HOST_COMMISSION_BPS);
      const freeAgain = await events.updateCategory(organizer, cat.id, { entryFeePaise: 0n });
      expect(freeAgain.commissionBps).toBe(0);
    });

    it('H2: the contact phone is an Indian mobile, stored as ten digits', async () => {
      const event = await draft({ contactPhone: '+91 98765 43210' });
      expect(event.contactPhone).toBe('9876543210');
      expect(await errorCode(() => draft({ contactPhone: '12345' }))).toBe(
        EventCode.INVALID_CONTACT_PHONE,
      );
      expect(
        await errorCode(() => events.update(organizer, event.id, { contactPhone: '5555555555' })),
      ).toBe(EventCode.INVALID_CONTACT_PHONE);
    });

    it('H2: accepting the hosting terms is stamped, and the location note kept', async () => {
      const event = await draft({ locationNote: '  Court 3, behind the parking lot ' });
      expect(event.hostTermsAcceptedAt).toBeInstanceOf(Date);
      expect(event.locationNote).toBe('Court 3, behind the parking lot');
    });

    it('H2: an over-long title, description or note is refused', async () => {
      expect(await errorCode(() => draft({ title: 'x'.repeat(81) }))).toBe(EventCode.INVALID_EVENT_FIELD);
      expect(await errorCode(() => draft({ description: 'x'.repeat(2001) }))).toBe(
        EventCode.INVALID_EVENT_FIELD,
      );
      expect(await errorCode(() => draft({ locationNote: 'x'.repeat(201) }))).toBe(
        EventCode.INVALID_EVENT_FIELD,
      );
    });

    it('H3: publish lists a missing phone and unaccepted terms', async () => {
      const event = await draft({ contactPhone: null, acceptHostTerms: false });
      await events.addCategory(organizer, event.id, FREE);
      try {
        await events.publish(organizer, event.id);
        expect.unreachable();
      } catch (e) {
        expect(isUserError(e) && e.code).toBe(EventCode.INVALID_EVENT_WINDOW);
        expect((e as Error).message).toMatch(/contact phone/);
        expect((e as Error).message).toMatch(/hosting terms/);
      }
    });

    it('H3: publish refuses a start in the past and a cancellation cutoff after the start', async () => {
      const past = await draft({
        startsAt: soon(-1),
        endsAt: soon(1),
        registrationClosesAt: soon(-2),
      });
      await events.addCategory(organizer, past.id, FREE);
      expect(await errorCode(() => events.publish(organizer, past.id))).toBe(
        EventCode.INVALID_EVENT_WINDOW,
      );

      const late = await draft({ cancellationCutoffAt: soon(31) });
      await events.addCategory(organizer, late.id, FREE);
      expect(await errorCode(() => events.publish(organizer, late.id))).toBe(
        EventCode.INVALID_EVENT_WINDOW,
      );
    });

    it('H3: registration closing exactly at the start is allowed', async () => {
      const startsAt = soon(10);
      const event = await draft({ startsAt, registrationClosesAt: startsAt });
      await events.addCategory(organizer, event.id, FREE);
      expect((await events.publish(organizer, event.id)).status).toBe('published');
    });

    it('H4: a paid category cannot publish past a closed gate, and says what is missing', async () => {
      const gated = gatedEvents(closedGate);
      const event = await draft();
      await events.addCategory(organizer, event.id, PAID);
      try {
        await gated.publish(organizer, event.id);
        expect.unreachable();
      } catch (e) {
        expect(isUserError(e) && e.code).toBe(EventCode.ORGANIZER_NOT_VERIFIED);
        expect((e as Error).message).toMatch(/host verification/);
      }
      expect((await events.byId(event.id)).status).toBe('draft');
    });

    it('H4: the payouts gate reads as a sentence whatever the account status (payouts R5)', async () => {
      const gated = gatedEvents({ canPublishPaid: async () => ({ ok: false, missing: ['no account'] }) });
      const event = await draft();
      await events.addCategory(organizer, event.id, PAID);
      const message = await gated.publish(organizer, event.id).then(
        () => '',
        (e: Error) => e.message,
      );
      expect(message).toMatch(/^Paid events need a verified payout account \(no account\)\./);
    });

    it('H4: a free event publishes through the same closed gate', async () => {
      const gated = gatedEvents(closedGate);
      const event = await draft();
      await events.addCategory(organizer, event.id, FREE);
      expect((await gated.publish(organizer, event.id)).status).toBe('published');
    });

    it('H4: an open gate lets a paid event publish', async () => {
      const gated = gatedEvents({
        async canPublishPaid() {
          return { ok: true, missing: [] };
        },
      });
      const event = await draft();
      await events.addCategory(organizer, event.id, PAID);
      expect((await gated.publish(organizer, event.id)).status).toBe('published');
    });
    it('H5: hostedBy lists the events a user runs, newest start first, and nobody else\'s', async () => {
      const later = await draft({ title: 'Later Cup', startsAt: soon(40) });
      const sooner = await draft({ title: 'Sooner Cup', startsAt: soon(20) });
      await events.addCategory(organizer, sooner.id, FREE);
      await events.publish(organizer, sooner.id);
      await events.create(stranger, {
        sportId: pickleballId,
        contactPhone: '9876543210',
        acceptHostTerms: true,
        title: 'Someone Else',
        city: 'Pune',
        startsAt: soon(10),
        endsAt: soon(11),
        registrationClosesAt: soon(9),
      });
      const hosted = await events.hostedBy(organizer.userId);
      expect(hosted.map((e) => e.id)).toEqual([later.id, sooner.id]);
      expect(await events.hostedBy(stranger.userId)).toHaveLength(1);
    });

    it('H6: the cover upload is signed under the event folder, and only for staff', async () => {
      const event = await draft();
      const upload = await events.coverUploadSignature(organizer, event.id);
      expect(upload.folder).toBe(`pl4y/events/${event.id}`);
      expect(await errorCode(() => events.coverUploadSignature(stranger, event.id))).toBe('FORBIDDEN');
    });

    it('H6: media must have been uploaded under this event', async () => {
      const event = await draft();
      const mine = `pl4y/events/${event.id}/abc`;
      const media = await events.addMedia(organizer, event.id, { publicId: mine, kind: 'cover' });
      expect(media.publicId).toBe(mine);
      expect((await events.byId(event.id)).coverPublicId).toBe(mine);
      expect(
        await errorCode(() =>
          events.addMedia(organizer, event.id, { publicId: 'pl4y/events/other/abc', kind: 'cover' }),
        ),
      ).toBe(EventCode.INVALID_EVENT_FIELD);
    });

    it('H7: the contact phone is for staff and seated entrants only', async () => {
      const event = await draft();
      expect(await events.canSeeContact(organizer.userId, event.id)).toBe(true);
      expect(await events.canSeeContact(stranger.userId, event.id)).toBe(false);
      expect(await events.canSeeContact(null, event.id)).toBe(false);
      entries.seated.add(`${event.id}:${stranger.userId}`);
      expect(await events.canSeeContact(stranger.userId, event.id)).toBe(true);
    });
  });
});

describe('events — gap review fixes (2026-10-03)', () => {
  const PAID = { name: 'Open Singles', format: 'singles', capacity: 16, entryFeePaise: 50_000n };
  const FREE = { ...PAID, entryFeePaise: 0n };
  const noVerifiedHost: PublishGate = {
    async canPublishPaid() {
      return { ok: false, missing: ['no account'] };
    },
  };

  it('gap #5: a published event cannot gain a paid draw without a verified host', async () => {
    const gated = createEventService({ ...eventDeps, publishGate: noVerifiedHost });
    const event = await draft();
    const free = await gated.addCategory(organizer, event.id, FREE);
    await gated.publish(organizer, event.id);

    expect(await errorCode(() => gated.addCategory(organizer, event.id, { ...PAID, name: 'Paid Later' }))).toBe(
      EventCode.ORGANIZER_NOT_VERIFIED,
    );
    expect(await errorCode(() => gated.updateCategory(organizer, free.id, { entryFeePaise: 30_000n }))).toBe(
      EventCode.ORGANIZER_NOT_VERIFIED,
    );
  });

  it('gap #7: the platform fee and the tax rate come from PL4Y, not the host', async () => {
    const priced = createEventService({ ...eventDeps, pricing: { platformFeePaise: 2_000n, taxBps: 500 } });
    const event = await draft();
    const paid = await priced.addCategory(organizer, event.id, PAID);
    expect(paid).toMatchObject({ platformFeePaise: 2_000n, taxBps: 500 });
    const free = await priced.addCategory(organizer, event.id, { ...FREE, name: 'Free' });
    expect(free.platformFeePaise).toBe(0n);
  });

  it('gap #8: a category that could never be drawn is refused', async () => {
    const event = await draft();
    const tooSmall = { ...PAID, capacity: 3 };
    expect(await errorCode(() => events.addCategory(organizer, event.id, tooSmall))).toBe(EventCode.INVALID_CATEGORY);
    expect(await errorCode(() => events.addCategory(organizer, event.id, { ...PAID, minEntries: 2 }))).toBe(
      EventCode.INVALID_CATEGORY,
    );
    expect(await errorCode(() => events.addCategory(organizer, event.id, { ...PAID, minEntries: 20 }))).toBe(
      EventCode.INVALID_CATEGORY,
    );
    expect(await errorCode(() => events.addCategory(organizer, event.id, { ...PAID, entryFeePaise: -1n }))).toBe(
      EventCode.INVALID_CATEGORY,
    );
    expect(
      await errorCode(() => events.addCategory(organizer, event.id, { ...PAID, skillMin: 4, skillMax: 3 })),
    ).toBe(EventCode.INVALID_CATEGORY);
    expect(await errorCode(() => events.addCategory(organizer, event.id, { ...PAID, name: '   ' }))).toBe(
      EventCode.INVALID_CATEGORY,
    );
    // A league needs three; a group stage six.
    const league = await events.addCategory(organizer, event.id, { ...PAID, name: 'League', capacity: 3, drawType: 'league' });
    expect(league.minEntries).toBe(3);
    expect(
      await errorCode(() => events.updateCategory(organizer, league.id, { drawType: 'groups_knockout' })),
    ).toBe(EventCode.INVALID_CATEGORY);
  });

  it('gap #11: a draft-free published draw with someone mid-payment keeps its price, size and format', async () => {
    const event = await draft();
    const category = await events.addCategory(organizer, event.id, PAID);
    await events.publish(organizer, event.id);
    entries.holds.set(category.id, 1);
    expect(await errorCode(() => events.updateCategory(organizer, category.id, { entryFeePaise: 70_000n }))).toBe(
      EventCode.EVENT_HAS_ENTRIES,
    );
    expect(await errorCode(() => events.updateCategory(organizer, category.id, { drawType: 'league' }))).toBe(
      EventCode.EVENT_HAS_ENTRIES,
    );
  });

  it('gap #35: an unknown time zone, or a cover that is not this event’s upload, is refused', async () => {
    expect(await errorCode(() => draft({ timezone: 'Asia/Kolkatta' }))).toBe(EventCode.INVALID_TIMEZONE);
    const event = await draft();
    expect(
      await errorCode(() => events.update(organizer, event.id, { coverPublicId: 'pl4y/events/someone-else/cover' })),
    ).toBe(EventCode.INVALID_EVENT_FIELD);
  });

  it('gap #1: an event completes when its last draw does, and a day after it ends regardless', async () => {
    const event = await draft();
    const a = await events.addCategory(organizer, event.id, PAID);
    const b = await events.addCategory(organizer, event.id, { ...PAID, name: 'Second' });
    await events.publish(organizer, event.id);

    await prisma.eventCategory.update({ where: { id: a.id }, data: { status: 'completed' } });
    expect(await events.completeIfFinished(event.id)).toBe(false);
    await prisma.eventCategory.update({ where: { id: b.id }, data: { status: 'cancelled' } });
    expect(await events.completeIfFinished(event.id)).toBe(true);
    expect((await events.byId(event.id)).status).toBe('completed');
    expect(await prisma.outbox.count({ where: { topic: 'event.completed' } })).toBe(1);

    const forgotten = await draft({ title: 'Never Scored' });
    await events.addCategory(organizer, forgotten.id, PAID);
    await events.publish(organizer, forgotten.id);
    expect(await events.dueForCompletion()).toEqual([]);
    await prisma.event.update({
      where: { id: forgotten.id },
      data: { startsAt: soon(-3), endsAt: soon(-2), registrationClosesAt: soon(-4) },
    });
    expect(await events.dueForCompletion()).toEqual([forgotten.id]);
  });

  it('gap #6: the host can close registration early; under-minimum draws are cancelled as at the deadline', async () => {
    const event = await draft();
    const healthy = await events.addCategory(organizer, event.id, PAID);
    const thin = await events.addCategory(organizer, event.id, { ...PAID, name: 'Thin' });
    await events.publish(organizer, event.id);
    entries.confirmed.set(healthy.id, 6);
    entries.confirmed.set(thin.id, 1);

    expect(await errorCode(() => events.closeRegistrationNow(stranger, event.id))).toBe('FORBIDDEN');
    const result = await events.closeRegistrationNow(organizer, event.id);
    expect(result).toEqual({ closed: [healthy.id], cancelled: [thin.id] });
    expect((await events.byId(event.id)).registrationClosesAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('gap #26: the owner adds a scorer and a manager; a manager may add scorers only', async () => {
    const event = await draft();
    const helper = await makeUser('helper@example.com');
    const deputy = await makeUser('deputy@example.com');
    const third = await makeUser('third@example.com');

    await events.addStaffMember(organizer, event.id, { email: 'helper@example.com', role: 'scorer' });
    await events.addStaffMember(organizer, event.id, { email: 'DEPUTY@example.com', role: 'manager' });
    const staff = await events.staffOf(organizer, event.id);
    expect(staff.map((m) => [m.userId, m.role]).sort()).toEqual(
      [
        [organizer.userId, 'owner'],
        [helper.userId, 'scorer'],
        [deputy.userId, 'manager'],
      ].sort(),
    );

    expect(
      await errorCode(() => events.addStaffMember(deputy, event.id, { email: 'third@example.com', role: 'manager' })),
    ).toBe('FORBIDDEN');
    await events.addStaffMember(deputy, event.id, { email: 'third@example.com', role: 'scorer' });
    expect(await errorCode(() => events.addStaffMember(helper, event.id, { email: 'x@example.com', role: 'scorer' }))).toBe(
      'FORBIDDEN',
    );
    expect(
      await errorCode(() => events.addStaffMember(organizer, event.id, { email: 'nobody@example.com', role: 'scorer' })),
    ).toBe(EventCode.STAFF_USER_NOT_FOUND);
    expect(await errorCode(() => events.removeStaffMember(deputy, event.id, organizer.userId))).toBe(
      EventCode.CANNOT_CHANGE_OWNER,
    );

    await events.removeStaffMember(organizer, event.id, third.userId);
    expect((await events.staffOf(organizer, event.id)).some((m) => m.userId === third.userId)).toBe(false);
  });

  it('gap #31: Discover leaves out events that have already ended', async () => {
    const past = await draft({ title: 'Last Month' });
    await events.addCategory(organizer, past.id, PAID);
    await events.publish(organizer, past.id);
    await prisma.event.update({
      where: { id: past.id },
      data: { startsAt: soon(-3), endsAt: soon(-2), registrationClosesAt: soon(-4) },
    });
    const upcoming = await draft({ title: 'Next Month' });
    await events.addCategory(organizer, upcoming.id, PAID);
    await events.publish(organizer, upcoming.id);

    const page = await events.search({}, { first: 20 });
    expect(page.nodes.map((e) => e.id)).toEqual([upcoming.id]);
  });
});
