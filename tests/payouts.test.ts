/**
 * payouts — service tests against a real Postgres (conventions.md §5), with a
 * scripted provider. Spec: docs/superpowers/specs/2026-10-02-host-payouts-design.md.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { TEST_SIGNATURE_HEADER, buildModules, signWebhook, webhookBody, type FakeQueue, type FakeGateway } from './helpers/modules.js';
import { FakePayouts, exists } from './helpers/payouts.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { PayoutsService, Staff } from '../src/modules/payments/service/payouts.js';
import { DETAILS_WINDOW, PayoutCode, VERIFY_RETRY_DELAYS_MS } from '../src/modules/payments/service/payouts.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let payouts: PayoutsService;
let payments: PaymentsService;
let registration: RegistrationService;
let events: EventService;
let profile: ProfileService;
let sport: SportService;
let provider: FakePayouts;
let gateway: FakeGateway;
let jobs: FakeQueue;
let notified: { userId: string; key: string; payload: Record<string, string | null> }[];
let alerts: string[];
let pickleballId: string;

const finance: Staff = { userId: '00000000-0000-7000-8000-000000000001', role: 'finance' };
const support: Staff = { userId: '00000000-0000-7000-8000-000000000002', role: 'support' };
const RAHUL = { legalName: 'Rahul Sharma', pan: 'ABCPS1234K', accountNumber: '51234567890', ifsc: 'HDFC0001098' };

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? 'THREW';
  }
  return 'NO_ERROR';
};

async function makeUser(name: string): Promise<{ userId: string; playerId: string }> {
  const userId = newId();
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: `${userId}@example.com`, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  return { userId, playerId };
}

/** Staff are real platform_staff rows: the gate reads the table, never a shortcut. */
async function seedStaff(): Promise<void> {
  for (const s of [finance, support]) {
    await prisma.user.create({ data: { id: s.userId, email: `${s.role}@pl4y.test`, displayName: s.role } });
    await prisma.platformStaff.create({ data: { userId: s.userId, role: s.role } });
  }
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  payouts = wired.payouts;
  payments = wired.payments;
  registration = wired.registration;
  events = wired.events;
  profile = wired.profile;
  sport = wired.sport;
  provider = wired.payoutProvider;
  gateway = wired.gateway;
  jobs = wired.jobs;
  notified = wired.payoutNotices;
  alerts = wired.payoutAlerts;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  // reviewed_by is a foreign key, and the publish gate reads platform_staff.
  await seedStaff();
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  provider.checks = [];
  provider.transferAnswers = [];
  provider.statuses.clear();
  provider.verified = [];
  provider.transfers = [];
  provider.balance = 1_000_000_000n;
  provider.manual = false;
  provider.calls = [];
  jobs.reset();
  notified.length = 0;
  alerts.length = 0;
});

describe('payouts R1, R2 — saving bank details', () => {
  it('stores sealed details, masks them, and queues the bank check', async () => {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, { ...RAHUL, pan: ' abcps1234k ', ifsc: 'hdfc0001098' });
    expect(view).toMatchObject({ status: 'checking', panMasked: 'XXXXXX234K', accountMasked: 'XXXXXXX7890', ifsc: 'HDFC0001098', panSurnameOk: true });

    const row = await prisma.payoutAccount.findFirstOrThrow({ where: { userId: host.userId } });
    expect(Buffer.from(row.panCipher).toString('utf8')).not.toContain('ABCPS1234K');
    expect(Buffer.from(row.accountCipher).toString('utf8')).not.toContain('51234567890');
    expect(jobs.added.map((j) => j.name)).toContain('verify-payout-account');
  });

  it.each([
    [{ pan: 'ABCPS12345' }, PayoutCode.INVALID_PAN],
    [{ pan: 'ABCCS1234K' }, PayoutCode.PAN_NOT_INDIVIDUAL],
    [{ ifsc: 'HDFC1001098' }, PayoutCode.INVALID_IFSC],
    [{ accountNumber: '1234' }, PayoutCode.INVALID_ACCOUNT_NUMBER],
    [{ legalName: ' ' }, PayoutCode.INVALID_NAME],
  ])('refuses %o with %s and saves nothing', async (patch, code) => {
    const host = await makeUser('Rahul Sharma');
    expect(await errorCode(() => payouts.saveAccount(host, { ...RAHUL, ...patch }))).toBe(code);
    expect(await prisma.payoutAccount.count()).toBe(0);
    expect(jobs.added).toHaveLength(0);
  });

  it(`allows ${DETAILS_WINDOW.max} saves a day`, async () => {
    const host = await makeUser('Rahul Sharma');
    for (let i = 0; i < DETAILS_WINDOW.max; i++) await payouts.saveAccount(host, RAHUL);
    expect(await errorCode(() => payouts.saveAccount(host, RAHUL))).toBe(PayoutCode.PAYOUT_DETAILS_RATE_LIMITED);
  });

  it('replacing details restarts the check (R7)', async () => {
    const host = await makeUser('Rahul Sharma');
    const first = await payouts.saveAccount(host, RAHUL);
    provider.checks.push(exists(96));
    await payouts.verifyAccount(first.id);
    const again = await payouts.saveAccount(host, { ...RAHUL, accountNumber: '99887766554' });
    expect(again).toMatchObject({ id: first.id, status: 'checking', accountMasked: 'XXXXXXX6554', nameMatch: null });
  });
});

