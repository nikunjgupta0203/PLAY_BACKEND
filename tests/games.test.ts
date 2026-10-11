/**
 * games — service tests against a real Postgres (conventions.md §5).
 * Every numbered rule has a test that names it: `grep 'R3:'` finds games R3.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createGamesRepo } from '../src/modules/games/repo/index.js';
import {
  createGamesService,
  GameCode,
  MAX_OPEN_GAMES,
  type GameInput,
  type GamesService,
} from '../src/modules/games/service/index.js';
import { createIdentityService } from '../src/modules/identity/service/index.js';
import { FOOTBALL, PICKLEBALL, RUNNING, seedSport, TENNIS } from '../src/modules/sport/seed.js';
import { UserError } from '../src/platform/errors/index.js';
import { casualWinnerOf, ScoringInputError } from '../src/modules/scoring/engine.js';
import {
  createGameResults,
  RESULT_AUTO_CONFIRM_MS,
  ResultCode,
  RESULTS_OPEN_AFTER_MS,
  type GameResultsService,
} from '../src/modules/games/service/results.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let games: GamesService;
let results: GameResultsService;
let clock: Date;
let sportId: string;
const notices: { userId: string; template: string; payload: Record<string, unknown> }[] = [];
const inactive = new Set<string>();

const MIN = 60_000;
const HOUR = 60 * MIN;
const PIN = { lat: 23.0225, lng: 72.5714 }; // Ahmedabad

async function user(name: string, phone?: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, email: `${name}-${userId}@example.com`.toLowerCase(), displayName: name, phoneE164: phone ?? null },
  });
  return { userId };
}

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? `THREW: ${String(e)}`;
  }
  return 'NO_ERROR';
};

/** A game tomorrow, 18:30–20:00, at a pin. */
function input(over: Partial<GameInput> = {}): GameInput {
  const startsAt = new Date(clock.getTime() + 26 * HOUR);
  return {
    sportId,
    location: PIN,
    placeName: 'Law Garden courts',
    city: 'Ahmedabad',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 90 * MIN),
    maxPlayers: 4,
    ...over,
  };
}

const sentTo = (template: string): string[] => notices.filter((n) => n.template === template).map((n) => n.userId);

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  modules = buildModules(prisma);
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  modules.sport.refresh();
  notices.length = 0;
  inactive.clear();
  clock = new Date('2026-10-11T04:30:00.000Z'); // Sunday 10:00 IST
  sportId = await seedSport(prisma, PICKLEBALL);
  modules.sport.refresh();
  const db = prisma as unknown as Db;
  const identity = createIdentityService({
    db: prisma as never,
    email: { send: async () => ({ messageId: null }) },
    limiter: { consumeAll: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
    profile: modules.profile,
  });
  games = createGamesService({
    db,
    repo: createGamesRepo(db),
    sport: {
      findById: (id) => modules.sport.byId(id).catch(() => null),
      hasSkillBand: (id, key) => modules.sport.hasSkillBand(id, key),
    },
    venues: { findById: (id) => modules.venues.findById(id) },
    users: {
      async namesByIds(ids) {
        const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
        return new Map(rows.map((r) => [r.id, r.displayName]));
      },
      inactive: async (ids) => new Set(ids.filter((id) => inactive.has(id))),
      async phoneOf(userId) {
        return (await prisma.user.findUnique({ where: { id: userId }, select: { phoneE164: true } }))?.phoneE164 ?? null;
      },
      // The real lookup: numbers are stored as typed, so the matching is the thing under test.
      findByPhone: (phone) => identity.findByPhone(phone),
    },
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
    async notify(userIds, template, payload) {
      for (const userId of userIds) notices.push({ userId, template, payload });
    },
    now: () => clock,
  });
  const ruleOf = (id: string) => modules.sport.scoringRuleFor(id);
  results = createGameResults({
    db,
    games: { byId: (id) => games.byId(id) },
    rules: {
      supported: async (id) => {
        const rule = await ruleOf(id);
        return rule.kind !== 'performance' && rule.kind !== 'scorecard';
      },
      // The real judge: held to the seeded sport's own rule.
      judge: async (id, units) => {
        try {
          return casualWinnerOf(units, await ruleOf(id));
        } catch (err) {
          if (err instanceof ScoringInputError) throw new UserError(ResultCode.INVALID_RESULT, err.message);
          throw err;
        }
      },
      finishes: async (id) => {
        const rule = await ruleOf(id);
        return rule.kind === 'bouts' ? rule.finishes : [];
      },
    },
    users: {
      async namesByIds(ids) {
        const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
        return new Map(rows.map((r) => [r.id, r.displayName]));
      },
    },
    sportName: async (id) => (await modules.sport.byId(id)).name,
    async notify(userIds, template, payload) {
      for (const userId of userIds) notices.push({ userId, template, payload });
    },
    now: () => clock,
  });
});

