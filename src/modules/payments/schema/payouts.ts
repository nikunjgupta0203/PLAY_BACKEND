/**
 * payouts — GraphQL (spec 2026-10-02-host-payouts). Hosts see their own
 * account, masked, and their payouts. Staff operations are here for the admin
 * web app; the player app never calls them.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import type { Ctx } from '../../../graphql/context.js';
import { SystemError } from '../../../platform/errors/index.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { EventRef } from '../../events/schema/index.js';
import { payouts } from '../index.js';
import type { PayoutAccountView, Staff } from '../index.js';
import type { PayoutAccountDetails, PayoutView } from '../service/payouts.js';

const paise = (v: bigint): number => Number(v);

/** portal R2 — staff, on a portal session. The service decides which roles may act. */
export async function requireStaff(ctx: Ctx): Promise<Staff> {
  return requirePlatformStaff(ctx);
}

const PayoutAccountStatusRef = builder.enumType('PayoutAccountStatus', {
  values: {
    CHECKING: { value: 'checking' },
    VERIFIED: { value: 'verified' },
    NEEDS_REVIEW: { value: 'needs_review' },
    REJECTED: { value: 'rejected' },
    SUSPENDED: { value: 'suspended' },
  } as const,
});

const PayoutStatusRef = builder.enumType('PayoutStatus', {
  values: {
    SCHEDULED: { value: 'scheduled' },
    HELD: { value: 'held' },
    AWAITING_FUNDS: { value: 'awaiting_funds' },
    SENDING: { value: 'sending' },
    PAID: { value: 'paid' },
    FAILED: { value: 'failed' },
  } as const,
});

export const PayoutAccountRef = builder.objectRef<PayoutAccountView>('PayoutAccount').implement({
  description: 'payouts R2 — PAN and account number are only ever masked here.',
  fields: (t) => ({
    id: t.exposeID('id'),
    legalName: t.exposeString('legalName'),
    panMasked: t.exposeString('panMasked'),
    accountMasked: t.exposeString('accountMasked'),
    ifsc: t.exposeString('ifsc'),
    status: t.field({ type: PayoutAccountStatusRef, resolve: (a) => a.status }),
    statusReason: t.string({ nullable: true, resolve: (a) => a.statusReason }),
    bankNameReturned: t.string({ nullable: true, resolve: (a) => a.bankNameReturned }),
    nameMatch: t.int({ nullable: true, resolve: (a) => a.nameMatch }),
    verifiedAt: t.field({ type: 'DateTime', nullable: true, resolve: (a) => a.verifiedAt }),
    detailsChangedAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'gap #25 — when verified details were last replaced. Payouts wait 48 hours after it.',
      resolve: (a) => a.detailsChangedAt,
    }),
  }),
});

const PayoutAccountDetailsRef = builder.objectRef<PayoutAccountDetails>('PayoutAccountDetails').implement({
  description: 'Manual payouts — the clear account number, for staff to check it or send money. Every read is audited.',
  fields: (t) => ({
    id: t.exposeID('id'),
    legalName: t.exposeString('legalName'),
    accountNumber: t.exposeString('accountNumber'),
    ifsc: t.exposeString('ifsc'),
    status: t.field({ type: PayoutAccountStatusRef, resolve: (a) => a.status }),
    detailsChangedAt: t.field({ type: 'DateTime', nullable: true, resolve: (a) => a.detailsChangedAt }),
  }),
});

