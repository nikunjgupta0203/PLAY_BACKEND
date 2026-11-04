/**
 * The cue-sports launch, end to end against a real Postgres
 * (docs/plans/2026-11-03-cue-launch.md §12).
 *
 *   1. a player discovers a snooker venue (and only cue-sports venues show);
 *   2. picks a table and a free time; 3. a duration (30/40/60/90);
 *   4. gets the right price (peak and off-peak); 5. the venue's and PL4Y's
 *   discounts, separately; 6. pays online or chooses pay at venue;
 *   7. is confirmed with a receipt; 8. the owner sees the booking;
 *   9. the owner tracks payment and revenue — and the payout pays them.
 *
 * And the edges: failed payments, cancellations, unavailable tables,
 * discount combinations and limits, duplicate bookings and duplicate payments.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, contactsPortFor, FakeEmail, FakeGateway, FakeMedia, FakeQueue, FakeSchedule } from './helpers/modules.js';
import type { Db } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { isUserError } from '../src/platform/errors/index.js';
import { createPaymentsRepo } from '../src/modules/payments/repo/index.js';
import { createPaymentsService, type PaymentsService } from '../src/modules/payments/service/index.js';
import { createBookingsRepo } from '../src/modules/bookings/repo/index.js';
import { createBookingsService, type BookingsService } from '../src/modules/bookings/service/index.js';
import { localMidnight, setOnlineOnlyBookingsForTests } from '../src/modules/bookings/service/slots.js';
import { createPricingService, type PricingService } from '../src/modules/pricing/service/index.js';
import { createRewardsService, type RewardsService } from '../src/modules/rewards/service/index.js';
import { createVenuePayouts, type VenuePayouts } from '../src/modules/venuepay/service/payouts.js';
import { createVenueRepo } from '../src/modules/venues/repo/index.js';
import { createVenueService } from '../src/modules/venues/service/index.js';
import { setSportFocusForTests } from '../src/modules/sport/service/offered.js';
import { PICKLEBALL, POOL, SNOOKER, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let bookings: BookingsService;
let payments: PaymentsService;
let pricing: PricingService;
let rewards: RewardsService;
let payouts: VenuePayouts;
let gateway: FakeGateway;
let email: FakeEmail;
let clock: Date;
const notices: { userId: string; template: string; payload: Record<string, unknown> }[] = [];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function user(name: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email: `${name.toLowerCase()}-${userId.slice(0, 8)}@example.com`, displayName: name } });
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

/** Tomorrow (local) at hh:mm, for `minutes`. */
function slot(hour: number, minutes: number, minute = 0, days = 1): { startsAt: Date; endsAt: Date } {
  const today = new Date(clock.getTime() + 330 * MIN).toISOString().slice(0, 10);
  const startsAt = new Date(localMidnight(today)!.getTime() + days * DAY + hour * HOUR + minute * MIN);
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * MIN) };
}

/**
 * A snooker club: two tables, open 10:00–23:00, ₹300/h off-peak and ₹480/h
 * from 18:00 (peak); bookings of 30, 40, 60 or 90 minutes every 10 minutes.
 */
async function snookerClub(owner: { userId: string }, paymentOptions: 'online' | 'at_venue' | 'both' = 'both') {
  const snooker = await seedSport(prisma, SNOOKER);
  modules.sport.refresh();
  const venue = await modules.venues.create(owner, {
    name: 'Cue Masters',
    address: '12 Connaught Place',
    city: 'New Delhi',
    location: { lat: 28.63, lng: 77.22 },
    courts: [],
  });
  await bookings.saveTable(owner, venue.id, { name: 'Snooker 1', sportIds: [snooker] });
  await bookings.saveTable(owner, venue.id, { name: 'Snooker 2', sportIds: [snooker] });
  const tables = await modules.venues.courtsFor(venue.id);
  await bookings.setPolicy(owner, venue.id, {
    bookable: true,
    minSlotMinutes: 30,
    slotStepMinutes: 10,
    durationOptions: [30, 40, 60, 90],
    paymentOptions,
    platformFeePaise: 0n,
    taxBps: 0,
  });
  for (const t of tables) {
    await bookings.setRules(
      owner,
      t.id,
      [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { weekday, opensMin: 10 * 60, closesMin: 18 * 60, pricePerHourPaise: 30_000n },
        { weekday, opensMin: 18 * 60, closesMin: 23 * 60, pricePerHourPaise: 48_000n },
      ]),
    );
  }
  return { venue, tables, snooker };
}

