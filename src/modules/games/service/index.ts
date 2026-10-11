/**
 * games — casual games (docs/modules/12-games.md, "Create Game Flow v2").
 *
 * Someone needs a fourth on Saturday morning. No payment, no approval, no
 * rating: a game is created, people join until it is full, it is played, and
 * it completes by itself when its end time passes.
 *
 * Rules, as the tests name them:
 *   R1  the host is a player from the first moment; a game is never empty
 *   R2  capacity is a count under a row lock — no holds, nothing is paid for
 *   R3  open → full at the last place; full → open when a place comes back
 *   R4  the host cannot leave; cancelling is how a host walks away
 *   R5  a removed player cannot rejoin (removal is the only safety valve)
 *   R6  completed once the end time passes — read that way at once, written by the sweep
 *   R7  moving the time or the place tells every joined player
 *   R8  the host's contact and the thread are for joined players only
 *   R9  a game is at a listed venue or a pin — never free text alone
 *   R10 one reminder, an hour before the start
 *   R11 invites: the host only, and only to accounts that can be reached
 */
import type { Db, Tx } from '../../../platform/db.js';
import { UserError, forbidden } from '../../../platform/errors/index.js';
import { isValidPoint, radiusTooLarge, type GeoPoint } from '../../../platform/geo.js';
import { newId } from '../../../platform/ids.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
import type { GameRow, GamesRepo, StoredStatus } from '../repo/index.js';

export const GameCode = {
  GAME_NOT_FOUND: 'GAME_NOT_FOUND',
  INVALID_GAME: 'INVALID_GAME',
  GAME_FULL: 'GAME_FULL',
  GAME_CLOSED: 'GAME_CLOSED',
  GAME_REMOVED: 'GAME_REMOVED',
  ALREADY_JOINED: 'ALREADY_JOINED',
  NOT_IN_GAME: 'NOT_IN_GAME',
  HOST_CANNOT_LEAVE: 'HOST_CANNOT_LEAVE',
  TOO_MANY_GAMES: 'TOO_MANY_GAMES',
  INVITE_LIMIT: 'INVITE_LIMIT',
  COMMENT_LIMIT: 'COMMENT_LIMIT',
  LOOKUP_LIMIT: 'LOOKUP_LIMIT',
} as const;

export type GameStatus = StoredStatus;

export interface Game extends GameRow {
  status: GameStatus;
}

export interface Actor {
  userId: string;
}

export interface GameComment {
  id: string;
  gameId: string;
  userId: string;
  body: string;
  createdAt: Date;
}

export interface GameInput {
  sportId: string;
  venueId?: string | null;
  /** With `placeName`, when the game is not at a listed venue (R9). */
  location?: GeoPoint | null;
  placeName?: string | null;
  city?: string | null;
  startsAt: Date;
  endsAt: Date;
  maxPlayers: number;
  minPlayers?: number | null;
  skillBand?: string | null;
  notes?: string | null;
}

export type GamePatch = Partial<GameInput>;

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

type Template = 'game.invite' | 'game.player_joined' | 'game.full' | 'game.changed' | 'game.cancelled' | 'game.reminder';

export interface GamesDeps {
  db: Db;
  repo: GamesRepo;
  sport: {
    findById(sportId: string): Promise<{ id: string; name: string; active: boolean } | null>;
    hasSkillBand(sportId: string, key: string): Promise<boolean>;
  };
  venues: { findById(venueId: string): Promise<{ id: string; name: string; city: string } | null> };
  users: {
    namesByIds(ids: string[]): Promise<Map<string, string>>;
    /** identity R19 — deactivated, suspended or deleted accounts among these. */
    inactive(ids: string[]): Promise<Set<string>>;
    phoneOf(userId: string): Promise<string | null>;
    findByPhone(phone: string): Promise<{ id: string } | null>;
  };
  limiter: { consume(key: string, window: Window): Promise<LimitResult> };
  /** Best-effort: a notice that fails never fails the change it reports. */
  notify?(userIds: string[], template: Template, payload: Record<string, unknown>, gameId: string): Promise<void>;
  now?: () => Date;
}

