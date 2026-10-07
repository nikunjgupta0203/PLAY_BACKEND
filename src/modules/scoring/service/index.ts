/**
 * scoring — service layer (docs/modules/10-scoring.md).
 *
 * This module knows how to count, not what counting means (R4): the engine
 * takes its rules from `sport`, and this file never looks at which sport it is
 * scoring.
 *
 * Every write is the same four steps, in one transaction:
 *
 *   1. lock the match row                     R1 — serialises two devices
 *   2. compare `expectedSeq` with `score_seq`  R1 — the loser gets SCORE_STALE
 *   3. append the event, move the head         R2, R3 — whole state, append-only
 *   4. write the outbox row                    R5 — Pusher never fails a tap
 *
 * Who may score: any staff grant on the event (owner, manager or the volunteer
 * `scorer`), or a player on either side of the match. Amateur draws are mostly
 * self-scored, which is why R6 needs the OTHER side to confirm.
 *
 * `correctResult` (R7, R8) fixes a confirmed result while the next round has
 * not started; after that the bracket has moved on and the organizer
 * regenerates or voids instead.
 */
import type { Db, Tx } from '../../../platform/db.js';
import { forbidden, SystemError, UserError } from '../../../platform/errors/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import type { ScoringRule } from '../../sport/index.js';
import {
  applyEvent,
  resultDetail,
  initialState,
  ScoringInputError,
  winnerOf,
  drawable,
  type GameScore,
  type ScoreEvent,
  type ScoreState,
  type Side,
} from '../engine.js';
import {
  autoConfirmFor,
  REMINDER_AFTER_MS,
  type ConfirmedVia,
  type ResultSource,
} from '../finality.js';
import type { ResultRow, ScoreEventRow, ScoringRepo } from '../repo/index.js';

export type { BoutState, Dismissal, GameScore, InningsRecord, InningsState, ScoreEvent, ScoreState, Shootout, Side } from '../engine.js';
export type { ResultRow, ScoreEventRow } from '../repo/index.js';

export const ScoringCode = {
  /** R4 — an event the sport's rule does not take (a 3-pointer in football, a kick out of turn). */
  INVALID_EVENT: 'INVALID_EVENT',
  /** R1 — carries the server's state in `details`; the client re-reads. */
  SCORE_STALE: 'SCORE_STALE',
  MATCH_NOT_LIVE: 'MATCH_NOT_LIVE',
  /** Both sides of the match are not yet known. */
  MATCH_NOT_READY: 'MATCH_NOT_READY',
  /** Scoring opens an hour before the event; `details.opensAt` says when. */
  MATCH_TOO_EARLY: 'MATCH_TOO_EARLY',
  NOTHING_TO_UNDO: 'NOTHING_TO_UNDO',
  /** A scoreline that is not a finished match under the sport's rule. */
  INVALID_RESULT: 'INVALID_RESULT',
  RESULT_NOT_SUBMITTED: 'RESULT_NOT_SUBMITTED',
  RESULT_ALREADY_CONFIRMED: 'RESULT_ALREADY_CONFIRMED',
  /** R6 — the organizer override opens 15 minutes after submission. */
  OVERRIDE_TOO_EARLY: 'OVERRIDE_TOO_EARLY',
  /** R6 — a disputed result is the organizer's to settle. */
  RESULT_DISPUTED: 'RESULT_DISPUTED',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  /** gap #19 — a player who disagrees with a submitted result disputes it. */
  USE_DISPUTE: 'USE_DISPUTE',
  /** gap #19 — only whoever tapped a point (or staff) may take it back. */
  NOT_YOUR_POINT: 'NOT_YOUR_POINT',
  /** gap #18 — an organizer playing in the match does not correct its result. */
  CANNOT_CORRECT: 'CANNOT_CORRECT',
  /** F6 — the opponent checked in, so this is not a walkover. */
  WALKOVER_OPPONENT_PRESENT: 'WALKOVER_OPPONENT_PRESENT',
  /** F6 — a player claims a walkover only 15 minutes after the match was due. */
  WALKOVER_TOO_EARLY: 'WALKOVER_TOO_EARLY',
} as const;

/** F6 — how long after its time a player may claim a walkover. */
export const WALKOVER_GRACE_MS = 15 * 60_000;

/** gap #20 — how often an open dispute is brought back to the organizer. */
export const DISPUTE_REMINDER_EVERY_MS = 30 * 60_000;
/** gap #20 — an open dispute this long after the event ends goes to PL4Y staff. */
export const DISPUTE_ESCALATE_AFTER_END_MS = 24 * 3_600_000;
/**
 * gap #20 — an escalated dispute PL4Y has not settled this long after it
 * reached them is closed on the submitted result (`default`), so a bracket
 * never waits forever. It is never rated (finality `isRatable`).
 */
export const DISPUTE_DEFAULT_AFTER_ESCALATION_MS = 72 * 3_600_000;

export type Outcome = ResultRow['outcome'];
export type StaffRole = 'owner' | 'manager' | 'scorer';

/** R6 — how long the opposing side has before an organizer may confirm for them. */
export const OVERRIDE_AFTER_MS = 15 * 60_000;

export interface SweepReport {
  confirmed: number;
  alerts: number;
  reminders: number;
  /** gap #20 — disputes escalated to PL4Y staff this pass. */
  escalated?: number;
  /** gap #20 — escalated disputes closed by default this pass. */
  defaulted?: number;
  /** One match's failure never stops the pass; the worker logs these. */
  failed: { matchId: string; error: string }[];
}

export interface Actor {
  userId: string;
}

/** What scoring needs to know about a match. Everything here is tournament's. */
export interface MatchInfo {
  id: string;
  tournamentId: string;
  eventId: string;
  eventCategoryId: string;
  sportId: string;
  status: string;
  /** championship | plate | league | group — a league or group match may end level. */
  bracket: string;
  /** R11 — the auto-confirm window never runs past the event's end (bar the 15-minute floor). */
  eventEndsAt: Date;
  sideARegistrationId: string | null;
  sideBRegistrationId: string | null;
  /** The event's status. A cancelled event's matches are not played. */
  eventStatus?: string;
  /** F6 — when the match was due: its court time, else the event's start. */
  scheduledAt?: Date | null;
  eventStartsAt?: Date;
}