async function payOnline(actor: { userId: string }, bookingId: string) {
  const order = await payments.createBookingOrder(actor, bookingId);
  gateway.capture(order.gatewayOrderId);
  await payments.refreshBookingPayment(actor, bookingId);
  return order;
}

const booking = (id: string) => prisma.courtBooking.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  modules = buildModules(prisma);
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(() => {
  setSportFocusForTests(null);
  setOnlineOnlyBookingsForTests(null);
});

beforeEach(async () => {
  await truncateAll(prisma);
  modules.sport.refresh();
  notices.length = 0;
  clock = new Date('2026-11-04T04:30:00.000Z'); // Wednesday 10:00 IST
  const db = prisma as unknown as Db;
  gateway = new FakeGateway();
  email = new FakeEmail();
  // Rewards are off unless a test turns them on, so amounts read plainly.
  await prisma.rewardSettings.upsert({ where: { id: 1 }, create: { id: 1, enabled: false }, update: { enabled: false } });
  const late: { bookings?: BookingsService } = {};
  rewards = createRewardsService({ db, limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) }, now: () => clock });
  pricing = createPricingService({
    db,
    roleAt: (actor, venueId) => late.bookings!.roleAt(actor, venueId),
    async notifyMany(userIds, template, payload) {
      for (const userId of userIds) notices.push({ userId, template, payload });
    },
    now: () => clock,
  });
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
    rewards: {
      discountFor: (userId, gross) => rewards.discountFor(userId, gross),
      onCapture: (order) => rewards.onCapture(order),
      onFullRefund: (orderId) => rewards.onFullRefund(orderId),
    },
    users: contactsPortFor(prisma),
    email: new FakeEmail(),
    queue: new FakeQueue(),
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
      addCourt: (venueId, input) =>
        modules.venues.addCourt({ userId: 'bookings', platformStaff: true }, venueId, { name: input.name, sportIds: input.sportIds, kind: 'table' }),
      updateCourt: (courtId, patch) => modules.venues.updateCourt({ userId: 'bookings', platformStaff: true }, courtId, patch),
    },
    payments: { refundForBooking: (input) => payments.refundForBooking(input) },
    pricing: {
      priceBooking: (input) => pricing.priceBooking(input),
      reserve: (input) => pricing.reserve(input as never),
      redeem: (id) => pricing.redeem(id),
      release: (id) => pricing.release(id),
      releaseDead: () => pricing.releaseDead(),
      commissionFor: (venueId, kind) => pricing.commissionFor(venueId, kind),
      ensureTerms: (venueId) => pricing.ensureTerms(venueId),
      rewardsWithPromos: async () => (await pricing.settings()).rewardsWithPromos,
      offerTitles: async (ids) => new Map((await prisma.offer.findMany({ where: { id: { in: ids } } })).map((o) => [o.id, o.title])),
    },
    users: {
      findByEmail: async (e) => prisma.user.findFirst({ where: { email: e }, select: { id: true } }),
      namesByIds: async (ids) => new Map((await prisma.user.findMany({ where: { id: { in: ids } } })).map((u) => [u.id, u.displayName])),
      contactsByIds: (ids) => contactsPortFor(prisma).byIds(ids),
    },
    email,
    queue: { releaseHold: async () => undefined },
    notify: async (userId, template, payload) => {
      notices.push({ userId, template, payload });
    },
    notifyVenue: async (userId, template, payload) => {
      notices.push({ userId, template, payload });
    },
    venuePayments: async () => [],
    now: () => clock,
  });
  late.bookings = bookings;
  payouts = createVenuePayouts({
    db,
    async accountOf(userId) {
      const row =
        (await prisma.payoutAccount.findFirst({ where: { userId } })) ??
        (await prisma.payoutAccount.create({
          data: {
            id: newId(),
            userId,
            legalName: 'Venue Owner',
            panCipher: Buffer.from('pan'),
            panLast4: '1234',
            accountCipher: Buffer.from('acct'),
            accountLast4: '7890',
            ifsc: 'HDFC0000001',
            panSurnameOk: true,
            status: 'verified',
          },
        }));
      return { id: row.id, status: 'verified', detailsChangedAt: null };
    },
    rates: { commissionGstBps: 0, tdsBps: 0 },
    launchedAt: async () => (await pricing.settings()).launchedAt,
    now: () => clock,
  });
});