describe('games — create', () => {
  it('R1: the host is the first player, and the game is open', async () => {
    const host = await user('Asha');
    const game = await games.create(host, input());

    expect(game.status).toBe('open');
    expect(game.playerUserIds).toEqual([host.userId]);
    expect(game.location).toEqual(PIN);
    expect(game.placeName).toBe('Law Garden courts');
  });

  it('R9: a game is at a listed venue or a named pin, never free text alone', async () => {
    const host = await user('Asha');
    expect(await codeOf(() => games.create(host, input({ location: null })))).toBe(GameCode.INVALID_GAME);
    expect(await codeOf(() => games.create(host, input({ placeName: '' })))).toBe(GameCode.INVALID_GAME);

    const venue = await modules.venues.create(host, {
      name: 'Smash Arena',
      address: '1 CG Road',
      city: 'Ahmedabad',
      location: PIN,
      courts: [{ name: 'Court 1', sportIds: [sportId] }],
    });
    const game = await games.create(host, input({ venueId: venue.id, location: null, placeName: null }));
    expect(game.venueId).toBe(venue.id);
    expect(game.city).toBe('Ahmedabad');
    expect(game.location).toBeNull();
  });

  it('create: times, capacity and the minimum are checked', async () => {
    const host = await user('Asha');
    const start = input().startsAt;
    expect(await codeOf(() => games.create(host, input({ endsAt: start })))).toBe(GameCode.INVALID_GAME);
    expect(await codeOf(() => games.create(host, input({ startsAt: new Date(clock.getTime() - HOUR) })))).toBe(GameCode.INVALID_GAME);
    expect(await codeOf(() => games.create(host, input({ maxPlayers: 1 })))).toBe(GameCode.INVALID_GAME);
    expect(await codeOf(() => games.create(host, input({ minPlayers: 6 })))).toBe(GameCode.INVALID_GAME);
    expect(await codeOf(() => games.create(host, input({ skillBand: 'expert-ish' })))).toBe(GameCode.INVALID_GAME);
    expect(await codeOf(() => games.create(host, input({ sportId: newId() })))).toBe(GameCode.INVALID_GAME);
  });

  it(`create: a host runs at most ${MAX_OPEN_GAMES} open games at once`, async () => {
    const host = await user('Asha');
    for (let i = 0; i < MAX_OPEN_GAMES; i += 1) await games.create(host, input());
    expect(await codeOf(() => games.create(host, input()))).toBe(GameCode.TOO_MANY_GAMES);
  });
});