export interface MatchesPort {
  byId(matchId: string): Promise<MatchInfo | null>;
  markLive(matchId: string, tx: Tx): Promise<void>;
  markAwaitingConfirm(matchId: string, tx: Tx): Promise<void>;
  reopen(matchId: string, tx: Tx): Promise<void>;
  /** tournament R9, R10 — under the tournament's advisory lock, idempotent. */
  advance(
    matchId: string,
    outcome: {
      /** Null for a draw. */
      winnerRegistrationId: string | null;
      loserRegistrationId: string | null;
      outcome: Outcome;
      /** The scoreline's totals, for a league table. Null for a walkover. */
      tallyA: number | null;
      tallyB: number | null;
    },
    tx: Tx,
  ): Promise<void>;
  /** gap #18 — re-advance a finished match under a corrected result. */
  correct(
    matchId: string,
    outcome: {
      winnerRegistrationId: string | null;
      loserRegistrationId: string | null;
      outcome: Outcome;
      tallyA: number | null;
      tallyB: number | null;
    },
    tx: Tx,
  ): Promise<void>;
}

export interface ScoringDeps {
  db: Db;
  repo: ScoringRepo;
  matches: MatchesPort;
  /** R4 — the ONLY source of what a point means. */
  ruleFor(eventCategoryId: string): Promise<ScoringRule>;
  /** identity R10 — read fresh, never a claim. */
  roleOn(userId: string, eventId: string): Promise<StaffRole | null>;
  /** Every user on an entry: the captain, and the partner for doubles. */
  membersOf(registrationId: string): Promise<string[]>;
  /** F6 — whether an entry has checked in. Absent: nobody has (walkover claims wait only on time). */
  checkedIn?(registrationId: string): Promise<boolean>;
  /** F4 — everyone with a grant on the event, to tell whether anyone neutral can settle a dispute. */
  staffOf?(eventId: string): Promise<{ userId: string; role: string }[]>;
  /**
   * How long before the event starts a match may be started. Default an hour:
   * a stray tap days early would score a match nobody is playing and flip the
   * whole event to live.
   */
  startOpensBeforeMs?: number;
  now?: () => Date;
}

/** A match may be started from an hour before its event begins. */
export const START_OPENS_BEFORE_MS = 60 * 60_000;

export interface Access {
  /** The side the viewer plays on, if they play in this match. */
  side: Side | null;
  role: StaffRole | null;
  canScore: boolean;
}

export interface Snapshot {
  state: ScoreState | null;
  seq: number;
}

const notFound = () => new UserError(ScoringCode.MATCH_NOT_FOUND, 'That match could not be found.');

const notLive = (status: string) =>
  new UserError(ScoringCode.MATCH_NOT_LIVE, 'This match is not being scored right now.', {
    details: { status },
  });

const invalid = (message: string) => new UserError(ScoringCode.INVALID_RESULT, message);

const otherSide = (side: Side): Side => (side === 'a' ? 'b' : 'a');

/**
 * The scoreline a live result stores. Rally and sets: the games or sets. Goals
 * and innings: the running score. A judged bout: each judge's total; a points
 * bout: its rounds.
 */
function resultGames(state: ScoreState): GameScore[] {
  if (state.kind === 'goals' || state.kind === 'innings') return [state.current];
  const cards = state.bout?.cards ?? [];
  if (cards.length > 0) {
    return cards[0]!.map((_, j) => cards.reduce((t, round) => ({ a: t.a + round[j]!.a, b: t.b + round[j]!.b }), { a: 0, b: 0 }));
  }
  return state.games.length > 0 ? state.games : [state.current];
}

/** What a league table counts from a result: the scoreline's totals. None for a walkover. */
function tallies(result: ResultRow): { tallyA: number | null; tallyB: number | null } {
  if (result.outcome === 'walkover' || result.games.length === 0) return { tallyA: null, tallyB: null };
  return {
    tallyA: result.games.reduce((t, g) => t + g.a, 0),
    tallyB: result.games.reduce((t, g) => t + g.b, 0),
  };
}

