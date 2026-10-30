/**
 * pay at venue — GraphQL surface (docs/plans/2026-10-30-feature-brief.md).
 *
 * The player's side: the venue page's offer, the breakdown before paying,
 * starting and paying, their receipt. The venue's side: hourly rates and the
 * payments dashboard in the venue desk. PL4Y's side: switching it on, every
 * payment, refunds and the monthly payouts.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { payments, payouts } from '../../payments/index.js';
import { CreatePaymentOrderPayload, RefreshPaymentPayload } from '../../payments/schema/index.js';
import { PayoutAccountRef } from '../../payments/schema/payouts.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { rewards } from '../../rewards/index.js';
import { VenueRef } from '../../venues/schema/index.js';
import { MINUTES_MAX, MINUTES_MIN, MINUTES_STEP, venuePay, venuePayouts } from '../index.js';
import type { Offer, Rate, VenuePayment, VenuePayout } from '../index.js';

const paise = (v: bigint): number => Number(v);

async function actorOf(ctx: Ctx) {
  const actor = requireActor(ctx);
  const platformStaff = actor.client === 'portal' && (await ctx.loaders.platformRole.load(actor.userId)) !== null;
  return { userId: actor.userId, platformStaff };
}

const StatusEnum = builder.enumType('VenuePaymentStatus', {
  values: {
    HELD: { value: 'held' },
    PAID: { value: 'paid' },
    EXPIRED: { value: 'expired' },
    FAILED: { value: 'failed' },
    REFUNDED: { value: 'refunded' },
  } as const,
});

const RateRef = builder.objectRef<Rate>('VenuePayRate').implement({
  description: 'An hourly rate for one activity or resource at a venue.',
  fields: (t) => ({
    id: t.exposeID('id'),
    label: t.exposeString('label'),
    sportId: t.exposeID('sportId', { nullable: true }),
    ratePerHourPaise: t.int({ resolve: (r) => paise(r.ratePerHourPaise) }),
    active: t.exposeBoolean('active'),
    position: t.exposeInt('position'),
  }),
});

const OfferRef = builder.objectRef<Offer>('PayAtVenueOffer').implement({
  fields: (t) => ({
    available: t.exposeBoolean('available', { description: 'Show the Pay at venue button.' }),
    reason: t.exposeString('reason', {
      nullable: true,
      description: 'Why not, for the owner: not_enabled (PL4Y has not switched it on) | no_rates | payout_account (not verified).',
    }),
    enabled: t.exposeBoolean('enabled', { description: 'PL4Y has switched it on for this venue.' }),
    rates: t.field({ type: [RateRef], resolve: (o) => o.rates }),
    minMinutes: t.int({ resolve: () => MINUTES_MIN }),
    maxMinutes: t.int({ resolve: () => MINUTES_MAX }),
    stepMinutes: t.int({ resolve: () => MINUTES_STEP }),
  }),
});

const VenuePaymentRef = builder.objectRef<VenuePayment>('VenuePayment').implement({
  description: 'One stretch of play paid for at a venue.',
  fields: (t) => ({
    id: t.exposeID('id'),
    venueId: t.exposeID('venueId'),
    venueName: t.exposeString('venueName'),
    label: t.exposeString('label'),
    minutes: t.exposeInt('minutes'),
    ratePerHourPaise: t.int({ resolve: (p) => paise(p.ratePerHourPaise) }),
    amountPaise: t.int({ description: 'The price of the time. The venue is paid on this.', resolve: (p) => paise(p.amountPaise) }),
    discountPaise: t.int({
      description: 'PL4Y’s reward discount on it, once paid.',
      resolve: async (p) => paise((await venuePay.paymentFacts([p.id])).get(p.id)?.discountPaise ?? 0n),
    }),
    paidPaise: t.int({
      description: 'What the player paid: amount − discount.',
      resolve: async (p) => paise(p.amountPaise - ((await venuePay.paymentFacts([p.id])).get(p.id)?.discountPaise ?? 0n)),
    }),
    reference: t.string({
      nullable: true,
      description: 'The gateway’s payment id: what support and the venue quote.',
      resolve: async (p) => (await venuePay.paymentFacts([p.id])).get(p.id)?.reference ?? null,
    }),
    method: t.string({ nullable: true, resolve: async (p) => (await venuePay.paymentFacts([p.id])).get(p.id)?.method ?? null }),
    status: t.field({ type: StatusEnum, resolve: (p) => p.status }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.paidAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (p) => p.createdAt }),
    player: t.field({ type: PlayerProfileRef, nullable: true, resolve: (p, _args, ctx) => ctx.loaders.publicProfileByUser.load(p.userId) }),
  }),
});

const QuoteRef = builder
  .objectRef<{ minutes: number; ratePerHourPaise: bigint; amountPaise: bigint; label: string; discountPaise: bigint; discountLabel: string | null }>(
    'VenuePayQuote',
  )
  .implement({
    description: 'The breakdown shown before paying: duration, rate, amount, PL4Y’s reward, total.',
    fields: (t) => ({
      label: t.exposeString('label'),
      minutes: t.exposeInt('minutes'),
      ratePerHourPaise: t.int({ resolve: (q) => paise(q.ratePerHourPaise) }),
      amountPaise: t.int({ resolve: (q) => paise(q.amountPaise) }),
      discountPaise: t.int({ resolve: (q) => paise(q.discountPaise) }),
      discountLabel: t.exposeString('discountLabel', { nullable: true }),
      totalPaise: t.int({ resolve: (q) => paise(q.amountPaise - q.discountPaise) }),
    }),
  });

builder.objectFields(VenueRef, (t) => ({
  payAtVenue: t.field({
    type: OfferRef,
    description: 'Pay at venue: whether the button shows, and the activities with their hourly rates.',
    resolve: (v) => venuePay.offer(v.id),
  }),
}));

builder.queryFields((t) => ({
  venuePayQuote: t.field({
    type: QuoteRef,
    args: { venueId: t.arg.id({ required: true }), rateId: t.arg.id({ required: true }), minutes: t.arg.int({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const q = await venuePay.quote(String(args.venueId), String(args.rateId), args.minutes);
      const d = await rewards.discountFor(actor.userId, q.amountPaise);
      return { ...q, discountPaise: d.discountPaise, discountLabel: d.label };
    },
  }),
  venuePayment: t.field({
    type: VenuePaymentRef,
    nullable: true,
    description: 'The player’s own, or one at a venue this person runs.',
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => venuePay.forViewer(await actorOf(ctx), String(args.id)),
  }),
  myVenuePayments: t.field({
    type: [VenuePaymentRef],
    args: { first: t.arg.int({ defaultValue: 30 }) },
    resolve: (_root, args, ctx) => venuePay.mine(requireActor(ctx).userId, args.first ?? 30),
  }),
  venuePaymentsAt: t.field({
    type: [VenuePaymentRef],
    description: 'The operator dashboard: paid and refunded payments at this venue, newest first. Desk staff and up.',
    args: { venueId: t.arg.id({ required: true }), from: t.arg({ type: 'DateTime' }), to: t.arg({ type: 'DateTime' }), first: t.arg.int({ defaultValue: 100 }) },
    resolve: async (_root, args, ctx) =>
      venuePay.forVenue(await actorOf(ctx), String(args.venueId), { from: args.from ?? null, to: args.to ?? null, first: args.first ?? 100 }),
  }),
  venuePaySetup: t.field({
    type: SetupRef,
    description: 'The owner’s setup: every rate (switched-off ones too), why the button is or isn’t showing, and payouts. Managers and up.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const venueId = String(args.venueId);
      await venuePay.requireRole(await actorOf(ctx), venueId, 'manager');
      return { venueId };
    },
  }),
}));

const PayoutStatusEnum = builder.enumType('VenuePayoutStatus', {
  values: { HELD: { value: 'held' }, READY: { value: 'ready' }, PAID: { value: 'paid' } } as const,
});

const VenuePayoutRef = builder.objectRef<VenuePayout>('VenuePayout').implement({
  description: 'One month of pay-at-venue payments for one venue, less PL4Y’s 10%, GST on it and TDS.',
  fields: (t) => ({
    id: t.exposeID('id'),
    venueId: t.exposeID('venueId'),
    venueName: t.exposeString('venueName'),
    period: t.exposeString('period'),
    paymentCount: t.exposeInt('paymentCount'),
    grossPaise: t.int({ resolve: (p) => paise(p.grossPaise) }),
    commissionPaise: t.int({ resolve: (p) => paise(p.commissionPaise) }),
    commissionTaxPaise: t.int({ resolve: (p) => paise(p.commissionTaxPaise) }),
    tdsPaise: t.int({ resolve: (p) => paise(p.tdsPaise) }),
    amountPaise: t.int({ resolve: (p) => paise(p.amountPaise) }),
    status: t.field({ type: PayoutStatusEnum, resolve: (p) => p.status }),
    holdReason: t.exposeString('holdReason', { nullable: true }),
    utr: t.exposeString('utr', { nullable: true }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.paidAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (p) => p.createdAt }),
    owner: t.field({ type: PlayerProfileRef, nullable: true, resolve: (p, _args, ctx) => ctx.loaders.publicProfileByUser.load(p.ownerUserId) }),
    payoutAccount: t.field({
      type: PayoutAccountRef,
      nullable: true,
      description: 'Masked. PL4Y staff only.',
      resolve: async (p, _args, ctx) => {
        await requirePlatformStaff(ctx);
        return p.payoutAccountId ? payouts.accountForPayout(p.payoutAccountId) : null;
      },
    }),
  }),
});

const SetupRef = builder.objectRef<{ venueId: string }>('VenuePaySetup').implement({
  fields: (t) => ({
    offer: t.field({ type: OfferRef, resolve: (s) => venuePay.offer(s.venueId) }),
    rates: t.field({ type: [RateRef], resolve: (s) => venuePay.rates(s.venueId, { includeInactive: true }) }),
    payouts: t.field({ type: [VenuePayoutRef], resolve: (s) => venuePayouts.forVenue(s.venueId) }),
  }),
});

const StartPayload = builder
  .objectRef<{ venuePayment: VenuePayment | null; userError: UserErrorShape | null }>('StartVenuePaymentPayload')
  .implement({
    fields: (t) => ({
      venuePayment: t.field({ type: VenuePaymentRef, nullable: true, resolve: (p) => p.venuePayment }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RatePayload = builder
  .objectRef<{ rate: Rate | null; userError: UserErrorShape | null }>('SaveVenuePayRatePayload')
  .implement({
    fields: (t) => ({
      rate: t.field({ type: RateRef, nullable: true, resolve: (p) => p.rate }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RateInput = builder.inputType('VenuePayRateInput', {
  fields: (t) => ({
    id: t.id({ description: 'Set to change a rate; omit to add one.' }),
    label: t.string({ required: true }),
    sportId: t.id(),
    ratePerHourPaise: t.int({ required: true }),
    active: t.boolean({ defaultValue: true }),
    position: t.int({ defaultValue: 0 }),
  }),
});

builder.mutationFields((t) => ({
  startVenuePayment: t.field({
    type: StartPayload,
    description: 'Freeze the rate and price for this stretch of play. Then createVenuePaymentOrder opens checkout.',
    args: { venueId: t.arg.id({ required: true }), rateId: t.arg.id({ required: true }), minutes: t.arg.int({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        venuePay.start(actor, { venueId: String(args.venueId), rateId: String(args.rateId), minutes: args.minutes }),
      );
      return { venuePayment: data, userError };
    },
  }),
  createVenuePaymentOrder: t.field({
    type: CreatePaymentOrderPayload,
    description: 'payments R20 — the order for a started venue payment. The amount is the one frozen on it.',
    args: { venuePaymentId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => payments.createVenueOrder(actor, String(args.venuePaymentId)));
      return { order: data, userError };
    },
  }),
  refreshVenuePayment: t.field({
    type: RefreshPaymentPayload,
    args: { venuePaymentId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => payments.refreshVenuePayment(actor, String(args.venuePaymentId)));
      return { settled: data?.settled ?? false, userError };
    },
  }),
  saveVenuePayRate: t.field({
    type: RatePayload,
    description: 'Owners and managers add or change an hourly rate. Switch a rate off with active: false.',
    args: { venueId: t.arg.id({ required: true }), input: t.arg({ type: RateInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        venuePay.saveRate(actor, String(args.venueId), {
          id: i.id ? String(i.id) : null,
          label: i.label,
          sportId: i.sportId ? String(i.sportId) : null,
          ratePerHourPaise: BigInt(i.ratePerHourPaise),
          active: i.active ?? true,
          position: i.position ?? 0,
        }),
      );
      return { rate: data, userError };
    },
  }),
}));

// --- PL4Y staff -------------------------------------------------------------------------

const OfferPayload = builder
  .objectRef<{ offer: Offer | null; userError: UserErrorShape | null }>('SetPayAtVenuePayload')
  .implement({
    fields: (t) => ({
      offer: t.field({ type: OfferRef, nullable: true, resolve: (p) => p.offer }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const VenuePayoutPayload = builder
  .objectRef<{ payout: VenuePayout | null; userError: UserErrorShape | null }>('VenuePayoutPayload')
  .implement({
    fields: (t) => ({
      payout: t.field({ type: VenuePayoutRef, nullable: true, resolve: (p) => p.payout }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RefundPayload = builder
  .objectRef<{ refundId: string | null; userError: UserErrorShape | null }>('VenuePaymentRefundPayload')
  .implement({
    fields: (t) => ({
      refundId: t.exposeID('refundId', { nullable: true }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  adminVenuePayments: t.field({
    type: [VenuePaymentRef],
    description: 'Portal — pay-at-venue payments, newest first, optionally for one venue.',
    args: { venueId: t.arg.id(), first: t.arg.int({ defaultValue: 100 }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return venuePay.forStaff({ venueId: args.venueId ? String(args.venueId) : null, first: args.first ?? 100 });
    },
  }),
  venuePayoutsOpen: t.field({
    type: [VenuePayoutRef],
    description: 'Portal — held and ready venue payouts, oldest first.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return venuePayouts.open();
    },
  }),
}));

builder.mutationFields((t) => ({
  adminSetPayAtVenue: t.field({
    type: OfferPayload,
    description: 'Portal — switch Pay at venue on or off for a venue. Admin and support. The reason goes in the audit log.',
    args: { venueId: t.arg.id({ required: true }), enabled: t.arg.boolean({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const venueId = String(args.venueId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: args.enabled ? 'venue.pay_at_venue_on' : 'venue.pay_at_venue_off', targetType: 'venue', targetId: venueId, details: {} },
          args.reason,
          () => venuePay.setEnabled(venueId, args.enabled),
        ),
      );
      return { offer: data, userError };
    },
  }),
  markVenuePayoutPaid: t.field({
    type: VenuePayoutPayload,
    description: 'Portal — record a READY venue payout as sent. `amountPaise` must be its exact amount. Admin and finance.',
    args: { id: t.arg.id({ required: true }), utr: t.arg.string({ required: true }), amountPaise: t.arg.int({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const id = String(args.id);
      const utr = args.utr.replace(/[\s-]/g, '').toUpperCase();
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: 'venue_payout.mark_paid', targetType: 'venue_payout', targetId: id, details: { utr, amountPaise: args.amountPaise } },
          `Paid by bank transfer, UTR ${utr}`,
          () => venuePayouts.markPaid(staff, id, { utr, amountPaise: BigInt(args.amountPaise) }),
        ),
      );
      return { payout: data, userError };
    },
  }),
  adminRefundVenuePayment: t.field({
    type: RefundPayload,
    description: 'Portal — refund a pay-at-venue payment in full. It leaves any unsent payout. Admin, finance and support.',
    args: { venuePaymentId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx);
      const venuePaymentId = String(args.venuePaymentId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: 'venue_payment.refund', targetType: 'venue_payment', targetId: venuePaymentId, details: {} },
          args.reason,
          (reason) => payments.staffRefundVenuePayment(staff, { venuePaymentId, reason }),
        ),
      );
      return { refundId: data?.id ?? null, userError };
    },
  }),
}));