describe('games — joining', () => {
  it('R2, R3: joining is automatic, the last place makes the game full, and one more is refused', async () => {
    const host = await user('Asha');
    const [b, c, d] = await Promise.all([user('Bina'), user('Chirag'), user('Dev')]);
    const game = await games.create(host, input({ maxPlayers: 3, minPlayers: 2 }));

    const afterB = await games.join(b!, game.id);
    expect(afterB.status).toBe('open');
    expect(sentTo('game.player_joined')).toEqual([host.userId]);

    const afterC = await games.join(c!, game.id);
    expect(afterC.status).toBe('full');
    expect(afterC.playerUserIds).toEqual([host.userId, b!.userId, c!.userId]);
    // Full is told to the host and to every player.
    expect(sentTo('game.full').sort()).toEqual([host.userId, b!.userId, c!.userId].sort());

    expect(await codeOf(() => games.join(d!, game.id))).toBe(GameCode.GAME_FULL);
    expect(await codeOf(() => games.join(b!, game.id))).toBe(GameCode.ALREADY_JOINED);
  });

  it('R2: two players racing for the last place — exactly one gets it', async () => {
    const host = await user('Asha');
    const [b, c] = await Promise.all([user('Bina'), user('Chirag')]);
    const game = await games.create(host, input({ maxPlayers: 2 }));

    const results = await Promise.all([codeOf(() => games.join(b!, game.id)), codeOf(() => games.join(c!, game.id))]);

    expect(results.sort()).toEqual([GameCode.GAME_FULL, 'NO_ERROR'].sort());
    expect((await games.byId(game.id)).playerUserIds).toHaveLength(2);
  });

  it('R3: a player leaving a full game opens it again', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input({ maxPlayers: 2 }));
    await games.join(b, game.id);
    expect((await games.byId(game.id)).status).toBe('full');

    const after = await games.leave(b, game.id);
    expect(after.status).toBe('open');
    expect(after.playerUserIds).toEqual([host.userId]);
    // Someone who left may come back.
    expect((await games.join(b, game.id)).status).toBe('full');
  });

  it('R4: the host cannot leave; cancelling is how a host walks away', async () => {
    const host = await user('Asha');
    const game = await games.create(host, input());
    expect(await codeOf(() => games.leave(host, game.id))).toBe(GameCode.HOST_CANNOT_LEAVE);
  });

  it('R5: the host removes a player, the place reopens, and that player cannot rejoin', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input({ maxPlayers: 2 }));
    await games.join(b, game.id);

    expect(await codeOf(() => games.removePlayer(b, game.id, host.userId))).toBe('FORBIDDEN');
    const after = await games.removePlayer(host, game.id, b.userId);
    expect(after.status).toBe('open');
    expect(after.playerUserIds).toEqual([host.userId]);
    expect(await codeOf(() => games.join(b, game.id))).toBe(GameCode.GAME_REMOVED);
    // And Discover stops offering it to them.
    expect((await games.search({ viewerUserId: b.userId }, { first: 10 })).nodes).toHaveLength(0);
    expect((await games.search({ viewerUserId: host.userId }, { first: 10 })).nodes).toHaveLength(1);
  });
});

describe('games — status', () => {
  it('R6: a game past its end reads as completed at once, and the sweep writes it', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input());

    clock = new Date(game.endsAt.getTime() + MIN);
    expect((await games.byId(game.id)).status).toBe('completed');
    expect(await codeOf(() => games.join(b, game.id))).toBe(GameCode.GAME_CLOSED);
    expect((await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).status).toBe('open');

    expect((await games.sweep()).completed).toBe(1);
    const row = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(row.status).toBe('completed');
    expect(row.completedAt).not.toBeNull();
    expect((await games.sweep()).completed).toBe(0);
  });

  it('R6: the host may mark a game played once it has started, not before', async () => {
    const host = await user('Asha');
    const game = await games.create(host, input());
    expect(await codeOf(() => games.complete(host, game.id))).toBe(GameCode.INVALID_GAME);

    clock = new Date(game.startsAt.getTime() + MIN);
    expect((await games.complete(host, game.id)).status).toBe('completed');
  });

  it('cancel: host only, every joined player is told, and nobody can join afterwards', async () => {
    const host = await user('Asha');
    const [b, c] = await Promise.all([user('Bina'), user('Chirag')]);
    const game = await games.create(host, input());
    await games.join(b!, game.id);

    expect(await codeOf(() => games.cancel(b!, game.id))).toBe('FORBIDDEN');
    const after = await games.cancel(host, game.id, 'Court is flooded');
    expect(after.status).toBe('cancelled');
    expect(after.cancelReason).toBe('Court is flooded');
    expect(sentTo('game.cancelled')).toEqual([b!.userId]);
    expect(await codeOf(() => games.join(c!, game.id))).toBe(GameCode.GAME_CLOSED);
    expect((await games.search({}, { first: 10 })).nodes).toHaveLength(0);
  });
});

