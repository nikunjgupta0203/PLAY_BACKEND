/**
 * tournament — service tests against a real Postgres (conventions.md §5).
 *
 * The bracket arithmetic is unit-tested without a database in
 * src/modules/tournament/draw.test.ts. What is under test HERE is everything
 * the database is responsible for: one draw per category, one transaction,
 * advancement under an advisory lock, and an exclusion constraint that will not
 * let two matches share a court.
 *
 * A mocked database would pass every one of these while the real one failed,
 * which is exactly why conventions.md §5 bans one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, closeBeforeDrawing, webhookBody, type FakeGateway, type FakeSchedule } from './helpers/modules.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { VenueService } from '../src/modules/venues/service/index.js';
import type {
  Match,
  TournamentService,
} from '../src/modules/tournament/service/index.js';
import {
  MATCH_MINUTES,
  MIN_REST_MINUTES,
  TournamentCode,
} from '../src/modules/tournament/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let tournament: TournamentService;
let rawTournament: TournamentService;
let registration: RegistrationService;
let payments: PaymentsService;
let events: EventService;
let venues: VenueService;
let profile: ProfileService;
let sport: SportService;
let gateway: FakeGateway;
let schedule: FakeSchedule;
let pickleballId: string;

const DAY = 86_400_000;
const MINUTE = 60_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);
const CENTRE = { lat: 12.9784, lng: 77.6408 };

interface Player {
  userId: string;
  playerId: string;
  email: string;
  actor: { userId: string };
}

let organizer: Player;

async function makePlayer(name: string): Promise<Player> {
  const userId = newId();
  const address = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({
    data: { playerId, sportId: pickleballId, skillBand: '3.5' },
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
  overrides: { capacity?: number; minEntries?: number; courts?: number } = {},
): Promise<{ eventId: string; categoryId: string; venueId: string }> {
  const startsAt = soon(30);
  const venue = await venues.create(organizer.actor, {
    name: `Club ${newId().slice(0, 8)}`,
    address: '100 Feet Road',
    city: 'Bengaluru',
    location: CENTRE,
    courts: Array.from({ length: overrides.courts ?? 2 }, (_, i) => ({
      name: `Court ${i + 1}`,
      sportIds: [pickleballId],
    })),
  });
  const event = await events.create(organizer.actor, {
    sportId: pickleballId,
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
    name: 'Test Draw',
    format: 'singles',
    capacity: Math.max(overrides.capacity ?? 64, 4),
    minEntries: 4,
    entryFeePaise: 50_000n,
    platformFeePaise: 5_000n,
    taxBps: 1800,
  });
  // A draw too small to be drawn is refused by events (gap #8); the
  // tournament floor (R7) is what some of these tests are about, so the
  // numbers are set directly.
  await prisma.eventCategory.update({
    where: { id: category.id },
    data: { capacity: overrides.capacity ?? 64, minEntries: overrides.minEntries ?? 4 },
  });
  await events.publish(organizer.actor, event.id);
  return { eventId: event.id, categoryId: category.id, venueId: venue.id };
}

/** Registers a player and drives them all the way to `confirmed`. */
let webhookSeq = 0;
async function enter(categoryId: string, player: Player): Promise<string> {
  const entry = await registration.begin(player.actor, { eventCategoryId: categoryId });
  const order = await payments.createOrder(player.actor, entry.id);
  const entity = gateway.capture(order.gatewayOrderId);
  webhookSeq += 1;
  const id = `evt_TEST${webhookSeq}`;
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

/** A field of `n` confirmed entries, in registration order. */
async function fieldOf(
  categoryId: string,
  n: number,
): Promise<{ player: Player; registrationId: string }[]> {
  const out: { player: Player; registrationId: string }[] = [];
  for (let i = 0; i < n; i += 1) {
    const player = await makePlayer(`Player ${String(i + 1).padStart(2, '0')}`);
    out.push({ player, registrationId: await enter(categoryId, player) });
  }
  return out;
}

const matchesOf = async (tournamentId: string): Promise<Match[]> =>
  tournament.matchesFor(tournamentId);

/** Plays a match: whoever is on side A wins, unless told otherwise. */
async function play(match: Match, opts: { winner?: 'a' | 'b' } = {}): Promise<void> {
  const winnerId =
    (opts.winner ?? 'a') === 'a' ? match.sideARegistrationId : match.sideBRegistrationId;
  const loserId =
    (opts.winner ?? 'a') === 'a' ? match.sideBRegistrationId : match.sideARegistrationId;
  await tournament.advance(match.id, {
    winnerRegistrationId: winnerId!,
    loserRegistrationId: loserId,
    outcome: 'played',
  });
}

/**
 * Plays the whole draw to completion, always advancing side A. Returns how many
 * matches were actually contested.
 */
async function playEverything(tournamentId: string): Promise<number> {
  let played = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    const playable = (await matchesOf(tournamentId)).filter(
      (m) =>
        m.status !== 'completed' &&
        m.status !== 'walkover' &&
        m.status !== 'void' &&
        m.sideARegistrationId !== null &&
        m.sideBRegistrationId !== null,
    );
    if (playable.length === 0) break;
    for (const match of playable) {
      await play(match);
      played += 1;
    }
  }
  return played;
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  rawTournament = wired.tournament;
  tournament = closeBeforeDrawing(wired.tournament, prisma);
  registration = wired.registration;
  payments = wired.payments;
  events = wired.events;
  venues = wired.venues;
  profile = wired.profile;
  sport = wired.sport;
  gateway = wired.gateway;
  schedule = wired.schedule;
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
  // venues reaches `court_assignments` through a port that can be stubbed by
  // hand. Clearing it between tests means every answer in this suite comes from
  // the real bookings, which is the point of running against a real Postgres.
  schedule.reset();
  webhookSeq = 0;
  organizer = await makePlayer('Organizer');
});

