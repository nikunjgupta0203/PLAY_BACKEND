/**
 * pay at venue (docs/plans/2026-10-30-feature-brief.md, phase 3) — rates, the
 * breakdown, paying through payments with the fake gateway, the venue's
 * dashboard and emails, rewards on top, and the monthly payout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, contactsPortFor, FakeEmail, FakeGateway, FakeQueue } from './helpers/modules.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createPaymentsRepo } from '../src/modules/payments/repo/index.js';
import { createPaymentsService, type PaymentsService } from '../src/modules/payments/service/index.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';
import { createRewardsService, type RewardsService } from '../src/modules/rewards/service/index.js';
import {
  VenuePayCode,
  createVenuePayService,
  priceFor,
  type VenuePayService,
} from '../src/modules/venuepay/service/index.js';
import { createVenuePayouts, venuePayoutQuote, type VenuePayouts } from '../src/modules/venuepay/service/payouts.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let venuePay: VenuePayService;
let venuePayouts: VenuePayouts;
let payments: PaymentsService;
let rewards: RewardsService;
let gateway: FakeGateway;
let email: FakeEmail;
let clock: Date;
let accountStatus: string | null;
const notices: { userId: string; template: string; payload: Record<string, unknown> }[] = [];

async function user(name: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email: `${name}-${userId}@example.com`.toLowerCase(), displayName: name, createdAt: clock } });
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

/** A venue PL4Y has switched on, with one rate: Badminton court at ₹600/h. */
async function payableVenue(owner: { userId: string }) {
  const sportId = await seedSport(prisma, PICKLEBALL);
  modules.sport.refresh();
  const venue = await modules.venues.create(owner, {
    name: 'Smash Arena',
    address: '1 MG Road',
    city: 'Bengaluru',
    location: { lat: 12.97, lng: 77.59 },
    courts: [{ name: 'Court 1', sportIds: [sportId] }],
  });
  const rate = await venuePay.saveRate(owner, venue.id, { label: 'Badminton court', ratePerHourPaise: 60_000n });
  await venuePay.setEnabled(venue.id, true);
  return { venue, rate };
}

/** Start, order, capture, refresh: the player's whole tap. */
async function payFor(actor: { userId: string }, venueId: string, rateId: string, minutes: number) {
  const started = await venuePay.start(actor, { venueId, rateId, minutes });
  const order = await payments.createVenueOrder(actor, started.id);
  gateway.capture(order.gatewayOrderId);
  await payments.refreshVenuePayment(actor, started.id);
  return { started, order };
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
  notices.length = 0;
  clock = new Date('2026-10-30T10:00:00.000Z');
  accountStatus = 'verified';
  const db = prisma as unknown as Db;
  await prisma.rewardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  gateway = new FakeGateway();
  email = new FakeEmail();
  const roleAt = async (actor: { userId: string }, venueId: string) => {
    const v = await prisma.venue.findUnique({ where: { id: venueId }, select: { createdBy: true } });
    if (v?.createdBy === actor.userId) return 'owner' as const;
    const s = await prisma.venueStaff.findUnique({ where: { venueId_userId: { venueId, userId: actor.userId } } });
    return (s?.role as 'manager' | 'desk' | undefined) ?? null;
  };
  venuePay = createVenuePayService({
    db,
    roleAt,
    payoutStatusOf: async () => accountStatus,
    users: { contactsByIds: (ids) => contactsPortFor(prisma).byIds(ids) },
    email,
    async notify(userId, template, payload) {
      notices.push({ userId, template, payload });
    },
    now: () => clock,
  });
  venuePayouts = createVenuePayouts({
    db,
    async accountOf(userId) {
      if (!accountStatus) return null;
      // A real row: the payout keeps a foreign key to it.
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
      return { id: row.id, status: accountStatus, detailsChangedAt: null };
    },
    rates: { commissionGstBps: 0, tdsBps: 0 },
    now: () => clock,
  });
  rewards = createRewardsService({
    db,
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
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
    venuePayments: {
      byId: (id) => venuePay.forPayments(id),
      extendHold: (id, minutes) => venuePay.extendHold(id, minutes),
      confirmFromPayment: (input) => venuePay.confirmFromPayment(input),
      failFromPayment: (input) => venuePay.failFromPayment(input),
      async markRefunded(id) {
        const r = await venuePay.markRefunded(id);
        if (r?.payoutId) await venuePayouts.dropRefundedPayment(r.payoutId, id);
      },
    },
    users: contactsPortFor(prisma),
    email: new FakeEmail(),
    queue: new FakeQueue(),
    now: () => clock,
  });
});

