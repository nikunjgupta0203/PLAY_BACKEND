/**
 * Worker process (architecture.md §1). Same image as the API, different
 * entrypoint.
 *
 * It exists because outbox drain, seat-hold expiry and rating periods must not
 * compete with request latency — not because the domain is distributed.
 */
import { pathToFileURL } from 'node:url';
import { logger } from './platform/logging/index.js';
import { disconnectDb, db } from './platform/db.js';
import { QUEUES, closeQueues, defaultJobOptions, jobStore, queue, startScheduler, startWorker } from './platform/queue.js';
import { claimBatch, markFailed, markProcessed, prune as pruneOutbox } from './platform/outbox.js';
import { pruneRateLimits } from './platform/rateLimit.js';
import { registrationNotifier } from './platform/realtime/registrationUpdates.js';
import { matchNotifier, supersededScores } from './platform/realtime/matchUpdates.js';
import { drawNotifier } from './platform/realtime/drawUpdates.js';
import { realtime } from './platform/pusher.js';
import { events } from './modules/events/index.js';
import { identity } from './modules/identity/index.js';
import { registration } from './modules/registration/index.js';
import { opsAlert, payments, payouts } from './modules/payments/index.js';
import { profile } from './modules/profile/index.js';
import { venues } from './modules/venues/index.js';
import { rating } from './modules/rating/index.js';
import { scoring } from './modules/scoring/index.js';
import { tournament } from './modules/tournament/index.js';
import { notifications } from './modules/notifications/index.js';
import { notify } from './notify.js';
import { AUTO_DRAW_RETRY_MS, autoDrawCategory } from './autoDraw.js';

/** Registered by topic. Dispatch is at-least-once, so handlers are idempotent. */
type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;

