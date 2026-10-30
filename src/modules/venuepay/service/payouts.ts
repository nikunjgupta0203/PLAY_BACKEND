/**
 * pay at venue — monthly venue payouts, paid by hand like community payouts
 * (communities R10, migration 049).
 *
 * Once a month (India time), every venue's pay-at-venue payments from the
 * month just ended are settled into one payout: what the time cost (the
 * undiscounted price — a reward discount is PL4Y's), less PL4Y's 10% (frozen
 * per payment), GST on that commission and TDS at the host-payout rates. Each
 * payment is counted in exactly one payout (`payout_id`).
 *
 * The venue owner's payout account decides whether it is ready: verified,
 * and not replaced in the last 48 hours. Until then it is held and the daily
 * sweep looks again. PL4Y staff send it and mark it paid with the UTR.
 */
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const VenuePayoutCode = {
  PAYOUT_NOT_FOUND: 'PAYOUT_NOT_FOUND',
  PAYOUT_NOT_READY: 'PAYOUT_NOT_READY',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  INVALID_UTR: 'INVALID_UTR',
} as const;

export type VenuePayoutStatus = 'held' | 'ready' | 'paid';

export interface VenuePayout {
  id: string;
  venueId: string;
  venueName: string;
  ownerUserId: string;
  payoutAccountId: string | null;
  period: string;
  paymentCount: number;
  grossPaise: bigint;
  commissionPaise: bigint;
  commissionTaxPaise: bigint;
  tdsPaise: bigint;
  amountPaise: bigint;
  status: VenuePayoutStatus;
  holdReason: string | null;
  utr: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface PayoutAccountLite {
  id: string;
  status: string;
  detailsChangedAt: Date | null;
}

export interface VenuePayoutsDeps {
  db: Db;
  accountOf(userId: string): Promise<PayoutAccountLite | null>;
  rates: { commissionGstBps: number; tdsBps: number };
  notify?(userId: string, payload: Record<string, unknown>, venueId: string): Promise<void>;
  alert?(subject: string, text: string): Promise<void>;
  now?: () => Date;
}

const IST_MS = 330 * 60_000;
const BANK_CHANGE_HOLD_MS = 48 * 3_600_000;
const UTR = /^[A-Z0-9]{6,35}$/;

/** "2026-10" — the calendar month an instant falls in, in India. */
export function periodOf(at: Date): string {
  const local = new Date(at.getTime() + IST_MS);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1) - IST_MS), end: new Date(Date.UTC(y, m, 1) - IST_MS) };
}

export function previousPeriod(at: Date): string {
  return periodOf(new Date(periodBounds(periodOf(at)).start.getTime() - 1));
}

const roundBps = (base: bigint, bps: number): bigint => (base * BigInt(bps) + 5_000n) / 10_000n;

/** The money in one payout, from the frozen per-payment amounts. Pure, so the portal and the transfer agree. */
export function venuePayoutQuote(
  payments: { amountPaise: bigint; commissionPaise: bigint }[],
  rates: { commissionGstBps: number; tdsBps: number },
): { grossPaise: bigint; commissionPaise: bigint; commissionTaxPaise: bigint; tdsPaise: bigint; amountPaise: bigint } {
  const grossPaise = payments.reduce((s, p) => s + p.amountPaise, 0n);
  const commissionPaise = payments.reduce((s, p) => s + p.commissionPaise, 0n);
  const commissionTaxPaise = roundBps(commissionPaise, rates.commissionGstBps);
  const tdsPaise = roundBps(grossPaise, rates.tdsBps);
  return { grossPaise, commissionPaise, commissionTaxPaise, tdsPaise, amountPaise: grossPaise - commissionPaise - commissionTaxPaise - tdsPaise };
}