describe('payouts R3, R4 — the bank check', () => {
  async function saved(patch: Partial<typeof RAHUL> = {}) {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, { ...RAHUL, ...patch });
    return { host, id: view.id };
  }

  it('verifies a strong match and tells the host', async () => {
    const { host, id } = await saved();
    provider.checks.push(exists(96));
    await payouts.verifyAccount(id);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'verified', nameMatch: 96, bankNameReturned: 'RAHUL SHARMA' });
    expect(provider.verified[0]).toMatchObject({ accountNumber: '51234567890', name: 'Rahul Sharma' });
    expect(notified).toContainEqual({ userId: host.userId, key: 'payout_account.status', payload: { status: 'verified', reason: null } });
  });

  it('sends a surname mismatch to review on a perfect bank match', async () => {
    const { host, id } = await saved({ pan: 'ABCPK1234K' });
    provider.checks.push(exists(100));
    await payouts.verifyAccount(id);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'needs_review', statusReason: 'pan_surname_mismatch' });
  });

  it('rejects a missing account with words the host can act on', async () => {
    const { host, id } = await saved();
    provider.checks.push({ outcome: 'missing', nameAtBank: null, nameMatch: null, error: 'Invalid account' });
    await payouts.verifyAccount(id);
    const view = await payouts.myAccount(host.userId);
    expect(view?.status).toBe('rejected');
    expect(view?.statusReason).toMatch(/account number and IFSC/);
  });

  it('retries a pending check on 5 min, 30 min, 2 h, then asks a person', async () => {
    const { host, id } = await saved();
    for (const delay of VERIFY_RETRY_DELAYS_MS) {
      provider.checks.push({ outcome: 'pending', nameAtBank: null, nameMatch: null, error: null });
      jobs.reset();
      await payouts.verifyAccount(id);
      expect(jobs.added).toEqual([expect.objectContaining({ name: 'verify-payout-account', delayMs: delay })]);
    }
    provider.checks.push({ outcome: 'pending', nameAtBank: null, nameMatch: null, error: null });
    jobs.reset();
    await payouts.verifyAccount(id);
    expect(jobs.added).toHaveLength(0);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'needs_review', statusReason: 'bank_check_inconclusive' });
  });

  it('treats a provider outage like a pending answer', async () => {
    const { id } = await saved();
    jobs.reset();
    await payouts.verifyAccount(id); // FakePayouts throws: nothing scripted
    expect(jobs.added).toEqual([expect.objectContaining({ name: 'verify-payout-account', delayMs: VERIFY_RETRY_DELAYS_MS[0] })]);
  });

  it('ignores a stale job for an account no longer checking', async () => {
    const { id } = await saved();
    provider.checks.push(exists(96));
    await payouts.verifyAccount(id);
    await payouts.verifyAccount(id);
    expect(provider.verified).toHaveLength(1);
  });
});

describe('payouts R6 — staff review', () => {
  async function inReview() {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, { ...RAHUL, pan: 'ABCPK1234K' });
    provider.checks.push(exists(100));
    await payouts.verifyAccount(view.id);
    return { host, id: view.id };
  }

  it('lists the queue for support but lets only admin and finance decide', async () => {
    const { id } = await inReview();
    expect((await payouts.accountsForReview(support)).map((a) => a.id)).toEqual([id]);
    expect(await errorCode(() => payouts.approveAccount(support, id))).toBe('FORBIDDEN');
  });

  it('approves, recording who and when', async () => {
    const { host, id } = await inReview();
    expect(await payouts.approveAccount(finance, id)).toMatchObject({ status: 'verified' });
    const row = await prisma.payoutAccount.findUniqueOrThrow({ where: { id } });
    expect(row.reviewedBy).toBe(finance.userId);
    expect(notified.at(-1)).toEqual({ userId: host.userId, key: 'payout_account.status', payload: { status: 'verified', reason: null } });
  });

  it('rejects and suspends with a reason, and reinstates', async () => {
    const { id } = await inReview();
    expect(await payouts.rejectAccount(finance, id, 'PAN belongs to someone else')).toMatchObject({ status: 'rejected', statusReason: 'PAN belongs to someone else' });
    await payouts.approveAccount(finance, id);
    expect(await payouts.suspendAccount(finance, id, 'chargebacks')).toMatchObject({ status: 'suspended' });
    expect(await payouts.reinstateAccount(finance, id)).toMatchObject({ status: 'verified' });
  });
});

describe('payouts R5 — the paid publish gate', () => {
  it('says what is missing until the account is verified', async () => {
    const host = await makeUser('Rahul Sharma');
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['no account'] });
    const view = await payouts.saveAccount(host, RAHUL);
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['checking'] });
    provider.checks.push(exists(96));
    await payouts.verifyAccount(view.id);
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: true, missing: [] });
  });

  it('lets platform staff publish without an account', async () => {
    expect(await payouts.canPublishPaid(finance.userId)).toEqual({ ok: true, missing: [] });
  });
});

// --- settlement (R8–R15) ------------------------------------------------------

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

