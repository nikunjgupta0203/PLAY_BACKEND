/**
 * communities R8 — paid memberships, end to end through payments (payments R20)
 * against a real Postgres and the fake gateway.
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
import { createCommunitiesRepo } from '../src/modules/communities/repo/index.js';
import {
  CommunityCode,
  RENEW_WINDOW_MS,
  commissionOf,
  createCommunitiesService,
  periodEndOf,
  type CommunitiesService,
  type CommunityInput,
} from '../src/modules/communities/service/index.js';
import { FOOTBALL, seedSport } from '../src/modules/sport/seed.js';
import { createCommunityPayouts, periodOf, previousPeriod } from '../src/modules/communities/service/payouts.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let svc: CommunitiesService;
let payments: PaymentsService;
let gateway: FakeGateway;
let clock: Date;
let football: string;
const notices: { userId: string; template: string; payload: Record<string, unknown> }[] = [];

const DAY = 86_400_000;

async function user(name: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email: `${name}-${userId}@example.com`.toLowerCase(), displayName: name } });
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

const paid = (over: Partial<CommunityInput> = {}): CommunityInput => ({
  name: 'Delhi Football Training Club',
  sportId: football,
  city: 'Delhi',
  visibility: 'public',
  access: 'paid',
  pricePaise: 49_900,
  billing: 'monthly',
  ...over,
});

/** Join & pay, the whole way: a held period, its order, a capture, and the app's refresh. */
async function pay(actor: { userId: string }, communityId: string): Promise<string> {
  const held = await svc.startPayment(actor, communityId);
  const order = await payments.createCommunityOrder(actor, held.id);
  gateway.capture(order.gatewayOrderId);
  await payments.refreshCommunityPayment(actor, held.id);
  return held.id;
}

const sentTo = (template: string): string[] => notices.filter((n) => n.template === template).map((n) => n.userId);

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
  clock = new Date('2026-10-22T04:30:00.000Z');
  football = await seedSport(prisma, FOOTBALL);
  modules.sport.refresh();
  const db = prisma as unknown as Db;
  gateway = new FakeGateway();
  svc = createCommunitiesService({
    db,
    repo: createCommunitiesRepo(db),
    sport: { findById: (id) => modules.sport.byId(id).catch(() => null) },
    users: {
      async namesByIds(ids) {
        const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
        return new Map(rows.map((r) => [r.id, r.displayName]));
      },
    },
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
    async notify(userIds, template, payload) {
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
    communityPayments: {
      byId: (id) => svc.forPayments(id),
      extendHold: (id, minutes) => svc.extendHold(id, minutes),
      confirmFromPayment: (input) => svc.confirmFromPayment(input),
      failFromPayment: (input) => svc.failFromPayment(input),
      idsForUser: (userId) => svc.paymentIdsForUser(userId),
    },
    users: contactsPortFor(prisma),
    email: new FakeEmail(),
    queue: new FakeQueue(),
    now: () => clock,
  });
});

