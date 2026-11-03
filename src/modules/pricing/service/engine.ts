/**
 * pricing — the pure parts (docs/plans/2026-11-03-cue-launch.md §5–7).
 *
 * No database and no clock: callers hand in the offers, the booking's facts
 * and the time, so the price a player is quoted and the price they are
 * charged are the same function, and every rule is a plain unit test.
 *
 * Money is integer paise throughout; percentages are basis points, rounded
 * half-up like every other split in the codebase.
 */

export type FundedBy = 'venue' | 'platform';
export type OfferKind = 'percent' | 'flat';

export interface OfferRule {
  id: string;
  fundedBy: FundedBy;
  /** Null only for a PL4Y offer that applies at every venue. */
  venueId: string | null;
  title: string;
  kind: OfferKind;
  percentBps: number;
  flatPaise: bigint;
  maxDiscountPaise: bigint | null;
  minAmountPaise: bigint;
  minMinutes: number;
  /** 0 = Monday … 6 = Sunday. Empty: every day. */
  weekdays: number[];
  timeFromMin: number | null;
  timeToMin: number | null;
  firstBookingOnly: boolean;
  startsAt: Date;
  endsAt: Date | null;
  usageLimit: number | null;
  perUserLimit: number | null;
  active: boolean;
}

/** What the engine needs to know about one booking. */
export interface BookingFacts {
  venueId: string;
  basePaise: bigint;
  minutes: number;
  /** Local weekday of the start, 0 = Monday. */
  weekday: number;
  /** Local minutes after midnight, start and end. */
  startMin: number;
  endMin: number;
  /** When the player is booking (an offer must be live now). */
  at: Date;
  /** Never booked or paid at this venue / anywhere on PL4Y. */
  firstAtVenue: boolean;
  firstAnywhere: boolean;
  /** Redemptions so far (reserved or redeemed), per offer: by this player, and by everyone. */
  usedByUser: ReadonlyMap<string, number>;
  usedTotal: ReadonlyMap<string, number>;
}

export interface StackingSettings {
  allowStacking: boolean;
  platformDiscountBase: 'after_venue' | 'original';
  maxDiscountBps: number;
}

export interface Priced {
  basePaise: bigint;
  venueOffer: OfferRule | null;
  venueDiscountPaise: bigint;
  platformOffer: OfferRule | null;
  platformDiscountPaise: bigint;
  /** base − both discounts: the court/table price the player pays before fee and tax. */
  courtPaise: bigint;
}

/** The smallest charge a gateway takes. Discounts never bring a paid booking below it. */
export const MIN_CHARGE_PAISE = 100n;

export const roundBps = (base: bigint, bps: number): bigint => (base * BigInt(bps) + 5_000n) / 10_000n;

/** Why an offer does not apply, or null when it does. The reasons are what the owner's screen shows. */
export function ineligibility(o: OfferRule, f: BookingFacts): string | null {
  if (!o.active) return 'inactive';
  if (o.venueId !== null && o.venueId !== f.venueId) return 'other_venue';
  if (f.at < o.startsAt) return 'not_started';
  if (o.endsAt && f.at >= o.endsAt) return 'ended';
  if (f.basePaise < o.minAmountPaise) return 'below_min_amount';
  if (f.minutes < o.minMinutes) return 'below_min_minutes';
  if (o.weekdays.length > 0 && !o.weekdays.includes(f.weekday)) return 'wrong_day';
  if (o.timeFromMin !== null && o.timeToMin !== null && (f.startMin < o.timeFromMin || f.endMin > o.timeToMin)) {
    return 'wrong_time';
  }
  if (o.firstBookingOnly && !(o.venueId === null ? f.firstAnywhere : f.firstAtVenue)) return 'not_first_booking';
  if (o.usageLimit !== null && (f.usedTotal.get(o.id) ?? 0) >= o.usageLimit) return 'used_up';
  if (o.perUserLimit !== null && (f.usedByUser.get(o.id) ?? 0) >= o.perUserLimit) return 'used_by_you';
  return null;
}

/** What the offer takes off `onPaise`: a percentage half-up or a flat amount, capped, never more than the price. */
export function offerDiscount(o: Pick<OfferRule, 'kind' | 'percentBps' | 'flatPaise' | 'maxDiscountPaise'>, onPaise: bigint): bigint {
  if (onPaise <= 0n) return 0n;
  let d = o.kind === 'percent' ? roundBps(onPaise, o.percentBps) : o.flatPaise;
  if (o.maxDiscountPaise !== null && d > o.maxDiscountPaise) d = o.maxDiscountPaise;
  return d > onPaise ? onPaise : d;
}

/** The eligible offer that takes most off `onPaise`; ties go to the one ending soonest, then the oldest id. */
function best(offers: OfferRule[], f: BookingFacts, onPaise: bigint): { offer: OfferRule; discount: bigint } | null {
  let pick: { offer: OfferRule; discount: bigint } | null = null;
  for (const o of offers) {
    if (ineligibility(o, f) !== null) continue;
    const discount = offerDiscount(o, onPaise);
    if (discount <= 0n) continue;
    const better =
      !pick ||
      discount > pick.discount ||
      (discount === pick.discount &&
        (o.endsAt?.getTime() ?? Infinity) < (pick.offer.endsAt?.getTime() ?? Infinity));
    if (better) pick = { offer: o, discount };
  }
  return pick;
}