/** A webhook as the gateway sends it, ingested and applied: the full production path. */
let webhookSeq = 0;
async function deliver(type: string, payload: Record<string, unknown>): Promise<void> {
  webhookSeq += 1;
  const id = `evt_PAYOUT${webhookSeq}`;
  const raw = Buffer.from(JSON.stringify(webhookBody({ id, type, ...payload })), 'utf8');
  const result = await payments.ingestWebhook(raw, { [TEST_SIGNATURE_HEADER]: signWebhook(raw) });
  expect(result.status).toBe(200);
  if (!result.duplicate) await payments.applyWebhook(id);
}

/** The gateway confirms a refund: `refund.processed` writes any reversal rows. */
async function settleRefund(refundId: string): Promise<void> {
  await payments.processRefund(refundId);
  const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
  await deliver('refund.processed', {
    refund: { id: row.gatewayRefundId, paymentId: row.payment.gatewayPaymentId, amountPaise: row.amountPaise, status: 'processed' },
  });
}

/** A player withdraws: the entry fee and tax back, the platform fee kept. */
const withdraw = (registrationId: string) =>
  payments.refundForRegistration({ registrationId, reason: 'withdrawn', refundAmount: true });

/**
 * A published paid event by `existing` (a fresh verified host when null) with
 * `entries` paid entries.
 */
async function hostedEventFor(existing: { userId: string; playerId: string } | null, entries = 2) {
  let host = existing;
  let accountId: string;
  if (host) {
    accountId = (await payouts.myAccount(host.userId))!.id;
  } else {
    host = await makeUser('Rahul Sharma');
    const account = await payouts.saveAccount(host, RAHUL);
    provider.checks.push(exists(96));
    await payouts.verifyAccount(account.id);
    accountId = account.id;
  }

  const actor = { userId: host.userId };
  const event = await events.create(actor, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `Open ${newId().slice(-8)}`,
    city: 'Bengaluru',
    startsAt: soon(30),
    endsAt: soon(31),
    registrationClosesAt: soon(25),
    cancellationCutoffAt: soon(20),
  });
  const category = await events.addCategory(actor, event.id, {
    name: 'Open',
    format: 'singles',
    capacity: 16,
    minEntries: 4,
    entryFeePaise: 50_000n,
    platformFeePaise: 5_000n,
    taxBps: 1800,
    skillMin: null,
    skillMax: null,
  });
  await events.publish(actor, event.id);

  const regs: string[] = [];
  for (let i = 0; i < entries; i++) {
    const player = await makeUser(`Player ${i}`);
    await prisma.playerSport.create({ data: { playerId: player.playerId, sportId: pickleballId, skillBand: '3.5' } });
    const reg = await registration.begin({ userId: player.userId }, { eventCategoryId: category.id });
    const order = await payments.createOrder({ userId: player.userId }, reg.id);
    await deliver('payment.captured', { payment: gateway.capture(order.gatewayOrderId) });
    regs.push(reg.id);
  }
  // F3 — an event a payout settles has to show it happened; one check-in does.
  if (regs[0]) {
    await prisma.registration.update({ where: { id: regs[0] }, data: { status: 'checked_in', checkedInAt: new Date() } });
  }
  return { host, accountId, eventId: event.id, regs };
}

const hostedEvent = (entries = 2) => hostedEventFor(null, entries);

/** Ends the event and moves the clock past the settlement delay (a week for a host's first payout, F3). */
async function endAndComeDue(eventId: string) {
  await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date(Date.now() - 8 * DAY) } });
  return payouts.scheduleForEvent(eventId);
}

describe('payouts R8, R9, R11 — settling an event', () => {
  it('schedules once: a week after a host’s first event ends (F3), 72 h after later ones', async () => {
    const { host, eventId } = await hostedEvent();
    await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date('2026-10-10T10:00:00Z') } });
    const first = await payouts.scheduleForEvent(eventId);
    const again = await payouts.scheduleForEvent(eventId);
    expect(first?.dueAt.toISOString()).toBe('2026-10-17T10:00:00.000Z');
    expect(again?.id).toBe(first?.id);
    expect(await prisma.payout.count()).toBe(1);

    await prisma.payout.update({ where: { id: first!.id }, data: { status: 'paid', amountPaise: 90_000n } });
    const next = await hostedEventFor(host);
    await prisma.event.update({ where: { id: next.eventId }, data: { endsAt: new Date('2026-11-10T10:00:00Z') } });
    expect((await payouts.scheduleForEvent(next.eventId))?.dueAt.toISOString()).toBe('2026-11-13T10:00:00.000Z');
  });

  it('schedules nothing for a free event', async () => {
    const { eventId } = await hostedEvent(0);
    expect(await payouts.scheduleForEvent(eventId)).toBeNull();
  });

  it('sends the entry fees less 10% to the verified account, and writes the ledger', async () => {
    const { host, eventId } = await hostedEvent(2);
    const scheduled = await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });

    const p = await prisma.payout.findUniqueOrThrow({ where: { id: scheduled!.id } });
    expect(p).toMatchObject({ status: 'sending', amountPaise: 90_000n, commissionPaise: 10_000n, transferRef: p.id });
    expect(provider.transfers).toEqual([{ ref: p.id, amountPaise: 90_000n, accountNumber: '51234567890', mode: 'IMPS' }]);

    const ledger = await prisma.ledgerEntry.findMany({ where: { payoutId: p.id } });
    expect(Object.fromEntries(ledger.map((l) => [l.kind, l.amountPaise]))).toEqual({
      host_commission: 10_000n,
      host_payout: -90_000n,
    });

    provider.succeed(p.id);
    expect(await payouts.checkPayout(p.id)).toBe('paid');
    expect(notified.at(-1)).toMatchObject({ userId: host.userId, key: 'payout.status', payload: { state: 'paid', amountPaise: '90000' } });
  });

  it('does not touch a payout before it is due', async () => {
    const { eventId } = await hostedEvent();
    await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date() } });
    await payouts.scheduleForEvent(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 0 });
  });

  it('pays NEFT above the IMPS ceiling', async () => {
    const { eventId } = await hostedEvent(1);
    await prisma.eventCategory.updateMany({ where: { eventId }, data: { commissionBps: 0 } });
    await prisma.ledgerEntry.updateMany({ where: { kind: 'charge' }, data: { amountPaise: 60_014_900n } });
    await endAndComeDue(eventId);
    await payouts.settleDue();
    expect(provider.transfers[0]?.mode).toBe('NEFT');
  });
});