describe('games — editing', () => {
  it('R7: a new time or place is told to every joined player but the host', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input());
    await games.join(b, game.id);

    // Notes are not news.
    await games.update(host, game.id, { notes: 'Bring water' });
    expect(sentTo('game.changed')).toEqual([]);

    const later = new Date(game.startsAt.getTime() + HOUR);
    const moved = await games.update(host, game.id, { startsAt: later, endsAt: new Date(later.getTime() + HOUR) });
    expect(moved.startsAt).toEqual(later);
    expect(sentTo('game.changed')).toEqual([b.userId]);
    expect(notices.at(-1)?.payload).toMatchObject({ timeChanged: true, placeChanged: false });

    await games.update(host, game.id, { placeName: 'Parimal Garden courts', location: { lat: 23.02, lng: 72.56 } });
    expect(notices.at(-1)?.payload).toMatchObject({ timeChanged: false, placeChanged: true, placeName: 'Parimal Garden courts' });
    expect(await codeOf(() => games.update(b, game.id, { notes: 'x' }))).toBe('FORBIDDEN');
  });

  it('R3: the maximum cannot drop below who has joined, and raising it reopens a full game', async () => {
    const host = await user('Asha');
    const [b, c] = await Promise.all([user('Bina'), user('Chirag')]);
    const game = await games.create(host, input({ maxPlayers: 3 }));
    await games.join(b!, game.id);
    await games.join(c!, game.id);

    expect(await codeOf(() => games.update(host, game.id, { maxPlayers: 2 }))).toBe(GameCode.INVALID_GAME);
    expect((await games.update(host, game.id, { maxPlayers: 4 })).status).toBe('open');
    expect((await games.update(host, game.id, { maxPlayers: 3 })).status).toBe('full');
  });
});

describe('games — coordination', () => {
  it('R8: the host’s number and the thread are for joined players only', async () => {
    const host = await user('Asha', '+91 98765 43210');
    const [b, c] = await Promise.all([user('Bina'), user('Chirag')]);
    const game = await games.create(host, input());
    await games.join(b!, game.id);

    const fresh = await games.byId(game.id);
    expect(await games.hostPhone(fresh, b!.userId)).toBe('+91 98765 43210');
    expect(await games.hostPhone(fresh, c!.userId)).toBeNull();
    expect(await games.hostPhone(fresh, null)).toBeNull();

    await games.addComment(b!, game.id, '  Running 10 minutes late  ');
    expect((await games.comments(host, game.id)).map((m) => m.body)).toEqual(['Running 10 minutes late']);
    expect(await games.comments(c!, game.id)).toEqual([]);
    expect(await codeOf(() => games.addComment(c!, game.id, 'Which court?'))).toBe('FORBIDDEN');
    expect(await codeOf(() => games.addComment(b!, game.id, '   '))).toBe(GameCode.INVALID_GAME);
  });

  it('R10: one reminder, an hour before the start, to the host and every player', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input());
    await games.join(b, game.id);

    expect((await games.sweep()).reminded).toBe(0);
    clock = new Date(game.startsAt.getTime() - 59 * MIN);
    expect((await games.sweep()).reminded).toBe(1);
    expect(sentTo('game.reminder').sort()).toEqual([host.userId, b.userId].sort());
    expect((await games.sweep()).reminded).toBe(0);
  });

  it('R10: moving the start time arms the reminder again', async () => {
    const host = await user('Asha');
    const game = await games.create(host, input());
    clock = new Date(game.startsAt.getTime() - 30 * MIN);
    expect((await games.sweep()).reminded).toBe(1);

    const later = new Date(game.startsAt.getTime() + 3 * HOUR);
    await games.update(host, game.id, { startsAt: later, endsAt: new Date(later.getTime() + HOUR) });
    expect((await games.sweep()).reminded).toBe(0);
    clock = new Date(later.getTime() - 30 * MIN);
    expect((await games.sweep()).reminded).toBe(1);
  });
});

