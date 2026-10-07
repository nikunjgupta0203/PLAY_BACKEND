/**
 * Domain events → notifications. The composition root's job, not a module's.
 *
 * `notifications` depends on nobody (docs/modules/11-notifications.md): it is
 * handed a user, a template key and the facts. Working out WHO to tell and
 * WHAT the facts are needs registration, events, profile and tournament, so it
 * happens here, where the worker already holds all of them — the same place
 * outbox topics are routed to every other consumer.
 *
 * Every function is safe to run twice: the outbox is at-least-once, and a
 * duplicate feed row is a smaller harm than a lost one.
 */
import { events } from './modules/events/index.js';
import { identity } from './modules/identity/index.js';
import { notifications } from './modules/notifications/index.js';
import type { TemplatePayloads } from './modules/notifications/index.js';
import { profile } from './modules/profile/index.js';
import { registration } from './modules/registration/index.js';
import { sport } from './modules/sport/index.js';
import { tournament } from './modules/tournament/index.js';
import { venues } from './modules/venues/index.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Everyone on an entry: the captain, and the partner for doubles. */
async function membersOf(registrationId: string): Promise<string[]> {
  const team = await registration.teamFor(registrationId);
  if (team.length > 0) return team.map((m) => m.userId);
  const found = await registration.findById(registrationId);
  return found ? [found.captainUserId] : [];
}

/** Minutes until an ISO instant, never below 1; null when there is none. */
function minutesUntil(iso: unknown): number | null {
  const at = str(iso);
  if (!at) return null;
  return Math.max(1, Math.round((Date.parse(at) - Date.now()) / 60_000));
}

/** scoring R6 — who answers a result: the side that did not submit it, or both if staff did. */
async function answeringSide(
  match: { sideARegistrationId: string; sideBRegistrationId: string },
  submittedBy: string,
): Promise<string[]> {
  const [a, b] = await Promise.all([
    membersOf(match.sideARegistrationId),
    membersOf(match.sideBRegistrationId),
  ]);
  return a.includes(submittedBy) ? b : b.includes(submittedBy) ? a : [...a, ...b];
}

async function entryContext(registrationId: string) {
  const entry = await registration.findById(registrationId);
  if (!entry) return null;
  const [event, category] = await Promise.all([
    events.byId(entry.eventId),
    events.categoryById(entry.eventCategoryId),
  ]);
  return { entry, event, category };
}

const eventTarget = (event: { id: string; slug: string }) =>
  ({ kind: 'event', id: event.id, slug: event.slug }) as const;

/** F12 — the host's own screen for this event (the in-app organizer section). */
const organizerTarget = (event: { slug: string }) =>
  ({ kind: 'route', route: 'organizer_dashboard', id: event.slug }) as const;

/** Owners and managers: who runs the event day to day. */
async function runnersOf(eventId: string): Promise<string[]> {
  return (await identity.staffFor(eventId))
    .filter((g) => g.role === 'owner' || g.role === 'manager')
    .map((g) => g.userId);
}

/** "Asha & Ravi" — an entry as people read it. */
async function entryName(registrationId: string): Promise<string> {
  const ids = await membersOf(registrationId);
  const users = await identity.contactsByIds(ids);
  const names = ids.map((id) => users.find((u) => u.id === id)?.displayName ?? '').filter(Boolean);
  return names.join(' & ') || 'A player';
}