/**
 * The booking's price after offers. One venue offer (the venue's best) and one
 * PL4Y offer (PL4Y's best) at most, calculated separately:
 *
 *   · the venue's discount is taken off the original price;
 *   · PL4Y's is taken off the price after the venue's discount, or off the
 *     original (settings), so "20% off, then 10% more up to ₹100" works;
 *   · without stacking, only the larger of the two applies;
 *   · together they never exceed `maxDiscountBps` of the original, and a paid
 *     booking never drops below the minimum charge. Any trimming comes out
 *     of PL4Y's discount first, so a venue's own offer always shows in full.
 */
export function priceWithOffers(input: {
  facts: BookingFacts;
  venueOffers: OfferRule[];
  platformOffers: OfferRule[];
  settings: StackingSettings;
}): Priced {
  const { facts: f, settings: s } = input;
  const base = f.basePaise;
  const none: Priced = { basePaise: base, venueOffer: null, venueDiscountPaise: 0n, platformOffer: null, platformDiscountPaise: 0n, courtPaise: base };
  if (base <= 0n) return none;

  const venue = best(input.venueOffers.filter((o) => o.fundedBy === 'venue'), f, base);
  let venueDiscount = venue?.discount ?? 0n;
  const platformOn = s.platformDiscountBase === 'original' ? base : base - venueDiscount;
  const platform = best(input.platformOffers.filter((o) => o.fundedBy === 'platform'), f, platformOn);
  let platformDiscount = platform?.discount ?? 0n;
  let venueOffer = venue?.offer ?? null;
  let platformOffer = platform?.offer ?? null;

  if (!s.allowStacking && venueOffer && platformOffer) {
    // The player gets the bigger one; a tie goes to the venue's (it costs PL4Y nothing).
    if (platformDiscount > venueDiscount) {
      venueOffer = null;
      venueDiscount = 0n;
      // Recomputed on the original: there is no venue discount to come after.
      platformDiscount = offerDiscount(platformOffer, base);
    } else {
      platformOffer = null;
      platformDiscount = 0n;
    }
  }

  // The ceilings: a share of the original, and the minimum charge.
  const capByShare = (base * BigInt(Math.max(0, Math.min(10_000, s.maxDiscountBps)))) / 10_000n;
  const capByCharge = base > MIN_CHARGE_PAISE ? base - MIN_CHARGE_PAISE : 0n;
  const ceiling = capByShare < capByCharge ? capByShare : capByCharge;
  let over = venueDiscount + platformDiscount - ceiling;
  if (over > 0n) {
    const cut = over < platformDiscount ? over : platformDiscount;
    platformDiscount -= cut;
    over -= cut;
  }
  if (over > 0n) venueDiscount -= over;
  if (venueDiscount <= 0n) {
    venueDiscount = 0n;
    venueOffer = null;
  }
  if (platformDiscount <= 0n) {
    platformDiscount = 0n;
    platformOffer = null;
  }

  return {
    basePaise: base,
    venueOffer,
    venueDiscountPaise: venueDiscount,
    platformOffer,
    platformDiscountPaise: platformDiscount,
    courtPaise: base - venueDiscount - platformDiscount,
  };
}

// --- commission -----------------------------------------------------------------

export interface CommissionSettings {
  bookingCommissionBps: number;
  venuePayCommissionBps: number;
  introEnabled: boolean;
  introCommissionBps: number;
}

export interface VenueTerms {
  introStartsAt: Date;
  introEndsAt: Date;
  commissionBpsOverride: number | null;
}

/**
 * PL4Y's rate on one transaction at one venue: the venue's own rate if staff
 * set one, else the introductory rate inside the venue's introductory
 * period, else the default for the kind of transaction.
 */
export function commissionBpsFor(
  settings: CommissionSettings,
  terms: VenueTerms | null,
  kind: 'booking' | 'venue_pay',
  at: Date,
): number {
  if (terms?.commissionBpsOverride != null) return terms.commissionBpsOverride;
  if (settings.introEnabled && terms && at >= terms.introStartsAt && at < terms.introEndsAt) return settings.introCommissionBps;
  return kind === 'booking' ? settings.bookingCommissionBps : settings.venuePayCommissionBps;
}

/**
 * What the venue earns on a booking, and PL4Y's commission on it. The venue
 * earns the price after ITS OWN discount; PL4Y's discount is PL4Y's, so it
 * never reduces what the venue is paid (or what PL4Y's commission is on).
 */
export function settlementFor(p: Pick<Priced, 'basePaise' | 'venueDiscountPaise'>, commissionBps: number) {
  const venueGrossPaise = p.basePaise - p.venueDiscountPaise;
  return { venueGrossPaise, commissionBps, commissionPaise: roundBps(venueGrossPaise, commissionBps) };
}

/** "20% off, up to ₹100" — the line an offer shows on a card and in a notification. */
export function offerSummary(o: Pick<OfferRule, 'kind' | 'percentBps' | 'flatPaise' | 'maxDiscountPaise' | 'minAmountPaise' | 'minMinutes'>): string {
  const rupees = (p: bigint) => `₹${(Number(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const parts = [o.kind === 'percent' ? `${o.percentBps / 100}% off` : `${rupees(o.flatPaise)} off`];
  if (o.kind === 'percent' && o.maxDiscountPaise !== null) parts[0] += ` up to ${rupees(o.maxDiscountPaise)}`;
  if (o.minAmountPaise > 0n) parts.push(`on bookings of ${rupees(o.minAmountPaise)} or more`);
  if (o.minMinutes > 0) parts.push(`for ${o.minMinutes} minutes or longer`);
  return parts.join(' ');
}