describe('games — invites', () => {
  it('R11: the host invites; players already in, removed or unreachable are skipped', async () => {
    const host = await user('Asha');
    const [b, c, d, e] = await Promise.all([user('Bina'), user('Chirag'), user('Dev'), user('Esha')]);
    const game = await games.create(host, input({ maxPlayers: 8 }));
    await games.join(b!, game.id);
    await games.join(c!, game.id);
    await games.removePlayer(host, game.id, c!.userId);
    inactive.add(d!.userId); // deactivated account

    expect(await codeOf(() => games.invite(b!, game.id, [e!.userId]))).toBe('FORBIDDEN');
    const sent = await games.invite(host, game.id, [b!.userId, c!.userId, d!.userId, e!.userId, host.userId, newId()]);
    expect(sent.invited).toEqual([e!.userId]);
    expect(sentTo('game.invite')).toEqual([e!.userId]);
    expect(await games.isInvited(game.id, e!.userId)).toBe(true);
    // Asking twice does not notify twice.
    expect((await games.invite(host, game.id, [e!.userId])).invited).toEqual([]);

    // The invited game shows in their My Games; joining uses the invite up.
    expect((await games.listForUser(e!.userId)).map((g) => g.id)).toEqual([game.id]);
    await games.join(e!, game.id);
    expect(await games.isInvited(game.id, e!.userId)).toBe(false);
  });

  it('R11: players can be invited as the game is created', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input(), { inviteUserIds: [b.userId] });
    expect(await games.invitedUserIds(game.id)).toEqual([b.userId]);
    expect(notices.find((n) => n.template === 'game.invite')?.payload).toMatchObject({ hostName: 'Asha', placeName: 'Law Garden courts' });
  });

  it('invites: a phone number finds the account that gave it, and never the asker', async () => {
    const host = await user('Asha', '9000000001');
    const b = await user('Bina', '+91 98765 43210');
    expect(await games.lookupByPhone(host, '098765-43210')).toEqual({ userId: b.userId });
    expect(await games.lookupByPhone(host, '9111111111')).toBeNull();
    expect(await games.lookupByPhone(host, '12345')).toBeNull();
    expect(await games.lookupByPhone(host, '9000000001')).toBeNull();
  });
});

describe('games — discover and my games', () => {
  it('search: soonest first, filtered by sport, dates and distance', async () => {
    const host = await user('Asha');
    const otherSport = newId();
    await prisma.sport.create({ data: { id: otherSport, slug: 'badminton-test', name: 'Badminton' } });
    modules.sport.refresh();

    const base = input().startsAt;
    const near = await games.create(host, input());
    const far = await games.create(
      host,
      input({ location: { lat: 26.8467, lng: 80.9462 }, placeName: 'Gomti Nagar courts', city: 'Lucknow', startsAt: new Date(base.getTime() + 2 * HOUR), endsAt: new Date(base.getTime() + 3 * HOUR) }),
    );
    const nextWeek = await games.create(
      host,
      input({ sportId: otherSport, startsAt: new Date(base.getTime() + 7 * 24 * HOUR), endsAt: new Date(base.getTime() + 7 * 24 * HOUR + HOUR) }),
    );

    expect((await games.search({}, { first: 10 })).nodes.map((g) => g.id)).toEqual([near.id, far.id, nextWeek.id]);
    expect((await games.search({ sportId: otherSport }, { first: 10 })).nodes.map((g) => g.id)).toEqual([nextWeek.id]);
    expect((await games.search({ to: new Date(base.getTime() + 24 * HOUR) }, { first: 10 })).nodes.map((g) => g.id)).toEqual([near.id, far.id]);

    const around = await games.search({ near: PIN, radiusKm: 25 }, { first: 10 });
    expect(around.nodes.map((g) => g.id)).toEqual([near.id, nextWeek.id]);
    expect(around.nodes[0]!.distanceKm).toBeLessThan(1);
    expect(await codeOf(() => games.search({ near: PIN, radiusKm: 500 }, { first: 10 }))).toBe(GameCode.INVALID_GAME);

    // Paging on (starts_at, id).
    const first = await games.search({}, { first: 2 });
    expect(first.hasNextPage).toBe(true);
    const second = await games.search({}, { first: 2, after: first.endCursor });
    expect(second.nodes.map((g) => g.id)).toEqual([nextWeek.id]);
    expect(second.hasNextPage).toBe(false);
  });

  it('my games: hosted and joined games, and the next one for Home', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const base = input().startsAt;
    const soon = await games.create(host, input());
    const later = await games.create(host, input({ startsAt: new Date(base.getTime() + 48 * HOUR), endsAt: new Date(base.getTime() + 49 * HOUR) }));
    await games.join(b, later.id);

    expect((await games.listForUser(host.userId)).map((g) => g.id)).toEqual([later.id, soon.id]);
    expect((await games.listForUser(b.userId)).map((g) => g.id)).toEqual([later.id]);
    expect((await games.nextForUser(host.userId))?.id).toBe(soon.id);
    expect((await games.nextForUser(b.userId))?.id).toBe(later.id);

    await games.cancel(host, soon.id);
    expect((await games.nextForUser(host.userId))?.id).toBe(later.id);
  });
});