describe('1 · sports: snooker, pool and billiards only', () => {
  it('lists only the cue sports, refuses new things for paused ones, and discovery shows only cue-sports venues', async () => {
    setSportFocusForTests(true);
    const snooker = await seedSport(prisma, SNOOKER);
    await seedSport(prisma, POOL);
    const pickleball = await seedSport(prisma, PICKLEBALL);
    modules.sport.refresh();
    expect((await modules.sport.list()).map((s) => s.slug).sort()).toEqual(['pool', 'snooker']);
    expect(await codeOf(() => modules.sport.requireOffered(pickleball))).toBe('SPORT_NOT_FOUND');
    // A paused sport still resolves for old matches (sport R3).
    expect((await modules.sport.byId(pickleball)).slug).toBe('pickleball');

    const owner = await user('Owner');
    const venues = createVenueService({
      repo: createVenueRepo(prisma as unknown as Db),
      schedule: new FakeSchedule(),
      media: new FakeMedia(),
      offeredSportIds: () => modules.sport.offeredIdsOrNull(),
    });
    const at = { lat: 28.63, lng: 77.22 };
    await venues.create(owner, { name: 'Cue Masters', address: 'CP', city: 'New Delhi', location: at, courts: [{ name: 'T1', sportIds: [snooker] }] });
    await venues.create(owner, { name: 'Smash Arena', address: 'CP', city: 'New Delhi', location: at, courts: [{ name: 'C1', sportIds: [pickleball] }] });
    const found = await venues.search({ near: at, radiusKm: 10 }, { first: 10 });
    expect(found.nodes.map((v) => v.name)).toEqual(['Cue Masters']);
    // Nothing is deleted: the other venue is still reachable directly.
    setSportFocusForTests(false);
    expect((await venues.search({ near: at, radiusKm: 10 }, { first: 10 })).nodes).toHaveLength(2);
  });
});