export function createVenuePayouts(deps: VenuePayoutsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function holdFor(account: PayoutAccountLite | null): string | null {
    if (!account) return 'no_payout_account';
    if (account.status !== 'verified') return 'account_not_verified';
    if (account.detailsChangedAt && now().getTime() - account.detailsChangedAt.getTime() < BANK_CHANGE_HOLD_MS) {
      return 'account_changed_recently';
    }
    return null;
  }

  async function views(rows: Awaited<ReturnType<Db['venuePayout']['findMany']>>): Promise<VenuePayout[]> {
    const venues = await db.venue.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.venueId))] } }, select: { id: true, name: true } });
    const name = new Map(venues.map((v) => [v.id, v.name]));
    return rows.map((r) => ({
      id: r.id,
      venueId: r.venueId,
      venueName: name.get(r.venueId) ?? 'Venue',
      ownerUserId: r.ownerUserId,
      payoutAccountId: r.payoutAccountId,
      period: r.period,
      paymentCount: r.paymentCount,
      grossPaise: r.grossPaise,
      commissionPaise: r.commissionPaise,
      commissionTaxPaise: r.commissionTaxPaise,
      tdsPaise: r.tdsPaise,
      amountPaise: r.amountPaise,
      status: r.status as VenuePayoutStatus,
      holdReason: r.holdReason,
      utr: r.utr,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    }));
  }

  /** Settles one month (default: the one just ended). Idempotent per venue and month. */
  async function settleMonth(period: string = previousPeriod(now())): Promise<{ created: number; ready: number }> {
    const { start, end } = periodBounds(period);
    const due = await db.venuePayment.groupBy({
      by: ['venueId'],
      where: { status: 'paid', payoutId: null, paidAt: { gte: start, lt: end } },
    });
    let created = 0;
    let ready = 0;
    for (const { venueId } of due) {
      const venue = await db.venue.findUnique({ where: { id: venueId }, select: { createdBy: true } });
      if (!venue) continue;
      const account = await deps.accountOf(venue.createdBy);
      const hold = holdFor(account);
      const made = await db.$transaction(async (tx) => {
        if (await tx.venuePayout.findUnique({ where: { venueId_period: { venueId, period } } })) return null;
        const payments = await tx.venuePayment.findMany({
          where: { venueId, status: 'paid', payoutId: null, paidAt: { gte: start, lt: end } },
          select: { id: true, amountPaise: true, commissionPaise: true },
        });
        if (payments.length === 0) return null;
        const id = newId();
        await tx.venuePayout.create({
          data: {
            id,
            venueId,
            ownerUserId: venue.createdBy,
            payoutAccountId: account?.id ?? null,
            period,
            paymentCount: payments.length,
            ...venuePayoutQuote(payments, deps.rates),
            status: hold ? 'held' : 'ready',
            holdReason: hold,
          },
        });
        await tx.venuePayment.updateMany({ where: { id: { in: payments.map((p) => p.id) } }, data: { payoutId: id } });
        return { status: hold ? 'held' : 'ready' };
      });
      if (!made) continue;
      created += 1;
      if (made.status === 'ready') ready += 1;
    }
    if (ready > 0) {
      await deps.alert?.('Venue payouts ready to pay', `${ready} venue payout(s) for ${period} are ready. Pay them from Payouts › Venues in the admin portal.`);
    }
    return { created, ready };
  }

  /** Daily. A held payout whose owner has since verified their bank account becomes ready. */
  async function refreshHeld(): Promise<number> {
    const held = await db.venuePayout.findMany({ where: { status: 'held' }, take: 500 });
    let moved = 0;
    for (const p of held) {
      const account = await deps.accountOf(p.ownerUserId);
      const hold = holdFor(account);
      if (hold) {
        if (hold !== p.holdReason) await db.venuePayout.update({ where: { id: p.id }, data: { holdReason: hold, updatedAt: now() } });
        continue;
      }
      const r = await db.venuePayout.updateMany({
        where: { id: p.id, status: 'held' },
        data: { status: 'ready', holdReason: null, payoutAccountId: account!.id, updatedAt: now() },
      });
      moved += r.count;
    }
    return moved;
  }

  async function open(): Promise<VenuePayout[]> {
    return views(await db.venuePayout.findMany({ where: { status: { in: ['held', 'ready'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 }));
  }

  async function forVenue(venueId: string): Promise<VenuePayout[]> {
    return views(await db.venuePayout.findMany({ where: { venueId }, orderBy: { period: 'desc' }, take: 24 }));
  }

  async function markPaid(staff: { userId: string }, id: string, input: { utr: string; amountPaise: bigint }): Promise<VenuePayout> {
    const utr = input.utr.replace(/[\s-]/g, '').toUpperCase();
    if (!UTR.test(utr)) throw new UserError(VenuePayoutCode.INVALID_UTR, 'Enter the UTR or UPI reference: 6 to 35 letters and digits.');
    const row = await db.venuePayout.findUnique({ where: { id } });
    if (!row) throw new UserError(VenuePayoutCode.PAYOUT_NOT_FOUND, 'That payout could not be found.');
    if (row.status !== 'ready') throw new UserError(VenuePayoutCode.PAYOUT_NOT_READY, 'This payout is not ready to pay.');
    if (input.amountPaise !== row.amountPaise) {
      throw new UserError(VenuePayoutCode.AMOUNT_MISMATCH, `This payout is ₹${(Number(row.amountPaise) / 100).toFixed(2)}. Record exactly what was sent.`);
    }
    const hold = holdFor(await deps.accountOf(row.ownerUserId));
    if (hold) {
      await db.venuePayout.update({ where: { id }, data: { status: 'held', holdReason: hold, updatedAt: now() } });
      throw new UserError(VenuePayoutCode.PAYOUT_NOT_READY, 'The owner’s bank account can’t be paid right now. The payout is held again.');
    }
    const moved = await db.venuePayout.updateMany({
      where: { id, status: 'ready' },
      data: { status: 'paid', utr, paidAt: now(), markedBy: staff.userId, updatedAt: now() },
    });
    if (moved.count === 0) throw new UserError(VenuePayoutCode.PAYOUT_NOT_READY, 'This payout is not ready to pay.');
    const [view] = await views([(await db.venuePayout.findUnique({ where: { id } }))!]);
    await deps.notify?.(row.ownerUserId, { venueName: view!.venueName, amountPaise: row.amountPaise.toString(), utr, period: row.period }, row.venueId).catch(() => undefined);
    return view!;
  }

  /** A refunded payment comes out of the payout that settled it, unless that payout is already paid. */
  async function dropRefundedPayment(payoutId: string, venuePaymentId: string): Promise<'recounted' | 'removed' | 'paid_out'> {
    const outcome = await db.$transaction(async (tx) => {
      const payout = await tx.venuePayout.findUnique({ where: { id: payoutId } });
      if (!payout) return 'removed' as const;
      if (payout.status === 'paid') return 'paid_out' as const;
      await tx.venuePayment.update({ where: { id: venuePaymentId }, data: { payoutId: null } });
      const left = await tx.venuePayment.findMany({ where: { payoutId, status: 'paid' }, select: { amountPaise: true, commissionPaise: true } });
      if (left.length === 0) {
        await tx.venuePayout.delete({ where: { id: payoutId } });
        return 'removed' as const;
      }
      await tx.venuePayout.update({ where: { id: payoutId }, data: { paymentCount: left.length, ...venuePayoutQuote(left, deps.rates), updatedAt: now() } });
      return 'recounted' as const;
    });
    if (outcome === 'paid_out') {
      await deps.alert?.('Refunded venue payment was already paid out', `Venue payment ${venuePaymentId} was refunded after payout ${payoutId} was sent. Recover it from the venue.`);
    }
    return outcome;
  }

  return { settleMonth, refreshHeld, open, forVenue, markPaid, dropRefundedPayment };
}

export type VenuePayouts = ReturnType<typeof createVenuePayouts>;
