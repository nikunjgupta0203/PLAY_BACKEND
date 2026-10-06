/**
 * rating — service tests against a real Postgres (conventions.md §5).
 *
 * The engine itself is unit-tested against Glickman's paper in
 * src/modules/rating/glicko2.test.ts. What is under test HERE is everything
 * around it: which results reach the engine, which number is written where, and
 * whether the log can be replayed to the same answer.
 *
 * `scoring` lands in Sprint 8, so confirmed results are handed over through the
 * MatchesPort by `FakeMatches` — which is what the module doc asks for, and the
 * same shape venues and events used for their own forward-looking ports.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, type FakeBoardCache, type FakeMatches } from './helpers/modules.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RatingService } from '../src/modules/rating/service/index.js';
import {
  ALGO_VERSION,
  RANKED_MINIMUM,
  RatingCode,
  UNRATED,
  scopeKey,
  weekStart,
} from '../src/modules/rating/service/index.js';
import type { ConfirmedResult } from '../src/modules/rating/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let rating: RatingService;
let profile: ProfileService;
let sport: SportService;
let results: FakeMatches;
let boardCache: FakeBoardCache;
let pickleballId: string;

interface Player {
  userId: string;
  playerId: string;
  city: string;
}

async function makePlayer(name: string, city = 'Bengaluru'): Promise<Player> {
  const userId = newId();
  const address = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerProfile.update({ where: { id: playerId }, data: { city } });
  await prisma.playerSport.create({
    data: { playerId, sportId: pickleballId, skillBand: '3.5' },
  });
  return { userId, playerId, city };
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

/**
 * A `matches` row for a fabricated result.
 *
 * 009 gave `rating_events.match_id` the foreign key 008 had been waiting for,
 * and that constraint is the point: a rating event is a claim about a match
 * that happened, and a claim about a match that does not exist is one this log
 * should never be able to hold. The scaffolding below is the cheapest honest
 * way to satisfy it — `scoring` still hands the result over through the port,
 * exactly as it will in production.
 */
let draw: { eventCategoryId: string; tournamentId: string } | null = null;
let matchSlot = 0;

async function realMatch(): Promise<string> {
  if (!draw) {
    const organizerId = newId();
    await prisma.user.create({
      data: {
        id: organizerId,
        email: `organizer-${organizerId.slice(0, 8)}@example.com`,
        displayName: 'Fixture Organizer',
      },
    });
    const eventId = newId();
    const at = new Date();
    await prisma.event.create({
      data: {
        id: eventId,
        sportId: pickleballId,
        organizerId,
        slug: `rating-fixture-${eventId.slice(0, 8)}`,
        title: 'Rating fixture',
        city: 'Bengaluru',
        startsAt: at,
        endsAt: at,
        registrationClosesAt: at,
        status: 'completed',
      },
    });
    const eventCategoryId = newId();
    await prisma.eventCategory.create({
      data: {
        id: eventCategoryId,
        eventId,
        sportId: pickleballId,
        name: 'Rating fixture draw',
        format: 'singles',
        capacity: 64,
        entryFeePaise: 0n,
        status: 'completed',
      },
    });
    const tournamentId = newId();
    await prisma.tournament.create({
      data: { id: tournamentId, eventId, eventCategoryId, bracketSize: 64 },
    });
    draw = { eventCategoryId, tournamentId };
  }
  const id = newId();
  matchSlot += 1;
  await prisma.match.create({
    data: {
      id,
      tournamentId: draw.tournamentId,
      eventCategoryId: draw.eventCategoryId,
      sportId: pickleballId,
      bracket: 'championship',
      round: 1,
      slot: matchSlot,
      status: 'completed',
    },
  });
  return id;
}

/** A confirmed result, as scoring will hand one over. */
let matchSeq = 0;
async function result(
  winners: Player[],
  losers: Player[],
  opts: { outcome?: ConfirmedResult['outcome']; at?: Date; drawn?: boolean } = {},
): Promise<ConfirmedResult> {
  matchSeq += 1;
  return results.add({
    matchId: await realMatch(),
    sportId: pickleballId,
    outcome: opts.outcome ?? 'played',
    winner: {
      registrationId: newId(),
      playerIds: winners.map((p) => p.playerId),
    },
    loser: {
      registrationId: newId(),
      playerIds: losers.map((p) => p.playerId),
    },
    confirmedAt: opts.at ?? new Date(Date.now() - matchSeq * 60_000),
    drawn: opts.drawn ?? false,
  });
}