export const PayoutRef = builder.objectRef<PayoutView>('Payout').implement({
  description: 'payouts R9, R14 — the breakdown is the live quote until the transfer is sent, then frozen.',
  fields: (t) => ({
    id: t.exposeID('id'),
    eventId: t.exposeID('eventId'),
    status: t.field({ type: PayoutStatusRef, resolve: (p) => p.status }),
    holdReason: t.string({ nullable: true, resolve: (p) => p.holdReason }),
    entryFeesPaise: t.int({ resolve: (p) => paise(p.entryFeesPaise) }),
    refundsPaise: t.int({ resolve: (p) => paise(p.refundsPaise) }),
    commissionPaise: t.int({ resolve: (p) => paise(p.commissionPaise) }),
    commissionTaxPaise: t.int({ resolve: (p) => paise(p.commissionTaxPaise) }),
    tdsPaise: t.int({ resolve: (p) => paise(p.tdsPaise) }),
    receivablesPaise: t.int({ resolve: (p) => paise(p.receivablesPaise) }),
    gatewayFeesPaise: t.int({
      description: 'F27 — gateway fees on an event the host cancelled, taken from what they are paid.',
      resolve: (p) => paise(p.gatewayFeesPaise),
    }),
    amountPaise: t.int({ resolve: (p) => paise(p.amountPaise) }),
    dueAt: t.field({ type: 'DateTime', resolve: (p) => p.dueAt }),
    sentAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.sentAt }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.paidAt }),
    lastError: t.string({ nullable: true, resolve: (p) => p.lastError }),
    toPayByHand: t.boolean({
      description: 'Manual payouts — in "Ready to pay": the amount is frozen and a person sends it from PL4Y’s bank.',
      resolve: (p) => p.toPayByHand,
    }),
    utr: t.string({
      nullable: true,
      description: 'Manual payouts — the bank reference (UTR) recorded when it was paid.',
      resolve: (p) => p.utr,
    }),
    payoutAccount: t.field({
      type: PayoutAccountRef,
      nullable: true,
      description: 'The account it goes to, masked.',
      resolve: (p) => payouts.accountForPayout(p.payoutAccountId),
    }),
    event: t.field({
      type: EventRef,
      nullable: true,
      description: 'The event this payout settles (G35; the admin payout list needs its name).',
      resolve: async (p) => {
        const { events } = await import('../../events/index.js');
        return events.findById(p.eventId);
      },
    }),
  }),
});

// payouts R14 — the manage screen's payout line. Registered here so `events`
// does not import `payments`. Money is the host's business: anyone else,
// including a co-manager, reads null.
builder.objectField(EventRef, 'payout', (t) =>
  t.field({
    type: PayoutRef,
    nullable: true,
    resolve: async (event, _args, ctx) => {
      if (!ctx.actor) return null;
      const isHost = event.organizerId === ctx.actor.userId;
      if (!isHost && !(await ctx.loaders.platformRole.load(ctx.actor.userId))) return null;
      return payouts.payoutForEvent(event.id);
    },
  }),
);

