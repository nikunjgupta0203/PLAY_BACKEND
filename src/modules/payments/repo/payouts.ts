/**
 * payouts — queries. The service owns the rules; this owns the SQL shapes,
 * including the one join the quote needs (ledger → registration → category).
 */
import type { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import type { QuoteRow } from '../service/payoutQuote.js';

export type PayoutAccountRow = Prisma.PayoutAccountGetPayload<object>;
export type PayoutRow = Prisma.PayoutGetPayload<object>;
type Conn = Db | Tx;

export function createPayoutsRepo(db: Db) {
  return {
    /** A person's own account. An organisation's account is never theirs, even its owner's (org R6). */
    accountByUser: (userId: string, conn: Conn = db) =>
      conn.payoutAccount.findFirst({ where: { userId, organizerProfileId: null } }),
    accountByOrganisation: (organizerProfileId: string, conn: Conn = db) =>
      conn.payoutAccount.findFirst({ where: { organizerProfileId } }),
    accountById: (id: string, conn: Conn = db) => conn.payoutAccount.findUnique({ where: { id } }),
    accountsInReview: () =>
      db.payoutAccount.findMany({ where: { status: 'needs_review' }, orderBy: { createdAt: 'asc' }, take: 200 }),

    payoutById: (id: string, conn: Conn = db) => conn.payout.findUnique({ where: { id } }),
    payoutByRef: (transferRef: string) => db.payout.findUnique({ where: { transferRef } }),
    payoutForEvent: (eventId: string) => db.payout.findFirst({ where: { eventId } }),
    payoutsForAccount: (payoutAccountId: string, take: number, cursor: string | null) =>
      db.payout.findMany({
        where: { payoutAccountId },
        orderBy: [{ dueAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    duePayouts: (now: Date) =>
      db.payout.findMany({
        where: { status: { in: ['scheduled', 'held', 'awaiting_funds'] }, dueAt: { lte: now } },
        orderBy: { dueAt: 'asc' },
        take: 100,
      }),
    /** Transfers a provider took. A payout staff pay by hand (`manual`) is nobody's to ask about. */
    staleSending: (before: Date) =>
      db.payout.findMany({
        where: {
          status: 'sending',
          sentAt: { lte: before },
          OR: [{ providerStatus: null }, { providerStatus: { not: 'manual' } }],
        },
        take: 100,
      }),
    /** Manual payouts — committed and waiting for a person to send them, oldest first. */
    toPayByHand: () =>
      db.payout.findMany({ where: { status: 'sending', providerStatus: 'manual' }, orderBy: { sentAt: 'asc' }, take: 200 }),
    payoutByUtr: (utr: string) => db.payout.findFirst({ where: { providerStatus: 'manual', providerRef: utr } }),
    heldOrFailed: () =>
      db.payout.findMany({ where: { status: { in: ['held', 'failed', 'awaiting_funds'] } }, orderBy: { dueAt: 'asc' }, take: 200 }),

    /** payouts R9 — every entry-money row for the event, with its category's frozen rate. */
    async quoteRows(eventId: string, conn: Conn = db): Promise<QuoteRow[]> {
      const rows = await conn.$queryRaw<{ registration_id: string; kind: string; amount_paise: bigint; commission_bps: number }[]>`
        SELECT le.registration_id, le.kind, le.amount_paise, ec.commission_bps
          FROM ledger_entries le
          JOIN registrations r ON r.id = le.registration_id
          JOIN event_categories ec ON ec.id = r.event_category_id
         WHERE r.event_id = ${eventId}::uuid
           AND le.kind IN ('charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal', 'gateway_fee')`;
      return rows.map((r) => ({
        registrationId: r.registration_id,
        kind: r.kind,
        amountPaise: r.amount_paise,
        commissionBps: r.commission_bps,
      }));
    },

    /** payouts R15 — receivables written minus receivables recovered, for one account. */
    async openReceivables(payoutAccountId: string, conn: Conn = db): Promise<bigint> {
      const [row] = await conn.$queryRaw<{ open: bigint | null }[]>`
        SELECT SUM(le.amount_paise)::bigint AS open
          FROM ledger_entries le
          JOIN payouts p ON p.id = le.payout_id
         WHERE p.payout_account_id = ${payoutAccountId}::uuid
           AND le.kind IN ('host_receivable', 'receivable_recovered')`;
      return row?.open ?? 0n;
    },

    /** Refunds for this event that payments has decided but the gateway has not settled. */
    async pendingRefundCount(eventId: string, conn: Conn = db): Promise<number> {
      const [row] = await conn.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
          FROM refunds rf
          JOIN payments pm ON pm.id = rf.payment_id
          JOIN payment_orders po ON po.id = pm.payment_order_id
          JOIN registrations r ON r.id = po.registration_id
         WHERE r.event_id = ${eventId}::uuid AND rf.status = 'pending'`;
      return Number(row?.n ?? 0n);
    },

    /**
     * gap #23 — captured payments on the event that have not been refunded in
     * full. On a cancelled event every one of them is a player still owed.
     */
    async unrefundedCaptureCount(eventId: string, conn: Conn = db): Promise<number> {
      const [row] = await conn.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
          FROM payments pm
          JOIN payment_orders po ON po.id = pm.payment_order_id
          JOIN registrations r ON r.id = po.registration_id
         WHERE r.event_id = ${eventId}::uuid
           AND pm.status IN ('captured', 'partially_refunded')
           AND pm.amount_paise > coalesce((SELECT sum(rf.amount_paise) FROM refunds rf
                                            WHERE rf.payment_id = pm.id
                                              AND rf.status IN ('pending', 'processed')), 0)`;
      return Number(row?.n ?? 0n);
    },

    /** The ledger rows a refund wrote: refund, and on a full refund its reversals. */
    refundLedger: (refundId: string) => db.ledgerEntry.findMany({ where: { refundId } }),

    /** Locks one payout for a state change (payments R15: one transfer, ever). */
    async lockPayout(tx: Tx, id: string): Promise<PayoutRow | null> {
      await tx.$queryRaw`SELECT id FROM payouts WHERE id = ${id}::uuid FOR UPDATE`;
      return tx.payout.findUnique({ where: { id } });
    },
  };
}

export type PayoutsRepo = ReturnType<typeof createPayoutsRepo>;
