/**
 * rewards — the first-payment discount and the referral reward
 * (docs/plans/2026-10-30-feature-brief.md, phase 1).
 *
 * One rewards system for every paid service: an event entry, a court, a
 * community membership, a pay-at-venue payment. PL4Y funds every discount, so
 * nothing here touches what a host, venue or owner is paid.
 *
 * The life of a reward:
 *   · the first-payment reward is made on first use, once per player, ever —
 *     a player who has already made a payment of at least the minimum never
 *     gets one;
 *   · a referral reward is issued when the player they referred makes a
 *     payment of at least the minimum, after the fraud checks;
 *   · an order lists the rewards its discount counted (`reward_ids`); only
 *     that order's CAPTURE uses them, so an abandoned checkout costs nothing;
 *   · a payment refunded in full gives its rewards back.
 *
 * No stacking unless the settings say so: one reward per payment, the
 * first-payment one first (it is once-only), then the referral reward that
 * expires soonest.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import { SystemError, UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';

export const RewardCode = {
  INVALID_CODE: 'INVALID_REFERRAL_CODE',
  OWN_CODE: 'OWN_REFERRAL_CODE',
  ALREADY_REFERRED: 'ALREADY_REFERRED',
  TOO_LATE: 'REFERRAL_TOO_LATE',
  REFERRALS_OFF: 'REFERRALS_OFF',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_SETTINGS: 'INVALID_REWARD_SETTINGS',
  REFERRAL_NOT_FOUND: 'REFERRAL_NOT_FOUND',
  NOT_HELD: 'REFERRAL_NOT_HELD',
} as const;

/** The smallest charge a gateway takes. A discount never brings a payment below it. */
export const MIN_CHARGE_PAISE = 100n;

/** How many codes a player may try in an hour: enough for typos, not for guessing. */
const APPLY_WINDOW: Window = { seconds: 3_600, max: 10 };

const DAY_MS = 86_400_000;
/** The monthly referral cap counts conversions in a rolling 30 days. */
const CAP_WINDOW_MS = 30 * DAY_MS;

/** No 0/O, 1/I/L: a code is read aloud and typed from a screenshot. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type RewardKind = 'first_payment' | 'referral';
export type RewardStatus = 'available' | 'used' | 'expired' | 'void';
export type ReferralStatus = 'pending' | 'converted' | 'held' | 'rejected';

export interface Settings {
  enabled: boolean;
  percentBps: number;
  capPaise: bigint;
  minOrderPaise: bigint;
  referralEnabled: boolean;
  referralExpiryDays: number;
  referralMonthlyCap: number;
  referralWindowDays: number;
  allowStacking: boolean;
  updatedAt: Date;
}

export type SettingsPatch = Partial<Omit<Settings, 'updatedAt'>>;

export interface Reward {
  id: string;
  userId: string;
  kind: RewardKind;
  status: RewardStatus;
  percentBps: number;
  capPaise: bigint;
  referralId: string | null;
  expiresAt: Date | null;
  usedOrderId: string | null;
  usedAt: Date | null;
  discountPaise: bigint | null;
  createdAt: Date;
}

export interface Referral {
  id: string;
  referrerId: string;
  referredId: string;
  code: string;
  status: ReferralStatus;
  holdReason: string | null;
  convertedAt: Date | null;
  createdAt: Date;
}

export interface Discount {
  discountPaise: bigint;
  rewardIds: string[];
  /** What the checkout line says: "Welcome offer", "Referral reward". Null with no discount. */
  label: string | null;
}

export interface WelcomeOffer {
  /** True while the player has not yet made a payment that used or spent it. */
  available: boolean;
  percentBps: number;
  capPaise: bigint;
  minOrderPaise: bigint;
}

/** The facts the payments module hands over when an order is captured or refunded. */
export interface OrderFacts {
  id: string;
  payerUserId: string | null;
  grossPaise: bigint;
  discountPaise: bigint;
  rewardIds: string[];
}

export interface RewardsDeps {
  db: Db;
  limiter: { consume(key: string, window: Window): Promise<LimitResult> };
  notify?(
    userId: string,
    template: 'referral.converted' | 'reward.available',
    payload: Record<string, unknown>,
  ): Promise<void>;
  /** admin R8 — a held referral is a fraud signal staff can see. Idempotent on the key. */
  recordSignal?(input: {
    subjectType: 'user';
    subjectId: string;
    detector: string;
    score: number;
    dedupeKey: string;
    evidence?: Record<string, unknown>;
  }): Promise<unknown>;
  /** PL4Y's finance inbox. */
  alert?(subject: string, text: string): Promise<void>;
  /** Picks a code's random characters. Tests pass a fixed source. */
  random?: () => number;
  now?: () => Date;
}