describe('the arithmetic', () => {
  it('rate × minutes ÷ 60, half-up', () => {
    expect(priceFor(60_000n, 40)).toBe(40_000n);
    expect(priceFor(60_000n, 90)).toBe(90_000n);
    expect(priceFor(50_000n, 25)).toBe(20_833n);
    expect(priceFor(10_001n, 10)).toBe(1_667n);
  });

  it('a payout is the gross less 10% and its taxes', () => {
    expect(venuePayoutQuote([{ amountPaise: 40_000n, commissionPaise: 4_000n }], { commissionGstBps: 1_800, tdsBps: 100 })).toEqual({
      grossPaise: 40_000n,
      commissionPaise: 4_000n,
      commissionTaxPaise: 720n,
      tdsPaise: 400n,
      amountPaise: 34_880n,
    });
  });
});

describe('the offer', () => {
  it('shows only once PL4Y switches it on, with a rate and a verified payout account', async () => {
    const owner = await user('Owner');
    const { venue } = await payableVenue(owner);
    expect((await venuePay.offer(venue.id)).available).toBe(true);
    accountStatus = 'checking';
    expect(await venuePay.offer(venue.id)).toMatchObject({ available: false, reason: 'payout_account' });
    accountStatus = 'verified';
    await venuePay.setEnabled(venue.id, false);
    expect(await venuePay.offer(venue.id)).toMatchObject({ available: false, reason: 'not_enabled' });
  });

  it('only owners and managers set rates, within range', async () => {
    const owner = await user('Owner');
    const desk = await user('Desk');
    const { venue } = await payableVenue(owner);
    await prisma.venueStaff.create({ data: { venueId: venue.id, userId: desk.userId, role: 'desk' } });
    expect(await codeOf(() => venuePay.saveRate(desk, venue.id, { label: 'Table tennis', ratePerHourPaise: 20_000n }))).toBe('FORBIDDEN');
    expect(await codeOf(() => venuePay.saveRate(owner, venue.id, { label: 'TT', ratePerHourPaise: 500n }))).toBe(VenuePayCode.INVALID_RATE);
  });
});

describe('paying', () => {
  it('40 minutes at ₹600/h is ₹400: paid, emailed to both sides, on the dashboard', async () => {
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const { venue, rate } = await payableVenue(owner);
    const q = await venuePay.quote(venue.id, rate.id, 40);
    expect(q).toMatchObject({ minutes: 40, ratePerHourPaise: 60_000n, amountPaise: 40_000n, label: 'Badminton court' });

    const { started, order } = await payFor(ravi, venue.id, rate.id, 40);
    expect(started).toMatchObject({ amountPaise: 40_000n, commissionPaise: 4_000n, status: 'held' });
    // No rewards wired here: full price.
    expect(order.amountPaise).toBe(40_000n);

    const paid = await venuePay.byId(started.id);
    expect(paid).toMatchObject({ status: 'paid' });
    expect(paid!.paymentId).not.toBeNull();

    const subjects = email.sent.map((m) => m.subject);
    expect(subjects).toContain('Payment confirmed: Smash Arena');
    expect(subjects).toContain('₹400.00 paid at Smash Arena');
    expect(notices.map((n) => [n.userId, n.template])).toEqual(
      expect.arrayContaining([
        [ravi.userId, 'payment.confirmed'],
        [owner.userId, 'venue.payment_received'],
      ]),
    );

    const board = await venuePay.forVenue(owner, venue.id);
    expect(board.map((p) => [p.userId, p.minutes, p.amountPaise, p.status])).toEqual([[ravi.userId, 40, 40_000n, 'paid']]);
    const facts = (await venuePay.paymentFacts([started.id])).get(started.id);
    expect(facts?.reference).toMatch(/^pay_TEST/);

    // A second capture-refresh changes nothing and sends nothing more.
    const before = email.sent.length;
    await payments.refreshVenuePayment(ravi, started.id);
    expect(email.sent.length).toBe(before);
  });

  it('refuses a bad duration, a switched-off rate, and a venue that is not on', async () => {
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const { venue, rate } = await payableVenue(owner);
    expect(await codeOf(() => venuePay.start(ravi, { venueId: venue.id, rateId: rate.id, minutes: 7 }))).toBe(VenuePayCode.INVALID_DURATION);
    expect(await codeOf(() => venuePay.start(ravi, { venueId: venue.id, rateId: rate.id, minutes: 42 }))).toBe(VenuePayCode.INVALID_DURATION);
    await venuePay.saveRate(owner, venue.id, { id: rate.id, label: rate.label, ratePerHourPaise: rate.ratePerHourPaise, active: false });
    expect(await codeOf(() => venuePay.start(ravi, { venueId: venue.id, rateId: rate.id, minutes: 40 }))).toBe(VenuePayCode.NOT_AVAILABLE);
  });

  it('the rate is frozen when the player starts', async () => {
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const { venue, rate } = await payableVenue(owner);
    const started = await venuePay.start(ravi, { venueId: venue.id, rateId: rate.id, minutes: 60 });
    await venuePay.saveRate(owner, venue.id, { id: rate.id, label: rate.label, ratePerHourPaise: 90_000n });
    const order = await payments.createVenueOrder(ravi, started.id);
    expect(order.amountPaise).toBe(60_000n);
  });

  it('only the player opens their checkout; desk staff see the dashboard, strangers do not', async () => {
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const other = await user('Other');
    const { venue, rate } = await payableVenue(owner);
    const started = await venuePay.start(ravi, { venueId: venue.id, rateId: rate.id, minutes: 30 });
    expect(await codeOf(() => payments.createVenueOrder(other, started.id))).toBe('FORBIDDEN');
    expect(await codeOf(() => venuePay.forVenue(other, venue.id))).toBe('FORBIDDEN');
    expect(await venuePay.forViewer(other, started.id)).toBeNull();
  });
});

