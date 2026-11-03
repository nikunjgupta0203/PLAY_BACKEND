/**
 * pricing — commission, the introductory period, and offers
 * (docs/plans/2026-11-03-cue-launch.md §5–7).
 *
 * Owns `pricing_settings`, `venue_commercial_terms`, `offers` and
 * `offer_redemptions`. Bookings asks it for a price and a commission when a
 * table is booked, and tells it when a booking is paid, cancelled or lapses.
 *
 *   · Commission is configurable in the portal: a default per kind of money,
 *     an introductory rate (0%) for each venue's first N days (30), and an
 *     optional per-venue rate. It is frozen on each booking when it is made,
 *     so a later change never reprices one.
 *   · Offers are venue-funded (the owner's, from the venue dashboard) or
 *     PL4Y-funded (from the portal). The engine (engine.ts) applies at most
 *     one of each, separately; the venue is paid on the price after its own
 *     discount only, so a PL4Y offer never costs the venue anything.
 *   · A redemption is reserved when a booking is made, redeemed once it is
 *     paid, and released when it is cancelled or lapses — so usage limits
 *     count what is really in use.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import {
  commissionBpsFor,
  ineligibility,
  offerSummary,
  priceWithOffers,
  type BookingFacts,
  type FundedBy,
  type OfferKind,
  type OfferRule,
  type Priced,
  type VenueTerms,
} from './engine.js';

export const PricingCode = {
  INVALID_SETTINGS: 'INVALID_PRICING_SETTINGS',
  INVALID_OFFER: 'INVALID_OFFER',
  OFFER_NOT_FOUND: 'OFFER_NOT_FOUND',
  OFFER_UNAVAILABLE: 'OFFER_UNAVAILABLE',
  INVALID_TERMS: 'INVALID_VENUE_TERMS',
} as const;

/** A venue keeps this many live offers at most: enough for every format, not a wall of them. */
export const MAX_ACTIVE_VENUE_OFFERS = 20;
const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

export type VenueRole = 'owner' | 'manager' | 'desk';
const RANK: Record<VenueRole, number> = { desk: 1, manager: 2, owner: 3 };

export interface Actor {
  userId: string;
  platformStaff?: boolean;
}

export interface PricingSettings {
  bookingCommissionBps: number;
  venuePayCommissionBps: number;
  introEnabled: boolean;
  introDays: number;
  introCommissionBps: number;
  launchedAt: Date;
  allowStacking: boolean;
  platformDiscountBase: 'after_venue' | 'original';
  maxDiscountBps: number;
  rewardsWithPromos: boolean;
  updatedAt: Date;
}

export type PricingSettingsPatch = Partial<Omit<PricingSettings, 'updatedAt' | 'launchedAt'>>;

