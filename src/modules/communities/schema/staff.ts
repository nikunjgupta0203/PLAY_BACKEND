/**
 * communities R10 — creator payouts (the owner's view and PL4Y's) and what
 * PL4Y staff do from the admin portal: hide a community, take a post down.
 */
import { builder } from '../../../graphql/builder.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { UserError } from '../../../platform/errors/index.js';
import { PayoutAccountRef } from '../../payments/schema/payouts.js';
import { payments, payouts } from '../../payments/index.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { communities, communityPayouts } from '../index.js';
import type { Community, CommunityPayment, CommunityPayout } from '../index.js';
import { CommunityRef } from './index.js';

const paise = (v: bigint): number => Number(v);
const isId = (v: string): boolean => /^[0-9a-f-]{36}$/i.test(v);

const PayoutStatusEnum = builder.enumType('CommunityPayoutStatus', {
  description: 'HELD — the owner’s bank account cannot be paid yet (holdReason says why). READY — send it. PAID — sent, with its UTR.',
  values: { HELD: { value: 'held' }, READY: { value: 'ready' }, PAID: { value: 'paid' } } as const,
});

const CommunityPayoutRef = builder.objectRef<CommunityPayout>('CommunityPayout').implement({
  description: 'communities R10 — one month’s memberships for one community, less PL4Y’s 5%, GST on it and TDS.',
  fields: (t) => ({
    id: t.exposeID('id'),
    period: t.exposeString('period', { description: 'YYYY-MM, India time.' }),
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
    communityId: t.exposeID('communityId'),
    communityName: t.exposeString('communityName'),
    owner: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (p, _args, ctx) => ctx.loaders.publicProfileByUser.load(p.ownerUserId),
    }),
    payoutAccount: t.field({
      type: PayoutAccountRef,
      nullable: true,
      description: 'Masked. Staff open the full details with revealPayoutAccount.',
      resolve: async (p, _args, ctx) => {
        await requirePlatformStaff(ctx);
        return p.payoutAccountId ? payouts.accountForPayout(p.payoutAccountId) : null;
      },
    }),
  }),
});

builder.objectFields(CommunityRef, (t) => ({
  payouts: t.field({
    type: [CommunityPayoutRef],
    description: 'communities R10 — monthly payouts, newest first. The owner only; empty for everyone else.',
    resolve: async (c, _args, ctx) =>
      ctx.actor && (await communities.roleOf(c.id, ctx.actor.userId)) === 'owner' ? communityPayouts.forCommunity(c.id) : [],
  }),
}));

// --- PL4Y staff -----------------------------------------------------------------------

builder.queryFields((t) => ({
  communityPayoutsOpen: t.field({
    type: [CommunityPayoutRef],
    description: 'Portal — held and ready community payouts, oldest first. Any staff member reads; admin and finance pay.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return communityPayouts.open();
    },
  }),

  adminCommunities: t.field({
    type: [CommunityRef],
    description: 'Portal — every community, hidden and unlisted ones too, newest first. `search` matches the name.',
    args: { search: t.arg.string(), first: t.arg.int({ defaultValue: 50 }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return communities.searchForStaff(args.search ?? null, args.first ?? 50);
    },
  }),
}));

