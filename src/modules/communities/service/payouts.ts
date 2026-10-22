/**
 * communities R10 — creator payouts for paid communities.
 *
 * Once a month (India time), every paid community's memberships paid in the
 * month just ended are settled into one payout: what members paid, PL4Y's 5%
 * (frozen on each payment), GST on that commission and TDS — the rates host
 * payouts use. Each payment is counted in exactly one payout (`payout_id`).
 *
 * The owner's payout account decides whether it is ready: verified, and not
 * replaced in the last 48 hours (gap #25). Until then it is held, and the
 * daily sweep looks again. PL4Y staff send it by hand and mark it paid with
 * the UTR, as they do host payouts.
 */
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const CommunityPayoutCode = {
  PAYOUT_NOT_FOUND: 'PAYOUT_NOT_FOUND',
  PAYOUT_NOT_READY: 'PAYOUT_NOT_READY',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  INVALID_UTR: 'INVALID_UTR',
} as const;

export type PayoutStatus = 'held' | 'ready' | 'paid';

export interface CommunityPayout {
  id: string;
  communityId: string;
  communityName: string;
  ownerUserId: string;
  payoutAccountId: string | null;
  period: string;
  paymentCount: number;
  grossPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  tdsPaise: bigint;
  amountPaise: bigint;
  status: PayoutStatus;
  holdReason: string | null;
  utr: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface PayoutAccountLite {
  id: string;
  /** checking | verified | needs_review | rejected | suspended */
  status: string;
  detailsChangedAt: Date | null;
}

export interface CommunityPayoutsDeps {
  db: Db;
  accountOf(userId: string): Promise<PayoutAccountLite | null>;
  rates: { commissionGstBps: number; tdsBps: number };
  notify?(userId: string, template: 'community.payout_paid', payload: Record<string, unknown>, communityId: string): Promise<void>;
  /** PL4Y's finance inbox: payouts waiting for a person. */
  alert?(subject: string, text: string): Promise<void>;
  now?: () => Date;
}

/** India has one offset and no daylight saving: a constant, not a conversion. */
const IST_MS = 330 * 60_000;
const BANK_CHANGE_HOLD_MS = 48 * 3_600_000;
const UTR = /^[A-Z0-9]{6,35}$/;

/** "2026-10" — the calendar month an instant falls in, in India. */
export function periodOf(at: Date): string {
  const local = new Date(at.getTime() + IST_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month's first and next month's first instant, India time, as UTC instants. */
export function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1) - IST_MS), end: new Date(Date.UTC(y, m, 1) - IST_MS) };
}

/** The month before the one `at` falls in. */
export function previousPeriod(at: Date): string {
  const { start } = periodBounds(periodOf(at));
  return periodOf(new Date(start.getTime() - 1));
}

/** Half-up in integers, as host payouts round (payoutQuote.roundBps). */
const roundBps = (base: bigint, bps: number): bigint => (base * BigInt(bps) + 5_000n) / 10_000n;

/** R10 — the money in one payout, from the frozen per-payment amounts. Pure, so the portal and the transfer agree. */
export function communityPayoutQuote(
  payments: { pricePaise: bigint; commissionPaise: bigint }[],
  rates: { commissionGstBps: number; tdsBps: number },
): { grossPaise: bigint; commissionPaise: bigint; commissionTaxPaise: bigint; tdsPaise: bigint; amountPaise: bigint } {
  const grossPaise = payments.reduce((s, p) => s + p.pricePaise, 0n);
  const commissionPaise = payments.reduce((s, p) => s + p.commissionPaise, 0n);
  const commissionTaxPaise = roundBps(commissionPaise, rates.commissionGstBps);
  const tdsPaise = roundBps(grossPaise, rates.tdsBps);
  return { grossPaise, commissionPaise, commissionTaxPaise, tdsPaise, amountPaise: grossPaise - commissionPaise - commissionTaxPaise - tdsPaise };
}

