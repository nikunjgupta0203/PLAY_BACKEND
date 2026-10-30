/**
 * pay at venue (docs/plans/2026-10-30-feature-brief.md, phase 3).
 *
 * A player at a venue pays through PL4Y for the time they played: they pick
 * an activity, enter the minutes, see the duration, rate and amount, and pay.
 * Not a booking: nothing is held on a court, so a capture always lands.
 *
 *   · The owner (or a manager) sets an hourly rate per activity; PL4Y staff
 *     switch the button on; it shows only while the owner's payout account is
 *     verified, so there is always somewhere to send the money.
 *   · The amount is the rate × minutes ÷ 60, half-up, priced on the server
 *     from the rate frozen on the payment when the player starts.
 *   · Like a court, only a verified capture marks it paid (payments R5). The
 *     player and the venue's owner and managers are emailed, and it shows in
 *     the venue desk with its status, reference, player, duration and amount.
 *   · PL4Y keeps 10%, frozen per payment; the rest goes out once a month
 *     (payouts.ts).
 */
import type { Db } from '../../../platform/db.js';
import { SystemError, UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import { operatorNoticeEmail, playerReceiptEmail, type VenuePaymentFacts } from './emails.js';

export const VenuePayCode = {
  NOT_AVAILABLE: 'PAY_AT_VENUE_UNAVAILABLE',
  RATE_NOT_FOUND: 'RATE_NOT_FOUND',
  INVALID_DURATION: 'INVALID_DURATION',
  INVALID_RATE: 'INVALID_RATE',
  NOT_FOUND: 'VENUE_PAYMENT_NOT_FOUND',
} as const;

export const MINUTES_MIN = 10;
export const MINUTES_MAX = 600;
export const MINUTES_STEP = 5;
export const RATE_MIN_PAISE = 1_000n;
export const RATE_MAX_PAISE = 10_000_000n;
/** PL4Y's commission on pay-at-venue money, as on event entry fees. */
export const COMMISSION_BPS = 1_000;
/** How long a started payment waits for its checkout. Nothing scarce is held. */
const HOLD_MS = 30 * 60_000;

export type VenueRole = 'owner' | 'manager' | 'desk';
const RANK: Record<VenueRole, number> = { desk: 1, manager: 2, owner: 3 };

export type VenuePaymentStatus = 'held' | 'paid' | 'expired' | 'failed' | 'refunded';

export interface Rate {
  id: string;
  venueId: string;
  label: string;
  sportId: string | null;
  ratePerHourPaise: bigint;
  active: boolean;
  position: number;
}

export interface VenuePayment {
  id: string;
  venueId: string;
  venueName: string;
  rateId: string;
  userId: string;
  label: string;
  minutes: number;
  ratePerHourPaise: bigint;
  amountPaise: bigint;
  commissionPaise: bigint;
  status: VenuePaymentStatus;
  holdExpiresAt: Date;
  paymentId: string | null;
  paidAt: Date | null;
  payoutId: string | null;
  createdAt: Date;
}

/** Whether a venue's page shows Pay at venue, and why not. */
export interface Offer {
  available: boolean;
  /** not_enabled | no_rates | payout_account — for the owner's setup screen. */
  reason: string | null;
  enabled: boolean;
  rates: Rate[];
}

export interface Actor {
  userId: string;
  platformStaff?: boolean;
}

export interface VenuePayDeps {
  db: Db;
  /** Who this person is at the venue (bookings R7). Null: nobody. */
  roleAt(actor: Actor, venueId: string): Promise<VenueRole | null>;
  /** The owner's payout account status, or null without one. */
  payoutStatusOf(userId: string): Promise<string | null>;
  users: { contactsByIds(ids: string[]): Promise<{ id: string; displayName: string; email: string }[]> };
  email: { send(msg: { to: string; subject: string; text: string; html?: string }): Promise<unknown> };
  notify?(
    userId: string,
    template: 'payment.confirmed' | 'venue.payment_received',
    payload: Record<string, unknown>,
    target: { venueId: string; venuePaymentId: string },
  ): Promise<void>;
  now?: () => Date;
}

// --- pure ----------------------------------------------------------------------

/** rate × minutes ÷ 60, half-up, in paise. */
export function priceFor(ratePerHourPaise: bigint, minutes: number): bigint {
  return (ratePerHourPaise * BigInt(minutes) + 30n) / 60n;
}

/** Half-up, as host payouts round. */
export const commissionOf = (amountPaise: bigint): bigint => (amountPaise * BigInt(COMMISSION_BPS) + 5_000n) / 10_000n;

export function checkMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < MINUTES_MIN || minutes > MINUTES_MAX || minutes % MINUTES_STEP !== 0) {
    throw new UserError(
      VenuePayCode.INVALID_DURATION,
      `Enter between ${MINUTES_MIN} minutes and ${MINUTES_MAX / 60} hours, in steps of ${MINUTES_STEP} minutes.`,
    );
  }
}

