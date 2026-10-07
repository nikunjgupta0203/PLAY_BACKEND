/**
 * scoring — service tests against a real Postgres (conventions.md §5).
 *
 * The engine's arithmetic is unit-tested without a database in
 * src/modules/scoring/engine.test.ts. What is under test HERE is what only the
 * database can promise: two devices racing for one sequence number, a log no
 * UPDATE can rewrite, and a confirmation that advances the bracket in the same
 * transaction that records it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, closeBeforeDrawing, closeBeforeHeats, webhookBody, type FakeGateway } from './helpers/modules.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { VenueService } from '../src/modules/venues/service/index.js';
import type { Match, TournamentService } from '../src/modules/tournament/service/index.js';
import {
  ScoringCode,
  type ScoringService,
  type Side,
} from '../src/modules/scoring/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import {
  BASKETBALL,
  FOOTBALL,
  KABADDI, CRICKET, CHESS, ESPORTS, SNOOKER, BOXING, KARATE, RUNNING, GOLF,
  PICKLEBALL,
  seedSport,
  type SportSeed,
} from '../src/modules/sport/seed.js';
import type { Dismissal, ScoreEvent } from '../src/modules/scoring/engine.js';
import type { FieldService } from '../src/modules/scoring/service/field.js';

let prisma: PrismaClient;
let scoring: ScoringService;
let field: FieldService;
let unwrappedField: FieldService;
let tournament: TournamentService;
let registration: RegistrationService;
let payments: PaymentsService;
let events: EventService;
let venues: VenueService;
let profile: ProfileService;
let sport: SportService;
let gateway: FakeGateway;
let clock: { offsetMs: number };
let pickleballId: string;
let identity: ReturnType<typeof buildModules>['identity'];

const DAY = 86_400_000;
const MINUTE = 60_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

interface Player {
  userId: string;
  actor: { userId: string };
}

let organizer: Player;

async function makePlayer(name: string): Promise<Player> {
  const userId = newId();
  const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({ data: { playerId, sportId: pickleballId, skillBand: '3.5' } });
  return { userId, actor: { userId } };
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

let webhookSeq = 0;
async function enter(categoryId: string, player: Player): Promise<string> {
  const entry = await registration.begin(player.actor, { eventCategoryId: categoryId });
  const order = await payments.createOrder(player.actor, entry.id);
  const entity = gateway.capture(order.gatewayOrderId);
  webhookSeq += 1;
  const id = `evt_SCORE${webhookSeq}`;
  await prisma.paymentWebhookEvent.create({
    data: {
      gatewayEventId: id,
      eventType: 'payment.captured',
      payload: webhookBody({ id, type: 'payment.captured', payment: entity }),
    },
  });
  await payments.applyWebhook(id);
  return entry.id;
}

interface Draw {
  eventId: string;
  players: Map<string, Player>;
  /** A round-1 Championship match with both sides filled. */
  match: Match;
  /** The player on each side of `match`. */
  side: Record<Side, Player>;
}

/** A published four-entry singles draw, generated. */
async function drawOfFour(): Promise<Draw> {
  return drawOf(pickleballId, PICKLEBALL);
}

const SEEDS: Record<string, SportSeed> = {
  pickleball: PICKLEBALL,
  basketball: BASKETBALL,
  football: FOOTBALL,
  kabaddi: KABADDI,
  cricket: CRICKET,
  chess: CHESS,
  esports: ESPORTS,
  snooker: SNOOKER,
  boxing: BOXING,
  karate: KARATE,
};

/**
 * A published four-entry draw for any seeded sport, generated. Singles entries
 * go through the real registration and payment path. Registration's partner
 * flow only knows doubles, so a team sport's entries (3-a-side and up) are
 * written confirmed straight into the table, one captain each.
 */
async function drawOf(sportId: string, seed: SportSeed): Promise<Draw> {
  const format = seed.formats[0]!;
  const startsAt = soon(30);
  const venue = await venues.create(organizer.actor, {
    name: `Club ${newId().slice(0, 8)}`,
    address: '100 Feet Road',
    city: 'Bengaluru',
    location: { lat: 12.9784, lng: 77.6408 },
    courts: [{ name: 'Court 1', sportIds: [sportId] }],
  });
  const event = await events.create(organizer.actor, {
    sportId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `Open ${newId().slice(0, 8)}`,
    venueId: venue.id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    registrationClosesAt: new Date(startsAt.getTime() - DAY),
    cancellationCutoffAt: new Date(startsAt.getTime() - 2 * DAY),
  });
  const category = await events.addCategory(organizer.actor, event.id, {
    name: format.name,
    format: format.key,
    capacity: 16,
    minEntries: 4,
    entryFeePaise: 50_000n,
    platformFeePaise: 5_000n,
    taxBps: 1800,
  });
  await events.publish(organizer.actor, event.id);

  const players = new Map<string, Player>();
  for (let i = 0; i < 4; i += 1) {
    const p = await makePlayer(`Player ${i + 1}`);
    if (format.teamSize === 1) {
      players.set(await enter(category.id, p), p);
    } else {
      const id = newId();
      await prisma.registration.create({
        data: {
          id,
          eventId: event.id,
          eventCategoryId: category.id,
          sportId,
          captainUserId: p.userId,
          status: 'confirmed',
          confirmedAt: new Date(),
          amountPaise: 0n,
        },
      });
      players.set(id, p);
    }
  }
  const draw = await tournament.generateDraw(organizer.actor, { eventCategoryId: category.id });
  const match = (await tournament.matchesFor(draw.id)).find(
    (m) => m.bracket === 'championship' && m.round === 1,
  )!;
  return {
    eventId: event.id,
    players,
    match,
    side: {
      a: players.get(match.sideARegistrationId!)!,
      b: players.get(match.sideBRegistrationId!)!,
    },
  };
}

/** A live match (seq 1) in the named sport, started by the organizer as scorer. */
async function liveMatch(opts: {
  sport: string;
}): Promise<{ match: Match; scorer: Player['actor'] }> {
  const seed = SEEDS[opts.sport]!;
  const sportId = opts.sport === 'pickleball' ? pickleballId : await seedSport(prisma, seed);
  sport.refresh();
  const { match } = await drawOf(sportId, seed);
  const scorer = organizer.actor;
  await scoring.start(scorer, match.id);
  return { match, scorer };
}

/** Taps `rallies` in order from the scorer's device, each against the current seq. */
async function tap(scorer: Player, matchId: string, rallies: string): Promise<number> {
  let seq = (await scoring.snapshot(matchId)).seq;
  for (const ch of rallies) {
    seq = (await scoring.recordPoint(scorer.actor, { matchId, side: ch as Side, expectedSeq: seq }))
      .seq;
  }
  return seq;
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  scoring = wired.scoring;
  unwrappedField = wired.field;
  field = closeBeforeHeats(wired.field, prisma);
  tournament = closeBeforeDrawing(wired.tournament, prisma);
  registration = wired.registration;
  payments = wired.payments;
  events = wired.events;
  venues = wired.venues;
  profile = wired.profile;
  sport = wired.sport;
  gateway = wired.gateway;
  clock = wired.clock;
  identity = wired.identity;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  gateway.reset();
  clock.offsetMs = 0;
  webhookSeq = 0;
  organizer = await makePlayer('Organizer');
});

describe('scoring — who may score', () => {
  it('a player in the match and the organizer may; a stranger may not', async () => {
    const { match, side } = await drawOfFour();
    const stranger = await makePlayer('Stranger');
    expect((await scoring.access(side.a.actor, match.id)).canScore).toBe(true);
    expect((await scoring.access(organizer.actor, match.id)).canScore).toBe(true);
    expect((await scoring.access(stranger.actor, match.id)).canScore).toBe(false);
    expect(await errorCode(() => scoring.start(stranger.actor, match.id))).toBe('FORBIDDEN');
  });
});

