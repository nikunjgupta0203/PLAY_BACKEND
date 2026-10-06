/**
 * payments — service tests against a real Postgres (conventions.md §5).
 *
 * This is the highest-risk module in the system, so the tests are written from
 * the outside in: the four "Done when" checks first, then one test per numbered
 * rule. The gateway is a fixture (`FakeGateway`), never the network,
 * but everything below it — the claim table's primary key, the refund
 * idempotency index, the ledger sums read inside a transaction — is real
 * Postgres, because those constraints are where the correctness actually lives.
 *
 * The webhook is the truth. Nothing here confirms a registration except a
 * signature-verified `payment.captured` or reconciliation (R5), and several of
 * the tests exist purely to keep a second path from growing one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import {
  buildModules,
  signWebhook,
  TEST_SIGNATURE_HEADER,
  webhookBody,
  type FakeEmail,
  type FakeQueue,
  type FakeGateway,
} from './helpers/modules.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import {
  ORDER_REUSE_MS,
  PaymentCode,
  RECONCILE_AFTER_MS,
  RECONCILE_ORDER_WINDOW_MS,
  RECONCILE_REFUND_WINDOW_MS,
} from '../src/modules/payments/service/index.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { GatewayPayment } from '../src/platform/paymentGateway.js';
import { GatewayError } from '../src/platform/paymentGateway.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let payments: PaymentsService;
let registration: RegistrationService;
let events: EventService;
let profile: ProfileService;
let sport: SportService;
let email: FakeEmail;
let gateway: FakeGateway;
let jobs: FakeQueue;
let pickleballId: string;

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

/** The category every test below is priced against: 500 + 50 entry/platform. */
const ENTRY_FEE = 50_000n;
const PLATFORM_FEE = 5_000n;
const TAX = 9_900n; // 18% of 55_000
const TOTAL = 64_900n;

interface Player {
  userId: string;
  playerId: string;
  email: string;
  actor: { userId: string };
}

let organizer: Player;

async function makePlayer(name: string, band = '3.5'): Promise<Player> {
  const userId = newId();
  const address = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({
    data: { playerId, sportId: pickleballId, skillBand: band },
  });
  return { userId, playerId, email: address, actor: { userId } };
}

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? 'THREW';
  }
  return 'NO_ERROR';
};

async function publishedCategory(
  overrides: { capacity?: number; entryFeePaise?: bigint; cancellationCutoffAt?: Date | null } = {},
): Promise<{ eventId: string; categoryId: string }> {
  const event = await events.create(organizer.actor, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `Open ${newId().slice(0, 8)}`,
    city: 'Bengaluru',
    startsAt: soon(30),
    endsAt: soon(31),
    registrationClosesAt: soon(25),
    cancellationCutoffAt: overrides.cancellationCutoffAt ?? soon(20),
  });
  const category = await events.addCategory(organizer.actor, event.id, {
    name: 'Test Draw',
    format: 'singles',
    capacity: overrides.capacity ?? 16,
    minEntries: 4,
    entryFeePaise: overrides.entryFeePaise ?? ENTRY_FEE,
    platformFeePaise: PLATFORM_FEE,
    taxBps: 1800,
    skillMin: null,
    skillMax: null,
  });
  await events.publish(organizer.actor, event.id);
  return { eventId: event.id, categoryId: category.id };
}

/**
 * A webhook as the gateway sends it: an event, serialised once, signed over
 * those bytes. Tests that care about R2/R3/R4 go through this rather than
 * writing the claim row by hand — the signature is half of what is under test.
 */
let webhookSeq = 0;
function envelope(
  type: string,
  payload: Record<string, unknown>,
): { raw: Buffer; signature: string; id: string } {
  webhookSeq += 1;
  const id = `evt_TEST${webhookSeq}`;
  const raw = Buffer.from(JSON.stringify(webhookBody({ id, type, ...payload })), 'utf8');
  return { raw, signature: signWebhook(raw), id };
}

const ingest = (raw: Buffer, signature: string) =>
  payments.ingestWebhook(raw, { [TEST_SIGNATURE_HEADER]: signature });

/** Ingest, then run the job ingest enqueued. The full production path. */
async function deliver(type: string, payload: Record<string, unknown>): Promise<string> {
  const { raw, signature, id } = envelope(type, payload);
  const result = await ingest(raw, signature);
  expect(result.status).toBe(200);
  if (!result.duplicate) await payments.applyWebhook(id);
  return id;
}

/** Registration → order → capture → confirmed, through the money path. */
async function payFor(
  player: Player,
  categoryId: string,
): Promise<{ registrationId: string; paymentId: string; gatewayPaymentId: string }> {
  const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
  const order = await payments.createOrder(player.actor, reg.id);
  const entity = gateway.capture(order.gatewayOrderId);
  await deliver('payment.captured', { payment: entity });
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { gatewayPaymentId: entity.id },
  });
  return { registrationId: reg.id, paymentId: payment.id, gatewayPaymentId: entity.id };
}

/** Ages a payment order so reconciliation considers it stale (R9). */
async function backdateOrder(gatewayOrderId: string, ms = RECONCILE_AFTER_MS + 60_000) {
  await prisma.paymentOrder.update({
    where: { gatewayOrderId },
    data: { createdAt: new Date(Date.now() - ms) },
  });
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  payments = wired.payments;
  registration = wired.registration;
  events = wired.events;
  profile = wired.profile;
  sport = wired.sport;
  email = wired.email;
  gateway = wired.gateway;
  jobs = wired.jobs;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  email.reset();
  gateway.reset();
  jobs.reset();
  webhookSeq = 0;
  organizer = await makePlayer('Organizer');
});

// ─────────────────────────────────────────────────────────────────────────────
// Done when
// ─────────────────────────────────────────────────────────────────────────────