const handlers: Record<string, OutboxHandler> = {
  // notifications lands in Sprint 9; until then a domain event is only logged,
  // which is enough to prove the outbox path end to end.
  'user.created': async (payload) => {
    logger.info({ payload }, 'outbox: user.created');
  },
  'user.suspended': async (payload) => {
    logger.info({ payload }, 'outbox: user.suspended');
  },
  // profile (docs/modules/03-profile.md § Emits). rating consumes the first,
  // notifications the second.
  'profile.sports_changed': async (payload) => {
    logger.info({ payload }, 'outbox: profile.sports_changed');
  },
  'achievement.earned': async (payload) => {
    await notify.achievementEarned(payload);
  },

  // events (docs/modules/05-events.md § Emits).
  //
  // Publishing is what schedules the registration deadline. A delayed job is
  // more precise than a sweep, and the sweep below still exists because a
  // delayed job that is lost would otherwise strand a draw as 'open' forever.
  'event.published': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    if (!eventId) return;
    const event = await events.findById(eventId);
    if (!event) return;
    await queue(QUEUES.events).add(
      'close-registration',
      { eventId },
      {
        ...defaultJobOptions,
        delay: Math.max(event.registrationClosesAt.getTime() - Date.now(), 0),
        // One deadline per event, however many times this row is redelivered.
        jobId: `close-registration-${eventId}`,
      },
    );
    logger.info({ eventId, slug: event.slug }, 'outbox: event.published');
  },
  // events R7 — a full refund for every confirmed entry, platform fee
  // included. Enqueued rather than done here: a final failure on this queue
  // PAGES someone, because a player is owed money.
  'event.cancelled': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    if (!eventId) return;
    // Told BEFORE their entries move out of `confirmed`: the notice is
    // addressed from that list.
    await notify.eventCancelled(payload);
    // gap #2, #3 — nobody stays "in" an event that is not happening, and no
    // unfinished entry can be confirmed into it by a late payment.
    for (const category of await events.categoriesFor(eventId)) {
      await registration.closeOutCancelled(category.id);
    }
    await queue(QUEUES.payments).add(
      'bulk-refund',
      // The reason is also the refund key's prefix, so it is fixed, not free text.
      { eventId, reason: 'event_cancelled' },
      { ...defaultJobOptions, attempts: 5, jobId: `bulk-refund-event-${eventId}` },
    );
    // payouts R8 — the refunds net it to zero and a zero payout closes itself
    // (R9); scheduling it keeps the ledger explaining where the money went.
    await payouts.scheduleForEvent(eventId);
  },

  // events R9 — the draw missed its minimum entries. Same money, one draw.
  'category.cancelled': async (payload) => {
    const categoryId = String(payload['categoryId'] ?? '');
    if (!categoryId) return;
    // Told BEFORE their entries move out of `confirmed`.
    await notify.categoryCancelled(payload);
    await notify.hostDrawCancelled(payload);
    await registration.closeOutCancelled(categoryId);
    await queue(QUEUES.payments).add(
      'bulk-refund',
      { categoryId, reason: String(payload['reason'] ?? 'under_minimum') },
      { ...defaultJobOptions, attempts: 5, jobId: `bulk-refund-category-${categoryId}` },
    );
  },
  // Registration closed and the draw goes ahead: whoever is still queued, or
  // still waiting for a partner, can no longer get a seat (gap #3).
  'category.closed': async (payload) => {
    const categoryId = String(payload['categoryId'] ?? '');
    if (!categoryId) return;
    await registration.closeOutClosed(categoryId);
    // The draw makes itself (autoDraw.ts); the host is asked only if it cannot.
    await queue(QUEUES.tournament).add(
      'auto-draw',
      { categoryId, attempt: 1 },
      { ...defaultJobOptions, jobId: `auto-draw-${categoryId}-1` },
    );
  },
  // F12 — a day before close, a draw is short of its minimum.
  'category.short': async (payload) => {
    await notify.hostDrawShort(payload);
  },
  // F18 — the host moved the place or dates after people entered.
  'event.terms_changed': async (payload) => {
    await notify.eventChanged(payload);
  },
  // F3 — a player reported the event. PL4Y staff look; the payout waits (payouts reads the report).
  'event.reported': async (payload) => {
    await opsAlert(
      'Event reported by a player',
      `Event ${String(payload['eventId'])} was reported (${String(payload['reason'])}). Its payout is held until the report is settled in the app.`,
    );
  },
  'event.report_resolved': async (payload) => {
    await notify.reportResolved(payload);
  },
  // gap #9 — the host moved the deadline; schedule the close for the new one.
  'event.registration_rescheduled': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    const at = new Date(String(payload['registrationClosesAt'] ?? ''));
    if (!eventId || Number.isNaN(at.getTime())) return;
    await queue(QUEUES.events).add(
      'close-registration',
      { eventId },
      {
        ...defaultJobOptions,
        delay: Math.max(at.getTime() - Date.now(), 0),
        jobId: `close-registration-${eventId}-${at.getTime()}`,
      },
    );
  },
  // events — an organizer's message to everyone entered (notifications R11).
  'event.message': async (payload) => {
    await notify.organizerMessage(payload);
  },
  'event.live': async (payload) => {
    logger.info({ payload }, 'outbox: event.live');
  },
  'event.completed': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    if (!eventId) return;
    // payouts R8 — the host's payout falls due 72 h after the event ends.
    const payout = await payouts.scheduleForEvent(eventId);
    // F12 — the host hears it is over, and when they will be paid.
    await notify.hostEventCompleted(payload, payout?.dueAt ?? null);
  },
  'category.full': async (payload) => {
    logger.info({ payload }, 'outbox: category.full');
  },

  // registration (docs/modules/06-registration.md § Emits).
  //
  // The hold and its release job are written in one transaction: the outbox row
  // IS the instruction to schedule the release, so a crash between taking a
  // seat and scheduling its expiry cannot leave a hold nothing will release
  // (platform R5). The five-minute sweep below is the second line of defence.
  'hold.created': async (payload) => {
    const holdId = String(payload['holdId'] ?? '');
    const expiresAt = new Date(String(payload['expiresAt'] ?? ''));
    if (holdId && !Number.isNaN(expiresAt.getTime())) {
      await queue(QUEUES.registration).add(
        'release-hold',
        { holdId },
        {
          ...defaultJobOptions,
          delay: Math.max(expiresAt.getTime() - Date.now(), 0),
          jobId: `release-hold-${holdId}`,
        },
      );
    }
    // registration R10 over in the app — the captain's screen leads with the countdown.
    await registrationNotifier.notify('hold.created', payload);
  },

  'invite.created': async (payload) => {
    const inviteId = String(payload['inviteId'] ?? '');
    const expiresAt = new Date(String(payload['expiresAt'] ?? ''));
    if (inviteId && !Number.isNaN(expiresAt.getTime())) {
      await queue(QUEUES.registration).add(
        'expire-invite',
        { inviteId },
        {
          ...defaultJobOptions,
          delay: Math.max(expiresAt.getTime() - Date.now(), 0),
          jobId: `expire-invite-${inviteId}`,
        },
      );
    }
    await registrationNotifier.notify('invite.created', payload);
    await notify.partnerInvited(payload);
  },

  'invite.declined': async (payload) => {
    await registrationNotifier.notify('invite.declined', payload);
    await notify.partnerDeclined(payload);
  },

  'registration.confirmed': async (payload) => {
    await registrationNotifier.notify('registration.confirmed', payload);
    await notify.registrationConfirmed(payload);
    // F12 — the host hears about every entry.
    await notify.hostNewEntry(payload);
  },

  'registration.expired': async (payload) => {
    await registrationNotifier.notify('registration.expired', payload);
    await notify.registrationExpired(payload);
  },

  'registration.payment_failed': async (payload) => {
    logger.info({ payload }, 'outbox: registration.payment_failed');
    await registrationNotifier.notify('registration.payment_failed', payload);
  },

  'registration.cancelled': async (payload) => {
    logger.info({ payload }, 'outbox: registration.cancelled');
    await registrationNotifier.notify('registration.cancelled', payload);
  },

  'registration.checked_in': async (payload) => {
    logger.info({ payload }, 'outbox: registration.checked_in');
    await registrationNotifier.notify('registration.checked_in', payload);
  },

  // registration R17 — the offer push.
  'waitlist.offered': async (payload) => {
    await notify.waitlistOffered(payload);
  },

  /**
   * A seat came back — a cancellation, a lapsed hold, a lapsed waitlist offer.
   * promote-waitlist offers it to the head of the queue (registration R17) and
   * then reopens the draw so `category.full` can fire again when it refills.
   */
  'capacity.changed': async (payload) => {
    const categoryId = String(payload['eventCategoryId'] ?? '');
    if (!categoryId) return;
    await queue(QUEUES.registration).add(
      'promote-waitlist',
      { eventCategoryId: categoryId },
      { ...defaultJobOptions },
    );
  },

  // payments (docs/modules/07-payments.md § Emits).
  'payment.captured': async (payload) => {
    logger.info({ payload }, 'outbox: payment.captured');
  },

  'payment.failed': async (payload) => {
    // A court booking's payment has no entry; the booking keeps its hold and says so itself.
    if (!payload['registrationId']) return;
    await notify.paymentUpdated('failed', payload);
  },

  'refund.processed': async (payload) => {
    // payouts R15 — a refund after the host was paid becomes a receivable.
    const refundId = String(payload['refundId'] ?? '');
    if (refundId) await payouts.onRefundProcessed(refundId);
    // A court booking's refund has no entry (found in the 2026-10-05 booking run, where this
    // retried in a loop): the booking told the player when they cancelled.
    if (!payload['registrationId']) return;
    await registrationNotifier.notify('refund.processed', payload);
    await notify.paymentUpdated('refunded', payload);
  },

  // tournament (docs/modules/09-tournament.md § Emits).
  'draw.generated': async (payload) => {
    // The first thing a fresh draw needs is somewhere to play. Scheduling is a
    // job rather than part of the draw transaction: R13 says the schedule is
    // advisory, and advisory work does not get to fail a draw.
    const tournamentId = String(payload['tournamentId'] ?? '');
    if (!tournamentId) return;
    await queue(QUEUES.tournament).add(
      'schedule-courts',
      { tournamentId },
      { ...defaultJobOptions, jobId: `schedule-courts-${tournamentId}-drawn` },
    );
    await drawNotifier.changed('draw.generated', payload);
    await notify.drawGenerated(payload);
  },

  // A group stage just finished and its knockout was drawn: it needs courts too.
  'knockout.drawn': async (payload) => {
    const tournamentId = String(payload['tournamentId'] ?? '');
    if (!tournamentId) return;
    await queue(QUEUES.tournament).add(
      'schedule-courts',
      { tournamentId },
      { ...defaultJobOptions, jobId: `schedule-courts-${tournamentId}-knockout` },
    );
    await drawNotifier.changed('knockout.drawn', payload);
  },

  /**
   * R11 — the scheduler is re-run whenever a match becomes ready, because that
   * is the moment a new match can be placed. The job id is per match, so five
   * matches becoming ready together enqueue five jobs and the queue's
   * concurrency of one turns them into one useful pass and four no-ops.
   */
  'match.ready': async (payload) => {
    const tournamentId = String(payload['tournamentId'] ?? '');
    const matchId = String(payload['matchId'] ?? '');
    if (!tournamentId) return;
    await queue(QUEUES.tournament).add(
      'schedule-courts',
      { tournamentId },
      { ...defaultJobOptions, jobId: `schedule-courts-${tournamentId}-${matchId}` },
    );
    await matchNotifier.status('match.ready', payload);
    await notify.matchReady(payload);
  },

  /**
   * A match has a time. 30 minutes before it, tell the players (R: the doc's
   * `notify-starting-soon`). A delayed job per match, replaced whenever an
   * organizer moves the match, which they do constantly (R13).
   */
  'match.scheduled': async (payload) => {
    const matchId = String(payload['matchId'] ?? '');
    const startsAt = new Date(String(payload['startsAt'] ?? ''));
    if (!matchId || Number.isNaN(startsAt.getTime())) return;
    await queue(QUEUES.tournament).add(
      'notify-starting-soon',
      { matchId },
      {
        ...defaultJobOptions,
        delay: Math.max(startsAt.getTime() - 30 * 60_000 - Date.now(), 0),
        jobId: `notify-starting-soon-${matchId}`,
      },
    );
    // N1 — the schedule screen shows the new time without a manual refresh.
    await drawNotifier.changed('match.scheduled', payload);
  },

  'match.live': async (payload) => {
    // The first match of an event is what flips it into Live Mode.
    const eventId = String(payload['eventId'] ?? '');
    if (!eventId) return;
    await queue(QUEUES.events).add(
      'promote-to-live',
      { eventId },
      { ...defaultJobOptions, jobId: `promote-to-live-${eventId}` },
    );
    await matchNotifier.status('match.live', payload);
  },

  'match.awaiting_confirm': async (payload) => {
    await matchNotifier.status('match.awaiting_confirm', payload);
  },

  'match.completed': async (payload) => {
    logger.info({ payload }, 'outbox: match.completed');
    await matchNotifier.status('match.completed', payload);
    // profile R12 — the history projection and, through it, the R8 stats.
    const matchId = String(payload['matchId'] ?? '');
    if (matchId) {
      await profile.projectMatch(matchId);
      // venues R6 — "played here", which review eligibility reads.
      await venues.recordMatchVisit(matchId);
    }
  },

  // scoring (docs/modules/10-scoring.md § Emits). Coalesced per match in
  // drainOutbox below (R5); what reaches here is the newest score in its drain.
  'match.score': async (payload) => {
    await matchNotifier.score(payload);
  },
  // Plans 7, 8 — a heat's standings changed.
  'heat.score': async (payload) => {
    await matchNotifier.heat(payload);
  },

  // scoring R6 — the other side is asked to confirm.
  'result.submitted': async (payload) => {
    await notify.resultSubmitted(payload);
  },
  // scoring R14 — the one reminder, half-way through the window.
  'result.reminder': async (payload) => {
    await notify.resultReminder(payload);
  },
  // scoring R13 — owners and managers, grouped per event.
  'results.waiting': async (payload) => {
    await notify.resultsWaiting(payload);
  },
  // gap #18 — an organizer corrected a confirmed result. Match history is
  // rewritten (projectMatch is idempotent) and ratings re-rate the match.
  'result.corrected': async (payload) => {
    const matchId = String(payload['matchId'] ?? '');
    if (!matchId) return;
    await profile.projectMatch(matchId);
    await queue(QUEUES.rating).add(
      'reapply-match',
      { matchId },
      { ...defaultJobOptions, attempts: 5, jobId: `reapply-match-${matchId}-${Date.now()}` },
    );
  },
  'match.corrected': async (payload) => {
    await matchNotifier.status('match.completed', payload);
  },
  // gap #20 — a dispute still open a day after the event ended goes to PL4Y staff.
  'result.escalated': async (payload) => {
    await opsAlert(
      'Match result dispute unresolved',
      `Match ${String(payload['matchId'])} on event ${String(payload['eventId'])} has been disputed since before the event ended and nobody has settled it.`,
    );
  },
  // bookings — the player is told inline by the bookings service; these are
  // recorded for the audit of what happened. No-shows are counted by the
  // nightly fraud detector straight from the bookings table (admin R8).
  'booking.confirmed': async () => {},
  'booking.cancelled': async () => {},
  'booking.no_show': async () => {},

  // gap #20 — PL4Y did not settle it within three days, so it closed on the
  // submitted result. Ops hear about it; the bracket moved on already.
  'result.defaulted': async (payload) => {
    await opsAlert(
      'Disputed result closed by default',
      `Match ${String(payload['matchId'])} on event ${String(payload['eventId'])} was escalated and not settled for 3 days, so it was confirmed on the submitted result. It is not rated. Correct it from the portal if it was wrong.`,
    );
  },
  'result.disputed': async (payload) => {
    logger.warn({ payload }, 'outbox: result.disputed');
    await notify.resultDisputed(payload);
  },

  // gap #1 — a finished draw may be the event's last: completing the event is
  // what schedules the host's payout.
  'tournament.completed': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    // F25 — everyone in the draw hears who won it.
    await notify.drawFinished(payload);
    if (eventId) await events.completeIfFinished(eventId);
  },
  // gap #32 — the same, for a draw played in heats.
  'category.completed': async (payload) => {
    const eventId = String(payload['eventId'] ?? '');
    if (eventId) await events.completeIfFinished(eventId);
  },

  // chat (docs/superpowers/specs/2026-09-29-chat-design.md). R8 — every message
  // nudges the recipient's app to refetch; only a request or the first unread
  // message becomes a notification. The publish is best-effort: the inbox is
  // the truth, and a missed nudge is caught by the next refetch.
  'chat.message.sent': async (payload) => {
    const recipientUserId = String(payload['recipientUserId'] ?? '');
    const conversationId = String(payload['conversationId'] ?? '');
    if (!recipientUserId || !conversationId) return;
    await realtime
      .publish([`private-user-${recipientUserId}`], 'chat.message', { conversationId })
      .catch((err: unknown) => logger.warn({ err, conversationId }, 'chat publish failed — dropped'));
    const kind = payload['notify'];
    if (kind === 'request' || kind === 'message') await notify.chatNotify({ ...payload, kind });
  },

  // rating (docs/modules/08-rating.md § Emits).
  //
  // `result.confirmed` is emitted by `scoring` when a result is confirmed
  // (scoring R6); the bracket has already advanced in that transaction.
  'result.confirmed': async (payload) => {
    const matchId = String(payload['matchId'] ?? '');
    if (!matchId) return;
    await notify.resultConfirmed(payload);
    // profile R12 — idempotent; a confirmation after a dispute rewrites the rows.
    await profile.projectMatch(matchId);
    await queue(QUEUES.rating).add(
      'apply-provisional',
      { matchId },
      // rating R3 — the number a player watches for. A final failure is an
      // alert rather than a page: the period job corrects it within the week.
      { ...defaultJobOptions, attempts: 5, jobId: `apply-provisional-${matchId}` },
    );
  },

  'rating.changed': async (payload) => {
    await notify.ratingChanged(payload);
  },

  'ranking.moved': async (payload) => {
    await notify.rankingMoved(payload);
  },
};

