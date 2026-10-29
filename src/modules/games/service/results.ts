/**
 * games — results of casual games.
 *
 * One game holds many results, because one session is often several matches.
 * A result names who was on each side and the score, held one game (or set,
 * or frame) at a time to the format the players chose (R18) over the sport's
 * own rule. Every match is ranked: once confirmed, a result moves ratings and
 * rankings and joins match history and analytics like a tournament match.
 *
 * Rules, as the tests name them:
 *   R12 results open an hour after the game starts, and close a week after it ends
 *   R13 only someone who played in the match enters it, and only joined players are on a side
 *   R14 the score is held to the sport's rule; a casual match may be short, or level
 *   R15 the other side confirms or says "not right"; unanswered, it confirms itself after an hour
 *   R16 a profile shows confirmed results only; a disputed one counts for nothing
 *   R17 a confirmed result makes its players "played together" (chat R2)
 *   R18 the score is held to the match's format: the result's own, else the game's, else the sport's
 *   R19 a confirmed result is ranked: rating, rankings, match history, analytics (onConfirmed)
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import { UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import type { Game, MatchFormat } from './index.js';

export const ResultCode = {
  RESULT_NOT_FOUND: 'RESULT_NOT_FOUND',
  RESULTS_NOT_OPEN: 'RESULTS_NOT_OPEN',
  RESULTS_CLOSED: 'RESULTS_CLOSED',
  RESULTS_NOT_SUPPORTED: 'RESULTS_NOT_SUPPORTED',
  INVALID_RESULT: 'INVALID_RESULT',
  RESULT_SETTLED: 'RESULT_SETTLED',
  TOO_MANY_RESULTS: 'TOO_MANY_RESULTS',
} as const;

/** R12 — a game is not over the moment it starts. */
export const RESULTS_OPEN_AFTER_MS = 60 * 60_000;
export const RESULTS_CLOSE_AFTER_MS = 7 * 86_400_000;
/** R15 — how long the other side has before silence counts as agreement. */
export const RESULT_AUTO_CONFIRM_MS = 60 * 60_000;
/** Far more matches than one session holds; enough to stop a loop filling a profile. */
export const MAX_RESULTS_PER_GAME = 40;

export type Side = 'a' | 'b';
export type ResultStatus = 'pending' | 'confirmed' | 'disputed';

export interface UnitScore {
  a: number;
  b: number;
}

export interface GameResult {
  id: string;
  gameId: string;
  sportId: string;
  /** User ids. */
  sideA: string[];
  sideB: string[];
  games: UnitScore[];
  /** Null is a draw. */
  winner: Side | null;
  method: string | null;
  status: ResultStatus;
  enteredBy: string;
  autoConfirmAt: Date;
  confirmedAt: Date | null;
  confirmedVia: string | null;
  playedAt: Date;
  createdAt: Date;
  /** R18 — the format it was entered under; null = the game's or the sport's usual. */
  matchFormat: MatchFormat | null;
}

export interface Tally {
  played: number;
  won: number;
  lost: number;
  drawn: number;
}

export interface Actor {
  userId: string;
}

export interface ResultInput {
  gameId: string;
  sideA: string[];
  sideB: string[];
  games: UnitScore[];
  /** A bout that ended early: one of the rule's finishes, with `winner`. */
  finish?: string | null;
  winner?: Side | null;
  /** R18 — this match's own format, when it differs from the game's. */
  format?: MatchFormat | null;
}

type Template = 'game.result_pending' | 'game.result_disputed';

