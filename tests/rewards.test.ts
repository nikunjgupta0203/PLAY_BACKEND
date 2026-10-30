/**
 * rewards — the first-payment discount and the referral reward
 * (docs/plans/2026-10-30-feature-brief.md), end to end through payments
 * against a real Postgres and the fake gateway. Paid community memberships
 * are the subject: the simplest thing to pay for.
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
import { payoutQuote } from '../src/modules/payments/service/payoutQuote.js';
import { createCommunitiesRepo } from '../src/modules/communities/repo/index.js';
import { createCommunitiesService, type CommunitiesService } from '../src/modules/communities/service/index.js';
import { FOOTBALL, seedSport } from '../src/modules/sport/seed.js';
import {
  RewardCode,
  createRewardsService,
  discountOf,
  makeCode,
  pickDiscount,
  type RewardsService,
} from '../src/modules/rewards/service/index.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let communities: CommunitiesService;
let payments: PaymentsService;
let rewards: RewardsService;
let gateway: FakeGateway;
let clock: Date;
let football: string;
const notices: { userId: string; template: string; payload: Record<string, unknown> }[] = [];
const signals: { subjectId: string; detector: string; dedupeKey: string; score: number }[] = [];
/** `${referrerId}:${referredId}` pairs that have shared a phone. */
const sharedDevices = new Set<string>();

const DAY = 86_400_000;

async function user(name: string, over: { phone?: string; createdAt?: Date } = {}): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      email: `${name}-${userId}@example.com`.toLowerCase(),
      displayName: name,
      phoneE164: over.phone ?? null,
      createdAt: over.createdAt ?? clock,
    },
  });
  return { userId };
}

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return `THREW: ${String(e)}`;
  }
  return 'NO_ERROR';
};

/** A paid community at `pricePaise`, owned by somebody new. */
async function club(pricePaise = 49_900): Promise<string> {
  const owner = await user('Owner');
  const c = await communities.create(owner, {
    name: `Club ${newId().slice(0, 6)}`,
    sportId: football,
    city: 'Delhi',
    visibility: 'public',
    access: 'paid',
    pricePaise,
    billing: 'one_time',
  });
  return c.id;
}

