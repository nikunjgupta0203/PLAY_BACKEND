/** The ONLY surface other modules may import (conventions.md §1). */
import { config } from '../../platform/config.js';
import { createSecretBox, type SecretBox } from '../../platform/crypto/secretBox.js';
import { db } from '../../platform/db.js';
import { email } from '../../platform/email.js';
import { SystemError } from '../../platform/errors/index.js';
import { logger } from '../../platform/logging/index.js';
import { paymentGateway } from '../../platform/paymentGateway.js';
import { payoutProvider } from '../../platform/payouts/index.js';
import { QUEUES, defaultJobOptions, queue } from '../../platform/queue.js';
import { consume } from '../../platform/rateLimit.js';
import { events, placeOf } from '../events/index.js';
import { createPaymentsRepo } from './repo/index.js';
import { createPayoutsRepo } from './repo/payouts.js';
import { createPaymentsService, type RegistrationPort } from './service/index.js';
import { payoutAlertEmail } from './service/paymentEmail.js';
import { createPayoutsService } from './service/payouts.js';

/**
 * registration and payments call each other: registration asks for an order and
 * a refund, payments tells registration a payment landed. Both edges are narrow
 * service calls (conventions.md §1) and both resolve lazily, so the ESM cycle
 * never closes at module scope.
 */
const registration: RegistrationPort = {
  async byId(registrationId) {
    const { registration: svc } = await import('../registration/index.js');
    return svc.byId(registrationId);
  },
  async confirmFromPayment(input) {
    const { registration: svc } = await import('../registration/index.js');
    return svc.confirmFromPayment(input);
  },
  async failFromPayment(input) {
    const { registration: svc } = await import('../registration/index.js');
    return svc.failFromPayment(input);
  },
  async extendHold(registrationId, minutes) {
    const { registration: svc } = await import('../registration/index.js');
    return svc.extendHold(registrationId, minutes);
  },
};

export const payments = createPaymentsService({
  db,
  repo: createPaymentsRepo(db),
  gateway: paymentGateway,
  events: {
    priceQuote: (categoryId) => events.priceQuote(categoryId),
    byId: async (eventId) => {
      const event = await events.byId(eventId);
      return { id: event.id, title: event.title };
    },
    forEmail: async (eventId) => {
      const event = await events.byId(eventId);
      return { title: event.title, startsAt: event.startsAt, timezone: event.timezone, place: await placeOf(event) };
    },
  },
  registration,
  // payments R20 — court bookings pay the same way (19-bookings R2).
  bookings: {
    async byId(bookingId) {
      const { bookings } = await import('../bookings/index.js');
      return bookings.forPayments(bookingId);
    },
    async extendHold(bookingId, minutes) {
      const { bookings } = await import('../bookings/index.js');
      return bookings.extendHold(bookingId, minutes);
    },
    async confirmFromPayment(input) {
      const { bookings } = await import('../bookings/index.js');
      return bookings.confirmFromPayment(input);
    },
    async failFromPayment(input) {
      const { bookings } = await import('../bookings/index.js');
      return bookings.failFromPayment(input);
    },
  },
  users: {
    async byIds(ids) {
      const { identity } = await import('../identity/index.js');
      return identity.contactsByIds(ids);
    },
  },
  email,
  // gap #15, #16, #21 — the same finance inbox payouts alert (rate-limited there).
  alert: (subject, text) => payoutsAlert(subject, text),
  queue: {
    // payments R4 — the state change happens in a job so ingest can acknowledge
    // in under a second. Gateways time out within seconds and retry a slow success.
    async applyWebhook(gatewayEventId) {
      await queue(QUEUES.payments).add(
        'apply-webhook',
        { gatewayEventId },
        {
          ...defaultJobOptions,
          // Money unreconciled pages someone, so it gets five attempts.
          attempts: 5,
          jobId: `apply-webhook-${gatewayEventId}`,
        },
      );
    },
    async processRefund(refundId) {
      await queue(QUEUES.payments).add(
        'process-refund',
        { refundId },
        { ...defaultJobOptions, attempts: 5, jobId: `process-refund-${refundId}` },
      );
    },
  },
});