describe('the arithmetic', () => {
  it('R8: PL4Y keeps 5%, rounded up to the paisa', () => {
    expect(commissionOf(49_900n)).toBe(2_495n);
    expect(commissionOf(1_001n)).toBe(51n);
    expect(commissionOf(5_000_000n)).toBe(250_000n);
  });

  it('R8: a month on from the 31st is the last day of the next month', () => {
    expect(periodEndOf(new Date('2026-01-31T10:00:00Z'), 'monthly')?.toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(periodEndOf(new Date('2028-02-29T10:00:00Z'), 'yearly')?.toISOString()).toBe('2029-02-28T10:00:00.000Z');
    expect(periodEndOf(new Date('2026-10-22T04:30:00Z'), 'one_time')).toBeNull();
  });
});

describe('paying to join', () => {
  it('R8: paid public — the order is the listed price, and only the capture makes the member', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    const held = await svc.startPayment(ravi, c.id);
    expect(held.commissionPaise).toBe(2_495n);
    const order = await payments.createCommunityOrder(ravi, held.id);
    expect(order.amountPaise).toBe(49_900n);
    expect(order.quote.platformFeePaise).toBe(0n);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('none');

    gateway.capture(order.gatewayOrderId);
    await payments.refreshCommunityPayment(ravi, held.id);
    const v = await svc.viewerOf(c.id, ravi.userId);
    expect(v.state).toBe('member');
    expect(v.membership?.paidUntil?.toISOString()).toBe('2026-11-22T04:30:00.000Z');
    expect((await svc.findById(c.id))?.memberCount).toBe(2);
    expect(sentTo('community.member_joined')).toEqual([owner.userId]);

    const ledger = await prisma.ledgerEntry.findMany({ where: { kind: 'charge' } });
    expect(ledger.map((l) => l.amountPaise)).toEqual([49_900n]);
    expect(await svc.earnings(owner, c.id)).toEqual({
      paidCount: 1,
      grossPaise: 49_900n,
      commissionPaise: 2_495n,
      netPaise: 47_405n,
      refundedCount: 0,
    });
    expect(await svc.earnings(ravi, c.id)).toBeNull();
  });

  it('R8: a membership payment shows in the payer’s payment history', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    const id = await pay(ravi, c.id);
    const history = await payments.paymentHistory(ravi.userId, { first: 10 });
    expect(history.nodes).toHaveLength(1);
    expect(history.nodes[0]).toMatchObject({ communityPaymentId: id, amountPaise: 49_900n });
    expect((await payments.paymentHistory(owner.userId, { first: 10 })).nodes).toEqual([]);
  });

  it('R8: a second capture of the same period changes nothing', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    const id = await pay(ravi, c.id);
    await expect(svc.confirmFromPayment({ communityPaymentId: id, paymentId: newId() })).resolves.toEqual({ confirmedNow: false });
    expect((await svc.findById(c.id))?.memberCount).toBe(2);
  });

  it('R8: paid private — approval first, payment second', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid({ visibility: 'private' }));
    expect(await codeOf(() => svc.startPayment(ravi, c.id))).toBe(CommunityCode.REQUEST_REQUIRED);
    const { request } = await svc.requestToJoin(ravi, c.id);
    expect(await codeOf(() => svc.startPayment(ravi, c.id))).toBe(CommunityCode.REQUEST_REQUIRED);
    await svc.respond(owner, request!.id, true);
    await pay(ravi, c.id);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('member');
    expect((await svc.requestById(request!.id))?.status).toBe('joined');
  });

  it('R8: one checkout at a time — a second tap reuses the held period', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    const [a, b] = await Promise.all([svc.startPayment(ravi, c.id), svc.startPayment(ravi, c.id)]);
    expect(a.id).toBe(b.id);
  });

  it('R8: one-time membership has no end and cannot be bought twice', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid({ billing: 'one_time', pricePaise: 250_000 }));
    await pay(ravi, c.id);
    expect((await svc.viewerOf(c.id, ravi.userId)).membership?.paidUntil).toBeNull();
    expect(await codeOf(() => svc.startPayment(ravi, c.id))).toBe(CommunityCode.ALREADY_MEMBER);
  });

  it('R8: a capture for someone removed while paying is refunded in full', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    await pay(ravi, c.id);
    await svc.removeMember(owner, c.id, ravi.userId);
    // An old checkout from before the removal lands late.
    const stale = await prisma.communityPayment.create({
      data: {
        id: newId(),
        communityId: c.id,
        userId: ravi.userId,
        billing: 'monthly',
        pricePaise: 49_900n,
        commissionPaise: 2_495n,
        holdExpiresAt: new Date(clock.getTime() + 60_000),
      },
    });
    const order = await payments.createCommunityOrder(ravi, stale.id);
    gateway.capture(order.gatewayOrderId);
    await payments.refreshCommunityPayment(ravi, stale.id);
    const refund = await prisma.refund.findFirst({ orderBy: { createdAt: 'desc' } });
    expect(refund?.amountPaise).toBe(49_900n);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('removed');
  });
});

describe('renewing and ending', () => {
  it('R8: renewal opens in the last 7 days and extends from the end of the period', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    await pay(ravi, c.id);
    expect(await codeOf(() => svc.startPayment(ravi, c.id))).toBe(CommunityCode.ALREADY_MEMBER);

    const end = (await svc.viewerOf(c.id, ravi.userId)).membership!.paidUntil!;
    clock = new Date(end.getTime() - RENEW_WINDOW_MS + 60_000);
    await pay(ravi, c.id);
    expect((await svc.viewerOf(c.id, ravi.userId)).membership?.paidUntil?.toISOString()).toBe('2026-12-22T04:30:00.000Z');
    expect((await svc.findById(c.id))?.memberCount).toBe(2);
  });

  it('R8: an ended period reads as expired at once; the sweep writes it, tells the member, and they can renew', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid({ visibility: 'private' }));
    const { request } = await svc.requestToJoin(ravi, c.id);
    await svc.respond(owner, request!.id, true);
    await pay(ravi, c.id);

    clock = new Date('2026-11-20T05:00:00.000Z');
    expect((await svc.sweep()).reminded).toBe(1);
    expect((await svc.sweep()).reminded).toBe(0);
    expect(sentTo('community.renewal_due')).toEqual([ravi.userId]);

    clock = new Date('2026-11-23T05:00:00.000Z');
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('expired');
    expect(await svc.isMember(c.id, ravi.userId)).toBe(false);
    const swept = await svc.sweep();
    expect(swept.expiredMembers).toBe(1);
    expect(sentTo('community.membership_expired')).toEqual([ravi.userId]);
    expect((await svc.findById(c.id))?.memberCount).toBe(1);

    // A past member of a private community renews without asking again.
    await pay(ravi, c.id);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('member');
  });

  it('R8: an owner never pays — a handover clears the new owner’s period', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    await pay(ravi, c.id);
    await svc.transferOwnership(owner, c.id, ravi.userId);
    clock = new Date(clock.getTime() + 60 * DAY);
    expect((await svc.viewerOf(c.id, ravi.userId)).role).toBe('owner');
    expect((await svc.sweep()).expiredMembers).toBe(0);
  });

  it('R8: unpaid checkouts lapse', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    await svc.startPayment(ravi, c.id);
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect((await svc.sweep()).expiredHolds).toBe(1);
  });
});