/** Opens the period covering `at` and settles it. */
async function settlePeriod(at = new Date()): Promise<{ playersUpdated: number }> {
  const period = await rating.periodFor(pickleballId, at);
  return rating.runPeriod(period.id);
}

const ratingsOf = async (): Promise<Record<string, number>> => {
  const rows = await prisma.playerSport.findMany({ where: { sportId: pickleballId } });
  return Object.fromEntries(rows.map((r) => [r.playerId, Number(r.rating ?? 0)]));
};

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  rating = wired.rating;
  profile = wired.profile;
  sport = wired.sport;
  results = wired.results;
  boardCache = wired.boardCache;
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Results are stamped minutes before "now" and the period covering "now" is
 * settled. Weekly periods open on Monday 00:00 IST, so in the first hour of a
 * Monday those results landed in last week and the period came up empty. Pin
 * the clock to Wednesday noon IST; only `Date` is faked, so Prisma's timers and
 * the container keep real time. It still ticks, so ordering by time holds.
 */
const PINNED_NOW = new Date('2026-09-30T06:30:00.000Z');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true, advanceTimeDelta: 1 });
  vi.setSystemTime(PINNED_NOW);
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  results.reset();
  boardCache.reset();
  matchSeq = 0;
  // Truncated with everything else, so the next test builds its own.
  draw = null;
  matchSlot = 0;
});

// ─────────────────────────────────────────────────────────────────────────────
// Done when — the determinism replay
// ─────────────────────────────────────────────────────────────────────────────