// --- service -------------------------------------------------------------------

type RateRow = Awaited<ReturnType<Db['venuePayRate']['findFirstOrThrow']>>;
type PaymentRow = Awaited<ReturnType<Db['venuePayment']['findFirstOrThrow']>>;

const toRate = (r: RateRow): Rate => ({
  id: r.id,
  venueId: r.venueId,
  label: r.label,
  sportId: r.sportId,
  ratePerHourPaise: r.ratePerHourPaise,
  active: r.active,
  position: r.position,
});

export function createVenuePayService(deps: VenuePayDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function requireRole(actor: Actor, venueId: string, at: VenueRole): Promise<VenueRole> {
    const role = await deps.roleAt(actor, venueId);
    if (!role || RANK[role] < RANK[at]) throw forbidden();
    return role;
  }

  async function venueOf(venueId: string) {
    const venue = await db.venue.findFirst({
      where: { id: venueId, deletedAt: null },
      select: { id: true, name: true, createdBy: true, payAtVenueEnabled: true },
    });
    if (!venue) throw new UserError(VenuePayCode.NOT_AVAILABLE, 'That venue could not be found.');
    return venue;
  }

  const names = async (venueIds: string[]): Promise<Map<string, string>> => {
    const rows = await db.venue.findMany({ where: { id: { in: [...new Set(venueIds)] } }, select: { id: true, name: true } });
    return new Map(rows.map((v) => [v.id, v.name]));
  };

  async function views(rows: PaymentRow[]): Promise<VenuePayment[]> {
    const venueNames = await names(rows.map((r) => r.venueId));
    return rows.map((r) => ({
      id: r.id,
      venueId: r.venueId,
      venueName: venueNames.get(r.venueId) ?? 'Venue',
      rateId: r.rateId,
      userId: r.userId,
      label: r.label,
      minutes: r.minutes,
      ratePerHourPaise: r.ratePerHourPaise,
      amountPaise: r.amountPaise,
      commissionPaise: r.commissionPaise,
      status: r.status as VenuePaymentStatus,
      holdExpiresAt: r.holdExpiresAt,
      paymentId: r.paymentId,
      paidAt: r.paidAt,
      payoutId: r.payoutId,
      createdAt: r.createdAt,
    }));
  }

  async function view(row: PaymentRow): Promise<VenuePayment> {
    return (await views([row]))[0]!;
  }

  // --- rates and the offer ------------------------------------------------------

  async function rates(venueId: string, opts: { includeInactive?: boolean } = {}): Promise<Rate[]> {
    const rows = await db.venuePayRate.findMany({
      where: { venueId, ...(opts.includeInactive ? {} : { active: true }) },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toRate);
  }

  /** What the venue page shows. The owner's setup screen reads `reason`. */
  async function offer(venueId: string): Promise<Offer> {
    const venue = await venueOf(venueId);
    const list = await rates(venueId);
    let reason: string | null = null;
    if (!venue.payAtVenueEnabled) reason = 'not_enabled';
    else if (list.length === 0) reason = 'no_rates';
    else if ((await deps.payoutStatusOf(venue.createdBy)) !== 'verified') reason = 'payout_account';
    return { available: reason === null, reason, enabled: venue.payAtVenueEnabled, rates: list };
  }

  /** Owners and managers add or change a rate. A rate in use is never deleted, only switched off. */
  async function saveRate(
    actor: Actor,
    venueId: string,
    input: { id?: string | null; label: string; sportId?: string | null; ratePerHourPaise: bigint; active?: boolean; position?: number },
  ): Promise<Rate> {
    await requireRole(actor, venueId, 'manager');
    await venueOf(venueId);
    const label = input.label.trim().replace(/\s+/g, ' ');
    if (label.length < 2 || label.length > 60) throw new UserError(VenuePayCode.INVALID_RATE, 'Name the activity in 2 to 60 characters.');
    if (input.ratePerHourPaise < RATE_MIN_PAISE || input.ratePerHourPaise > RATE_MAX_PAISE) {
      throw new UserError(VenuePayCode.INVALID_RATE, 'The hourly rate must be between ₹10 and ₹1,00,000.');
    }
    const data = {
      label,
      sportId: input.sportId ?? null,
      ratePerHourPaise: input.ratePerHourPaise,
      active: input.active ?? true,
      position: input.position ?? 0,
      updatedAt: now(),
    };
    if (input.id) {
      const existing = await db.venuePayRate.findFirst({ where: { id: input.id, venueId } });
      if (!existing) throw new UserError(VenuePayCode.RATE_NOT_FOUND, 'That rate could not be found.');
      return toRate(await db.venuePayRate.update({ where: { id: input.id }, data }));
    }
    const count = await db.venuePayRate.count({ where: { venueId, active: true } });
    if (count >= 20) throw new UserError(VenuePayCode.INVALID_RATE, 'A venue can have up to 20 rates.');
    return toRate(await db.venuePayRate.create({ data: { id: newId(), venueId, ...data } }));
  }

  /** Portal — PL4Y staff switch the button on or off. */
  async function setEnabled(venueId: string, enabled: boolean): Promise<Offer> {
    await venueOf(venueId);
    await db.venue.update({ where: { id: venueId }, data: { payAtVenueEnabled: enabled } });
    return offer(venueId);
  }

  // --- the player's side ----------------------------------------------------------

  /** The breakdown before paying: duration, rate, amount. The server's arithmetic, never the app's. */
  async function quote(venueId: string, rateId: string, minutes: number) {
    checkMinutes(minutes);
    const rate = await db.venuePayRate.findFirst({ where: { id: rateId, venueId, active: true } });
    if (!rate) throw new UserError(VenuePayCode.RATE_NOT_FOUND, 'That activity is no longer available here.');
    return { minutes, ratePerHourPaise: rate.ratePerHourPaise, amountPaise: priceFor(rate.ratePerHourPaise, minutes), label: rate.label };
  }

  /** The player starts: the rate and price are frozen on a held payment, then payments opens the order. */
  async function start(actor: Actor, input: { venueId: string; rateId: string; minutes: number }): Promise<VenuePayment> {
    const o = await offer(input.venueId);
    if (!o.available) throw new UserError(VenuePayCode.NOT_AVAILABLE, 'This venue isn’t taking payments through PL4Y right now.');
    const q = await quote(input.venueId, input.rateId, input.minutes);
    const row = await db.venuePayment.create({
      data: {
        id: newId(),
        venueId: input.venueId,
        rateId: input.rateId,
        userId: actor.userId,
        label: q.label,
        minutes: q.minutes,
        ratePerHourPaise: q.ratePerHourPaise,
        amountPaise: q.amountPaise,
        commissionPaise: commissionOf(q.amountPaise),
        holdExpiresAt: new Date(now().getTime() + HOLD_MS),
      },
    });
    return view(row);
  }

  async function byId(id: string): Promise<VenuePayment | null> {
    const row = await db.venuePayment.findUnique({ where: { id } });
    return row ? view(row) : null;
  }

  /** The player's own, or the venue's people. */
  async function forViewer(actor: Actor, id: string): Promise<VenuePayment | null> {
    const row = await db.venuePayment.findUnique({ where: { id } });
    if (!row) return null;
    if (row.userId !== actor.userId && !(await deps.roleAt(actor, row.venueId))) return null;
    return view(row);
  }

  async function mine(userId: string, first = 30): Promise<VenuePayment[]> {
    const rows = await db.venuePayment.findMany({
      where: { userId, status: { in: ['paid', 'refunded'] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(first, 100),
    });
    return views(rows);
  }

  // --- what payments calls (payments R20) ------------------------------------------

  async function forPayments(id: string) {
    const row = await db.venuePayment.findUnique({ where: { id } });
    if (!row) throw new UserError(VenuePayCode.NOT_FOUND, 'That payment could not be found.');
    const venue = await db.venue.findUnique({ where: { id: row.venueId }, select: { name: true } });
    return {
      id: row.id,
      userId: row.userId,
      status: row.status,
      amountPaise: row.amountPaise,
      holdExpiresAt: row.holdExpiresAt,
      description: `${row.label} at ${venue?.name ?? 'the venue'}`,
    };
  }

  async function extendHold(id: string, minutes: number): Promise<void> {
    const until = new Date(now().getTime() + minutes * 60_000);
    await db.venuePayment.updateMany({ where: { id, status: { in: ['held', 'failed'] }, holdExpiresAt: { lt: until } }, data: { holdExpiresAt: until, updatedAt: now() } });
  }

  /**
   * A verified capture. Nothing scarce was held, so a late capture still
   * pays: only a refunded payment cannot become paid again. The emails go out
   * once, from the call that moved it.
   */
  async function confirmFromPayment(input: {
    venuePaymentId: string;
    paymentId: string;
    gatewayPaymentId: string | null;
    discountPaise: bigint;
  }): Promise<{ confirmedNow: boolean }> {
    const at = now();
    const { count } = await db.venuePayment.updateMany({
      where: { id: input.venuePaymentId, status: { in: ['held', 'expired', 'failed'] } },
      data: { status: 'paid', paymentId: input.paymentId, paidAt: at, updatedAt: at },
    });
    if (count === 0) {
      const row = await db.venuePayment.findUnique({ where: { id: input.venuePaymentId } });
      if (row?.status === 'paid') return { confirmedNow: false };
      throw new SystemError('ILLEGAL_TRANSITION', 'This payment can no longer be completed.');
    }
    await announce(input.venuePaymentId, input.gatewayPaymentId, input.discountPaise).catch((err: unknown) => {
      logger.error({ err, venuePaymentId: input.venuePaymentId }, 'pay-at-venue confirmation messages failed');
    });
    return { confirmedNow: true };
  }

  async function failFromPayment(input: { venuePaymentId: string }): Promise<void> {
    await db.venuePayment.updateMany({ where: { id: input.venuePaymentId, status: 'held' }, data: { status: 'failed', updatedAt: now() } });
  }

  /** A refund in full: out of the venue's money, and out of an unsent payout. */
  async function markRefunded(venuePaymentId: string): Promise<{ payoutId: string | null } | null> {
    const row = await db.venuePayment.findUnique({ where: { id: venuePaymentId } });
    if (!row || row.status !== 'paid') return null;
    await db.venuePayment.update({ where: { id: venuePaymentId }, data: { status: 'refunded', updatedAt: now() } });
    return { payoutId: row.payoutId };
  }

  /** The player's receipt and the venue's notice: email, feed and push. */
  async function announce(venuePaymentId: string, reference: string | null, discountPaise: bigint): Promise<void> {
    const row = await db.venuePayment.findUniqueOrThrow({ where: { id: venuePaymentId } });
    const venue = await db.venue.findUniqueOrThrow({ where: { id: row.venueId }, select: { name: true, createdBy: true } });
    const staff = await db.venueStaff.findMany({ where: { venueId: row.venueId, role: { in: ['owner', 'manager'] } }, select: { userId: true } });
    const operators = [...new Set([venue.createdBy, ...staff.map((s) => s.userId)])];
    const contacts = await deps.users.contactsByIds([row.userId, ...operators]);
    const player = contacts.find((c) => c.id === row.userId);
    const facts: VenuePaymentFacts = {
      venueName: venue.name,
      label: row.label,
      minutes: row.minutes,
      ratePerHourPaise: row.ratePerHourPaise,
      amountPaise: row.amountPaise,
      discountPaise,
      playerName: player?.displayName ?? 'A player',
      reference,
      paidAt: row.paidAt ?? now(),
    };
    const target = { venueId: row.venueId, venuePaymentId };
    const sends: Promise<unknown>[] = [];
    if (player?.email) sends.push(deps.email.send({ to: player.email, ...playerReceiptEmail(player.email, facts) }));
    for (const id of operators) {
      const c = contacts.find((x) => x.id === id);
      if (c?.email) sends.push(deps.email.send({ to: c.email, ...operatorNoticeEmail(c.email, facts) }));
    }
    sends.push(
      deps.notify?.(row.userId, 'payment.confirmed', { what: `${row.label} at ${venue.name}`, amountPaise: (row.amountPaise - discountPaise).toString() }, target) ??
        Promise.resolve(),
    );
    for (const id of operators) {
      sends.push(
        deps.notify?.(
          id,
          'venue.payment_received',
          { playerName: facts.playerName, label: row.label, minutes: row.minutes, amountPaise: row.amountPaise.toString(), venueName: venue.name },
          target,
        ) ?? Promise.resolve(),
      );
    }
    const results = await Promise.allSettled(sends);
    for (const r of results) if (r.status === 'rejected') logger.warn({ err: r.reason, venuePaymentId }, 'pay-at-venue message failed');
  }

  // --- the venue's side --------------------------------------------------------------

  /** The operator dashboard: payments at this venue, newest first. Desk staff and up. */
  async function forVenue(actor: Actor, venueId: string, input: { from?: Date | null; to?: Date | null; first?: number } = {}): Promise<VenuePayment[]> {
    await requireRole(actor, venueId, 'desk');
    const rows = await db.venuePayment.findMany({
      where: {
        venueId,
        status: { in: ['paid', 'refunded'] },
        paidAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lt: input.to } : {}) },
      },
      orderBy: { paidAt: 'desc' },
      take: Math.min(input.first ?? 100, 500),
    });
    return views(rows);
  }

  /** Portal — every pay-at-venue payment, newest first. */
  async function forStaff(input: { venueId?: string | null; first?: number } = {}): Promise<VenuePayment[]> {
    const rows = await db.venuePayment.findMany({
      where: { status: { in: ['paid', 'refunded'] }, ...(input.venueId ? { venueId: input.venueId } : {}) },
      orderBy: { paidAt: 'desc' },
      take: Math.min(input.first ?? 100, 500),
    });
    return views(rows);
  }

  /** Started but never paid: they stop counting. With the bookings sweep. */
  async function sweep(): Promise<number> {
    const { count } = await db.venuePayment.updateMany({
      where: { status: 'held', holdExpiresAt: { lt: now() } },
      data: { status: 'expired', updatedAt: now() },
    });
    return count;
  }

  /**
   * What the dashboard and receipt show beside each payment: the gateway's
   * reference, the method, and PL4Y's reward discount (the player paid
   * amount − discount; the venue is paid on the amount).
   */
  async function paymentFacts(ids: string[]): Promise<Map<string, { reference: string | null; method: string | null; discountPaise: bigint }>> {
    const out = new Map<string, { reference: string | null; method: string | null; discountPaise: bigint }>();
    if (ids.length === 0) return out;
    const orders = await db.paymentOrder.findMany({
      where: { venuePaymentId: { in: ids }, status: 'paid' },
      select: { venuePaymentId: true, discountPaise: true, payments: { where: { status: { not: 'failed' } }, select: { gatewayPaymentId: true, method: true }, take: 1 } },
    });
    for (const o of orders) {
      if (!o.venuePaymentId || out.has(o.venuePaymentId)) continue;
      out.set(o.venuePaymentId, { reference: o.payments[0]?.gatewayPaymentId ?? null, method: o.payments[0]?.method ?? null, discountPaise: o.discountPaise });
    }
    return out;
  }

  /** Whether this person runs any venue that takes payments here: the venue desk entry. */
  async function hasRates(venueIds: string[]): Promise<boolean> {
    if (venueIds.length === 0) return false;
    return (await db.venuePayRate.count({ where: { venueId: { in: venueIds }, active: true } })) > 0;
  }

  return {
    rates,
    offer,
    saveRate,
    setEnabled,
    quote,
    start,
    byId,
    forViewer,
    mine,
    forPayments,
    extendHold,
    confirmFromPayment,
    failFromPayment,
    markRefunded,
    forVenue,
    forStaff,
    sweep,
    hasRates,
    paymentFacts,
    requireRole,
  };
}

export type VenuePayService = ReturnType<typeof createVenuePayService>;