describe('scoring — the point log', () => {
  it('start opens the log at seq 1 and flips the match live', async () => {
    const { match, side } = await drawOfFour();
    const snap = await scoring.start(side.a.actor, match.id);
    expect(snap.seq).toBe(1);
    expect(snap.state).toMatchObject({ current: { a: 0, b: 0 }, matchOver: false });
    expect((await tournament.matchById(match.id)).status).toBe('live');
    // Idempotent: a second phone tapping Start gets the same state, not an error.
    expect((await scoring.start(side.b.actor, match.id)).seq).toBe(1);
  });

  it('scoring R1: a stale expectedSeq is rejected, carrying the server state', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'aa');
    try {
      await scoring.recordPoint(side.b.actor, { matchId: match.id, side: 'b', expectedSeq: 1 });
      expect.unreachable();
    } catch (e) {
      expect(isUserError(e) && e.code).toBe(ScoringCode.SCORE_STALE);
      expect(isUserError(e) && e.details).toMatchObject({ seq: 3, state: { current: { a: 2, b: 0 } } });
    }
  });

  it('scoring R1: two devices racing for the same seq — exactly one point lands', async () => {
    const { match, side } = await drawOfFour();
    const { seq } = await scoring.start(side.a.actor, match.id);
    const results = await Promise.allSettled([
      scoring.recordPoint(side.a.actor, { matchId: match.id, side: 'a', expectedSeq: seq }),
      scoring.recordPoint(side.b.actor, { matchId: match.id, side: 'b', expectedSeq: seq }),
    ]);
    const landed = results.filter((r) => r.status === 'fulfilled');
    expect(landed).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isUserError(rejected.reason) && rejected.reason.code).toBe(ScoringCode.SCORE_STALE);
    expect(await prisma.matchScoreEvent.count({ where: { matchId: match.id } })).toBe(2);
  });

  it('scoring R2: undo is a new event, and the log cannot be rewritten', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    const seq = await tap(side.a, match.id, 'ab');
    const undone = await scoring.undo(side.a.actor, { matchId: match.id, expectedSeq: seq });
    expect(undone.state?.current).toEqual({ a: 1, b: 0 });

    const log = await scoring.timeline(match.id);
    expect(log.map((e) => e.kind)).toEqual(['start', 'point', 'point', 'undo']);

    await expect(
      prisma.$executeRaw`UPDATE match_score_events SET scoring_side = 'a' WHERE match_id = ${match.id}::uuid`,
    ).rejects.toThrow(/append-only/);
  });

  it('scoring R2: two undos take back two points; a third has nothing to take', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    let seq = await tap(side.a, match.id, 'ab');
    seq = (await scoring.undo(side.a.actor, { matchId: match.id, expectedSeq: seq })).seq;
    const twice = await scoring.undo(side.a.actor, { matchId: match.id, expectedSeq: seq });
    expect(twice.state?.current).toEqual({ a: 0, b: 0 });
    expect(
      await errorCode(() => scoring.undo(side.a.actor, { matchId: match.id, expectedSeq: twice.seq })),
    ).toBe(ScoringCode.NOTHING_TO_UNDO);
  });

  it('scoring R3: every event stores the whole score', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(11) + 'b');
    const last = (await scoring.timeline(match.id)).at(-1)!;
    expect(last.stateAfter).toMatchObject({
      games: [{ a: 11, b: 0 }],
      current: { a: 0, b: 1 },
      serving: 'b',
    });
  });
});

describe('scoring — results (R6)', () => {
  it('scoring R6: the last point submits the result and waits for the other side', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));

    expect((await tournament.matchById(match.id)).status).toBe('awaiting_confirm');
    const result = await scoring.resultFor(match.id);
    expect(result).toMatchObject({ outcome: 'played', confirmedAt: null });
    expect(result?.winnerRegistrationId).toBe(match.sideARegistrationId);
  });

  it('scoring R6: the submitting side cannot confirm its own result', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(await errorCode(() => scoring.confirmResult(side.a.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R6: the other side confirms, and the winner advances in the same transaction', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await scoring.confirmResult(side.b.actor, match.id);

    const done = await tournament.matchById(match.id);
    expect(done.status).toBe('completed');
    expect(done.winnerRegistrationId).toBe(match.sideARegistrationId);
    const next = await tournament.matchById(match.winnerMatchId!);
    expect([next.sideARegistrationId, next.sideBRegistrationId]).toContain(match.sideARegistrationId);

    const outbox = await prisma.outbox.findMany({ where: { topic: 'result.confirmed' } });
    expect(outbox).toHaveLength(1);
    expect(
      await errorCode(() => scoring.confirmResult(side.b.actor, match.id)),
    ).toBe(ScoringCode.RESULT_ALREADY_CONFIRMED);
  });

  it('scoring R6: an organizer override opens 15 minutes after submission', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));

    expect(await errorCode(() => scoring.confirmResult(organizer.actor, match.id))).toBe(
      ScoringCode.OVERRIDE_TOO_EARLY,
    );
    clock.offsetMs = 16 * MINUTE;
    await scoring.confirmResult(organizer.actor, match.id);
    expect((await tournament.matchById(match.id)).status).toBe('completed');
  });

  it('scoring R6: a disputed result is the organizer’s to settle, at once', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await scoring.disputeResult(side.b.actor, match.id, 'Second game was 11–9, not 11–0');

    expect(await errorCode(() => scoring.confirmResult(side.b.actor, match.id))).toBe(
      ScoringCode.RESULT_DISPUTED,
    );
    // The organizer settles it with the right score, then confirms.
    await scoring.submitResult(organizer.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    await scoring.confirmResult(side.b.actor, match.id);
    expect((await scoring.resultFor(match.id))?.games).toEqual([{ a: 11, b: 0 }, { a: 11, b: 9 }]);
  });

  it('undoing the final point takes back its unconfirmed result — staff only (gap #19)', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    const seq = await tap(side.a, match.id, 'a'.repeat(22));
    // A player who disagrees disputes; they do not reopen the match.
    expect(await errorCode(() => scoring.undo(side.b.actor, { matchId: match.id, expectedSeq: seq }))).toBe('USE_DISPUTE');
    expect(await errorCode(() => scoring.undo(side.a.actor, { matchId: match.id, expectedSeq: seq }))).toBe('USE_DISPUTE');
    const snap = await scoring.undo(organizer.actor, { matchId: match.id, expectedSeq: seq });
    expect(snap.state).toMatchObject({ current: { a: 10, b: 0 }, matchOver: false });
    expect((await tournament.matchById(match.id)).status).toBe('live');
    expect(await scoring.resultFor(match.id)).toBeNull();
  });

  it('scoring R10: a walkover is submitted without a point log', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(organizer.actor, {
      matchId: match.id,
      outcome: 'walkover',
      games: [],
      winner: 'b',
    });
    await scoring.confirmResult(side.a.actor, match.id);
    const done = await tournament.matchById(match.id);
    expect(done.status).toBe('walkover');
    expect(done.winnerRegistrationId).toBe(match.sideBRegistrationId);
    expect(await prisma.matchScoreEvent.count({ where: { matchId: match.id } })).toBe(0);
  });

  it('scoring R4: a hand-entered score is held to the sport’s rule', async () => {
    const { match } = await drawOfFour();
    expect(
      await errorCode(() =>
        scoring.submitResult(organizer.actor, {
          matchId: match.id,
          outcome: 'played',
          games: [{ a: 13, b: 5 }, { a: 11, b: 2 }],
        }),
      ),
    ).toBe(ScoringCode.INVALID_RESULT);
  });

  it('rating reads only confirmed results', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(await scoring.confirmedResult(match.id)).toBeNull();
    await scoring.confirmResult(side.b.actor, match.id);
    expect(await scoring.confirmedResult(match.id)).toMatchObject({
      outcome: 'played',
      sportId: pickleballId,
    });
  });
});