describe('rating — Done when: the log replays to the same numbers', () => {
  it('replaying every settled row under the same engine reproduces each rating exactly', async () => {
    const field = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makePlayer(`Player ${i}`)),
    );
    const start = new Date(Date.now() - 60 * 60_000);

    // A round-robin-ish card: everyone plays, some more than others, and the
    // results are not symmetrical — a replay of a symmetrical card would prove
    // nothing.
    for (let i = 0; i < field.length; i += 1) {
      for (let j = i + 1; j < field.length; j += 1) {
        const winner = (i + j) % 3 === 0 ? field[j]! : field[i]!;
        const loser = winner === field[i]! ? field[j]! : field[i]!;
        await result([winner], [loser], { at: new Date(start.getTime() + (i * 8 + j) * 1000) });
      }
    }

    await settlePeriod(start);
    const before = await ratingsOf();
    const logBefore = await prisma.ratingEvent.count({ where: { isProvisional: false } });
    expect(logBefore).toBe(field.length);
    expect(Object.values(before).every((r) => r !== 0)).toBe(true);

    // Replay from before the first period. Same engine, same inputs, same
    // order — and therefore, if the module is honest about being replayable,
    // the same numbers to the last decimal.
    const replayed = await rating.replay(
      pickleballId,
      new Date(start.getTime() - 86_400_000),
      ALGO_VERSION,
    );
    expect(replayed.playersUpdated).toBe(field.length);

    const after = await ratingsOf();
    expect(after).toEqual(before);

    // And the log did not grow: a replay supersedes settled rows, it does not
    // append a second set of them.
    expect(await prisma.ratingEvent.count({ where: { isProvisional: false } })).toBe(logBefore);
  });

  it('a replay under an engine this build does not have refuses rather than guesses', async () => {
    expect(
      await errorCode(() => rating.replay(pickleballId, new Date(0), 'glicko2-v9')),
    ).toBe(RatingCode.UNKNOWN_ALGO_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

describe('rating', () => {
  it('R3: a confirmed result writes a provisional row that the period supersedes', async () => {
    const winner = await makePlayer('Winner');
    const loser = await makePlayer('Loser');
    const match = await result([winner], [loser]);

    const provisional = await rating.applyMatch(match.matchId);

    expect(provisional).toHaveLength(2);
    expect(provisional.every((e) => e.isProvisional)).toBe(true);
    expect(provisional.every((e) => e.algoVersion === ALGO_VERSION)).toBe(true);

    const winnerRow = provisional.find((e) => e.playerId === winner.playerId)!;
    expect(winnerRow.ratingBefore).toBe(UNRATED.rating);
    expect(winnerRow.ratingAfter).toBeGreaterThan(UNRATED.rating);

    // The period rates the same match again, from the same starting position,
    // and writes the settled row. Both stay in the log so history reads
    // continuously.
    await settlePeriod();

    const rows = await prisma.ratingEvent.findMany({
      where: { playerId: winner.playerId },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.isProvisional)).toEqual([true, false]);
    expect((await rating.ratingFor(winner.playerId, pickleballId)).rating).toBe(
      Number(rows[1]!.ratingAfter),
    );
  });

  it('R3: a provisional rating is not an input to the next calculation', async () => {
    const winner = await makePlayer('Winner');
    const loser = await makePlayer('Loser');

    const first = await result([winner], [loser]);
    await rating.applyMatch(first.matchId);

    // A second match, provisionally rated before anything settled. It must
    // start from the SETTLED position — 1500 — not from the first match's
    // preview, or the same result would compound.
    const second = await result([winner], [loser]);
    const rows = await rating.applyMatch(second.matchId);

    expect(rows.find((e) => e.playerId === winner.playerId)!.ratingBefore).toBe(
      UNRATED.rating,
    );
  });

  it('R3: redelivering a confirmed result rates it once', async () => {
    const winner = await makePlayer('Winner');
    const loser = await makePlayer('Loser');
    const match = await result([winner], [loser]);

    await rating.applyMatch(match.matchId);
    const again = await rating.applyMatch(match.matchId);

    expect(again).toHaveLength(0);
    expect(await prisma.ratingEvent.count()).toBe(2);
  });

  it('R4: the period rates a whole card in one update, not match by match', async () => {
    const player = await makePlayer('Busy');
    const a = await makePlayer('Opponent A');
    const b = await makePlayer('Opponent B');
    const c = await makePlayer('Opponent C');
    const at = new Date(Date.now() - 30 * 60_000);

    await result([player], [a], { at });
    await result([player], [b], { at: new Date(at.getTime() + 1000) });
    await result([c], [player], { at: new Date(at.getTime() + 2000) });

    await settlePeriod(at);

    // One settled row for the week, covering three matches — that is what
    // Glicko-2 is defined over, and rating them one at a time gives a
    // different, wrong answer.
    const rows = await prisma.ratingEvent.findMany({
      where: { playerId: player.playerId, isProvisional: false },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ratingPeriodId).not.toBeNull();
  });

  it('R4: a period that has already run refuses rather than rating twice', async () => {
    const winner = await makePlayer('Winner');
    const loser = await makePlayer('Loser');
    await result([winner], [loser]);

    const period = await rating.periodFor(pickleballId, new Date());
    await rating.runPeriod(period.id);

    expect(await errorCode(() => rating.runPeriod(period.id))).toBe(
      RatingCode.PERIOD_ALREADY_RUN,
    );
    expect(await prisma.ratingEvent.count({ where: { isProvisional: false } })).toBe(2);
  });

  it('R4: periods start on Monday at 03:00 IST', async () => {
    // A Thursday, 2026-09-10 12:00 IST.
    const thursday = new Date('2026-09-10T06:30:00.000Z');
    const start = weekStart(thursday);

    // 2026-09-07 is the Monday of that week. 03:00 IST is 21:30 UTC the day
    // before.
    expect(start.toISOString()).toBe('2026-09-06T21:30:00.000Z');
    // Every instant in the week maps to the same period.
    expect(weekStart(new Date('2026-09-12T18:00:00.000Z')).getTime()).toBe(start.getTime());
    // And the following Monday opens the next one.
    expect(weekStart(new Date('2026-09-14T02:00:00.000Z')).getTime()).toBeGreaterThan(
      start.getTime(),
    );
  });

  it('R5: a doubles result moves the less certain partner further', async () => {
    const known = await makePlayer('Known');
    const unknown = await makePlayer('Unknown');
    const oppA = await makePlayer('Opponent A');
    const oppB = await makePlayer('Opponent B');

    // Give one partner a settled, confident rating first: five weeks of results
    // is what makes an RD small, and the split is about RD.
    for (let week = 1; week <= 5; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([known], [oppA], { at });
      await settlePeriod(at);
    }
    const knownBefore = await rating.ratingFor(known.playerId, pickleballId);
    const unknownBefore = await rating.ratingFor(unknown.playerId, pickleballId);
    expect(knownBefore.rd).toBeLessThan(unknownBefore.rd);

    const at = new Date();
    await result([known, unknown], [oppA, oppB], { at });
    await settlePeriod(at);

    const knownAfter = await rating.ratingFor(known.playerId, pickleballId);
    const unknownAfter = await rating.ratingFor(unknown.playerId, pickleballId);

    const knownDelta = Math.abs(knownAfter.rating - knownBefore.rating);
    const unknownDelta = Math.abs(unknownAfter.rating - unknownBefore.rating);
    // The less certain player absorbs more of the change, which is what RD
    // means.
    expect(unknownDelta).toBeGreaterThan(knownDelta);
  });

  it('R6: beating a much weaker field moves a rating less than beating a real one', async () => {
    const stacker = await makePlayer('Stacker');
    const honest = await makePlayer('Honest');
    const weak = await makePlayer('Weak');
    const peer = await makePlayer('Peer');

    // Drive the two victims apart first, so the 400-point gap is real rather
    // than assumed.
    const early = new Date(Date.now() - 30 * 86_400_000);
    for (let i = 0; i < 12; i += 1) {
      await result([peer], [weak], { at: new Date(early.getTime() + i * 60_000) });
    }
    await settlePeriod(early);

    const weakRating = (await rating.ratingFor(weak.playerId, pickleballId)).rating;
    const peerRating = (await rating.ratingFor(peer.playerId, pickleballId)).rating;
    expect(peerRating - weakRating).toBeGreaterThan(400);

    // Now: one player farms the weak one, the other beats the peer. Same number
    // of wins, same starting rating.
    const at = new Date();
    await result([stacker], [weak], { at });
    await result([honest], [peer], { at: new Date(at.getTime() + 1000) });
    await settlePeriod(at);

    const stackerAfter = (await rating.ratingFor(stacker.playerId, pickleballId)).rating;
    const honestAfter = (await rating.ratingFor(honest.playerId, pickleballId)).rating;

    expect(stackerAfter).toBeGreaterThan(UNRATED.rating);
    expect(stackerAfter).toBeLessThan(honestAfter);
  });

  it('a league draw is half a win each: between equals nobody moves, against a stronger player you gain', async () => {
    const [even1, even2] = [await makePlayer('Even 1'), await makePlayer('Even 2')];
    await result([even1], [even2], { drawn: true });
    const strong = await makePlayer('Strong');
    const weak = await makePlayer('Weak');
    const stake = await makePlayer('Stake');
    // Strong is stronger: beat a third player twice in an earlier period.
    const earlier = new Date(Date.now() - 8 * 86_400_000);
    await result([strong], [stake], { at: earlier });
    await result([strong], [stake], { at: new Date(earlier.getTime() + 60_000) });
    await settlePeriod(earlier);
    const strongBefore = (await rating.ratingFor(strong.playerId, pickleballId)).rating;

    await result([strong], [weak], { drawn: true });
    await settlePeriod();
    const now = await ratingsOf();
    expect(now[even1.playerId]).toBeCloseTo(UNRATED.rating, 6);
    expect(now[even2.playerId]).toBeCloseTo(UNRATED.rating, 6);
    expect(now[strong.playerId]).toBeLessThan(strongBefore);
    expect(now[weak.playerId]).toBeGreaterThan(UNRATED.rating);
  });

  it('R7: a walkover does not touch either rating', async () => {
    const winner = await makePlayer('Present');
    const loser = await makePlayer('Absent');
    const match = await result([winner], [loser], { outcome: 'walkover' });

    expect(await rating.applyMatch(match.matchId)).toHaveLength(0);
    await settlePeriod();

    // Not through the provisional door, and not through the period door either.
    expect(await prisma.ratingEvent.count()).toBe(0);
    expect((await rating.ratingFor(winner.playerId, pickleballId)).rating).toBe(
      UNRATED.rating,
    );
  });

  it('F20: a match against a walk-in guest (no player profile) is not rated, and does not fail', async () => {
    const real = await makePlayer('Real');
    // The guest's side reaches rating with nobody on it.
    const match = await result([real], []);

    expect(await rating.applyMatch(match.matchId)).toHaveLength(0);
    await settlePeriod();
    expect(await prisma.ratingEvent.count()).toBe(0);
  });

  it('R7: retirements and forfeits are skipped for the same reason', async () => {
    const a = await makePlayer('A');
    const b = await makePlayer('B');
    await result([a], [b], { outcome: 'retired' });
    await result([a], [b], { outcome: 'forfeit' });

    await settlePeriod();
    expect(await prisma.ratingEvent.count()).toBe(0);
  });

  it('R9: a player under five settled matches is unranked, not badly ranked', async () => {
    const player = await makePlayer('Newcomer');
    const opponent = await makePlayer('Opponent');

    for (let week = 1; week <= 3; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([player], [opponent], { at });
      await settlePeriod(at);
    }

    const found = await rating.ratingFor(player.playerId, pickleballId);
    expect(found.matchesPlayed).toBeLessThan(RANKED_MINIMUM);
    expect(found.provisional).toBe(true);
    expect(await errorCode(() => rating.rankedRatingFor(player.playerId, pickleballId))).toBe(
      RatingCode.RATING_UNAVAILABLE,
    );

    // And they are not on the board either — a number nobody should act on is
    // not a number to rank people by.
    await rating.rebuildRankings(pickleballId, { kind: 'national' });
    const board = await rating.leaderboard(
      pickleballId,
      { kind: 'national' },
      { first: 50 },
    );
    expect(board.nodes.map((n) => n.playerId)).not.toContain(player.playerId);
  });

  it('R9: five settled matches puts a player on the board', async () => {
    const player = await makePlayer('Regular');
    const opponent = await makePlayer('Opponent');

    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([player], [opponent], { at });
      await settlePeriod(at);
    }

    const found = await rating.ratingFor(player.playerId, pickleballId);
    expect(found.matchesPlayed).toBeGreaterThanOrEqual(RANKED_MINIMUM);
    expect(found.provisional).toBe(false);

    await rating.rebuildRankings(pickleballId, { kind: 'national' });
    const board = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 50 });
    expect(board.nodes.map((n) => n.playerId)).toContain(player.playerId);
  });

  it('R10: scopes are enumerated, and the database refuses anything else', async () => {
    expect(scopeKey({ kind: 'national' })).toBe('national');
    expect(scopeKey({ kind: 'city', value: 'Bengaluru' })).toBe('city:Bengaluru');
    expect(scopeKey({ kind: 'age', value: '35+' })).toBe('age:35+');

    const player = await makePlayer('Anybody');
    // An open-ended scope string is an unbounded table, so the CHECK is in the
    // schema rather than only in the service.
    await expect(
      prisma.ranking.create({
        data: {
          sportId: pickleballId,
          scope: 'whatever-i-like',
          playerId: player.playerId,
          rank: 1,
          rating: 1500,
          matchesPlayed: 5,
          computedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it('R10: a city board holds only that city', async () => {
    const local = await makePlayer('Local', 'Bengaluru');
    const visitor = await makePlayer('Visitor', 'Mumbai');
    const opponent = await makePlayer('Opponent', 'Bengaluru');

    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([local], [opponent], { at });
      await result([visitor], [opponent], { at: new Date(at.getTime() + 1000) });
      await settlePeriod(at);
    }

    await rating.rebuildAll(pickleballId);

    const blr = await rating.leaderboard(
      pickleballId,
      { kind: 'city', value: 'Bengaluru' },
      { first: 50 },
    );
    const ids = blr.nodes.map((n) => n.playerId);
    expect(ids).toContain(local.playerId);
    expect(ids).not.toContain(visitor.playerId);

    // And the national board holds both.
    const national = await rating.leaderboard(
      pickleballId,
      { kind: 'national' },
      { first: 50 },
    );
    expect(national.nodes.map((n) => n.playerId)).toEqual(
      expect.arrayContaining([local.playerId, visitor.playerId]),
    );
  });

  it('R11: movement is stored, and positive means the player went up', async () => {
    const climber = await makePlayer('Climber');
    const leader = await makePlayer('Leader');
    const filler = await makePlayer('Filler');

    // Six weeks that leave the leader on top and the climber below.
    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - (week + 4) * 8 * 86_400_000);
      await result([leader], [filler], { at });
      await result([filler], [climber], { at: new Date(at.getTime() + 1000) });
      await settlePeriod(at);
    }
    await rating.rebuildRankings(pickleballId, { kind: 'national' });

    const first = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 50 });
    const climberRankBefore = first.nodes.find((n) => n.playerId === climber.playerId)!.rank;
    expect(climberRankBefore).toBeGreaterThan(1);

    // Now the climber beats the leader, repeatedly.
    for (let week = 1; week <= 4; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([climber], [leader], { at });
      await settlePeriod(at);
    }
    await rating.rebuildRankings(pickleballId, { kind: 'national' });

    const second = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 50 });
    const climberAfter = second.nodes.find((n) => n.playerId === climber.playerId)!;
    expect(climberAfter.rank).toBeLessThan(climberRankBefore);
    // Stored, not derived at read time: the arrow costs no second query.
    expect(climberAfter.movement).toBe(climberRankBefore - climberAfter.rank);
    expect(climberAfter.movement).toBeGreaterThan(0);
  });

  it('R11: a first appearance on the board has no movement to report', async () => {
    const player = await makePlayer('Debutant');
    const opponent = await makePlayer('Opponent');
    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([player], [opponent], { at });
      await settlePeriod(at);
    }

    await rating.rebuildRankings(pickleballId, { kind: 'national' });
    const board = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 50 });

    // Not "up from nowhere" — a debut is not a climb.
    expect(board.nodes.every((n) => n.movement === 0)).toBe(true);
  });

  it('R12: ratings reach player_sports only through profile.applyRating', async () => {
    const winner = await makePlayer('Winner');
    const loser = await makePlayer('Loser');
    await result([winner], [loser]);
    await settlePeriod();

    const row = await prisma.playerSport.findUniqueOrThrow({
      where: { playerId_sportId: { playerId: winner.playerId, sportId: pickleballId } },
    });
    const settled = await prisma.ratingEvent.findFirstOrThrow({
      where: { playerId: winner.playerId, isProvisional: false },
    });

    // The column and the log agree, because the log is what wrote the column.
    expect(Number(row.rating)).toBe(Number(settled.ratingAfter));
    expect(Number(row.ratingDev)).toBe(Number(settled.rdAfter));
    // One settled match, which is the count the log sums to.
    expect(row.matchesPlayed).toBe(1);
    // profile R9 decides `is_provisional` from that count, and rating does not
    // get a say — it never touches the column directly.
    expect(row.isProvisional).toBe(true);
  });

  it('R8: every row carries the engine that produced it', async () => {
    const winner = await makePlayer('Winner');
    const loser = await makePlayer('Loser');
    const match = await result([winner], [loser]);
    await rating.applyMatch(match.matchId);
    await settlePeriod();

    const rows = await prisma.ratingEvent.findMany();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.algoVersion === ALGO_VERSION)).toBe(true);
  });

  it('R1: a rating log is append-only — history keeps every row', async () => {
    const player = await makePlayer('Veteran');
    const opponent = await makePlayer('Opponent');

    for (let week = 1; week <= 3; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      const match = await result([player], [opponent], { at });
      await rating.applyMatch(match.matchId);
      await settlePeriod(at);
    }

    const history = await rating.historyFor(player.playerId, pickleballId, { first: 50 });
    // Three provisional rows and three settled ones, newest first.
    expect(history.nodes).toHaveLength(6);
    expect(history.nodes.filter((e) => e.isProvisional)).toHaveLength(3);
    for (let i = 1; i < history.nodes.length; i += 1) {
      expect(history.nodes[i]!.id < history.nodes[i - 1]!.id).toBe(true);
    }
  });

  it('the leaderboard serves its first page from cache and deep pages from Postgres', async () => {
    const field = await Promise.all(
      Array.from({ length: 6 }, (_, i) => makePlayer(`Board ${i}`)),
    );
    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      for (let i = 0; i < field.length; i += 2) {
        await result([field[i]!], [field[i + 1]!], { at: new Date(at.getTime() + i * 1000) });
      }
      await settlePeriod(at);
    }

    await rating.rebuildRankings(pickleballId, { kind: 'national' });
    expect(boardCache.entries.get(`rankings:${pickleballId}:national`)).toBeDefined();

    const cached = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 2 });
    expect(cached.nodes).toHaveLength(2);
    expect(cached.hasNextPage).toBe(true);

    // A deep page is a real query, and it continues where the first left off.
    const deep = await rating.leaderboard(pickleballId, { kind: 'national' }, {
      first: 10,
      after: cached.endCursor,
    });
    expect(deep.nodes.map((n) => n.playerId)).not.toContain(cached.nodes[0]!.playerId);

    // A cold cache is a slower board, never a wrong one.
    boardCache.reset();
    const cold = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 2 });
    expect(cold.nodes.map((n) => n.playerId)).toEqual(cached.nodes.map((n) => n.playerId));
  });

  it('a player who falls off the board does not sit on it at a stale rank', async () => {
    const player = await makePlayer('Ranked');
    const opponent = await makePlayer('Opponent');
    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([player], [opponent], { at });
      await settlePeriod(at);
    }
    await rating.rebuildRankings(pickleballId, { kind: 'national' });
    expect(
      (await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 50 })).nodes.length,
    ).toBeGreaterThan(0);

    // The player leaves the sport. The next rebuild must drop them rather than
    // leave a rank nobody holds.
    await prisma.playerSport.deleteMany({ where: { sportId: pickleballId } });
    await rating.rebuildRankings(pickleballId, { kind: 'national' });

    const board = await rating.leaderboard(pickleballId, { kind: 'national' }, { first: 50 });
    expect(board.nodes).toHaveLength(0);
    expect(await prisma.ranking.count()).toBe(0);
  });

  it('an unrated player reads as 1500 with the widest deviation', async () => {
    const player = await makePlayer('Nobody');
    const found = await rating.ratingFor(player.playerId, pickleballId);

    expect(found.rating).toBe(UNRATED.rating);
    expect(found.rd).toBe(UNRATED.rd);
    expect(found.matchesPlayed).toBe(0);
    expect(found.provisional).toBe(true);
  });

  it('a period with no results settles nobody rather than failing', async () => {
    const period = await rating.periodFor(pickleballId, new Date());
    expect(await rating.runPeriod(period.id)).toEqual({ playersUpdated: 0 });
    expect(await prisma.ratingEvent.count()).toBe(0);
  });
});

