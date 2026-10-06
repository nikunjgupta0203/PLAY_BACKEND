/**
 * bookings — service tests against a real Postgres (conventions.md §5).
 *
 * The Done when of docs/modules/19-bookings.md, in order: fifty concurrent
 * holds produce one booking; an expired hold frees its slot for the very next
 * insert without the sweep; a reserved court shows unavailable; a desk walk-in
 * on a held slot is refused; a cancellation 25 hours out refunds in full,
 * exactly once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, contactsPortFor, FakeEmail, FakeGateway, FakeQueue } from './helpers/modules.js';
import type { Db } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { isUserError } from '../src/platform/errors/index.js';
import { createPaymentsRepo } from '../src/modules/payments/repo/index.js';
import { createPaymentsService, type PaymentsService } from '../src/modules/payments/service/index.js';
import { createBookingsRepo } from '../src/modules/bookings/repo/index.js';
import { createBookingsService, HOLD_MINUTES, type BookingsService } from '../src/modules/bookings/service/index.js';
import { localMidnight } from '../src/modules/bookings/service/slots.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let bookings: BookingsService;
let payments: PaymentsService;
let gateway: FakeGateway;
let clock: Date;
const notices: { userId: string; template: string }[] = [];

const MIN = 60_000;
const HOUR = 60 * MIN;

async function user(name: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email: `${name}-${userId.slice(0, 8)}@example.com`, displayName: name } });
  return { userId };
}

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? `THREW: ${String(e)}`;
  }
  return 'NO_ERROR';
};

/** A venue with one court, open 06:00–22:00 every day at ₹600/h, taking bookings. */
async function bookableVenue(owner: { userId: string }) {
  const sportId = await seedSport(prisma, PICKLEBALL);
  modules.sport.refresh();
  const venue = await modules.venues.create(owner, {
    name: 'Smash Arena',
    address: '1 MG Road',
    city: 'Bengaluru',
    location: { lat: 12.97, lng: 77.59 },
    courts: [{ name: 'Court 1', sportIds: [sportId] }],
  });
  const [court] = await modules.venues.courtsFor(venue.id);
  await bookings.setPolicy(owner, venue.id, { bookable: true, minSlotMinutes: 60, platformFeePaise: 2_000n, taxBps: 0 });
  await bookings.setRules(
    owner,
    court!.id,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensMin: 6 * 60, closesMin: 22 * 60, pricePerHourPaise: 60_000n })),
  );
  return { venue, court: court! };
}

/** Tomorrow (local) at `hour`:00, as a [start, end) hour. */
function slotTomorrow(hour: number, hours = 1): { startsAt: Date; endsAt: Date } {
  const today = new Date(clock.getTime() + 330 * MIN).toISOString().slice(0, 10);
  const midnight = localMidnight(today)!;
  const startsAt = new Date(midnight.getTime() + 24 * HOUR + hour * HOUR);
  return { startsAt, endsAt: new Date(startsAt.getTime() + hours * HOUR) };
}