describe('games — results (unranked matches)', () => {
  /** A doubles game of four that started 90 minutes ago, so results are open. */
  async function played(over: Partial<GameInput> = {}) {
    const host = await user('Asha');
    const [b, c, d] = [await user('Bina'), await user('Chirag'), await user('Dev')];
    const game = await games.create(host, input({ maxPlayers: 4, ...over }));
    for (const p of [b, c, d]) await games.join(p, game.id);
    clock = new Date(game.startsAt.getTime() + 90 * MIN);
    notices.length = 0;
    return { game, host, b, c, d };
  }
  const doubles = (g: Awaited<ReturnType<typeof played>>, scores: { a: number; b: number }[]) => ({
    gameId: g.game.id,
    sideA: [g.host.userId, g.b.userId],
    sideB: [g.c.userId, g.d.userId],
    games: scores,
  });

  it('R12: results open an hour after the start and close a week after the end', async () => {
    const g = await played();
    const entry = doubles(g, [{ a: 11, b: 8 }]);

    clock = new Date(g.game.startsAt.getTime() + RESULTS_OPEN_AFTER_MS - MIN);
    expect(await results.canAdd(await games.byId(g.game.id), g.host.userId)).toBe(false);
    expect(await codeOf(() => results.add(g.host, entry))).toBe(ResultCode.RESULTS_NOT_OPEN);

    clock = new Date(g.game.startsAt.getTime() + RESULTS_OPEN_AFTER_MS);
    expect(await results.canAdd(await games.byId(g.game.id), g.host.userId)).toBe(true);
    expect((await results.add(g.host, entry)).status).toBe('pending');

    clock = new Date(g.game.endsAt.getTime() + 8 * 24 * HOUR);
    expect(await results.canAdd(await games.byId(g.game.id), g.host.userId)).toBe(false);
    expect(await codeOf(() => results.add(g.host, entry))).toBe(ResultCode.RESULTS_CLOSED);
  });

  it('R13: sides are joined players, nobody twice, and whoever enters it played in it', async () => {
    const g = await played();
    const outsider = await user('Esha');
    const ok = doubles(g, [{ a: 11, b: 8 }]);

    expect(await codeOf(() => results.add(g.host, { ...ok, sideB: [] }))).toBe(ResultCode.INVALID_RESULT);
    expect(await codeOf(() => results.add(g.host, { ...ok, sideB: [g.b.userId, g.c.userId] }))).toBe(ResultCode.INVALID_RESULT);
    expect(await codeOf(() => results.add(g.host, { ...ok, sideB: [g.c.userId, outsider.userId] }))).toBe(ResultCode.INVALID_RESULT);
    // Bina and Chirag played singles; the host cannot enter a match she was not in.
    expect(await codeOf(() => results.add(g.host, { ...ok, sideA: [g.b.userId], sideB: [g.c.userId] }))).toBe('FORBIDDEN');
    expect(await results.canAdd(await games.byId(g.game.id), outsider.userId)).toBe(false);
  });

  it('R14: each game is held to the sport\'s rule; the match may be short, or level', async () => {
    const g = await played();
    // Pickleball as seeded: games to 11, win by 2, and a deciding third game to 15. One game is a result.
    expect((await results.add(g.host, doubles(g, [{ a: 11, b: 8 }]))).winner).toBe('a');
    expect((await results.add(g.host, doubles(g, [{ a: 9, b: 11 }, { a: 13, b: 11 }, { a: 9, b: 15 }]))).winner).toBe('b');
    // One game each is a draw: nobody played a decider.
    expect((await results.add(g.host, doubles(g, [{ a: 11, b: 5 }, { a: 4, b: 11 }]))).winner).toBeNull();

    // Not a finished game, played on past the end, or a score that says the other side won.
    expect(await codeOf(() => results.add(g.host, doubles(g, [{ a: 9, b: 11 }, { a: 13, b: 11 }, { a: 7, b: 11 }])))).toBe(ResultCode.INVALID_RESULT); // the decider goes to 15
    expect(await codeOf(() => results.add(g.host, doubles(g, [{ a: 11, b: 10 }])))).toBe(ResultCode.INVALID_RESULT);
    expect(await codeOf(() => results.add(g.host, doubles(g, [{ a: 14, b: 8 }])))).toBe(ResultCode.INVALID_RESULT);
    expect(await codeOf(() => results.add(g.host, doubles(g, [{ a: 10, b: 10 }])))).toBe(ResultCode.INVALID_RESULT);
    expect(await codeOf(() => results.add(g.host, doubles(g, [])))).toBe(ResultCode.INVALID_RESULT);
    expect(await codeOf(() => results.add(g.host, { ...doubles(g, [{ a: 11, b: 8 }]), winner: 'b' }))).toBe(ResultCode.INVALID_RESULT);
  });

  it('R14: every sport is scored its own way — sets, goals, and no result for a race', async () => {
    const tennis = await seedSport(prisma, TENNIS);
    const football = await seedSport(prisma, FOOTBALL);
    const running = await seedSport(prisma, RUNNING);
    modules.sport.refresh();

    const t = await played({ sportId: tennis });
    expect((await results.add(t.host, doubles(t, [{ a: 6, b: 4 }, { a: 7, b: 6 }]))).winner).toBe('a');
    expect(await codeOf(() => results.add(t.host, doubles(t, [{ a: 6, b: 5 }])))).toBe(ResultCode.INVALID_RESULT);

    clock = new Date('2026-10-11T04:30:00.000Z');
    const f = await played({ sportId: football });
    expect((await results.add(f.host, doubles(f, [{ a: 3, b: 1 }]))).winner).toBe('a');
    expect((await results.add(f.host, doubles(f, [{ a: 2, b: 2 }]))).winner).toBeNull();

    clock = new Date('2026-10-11T04:30:00.000Z');
    const r = await played({ sportId: running });
    expect(await results.canAdd(await games.byId(r.game.id), r.host.userId)).toBe(false);
    expect(await codeOf(() => results.add(r.host, doubles(r, [{ a: 1, b: 0 }])))).toBe(ResultCode.RESULTS_NOT_SUPPORTED);
  });

  it('R15: the other side is asked, and confirms; the side that entered it cannot', async () => {
    const g = await played();
    const result = await results.add(g.host, doubles(g, [{ a: 11, b: 8 }, { a: 11, b: 6 }]));

    // Only the other side is told, with the score from their side.
    expect(sentTo('game.result_pending').sort()).toEqual([g.c.userId, g.d.userId].sort());
    expect(notices[0]!.payload).toMatchObject({ enteredByName: 'Asha', score: '8–11, 6–11', autoConfirmMinutes: 60 });
    expect(results.viewerCan(result, g.c.userId)).toEqual({ side: 'b', confirm: true, remove: false });
    expect(results.viewerCan(result, g.b.userId)).toEqual({ side: 'a', confirm: false, remove: false });
    expect(results.viewerCan(result, g.host.userId)).toEqual({ side: 'a', confirm: false, remove: true });

    expect(await codeOf(() => results.confirm(g.b, result.id))).toBe('FORBIDDEN');
    const confirmed = await results.confirm(g.d, result.id);
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedVia: 'opponent' });
    // Settled: it can no longer be disputed or taken back.
    expect(await codeOf(() => results.dispute(g.c, result.id))).toBe(ResultCode.RESULT_SETTLED);
    expect(await codeOf(() => results.remove(g.host, result.id))).toBe(ResultCode.RESULT_SETTLED);
  });

  it('R15: unanswered, a result confirms itself after an hour — read that way at once, written by the sweep', async () => {
    const g = await played();
    const result = await results.add(g.host, doubles(g, [{ a: 11, b: 8 }]));
    expect(await results.forUser(g.c.userId, { first: 10 })).toEqual([]);

    clock = new Date(clock.getTime() + RESULT_AUTO_CONFIRM_MS + MIN);
    expect((await results.forGame(g.game.id, null))[0]).toMatchObject({ id: result.id, status: 'confirmed', confirmedVia: 'auto' });
    expect((await prisma.gameResult.findUniqueOrThrow({ where: { id: result.id } })).status).toBe('pending');
    // Too late to say it is not right.
    expect(await codeOf(() => results.dispute(g.c, result.id))).toBe(ResultCode.RESULT_SETTLED);

    expect(await results.sweep()).toBe(1);
    expect((await prisma.gameResult.findUniqueOrThrow({ where: { id: result.id } })).confirmedVia).toBe('auto');
    expect(await results.sweep()).toBe(0);
  });

  it('R15, R16: "not right" tells whoever entered it, and the result counts for nothing', async () => {
    const g = await played();
    const result = await results.add(g.host, doubles(g, [{ a: 11, b: 0 }]));
    notices.length = 0;

    expect((await results.dispute(g.c, result.id)).status).toBe('disputed');
    expect(sentTo('game.result_disputed')).toEqual([g.host.userId]);
    expect(notices[0]!.payload).toMatchObject({ byName: 'Chirag', score: '11–0' });

    // Never confirmed by time, on nobody's profile, and hidden from everyone outside the match.
    clock = new Date(clock.getTime() + 3 * HOUR);
    expect(await results.sweep()).toBe(0);
    expect(await results.forUser(g.host.userId, { first: 10 })).toEqual([]);
    expect(await results.tallyFor(g.host.userId)).toEqual({ played: 0, won: 0, lost: 0, drawn: 0 });
    expect(await results.forGame(g.game.id, null)).toEqual([]);
    expect((await results.forGame(g.game.id, g.d.userId)).map((r) => r.status)).toEqual(['disputed']);
    // Whoever entered it can clear it away.
    await results.remove(g.host, result.id);
    expect(await prisma.gameResult.count()).toBe(0);
  });

  it('R16: a profile lists confirmed results only, with its own tally', async () => {
    const g = await played();
    const win = await results.add(g.host, doubles(g, [{ a: 11, b: 8 }]));
    const loss = await results.add(g.host, doubles(g, [{ a: 5, b: 11 }]));
    const draw = await results.add(g.c, doubles(g, [{ a: 11, b: 5 }, { a: 4, b: 11 }]));
    const waiting = await results.add(g.host, doubles(g, [{ a: 11, b: 9 }]));
    await results.confirm(g.c, win.id);
    await results.confirm(g.c, loss.id);
    await results.confirm(g.host, draw.id);

    expect((await results.forUser(g.host.userId, { first: 10 })).map((r) => r.id).sort()).toEqual([win.id, loss.id, draw.id].sort());
    expect(await results.tallyFor(g.host.userId)).toEqual({ played: 3, won: 1, lost: 1, drawn: 1 });
    // The same three, seen from the other side.
    expect(await results.tallyFor(g.d.userId)).toEqual({ played: 3, won: 1, lost: 1, drawn: 1 });
    // Before the hour is up, the fourth is for its players only.
    expect((await results.forGame(g.game.id, null)).map((r) => r.id)).not.toContain(waiting.id);
    expect((await results.forGame(g.game.id, g.b.userId)).map((r) => r.id)).toContain(waiting.id);
    // Ranked history is untouched.
    expect(await prisma.playerMatchHistory.count()).toBe(0);
  });

  it('R17: a confirmed result makes its players "played together"; an unanswered one does not', async () => {
    const g = await played();
    const result = await results.add(g.host, doubles(g, [{ a: 11, b: 8 }]));
    expect(await results.haveShared(g.host.userId, g.c.userId)).toBe(false);

    await results.confirm(g.c, result.id);
    expect(await results.haveShared(g.host.userId, g.c.userId)).toBe(true);
    expect(await results.haveShared(g.b.userId, g.host.userId)).toBe(true); // partners count too
    const stranger = await user('Esha');
    expect(await results.haveShared(g.host.userId, stranger.userId)).toBe(false);
  });

  it('a cancelled game has no results', async () => {
    const host = await user('Asha');
    const b = await user('Bina');
    const game = await games.create(host, input());
    await games.join(b, game.id);
    await games.cancel(host, game.id);
    clock = new Date(game.startsAt.getTime() + 2 * HOUR);
    expect(await results.canAdd(await games.byId(game.id), host.userId)).toBe(false);
    expect(
      await codeOf(() => results.add(host, { gameId: game.id, sideA: [host.userId], sideB: [b.userId], games: [{ a: 11, b: 8 }] })),
    ).toBe(ResultCode.RESULTS_CLOSED);
  });
});
