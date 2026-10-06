/**
 * payments — service layer (docs/modules/07-payments.md).
 *
 * Gateway orders, webhook ingest, refunds and a ledger. Knows nothing about
 * tournaments — it moves money against a registration id and tells
 * `registration` what happened. The gateway itself is a port
 * (platform/paymentGateway.ts); nothing here knows which provider is behind it.
 *
 * THE WEBHOOK IS THE TRUTH. The gateway's client-side checkout callback is a UI
 * hint and confirms nothing (R5). A registration confirms on a signature-
 * verified `payment.captured`, or on reconciliation against the Orders API.
 * There is no third way, and adding one is how a tournament ends up with
 * entries nobody paid for.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../../../platform/db.js';
import { SystemError, UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import { GatewayError } from '../../../platform/paymentGateway.js';
import type {
  CheckoutForm,
  GatewayPayment,
  GatewayWebhookEvent,
  PaymentGateway,
} from '../../../platform/paymentGateway.js';
import type { LedgerRow, PaymentsRepo } from '../repo/index.js';
import type { TicketEvent } from '../../../platform/emailKit.js';
import { paymentEmail, type PaymentEmailKind } from './paymentEmail.js';

export const PaymentCode = {
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ORDER_ALREADY_PAID: 'ORDER_ALREADY_PAID',
  REFUND_WINDOW_CLOSED: 'REFUND_WINDOW_CLOSED',
  /** System channel — this one is a bug (R8). */
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  GATEWAY_UNAVAILABLE: 'GATEWAY_UNAVAILABLE',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  NOTHING_TO_REFUND: 'NOTHING_TO_REFUND',
  /** gap #12 — the draw's price moved after the player started; they start again. */
  PRICE_CHANGED: 'PRICE_CHANGED',
  /** gap #13 — the entry is not waiting for a payment (expired, withdrawn, queued, no partner yet). */
  NOT_PAYABLE: 'NOT_PAYABLE',
  /** gap #13 — the seat hold ran out; registering again takes a new one. */
  HOLD_EXPIRED: 'HOLD_EXPIRED',
} as const;

export interface Actor {
  userId: string;
}

export interface OrderHandle {
  orderId: string;
  gatewayOrderId: string;
  /** The signed form the client posts to the provider's hosted page. */
  checkout: CheckoutForm;
  amountPaise: bigint;
  currency: string;
  quote: {
    entryFeePaise: bigint;
    platformFeePaise: bigint;
    taxPaise: bigint;
    totalPaise: bigint;
    currency: string;
  };
}

export interface Refund {
  id: string;
  paymentId: string;
  amountPaise: bigint;
  reason: string;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
}

export interface LedgerEntry {
  id: bigint;
  kind: string;
  amountPaise: bigint;
  createdAt: Date;
}

/** R11 — rendered on demand from the ledger. No file is written anywhere. */
export interface Receipt {
  registrationId: string;
  paymentId: string;
  gatewayPaymentId: string;
  method: string | null;
  paidAt: Date | null;
  lines: { kind: string; amountPaise: bigint }[];
  totalPaise: bigint;
  refundedPaise: bigint;
  netPaise: bigint;
  currency: string;
}

// --- ports -------------------------------------------------------------------

export interface EventsPort {
  priceQuote(categoryId: string): Promise<{
    entryFeePaise: bigint;
    platformFeePaise: bigint;
    taxPaise: bigint;
    totalPaise: bigint;
    currency: string;
  }>;
  byId(eventId: string): Promise<{ id: string; title: string }>;
  /** The title, start and place that payment emails show. */
  forEmail(eventId: string): Promise<TicketEvent>;
}

/**
 * The only two calls back into `registration`. R5 lives on this edge: nothing
 * except a verified capture or a reconciliation reaches `confirmFromPayment`.
 */
export interface RegistrationPort {
  byId(registrationId: string): Promise<{
    id: string;
    eventId: string;
    eventCategoryId: string;
    captainUserId: string;
    status: string;
    amountPaise: bigint;
    /** Non-null while the entry holds a live seat. */
    holdExpiresAt: Date | null;
  }>;
  /** gap #22 — keep the seat held while the player is paying. */
  extendHold(registrationId: string, minutes: number): Promise<unknown>;
  /**
   * Throws ILLEGAL_TRANSITION when the entry can no longer be confirmed (hold
   * lapsed, expired, withdrawn). `confirmedNow` is true only for the call that
   * actually moved it — the one that may send "you are in".
   */
  confirmFromPayment(input: {
    registrationId: string;
    paymentId: string;
  }): Promise<{ confirmedNow: boolean }>;
  failFromPayment(input: {
    registrationId: string;
    paymentId: string;
    reason: string;
  }): Promise<unknown>;
}

/**
 * payments R20 — a court booking (19-bookings) is paid for the same way an
 * entry is: hold, order, and only a verified capture confirms it (bookings R2).
 */
export interface BookingsPort {
  byId(bookingId: string): Promise<{
    id: string;
    userId: string | null;
    status: string;
    amountPaise: bigint;
    courtPaise: bigint;
    platformFeePaise: bigint;
    taxPaise: bigint;
    holdExpiresAt: Date | null;
    venueName: string;
  }>;
  /** Keeps the court held while the player is paying (as gap #22 does for seats). */
  extendHold(bookingId: string, minutes: number): Promise<unknown>;
  /** Throws ILLEGAL_TRANSITION when the hold is gone; the capture is then refunded in full. */
  confirmFromPayment(input: { bookingId: string; paymentId: string }): Promise<{ confirmedNow: boolean }>;
  failFromPayment(input: { bookingId: string; paymentId: string; reason: string }): Promise<unknown>;
}

export interface UsersPort {
  byIds(ids: string[]): Promise<{ id: string; displayName: string; email: string; phone: string | null }[]>;
}