describe('payments — Done when: a payment confirms an entry end to end', () => {
  it('a UPI capture takes an entry from payment_pending to confirmed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');

    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    expect(reg.status).toBe('payment_pending');

    const order = await payments.createOrder(player.actor, reg.id);
    expect(order.amountPaise).toBe(TOTAL);
    expect(order.checkout.action).toBe('https://gateway.test/checkout');
    expect(order.checkout.fields['order_id']).toBe(order.gatewayOrderId);
    expect(order.checkout.fields['receipt']).toBe(order.orderId);

    const entity = gateway.capture(order.gatewayOrderId, { method: 'upi' });
    await deliver('payment.captured', { payment: entity });

    const after = await registration.byId(reg.id);
    expect(after.status).toBe('confirmed');

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { gatewayPaymentId: entity.id },
    });
    expect(payment.status).toBe('captured');
    expect(payment.method).toBe('upi');
    expect(payment.amountPaise).toBe(TOTAL);
    expect(
      (await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.orderId } })).status,
    ).toBe('paid');
  });
});

describe('payments — Done when: duplicate delivery produces exactly one of everything', () => {
  it('five deliveries of the same capture write one payment, one ledger set, one push', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    const entity = gateway.capture(order.gatewayOrderId);

    // The gateway redelivers whenever our acknowledgement is slow. Same event id
    // five times is the normal case on a busy Saturday, not an edge case.
    const { raw, signature, id } = envelope('payment.captured', { payment: entity });
    for (let i = 0; i < 5; i += 1) {
      const result = await ingest(raw, signature);
      expect(result.status).toBe(200);
      expect(result.duplicate).toBe(i > 0);
      await payments.applyWebhook(id);
    }

    expect(await prisma.paymentWebhookEvent.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(3);
    expect(await prisma.outbox.count({ where: { topic: 'payment.captured' } })).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'registration.confirmed' } })).toBe(1);
    expect(email.to(player.email).filter((m) => m.subject.startsWith('You’re in'))).toHaveLength(1);
  });
});

describe('payments — Done when: a dropped webhook is resolved without a human', () => {
  it('reconcile-pending confirms an entry whose webhook never arrived', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Ghosted');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    // The money moved at the gateway. The webhook did not arrive — dropped in
    // transit, or our endpoint was down for the ninety seconds that mattered.
    gateway.capture(order.gatewayOrderId);
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');

    await backdateOrder(order.gatewayOrderId);
    const result = await payments.reconcilePending();

    expect(result).toEqual({ checked: 1, resolved: 1 });
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
    expect(await prisma.ledgerEntry.count({ where: { kind: 'charge' } })).toBe(1);
  });
});