export interface Offer extends OfferRule {
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OfferInput {
  title: string;
  description?: string | null;
  kind: OfferKind;
  percentBps?: number | null;
  flatPaise?: bigint | null;
  maxDiscountPaise?: bigint | null;
  minAmountPaise?: bigint | null;
  minMinutes?: number | null;
  weekdays?: number[] | null;
  timeFromMin?: number | null;
  timeToMin?: number | null;
  firstBookingOnly?: boolean | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  perUserLimit?: number | null;
  active?: boolean | null;
}

export interface OfferStats {
  offerId: string;
  /** Paid bookings that used it. */
  redeemed: number;
  /** Bookings holding it right now: held, or booked to pay at the venue. */
  reserved: number;
  /** Distinct players who redeemed it. */
  players: number;
  /** What it has taken off paid bookings, in paise. */
  discountPaise: bigint;
}

export interface IntroStatus {
  /** True while the venue is inside its introductory period, or has not started taking money yet. */
  active: boolean;
  /** Null until the venue's first booking or payment through PL4Y starts the clock. */
  startsAt: Date | null;
  endsAt: Date | null;
  daysLeft: number;
  /** The rate inside the period, and the one after it, in basis points. */
  introCommissionBps: number;
  commissionBpsAfter: number;
  /** The rate that applies to a booking made right now. */
  currentCommissionBps: number;
  /** "Enjoy 0% Commission on PL4Y for Your First 30 Days." — null when the period is over or switched off. */
  message: string | null;
}

export interface PricingDeps {
  db: Db;
  /** Who this person is at the venue (bookings R7). Null: nobody. */
  roleAt(actor: Actor, venueId: string): Promise<VenueRole | null>;
  notifyMany?(
    userIds: string[],
    template: 'offer.new' | 'offer.expiring',
    payload: Record<string, unknown>,
    venueId: string | null,
  ): Promise<void>;
  now?: () => Date;
}

type OfferRow = Awaited<ReturnType<Db['offer']['findFirstOrThrow']>>;
type SettingsRow = Awaited<ReturnType<Db['pricingSettings']['findFirstOrThrow']>>;

const toOffer = (r: OfferRow): Offer => ({
  id: r.id,
  fundedBy: r.fundedBy as FundedBy,
  venueId: r.venueId,
  title: r.title,
  description: r.description,
  kind: r.kind as OfferKind,
  percentBps: r.percentBps,
  flatPaise: r.flatPaise,
  maxDiscountPaise: r.maxDiscountPaise,
  minAmountPaise: r.minAmountPaise,
  minMinutes: r.minMinutes,
  weekdays: r.weekdays,
  timeFromMin: r.timeFromMin,
  timeToMin: r.timeToMin,
  firstBookingOnly: r.firstBookingOnly,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  usageLimit: r.usageLimit,
  perUserLimit: r.perUserLimit,
  active: r.active,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toSettings = (r: SettingsRow): PricingSettings => ({
  bookingCommissionBps: r.bookingCommissionBps,
  venuePayCommissionBps: r.venuePayCommissionBps,
  introEnabled: r.introEnabled,
  introDays: r.introDays,
  introCommissionBps: r.introCommissionBps,
  launchedAt: r.launchedAt,
  allowStacking: r.allowStacking,
  platformDiscountBase: r.platformDiscountBase as 'after_venue' | 'original',
  maxDiscountBps: r.maxDiscountBps,
  rewardsWithPromos: r.rewardsWithPromos,
  updatedAt: r.updatedAt,
});

/** The offer's text and numbers, checked. Shared by venue and PL4Y offers. */
export function validateOffer(input: OfferInput, at: Date, existing?: Offer | null): Omit<OfferRule, 'id' | 'fundedBy' | 'venueId'> & { description: string | null } {
  const bad = (msg: string) => new UserError(PricingCode.INVALID_OFFER, msg);
  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length < 3 || title.length > 60) throw bad('Give the offer a name of 3 to 60 characters.');
  const description = input.description?.trim() || null;
  if (description && description.length > 300) throw bad('Keep the description under 300 characters.');
  const percentBps = input.kind === 'percent' ? (input.percentBps ?? 0) : 0;
  const flatPaise = input.kind === 'flat' ? (input.flatPaise ?? 0n) : 0n;
  if (input.kind === 'percent' && (!Number.isInteger(percentBps) || percentBps < 100 || percentBps > 10_000)) {
    throw bad('A percentage offer is between 1% and 100%.');
  }
  if (input.kind === 'flat' && (flatPaise < 100n || flatPaise > 1_000_000n)) throw bad('A flat discount is between ₹1 and ₹10,000.');
  const maxDiscountPaise = input.maxDiscountPaise ?? null;
  if (maxDiscountPaise !== null && (maxDiscountPaise < 100n || maxDiscountPaise > 1_000_000n)) {
    throw bad('The most it takes off is between ₹1 and ₹10,000.');
  }
  const minAmountPaise = input.minAmountPaise ?? 0n;
  if (minAmountPaise < 0n || minAmountPaise > 10_000_000n) throw bad('The minimum booking value is between ₹0 and ₹1,00,000.');
  const minMinutes = input.minMinutes ?? 0;
  if (!Number.isInteger(minMinutes) || minMinutes < 0 || minMinutes > 720) throw bad('The minimum duration is between 0 and 720 minutes.');
  const weekdays = [...new Set(input.weekdays ?? [])].sort((a, b) => a - b);
  if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Pick days from Monday to Sunday.');
  const from = input.timeFromMin ?? null;
  const to = input.timeToMin ?? null;
  if ((from === null) !== (to === null)) throw bad('Give both a start and an end time, or neither.');
  if (from !== null && to !== null && (from < 0 || to > 1440 || from >= to || from % 5 !== 0 || to % 5 !== 0)) {
    throw bad('The time window needs a start before its end, in 5-minute steps.');
  }
  const startsAt = input.startsAt ?? existing?.startsAt ?? at;
  const endsAt = input.endsAt ?? null;
  if (endsAt && endsAt <= startsAt) throw bad('The offer must end after it starts.');
  if (endsAt && endsAt <= at && !existing) throw bad('That end date has already passed.');
  const usageLimit = input.usageLimit ?? null;
  const perUserLimit = input.perUserLimit ?? null;
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 1_000_000)) throw bad('The usage limit is a whole number from 1.');
  if (perUserLimit !== null && (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 1_000)) throw bad('The per-player limit is a whole number from 1.');
  return {
    title,
    description,
    kind: input.kind,
    percentBps,
    flatPaise,
    maxDiscountPaise: input.kind === 'percent' ? maxDiscountPaise : null,
    minAmountPaise,
    minMinutes,
    weekdays,
    timeFromMin: from,
    timeToMin: to,
    firstBookingOnly: input.firstBookingOnly ?? false,
    startsAt,
    endsAt,
    usageLimit,
    perUserLimit,
    active: input.active ?? existing?.active ?? true,
  };
}