const PayoutPayload = builder
  .objectRef<{ payout: CommunityPayout | null; userError: UserErrorShape | null }>('CommunityPayoutPayload')
  .implement({
    fields: (t) => ({
      payout: t.field({ type: CommunityPayoutRef, nullable: true, resolve: (p) => p.payout }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const StaffCommunityPayload = builder
  .objectRef<{ community: Community | null; userError: UserErrorShape | null }>('StaffCommunityPayload')
  .implement({
    fields: (t) => ({
      community: t.field({ type: CommunityRef, nullable: true, resolve: (p) => p.community }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  markCommunityPayoutPaid: t.field({
    type: PayoutPayload,
    description:
      'Portal — record a READY community payout as sent from PL4Y’s bank. `amountPaise` must be its exact amount; ' +
      'the owner is told, with the UTR. Admin and finance.',
    args: { id: t.arg.id({ required: true }), utr: t.arg.string({ required: true }), amountPaise: t.arg.int({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const id = String(args.id);
      const utr = args.utr.replace(/[\s-]/g, '').toUpperCase();
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: 'community_payout.mark_paid', targetType: 'community_payout', targetId: id, details: { utr, amountPaise: args.amountPaise } },
          `Paid by bank transfer, UTR ${utr}`,
          () => communityPayouts.markPaid(staff, id, { utr, amountPaise: BigInt(args.amountPaise) }),
        ),
      );
      return { payout: data, userError };
    },
  }),

  adminSetCommunityHidden: t.field({
    type: StaffCommunityPayload,
    description:
      'communities R10 — hide a community (gone from Discover and invite links; members still see it, flagged) or show it again. ' +
      'Admin and support. The reason goes in the audit log.',
    args: {
      communityId: t.arg.id({ required: true }),
      hidden: t.arg.boolean({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const id = String(args.communityId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: args.hidden ? 'community.hide' : 'community.unhide', targetType: 'community', targetId: id },
          args.reason,
          async () => {
            if (!isId(id)) throw new UserError('COMMUNITY_NOT_FOUND', 'No such community.');
            return communities.setHiddenByStaff(id, args.hidden);
          },
        ),
      );
      return { community: data, userError };
    },
  }),

  adminHideCommunityPost: t.field({
    type: StaffCommunityPayload,
    description: 'communities R10 — take one post out of a community’s feed, for everyone. What it said stays in the database.',
    args: { postId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const postId = String(args.postId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'community_post.hide', targetType: 'community_post', targetId: postId }, args.reason, async () => {
          const hidden = isId(postId) ? await communities.hidePostByStaff(postId) : null;
          if (!hidden) throw new UserError('POST_NOT_FOUND', 'That post is already gone.');
          return communities.findById(hidden.communityId);
        }),
      );
      return { community: data, userError };
    },
  }),
}));

// --- staff refunds of a membership payment (R10) ------------------------------------------

const CommunityPaymentRef = builder.objectRef<CommunityPayment>('CommunityPayment').implement({
  description: 'communities R8 — one paid (or refunded) membership period. Staff only.',
  fields: (t) => ({
    id: t.exposeID('id'),
    pricePaise: t.int({ resolve: (p) => paise(p.pricePaise) }),
    commissionPaise: t.int({ resolve: (p) => paise(p.commissionPaise) }),
    billing: t.exposeString('billing'),
    status: t.exposeString('status', { description: 'paid | refunded' }),
    periodStart: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.periodStart }),
    periodEnd: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.periodEnd }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.paidAt }),
    member: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (p, _args, ctx) => ctx.loaders.publicProfileByUser.load(p.userId),
    }),
  }),
});

builder.queryFields((t) => ({
  adminCommunityPayments: t.field({
    type: [CommunityPaymentRef],
    description: 'Portal — a community’s paid and refunded membership payments, newest first.',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const id = String(args.communityId);
      return isId(id) ? communities.paymentsForStaff(id) : [];
    },
  }),
}));

const StaffRefundPayload = builder
  .objectRef<{ refundId: string | null; userError: UserErrorShape | null }>('StaffCommunityRefundPayload')
  .implement({
    fields: (t) => ({
      refundId: t.id({ nullable: true, resolve: (p) => p.refundId }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  adminRefundCommunityPayment: t.field({
    type: StaffRefundPayload,
    description:
      'communities R10 — refund one membership payment in full. The period it bought is void (the member’s paid-until goes back, ' +
      'and the membership ends if that is already past); it comes out of the month’s payout, or finance is told to recover it ' +
      'if that payout was already sent. Admin and finance.',
    args: { communityPaymentId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const id = String(args.communityPaymentId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'community_payment.refund', targetType: 'community_payment', targetId: id }, args.reason, async (reason) => {
          if (!isId(id)) throw new UserError('PAYMENT_NOT_FOUND', 'No such payment.');
          const paid = await communities.refundablePayment(id);
          const refund = await payments.staffRefundCommunityPayment(staff, {
            communityPaymentId: id,
            paymentId: paid.paymentId,
            amountPaise: paid.pricePaise,
            reason,
          });
          const voided = await communities.voidRefundedPeriod(id);
          if (voided?.payoutId) await communityPayouts.dropRefundedPayment(voided.payoutId, id);
          return refund;
        }),
      );
      return { refundId: data?.id ?? null, userError };
    },
  }),
}));

export { CommunityPayoutRef };