// ─────────────────────────────────────────────────────────────────────────────
// Done when — a 32-entry draw, played to the end
// ─────────────────────────────────────────────────────────────────────────────

describe('tournament — Done when: a 32-entry draw plays out with no unfilled slots', () => {
  it('generates 31 Championship and 15 Plate matches with complete wiring', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 32);

    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    expect(draw.bracketSize).toBe(32);
    expect(draw.plateSize).toBe(16);

    const matches = await matchesOf(draw.id);
    expect(matches.filter((m) => m.bracket === 'championship')).toHaveLength(31);
    expect(matches.filter((m) => m.bracket === 'plate')).toHaveLength(15);

    // R5 — every Championship round-1 match drops its loser into the Plate,
    // and every match that is not a final carries its winner somewhere.
    const firstRound = matches.filter((m) => m.bracket === 'championship' && m.round === 1);
    expect(firstRound).toHaveLength(16);
    expect(firstRound.every((m) => m.loserMatchId !== null)).toBe(true);
    expect(matches.filter((m) => m.winnerMatchId === null)).toHaveLength(2); // two finals
  });

  it('scoring all 46 matches leaves one Championship winner, one Plate winner and zero unfilled slots', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 32);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });

    const played = await playEverything(draw.id);
    expect(played).toBe(46);

    const matches = await matchesOf(draw.id);
    expect(matches).toHaveLength(46);
    // Zero unfilled slots: every position in both brackets found two players.
    expect(
      matches.filter((m) => m.sideARegistrationId === null || m.sideBRegistrationId === null),
    ).toHaveLength(0);
    expect(matches.every((m) => m.status === 'completed')).toBe(true);

    const finals = matches.filter((m) => m.winnerMatchId === null);
    expect(finals).toHaveLength(2);
    expect(finals.every((m) => m.winnerRegistrationId !== null)).toBe(true);
    expect(new Set(finals.map((m) => m.bracket))).toEqual(
      new Set(['championship', 'plate']),
    );

    // The draw is over, so the category and the tournament say so.
    expect((await tournament.byId(draw.id)).completedAt).not.toBeNull();
    expect((await events.categoryById(categoryId)).status).toBe('completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Done when — two results confirmed at the same instant
// ─────────────────────────────────────────────────────────────────────────────

describe('tournament — Done when: simultaneous advancement', () => {
  it('R9: two sibling matches confirmed in the same millisecond both advance correctly', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });

    const firstRound = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 1,
    );
    // The two matches that feed the SAME round-2 slot — the pair that would
    // race for it without the advisory lock.
    const siblings = firstRound.filter((m) => m.winnerMatchId === firstRound[0]!.winnerMatchId);
    expect(siblings).toHaveLength(2);

    await Promise.all(siblings.map((m) => play(m)));

    const next = (await matchesOf(draw.id)).find((m) => m.id === siblings[0]!.winnerMatchId)!;
    expect(next.sideARegistrationId).toBe(siblings[0]!.sideARegistrationId);
    expect(next.sideBRegistrationId).toBe(siblings[1]!.sideARegistrationId);
    expect(next.status).toBe('ready');
  });

  it('R9: sixteen first-round results confirmed at once fill every round-2 slot exactly once', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 32);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const firstRound = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 1,
    );

    await Promise.all(firstRound.map((m) => play(m)));

    const after = await matchesOf(draw.id);
    const roundTwo = after.filter((m) => m.bracket === 'championship' && m.round === 2);
    expect(roundTwo).toHaveLength(8);
    expect(roundTwo.every((m) => m.sideARegistrationId && m.sideBRegistrationId)).toBe(true);

    // The Plate filled at the same time, from the same sixteen results.
    const plateOne = after.filter((m) => m.bracket === 'plate' && m.round === 1);
    expect(plateOne).toHaveLength(8);
    expect(plateOne.every((m) => m.sideARegistrationId && m.sideBRegistrationId)).toBe(true);

    // Nobody is in two places at once.
    const placed = [...roundTwo, ...plateOne].flatMap((m) => [
      m.sideARegistrationId,
      m.sideBRegistrationId,
    ]);
    expect(new Set(placed).size).toBe(32);
  });

  it('R10: advancing an already-completed match twice is a no-op, not an error', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const match = (await matchesOf(draw.id)).find(
      (m) => m.bracket === 'championship' && m.round === 1,
    )!;

    await play(match);
    const afterFirst = (await matchesOf(draw.id)).find((m) => m.id === match.winnerMatchId)!;

    // A retried job, arriving with the OTHER side as the winner. The retry must
    // change nothing at all.
    await tournament.advance(match.id, {
      winnerRegistrationId: match.sideBRegistrationId!,
      loserRegistrationId: match.sideARegistrationId,
      outcome: 'played',
    });

    const afterRetry = (await matchesOf(draw.id)).find((m) => m.id === match.winnerMatchId)!;
    expect(afterRetry.sideARegistrationId).toBe(afterFirst.sideARegistrationId);
    expect(afterRetry.sideBRegistrationId).toBe(afterFirst.sideBRegistrationId);

    const replayed = (await matchesOf(draw.id)).find((m) => m.id === match.id)!;
    expect(replayed.winnerRegistrationId).toBe(match.sideARegistrationId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Draw generation
// ─────────────────────────────────────────────────────────────────────────────

describe('tournament — draw generation', () => {
  it('R1: a payment still pending at draw time is not in the tournament', async () => {
    const { categoryId } = await publishedCategory();
    const confirmed = await fieldOf(categoryId, 4);

    // A fifth entry that began but never paid.
    const straggler = await makePlayer('Unpaid');
    const pending = await registration.begin(straggler.actor, {
      eventCategoryId: categoryId,
    });
    expect((await registration.byId(pending.id)).status).toBe('payment_pending');

    // gap #6 — while someone is paying for a seat, the draw waits for them.
    expect(
      await errorCode(() => tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId })),
    ).toBe(TournamentCode.PLAYERS_STILL_PAYING);
    // Their hold runs out; now the draw is made without them.
    await prisma.seatHold.updateMany({
      where: { registrationId: pending.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const placed = (await matchesOf(draw.id))
      .filter((m) => m.bracket === 'championship' && m.round === 1)
      .flatMap((m) => [m.sideARegistrationId, m.sideBRegistrationId])
      .filter((id): id is string => id !== null);

    expect(placed.sort()).toEqual(confirmed.map((e) => e.registrationId).sort());
    expect(placed).not.toContain(pending.id);
  });

  it('R7: fewer entries than the category minimum is INSUFFICIENT_ENTRIES', async () => {
    const { categoryId } = await publishedCategory({ minEntries: 8 });
    await fieldOf(categoryId, 6);
    expect(
      await errorCode(() =>
        tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId }),
      ),
    ).toBe(TournamentCode.INSUFFICIENT_ENTRIES);
  });

  it('R7: three entries cannot make a draw even when the organizer said one', async () => {
    const { categoryId } = await publishedCategory({ minEntries: 1 });
    await fieldOf(categoryId, 3);
    expect(
      await errorCode(() =>
        tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId }),
      ),
    ).toBe(TournamentCode.INSUFFICIENT_ENTRIES);
  });

  it('R6: the whole draw is one transaction — a failure leaves no half-bracket', async () => {
    const { categoryId } = await publishedCategory({ minEntries: 8 });
    await fieldOf(categoryId, 5);

    await errorCode(() =>
      tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId }),
    );

    expect(await prisma.tournament.count()).toBe(0);
    expect(await prisma.match.count()).toBe(0);
    // And the category was not left claiming a draw that does not exist.
    expect((await events.categoryById(categoryId)).status).not.toBe('drawn');
  });

  it('R6: the seeds, the bracket and the category status commit together', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    await tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId });

    const seeded = await prisma.registration.findMany({
      where: { eventCategoryId: categoryId },
      select: { seed: true },
    });
    expect(seeded.map((r) => r.seed).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect((await events.categoryById(categoryId)).status).toBe('drawn');
  });

  it('R2: seeding follows settled rating, and unrated entries seed last', async () => {
    const { categoryId } = await publishedCategory();
    const field = await fieldOf(categoryId, 4);

    // Give the third entrant a settled rating and nobody else one. R2 says a
    // rated player outranks an unrated one however late they entered.
    await prisma.playerSport.update({
      where: {
        playerId_sportId: { playerId: field[2]!.player.playerId, sportId: pickleballId },
      },
      data: { rating: 1800, ratingDev: 100, volatility: 0.06, matchesPlayed: 20 },
    });
    await settleRating(field[2]!.player.playerId, 1800);

    await tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId });
    const seeds = await prisma.registration.findMany({
      where: { eventCategoryId: categoryId },
      select: { id: true, seed: true },
    });
    const top = seeds.find((s) => s.seed === 1)!;
    expect(top.id).toBe(field[2]!.registrationId);
  });

  it('R3: byes are real match rows with one side and status walkover', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 5);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    expect(draw.bracketSize).toBe(8);

    const matches = await matchesOf(draw.id);
    const byes = matches.filter((m) => m.status === 'walkover');
    expect(byes).toHaveLength(3);
    for (const bye of byes) {
      // One side, and a winner, without a point being played.
      const sides = [bye.sideARegistrationId, bye.sideBRegistrationId].filter(Boolean);
      expect(sides).toHaveLength(1);
      expect(bye.winnerRegistrationId).toBe(sides[0]);
      // A bye has no loser, so nothing was wired into the Plate for it.
      expect(bye.loserMatchId).toBeNull();
    }

    // R3's point: advancement had no special case — the three bye winners are
    // already standing in round 2.
    const roundTwo = matches.filter((m) => m.bracket === 'championship' && m.round === 2);
    const placed = roundTwo.flatMap((m) => [m.sideARegistrationId, m.sideBRegistrationId]);
    expect(placed.filter(Boolean)).toHaveLength(3);
  });

  it('R8: a second generateDraw is DRAW_ALREADY_GENERATED', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    await tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId });

    expect(
      await errorCode(() =>
        tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId }),
      ),
    ).toBe(TournamentCode.DRAW_ALREADY_GENERATED);
  });

  it('R6: two simultaneous generateDraw calls produce exactly one draw', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);

    const results = await Promise.allSettled([
      tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId }),
      tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.tournament.count()).toBe(1);
    expect(await prisma.match.count()).toBe(7 + 3);
  });

  it('R8: regenerating before anything starts rebuilds the draw', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const first = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const firstIds = (await matchesOf(first.id)).map((m) => m.id).sort();

    const second = await tournament.regenerateDraw(organizer.actor, first.id);
    const secondIds = (await matchesOf(second.id)).map((m) => m.id).sort();

    expect(second.id).not.toBe(first.id);
    expect(secondIds).not.toEqual(firstIds);
    expect(await prisma.tournament.count()).toBe(1);
    expect(await prisma.match.count()).toBe(10);
  });

  it('R8: a draw full of byes is still regenerable — a bye is not a match anybody played', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 5);
    const first = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    expect((await matchesOf(first.id)).filter((m) => m.status === 'walkover')).toHaveLength(3);

    const second = await tournament.regenerateDraw(organizer.actor, first.id);
    expect(second.id).not.toBe(first.id);
    expect(await prisma.tournament.count()).toBe(1);
  });

  it('R8: once a match has started the draw is immutable — DRAW_LOCKED', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const first = (await matchesOf(draw.id)).find(
      (m) => m.bracket === 'championship' && m.round === 1,
    )!;
    await tournament.markLive(first.id);

    expect(await errorCode(() => tournament.regenerateDraw(organizer.actor, draw.id))).toBe(
      TournamentCode.DRAW_LOCKED,
    );
  });

  it('only event staff may generate a draw', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const stranger = await makePlayer('Stranger');
    expect(
      await errorCode(() =>
        tournament.generateDraw(stranger.actor, { eventCategoryId: categoryId }),
      ),
    ).toBe('FORBIDDEN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Advancement with byes
// ─────────────────────────────────────────────────────────────────────────────

describe('tournament — advancement', () => {
  it('R5: a first-round loser lands in the Plate, not out of the tournament', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const match = (await matchesOf(draw.id)).find(
      (m) => m.bracket === 'championship' && m.round === 1,
    )!;
    const loserId = match.sideBRegistrationId!;

    await play(match);

    const plate = (await matchesOf(draw.id)).find((m) => m.id === match.loserMatchId)!;
    expect(plate.bracket).toBe('plate');
    expect(
      [plate.sideARegistrationId, plate.sideBRegistrationId].includes(loserId),
    ).toBe(true);
  });

  it('R3, R5: an odd field still plays to exactly one Championship and one Plate winner', async () => {
    for (const n of [5, 6, 7, 11, 13]) {
      await truncateAll(prisma);
      sport.refresh();
      pickleballId = await seedSport(prisma, PICKLEBALL);
      sport.refresh();
      gateway.reset();
      webhookSeq = 0;
      organizer = await makePlayer('Organizer');

      const { categoryId } = await publishedCategory();
      await fieldOf(categoryId, n);
      const draw = await tournament.generateDraw(organizer.actor, {
        eventCategoryId: categoryId,
      });

      await playEverything(draw.id);

      const matches = await matchesOf(draw.id);
      // Nothing is left hanging: every match resolved one way or another.
      expect(
        matches.filter((m) => !['completed', 'walkover', 'void'].includes(m.status)),
      ).toHaveLength(0);

      const championshipFinal = matches.find(
        (m) => m.bracket === 'championship' && m.winnerMatchId === null,
      )!;
      expect(championshipFinal.winnerRegistrationId).not.toBeNull();

      const plateFinal = matches.find((m) => m.bracket === 'plate' && m.winnerMatchId === null);
      if (draw.plateSize > 0) {
        expect(plateFinal?.winnerRegistrationId).not.toBeNull();
      }
      expect((await tournament.byId(draw.id)).completedAt).not.toBeNull();
    }
  });

  it('a walkover in the Plate resolves the moment the only possible player arrives', async () => {
    // 6 entries in a bracket of 8: two byes, four contests... and a Plate of
    // four positions for four losers, so no Plate byes. 7 entries gives one.
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 7);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    expect(draw.plateSize).toBe(4);

    const firstRound = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 1 && m.loserMatchId !== null,
    );
    expect(firstRound).toHaveLength(3);

    for (const match of firstRound) await play(match);

    const plate = (await matchesOf(draw.id)).filter((m) => m.bracket === 'plate');
    // Three losers into a Plate of four: one first-round position is a bye, and
    // its occupant is already through to the Plate final.
    const plateWalkovers = plate.filter((m) => m.status === 'walkover');
    expect(plateWalkovers).toHaveLength(1);
    const plateFinal = plate.find((m) => m.winnerMatchId === null)!;
    expect(plateFinal.sideARegistrationId ?? plateFinal.sideBRegistrationId).not.toBeNull();
  });

  it('advancing an entry that is not in the match is refused', async () => {
    const { categoryId } = await publishedCategory();
    const field = await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const match = (await matchesOf(draw.id)).find(
      (m) => m.bracket === 'championship' && m.round === 1,
    )!;
    const outsider = field.find(
      (e) =>
        e.registrationId !== match.sideARegistrationId &&
        e.registrationId !== match.sideBRegistrationId,
    )!;

    expect(
      await errorCode(() =>
        tournament.advance(match.id, {
          winnerRegistrationId: outsider.registrationId,
          loserRegistrationId: null,
          outcome: 'played',
        }),
      ),
    ).toBe(TournamentCode.NOT_A_SIDE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling
// ─────────────────────────────────────────────────────────────────────────────

describe('tournament — scheduling', () => {
  it('R11, R12: every round-1 match is scheduled before any round-2 match', async () => {
    const { categoryId } = await publishedCategory({ courts: 2 });
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });

    await tournament.schedule(draw.id);
    const roundOne = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 1,
    );
    expect(roundOne.every((m) => m.scheduledAt !== null && m.courtId !== null)).toBe(true);

    // Round 2 is not ready — its sides do not exist yet — so nothing there was
    // scheduled ahead of a match that has to happen first.
    const roundTwo = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 2,
    );
    expect(roundTwo.every((m) => m.scheduledAt === null)).toBe(true);

    for (const match of roundOne) await play(match);
    await tournament.schedule(draw.id);

    const latestRoundOne = Math.max(
      ...roundOne.map((m) => m.scheduledAt!.getTime()),
    );
    const scheduledRoundTwo = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 2 && m.scheduledAt,
    );
    expect(scheduledRoundTwo.length).toBeGreaterThan(0);
    for (const match of scheduledRoundTwo) {
      expect(match.scheduledAt!.getTime()).toBeGreaterThanOrEqual(latestRoundOne);
    }
  });

  it('R11: a player gets twenty minutes between matches', async () => {
    const { categoryId } = await publishedCategory({ courts: 4 });
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    await tournament.schedule(draw.id);

    const roundOne = (await matchesOf(draw.id)).filter(
      (m) => m.bracket === 'championship' && m.round === 1,
    );
    for (const match of roundOne) await play(match);
    await tournament.schedule(draw.id);

    const all = await matchesOf(draw.id);
    const byRegistration = new Map<string, number[]>();
    for (const match of all) {
      if (!match.scheduledAt) continue;
      for (const id of [match.sideARegistrationId, match.sideBRegistrationId]) {
        if (!id) continue;
        const list = byRegistration.get(id) ?? [];
        list.push(match.scheduledAt.getTime());
        byRegistration.set(id, list);
      }
    }
    for (const times of byRegistration.values()) {
      const sorted = [...times].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(
          (MATCH_MINUTES + MIN_REST_MINUTES) * MINUTE,
        );
      }
    }
  });

  it('R11, R13: scheduling twice places nothing the second time', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });

    const first = await tournament.schedule(draw.id);
    expect(first.length).toBeGreaterThan(0);
    expect(await tournament.schedule(draw.id)).toHaveLength(0);
  });

  it('no two matches share a court at the same time', async () => {
    const { categoryId } = await publishedCategory({ courts: 2 });
    await fieldOf(categoryId, 16);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    await tournament.schedule(draw.id);

    const assignments = await tournament.assignmentsFor(draw.id);
    const byCourt = new Map<string, { from: number; to: number }[]>();
    for (const a of assignments) {
      const list = byCourt.get(a.courtId) ?? [];
      list.push({
        from: a.startsAt.getTime(),
        to: (a.endsAt ?? new Date(a.startsAt.getTime() + MATCH_MINUTES * MINUTE)).getTime(),
      });
      byCourt.set(a.courtId, list);
    }
    for (const windows of byCourt.values()) {
      const sorted = [...windows].sort((a, b) => a.from - b.from);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]!.from).toBeGreaterThanOrEqual(sorted[i - 1]!.to);
      }
    }
  });

  it('R13: an organizer can move a match by hand, and the constraint stops a clash', async () => {
    const { categoryId, venueId } = await publishedCategory({ courts: 2 });
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    const [courtA] = await venues.courtsFor(venueId);
    const ready = (await matchesOf(draw.id)).filter((m) => m.status === 'ready');
    const at = new Date(soon(30).getTime() + 3 * 3_600_000);

    const moved = await tournament.assignCourt(organizer.actor, {
      matchId: ready[0]!.id,
      courtId: courtA!.id,
      startsAt: at,
    });
    expect(moved.courtId).toBe(courtA!.id);
    expect(moved.scheduledAt?.getTime()).toBe(at.getTime());

    // COURT_DOUBLE_BOOKED — the exclusion constraint fired, not a read-then-write
    // check that two organizers could both pass.
    expect(
      await errorCode(() =>
        tournament.assignCourt(organizer.actor, {
          matchId: ready[1]!.id,
          courtId: courtA!.id,
          startsAt: new Date(at.getTime() + 10 * MINUTE),
        }),
      ),
    ).toBe(TournamentCode.COURT_DOUBLE_BOOKED);

    // Ten minutes later on the OTHER court is fine.
    const [, courtB] = await venues.courtsFor(venueId);
    const second = await tournament.assignCourt(organizer.actor, {
      matchId: ready[1]!.id,
      courtId: courtB!.id,
      startsAt: new Date(at.getTime() + 10 * MINUTE),
    });
    expect(second.courtId).toBe(courtB!.id);
  });

  it('R13: unassigning a match puts it back in the scheduler’s queue', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    await tournament.schedule(draw.id);

    const scheduled = (await matchesOf(draw.id)).find((m) => m.courtId !== null)!;
    const cleared = await tournament.unassignCourt(organizer.actor, scheduled.id);
    expect(cleared.courtId).toBeNull();
    expect(cleared.scheduledAt).toBeNull();

    const replaced = await tournament.schedule(draw.id);
    expect(replaced.map((a) => a.matchId)).toContain(scheduled.id);
  });

  it('venues R4: a court with matches on it cannot be retired out from under them', async () => {
    const { categoryId, venueId } = await publishedCategory({ courts: 2 });
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    await tournament.schedule(draw.id);

    const scheduled = (await matchesOf(draw.id)).find((m) => m.courtId !== null)!;
    expect(
      await errorCode(() =>
        venues.updateCourt(organizer.actor, scheduled.courtId!, { active: false }),
      ),
    ).toBe('COURT_IN_USE');

    // A court nothing was placed on is still retirable, so the port is
    // answering from the bookings rather than refusing everything.
    const idle = (await venues.courtsFor(venueId)).find(
      (c) => c.id !== scheduled.courtId,
    );
    if (idle) {
      const matchesOnIdle = (await matchesOf(draw.id)).filter((m) => m.courtId === idle.id);
      if (matchesOnIdle.length === 0) {
        expect((await venues.updateCourt(organizer.actor, idle.id, { active: false })).active).toBe(
          false,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

describe('tournament — reads', () => {
  it('the bracket reads back as rounds with derived names', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    await tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId });

    const bracket = (await tournament.bracketFor(categoryId))!;
    expect(bracket.championship.map((r) => r.name)).toEqual([
      'Quarter-final',
      'Semi-final',
      'Final',
    ]);
    expect(bracket.plate.map((r) => r.name)).toEqual(['Semi-final', 'Final']);
  });

  it('standings rank the Championship above the Plate, and joint places share a number', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });
    await playEverything(draw.id);

    const standings = await tournament.standingsFor(categoryId);
    expect(standings).toHaveLength(8);
    expect(standings[0]!.place).toBe(1);
    expect(standings[0]!.bracket).toBe('championship');

    // The champion won three matches; nobody won more.
    expect(standings[0]!.wins).toBe(Math.max(...standings.map((s) => s.wins)));
    // Everyone who lost in Championship round 1 is ranked inside the Plate.
    expect(standings.filter((s) => s.bracket === 'plate')).toHaveLength(4);
    // Places never decrease down the list.
    for (let i = 1; i < standings.length; i += 1) {
      expect(standings[i]!.place).toBeGreaterThanOrEqual(standings[i - 1]!.place);
    }
  });

  it('liveMatches is what is on court right now, across the whole event', async () => {
    const { categoryId, eventId } = await publishedCategory();
    await fieldOf(categoryId, 8);
    const draw = await tournament.generateDraw(organizer.actor, {
      eventCategoryId: categoryId,
    });

    const ready = (await matchesOf(draw.id)).filter((m) => m.status === 'ready');
    expect(await tournament.liveMatches(eventId)).toHaveLength(ready.length);

    await tournament.markLive(ready[0]!.id);
    const live = await tournament.liveMatches(eventId);
    expect(live.find((m) => m.id === ready[0]!.id)?.status).toBe('live');

    await play(ready[0]!);
    expect((await tournament.liveMatches(eventId)).map((m) => m.id)).not.toContain(
      ready[0]!.id,
    );
  });
});