describe('payouts R10, R7 — holds', () => {
  it('holds while the account is not verified, and releases once it is', async () => {
    const { host, accountId, eventId } = await hostedEvent();
    await payouts.saveAccount(host, { ...RAHUL, accountNumber: '99887766554' }); // back to checking
    const p = await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ status: 'held', holdReason: 'account_not_verified' });
    expect(provider.transfers).toHaveLength(0);

    provider.checks.push(exists(96));
    await payouts.verifyAccount(accountId);
    // gap #25 — new details on an account that was verified wait 48 hours.
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({
      holdReason: 'account_changed_recently',
    });
    await prisma.payoutAccount.update({
      where: { id: accountId },
      data: { detailsChangedAt: new Date(Date.now() - 49 * 3_600_000) },
    });
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
    expect(provider.transfers[0]?.accountNumber).toBe('99887766554');
  });

  it('holds while a refund for the event is pending', async () => {
    const { eventId, regs } = await hostedEvent();
    await withdraw(regs[0]!);
    await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
  });

  it('a staff hold is released only by staff', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.holdPayout(finance, p!.id, 'fraud review');
    // The portal's list shows what the host would get, not the zero a never-sent payout stores.
    expect((await payouts.payoutsNeedingAttention(support))[0]).toMatchObject({ id: p!.id, status: 'held', amountPaise: 90_000n });
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 0 });
    expect(await errorCode(() => payouts.holdPayout(support, p!.id, 'x'))).toBe('FORBIDDEN');
    await payouts.releasePayout(finance, p!.id);
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
  });

  it('refuses to release a payout that is not held', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    expect(await errorCode(() => payouts.releasePayout(finance, p!.id))).toBe(PayoutCode.PAYOUT_NOT_HELD);
  });
});

describe('payouts R12 — funding', () => {
  it('waits for funds, alerts finance, and sends once topped up', async () => {
    const { eventId } = await hostedEvent();
    provider.balance = 10_000n;
    await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 1 });
    expect(alerts).toHaveLength(1);
    provider.balance = 1_000_000n;
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
  });
});

describe('payouts R11, R13 — exactly once', () => {
  it('concurrent sends move a payout to sending once', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    const results = await Promise.all([payouts.sendPayout(p!.id), payouts.sendPayout(p!.id), payouts.sendPayout(p!.id)]);
    // Every caller sees the payout in flight; only one of them put it there.
    expect(results).toEqual(['sending', 'sending', 'sending']);
    expect(provider.transfers).toHaveLength(1);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ attempts: 1 });
    expect(await prisma.ledgerEntry.count({ where: { payoutId: p!.id, kind: 'host_payout' } })).toBe(1);
  });

  it('timeout after acceptance sends once', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    provider.transferAnswers.push('timeout');
    expect(await payouts.sendPayout(p!.id)).toBe('sending');
    // The sweep and a webhook both look; neither sends again.
    await payouts.settleDue();
    await payouts.checkPayout(p!.id);
    expect(provider.transfers).toHaveLength(1);
    provider.succeed(p!.id);
    expect(await payouts.checkPayout(p!.id)).toBe('paid');
  });

  it('a refused transfer fails, reverses the ledger and alerts', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    provider.transferAnswers.push({ accepted: false, error: 'beneficiary bank down' });
    expect(await payouts.sendPayout(p!.id)).toBe('failed');
    const sum = await prisma.ledgerEntry.aggregate({ where: { payoutId: p!.id }, _sum: { amountPaise: true } });
    expect(sum._sum.amountPaise).toBe(0n);
    expect(alerts.at(-1)).toMatch(/failed/);
  });

  it('a reversed transfer fails and sends the account back to review', async () => {
    const { accountId, eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.sendPayout(p!.id);
    provider.fail(p!.id, 'reversed');
    expect(await payouts.checkPayout(p!.id)).toBe('failed');
    expect(await prisma.payoutAccount.findUniqueOrThrow({ where: { id: accountId } })).toMatchObject({ status: 'needs_review' });
  });

  it('staff retry uses a new merchantRefId', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    provider.transferAnswers.push({ accepted: false, error: 'x' });
    await payouts.sendPayout(p!.id);
    expect(await errorCode(() => payouts.retryPayout(support, p!.id))).toBe('FORBIDDEN');
    await payouts.retryPayout(finance, p!.id);
    expect(provider.transfers.map((t) => t.ref)).toEqual([p!.id, `${p!.id}-r2`]);
  });

  it('refuses to retry a payout that has not failed', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    expect(await errorCode(() => payouts.retryPayout(finance, p!.id))).toBe(PayoutCode.PAYOUT_NOT_FAILED);
  });

  it('the stale-sending sweep asks the provider about old transfers', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.sendPayout(p!.id);
    await prisma.payout.update({ where: { id: p!.id }, data: { sentAt: new Date(Date.now() - 31 * 60_000) } });
    provider.succeed(p!.id);
    expect(await payouts.sweepSending()).toBe(1);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ status: 'paid' });
  });

  it('a webhook for an unknown ref changes nothing', async () => {
    await expect(payouts.checkByRef('not-ours')).resolves.toBeUndefined();
  });
});