describe('result finality — provenance and deadline (R11, R12)', () => {
  const window = (r: { submittedAt: Date; autoConfirmAt: Date | null } | null) =>
    r?.autoConfirmAt ? r.autoConfirmAt.getTime() - r.submittedAt.getTime() : null;

  it('scoring R12, F5: a player’s own live score waits two hours for the other side; staff live scoring confirms itself in 60 minutes', async () => {
    const own = await drawOfFour();
    await scoring.start(own.side.a.actor, own.match.id);
    await tap(own.side.a, own.match.id, 'a'.repeat(22));
    const mine = await scoring.resultFor(own.match.id);
    expect(mine).toMatchObject({ source: 'live', submitterRole: 'player' });
    expect(window(mine)).toBe(120 * MINUTE);

    const { match } = await drawOfFour();
    await scoring.start(organizer.actor, match.id);
    await tap(organizer, match.id, 'a'.repeat(22));
    const r = await scoring.resultFor(match.id);
    expect(r).toMatchObject({ source: 'live', submitterRole: 'staff', confirmedVia: null });
    expect(window(r)).toBe(60 * MINUTE);
  });

  it('scoring R12, F5: a played score typed by a player confirms itself only after two hours of silence', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    const r = await scoring.resultFor(match.id);
    expect(r).toMatchObject({ source: 'typed', submitterRole: 'player' });
    expect(window(r)).toBe(120 * MINUTE);
  });

  it('F6, F5: a player’s walkover waits until the match is 15 minutes late, then two hours; the organizer’s confirms in 60 minutes', async () => {
    const first = await drawOfFour();
    const claim = () =>
      scoring.submitResult(first.side.a.actor, { matchId: first.match.id, outcome: 'walkover', games: [], winner: 'a' });
    expect(await errorCode(claim)).toBe(ScoringCode.WALKOVER_TOO_EARLY);
    // The event starts in 30 days; 16 minutes after that the claim stands.
    clock.offsetMs = 30 * DAY + 16 * MINUTE;
    await claim();
    expect(window(await scoring.resultFor(first.match.id))).toBe(120 * MINUTE);
    clock.offsetMs = 0;

    const second = await drawOfFour();
    await scoring.submitResult(organizer.actor, {
      matchId: second.match.id, outcome: 'walkover', games: [], winner: 'a',
    });
    const r = await scoring.resultFor(second.match.id);
    expect(r).toMatchObject({ source: 'typed', submitterRole: 'staff' });
    expect(window(r)).toBe(60 * MINUTE);
  });

  // drawOfFour's event starts in 30 days and ends a day later. Moving the
  // clock, not the event, keeps every events-table CHECK satisfied.
  it('scoring R11: the window is shortened to the event end', async () => {
    const { match } = await drawOfFour();
    clock.offsetMs = 31 * DAY - 30 * MINUTE;
    await scoring.start(organizer.actor, match.id);
    await tap(organizer, match.id, 'a'.repeat(22));
    const w = window(await scoring.resultFor(match.id))!;
    expect(w).toBeGreaterThan(29 * MINUTE);
    expect(w).toBeLessThanOrEqual(30 * MINUTE);
  });

  it('scoring R11: a match finished after the event ended still gets 15 minutes', async () => {
    const { match } = await drawOfFour();
    clock.offsetMs = 31 * DAY + 2 * 60 * MINUTE;
    await scoring.start(organizer.actor, match.id);
    await tap(organizer, match.id, 'a'.repeat(22));
    expect(window(await scoring.resultFor(match.id))).toBe(15 * MINUTE);
  });

  it('scoring R12: staff who play in the match are players when they type their own result', async () => {
    const { eventId, match, side } = await drawOfFour();
    await identity.addStaff(eventId, side.a.userId, 'scorer');
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 0 }],
    });
    const r = await scoring.resultFor(match.id);
    expect(r).toMatchObject({ source: 'typed', submitterRole: 'player' });
    // A player's window (F5), not staff's.
    expect(window(r)).toBe(120 * MINUTE);
  });

  it('a re-submission after a dispute starts the clock again', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await prisma.matchResult.update({
      where: { matchId: match.id },
      data: { remindedAt: new Date(), staffAlertedAt: new Date() },
    });
    await scoring.disputeResult(side.b.actor, match.id, 'Second game was 11–9');
    clock.offsetMs = 5 * MINUTE;
    await scoring.submitResult(organizer.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    const r = await scoring.resultFor(match.id);
    expect(r).toMatchObject({
      source: 'typed',
      submitterRole: 'staff',
      remindedAt: null,
      staffAlertedAt: null,
      disputedAt: null,
    });
    expect(window(r)).toBe(60 * MINUTE);
  });
});