describe('payments — Done when: the unreconciled count sits at zero', () => {
  it('a settled payment leaves nothing older than thirty minutes behind', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { registrationId } = await payFor(player, categoryId);

    // Age everything past the dashboard's window. A settled payment must still
    // report zero: the metric counts what is STUCK, not what is old.
    await prisma.paymentOrder.updateMany({
      data: { createdAt: new Date(Date.now() - RECONCILE_AFTER_MS - 60_000) },
    });
    await prisma.paymentWebhookEvent.updateMany({
      data: { receivedAt: new Date(Date.now() - RECONCILE_AFTER_MS - 60_000) },
    });

    expect(await payments.unreconciledCount()).toBe(0);
    expect((await registration.byId(registrationId)).status).toBe('confirmed');
  });

  it('an order stuck in created for over thirty minutes is counted', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Abandoner');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    expect(await payments.unreconciledCount()).toBe(0); // too young to count
    await backdateOrder(order.gatewayOrderId);
    expect(await payments.unreconciledCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

describe('payments', () => {
  it('R1: the order amount is recomputed from the quote, never supplied', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });

    const order = await payments.createOrder(player.actor, reg.id);

    // The signature has no amount parameter, which is what "ignored, not
    // validated" means in practice. What the gateway was asked for is the quote.
    expect(order.amountPaise).toBe(TOTAL);
    expect(order.quote).toEqual({
      entryFeePaise: ENTRY_FEE,
      platformFeePaise: PLATFORM_FEE,
      taxPaise: TAX,
      totalPaise: TOTAL,
      currency: 'INR',
    });
    expect(gateway.orders.get(order.gatewayOrderId)?.amountPaise).toBe(TOTAL);

    const row = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(row.entryFeePaise).toBe(ENTRY_FEE);
    expect(row.platformFeePaise).toBe(PLATFORM_FEE);
    expect(row.taxPaise).toBe(TAX);
  });

  it('R1, gap #12: a repriced draw is never charged at a price the player did not agree to', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const first = await payments.createOrder(player.actor, reg.id);

    // A double-tap on Pay reuses the open order rather than making two.
    const again = await payments.createOrder(player.actor, reg.id);
    expect(again.gatewayOrderId).toBe(first.gatewayOrderId);

    // The player agreed to the price frozen on their entry. A draw repriced
    // since then is a different deal: no order at either price, they start again.
    await prisma.eventCategory.update({
      where: { id: categoryId },
      data: { entryFeePaise: 100_000n },
    });
    expect(await errorCode(() => payments.createOrder(player.actor, reg.id))).toBe('PRICE_CHANGED');
    expect(gateway.orders.size).toBe(1);
  });

  it('R2: a bad signature is a 400 and nothing is written', async () => {
    const { raw } = envelope('payment.captured', { payment: { id: 'pay_X' } });

    const wrong = await ingest(raw, 'f'.repeat(64));
    expect(wrong).toEqual({ accepted: false, duplicate: false, status: 400 });

    // A signature of the wrong length must be rejected rather than throwing:
    // timingSafeEqual raises on a length mismatch, and an exception here would
    // be a 500, which makes the gateway retry a request that can never succeed.
    const short = await ingest(raw, 'deadbeef');
    expect(short.status).toBe(400);
    const absent = await ingest(raw, '');
    expect(absent.status).toBe(400);

    expect(await prisma.paymentWebhookEvent.count()).toBe(0);
    expect(jobs.applyWebhookCalls).toHaveLength(0);
  });

  it('R2: the signature is over the exact bytes transmitted', async () => {
    const { raw, signature } = envelope('payment.captured', { payment: null });

    // Re-serialising the same object produces different bytes in general, and
    // a signature over the re-serialised form must not verify. This is the
    // failure that presents as a credentials problem when a JSON parser is
    // mounted ahead of the webhook route (architecture.md §2).
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))) + ' ');
    expect((await ingest(reserialised, signature)).status).toBe(400);
    expect((await ingest(raw, signature)).status).toBe(200);
  });

  it('R3: a duplicate delivery inserts nothing and returns 200 immediately', async () => {
    const { raw, signature } = envelope('payment.captured', { payment: null });

    const first = await ingest(raw, signature);
    expect(first).toEqual({ accepted: true, duplicate: false, status: 200 });

    const second = await ingest(raw, signature);
    // 200, so the gateway stops retrying immediately rather than backing off over
    // the next day — and accepted, because it genuinely was.
    expect(second).toEqual({ accepted: true, duplicate: true, status: 200 });

    expect(await prisma.paymentWebhookEvent.count()).toBe(1);
    // The claim is what suppresses the second job, not the job's own guard.
    expect(jobs.applyWebhookCalls).toHaveLength(1);
  });

  it('R4: ingest enqueues the work and does none of it', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    const entity = gateway.capture(order.gatewayOrderId);
    const { raw, signature, id } = envelope('payment.captured', { payment: entity });

    await ingest(raw, signature);

    // Gateways time out within seconds and retries a slow success. Nothing
    // below happens on the request path.
    expect(jobs.applyWebhookCalls).toEqual([id]);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(0);
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');

    await payments.applyWebhook(id);
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
    expect(
      (await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { gatewayEventId: id } }))
        .processedAt,
    ).not.toBeNull();
  });

  it('R5: order.paid does not confirm anything — only payment.captured does', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    const entity = gateway.capture(order.gatewayOrderId);

    // Gateways send an order-level event too. Acting on both would
    // double-apply, so it is ignored on purpose — and ignoring it must not
    // confirm the entry.
    await deliver('order.paid', { order: { id: order.gatewayOrderId } });
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');
    expect(await prisma.payment.count()).toBe(0);

    await deliver('payment.captured', { payment: entity });
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
  });

  it('R5: a capture against an order we never created fails loudly', async () => {
    const entity: GatewayPayment = {
      id: 'pay_FOREIGN',
      orderId: 'order_FROM_ANOTHER_ENVIRONMENT',
      amountPaise: 64_900n,
      status: 'captured',
      method: null,
      failureReason: null,
      capturedAt: new Date(),
      raw: {},
    };
    const { raw, signature, id } = envelope('payment.captured', { payment: entity });
    await ingest(raw, signature);

    // Silence here would mean money arriving against nothing. The job throws,
    // The job queue retries, and a final failure pages someone.
    await expect(payments.applyWebhook(id)).rejects.toThrow(/No payment_order/);
    const row = await prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { gatewayEventId: id },
    });
    expect(row.processedAt).toBeNull();
    expect(row.lastError).toContain('No payment_order');
  });

  it('R6: every movement writes a ledger row', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { registrationId, paymentId, gatewayPaymentId } = await payFor(player, categoryId);

    const onCapture = await payments.ledgerFor(registrationId);
    expect(onCapture.map((l) => [l.kind, l.amountPaise])).toEqual(
      expect.arrayContaining([
        ['charge', TOTAL],
        ['platform_fee', PLATFORM_FEE],
        ['tax', TAX],
      ]),
    );
    expect(onCapture).toHaveLength(3);

    // A full refund debits the charge and reverses both components.
    const refund = await payments.refund(player.actor, {
      paymentId,
      amountPaise: TOTAL,
      reason: 'organizer cancelled',
    });
    await payments.processRefund(refund.id);
    const sent = gateway.refunds[0];
    expect(sent).toBeDefined();
    await deliver('refund.processed', {
      refund: {
        id: sent!.id,
        paymentId: gatewayPaymentId,
        amountPaise: TOTAL,
        status: 'processed',
      },
    });

    const settled = await payments.ledgerFor(registrationId);
    const byKind = Object.fromEntries(settled.map((l) => [l.kind, l.amountPaise]));
    expect(byKind['refund']).toBe(-TOTAL);
    expect(byKind['fee_reversal']).toBe(-PLATFORM_FEE);
    expect(byKind['tax_reversal']).toBe(-TAX);
    // Charge and refund cancel; the components cancel; the ledger nets to zero.
    expect(settled.reduce((sum, l) => sum + l.amountPaise, 0n)).toBe(0n);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
    ).toBe('refunded');
  });

  it('R6: a partial refund does not reverse the fee or the tax', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { registrationId, paymentId, gatewayPaymentId } = await payFor(player, categoryId);

    const refund = await payments.refund(player.actor, {
      paymentId,
      amountPaise: 10_000n,
      reason: 'partial goodwill',
    });
    await payments.processRefund(refund.id);
    await deliver('refund.processed', {
      refund: {
        id: gateway.refunds[0]!.id,
        paymentId: gatewayPaymentId,
        amountPaise: 10_000n,
        status: 'processed',
      },
    });

    const kinds = (await payments.ledgerFor(registrationId)).map((l) => l.kind);
    // Which component a partial refund came out of is a decision, and this
    // module does not get to guess it.
    expect(kinds).not.toContain('fee_reversal');
    expect(kinds).not.toContain('tax_reversal');
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
    ).toBe('partially_refunded');
  });

  it('R7: retrying the same refund never sends money twice', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId } = await payFor(player, categoryId);

    const args = { paymentId, amountPaise: 20_000n, reason: 'cancelled before cutoff' };
    const first = await payments.refund(player.actor, args);
    const second = await payments.refund(player.actor, args);

    expect(second.id).toBe(first.id);
    expect(await prisma.refund.count()).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { kind: 'refund' } })).toBe(1);

    // The gateway side of R7: the same idempotency key reaches the gateway once.
    await payments.processRefund(first.id);
    await payments.processRefund(second.id);
    expect(gateway.refunds).toHaveLength(1);
  });

  it('R7: an explicit idempotency key overrides the default', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId } = await payFor(player, categoryId);

    const args = { paymentId, amountPaise: 10_000n, reason: 'goodwill' };
    const first = await payments.refund(player.actor, args);
    const distinct = await payments.refund(player.actor, {
      ...args,
      idempotencyKey: 'second-goodwill-gesture',
    });

    // Same payment, same reason, same amount — deliberately a second refund,
    // because the caller said so.
    expect(distinct.id).not.toBe(first.id);
    expect(await prisma.refund.count()).toBe(2);
  });

  it('R8: a refund may never exceed captured minus already refunded', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId } = await payFor(player, categoryId);

    expect(
      await errorCode(() =>
        payments.refund(player.actor, {
          paymentId,
          amountPaise: TOTAL + 1n,
          reason: 'too much',
        }),
      ),
    ).toBe(PaymentCode.REFUND_EXCEEDS_CAPTURED);

    await payments.refund(player.actor, {
      paymentId,
      amountPaise: 60_000n,
      reason: 'most of it',
    });

    // The remaining headroom is 4_900, and the sum is read inside the
    // transaction, so the second refund is measured against the first.
    expect(
      await errorCode(() =>
        payments.refund(player.actor, {
          paymentId,
          amountPaise: 5_000n,
          reason: 'the rest and then some',
        }),
      ),
    ).toBe(PaymentCode.REFUND_EXCEEDS_CAPTURED);

    const ok = await payments.refund(player.actor, {
      paymentId,
      amountPaise: 4_900n,
      reason: 'exactly the rest',
    });
    expect(ok.amountPaise).toBe(4_900n);
    expect(await prisma.refund.count()).toBe(2);
  });

  it('R9: reconciliation drives a failure as well as a capture', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Declined');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.fail(order.gatewayOrderId, 'card declined');
    await backdateOrder(order.gatewayOrderId);

    const result = await payments.reconcilePending();

    expect(result.resolved).toBe(1);
    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
    // registration R8 — the hold outlives the failure so a retry keeps the slot.
    expect(await prisma.seatHold.count({ where: { releasedAt: null } })).toBe(1);
  });

  it('R9: an order younger than thirty minutes is left alone', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Deciding');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.capture(order.gatewayOrderId);

    // The player is still on the gateway screen. Reconciling now would race
    // the webhook for no reason.
    expect(await payments.reconcilePending()).toEqual({ checked: 0, resolved: 0 });
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');
  });

  it('R9: an abandoned order resolves nothing and is not an error', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Abandoner');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    await backdateOrder(order.gatewayOrderId);

    // Nothing at the gateway either: the player never went through with it, and
    // the seat hold expires on its own schedule (registration R5).
    expect(await payments.reconcilePending()).toEqual({ checked: 1, resolved: 0 });
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');
  });

  it('R10: the raw gateway payload is kept as evidence', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Disputer');
    const { paymentId, gatewayPaymentId } = await payFor(player, categoryId);

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    // Four months from now this payload is what settles the dispute.
    expect(row.raw).toMatchObject({ id: gatewayPaymentId, status: 'captured' });
  });

  it('R11: the receipt is rendered from the ledger, not stored', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId, gatewayPaymentId } = await payFor(player, categoryId);

    const receipt = await payments.receipt(player.actor, paymentId);

    expect(receipt.gatewayPaymentId).toBe(gatewayPaymentId);
    expect(receipt.totalPaise).toBe(TOTAL);
    expect(receipt.refundedPaise).toBe(0n);
    expect(receipt.netPaise).toBe(TOTAL);
    expect(receipt.currency).toBe('INR');
    // charge, platform_fee, tax — the breakdown, straight off the ledger rows.
    expect(receipt.lines.map((l) => l.kind).sort()).toEqual(['charge', 'platform_fee', 'tax']);
    expect(receipt.paidAt).toBeInstanceOf(Date);

    // There is no PDF, no bucket and no signed file URL. The only durable
    // artefacts are the ledger rows the receipt was built from.
    expect(Object.keys(receipt)).not.toContain('url');
    expect(await prisma.ledgerEntry.count()).toBe(3);
  });

  it('R11: a refund changes what the receipt says, because the ledger changed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId } = await payFor(player, categoryId);

    await payments.refund(player.actor, {
      paymentId,
      amountPaise: 20_000n,
      reason: 'partial',
    });

    const receipt = await payments.receipt(player.actor, paymentId);
    expect(receipt.refundedPaise).toBe(20_000n);
    expect(receipt.netPaise).toBe(TOTAL - 20_000n);
    expect(receipt.lines.map((l) => l.kind)).toContain('refund');
  });

  it('R11: a receipt belongs to the payer and nobody else', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const stranger = await makePlayer('Stranger');
    const { paymentId } = await payFor(player, categoryId);

    expect(await errorCode(() => payments.receipt(stranger.actor, paymentId))).toBe('FORBIDDEN');
  });

  it('R12: payment email and in-app feed row are written together', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    const failed = gateway.fail(order.gatewayOrderId, 'insufficient funds');
    await deliver('payment.failed', { payment: failed });

    // Transactional email is this module's job; the outbox row is what keeps
    // the in-app feed complete (ADR 0002).
    expect(
      email.to(player.email).some((m) => m.subject.startsWith('Payment didn’t go through')),
    ).toBe(true);
    expect(await prisma.outbox.count({ where: { topic: 'payment.failed' } })).toBe(1);
    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
  });

  it('R12: a processed refund emails the payer', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId, gatewayPaymentId } = await payFor(player, categoryId);
    email.reset();

    const refund = await payments.refund(player.actor, {
      paymentId,
      amountPaise: TOTAL,
      reason: 'organizer cancelled',
    });
    // The decision is recorded before the money moves; nothing is sent yet.
    expect(email.to(player.email)).toHaveLength(0);
    expect(jobs.processRefundCalls).toEqual([refund.id]);

    await payments.processRefund(refund.id);
    await deliver('refund.processed', {
      refund: {
        id: gateway.refunds[0]!.id,
        paymentId: gatewayPaymentId,
        amountPaise: TOTAL,
        status: 'processed',
      },
    });

    expect(email.to(player.email).some((m) => m.subject.startsWith('Refund on its way'))).toBe(
      true,
    );
    expect(await prisma.outbox.count({ where: { topic: 'refund.processed' } })).toBe(1);
  });

  it('a refund.failed leaves the refund pending, because we still owe the money', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId } = await payFor(player, categoryId);

    const refund = await payments.refund(player.actor, {
      paymentId,
      amountPaise: 10_000n,
      reason: 'goodwill',
    });
    await payments.processRefund(refund.id);
    await deliver('refund.failed', {
      refund: {
        id: gateway.refunds[0]!.id,
        paymentId: 'pay_whatever',
        amountPaise: 10_000n,
        status: 'failed',
      },
    });

    // Deliberately not marked `failed`: a refund we owe keeps showing up in the
    // pending list until a human or a retry clears it.
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe(
      'pending',
    );
    expect((await payments.pendingRefunds()).map((r) => r.id)).toContain(refund.id);
  });

  it('only the captain can create the order (registration R6)', async () => {
    const { categoryId } = await publishedCategory();
    const captain = await makePlayer('Captain');
    const stranger = await makePlayer('Stranger');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });

    expect(await errorCode(() => payments.createOrder(stranger.actor, reg.id))).toBe('FORBIDDEN');
  });

  it('the webhook lands before the client callback and the client is routed, not charged', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    // A gateway's webhook regularly beats its own client callback back to us.
    // The entry is already confirmed before the app has said anything at all —
    // the client is never part of the confirmation path (R5).
    const entity = gateway.capture(order.gatewayOrderId);
    await deliver('payment.captured', { payment: entity });
    expect((await registration.byId(reg.id)).status).toBe('confirmed');

    // Now the app comes back, having no idea. It must be routed to the paid
    // entry, not asked for money a second time.
    expect(await errorCode(() => payments.createOrder(player.actor, reg.id))).toBe(
      PaymentCode.ORDER_ALREADY_PAID,
    );
    expect(await prisma.paymentOrder.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('a gateway outage surfaces as GATEWAY_UNAVAILABLE, not a stack trace', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    gateway.failNext = true;

    expect(await errorCode(() => payments.createOrder(player.actor, reg.id))).toBe(
      PaymentCode.GATEWAY_UNAVAILABLE,
    );
    // Nothing half-written: no order row for an order the gateway never created.
    expect(await prisma.paymentOrder.count()).toBe(0);
  });

  it('an organizer cancellation refunds every confirmed entry, fee included', async () => {
    const { eventId, categoryId } = await publishedCategory();
    const one = await makePlayer('One');
    const two = await makePlayer('Two');
    await payFor(one, categoryId);
    await payFor(two, categoryId);

    const result = await payments.bulkRefund(eventId, 'event cancelled');

    expect(result.queued).toBe(2);
    const refunds = await prisma.refund.findMany();
    expect(refunds).toHaveLength(2);
    // The platform fee is absorbed when the organizer is the one cancelling.
    expect(refunds.every((r) => r.amountPaise === TOTAL)).toBe(true);
  });

  it('a player cancelling before the cutoff gets the entry fee back, not the platform fee', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { registrationId } = await payFor(player, categoryId);

    // registration R9 routes this through payments.refundForRegistration.
    await registration.cancel(player.actor, registrationId);

    const refund = await prisma.refund.findFirstOrThrow();
    // The platform fee is retained, as disclosed in the quote at checkout.
    // gap #16 — the platform fee is kept, and so is the tax on it: only the
    // entry fee's share of the tax goes back.
    expect(refund.amountPaise).toBe(ENTRY_FEE + (TAX * ENTRY_FEE) / (ENTRY_FEE + PLATFORM_FEE));
  });

  it('the payment history is the payer own payments, newest first', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const other = await makePlayer('Other');
    await payFor(player, categoryId);
    await payFor(other, categoryId);

    const page = await payments.paymentHistory(player.userId, { first: 20 });

    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]?.amountPaise).toBe(TOTAL);
    expect(page.hasNextPage).toBe(false);
  });
});