describe('payouts R15 — refunds after payout', () => {
  it('a refund after the host was paid becomes a receivable netted from the next payout', async () => {
    const first = await hostedEvent(2);
    const p1 = await endAndComeDue(first.eventId);
    await payouts.sendPayout(p1!.id);
    provider.succeed(p1!.id);
    await payouts.checkPayout(p1!.id);

    const refund = await withdraw(first.regs[0]!);
    await settleRefund(refund!.id);
    await payouts.onRefundProcessed(refund!.id);
    const receivable = await prisma.ledgerEntry.findFirstOrThrow({ where: { kind: 'host_receivable' } });
    expect(receivable.amountPaise).toBe(45_000n); // the ₹500 entry fee less its 10%

    // A second event by the same host pays 45_000 less.
    const second = await hostedEventFor(first.host, 2);
    const p2 = await endAndComeDue(second.eventId);
    await payouts.sendPayout(p2!.id);
    expect(provider.transfers.at(-1)?.amountPaise).toBe(90_000n - 45_000n);
  });

  it('a refund before the payout is sent is simply in the quote', async () => {
    const { eventId, regs } = await hostedEvent(2);
    const refund = await withdraw(regs[0]!);
    await settleRefund(refund!.id);
    await payouts.onRefundProcessed(refund!.id);
    expect(await prisma.ledgerEntry.count({ where: { kind: 'host_receivable' } })).toBe(0);
    await endAndComeDue(eventId);
    await payouts.settleDue();
    expect(provider.transfers[0]?.amountPaise).toBe(45_000n);
  });
});

describe('payouts R16 — account deletion', () => {
  it('blocks deletion while the host owes a receivable', async () => {
    const { payoutsDeletionGuard } = await import('../src/modules/payments/service/payouts.js');
    const first = await hostedEvent(1);
    const p = await endAndComeDue(first.eventId);
    await payouts.sendPayout(p!.id);
    provider.succeed(p!.id);
    await payouts.checkPayout(p!.id);
    expect(await payoutsDeletionGuard(prisma as never)(first.host.userId)).toEqual([]);
    await prisma.ledgerEntry.create({ data: { payoutId: p!.id, kind: 'host_receivable', amountPaise: 100n } });
    expect(await payoutsDeletionGuard(prisma as never)(first.host.userId)).toEqual(['OPEN_HOST_RECEIVABLE']);
  });

  it('blocks deletion while a payout is still owed', async () => {
    const { payoutsDeletionGuard } = await import('../src/modules/payments/service/payouts.js');
    const { host, eventId } = await hostedEvent(1);
    await endAndComeDue(eventId);
    expect(await payoutsDeletionGuard(prisma as never)(host.userId)).toEqual(['PAYOUT_OWED']);
  });
});

describe('payouts — gap review fixes (2026-10-03)', () => {
  it('gap #24: a suspended host cannot re-save details to lift the suspension', async () => {
    const host = await makeUser('Rahul Sharma');
    const account = await payouts.saveAccount(host, RAHUL);
    provider.checks.push(exists(96));
    await payouts.verifyAccount(account.id);
    await payouts.suspendAccount(finance, account.id, 'fake event reports');

    expect(await errorCode(() => payouts.saveAccount(host, RAHUL))).toBe('PAYOUT_ACCOUNT_SUSPENDED');
    expect((await payouts.myAccount(host.userId))?.status).toBe('suspended');
  });

  it('gap #25: verified details replaced under a different legal name go to a person', async () => {
    const host = await makeUser('Rahul Sharma');
    const account = await payouts.saveAccount(host, RAHUL);
    provider.checks.push(exists(96));
    await payouts.verifyAccount(account.id);

    // Same surname initial, so the PAN check alone would let it through.
    await payouts.saveAccount(host, { ...RAHUL, legalName: 'Ravi Shetty', accountNumber: '61234567890' });
    provider.checks.push(exists(96));
    await payouts.verifyAccount(account.id);

    const after = await payouts.myAccount(host.userId);
    expect(after).toMatchObject({ status: 'needs_review', statusReason: 'legal_name_changed' });
    expect(notified.some((n) => n.userId === host.userId && /changed/.test(n.payload['reason'] ?? ''))).toBe(true);
  });

  it('gap #23: a cancelled event pays the host nothing while any player is still owed', async () => {
    const { eventId } = await hostedEvent();
    await prisma.event.update({ where: { id: eventId }, data: { status: 'cancelled' } });
    const p = await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({
      status: 'held',
      holdReason: 'cancelled_event_unrefunded',
    });
    expect(provider.transfers).toHaveLength(0);
  });

  it('gap #16: a host who owes PL4Y money cannot publish paid events until it is settled', async () => {
    const { host, accountId } = await hostedEvent();
    expect((await payouts.canPublishPaid(host.userId)).ok).toBe(true);
    // A refund after a payout left this host owing 450.
    const payout = await prisma.payout.create({
      data: { id: newId(), eventId: (await prisma.event.findFirstOrThrow()).id, payoutAccountId: accountId, dueAt: new Date(), status: 'paid' },
    });
    await prisma.ledgerEntry.create({ data: { payoutId: payout.id, kind: 'host_receivable', amountPaise: 45_000n } });

    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['money owed to PL4Y'] });
  });
});