describe('result finality — who confirms (R6, R11, R12)', () => {
  it('scoring R6: the opponent’s confirmation is recorded as such', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await scoring.confirmResult(side.b.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'opponent' });
    const [row] = await prisma.outbox.findMany({ where: { topic: 'result.confirmed' } });
    expect(row?.payload).toMatchObject({ via: 'opponent' });
  });

  it('scoring R6: the organizer override is recorded as staff', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    clock.offsetMs = 16 * MINUTE;
    await scoring.confirmResult(organizer.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'staff' });
  });

  it('scoring R12: a scorer who scored the match confirms it at once', async () => {
    const { eventId, match } = await drawOfFour();
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(volunteer.actor, match.id);
    await tap(volunteer, match.id, 'a'.repeat(22));

    const r = (await scoring.resultFor(match.id))!;
    const info = (await scoring.matchInfo(match.id))!;
    expect((await scoring.resultAccess(volunteer.actor, info, r)).canConfirm).toBe(true);
    await scoring.confirmResult(volunteer.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'staff' });
    expect((await tournament.matchById(match.id)).status).toBe('completed');
  });

  it('scoring R12: a scorer who recorded no points may not confirm', async () => {
    const { eventId, match, side } = await drawOfFour();
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(await errorCode(() => scoring.confirmResult(volunteer.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R12: a scorer who plays in the match is not a witness', async () => {
    const { eventId, match, side } = await drawOfFour();
    await identity.addStaff(eventId, side.a.userId, 'scorer');
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(await errorCode(() => scoring.confirmResult(side.a.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R12: a scorer cannot confirm a typed result, even one they started scoring', async () => {
    const { eventId, match, side } = await drawOfFour();
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(volunteer.actor, match.id);
    await tap(volunteer, match.id, 'aaa');
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'retired',
      games: [{ a: 3, b: 0 }],
      winner: 'a',
    });
    expect(await errorCode(() => scoring.confirmResult(volunteer.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R11: autoConfirm does nothing before the deadline and confirms after it', async () => {
    const { match } = await drawOfFour();
    await scoring.start(organizer.actor, match.id);
    await tap(organizer, match.id, 'a'.repeat(22));

    clock.offsetMs = 59 * MINUTE;
    expect(await scoring.autoConfirm(match.id)).toBeNull();

    clock.offsetMs = 60 * MINUTE + 1000;
    const confirmed = await scoring.autoConfirm(match.id);
    expect(confirmed).toMatchObject({ confirmedVia: 'auto', confirmedBy: null });
    expect((await tournament.matchById(match.id)).status).toBe('completed');
    const rows = await prisma.outbox.findMany({ where: { topic: 'result.confirmed' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ via: 'auto' });
  });

  it('scoring R11: a disputed result is never auto-confirmed', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await scoring.disputeResult(side.b.actor, match.id, 'Wrong score');
    clock.offsetMs = 3 * 60 * MINUTE;
    expect(await scoring.autoConfirm(match.id)).toBeNull();
    expect((await scoring.resultFor(match.id))?.confirmedAt).toBeNull();
  });

  it('scoring R11: a person who confirmed first wins; the sweep adds nothing', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    clock.offsetMs = 61 * MINUTE;
    await scoring.confirmResult(side.b.actor, match.id);
    expect(await scoring.autoConfirm(match.id)).toBeNull();
    expect(await prisma.outbox.count({ where: { topic: 'result.confirmed' } })).toBe(1);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'opponent' });
  });
});

describe('result finality — the sweep (R11, R13, R14)', () => {
  const outbox = (topic: string) => prisma.outbox.findMany({ where: { topic } });

  /** Live-scored by the organizer, not playing: the kind that confirms itself (gap #17). */
  async function liveResult() {
    const draw = await drawOfFour();
    await scoring.start(organizer.actor, draw.match.id);
    await tap(organizer, draw.match.id, 'a'.repeat(22));
    return draw;
  }

  it('scoring R11: confirms what is due, once', async () => {
    const { match } = await liveResult();
    clock.offsetMs = 30 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(0);

    clock.offsetMs = 61 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(1);
    expect((await tournament.matchById(match.id)).status).toBe('completed');
    expect((await scoring.sweep()).confirmed).toBe(0);
    expect(await outbox('result.confirmed')).toHaveLength(1);
  });

  it('scoring R11, F5: never confirms a disputed result; a player-typed one only after its two hours', async () => {
    const disputed = await liveResult();
    await scoring.disputeResult(disputed.side.b.actor, disputed.match.id, 'Wrong score');

    const typed = await drawOfFour();
    await scoring.submitResult(typed.side.a.actor, {
      matchId: typed.match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });

    clock.offsetMs = 119 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(0);
    clock.offsetMs = 5 * 60 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(1);
    expect((await scoring.resultFor(disputed.match.id))?.confirmedAt).toBeNull();
    expect(await scoring.resultFor(typed.match.id)).toMatchObject({ confirmedVia: 'auto', submitterRole: 'player' });
  });

  it('scoring R13: one alert per event once the override opens, each result counted once', async () => {
    const { eventId, match, players } = await liveResult();
    const other = (await tournament.matchesFor(match.tournamentId)).find(
      (m) => m.bracket === 'championship' && m.round === 1 && m.id !== match.id,
    )!;
    const otherA = players.get(other.sideARegistrationId!)!;
    await scoring.start(otherA.actor, other.id);
    await tap(otherA, other.id, 'a'.repeat(22));

    clock.offsetMs = 10 * MINUTE;
    expect((await scoring.sweep()).alerts).toBe(0);

    clock.offsetMs = 16 * MINUTE;
    expect((await scoring.sweep()).alerts).toBe(1);
    const alerts = await outbox('results.waiting');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toEqual({ eventId, count: 2 });

    clock.offsetMs = 20 * MINUTE;
    expect((await scoring.sweep()).alerts).toBe(0);
  });

  it('scoring R14: the opponent is reminded once, at half the window', async () => {
    const { match } = await liveResult();
    clock.offsetMs = 29 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(0);

    clock.offsetMs = 31 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(1);
    const [row] = await outbox('result.reminder');
    expect(row?.payload).toMatchObject({ matchId: match.id });
    expect(typeof (row?.payload as { autoConfirmAt: unknown }).autoConfirmAt).toBe('string');

    clock.offsetMs = 40 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(0);
  });

  it('scoring R14, F5: a player-typed result is reminded half-way through its two hours; a disputed one never', async () => {
    const typed = await drawOfFour();
    await scoring.submitResult(typed.side.a.actor, {
      matchId: typed.match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    const disputed = await liveResult();
    await scoring.disputeResult(disputed.side.b.actor, disputed.match.id, 'Wrong score');

    clock.offsetMs = 59 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(0);
    clock.offsetMs = 61 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(1);
    const [row] = await outbox('result.reminder');
    expect(row?.payload).toMatchObject({ matchId: typed.match.id });
    expect(typeof (row?.payload as { autoConfirmAt: unknown }).autoConfirmAt).toBe('string');
  });
});

describe('typed score events', () => {
  it('scoring R4: a basketball three is worth 3, and the event is kept with the state', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    const snap = await scoring.recordEvent(scorer, {
      matchId: match.id,
      event: { type: 'score', side: 'a', action: 'three' },
      expectedSeq: 1,
    });
    expect(snap.state?.current).toEqual({ a: 3, b: 0 });
    const [, last] = await scoring.timeline(match.id);
    expect(last).toMatchObject({
      kind: 'event',
      scoringSide: 'a',
      event: { type: 'score', side: 'a', action: 'three' },
    });
  });

  it('scoring R3: the database refuses a scoring side that is not a or b', async () => {
    const { match } = await liveMatch({ sport: 'basketball' });
    await expect(
      prisma.$executeRaw`INSERT INTO match_score_events (match_id, seq, kind, scoring_side, state_after, event, recorded_by)
        VALUES (${match.id}::uuid, 2, 'event', 'x', '{}'::jsonb, '{"type":"period_end"}'::jsonb, ${organizer.userId}::uuid)`,
    ).rejects.toThrow(/match_score_events_side_check/);
  });

  it('scoring R1: a typed event carries expectedSeq like a point', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    await expect(
      scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'period_end' }, expectedSeq: 0 }),
    ).rejects.toMatchObject({ code: 'SCORE_STALE' });
  });

  it('an event the sport does not take is refused and nothing is stored', async () => {
    const { match, scorer } = await liveMatch({ sport: 'football' });
    await expect(
      scoring.recordEvent(scorer, {
        matchId: match.id,
        event: { type: 'score', side: 'a', action: 'three' },
        expectedSeq: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
    expect(await scoring.timeline(match.id)).toHaveLength(1); // just the start
  });

  it('scoring R6: the event that ends the match submits the result', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    let seq = 1;
    const rec = async (event: ScoreEvent) => {
      await scoring.recordEvent(scorer, { matchId: match.id, event, expectedSeq: seq });
      seq += 1;
    };
    await rec({ type: 'score', side: 'b', action: 'two' });
    for (let i = 0; i < 4; i++) await rec({ type: 'period_end' });
    expect(await scoring.resultFor(match.id)).toMatchObject({ outcome: 'played', source: 'live' });
  });

  it('scoring R2: undo takes back a typed event', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    await scoring.recordEvent(scorer, {
      matchId: match.id,
      event: { type: 'score', side: 'a', action: 'three' },
      expectedSeq: 1,
    });
    const after = await scoring.undo(scorer, { matchId: match.id, expectedSeq: 2 });
    expect(after.state?.current).toEqual({ a: 0, b: 0 });
  });

  it('a level seeded kabaddi match at full time goes to a shootout and submits no result', async () => {
    const { match, scorer } = await liveMatch({ sport: 'kabaddi' });
    await scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'period_end' }, expectedSeq: 1 });
    const snap = await scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'period_end' }, expectedSeq: 2 });
    expect(snap.state).toMatchObject({ matchOver: false, winner: null, shootout: { a: [], b: [] } });
    expect(await scoring.resultFor(match.id)).toBeNull();
  });

  it('scoring R12: a scorer who recorded score events (not points) confirms at once', async () => {
    const sportId = await seedSport(prisma, BASKETBALL);
    sport.refresh();
    const { eventId, match } = await drawOf(sportId, BASKETBALL);
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(volunteer.actor, match.id);
    let seq = 1;
    await scoring.recordEvent(volunteer.actor, {
      matchId: match.id,
      event: { type: 'score', side: 'a', action: 'two' },
      expectedSeq: seq++,
    });
    for (let i = 0; i < 4; i++) {
      await scoring.recordEvent(volunteer.actor, {
        matchId: match.id,
        event: { type: 'period_end' },
        expectedSeq: seq++,
      });
    }
    const r = (await scoring.resultFor(match.id))!;
    const info = (await scoring.matchInfo(match.id))!;
    expect((await scoring.resultAccess(volunteer.actor, info, r)).canConfirm).toBe(true);
    await scoring.confirmResult(volunteer.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'staff' });
  });
});