export interface ResultsDeps {
  db: Db;
  games: { byId(gameId: string): Promise<Game> };
  /**
   * R14 — the sport's rule decides. `supported` is false for a sport scored in
   * heats (a race, a scorecard); `judge` returns the winner the score implies
   * (null for a draw) or throws a UserError saying why it is not a score.
   */
  rules: {
    supported(sportId: string): Promise<boolean>;
    judge(sportId: string, games: UnitScore[], format: MatchFormat | null): Promise<Side | null>;
    finishes(sportId: string): Promise<string[]>;
    /** R18 — the format held to the sport's rule, or a UserError; null when the sport has none to choose. */
    checkFormat(sportId: string, format: MatchFormat): Promise<MatchFormat | null>;
  };
  users: { namesByIds(ids: string[]): Promise<Map<string, string>> };
  sportName(sportId: string): Promise<string>;
  notify?(userIds: string[], template: Template, payload: Record<string, unknown>, gameId: string): Promise<void>;
  now?: () => Date;
}

type Row = Prisma.GameResultGetPayload<object>;

const notFound = () => new UserError(ResultCode.RESULT_NOT_FOUND, 'That result could not be found.');
const invalid = (message: string) => new UserError(ResultCode.INVALID_RESULT, message);
const settled = () => new UserError(ResultCode.RESULT_SETTLED, 'This result has already been answered.');

const scoreline = (games: UnitScore[]): string => games.map((g) => `${g.a}–${g.b}`).join(', ');