export interface EmailPort {
  send(msg: { to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export interface QueuePort {
  /** Enqueues the apply-webhook job. Kept off the request path (R4). */
  applyWebhook(gatewayEventId: string): Promise<void>;
  processRefund(refundId: string): Promise<void>;
}

export interface PaymentsDeps {
  db: Db;
  repo: PaymentsRepo;
  gateway: PaymentGateway;
  events: EventsPort;
  registration: RegistrationPort;
  /** Absent where bookings are not wired (most tests). */
  bookings?: BookingsPort;
  users: UsersPort;
  email: EmailPort;
  queue: QueuePort;
  /** Finance's inbox for money that needs a person (gap #15, #16, #21). Absent in tests that do not check it. */
  alert?(subject: string, text: string): Promise<void>;
  now?: () => Date;
}

const CURRENCY = 'INR';

/**
 * How long a payment may sit pending before reconciliation goes looking (R9).
 * gap #22 — well inside the seat hold, so a lost webhook is caught while the
 * player still holds their seat, not after it has gone to somebody else.
 */
export const RECONCILE_AFTER_MS = 5 * 60_000;

/** gap #22 — opening an order keeps the seat held this long from now. */
export const HOLD_WHILE_PAYING_MINUTES = 20;

/** gap #15 — the gateway is asked this many times before a refund is marked failed. */
export const REFUND_MAX_ATTEMPTS = 3;

/**
 * How far back reconciliation looks for an unsettled order. Older ones are
 * abandoned checkouts; without a floor they pile up at the head of the
 * oldest-first batch and starve the orders that actually need asking about.
 */
export const RECONCILE_ORDER_WINDOW_MS = 48 * 3_600_000;

/** The same floor for sent-but-unsettled refunds. */
export const RECONCILE_REFUND_WINDOW_MS = 7 * 86_400_000;

/**
 * An open order is reused only for a double-tap on Pay. A player who comes
 * back to Pay after dismissing or failing checkout gets a new order, so each
 * checkout session has its own; the old one is left for reconciliation, which
 * still catches a payment that lands on it late (a UPI app that finished after
 * the player gave up on checkout).
 */
export const ORDER_REUSE_MS = 10_000;

/** The refund reason for a capture whose entry could no longer be confirmed. */
export const LATE_CAPTURE_REASON = 'late_capture';
const lateCaptureKey = (paymentId: string) => `late_capture:${paymentId}`;
/** gap #21 — the refund of a second payment for an entry that was already paid. */
export const DUPLICATE_PAYMENT_REASON = 'duplicate_payment';
const duplicateKey = (paymentId: string) => `duplicate:${paymentId}`;

/**
 * F27 — the gateway's fee on a payment (Razorpay's payment entity carries
 * `fee`, in paise, tax included). Null when the payload does not say.
 */
export function gatewayFeeOf(raw: unknown): bigint | null {
  const fee = (raw as { fee?: unknown } | null)?.fee;
  if (typeof fee === 'number' && Number.isInteger(fee) && fee >= 0) return BigInt(fee);
  if (typeof fee === 'string' && /^\d+$/.test(fee)) return BigInt(fee);
  return null;
}

export function createPaymentsService(deps: PaymentsDeps) {
  const { db, repo, gateway, events, registration, users, email, queue } = deps;
  const now = deps.now ?? (() => new Date());

  // --- orders ----------------------------------------------------------------

  /**
   * R1 — the amount is recomputed server-side from `events.priceQuote()`. An
   * amount arriving from a client is IGNORED, not validated: there is no
   * parameter here for one to arrive in.
   *
   * Reusing an open order for the same amount is what keeps a double-tap on
   * "Pay" from creating two orders against one seat.
   */
  async function createOrder(actor: Actor, registrationId: string): Promise<OrderHandle> {
    const reg = await registration.byId(registrationId);
    if (reg.captainUserId !== actor.userId) {
      // registration R6 — the captain pays for the whole team.
      throw new SystemError('FORBIDDEN', 'Only the captain can pay for this entry.');
    }
    if (reg.status === 'confirmed' || reg.status === 'checked_in') {
      throw new UserError(
        PaymentCode.ORDER_ALREADY_PAID,
        'This entry is already paid for.',
        { details: { registrationId } },
      );
    }
    // gap #13 — only an entry waiting for its payment can take one. An
    // expired, withdrawn or queued entry, or a team still waiting for its
    // partner, would be charged and then refunded.
    if (reg.status !== 'payment_pending' && reg.status !== 'payment_failed') {
      throw new UserError(PaymentCode.NOT_PAYABLE, 'This entry can’t be paid for. Please register again.', {
        details: { registrationId, status: reg.status },
      });
    }
    if (!reg.holdExpiresAt) {
      throw new UserError(PaymentCode.HOLD_EXPIRED, 'Your seat hold ran out. Please register again.', {
        details: { registrationId },
      });
    }

    const quote = await events.priceQuote(reg.eventCategoryId);
    // gap #12 — the player agreed to the price frozen on their entry (events
    // R3). A draw repriced since then is a different deal: they start again
    // rather than being charged something they never saw.
    if (quote.totalPaise !== reg.amountPaise) {
      throw new UserError(PaymentCode.PRICE_CHANGED, 'The price of this draw has changed. Please register again.', {
        details: { registrationId },
      });
    }

    // gap #22 — the seat stays held while they pay; UPI can take minutes.
    await registration.extendHold(registrationId, HOLD_WHILE_PAYING_MINUTES);

    const open = await repo.openOrderFor(registrationId);
    if (
      open &&
      open.amountPaise === quote.totalPaise &&
      now().getTime() - open.createdAt.getTime() < ORDER_REUSE_MS
    ) {
      return handle(open, quote, reg);
    }

    const id = newId();
    let order;
    try {
      order = await gateway.createOrder({
        amountPaise: quote.totalPaise,
        currency: quote.currency,
        // Gateways cap the receipt (40 characters is the common limit), and our
        // own id is what we want to see on a settlement report.
        receipt: id.replace(/-/g, '').slice(0, 40),
        notes: { registrationId, eventId: reg.eventId },
      });
    } catch (err) {
      logger.error({ err, registrationId }, 'gateway order creation failed');
      throw new SystemError(PaymentCode.GATEWAY_UNAVAILABLE, 'Payments are briefly unavailable.');
    }

    const row = await repo.insertOrder({
      id,
      registrationId,
      gatewayOrderId: order.id,
      entryFeePaise: quote.entryFeePaise,
      platformFeePaise: quote.platformFeePaise,
      taxPaise: quote.taxPaise,
      amountPaise: quote.totalPaise,
      currency: quote.currency,
      status: 'created',
    });

    return handle(row, quote, reg);
  }

  /**
   * gap #22 — the app asks this every few seconds while checkout is open. It
   * asks the gateway directly about every open order on the entry, through
   * `settleOrderFromGateway` — the same path reconciliation takes, and still
   * the only way a capture confirms an entry. A webhook that is late or lost
   * then costs seconds, not a refund.
   */
  async function refreshPayment(actor: Actor, registrationId: string): Promise<{ settled: boolean }> {
    const reg = await registration.byId(registrationId);
    if (reg.captainUserId !== actor.userId) {
      throw new SystemError('FORBIDDEN', 'Only the captain can check this payment.');
    }
    if (reg.status !== 'payment_pending' && reg.status !== 'payment_failed') return { settled: false };
    let settled = false;
    for (const order of await repo.ordersFor(registrationId)) {
      if (order.status !== 'created' && order.status !== 'attempted') continue;
      try {
        if (await settleOrderFromGateway(order.gatewayOrderId)) settled = true;
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'payment refresh failed; reconciliation will retry');
      }
    }
    return { settled };
  }

  function bookingsPort(): BookingsPort {
    if (!deps.bookings) throw new SystemError('INTERNAL', 'Court bookings are not available.');
    return deps.bookings;
  }

  /**
   * bookings R2, R5 — the order for a held court. The amount is the quote
   * frozen on the booking when it was held, never one from the client.
   */
  async function createBookingOrder(actor: Actor, bookingId: string): Promise<OrderHandle> {
    const bookings = bookingsPort();
    const booking = await bookings.byId(bookingId);
    if (booking.userId !== actor.userId) throw new SystemError('FORBIDDEN', 'This booking is not yours.');
    if (booking.status === 'confirmed' || booking.status === 'checked_in' || booking.status === 'completed') {
      throw new UserError(PaymentCode.ORDER_ALREADY_PAID, 'This booking is already paid for.');
    }
    if (booking.status !== 'held' || !booking.holdExpiresAt || booking.holdExpiresAt <= now()) {
      throw new UserError(PaymentCode.HOLD_EXPIRED, 'Your hold on this court ran out. Please pick a slot again.');
    }
    await bookings.extendHold(bookingId, HOLD_WHILE_PAYING_MINUTES);

    const quote = {
      entryFeePaise: booking.courtPaise,
      platformFeePaise: booking.platformFeePaise,
      taxPaise: booking.taxPaise,
      totalPaise: booking.amountPaise,
      currency: CURRENCY,
    };
    const open = await repo.openOrderForBooking(bookingId);
    if (open && open.amountPaise === quote.totalPaise && now().getTime() - open.createdAt.getTime() < ORDER_REUSE_MS) {
      return bookingHandle(open, quote, actor.userId, booking.venueName);
    }

    const id = newId();
    let order;
    try {
      order = await gateway.createOrder({
        amountPaise: quote.totalPaise,
        currency: quote.currency,
        receipt: id.replace(/-/g, '').slice(0, 40),
        notes: { bookingId },
      });
    } catch (err) {
      logger.error({ err, bookingId }, 'gateway order creation failed');
      throw new SystemError(PaymentCode.GATEWAY_UNAVAILABLE, 'Payments are briefly unavailable.');
    }
    const row = await repo.insertOrder({
      id,
      bookingId,
      gatewayOrderId: order.id,
      entryFeePaise: quote.entryFeePaise,
      platformFeePaise: quote.platformFeePaise,
      taxPaise: quote.taxPaise,
      amountPaise: quote.totalPaise,
      currency: quote.currency,
      status: 'created',
    });
    return bookingHandle(row, quote, actor.userId, booking.venueName);
  }

  async function bookingHandle(
    row: Awaited<ReturnType<PaymentsRepo['insertOrder']>>,
    quote: OrderHandle['quote'],
    payerId: string,
    venueName: string,
  ): Promise<OrderHandle> {
    const [payer] = await users.byIds([payerId]);
    if (!payer) throw new SystemError('FORBIDDEN', 'The payer could not be found.');
    let checkout: CheckoutForm;
    try {
      checkout = gateway.checkoutForm({
        gatewayOrderId: row.gatewayOrderId,
        amountPaise: row.amountPaise,
        receipt: row.id,
        payer: { name: payer.displayName, email: payer.email, phone: payer.phone },
        description: `Court at ${venueName}`,
      });
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      logger.error({ err, orderId: row.id }, 'gateway checkout form failed');
      throw new SystemError(PaymentCode.GATEWAY_UNAVAILABLE, 'Payments are briefly unavailable.');
    }
    return { orderId: row.id, gatewayOrderId: row.gatewayOrderId, checkout, amountPaise: row.amountPaise, currency: row.currency, quote };
  }

  /** The booking twin of `refreshPayment`: asks the gateway, through the one settle path. */
  async function refreshBookingPayment(actor: Actor, bookingId: string): Promise<{ settled: boolean }> {
    const booking = await bookingsPort().byId(bookingId);
    if (booking.userId !== actor.userId) throw new SystemError('FORBIDDEN', 'This booking is not yours.');
    if (booking.status !== 'held') return { settled: false };
    let settled = false;
    for (const order of await repo.ordersForBooking(bookingId)) {
      if (order.status !== 'created' && order.status !== 'attempted') continue;
      try {
        if (await settleOrderFromGateway(order.gatewayOrderId)) settled = true;
      } catch (err) {
        logger.warn({ err, orderId: order.id }, 'booking payment refresh failed; reconciliation will retry');
      }
    }
    return { settled };
  }

  /**
   * bookings R6 — the refund for a cancelled booking: a share of the court
   * money (basis points) and, when the venue cancelled, the platform fee too.
   * One refund per booking cancellation, however often it is asked for.
   */
  async function refundForBooking(input: {
    bookingId: string;
    reason: string;
    courtShareBps: number;
    includePlatformFee: boolean;
  }): Promise<Refund | null> {
    const payment = await repo.capturedPaymentForBooking(input.bookingId);
    if (!payment) return null;
    const order = await repo.orderById(payment.paymentOrderId);
    if (!order) return null;
    const amount = bookingRefundAmount({
      courtPaise: order.entryFeePaise,
      platformFeePaise: order.platformFeePaise,
      taxPaise: order.taxPaise,
      capturedPaise: payment.amountPaise,
      courtShareBps: input.courtShareBps,
      includePlatformFee: input.includePlatformFee,
    });
    if (amount <= 0n) return null;
    return refund(null, {
      paymentId: payment.id,
      amountPaise: amount,
      reason: input.reason,
      idempotencyKey: `booking_cancel:${input.bookingId}`,
    });
  }

  async function handle(
    row: Awaited<ReturnType<PaymentsRepo['insertOrder']>>,
    quote: Awaited<ReturnType<EventsPort['priceQuote']>>,
    reg: Awaited<ReturnType<RegistrationPort['byId']>>,
  ): Promise<OrderHandle> {
    const [[payer], event] = await Promise.all([users.byIds([reg.captainUserId]), events.byId(reg.eventId)]);
    if (!payer) throw new SystemError('FORBIDDEN', 'The payer could not be found.');
    let checkout: CheckoutForm;
    try {
      checkout = gateway.checkoutForm({
        gatewayOrderId: row.gatewayOrderId,
        amountPaise: row.amountPaise,
        receipt: row.id,
        payer: { name: payer.displayName, email: payer.email, phone: payer.phone },
        description: event.title,
      });
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      logger.error({ err, orderId: row.id }, 'gateway checkout form failed');
      throw new SystemError(PaymentCode.GATEWAY_UNAVAILABLE, 'Payments are briefly unavailable.');
    }
    return {
      orderId: row.id,
      gatewayOrderId: row.gatewayOrderId,
      checkout,
      amountPaise: row.amountPaise,
      currency: row.currency,
      quote,
    };
  }

  // --- webhook ingest (R2, R3, R4) -------------------------------------------

  /**
   * The request path, and it does three things: verify, claim, enqueue.
   *
   * R2 — the gateway adapter verifies the signature over the RAW bytes. A bad
   * signature is a 400 and nothing is written.
   *
   * R3 — the event id is claimed BEFORE anything else. A duplicate inserts
   * nothing and gets a 200, so the gateway stops retrying immediately.
   *
   * R4 — the state change happens in a job. Gateways time out within seconds
   * and RETRY A SLOW SUCCESS, which is how you get double-processing; doing the
   * work here would make that our normal case on a busy Saturday.
   */
  async function ingestWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ accepted: boolean; duplicate: boolean; status: number }> {
    const event = gateway.parseWebhook(rawBody, headers);
    if (!event) return { accepted: false, duplicate: false, status: 400 };

    // An unsigned refund notice for a refund we never sent is dropped BEFORE
    // anything is written: otherwise anyone can make us insert a claim row
    // and enqueue a job per request.
    if (event.type === 'refund.check' && !(await repo.refundByGatewayId(event.gatewayRefundId))) {
      logger.warn({ gatewayRefundId: event.gatewayRefundId }, 'refund notice for an unknown refund');
      return { accepted: true, duplicate: false, status: 200 };
    }

    const claimed = await repo.claimWebhookEvent({
      gatewayEventId: event.id,
      eventType: event.type,
      payload: storeEvent(event),
    });
    if (!claimed) return { accepted: true, duplicate: true, status: 200 };

    await queue.applyWebhook(event.id);
    return { accepted: true, duplicate: false, status: 200 };
  }

  /**
   * The job. Retried five times with backoff, and a final failure PAGES someone
   * because money is unreconciled — so every branch below has to be safe to run
   * twice.
   */
  async function applyWebhook(gatewayEventId: string): Promise<void> {
    const row = await repo.webhookEvent(gatewayEventId);
    if (!row) return;
    if (row.processedAt) return; // already applied

    const event = loadEvent(row.payload);

    try {
      switch (event.type) {
        case 'payment.captured':
          await applyCapture(event.payment);
          break;
        case 'payment.failed':
          await applyFailure(event.payment);
          break;
        case 'refund.processed':
          await applyRefundProcessed(event.refund.id, event.refund.paymentId);
          break;
        case 'refund.failed':
          await applyRefundFailed(event.refund.id);
          break;
        case 'refund.check':
          await checkRefund(event.gatewayRefundId);
          break;
        case 'payment.check':
          await checkPayment(event.gatewayOrderId, event.status);
          break;
        default:
          logger.info({ eventType: row.eventType }, 'gateway event ignored');
      }
      await repo.markWebhookProcessed(gatewayEventId);
    } catch (err) {
      await repo.markWebhookFailed(
        gatewayEventId,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * R5, R6 — the only path that confirms a registration, and the only path that
   * writes charge/fee/tax ledger rows.
   *
   * Idempotent all the way down: the payment upserts on its unique gateway id,
   * the ledger writes are guarded on already having a charge row, and
   * `registration.confirmFromPayment` is itself a conditional UPDATE. Five
   * duplicate deliveries produce one payment, one ledger set and one push.
   */
  async function applyCapture(entity: GatewayPayment): Promise<void> {
    if (!entity.orderId) {
      logger.warn({ paymentId: entity.id }, 'captured payment with no order');
      return;
    }
    const order = await repo.orderByGatewayId(entity.orderId);
    if (!order) {
      // An order we never created. Either a different environment's key is
      // pointed at this endpoint, or a very bad day. Loud, not silent.
      throw new Error(`No payment_order for gateway order ${entity.orderId}`);
    }
    // gap #16 — the gateway took a different amount from the one we asked
    // for. Nothing is written and nothing confirms; the job fails (and pages
    // on its last try) and finance is told at once. A person decides.
    if (entity.amountPaise !== order.amountPaise) {
      await deps.alert?.(
        'Captured amount does not match the order',
        `Payment ${entity.id} on order ${order.gatewayOrderId} captured ${entity.amountPaise} paise; the order was for ${order.amountPaise}.`,
      );
      throw new Error(
        `Capture ${entity.id} is ${entity.amountPaise} paise but order ${order.id} is ${order.amountPaise}`,
      );
    }

    const paymentId = newId();
    const result = await db.$transaction(async (tx) => {
      const { payment } = await repo.upsertPayment(tx, {
        id: paymentId,
        paymentOrderId: order.id,
        gatewayPaymentId: entity.id,
        method: entity.method,
        amountPaise: entity.amountPaise,
        status: 'captured',
        failureReason: null,
        capturedAt: entity.capturedAt ?? now(),
        raw: entity.raw,
      });

      await repo.setOrderStatus(tx, order.id, 'paid');

      // F27 — what the gateway kept, from its own payload. Informational on a
      // played event; the host's on an event they cancel (payoutQuote).
      const feePaise = gatewayFeeOf(entity.raw);

      // R6 — charge, platform fee and tax, each its own row, written once.
      if (!(await repo.hasChargeLedger(tx, payment.id))) {
        if (feePaise !== null) {
          await tx.payment.update({ where: { id: payment.id }, data: { feePaise } });
          await repo.writeLedger(tx, [
            { registrationId: order.registrationId, paymentId: payment.id, kind: 'gateway_fee', amountPaise: feePaise },
          ]);
        }
        await repo.writeLedger(tx, [
          {
            registrationId: order.registrationId,
            paymentId: payment.id,
            kind: 'charge',
            amountPaise: order.amountPaise,
          },
          {
            registrationId: order.registrationId,
            paymentId: payment.id,
            kind: 'platform_fee',
            amountPaise: order.platformFeePaise,
          },
          {
            registrationId: order.registrationId,
            paymentId: payment.id,
            kind: 'tax',
            amountPaise: order.taxPaise,
          },
        ]);
        await outboxWrite(tx, {
          topic: 'payment.captured',
          payload: {
            paymentId: payment.id,
            registrationId: order.registrationId,
            amountPaise: order.amountPaise.toString(),
          },
        });
      }
      return { payment };
    });

    // Already refunded as a late capture: never confirm it afterwards, even
    // if the entry has since become confirmable again (a new hold on retry).
    if (await repo.refundByIdempotencyKey(lateCaptureKey(result.payment.id))) return;

    if (order.bookingId) {
      await settleBookingCapture(order.bookingId, result.payment);
      return;
    }
    const registrationId = order.registrationId!;

    let confirmation: { confirmedNow: boolean };
    try {
      confirmation = await registration.confirmFromPayment({
        registrationId,
        paymentId: result.payment.id,
      });
    } catch (err) {
      if (!isIllegalTransition(err)) throw err;
      // The player was charged for an entry that can no longer be confirmed
      // (hold lapsed, expired, withdrawn). Throwing would page forever and
      // fix nothing; a charged player with no entry expects their money back.
      // Idempotent on the key, so redelivery and reconciliation are free.
      logger.warn(
        { err, paymentId: result.payment.id, registrationId },
        'capture for an entry that cannot be confirmed — refunding in full',
      );
      await refund(null, {
        paymentId: result.payment.id,
        amountPaise: result.payment.amountPaise,
        reason: LATE_CAPTURE_REASON,
        idempotencyKey: lateCaptureKey(result.payment.id),
        registrationId,
      });
      return;
    }

    // gap #21 — a second payment for an entry that is already paid (an old
    // checkout's UPI request approved after a new one succeeded). Exactly one
    // capture pays for an entry; any other is refunded in full, and never
    // counts toward the host's payout once its refund lands.
    const keeper = await repo.keeperCapture(registrationId);
    if (keeper && keeper !== result.payment.id) {
      logger.warn(
        { paymentId: result.payment.id, keeper, registrationId },
        'duplicate payment for an already-paid entry — refunding in full',
      );
      await refund(null, {
        paymentId: result.payment.id,
        amountPaise: result.payment.amountPaise,
        reason: DUPLICATE_PAYMENT_REASON,
        idempotencyKey: duplicateKey(result.payment.id),
        registrationId,
      });
      await deps.alert?.(
        'Duplicate payment refunded',
        `Registration ${registrationId} was paid twice; payment ${entity.id} is being refunded in full.`,
      );
      return;
    }

    // R12 — transactional email belongs to the module that owns the action.
    //
    // Sent only by the call that actually confirmed the entry: gateways
    // redeliver and reconciliation covers the same ground the webhook does,
    // and a capture that ends up refunded must never say "you are in".
    if (confirmation.confirmedNow) {
      await sendPaymentEmail(registrationId, 'confirmed', order.amountPaise, {
        method: entity.method,
        reference: entity.id,
      });
    }
  }

  /**
   * bookings R2 — the booking half of `applyCapture`. A capture for a hold
   * that is gone (expired, the court taken) is refunded in full, as is a
   * second capture for a booking that is already paid.
   */
  async function settleBookingCapture(bookingId: string, payment: { id: string; amountPaise: bigint }): Promise<void> {
    const bookings = bookingsPort();
    try {
      await bookings.confirmFromPayment({ bookingId, paymentId: payment.id });
    } catch (err) {
      if (!isIllegalTransition(err)) throw err;
      logger.warn({ err, paymentId: payment.id, bookingId }, 'capture for a booking that cannot be confirmed — refunding in full');
      await refund(null, {
        paymentId: payment.id,
        amountPaise: payment.amountPaise,
        reason: LATE_CAPTURE_REASON,
        idempotencyKey: lateCaptureKey(payment.id),
      });
      return;
    }
    const keeper = await repo.keeperCapture({ bookingId });
    if (keeper && keeper !== payment.id) {
      await refund(null, {
        paymentId: payment.id,
        amountPaise: payment.amountPaise,
        reason: DUPLICATE_PAYMENT_REASON,
        idempotencyKey: duplicateKey(payment.id),
      });
    }
  }

  /**
   * R8 over in registration: the hold stays alive so a retry keeps the slot.
   *
   * Idempotent the same way `applyCapture` is: the payment upserts on its
   * unique gateway id, and `created` (true only the FIRST time this gateway
   * payment id is written) is what gates the outbox write, the call into
   * registration and the email — not just the `payment.check` repeat guard
   * in `checkPayment`, because reconciliation reaches this function directly
   * and a webhook redelivery can race a reconcile pass on the same order.
   *
   * One order can carry several attempts (Razorpay's checkout retries in
   * place), and webhooks are not delivered in order: a failed attempt's notice
   * can land after the attempt that was captured. It is recorded, and changes
   * nothing else — a paid order stays paid and no "payment failed" email
   * follows a "you are in".
   */
  async function applyFailure(entity: GatewayPayment): Promise<void> {
    if (!entity.orderId) return;
    const order = await repo.orderByGatewayId(entity.orderId);
    if (!order) return;

    const reason = entity.failureReason ?? 'payment failed';
    const paymentId = newId();

    const result = await db.$transaction(async (tx) => {
      const { payment: row, created } = await repo.upsertPayment(tx, {
        id: paymentId,
        paymentOrderId: order.id,
        gatewayPaymentId: entity.id,
        method: entity.method,
        amountPaise: entity.amountPaise,
        status: 'failed',
        failureReason: reason,
        capturedAt: null,
        raw: entity.raw,
      });
      const failedOrder = await repo.failOrderUnlessPaid(tx, order.id);
      const firstApplication = created && failedOrder;
      if (firstApplication) {
        await outboxWrite(tx, {
          topic: 'payment.failed',
          payload: { paymentId: row.id, registrationId: order.registrationId, bookingId: order.bookingId, reason },
        });
      }
      return { payment: row, firstApplication };
    });

    if (result.firstApplication) {
      if (order.bookingId) {
        await bookingsPort().failFromPayment({ bookingId: order.bookingId, paymentId: result.payment.id, reason });
        return;
      }
      const registrationId = order.registrationId!;
      await registration.failFromPayment({
        registrationId,
        paymentId: result.payment.id,
        reason,
      });
      await sendPaymentEmail(registrationId, 'failed', order.amountPaise, { method: entity.method });
    }
  }

  /**
   * Asks the gateway what actually happened to an order and applies the
   * answer through `applyCapture`/`applyFailure` — the only two functions
   * that ever confirm a registration or move money. Shared by
   * `reconcilePending` (R9, polling a stale order) and `checkPayment` (a
   * payment notice whose provider id is not itself trusted), so there is one
   * place this logic lives rather than two that can drift apart.
   */
  async function settleOrderFromGateway(gatewayOrderId: string): Promise<boolean> {
    const payments = await gateway.paymentsForOrder(gatewayOrderId);
    const captured = payments.find((p) => p.status === 'captured');
    if (captured) {
      await applyCapture(captured);
      return true;
    }
    const failed = payments.find((p) => p.status === 'failed');
    if (failed) {
      await applyFailure(failed);
      return true;
    }
    return false;
  }

  /**
   * For providers whose payment notices can be trusted for an order id and
   * nothing more (Razorpay signs the whole payload and sends
   * `payment.captured` instead): the adapter emits `payment.check` keyed on
   * the order, and this asks the provider for the real payment rather than
   * trusting anything else in the notice.
   *
   * Looked up in OUR db FIRST, symmetric with `checkRefund`: an id we never
   * sent must never make us call the gateway about it. But once we know the
   * order, there is deliberately NO status-based early return — not even for
   * `paid` — and the gateway is asked every time. Two things make that safe
   * rather than wasteful: `applyCapture` and `applyFailure` are both
   * first-application-gated, and `registration.confirmFromPayment` no-ops on
   * an already-confirmed registration. A player can retry on the SAME order
   * after a failure, so a capture may land on a `payment_failed` entry: it confirms
   * while the seat hold lives, and is refunded in full (`late_capture`)
   * when it cannot — see `applyCapture`.
   *
   * The notice's own signed status is carried: a `success`/`failure` notice
   * that the gateway cannot yet back with a final payment throws, so the job
   * retries with backoff instead of marking the notice processed.
   */
  async function checkPayment(
    gatewayOrderId: string,
    noticeStatus: 'success' | 'failure' | 'other',
  ): Promise<void> {
    const order = await repo.orderByGatewayId(gatewayOrderId);
    if (!order) {
      logger.warn({ gatewayOrderId }, 'payment status check for an unknown order');
      return;
    }

    const settled = await settleOrderFromGateway(gatewayOrderId);
    // A signed final notice the provider cannot yet back up (its verify API
    // lags the notice). Marking it processed would drop it; throwing makes the
    // job retry with backoff until verify catches up.
    if (!settled && noticeStatus !== 'other') {
      throw new Error(
        `payment notice says ${noticeStatus} for ${gatewayOrderId}, but the gateway reports nothing final yet`,
      );
    }
  }

  // --- refunds (R7, R8) ------------------------------------------------------

  /**
   * The idempotency key. Default is a hash of (payment, reason, amount) exactly
   * as R7 specifies, so retrying the same refund is free; an explicit key wins
   * when the caller has a better notion of "the same refund".
   */
  const defaultKey = (paymentId: string, reason: string, amountPaise: bigint): string =>
    createHash('sha256').update(`${paymentId}|${reason}|${amountPaise}`).digest('hex');

  /**
   * R7, R8 — idempotent, and never more than `captured − already_refunded`.
   *
   * The sum is read INSIDE the transaction and the unique index on
   * `idempotency_key` is the tiebreak when two workers arrive together: one
   * inserts, the other collides and reads back the row that won. Retrying a
   * refund must never send money twice.
   */
  async function refund(
    actor: Actor | null,
    input: {
      paymentId: string;
      amountPaise: bigint;
      reason: string;
      idempotencyKey?: string;
      registrationId?: string;
    },
  ): Promise<Refund> {
    const payment = await repo.paymentById(input.paymentId);
    if (!payment) {
      throw new UserError(PaymentCode.PAYMENT_NOT_FOUND, 'That payment could not be found.');
    }
    const order = await repo.orderById(payment.paymentOrderId);
    if (!order) {
      throw new UserError(PaymentCode.PAYMENT_NOT_FOUND, 'That payment could not be found.');
    }
    if (actor) {
      const payer = order.bookingId
        ? (await bookingsPort().byId(order.bookingId)).userId
        : (await registration.byId(order.registrationId!)).captainUserId;
      if (payer !== actor.userId) {
        throw new SystemError('FORBIDDEN', 'Only the payer can request this refund.');
      }
    }

    const key = input.idempotencyKey ?? defaultKey(payment.id, input.reason, input.amountPaise);
    const existing = await repo.refundByIdempotencyKey(key);
    if (existing) return toRefund(existing);

    if (input.amountPaise <= 0n) {
      throw new UserError(PaymentCode.NOTHING_TO_REFUND, 'There is nothing to refund.');
    }

    const refundId = newId();
    const row = await db.$transaction(async (tx) => {
      const already = await repo.refundedTotal(tx, payment.id);
      if (already + input.amountPaise > payment.amountPaise) {
        // A bug, not something the player did — system channel (R8).
        throw new SystemError(
          PaymentCode.REFUND_EXCEEDS_CAPTURED,
          `Refund of ${input.amountPaise} exceeds ${payment.amountPaise - already} available`,
        );
      }

      const created = await repo.insertRefund(tx, {
        id: refundId,
        paymentId: payment.id,
        gatewayRefundId: null,
        amountPaise: input.amountPaise,
        reason: input.reason,
        idempotencyKey: key,
        status: 'pending',
        processedAt: null,
      });

      // R6 — the movement is recorded the moment it is decided, as a debit.
      // The reversal rows land when the gateway confirms.
      await repo.writeLedger(tx, [
        {
          registrationId: order.registrationId,
          paymentId: payment.id,
          refundId: created.id,
          kind: 'refund',
          amountPaise: -input.amountPaise,
        },
      ]);
      return created;
    });

    // Sending the money is a job: a gateway timeout must not lose the decision.
    await queue.processRefund(row.id).catch((err: unknown) => {
      logger.error({ err, refundId: row.id }, 'failed to enqueue refund');
    });

    return toRefund(row);
  }

  /** The `process-refund` job. A final failure PAGES: a player is owed money. */
  async function processRefund(refundId: string): Promise<void> {
    const row = await repo.refundById(refundId);
    if (!row || row.status !== 'pending') return;
    if (row.gatewayRefundId) return; // already sent, waiting for the webhook

    const payment = await repo.paymentById(row.paymentId);
    if (!payment) throw new Error(`Refund ${refundId} has no payment`);

    // gap #15 — a retry after the gateway failed the refund needs a fresh
    // receipt, or the gateway hands back the same failed refund. The row's own
    // key never changes, so a caller retrying the decision still dedupes.
    const attempts = row.attempts ?? 0;
    const sent = await gateway.refund({
      paymentId: payment.gatewayPaymentId,
      amountPaise: row.amountPaise,
      idempotencyKey: attempts === 0 ? row.idempotencyKey : `${row.idempotencyKey}:r${attempts}`,
    });

    await repo.updateRefund(db, refundId, { gatewayRefundId: sent.id });
    // `refund.processed` is what actually settles it. If the gateway answered
    // 'processed' synchronously we still wait for the webhook, so there is one
    // path that writes the reversal rows rather than two.
  }

  /**
   * For an unsigned refund notice (`refund.check`) and for reconciliation of a
   * refund whose webhook never came: looked up in OUR
   * db FIRST — an unsigned notice must never make us call the gateway about a
   * refund id we never sent — then asked, then applied through the same two
   * functions a signed webhook would use, off OUR stored row, never an amount
   * out of the provider's response. Still pending is not an error;
   * reconciliation asks again.
   */
  async function checkRefund(gatewayRefundId: string): Promise<void> {
    const row = await repo.refundByGatewayId(gatewayRefundId);
    if (!row) {
      logger.warn({ gatewayRefundId }, 'refund status check for an unknown refund');
      return;
    }

    let status;
    try {
      status = await gateway.refundStatus(gatewayRefundId);
    } catch (err) {
      // The gateway has never heard of this refund (a key from another
      // account or mode, a mistyped id). Asking again every five minutes
      // cannot change that — found in the 2026-10-05 end-to-end run. It is
      // marked failed, which frees the payment for a new refund, and finance
      // is told once, because a player may still be owed this money.
      const unknown = err instanceof GatewayError && (err.upstreamStatus === 404 || err.status === 404);
      if (!unknown || row.status !== 'pending') throw err;
      await repo.updateRefund(db, row.id, { status: 'failed', attempts: (row.attempts ?? 0) + 1 });
      logger.error({ refundId: row.id, gatewayRefundId }, 'gateway does not know this refund — marked failed');
      await deps.alert?.(
        'Refund unknown to the gateway',
        `Refund ${row.id} (${row.amountPaise} paise) has gateway id ${gatewayRefundId}, which the gateway does not recognise. It is marked failed; check the payment and refund it another way if the player is still owed.`,
      );
      return;
    }
    if (status.status === 'processed') {
      const payment = await repo.paymentById(row.paymentId);
      if (!payment) {
        logger.warn({ gatewayRefundId }, 'refund status for a refund with no payment');
        return;
      }
      await applyRefundProcessed(gatewayRefundId, payment.gatewayPaymentId);
    } else if (status.status === 'failed') {
      await applyRefundFailed(gatewayRefundId);
    }
  }

  async function applyRefundProcessed(
    gatewayRefundId: string,
    gatewayPaymentId: string,
  ): Promise<void> {
    const row = await repo.refundByGatewayId(gatewayRefundId);
    const payment = await repo.paymentByGatewayId(gatewayPaymentId);
    if (!row || !payment) {
      logger.warn({ gatewayRefundId }, 'refund.processed for an unknown refund');
      return;
    }
    if (row.status === 'processed') return;

    const order = await repo.orderById(payment.paymentOrderId);

    const firstApplication = await db.$transaction(async (tx) => {
      // The conditional UPDATE is the gate: of two callers racing here (two
      // notices, or a notice and reconciliation), exactly one moves the row
      // off `pending`, and only that one writes reversals, outbox and email.
      if (!(await repo.markRefundProcessed(tx, row.id, now()))) return false;

      const total = await repo.refundedTotal(tx, payment.id);
      await repo.setPaymentStatus(
        tx,
        payment.id,
        total >= payment.amountPaise ? 'refunded' : 'partially_refunded',
      );

      // R6 — a full refund reverses the fee and the tax as well as the charge.
      // A partial one does not: which component a partial refund came out of is
      // a decision, and this module does not get to guess it.
      if (order && total >= payment.amountPaise) {
        await repo.writeLedger(tx, [
          {
            registrationId: order.registrationId,
            paymentId: payment.id,
            refundId: row.id,
            kind: 'fee_reversal',
            amountPaise: -order.platformFeePaise,
          },
          {
            registrationId: order.registrationId,
            paymentId: payment.id,
            refundId: row.id,
            kind: 'tax_reversal',
            amountPaise: -order.taxPaise,
          },
        ]);
      }

      await outboxWrite(tx, {
        topic: 'refund.processed',
        payload: {
          refundId: row.id,
          registrationId: order?.registrationId ?? null,
          amountPaise: row.amountPaise.toString(),
        },
      });
      return true;
    });

    if (firstApplication && order?.registrationId) {
      await sendPaymentEmail(order.registrationId, 'refunded', row.amountPaise, {
        method: payment.method,
        reference: gatewayRefundId,
        at: now(),
      });
    }
  }

  /**
   * gap #15 — the gateway failed a refund (a closed account, a bank that
   * bounced it). It is sent again, a few times, each under a fresh receipt;
   * after the last try it is marked `failed` and finance is told, because a
   * player is owed money and a person has to find another way to pay it.
   * A `failed` refund no longer counts against the payment, so staff can
   * issue a new one.
   */
  async function applyRefundFailed(gatewayRefundId: string): Promise<void> {
    const row = await repo.refundByGatewayId(gatewayRefundId);
    if (!row || row.status !== 'pending') return;
    const attempts = (row.attempts ?? 0) + 1;
    logger.error({ refundId: row.id, attempts }, 'gateway refund FAILED — a player is owed money');
    if (attempts >= REFUND_MAX_ATTEMPTS) {
      await repo.updateRefund(db, row.id, { status: 'failed', attempts });
      await deps.alert?.(
        'Refund failed — a player is owed money',
        `Refund ${row.id} (${row.amountPaise} paise) failed ${attempts} times at the gateway. Pay it another way.`,
      );
      return;
    }
    await repo.updateRefund(db, row.id, { gatewayRefundId: null, attempts });
    await queue.processRefund(row.id);
  }

  /**
   * What `registration.cancel` calls (registration R9). `refundAmount: false`
   * is the post-cutoff case: the slot returns, the money does not, and there is
   * nothing for this module to do.
   */
  async function refundForRegistration(input: {
    registrationId: string;
    reason: string;
    refundAmount: boolean;
    /** Organizer cancellation absorbs the platform fee (the refund table). */
    includePlatformFee?: boolean;
    /** F27 — a share of the entry fee (basis points), for a late withdrawal under the flexible policy. */
    fractionBps?: number;
  }): Promise<Refund | null> {
    if (!input.refundAmount) return null;

    const payment = await repo.capturedPaymentFor(input.registrationId);
    if (!payment) return null;
    const order = await repo.orderById(payment.paymentOrderId);
    if (!order) return null;

    // The refund table in the module doc: a player cancelling before the cutoff
    // gets the entry fee back and the platform fee is retained — which is
    // disclosed in the quote at checkout. An organizer cancelling gives back
    // everything, platform fee absorbed.
    // gap #16 — the tax on the order covers the entry fee AND the platform
    // fee. The platform fee is retained, so the tax on it is too; only the
    // entry fee's share of the tax goes back.
    const base = order.entryFeePaise + order.platformFeePaise;
    const entryTaxPaise = base > 0n ? (order.taxPaise * order.entryFeePaise) / base : 0n;
    const full = input.includePlatformFee
      ? payment.amountPaise
      : order.entryFeePaise + entryTaxPaise;
    const amount =
      input.fractionBps !== undefined ? (full * BigInt(input.fractionBps)) / 10_000n : full;
    if (amount <= 0n) return null;

    return refund(null, {
      paymentId: payment.id,
      amountPaise: amount,
      reason: input.reason,
      registrationId: input.registrationId,
    });
  }

  /**
   * events R7 — an organizer cancellation gives back everything.
   *
   * gap #2, #21, #34 — driven by the captured PAYMENTS on the event, not by
   * which entries happen to be `confirmed`: a second payment for one entry,
   * a player who withdrew after the cutoff, a late capture — each gets back
   * whatever of its payment has not already gone back.
   */
  async function bulkRefund(eventId: string, reason: string): Promise<{ queued: number }> {
    return refundEach(await repo.capturedPaymentsIn({ eventId }), reason);
  }

  /**
   * events R9 — a category that missed its minimum entries. Same money as an
   * organizer cancellation, because the player did nothing wrong either time.
   */
  async function bulkRefundCategory(
    categoryId: string,
    reason: string,
  ): Promise<{ queued: number }> {
    return refundEach(await repo.capturedPaymentsIn({ categoryId }), reason);
  }

  async function refundEach(
    captured: { paymentId: string; registrationId: string; amountPaise: bigint; refundedPaise: bigint }[],
    reason: string,
  ): Promise<{ queued: number }> {
    let queued = 0;
    const failed: string[] = [];
    for (const p of captured) {
      const left = p.amountPaise - p.refundedPaise;
      if (left <= 0n) continue;
      try {
        await refund(null, {
          paymentId: p.paymentId,
          amountPaise: left,
          reason,
          // One cancellation refund per payment, however often the job runs.
          idempotencyKey: `cancel:${reason}:${p.paymentId}`,
          registrationId: p.registrationId,
        });
        queued += 1;
      } catch (err) {
        // One player's refund failing must not strand the other forty-nine…
        logger.error({ err, paymentId: p.paymentId }, 'bulk refund entry failed');
        failed.push(p.paymentId);
      }
    }
    // …but it must not be forgotten either (gap #23). Failing the job makes it
    // retry; the refunds already made are idempotent on their keys.
    if (failed.length > 0) {
      throw new Error(`bulk refund: ${failed.length} of ${captured.length} payments failed`);
    }
    return { queued };
  }

  /**
   * gap #33 — finance or support refunds one entry by hand: an injury, a
   * goodwill gesture, a refund the gateway kept failing. Bounded like every
   * refund by what is left of the payment, and idempotent on (payment,
   * reason, amount).
   */
  async function staffRefund(
    staff: { userId: string; role: string },
    input: { registrationId: string; amountPaise: bigint; reason: string },
  ): Promise<Refund> {
    if (!['admin', 'finance', 'support'].includes(staff.role)) {
      throw new SystemError('FORBIDDEN', 'Only PL4Y staff can issue a refund.');
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new UserError(PaymentCode.NOTHING_TO_REFUND, 'Say why this refund is being made.');
    }
    const payment = await repo.capturedPaymentFor(input.registrationId);
    if (!payment) {
      throw new UserError(PaymentCode.PAYMENT_NOT_FOUND, 'This entry has no payment that can be refunded.');
    }
    logger.info({ staff: staff.userId, registrationId: input.registrationId, reason }, 'staff refund');
    return refund(null, {
      paymentId: payment.id,
      amountPaise: input.amountPaise,
      reason: `staff:${reason}`,
      registrationId: input.registrationId,
    });
  }

  // --- reconciliation (R9) ---------------------------------------------------

  /**
   * R9 — Phase 1 work, not later hardening. It turns a lost webhook from a
   * support ticket into a thirty-minute delay.
   *
   * Every order still `created` or `attempted` after thirty minutes is checked
   * against the gateway, and the answer drives the state machine through the
   * same functions the webhook uses. There is no second confirmation path.
   */
  async function reconcilePending(): Promise<{ checked: number; resolved: number }> {
    const at = now().getTime();
    const cutoff = new Date(at - RECONCILE_AFTER_MS);
    const stale = await db.paymentOrder.findMany({
      where: {
        status: { in: ['created', 'attempted'] },
        createdAt: { gt: new Date(at - RECONCILE_ORDER_WINDOW_MS), lte: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    let resolved = 0;
    for (const order of stale) {
      try {
        if (await settleOrderFromGateway(order.gatewayOrderId)) {
          resolved += 1;
        }
        // Nothing at the gateway either: the player never went through with it.
        // The seat hold expires on its own schedule (registration R5).
      } catch (err) {
        logger.error({ err, orderId: order.id }, 'reconciliation failed for order');
      }
    }

    // Refunds sent but never settled: a missed or unsigned notice costs a
    // delay, not money.
    const unsettled = await db.refund.findMany({
      where: {
        status: 'pending',
        gatewayRefundId: { not: null },
        createdAt: { gt: new Date(at - RECONCILE_REFUND_WINDOW_MS), lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (const r of unsettled) {
      try {
        await checkRefund(r.gatewayRefundId!);
      } catch (err) {
        logger.error({ err, refundId: r.id }, 'refund reconciliation failed');
      }
    }

    // gap #15 — refunds decided but never handed to the gateway (the send job
    // was never queued). Queued again; sending is idempotent on the receipt.
    for (const r of await repo.unsentRefunds(new Date(at - RECONCILE_AFTER_MS))) {
      await queue.processRefund(r.id).catch((err: unknown) => {
        logger.error({ err, refundId: r.id }, 'failed to re-queue an unsent refund');
      });
    }

    return { checked: stale.length, resolved };
  }

  /** The dashboard number the doc asks for. Steady state is zero. */
  async function unreconciledCount(): Promise<number> {
    const cutoff = new Date(now().getTime() - RECONCILE_AFTER_MS);
    const [orders, webhooks] = await Promise.all([
      db.paymentOrder.count({
        where: { status: { in: ['created', 'attempted'] }, createdAt: { lt: cutoff } },
      }),
      repo.unprocessedWebhooks(cutoff),
    ]);
    return orders + webhooks;
  }

  // --- reads -----------------------------------------------------------------

  async function ledgerFor(registrationId: string): Promise<LedgerEntry[]> {
    return (await repo.ledgerFor(registrationId)).map(toLedger);
  }

  /**
   * R11 — built from `ledger_entries` on demand. There is no PDF, no bucket and
   * no signed file URL: the ledger is already the source of truth, so a stored
   * file would only be a second copy that can disagree with it.
   */
  async function receipt(actor: Actor, paymentId: string): Promise<Receipt> {
    const payment = await repo.paymentById(paymentId);
    if (!payment) {
      throw new UserError(PaymentCode.PAYMENT_NOT_FOUND, 'That payment could not be found.');
    }
    const order = await repo.orderById(payment.paymentOrderId);
    if (!order) {
      throw new UserError(PaymentCode.PAYMENT_NOT_FOUND, 'That payment could not be found.');
    }
    const payer = order.bookingId
      ? (await bookingsPort().byId(order.bookingId)).userId
      : (await registration.byId(order.registrationId!)).captainUserId;
    if (payer !== actor.userId) {
      throw new SystemError('FORBIDDEN', 'That receipt is not yours.');
    }

    const rows = await repo.ledgerForPayment(payment.id);
    // `charge` is the total the player paid; fee and tax are its breakdown, so
    // summing all three would bill them twice on their own receipt.
    const lines = rows
      .filter((r) => r.kind !== 'fee_reversal' && r.kind !== 'tax_reversal')
      .map((r) => ({ kind: r.kind, amountPaise: r.amountPaise }));
    const refunded = rows
      .filter((r) => r.kind === 'refund')
      .reduce((sum, r) => sum + -r.amountPaise, 0n);

    return {
      registrationId: order.registrationId ?? order.bookingId!,
      paymentId: payment.id,
      gatewayPaymentId: payment.gatewayPaymentId,
      method: payment.method,
      paidAt: payment.capturedAt,
      lines,
      totalPaise: order.amountPaise,
      refundedPaise: refunded,
      netPaise: order.amountPaise - refunded,
      currency: order.currency,
    };
  }

  async function paymentHistory(
    userId: string,
    page: { first: number; after?: string | null },
  ): Promise<{ nodes: (LedgerEntry & { registrationId: string })[]; hasNextPage: boolean; endCursor: string | null }> {
    const first = Math.min(Math.max(page.first, 1), 50);
    const rows = await repo.paymentsForUser(userId, {
      after: page.after ? { createdAt: new Date(0), id: page.after } : null,
      limit: first + 1,
    });
    const nodes = rows.slice(0, first).map((r) => ({
      id: 0n,
      kind: r.status,
      amountPaise: r.amountPaise,
      createdAt: r.capturedAt ?? r.createdAt,
      registrationId: r.registrationId,
    }));
    return {
      nodes,
      hasNextPage: rows.length > first,
      endCursor: rows[first - 1]?.id ?? null,
    };
  }

  // --- email (R12) -----------------------------------------------------------

  /**
   * R12 — payment emails go out from here, not from `notifications`. That
   * module owns the in-app feed and push; transactional email belongs to the
   * module that owns the action (ADR 0002). The outbox row written alongside
   * each movement is what keeps the in-app feed complete.
   */
  async function sendPaymentEmail(
    registrationId: string,
    kind: PaymentEmailKind,
    amountPaise: bigint,
    extra: { method?: string | null; reference?: string | null; at?: Date } = {},
  ): Promise<void> {
    try {
      const reg = await registration.byId(registrationId);
      const [user] = await users.byIds([reg.captainUserId]);
      if (!user) return;
      const event = await events.forEmail(reg.eventId);
      const facts = { to: user.email, kind, amountPaise, event, ...extra };
      await email.send({ to: user.email, ...paymentEmail(facts) });
    } catch (err) {
      // An email failure must never roll back money that already moved.
      logger.error({ err, registrationId, kind }, 'payment email failed');
    }
  }

  const toRefund = (r: {
    id: string;
    paymentId: string;
    amountPaise: bigint;
    reason: string;
    status: string;
    createdAt: Date;
    processedAt: Date | null;
  }): Refund => ({
    id: r.id,
    paymentId: r.paymentId,
    amountPaise: r.amountPaise,
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt,
    processedAt: r.processedAt,
  });

  const toLedger = (r: LedgerRow): LedgerEntry => ({
    id: r.id,
    kind: r.kind,
    amountPaise: r.amountPaise,
    createdAt: r.createdAt,
  });

  return {
    ledgerSummary: (eventIds: string[]) => repo.ledgerSummary(eventIds),
    createOrder,
    refreshPayment,
    createBookingOrder,
    refreshBookingPayment,
    refundForBooking,
    staffRefund,
    ingestWebhook,
    applyWebhook,
    refund,
    refundForRegistration,
    processRefund,
    checkRefund,
    bulkRefund,
    bulkRefundCategory,
    reconcilePending,
    unreconciledCount,
    ledgerFor,
    receipt,
    paymentHistory,
    pendingRefunds: () => repo.pendingRefunds(),
  };
}

/**
 * A normalised event carries bigints and Dates, which JSON does not. The
 * claimed row stores it with those turned into strings, and the job turns them
 * back.
 */
function storeEvent(event: GatewayWebhookEvent): object {
  return JSON.parse(
    JSON.stringify(event, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as object;
}

function loadEvent(payload: unknown): GatewayWebhookEvent {
  const e = payload as { id: string; type: string; providerType?: string };
  if (e.type === 'payment.captured' || e.type === 'payment.failed') {
    const p = (payload as { payment: Record<string, unknown> }).payment;
    return {
      id: e.id,
      type: e.type,
      payment: {
        ...(p as unknown as GatewayPayment),
        amountPaise: BigInt(p['amountPaise'] as string),
        capturedAt: p['capturedAt'] ? new Date(p['capturedAt'] as string) : null,
      },
    };
  }
  if (e.type === 'refund.processed' || e.type === 'refund.failed') {
    const r = (payload as { refund: { id: string; paymentId: string; amountPaise: string; status: string } }).refund;
    return { id: e.id, type: e.type, refund: { ...r, amountPaise: BigInt(r.amountPaise) } };
  }
  if (e.type === 'refund.check') {
    return {
      id: e.id,
      type: 'refund.check',
      gatewayRefundId: (payload as { gatewayRefundId: string }).gatewayRefundId,
    };
  }
  if (e.type === 'payment.check') {
    return {
      id: e.id,
      type: 'payment.check',
      gatewayOrderId: (payload as { gatewayOrderId: string }).gatewayOrderId,
      // Rows claimed before the status was carried read as 'other'.
      status: normaliseNoticeStatus((payload as { status?: unknown }).status),
    };
  }
  return { id: e.id, type: 'ignored', providerType: e.providerType ?? e.type };
}

function normaliseNoticeStatus(s: unknown): 'success' | 'failure' | 'other' {
  return s === 'success' || s === 'failure' ? s : 'other';
}

/**
 * bookings R6 — what goes back when a booking is cancelled: a share of the
 * court money and its tax, plus (venue cancellation) the platform fee and its
 * tax. Never more than was captured. Pure, so the cancel preview and the
 * refund agree to the paisa.
 */
export function bookingRefundAmount(input: {
  courtPaise: bigint;
  platformFeePaise: bigint;
  taxPaise: bigint;
  capturedPaise: bigint;
  courtShareBps: number;
  includePlatformFee: boolean;
}): bigint {
  const base = input.courtPaise + input.platformFeePaise;
  const courtTax = base > 0n ? (input.taxPaise * input.courtPaise) / base : 0n;
  const court = ((input.courtPaise + courtTax) * BigInt(input.courtShareBps)) / 10_000n;
  const fee = input.includePlatformFee ? input.platformFeePaise + (input.taxPaise - courtTax) : 0n;
  const total = court + fee;
  return total > input.capturedPaise ? input.capturedPaise : total;
}

function isIllegalTransition(err: unknown): boolean {

  return (err as { extensions?: { code?: unknown } } | null)?.extensions?.code === 'ILLEGAL_TRANSITION';
}

export { CURRENCY };
export type PaymentsService = ReturnType<typeof createPaymentsService>;
