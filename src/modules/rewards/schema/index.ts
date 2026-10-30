/**
 * rewards — GraphQL surface (docs/plans/2026-10-30-feature-brief.md).
 *
 * The player's side: their welcome offer, code, rewards and referrals, a
 * preview of what comes off a payment, and entering a friend's code. The
 * portal's side: the rules, and the referrals a fraud check held.
 */
import { builder } from '../../../graphql/builder.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { referralLink, rewards } from '../index.js';
import type { Referral, ReferralStatus, Reward, RewardSettings, WelcomeOffer } from '../index.js';

const paise = (v: bigint): number => Number(v);

const RewardKindEnum = builder.enumType('RewardKind', {
  values: { FIRST_PAYMENT: { value: 'first_payment' }, REFERRAL: { value: 'referral' } } as const,
});

const RewardStatusEnum = builder.enumType('RewardStatus', {
  description: 'AVAILABLE — counts on the next payment. USED — spent on a payment. EXPIRED, VOID — never counts.',
  values: { AVAILABLE: { value: 'available' }, USED: { value: 'used' }, EXPIRED: { value: 'expired' }, VOID: { value: 'void' } } as const,
});

const ReferralStatusEnum = builder.enumType('ReferralStatus', {
  description: 'PENDING — waiting for the friend’s first payment. CONVERTED — reward issued. HELD — PL4Y is checking it. REJECTED.',
  values: {
    PENDING: { value: 'pending' },
    CONVERTED: { value: 'converted' },
    HELD: { value: 'held' },
    REJECTED: { value: 'rejected' },
  } as const,
});

const RewardRef = builder.objectRef<Reward>('Reward').implement({
  description: 'A discount the player holds. Funded by PL4Y; the seller is paid in full.',
  fields: (t) => ({
    id: t.exposeID('id'),
    kind: t.field({ type: RewardKindEnum, resolve: (r) => r.kind }),
    status: t.field({ type: RewardStatusEnum, resolve: (r) => r.status }),
    percentBps: t.exposeInt('percentBps', { description: '1000 = 10%.' }),
    capPaise: t.int({ resolve: (r) => paise(r.capPaise) }),
    expiresAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.expiresAt }),
    usedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.usedAt }),
    discountPaise: t.int({ nullable: true, description: 'What it took off, once used.', resolve: (r) => (r.discountPaise === null ? null : paise(r.discountPaise)) }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
  }),
});

const ReferralRef = builder.objectRef<Referral>('Referral').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    status: t.field({ type: ReferralStatusEnum, resolve: (r) => r.status }),
    holdReason: t.exposeString('holdReason', { nullable: true, description: 'shared_phone | monthly_cap | referrer_inactive | referrals_off' }),
    code: t.exposeString('code'),
    convertedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.convertedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    friend: t.field({
      type: PlayerProfileRef,
      nullable: true,
      description: 'The player who was referred.',
      resolve: (r, _args, ctx) => ctx.loaders.publicProfileByUser.load(r.referredId),
    }),
    referrer: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (r, _args, ctx) => ctx.loaders.publicProfileByUser.load(r.referrerId),
    }),
  }),
});

const WelcomeOfferRef = builder.objectRef<WelcomeOffer>('WelcomeOffer').implement({
  description: 'The first-payment discount. `available` is false once spent, or for a player who had already paid.',
  fields: (t) => ({
    available: t.exposeBoolean('available'),
    percentBps: t.exposeInt('percentBps'),
    capPaise: t.int({ resolve: (o) => paise(o.capPaise) }),
    minOrderPaise: t.int({ resolve: (o) => paise(o.minOrderPaise) }),
  }),
});

interface MyRewards {
  userId: string;
}

const MyRewardsRef = builder.objectRef<MyRewards>('MyRewards').implement({
  description: 'Everything on the Rewards screen.',
  fields: (t) => ({
    welcomeOffer: t.field({ type: WelcomeOfferRef, resolve: (m) => rewards.welcomeOffer(m.userId) }),
    referralCode: t.string({ resolve: (m) => rewards.codeFor(m.userId) }),
    referralLink: t.string({ resolve: async (m) => referralLink(await rewards.codeFor(m.userId)) }),
    rewards: t.field({ type: [RewardRef], resolve: (m) => rewards.rewardsFor(m.userId) }),
    referrals: t.field({ type: [ReferralRef], description: 'Friends this player referred, newest first.', resolve: (m) => rewards.referralsBy(m.userId) }),
    referredBy: t.field({
      type: ReferralRef,
      nullable: true,
      description: 'The code this player entered, if any.',
      resolve: (m) => rewards.referralOf(m.userId),
    }),
    canEnterCode: t.boolean({ description: 'Inside the window after joining, before the first payment, no code yet.', resolve: (m) => rewards.canEnterCode(m.userId) }),
  }),
});

const DiscountPreviewRef = builder
  .objectRef<{ grossPaise: bigint; discountPaise: bigint; label: string | null }>('DiscountPreview')
  .implement({
    description: 'What PL4Y takes off a payment of this amount for this player, before checkout.',
    fields: (t) => ({
      grossPaise: t.int({ resolve: (d) => paise(d.grossPaise) }),
      discountPaise: t.int({ resolve: (d) => paise(d.discountPaise) }),
      totalPaise: t.int({ resolve: (d) => paise(d.grossPaise - d.discountPaise) }),
      label: t.exposeString('label', { nullable: true }),
    }),
  });