export function createCommunityPayouts(deps: CommunityPayoutsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** Why this account cannot be paid yet, or null when it can. */
  function holdFor(account: PayoutAccountLite | null): string | null {
    if (!account) return 'no_payout_account';
    if (account.status !== 'verified') return 'account_not_verified';
    if (account.detailsChangedAt && now().getTime() - account.detailsChangedAt.getTime() < BANK_CHANGE_HOLD_MS) {
      return 'account_changed_recently';
    }
    return null;
  }

  const view = (r: {
    id: string;
    communityId: string;
    ownerUserId: string;
    payoutAccountId: string | null;
    period: string;
    paymentCount: number;
    grossPaise: bigint;
    commissionPaise: bigint;
    commissionTaxPaise: bigint;
    tdsPaise: bigint;
    amountPaise: bigint;
    status: string;
    holdReason: string | null;
    utr: string | null;
    paidAt: Date | null;
    createdAt: Date;
    community: { name: string };
  }): CommunityPayout => ({
    id: r.id,
    communityId: r.communityId,
    communityName: r.community.name,
    ownerUserId: r.ownerUserId,
    payoutAccountId: r.payoutAccountId,
    period: r.period,
    paymentCount: r.paymentCount,
    grossPaise: r.grossPaise,
    commissionPaise: r.commissionPaise,
    commissionTaxPaise: r.commissionTaxPaise,
    tdsPaise: r.tdsPaise,
    amountPaise: r.amountPaise,
    status: r.status as PayoutStatus,
    holdReason: r.holdReason,
    utr: r.utr,
    paidAt: r.paidAt,
    createdAt: r.createdAt,
  });

  const withName = { community: { select: { name: true } } } as const;

  /**
   * R10 — settles one month (default: the one just ended). Idempotent: a
   * community's month is one row (unique index), and a payment already in a
   * payout is never picked up again.
   */
  async function settleMonth(period: string = previousPeriod(now())): Promise<{ created: number; ready: number }> {
    const { start, end } = periodBounds(period);
    const due = await db.communityPayment.groupBy({
      by: ['communityId'],
      where: { status: 'paid', payoutId: null, paidAt: { gte: start, lt: end } },
    });
    let created = 0;
    let ready = 0;
    for (const { communityId } of due) {
      const community = await db.community.findUnique({ where: { id: communityId }, select: { ownerUserId: true } });
      if (!community) continue;
      const account = await deps.accountOf(community.ownerUserId);
      const hold = holdFor(account);
      const made = await db.$transaction(async (tx) => {
        if (await tx.communityPayout.findUnique({ where: { communityId_period: { communityId, period } } })) return null;
        const payments = await tx.communityPayment.findMany({
          where: { communityId, status: 'paid', payoutId: null, paidAt: { gte: start, lt: end } },
          select: { id: true, pricePaise: true, commissionPaise: true },
        });
        if (payments.length === 0) return null;
        const quote = communityPayoutQuote(payments, deps.rates);
        const id = newId();
        await tx.communityPayout.create({
          data: {
            id,
            communityId,
            ownerUserId: community.ownerUserId,
            payoutAccountId: account?.id ?? null,
            period,
            paymentCount: payments.length,
            ...quote,
            status: hold ? 'held' : 'ready',
            holdReason: hold,
          },
        });
        await tx.communityPayment.updateMany({ where: { id: { in: payments.map((p) => p.id) } }, data: { payoutId: id } });
        return { status: hold ? 'held' : 'ready' };
      });
      if (!made) continue;
      created += 1;
      if (made.status === 'ready') ready += 1;
    }
    if (ready > 0) {
      await deps.alert?.('Community payouts ready to pay', `${ready} community payout(s) for ${period} are ready. Pay them from Payouts › Communities in the admin portal.`);
    }
    return { created, ready };
  }

  /** Daily. A held payout whose owner has since verified their bank account becomes ready. */
  async function refreshHeld(): Promise<number> {
    const held = await db.communityPayout.findMany({ where: { status: 'held' }, take: 500 });
    let moved = 0;
    for (const p of held) {
      const account = await deps.accountOf(p.ownerUserId);
      const hold = holdFor(account);
      if (hold) {
        if (hold !== p.holdReason) await db.communityPayout.update({ where: { id: p.id }, data: { holdReason: hold, updatedAt: now() } });
        continue;
      }
      const r = await db.communityPayout.updateMany({
        where: { id: p.id, status: 'held' },
        data: { status: 'ready', holdReason: null, payoutAccountId: account!.id, updatedAt: now() },
      });
      moved += r.count;
    }
    return moved;
  }

  /** Staff: held and ready payouts, oldest first. */
  async function open(): Promise<CommunityPayout[]> {
    const rows = await db.communityPayout.findMany({
      where: { status: { in: ['held', 'ready'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: withName,
      take: 200,
    });
    return rows.map(view);
  }

  /** The owner's own payouts for one community, newest month first. */
  async function forCommunity(communityId: string): Promise<CommunityPayout[]> {
    const rows = await db.communityPayout.findMany({ where: { communityId }, orderBy: { period: 'desc' }, include: withName, take: 24 });
    return rows.map(view);
  }

  /**
   * Staff record a ready payout as sent from PL4Y's bank. The amount must be
   * the frozen one exactly, and the account must still be payable.
   */
  async function markPaid(staff: { userId: string }, id: string, input: { utr: string; amountPaise: bigint }): Promise<CommunityPayout> {
    const utr = input.utr.replace(/[\s-]/g, '').toUpperCase();
    if (!UTR.test(utr)) throw new UserError(CommunityPayoutCode.INVALID_UTR, 'Enter the UTR or UPI reference: 6 to 35 letters and digits.');
    const row = await db.communityPayout.findUnique({ where: { id }, include: withName });
    if (!row) throw new UserError(CommunityPayoutCode.PAYOUT_NOT_FOUND, 'That payout could not be found.');
    if (row.status !== 'ready') throw new UserError(CommunityPayoutCode.PAYOUT_NOT_READY, 'This payout is not ready to pay.');
    if (input.amountPaise !== row.amountPaise) {
      throw new UserError(CommunityPayoutCode.AMOUNT_MISMATCH, `This payout is ₹${(Number(row.amountPaise) / 100).toFixed(2)}. Record exactly what was sent.`);
    }
    const hold = holdFor(await deps.accountOf(row.ownerUserId));
    if (hold) {
      await db.communityPayout.update({ where: { id }, data: { status: 'held', holdReason: hold, updatedAt: now() } });
      throw new UserError(CommunityPayoutCode.PAYOUT_NOT_READY, 'The owner’s bank account can’t be paid right now. The payout is held again.');
    }
    const moved = await db.communityPayout.updateMany({
      where: { id, status: 'ready' },
      data: { status: 'paid', utr, paidAt: now(), markedBy: staff.userId, updatedAt: now() },
    });
    if (moved.count === 0) throw new UserError(CommunityPayoutCode.PAYOUT_NOT_READY, 'This payout is not ready to pay.');
    await deps
      .notify?.(
        row.ownerUserId,
        'community.payout_paid',
        { communityName: row.community.name, amountPaise: row.amountPaise.toString(), utr, period: row.period },
        row.communityId,
      )
      .catch(() => undefined);
    return view((await db.communityPayout.findUnique({ where: { id }, include: withName }))!);
  }

  /**
   * R10 — a refunded payment comes out of the payout that settled it. A payout
   * not yet sent is recounted from what is left (or removed when nothing is);
   * one already paid cannot change, so the creator owes it back and finance is
   * told.
   */
  async function dropRefundedPayment(payoutId: string, communityPaymentId: string): Promise<'recounted' | 'removed' | 'paid_out'> {
    const outcome = await db.$transaction(async (tx) => {
      const payout = await tx.communityPayout.findUnique({ where: { id: payoutId }, include: withName });
      if (!payout) return { kind: 'removed' as const };
      if (payout.status === 'paid') return { kind: 'paid_out' as const, payout };
      await tx.communityPayment.update({ where: { id: communityPaymentId }, data: { payoutId: null } });
      const left = await tx.communityPayment.findMany({
        where: { payoutId, status: 'paid' },
        select: { pricePaise: true, commissionPaise: true },
      });
      if (left.length === 0) {
        await tx.communityPayout.delete({ where: { id: payoutId } });
        return { kind: 'removed' as const };
      }
      await tx.communityPayout.update({
        where: { id: payoutId },
        data: { paymentCount: left.length, ...communityPayoutQuote(left, deps.rates), updatedAt: now() },
      });
      return { kind: 'recounted' as const };
    });
    if (outcome.kind === 'paid_out') {
      const price = (await db.communityPayment.findUnique({ where: { id: communityPaymentId }, select: { pricePaise: true } }))?.pricePaise ?? 0n;
      await deps.alert?.(
        'Refunded membership was already paid out',
        `A membership payment of ₹${(Number(price) / 100).toFixed(2)} for ${outcome.payout.community.name} (${outcome.payout.period}) was refunded ` +
          `after its payout was sent (UTR ${outcome.payout.utr}). Recover it from the community owner.`,
      );
    }
    return outcome.kind;
  }

  return { settleMonth, refreshHeld, open, forCommunity, markPaid, dropRefundedPayment };
}

export type CommunityPayouts = ReturnType<typeof createCommunityPayouts>;