const PayoutAccountPayload = builder
  .objectRef<{ account: PayoutAccountView | null; userError: UserErrorShape | null }>('PayoutAccountPayload')
  .implement({
    fields: (t) => ({
      account: t.field({ type: PayoutAccountRef, nullable: true, resolve: (p) => p.account }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PayoutChangeCodePayload = builder
  .objectRef<{ sentTo: string | null; userError: UserErrorShape | null }>('PayoutChangeCodePayload')
  .implement({
    fields: (t) => ({
      sentTo: t.string({ nullable: true, description: 'The masked address the code went to.', resolve: (p) => p.sentTo }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PayoutPayload = builder
  .objectRef<{ payout: PayoutView | null; userError: UserErrorShape | null }>('PayoutPayload')
  .implement({
    fields: (t) => ({
      payout: t.field({ type: PayoutRef, nullable: true, resolve: (p) => p.payout }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PayoutAccountDetailsPayload = builder
  .objectRef<{ details: PayoutAccountDetails | null; userError: UserErrorShape | null }>('PayoutAccountDetailsPayload')
  .implement({
    fields: (t) => ({
      details: t.field({ type: PayoutAccountDetailsRef, nullable: true, resolve: (p) => p.details }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const OpenReceivableRef = builder
  .objectRef<{ payoutAccountId: string; userId: string; openPaise: bigint }>('OpenReceivable')
  .implement({
    fields: (t) => ({
      payoutAccountId: t.exposeID('payoutAccountId'),
      userId: t.exposeID('userId'),
      openPaise: t.int({ resolve: (r) => paise(r.openPaise) }),
      account: t.field({
        type: PayoutAccountRef,
        nullable: true,
        description: 'Whose debt it is, masked.',
        resolve: (r) => payouts.accountForPayout(r.payoutAccountId),
      }),
    }),
  });

const HostRepaymentPayload = builder
  .objectRef<{ openPaise: bigint | null; userError: UserErrorShape | null }>('HostRepaymentPayload')
  .implement({
    fields: (t) => ({
      openPaise: t.int({
        nullable: true,
        description: 'What the host still owes after this repayment.',
        resolve: (p) => (p.openPaise == null ? null : paise(p.openPaise)),
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  myPayoutAccount: t.field({
    type: PayoutAccountRef,
    nullable: true,
    resolve: async (_root, _args, ctx) => payouts.myAccount(requireActor(ctx).userId),
  }),

  myPayouts: t.connection(
    {
      type: PayoutRef,
      args: {},
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'myPayouts supports forward pagination only');
        }
        const after = args.after ? Buffer.from(args.after, 'base64url').toString('utf8') : null;
        const page = await payouts.myPayouts(actor.userId, { first: clampFirst(args.first, 20), after });
        const edges = page.nodes.map((node) => ({ cursor: Buffer.from(node.id, 'utf8').toString('base64url'), node }));
        return {
          edges,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: edges.at(-1)?.cursor ?? null,
          },
        };
      },
    },
    { name: 'PayoutConnection' },
    { name: 'PayoutEdge' },
  ),

  payoutAccountsForReview: t.field({
    type: [PayoutAccountRef],
    resolve: async (_root, _args, ctx) => payouts.accountsForReview(await requireStaff(ctx)),
  }),

  payoutsNeedingAttention: t.field({
    type: [PayoutRef],
    resolve: async (_root, _args, ctx) => payouts.payoutsNeedingAttention(await requireStaff(ctx)),
  }),

  payoutsToPay: t.field({
    type: [PayoutRef],
    description: 'Manual payouts — "Ready to pay": send each from PL4Y’s bank, then markPayoutPaid. Oldest first.',
    resolve: async (_root, _args, ctx) => payouts.payoutsToPay(await requireStaff(ctx)),
  }),

  openReceivables: t.field({
    type: [OpenReceivableRef],
    resolve: async (_root, _args, ctx) => payouts.openReceivables(await requireStaff(ctx)),
  }),
}));

builder.mutationFields((t) => ({
  savePayoutAccount: t.field({
    type: PayoutAccountPayload,
    description:
      'payouts R1 — saves (or replaces) the host bank details and starts the bank check. ' +
      'With `organisationId`, the organisation’s account instead: its owner only (org R6).',
    args: {
      legalName: t.arg.string({ required: true }),
      pan: t.arg.string({ required: true }),
      accountNumber: t.arg.string({ required: true }),
      ifsc: t.arg.string({ required: true }),
      organisationId: t.arg.id(),
      emailCode: t.arg.string({
        description: 'gap #25 — required when replacing details that were already verified. Ask with requestPayoutChangeCode.',
      }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { organisationId, ...details } = args;
      const { data, userError } = await attempt(() =>
        payouts.saveAccount(actor, details, { organisationId: organisationId ? String(organisationId) : null }),
      );
      return { account: data, userError };
    },
  }),

  requestPayoutChangeCode: t.field({
    type: PayoutChangeCodePayload,
    description: 'gap #25 — emails a code that savePayoutAccount needs before verified bank details change.',
    resolve: async (_root, _args, ctx) => {
      const actor = requireActor(ctx);
      const { identity } = await import('../../identity/index.js');
      const { data, userError } = await attempt(() => identity.requestStepUpCode(actor.userId, 'payout_change'));
      return { sentTo: data?.sentTo ?? null, userError };
    },
  }),

  // portal R3 — every one of these takes a reason and is audited.
  approvePayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout_account.approve', targetType: 'payout_account', targetId: id }, args.reason, () =>
          payouts.approveAccount(staff, id),
        ),
      );
      return { account: data, userError };
    },
  }),

  rejectPayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout_account.reject', targetType: 'payout_account', targetId: id }, args.reason, (reason) =>
          payouts.rejectAccount(staff, id, reason),
        ),
      );
      return { account: data, userError };
    },
  }),

  suspendPayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout_account.suspend', targetType: 'payout_account', targetId: id }, args.reason, (reason) =>
          payouts.suspendAccount(staff, id, reason),
        ),
      );
      return { account: data, userError };
    },
  }),

  reinstatePayoutAccount: t.field({
    type: PayoutAccountPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout_account.reinstate', targetType: 'payout_account', targetId: id }, args.reason, () =>
          payouts.reinstateAccount(staff, id),
        ),
      );
      return { account: data, userError };
    },
  }),

  holdPayout: t.field({
    type: PayoutPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout.hold', targetType: 'payout', targetId: id }, args.reason, (reason) =>
          payouts.holdPayout(staff, id, reason),
        ),
      );
      return { payout: data, userError };
    },
  }),

  releasePayout: t.field({
    type: PayoutPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout.release', targetType: 'payout', targetId: id }, args.reason, () =>
          payouts.releasePayout(staff, id),
        ),
      );
      return { payout: data, userError };
    },
  }),

  markPayoutPaid: t.field({
    type: PayoutPayload,
    description:
      'Manual payouts — record a "Ready to pay" payout as sent. `amountPaise` must be its exact amount; ' +
      'the UTR is shown to the host and kept in the audit log.',
    args: {
      id: t.arg.id({ required: true }),
      utr: t.arg.string({ required: true }),
      amountPaise: t.arg.int({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      // As the service stores it, so the audit log and the payout show the same reference.
      const utr = args.utr.replace(/[\s-]/g, '').toUpperCase();
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: 'payout.mark_paid', targetType: 'payout', targetId: id, details: { utr, amountPaise: args.amountPaise } },
          `Paid by bank transfer, UTR ${utr}`,
          () => payouts.markPaid(staff, id, { utr, amountPaise: BigInt(args.amountPaise) }),
        ),
      );
      return { payout: data, userError };
    },
  }),

  recordHostRepayment: t.field({
    type: HostRepaymentPayload,
    description:
      'gap #16 — a host who owes PL4Y (a refund after they were paid) paid it back by bank transfer. ' +
      'Up to what they owe; the UTR goes in the audit log.',
    args: {
      payoutAccountId: t.arg.id({ required: true }),
      amountPaise: t.arg.int({ required: true }),
      utr: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.payoutAccountId);
      const utr = args.utr.replace(/[\s-]/g, '').toUpperCase();
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          {
            action: 'payout_account.repayment',
            targetType: 'payout_account',
            targetId: id,
            details: { utr, amountPaise: args.amountPaise },
          },
          `Host repaid ₹${(args.amountPaise / 100).toFixed(2)}, UTR ${utr}`,
          () => payouts.recordRepayment(staff, id, { amountPaise: BigInt(args.amountPaise), utr }),
        ),
      );
      return { openPaise: data?.openPaise ?? null, userError };
    },
  }),

  revealPayoutAccount: t.field({
    type: PayoutAccountDetailsPayload,
    description: 'Manual payouts — the full account number, for admin and finance. Takes a reason; every look is audited.',
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout_account.reveal', targetType: 'payout_account', targetId: id }, args.reason, () =>
          payouts.accountDetails(staff, id),
        ),
      );
      return { details: data, userError };
    },
  }),

  retryPayout: t.field({
    type: PayoutPayload,
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'payout.retry', targetType: 'payout', targetId: id }, args.reason, () =>
          payouts.retryPayout(staff, id),
        ),
      );
      return { payout: data, userError };
    },
  }),
}));