export const MAX_PLAYERS = 64;
export const NOTES_MAX = 500;
export const PLACE_NAME_MAX = 80;
export const COMMENT_MAX = 500;
/** How far ahead a game may be set, and how long one may run. */
export const MAX_DAYS_AHEAD = 90;
export const MAX_HOURS = 12;
/** A host's open games at once: enough for a busy organiser, too few to flood Discover. */
export const MAX_OPEN_GAMES = 10;
export const MAX_INVITES_PER_CALL = 30;
export const INVITE_WINDOW: Window = { seconds: 86_400, max: 100 };
export const COMMENT_WINDOW: Window = { seconds: 60, max: 20 };
/** A phone number answers "is this person on PL4Y": slow enough that it cannot be swept. */
export const LOOKUP_WINDOW: Window = { seconds: 3600, max: 30 };
/** R10 — the reminder goes out this long before the start. */
export const REMINDER_MS = 60 * 60_000;
/** My Games keeps this much history. */
const HISTORY_MS = 90 * 86_400_000;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const notFound = () => new UserError(GameCode.GAME_NOT_FOUND, 'That game could not be found.');
const invalid = (message: string) => new UserError(GameCode.INVALID_GAME, message);
const closed = (message = 'This game is no longer open.') => new UserError(GameCode.GAME_CLOSED, message);

/** Cursor on (starts_at, id) — conventions.md §4. Opaque to the client. */
export const gameCursor = (g: { startsAt: Date; id: string }): string =>
  Buffer.from(`${g.startsAt.toISOString()}|${g.id}`).toString('base64url');

function decodeCursor(cursor: string): { startsAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const startsAt = new Date(at ?? '');
  return id && !Number.isNaN(startsAt.getTime()) ? { startsAt, id } : null;
}

/** R6 — the status a reader sees: a game past its end is completed whether or not the sweep has run. */
export function effectiveStatus(row: { status: StoredStatus; endsAt: Date }, at: Date): GameStatus {
  return (row.status === 'open' || row.status === 'full') && row.endsAt <= at ? 'completed' : row.status;
}