describe('creator payouts', () => {
  const accounts = new Map<string, { id: string; status: string; detailsChangedAt: Date | null }>();
  const ops: string[] = [];
  const payoutsFor = () =>
    createCommunityPayouts({
      db: prisma as unknown as Db,
      accountOf: async (userId) => accounts.get(userId) ?? null,
      rates: { commissionGstBps: 1800, tdsBps: 100 },
      async notify(userId, template, payload) {
        notices.push({ userId, template, payload });
      },
      async alert(subject) {
        ops.push(subject);
      },
      now: () => clock,
    });

  beforeEach(() => {
    accounts.clear();
    ops.length = 0;
  });

  it('R10: months are India’s calendar months', () => {
    expect(periodOf(new Date('2026-10-31T18:29:00Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-10-31T18:31:00Z'))).toBe('2026-11');
    expect(previousPeriod(new Date('2026-11-01T00:30:00Z'))).toBe('2026-10');
    expect(previousPeriod(new Date('2026-01-01T00:30:00Z'))).toBe('2025-12');
  });

  it('R10: a month settles once per community — gross, 5%, GST on it, TDS — and each payment is counted once', async () => {
    const owner = await user('Asha');
    accounts.set(owner.userId, { id: await payoutAccount(owner.userId), status: 'verified', detailsChangedAt: null });
    const c = await svc.create(owner, paid());
    for (const name of ['Ravi', 'Meera']) await pay(await user(name), c.id);

    clock = new Date('2026-11-01T00:30:00.000Z');
    const p = payoutsFor();
    expect(await p.settleMonth()).toEqual({ created: 1, ready: 1 });
    expect(await p.settleMonth()).toEqual({ created: 0, ready: 0 });
    const [row] = await p.open();
    // 2 × ₹499: commission 2 × ₹24.95, GST 18% of that, TDS 1% of the gross.
    expect(row).toMatchObject({
      period: '2026-10',
      paymentCount: 2,
      grossPaise: 99_800n,
      commissionPaise: 4_990n,
      commissionTaxPaise: 898n,
      tdsPaise: 998n,
      amountPaise: 92_914n,
      status: 'ready',
    });
    expect(ops).toEqual(['Community payouts ready to pay']);
    expect(await prisma.communityPayment.count({ where: { payoutId: null, status: 'paid' } })).toBe(0);
  });

  it('R10: no verified bank account holds the payout; verifying it makes it ready', async () => {
    const owner = await user('Asha');
    const c = await svc.create(owner, paid());
    await pay(await user('Ravi'), c.id);
    clock = new Date('2026-11-01T00:30:00.000Z');
    const p = payoutsFor();
    await p.settleMonth();
    expect((await p.open())[0]).toMatchObject({ status: 'held', holdReason: 'no_payout_account' });

    accounts.set(owner.userId, { id: await payoutAccount(owner.userId), status: 'checking', detailsChangedAt: null });
    expect(await p.refreshHeld()).toBe(0);
    expect((await p.open())[0]?.holdReason).toBe('account_not_verified');
    accounts.set(owner.userId, { ...accounts.get(owner.userId)!, status: 'verified' });
    expect(await p.refreshHeld()).toBe(1);
    expect((await p.open())[0]?.status).toBe('ready');
  });

  it('R10: staff mark it paid with the exact amount and a UTR; the owner is told', async () => {
    const owner = await user('Asha');
    accounts.set(owner.userId, { id: await payoutAccount(owner.userId), status: 'verified', detailsChangedAt: null });
    const c = await svc.create(owner, paid());
    await pay(await user('Ravi'), c.id);
    clock = new Date('2026-11-01T00:30:00.000Z');
    const p = payoutsFor();
    await p.settleMonth();
    const [row] = await p.open();
    const staff = await user('Finance');
    expect(await codeOf(() => p.markPaid(staff, row!.id, { utr: 'UTR12345', amountPaise: 1n }))).toBe('AMOUNT_MISMATCH');
    expect(await codeOf(() => p.markPaid(staff, row!.id, { utr: 'x', amountPaise: row!.amountPaise }))).toBe('INVALID_UTR');
    const done = await p.markPaid(staff, row!.id, { utr: 'utr-1234 5678', amountPaise: row!.amountPaise });
    expect(done).toMatchObject({ status: 'paid', utr: 'UTR12345678' });
    expect(sentTo('community.payout_paid')).toEqual([owner.userId]);
    expect(await codeOf(() => p.markPaid(staff, row!.id, { utr: 'UTR12345', amountPaise: row!.amountPaise }))).toBe('PAYOUT_NOT_READY');
    expect(await p.forCommunity(c.id)).toHaveLength(1);
  });

  it('R10: bank details replaced in the last 48 hours put a ready payout back on hold', async () => {
    const owner = await user('Asha');
    accounts.set(owner.userId, { id: await payoutAccount(owner.userId), status: 'verified', detailsChangedAt: null });
    const c = await svc.create(owner, paid());
    await pay(await user('Ravi'), c.id);
    clock = new Date('2026-11-01T00:30:00.000Z');
    const p = payoutsFor();
    await p.settleMonth();
    accounts.set(owner.userId, { ...accounts.get(owner.userId)!, detailsChangedAt: new Date(clock.getTime() - 3_600_000) });
    const [row] = await p.open();
    const staff = await user('Finance');
    expect(await codeOf(() => p.markPaid(staff, row!.id, { utr: 'UTR12345', amountPaise: row!.amountPaise }))).toBe('PAYOUT_NOT_READY');
    expect((await p.open())[0]).toMatchObject({ status: 'held', holdReason: 'account_changed_recently' });
  });
});

