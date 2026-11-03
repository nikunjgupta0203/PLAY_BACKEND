/**
 * pricing — GraphQL (docs/plans/2026-11-03-cue-launch.md §5–7).
 *
 * The venue dashboard: the owner's offers (with how often each was used),
 * and the commission banner ("Enjoy 0% Commission on PL4Y for Your First 30
 * Days."). Players: the offers live at a venue. The portal: PL4Y's pricing
 * settings (commission, the introductory period, stacking), PL4Y's own
 * offers, and each venue's introductory period and rate.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { VenueRef } from '../../venues/schema/index.js';
import { venues } from '../../venues/index.js';
import { offerSummary, pricing } from '../index.js';
import type { IntroStatus, Offer, OfferInput, OfferStats, PricingSettings } from '../index.js';

const paise = (v: bigint): number => Number(v);
const defined = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

async function actorOf(ctx: Ctx) {
  const actor = requireActor(ctx);
  const platformStaff = actor.client === 'portal' && (await ctx.loaders.platformRole.load(actor.userId)) !== null;
  return { userId: actor.userId, platformStaff };
}

const FundedByEnum = builder.enumType('OfferFundedBy', {
  description: 'VENUE — the venue gives it and it comes out of the venue’s share. PLATFORM — PL4Y gives it; the venue is paid in full.',
  values: { VENUE: { value: 'venue' }, PLATFORM: { value: 'platform' } } as const,
});

const OfferKindEnum = builder.enumType('OfferKind', {
  values: { PERCENT: { value: 'percent' }, FLAT: { value: 'flat' } } as const,
});

const PlatformBaseEnum = builder.enumType('PlatformDiscountBase', {
  description: 'What PL4Y’s percentage is taken of: the price AFTER_VENUE discount, or the ORIGINAL price.',
  values: { AFTER_VENUE: { value: 'after_venue' }, ORIGINAL: { value: 'original' } } as const,
});

/** An offer, and (for the venue's people and PL4Y staff) how often it was used. */
type OfferView = Offer & { stats?: OfferStats | null };

const OfferStatsRef = builder.objectRef<OfferStats>('OfferStats').implement({
  fields: (t) => ({
    redeemed: t.exposeInt('redeemed', { description: 'Paid bookings that used it.' }),
    reserved: t.exposeInt('reserved', { description: 'Bookings holding it now: held, or to pay at the venue.' }),
    players: t.exposeInt('players', { description: 'Different players who redeemed it.' }),
    discountPaise: t.int({ description: 'What it has taken off paid bookings.', resolve: (s) => paise(s.discountPaise) }),
  }),
});

const OfferRef = builder.objectRef<OfferView>('Offer').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    fundedBy: t.field({ type: FundedByEnum, resolve: (o) => o.fundedBy }),
    venue: t.field({ type: VenueRef, nullable: true, resolve: (o) => (o.venueId ? venues.byId(o.venueId) : null) }),
    title: t.exposeString('title'),
    description: t.string({ nullable: true, resolve: (o) => o.description }),
    summary: t.string({ description: '"20% off up to ₹100 for 60 minutes or longer"', resolve: (o) => offerSummary(o) }),
    kind: t.field({ type: OfferKindEnum, resolve: (o) => o.kind }),
    percentBps: t.exposeInt('percentBps'),
    flatPaise: t.int({ resolve: (o) => paise(o.flatPaise) }),
    maxDiscountPaise: t.int({ nullable: true, resolve: (o) => (o.maxDiscountPaise === null ? null : paise(o.maxDiscountPaise)) }),
    minAmountPaise: t.int({ resolve: (o) => paise(o.minAmountPaise) }),
    minMinutes: t.exposeInt('minMinutes'),
    weekdays: t.intList({ description: '0 = Monday … 6 = Sunday. Empty: every day.', resolve: (o) => o.weekdays }),
    timeFromMinute: t.int({ nullable: true, resolve: (o) => o.timeFromMin }),
    timeToMinute: t.int({ nullable: true, resolve: (o) => o.timeToMin }),
    firstBookingOnly: t.exposeBoolean('firstBookingOnly'),
    startsAt: t.field({ type: 'DateTime', resolve: (o) => o.startsAt }),
    endsAt: t.field({ type: 'DateTime', nullable: true, resolve: (o) => o.endsAt }),
    usageLimit: t.int({ nullable: true, resolve: (o) => o.usageLimit }),
    perUserLimit: t.int({ nullable: true, resolve: (o) => o.perUserLimit }),
    active: t.exposeBoolean('active'),
    stats: t.field({ type: OfferStatsRef, nullable: true, description: 'The venue’s people and PL4Y staff only.', resolve: (o) => o.stats ?? null }),
  }),
});