describe('2–9 · discover, pick, price, discount, pay, confirm, track', () => {
  it('the whole flow online: 40 minutes off-peak, venue 20% + PL4Y 10% up to ₹100, paid, on the dashboard, 0% commission, paid out', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner, 'online');
    const t1 = tables[0]!;

    // The owner's offer, and PL4Y's.
    await pricing.saveVenueOffer(owner, venue.id, { title: 'Weekday 20%', kind: 'percent', percentBps: 2000 });
    await pricing.savePlatformOffer(owner.userId, { title: 'PL4Y launch', kind: 'percent', percentBps: 1000, maxDiscountPaise: 10_000n });

    // 2, 3 — the options, then free 40-minute slots every 10 minutes.
    const options = await bookings.bookingOptions(venue.id);
    expect(options.durations).toEqual([30, 40, 60, 90]);
    expect(options.paymentChoices).toEqual(['online']);
    const date = new Date(slot(0, 0).startsAt.getTime() + 12 * HOUR).toISOString().slice(0, 10);
    const grid = await bookings.availability(venue.id, date, { durationMinutes: 40 });
    const first = grid.find((s) => s.courtId === t1.id && s.available)!;
    expect(first.pricePaise).toBe(20_000n); // 40 min at ₹300/h
    expect(grid.filter((s) => s.courtId === t1.id)[1]!.startsAt.getTime() - first.startsAt.getTime()).toBe(10 * MIN);

    // 4, 5 — the price, both discounts separately.
    const s = slot(14, 40);
    const q = await bookings.quoteForPlayer(player, { courtId: t1.id, ...s });
    expect(q.basePaise).toBe(20_000n);
    expect(q.venueDiscountPaise).toBe(4_000n); // 20%
    expect(q.platformDiscountPaise).toBe(1_600n); // 10% of ₹160
    expect(q.totalPaise).toBe(14_400n);
    expect(q.venueOfferTitle).toBe('Weekday 20%');
    expect(q.platformOfferTitle).toBe('PL4Y launch');

    // 6 — online: held, then paid.
    const held = await bookings.hold(player, { courtId: t1.id, ...s, payment: 'online' });
    expect(held.status).toBe('held');
    expect(held.bookingCode).toMatch(/^BK-[A-Z2-9]{8}$/);
    expect(held.venueGrossPaise).toBe(16_000n); // the venue earns its price after its own discount
    expect(held.commissionPaise).toBe(0n); // first 30 days
    const order = await payOnline(player, held.id);
    expect(order.amountPaise).toBe(14_400n);

    // 7 — confirmed, receipt, notices.
    const paid = await booking(held.id);
    expect(paid.status).toBe('confirmed');
    expect(paid.paymentStatus).toBe('paid');
    expect(paid.collectedBy).toBe('pl4y');
    expect(paid.paymentMethod).toBe('upi');
    expect(notices.some((n) => n.userId === player.userId && n.template === 'booking.confirmed')).toBe(true);
    expect(notices.some((n) => n.userId === owner.userId && n.template === 'venue.booking_received')).toBe(true);
    expect(email.sent.some((m) => m.subject.startsWith(`Receipt ${paid.bookingCode}`))).toBe(true);
    expect(await prisma.offerRedemption.count({ where: { bookingId: held.id, status: 'redeemed' } })).toBe(2);

    // 8, 9 — the owner sees it, with revenue and who paid for each discount.
    const list = await bookings.venueBookings(owner, venue.id, { from: date, to: date });
    expect(list.map((b) => b.bookingCode)).toEqual([paid.bookingCode]);
    const dash = await bookings.dashboard(owner, venue.id, date, date);
    expect(dash.bookings).toBe(1);
    expect(dash.revenuePaise).toBe(16_000n);
    expect(dash.venueDiscountPaise).toBe(4_000n);
    expect(dash.platformDiscountPaise).toBe(1_600n);
    expect(dash.commissionPaise).toBe(0n);
    expect(dash.customers).toBe(1);
    const tx = await bookings.transactions(owner, venue.id, { from: localDateOf(clock), to: date });
    expect(tx[0]).toMatchObject({ reference: paid.bookingCode, venueEarningsPaise: 16_000n, platformDiscountPaise: 1_600n, commissionPaise: 0n });
    const offers = await pricing.venueOffers(owner, venue.id);
    expect((await pricing.stats(offers.map((o) => o.id))).get(offers[0]!.id)).toMatchObject({ redeemed: 1, players: 1, discountPaise: 4_000n });

    // The intro banner.
    const intro = await pricing.introStatus(venue.id);
    expect(intro.message).toBe('Enjoy 0% Commission on PL4Y for Your First 30 Days.');
    expect(intro.daysLeft).toBe(30);

    // The monthly payout pays the venue its ₹160 in full: PL4Y's ₹16 discount is PL4Y's.
    clock = new Date('2026-12-01T04:30:00.000Z');
    expect(await payouts.settleMonth()).toEqual({ created: 1, ready: 1 });
    const payout = await prisma.venuePayout.findFirstOrThrow({ where: { venueId: venue.id } });
    expect(payout).toMatchObject({ bookingCount: 1, paymentCount: 0, grossPaise: 16_000n, commissionPaise: 0n, amountPaise: 16_000n });
    // Settled once.
    expect(await payouts.settleMonth('2026-12')).toEqual({ created: 0, ready: 0 });
  });

  it('pay at venue: confirmed at once and due, the desk marks it paid, the player gets a receipt; PL4Y owes the venue its own discount', async () => {
    const owner = await user('Owner');
    const player = await user('Ravi');
    const { venue, tables } = await snookerClub(owner, 'both');
    await pricing.savePlatformOffer(owner.userId, { title: 'PL4Y ₹50', kind: 'flat', flatPaise: 5_000n });
    const s = slot(19, 60); // peak: ₹480
    const b = await bookings.hold(player, { courtId: tables[0]!.id, ...s, payment: 'at_venue' });
    expect(b).toMatchObject({ status: 'confirmed', paymentMode: 'at_venue', paymentStatus: 'due', basePaise: 48_000n, platformDiscountPaise: 5_000n, amountPaise: 43_000n });
    expect(notices.find((n) => n.template === 'booking.confirmed')!.payload.dueAtVenuePaise).toBe('43000');
    // It blocks the table like any booking.
    const other = await user('Other');
    expect(await codeOf(() => bookings.hold(other, { courtId: tables[0]!.id, ...s }))).toBe('SLOT_UNAVAILABLE');

    expect(await codeOf(() => bookings.markPaidAtDesk(player, b.id, 'cash'))).toBe('FORBIDDEN');
    const paid = await bookings.markPaidAtDesk(owner, b.id, 'cash');
    expect(paid).toMatchObject({ paymentStatus: 'paid', collectedBy: 'venue', paymentMethod: 'cash' });
    expect(notices.some((n) => n.template === 'booking.paid' && n.userId === player.userId)).toBe(true);
    expect(await codeOf(() => bookings.markPaidAtDesk(owner, b.id, 'cash'))).toBe('BOOKING_ALREADY_PAID');

    // The payout: the venue holds ₹430; PL4Y owes it the ₹50 it took off.
    clock = new Date('2026-12-01T04:30:00.000Z');
    await payouts.settleMonth();
    expect(await prisma.venuePayout.findFirstOrThrow({ where: { venueId: venue.id } })).toMatchObject({ grossPaise: 5_000n, amountPaise: 5_000n, bookingCount: 1 });
  });

  it('pay at venue, paid in the app instead; a duplicate payment after the desk took cash is refunded in full', async () => {
    const owner = await user('Owner');
    const a = await user('Asha');
    const b = await user('Ben');
    const { tables } = await snookerClub(owner, 'at_venue');
    const first = await bookings.hold(a, { courtId: tables[0]!.id, ...slot(12, 60) });
    expect(first.paymentStatus).toBe('due');
    await payOnline(a, first.id);
    expect(await booking(first.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid', collectedBy: 'pl4y' });
    expect(await codeOf(() => bookings.markPaidAtDesk(owner, first.id, 'cash'))).toBe('BOOKING_ALREADY_PAID');

    // Ben opens a checkout, the desk takes cash, then Ben's payment lands.
    const second = await bookings.hold(b, { courtId: tables[1]!.id, ...slot(12, 60) });
    const order = await payments.createBookingOrder(b, second.id);
    await bookings.markPaidAtDesk(owner, second.id, 'upi');
    gateway.capture(order.gatewayOrderId);
    await payments.refreshBookingPayment(b, second.id);
    expect((await booking(second.id)).collectedBy).toBe('venue');
    // The duplicate capture is refunded in full (queued for the gateway).
    expect((await prisma.refund.findMany()).map((r) => r.amountPaise)).toEqual([30_000n]);
  });

  it('the venue’s choice decides what the player may choose', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner, 'online');
    expect(await codeOf(() => bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 30), payment: 'at_venue' }))).toBe('PAYMENT_OPTION_UNAVAILABLE');
    await bookings.setPolicy(owner, venue.id, { paymentOptions: 'at_venue' });
    expect(await codeOf(() => bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 30), payment: 'online' }))).toBe('PAYMENT_OPTION_UNAVAILABLE');
    expect((await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 30) })).paymentMode).toBe('at_venue');
  });

  it('2026-11-04: outside tests every table booking is paid online, whatever the venue chose', async () => {
    setOnlineOnlyBookingsForTests(true);
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner, 'both');
    expect((await bookings.bookingOptions(venue.id)).paymentChoices).toEqual(['online']);
    expect(await codeOf(() => bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 30), payment: 'at_venue' }))).toBe('PAYMENT_OPTION_UNAVAILABLE');
    const b = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 30) });
    expect(b).toMatchObject({ status: 'held', paymentMode: 'online' });
  });
});