builder.queryFields((t) => ({
  myRewards: t.field({
    type: MyRewardsRef,
    resolve: (_root, _args, ctx) => ({ userId: requireActor(ctx).userId }),
  }),
  rewardPreview: t.field({
    type: DiscountPreviewRef,
    args: { amountPaise: t.arg.int({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const grossPaise = BigInt(Math.max(0, args.amountPaise));
      const d = await rewards.discountFor(actor.userId, grossPaise);
      return { grossPaise, discountPaise: d.discountPaise, label: d.label };
    },
  }),
}));

const ApplyPayload = builder
  .objectRef<{ referral: Referral | null; userError: UserErrorShape | null }>('ApplyReferralCodePayload')
  .implement({
    fields: (t) => ({
      referral: t.field({ type: ReferralRef, nullable: true, resolve: (p) => p.referral }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  applyReferralCode: t.field({
    type: ApplyPayload,
    description: 'A new player names who sent them. The friend’s reward unlocks on this player’s first payment.',
    args: { code: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => rewards.applyCode(actor, args.code));
      return { referral: data?.referral ?? null, userError };
    },
  }),
}));

// --- PL4Y staff -------------------------------------------------------------------------

const SettingsRef = builder.objectRef<RewardSettings>('RewardSettings').implement({
  description: 'The rules. Changes apply to rewards issued from then on.',
  fields: (t) => ({
    enabled: t.exposeBoolean('enabled', { description: 'Off: no discount is given at all.' }),
    percentBps: t.exposeInt('percentBps'),
    capPaise: t.int({ resolve: (s) => paise(s.capPaise) }),
    minOrderPaise: t.int({ resolve: (s) => paise(s.minOrderPaise) }),
    referralEnabled: t.exposeBoolean('referralEnabled'),
    referralExpiryDays: t.exposeInt('referralExpiryDays'),
    referralMonthlyCap: t.exposeInt('referralMonthlyCap', { description: 'Rewards a referrer can earn in 30 days before the rest are held for review.' }),
    referralWindowDays: t.exposeInt('referralWindowDays', { description: 'Days after joining that a code can still be entered.' }),
    allowStacking: t.exposeBoolean('allowStacking', { description: 'On: the welcome offer and one referral reward can combine on a payment.' }),
    updatedAt: t.field({ type: 'DateTime', resolve: (s) => s.updatedAt }),
  }),
});

const StatsRef = builder
  .objectRef<Awaited<ReturnType<typeof rewards.stats>>>('RewardStats')
  .implement({
    fields: (t) => ({
      firstPaymentUsed: t.exposeInt('firstPaymentUsed'),
      referralsConverted: t.exposeInt('referralsConverted'),
      referralsHeld: t.exposeInt('referralsHeld'),
      discountGivenPaise: t.int({ resolve: (s) => paise(s.discountGivenPaise) }),
    }),
  });

builder.queryFields((t) => ({
  rewardSettings: t.field({
    type: SettingsRef,
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return rewards.settings();
    },
  }),
  rewardStats: t.field({
    type: StatsRef,
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return rewards.stats();
    },
  }),
  adminReferrals: t.field({
    type: [ReferralRef],
    description: 'Portal — referrals, newest first. Filter HELD for the review queue.',
    args: { status: t.arg({ type: ReferralStatusEnum }), first: t.arg.int({ defaultValue: 100 }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return rewards.referralsForStaff((args.status as ReferralStatus | null | undefined) ?? null, args.first ?? 100);
    },
  }),
}));

const SettingsInput = builder.inputType('RewardSettingsInput', {
  fields: (t) => ({
    enabled: t.boolean(),
    percentBps: t.int(),
    capPaise: t.int(),
    minOrderPaise: t.int(),
    referralEnabled: t.boolean(),
    referralExpiryDays: t.int(),
    referralMonthlyCap: t.int(),
    referralWindowDays: t.int(),
    allowStacking: t.boolean(),
  }),
});

const SettingsPayload = builder
  .objectRef<{ settings: RewardSettings | null; userError: UserErrorShape | null }>('RewardSettingsPayload')
  .implement({
    fields: (t) => ({
      settings: t.field({ type: SettingsRef, nullable: true, resolve: (p) => p.settings }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ReviewPayload = builder
  .objectRef<{ referral: Referral | null; userError: UserErrorShape | null }>('ReviewReferralPayload')
  .implement({
    fields: (t) => ({
      referral: t.field({ type: ReferralRef, nullable: true, resolve: (p) => p.referral }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const defined = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

builder.mutationFields((t) => ({
  updateRewardSettings: t.field({
    type: SettingsPayload,
    description: 'Portal — change the reward rules. Admin and finance. The reason goes in the audit log.',
    args: { input: t.arg({ type: SettingsInput, required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const i = args.input;
      const patch = {
        enabled: defined(i.enabled),
        percentBps: defined(i.percentBps),
        capPaise: i.capPaise == null ? undefined : BigInt(i.capPaise),
        minOrderPaise: i.minOrderPaise == null ? undefined : BigInt(i.minOrderPaise),
        referralEnabled: defined(i.referralEnabled),
        referralExpiryDays: defined(i.referralExpiryDays),
        referralMonthlyCap: defined(i.referralMonthlyCap),
        referralWindowDays: defined(i.referralWindowDays),
        allowStacking: defined(i.allowStacking),
      };
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: 'reward_settings.update', targetType: 'reward_settings', targetId: '1', details: { ...i } },
          args.reason,
          () => rewards.updateSettings(staff.userId, patch),
        ),
      );
      return { settings: data, userError };
    },
  }),
  reviewReferral: t.field({
    type: ReviewPayload,
    description: 'Portal — pay out (approve) or turn down a HELD referral. Admin, finance and support.',
    args: { id: t.arg.id({ required: true }), approve: t.arg.boolean({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: args.approve ? 'referral.approve' : 'referral.reject', targetType: 'referral', targetId: id, details: {} },
          args.reason,
          () => rewards.reviewReferral(staff.userId, id, args.approve),
        ),
      );
      return { referral: data, userError };
    },
  }),
}));