const IntroRef = builder.objectRef<IntroStatus>('VenueCommission').implement({
  description: 'The venue’s commission and its introductory period (0% for the first 30 days at launch).',
  fields: (t) => ({
    active: t.exposeBoolean('active'),
    startsAt: t.field({ type: 'DateTime', nullable: true, resolve: (i) => i.startsAt }),
    endsAt: t.field({ type: 'DateTime', nullable: true, resolve: (i) => i.endsAt }),
    daysLeft: t.exposeInt('daysLeft'),
    introCommissionBps: t.exposeInt('introCommissionBps'),
    commissionBpsAfter: t.exposeInt('commissionBpsAfter'),
    currentCommissionBps: t.exposeInt('currentCommissionBps'),
    message: t.string({ nullable: true, resolve: (i) => i.message }),
  }),
});

const SettingsRef = builder.objectRef<PricingSettings>('PricingSettings').implement({
  fields: (t) => ({
    bookingCommissionBps: t.exposeInt('bookingCommissionBps'),
    venuePayCommissionBps: t.exposeInt('venuePayCommissionBps'),
    introEnabled: t.exposeBoolean('introEnabled'),
    introDays: t.exposeInt('introDays'),
    introCommissionBps: t.exposeInt('introCommissionBps'),
    launchedAt: t.field({ type: 'DateTime', resolve: (s) => s.launchedAt }),
    allowStacking: t.exposeBoolean('allowStacking'),
    platformDiscountBase: t.field({ type: PlatformBaseEnum, resolve: (s) => s.platformDiscountBase }),
    maxDiscountBps: t.exposeInt('maxDiscountBps'),
    rewardsWithPromos: t.exposeBoolean('rewardsWithPromos'),
    updatedAt: t.field({ type: 'DateTime', resolve: (s) => s.updatedAt }),
  }),
});

interface TermsView {
  venueId: string;
  introStartsAt: Date;
  introEndsAt: Date;
  commissionBpsOverride: number | null;
  note: string | null;
}

const TermsRef = builder.objectRef<TermsView>('VenueCommercialTerms').implement({
  fields: (t) => ({
    venue: t.field({ type: VenueRef, resolve: (x) => venues.byId(x.venueId) }),
    introStartsAt: t.field({ type: 'DateTime', resolve: (x) => x.introStartsAt }),
    introEndsAt: t.field({ type: 'DateTime', resolve: (x) => x.introEndsAt }),
    commissionBpsOverride: t.int({ nullable: true, resolve: (x) => x.commissionBpsOverride }),
    note: t.string({ nullable: true, resolve: (x) => x.note }),
  }),
});

const OfferInputRef = builder.inputType('OfferInput', {
  fields: (t) => ({
    title: t.string({ required: true }),
    description: t.string(),
    kind: t.field({ type: OfferKindEnum, required: true }),
    percentBps: t.int({ description: '100 = 1%. PERCENT only.' }),
    flatPaise: t.int({ description: 'FLAT only.' }),
    maxDiscountPaise: t.int({ description: 'PERCENT only: the most one booking gets off.' }),
    minAmountPaise: t.int({ description: 'Minimum booking value (the original price).' }),
    minMinutes: t.int({ description: 'Minimum booking duration.' }),
    weekdays: t.intList({ description: '0 = Monday … 6 = Sunday. Empty: every day (weekends: [5, 6]).' }),
    timeFromMinute: t.int({ description: 'Time-slot offers: the booking must start at or after this (minutes after midnight)…' }),
    timeToMinute: t.int({ description: '…and end by this.' }),
    firstBookingOnly: t.boolean({ description: 'First-time customers only.' }),
    startsAt: t.field({ type: 'DateTime' }),
    endsAt: t.field({ type: 'DateTime', description: 'Limited-period offers end here. Absent: until switched off.' }),
    usageLimit: t.int({ description: 'Uses in all. Absent: unlimited.' }),
    perUserLimit: t.int({ description: 'Uses per player. Absent: unlimited.' }),
    active: t.boolean(),
  }),
});