async function pay(actor: { userId: string }, bookingId: string): Promise<void> {
  const order = await payments.createBookingOrder(actor, bookingId);
  gateway.capture(order.gatewayOrderId);
  await payments.refreshBookingPayment(actor, bookingId);
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  modules = buildModules(prisma);
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  modules.sport.refresh();
  notices.length = 0;
  clock = new Date('2026-10-07T04:30:00.000Z'); // Wednesday 10:00 IST
  const db = prisma as unknown as Db;
  gateway = new FakeGateway();
  const jobs = new FakeQueue();
  // payments and bookings call each other; the second is bound once it exists.
  const late: { bookings?: BookingsService } = {};
  payments = createPaymentsService({
    db,
    repo: createPaymentsRepo(db),
    gateway,
    events: {
      priceQuote: async () => {
        throw new Error('not used');
      },
      byId: async () => ({ id: '', title: '' }),
      forEmail: async () => {
        throw new Error('not used');
      },
    },
    registration: {
      byId: async () => {
        throw new Error('not used');
      },
      extendHold: async () => undefined,
      confirmFromPayment: async () => ({ confirmedNow: false }),
      failFromPayment: async () => undefined,
    },
    bookings: {
      byId: (id) => late.bookings!.forPayments(id),
      extendHold: (id, minutes) => late.bookings!.extendHold(id, minutes),
      confirmFromPayment: (input) => late.bookings!.confirmFromPayment(input),
      failFromPayment: (input) => late.bookings!.failFromPayment(input),
    },
    users: contactsPortFor(prisma),
    email: new FakeEmail(),
    queue: jobs,
    now: () => clock,
  });
  bookings = createBookingsService({
    db,
    repo: createBookingsRepo(db),
    venues: {
      byId: async (id) => {
        const v = await modules.venues.byId(id);
        return { id: v.id, name: v.name, createdBy: v.createdBy };
      },
      courtsFor: (id) => modules.venues.courtsFor(id),
      courtById: (id) => modules.venues.findCourtById(id),
    },
    payments: { refundForBooking: (input) => payments.refundForBooking(input) },
    users: {
      findByEmail: async (email) => prisma.user.findFirst({ where: { email }, select: { id: true } }),
      namesByIds: async (ids) =>
        new Map((await prisma.user.findMany({ where: { id: { in: ids } } })).map((u) => [u.id, u.displayName])),
    },
    queue: { releaseHold: async () => undefined },
    notify: async (userId, template) => {
      notices.push({ userId, template });
    },
    now: () => clock,
  });
  late.bookings = bookings;
});

describe('bookings — Done when', () => {
  it('bookings R1: fifty concurrent holds on one court and slot produce exactly one booking', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const players = await Promise.all(Array.from({ length: 50 }, (_, i) => user(`P${i}`)));
    const slot = slotTomorrow(18);
    const results = await Promise.all(players.map((p) => codeOf(() => bookings.hold(p, { courtId: court.id, ...slot }))));
    // Anything other than a win or "taken" is printed, so a new failure mode names itself.
    expect(results.filter((r) => r !== 'NO_ERROR' && r !== 'SLOT_UNAVAILABLE')).toEqual([]);
    expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
    expect(results.filter((r) => r === 'SLOT_UNAVAILABLE')).toHaveLength(49);
    expect(await prisma.courtBooking.count({ where: { status: 'held' } })).toBe(1);
  });

  it('bookings R3: an expired hold frees its slot for the very next insert, without the sweep', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const [a, b] = [await user('A'), await user('B')];
    const slot = slotTomorrow(7);
    const first = await bookings.hold(a, { courtId: court.id, ...slot });
    expect(await codeOf(() => bookings.hold(b, { courtId: court.id, ...slot }))).toBe('SLOT_UNAVAILABLE');
    clock = new Date(clock.getTime() + (HOLD_MINUTES + 1) * MIN);
    const second = await bookings.hold(b, { courtId: court.id, ...slot });
    expect(second.status).toBe('held');
    expect((await prisma.courtBooking.findUnique({ where: { id: first.id } }))!.status).toBe('expired');
  });

  it('bookings R4: a court reserved for an event shows unavailable and cannot be held', async () => {
    const owner = await user('Owner');
    const { venue, court } = await bookableVenue(owner);
    const slot = slotTomorrow(9, 3);
    await bookings.addBlackout(owner, { venueId: venue.id, courtId: court.id, kind: 'event', ...slot });
    const date = new Date(slot.startsAt.getTime() + 330 * MIN).toISOString().slice(0, 10);
    const grid = await bookings.availability(venue.id, date);
    const inside = grid.filter((s) => s.startsAt >= slot.startsAt && s.startsAt < slot.endsAt);
    expect(inside).toHaveLength(3);
    expect(inside.every((s) => !s.available)).toBe(true);
    expect(grid.some((s) => s.available)).toBe(true);
    const player = await user('Player');
    expect(await codeOf(() => bookings.hold(player, { courtId: court.id, startsAt: slot.startsAt, endsAt: new Date(slot.startsAt.getTime() + HOUR) }))).toBe(
      'SLOT_UNAVAILABLE',
    );
  });

  it('bookings R8: a desk walk-in on a held slot is refused — the desk has no bypass', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    const slot = slotTomorrow(19);
    await bookings.hold(player, { courtId: court.id, ...slot });
    expect(
      await codeOf(() => bookings.walkIn(owner, { courtId: court.id, ...slot, name: 'Ravi', paymentMode: 'offline' })),
    ).toBe('SLOT_UNAVAILABLE');
    const free = slotTomorrow(20);
    const walkIn = await bookings.walkIn(owner, { courtId: court.id, ...free, name: 'Ravi', paymentMode: 'offline' });
    expect(walkIn.status).toBe('confirmed');
    expect(walkIn.userId).toBeNull();
  });

  it('bookings R6: cancelling 25 hours before start refunds the court money in full, exactly once', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    const slot = slotTomorrow(12);
    const held = await bookings.hold(player, { courtId: court.id, ...slot });
    expect(held.amountPaise).toBe(62_000n);
    await pay(player, held.id);
    expect((await bookings.byId(held.id))!.status).toBe('confirmed');

    clock = new Date(slot.startsAt.getTime() - 25 * HOUR);
    const preview = await bookings.cancelPreview(player, held.id);
    expect(preview.refundPaise).toBe(60_000n);
    const { refundPaise } = await bookings.cancel(player, held.id);
    expect(refundPaise).toBe(60_000n);
    expect(await codeOf(() => bookings.cancel(player, held.id))).toBe('NOT_CANCELLABLE');
    const refunds = await prisma.refund.findMany();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountPaise).toBe(60_000n);
    // The same refund asked for again is the same row.
    await payments.refundForBooking({ bookingId: held.id, reason: 'booking_cancelled', courtShareBps: 10_000, includePlatformFee: false });
    expect(await prisma.refund.count()).toBe(1);
  });
});