/** A payout_accounts row, for the foreign key; the service only reads its status through `accountOf`. */
async function payoutAccount(userId: string): Promise<string> {
  const id = newId();
  await prisma.payoutAccount.create({
    data: {
      id,
      userId,
      legalName: 'Asha Rao',
      panCipher: Buffer.from('x'),
      panLast4: '234F',
      accountCipher: Buffer.from('x'),
      accountLast4: '7890',
      ifsc: 'HDFC0000001',
      panSurnameOk: true,
      status: 'verified',
    },
  });
  return id;
}

describe('staff refunds', () => {
  const staff = { userId: newId(), role: 'finance' };

  async function refundIt(communityPaymentId: string) {
    const paidRow = await svc.refundablePayment(communityPaymentId);
    await payments.staffRefundCommunityPayment(staff, { communityPaymentId, paymentId: paidRow.paymentId, amountPaise: paidRow.pricePaise, reason: 'Club never met' });
    return svc.voidRefundedPeriod(communityPaymentId);
  }

  it('R10: a full refund voids the period — the member is out, and the payment leaves the unsent payout', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const meera = await user('Meera');
    const c = await svc.create(owner, paid());
    const raviPayment = await pay(ravi, c.id);
    await pay(meera, c.id);
    clock = new Date('2026-11-01T00:30:00.000Z');
    const ops: string[] = [];
    const p = createCommunityPayouts({
      db: prisma as unknown as Db,
      accountOf: async () => null,
      rates: { commissionGstBps: 0, tdsBps: 0 },
      async alert(subject) {
        ops.push(subject);
      },
      now: () => clock,
    });
    await p.settleMonth();

    const voided = await refundIt(raviPayment);
    expect(await prisma.refund.count()).toBe(1);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('expired');
    expect((await svc.findById(c.id))?.memberCount).toBe(2);
    expect(await p.dropRefundedPayment(voided!.payoutId!, raviPayment)).toBe('recounted');
    expect((await p.open())[0]).toMatchObject({ paymentCount: 1, grossPaise: 49_900n });

    // Asked twice: one refund, nothing more to void.
    expect(await codeOf(() => refundIt(raviPayment))).toBe(CommunityCode.INVALID_COMMUNITY);
    expect(await prisma.refund.count()).toBe(1);
    expect(ops).toEqual([]);
  });

  it('R10: refunding a renewal takes the member back to the end of the period before it', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paid());
    await pay(ravi, c.id);
    const end = (await svc.viewerOf(c.id, ravi.userId)).membership!.paidUntil!;
    clock = new Date(end.getTime() - RENEW_WINDOW_MS + 60_000);
    const renewal = await pay(ravi, c.id);
    await refundIt(renewal);
    const v = await svc.viewerOf(c.id, ravi.userId);
    expect(v.state).toBe('member');
    expect(v.membership?.paidUntil?.toISOString()).toBe(end.toISOString());
  });
});