function toInput(i: typeof OfferInputRef.$inferInput): OfferInput {
  return {
    title: i.title,
    description: i.description ?? null,
    kind: i.kind,
    percentBps: i.percentBps ?? null,
    flatPaise: i.flatPaise == null ? null : BigInt(i.flatPaise),
    maxDiscountPaise: i.maxDiscountPaise == null ? null : BigInt(i.maxDiscountPaise),
    minAmountPaise: i.minAmountPaise == null ? null : BigInt(i.minAmountPaise),
    minMinutes: i.minMinutes ?? null,
    weekdays: i.weekdays ?? null,
    timeFromMin: i.timeFromMinute ?? null,
    timeToMin: i.timeToMinute ?? null,
    firstBookingOnly: i.firstBookingOnly ?? null,
    startsAt: i.startsAt ?? null,
    endsAt: i.endsAt ?? null,
    usageLimit: i.usageLimit ?? null,
    perUserLimit: i.perUserLimit ?? null,
    active: i.active ?? null,
  };
}

const SettingsInput = builder.inputType('PricingSettingsInput', {
  fields: (t) => ({
    bookingCommissionBps: t.int(),
    venuePayCommissionBps: t.int(),
    introEnabled: t.boolean(),
    introDays: t.int(),
    introCommissionBps: t.int(),
    allowStacking: t.boolean(),
    platformDiscountBase: t.field({ type: PlatformBaseEnum }),
    maxDiscountBps: t.int(),
    rewardsWithPromos: t.boolean(),
  }),
});

const TermsInput = builder.inputType('VenueCommercialTermsInput', {
  fields: (t) => ({
    introStartsAt: t.field({ type: 'DateTime' }),
    introEndsAt: t.field({ type: 'DateTime' }),
    commissionBpsOverride: t.int({ description: 'This venue’s own rate. Use clearOverride to go back to the default.' }),
    clearOverride: t.boolean(),
    note: t.string(),
  }),
});