describe('gap #16 — a host pays back what they owe', () => {
  /** A host paid ₹900 for two entries, then one player refunded: they owe PL4Y ₹450. */
  async function owingHost() {
    const ev = await hostedEvent(2);
    const p = await endAndComeDue(ev.eventId);
    await payouts.sendPayout(p!.id);
    provider.succeed(p!.id);
    await payouts.checkPayout(p!.id);
    const refund = await withdraw(ev.regs[0]!);
    await settleRefund(refund!.id);
    await payouts.onRefundProcessed(refund!.id);
    return ev;
  }

  it('records part and full repayments, then lets the host publish paid events again', async () => {
    const { host, accountId } = await owingHost();
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['money owed to PL4Y'] });
    expect(await payouts.openReceivables(support)).toEqual([{ payoutAccountId: accountId, userId: host.userId, openPaise: 45_000n }]);

    const pay = (amountPaise: bigint, utr = '412345678901') => payouts.recordRepayment(finance, accountId, { amountPaise, utr });
    expect(await errorCode(() => payouts.recordRepayment(support, accountId, { amountPaise: 1n, utr: '412345678901' }))).toBe('FORBIDDEN');
    expect(await errorCode(() => pay(10_000n, 'x'))).toBe(PayoutCode.INVALID_UTR);
    expect(await errorCode(() => pay(45_001n))).toBe(PayoutCode.REPAYMENT_TOO_LARGE);
    expect(await errorCode(() => pay(0n))).toBe(PayoutCode.REPAYMENT_TOO_LARGE);

    expect(await pay(20_000n)).toEqual({ openPaise: 25_000n });
    expect((await payouts.canPublishPaid(host.userId)).ok).toBe(false);
    expect(await pay(25_000n, 'UPI 5202 6100 5999')).toEqual({ openPaise: 0n });
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: true, missing: [] });
    expect(await payouts.openReceivables(support)).toEqual([]);
    expect(await errorCode(() => pay(1n))).toBe(PayoutCode.NOTHING_OWED);

    // Repaid, so their next payout takes nothing off.
    const next = await hostedEventFor(host, 2);
    const p2 = await endAndComeDue(next.eventId);
    await payouts.sendPayout(p2!.id);
    expect(provider.transfers.at(-1)?.amountPaise).toBe(90_000n);
  });

  it('two people recording the same repayment at once take the debt off once', async () => {
    const { accountId } = await owingHost();
    const results = await Promise.all(
      [1, 2].map(() => errorCode(() => payouts.recordRepayment(finance, accountId, { amountPaise: 45_000n, utr: '412345678901' }))),
    );
    expect(results.sort()).toEqual(['NOTHING_OWED', 'NO_ERROR']);
    expect(await payouts.openReceivables(finance)).toEqual([]);
  });
});

describe('payouts R15 — refunds while a transfer is in flight', () => {
  it('a refund during a transfer that then fails is taken once when the payout is retried', async () => {
    const { regs, eventId } = await hostedEvent(2);
    const p = await endAndComeDue(eventId);
    await payouts.sendPayout(p!.id);
    const refund = await withdraw(regs[0]!);
    await settleRefund(refund!.id);
    await payouts.onRefundProcessed(refund!.id);
    expect(await prisma.ledgerEntry.count({ where: { kind: 'host_receivable' } })).toBe(1);

    provider.fail(p!.id);
    expect(await payouts.checkPayout(p!.id)).toBe('failed');
    await payouts.retryPayout(finance, p!.id);
    // The refund is in the new quote; the receivable it wrote is undone, not netted again.
    expect(provider.transfers.at(-1)).toMatchObject({ ref: `${p!.id}-r2`, amountPaise: 45_000n });
  });
});