/** Join & pay the whole way. Returns the order. */
async function pay(actor: { userId: string }, communityId: string) {
  const held = await communities.startPayment(actor, communityId);
  const order = await payments.createCommunityOrder(actor, held.id);
  gateway.capture(order.gatewayOrderId);
  await payments.refreshCommunityPayment(actor, held.id);
  return { order, heldId: held.id };
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
  signals.length = 0;
  sharedDevices.clear();
  clock = new Date('2026-10-30T04:30:00.000Z');
  football = await seedSport(prisma, FOOTBALL);
  modules.sport.refresh();
  const db = prisma as unknown as Db;
  await prisma.rewardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  gateway = new FakeGateway();
  communities = createCommunitiesService({
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
    async notify() {},
    now: () => clock,
  });
  let seq = 0;
  rewards = createRewardsService({
    db,
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
    async notify(userId, template, payload) {
      notices.push({ userId, template, payload });
    },
    async recordSignal(input) {
      signals.push(input);
    },
    async sharesDevice(a, b) {
      return sharedDevices.has(`${a}:${b}`);
    },
    random: () => ((seq++ * 7) % 31) / 31,
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
      byId: (id) => communities.forPayments(id),
      extendHold: (id, minutes) => communities.extendHold(id, minutes),
      confirmFromPayment: (input) => communities.confirmFromPayment(input),
      failFromPayment: (input) => communities.failFromPayment(input),
      idsForUser: (userId) => communities.paymentIdsForUser(userId),
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
});

describe('the arithmetic', () => {
  const s = { enabled: true, minOrderPaise: 10_000n, allowStacking: false };
  const first = { id: 'f', kind: 'first_payment' as const, percentBps: 1_000, capPaise: 10_000n };
  const ref = { id: 'r', kind: 'referral' as const, percentBps: 1_000, capPaise: 10_000n };

  it('10%, half-up, capped at ₹100', () => {
    expect(discountOf(49_900n, first)).toBe(4_990n);
    expect(discountOf(250_000n, first)).toBe(10_000n);
    expect(discountOf(10_005n, first)).toBe(1_001n);
  });

  it('below the minimum, or rewards off: nothing comes off', () => {
    expect(pickDiscount(9_999n, [first], s).discountPaise).toBe(0n);
    expect(pickDiscount(49_900n, [first], { ...s, enabled: false }).discountPaise).toBe(0n);
  });

  it('no stacking by default: the first candidate only', () => {
    const d = pickDiscount(200_000n, [first, ref], s);
    expect(d).toEqual({ discountPaise: 10_000n, rewardIds: ['f'], label: 'Welcome offer' });
  });

  it('stacking on: one of each kind, never below the gateway minimum', () => {
    expect(pickDiscount(200_000n, [first, ref], { ...s, allowStacking: true }).discountPaise).toBe(20_000n);
    const tiny = pickDiscount(200n, [{ ...first, percentBps: 10_000 }, { ...ref, percentBps: 10_000 }], { ...s, minOrderPaise: 0n, allowStacking: true });
    expect(tiny.discountPaise).toBe(100n);
  });

  it('codes are seven readable characters', () => {
    const code = makeCode('Asha Iyer', () => 0.5);
    expect(code).toMatch(/^[A-Z2-9]{7}$/);
    expect(code.startsWith('ASHA')).toBe(true);
    expect(makeCode('रवि', () => 0)).toBe('AAAAAAA');
  });

  it('payoutQuote: PL4Y’s discount is the host’s, and a full refund takes it back', () => {
    const rows = (kinds: [string, bigint][]) => kinds.map(([kind, amountPaise]) => ({ registrationId: 'x', kind, amountPaise, commissionBps: 1_000 }));
    const paid = rows([['charge', 45_000n], ['platform_fee', 0n], ['tax', 0n], ['reward_discount', 5_000n]]);
    expect(payoutQuote(paid, 0n, { commissionGstBps: 0, tdsBps: 0 }).entryFeesPaise).toBe(50_000n);
    const refunded = [...paid, ...rows([['refund', -45_000n], ['fee_reversal', 0n], ['tax_reversal', 0n], ['reward_reversal', -5_000n]])];
    const q = payoutQuote(refunded, 0n, { commissionGstBps: 0, tdsBps: 0 });
    expect(q.entryFeesPaise - q.refundsPaise).toBe(0n);
    expect(q.amountPaise).toBe(0n);
  });
});

describe('the welcome offer', () => {
  it('takes 10% off the first payment, once, and the owner is paid on the full price', async () => {
    const ravi = await user('Ravi');
    const c1 = await club(49_900);
    const { order, heldId } = await pay(ravi, c1);
    expect(order.quote.totalPaise).toBe(49_900n);
    expect(order.discount).toEqual({ paise: 4_990n, label: 'Welcome offer' });
    expect(order.amountPaise).toBe(44_910n);
    expect(gateway.orders.get(order.gatewayOrderId)?.amountPaise).toBe(44_910n);

    // The membership is paid at its full price: the owner's payout reads pricePaise.
    const period = await prisma.communityPayment.findUniqueOrThrow({ where: { id: heldId } });
    expect(period.status).toBe('paid');
    expect(period.pricePaise).toBe(49_900n);

    const row = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row).toMatchObject({ grossPaise: 49_900n, discountPaise: 4_990n, payerUserId: ravi.userId });
    const ledger = await prisma.ledgerEntry.findMany({ where: { kind: 'reward_discount' } });
    expect(ledger.map((l) => l.amountPaise)).toEqual([4_990n]);

    const [first] = await rewards.rewardsFor(ravi.userId);
    expect(first).toMatchObject({ kind: 'first_payment', status: 'used', discountPaise: 4_990n, usedOrderId: order.orderId });
    expect((await rewards.welcomeOffer(ravi.userId)).available).toBe(false);

    // The second payment is full price.
    const second = await pay(ravi, await club(49_900));
    expect(second.order.discount.paise).toBe(0n);
    expect(second.order.amountPaise).toBe(49_900n);
  });

  it('an abandoned checkout costs nothing: only a capture uses the reward', async () => {
    const ravi = await user('Ravi');
    const c = await club();
    const held = await communities.startPayment(ravi, c);
    await payments.createCommunityOrder(ravi, held.id);
    expect((await rewards.welcomeOffer(ravi.userId)).available).toBe(true);
  });

  it('a payment below the minimum keeps the offer for later', async () => {
    const ravi = await user('Ravi');
    const small = await pay(ravi, await club(5_000));
    expect(small.order.discount.paise).toBe(0n);
    expect((await rewards.welcomeOffer(ravi.userId)).available).toBe(true);
    const big = await pay(ravi, await club(100_000));
    expect(big.order.discount.paise).toBe(10_000n);
  });

  it('a player who had already paid before rewards existed never gets one', async () => {
    const ravi = await user('Ravi');
    await prisma.rewardSettings.update({ where: { id: 1 }, data: { enabled: false } });
    await pay(ravi, await club());
    await prisma.rewardSettings.update({ where: { id: 1 }, data: { enabled: true } });
    expect((await rewards.welcomeOffer(ravi.userId)).available).toBe(false);
    const next = await pay(ravi, await club());
    expect(next.order.discount.paise).toBe(0n);
  });

  it('a payment refunded in full gives the offer back', async () => {
    const ravi = await user('Ravi');
    const c = await club();
    const { order, heldId } = await pay(ravi, c);
    const payment = await prisma.payment.findFirstOrThrow({ where: { paymentOrderId: order.orderId } });
    const staff = { userId: (await user('Staff')).userId, role: 'finance' };
    const refund = await payments.staffRefundCommunityPayment(staff, {
      communityPaymentId: heldId,
      paymentId: payment.id,
      amountPaise: payment.amountPaise,
      reason: 'Club never met',
    });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    await payments.checkRefund(sent.gatewayRefundId!);
    expect((await rewards.welcomeOffer(ravi.userId)).available).toBe(true);
    expect(notices.some((n) => n.userId === ravi.userId && n.template === 'reward.available')).toBe(true);
  });
});