// --- pure ----------------------------------------------------------------------

/** Half-up in integers, capped. */
export function discountOf(grossPaise: bigint, reward: { percentBps: number; capPaise: bigint }): bigint {
  const raw = (grossPaise * BigInt(reward.percentBps) + 5_000n) / 10_000n;
  return raw > reward.capPaise ? reward.capPaise : raw;
}

/**
 * Which rewards a payment of `grossPaise` uses, and how much comes off. The
 * candidates arrive in preference order. Pure, so the price a player sees and
 * the price they are charged are the same function.
 */
export function pickDiscount(
  grossPaise: bigint,
  candidates: { id: string; kind: RewardKind; percentBps: number; capPaise: bigint }[],
  settings: Pick<Settings, 'enabled' | 'minOrderPaise' | 'allowStacking'>,
): Discount {
  const none: Discount = { discountPaise: 0n, rewardIds: [], label: null };
  if (!settings.enabled || grossPaise < settings.minOrderPaise) return none;
  const ceiling = grossPaise - MIN_CHARGE_PAISE;
  if (ceiling <= 0n) return none;

  const chosen: typeof candidates = [];
  for (const c of candidates) {
    if (chosen.some((x) => x.kind === c.kind)) continue;
    chosen.push(c);
    if (!settings.allowStacking) break;
  }
  let total = 0n;
  const ids: string[] = [];
  for (const c of chosen) {
    const d = discountOf(grossPaise, c);
    if (d <= 0n || total >= ceiling) continue;
    total += d;
    ids.push(c.id);
  }
  if (total > ceiling) total = ceiling;
  if (total <= 0n) return none;
  const kinds = new Set(chosen.filter((c) => ids.includes(c.id)).map((c) => c.kind));
  const label = kinds.size > 1 ? 'PL4Y rewards' : kinds.has('first_payment') ? 'Welcome offer' : 'Referral reward';
  return { discountPaise: total, rewardIds: ids, label };
}

/** "ASHA7KQ": up to four letters of the name, then random characters, seven in all. */
export function makeCode(displayName: string, random: () => number): string {
  const letters = displayName
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .replace(/[IOL]/g, '')
    .slice(0, 4);
  let code = letters;
  while (code.length < 7) code += ALPHABET[Math.floor(random() * ALPHABET.length)]!;
  return code;
}

export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

// --- service -------------------------------------------------------------------

type RewardRow = Awaited<ReturnType<Db['reward']['findFirstOrThrow']>>;
type SettingsRow = Awaited<ReturnType<Db['rewardSettings']['findFirstOrThrow']>>;

const toReward = (r: RewardRow): Reward => ({
  id: r.id,
  userId: r.userId,
  kind: r.kind as RewardKind,
  status: r.status as RewardStatus,
  percentBps: r.percentBps,
  capPaise: r.capPaise,
  referralId: r.referralId,
  expiresAt: r.expiresAt,
  usedOrderId: r.usedOrderId,
  usedAt: r.usedAt,
  discountPaise: r.discountPaise,
  createdAt: r.createdAt,
});

const toSettings = (r: SettingsRow): Settings => ({
  enabled: r.enabled,
  percentBps: r.percentBps,
  capPaise: r.capPaise,
  minOrderPaise: r.minOrderPaise,
  referralEnabled: r.referralEnabled,
  referralExpiryDays: r.referralExpiryDays,
  referralMonthlyCap: r.referralMonthlyCap,
  referralWindowDays: r.referralWindowDays,
  allowStacking: r.allowStacking,
  updatedAt: r.updatedAt,
});

const toReferral = (r: Awaited<ReturnType<Db['referral']['findFirstOrThrow']>>): Referral => ({
  id: r.id,
  referrerId: r.referrerId,
  referredId: r.referredId,
  code: r.code,
  status: r.status as ReferralStatus,
  holdReason: r.holdReason,
  convertedAt: r.convertedAt,
  createdAt: r.createdAt,
});