/** Local weekday (0 = Monday) and minutes after midnight, in India time. */
export function localParts(at: Date): { weekday: number; minutes: number } {
  const shifted = new Date(at.getTime() + IST_MS);
  return { weekday: (shifted.getUTCDay() + 6) % 7, minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

export function createPricingService(deps: PricingDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function requireRole(actor: Actor, venueId: string, at: VenueRole): Promise<void> {
    const role = await deps.roleAt(actor, venueId);
    if (!role || RANK[role] < RANK[at]) throw forbidden();
  }

  // --- settings ---------------------------------------------------------------------

  async function settings(): Promise<PricingSettings> {
    const row =
      (await db.pricingSettings.findUnique({ where: { id: 1 } })) ??
      (await db.pricingSettings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }));
    return toSettings(row);
  }

  /** Portal — applies to bookings made from now on; booked ones keep what they were quoted. */
  async function updateSettings(staffUserId: string, patch: PricingSettingsPatch): Promise<PricingSettings> {
    const bad = (msg: string) => new UserError(PricingCode.INVALID_SETTINGS, msg);
    const bps = (v: number | undefined, label: string, max = 5_000) => {
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > max)) throw bad(`${label} must be between 0% and ${max / 100}%.`);
    };
    bps(patch.bookingCommissionBps, 'The booking commission');
    bps(patch.venuePayCommissionBps, 'The pay-at-venue commission');
    bps(patch.introCommissionBps, 'The introductory commission');
    bps(patch.maxDiscountBps, 'The most all discounts can take', 10_000);
    if (patch.introDays !== undefined && (!Number.isInteger(patch.introDays) || patch.introDays < 0 || patch.introDays > 365)) {
      throw bad('The introductory period is between 0 and 365 days.');
    }
    if (patch.platformDiscountBase !== undefined && !['after_venue', 'original'].includes(patch.platformDiscountBase)) {
      throw bad('PL4Y’s discount is taken after the venue’s, or off the original price.');
    }
    await settings();
    const row = await db.pricingSettings.update({ where: { id: 1 }, data: { ...patch, updatedBy: staffUserId, updatedAt: now() } });
    return toSettings(row);
  }

  // --- the introductory period and commission ----------------------------------------------

  async function terms(venueId: string): Promise<VenueTerms & { note: string | null } | null> {
    const row = await db.venueCommercialTerms.findUnique({ where: { venueId } });
    return row
      ? { introStartsAt: row.introStartsAt, introEndsAt: row.introEndsAt, commissionBpsOverride: row.commissionBpsOverride, note: row.note }
      : null;
  }

  /**
   * The venue's introductory period starts the first time it takes money
   * through PL4Y (or switches bookings or pay at venue on). Idempotent: the
   * first call fixes the dates; later calls change nothing.
   */
  async function ensureTerms(venueId: string): Promise<VenueTerms> {
    const existing = await terms(venueId);
    if (existing) return existing;
    const s = await settings();
    const at = now();
    await db.venueCommercialTerms.createMany({
      data: [{ venueId, introStartsAt: at, introEndsAt: new Date(at.getTime() + s.introDays * DAY_MS) }],
      skipDuplicates: true,
    });
    return (await terms(venueId))!;
  }

  /** Portal — move a venue's introductory period, or give it its own rate. */
  async function setTerms(
    staffUserId: string,
    venueId: string,
    patch: { introStartsAt?: Date | null; introEndsAt?: Date | null; commissionBpsOverride?: number | null; clearOverride?: boolean; note?: string | null },
  ) {
    const current = await ensureTerms(venueId);
    const introStartsAt = patch.introStartsAt ?? current.introStartsAt;
    const introEndsAt = patch.introEndsAt ?? current.introEndsAt;
    if (introEndsAt < introStartsAt) throw new UserError(PricingCode.INVALID_TERMS, 'The introductory period must end after it starts.');
    const override = patch.clearOverride ? null : (patch.commissionBpsOverride ?? current.commissionBpsOverride);
    if (override !== null && (!Number.isInteger(override) || override < 0 || override > 5_000)) {
      throw new UserError(PricingCode.INVALID_TERMS, 'A venue’s commission is between 0% and 50%.');
    }
    await db.venueCommercialTerms.update({
      where: { venueId },
      data: {
        introStartsAt,
        introEndsAt,
        commissionBpsOverride: override,
        ...(patch.note !== undefined ? { note: patch.note?.trim() || null } : {}),
        updatedBy: staffUserId,
        updatedAt: now(),
      },
    });
    return terms(venueId);
  }

  /** PL4Y's rate on money taken now at this venue. Starts the venue's introductory period if it has not. */
  async function commissionFor(venueId: string, kind: 'booking' | 'venue_pay'): Promise<number> {
    const [s, t] = await Promise.all([settings(), ensureTerms(venueId)]);
    return commissionBpsFor(s, t, kind, now());
  }

  /** The venue dashboard's banner and commission line. */
  async function introStatus(venueId: string): Promise<IntroStatus> {
    const [s, t] = await Promise.all([settings(), terms(venueId)]);
    const at = now();
    const after = t?.commissionBpsOverride ?? s.bookingCommissionBps;
    const inside = !!t && at >= t.introStartsAt && at < t.introEndsAt;
    const active = s.introEnabled && t?.commissionBpsOverride == null && (inside || !t);
    const daysLeft = t ? Math.max(0, Math.ceil((t.introEndsAt.getTime() - at.getTime()) / DAY_MS)) : s.introDays;
    const pct = (bps: number) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
    return {
      active,
      startsAt: t?.introStartsAt ?? null,
      endsAt: t?.introEndsAt ?? null,
      daysLeft: active ? daysLeft : 0,
      introCommissionBps: s.introCommissionBps,
      commissionBpsAfter: after,
      currentCommissionBps: commissionBpsFor(s, t ?? { introStartsAt: at, introEndsAt: new Date(at.getTime() + s.introDays * DAY_MS), commissionBpsOverride: null }, 'booking', at),
      message: active ? `Enjoy ${pct(s.introCommissionBps)} Commission on PL4Y for Your First ${s.introDays} Days.` : null,
    };
  }

  // --- offers: the owner's and PL4Y's ------------------------------------------------------------

  async function venueName(venueId: string): Promise<string> {
    return (await db.venue.findUnique({ where: { id: venueId }, select: { name: true } }))?.name ?? 'the venue';
  }

  async function offerOr404(offerId: string): Promise<Offer> {
    const row = await db.offer.findUnique({ where: { id: offerId } });
    if (!row) throw new UserError(PricingCode.OFFER_NOT_FOUND, 'That offer could not be found.');
    return toOffer(row);
  }

  /** The venue dashboard: every offer the venue has made, newest first. Managers and owners. */
  async function venueOffers(actor: Actor, venueId: string): Promise<Offer[]> {
    await requireRole(actor, venueId, 'manager');
    const rows = await db.offer.findMany({ where: { venueId, fundedBy: 'venue' }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }], take: 200 });
    return rows.map(toOffer);
  }

  /** Owners and managers create or change their own offers. The venue pays for these. */
  async function saveVenueOffer(actor: Actor, venueId: string, input: OfferInput & { id?: string | null }): Promise<Offer> {
    await requireRole(actor, venueId, 'manager');
    const existing = input.id ? await offerOr404(input.id) : null;
    if (existing && (existing.venueId !== venueId || existing.fundedBy !== 'venue')) throw new UserError(PricingCode.OFFER_NOT_FOUND, 'That offer could not be found.');
    const data = validateOffer(input, now(), existing);
    if (data.active && (!existing || !existing.active)) {
      const live = await db.offer.count({ where: { venueId, fundedBy: 'venue', active: true } });
      if (live >= MAX_ACTIVE_VENUE_OFFERS) {
        throw new UserError(PricingCode.INVALID_OFFER, `A venue can run up to ${MAX_ACTIVE_VENUE_OFFERS} offers at once. Switch one off first.`);
      }
    }
    const row = existing
      ? await db.offer.update({ where: { id: existing.id }, data: { ...data, updatedAt: now() } })
      : await db.offer.create({ data: { id: newId(), fundedBy: 'venue', venueId, createdBy: actor.userId, ...data } });
    return toOffer(row);
  }

  async function setVenueOfferActive(actor: Actor, offerId: string, active: boolean): Promise<Offer> {
    const offer = await offerOr404(offerId);
    if (offer.fundedBy !== 'venue' || !offer.venueId) throw new UserError(PricingCode.OFFER_NOT_FOUND, 'That offer could not be found.');
    return saveVenueOffer(actor, offer.venueId, { ...offer, id: offer.id, active });
  }

  /** Portal — PL4Y's own offers (null venue: every venue). PL4Y pays for these. */
  async function platformOffers(): Promise<Offer[]> {
    const rows = await db.offer.findMany({ where: { fundedBy: 'platform' }, orderBy: [{ active: 'desc' }, { createdAt: 'desc' }], take: 200 });
    return rows.map(toOffer);
  }

  async function savePlatformOffer(staffUserId: string, input: OfferInput & { id?: string | null; venueId?: string | null }): Promise<Offer> {
    const existing = input.id ? await offerOr404(input.id) : null;
    if (existing && existing.fundedBy !== 'platform') throw new UserError(PricingCode.OFFER_NOT_FOUND, 'That offer could not be found.');
    if (input.venueId && !(await db.venue.findFirst({ where: { id: input.venueId, deletedAt: null }, select: { id: true } }))) {
      throw new UserError(PricingCode.INVALID_OFFER, 'That venue could not be found.');
    }
    const data = validateOffer(input, now(), existing);
    const row = existing
      ? await db.offer.update({ where: { id: existing.id }, data: { ...data, venueId: input.venueId ?? null, updatedAt: now() } })
      : await db.offer.create({ data: { id: newId(), fundedBy: 'platform', venueId: input.venueId ?? null, createdBy: staffUserId, ...data } });
    return toOffer(row);
  }

  /** Offers that could apply at a venue now: its own and PL4Y's. What the venue page lists. */
  async function liveOffersAt(venueId: string): Promise<Offer[]> {
    const at = now();
    const rows = await db.offer.findMany({
      where: {
        active: true,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
        AND: [{ OR: [{ venueId }, { venueId: null, fundedBy: 'platform' }] }],
      },
      orderBy: { createdAt: 'desc' },
    });
    const offers = rows.map(toOffer);
    // A used-up offer is no offer.
    const used = await usedTotals(offers.filter((o) => o.usageLimit !== null).map((o) => o.id));
    return offers.filter((o) => o.usageLimit === null || (used.get(o.id) ?? 0) < o.usageLimit);
  }

  async function usedTotals(offerIds: string[]): Promise<Map<string, number>> {
    if (offerIds.length === 0) return new Map();
    const rows = await db.offerRedemption.groupBy({ by: ['offerId'], where: { offerId: { in: offerIds }, status: { in: ['reserved', 'redeemed'] } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.offerId, r._count._all]));
  }

  async function usedBy(userId: string, offerIds: string[]): Promise<Map<string, number>> {
    if (offerIds.length === 0) return new Map();
    const rows = await db.offerRedemption.groupBy({
      by: ['offerId'],
      where: { userId, offerId: { in: offerIds }, status: { in: ['reserved', 'redeemed'] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.offerId, r._count._all]));
  }

  /** A first-time customer: no booking that went ahead and no paid pay-at-venue payment, here or anywhere. */
  async function firstTimes(userId: string | null, venueId: string): Promise<{ atVenue: boolean; anywhere: boolean }> {
    if (!userId) return { atVenue: true, anywhere: true };
    const went = ['confirmed', 'checked_in', 'completed', 'no_show'];
    const [hereB, hereP, anyB, anyP] = await Promise.all([
      db.courtBooking.count({ where: { userId, venueId, status: { in: went } } }),
      db.venuePayment.count({ where: { userId, venueId, status: 'paid' } }),
      db.courtBooking.count({ where: { userId, status: { in: went } } }),
      db.venuePayment.count({ where: { userId, status: 'paid' } }),
    ]);
    return { atVenue: hereB + hereP === 0, anywhere: anyB + anyP === 0 };
  }

  /**
   * The price of a table for this player after offers. `userId` null: a
   * guest looking at the venue page — every offer that could apply shows.
   */
  async function priceBooking(input: { userId: string | null; venueId: string; basePaise: bigint; startsAt: Date; endsAt: Date }): Promise<Priced & { facts: BookingFacts }> {
    const [s, offers, first] = await Promise.all([settings(), liveOffersAt(input.venueId), firstTimes(input.userId, input.venueId)]);
    const ids = offers.map((o) => o.id);
    const [usedTotal, usedByUser] = await Promise.all([usedTotals(ids), input.userId ? usedBy(input.userId, ids) : Promise.resolve(new Map<string, number>())]);
    const start = localParts(input.startsAt);
    const minutes = Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000);
    const facts: BookingFacts = {
      venueId: input.venueId,
      basePaise: input.basePaise,
      minutes,
      weekday: start.weekday,
      startMin: start.minutes,
      endMin: start.minutes + minutes,
      at: now(),
      firstAtVenue: first.atVenue,
      firstAnywhere: first.anywhere,
      usedByUser,
      usedTotal,
    };
    const priced = priceWithOffers({
      facts,
      venueOffers: offers.filter((o) => o.fundedBy === 'venue'),
      platformOffers: offers.filter((o) => o.fundedBy === 'platform'),
      settings: s,
    });
    return { ...priced, facts };
  }

  // --- redemptions ------------------------------------------------------------------------------

  /**
   * A booking was made with these offers. Each offer's row is locked while it
   * is counted, so two players racing for an offer's last use cannot both get
   * it: the loser's booking is refused and the app quotes again.
   */
  async function reserve(input: { bookingId: string; userId: string; priced: Pick<Priced, 'venueOffer' | 'venueDiscountPaise' | 'platformOffer' | 'platformDiscountPaise'> }): Promise<void> {
    const lines: { offer: OfferRule; discount: bigint }[] = [];
    if (input.priced.venueOffer) lines.push({ offer: input.priced.venueOffer, discount: input.priced.venueDiscountPaise });
    if (input.priced.platformOffer) lines.push({ offer: input.priced.platformOffer, discount: input.priced.platformDiscountPaise });
    if (lines.length === 0) return;
    await db.$transaction(async (tx) => {
      for (const { offer, discount } of lines) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM offers WHERE id = ${offer.id}::uuid FOR UPDATE`);
        const [total, mine] = await Promise.all([
          tx.offerRedemption.count({ where: { offerId: offer.id, status: { in: ['reserved', 'redeemed'] } } }),
          tx.offerRedemption.count({ where: { offerId: offer.id, userId: input.userId, status: { in: ['reserved', 'redeemed'] } } }),
        ]);
        if ((offer.usageLimit !== null && total >= offer.usageLimit) || (offer.perUserLimit !== null && mine >= offer.perUserLimit)) {
          throw new UserError(PricingCode.OFFER_UNAVAILABLE, `“${offer.title}” just ran out. Check the new price and try again.`);
        }
        await tx.offerRedemption.create({
          data: { id: newId(), offerId: offer.id, userId: input.userId, bookingId: input.bookingId, fundedBy: offer.fundedBy, discountPaise: discount },
        });
      }
    });
  }

  /** The booking was paid: its offers count as used. A booking revived after its hold lapsed takes them back too. */
  async function redeem(bookingId: string): Promise<void> {
    await db.offerRedemption.updateMany({ where: { bookingId, status: { not: 'redeemed' } }, data: { status: 'redeemed', updatedAt: now() } });
  }

  /** The booking was cancelled or lapsed: its offers can be used again. */
  async function release(bookingId: string): Promise<void> {
    await db.offerRedemption.updateMany({ where: { bookingId, status: { not: 'released' } }, data: { status: 'released', updatedAt: now() } });
  }

  /** Every minute, with the bookings sweep: redemptions on bookings that lapsed or were cancelled. */
  async function releaseDead(): Promise<number> {
    return db.$executeRaw`
      UPDATE offer_redemptions r SET status = 'released', updated_at = now()
        FROM court_bookings b
       WHERE r.booking_id = b.id AND r.status <> 'released'
         AND b.status IN ('expired', 'cancelled', 'no_show', 'payment_failed')`;
  }

  /** How often each offer has been used: the owner's "redeemed by" numbers. */
  async function stats(offerIds: string[]): Promise<Map<string, OfferStats>> {
    const out = new Map<string, OfferStats>(offerIds.map((id) => [id, { offerId: id, redeemed: 0, reserved: 0, players: 0, discountPaise: 0n }]));
    if (offerIds.length === 0) return out;
    const [byStatus, players] = await Promise.all([
      db.offerRedemption.groupBy({
        by: ['offerId', 'status'],
        where: { offerId: { in: offerIds }, status: { in: ['reserved', 'redeemed'] } },
        _count: { _all: true },
        _sum: { discountPaise: true },
      }),
      db.$queryRaw<{ offerId: string; n: bigint }[]>`
        SELECT offer_id::text AS "offerId", count(DISTINCT user_id) AS n
          FROM offer_redemptions WHERE offer_id = ANY(${offerIds}::uuid[]) AND status = 'redeemed'
         GROUP BY offer_id`,
    ]);
    for (const r of byStatus) {
      const s = out.get(r.offerId)!;
      if (r.status === 'redeemed') {
        s.redeemed = r._count._all;
        s.discountPaise = r._sum.discountPaise ?? 0n;
      } else s.reserved = r._count._all;
    }
    for (const p of players) out.get(p.offerId)!.players = Number(p.n);
    return out;
  }

  /** The player's own discounts: what each booking saved, and who paid for it. */
  async function redemptionsFor(bookingIds: string[]) {
    if (bookingIds.length === 0) return [];
    return db.offerRedemption.findMany({ where: { bookingId: { in: bookingIds } }, include: { offer: { select: { title: true } } } });
  }

  // --- notifications (jobs) -----------------------------------------------------------------------

  /** Players worth telling about an offer: customers of the venue, or (a PL4Y offer anywhere) recent bookers. */
  async function audience(offer: Offer): Promise<string[]> {
    const since = new Date(now().getTime() - 180 * DAY_MS);
    const rows = offer.venueId
      ? await db.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT user_id::text AS id FROM court_bookings
           WHERE venue_id = ${offer.venueId}::uuid AND user_id IS NOT NULL AND status NOT IN ('expired', 'held')
          UNION
          SELECT DISTINCT user_id::text FROM venue_payments WHERE venue_id = ${offer.venueId}::uuid AND status = 'paid'
          LIMIT 2000`
      : await db.$queryRaw<{ id: string }[]>`
          SELECT DISTINCT user_id::text AS id FROM court_bookings
           WHERE user_id IS NOT NULL AND status NOT IN ('expired', 'held') AND created_at > ${since}
          UNION
          SELECT DISTINCT user_id::text FROM venue_payments WHERE status = 'paid' AND created_at > ${since}
          LIMIT 5000`;
    return rows.map((r) => r.id);
  }

  /** Hourly. Offers that have started and nobody was told about yet: their venue's customers hear once. */
  async function announceNew(): Promise<number> {
    const at = now();
    const due = await db.offer.findMany({
      where: { active: true, announcedAt: null, startsAt: { lte: at }, OR: [{ endsAt: null }, { endsAt: { gt: at } }] },
      take: 50,
    });
    let sent = 0;
    for (const row of due) {
      const claimed = await db.offer.updateMany({ where: { id: row.id, announcedAt: null }, data: { announcedAt: at } });
      if (claimed.count === 0) continue;
      const offer = toOffer(row);
      const users = await audience(offer);
      if (users.length === 0) continue;
      const name = offer.venueId ? await venueName(offer.venueId) : null;
      await deps
        .notifyMany?.(users, 'offer.new', { venueName: name, title: offer.title, summary: offerSummary(offer) }, offer.venueId)
        .catch((err: unknown) => logger.warn({ err, offerId: offer.id }, 'new offer notification failed'));
      sent += users.length;
    }
    return sent;
  }

  /** Hourly. Offers ending within a day: players who could still use them hear once. */
  async function announceExpiring(): Promise<number> {
    const at = now();
    const due = await db.offer.findMany({
      where: { active: true, expiryNotifiedAt: null, endsAt: { gt: at, lte: new Date(at.getTime() + DAY_MS) }, startsAt: { lte: at } },
      take: 50,
    });
    let sent = 0;
    for (const row of due) {
      const claimed = await db.offer.updateMany({ where: { id: row.id, expiryNotifiedAt: null }, data: { expiryNotifiedAt: at } });
      if (claimed.count === 0) continue;
      const offer = toOffer(row);
      const users = new Set(await audience(offer));
      if (offer.perUserLimit !== null) {
        const used = await db.offerRedemption.groupBy({ by: ['userId'], where: { offerId: offer.id, status: { in: ['reserved', 'redeemed'] } }, _count: { _all: true } });
        for (const u of used) if (u._count._all >= offer.perUserLimit) users.delete(u.userId);
      }
      if (users.size === 0) continue;
      const name = offer.venueId ? await venueName(offer.venueId) : null;
      await deps
        .notifyMany?.([...users], 'offer.expiring', { venueName: name, title: offer.title, endsAt: offer.endsAt!.toISOString() }, offer.venueId)
        .catch((err: unknown) => logger.warn({ err, offerId: offer.id }, 'expiring offer notification failed'));
      sent += users.size;
    }
    return sent;
  }

  /** Why an offer would not apply to a booking: for tests and the owner's preview. */
  const why = ineligibility;

  return {
    settings,
    updateSettings,
    terms,
    ensureTerms,
    setTerms,
    commissionFor,
    introStatus,
    venueOffers,
    saveVenueOffer,
    setVenueOfferActive,
    platformOffers,
    savePlatformOffer,
    liveOffersAt,
    priceBooking,
    reserve,
    redeem,
    release,
    releaseDead,
    stats,
    redemptionsFor,
    announceNew,
    announceExpiring,
    why,
  };
}

export type PricingService = ReturnType<typeof createPricingService>;