describe('bookings — rules', () => {
  it('bookings R2: only a verified capture confirms; the booking was held until then', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    const held = await bookings.hold(player, { courtId: court.id, ...slotTomorrow(8) });
    expect(held.status).toBe('held');
    const order = await payments.createBookingOrder(player, held.id);
    expect(order.amountPaise).toBe(held.amountPaise);
    expect((await bookings.byId(held.id))!.status).toBe('held');
    gateway.capture(order.gatewayOrderId);
    await payments.refreshBookingPayment(player, held.id);
    expect((await bookings.byId(held.id))!.status).toBe('confirmed');
    expect(notices.map((n) => n.template)).toContain('booking.confirmed');
  });

  it('bookings R2: a capture for a lapsed hold whose court was taken is refunded in full', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const [a, b] = [await user('A'), await user('B')];
    const slot = slotTomorrow(10);
    const held = await bookings.hold(a, { courtId: court.id, ...slot });
    const order = await payments.createBookingOrder(a, held.id);
    clock = new Date(clock.getTime() + 25 * MIN);
    await bookings.hold(b, { courtId: court.id, ...slot });
    gateway.capture(order.gatewayOrderId);
    await payments.refreshBookingPayment(a, held.id).catch(() => undefined);
    // `held` is now expired (the insert expired it), so refresh skips it; reconciliation settles it.
    clock = new Date(clock.getTime() + 10 * MIN);
    await payments.reconcilePending();
    expect((await bookings.byId(held.id))!.status).toBe('expired');
    const refund = await prisma.refund.findFirst();
    expect(refund?.amountPaise).toBe(held.amountPaise);
  });

  it('bookings R5: the quote is frozen at hold time', async () => {
    const owner = await user('Owner');
    const { venue, court } = await bookableVenue(owner);
    const player = await user('Player');
    const held = await bookings.hold(player, { courtId: court.id, ...slotTomorrow(14, 2) });
    expect(held.courtPaise).toBe(120_000n);
    await bookings.setPolicy(owner, venue.id, { platformFeePaise: 9_000n });
    const order = await payments.createBookingOrder(player, held.id);
    expect(order.amountPaise).toBe(122_000n);
  });

  it('bookings R6: the venue cancelling refunds everything, platform fee included', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    const held = await bookings.hold(player, { courtId: court.id, ...slotTomorrow(16) });
    await pay(player, held.id);
    await bookings.venueCancel(owner, held.id, 'Roof leak');
    const refund = await prisma.refund.findFirst();
    expect(refund?.amountPaise).toBe(62_000n);
  });

  it('bookings R6: inside the last hours nothing comes back', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    const slot = slotTomorrow(17);
    const held = await bookings.hold(player, { courtId: court.id, ...slot });
    await pay(player, held.id);
    clock = new Date(slot.startsAt.getTime() - 2 * HOUR);
    expect((await bookings.cancel(player, held.id)).refundPaise).toBe(0n);
    expect(await prisma.refund.count()).toBe(0);
  });

  it('bookings R7: the desk sees the schedule; a stranger does not', async () => {
    const owner = await user('Owner');
    const { venue } = await bookableVenue(owner);
    const stranger = await user('Stranger');
    expect(await codeOf(() => bookings.schedule(stranger, venue.id, '2026-10-08'))).toBe('FORBIDDEN');
    const desk = await user('Desk');
    const deskEmail = (await prisma.user.findUnique({ where: { id: desk.userId } }))!.email;
    await bookings.setStaff(owner, venue.id, deskEmail, 'desk');
    const schedule = await bookings.schedule(desk, venue.id, '2026-10-08');
    expect(schedule.courts).toHaveLength(1);
    // The desk does not edit rules.
    expect(await codeOf(() => bookings.setPolicy(desk, venue.id, { advanceDays: 30 }))).toBe('FORBIDDEN');
  });

  it('bookings R10: three hours a day per venue, two open holds at most', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    await bookings.hold(player, { courtId: court.id, ...slotTomorrow(6, 2) });
    expect(await codeOf(() => bookings.hold(player, { courtId: court.id, ...slotTomorrow(9, 2) }))).toBe('BOOKING_LIMIT_EXCEEDED');
    await bookings.hold(player, { courtId: court.id, ...slotTomorrow(9, 1) });
    expect(await codeOf(() => bookings.hold(player, { courtId: court.id, ...slotTomorrow(11, 1) }))).toBe('BOOKING_LIMIT_EXCEEDED');
    const far = { startsAt: new Date(clock.getTime() + 20 * 24 * HOUR), endsAt: new Date(clock.getTime() + 20 * 24 * HOUR + HOUR) };
    const other = await user('Other');
    expect(await codeOf(() => bookings.hold(other, { courtId: court.id, ...far }))).toBe('OUTSIDE_BOOKING_WINDOW');
  });

  it('bookings R12: no-shows are marked by the desk once the slot started', async () => {
    const owner = await user('Owner');
    const { court } = await bookableVenue(owner);
    const player = await user('Player');
    const slot = slotTomorrow(6);
    const held = await bookings.hold(player, { courtId: court.id, ...slot });
    await pay(player, held.id);
    expect(await codeOf(() => bookings.markNoShow(owner, held.id))).toBe('NOT_CANCELLABLE');
    clock = new Date(slot.startsAt.getTime() + 20 * MIN);
    expect((await bookings.markNoShow(owner, held.id)).status).toBe('no_show');
  });

  it('a venue that does not take bookings refuses a hold', async () => {
    const owner = await user('Owner');
    const { venue, court } = await bookableVenue(owner);
    await bookings.setPolicy(owner, venue.id, { bookable: false });
    const player = await user('Player');
    expect(await codeOf(() => bookings.hold(player, { courtId: court.id, ...slotTomorrow(8) }))).toBe('VENUE_NOT_BOOKABLE');
  });
});