describe('how a match was won (plan 3)', () => {
  async function playEvents(scorer: Player['actor'], matchId: string, events: ScoreEvent[]) {
    let seq = (await scoring.snapshot(matchId)).seq;
    for (const event of events) seq = (await scoring.recordEvent(scorer, { matchId, event, expectedSeq: seq })).seq;
  }
  const end: ScoreEvent = { type: 'period_end' };
  const kick = (side: Side, scored: boolean): ScoreEvent => ({ type: 'shootout_kick', side, scored });

  it('a live shootout win is stored with method shootout and the kick tally', async () => {
    const { match, scorer } = await liveMatch({ sport: 'football' });
    await playEvents(scorer, match.id, [end, end, end, end, kick('b', true), kick('a', false), kick('b', true), kick('a', false), kick('b', true), kick('a', false)]);
    expect(await scoring.resultFor(match.id)).toMatchObject({ method: 'shootout', margin: '0–3', games: [{ a: 0, b: 0 }] });
  });

  it('a typed level score is a finished match only with the penalties that decided it', async () => {
    const { match } = await liveMatch({ sport: 'football' });
    await expect(
      scoring.submitResult(organizer.actor, { matchId: match.id, outcome: 'played', games: [{ a: 1, b: 1 }] }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    await expect(
      scoring.submitResult(organizer.actor, { matchId: match.id, outcome: 'played', games: [{ a: 1, b: 1 }], penalties: { a: 3, b: 3 } }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    const r = await scoring.submitResult(organizer.actor, {
      matchId: match.id, outcome: 'played', games: [{ a: 1, b: 1 }], penalties: { a: 4, b: 3 },
    });
    expect(r).toMatchObject({ method: 'shootout', margin: '4–3', winnerRegistrationId: match.sideARegistrationId });
  });

  it('penalties are refused where the score was not level', async () => {
    const { match } = await liveMatch({ sport: 'football' });
    await expect(
      scoring.submitResult(organizer.actor, { matchId: match.id, outcome: 'played', games: [{ a: 2, b: 1 }], penalties: { a: 4, b: 3 } }),
    ).rejects.toMatchObject({ code: 'INVALID_RESULT' });
  });
});

describe('cricket (plan 4)', () => {
  const ball = (runs: number, wicket: Dismissal | null = null): ScoreEvent => ({ type: 'ball', runs, extra: null, wicket });

  it('scoring R4, R6: a T20 scored ball by ball submits the result with how it was won', async () => {
    const { match, scorer } = await liveMatch({ sport: 'cricket' });
    let seq = (await scoring.snapshot(match.id)).seq;
    const rec = async (event: ScoreEvent) => {
      seq = (await scoring.recordEvent(scorer, { matchId: match.id, event, expectedSeq: seq })).seq;
    };
    await rec(ball(4));
    for (let i = 0; i < 10; i += 1) await rec(ball(0, 'bowled'));
    const chasing = await scoring.snapshot(match.id);
    expect(chasing.state?.innings?.list[1]).toMatchObject({ batting: 'b', target: 5 });
    await rec(ball(6));
    expect(await scoring.resultFor(match.id)).toMatchObject({
      outcome: 'played', method: 'wickets', margin: '10', games: [{ a: 4, b: 6 }], winnerRegistrationId: match.sideBRegistrationId,
    });
  });

  it('a delivery the laws refuse is INVALID_EVENT: bowled off a no-ball', async () => {
    const { match, scorer } = await liveMatch({ sport: 'cricket' });
    await expect(
      scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'ball', runs: 0, extra: 'no_ball', wicket: 'bowled' }, expectedSeq: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
  });
});

describe('series (plan 5)', () => {
  it('scoring R6: a chess win is recorded as the one game and submits the result', async () => {
    const { match, scorer } = await liveMatch({ sport: 'chess' });
    await scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'unit_won', side: 'b', score: null }, expectedSeq: 1 });
    expect(await scoring.resultFor(match.id)).toMatchObject({ outcome: 'played', games: [{ a: 0, b: 1 }], winnerRegistrationId: match.sideBRegistrationId });
  });

  it('scoring R4: a map score the rule refuses is INVALID_EVENT', async () => {
    const { match, scorer } = await liveMatch({ sport: 'esports' });
    await expect(
      scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'unit_won', side: 'a', score: { a: 13, b: 12 } }, expectedSeq: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
  });

  it('snooker: pots by name, frames closed on points, best of five', async () => {
    const { match, scorer } = await liveMatch({ sport: 'snooker' });
    let seq = 1;
    const rec = async (event: ScoreEvent) => {
      seq = (await scoring.recordEvent(scorer, { matchId: match.id, event, expectedSeq: seq })).seq;
    };
    for (let f = 0; f < 3; f += 1) {
      await rec({ type: 'score', side: 'a', action: 'black' });
      await rec({ type: 'unit_end' });
    }
    expect(await scoring.resultFor(match.id)).toMatchObject({ games: [{ a: 7, b: 0 }, { a: 7, b: 0 }, { a: 7, b: 0 }] });
  });
});

describe('bouts (plan 6)', () => {
  it('scoring R6: a boxing bout on judges’ cards submits the decision and each judge’s total', async () => {
    const { match, scorer } = await liveMatch({ sport: 'boxing' });
    let seq = 1;
    const cards = async (c: [number, number][]) => {
      seq = (await scoring.recordEvent(scorer, {
        matchId: match.id, event: { type: 'round_cards', cards: c.map(([a, b]) => ({ a, b })) }, expectedSeq: seq,
      })).seq;
    };
    await cards([[10, 9], [10, 9], [9, 10]]);
    await cards([[10, 9], [9, 10], [9, 10]]);
    await cards([[9, 10], [10, 9], [10, 9]]);
    expect(await scoring.resultFor(match.id)).toMatchObject({
      method: 'split_decision', margin: '29–28, 29–28, 28–29',
      games: [{ a: 29, b: 28 }, { a: 29, b: 28 }, { a: 28, b: 29 }], winnerRegistrationId: match.sideARegistrationId,
    });
  });

  it('scoring R4: a finish the sport does not have is INVALID_EVENT', async () => {
    const { match, scorer } = await liveMatch({ sport: 'karate' });
    await expect(
      scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'finish', side: 'a', method: 'ko' }, expectedSeq: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
  });
});

describe('heats (plans 7, 8)', () => {
  /** A published field category with three confirmed entries, the organizer owning the event. */
  async function fieldCategory(seed: SportSeed, count = 3): Promise<{ categoryId: string; entries: string[] }> {
    const sportId = await seedSport(prisma, seed);
    sport.refresh();
    const startsAt = soon(30);
    const event = await events.create(organizer.actor, {
      sportId,
      contactPhone: '9876543210',
      acceptHostTerms: true,
      title: `Meet ${newId().slice(0, 8)}`,
      city: 'Bengaluru',
      startsAt,
      endsAt: new Date(startsAt.getTime() + DAY),
      registrationClosesAt: new Date(startsAt.getTime() - DAY),
      cancellationCutoffAt: new Date(startsAt.getTime() - 2 * DAY),
    });
    const format = seed.formats[0]!;
    const category = await events.addCategory(organizer.actor, event.id, {
      name: format.name, format: format.key, capacity: 16, minEntries: 4,
      entryFeePaise: 0n, platformFeePaise: 0n, taxBps: 0,
    });
    await events.publish(organizer.actor, event.id);
    const entries: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const p = await makePlayer(`Athlete ${i + 1}`);
      const id = newId();
      await prisma.registration.create({
        data: { id, eventId: event.id, eventCategoryId: category.id, sportId, captainUserId: p.userId, status: 'confirmed', confirmedAt: new Date(), amountPaise: 0n },
      });
      entries.push(id);
    }
    return { categoryId: category.id, entries };
  }

  it('a race: the organizer opens a heat of every confirmed entry; times rank it, lowest first', async () => {
    const { categoryId, entries } = await fieldCategory(RUNNING);
    let heat = await field.createHeat(organizer.actor, { eventCategoryId: categoryId, name: '10K' });
    expect(heat.entries).toEqual(entries);
    heat = await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 0, event: { type: 'mark', entry: entries[1]!, value: 2095 } });
    heat = await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 1, event: { type: 'mark', entry: entries[0]!, value: 2180 } });
    heat = await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 2, event: { type: 'status', entry: entries[2]!, code: 'DNF' } });
    expect(heat.standings.map((s) => [s.entry, s.place])).toEqual([[entries[1], 1], [entries[0], 2], [entries[2], null]]);
    expect(await prisma.heatScoreEvent.count({ where: { heatId: heat.id } })).toBe(3);
  });

  it('scoring R1: a stale seq is refused with the server state; a non-staff player cannot score', async () => {
    const { categoryId, entries } = await fieldCategory(RUNNING);
    const heat = await field.createHeat(organizer.actor, { eventCategoryId: categoryId, name: 'Heat 1' });
    await expect(
      field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 5, event: { type: 'mark', entry: entries[0]!, value: 60 } }),
    ).rejects.toMatchObject({ code: 'SCORE_STALE' });
    const stranger = await makePlayer('Stranger');
    await expect(
      field.recordFieldEvent(stranger.actor, { heatId: heat.id, expectedSeq: 0, event: { type: 'mark', entry: entries[0]!, value: 60 } }),
    ).rejects.toThrow('Forbidden');
  });

  it('gap #32: heats wait for registration to close, and the organizer finishes the category', async () => {
    const { categoryId, entries } = await fieldCategory(GOLF);
    let heat = await field.createHeat(organizer.actor, { eventCategoryId: categoryId, name: 'Round 1' });
    // Not finished while a heat is still live.
    await expect(field.finishCategory(organizer.actor, categoryId)).rejects.toMatchObject({ code: 'ROUND_NOT_CLOSED' });
    heat = await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 0, event: { type: 'card', entry: entries[0]!, values: [3] } });
    await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 1, event: { type: 'close' } });
    await field.finishCategory(organizer.actor, categoryId);
    expect((await prisma.eventCategory.findUniqueOrThrow({ where: { id: categoryId } })).status).toBe('completed');
    expect(await prisma.outbox.count({ where: { topic: 'category.completed' } })).toBe(1);
  });

  it('gap #32: no heats while registration is open', async () => {
    const { categoryId } = await fieldCategory(GOLF);
    // Straight to the real service, past the suite's close-first wrapper.
    await expect(unwrappedField.createHeat(organizer.actor, { eventCategoryId: categoryId, name: 'Early' })).rejects.toMatchObject({
      code: 'REGISTRATION_STILL_OPEN',
    });
  });

  it('golf: cards against par; a closed heat takes nothing more', async () => {
    const { categoryId, entries } = await fieldCategory(GOLF);
    let heat = await field.createHeat(organizer.actor, { eventCategoryId: categoryId, name: 'Round 1' });
    heat = await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 0, event: { type: 'card', entry: entries[0]!, values: [3] } });
    expect(heat.standings[0]).toMatchObject({ entry: entries[0], display: '−1 thru 1' });
    heat = await field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 1, event: { type: 'close' } });
    expect(heat.status).toBe('closed');
    await expect(
      field.recordFieldEvent(organizer.actor, { heatId: heat.id, expectedSeq: 2, event: { type: 'card', entry: entries[1]!, values: [4] } }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
  });

  it('access: organizers manage and score heats; a player only watches; a match sport is not a field', async () => {
    const { categoryId } = await fieldCategory(RUNNING);
    expect(await field.access(organizer.userId, categoryId)).toEqual({ isField: true, canManage: true, canScore: true });
    const fan = await makePlayer('Fan');
    expect(await field.access(fan.userId, categoryId)).toEqual({ isField: true, canManage: false, canScore: false });
    expect(await field.access(null, categoryId)).toMatchObject({ isField: true, canScore: false });
    const singles = await fieldCategory(PICKLEBALL);
    expect((await field.access(organizer.userId, singles.categoryId)).isField).toBe(false);
  });

  it('the app draws the heats itself once registration closes — and only once', async () => {
    const { categoryId, entries } = await fieldCategory(RUNNING, 5);
    await prisma.eventCategory.update({ where: { id: categoryId }, data: { status: 'closed' } });
    const heats = await field.autoHeats(categoryId, 1);
    expect(heats).toHaveLength(1);
    expect([...heats![0]!.entries].sort()).toEqual([...entries].sort());
    expect(await field.autoHeats(categoryId, 1)).toBeNull();
  });

  it('#13, #14: undo takes back the last write, reopens a heat made final, and never rewrites the log', async () => {
    const { categoryId, entries: [e1, e2] } = await fieldCategory(RUNNING, 2);
    const [heat] = await field.createHeats(organizer.actor, { eventCategoryId: categoryId, count: 1 });
    const id = heat!.id;
    await field.recordFieldEvent(organizer.actor, { heatId: id, expectedSeq: 0, event: { type: 'mark', entry: e1!, value: 61 } });
    await field.recordFieldEvent(organizer.actor, { heatId: id, expectedSeq: 1, event: { type: 'status', entry: e2!, code: 'DNF' } });
    await field.recordFieldEvent(organizer.actor, { heatId: id, expectedSeq: 2, event: { type: 'close' } });

    // Reopen: the close is taken back.
    let view = await field.undoFieldEvent(organizer.actor, { heatId: id, expectedSeq: 3 });
    expect(view.status).toBe('live');
    // The DNF next, then the mark — undos walk back past each other.
    view = await field.undoFieldEvent(organizer.actor, { heatId: id, expectedSeq: 4 });
    expect(view.state.entries[e2!]!.status).toBe('active');
    view = await field.undoFieldEvent(organizer.actor, { heatId: id, expectedSeq: 5 });
    expect(view.state.entries[e1!]!.marks).toEqual([]);
    await expect(field.undoFieldEvent(organizer.actor, { heatId: id, expectedSeq: 6 })).rejects.toMatchObject({ code: 'NOTHING_TO_UNDO' });
    // A stale seq is refused like any write.
    await expect(field.undoFieldEvent(organizer.actor, { heatId: id, expectedSeq: 2 })).rejects.toMatchObject({ code: 'SCORE_STALE' });
    expect(await prisma.heatScoreEvent.count({ where: { heatId: id } })).toBe(6);
  });

  it('rounds: heats drawn once, serpentine; the top of each closed heat and the best of the rest make the final', async () => {
    const { categoryId, entries: [e1, e2, e3, e4, e5] } = await fieldCategory(RUNNING, 5);
    const [h1, h2] = await field.createHeats(organizer.actor, { eventCategoryId: categoryId, count: 2 });
    expect([h1!.entries, h2!.entries]).toEqual([[e1, e4, e5], [e2, e3]]);
    expect([h1!.name, h2!.name, h1!.round]).toEqual(['Heat 1', 'Heat 2', 1]);
    await expect(field.createHeats(organizer.actor, { eventCategoryId: categoryId, count: 2 })).rejects.toMatchObject({
      code: 'HEATS_EXIST',
    });
    await expect(field.advance(organizer.actor, { eventCategoryId: categoryId, perHeat: 1, best: 1 })).rejects.toMatchObject({
      code: 'ROUND_NOT_CLOSED',
    });

    const times: [string, string, number][] = [
      [h1!.id, e1!, 61.2], [h1!.id, e4!, 60.4], [h1!.id, e5!, 62.0], [h2!.id, e2!, 60.9], [h2!.id, e3!, 61.0],
    ];
    const seqs = new Map<string, number>();
    const next = (id: string) => { const s = seqs.get(id) ?? 0; seqs.set(id, s + 1); return s; };
    for (const [heatId, entry, value] of times) {
      await field.recordFieldEvent(organizer.actor, { heatId, expectedSeq: next(heatId), event: { type: 'mark', entry, value } });
    }
    for (const heatId of [h1!.id, h2!.id]) {
      await field.recordFieldEvent(organizer.actor, { heatId, expectedSeq: next(heatId), event: { type: 'close' } });
    }

    // Q: e4 (heat 1), e2 (heat 2). q: e3 (61.0) beats e1 (61.2). Fastest first.
    const final = await field.advance(organizer.actor, { eventCategoryId: categoryId, perHeat: 1, best: 1 });
    expect(final).toMatchObject({ name: 'Final', round: 2, status: 'live', entries: [e4, e2, e3] });
    expect((await field.forCategory(categoryId)).map((h) => [h.name, h.round])).toEqual([
      ['Heat 1', 1], ['Heat 2', 1], ['Final', 2],
    ]);
  });

  it('a two-sided sport is played as matches, not heats', async () => {
    const { categoryId } = await fieldCategory(PICKLEBALL);
    await expect(field.createHeat(organizer.actor, { eventCategoryId: categoryId, name: 'x' })).rejects.toMatchObject({
      code: 'NOT_A_FIELD_SPORT',
    });
  });
});