describe('rewards on top', () => {
  it('the welcome offer comes off what the player pays; the venue is paid on the full price', async () => {
    const db = prisma as unknown as Db;
    payments = createPaymentsService({
      db,
      repo: createPaymentsRepo(db),
      gateway,
      events: { priceQuote: async () => { throw new Error('not used'); }, byId: async () => ({ id: '', title: '' }), forEmail: async () => { throw new Error('not used'); } },
      registration: {
        byId: async () => { throw new Error('not used'); },
        extendHold: async () => undefined,
        confirmFromPayment: async () => ({ confirmedNow: false }),
        failFromPayment: async () => undefined,
      },
      venuePayments: {
        byId: (id) => venuePay.forPayments(id),
        extendHold: (id, minutes) => venuePay.extendHold(id, minutes),
        confirmFromPayment: (input) => venuePay.confirmFromPayment(input),
        failFromPayment: (input) => venuePay.failFromPayment(input),
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
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const { venue, rate } = await payableVenue(owner);
    const { started, order } = await payFor(ravi, venue.id, rate.id, 60);
    expect(order.discount).toEqual({ paise: 6_000n, label: 'Welcome offer' });
    expect(order.amountPaise).toBe(54_000n);
    const facts = (await venuePay.paymentFacts([started.id])).get(started.id);
    expect(facts?.discountPaise).toBe(6_000n);
    expect((await venuePay.byId(started.id))?.amountPaise).toBe(60_000n);
    expect(email.sent.find((m) => m.subject.startsWith('Payment confirmed'))?.text).toContain('PL4Y reward: −₹60');
  });
});

describe('payouts', () => {
  it('one payout per venue per month; a refund before it is sent comes out of it', async () => {
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const meera = await user('Meera');
    const { venue, rate } = await payableVenue(owner);
    const a = await payFor(ravi, venue.id, rate.id, 60);
    await payFor(meera, venue.id, rate.id, 30);

    clock = new Date('2026-11-01T02:00:00.000Z');
    expect(await venuePayouts.settleMonth()).toEqual({ created: 1, ready: 1 });
    expect(await venuePayouts.settleMonth()).toEqual({ created: 0, ready: 0 });
    const [payout] = await venuePayouts.open();
    expect(payout).toMatchObject({ period: '2026-10', paymentCount: 2, grossPaise: 90_000n, commissionPaise: 9_000n, amountPaise: 81_000n, status: 'ready' });

    const staff = { userId: (await user('Staff')).userId, role: 'finance' };
    await payments.staffRefundVenuePayment(staff, { venuePaymentId: a.started.id, reason: 'Charged twice by mistake' });
    const [after] = await venuePayouts.open();
    expect(after).toMatchObject({ paymentCount: 1, grossPaise: 30_000n, amountPaise: 27_000n });
    expect((await venuePay.byId(a.started.id))?.status).toBe('refunded');

    const paid = await venuePayouts.markPaid(staff, after!.id, { utr: 'UTR123456', amountPaise: 27_000n });
    expect(paid.status).toBe('paid');
  });

  it('holds the payout while the owner’s bank account is not verified', async () => {
    const owner = await user('Owner');
    const ravi = await user('Ravi');
    const { venue, rate } = await payableVenue(owner);
    await payFor(ravi, venue.id, rate.id, 60);
    accountStatus = 'needs_review';
    clock = new Date('2026-11-01T02:00:00.000Z');
    await venuePayouts.settleMonth();
    expect((await venuePayouts.open())[0]).toMatchObject({ status: 'held', holdReason: 'account_not_verified' });
    accountStatus = 'verified';
    expect(await venuePayouts.refreshHeld()).toBe(1);
  });
});