export function createScoringService(deps: ScoringDeps) {
  const { db, repo, matches } = deps;
  const now = deps.now ?? (() => new Date());
  const startOpensBeforeMs = deps.startOpensBeforeMs ?? START_OPENS_BEFORE_MS;

  // --- reads ---------------------------------------------------------------

  async function matchOrThrow(matchId: string): Promise<MatchInfo> {
    const found = await matches.byId(matchId);
    if (!found) throw notFound();
    return found;
  }

  /** A league or group match may end level; a knockout match never may. */
  const drawAllowed = (match: MatchInfo): boolean => match.bracket === 'league' || match.bracket === 'group';

  /** R4 — the sport's rule, without its knockout tiebreaker where a draw is a result. */
  async function ruleOf(match: MatchInfo): Promise<ScoringRule> {
    const rule = await deps.ruleFor(match.eventCategoryId);
    return drawAllowed(match) ? drawable(rule) : rule;
  }

  async function sideOf(match: MatchInfo, userId: string): Promise<Side | null> {
    for (const [side, registrationId] of [
      ['a', match.sideARegistrationId],
      ['b', match.sideBRegistrationId],
    ] as const) {
      if (registrationId && (await deps.membersOf(registrationId)).includes(userId)) return side;
    }
    return null;
  }

  async function accessFor(actor: Actor | null, match: MatchInfo): Promise<Access> {
    if (!actor) return { side: null, role: null, canScore: false };
    const [side, role] = await Promise.all([
      sideOf(match, actor.userId),
      deps.roleOn(actor.userId, match.eventId),
    ]);
    return { side, role, canScore: side !== null || role !== null };
  }

  /**
   * F4 — an owner or manager who is NOT playing in this match. Staff who play
   * are players here, everywhere: correcting, confirming for the other side,
   * and settling a dispute.
   */
  const neutralManager = (who: Access): boolean =>
    (who.role === 'owner' || who.role === 'manager') && who.side === null;

  async function access(actor: Actor | null, matchId: string): Promise<Access> {
    return accessFor(actor, await matchOrThrow(matchId));
  }

  async function snapshot(matchId: string): Promise<Snapshot> {
    const head = await repo.head(matchId);
    return { state: head?.currentScore ?? null, seq: head?.scoreSeq ?? 0 };
  }

  const timeline = (matchId: string): Promise<ScoreEventRow[]> => repo.events(db, matchId);
  const resultFor = (matchId: string): Promise<ResultRow | null> => repo.result(db, matchId);

  // --- writes --------------------------------------------------------------

  async function assertCanScore(actor: Actor, matchId: string): Promise<MatchInfo> {
    const match = await matchOrThrow(matchId);
    if (!(await accessFor(actor, match)).canScore) throw forbidden();
    assertEventOn(match);
    return match;
  }

  /** A cancelled event's matches are not played, so they are not scored either. */
  function assertEventOn(match: MatchInfo): void {
    if (match.eventStatus === 'cancelled') {
      throw new UserError(ScoringCode.MATCH_NOT_LIVE, 'This event was cancelled.', {
        details: { status: 'cancelled' },
      });
    }
  }

  /** Scoring opens an hour before the event — never days early. */
  function assertStartable(match: MatchInfo): void {
    if (!match.eventStartsAt || match.status === 'live') return;
    const opensAt = match.eventStartsAt.getTime() - startOpensBeforeMs;
    if (now().getTime() < opensAt) {
      throw new UserError(ScoringCode.MATCH_TOO_EARLY, 'This match can be started from an hour before the event begins.', {
        details: { opensAt: new Date(opensAt).toISOString() },
      });
    }
  }

  /** R1 — the loser of a race is told what the winner wrote. */
  function stale(head: { scoreSeq: number; currentScore: ScoreState | null }): UserError {
    return new UserError(
      ScoringCode.SCORE_STALE,
      'Somebody else scored this match first. Check the score before carrying on.',
      { details: { seq: head.scoreSeq, state: head.currentScore } },
    );
  }

  async function publishScore(tx: Tx, match: MatchInfo, seq: number, state: ScoreState) {
    await outboxWrite(tx, {
      topic: 'match.score',
      payload: { matchId: match.id, eventId: match.eventId, seq, state, at: now().toISOString() },
    });
  }

  /**
   * Opens the point log. Idempotent for a match already live, so a scorer who
   * taps Start on two phones does not get an error on the second.
   */
  async function start(actor: Actor, matchId: string, firstServer: Side = 'a'): Promise<Snapshot> {
    const match = await assertCanScore(actor, matchId);
    if (!match.sideARegistrationId || !match.sideBRegistrationId) {
      throw new UserError(ScoringCode.MATCH_NOT_READY, 'Both sides of this match are not known yet.');
    }
    assertStartable(match);
    const rule = await ruleOf(match);

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, matchId);
      if (!head) throw notFound();
      if (head.status === 'live' && head.currentScore) {
        return { state: head.currentScore, seq: head.scoreSeq };
      }
      if (head.status !== 'ready' && head.status !== 'live') throw notLive(head.status);

      const state = initialState(rule, firstServer);
      const seq = head.scoreSeq + 1;
      await repo.append(tx, {
        matchId,
        seq,
        kind: 'start',
        scoringSide: null,
        stateAfter: state,
        event: null,
        recordedBy: actor.userId,
      });
      await matches.markLive(matchId, tx);
      await publishScore(tx, match, seq, state);
      return { state, seq };
    });
  }

  /**
   * R1–R5 for any typed event. The event that ends the match also submits its
   * result (R6) — a win, or in a league or group match a draw.
   */
  async function recordEvent(
    actor: Actor,
    input: { matchId: string; event: ScoreEvent; expectedSeq: number },
  ): Promise<Snapshot> {
    const match = await assertCanScore(actor, input.matchId);
    const rule = await ruleOf(match);

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, input.matchId);
      if (!head) throw notFound();
      if (input.expectedSeq !== head.scoreSeq) throw stale(head);
      if (head.status !== 'live' || !head.currentScore) throw notLive(head.status);

      let state: ScoreState;
      try {
        state = applyEvent(head.currentScore, input.event, rule);
      } catch (err) {
        if (err instanceof ScoringInputError) {
          if (head.currentScore.matchOver) throw notLive(head.status);
          throw new UserError(ScoringCode.INVALID_EVENT, err.message);
        }
        throw err;
      }

      const isPoint = input.event.type === 'point';
      const seq = head.scoreSeq + 1;
      await repo.append(tx, {
        matchId: input.matchId,
        seq,
        kind: isPoint ? 'point' : 'event',
        scoringSide: 'side' in input.event ? input.event.side : null,
        stateAfter: state,
        event: isPoint ? null : input.event,
        recordedBy: actor.userId,
      });

      if (state.matchOver && (state.winner || drawAllowed(match))) {
        await submitIn(tx, match, actor, {
          outcome: 'played',
          winner: state.winner,
          // A goals match has no completed units; its result is the final score.
          // A goals or innings match has no completed units; its result is the running score.
          games: resultGames(state),
          ...resultDetail(state),
          source: 'live',
        });
      }

      await publishScore(tx, match, seq, state);
      return { state, seq };
    });
  }

  /** R1–R5 — a rally won by `side`. Kept for existing clients; the same write as recordEvent. */
  function recordPoint(
    actor: Actor,
    input: { matchId: string; side: Side; expectedSeq: number },
  ): Promise<Snapshot> {
    return recordEvent(actor, {
      matchId: input.matchId,
      event: { type: 'point', side: input.side },
      expectedSeq: input.expectedSeq,
    });
  }

  /**
   * R2 — an undo is an event, never a delete. It restores the state before the
   * last point still standing, so two undos in a row take back two points.
   *
   * Undoing the point that ended the match takes back its result as well —
   * as long as nobody has confirmed it. A confirmed result is a correction,
   * and corrections are not a scorer's (R7).
   */
  async function undo(
    actor: Actor,
    input: { matchId: string; expectedSeq: number },
  ): Promise<Snapshot> {
    const match = await assertCanScore(actor, input.matchId);
    const who = await accessFor(actor, match);
    // Staff who are not playing in this match.
    const neutralStaff = who.role !== null && who.side === null;

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, input.matchId);
      if (!head) throw notFound();
      if (input.expectedSeq !== head.scoreSeq) throw stale(head);

      const reopening = head.status === 'awaiting_confirm' && head.currentScore?.matchOver === true;
      if (head.status !== 'live' && !reopening) throw notLive(head.status);
      // gap #19 — a submitted result is taken back by staff, never by a
      // player: a losing player could otherwise reopen the match forever.
      if (reopening && !neutralStaff) {
        throw new UserError(
          ScoringCode.USE_DISPUTE,
          'The result is submitted. If it is wrong, dispute it and the organizer will settle it.',
        );
      }
      if (reopening) {
        const result = await repo.result(tx, input.matchId);
        if (result?.confirmedAt) {
          throw new UserError(
            ScoringCode.RESULT_ALREADY_CONFIRMED,
            'This result has been confirmed and can only be corrected by an organizer.',
          );
        }
      }

      // Replay the log to find what is still standing. Walking the whole log
      // costs one indexed read of a few hundred rows, and it is the log — not
      // a counter kept beside it — that says which point an undo takes back.
      const stack: { state: ScoreState; by: string }[] = [];
      for (const e of await repo.events(tx, input.matchId)) {
        if (e.kind === 'undo') {
          if (stack.length > 1) stack.pop();
        } else {
          stack.push({ state: e.stateAfter, by: e.recordedBy });
        }
      }
      if (stack.length <= 1) {
        throw new UserError(ScoringCode.NOTHING_TO_UNDO, 'There is no point to undo.');
      }
      // gap #19 — during play, a point is taken back by whoever tapped it, or
      // by staff. The other side's player cannot erase points they lost.
      if (!neutralStaff && stack[stack.length - 1]!.by !== actor.userId) {
        throw new UserError(ScoringCode.NOT_YOUR_POINT, 'Only whoever recorded that point can undo it.');
      }
      stack.pop();
      const state = stack[stack.length - 1]!.state;

      const seq = head.scoreSeq + 1;
      await repo.append(tx, {
        matchId: input.matchId,
        seq,
        kind: 'undo',
        scoringSide: null,
        stateAfter: state,
        event: null,
        recordedBy: actor.userId,
      });
      if (reopening) {
        await repo.dropUnconfirmedResult(tx, input.matchId);
        await matches.reopen(input.matchId, tx);
      }
      await publishScore(tx, match, seq, state);
      return { state, seq };
    });
  }

  async function submitIn(
    tx: Tx,
    match: MatchInfo,
    actor: Actor,
    input: {
      outcome: Outcome;
      /** Null for a draw — only ever reached for a league or group match. */
      winner: Side | null;
      games: GameScore[];
      source: ResultSource;
      /** Plan 3 — how it was won beyond the scoreline. Absent = normal play. */
      method?: string | null;
      margin?: string | null;
    },
  ): Promise<ResultRow> {
    const winnerId = input.winner === null ? null : input.winner === 'a' ? match.sideARegistrationId : match.sideBRegistrationId;
    const loserId = input.winner === null ? null : input.winner === 'a' ? match.sideBRegistrationId : match.sideARegistrationId;
    if (input.winner !== null && !winnerId) throw new UserError(ScoringCode.MATCH_NOT_READY, 'That side is empty.');

    // R12 — the role held at the moment of submission, not whatever it is later.
    // Staff who play in this match are players here: their own score is no
    // more witnessed than anyone else's.
    const [role, side] = await Promise.all([
      deps.roleOn(actor.userId, match.eventId),
      sideOf(match, actor.userId),
    ]);
    const submitterRole = role && side === null ? 'staff' : 'player';
    const submittedAt = now();
    const row = await repo.putResult(tx, {
      matchId: match.id,
      winnerRegistrationId: winnerId,
      loserRegistrationId: loserId,
      games: input.games,
      outcome: input.outcome,
      method: input.method ?? null,
      margin: input.margin ?? null,
      submittedBy: actor.userId,
      submittedAt,
      source: input.source,
      submitterRole,
      // R11 — computed once, here; the sweep and the client both read it.
      // R11 for staff; F5 for a player's own result.
      autoConfirmAt: autoConfirmFor({ submittedAt, eventEndsAt: match.eventEndsAt, role: submitterRole }),
    });
    await matches.markAwaitingConfirm(match.id, tx);
    await outboxWrite(tx, {
      topic: 'result.submitted',
      payload: {
        matchId: match.id,
        eventId: match.eventId,
        outcome: input.outcome,
        submittedBy: actor.userId,
        autoConfirmAt: row.autoConfirmAt?.toISOString() ?? null,
      },
    });
    return row;
  }

  /**
   * What a submitted scoreline means under the sport's rule: who won, and how
   * beyond the score. Shared by a first submission and an organizer's
   * correction (gap #18), so the two can never accept different scorelines.
   */
  async function judge(
    match: MatchInfo,
    input: {
      outcome: Outcome;
      games: GameScore[];
      winner?: Side | null;
      penalties?: GameScore | null;
      /** A bout ended early — one of the rule's `finishes` (ko, tko, submission…). */
      finish?: string | null;
    },
  ): Promise<{ winner: Side | null; detail: { method: string | null; margin: string | null } }> {
    const rule = await ruleOf(match);
    let winner: Side | null;
    let detail: { method: string | null; margin: string | null } = { method: null, margin: null };
    const wholeNumbers = (ns: number[]) => ns.every((n) => Number.isInteger(n) && n >= 0);
    if (input.finish) {
      if (input.outcome !== 'played' || rule.kind !== 'bouts') throw invalid('Only a bout can end by a stoppage.');
      if (!rule.finishes.includes(input.finish)) throw invalid(`This sport does not end by ${input.finish}.`);
      if (!input.winner) throw invalid('Say which side won by stoppage.');
      if (!wholeNumbers(input.games.flatMap((g) => [g.a, g.b]))) throw invalid('Scores are whole numbers, never negative.');
      winner = input.winner;
      detail = { method: input.finish, margin: null };
    } else if (input.penalties) {
      // A level knockout: a goals match goes to a shootout, a cricket match to a super over.
      const p = input.penalties;
      const total = input.games.reduce((t, g) => ({ a: t.a + g.a, b: t.b + g.b }), { a: 0, b: 0 });
      const decider = rule.kind === 'innings' ? 'super over' : 'penalties';
      if (input.outcome !== 'played' || (rule.kind !== 'goals' && rule.kind !== 'innings')) {
        throw invalid('A tiebreaker only decides a played goals or cricket match.');
      }
      if (input.games.length === 0 || total.a !== total.b) throw invalid(`The ${decider} only decide a level score.`);
      if (!wholeNumbers([p.a, p.b, ...input.games.flatMap((g) => [g.a, g.b])])) {
        throw invalid('Scores are whole numbers, never negative.');
      }
      if (p.a === p.b) throw invalid(`The ${decider} has no winner.`);
      winner = p.a > p.b ? 'a' : 'b';
      detail = { method: rule.kind === 'innings' ? 'super_over' : 'shootout', margin: `${p.a}–${p.b}` };
      if (input.winner && input.winner !== winner) throw invalid(`The ${decider} says the other side won.`);
    } else if (input.outcome === 'played') {
      try {
        winner = winnerOf(input.games, rule);
      } catch (err) {
        if (err instanceof ScoringInputError) throw invalid(err.message);
        throw err;
      }
      if (input.winner && input.winner !== winner) {
        throw invalid(winner ? 'The score says the other side won.' : 'The score is level: a draw.');
      }
      if (winner === null && !drawAllowed(match)) throw invalid('A knockout match needs a winner.');
    } else {
      if (!input.winner) throw invalid('Say which side the match was awarded to.');
      for (const g of input.games) {
        if (!Number.isInteger(g.a) || !Number.isInteger(g.b) || g.a < 0 || g.b < 0) {
          throw invalid('Scores are whole numbers, never negative.');
        }
      }
      winner = input.winner;
    }
    return { winner, detail };
  }

  /**
   * R6, R10 — a result entered rather than tapped: a paper scoresheet, a
   * retirement mid-match, a walkover. A played result is held to the sport's
   * rule; the others carry no point log and need only a winner.
   *
   * A disputed result may be re-submitted by an owner or manager, which is how
   * an organizer settles a dispute with a different scoreline.
   */
  async function submitResult(
    actor: Actor,
    input: {
      matchId: string;
      outcome: Outcome;
      games: GameScore[];
      winner?: Side | null;
      /** Plan 3 — the shootout (or super over) that decided a level knockout: required then, refused otherwise. */
      penalties?: GameScore | null;
      /** A bout won early: ko, tko, submission… */
      finish?: string | null;
    },
  ): Promise<ResultRow> {
    const match = await matchOrThrow(input.matchId);
    const who = await accessFor(actor, match);
    if (!who.canScore) throw forbidden();
    assertEventOn(match);
    if (!match.sideARegistrationId || !match.sideBRegistrationId) {
      throw new UserError(ScoringCode.MATCH_NOT_READY, 'Both sides of this match are not known yet.');
    }
    const { winner, detail } = await judge(match, input);
    if (input.outcome === 'walkover' && !(who.role !== null && who.side === null)) {
      await assertWalkoverClaim(match, winner);
    }

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, input.matchId);
      if (!head) throw notFound();

      if (head.status === 'awaiting_confirm') {
        const existing = await repo.result(tx, input.matchId);
        if (existing?.confirmedAt) {
          throw new UserError(ScoringCode.RESULT_ALREADY_CONFIRMED, 'This result is already confirmed.');
        }
        const settling = existing?.disputedAt && neutralManager(who);
        if (!settling) {
          throw new UserError(
            ScoringCode.MATCH_NOT_LIVE,
            'A result is already waiting for confirmation.',
            { details: { status: head.status } },
          );
        }
      } else if (head.status !== 'ready' && head.status !== 'live') {
        throw notLive(head.status);
      }

      return submitIn(tx, match, actor, {
        outcome: input.outcome,
        winner,
        games: input.games,
        source: 'typed',
        ...detail,
      });
    });
  }

  /**
   * F6 — a player claiming a walkover: the other side must not have checked
   * in, and the match must be 15 minutes past its time. Neutral staff, who are
   * standing there, are not held to this.
   */
  async function assertWalkoverClaim(match: MatchInfo, winner: Side | null): Promise<void> {
    const absentId = winner === 'a' ? match.sideBRegistrationId : match.sideARegistrationId;
    if (absentId && deps.checkedIn && (await deps.checkedIn(absentId))) {
      throw new UserError(
        ScoringCode.WALKOVER_OPPONENT_PRESENT,
        'The other side has checked in, so this is not a walkover. Play the match, or ask the organizer.',
      );
    }
    const due = match.scheduledAt ?? match.eventStartsAt ?? null;
    if (due) {
      const opensAt = new Date(due.getTime() + WALKOVER_GRACE_MS);
      if (now() < opensAt) {
        throw new UserError(
          ScoringCode.WALKOVER_TOO_EARLY,
          'A walkover can be claimed 15 minutes after the match was due to start.',
          { retryAfterSeconds: Math.ceil((opensAt.getTime() - now().getTime()) / 1000) },
        );
      }
    }
  }

  /**
   * Who may answer a submitted result: anybody on the side that did NOT submit
   * it. When staff submitted, both sides are "the other side".
   */
  async function mayAnswer(match: MatchInfo, result: ResultRow, who: Access): Promise<boolean> {
    if (who.side === null) return false;
    const submitter = await sideOf(match, result.submittedBy);
    return submitter === null || who.side === otherSide(submitter);
  }

  function overrideOpensAt(result: ResultRow): Date {
    return new Date(result.submittedAt.getTime() + OVERRIDE_AFTER_MS);
  }

  /**
   * R12 — the volunteer who watched it: a scorer, on neither side, who tapped
   * points into this match's own log. A typed result has no such witness.
   */
  async function isWitness(
    client: Db | Tx,
    match: MatchInfo,
    result: ResultRow,
    who: Access,
    userId: string,
  ): Promise<boolean> {
    return (
      who.role === 'scorer' &&
      who.side === null &&
      result.source === 'live' &&
      result.disputedAt === null &&
      (await repo.hasRecordedPoints(client, match.id, userId))
    );
  }

  /**
   * What the viewer may do with a pending result. Read by the client to decide
   * which buttons exist, and re-checked by `confirmResult` itself.
   */
  async function resultAccess(
    actor: Actor | null,
    match: MatchInfo,
    result: ResultRow,
  ): Promise<{ canConfirm: boolean; canDispute: boolean }> {
    if (!actor || result.confirmedAt) return { canConfirm: false, canDispute: false };
    const who = await accessFor(actor, match);
    const answering = await mayAnswer(match, result, who);
    const manager = neutralManager(who);
    const overrideOpen = result.disputedAt !== null || now() >= overrideOpensAt(result);
    const witness = await isWitness(db, match, result, who, actor.userId);
    return {
      canConfirm: (answering && result.disputedAt === null) || (manager && overrideOpen) || witness,
      canDispute: answering && result.disputedAt === null,
    };
  }

  /**
   * The one way a result becomes final, whoever asked for it: advance the
   * bracket in the same transaction and tell rating (rating R3).
   */
  async function confirmIn(
    tx: Tx,
    match: MatchInfo,
    by: string | null,
    via: ConfirmedVia,
  ): Promise<ResultRow> {
    const confirmed = await repo.confirm(tx, match.id, by, via, now());
    await matches.advance(
      match.id,
      {
        winnerRegistrationId: confirmed.winnerRegistrationId,
        loserRegistrationId: confirmed.loserRegistrationId,
        outcome: confirmed.outcome,
        ...tallies(confirmed),
      },
      tx,
    );
    await outboxWrite(tx, {
      topic: 'result.confirmed',
      payload: { matchId: match.id, eventId: match.eventId, outcome: confirmed.outcome, via },
    });
    return confirmed;
  }

  /**
   * R6, R12 — the opposing side confirms; a scorer who scored it may confirm at
   * once; an owner or manager may confirm 15 minutes after submission, or at
   * once when the result is disputed.
   */
  async function confirmResult(actor: Actor, matchId: string): Promise<ResultRow> {
    const match = await matchOrThrow(matchId);
    const who = await accessFor(actor, match);

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, matchId);
      if (!head) throw notFound();
      const result = await repo.result(tx, matchId);
      if (!result) {
        throw new UserError(ScoringCode.RESULT_NOT_SUBMITTED, 'No result has been submitted yet.');
      }
      if (result.confirmedAt) {
        throw new UserError(ScoringCode.RESULT_ALREADY_CONFIRMED, 'This result is already confirmed.');
      }

      const answering = await mayAnswer(match, result, who);
      if (answering && result.disputedAt === null) return confirmIn(tx, match, actor.userId, 'opponent');
      if (await isWitness(tx, match, result, who, actor.userId)) {
        return confirmIn(tx, match, actor.userId, 'staff');
      }

      const manager = neutralManager(who);
      if (!manager) {
        if (result.disputedAt !== null && answering) {
          throw new UserError(
            ScoringCode.RESULT_DISPUTED,
            'This result is disputed. The organizer will settle it.',
          );
        }
        throw forbidden();
      }
      const opensAt = overrideOpensAt(result);
      if (result.disputedAt === null && now() < opensAt) {
        throw new UserError(
          ScoringCode.OVERRIDE_TOO_EARLY,
          'The other side has 15 minutes to confirm before an organizer can.',
          { retryAfterSeconds: Math.ceil((opensAt.getTime() - now().getTime()) / 1000) },
        );
      }
      return confirmIn(tx, match, actor.userId, 'staff');
    });
  }

  /**
   * R11 — the sweep's confirmation. Everything is re-checked under the match
   * lock: a dispute or a person's confirmation that landed first wins, and the
   * sweep does nothing.
   */
  async function autoConfirm(matchId: string): Promise<ResultRow | null> {
    const match = await matchOrThrow(matchId);
    return db.$transaction(async (tx) => {
      await repo.lockHead(tx, matchId);
      const result = await repo.result(tx, matchId);
      if (
        !result ||
        result.confirmedAt ||
        result.disputedAt ||
        !result.autoConfirmAt ||
        result.autoConfirmAt > now()
      ) {
        return null;
      }
      return confirmIn(tx, match, null, 'auto');
    });
  }

  /**
   * R11, R13, R14 — one pass, run every minute by the worker. Confirmations go
   * first, so a result that is due is confirmed rather than reminded about.
   * Every step is safe to repeat: the stamps and the post-lock re-check make a
   * second pass a no-op.
   */
  async function sweep(): Promise<SweepReport> {
    const at = now();
    const report: SweepReport = { confirmed: 0, alerts: 0, reminders: 0, failed: [] };

    for (const matchId of await repo.dueForAutoConfirm(at)) {
      try {
        if (await autoConfirm(matchId)) report.confirmed += 1;
      } catch (err) {
        report.failed.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const byEvent = new Map<string, string[]>();
    for (const row of await repo.dueForStaffAlert(at, OVERRIDE_AFTER_MS)) {
      byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row.matchId]);
    }
    for (const [eventId, matchIds] of byEvent) {
      const sent = await db.$transaction(async (tx) => {
        const count = await repo.markStaffAlerted(tx, matchIds, at);
        if (count === 0) return false;
        await outboxWrite(tx, { topic: 'results.waiting', payload: { eventId, count } });
        return true;
      });
      if (sent) report.alerts += 1;
    }

    for (const row of await repo.dueForReminder(at, REMINDER_AFTER_MS)) {
      const sent = await db.$transaction(async (tx) => {
        if (!(await repo.markReminded(tx, row.matchId, at))) return false;
        await outboxWrite(tx, {
          topic: 'result.reminder',
          payload: {
            matchId: row.matchId,
            eventId: row.eventId,
            submittedBy: row.submittedBy,
            autoConfirmAt: row.autoConfirmAt?.toISOString() ?? null,
          },
        });
        return true;
      });
      if (sent) report.reminders += 1;
    }

    // gap #20 — a dispute nobody settles blocks the bracket. The organizer is
    // reminded every half hour while it is open (one grouped notice per
    // event)…
    const disputesByEvent = new Map<string, string[]>();
    for (const row of await repo.dueForDisputeReminder(at, DISPUTE_REMINDER_EVERY_MS)) {
      disputesByEvent.set(row.eventId, [...(disputesByEvent.get(row.eventId) ?? []), row.matchId]);
    }
    for (const [eventId, matchIds] of disputesByEvent) {
      const sent = await db.$transaction(async (tx) => {
        const count = await repo.markDisputeAlerted(tx, matchIds, at);
        if (count === 0) return false;
        await outboxWrite(tx, { topic: 'results.waiting', payload: { eventId, count, disputed: true } });
        return true;
      });
      if (sent) report.alerts += 1;
    }

    // …and a day after the event ends it goes to PL4Y staff.
    report.escalated = 0;
    for (const row of await repo.dueForEscalation(at, DISPUTE_ESCALATE_AFTER_END_MS)) {
      const sent = await db.$transaction(async (tx) => {
        if (!(await repo.markEscalated(tx, row.matchId, at))) return false;
        await outboxWrite(tx, { topic: 'result.escalated', payload: { matchId: row.matchId, eventId: row.eventId } });
        return true;
      });
      if (sent) report.escalated += 1;
    }

    // …and if nobody at PL4Y settles it either, it closes on the submitted
    // result three days later, unrated.
    report.defaulted = 0;
    for (const matchId of await repo.dueForDefault(at, DISPUTE_DEFAULT_AFTER_ESCALATION_MS)) {
      try {
        if (await settleByDefault(matchId)) report.defaulted += 1;
      } catch (err) {
        report.failed.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return report;
  }

  /**
   * gap #20 — re-checked under the match lock: staff who settled it a moment
   * earlier win, and this does nothing.
   */
  async function settleByDefault(matchId: string): Promise<ResultRow | null> {
    const match = await matchOrThrow(matchId);
    return db.$transaction(async (tx) => {
      await repo.lockHead(tx, matchId);
      const result = await repo.result(tx, matchId);
      if (!result || result.confirmedAt || !result.disputedAt || !result.escalatedAt) return null;
      if (now().getTime() - result.escalatedAt.getTime() < DISPUTE_DEFAULT_AFTER_ESCALATION_MS) return null;
      const confirmed = await confirmIn(tx, match, null, 'default');
      await outboxWrite(tx, { topic: 'result.defaulted', payload: { matchId, eventId: match.eventId } });
      return confirmed;
    });
  }

  /** F4 — some owner or manager on the event who is not on either side of this match. */
  async function hasNeutralSettler(match: MatchInfo): Promise<boolean> {
    if (!deps.staffOf) return true;
    const players = new Set<string>();
    for (const id of [match.sideARegistrationId, match.sideBRegistrationId]) {
      if (id) for (const userId of await deps.membersOf(id)) players.add(userId);
    }
    return (await deps.staffOf(match.eventId)).some(
      (g) => (g.role === 'owner' || g.role === 'manager') && !players.has(g.userId),
    );
  }

  /** The other side says the score is wrong. An organizer settles it (R6). */
  async function disputeResult(actor: Actor, matchId: string, reason: string): Promise<ResultRow> {
    const trimmed = reason.trim();
    if (trimmed.length === 0 || trimmed.length > 500) {
      throw invalid('Say what is wrong with the score, in under 500 characters.');
    }
    const match = await matchOrThrow(matchId);
    const who = await accessFor(actor, match);

    return db.$transaction(async (tx) => {
      await repo.lockHead(tx, matchId);
      const result = await repo.result(tx, matchId);
      if (!result) {
        throw new UserError(ScoringCode.RESULT_NOT_SUBMITTED, 'No result has been submitted yet.');
      }
      if (result.confirmedAt) {
        throw new UserError(ScoringCode.RESULT_ALREADY_CONFIRMED, 'This result is already confirmed.');
      }
      if (!(await mayAnswer(match, result, who))) throw forbidden();
      if (result.disputedAt) return result;

      const disputed = await repo.dispute(tx, matchId, actor.userId, trimmed, now());
      await outboxWrite(tx, {
        topic: 'result.disputed',
        payload: { matchId, eventId: match.eventId, disputedBy: actor.userId },
      });
      // F4 — a dispute in a match every organizer plays in has nobody neutral
      // to settle it. It goes to PL4Y staff now, not a day after the event.
      if (!(await hasNeutralSettler(match))) {
        if (await repo.markEscalated(tx, matchId, now())) {
          await outboxWrite(tx, {
            topic: 'result.escalated',
            payload: { matchId, eventId: match.eventId, reason: 'no_neutral_organizer' },
          });
        }
      }
      return disputed;
    });
  }

  /**
   * R7, R8 (gap #18) — an owner or manager corrects a result that was already
   * confirmed: the scorer tapped the wrong side, a walkover was recorded as a
   * win. The new scoreline is held to the same rule as any submission. A new
   * winner moves into the next match in place of the old one, which is only
   * possible while that match has not started (tournament refuses otherwise).
   * Rating re-rates the match on `result.corrected`.
   *
   * An organizer playing in the match does not correct their own result.
   */
  async function correctResult(
    actor: Actor,
    input: {
      matchId: string;
      outcome: Outcome;
      games: GameScore[];
      winner?: Side | null;
      penalties?: GameScore | null;
      finish?: string | null;
    },
  ): Promise<ResultRow> {
    const match = await matchOrThrow(input.matchId);
    const who = await accessFor(actor, match);
    if (who.role !== 'owner' && who.role !== 'manager') throw forbidden();
    if (!neutralManager(who)) {
      throw new UserError(ScoringCode.CANNOT_CORRECT, 'You play in this match, so another organizer must correct it.');
    }
    const { winner, detail } = await judge(match, input);
    const winnerId =
      winner === null ? null : winner === 'a' ? match.sideARegistrationId : match.sideBRegistrationId;
    const loserId =
      winner === null ? null : winner === 'a' ? match.sideBRegistrationId : match.sideARegistrationId;

    return db.$transaction(async (tx) => {
      await repo.lockHead(tx, input.matchId);
      const existing = await repo.result(tx, input.matchId);
      if (!existing?.confirmedAt) {
        throw new UserError(
          ScoringCode.RESULT_NOT_SUBMITTED,
          'Only a confirmed result can be corrected. Confirm or dispute the waiting one instead.',
        );
      }
      const corrected = await repo.correct(tx, input.matchId, {
        winnerRegistrationId: winnerId,
        loserRegistrationId: loserId,
        games: input.games,
        outcome: input.outcome,
        method: detail.method,
        margin: detail.margin,
        correctedBy: actor.userId,
      });
      await matches.correct(
        match.id,
        {
          winnerRegistrationId: corrected.winnerRegistrationId,
          loserRegistrationId: corrected.loserRegistrationId,
          outcome: corrected.outcome,
          ...tallies(corrected),
        },
        tx,
      );
      await outboxWrite(tx, {
        topic: 'result.corrected',
        payload: {
          matchId: match.id,
          eventId: match.eventId,
          winnerChanged: existing.winnerRegistrationId !== corrected.winnerRegistrationId,
          correctedBy: actor.userId,
        },
      });
      return corrected;
    });
  }

  /**
   * F12, F15 — the organizer's "needs you" list: results waiting for
   * somebody, disputes first. Anyone with a grant on the event may read it.
   */
  async function pendingForEvent(actor: Actor, eventId: string): Promise<string[]> {
    if (!(await deps.roleOn(actor.userId, eventId))) throw forbidden();
    return repo.openForEvent(eventId);
  }

  /**
   * F9 — PL4Y staff settle a dispute nobody on the event could (F4) or did
   * (gap #20): keep the submitted result, or enter the right one. Either way
   * it is confirmed now, by staff. The caller has checked the platform role.
   */
  async function platformSettle(
    staffUserId: string,
    input: {
      matchId: string;
      keep: boolean;
      outcome?: Outcome;
      games?: GameScore[];
      winner?: Side | null;
      penalties?: GameScore | null;
      finish?: string | null;
    },
  ): Promise<ResultRow> {
    const match = await matchOrThrow(input.matchId);
    const judged = input.keep
      ? null
      : await judge(match, {
          outcome: input.outcome ?? 'played',
          games: input.games ?? [],
          winner: input.winner,
          penalties: input.penalties,
          finish: input.finish,
        });
    return db.$transaction(async (tx) => {
      await repo.lockHead(tx, input.matchId);
      const result = await repo.result(tx, input.matchId);
      if (!result) throw new UserError(ScoringCode.RESULT_NOT_SUBMITTED, 'No result has been submitted yet.');
      if (result.confirmedAt) {
        throw new UserError(ScoringCode.RESULT_ALREADY_CONFIRMED, 'This result is already confirmed.');
      }
      if (judged) {
        const w = judged.winner;
        await repo.putResult(tx, {
          matchId: match.id,
          winnerRegistrationId: w === null ? null : w === 'a' ? match.sideARegistrationId : match.sideBRegistrationId,
          loserRegistrationId: w === null ? null : w === 'a' ? match.sideBRegistrationId : match.sideARegistrationId,
          games: input.games ?? [],
          outcome: input.outcome ?? 'played',
          method: judged.detail.method,
          margin: judged.detail.margin,
          submittedBy: staffUserId,
          submittedAt: now(),
          source: 'typed',
          submitterRole: 'staff',
          autoConfirmAt: null,
        });
      }
      return confirmIn(tx, match, staffUserId, 'staff');
    });
  }

  /** F9 — what PL4Y staff have to settle. */
  const escalatedResults = (): Promise<string[]> => repo.escalatedOpen();

  /** rating's port. Only a confirmed row is a result as far as anyone else is concerned. */
  async function confirmedResult(matchId: string): Promise<(ResultRow & { sportId: string }) | null> {
    const result = await repo.result(db, matchId);
    if (!result?.confirmedAt) return null;
    const match = await matches.byId(matchId);
    if (!match) throw new SystemError('MATCH_NOT_FOUND', `match ${matchId} vanished`);
    return { ...result, sportId: match.sportId };
  }

  return {
    platformSettle,
    escalatedResults,
    pendingForEvent,
    access,
    snapshot,
    timeline,
    resultFor,
    resultAccess,
    overrideOpensAt,
    start,
    recordPoint,
    recordEvent,
    undo,
    submitResult,
    confirmResult,
    autoConfirm,
    sweep,
    disputeResult,
    correctResult,
    confirmedResult,
    confirmedBetween: repo.confirmedBetween,
    matchInfo: (matchId: string) => matches.byId(matchId),
    ruleForMatch: async (matchId: string) => ruleOf(await matchOrThrow(matchId)),
  };
}

export type ScoringService = ReturnType<typeof createScoringService>;
