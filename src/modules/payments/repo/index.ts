/**
 * payments — repository (conventions.md §1).
 *
 * Two queries here carry the module's guarantees:
 *   · `claimWebhookEvent` — the INSERT ... ON CONFLICT DO NOTHING that makes a
 *     duplicate gateway delivery free (payments R3).
 *   · `refundedTotal` — read INSIDE the refund transaction, which is what makes
 *     the `captured − already_refunded` guard hold under concurrency (R8).
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';

export interface PaymentOrderRow {
  id: string;
  /** payments R20 — exactly one of these is set: an entry, or a court booking. */
  registrationId: string | null;
  bookingId: string | null;
  gatewayOrderId: string;
  entryFeePaise: bigint;
  platformFeePaise: bigint;
  taxPaise: bigint;
  amountPaise: bigint;
  currency: string;
  status: string;
  createdAt: Date;
}

export interface PaymentRow {
  id: string;
  paymentOrderId: string;
  gatewayPaymentId: string;
  method: string | null;
  amountPaise: bigint;
  status: string;
  failureReason: string | null;
  capturedAt: Date | null;
}

export interface RefundRow {
  id: string;
  paymentId: string;
  gatewayRefundId: string | null;
  amountPaise: bigint;
  reason: string;
  idempotencyKey: string;
  status: string;
  /** gap #15 — gateway attempts so far. */
  attempts?: number;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerRow {
  id: bigint;
  registrationId: string | null;
  paymentId: string | null;
  refundId: string | null;
  kind: string;
  amountPaise: bigint;
  createdAt: Date;
}

export function createPaymentsRepo(db: Db) {
  // --- webhook idempotency (R3) ----------------------------------------------

  /**
   * payments R3 — claims the gateway event id BEFORE any work happens.
   *
   * `skipDuplicates` compiles to ON CONFLICT DO NOTHING, so a duplicate
   * delivery inserts nothing and reports zero. The caller answers 200 to that
   * and the gateway stops retrying immediately.
   *
   * This runs on the request path, so it is one statement and nothing else.
   */
  async function claimWebhookEvent(input: {
    gatewayEventId: string;
    eventType: string;
    payload: unknown;
  }): Promise<boolean> {
    const { count } = await db.paymentWebhookEvent.createMany({
      data: [
        {
          gatewayEventId: input.gatewayEventId,
          eventType: input.eventType,
          payload: input.payload as object,
        },
      ],
      skipDuplicates: true,
    });
    return count > 0;
  }

  async function webhookEvent(gatewayEventId: string) {
    return db.paymentWebhookEvent.findUnique({ where: { gatewayEventId } });
  }

  async function markWebhookProcessed(gatewayEventId: string): Promise<void> {
    await db.paymentWebhookEvent.update({
      where: { gatewayEventId },
      data: { processedAt: new Date(), attempts: { increment: 1 } },
    });
  }

  async function markWebhookFailed(gatewayEventId: string, error: string): Promise<void> {
    await db.paymentWebhookEvent.update({
      where: { gatewayEventId },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 2000) },
    });
  }

  /** The operations dashboard metric: webhooks received but never applied. */
  async function unprocessedWebhooks(olderThan: Date): Promise<number> {
    return db.paymentWebhookEvent.count({
      where: { processedAt: null, receivedAt: { lt: olderThan } },
    });
  }

  // --- orders ----------------------------------------------------------------

  async function insertOrder(
    row: Omit<PaymentOrderRow, 'createdAt' | 'bookingId' | 'registrationId'> & {
      registrationId?: string | null;
      bookingId?: string | null;
    },
  ): Promise<PaymentOrderRow> {
    return db.paymentOrder.create({
      data: { ...row, registrationId: row.registrationId ?? null, bookingId: row.bookingId ?? null },
    });
  }

  async function orderById(id: string): Promise<PaymentOrderRow | null> {
    return db.paymentOrder.findUnique({ where: { id } });
  }

  async function orderByGatewayId(gatewayOrderId: string): Promise<PaymentOrderRow | null> {
    return db.paymentOrder.findUnique({ where: { gatewayOrderId } });
  }

  /** The live order for a registration, if it already has one. */
  async function openOrderFor(registrationId: string): Promise<PaymentOrderRow | null> {
    return db.paymentOrder.findFirst({
      where: { registrationId, status: { in: ['created', 'attempted'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function ordersFor(registrationId: string): Promise<PaymentOrderRow[]> {
    return db.paymentOrder.findMany({
      where: { registrationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** bookings R2 — the live order for a court booking, if it already has one. */
  async function openOrderForBooking(bookingId: string): Promise<PaymentOrderRow | null> {
    return db.paymentOrder.findFirst({
      where: { bookingId, status: { in: ['created', 'attempted'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function ordersForBooking(bookingId: string): Promise<PaymentOrderRow[]> {
    return db.paymentOrder.findMany({ where: { bookingId }, orderBy: { createdAt: 'desc' } });
  }

  async function setOrderStatus(tx: Tx | Db, orderId: string, status: string): Promise<void> {
    await tx.paymentOrder.update({ where: { id: orderId }, data: { status } });
  }

  /**
   * `failed`, unless a capture already made the order `paid`: one order can
   * carry several attempts, and a failed one's notice may arrive after the
   * attempt that succeeded. True when the order moved.
   */
  async function failOrderUnlessPaid(tx: Tx | Db, orderId: string): Promise<boolean> {
    const { count } = await tx.paymentOrder.updateMany({
      where: { id: orderId, status: { not: 'paid' } },
      data: { status: 'failed' },
    });
    return count === 1;
  }

  // --- payments --------------------------------------------------------------

  /**
   * Idempotent on `gateway_payment_id`, which is unique. A second delivery of
   * the same capture upserts the same row rather than writing a second one.
   */
  async function upsertPayment(
    tx: Tx,
    row: Omit<PaymentRow, 'id'> & { id: string; raw: unknown },
  ): Promise<{ payment: PaymentRow; created: boolean }> {
    const existing = await tx.payment.findUnique({
      where: { gatewayPaymentId: row.gatewayPaymentId },
    });
    if (existing) {
      // A redelivered capture must not undo a refund we already recorded.
      const refunded = existing.status === 'refunded' || existing.status === 'partially_refunded';
      const updated = await tx.payment.update({
        where: { id: existing.id },
        data: {
          status: refunded && row.status === 'captured' ? existing.status : row.status,
          method: row.method,
          failureReason: row.failureReason,
          capturedAt: row.capturedAt,
          raw: row.raw as object,
        },
      });
      return { payment: updated, created: false };
    }
    const created = await tx.payment.create({
      data: {
        id: row.id,
        paymentOrderId: row.paymentOrderId,
        gatewayPaymentId: row.gatewayPaymentId,
        method: row.method,
        amountPaise: row.amountPaise,
        status: row.status,
        failureReason: row.failureReason,
        capturedAt: row.capturedAt,
        raw: row.raw as object,
      },
    });
    return { payment: created, created: true };
  }

  async function paymentById(id: string): Promise<PaymentRow | null> {
    return db.payment.findUnique({ where: { id } });
  }

  async function paymentByGatewayId(gatewayPaymentId: string): Promise<PaymentRow | null> {
    return db.payment.findUnique({ where: { gatewayPaymentId } });
  }

  async function capturedPaymentFor(registrationId: string): Promise<PaymentRow | null> {
    return db.payment.findFirst({
      where: { status: 'captured', paymentOrder: { registrationId } },
      orderBy: { capturedAt: 'desc' },
    });
  }

  async function capturedPaymentForBooking(bookingId: string): Promise<PaymentRow | null> {
    return db.payment.findFirst({
      where: { status: { in: ['captured', 'partially_refunded'] }, paymentOrder: { bookingId } },
      orderBy: { capturedAt: 'desc' },
    });
  }

  async function setPaymentStatus(tx: Tx, paymentId: string, status: string): Promise<void> {
    await tx.payment.update({ where: { id: paymentId }, data: { status } });
  }

  async function paymentsForUser(
    userId: string,
    page: { after?: { createdAt: Date; id: string } | null; limit: number },
  ): Promise<(PaymentRow & { registrationId: string; createdAt: Date })[]> {
    const rows = await db.payment.findMany({
      where: { paymentOrder: { registration: { captainUserId: userId } } },
      include: { paymentOrder: { select: { registrationId: true, createdAt: true } } },
      orderBy: [{ paymentOrder: { createdAt: 'desc' } }, { id: 'desc' }],
      take: page.limit,
      ...(page.after
        ? { skip: 1, cursor: { id: page.after.id } }
        : {}),
    });
    return rows.map((r) => ({
      id: r.id,
      paymentOrderId: r.paymentOrderId,
      gatewayPaymentId: r.gatewayPaymentId,
      method: r.method,
      amountPaise: r.amountPaise,
      status: r.status,
      failureReason: r.failureReason,
      capturedAt: r.capturedAt,
      // The where clause reaches the payment through its registration.
      registrationId: r.paymentOrder.registrationId!,
      createdAt: r.paymentOrder.createdAt,
    }));
  }

  // --- refunds ---------------------------------------------------------------

  /**
   * payments R8 — summed INSIDE the caller's transaction. Read outside one and
   * two concurrent refunds each see the other's absence and both go through.
   */
  async function refundedTotal(tx: Tx, paymentId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT coalesce(sum(amount_paise), 0)::bigint AS total
        FROM refunds
       WHERE payment_id = ${paymentId}::uuid
         AND status IN ('pending', 'processed')
    `;
    return rows[0]?.total ?? 0n;
  }

  async function insertRefund(tx: Tx, row: Omit<RefundRow, 'createdAt'>): Promise<RefundRow> {
    return tx.refund.create({ data: row });
  }

  async function refundByIdempotencyKey(key: string): Promise<RefundRow | null> {
    return db.refund.findUnique({ where: { idempotencyKey: key } });
  }

  async function refundByGatewayId(gatewayRefundId: string): Promise<RefundRow | null> {
    return db.refund.findUnique({ where: { gatewayRefundId } });
  }

  async function refundById(id: string): Promise<RefundRow | null> {
    return db.refund.findUnique({ where: { id } });
  }

  async function updateRefund(
    tx: Tx | Db,
    refundId: string,
    patch: { gatewayRefundId?: string | null; status?: string; processedAt?: Date | null; attempts?: number },
  ): Promise<RefundRow> {
    return tx.refund.update({ where: { id: refundId }, data: patch });
  }

  /** Moves a refund off `pending` exactly once; false when someone else already did. */
  async function markRefundProcessed(tx: Tx, refundId: string, processedAt: Date): Promise<boolean> {
    const { count } = await tx.refund.updateMany({
      where: { id: refundId, status: 'pending' },
      data: { status: 'processed', processedAt },
    });
    return count > 0;
  }

  /**
   * gap #15 — refunds decided but never handed to the gateway: the job that
   * sends them was never queued (a restart between the two steps).
   */
  async function unsentRefunds(olderThan: Date, limit = 100): Promise<RefundRow[]> {
    return db.refund.findMany({
      where: { status: 'pending', gatewayRefundId: null, createdAt: { lt: olderThan } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Every captured payment on an event or one draw, with how much of it has
   * already gone back (gap #2, #21, #34): a cancellation refunds what is left
   * of each, whatever happened to the entry since.
   */
  async function capturedPaymentsIn(scope: { eventId: string } | { categoryId: string }): Promise<
    { paymentId: string; registrationId: string; amountPaise: bigint; refundedPaise: bigint }[]
  > {
    const where =
      'eventId' in scope
        ? Prisma.sql`reg.event_id = ${scope.eventId}::uuid`
        : Prisma.sql`reg.event_category_id = ${scope.categoryId}::uuid`;
    return db.$queryRaw<{ paymentId: string; registrationId: string; amountPaise: bigint; refundedPaise: bigint }[]>`
      SELECT p.id AS "paymentId",
             po.registration_id AS "registrationId",
             p.amount_paise AS "amountPaise",
             coalesce((SELECT sum(r.amount_paise) FROM refunds r
                        WHERE r.payment_id = p.id AND r.status IN ('pending', 'processed')), 0)::bigint
               AS "refundedPaise"
        FROM payments p
        JOIN payment_orders po ON po.id = p.payment_order_id
        JOIN registrations reg ON reg.id = po.registration_id
       WHERE p.status IN ('captured', 'partially_refunded')
         AND ${where}
       ORDER BY p.captured_at, p.id
    `;
  }

  /**
   * gap #21 — the one captured payment that pays for an entry: the earliest
   * (ids are UUIDv7, so time-ordered) that nothing has refunded. Every other
   * live capture on the same entry is a duplicate. A fixed order means two
   * captures checking at once can never both decide to refund themselves.
   */
  async function keeperCapture(subject: string | { bookingId: string }): Promise<string | null> {
    const match =
      typeof subject === 'string'
        ? Prisma.sql`po.registration_id = ${subject}::uuid`
        : Prisma.sql`po.booking_id = ${subject.bookingId}::uuid`;
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM payments p
        JOIN payment_orders po ON po.id = p.payment_order_id
       WHERE ${match}
         AND p.status = 'captured'
         AND NOT EXISTS (SELECT 1 FROM refunds r
                          WHERE r.payment_id = p.id AND r.status IN ('pending', 'processed'))
       ORDER BY p.id
       LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  async function pendingRefunds(limit = 100): Promise<RefundRow[]> {
    return db.refund.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  // --- ledger (R6) -----------------------------------------------------------

  /**
   * payments R6 — every money movement writes a row here, inside the same
   * transaction as the movement. The ledger, not the payments table, is what
   * reconciles against a gateway settlement report.
   */
  async function writeLedger(
    tx: Tx,
    entries: {
      registrationId?: string | null;
      paymentId?: string | null;
      refundId?: string | null;
      kind: string;
      amountPaise: bigint;
    }[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await tx.ledgerEntry.createMany({
      data: entries.map((e) => ({
        registrationId: e.registrationId ?? null,
        paymentId: e.paymentId ?? null,
        refundId: e.refundId ?? null,
        kind: e.kind,
        amountPaise: e.amountPaise,
      })),
    });
  }

  async function ledgerFor(registrationId: string): Promise<LedgerRow[]> {
    return db.ledgerEntry.findMany({
      where: { registrationId },
      orderBy: { id: 'asc' },
    });
  }

  async function ledgerForPayment(paymentId: string): Promise<LedgerRow[]> {
    return db.ledgerEntry.findMany({ where: { paymentId }, orderBy: { id: 'asc' } });
  }

  /** True when this payment already has its charge rows. Keeps R6 idempotent. */
  async function hasChargeLedger(tx: Tx, paymentId: string): Promise<boolean> {
    const count = await tx.ledgerEntry.count({ where: { paymentId, kind: 'charge' } });
    return count > 0;
  }

  /**
   * organizers R8 — money per event, from the ledger (payments R6): what
   * players paid, what went back, and the platform's share.
   */
  async function ledgerSummary(eventIds: string[]): Promise<
    { eventId: string; grossPaise: bigint; refundedPaise: bigint; platformFeePaise: bigint; refunds: number }[]
  > {
    if (eventIds.length === 0) return [];
    return db.$queryRaw`
      SELECT reg.event_id::text AS "eventId",
             coalesce(sum(le.amount_paise) FILTER (WHERE le.kind = 'charge'), 0)::bigint AS "grossPaise",
             coalesce(-sum(le.amount_paise) FILTER (WHERE le.kind = 'refund'), 0)::bigint AS "refundedPaise",
             coalesce(sum(le.amount_paise) FILTER (WHERE le.kind IN ('platform_fee', 'fee_reversal')), 0)::bigint AS "platformFeePaise",
             count(*) FILTER (WHERE le.kind = 'refund')::int AS "refunds"
        FROM ledger_entries le
        JOIN registrations reg ON reg.id = le.registration_id
       WHERE reg.event_id = ANY(${eventIds}::uuid[])
       GROUP BY reg.event_id
    `;
  }

  return {
    ledgerSummary,
    claimWebhookEvent,
    webhookEvent,
    markWebhookProcessed,
    markWebhookFailed,
    unprocessedWebhooks,
    insertOrder,
    orderById,
    orderByGatewayId,
    openOrderFor,
    ordersFor,
    openOrderForBooking,
    ordersForBooking,
    capturedPaymentForBooking,
    setOrderStatus,
    failOrderUnlessPaid,
    upsertPayment,
    paymentById,
    paymentByGatewayId,
    capturedPaymentFor,
    setPaymentStatus,
    paymentsForUser,
    refundedTotal,
    insertRefund,
    refundByIdempotencyKey,
    refundByGatewayId,
    refundById,
    updateRefund,
    markRefundProcessed,
    pendingRefunds,
    unsentRefunds,
    capturedPaymentsIn,
    keeperCapture,
    writeLedger,
    ledgerFor,
    ledgerForPayment,
    hasChargeLedger,
  };
}

export type PaymentsRepo = ReturnType<typeof createPaymentsRepo>;