export function createGamesService(deps: GamesDeps) {
  const { db, repo } = deps;
  const now = deps.now ?? (() => new Date());

  const live = (row: GameRow): Game => ({ ...row, status: effectiveStatus(row, now()) });

  async function tell(userIds: string[], template: Template, payload: Record<string, unknown>, gameId: string): Promise<void> {
    if (!deps.notify || userIds.length === 0) return;
    await deps.notify([...new Set(userIds)], template, payload, gameId).catch(() => undefined);
  }

  /** What every notice says about a game: the sport, the place and the start. */
  async function facts(game: GameRow): Promise<{ sportName: string; placeName: string; startsAt: string }> {
    const [sport, venue] = await Promise.all([
      deps.sport.findById(game.sportId),
      game.venueId ? deps.venues.findById(game.venueId) : null,
    ]);
    return {
      sportName: sport?.name ?? 'Game',
      placeName: venue?.name ?? game.placeName ?? game.city,
      startsAt: game.startsAt.toISOString(),
    };
  }

  // --- validation --------------------------------------------------------------

  interface Checked {
    sportId: string;
    venueId: string | null;
    placeName: string | null;
    city: string;
    location: GeoPoint | null;
    startsAt: Date;
    endsAt: Date;
    maxPlayers: number;
    minPlayers: number | null;
    skillBand: string | null;
    notes: string | null;
  }

  async function check(input: GameInput, opts: { timeChanged: boolean }): Promise<Checked> {
    const sport = await deps.sport.findById(input.sportId);
    if (!sport || !sport.active) throw invalid('Choose a sport.');

    // R9 — a listed venue, or a pin with a name for it.
    let venueId: string | null = null;
    let placeName: string | null = null;
    let city = (input.city ?? '').trim();
    let location: GeoPoint | null = null;
    if (input.venueId) {
      const venue = await deps.venues.findById(input.venueId);
      if (!venue) throw invalid('Choose a venue from the list.');
      venueId = venue.id;
      city = venue.city;
    } else {
      placeName = (input.placeName ?? '').trim();
      if (!input.location || !isValidPoint(input.location)) throw invalid('Choose a venue, or drop a pin on the map.');
      if (placeName.length < 2 || placeName.length > PLACE_NAME_MAX) {
        throw invalid(`Give the place a name, up to ${PLACE_NAME_MAX} characters.`);
      }
      location = input.location;
    }

    const { startsAt, endsAt } = input;
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw invalid('Choose a start and an end time.');
    if (endsAt <= startsAt) throw invalid('The end time must be after the start time.');
    if (endsAt.getTime() - startsAt.getTime() > MAX_HOURS * HOUR) throw invalid(`A game can run for up to ${MAX_HOURS} hours.`);
    if (opts.timeChanged) {
      if (startsAt <= now()) throw invalid('Choose a start time in the future.');
      if (startsAt.getTime() - now().getTime() > MAX_DAYS_AHEAD * DAY) {
        throw invalid(`A game can be set up to ${MAX_DAYS_AHEAD} days ahead.`);
      }
    }

    const maxPlayers = Math.trunc(input.maxPlayers);
    if (!(maxPlayers >= 2 && maxPlayers <= MAX_PLAYERS)) throw invalid(`A game takes 2 to ${MAX_PLAYERS} players.`);
    const minPlayers = input.minPlayers == null ? null : Math.trunc(input.minPlayers);
    if (minPlayers !== null && !(minPlayers >= 2 && minPlayers <= maxPlayers)) {
      throw invalid('The minimum is 2 or more, and no more than the maximum.');
    }

    const skillBand = input.skillBand?.trim() || null;
    if (skillBand && !(await deps.sport.hasSkillBand(sport.id, skillBand))) throw invalid('Choose a skill level from the list.');
    const notes = input.notes?.trim() || null;
    if (notes && notes.length > NOTES_MAX) throw invalid(`Notes can be up to ${NOTES_MAX} characters.`);

    return { sportId: sport.id, venueId, placeName, city, location, startsAt, endsAt, maxPlayers, minPlayers, skillBand, notes };
  }

  // --- reads -------------------------------------------------------------------

  async function findById(gameId: string): Promise<Game | null> {
    const row = await repo.findById(gameId);
    return row ? live(row) : null;
  }

  async function byId(gameId: string): Promise<Game> {
    const game = await findById(gameId);
    if (!game) throw notFound();
    return game;
  }

  /** Discover Games. `to` is exclusive; a map centre needs a radius of 50 km or less. */
  async function search(
    filter: { sportId?: string | null; from?: Date | null; to?: Date | null; near?: GeoPoint | null; radiusKm?: number | null; viewerUserId?: string | null },
    page: { first: number; after?: string | null },
  ): Promise<Page<Game>> {
    const first = Math.min(Math.max(page.first, 1), 50);
    const near = filter.near && isValidPoint(filter.near) ? filter.near : null;
    if (near && radiusTooLarge(filter.radiusKm ?? 0)) throw invalid('Choose a distance of up to 50 km.');
    const at = now();
    // A day that has already started still lists its games that have not ended.
    const from = filter.from && filter.from > at ? filter.from : at;
    const rows = await repo.search({
      sportId: filter.sportId ?? null,
      from,
      to: filter.to ?? null,
      near,
      radiusKm: near ? filter.radiusKm : null,
      viewerUserId: filter.viewerUserId ?? null,
      after: page.after ? decodeCursor(page.after) : null,
      limit: first + 1,
    });
    const nodes = rows.slice(0, first).map(live);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > first, endCursor: last ? gameCursor(last) : null };
  }

  /** My Games: hosted, joined and invited, newest start first. The client groups them. */
  async function listForUser(userId: string): Promise<Game[]> {
    const ids = await repo.idsForUser(userId, new Date(now().getTime() - HISTORY_MS));
    return (await repo.byIds(ids)).map(live);
  }

  /** Home's "Next up": the viewer's next game that has not ended. */
  async function nextForUser(userId: string): Promise<Game | null> {
    const at = now();
    const mine = (await listForUser(userId))
      .filter((g) => (g.status === 'open' || g.status === 'full') && g.endsAt > at && g.playerUserIds.includes(userId))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return mine[0] ?? null;
  }

  async function invitedUserIds(gameId: string): Promise<string[]> {
    const rows = await db.gameInvite.findMany({ where: { gameId }, orderBy: { createdAt: 'asc' }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  async function isInvited(gameId: string, userId: string): Promise<boolean> {
    return (await db.gameInvite.count({ where: { gameId, userId } })) > 0;
  }

  /** R8 — the host's number, for joined players only. Null when the host gave none. */
  async function hostPhone(game: Game, viewerUserId: string | null): Promise<string | null> {
    if (!viewerUserId || viewerUserId === game.hostUserId || !game.playerUserIds.includes(viewerUserId)) return null;
    return deps.users.phoneOf(game.hostUserId);
  }

  // --- create and edit ---------------------------------------------------------

  async function create(actor: Actor, input: GameInput, opts: { inviteUserIds?: string[] } = {}): Promise<Game> {
    const checked = await check(input, { timeChanged: true });
    const open = await db.game.count({
      where: { hostUserId: actor.userId, status: { in: ['open', 'full'] }, endsAt: { gt: now() } },
    });
    if (open >= MAX_OPEN_GAMES) {
      throw new UserError(GameCode.TOO_MANY_GAMES, `You can host up to ${MAX_OPEN_GAMES} games at a time. Cancel or finish one first.`);
    }
    const id = newId();
    await db.$transaction((tx) => repo.insert(tx, { id, hostUserId: actor.userId, ...checked }));
    if (opts.inviteUserIds && opts.inviteUserIds.length > 0) {
      // The game exists either way: an invite that cannot be sent never undoes it.
      await invite(actor, id, opts.inviteUserIds).catch(() => undefined);
    }
    return byId(id);
  }

  async function hostGame(actor: Actor, gameId: string): Promise<Game> {
    const game = await byId(gameId);
    if (game.hostUserId !== actor.userId) throw forbidden();
    return game;
  }

  /** R7 — the host edits. A new time or place is told to every joined player. */
  async function update(actor: Actor, gameId: string, patch: GamePatch): Promise<Game> {
    const before = await hostGame(actor, gameId);
    if (before.status !== 'open' && before.status !== 'full') throw closed('A finished or cancelled game cannot be edited.');

    // A patch that names a pin clears the venue, and the other way round.
    const placeGiven = patch.venueId !== undefined || patch.location !== undefined || patch.placeName !== undefined;
    const merged: GameInput = {
      sportId: patch.sportId ?? before.sportId,
      venueId: placeGiven ? (patch.venueId ?? null) : before.venueId,
      location: placeGiven ? (patch.venueId ? null : (patch.location ?? before.location)) : before.location,
      placeName: placeGiven ? (patch.venueId ? null : (patch.placeName ?? before.placeName)) : before.placeName,
      city: patch.city ?? before.city,
      startsAt: patch.startsAt ?? before.startsAt,
      endsAt: patch.endsAt ?? before.endsAt,
      maxPlayers: patch.maxPlayers ?? before.maxPlayers,
      minPlayers: patch.minPlayers === undefined ? before.minPlayers : patch.minPlayers,
      skillBand: patch.skillBand === undefined ? before.skillBand : patch.skillBand,
      notes: patch.notes === undefined ? before.notes : patch.notes,
    };
    const timeChanged =
      merged.startsAt.getTime() !== before.startsAt.getTime() || merged.endsAt.getTime() !== before.endsAt.getTime();
    const checked = await check(merged, { timeChanged });
    const placeChanged =
      checked.venueId !== before.venueId ||
      checked.placeName !== before.placeName ||
      checked.location?.lat !== before.location?.lat ||
      checked.location?.lng !== before.location?.lng;

    await db.$transaction(async (tx) => {
      const locked = await repo.lock(tx, gameId);
      if (!locked || (locked.status !== 'open' && locked.status !== 'full')) throw closed();
      const joined = await tx.gameParticipant.count({ where: { gameId, status: 'joined' } });
      if (checked.maxPlayers < joined) {
        throw invalid(`${joined} players have joined. Remove a player before lowering the maximum below that.`);
      }
      await tx.game.update({
        where: { id: gameId },
        data: {
          sportId: checked.sportId,
          startsAt: checked.startsAt,
          endsAt: checked.endsAt,
          maxPlayers: checked.maxPlayers,
          minPlayers: checked.minPlayers,
          skillBand: checked.skillBand,
          notes: checked.notes,
          // R3 — a raised or lowered maximum can open or fill the game.
          status: joined >= checked.maxPlayers ? 'full' : 'open',
          // R10 — a moved start is reminded about afresh.
          ...(timeChanged ? { reminderSentAt: null } : {}),
          updatedAt: now(),
        },
      });
      if (placeChanged) await repo.setPlace(tx, gameId, checked);
    });

    const after = await byId(gameId);
    if (timeChanged || placeChanged) {
      await tell(
        after.playerUserIds.filter((u) => u !== actor.userId),
        'game.changed',
        { ...(await facts(after)), timeChanged, placeChanged },
        gameId,
      );
    }
    return after;
  }

  // --- join, leave, remove ------------------------------------------------------

  /** R2, R3, R5 — automatic while a place is free. No approval. */
  async function join(actor: Actor, gameId: string): Promise<Game> {
    const filled = await db.$transaction(async (tx) => {
      const locked = await repo.lock(tx, gameId);
      if (!locked) throw notFound();
      const status = effectiveStatus(locked, now());
      if (status === 'cancelled' || status === 'completed') throw closed();

      const mine = await tx.gameParticipant.findUnique({ where: { gameId_userId: { gameId, userId: actor.userId } } });
      if (mine?.status === 'joined') throw new UserError(GameCode.ALREADY_JOINED, 'You are already in this game.');
      if (mine?.status === 'removed') throw new UserError(GameCode.GAME_REMOVED, 'The host removed you from this game.');

      const joined = await tx.gameParticipant.count({ where: { gameId, status: 'joined' } });
      if (joined >= locked.maxPlayers) throw new UserError(GameCode.GAME_FULL, 'This game is full.');

      await tx.gameParticipant.upsert({
        where: { gameId_userId: { gameId, userId: actor.userId } },
        create: { gameId, userId: actor.userId },
        update: { status: 'joined', joinedAt: now(), updatedAt: now() },
      });
      await tx.gameInvite.deleteMany({ where: { gameId, userId: actor.userId } });
      const full = joined + 1 >= locked.maxPlayers;
      if (full) await tx.game.update({ where: { id: gameId }, data: { status: 'full', updatedAt: now() } });
      return full;
    });

    const game = await byId(gameId);
    const about = await facts(game);
    const names = await deps.users.namesByIds([actor.userId]);
    await tell(
      [game.hostUserId],
      'game.player_joined',
      { ...about, playerName: names.get(actor.userId) ?? 'A player', joined: game.playerUserIds.length, maxPlayers: game.maxPlayers },
      gameId,
    );
    if (filled) await tell(game.playerUserIds, 'game.full', about, gameId);
    return game;
  }

  /** One place comes back; a full game is open again (R3). */
  async function vacate(tx: Tx, gameId: string, userId: string, to: 'left' | 'removed'): Promise<void> {
    const locked = await repo.lock(tx, gameId);
    if (!locked) throw notFound();
    const status = effectiveStatus(locked, now());
    if (status === 'cancelled' || status === 'completed') throw closed();
    const moved = await tx.gameParticipant.updateMany({
      where: { gameId, userId, status: 'joined' },
      data: { status: to, updatedAt: now() },
    });
    if (moved.count === 0) throw new UserError(GameCode.NOT_IN_GAME, 'That player is not in this game.');
    if (locked.status === 'full') await tx.game.update({ where: { id: gameId }, data: { status: 'open', updatedAt: now() } });
  }

  async function leave(actor: Actor, gameId: string): Promise<Game> {
    const game = await byId(gameId);
    // R4 — a game without its host has nobody to run it.
    if (game.hostUserId === actor.userId) {
      throw new UserError(GameCode.HOST_CANNOT_LEAVE, 'You are hosting this game. Cancel it if you cannot play.');
    }
    await db.$transaction((tx) => vacate(tx, gameId, actor.userId, 'left'));
    return byId(gameId);
  }

  /** R5 — the host's safety valve. The removed player cannot rejoin. */
  async function removePlayer(actor: Actor, gameId: string, userId: string): Promise<Game> {
    await hostGame(actor, gameId);
    if (userId === actor.userId) throw new UserError(GameCode.HOST_CANNOT_LEAVE, 'You are hosting this game. Cancel it if you cannot play.');
    await db.$transaction((tx) => vacate(tx, gameId, userId, 'removed'));
    return byId(gameId);
  }

  // --- cancel and complete ------------------------------------------------------

  async function cancel(actor: Actor, gameId: string, reason?: string | null): Promise<Game> {
    const game = await hostGame(actor, gameId);
    if (game.status === 'cancelled') return game;
    if (game.status === 'completed') throw closed('This game has already been played.');
    const why = reason?.trim().slice(0, 200) || null;
    await db.game.updateMany({
      where: { id: gameId, status: { in: ['open', 'full'] } },
      data: { status: 'cancelled', cancelReason: why, cancelledAt: now(), updatedAt: now() },
    });
    await tell(
      game.playerUserIds.filter((u) => u !== actor.userId),
      'game.cancelled',
      { ...(await facts(game)), reason: why },
      gameId,
    );
    return byId(gameId);
  }

  /** The optional manual button: the host marks it done once it has started. */
  async function complete(actor: Actor, gameId: string): Promise<Game> {
    const game = await hostGame(actor, gameId);
    if (game.status === 'completed') return game;
    if (game.status === 'cancelled') throw closed();
    if (game.startsAt > now()) throw invalid('A game can be marked as played once it has started.');
    await db.game.updateMany({
      where: { id: gameId, status: { in: ['open', 'full'] } },
      data: { status: 'completed', completedAt: now(), updatedAt: now() },
    });
    return byId(gameId);
  }

  // --- invites (R11) ------------------------------------------------------------

  async function invite(actor: Actor, gameId: string, userIds: string[]): Promise<{ invited: string[] }> {
    const game = await hostGame(actor, gameId);
    if (game.status !== 'open' && game.status !== 'full') throw closed();
    const asked = [...new Set(userIds)].filter((u) => u !== actor.userId).slice(0, MAX_INVITES_PER_CALL);
    if (asked.length === 0) return { invited: [] };

    const [inactive, known] = await Promise.all([
      deps.users.inactive(asked),
      db.gameParticipant.findMany({ where: { gameId, userId: { in: asked } }, select: { userId: true, status: true } }),
    ]);
    // Not someone already in, and not someone the host removed.
    const skip = new Set(known.filter((k) => k.status !== 'left').map((k) => k.userId));
    const already = new Set((await db.gameInvite.findMany({ where: { gameId, userId: { in: asked } }, select: { userId: true } })).map((i) => i.userId));
    const names = await deps.users.namesByIds([actor.userId, ...asked]);
    // An id that is nobody's is dropped rather than failing the whole batch on a foreign key.
    const fresh = asked.filter((u) => names.has(u) && !inactive.has(u) && !skip.has(u) && !already.has(u));
    if (fresh.length === 0) return { invited: [] };

    for (let i = 0; i < fresh.length; i += 1) {
      const limit = await deps.limiter.consume(`games:invite:${actor.userId}`, INVITE_WINDOW);
      if (!limit.allowed) {
        if (i === 0) {
          throw new UserError(GameCode.INVITE_LIMIT, 'You have sent a lot of invites today. Try again tomorrow.', {
            retryAfterSeconds: limit.retryAfterSeconds,
          });
        }
        fresh.length = i;
        break;
      }
    }
    await db.gameInvite.createMany({
      data: fresh.map((userId) => ({ gameId, userId, invitedBy: actor.userId })),
      skipDuplicates: true,
    });
    await tell(fresh, 'game.invite', { ...(await facts(game)), hostName: names.get(actor.userId) ?? 'A player' }, gameId);
    return { invited: fresh };
  }

  /**
   * "Is this number on PL4Y?" — for the invite screen. Answers with the account
   * or nothing; rate limited, because a phone number is otherwise an oracle.
   */
  async function lookupByPhone(actor: Actor, phone: string): Promise<{ userId: string } | null> {
    if (phone.replace(/\D/g, '').length < 10) return null;
    const limit = await deps.limiter.consume(`games:lookup:${actor.userId}`, LOOKUP_WINDOW);
    if (!limit.allowed) {
      throw new UserError(GameCode.LOOKUP_LIMIT, 'Too many searches. Try again later.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const found = await deps.users.findByPhone(phone);
    return found && found.id !== actor.userId ? { userId: found.id } : null;
  }

  // --- the thread (R8) ----------------------------------------------------------

  async function comments(actor: Actor | null, gameId: string): Promise<GameComment[]> {
    if (!actor) return [];
    const game = await findById(gameId);
    if (!game || !game.playerUserIds.includes(actor.userId)) return [];
    return db.gameComment.findMany({ where: { gameId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 200 });
  }

  async function addComment(actor: Actor, gameId: string, body: string): Promise<GameComment> {
    const text = body.trim();
    if (text.length < 1 || text.length > COMMENT_MAX) throw invalid(`A message is 1 to ${COMMENT_MAX} characters.`);
    const game = await byId(gameId);
    if (!game.playerUserIds.includes(actor.userId)) throw forbidden();
    if (game.status === 'cancelled') throw closed();
    const limit = await deps.limiter.consume(`games:comment:${actor.userId}`, COMMENT_WINDOW);
    if (!limit.allowed) {
      throw new UserError(GameCode.COMMENT_LIMIT, 'You’re sending messages too quickly.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    return db.gameComment.create({ data: { id: newId(), gameId, userId: actor.userId, body: text } });
  }

  // --- the sweep (R6, R10) ------------------------------------------------------

  /** Every minute. Idempotent: each reminder is claimed by its own UPDATE before it is sent. */
  async function sweep(): Promise<{ completed: number; reminded: number }> {
    const at = now();
    const { count: completed } = await db.game.updateMany({
      where: { status: { in: ['open', 'full'] }, endsAt: { lte: at } },
      data: { status: 'completed', completedAt: at, updatedAt: at },
    });

    const due = await db.game.findMany({
      where: {
        status: { in: ['open', 'full'] },
        reminderSentAt: null,
        startsAt: { gt: at, lte: new Date(at.getTime() + REMINDER_MS) },
      },
      select: { id: true },
      take: 200,
    });
    let reminded = 0;
    for (const { id } of due) {
      const claimed = await db.game.updateMany({ where: { id, reminderSentAt: null }, data: { reminderSentAt: at } });
      if (claimed.count === 0) continue;
      const game = await repo.findById(id);
      if (!game) continue;
      await tell(game.playerUserIds, 'game.reminder', await facts(game), id);
      reminded += 1;
    }
    return { completed, reminded };
  }

  return {
    findById,
    byId,
    search,
    listForUser,
    nextForUser,
    invitedUserIds,
    isInvited,
    hostPhone,
    create,
    update,
    join,
    leave,
    removePlayer,
    cancel,
    complete,
    invite,
    lookupByPhone,
    comments,
    addComment,
    sweep,
  };
}

export type GamesService = ReturnType<typeof createGamesService>;