export function createRewardsService(deps: RewardsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  // --- settings ------------------------------------------------------------------

  async function settings(client: Db | Tx = db): Promise<Settings> {
    const row =
      (await client.rewardSettings.findUnique({ where: { id: 1 } })) ??
      (await client.rewardSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }));
    return toSettings(row);
  }

  /** Portal — staff change the rules. Applies to rewards issued from now on; issued ones keep theirs. */
  async function updateSettings(staffUserId: string, patch: SettingsPatch): Promise<Settings> {
    const bad = (msg: string) => new UserError(RewardCode.INVALID_SETTINGS, msg);
    if (patch.percentBps !== undefined && (patch.percentBps < 0 || patch.percentBps > 5_000)) throw bad('The discount must be between 0% and 50%.');
    if (patch.capPaise !== undefined && (patch.capPaise < 0n || patch.capPaise > 10_000_00n)) throw bad('The cap must be between ₹0 and ₹10,000.');
    if (patch.minOrderPaise !== undefined && (patch.minOrderPaise < 0n || patch.minOrderPaise > 100_000_00n)) throw bad('The minimum payment must be between ₹0 and ₹1,00,000.');
    if (patch.referralExpiryDays !== undefined && (patch.referralExpiryDays < 1 || patch.referralExpiryDays > 3_650)) throw bad('Rewards must last between 1 and 3,650 days.');
    if (patch.referralMonthlyCap !== undefined && (patch.referralMonthlyCap < 0 || patch.referralMonthlyCap > 1_000)) throw bad('The monthly cap must be between 0 and 1,000.');
    if (patch.referralWindowDays !== undefined && (patch.referralWindowDays < 0 || patch.referralWindowDays > 365)) throw bad('The window must be between 0 and 365 days.');
    await settings();
    const row = await db.rewardSettings.update({
      where: { id: 1 },
      data: { ...patch, updatedBy: staffUserId, updatedAt: now() },
    });
    return toSettings(row);
  }

  // --- reading -------------------------------------------------------------------

  /** True once the player has paid at least `minPaise` in one captured order. */
  async function hasPaid(client: Db | Tx, userId: string, minPaise = 0n): Promise<boolean> {
    const n = await client.paymentOrder.count({
      where: { payerUserId: userId, status: 'paid', grossPaise: { gte: minPaise } },
    });
    return n > 0;
  }

  /**
   * The first-payment reward, made now if the player qualifies: no reward of
   * that kind yet, and no payment of at least the minimum. Safe under a race:
   * the partial unique index lets one insert through.
   */
  async function ensureFirstPayment(client: Db | Tx, userId: string, s: Settings): Promise<void> {
    if (!s.enabled) return;
    const existing = await client.reward.findFirst({ where: { userId, kind: 'first_payment' }, select: { id: true } });
    if (existing) return;
    if (await hasPaid(client, userId, s.minOrderPaise)) return;
    await client.reward.createMany({
      data: [{ id: newId(), userId, kind: 'first_payment', percentBps: s.percentBps, capPaise: s.capPaise }],
      skipDuplicates: true,
    });
  }

  /** Usable rewards in preference order: the first-payment one, then referral rewards soonest to expire. */
  async function candidates(client: Db | Tx, userId: string): Promise<RewardRow[]> {
    const at = now();
    const rows = await client.reward.findMany({
      where: { userId, status: 'available', OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
    });
    const rank = (r: RewardRow) => (r.kind === 'first_payment' ? 0 : 1);
    return rows.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  /**
   * What comes off a payment of `grossPaise` for this player. Called by
   * payments when it opens an order (the order records the answer) and by the
   * app before checkout, so the player sees the same number they pay.
   */
  async function discountFor(userId: string, grossPaise: bigint): Promise<Discount> {
    const s = await settings();
    if (!s.enabled) return { discountPaise: 0n, rewardIds: [], label: null };
    await ensureFirstPayment(db, userId, s);
    return pickDiscount(grossPaise, (await candidates(db, userId)).map(toReward), s);
  }

  async function welcomeOffer(userId: string): Promise<WelcomeOffer> {
    const s = await settings();
    await ensureFirstPayment(db, userId, s);
    const row = await db.reward.findFirst({ where: { userId, kind: 'first_payment' } });
    return {
      available: s.enabled && row?.status === 'available',
      percentBps: row?.percentBps ?? s.percentBps,
      capPaise: row?.capPaise ?? s.capPaise,
      minOrderPaise: s.minOrderPaise,
    };
  }

  async function rewardsFor(userId: string): Promise<Reward[]> {
    await ensureFirstPayment(db, userId, await settings());
    const rows = await db.reward.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return rows.map(toReward);
  }

  async function referralsBy(userId: string): Promise<Referral[]> {
    const rows = await db.referral.findMany({ where: { referrerId: userId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map(toReferral);
  }

  async function referralOf(userId: string): Promise<Referral | null> {
    const row = await db.referral.findUnique({ where: { referredId: userId } });
    return row ? toReferral(row) : null;
  }

  /** Whether the player may still type a code: inside the window, before their first payment, not referred yet. */
  async function canEnterCode(userId: string): Promise<boolean> {
    const s = await settings();
    if (!s.referralEnabled) return false;
    const [user, referral] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
      db.referral.findUnique({ where: { referredId: userId }, select: { id: true } }),
    ]);
    if (!user || referral) return false;
    if (now().getTime() - user.createdAt.getTime() > s.referralWindowDays * DAY_MS) return false;
    return !(await hasPaid(db, userId));
  }

  // --- codes ---------------------------------------------------------------------

  /** The player's own code, made the first time it is asked for. */
  async function codeFor(userId: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const user = await db.user.findUnique({ where: { id: userId }, select: { referralCode: true, displayName: true } });
      if (!user) throw new SystemError('NOT_FOUND', 'No such player.');
      if (user.referralCode) return user.referralCode;
      // After a few collisions on the name's letters, go fully random.
      const code = makeCode(attempt < 4 ? user.displayName : '', random);
      try {
        await db.user.updateMany({ where: { id: userId, referralCode: null }, data: { referralCode: code } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new SystemError('INTERNAL', 'Could not make a referral code.');
  }

  /**
   * A new player says who sent them. Only once, only within the window after
   * joining, only before their first payment, never their own code.
   */
  async function applyCode(actor: { userId: string }, rawCode: string): Promise<{ referral: Referral; referrerId: string }> {
    const limit = await deps.limiter.consume(`rewards:apply:${actor.userId}`, APPLY_WINDOW);
    if (!limit.allowed) {
      throw new UserError(RewardCode.RATE_LIMITED, 'Too many tries. Try again in a little while.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const s = await settings();
    if (!s.referralEnabled) throw new UserError(RewardCode.REFERRALS_OFF, 'Referral codes aren’t being accepted right now.');
    const code = normaliseCode(rawCode);
    const invalid = () => new UserError(RewardCode.INVALID_CODE, 'That code doesn’t match anyone. Check it and try again.');
    if (!/^[A-Z0-9]{4,12}$/.test(code)) throw invalid();

    const referrer = await db.user.findUnique({
      where: { referralCode: code },
      select: { id: true, status: true, isGuest: true },
    });
    if (!referrer || referrer.status !== 'active' || referrer.isGuest) throw invalid();
    if (referrer.id === actor.userId) throw new UserError(RewardCode.OWN_CODE, 'That’s your own code — share it with friends instead.');

    const [me, existing, circular] = await Promise.all([
      db.user.findUnique({ where: { id: actor.userId }, select: { createdAt: true } }),
      db.referral.findUnique({ where: { referredId: actor.userId }, select: { id: true } }),
      db.referral.findFirst({ where: { referrerId: actor.userId, referredId: referrer.id }, select: { id: true } }),
    ]);
    if (!me) throw new SystemError('NOT_FOUND', 'No such player.');
    if (existing) throw new UserError(RewardCode.ALREADY_REFERRED, 'You’ve already used a referral code.');
    if (circular) throw invalid();
    if (now().getTime() - me.createdAt.getTime() > s.referralWindowDays * DAY_MS) {
      throw new UserError(RewardCode.TOO_LATE, `Referral codes can be added in your first ${s.referralWindowDays} days on PL4Y.`);
    }
    if (await hasPaid(db, actor.userId)) {
      throw new UserError(RewardCode.TOO_LATE, 'Referral codes can only be added before your first payment.');
    }

    try {
      const row = await db.referral.create({
        data: { id: newId(), referrerId: referrer.id, referredId: actor.userId, code, createdAt: now() },
      });
      return { referral: toReferral(row), referrerId: referrer.id };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new UserError(RewardCode.ALREADY_REFERRED, 'You’ve already used a referral code.');
      }
      throw err;
    }
  }

  // --- what payments tells us ------------------------------------------------------

  /**
   * An order was captured. Uses the rewards its discount counted, spends the
   * welcome offer if this payment qualified without it, and converts the
   * payer's referral. Safe to run twice: every write is conditional.
   */
  async function onCapture(order: OrderFacts): Promise<void> {
    if (!order.payerUserId) return;
    const s = await settings();
    const at = now();

    let remaining = order.discountPaise;
    for (const id of order.rewardIds) {
      const row = await db.reward.findUnique({ where: { id } });
      if (!row) continue;
      if (row.usedOrderId === order.id) {
        remaining -= row.discountPaise ?? 0n;
        continue;
      }
      const share = discountOf(order.grossPaise, row);
      const used = share < remaining ? share : remaining;
      remaining -= used;
      // An expired reward still counts here: the player was quoted it and the
      // gateway has already charged the discounted amount.
      const { count } = await db.reward.updateMany({
        where: { id, status: { in: ['available', 'expired'] } },
        data: { status: 'used', usedOrderId: order.id, usedAt: at, discountPaise: used, updatedAt: at },
      });
      if (count === 0) {
        // Two checkouts opened at once both counted it, and the other paid
        // first. PL4Y has given this discount twice; it is bounded by the cap.
        logger.warn({ rewardId: id, orderId: order.id }, 'reward already used by another order');
        await deps.alert?.('Reward used twice', `Reward ${id} was counted by order ${order.id} after another order had used it. PL4Y covered ${used} paise twice.`);
      }
    }

    // A first payment that qualified but took no welcome discount (rewards
    // were off, or another reward was preferred under no-stacking) spends it.
    if (order.grossPaise >= s.minOrderPaise) {
      await db.reward.updateMany({
        where: { userId: order.payerUserId, kind: 'first_payment', status: 'available', id: { notIn: order.rewardIds } },
        data: { status: 'void', updatedAt: at },
      });
      await convertReferral(order.payerUserId, order.id, s);
    }
  }

  /** A payment was refunded in full: its rewards come back, unless they have since expired. */
  async function onFullRefund(orderId: string): Promise<void> {
    const at = now();
    const rows = await db.reward.findMany({ where: { usedOrderId: orderId, status: 'used' } });
    for (const r of rows) {
      const expired = r.expiresAt !== null && r.expiresAt <= at;
      const { count } = await db.reward.updateMany({
        where: { id: r.id, status: 'used', usedOrderId: orderId },
        data: { status: expired ? 'expired' : 'available', usedOrderId: null, usedAt: null, discountPaise: null, updatedAt: at },
      });
      if (count > 0 && !expired) {
        await deps.notify?.(r.userId, 'reward.available', { reason: 'restored', percentBps: r.percentBps, capPaise: r.capPaise.toString() }).catch((err: unknown) => {
          logger.warn({ err, rewardId: r.id }, 'reward restored notification failed');
        });
      }
    }
  }

  // --- referrals -------------------------------------------------------------------

  /**
   * The referred player has made a qualifying payment. Fraud checks first;
   * a pass issues the referrer's reward, a doubt holds it for PL4Y staff.
   */
  async function convertReferral(referredId: string, orderId: string, s: Settings): Promise<void> {
    const referral = await db.referral.findUnique({ where: { referredId } });
    if (!referral || referral.status !== 'pending') return;

    const [referrer, referred, recent] = await Promise.all([
      db.user.findUnique({ where: { id: referral.referrerId }, select: { status: true, phoneE164: true } }),
      db.user.findUnique({ where: { id: referredId }, select: { phoneE164: true, displayName: true } }),
      db.referral.count({
        where: { referrerId: referral.referrerId, status: 'converted', convertedAt: { gt: new Date(now().getTime() - CAP_WINDOW_MS) } },
      }),
    ]);

    let verdict: { status: 'converted' | 'held' | 'rejected'; reason: string | null };
    if (!referrer || referrer.status !== 'active') verdict = { status: 'rejected', reason: 'referrer_inactive' };
    else if (!s.referralEnabled) verdict = { status: 'rejected', reason: 'referrals_off' };
    else if (referrer.phoneE164 && referred?.phoneE164 && referrer.phoneE164 === referred.phoneE164) {
      verdict = { status: 'held', reason: 'shared_phone' };
    } else if (recent >= s.referralMonthlyCap) verdict = { status: 'held', reason: 'monthly_cap' };
    else verdict = { status: 'converted', reason: null };

    const at = now();
    const moved = await db.$transaction(async (tx) => {
      const { count } = await tx.referral.updateMany({
        where: { id: referral.id, status: 'pending' },
        data: {
          status: verdict.status,
          holdReason: verdict.reason,
          paymentOrderId: orderId,
          convertedAt: verdict.status === 'converted' ? at : null,
        },
      });
      if (count === 0) return false;
      if (verdict.status === 'converted') await issueReferralReward(tx, referral.id, referral.referrerId, s);
      return true;
    });
    if (!moved) return;

    if (verdict.status === 'converted') {
      await deps.notify?.(referral.referrerId, 'referral.converted', {
        friendName: referred?.displayName ?? 'Your friend',
        percentBps: s.percentBps,
        capPaise: s.capPaise.toString(),
      }).catch((err: unknown) => logger.warn({ err, referralId: referral.id }, 'referral notification failed'));
    } else if (verdict.status === 'held') {
      await deps.recordSignal?.({
        subjectType: 'user',
        subjectId: referral.referrerId,
        detector: 'referral_reward',
        score: verdict.reason === 'shared_phone' ? 70 : 40,
        dedupeKey: `referral:${referral.id}`,
        evidence: { referralId: referral.id, referredId, reason: verdict.reason },
      }).catch((err: unknown) => logger.warn({ err, referralId: referral.id }, 'referral fraud signal failed'));
    }
  }

  async function issueReferralReward(tx: Tx, referralId: string, referrerId: string, s: Settings): Promise<void> {
    await tx.reward.createMany({
      data: [
        {
          id: newId(),
          userId: referrerId,
          kind: 'referral',
          referralId,
          percentBps: s.percentBps,
          capPaise: s.capPaise,
          expiresAt: new Date(now().getTime() + s.referralExpiryDays * DAY_MS),
        },
      ],
      skipDuplicates: true,
    });
  }

  /** Portal — a held referral is paid out or turned down. */
  async function reviewReferral(staffUserId: string, referralId: string, approve: boolean): Promise<Referral> {
    const s = await settings();
    const at = now();
    const row = await db.$transaction(async (tx) => {
      const referral = await tx.referral.findUnique({ where: { id: referralId } });
      if (!referral) throw new UserError(RewardCode.REFERRAL_NOT_FOUND, 'That referral could not be found.');
      const { count } = await tx.referral.updateMany({
        where: { id: referralId, status: 'held' },
        data: approve
          ? { status: 'converted', convertedAt: at, reviewedBy: staffUserId, reviewedAt: at }
          : { status: 'rejected', reviewedBy: staffUserId, reviewedAt: at },
      });
      if (count === 0) throw new UserError(RewardCode.NOT_HELD, 'Only a held referral can be reviewed.');
      if (approve) await issueReferralReward(tx, referralId, referral.referrerId, s);
      return tx.referral.findUniqueOrThrow({ where: { id: referralId } });
    });
    if (approve) {
      await deps.notify?.(row.referrerId, 'reward.available', { reason: 'referral', percentBps: s.percentBps, capPaise: s.capPaise.toString() }).catch(
        (err: unknown) => logger.warn({ err, referralId }, 'reward notification failed'),
      );
    }
    return toReferral(row);
  }

  async function referralsForStaff(status: ReferralStatus | null, first: number): Promise<Referral[]> {
    const rows = await db.referral.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(first, 1), 200),
    });
    return rows.map(toReferral);
  }

  /** Portal headline numbers. */
  async function stats(): Promise<{ firstPaymentUsed: number; referralsConverted: number; referralsHeld: number; discountGivenPaise: bigint }> {
    const [firstPaymentUsed, referralsConverted, referralsHeld, sum] = await Promise.all([
      db.reward.count({ where: { kind: 'first_payment', status: 'used' } }),
      db.referral.count({ where: { status: 'converted' } }),
      db.referral.count({ where: { status: 'held' } }),
      db.reward.aggregate({ where: { status: 'used' }, _sum: { discountPaise: true } }),
    ]);
    return { firstPaymentUsed, referralsConverted, referralsHeld, discountGivenPaise: sum._sum.discountPaise ?? 0n };
  }

  // --- jobs ------------------------------------------------------------------------

  /** Daily. Referral rewards past their date stop counting. */
  async function expireDue(): Promise<number> {
    const at = now();
    const { count } = await db.reward.updateMany({
      where: { status: 'available', expiresAt: { lte: at } },
      data: { status: 'expired', updatedAt: at },
    });
    return count;
  }

  return {
    settings,
    updateSettings,
    discountFor,
    welcomeOffer,
    rewardsFor,
    referralsBy,
    referralOf,
    canEnterCode,
    codeFor,
    applyCode,
    onCapture,
    onFullRefund,
    reviewReferral,
    referralsForStaff,
    stats,
    expireDue,
  };
}

export type RewardsService = ReturnType<typeof createRewardsService>;