describe('referrals', () => {
  it('B uses A’s code; B’s first payment unlocks a reward for A, once', async () => {
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    const code = await rewards.codeFor(asha.userId);
    expect(await rewards.codeFor(asha.userId)).toBe(code);
    await rewards.applyCode(ravi, code.toLowerCase());
    expect(await rewards.canEnterCode(ravi.userId)).toBe(false);

    await pay(ravi, await club());
    const [reward] = await rewards.rewardsFor(asha.userId).then((rs) => rs.filter((r) => r.kind === 'referral'));
    expect(reward).toMatchObject({ status: 'available', percentBps: 1_000, capPaise: 10_000n });
    expect(reward!.expiresAt?.getTime()).toBe(clock.getTime() + 90 * DAY);
    expect(notices.filter((n) => n.template === 'referral.converted').map((n) => n.userId)).toEqual([asha.userId]);

    // Ravi paying again changes nothing.
    await pay(ravi, await club());
    expect((await rewards.rewardsFor(asha.userId)).filter((r) => r.kind === 'referral')).toHaveLength(1);

    // Asha's welcome offer goes first; the referral reward waits for the payment after.
    const a1 = await pay(asha, await club());
    expect(a1.order.discount.label).toBe('Welcome offer');
    const a2 = await pay(asha, await club());
    expect(a2.order.discount).toEqual({ paise: 4_990n, label: 'Referral reward' });
  });

  it('each converted friend is another reward', async () => {
    const asha = await user('Asha');
    const code = await rewards.codeFor(asha.userId);
    for (const name of ['Ravi', 'Meera', 'Kabir']) {
      const friend = await user(name);
      await rewards.applyCode(friend, code);
      await pay(friend, await club());
    }
    expect((await rewards.rewardsFor(asha.userId)).filter((r) => r.kind === 'referral' && r.status === 'available')).toHaveLength(3);
  });

  it('refuses its own code, a second code, an unknown code, and a code after the window or a payment', async () => {
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    const code = await rewards.codeFor(asha.userId);
    expect(await codeOf(() => rewards.applyCode(asha, code))).toBe(RewardCode.OWN_CODE);
    expect(await codeOf(() => rewards.applyCode(ravi, 'NOPE999'))).toBe(RewardCode.INVALID_CODE);
    await rewards.applyCode(ravi, code);
    expect(await codeOf(() => rewards.applyCode(ravi, code))).toBe(RewardCode.ALREADY_REFERRED);

    const old = await user('Old', { createdAt: new Date(clock.getTime() - 8 * DAY) });
    expect(await codeOf(() => rewards.applyCode(old, code))).toBe(RewardCode.TOO_LATE);

    const payer = await user('Payer');
    await pay(payer, await club(5_000));
    expect(await codeOf(() => rewards.applyCode(payer, code))).toBe(RewardCode.TOO_LATE);

    // Ravi cannot then refer Asha back.
    const back = await rewards.codeFor(ravi.userId);
    await prisma.user.update({ where: { id: asha.userId }, data: { createdAt: clock } });
    expect(await codeOf(() => rewards.applyCode(asha, back))).toBe(RewardCode.INVALID_CODE);
  });

  it('a shared phone holds the referral for review; staff approve it', async () => {
    const asha = await user('Asha', { phone: '+919800000001' });
    const ravi = await user('Ravi', { phone: '+919800000001' });
    await rewards.applyCode(ravi, await rewards.codeFor(asha.userId));
    await pay(ravi, await club());
    const [held] = await rewards.referralsForStaff('held', 10);
    expect(held).toMatchObject({ referrerId: asha.userId, holdReason: 'shared_phone' });
    expect(signals).toEqual([expect.objectContaining({ subjectId: asha.userId, detector: 'referral_reward', dedupeKey: `referral:${held!.id}` })]);
    expect((await rewards.rewardsFor(asha.userId)).some((r) => r.kind === 'referral')).toBe(false);

    const staff = await user('Staff');
    await rewards.reviewReferral(staff.userId, held!.id, true);
    expect((await rewards.rewardsFor(asha.userId)).filter((r) => r.kind === 'referral')).toHaveLength(1);
    expect(await codeOf(() => rewards.reviewReferral(staff.userId, held!.id, false))).toBe(RewardCode.NOT_HELD);
  });

  it('a shared phone for push holds the referral too', async () => {
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    sharedDevices.add(`${asha.userId}:${ravi.userId}`);
    await rewards.applyCode(ravi, await rewards.codeFor(asha.userId));
    await pay(ravi, await club());
    const [held] = await rewards.referralsForStaff('held', 10);
    expect(held).toMatchObject({ referrerId: asha.userId, holdReason: 'shared_device' });
    expect(signals).toEqual([expect.objectContaining({ subjectId: asha.userId, score: 70 })]);
    expect((await rewards.rewardsFor(asha.userId)).some((r) => r.kind === 'referral')).toBe(false);
  });

  it('the monthly cap holds the rest', async () => {
    await prisma.rewardSettings.update({ where: { id: 1 }, data: { referralMonthlyCap: 1 } });
    const asha = await user('Asha');
    const code = await rewards.codeFor(asha.userId);
    for (const name of ['Ravi', 'Meera']) {
      const friend = await user(name);
      await rewards.applyCode(friend, code);
      await pay(friend, await club());
    }
    const all = await rewards.referralsBy(asha.userId);
    expect(all.map((r) => r.status).sort()).toEqual(['converted', 'held']);
  });

  it('referral rewards expire', async () => {
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    await rewards.applyCode(ravi, await rewards.codeFor(asha.userId));
    await pay(ravi, await club());
    clock = new Date(clock.getTime() + 91 * DAY);
    expect(await rewards.expireDue()).toBe(1);
    expect((await rewards.rewardsFor(asha.userId)).find((r) => r.kind === 'referral')?.status).toBe('expired');
  });
});

describe('settings', () => {
  it('validate their ranges', async () => {
    const staff = await user('Staff');
    expect(await codeOf(() => rewards.updateSettings(staff.userId, { percentBps: 9_000 }))).toBe(RewardCode.INVALID_SETTINGS);
    const s = await rewards.updateSettings(staff.userId, { percentBps: 1_500, capPaise: 20_000n });
    expect(s).toMatchObject({ percentBps: 1_500, capPaise: 20_000n });
    const ravi = await user('Ravi');
    expect((await rewards.discountFor(ravi.userId, 100_000n)).discountPaise).toBe(15_000n);
  });
});