const OfferPayload = builder.objectRef<{ offer: OfferView | null; userError: UserErrorShape | null }>('OfferPayload').implement({
  fields: (t) => ({
    offer: t.field({ type: OfferRef, nullable: true, resolve: (p) => p.offer }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});

const SettingsPayload = builder
  .objectRef<{ settings: PricingSettings | null; userError: UserErrorShape | null }>('PricingSettingsPayload')
  .implement({
    fields: (t) => ({
      settings: t.field({ type: SettingsRef, nullable: true, resolve: (p) => p.settings }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const TermsPayload = builder.objectRef<{ terms: TermsView | null; userError: UserErrorShape | null }>('VenueCommercialTermsPayload').implement({
  fields: (t) => ({
    terms: t.field({ type: TermsRef, nullable: true, resolve: (p) => p.terms }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});

async function withStats(offers: Offer[]): Promise<OfferView[]> {
  const stats = await pricing.stats(offers.map((o) => o.id));
  return offers.map((o) => ({ ...o, stats: stats.get(o.id) ?? null }));
}

builder.queryFields((t) => ({
  offersAtVenue: t.field({
    type: [OfferRef],
    description: 'Offers a player can get at this venue now: the venue’s own and PL4Y’s.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: (_root, args) => pricing.liveOffersAt(String(args.venueId)),
  }),
  venueOffers: t.field({
    type: [OfferRef],
    description: 'The venue dashboard: every offer the venue has made, with how often each was used. Managers and owners.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => withStats(await pricing.venueOffers(await actorOf(ctx), String(args.venueId))),
  }),
  venueCommission: t.field({
    type: IntroRef,
    description: 'The venue dashboard’s commission line and introductory banner. Managers and owners.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const venueId = String(args.venueId);
      const { bookings } = await import('../../bookings/index.js');
      const role = await bookings.roleAt(actor, venueId);
      if (!role || role === 'desk') {
        const { forbidden } = await import('../../../platform/errors/index.js');
        throw forbidden();
      }
      return pricing.introStatus(venueId);
    },
  }),
  pricingSettings: t.field({
    type: SettingsRef,
    description: 'Portal — commission, the introductory period and discount stacking.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return pricing.settings();
    },
  }),
  platformOffers: t.field({
    type: [OfferRef],
    description: 'Portal — PL4Y’s own offers, with how often each was used.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return withStats(await pricing.platformOffers());
    },
  }),
  venueCommercialTerms: t.field({
    type: TermsRef,
    nullable: true,
    description: 'Portal — a venue’s introductory period and rate. Null until the venue first takes money through PL4Y.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const venueId = String(args.venueId);
      const terms = await pricing.terms(venueId);
      return terms ? { venueId, ...terms } : null;
    },
  }),
}));

builder.mutationFields((t) => ({
  saveVenueOffer: t.field({
    type: OfferPayload,
    description: 'The venue dashboard: create (no id) or change an offer the venue pays for. Managers and owners.',
    args: { venueId: t.arg.id({ required: true }), id: t.arg.id(), input: t.arg({ type: OfferInputRef, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const { data, userError } = await attempt(async () =>
        (await withStats([await pricing.saveVenueOffer(actor, String(args.venueId), { ...toInput(args.input), id: args.id ? String(args.id) : null })]))[0]!,
      );
      return { offer: data, userError };
    },
  }),
  setVenueOfferActive: t.field({
    type: OfferPayload,
    description: 'The venue dashboard: switch an offer on or off.',
    args: { offerId: t.arg.id({ required: true }), active: t.arg.boolean({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const { data, userError } = await attempt(async () => (await withStats([await pricing.setVenueOfferActive(actor, String(args.offerId), args.active)]))[0]!);
      return { offer: data, userError };
    },
  }),
  updatePricingSettings: t.field({
    type: SettingsPayload,
    description: 'Portal — change commission, the introductory period or stacking. Admin and finance. Applies to bookings made from now on.',
    args: { input: t.arg({ type: SettingsInput, required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const i = args.input;
      const patch = {
        bookingCommissionBps: defined(i.bookingCommissionBps),
        venuePayCommissionBps: defined(i.venuePayCommissionBps),
        introEnabled: defined(i.introEnabled),
        introDays: defined(i.introDays),
        introCommissionBps: defined(i.introCommissionBps),
        allowStacking: defined(i.allowStacking),
        platformDiscountBase: defined(i.platformDiscountBase),
        maxDiscountBps: defined(i.maxDiscountBps),
        rewardsWithPromos: defined(i.rewardsWithPromos),
      };
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'pricing_settings.update', targetType: 'pricing_settings', targetId: '1', details: { ...i } }, args.reason, () =>
          pricing.updateSettings(staff.userId, patch),
        ),
      );
      return { settings: data, userError };
    },
  }),
  savePlatformOffer: t.field({
    type: OfferPayload,
    description: 'Portal — create (no id) or change a PL4Y-funded offer; venueId null applies at every venue. Admin and finance.',
    args: { id: t.arg.id(), venueId: t.arg.id(), input: t.arg({ type: OfferInputRef, required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const { data, userError } = await attempt(async () =>
        audited(
          staff,
          { action: args.id ? 'platform_offer.update' : 'platform_offer.create', targetType: 'offer', targetId: args.id ? String(args.id) : 'new', details: { ...args.input } },
          args.reason,
          async () =>
            (
              await withStats([
                await pricing.savePlatformOffer(staff.userId, {
                  ...toInput(args.input),
                  id: args.id ? String(args.id) : null,
                  venueId: args.venueId ? String(args.venueId) : null,
                }),
              ])
            )[0]!,
        ),
      );
      return { offer: data, userError };
    },
  }),
  setVenueCommercialTerms: t.field({
    type: TermsPayload,
    description: 'Portal — move a venue’s introductory period or give it its own commission. Admin and finance.',
    args: { venueId: t.arg.id({ required: true }), input: t.arg({ type: TermsInput, required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const venueId = String(args.venueId);
      const i = args.input;
      const { data, userError } = await attempt(async () =>
        audited(staff, { action: 'venue_terms.update', targetType: 'venue', targetId: venueId, details: { ...i } }, args.reason, async () => {
          const terms = await pricing.setTerms(staff.userId, venueId, {
            introStartsAt: i.introStartsAt ?? null,
            introEndsAt: i.introEndsAt ?? null,
            commissionBpsOverride: i.commissionBpsOverride ?? null,
            clearOverride: i.clearOverride ?? false,
            note: i.note === undefined ? undefined : i.note,
          });
          return terms ? { venueId, ...terms } : null;
        }),
      );
      return { terms: data, userError };
    },
  }),
}));