describe('prices: durations, intervals, peak and off-peak', () => {
  it('a booking running from off-peak into peak is priced minute by minute; a bad duration or start is refused', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { tables } = await snookerClub(owner);
    // 17:30–19:00: 30 min at ₹300/h + 60 min at ₹480/h = ₹150 + ₹480.
    const q = await bookings.quoteForPlayer(player, { courtId: tables[0]!.id, ...slot(17, 90, 30) });
    expect(q.basePaise).toBe(63_000n);
    expect(await codeOf(() => bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 45) }))).toBe('INVALID_SLOT');
    expect(await codeOf(() => bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 30, 5) }))).toBe('INVALID_SLOT');
    // Past closing.
    expect(await codeOf(() => bookings.quoteForPlayer(player, { courtId: tables[0]!.id, ...slot(22, 90) }))).toBe('SLOT_UNAVAILABLE');
  });
});

describe('edges', () => {
  it('a failed payment keeps the hold and says so; a retry pays', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { tables } = await snookerClub(owner, 'online');
    const held = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(15, 60) });
    const order = await payments.createBookingOrder(player, held.id);
    gateway.fail(order.gatewayOrderId);
    await payments.refreshBookingPayment(player, held.id);
    expect(await booking(held.id)).toMatchObject({ status: 'held', paymentStatus: 'failed' });
    expect(notices.some((n) => n.template === 'booking.payment_failed')).toBe(true);
    await payOnline(player, held.id);
    expect(await booking(held.id)).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
  });

  it('a lapsed hold frees the table and its offer use; nothing is owed', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner, 'online');
    await pricing.saveVenueOffer(owner, venue.id, { title: 'Only one', kind: 'flat', flatPaise: 5_000n, usageLimit: 1 });
    const held = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(15, 60) });
    expect(await prisma.offerRedemption.count({ where: { status: 'reserved' } })).toBe(1);
    clock = new Date(clock.getTime() + 11 * MIN);
    await bookings.sweep();
    expect(await booking(held.id)).toMatchObject({ status: 'expired', paymentStatus: 'void' });
    expect(await prisma.offerRedemption.count({ where: { status: 'released' } })).toBe(1);
    // The offer is free again for the next player.
    expect((await bookings.quoteForPlayer(await user('Ben'), { courtId: tables[0]!.id, ...slot(15, 60) })).venueDiscountPaise).toBe(5_000n);
  });

  it('cancellations: pay-at-venue is released; online is refunded by the venue’s policy; the venue is notified', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { tables } = await snookerClub(owner, 'both');
    const due = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 60), payment: 'at_venue' });
    const c1 = await bookings.cancel(player, due.id);
    expect(c1.booking).toMatchObject({ status: 'cancelled', paymentStatus: 'void' });
    expect(c1.refundPaise).toBe(0n);
    expect(notices.some((n) => n.template === 'venue.booking_cancelled' && n.userId === owner.userId)).toBe(true);

    const online = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 60), payment: 'online' });
    await payOnline(player, online.id);
    const c2 = await bookings.cancel(player, online.id);
    expect(c2.refundPaise).toBe(30_000n); // > 24 h ahead: in full
    expect(await booking(online.id)).toMatchObject({ status: 'cancelled', paymentStatus: 'refunded', refundedPaise: 30_000n, venueGrossPaise: 0n });
    expect(await codeOf(() => bookings.cancel(player, online.id))).toBe('NOT_CANCELLABLE');
  });

  it('unavailable tables: blocked for a time, or out of service', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner);
    const s = slot(16, 60);
    await bookings.addBlackout(owner, { venueId: venue.id, courtId: tables[0]!.id, kind: 'maintenance', startsAt: s.startsAt, endsAt: s.endsAt });
    expect(await codeOf(() => bookings.hold(player, { courtId: tables[0]!.id, ...s }))).toBe('SLOT_UNAVAILABLE');
    expect((await bookings.hold(player, { courtId: tables[1]!.id, ...s })).status).toBe('held');
    // Out of service: refused while it has bookings, then gone from the grid.
    expect(await codeOf(() => bookings.saveTable(owner, venue.id, { id: tables[1]!.id, active: false }))).toBe('INVALID_TABLE');
    await bookings.saveTable(owner, venue.id, { id: tables[0]!.id, active: false });
    const date = new Date(s.startsAt.getTime() + 330 * MIN).toISOString().slice(0, 10);
    expect(new Set((await bookings.availability(venue.id, date, { durationMinutes: 60 })).map((x) => x.courtId))).toEqual(new Set([tables[1]!.id]));
  });

  it('duplicate bookings: one table, one time, one booking — online or at the venue', async () => {
    const owner = await user('Owner');
    const { tables } = await snookerClub(owner, 'both');
    const s = slot(20, 60);
    const players = await Promise.all(Array.from({ length: 12 }, (_, i) => user(`P${i}`)));
    const results = await Promise.all(
      players.map((p, i) => codeOf(() => bookings.hold(p, { courtId: tables[0]!.id, ...s, payment: i % 2 ? 'at_venue' : 'online' }))),
    );
    expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
    expect(results.filter((r) => r === 'SLOT_UNAVAILABLE')).toHaveLength(11);
  });

  it('discount combinations: limits, first-time customers, time windows, weekends, the cap, and no stacking', async () => {
    const owner = await user('Owner');
    const { venue, tables } = await snookerClub(owner, 'both');
    const t = tables[0]!.id;
    await pricing.saveVenueOffer(owner, venue.id, { title: 'Happy hours', kind: 'percent', percentBps: 5000, timeFromMin: 14 * 60, timeToMin: 17 * 60 });
    await pricing.saveVenueOffer(owner, venue.id, { title: 'Welcome', kind: 'flat', flatPaise: 10_000n, firstBookingOnly: true, perUserLimit: 1 });
    await pricing.saveVenueOffer(owner, venue.id, { title: 'Weekend', kind: 'percent', percentBps: 9000, weekdays: [5, 6] });
    const asha = await user('Asha');
    // Thursday 15:00, 60 min, ₹300: happy hours (₹150) beats welcome (₹100).
    expect((await bookings.quoteForPlayer(asha, { courtId: t, ...slot(15, 60) })).venueDiscountPaise).toBe(15_000n);
    // Thursday 12:00: only the welcome offer.
    const q = await bookings.quoteForPlayer(asha, { courtId: t, ...slot(12, 60) });
    expect(q.venueOfferTitle).toBe('Welcome');
    const b = await bookings.hold(asha, { courtId: t, ...slot(12, 60), payment: 'at_venue' });
    await bookings.markPaidAtDesk(owner, b.id, 'cash');
    // Not a first-timer any more.
    expect((await bookings.quoteForPlayer(asha, { courtId: t, ...slot(12, 60, 0, 2) })).venueDiscountPaise).toBe(0n);
    // Saturday: 90% off, capped by PL4Y's 50% ceiling once PL4Y's offer is on top, trimming PL4Y's first.
    await pricing.updateSettings(owner.userId, { maxDiscountBps: 9000 });
    await pricing.savePlatformOffer(owner.userId, { title: 'PL4Y 10%', kind: 'percent', percentBps: 1000 });
    const sat = await bookings.quoteForPlayer(asha, { courtId: t, ...slot(12, 60, 0, 3) });
    expect(sat.venueDiscountPaise).toBe(27_000n);
    expect(sat.platformDiscountPaise).toBe(0n);
    // No stacking: only the bigger one.
    await pricing.updateSettings(owner.userId, { allowStacking: false, maxDiscountBps: 10_000 });
    const ben = await user('Ben');
    const thu = await bookings.quoteForPlayer(ben, { courtId: t, ...slot(12, 60) });
    expect([thu.venueDiscountPaise, thu.platformDiscountPaise]).toEqual([10_000n, 0n]);
  });

  it('the last use of an offer goes to one player only', async () => {
    const owner = await user('Owner');
    const { venue, tables } = await snookerClub(owner, 'at_venue');
    await pricing.saveVenueOffer(owner, venue.id, { title: 'First five', kind: 'flat', flatPaise: 5_000n, usageLimit: 1 });
    const players = await Promise.all(Array.from({ length: 6 }, (_, i) => user(`P${i}`)));
    const results = await Promise.all(players.map((p, i) => codeOf(() => bookings.hold(p, { courtId: tables[i % 2]!.id, ...slot(12 + i, 60) }))));
    expect(await prisma.offerRedemption.count({ where: { status: { not: 'released' } } })).toBe(1);
    // Losers of the race are told to look again, never charged a price they were not quoted.
    expect(results.filter((r) => r !== 'NO_ERROR' && r !== 'OFFER_UNAVAILABLE')).toEqual([]);
  });

  it('PL4Y rewards stack on PL4Y offers unless the setting says no', async () => {
    await prisma.rewardSettings.update({ where: { id: 1 }, data: { enabled: true } });
    const owner = await user('Owner');
    const player = await user('Asha');
    const { tables } = await snookerClub(owner, 'online');
    await pricing.savePlatformOffer(owner.userId, { title: 'PL4Y ₹20', kind: 'flat', flatPaise: 2_000n });
    await pricing.updateSettings(owner.userId, { rewardsWithPromos: false });
    const held = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 60) });
    expect((await payments.createBookingOrder(player, held.id)).amountPaise).toBe(28_000n);
    await pricing.updateSettings(owner.userId, { rewardsWithPromos: true });
    const other = await bookings.hold(await user('Ben'), { courtId: tables[1]!.id, ...slot(12, 60) });
    const ben = (await prisma.courtBooking.findUniqueOrThrow({ where: { id: other.id } })).userId!;
    // Welcome 10% of ₹280, capped at ₹100: ₹28 off.
    expect((await payments.createBookingOrder({ userId: ben }, other.id)).amountPaise).toBe(25_200n);
  });

  it('commission: 0% for the venue’s first 30 days, then the portal’s rate — frozen on each booking', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner, 'online');
    const early = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 60) });
    expect(early.commissionPaise).toBe(0n);
    clock = new Date(clock.getTime() + 31 * DAY);
    const late = await bookings.hold(player, { courtId: tables[1]!.id, ...slot(12, 60) });
    expect(late).toMatchObject({ commissionBps: 1000, commissionPaise: 3_000n });
    expect((await pricing.introStatus(venue.id)).message).toBeNull();
    await pricing.updateSettings(owner.userId, { bookingCommissionBps: 500 });
    expect((await booking(late.id)).commissionPaise).toBe(3_000n);
  });

  it('reminders go out two hours before, once, with what is still to pay', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { tables } = await snookerClub(owner, 'both');
    const b = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(14, 60), payment: 'at_venue' });
    clock = new Date(b.startsAt.getTime() - 90 * MIN);
    await bookings.sweep();
    await bookings.sweep();
    const sent = notices.filter((n) => n.template === 'booking.reminder');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ bookingCode: b.bookingCode, dueAtVenuePaise: '30000' });
  });

  it('players see upcoming, past and cancelled bookings apart', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { tables } = await snookerClub(owner, 'at_venue');
    const keep = await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 60) });
    const drop = await bookings.hold(player, { courtId: tables[1]!.id, ...slot(12, 60) });
    await bookings.cancel(player, drop.id);
    expect((await bookings.listForUser(player.userId, { first: 10, offset: 0 }, 'upcoming')).map((x) => x.id)).toEqual([keep.id]);
    expect((await bookings.listForUser(player.userId, { first: 10, offset: 0 }, 'cancelled')).map((x) => x.id)).toEqual([drop.id]);
    clock = new Date(keep.endsAt.getTime() + HOUR);
    expect((await bookings.listForUser(player.userId, { first: 10, offset: 0 }, 'past')).map((x) => x.id)).toEqual([keep.id]);
  });

  it('new offers are announced to the venue’s customers once; expiring ones once', async () => {
    const owner = await user('Owner');
    const player = await user('Asha');
    const { venue, tables } = await snookerClub(owner, 'at_venue');
    await bookings.hold(player, { courtId: tables[0]!.id, ...slot(12, 60) });
    await pricing.saveVenueOffer(owner, venue.id, { title: 'Night owls', kind: 'percent', percentBps: 1500, endsAt: new Date(clock.getTime() + 20 * HOUR) });
    await pricing.announceNew();
    await pricing.announceNew();
    await pricing.announceExpiring();
    await pricing.announceExpiring();
    expect(notices.filter((n) => n.template === 'offer.new' && n.userId === player.userId)).toHaveLength(1);
    expect(notices.filter((n) => n.template === 'offer.expiring' && n.userId === player.userId)).toHaveLength(1);
  });

  it('only the venue’s managers make offers and change settings', async () => {
    const owner = await user('Owner');
    const desk = await user('Desk');
    const stranger = await user('Stranger');
    const { venue } = await snookerClub(owner);
    await prisma.venueStaff.create({ data: { venueId: venue.id, userId: desk.userId, role: 'desk' } });
    expect(await codeOf(() => pricing.saveVenueOffer(desk, venue.id, { title: 'Nope', kind: 'flat', flatPaise: 100n }))).toBe('FORBIDDEN');
    expect(await codeOf(() => pricing.saveVenueOffer(stranger, venue.id, { title: 'Nope', kind: 'flat', flatPaise: 100n }))).toBe('FORBIDDEN');
    expect(await codeOf(() => bookings.setPolicy(desk, venue.id, { paymentOptions: 'online' }))).toBe('FORBIDDEN');
    expect(await codeOf(() => bookings.dashboard(desk, venue.id, '2026-11-01', '2026-11-30'))).toBe('FORBIDDEN');
    expect(await codeOf(() => pricing.saveVenueOffer(owner, venue.id, { title: 'Bad', kind: 'percent', percentBps: 20_000 }))).toBe('INVALID_OFFER');
  });
});

function localDateOf(at: Date): string {
  return new Date(at.getTime() + 330 * MIN).toISOString().slice(0, 10);
}