describe('rating — your standing on a board', () => {
  it('R11: your row, the player just above you, and when the board was built', async () => {
    const top = await makePlayer('Top');
    const middle = await makePlayer('Middle');
    const bottom = await makePlayer('Bottom');
    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([top], [middle], { at });
      await result([middle], [bottom], { at: new Date(at.getTime() + 1000) });
      await settlePeriod(at);
    }
    await rating.rebuildRankings(pickleballId, { kind: 'national' });

    const mine = await rating.myStanding(pickleballId, { kind: 'national' }, middle.playerId);
    expect(mine.row?.rank).toBe(2);
    expect(mine.next?.rank).toBe(1);
    expect(mine.next!.rating).toBeGreaterThan(mine.row!.rating);
    expect(mine.updatedAt).toBeInstanceOf(Date);

    const leader = await rating.myStanding(pickleballId, { kind: 'national' }, top.playerId);
    expect(leader.row?.rank).toBe(1);
    expect(leader.next).toBeNull();
  });

  it('R9: an unranked player has no row, but still learns when the board was built', async () => {
    const a = await makePlayer('A');
    const b = await makePlayer('B');
    const newcomer = await makePlayer('Newcomer');
    for (let week = 1; week <= 6; week += 1) {
      const at = new Date(Date.now() - week * 8 * 86_400_000);
      await result([a], [b], { at });
      await settlePeriod(at);
    }
    await rating.rebuildRankings(pickleballId, { kind: 'national' });

    const mine = await rating.myStanding(pickleballId, { kind: 'national' }, newcomer.playerId);
    expect(mine).toMatchObject({ row: null, next: null });
    expect(mine.updatedAt).toBeInstanceOf(Date);
  });

  it('an empty board has no build time', async () => {
    const lonely = await makePlayer('Lonely');
    const mine = await rating.myStanding(pickleballId, { kind: 'national' }, lonely.playerId);
    expect(mine).toEqual({ row: null, next: null, updatedAt: null });
  });
});