describe('leagues and group stages', () => {
  /** A published team category with `n` confirmed entries, drawn as `drawType`. */
  async function competition(seed: SportSeed, drawType: string, n: number) {
    const sportId = await seedSport(prisma, seed);
    sport.refresh();
    const format = seed.formats[0]!;
    const startsAt = soon(30);
    const event = await events.create(organizer.actor, {
      sportId,
      contactPhone: '9876543210',
      acceptHostTerms: true,
      title: `League ${newId().slice(0, 8)}`,
      city: 'Bengaluru',
      startsAt,
      endsAt: new Date(startsAt.getTime() + DAY),
      registrationClosesAt: new Date(startsAt.getTime() - DAY),
      cancellationCutoffAt: new Date(startsAt.getTime() - 2 * DAY),
    });
    const category = await events.addCategory(organizer.actor, event.id, {
      name: format.name, format: format.key, capacity: 16, minEntries: drawType === 'groups_knockout' ? 6 : drawType === 'league' ? 3 : 4, drawType,
      entryFeePaise: 0n, platformFeePaise: 0n, taxBps: 0,
    });
    await events.publish(organizer.actor, event.id);
    const players = new Map<string, Player>();
    for (let i = 0; i < n; i += 1) {
      const p = await makePlayer(`Captain ${i + 1}`);
      const id = newId();
      await prisma.registration.create({
        data: { id, eventId: event.id, eventCategoryId: category.id, sportId, captainUserId: p.userId, status: 'confirmed', confirmedAt: new Date(Date.now() + i), amountPaise: 0n },
      });
      players.set(id, p);
    }
    const draw = await tournament.generateDraw(organizer.actor, { eventCategoryId: category.id });
    return { draw, categoryId: category.id, players };
  }

  /** The organizer enters the score; side A's captain confirms it. */
  async function play(match: Match, players: Map<string, Player>, games: { a: number; b: number }[]) {
    await scoring.submitResult(organizer.actor, { matchId: match.id, outcome: 'played', games });
    await scoring.confirmResult(players.get(match.sideARegistrationId!)!.actor, match.id);
  }

  it('a league: everyone plays everyone, every match ready at once; a level score is a draw, a point each', async () => {
    const { draw, categoryId, players } = await competition(FOOTBALL, 'league', 4);
    const matches = await tournament.matchesFor(draw.id);
    expect(matches).toHaveLength(6);
    expect(new Set(matches.map((m) => [m.bracket, m.status].join()))).toEqual(new Set(['league,ready']));
    expect(new Set(matches.map((m) => m.round))).toEqual(new Set([1, 2, 3]));

    const [m1, m2] = matches;
    await play(m1!, players, [{ a: 1, b: 1 }]);
    await play(m2!, players, [{ a: 2, b: 0 }]);
    expect(await scoring.resultFor(m1!.id)).toMatchObject({ winnerRegistrationId: null, loserRegistrationId: null });
    expect(await tournament.matchById(m1!.id)).toMatchObject({ status: 'completed', winnerRegistrationId: null, tallyA: 1, tallyB: 1 });

    const [table] = await tournament.leagueTableFor(categoryId);
    expect(table!.group).toBeNull();
    const row = (id: string) => table!.table.find((r) => r.registrationId === id)!;
    expect(row(m2!.sideARegistrationId!)).toMatchObject({ played: 1, won: 1, points: 3, scoreFor: 2, scoreAgainst: 0 });
    expect(row(m1!.sideARegistrationId!)).toMatchObject({ played: 1, drawn: 1, points: 1 });
    expect(row(m1!.sideBRegistrationId!)).toMatchObject({ played: 1, drawn: 1, points: 1 });
    expect(table!.table[0]!.registrationId).toBe(m2!.sideARegistrationId);
  });

  it('a league reads its table as its standings, so "where did I finish" has one answer', async () => {
    const { draw, categoryId, players } = await competition(FOOTBALL, 'league', 3);
    for (const m of await tournament.matchesFor(draw.id)) await play(m, players, [{ a: 2, b: 0 }]);

    const [table] = await tournament.leagueTableFor(categoryId);
    const standings = await tournament.standingsFor(categoryId);
    expect(standings.map((r) => [r.registrationId, r.place])).toEqual(table!.table.map((r) => [r.registrationId, r.place]));
    expect(new Set(standings.map((r) => r.bracket))).toEqual(new Set(['league']));
    expect(standings.reduce((n, r) => n + r.wins, 0)).toBe(3);
  });

  it('live scoring a league match: level at the final whistle ends it as a draw and submits that result', async () => {
    const { draw, players } = await competition(FOOTBALL, 'league', 3);
    const [match] = await tournament.matchesFor(draw.id);
    const scorer = players.get(match!.sideARegistrationId!)!.actor;
    expect((await scoring.ruleForMatch(match!.id)) as { tiebreaker: string }).toMatchObject({ tiebreaker: 'none' });
    await scoring.start(scorer, match!.id);
    let seq = 1;
    for (let i = 0; i < 2; i++) {
      const snap = await scoring.recordEvent(scorer, { matchId: match!.id, event: { type: 'period_end' }, expectedSeq: seq });
      seq += 1;
      if (i === 1) expect(snap.state).toMatchObject({ matchOver: true, winner: null });
    }
    expect(await scoring.resultFor(match!.id)).toMatchObject({ outcome: 'played', source: 'live', winnerRegistrationId: null });
  });

  it('a knockout match still needs a winner', async () => {
    const { draw } = await competition(FOOTBALL, 'single_elim_with_plate', 4);
    const match = (await tournament.matchesFor(draw.id)).find((m) => m.status === 'ready')!;
    expect(
      await errorCode(() => scoring.submitResult(organizer.actor, { matchId: match.id, outcome: 'played', games: [{ a: 1, b: 1 }] })),
    ).toBe('INVALID_RESULT');
  });

  it('groups: two groups of three; the last group result draws a knockout of the top two, no group rematch', async () => {
    const { draw, categoryId, players } = await competition(FOOTBALL, 'groups_knockout', 6);
    const groupMatches = await tournament.matchesFor(draw.id);
    expect(groupMatches).toHaveLength(6);
    expect(new Set(groupMatches.map((m) => m.groupNo))).toEqual(new Set([1, 2]));
    for (const m of groupMatches) await play(m, players, [{ a: 1, b: 0 }]);

    const tables = await tournament.leagueTableFor(categoryId);
    expect(tables.map((t) => [t.group, t.table.length, t.qualify])).toEqual([[1, 3, 2], [2, 3, 2]]);
    const groupOf = new Map(tables.flatMap((t) => t.table.map((r) => [r.registrationId, t.group] as const)));

    const knockout = (await tournament.matchesFor(draw.id)).filter((m) => m.bracket === 'championship');
    expect(knockout.map((m) => m.round).sort()).toEqual([1, 1, 2]);
    const semis = knockout.filter((m) => m.round === 1);
    for (const m of semis) {
      expect(m.status).toBe('ready');
      expect(groupOf.get(m.sideARegistrationId!)).not.toBe(groupOf.get(m.sideBRegistrationId!));
    }
    const through = new Set(semis.flatMap((m) => [m.sideARegistrationId, m.sideBRegistrationId]));
    expect(through).toEqual(new Set(tables.flatMap((t) => t.table.slice(0, 2).map((r) => r.registrationId))));
    expect((await tournament.byId(draw.id)).completedAt).toBeNull();
  });

  it('a draw type is one the system can generate', async () => {
    await expect(competition(FOOTBALL, 'swiss', 4)).rejects.toMatchObject({ code: 'INVALID_DRAW_TYPE' });
  });
});