/** payouts R2 — no key, no payouts: a box that refuses beats a silent clear-text fallback. */
const box: SecretBox =
  config.PAYOUT_DATA_KEY !== ''
    ? createSecretBox(config.PAYOUT_DATA_KEY)
    : {
        seal: () => {
          throw new SystemError('PAYOUTS_UNAVAILABLE', 'Payouts are not configured');
        },
        open: () => {
          throw new SystemError('PAYOUTS_UNAVAILABLE', 'Payouts are not configured');
        },
      };

let lastAlertAt = 0;

/** payouts R12 — one email an hour at most; the log line is every time. */
async function payoutsAlert(subject: string, text: string): Promise<void> {
  logger.error({ subject }, text);
  if (!config.PAYOUT_ALERT_EMAIL || Date.now() - lastAlertAt < 3_600_000) return;
  lastAlertAt = Date.now();
  const to = config.PAYOUT_ALERT_EMAIL;
  await email.send({ to, ...payoutAlertEmail({ to, subject, text }) });
}

export const payouts = createPayoutsService({
  db,
  repo: createPayoutsRepo(db),
  provider: payoutProvider,
  box,
  limiter: { consume },
  jobs: {
    async verifyAccount(accountId, delayMs) {
      await queue(QUEUES.payments).add(
        'verify-payout-account',
        { accountId },
        { ...defaultJobOptions, delay: delayMs, jobId: `verify-payout-account-${accountId}-${Date.now()}` },
      );
    },
    async checkPayout(payoutId, delayMs) {
      await queue(QUEUES.payments).add(
        'check-payout',
        { payoutId },
        { ...defaultJobOptions, attempts: 5, delay: delayMs, jobId: `check-payout-${payoutId}-${Date.now()}` },
      );
    },
  },
  async notify(userId, key, payload) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, key, payload as never, { kind: 'route', route: 'organizer_payouts' });
  },
  alert: payoutsAlert,
  async isStaff(userId) {
    const { identity } = await import('../identity/index.js');
    return (await identity.platformRoleFor(userId)) !== null;
  },
  stepUp: {
    async verify(userId, code) {
      const { identity } = await import('../identity/index.js');
      return identity.verifyStepUpCode(userId, 'payout_change', code);
    },
  },
  // F3 — whether anything shows the event happened, and what players reported.
  async reviewSignals(eventId) {
    const [{ tournament }, { field }, { registration }, { events }] = await Promise.all([
      import('../tournament/index.js'),
      import('../scoring/index.js'),
      import('../registration/index.js'),
      import('../events/index.js'),
    ]);
    const categoryIds = (await events.categoriesFor(eventId)).map((c) => c.id);
    const [matches, heats, checkIns, reports] = await Promise.all([
      tournament.startedMatchCount(eventId),
      field.scoredHeatCount(categoryIds),
      registration.entries.checkInCount(eventId),
      events.openReports(eventId),
    ]);
    return { startedMatches: matches + heats, checkIns, openReports: reports.count, latestReportAt: reports.latestAt };
  },
  config: {
    autoThreshold: config.PAYOUT_NAME_MATCH_AUTO,
    commissionGstBps: config.COMMISSION_GST_BPS,
    tdsBps: config.HOST_TDS_BPS,
    impsMaxPaise: config.PAYOUT_IMPS_MAX_PAISE,
  },
});

export { PaymentCode, RECONCILE_AFTER_MS } from './service/index.js';
/** The PL4Y staff inbox (PAYOUT_ALERT_EMAIL), one email an hour at most. */
export const opsAlert = (subject: string, text: string): Promise<void> => payoutsAlert(subject, text);
export type {
  LedgerEntry,
  OrderHandle,
  PaymentsService,
  Receipt,
  Refund,
  RegistrationPort,
} from './service/index.js';
export { PayoutCode } from './service/payouts.js';
export type { PayoutAccountView, PayoutsService, Staff } from './service/payouts.js';