/**
 * A settled rating, written the way `rating` writes one. Seeding reads the
 * settled number and nothing else (R2), so a test about seeding has to produce
 * one rather than a provisional row.
 */
async function settleRating(playerId: string, value: number): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await prisma.ratingEvent.create({
      data: {
        playerId,
        sportId: pickleballId,
        matchId: null,
        algoVersion: 'glicko2-v1',
        ratingBefore: value,
        ratingAfter: value,
        rdBefore: 100,
        rdAfter: 100,
        volatilityAfter: 0.06,
        matchesPlayed: 1,
        isProvisional: false,
      },
    });
  }
}

describe('tournament — gap review fixes (2026-10-03)', () => {
  it('gap #6: no draw while registration is still open', async () => {
    const { categoryId } = await publishedCategory();
    await fieldOf(categoryId, 4);
    expect(
      await errorCode(() => rawTournament.generateDraw(organizer.actor, { eventCategoryId: categoryId })),
    ).toBe(TournamentCode.REGISTRATION_STILL_OPEN);
    expect(await prisma.tournament.count()).toBe(0);
  });

  it('gap #35: a redraw that cannot be made leaves the old draw in place', async () => {
    const { categoryId } = await publishedCategory();
    const entered = await fieldOf(categoryId, 4);
    const first = await tournament.generateDraw(organizer.actor, { eventCategoryId: categoryId });
    // One entry leaves; four is the floor, so a new draw cannot be made.
    await prisma.registration.update({ where: { id: entered[0]!.registrationId }, data: { status: 'withdrawn' } });

    expect(await errorCode(() => tournament.regenerateDraw(organizer.actor, first.id))).toBe(
      TournamentCode.INSUFFICIENT_ENTRIES,
    );
    expect(await prisma.tournament.findUnique({ where: { id: first.id } })).not.toBeNull();
    expect((await matchesOf(first.id)).length).toBeGreaterThan(0);
  });
});