describe('scoring — gap review fixes (2026-10-03)', () => {
  it('gap #18: an organizer corrects a confirmed result, and the right player moves on', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    await scoring.confirmResult(side.b.actor, match.id);
    const done = await tournament.matchById(match.id);
    const next = await tournament.matchById(done.winnerMatchId!);
    const slot = done.winnerSlot === 0 ? 'sideARegistrationId' : 'sideBRegistrationId';
    expect(next[slot]).toBe(match.sideARegistrationId);

    // A player cannot; the organizer can.
    const fix = { matchId: match.id, outcome: 'played' as const, games: [{ a: 0, b: 11 }, { a: 9, b: 11 }] };
    expect(await errorCode(() => scoring.correctResult(side.b.actor, fix))).toBe('FORBIDDEN');
    const corrected = await scoring.correctResult(organizer.actor, fix);

    expect(corrected.winnerRegistrationId).toBe(match.sideBRegistrationId);
    expect((await tournament.matchById(done.winnerMatchId!))[slot]).toBe(match.sideBRegistrationId);
    expect((await tournament.matchById(match.id)).winnerRegistrationId).toBe(match.sideBRegistrationId);
    const rows = await prisma.outbox.findMany({ where: { topic: 'result.corrected' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ matchId: match.id, winnerChanged: true });
  });

  it('gap #18: an unconfirmed result is not corrected — it is confirmed or disputed', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    expect(
      await errorCode(() =>
        scoring.correctResult(organizer.actor, { matchId: match.id, outcome: 'walkover', games: [], winner: 'b' }),
      ),
    ).toBe('RESULT_NOT_SUBMITTED');
  });

  it('gap #19: during play a player takes back only the points they tapped', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    const seq = await tap(side.a, match.id, 'aaa');
    expect(await errorCode(() => scoring.undo(side.b.actor, { matchId: match.id, expectedSeq: seq }))).toBe(
      'NOT_YOUR_POINT',
    );
    const snap = await scoring.undo(side.a.actor, { matchId: match.id, expectedSeq: seq });
    expect(snap.state).toMatchObject({ current: { a: 2, b: 0 } });
  });

  it('gap #20: an open dispute keeps reminding the organizer, then goes to PL4Y staff after the event', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    await scoring.disputeResult(side.b.actor, match.id, 'That was 11-9 the other way');
    const waiting = async () =>
      (await prisma.outbox.findMany({ where: { topic: 'results.waiting' } })).filter(
        (r) => (r.payload as { disputed?: boolean }).disputed === true,
      ).length;

    clock.offsetMs = 31 * MINUTE;
    await scoring.sweep();
    expect(await waiting()).toBe(1);
    clock.offsetMs = 40 * MINUTE;
    await scoring.sweep();
    expect(await waiting()).toBe(1); // not again within the half hour
    clock.offsetMs = 62 * MINUTE;
    await scoring.sweep();
    expect(await waiting()).toBe(2);

    // drawOfFour's event ends 31 days out; a day after that, staff are told once.
    clock.offsetMs = 32 * DAY + 60 * MINUTE;
    expect((await scoring.sweep()).escalated).toBe(1);
    expect((await scoring.sweep()).escalated).toBe(0);
    expect(await prisma.outbox.count({ where: { topic: 'result.escalated' } })).toBe(1);
  });

  it('gap #20: an escalated dispute PL4Y never settles closes on the submitted result after 3 days, unrated', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 3 }, { a: 11, b: 4 }],
    });
    await scoring.disputeResult(side.b.actor, match.id, 'We never played this');
    clock.offsetMs = 32 * DAY + 60 * MINUTE;
    expect((await scoring.sweep()).escalated).toBe(1);
    clock.offsetMs = 32 * DAY + 60 * MINUTE + 71 * 60 * MINUTE;
    expect((await scoring.sweep()).defaulted).toBe(0);
    clock.offsetMs = 32 * DAY + 60 * MINUTE + 73 * 60 * MINUTE;
    expect((await scoring.sweep()).defaulted).toBe(1);
    expect((await scoring.sweep()).defaulted).toBe(0);
    const row = await prisma.matchResult.findUnique({ where: { matchId: match.id } });
    expect(row?.confirmedVia).toBe('default');
    expect(row?.confirmedBy).toBeNull();
    expect(await prisma.outbox.count({ where: { topic: 'result.defaulted' } })).toBe(1);
    const { isRatable } = await import('../src/modules/scoring/finality.js');
    expect(isRatable({ confirmedVia: 'default', submitterRole: 'staff' })).toBe(false);
  });

  it('a cancelled event is not scored', async () => {
    const { eventId, match, side } = await drawOfFour();
    await prisma.event.update({ where: { id: eventId }, data: { status: 'cancelled' } });
    expect(await errorCode(() => scoring.start(side.a.actor, match.id))).toBe('MATCH_NOT_LIVE');
  });
});