/**
 * platform R6 — claim with FOR UPDATE SKIP LOCKED so two workers never dispatch
 * the same row, then mark processed. Rows claimed but not processed for five
 * minutes are retried.
 */
export async function drainOutbox(): Promise<number> {
  const rows = await claimBatch(100);
  if (rows.length === 0) return 0;

  // scoring R5 — an older score for a match that has a newer one in this same
  // batch is done without a publish. The newer row carries the whole score.
  const superseded = supersededScores(rows);

  const done: bigint[] = [];
  for (const row of rows) {
    if (superseded.has(row.id)) {
      done.push(row.id);
      continue;
    }
    const handler = handlers[row.topic];
    if (!handler) {
      // An unknown topic is a deploy-ordering artefact, not a failure.
      logger.warn({ topic: row.topic }, 'outbox: no handler registered');
      done.push(row.id);
      continue;
    }
    try {
      await handler((row.payload ?? {}) as Record<string, unknown>);
      done.push(row.id);
    } catch (err) {
      await markFailed(row.id, err instanceof Error ? err.message : String(err));
    }
  }
  await markProcessed(done);
  return done.length;
}

/** [queue, job, cron in UTC]. Anything not listed here is unscheduled at boot. */
const SCHEDULES: [string, string, string][] = [
  // identity — purge jobs (docs/modules/01-identity.md § Jobs)
  [QUEUES.identity, 'purge-expired-otp', '0 * * * *'],
  [QUEUES.identity, 'purge-revoked-tokens', '15 3 * * *'],
  // identity R18 — a deletion request past its 30-day grace. Final failure
  // alerts: a deletion request is overdue.
  [QUEUES.identity, 'scrub-deleted-users', '45 3 * * *'],
  // events — the safety net behind the per-event delayed job above.
  [QUEUES.events, 'sweep-registration-close', '*/5 * * * *'],
  // gap #1 — events a day past their end that nothing completed.
  [QUEUES.events, 'sweep-event-completion', '20 * * * *'],
  // F12 — draws short of their minimum a day before registration closes.
  [QUEUES.events, 'warn-short-categories', '10 * * * *'],
  // registration R5 — the safety net behind every delayed release job.
  [QUEUES.registration, 'sweep-stale-holds', '*/5 * * * *'],
  // bookings R3 — lapsed court holds and finished bookings, every minute.
  [QUEUES.registration, 'sweep-bookings', '* * * * *'],
  // payments R9 — turns a lost webhook from a support ticket into a few minutes'
  // delay, inside the seat hold (gap #22).
  [QUEUES.payments, 'reconcile-pending', '*/5 * * * *'],
  // payouts R8, R10, R12 — every minute: due payouts are sent, held or wait for funds.
  [QUEUES.payments, 'settle-due-payouts', '* * * * *'],
  // payouts R13 — transfers we have not heard about in 30 minutes.
  [QUEUES.payments, 'sweep-sending-payouts', '*/15 * * * *'],
  // scoring R11, R13, R14 — every minute: auto_confirm_at is a floor, and a
  // minute late is the most anyone waits past it.
  [QUEUES.tournament, 'sweep-results', '* * * * *'],
  // notifications — 180-day feed retention.
  [QUEUES.notify, 'prune-notifications', '30 4 * * *'],
  // rating R4 — Monday 03:00 IST, which is 21:30 UTC on Sunday. India has one
  // offset and no daylight saving, so this is a constant, not a conversion.
  [QUEUES.rating, 'run-period', '30 21 * * 0'],
  // platform — the queue's own retention.
  [QUEUES.maintenance, 'prune-jobs', '0 4 * * *'],
  [QUEUES.maintenance, 'prune-outbox', '10 4 * * *'],
  [QUEUES.maintenance, 'prune-rate-limits', '5 * * * *'],
  // admin R8, F26 — fraud detectors, nightly at 03:30 IST.
  [QUEUES.maintenance, 'detect-fraud-signals', '0 22 * * *'],
  // admin R7 — resolved tickets nobody reopened for a week close.
  [QUEUES.maintenance, 'close-stale-tickets', '40 * * * *'],
];