export function createGameResults(deps: ResultsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** R15 — pending past its hour reads as confirmed, whether or not the sweep has run. */
  const live = (r: Row): GameResult => {
    const auto = r.status === 'pending' && r.autoConfirmAt <= now();
    return {
      id: r.id,
      gameId: r.gameId,
      sportId: r.sportId,
      sideA: r.sideA,
      sideB: r.sideB,
      games: r.games as unknown as UnitScore[],
      winner: (r.winner as Side | null) ?? null,
      method: r.method,
      status: auto ? 'confirmed' : (r.status as ResultStatus),
      enteredBy: r.enteredBy,
      autoConfirmAt: r.autoConfirmAt,
      confirmedAt: auto ? r.autoConfirmAt : r.confirmedAt,
      confirmedVia: auto ? 'auto' : r.confirmedVia,
      playedAt: r.playedAt,
      createdAt: r.createdAt,
      matchFormat: (r.matchFormat as unknown as MatchFormat | null) ?? null,
    };
  };

  /** R19 — in the confirming transaction: the worker rates it and adds it to match history. */
  async function announce(tx: Tx, resultIds: string[]): Promise<void> {
    for (const resultId of resultIds) {
      await outboxWrite(tx, { topic: 'game_result.confirmed', payload: { resultId } });
    }
  }

  const inMatch = (r: { sideA: string[]; sideB: string[] }, userId: string): Side | null =>
    r.sideA.includes(userId) ? 'a' : r.sideB.includes(userId) ? 'b' : null;

  async function tell(userIds: string[], template: Template, payload: Record<string, unknown>, gameId: string): Promise<void> {
    if (!deps.notify || userIds.length === 0) return;
    await deps.notify([...new Set(userIds)], template, payload, gameId).catch(() => undefined);
  }

  // --- when and whether -------------------------------------------------------

  /** R12 — the window results may be entered in. */
  function windowOf(game: Pick<Game, 'startsAt' | 'endsAt'>): { opensAt: Date; closesAt: Date } {
    return {
      opensAt: new Date(game.startsAt.getTime() + RESULTS_OPEN_AFTER_MS),
      closesAt: new Date(game.endsAt.getTime() + RESULTS_CLOSE_AFTER_MS),
    };
  }

  /** Whether this viewer could add a result to this game right now (the button's own rule). */
  async function canAdd(game: Game, viewerUserId: string | null): Promise<boolean> {
    if (!viewerUserId || game.status === 'cancelled' || !game.playerUserIds.includes(viewerUserId)) return false;
    if (game.playerUserIds.length < 2) return false;
    const { opensAt, closesAt } = windowOf(game);
    const at = now();
    return at >= opensAt && at <= closesAt && (await deps.rules.supported(game.sportId));
  }

  // --- enter --------------------------------------------------------------------

  async function add(actor: Actor, input: ResultInput): Promise<GameResult> {
    const game = await deps.games.byId(input.gameId);
    if (game.status === 'cancelled') {
      throw new UserError(ResultCode.RESULTS_CLOSED, 'This game was cancelled, so it has no results.');
    }
    const { opensAt, closesAt } = windowOf(game);
    if (now() < opensAt) {
      throw new UserError(ResultCode.RESULTS_NOT_OPEN, 'Results open an hour after the game starts.');
    }
    if (now() > closesAt) {
      throw new UserError(ResultCode.RESULTS_CLOSED, 'Results for this game closed a week after it ended.');
    }
    if (!(await deps.rules.supported(game.sportId))) {
      throw new UserError(ResultCode.RESULTS_NOT_SUPPORTED, 'Results for this sport are not recorded as matches yet.');
    }

    // R13 — sides are joined players, nobody twice, and the person entering it played in it.
    const sideA = [...new Set(input.sideA)];
    const sideB = [...new Set(input.sideB)];
    if (sideA.length === 0 || sideB.length === 0) throw invalid('Choose who was on each side.');
    if (sideA.some((u) => sideB.includes(u))) throw invalid('A player cannot be on both sides.');
    const joined = new Set(game.playerUserIds);
    if (![...sideA, ...sideB].every((u) => joined.has(u))) throw invalid('Only players who joined this game can be in a result.');
    if (!sideA.includes(actor.userId) && !sideB.includes(actor.userId)) throw forbidden();

    // R18 — the match's format: its own, else the game's, else the sport's usual.
    const format = input.format ? await deps.rules.checkFormat(game.sportId, input.format) : (game.matchFormat ?? null);

    // R14 — the sport's own rule.
    let winner: Side | null;
    let method: string | null = null;
    const finish = input.finish?.trim() || null;
    if (finish) {
      if (!(await deps.rules.finishes(game.sportId)).includes(finish)) throw invalid('This sport does not end that way.');
      if (!input.winner) throw invalid('Say which side won.');
      if (input.games.some((g) => !Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0)) {
        throw invalid('Scores are whole numbers, never negative.');
      }
      winner = input.winner;
      method = finish;
    } else {
      winner = await deps.rules.judge(game.sportId, input.games, format);
      if (input.winner && input.winner !== winner) {
        throw invalid(winner ? 'The score says the other side won.' : 'The score is level: a draw.');
      }
    }

    const existing = await db.gameResult.count({ where: { gameId: game.id } });
    if (existing >= MAX_RESULTS_PER_GAME) {
      throw new UserError(ResultCode.TOO_MANY_RESULTS, 'This game already has a lot of results.');
    }

    const at = now();
    const row = await db.gameResult.create({
      data: {
        id: newId(),
        gameId: game.id,
        sportId: game.sportId,
        sideA,
        sideB,
        games: input.games.map((g) => ({ a: g.a, b: g.b })) as unknown as Prisma.InputJsonValue,
        winner,
        method,
        enteredBy: actor.userId,
        autoConfirmAt: new Date(at.getTime() + RESULT_AUTO_CONFIRM_MS),
        playedAt: game.startsAt,
        ...(input.format && format ? { matchFormat: format as unknown as Prisma.InputJsonValue } : {}),
      },
    });

    // R15 — the other side is asked. One notice; no reminder.
    const mine = inMatch(row, actor.userId)!;
    const [names, sportName] = await Promise.all([deps.users.namesByIds([actor.userId]), deps.sportName(game.sportId)]);
    await tell(
      mine === 'a' ? sideB : sideA,
      'game.result_pending',
      {
        enteredByName: names.get(actor.userId) ?? 'A player',
        sportName,
        // From the reader's side: their own score first.
        score: scoreline(input.games.map((g) => (mine === 'a' ? { a: g.b, b: g.a } : g))),
        autoConfirmMinutes: Math.round(RESULT_AUTO_CONFIRM_MS / 60_000),
      },
      game.id,
    );
    return live(row);
  }

  // --- answer (R15) ---------------------------------------------------------------

  /** The row, and proof the actor is on the side that did not enter it. */
  async function forAnswer(actor: Actor, resultId: string): Promise<Row> {
    const row = await db.gameResult.findUnique({ where: { id: resultId } });
    if (!row) throw notFound();
    const side = inMatch(row, actor.userId);
    const entrantSide = inMatch(row, row.enteredBy);
    if (!side || side === entrantSide) throw forbidden();
    return row;
  }

  async function confirm(actor: Actor, resultId: string): Promise<GameResult> {
    const row = await forAnswer(actor, resultId);
    if (live(row).status === 'confirmed') return live(row);
    const moved = await db.$transaction(async (tx) => {
      const m = await tx.gameResult.updateMany({
        where: { id: resultId, status: 'pending' },
        data: { status: 'confirmed', confirmedAt: now(), confirmedVia: 'opponent' },
      });
      if (m.count > 0) await announce(tx, [resultId]);
      return m;
    });
    if (moved.count === 0) throw settled();
    return live(await db.gameResult.findUniqueOrThrow({ where: { id: resultId } }));
  }

  /** "Not right": the result counts for nothing, and the person who entered it is told. */
  async function dispute(actor: Actor, resultId: string): Promise<GameResult> {
    const row = await forAnswer(actor, resultId);
    const at = now();
    // Only while the hour is still running: after it, the result stands.
    const moved = await db.gameResult.updateMany({
      where: { id: resultId, status: 'pending', autoConfirmAt: { gt: at } },
      data: { status: 'disputed', disputedBy: actor.userId, disputedAt: at },
    });
    if (moved.count === 0) throw settled();
    const [names, sportName] = await Promise.all([deps.users.namesByIds([actor.userId]), deps.sportName(row.sportId)]);
    await tell(
      [row.enteredBy],
      'game.result_disputed',
      { byName: names.get(actor.userId) ?? 'A player', sportName, score: scoreline(row.games as unknown as UnitScore[]) },
      row.gameId,
    );
    return live(await db.gameResult.findUniqueOrThrow({ where: { id: resultId } }));
  }

  /** Whoever entered it may take it back while nobody has answered. */
  async function remove(actor: Actor, resultId: string): Promise<void> {
    const row = await db.gameResult.findUnique({ where: { id: resultId } });
    if (!row) throw notFound();
    if (row.enteredBy !== actor.userId) throw forbidden();
    const gone = await db.gameResult.deleteMany({
      where: { id: resultId, OR: [{ status: 'disputed' }, { status: 'pending', autoConfirmAt: { gt: now() } }] },
    });
    if (gone.count === 0) throw settled();
  }

  // --- reads ----------------------------------------------------------------------

  /**
   * A game's results as this viewer may see them: confirmed ones for anyone,
   * and the unanswered or disputed ones only for the players in that match.
   */
  async function forGame(gameId: string, viewerUserId: string | null): Promise<GameResult[]> {
    const rows = await db.gameResult.findMany({ where: { gameId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows
      .map(live)
      .filter((r) => r.status === 'confirmed' || (viewerUserId !== null && inMatch(r, viewerUserId) !== null));
  }

  /** What the viewer may do with one result. */
  function viewerCan(r: GameResult, viewerUserId: string | null): { confirm: boolean; remove: boolean; side: Side | null } {
    const side = viewerUserId ? inMatch(r, viewerUserId) : null;
    const entrantSide = inMatch(r, r.enteredBy);
    return {
      side,
      confirm: r.status === 'pending' && side !== null && side !== entrantSide,
      remove: viewerUserId === r.enteredBy && r.status !== 'confirmed',
    };
  }

  const confirmedSql = (at: Date) => Prisma.sql`(r.status = 'confirmed' OR (r.status = 'pending' AND r.auto_confirm_at <= ${at}))`;

  /** R16 — a player's casual results (kept for older app versions): confirmed results this player was in, newest game first. */
  async function forUser(userId: string, opts: { first: number }): Promise<GameResult[]> {
    const first = Math.min(Math.max(opts.first, 1), 50);
    const ids = await db.$queryRaw<{ id: string }[]>`
      SELECT r.id FROM game_results r
       WHERE (${userId}::uuid = ANY(r.side_a) OR ${userId}::uuid = ANY(r.side_b))
         AND ${confirmedSql(now())}
       ORDER BY r.played_at DESC, r.created_at DESC, r.id
       LIMIT ${first}`;
    if (ids.length === 0) return [];
    const rows = await db.gameResult.findMany({ where: { id: { in: ids.map((i) => i.id) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap(({ id }) => (byId.has(id) ? [live(byId.get(id)!)] : []));
  }

  /** R16 — played, won, lost, drawn across every confirmed casual result. */
  async function tallyFor(userId: string): Promise<Tally> {
    const at = now();
    const rows = await db.$queryRaw<{ played: number; won: number; drawn: number }[]>`
      SELECT count(*)::int AS played,
             count(*) FILTER (WHERE (r.winner = 'a' AND ${userId}::uuid = ANY(r.side_a))
                                 OR (r.winner = 'b' AND ${userId}::uuid = ANY(r.side_b)))::int AS won,
             count(*) FILTER (WHERE r.winner IS NULL)::int AS drawn
        FROM game_results r
       WHERE (${userId}::uuid = ANY(r.side_a) OR ${userId}::uuid = ANY(r.side_b))
         AND ${confirmedSql(at)}`;
    const t = rows[0] ?? { played: 0, won: 0, drawn: 0 };
    return { played: t.played, won: t.won, drawn: t.drawn, lost: t.played - t.won - t.drawn };
  }

  /** R17 — two players have a confirmed casual result in common. */
  async function haveShared(userA: string, userB: string): Promise<boolean> {
    if (userA === userB) return false;
    const rows = await db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM game_results r
       WHERE (r.side_a || r.side_b) @> ARRAY[${userA}::uuid, ${userB}::uuid]
         AND ${confirmedSql(now())}
       LIMIT 1`;
    return rows.length > 0;
  }

  /** R15 — writes what the reads already say: an unanswered result past its hour is confirmed. */
  async function sweep(): Promise<number> {
    const at = now();
    const due = await db.gameResult.findMany({
      where: { status: 'pending', autoConfirmAt: { lte: at } },
      select: { id: true },
      take: 500,
    });
    if (due.length === 0) return 0;
    let count = 0;
    // One at a time, so each row and its announcement commit together.
    for (const { id } of due) {
      count += await db.$transaction(async (tx) => {
        const m = await tx.gameResult.updateMany({
          where: { id, status: 'pending', autoConfirmAt: { lte: at } },
          data: { status: 'confirmed', confirmedAt: at, confirmedVia: 'auto' },
        });
        if (m.count > 0) await announce(tx, [id]);
        return m.count;
      });
    }
    return count;
  }

  /** R19 — the rating port: one confirmed result, or null. */
  async function confirmedById(resultId: string): Promise<GameResult | null> {
    const row = await db.gameResult.findUnique({ where: { id: resultId } });
    if (!row) return null;
    const r = live(row);
    return r.status === 'confirmed' ? r : null;
  }

  /** R19 — the rating period's input: results confirmed in [from, to), oldest first. */
  async function confirmedBetween(sportId: string, from: Date, to: Date): Promise<GameResult[]> {
    const rows = await db.gameResult.findMany({
      where: { sportId, status: 'confirmed', confirmedAt: { gte: from, lt: to } },
      orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(live);
  }

  /** R19 — every confirmed result, for the backfill. */
  async function allConfirmedIds(): Promise<string[]> {
    const rows = await db.gameResult.findMany({
      where: { OR: [{ status: 'confirmed' }, { status: 'pending', autoConfirmAt: { lte: now() } }] },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  return {
    windowOf,
    canAdd,
    add,
    confirm,
    dispute,
    remove,
    forGame,
    viewerCan,
    forUser,
    tallyFor,
    haveShared,
    sweep,
    confirmedById,
    confirmedBetween,
    allConfirmedIds,
  };
}

export type GameResultsService = ReturnType<typeof createGameResults>;