describe('manual payouts (PAYOUT_PROVIDER=manual)', () => {
  const UTR = '412345678901';

  /** A verified host's paid event, ended and due, with the provider switched to manual. */
  async function readyPayout(entries = 2) {
    const ev = await hostedEvent(entries);
    provider.manual = true;
    provider.calls = [];
    const p = await endAndComeDue(ev.eventId);
    return { ...ev, payoutId: p!.id };
  }

  it('sends saved bank details straight to a person, with no bank check', async () => {
    provider.manual = true;
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, RAHUL);
    expect(view).toMatchObject({ status: 'needs_review', statusReason: 'manual_review' });
    expect(jobs.added).toHaveLength(0);
    expect(provider.calls).toEqual([]);
    expect(notified).toContainEqual({ userId: host.userId, key: 'payout_account.status', payload: { status: 'needs_review', reason: null } });
    expect((await payouts.accountsForReview(support)).map((a) => a.id)).toEqual([view.id]);
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: false, missing: ['needs review'] });

    await payouts.approveAccount(finance, view.id);
    expect(await payouts.canPublishPaid(host.userId)).toEqual({ ok: true, missing: [] });
  });

  it('a bank check queued before the switch goes to a person instead', async () => {
    const host = await makeUser('Rahul Sharma');
    const view = await payouts.saveAccount(host, RAHUL);
    provider.manual = true;
    await payouts.verifyAccount(view.id);
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'needs_review', statusReason: 'manual_review' });
    expect(provider.calls).toEqual([]);
  });

  it('replaced verified details go back to review, and the host is warned', async () => {
    const { host } = await hostedEvent(0);
    provider.manual = true;
    await payouts.saveAccount(host, { ...RAHUL, accountNumber: '99887766554' });
    expect(await payouts.myAccount(host.userId)).toMatchObject({ status: 'needs_review', statusReason: 'manual_review' });
    expect(notified.at(-1)?.payload).toMatchObject({ status: 'needs_review', reason: expect.stringMatching(/changed/) });
  });

  it('a due payout waits in Ready to pay, its amount frozen, and no provider is asked', async () => {
    const { payoutId } = await readyPayout();
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
    const row = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
    expect(row).toMatchObject({ status: 'sending', providerStatus: 'manual', amountPaise: 90_000n, transferRef: payoutId });
    expect(alerts).toEqual(['Host payout ready to pay']);
    const ledger = await prisma.ledgerEntry.findMany({ where: { payoutId } });
    expect(Object.fromEntries(ledger.map((l) => [l.kind, l.amountPaise]))).toEqual({ host_commission: 10_000n, host_payout: -90_000n });

    // Later runs, the stale sweep and a status check all leave it alone.
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 0 });
    await prisma.payout.update({ where: { id: payoutId }, data: { sentAt: new Date(Date.now() - 2 * DAY) } });
    expect(await payouts.sweepSending()).toBe(0);
    expect(await payouts.checkPayout(payoutId)).toBe('sending');
    expect(provider.calls).toEqual([]);
    expect(alerts).toHaveLength(1);

    expect(await payouts.payoutsToPay(finance)).toEqual([
      expect.objectContaining({ id: payoutId, toPayByHand: true, amountPaise: 90_000n, utr: null }),
    ]);
    // Support sees the list; only admin and finance can pay from it or see the full account.
    expect((await payouts.payoutsToPay(support)).map((p) => p.id)).toEqual([payoutId]);
  });

  it('mark paid checks the UTR and the amount, tells the host, and happens once', async () => {
    const { host, payoutId } = await readyPayout();
    await payouts.settleDue();
    const mark = (utr: string, amountPaise = 90_000n) => payouts.markPaid(finance, payoutId, { utr, amountPaise });

    expect(await errorCode(() => payouts.markPaid(support, payoutId, { utr: UTR, amountPaise: 90_000n }))).toBe('FORBIDDEN');
    expect(await errorCode(() => mark('x1'))).toBe(PayoutCode.INVALID_UTR);
    expect(await errorCode(() => mark('UTR/123456'))).toBe(PayoutCode.INVALID_UTR);
    expect(await errorCode(() => mark(UTR, 9_000n))).toBe(PayoutCode.PAYOUT_AMOUNT_MISMATCH);
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({ status: 'sending' });

    const paid = await mark(' hdfcn5202610 05-12345 ');
    expect(paid).toMatchObject({ status: 'paid', utr: 'HDFCN52026100512345', toPayByHand: false });
    expect(notified.at(-1)).toEqual({
      userId: host.userId,
      key: 'payout.status',
      payload: { eventTitle: expect.any(String), state: 'paid', amountPaise: '90000', utr: 'HDFCN52026100512345' },
    });
    expect(await payouts.payoutsToPay(finance)).toEqual([]);
    expect(await errorCode(() => mark('HDFCN52026100512345'))).toBe(PayoutCode.PAYOUT_NOT_READY);
    expect((await payouts.myPayouts(host.userId, { first: 5, after: null })).nodes[0]).toMatchObject({
      status: 'paid',
      utr: 'HDFCN52026100512345',
    });
    expect(provider.calls).toEqual([]);
  });

  it('two people marking the same payout paid at once record one payment', async () => {
    const { payoutId } = await readyPayout();
    await payouts.settleDue();
    const results = await Promise.all(
      [1, 2, 3].map(() => errorCode(() => payouts.markPaid(finance, payoutId, { utr: UTR, amountPaise: 90_000n }))),
    );
    expect(results.filter((r) => r === 'NO_ERROR')).toHaveLength(1);
    expect(results.filter((r) => r === PayoutCode.PAYOUT_NOT_READY)).toHaveLength(2);
    expect(notified.filter((n) => n.key === 'payout.status')).toHaveLength(1);
  });

  it('refuses a UTR already recorded on another payout', async () => {
    const a = await readyPayout();
    const b = await hostedEventFor(a.host, 2);
    const pb = await endAndComeDue(b.eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 2, held: 0, waiting: 0 });
    await payouts.markPaid(finance, a.payoutId, { utr: UTR, amountPaise: 90_000n });
    expect(await errorCode(() => payouts.markPaid(finance, pb!.id, { utr: '4123 4567 8901', amountPaise: 90_000n }))).toBe(
      PayoutCode.UTR_ALREADY_USED,
    );
  });

  it('a refund after the payout is ready is owed back; the amount to send never changes', async () => {
    const { host, regs, payoutId } = await readyPayout();
    await payouts.settleDue();
    const refund = await withdraw(regs[0]!);
    await settleRefund(refund!.id);
    await payouts.onRefundProcessed(refund!.id);
    expect((await payouts.payoutsToPay(finance))[0]?.amountPaise).toBe(90_000n);
    expect(await prisma.ledgerEntry.findFirstOrThrow({ where: { kind: 'host_receivable' } })).toMatchObject({ amountPaise: 45_000n, payoutId });
    await payouts.markPaid(finance, payoutId, { utr: UTR, amountPaise: 90_000n });

    // The host's next payout is 45_000 less.
    const second = await hostedEventFor(host, 2);
    const p2 = await endAndComeDue(second.eventId);
    await payouts.settleDue();
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p2!.id } })).toMatchObject({
      status: 'sending',
      amountPaise: 45_000n,
      receivablesPaise: 45_000n,
    });
  });

  it('hold takes a payout out of Ready to pay; release quotes it again with the refund counted once', async () => {
    const { regs, payoutId } = await readyPayout();
    await payouts.settleDue();
    const refund = await withdraw(regs[0]!);
    await settleRefund(refund!.id);
    await payouts.onRefundProcessed(refund!.id);

    expect(await errorCode(() => payouts.holdPayout(support, payoutId, 'host disputed'))).toBe('FORBIDDEN');
    const held = await payouts.holdPayout(finance, payoutId, 'host disputed the result');
    expect(held).toMatchObject({ status: 'held', holdReason: 'host disputed the result', toPayByHand: false });
    const sum = await prisma.ledgerEntry.aggregate({ where: { payoutId }, _sum: { amountPaise: true } });
    expect(sum._sum.amountPaise).toBe(0n);
    expect(await payouts.payoutsToPay(finance)).toEqual([]);
    expect(await errorCode(() => payouts.markPaid(finance, payoutId, { utr: UTR, amountPaise: 90_000n }))).toBe(PayoutCode.PAYOUT_NOT_READY);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 0, waiting: 0 });

    await payouts.releasePayout(finance, payoutId);
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })).toMatchObject({
      status: 'sending',
      providerStatus: 'manual',
      amountPaise: 45_000n,
      receivablesPaise: 0n,
      transferRef: `${payoutId}-r2`,
    });
    expect(provider.calls).toEqual([]);
  });

  it('automatic holds still apply: new details wait for approval and 48 hours, then the payout is ready', async () => {
    const { host, accountId, eventId } = await hostedEvent();
    provider.manual = true;
    provider.calls = [];
    await payouts.saveAccount(host, { ...RAHUL, accountNumber: '99887766554' });
    await endAndComeDue(eventId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });

    await payouts.approveAccount(finance, accountId);
    expect(await payouts.settleDue()).toEqual({ sent: 0, held: 1, waiting: 0 });
    await prisma.payoutAccount.update({
      where: { id: accountId },
      data: { detailsChangedAt: new Date(Date.now() - 49 * 3_600_000) },
    });
    expect(await payouts.settleDue()).toEqual({ sent: 1, held: 0, waiting: 0 });

    expect(await payouts.accountDetails(finance, accountId)).toMatchObject({
      accountNumber: '99887766554',
      ifsc: 'HDFC0001098',
      legalName: 'Rahul Sharma',
      status: 'verified',
    });
    expect(await errorCode(() => payouts.accountDetails(support, accountId))).toBe('FORBIDDEN');
    expect(provider.calls).toEqual([]);
  });

  it('a payout ready by hand survives a switch back to a provider: nobody asks about it, staff still mark it', async () => {
    const { payoutId } = await readyPayout();
    await payouts.settleDue();
    provider.manual = false;
    await prisma.payout.update({ where: { id: payoutId }, data: { sentAt: new Date(Date.now() - 2 * DAY) } });
    expect(await payouts.sweepSending()).toBe(0);
    expect(await payouts.checkPayout(payoutId)).toBe('sending');
    expect(provider.calls).toEqual([]);
    expect(await payouts.markPaid(finance, payoutId, { utr: UTR, amountPaise: 90_000n })).toMatchObject({ status: 'paid' });
  });

  it('a payout a provider is sending cannot be marked paid by hand, nor held', async () => {
    const { eventId } = await hostedEvent();
    const p = await endAndComeDue(eventId);
    await payouts.sendPayout(p!.id);
    expect(await errorCode(() => payouts.markPaid(finance, p!.id, { utr: UTR, amountPaise: 90_000n }))).toBe(PayoutCode.PAYOUT_NOT_READY);
    // The money may already be gone, so a staff hold still refuses it.
    expect(await errorCode(() => payouts.holdPayout(finance, p!.id, 'stop it now'))).toBe(PayoutCode.PAYOUT_NOT_HELD);
  });
});