/** Achievement keys have no titles on the wire yet (G14). The key, readable. */
const humanise = (key: string) =>
  key.replace(/[._-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const notify = {
  async registrationConfirmed(payload: Record<string, unknown>): Promise<void> {
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    if (!ctx) return;
    await notifications.emitBulk(
      await membersOf(ctx.entry.id),
      'registration.confirmed',
      { eventTitle: ctx.event.title, categoryName: ctx.category.name },
      eventTarget(ctx.event),
    );
  },

  async partnerInvited(payload: Record<string, unknown>): Promise<void> {
    // An invite by email to somebody with no account yet has nobody to notify:
    // the email the registration module sent is the whole invitation.
    const invitee = str(payload['invitedUserId']);
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    if (!invitee || !ctx) return;
    await notifications.emit(
      invitee,
      'partner.invite',
      { eventTitle: ctx.event.title, categoryName: ctx.category.name },
      eventTarget(ctx.event),
    );
  },

  async partnerDeclined(payload: Record<string, unknown>): Promise<void> {
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    if (!ctx) return;
    await notifications.emit(
      ctx.entry.captainUserId,
      'partner.declined',
      { eventTitle: ctx.event.title, categoryName: ctx.category.name },
      eventTarget(ctx.event),
    );
  },

  async waitlistOffered(payload: Record<string, unknown>): Promise<void> {
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    if (!ctx) return;
    await notifications.emit(
      ctx.entry.captainUserId,
      'waitlist.offer',
      { eventTitle: ctx.event.title, categoryName: ctx.category.name },
      eventTarget(ctx.event),
    );
  },

  async registrationExpired(payload: Record<string, unknown>): Promise<void> {
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    const reason = str(payload['reason']) as TemplatePayloads['registration.expired']['reason'] | null;
    if (!ctx || !reason) return;
    await notifications.emit(
      ctx.entry.captainUserId,
      'registration.expired',
      { eventTitle: ctx.event.title, reason },
      eventTarget(ctx.event),
    );
  },

  async paymentUpdated(state: 'failed' | 'refunded', payload: Record<string, unknown>): Promise<void> {
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    if (!ctx) return;
    await notifications.emit(
      ctx.entry.captainUserId,
      'payment.updated',
      { eventTitle: ctx.event.title, state, amountPaise: str(payload['amountPaise']) },
      { kind: 'route', route: 'payment_history' },
    );
  },

  async eventCancelled(payload: Record<string, unknown>): Promise<void> {
    const eventId = str(payload['eventId']);
    if (!eventId) return;
    const event = await events.byId(eventId);
    const recipients: string[] = [];
    for (const category of await events.categoriesFor(eventId)) {
      for (const entry of await registration.confirmedForCategory(category.id)) {
        recipients.push(...(await membersOf(entry.id)));
      }
    }
    const reason = str(payload['reason']);
    await notifications.emitBulk(
      recipients,
      'event.cancelled',
      { eventTitle: event.title, reason: reason && reason !== 'Cancelled by the host' ? reason : null },
      eventTarget(event),
    );
  },

  /** F18 — everyone entered hears the place or dates moved, and that they may leave in full. */
  async eventChanged(payload: Record<string, unknown>): Promise<void> {
    const eventId = str(payload['eventId']);
    if (!eventId) return;
    const event = await events.byId(eventId);
    const recipients: string[] = [];
    for (const category of await events.categoriesFor(eventId)) {
      for (const entry of await registration.confirmedForCategory(category.id)) {
        recipients.push(...(await membersOf(entry.id)));
      }
    }
    await notifications.emitBulk(
      recipients,
      'event.changed',
      { eventTitle: event.title, datesChanged: payload['datesChanged'] === true, placeChanged: payload['placeChanged'] === true },
      eventTarget(event),
    );
  },

  /** F25 — a draw finished: everyone in it hears who won. */
  async drawFinished(payload: Record<string, unknown>): Promise<void> {
    const categoryId = str(payload['eventCategoryId']);
    const tournamentId = str(payload['tournamentId']);
    if (!categoryId || !tournamentId) return;
    const category = await events.categoryById(categoryId);
    const event = await events.byId(category.eventId);
    const standings = await tournament.standingsFor(categoryId);
    let winnerId = standings.find((r) => r.place === 1)?.registrationId ?? null;
    if (!winnerId) {
      // A league or group stage: the table decides.
      const tables = await tournament.leagueTableFor(categoryId);
      winnerId = tables.length === 1 ? (tables[0]!.table[0]?.registrationId ?? null) : null;
    }
    if (!winnerId) return;
    const recipients: string[] = [];
    for (const entry of await registration.confirmedForCategory(categoryId)) {
      recipients.push(...(await membersOf(entry.id)));
    }
    await notifications.emitBulk(
      recipients,
      'draw.finished',
      { eventTitle: event.title, categoryName: category.name, winnerName: await entryName(winnerId) },
      eventTarget(event),
    );
  },

  /** F3 — the reporter hears what PL4Y decided. */
  async reportResolved(payload: Record<string, unknown>): Promise<void> {
    const eventId = str(payload['eventId']);
    const reportId = str(payload['reportId']);
    const outcome = payload['outcome'] === 'resolved' ? 'resolved' : 'dismissed';
    if (!eventId || !reportId) return;
    const event = await events.byId(eventId);
    const report = (await events.reports(outcome)).find((r) => r.id === reportId);
    if (!report) return;
    await notifications.emit(report.reporterUserId, 'event.report_resolved', { eventTitle: event.title, outcome }, eventTarget(event));
  },

  // --- F12: the host hears what their event needs --------------------------------

  async hostNewEntry(payload: Record<string, unknown>): Promise<void> {
    const ctx = await entryContext(str(payload['registrationId']) ?? '');
    if (!ctx) return;
    const owner = ctx.event.organizerId;
    // A host entering their own draw does not need telling.
    if ((await membersOf(ctx.entry.id)).includes(owner)) return;
    await notifications.emit(
      owner,
      'host.new_entry',
      { eventTitle: ctx.event.title, categoryName: ctx.category.name, entrantName: await entryName(ctx.entry.id) },
      organizerTarget(ctx.event),
    );
  },

  async hostDrawShort(payload: Record<string, unknown>): Promise<void> {
    const categoryId = str(payload['categoryId']);
    if (!categoryId) return;
    const category = await events.categoryById(categoryId);
    const event = await events.byId(category.eventId);
    await notifications.emitBulk(
      await runnersOf(event.id),
      'host.draw_short',
      {
        eventTitle: event.title,
        categoryName: category.name,
        confirmed: Number(payload['confirmed'] ?? 0),
        minEntries: Number(payload['minEntries'] ?? category.minEntries),
      },
      organizerTarget(event),
    );
  },

  async hostDrawCancelled(payload: Record<string, unknown>): Promise<void> {
    const categoryId = str(payload['categoryId']);
    if (!categoryId) return;
    const category = await events.categoryById(categoryId);
    const event = await events.byId(category.eventId);
    // An event the host cancelled whole tells them nothing new.
    if (event.status === 'cancelled') return;
    await notifications.emitBulk(
      await runnersOf(event.id),
      'host.draw_cancelled',
      { eventTitle: event.title, categoryName: category.name },
      organizerTarget(event),
    );
  },

  async hostReadyToDraw(payload: Record<string, unknown>): Promise<void> {
    const categoryId = str(payload['categoryId']);
    if (!categoryId) return;
    const category = await events.categoryById(categoryId);
    const event = await events.byId(category.eventId);
    await notifications.emitBulk(
      await runnersOf(event.id),
      'host.ready_to_draw',
      {
        eventTitle: event.title,
        categoryName: category.name,
        heats: ['performance', 'scorecard'].includes((await sport.ruleForCategory(category)).kind),
      },
      organizerTarget(event),
    );
  },

  /** The app made the draw itself (autoDraw.ts): the hosts are told, and where to change it. */
  async hostDrawMade(payload: { categoryId: string; heats: number }): Promise<void> {
    const category = await events.categoryById(payload.categoryId);
    const event = await events.byId(category.eventId);
    await notifications.emitBulk(
      await runnersOf(event.id),
      'host.draw_made',
      { eventTitle: event.title, categoryName: category.name, heats: payload.heats },
      organizerTarget(event),
    );
  },

  async hostEventCompleted(payload: Record<string, unknown>, payoutDueAt: Date | null): Promise<void> {
    const eventId = str(payload['eventId']);
    if (!eventId) return;
    const event = await events.byId(eventId);
    await notifications.emit(
      event.organizerId,
      'host.event_completed',
      { eventTitle: event.title, payoutDueAt: payoutDueAt?.toISOString() ?? null },
      organizerTarget(event),
    );
  },

  /** events R9 — one draw missed its minimum. Everyone confirmed in it. */
  async categoryCancelled(payload: Record<string, unknown>): Promise<void> {
    const categoryId = str(payload['categoryId']);
    if (!categoryId) return;
    const category = await events.categoryById(categoryId);
    const event = await events.byId(category.eventId);
    const recipients: string[] = [];
    for (const entry of await registration.confirmedForCategory(categoryId)) {
      recipients.push(...(await membersOf(entry.id)));
    }
    await notifications.emitBulk(
      recipients,
      'category.cancelled',
      { eventTitle: event.title, categoryName: category.name },
      eventTarget(event),
    );
  },

  /** R11 — the organizer's words ride as a payload field; the template frames them. */
  async organizerMessage(payload: Record<string, unknown>): Promise<void> {
    const eventId = str(payload['eventId']);
    const message = str(payload['message']);
    if (!eventId || !message) return;
    const event = await events.byId(eventId);
    const recipients: string[] = [];
    for (const category of await events.categoriesFor(eventId)) {
      for (const entry of await registration.confirmedForCategory(category.id)) {
        recipients.push(...(await membersOf(entry.id)));
      }
    }
    await notifications.emitBulk(recipients, 'organizer.message', { eventTitle: event.title, message }, eventTarget(event));
  },

  async drawGenerated(payload: Record<string, unknown>): Promise<void> {
    const categoryId = str(payload['eventCategoryId']);
    if (!categoryId) return;
    const category = await events.categoryById(categoryId);
    const event = await events.byId(category.eventId);
    const recipients: string[] = [];
    for (const entry of await registration.confirmedForCategory(categoryId)) {
      recipients.push(...(await membersOf(entry.id)));
    }
    await notifications.emitBulk(
      recipients,
      'draw.generated',
      { eventTitle: event.title, categoryName: category.name },
      // N2 — "See who you play" opens the draw itself, not the event page.
      { kind: 'route', route: 'event_draw', id: event.slug },
    );
  },

  /**
   * chat R8 — a request, or the first unread message of a conversation. The
   * producer decided whether this one deserves a push; this only words it.
   */
  async chatNotify(payload: Record<string, unknown>): Promise<void> {
    const [sender, recipient] = await Promise.all([
      profile.findById(str(payload['senderId']) ?? ''),
      profile.findById(str(payload['recipientId']) ?? ''),
    ]);
    const conversationId = str(payload['conversationId']);
    if (!sender || !recipient || !conversationId) return;
    const target = { kind: 'route' as const, route: 'conversation' as const, id: conversationId };
    if (payload['kind'] === 'request') {
      await notifications.emit(recipient.userId, 'chat.request', { fromName: sender.displayName }, target);
    } else {
      const preview = (str(payload['preview']) ?? '').slice(0, 80);
      await notifications.emit(recipient.userId, 'chat.message', { fromName: sender.displayName, preview }, target);
    }
  },

  async achievementEarned(payload: Record<string, unknown>): Promise<void> {
    const player = await profile.findById(str(payload['playerId']) ?? '');
    const key = str(payload['key']);
    if (!player || !key) return;
    await notifications.emit(player.userId, 'achievement.earned', { title: humanise(key) }, { kind: 'player', id: player.id });
  },

  /** The national board only: a city board moving too would be the same news twice. */
  async rankingMoved(payload: Record<string, unknown>): Promise<void> {
    const movement = Number(payload['movement'] ?? 0);
    if (payload['scope'] !== 'national' || !Number.isFinite(movement) || movement === 0) return;
    const player = await profile.findById(str(payload['playerId']) ?? '');
    const sportId = str(payload['sportId']);
    if (!player || !sportId) return;
    const sportName = (await sport.list()).find((s) => s.id === sportId)?.name ?? 'your sport';
    await notifications.emit(
      player.userId,
      'ranking.changed',
      { sportName, rank: Number(payload['rank']), movement },
      { kind: 'player', id: player.id },
    );
  },

  async matchStartingSoon(matchId: string): Promise<void> {
    const match = await tournament.matchById(matchId).catch(() => null);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId) return;
    const draw = await tournament.byId(match.tournamentId);
    const event = await events.byId(draw.eventId);
    const court = match.courtId ? await venues.findCourtById(match.courtId) : null;
    const recipients = [
      ...(await membersOf(match.sideARegistrationId)),
      ...(await membersOf(match.sideBRegistrationId)),
    ];
    await notifications.emitBulk(
      recipients,
      'match.starting_soon',
      {
        eventTitle: event.title,
        courtName: court?.name ?? null,
        startsAt: (match.scheduledAt ?? new Date()).toISOString(),
      },
      { kind: 'match', id: match.id },
    );
  },

  /**
   * A knockout match just got its second side: tell both who they play next.
   * Matches that are ready the moment a draw is made (round 1, every league
   * and group match) are skipped — `draw.generated` already told everyone.
   */
  async matchReady(payload: Record<string, unknown>): Promise<void> {
    const bracket = str(payload['bracket']);
    const round = Number(payload['round'] ?? 0);
    if (bracket === 'league' || bracket === 'group') return;
    if (bracket === 'championship' && round <= 1) return;
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId) return;
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    const sides = [
      [match.sideARegistrationId, match.sideBRegistrationId],
      [match.sideBRegistrationId, match.sideARegistrationId],
    ] as const;
    for (const [mine, theirs] of sides) {
      const opponentName = (await registration.teamNameFor(theirs)) ?? (await entryName(theirs));
      await notifications.emitBulk(
        await membersOf(mine),
        'match.ready',
        { eventTitle: event.title, opponentName },
        { kind: 'match', id: match.id },
      );
    }
  },

  /** scoring R6, R11 — the side that did NOT submit is asked to confirm, and told when it confirms itself. */
  async resultSubmitted(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    const submittedBy = str(payload['submittedBy']);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId || !submittedBy) return;
    const recipients = await answeringSide(
      { sideARegistrationId: match.sideARegistrationId, sideBRegistrationId: match.sideBRegistrationId },
      submittedBy,
    );
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    await notifications.emitBulk(
      recipients,
      'match.result_pending',
      { eventTitle: event.title, autoConfirmMinutes: minutesUntil(payload['autoConfirmAt']) },
      { kind: 'match', id: match.id },
    );
  },

  /** scoring R14 — once, half-way through the window. */
  async resultReminder(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    const submittedBy = str(payload['submittedBy']);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId || !submittedBy) return;
    if (match.status !== 'awaiting_confirm') return;
    const recipients = await answeringSide(
      { sideARegistrationId: match.sideARegistrationId, sideBRegistrationId: match.sideBRegistrationId },
      submittedBy,
    );
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    await notifications.emitBulk(
      recipients,
      'match.result_reminder',
      { eventTitle: event.title, autoConfirmMinutes: minutesUntil(payload['autoConfirmAt']) },
      { kind: 'match', id: match.id },
    );
  },

  /** scoring R13 — owners and managers, one message per event per sweep. */
  async resultsWaiting(payload: Record<string, unknown>): Promise<void> {
    const eventId = str(payload['eventId']);
    const count = Number(payload['count'] ?? 0);
    if (!eventId || !Number.isFinite(count) || count < 1) return;
    const event = await events.byId(eventId);
    const recipients = (await identity.staffFor(eventId))
      .filter((g) => g.role === 'owner' || g.role === 'manager')
      .map((g) => g.userId);
    if (recipients.length === 0) return;
    await notifications.emitBulk(
      recipients,
      'match.results_waiting',
      { eventTitle: event.title, count },
      // F12 — straight to the organizer section's "needs you" list.
      organizerTarget(event),
    );
  },

  /** The side whose score was disputed hears it; the organizer is asked to settle it. */
  async resultDisputed(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    const disputedBy = str(payload['disputedBy']);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId || !disputedBy) return;
    const [a, b] = await Promise.all([
      membersOf(match.sideARegistrationId),
      membersOf(match.sideBRegistrationId),
    ]);
    const players = a.includes(disputedBy) ? b : b.includes(disputedBy) ? a : [];
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    const target = { kind: 'match', id: match.id } as const;
    // F4 — only an owner or manager who is not playing in the match may settle
    // it. With none, the dispute is PL4Y's, and the players are told so.
    const inMatch = new Set([...a, ...b]);
    const settlers = (await runnersOf(event.id)).filter((id) => !inMatch.has(id));
    const reviewer = settlers.length > 0 ? 'organizer' : 'pl4y';
    if (players.length > 0) {
      await notifications.emitBulk(players, 'match.result_disputed', { eventTitle: event.title, audience: 'player', reviewer }, target);
    }
    if (settlers.length > 0) {
      await notifications.emitBulk(settlers, 'match.result_disputed', { eventTitle: event.title, audience: 'organizer' }, target);
    }
  },

  async resultConfirmed(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId) return;
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    const auto = payload['via'] === 'auto';
    for (const side of [match.sideARegistrationId, match.sideBRegistrationId]) {
      await notifications.emitBulk(
        await membersOf(side),
        'match.result',
        {
          eventTitle: event.title,
          won: match.winnerRegistrationId === side,
          drawn: match.winnerRegistrationId === null,
          league: match.bracket === 'league' || match.bracket === 'group',
          last: match.winnerMatchId === null,
          auto,
        },
        { kind: 'match', id: match.id },
      );
    }
  },

  /** rating R2 — the settled number only; the provisional one already arrives with the result. */
  async ratingChanged(payload: Record<string, unknown>): Promise<void> {
    if (payload['isProvisional'] !== false) return;
    const before = Number(payload['ratingBefore']);
    const after = Number(payload['ratingAfter']);
    const delta = after - before;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;
    const player = await profile.findById(str(payload['playerId']) ?? '');
    const sportId = str(payload['sportId']);
    if (!player || !sportId) return;
    const sportName = (await sport.list()).find((s) => s.id === sportId)?.name ?? 'your sport';
    await notifications.emit(
      player.userId,
      'rating.changed',
      { sportName, rating: after, delta },
      { kind: 'player', id: player.id },
    );
  },
};