describe('payments — checkout forms, payment and refund checks', () => {
  it('a reused open order gets a fresh form for the same gateway order', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const first = await payments.createOrder(player.actor, reg.id);
    const again = await payments.createOrder(player.actor, reg.id);
    expect(again.gatewayOrderId).toBe(first.gatewayOrderId);
    expect(again.checkout.fields['order_id']).toBe(first.gatewayOrderId);
    expect(again.checkout.fields['receipt']).toBe(first.orderId);
  });

  it('the checkout form carries the payer from identity and the event title', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: player.actor.userId } });
    expect(order.checkout.fields['prefill_email']).toBe(user.email);
    expect(order.checkout.fields['prefill_name']).toBe(user.displayName);
    expect(order.checkout.fields['description']).toBeTruthy();
  });

  it('a refund.check notice settles the refund from the provider, not the notice', async () => {
    const { categoryId } = await publishedCategory();
    const { paymentId } = await payFor(await makePlayer('Payer'), categoryId);
    const refund = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });

    gateway.statuses.set(sent.gatewayRefundId!, 'pending');
    await deliver('refund.check', { gatewayRefundId: sent.gatewayRefundId });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('pending');

    gateway.statuses.set(sent.gatewayRefundId!, 'processed');
    await deliver('refund.check', { gatewayRefundId: sent.gatewayRefundId });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('processed');
  });

  it('a refund the gateway has never heard of is marked failed once, not polled forever (2026-10-05 e2e run)', async () => {
    const { categoryId } = await publishedCategory();
    const { paymentId } = await payFor(await makePlayer('Payer'), categoryId);
    const refund = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });

    const real = gateway.refundStatus.bind(gateway);
    gateway.refundStatus = async () => {
      // What the Razorpay adapter really throws: our 502, the provider's 404.
      throw new GatewayError(502, 'razorpay GET /refunds/x refused (HTTP 404): no description', 404);
    };
    try {
      await payments.checkRefund(sent.gatewayRefundId!);
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('failed');
      // Failed no longer counts against the payment: the money can be refunded again.
      const again = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'reissued' });
      expect(again.status).toBe('pending');
    } finally {
      gateway.refundStatus = real;
    }
  });

  it('payments R9: reconciliation settles a refund whose notice never came', async () => {
    const { categoryId } = await publishedCategory();
    const { paymentId } = await payFor(await makePlayer('Payer'), categoryId);
    const refund = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    gateway.statuses.set(sent.gatewayRefundId!, 'processed');
    await prisma.refund.update({
      where: { id: refund.id },
      data: { createdAt: new Date(Date.now() - RECONCILE_AFTER_MS - 60_000) },
    });
    await payments.reconcilePending();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('processed');
  });

  it('a payment.check notice confirms a captured order, and a second one changes nothing', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.capture(order.gatewayOrderId);

    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
    expect(await prisma.payment.count()).toBe(1);

    // A second, distinct payment.check notice for the same order must not
    // write a second payments row — upsertPayment is keyed on the gateway
    // payment id, which the gateway reports the same every time it is asked.
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });
    expect(await prisma.payment.count()).toBe(1);
  });

  it('a payment.check notice on a failed order is idempotent: one outbox row, one email', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Declined');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.fail(order.gatewayOrderId, 'card declined');

    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'failure' });
    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'payment.failed' } })).toBe(1);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('Payment didn’t go through')),
    ).toHaveLength(1);

    // Several distinct payment.check notices per order are normal for a
    // notice-only provider (each its own event id, so the webhook claim table
    // does not dedupe them). `failed` is not treated as terminal by
    // checkPayment (the same order can be retried), so this repeat DOES re-ask the gateway —
    // it just finds the same failed payment again, and applyFailure's own
    // first-application gate (on upsertPayment's `created`) is what keeps
    // the outbox row, the registration call and the email from doubling.
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'failure' });
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'payment.failed' } })).toBe(1);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('Payment didn’t go through')),
    ).toHaveLength(1);
  });

  it('a same-order capture after a failure confirms the entry while the hold lives: one charge set, one confirmation email', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Retried');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    gateway.fail(order.gatewayOrderId, 'card declined');
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'failure' });
    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
    // registration R8 — the hold outlives the failure.
    expect(await prisma.seatHold.count({ where: { registrationId: reg.id, releasedAt: null } })).toBe(1);

    // Checkout lets the player retry on the SAME order, and the gateway now
    // reports the order as captured.
    gateway.capture(order.gatewayOrderId);
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });

    expect((await registration.byId(reg.id)).status).toBe('confirmed');
    expect(await prisma.ledgerEntry.count({ where: { kind: 'charge' } })).toBe(1);
    expect(await prisma.refund.count()).toBe(0);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('You’re in')),
    ).toHaveLength(1);

    // A redelivery changes nothing and sends nothing.
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });
    expect(await prisma.ledgerEntry.count({ where: { kind: 'charge' } })).toBe(1);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('You’re in')),
    ).toHaveLength(1);
  });

  it('a second payment.check on a paid order is idempotent: one payment, one charge ledger set, one confirmation email', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { registrationId, paymentId } = await payFor(player, categoryId);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const order = await prisma.paymentOrder.findUniqueOrThrow({
      where: { id: payment.paymentOrderId },
    });

    // checkPayment has no status-based early return any more — a `paid`
    // order is asked about again just like any other. That is safe rather
    // than wasteful: applyCapture is first-application-gated on the
    // payment's own gateway id (unchanged since the order was captured, so
    // upsertPayment finds the existing row rather than creating one), and
    // registration.confirmFromPayment no-ops on an already-confirmed
    // registration. A repeat settles to the same state, not a duplicate.
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });

    expect((await registration.byId(registrationId)).status).toBe('confirmed');
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { kind: 'charge' } })).toBe(1);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('You’re in')),
    ).toHaveLength(1);
  });

  it('a capture on a registration that can no longer be confirmed is refunded in full, once, without throwing', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Late');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    gateway.fail(order.gatewayOrderId, 'card declined');
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'failure' });

    // The hold runs out and the entry expires.
    const hold = await prisma.seatHold.findFirstOrThrow({ where: { registrationId: reg.id } });
    await prisma.seatHold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await registration.expireHold(hold.id);
    expect((await registration.byId(reg.id)).status).toBe('expired');
    email.reset();

    // ...and only then does the same-order retry capture.
    gateway.capture(order.gatewayOrderId);
    const first = envelope('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });
    await ingest(first.raw, first.signature);
    await payments.applyWebhook(first.id);

    const row1 = await prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { gatewayEventId: first.id },
    });
    expect(row1.processedAt).not.toBeNull();
    expect((await registration.byId(reg.id)).status).toBe('expired');

    const captured = await prisma.payment.findFirstOrThrow({ where: { status: 'captured' } });
    const refunds = await prisma.refund.findMany();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      paymentId: captured.id,
      reason: 'late_capture',
      amountPaise: captured.amountPaise,
      idempotencyKey: `late_capture:${captured.id}`,
    });
    expect(jobs.processRefundCalls).toEqual([refunds[0]!.id]);
    // Never told "you are in" for an entry that is not.
    expect(email.to(player.email).filter((m) => m.subject.startsWith('You’re in'))).toHaveLength(0);

    // Redelivery: still no throw, still exactly one refund.
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });
    await payments.reconcilePending();
    expect(await prisma.refund.count()).toBe(1);
    expect(await prisma.payment.count({ where: { status: 'captured' } })).toBe(1);
  });

  it('a capture on a payment_failed entry whose hold already lapsed is refunded, not confirmed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Lapsed');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    gateway.fail(order.gatewayOrderId, 'card declined');
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'failure' });
    // The hold's TTL has passed but the release job has not run yet.
    await prisma.seatHold.updateMany({
      where: { registrationId: reg.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    gateway.capture(order.gatewayOrderId);
    await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });

    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
    expect(await prisma.refund.count({ where: { reason: 'late_capture' } })).toBe(1);
  });

  it('a signed success the gateway does not yet report is retried, not marked processed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Early');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    // verify_payment has nothing final yet.
    const notice = envelope('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'success' });
    await ingest(notice.raw, notice.signature);
    await expect(payments.applyWebhook(notice.id)).rejects.toThrow();
    const row = await prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { gatewayEventId: notice.id },
    });
    expect(row.processedAt).toBeNull();
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');

    // The job's retry, once the gateway catches up, settles it.
    gateway.capture(order.gatewayOrderId);
    await payments.applyWebhook(notice.id);
    expect(
      (await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { gatewayEventId: notice.id } }))
        .processedAt,
    ).not.toBeNull();
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
  });

  it('a payment notice with a non-final status and nothing at the gateway is simply processed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Pending');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);

    const id = await deliver('payment.check', { gatewayOrderId: order.gatewayOrderId, status: 'other' });
    expect(
      (await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { gatewayEventId: id } }))
        .processedAt,
    ).not.toBeNull();
  });

  it('a refund notice for a refund we never sent writes nothing and enqueues nothing', async () => {
    const { raw, signature } = envelope('refund.check', { gatewayRefundId: 'rfnd_UNKNOWN' });
    expect(await ingest(raw, signature)).toEqual({ accepted: true, duplicate: false, status: 200 });
    expect(await prisma.paymentWebhookEvent.count()).toBe(0);
    expect(jobs.applyWebhookCalls).toEqual([]);
  });

  it('checkRefund for an unknown refund never asks the gateway', async () => {
    await payments.checkRefund('rfnd_NEVER_SENT');
    expect(gateway.refundStatusCalls).toBe(0);
  });

  it('a refund settled twice writes one set of reversals, one outbox row and one email', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const { paymentId, gatewayPaymentId } = await payFor(player, categoryId);
    email.reset();
    const refund = await payments.refund(null, { paymentId, amountPaise: TOTAL, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const gatewayRefundId = gateway.refunds[0]!.id;
    const body = {
      refund: { id: gatewayRefundId, paymentId: gatewayPaymentId, amountPaise: TOTAL, status: 'processed' },
    };

    // Two distinct notices applied together, as two workers would.
    const a = envelope('refund.processed', body);
    const b = envelope('refund.processed', body);
    await ingest(a.raw, a.signature);
    await ingest(b.raw, b.signature);
    await Promise.all([payments.applyWebhook(a.id), payments.applyWebhook(b.id)]);
    // And once more after both have settled.
    await deliver('refund.processed', body);

    expect(await prisma.ledgerEntry.count({ where: { kind: 'fee_reversal' } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { kind: 'tax_reversal' } })).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'refund.processed' } })).toBe(1);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('Refund on its way')),
    ).toHaveLength(1);
  });

  it('R9: an order older than the reconciliation window is no longer asked about', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Ancient');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.capture(order.gatewayOrderId);
    await backdateOrder(order.gatewayOrderId, RECONCILE_ORDER_WINDOW_MS + 60_000);

    expect(await payments.reconcilePending()).toEqual({ checked: 0, resolved: 0 });
    expect((await registration.byId(reg.id)).status).toBe('payment_pending');
  });

  it('R9: an order just inside the reconciliation window is still asked about', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Recent');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.capture(order.gatewayOrderId);
    await backdateOrder(order.gatewayOrderId, RECONCILE_ORDER_WINDOW_MS - 60_000);

    expect(await payments.reconcilePending()).toEqual({ checked: 1, resolved: 1 });
  });

  it('R9: a pending refund older than the refund window is no longer asked about', async () => {
    const { categoryId } = await publishedCategory();
    const { paymentId } = await payFor(await makePlayer('Payer'), categoryId);
    const refund = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    gateway.statuses.set(sent.gatewayRefundId!, 'processed');
    await prisma.refund.update({
      where: { id: refund.id },
      data: { createdAt: new Date(Date.now() - RECONCILE_REFUND_WINDOW_MS - 60_000) },
    });
    gateway.refundStatusCalls = 0;

    await payments.reconcilePending();
    expect(gateway.refundStatusCalls).toBe(0);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('pending');
  });

  it('a failed attempt reported after the captured one changes nothing: the order stays paid, no failure email', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Retrier');
    const { registrationId } = await payFor(player, categoryId);
    const order = await prisma.paymentOrder.findFirstOrThrow({ where: { registrationId } });

    // Attempt 1 failed inside checkout before attempt 2 was captured, and its
    // notice is delivered last: webhooks do not arrive in order.
    const failed = gateway.fail(order.gatewayOrderId, 'UPI app declined');
    await deliver('payment.failed', { payment: failed });

    expect((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('paid');
    expect((await registration.byId(registrationId)).status).toBe('confirmed');
    // Recorded as evidence, and nothing else.
    expect(await prisma.payment.count({ where: { status: 'failed' } })).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'payment.failed' } })).toBe(0);
    expect(
      email.to(player.email).filter((m) => m.subject.startsWith('Payment didn’t go through')),
    ).toHaveLength(0);
  });

  it('an open order older than the reuse window is replaced by a new one; a fresh one is reused', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Returning');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const first = await payments.createOrder(player.actor, reg.id);
    expect((await payments.createOrder(player.actor, reg.id)).gatewayOrderId).toBe(first.gatewayOrderId);

    // A retry after dismissing or failing checkout gets its own order.
    await backdateOrder(first.gatewayOrderId, ORDER_REUSE_MS + 1_000);
    const later = await payments.createOrder(player.actor, reg.id);
    expect(later.gatewayOrderId).not.toBe(first.gatewayOrderId);
    // The old order stays behind for reconciliation.
    expect(await prisma.paymentOrder.count({ where: { registrationId: reg.id } })).toBe(2);
  });

  it('a gateway error building the checkout form is GATEWAY_UNAVAILABLE, not a 500', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    gateway.failCheckoutNext = true;

    expect(await errorCode(() => payments.createOrder(player.actor, reg.id))).toBe(
      PaymentCode.GATEWAY_UNAVAILABLE,
    );
  });
});