async function registerSchedules(): Promise<void> {
  for (const [queueName, name, cron] of SCHEDULES) {
    await jobStore.schedule(queueName, name, cron);
  }
  const dropped = await jobStore.pruneSchedules(SCHEDULES.map(([q, n]) => `${q}:${n}`));
  if (dropped > 0) logger.info({ dropped }, 'unregistered stale job schedules');
}

/**
 * Registers the schedules, starts every queue consumer and the outbox drain.
 * Returns the function that stops the drain; the caller owns closing queues
 * and connections, because in the combined process (src/all.ts) the API
 * shares them.
 */
export async function startWorkers(): Promise<() => void> {
  await registerSchedules();

  startWorker(QUEUES.identity, async (job) => {
    switch (job.name) {
      case 'purge-expired-otp': {
        const { count } = await db.otpChallenge.deleteMany({
          where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } },
        });
        logger.info({ count }, 'purged expired otp challenges');
        return;
      }
      case 'scrub-deleted-users': {
        const count = await identity.scrubDeletedUsers();
        if (count > 0) logger.info({ count }, 'scrubbed deleted users');
        return;
      }
      case 'purge-revoked-tokens': {
        // 90-day retention.
        const { count } = await db.refreshToken.deleteMany({
          where: { revokedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } },
        });
        logger.info({ count }, 'purged revoked refresh tokens');
        return;
      }
      default:
        logger.warn({ job: job.name }, 'unknown identity job');
    }
  });

  startWorker(QUEUES.events, async (job) => {
    switch (job.name) {
      case 'close-registration': {
        // events R9 — categories under min_entries are cancelled here and
        // refunded by payments. Idempotent: a category already closed or
        // cancelled is left alone.
        const { eventId } = job.data as { eventId: string };
        const result = await events.closeRegistration(eventId);
        logger.info({ eventId, ...result }, 'registration closed');
        return;
      }
      case 'sweep-event-completion': {
        // gap #1's backstop: an event a day past its end is over, scored or not.
        for (const eventId of await events.dueForCompletion()) {
          await events.markCompleted(eventId);
        }
        return;
      }
      case 'sweep-registration-close': {
        const due = await events.dueForClose();
        for (const eventId of due) {
          await events.closeRegistration(eventId);
        }
        if (due.length > 0) logger.warn({ count: due.length }, 'swept overdue registrations');
        return;
      }
      case 'warn-short-categories': {
        // F12 — a day before close, draws still short of their minimum.
        const warned = await events.warnShortCategories();
        if (warned > 0) logger.info({ warned }, 'hosts warned about short draws');
        return;
      }
      case 'promote-to-live': {
        // Enqueued by `tournament` when the first match starts (Sprint 8).
        const { eventId } = job.data as { eventId: string };
        await events.markLive(eventId);
        return;
      }
      default:
        logger.warn({ job: job.name }, 'unknown events job');
    }
  });

  startWorker(QUEUES.registration, async (job) => {
    switch (job.name) {
      case 'release-hold': {
        // registration R5 — this is NOT what makes capacity correct; the count
        // predicate already ignores an expired hold. A final failure alerts,
        // because a hold nobody released leaves a seat looking taken.
        const { holdId } = job.data as { holdId: string };
        await registration.expireHold(holdId);
        return;
      }
      // bookings R3 — like seat holds, not what makes availability correct:
      // the insert path expires an overlapping stale hold itself.
      case 'release-booking-hold': {
        const { bookingId } = job.data as { bookingId: string };
        const { bookings } = await import('./modules/bookings/index.js');
        await bookings.expireHold(bookingId);
        return;
      }
      case 'sweep-bookings': {
        const { bookings } = await import('./modules/bookings/index.js');
        const result = await bookings.sweep();
        if (result.expired + result.completed > 0) logger.info(result, 'swept court bookings');
        return;
      }
      case 'expire-invite': {
        const { inviteId } = job.data as { inviteId: string };
        await registration.expireInvite(inviteId);
        return;
      }
      case 'sweep-stale-holds': {
        const holds = await registration.sweepStaleHolds();
        const invites = await registration.sweepStaleInvites();
        if (holds > 0 || invites > 0) {
          logger.warn({ holds, invites }, 'swept stale holds and invites');
        }
        return;
      }
      case 'promote-waitlist': {
        // registration R17 — head of the queue first, one hold per promotion,
        // each under the category lock. Looping until nobody fits is safe
        // against a concurrent cancellation or a second copy of this job.
        const { eventCategoryId } = job.data as { eventCategoryId: string };
        let promoted = 0;
        while (promoted < 500 && (await registration.promoteWaitlist(eventCategoryId))) {
          promoted += 1;
        }
        if (promoted > 0) logger.info({ eventCategoryId, promoted }, 'waitlist promoted');
        await events.refreshCategoryFullness(eventCategoryId);
        return;
      }
      default:
        logger.warn({ job: job.name }, 'unknown registration job');
    }
  });

  startWorker(
    QUEUES.payments,
    async (job) => {
      switch (job.name) {
        case 'apply-webhook': {
          // payments R4 — the state change the ingest route deliberately did
          // not do. A final failure here PAGES: money is unreconciled.
          const { gatewayEventId } = job.data as { gatewayEventId: string };
          await payments.applyWebhook(gatewayEventId);
          return;
        }
        case 'process-refund': {
          const { refundId } = job.data as { refundId: string };
          await payments.processRefund(refundId);
          return;
        }
        case 'bulk-refund': {
          const { eventId, categoryId, reason } = job.data as {
            eventId?: string;
            categoryId?: string;
            reason: string;
          };
          const result = eventId
            ? await payments.bulkRefund(eventId, reason)
            : categoryId
              ? await payments.bulkRefundCategory(categoryId, reason)
              : { queued: 0 };
          logger.warn({ eventId, categoryId, ...result }, 'bulk refund queued');
          return;
        }
        case 'reconcile-pending': {
          const result = await payments.reconcilePending();
          if (result.resolved > 0) logger.warn(result, 'reconciliation resolved payments');
          // The operations dashboard number. Steady state is zero.
          const unreconciled = await payments.unreconciledCount();
          if (unreconciled > 0) {
            logger.error({ unreconciled }, 'payments unreconciled past the reconciliation window');
          }
          return;
        }
        case 'verify-payout-account': {
          const { accountId } = job.data as { accountId: string };
          await payouts.verifyAccount(accountId);
          return;
        }
        case 'check-payout': {
          const { payoutId } = job.data as { payoutId: string };
          await payouts.checkPayout(payoutId);
          return;
        }
        case 'settle-due-payouts': {
          const result = await payouts.settleDue();
          if (result.sent + result.held + result.waiting > 0) logger.info(result, 'payouts settled');
          return;
        }
        case 'sweep-sending-payouts': {
          const checked = await payouts.sweepSending();
          if (checked > 0) logger.warn({ checked }, 'checked payouts stuck in sending');
          return;
        }
        default:
          logger.warn({ job: job.name }, 'unknown payments job');
      }
    },
    // Money is serialised per job by its own idempotency keys, but a lower
    // concurrency keeps a gateway outage from burning five attempts at once.
    { concurrency: 3 },
  );

  startWorker(
    QUEUES.tournament,
    async (job) => {
      switch (job.name) {
        case 'auto-draw': {
          const { categoryId, attempt } = job.data as { categoryId: string; attempt: number };
          const outcome = await autoDrawCategory(categoryId, attempt);
          logger.info({ categoryId, attempt, outcome }, 'auto draw');
          if (outcome.kind === 'retry') {
            await queue(QUEUES.tournament).add(
              'auto-draw',
              { categoryId, attempt: attempt + 1 },
              { ...defaultJobOptions, delay: AUTO_DRAW_RETRY_MS, jobId: `auto-draw-${categoryId}-${attempt + 1}` },
            );
          } else if (outcome.kind === 'manual') {
            // F12 — it could not make itself: the host is asked, as before.
            await notify.hostReadyToDraw({ categoryId });
          } else if (outcome.kind === 'drawn' || outcome.kind === 'heats') {
            await notify.hostDrawMade({ categoryId, heats: outcome.kind === 'heats' ? outcome.count : 0 });
          }
          return;
        }
        case 'schedule-courts': {
          // R11, R12 — greedy and idempotent: it places only what is ready and
          // unplaced, so a second run over the same draw writes nothing. A
          // final failure ALERTS rather than pages: an organizer can assign
          // courts by hand, and R13 says they will anyway.
          const { tournamentId } = job.data as { tournamentId: string };
          const placed = await tournament.schedule(tournamentId);
          if (placed.length > 0) {
            logger.info({ tournamentId, placed: placed.length }, 'matches scheduled onto courts');
          }
          return;
        }
        case 'notify-starting-soon': {
          // A final failure is a DROP: a match that has already started needs
          // no warning. notifications R3 — this one is pushed through quiet hours.
          const { matchId } = job.data as { matchId: string };
          const match = await tournament.matchById(matchId).catch(() => null);
          if (!match?.scheduledAt || match.status !== 'ready') return;
          await notify.matchStartingSoon(matchId);
          return;
        }
        case 'sweep-results': {
          // A final failure ALERTS: the next minute's pass picks up whatever this one missed.
          const report = await scoring.sweep();
          if (report.confirmed + report.alerts + report.reminders > 0) {
            logger.info(
              { confirmed: report.confirmed, alerts: report.alerts, reminders: report.reminders },
              'results swept',
            );
          }
          for (const f of report.failed) {
            logger.error({ matchId: f.matchId, error: f.error }, 'auto-confirm failed; retried next pass');
          }
          return;
        }
        default:
          logger.warn({ job: job.name }, 'unknown tournament job');
      }
    },
    // R9's advisory lock serialises advancement, but the scheduler is not under
    // it: two passes over one draw would race to book the same court and burn
    // an attempt on the exclusion constraint. One at a time costs nothing.
    { concurrency: 1 },
  );

  startWorker(
    QUEUES.rating,
    async (job) => {
      switch (job.name) {
        case 'reapply-match': {
          // gap #18 — a corrected result: the preview is taken back and redone.
          const { matchId } = job.data as { matchId: string };
          const written = await rating.reapplyMatch(matchId);
          if (written.length > 0) {
            await queue(QUEUES.rating).add(
              'rebuild-rankings',
              { sportId: written[0]!.sportId },
              { ...defaultJobOptions, jobId: `rebuild-rankings-${written[0]!.sportId}` },
            );
          }
          return;
        }
        case 'apply-provisional': {
          // rating R3 — the number that moves the moment a result is confirmed.
          const { matchId } = job.data as { matchId: string };
          const events = await rating.applyMatch(matchId);
          if (events.length > 0) {
            await queue(QUEUES.rating).add(
              'rebuild-rankings',
              { sportId: events[0]!.sportId },
              { ...defaultJobOptions, jobId: `rebuild-rankings-${events[0]!.sportId}` },
            );
          }
          return;
        }
        case 'run-period': {
          // rating R4 — every sport's week, settled. A final failure PAGES:
          // ratings frozen is a leaderboard that quietly stops being true.
          const sports = await db.sport.findMany({
            where: { active: true },
            select: { id: true },
          });
          for (const { id: sportId } of sports) {
            // The period that just ENDED, which is the one before the week the
            // job is running in.
            const previous = new Date(Date.now() - 7 * 86_400_000);
            const period = await rating.periodFor(sportId, previous);
            try {
              const result = await rating.runPeriod(period.id);
              logger.info({ sportId, ...result }, 'rating period settled');
              await rating.rebuildAll(sportId);
            } catch (err) {
              // PERIOD_ALREADY_RUN is the guard doing its job on a retry, not a
              // failure worth paging anyone over.
              const code = (err as { extensions?: { code?: string } }).extensions?.code;
              if (code === 'PERIOD_ALREADY_RUN') {
                logger.info({ sportId, periodId: period.id }, 'rating period already run');
                continue;
              }
              throw err;
            }
          }
          return;
        }
        case 'rebuild-rankings': {
          const { sportId } = job.data as { sportId: string };
          const result = await rating.rebuildAll(sportId);
          logger.info({ sportId, ...result }, 'rankings rebuilt');
          return;
        }
        default:
          logger.warn({ job: job.name }, 'unknown rating job');
      }
    },
    // One period run touches every player in a sport. Serialising the queue
    // keeps two rebuilds from interleaving their movement arithmetic.
    { concurrency: 1 },
  );

  startWorker(QUEUES.notify, async (job) => {
    switch (job.name) {
      case 'send-push': {
        // notifications R1 — the feed row already exists. A final failure here
        // is a DROP: the player still sees it in the app.
        const { notificationIds } = job.data as { notificationIds: string[] };
        await notifications.deliver(notificationIds);
        return;
      }
      case 'check-push-receipts': {
        // notifications R6 — most dead tokens surface here. A final failure is
        // a DROP: the next send to a dead token reports it on the ticket.
        const { tickets } = job.data as { tickets: { id: string; token: string }[] };
        const { pruned } = await notifications.checkReceipts(tickets);
        if (pruned > 0) logger.info({ pruned }, 'push receipts: pruned dead tokens');
        return;
      }
      case 'prune-notifications': {
        const { count } = await db.notification.deleteMany({
          where: { createdAt: { lt: new Date(Date.now() - 180 * 86_400_000) } },
        });
        if (count > 0) logger.info({ count }, 'pruned old notifications');
        return;
      }
      default:
        logger.warn({ job: job.name }, 'unknown notify job');
    }
  });

  startWorker(QUEUES.maintenance, async (job) => {
    switch (job.name) {
      case 'prune-jobs': {
        const count = await jobStore.prune();
        if (count > 0) logger.info({ count }, 'pruned finished jobs');
        return;
      }
      case 'prune-outbox': {
        const count = await pruneOutbox();
        if (count > 0) logger.info({ count }, 'pruned dispatched outbox rows');
        return;
      }
      case 'prune-rate-limits': {
        const count = await pruneRateLimits();
        if (count > 0) logger.info({ count }, 'pruned rate-limit rows');
        return;
      }
      case 'detect-fraud-signals': {
        const { admin } = await import('./modules/admin/index.js');
        logger.info({ result: await admin.runDetectors() }, 'fraud detectors ran');
        return;
      }
      case 'close-stale-tickets': {
        const { admin } = await import('./modules/admin/index.js');
        const count = await admin.closeStaleTickets();
        if (count > 0) logger.info({ count }, 'closed stale support tickets');
        return;
      }
      default:
        logger.warn({ job: job.name }, 'unknown maintenance job');
    }
  });

  const scheduler = startScheduler();

  // Outbox drain runs on a tight interval rather than as a queued job: it is
  // the thing that feeds the queues (architecture.md §6, 250 ms).
  let draining = false;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    drainOutbox()
      .catch((err) => logger.error({ err }, 'outbox drain failed'))
      .finally(() => {
        draining = false;
      });
  }, 250);

  logger.info('PL4Y worker started');
  return () => {
    clearInterval(timer);
    void scheduler.close();
  };
}

async function main(): Promise<void> {
  const stopDrain = await startWorkers();

  const shutdown = (signal: string) => {
    void (async () => {
      logger.info({ signal }, 'worker shutting down');
      stopDrain();
      await closeQueues();
      await disconnectDb();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// pathToFileURL, not string surgery: on Windows import.meta.url is
// file:///C:/... while a hand-built file:// prefix has one slash too few.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch((err) => {
    logger.fatal({ err }, 'worker failed to start');
    process.exit(1);
  });
}
