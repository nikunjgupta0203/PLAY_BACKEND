/**
 * payments — GraphQL surface (docs/modules/07-payments.md).
 *
 * The webhook is deliberately NOT here. It is `POST /webhooks/payments`,
 * mounted with `express.raw` before `express.json()`, because gateways sign
 * the exact bytes it transmitted (architecture.md §2). A GraphQL mutation would
 * have had its body parsed and re-serialised before we ever saw it, and the
 * signature could never verify.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { SystemError } from '../../../platform/errors/index.js';
import { PriceQuoteRef } from '../../events/schema/index.js';
import { payments } from '../index.js';
import { requireStaff } from './payouts.js';
import { audited } from '../../../graphql/staff.js';
import type { LedgerEntry, OrderHandle, Receipt } from '../index.js';
import type { CheckoutForm } from '../../../platform/paymentGateway.js';

const paise = (v: bigint): number => Number(v);

// --- types -------------------------------------------------------------------

const LedgerEntryRef = builder.objectRef<LedgerEntry>('LedgerEntry').implement({
  description:
    'payments R6 — one row per money movement. Signed: credits positive, debits ' +
    'negative. This, not the payments table, is what reconciles against a ' +
    'gateway settlement report.',
  fields: (t) => ({
    kind: t.exposeString('kind'),
    amountPaise: t.int({ resolve: (e) => paise(e.amountPaise) }),
    createdAt: t.field({ type: 'DateTime', resolve: (e) => e.createdAt }),
  }),
});

const ReceiptRef = builder.objectRef<Receipt>('Receipt').implement({
  description:
    'payments R11 — rendered on demand from `ledger_entries`. There is no PDF, ' +
    'no bucket and no signed file URL: the ledger is already the source of ' +
    'truth, and a stored file would only be a second copy that can disagree.',
  fields: (t) => ({
    registrationId: t.exposeID('registrationId'),
    paymentId: t.exposeID('paymentId'),
    gatewayPaymentId: t.exposeString('gatewayPaymentId'),
    method: t.string({ nullable: true, resolve: (r) => r.method }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.paidAt }),
    lines: t.field({ type: [LedgerEntryRef], resolve: (r) =>
      r.lines.map((l, i) => ({
        id: BigInt(i),
        kind: l.kind,
        amountPaise: l.amountPaise,
        createdAt: r.paidAt ?? new Date(0),
      })),
    }),
    totalPaise: t.int({ resolve: (r) => paise(r.totalPaise) }),
    refundedPaise: t.int({ resolve: (r) => paise(r.refundedPaise) }),
    netPaise: t.int({ resolve: (r) => paise(r.netPaise) }),
    currency: t.exposeString('currency'),
  }),
});

const PaymentRecordRef = builder
  .objectRef<LedgerEntry & { registrationId: string }>('PaymentRecord')
  .implement({
    fields: (t) => ({
      registrationId: t.exposeID('registrationId'),
      status: t.string({ resolve: (p) => p.kind }),
      amountPaise: t.int({ resolve: (p) => paise(p.amountPaise) }),
      at: t.field({ type: 'DateTime', resolve: (p) => p.createdAt }),
    }),
  });

// --- payloads ----------------------------------------------------------------

const CheckoutFieldRef = builder
  .objectRef<{ key: string; value: string }>('CheckoutField')
  .implement({ fields: (t) => ({ key: t.exposeString('key'), value: t.exposeString('value') }) });

const CheckoutFormRef = builder.objectRef<CheckoutForm>('CheckoutForm').implement({
  description:
    'POST these fields, unchanged, to `action`. Signed by the server; the client never computes or checks a hash.',
  fields: (t) => ({
    action: t.exposeString('action'),
    fields: t.field({
      type: [CheckoutFieldRef],
      resolve: (f) => Object.entries(f.fields).map(([key, value]) => ({ key, value })),
    }),
  }),
});

const CreatePaymentOrderPayload = builder
  .objectRef<{ order: OrderHandle | null; userError: UserErrorShape | null }>(
    'CreatePaymentOrderPayload',
  )
  .implement({
    fields: (t) => ({
      gatewayOrderId: t.string({ nullable: true, resolve: (p) => p.order?.gatewayOrderId ?? null }),
      checkoutForm: t.field({ type: CheckoutFormRef, nullable: true, resolve: (p) => p.order?.checkout ?? null }),
      amountPaise: t.int({
        nullable: true,
        resolve: (p) => (p.order ? paise(p.order.amountPaise) : null),
      }),
      /**
       * events R3 — the same quote the confirm screen showed, recomputed
       * server-side here. If these two ever differ, one of them is a bug and
       * the client must not paper over it.
       */
      quote: t.field({ type: PriceQuoteRef, nullable: true, resolve: (p) => p.order?.quote ?? null }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- queries -----------------------------------------------------------------

builder.queryFields((t) => ({
  receipt: t.field({
    type: ReceiptRef,
    args: { paymentId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) =>
      payments.receipt(requireActor(ctx), args.paymentId),
  }),

  registrationLedger: t.field({
    type: [LedgerEntryRef],
    description: 'Every money movement against one registration, oldest first.',
    args: { registrationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      // A ledger is money, so it is readable only by the payer. The receipt
      // check is the same one, and it is the one that owns the rule.
      const { registration } = await import('../../registration/index.js');
      const reg = await registration.byId(args.registrationId);
      if (reg.captainUserId !== actor.userId) {
        throw new SystemError('FORBIDDEN', 'That ledger is not yours.');
      }
      return payments.ledgerFor(args.registrationId);
    },
  }),

  paymentHistory: t.connection(
    {
      type: PaymentRecordRef,
      args: {},
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError(
            'BAD_USER_INPUT',
            'paymentHistory supports forward pagination only',
          );
        }
        const page = await payments.paymentHistory(actor.userId, {
          first: clampFirst(args.first, 20),
          after: args.after ?? null,
        });
        const edges = page.nodes.map((node) => ({
          cursor: Buffer.from(node.registrationId, 'utf8').toString('base64url'),
          node,
        }));
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
    { name: 'PaymentConnection' },
    { name: 'PaymentEdge' },
  ),
}));

// --- mutations ---------------------------------------------------------------

builder.mutationFields((t) => ({
  createPaymentOrder: t.field({
    type: CreatePaymentOrderPayload,
    description:
      'payments R1 — the amount is recomputed from events.priceQuote(). There is ' +
      'deliberately no argument for a client-supplied amount to arrive in.',
    args: { registrationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        payments.createOrder(actor, args.registrationId),
      );
      return { order: data, userError };
    },
  }),

  createBookingPaymentOrder: t.field({
    type: CreatePaymentOrderPayload,
    description:
      'payments R20, bookings R2, R5 — the order for a held court. The amount is the quote frozen on the booking; ' +
      'there is no argument for a client amount.',
    args: { bookingId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => payments.createBookingOrder(actor, String(args.bookingId)));
      return { order: data, userError };
    },
  }),

  refreshBookingPayment: t.field({
    type: RefreshPaymentPayload,
    description: 'bookings R2 — the booking twin of refreshPayment. The webhook is still the truth; this asks the gateway.',
    args: { bookingId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => payments.refreshBookingPayment(actor, String(args.bookingId)));
      return { settled: data?.settled ?? false, userError };
    },
  }),

  refreshPayment: t.field({
    type: RefreshPaymentPayload,
    description:
      'gap #22 — the app calls this while checkout is open. It asks the gateway about the ' +
      'entry’s open orders and applies a capture exactly as the webhook would, so a late ' +
      'webhook costs seconds, not the seat. Captain only.',
    args: { registrationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        payments.refreshPayment(actor, String(args.registrationId)),
      );
      return { settled: data?.settled ?? false, userError };
    },
  }),

  staffRefundRegistration: t.field({
    type: StaffRefundPayload,
    description:
      'gap #33 — PL4Y staff refund one entry by hand, up to what is left of its payment. ' +
      'Admin web only.',
    args: {
      registrationId: t.arg.id({ required: true }),
      amountPaise: t.arg.int({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requireStaff(ctx);
      const registrationId = String(args.registrationId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          {
            action: 'registration.refund',
            targetType: 'registration',
            targetId: registrationId,
            details: { amountPaise: args.amountPaise },
          },
          args.reason,
          (reason) => payments.staffRefund(staff, { registrationId, amountPaise: BigInt(args.amountPaise), reason }),
        ),
      );
      return { refundId: data?.id ?? null, userError };
    },
  }),
}));

const RefreshPaymentPayload = builder
  .objectRef<{ settled: boolean; userError: UserErrorShape | null }>('RefreshPaymentPayload')
  .implement({
    fields: (t) => ({
      settled: t.exposeBoolean('settled'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const StaffRefundPayload = builder
  .objectRef<{ refundId: string | null; userError: UserErrorShape | null }>('StaffRefundPayload')
  .implement({
    fields: (t) => ({
      refundId: t.id({ nullable: true, resolve: (p) => p.refundId }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

export { LedgerEntryRef, ReceiptRef };
import './payouts.js';