describe('payments — gap review fixes (2026-10-03)', () => {
  it('gap #21: a second payment for an entry already paid is refunded in full', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Twice');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const first = await payments.createOrder(player.actor, reg.id);
    // The player came back to Pay after the reuse window: a second order.
    await backdateOrder(first.gatewayOrderId, ORDER_REUSE_MS + 1_000);
    const second = await payments.createOrder(player.actor, reg.id);
    expect(second.gatewayOrderId).not.toBe(first.gatewayOrderId);

    await deliver('payment.captured', { payment: gateway.capture(second.gatewayOrderId) });
    // ...and then approves the old UPI request too.
    const late = gateway.capture(first.gatewayOrderId, { id: 'pay_OLD_UPI' });
    await deliver('payment.captured', { payment: late });

    expect((await registration.byId(reg.id)).status).toBe('confirmed');
    const latePayment = await prisma.payment.findUniqueOrThrow({ where: { gatewayPaymentId: 'pay_OLD_UPI' } });
    const refunds = await prisma.refund.findMany();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ paymentId: latePayment.id, amountPaise: TOTAL, reason: 'duplicate_payment' });

    // Redelivery changes nothing.
    await deliver('payment.captured', { payment: late });
    expect(await prisma.refund.count()).toBe(1);
  });

  it('gap #22: refreshPayment confirms a paid entry whose webhook never came', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Quiet');
    const stranger = await makePlayer('Stranger');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    gateway.capture(order.gatewayOrderId); // captured at the gateway; no webhook

    expect(await errorCode(() => payments.refreshPayment(stranger.actor, reg.id))).toBe('FORBIDDEN');
    expect(await payments.refreshPayment(player.actor, reg.id)).toEqual({ settled: true });
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
  });

  it('gap #22: opening an order keeps the seat held while the player pays', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Slow');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await payments.createOrder(player.actor, reg.id);
    const hold = await prisma.seatHold.findFirstOrThrow({ where: { registrationId: reg.id } });
    expect(hold.expiresAt.getTime()).toBeGreaterThan(Date.now() + 15 * 60_000);
  });

  it('gap #13: no order for an entry that is not waiting to pay', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Gone');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await registration.cancel(player.actor, reg.id);
    expect(await errorCode(() => payments.createOrder(player.actor, reg.id))).toBe(PaymentCode.NOT_PAYABLE);
    expect(gateway.orders.size).toBe(0);
  });

  it('gap #14: a capture after the hold ran out (release job not yet run) is refunded, not confirmed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Late');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    await prisma.seatHold.updateMany({
      where: { registrationId: reg.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await deliver('payment.captured', { payment: gateway.capture(order.gatewayOrderId) });

    expect((await registration.byId(reg.id)).status).toBe('payment_pending');
    expect(await prisma.refund.findFirstOrThrow()).toMatchObject({ amountPaise: TOTAL, reason: 'late_capture' });
  });

  it('gap #2, #34: an organizer cancellation closes out every entry and refunds every payment, withdrawn ones too', async () => {
    const { eventId, categoryId } = await publishedCategory({ cancellationCutoffAt: soon(-1) });
    const stays = await makePlayer('Stays');
    const left = await makePlayer('Left');
    const staying = await payFor(stays, categoryId);
    const leaving = await payFor(left, categoryId);
    // Withdrew after the cutoff: no refund, because the event was still on.
    await registration.cancel(left.actor, leaving.registrationId);
    expect(await prisma.refund.count()).toBe(0);

    // event.cancelled, as the worker runs it.
    await registration.closeOutCancelled(categoryId);
    await payments.bulkRefund(eventId, 'event_cancelled');

    expect((await registration.byId(staying.registrationId)).status).toBe('refunded');
    expect((await registration.byId(leaving.registrationId)).status).toBe('withdrawn');
    const refunds = await prisma.refund.findMany();
    expect(refunds.map((r) => r.paymentId).sort()).toEqual([staying.paymentId, leaving.paymentId].sort());
    expect(refunds.every((r) => r.amountPaise === TOTAL)).toBe(true);

    // The job running again sends nothing twice.
    await payments.bulkRefund(eventId, 'event_cancelled');
    expect(await prisma.refund.count()).toBe(2);
  });

  it('gap #3: a payment landing after the draw was cancelled is refunded, never confirmed', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Mid-pay');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    await prisma.eventCategory.update({ where: { id: categoryId }, data: { status: 'cancelled' } });
    await registration.closeOutCancelled(categoryId);

    await deliver('payment.captured', { payment: gateway.capture(order.gatewayOrderId) });

    expect((await registration.byId(reg.id)).status).toBe('expired');
    expect(await prisma.refund.findFirstOrThrow()).toMatchObject({ amountPaise: TOTAL, reason: 'late_capture' });
  });

  it('gap #15: a refund the gateway fails is sent again, and marked failed after the last try', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Bounced');
    const { paymentId } = await payFor(player, categoryId);
    const refund = await payments.refund(player.actor, { paymentId, amountPaise: 10_000n, reason: 'goodwill' });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      jobs.processRefundCalls = [];
      await payments.processRefund(refund.id);
      const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      await deliver('refund.failed', {
        refund: { id: row.gatewayRefundId ?? '', paymentId: 'pay_x', amountPaise: 10_000n, status: 'failed' },
      });
      const after = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      if (attempt < 3) {
        expect(after).toMatchObject({ status: 'pending', attempts: attempt, gatewayRefundId: null });
        expect(jobs.processRefundCalls).toEqual([refund.id]);
      } else {
        expect(after).toMatchObject({ status: 'failed', attempts: 3 });
      }
    }
  });

  it('gap #15: a refund saved but never queued is queued again by reconciliation', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Stranded');
    const { paymentId } = await payFor(player, categoryId);
    const refund = await payments.refund(player.actor, { paymentId, amountPaise: 10_000n, reason: 'goodwill' });
    await prisma.refund.update({
      where: { id: refund.id },
      data: { createdAt: new Date(Date.now() - RECONCILE_AFTER_MS - 60_000) },
    });
    jobs.processRefundCalls = [];

    await payments.reconcilePending();
    expect(jobs.processRefundCalls).toContain(refund.id);
  });
});
