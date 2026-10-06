/**
 * scoring — the counting engine (docs/modules/10-scoring.md).
 *
 * Pure functions over a complete score. No database, no clock, no sport.
 *
 * R4 — what a point MEANS (when a game ends, whether a cap applies, who serves)
 * comes entirely from the `ScoringRule` the sport module hands over. The only
 * switch below is on `rule.kind`, the scoring FAMILY, which is the rule's own
 * discriminant; there is no branch on a sport anywhere in this module, and
 * `grep pickleball` over it should find nothing but a test. What a scorer can
 * record is a typed `ScoreEvent`; the family decides which events it accepts.
 *
 * R3 — every function returns the WHOLE score, never a delta, because that is
 * what `match_score_events.state_after` stores and what a spectator who missed
 * ten messages needs on receiving the eleventh.
 */
import type { ScoringRule } from '../sport/index.js';

export type Side = 'a' | 'b';

export interface GameScore {
  a: number;
  b: number;
}

export interface ScoreState {
  kind: ScoringRule['kind'];
  /**
   * Completed units: games for a rally sport, sets for a sets sport (each
   * holding the games won in that set). Always empty for a goals sport.
   */
  games: GameScore[];
  /**
   * The unit in progress: points in the current game (rally), games in the
   * current set (sets), or the running score (goals).
   */
  current: GameScore;
  /** Sets only — points in the current game or tiebreak. Null otherwise. */
  points: GameScore | null;
  /** Sets only — the current game is a set tiebreak. */
  tiebreak: boolean;
  /** Null where the family has no serve (goals). */
  serving: Side | null;
  matchOver: boolean;
  winner: Side | null;
  /** Goals only — the period being played, 1-based. Absent in states stored before periods existed: read as 1. */
  period?: number;
  /**
   * Goals only — kicks taken in a shootout, in order, and who kicked first (the
   * coin toss). Null/absent when there is none. `first` is set on the first kick;
   * a shootout stored before it existed is read as A first.
   */
  shootout?: Shootout | null;
  /** Sets only — the current tiebreak replaces the deciding set (`finalSetMatchTiebreak`). */
  matchTiebreak?: boolean;
  /**
   * Innings only (plan 4) — every innings so far, the current one last. `current`
   * holds each side's main-innings runs and `serving` the batting side.
   */
  innings?: InningsState;
  /** Series only (plan 5) — scoring events in the unit being played (carrom boards). */
  unitEvents?: number;
  /** Bouts only (plan 6). `current` is the points in play; `games` the rounds' final points (points bouts). */
  bout?: BoutState;
}

export interface BoutState {
  /** 1-based. */
  round: number;
  /** Judged bouts: each round's cards, one per judge. */
  cards: GameScore[][];
  roundsWon: GameScore;
  penalties: GameScore;
  /** Karate senshu: who scored the first unopposed point. */
  senshu: Side | null;
  /** The last side to score — the final criterion for a level points bout. */
  lastScorer: Side | null;
  /** How it ended, once over: ko, point_gap, points, unanimous_decision… */
  method: string | null;
  margin: string | null;
}

export interface InningsRecord {
  batting: Side;
  runs: number;
  wickets: number;
  /** Legal deliveries. Wides and no-balls are not. */
  balls: number;
  extras: number;
  /** Runs needed to win, for a chasing innings. Null when batting first. */
  target: number | null;
  /** When this innings ends: the balls and wickets it may use. */
  maxBalls: number;
  maxWickets: number;
}

export interface InningsState {
  list: InningsRecord[];
  /** 'main' for the match's two innings; 'super_over' once a tie went to one. */
  phase: 'main' | 'super_over';
  /** The next legal ball is a free hit: only a run out dismisses. */
  freeHit: boolean;
}

export type Dismissal = 'bowled' | 'caught' | 'lbw' | 'stumped' | 'run_out' | 'hit_wicket' | 'other';

export class ScoringInputError extends Error {}

/** What a scorer can record. The family decides which it accepts. */
export type ScoreEvent =
  | { type: 'point'; side: Side }
  | { type: 'score'; side: Side; action: string }
  | { type: 'period_end' }
  | { type: 'shootout_kick'; side: Side; scored: boolean }
  /**
   * Innings (plan 4) — one delivery. `runs` are the runs taken off it (a
   * boundary is 4 or 6); an extra adds its own penalty runs on top. `wicket` is
   * how a batter was out off it, or null.
   */
  | { type: 'ball'; runs: number; extra: 'wide' | 'no_ball' | 'bye' | 'leg_bye' | null; wicket: Dismissal | null }
  /** Series (plan 5) — a unit won outright; `score` is its score where the rule wants one (esports rounds). */
  | { type: 'unit_won'; side: Side; score: GameScore | null }
  /** Series — a drawn unit (chess): half a point each. */
  | { type: 'unit_drawn' }
  /** Series — the scorer closes a points unit (snooker frame); the higher score takes it. */
  | { type: 'unit_end' }
  /** Series — points inside a unit, any value (a snooker pot, a carrom board). */
  | { type: 'points'; side: Side; value: number }
  /** Bouts (plan 6) — a round's cards, one per judge, 10-point must. */
  | { type: 'round_cards'; cards: GameScore[] }
  /** Bouts — the round's clock ran out. */
  | { type: 'round_end' }
  /** Bouts — a penalty against `side`. */
  | { type: 'penalty'; side: Side }
  /** Bouts — `side` won early by `method` (ko, submission, fall…). */
  | { type: 'finish'; side: Side; method: string };

const other = (side: Side): Side => (side === 'a' ? 'b' : 'a');
const zero = (): GameScore => ({ a: 0, b: 0 });
const add = (score: GameScore, side: Side): GameScore => ({ ...score, [side]: score[side] + 1 });

function wonCount(units: GameScore[], side: Side): number {
  return units.filter((u) => u[side] > u[other(side)]).length;
}

export function initialState(rule: ScoringRule, firstServer: Side = 'a'): ScoreState {
  return {
    kind: rule.kind,
    games: [],
    current: zero(),
    points: rule.kind === 'sets' ? zero() : null,
    tiebreak: false,
    serving: rule.kind === 'goals' || rule.kind === 'series' || rule.kind === 'bouts' ? null : firstServer,
    matchOver: false,
    winner: null,
    ...(rule.kind === 'goals' ? { period: 1, shootout: null } : {}),
    ...(rule.kind === 'bouts'
      ? {
          bout: {
            round: 1,
            cards: [],
            roundsWon: zero(),
            penalties: zero(),
            senshu: null,
            lastScorer: null,
            method: null,
            margin: null,
          },
        }
      : {}),
    ...(rule.kind === 'innings'
      ? {
          innings: {
            list: [freshInnings(firstServer, null, rule.oversPerInnings * rule.ballsPerOver, rule.wicketsPerInnings)],
            phase: 'main' as const,
            freeHit: false,
          },
        }
      : {}),
  };
}

/**
 * One thing that happened, recorded by a scorer. What it does to the score is
 * the rule's business; throws ScoringInputError on a match that is already
 * over, a state from a different family, or an event the family does not take.
 */
/**
 * A league or group match may end level; a knockout match may not. The same
 * rule with its knockout tiebreaker taken away — extra time, a shootout, a
 * super over — so a level score at the end is a draw. Families that cannot
 * end level (rally, sets) and those whose own rule already allows it (a chess
 * series, a judges' draw) are unchanged.
 */
export function drawable(rule: ScoringRule): ScoringRule {
  if (rule.kind === 'goals' || rule.kind === 'innings') return { ...rule, tiebreaker: 'none' };
  return rule;
}

export function applyEvent(state: ScoreState, event: ScoreEvent, rule: ScoringRule): ScoreState {
  if (state.matchOver) throw new ScoringInputError('the match is already over');
  if (state.kind !== rule.kind) {
    throw new ScoringInputError(`a ${state.kind} score cannot take a ${rule.kind} event`);
  }
  switch (rule.kind) {
    case 'rally':
      if (event.type !== 'point') throw new ScoringInputError(`a rally match takes points, not ${event.type}`);
      return applyRally(state, event.side, rule);
    case 'sets':
      if (event.type !== 'point') throw new ScoringInputError(`a sets match takes points, not ${event.type}`);
      return applySets(state, event.side, rule);
    case 'goals':
      return applyGoals(state, event, rule);
    case 'innings':
      if (event.type !== 'ball') throw new ScoringInputError(`an innings match takes deliveries, not ${event.type}`);
      return applyBall(state, event, rule);
    case 'series':
      return applySeries(state, event, rule);
    case 'bouts':
      return applyBout(state, event, rule);
    case 'performance':
    case 'scorecard':
      // Plans 7, 8 — a field contest is scored as a heat (field.ts), never as a two-sided match.
      throw new ScoringInputError('this sport is scored in heats, not matches');
  }
}

/** One rally, goal or point won by `side`. Kept for recordPoint and older clients. */
export function applyPoint(state: ScoreState, side: Side, rule: ScoringRule): ScoreState {
  return applyEvent(state, { type: 'point', side }, rule);
}

// --- goals -------------------------------------------------------------------

type GoalsRule = Extract<ScoringRule, { kind: 'goals' }>;

const DEFAULT_ACTIONS = [{ key: 'goal', label: 'Goal', value: 1 }];

/** The scorer's buttons, in order. A rule with none scores one Goal at a time. */
export function actionsOf(rule: GoalsRule): { key: string; label: string; value: number }[] {
  return rule.actions ?? DEFAULT_ACTIONS;
}

export interface Shootout {
  a: boolean[];
  b: boolean[];
  first?: Side;
}

/** Who kicked first: recorded, or A for a shootout stored before it was. Null before any kick. */
const firstKicker = (so: Shootout): Side | null =>
  so.first ?? (so.a.length + so.b.length > 0 ? 'a' : null);

/** The side due to kick, or null when either may (nobody has kicked yet). */
export function kicksNext(so: Shootout): Side | null {
  const first = firstKicker(so);
  if (!first) return null;
  return so[first].length <= so[other(first)].length ? first : other(first);
}

/** Five kicks each, stopping as soon as one side cannot catch up; then sudden death in pairs. */
function shootoutWinner(so: Shootout): Side | null {
  const ga = so.a.filter(Boolean).length;
  const gb = so.b.filter(Boolean).length;
  const la = so.a.length;
  const lb = so.b.length;
  if (la <= 5 && lb <= 5 && !(la === 5 && lb === 5)) {
    if (ga + (5 - la) < gb) return 'b';
    if (gb + (5 - lb) < ga) return 'a';
    return null;
  }
  if (la === lb && ga !== gb) return ga > gb ? 'a' : 'b';
  return null;
}

function applyGoals(state: ScoreState, event: ScoreEvent, rule: GoalsRule): ScoreState {
  const period = state.period ?? 1;
  const shootout = state.shootout ?? null;

  if (event.type === 'point' || event.type === 'score') {
    if (shootout) throw new ScoringInputError('the match is in a shootout; record kicks');
    const action =
      event.type === 'point' ? actionsOf(rule)[0]! : actionsOf(rule).find((a) => a.key === event.action);
    if (!action) throw new ScoringInputError(`this sport has no "${(event as { action: string }).action}" score`);
    return { ...state, period, current: { ...state.current, [event.side]: state.current[event.side] + action.value } };
  }

  if (event.type === 'shootout_kick') {
    if (!shootout) throw new ScoringInputError('there is no shootout');
    const due = kicksNext(shootout);
    if (due && due !== event.side) throw new ScoringInputError('it is the other side’s kick');
    const next: Shootout = {
      ...shootout,
      first: firstKicker(shootout) ?? event.side,
      [event.side]: [...shootout[event.side], event.scored],
    };
    const winner = shootoutWinner(next);
    return { ...state, shootout: next, matchOver: winner !== null, winner };
  }

  // period_end
  if (shootout) throw new ScoringInputError('the match is in a shootout');
  if (period < rule.periods) return { ...state, period: period + 1 };

  const level = state.current.a === state.current.b;
  const leader: Side = state.current.a > state.current.b ? 'a' : 'b';
  const hasExtra = rule.tiebreaker === 'extra_period' || rule.tiebreaker === 'extra_period_then_shootout';
  const block = rule.extraPeriods ?? 2;
  const extraPlayed = period - rule.periods;

  // Mid-way through a block of extra time (the first half of a two-half block): play on, whatever the score.
  if (extraPlayed > 0 && extraPlayed % block !== 0) return { ...state, period: period + 1 };

  if (!level) return { ...state, matchOver: true, winner: leader };

  const mayPlayExtra = hasExtra && (extraPlayed === 0 || rule.repeatExtraPeriods === true);
  if (mayPlayExtra) return { ...state, period: period + 1 };
  if (rule.tiebreaker === 'shootout' || rule.tiebreaker === 'extra_period_then_shootout') {
    return { ...state, shootout: { a: [], b: [] } };
  }
  // tiebreaker 'none': a level match is over with no winner (a league draw).
  return { ...state, matchOver: true, winner: null };
}

// --- rally -------------------------------------------------------------------

type RallyRule = Extract<ScoringRule, { kind: 'rally' }>;

/** The deciding game — the last one a best-of-N can reach — may be shorter or longer. */
export function rallyGameShape(
  rule: RallyRule,
  gameIndex: number,
): { pointsToWin: number; hardCap: number | null } {
  const deciding = gameIndex === 2 * rule.gamesToWin - 2;
  return deciding && rule.decidingGame ? rule.decidingGame : rule;
}

function rallyGameWon(game: GameScore, side: Side, rule: RallyRule, gameIndex: number): boolean {
  const shape = rallyGameShape(rule, gameIndex);
  const mine = game[side];
  const theirs = game[other(side)];
  if (shape.hardCap !== null && mine >= shape.hardCap) return true;
  return mine >= shape.pointsToWin && mine - theirs >= rule.winBy;
}

function applyRally(state: ScoreState, side: Side, rule: RallyRule): ScoreState {
  // Side-out: only the serving side can score. Winning the rally as the
  // receiver wins the serve and nothing else.
  if (rule.serveModel === 'side_out' && state.serving !== side) {
    return { ...state, serving: side };
  }

  const current = add(state.current, side);
  if (!rallyGameWon(current, side, rule, state.games.length)) {
    return { ...state, current, serving: side };
  }

  const games = [...state.games, current];
  const over = wonCount(games, side) >= rule.gamesToWin;
  return {
    ...state,
    games,
    current: zero(),
    serving: side,
    matchOver: over,
    winner: over ? side : null,
  };
}

// --- sets --------------------------------------------------------------------

type SetsRule = Extract<ScoringRule, { kind: 'sets' }>;

function isFinalSet(rule: SetsRule, setIndex: number): boolean {
  return setIndex === 2 * rule.setsToWin - 2;
}

function applySets(state: ScoreState, side: Side, rule: SetsRule): ScoreState {
  const points = add(state.points ?? zero(), side);
  const mine = points[side];
  const theirs = points[other(side)];

  if (state.tiebreak) {
    const target =
      state.matchTiebreak && rule.finalSetMatchTiebreak
        ? rule.finalSetMatchTiebreak
        : { pointsToWin: rule.tiebreakPointsToWin, winBy: rule.tiebreakWinBy };
    const won = mine >= target.pointsToWin && mine - theirs >= target.winBy;
    if (!won) {
      // The first tiebreak point is served alone, then two each.
      const played = points.a + points.b;
      const serving = played % 2 === 1 ? other(state.serving ?? 'a') : state.serving;
      return { ...state, points, serving };
    }
    // A match tiebreak is recorded as the deciding "set", by its points (10–8).
    if (state.matchTiebreak) return closeSet({ ...state, matchTiebreak: false }, points, side, rule);
    // A set tiebreak decides the set by one game.
    return closeSet(state, add(state.current, side), side, rule);
  }

  const gameWinBy = rule.gameWinBy ?? 2;
  if (!(mine >= rule.gamePointsToWin && mine - theirs >= gameWinBy)) {
    return { ...state, points };
  }

  const current = add(state.current, side);
  const serving = other(state.serving ?? 'a');
  const g = current[side];
  const og = current[other(side)];
  if (g >= rule.setGamesToWin && g - og >= rule.setWinBy) {
    return closeSet({ ...state, serving }, current, side, rule);
  }

  const tiebreakFires =
    rule.setTiebreakAt !== null &&
    current.a === rule.setTiebreakAt &&
    current.b === rule.setTiebreakAt &&
    !(isFinalSet(rule, state.games.length) && rule.finalSetIsFullSet);

  return { ...state, current, points: zero(), tiebreak: tiebreakFires, serving };
}

function closeSet(state: ScoreState, set: GameScore, side: Side, rule: SetsRule): ScoreState {
  const games = [...state.games, set];
  const over = wonCount(games, side) >= rule.setsToWin;
  const toMatchTiebreak =
    !over &&
    !!rule.finalSetMatchTiebreak &&
    wonCount(games, 'a') === rule.setsToWin - 1 &&
    wonCount(games, 'b') === rule.setsToWin - 1;
  return {
    ...state,
    games,
    current: zero(),
    points: zero(),
    tiebreak: toMatchTiebreak,
    matchTiebreak: toMatchTiebreak,
    serving: state.tiebreak ? other(state.serving ?? 'a') : state.serving,
    matchOver: over,
    winner: over ? side : null,
  };
}

// --- results submitted without a point log ------------------------------------

/**
 * The winner a submitted scoreline implies, or a ScoringInputError saying why
 * the scoreline is not a finished match under this rule.
 *
 * A result entered by hand (scoring R10, a paper scoresheet, a dead phone) is
 * held to the same rule a tapped one is: a rally game has to be a game the
 * engine would have ended exactly there, and nothing may be played after the
 * match was decided.
 */
export function winnerOf(units: GameScore[], rule: ScoringRule): Side | null {
  if (units.length === 0) throw new ScoringInputError('a played result needs a score');
  for (const u of units) {
    if (!Number.isInteger(u.a) || !Number.isInteger(u.b) || u.a < 0 || u.b < 0) {
      throw new ScoringInputError('scores are whole numbers, never negative');
    }
  }

  if (rule.kind === 'performance' || rule.kind === 'scorecard') {
    throw new ScoringInputError('this sport is scored in heats, not matches');
  }
  if (rule.kind === 'series') return seriesWinnerOf(units, rule);
  if (rule.kind === 'bouts') {
    // A typed bout result is its final points (or judge totals); the higher wins.
    const total = units.reduce((s, u) => ({ a: s.a + u.a, b: s.b + u.b }), zero());
    if (total.a === total.b) throw new ScoringInputError('a level score has no winner — enter how it was decided');
    return total.a > total.b ? 'a' : 'b';
  }
  if (rule.kind === 'goals' || rule.kind === 'innings') {
    const total = units.reduce((s, u) => ({ a: s.a + u.a, b: s.b + u.b }), zero());
    if (total.a === total.b) {
      // A league match may end level: a draw (see drawable).
      if (rule.tiebreaker === 'none') return null;
      // A knockout draw advances somebody. A level scoreline is a result only
      // once the tiebreaker (extra time, a shootout) has been entered too.
      throw new ScoringInputError('a level score has no winner — enter the tiebreaker');
    }
    return total.a > total.b ? 'a' : 'b';
  }

  const toWin = rule.kind === 'rally' ? rule.gamesToWin : rule.setsToWin;
  const tally = { a: 0, b: 0 };
  for (const [i, u] of units.entries()) {
    if (tally.a >= toWin || tally.b >= toWin) {
      throw new ScoringInputError('a game was played after the match was decided');
    }
    if (u.a === u.b) throw new ScoringInputError(`game ${i + 1} has no winner`);
    const w: Side = u.a > u.b ? 'a' : 'b';
    if (rule.kind === 'rally') {
      const before: GameScore = { ...u, [w]: u[w] - 1 };
      if (!rallyGameWon(u, w, rule, i) || rallyGameWon(before, w, rule, i)) {
        throw new ScoringInputError(`game ${i + 1} (${u.a}–${u.b}) is not a finished game`);
      }
    } else {
      const g = u[w];
      const og = u[other(w)];
      const deciding = tally.a === rule.setsToWin - 1 && tally.b === rule.setsToWin - 1;
      const mtb = rule.finalSetMatchTiebreak;
      if (deciding && mtb) {
        const finished = g >= mtb.pointsToWin && g - og >= mtb.winBy && (g === mtb.pointsToWin || g - og === mtb.winBy);
        if (!finished) throw new ScoringInputError(`the match tiebreak (${u.a}–${u.b}) is not finished`);
      } else {
        const outright = g >= rule.setGamesToWin && g - og >= rule.setWinBy;
        const byTiebreak =
          rule.setTiebreakAt !== null &&
          !(isFinalSet(rule, i) && rule.finalSetIsFullSet) &&
          og === rule.setTiebreakAt &&
          g === rule.setTiebreakAt + 1;
        if (!outright && !byTiebreak) {
          throw new ScoringInputError(`set ${i + 1} (${u.a}–${u.b}) is not a finished set`);
        }
      }
    }
    tally[w] += 1;
  }
  if (tally.a < toWin && tally.b < toWin) {
    throw new ScoringInputError('nobody has won the match yet');
  }
  return tally.a > tally.b ? 'a' : 'b';
}

// --- how a match was won -------------------------------------------------------

/**
 * Plan 3 — how a finished match was won, beyond its scoreline: a shootout win
 * is `shootout` with the kick tally as the margin ("4–3"). Null for a win in
 * normal play. Families added later (bouts, innings) report their own methods
 * here — KO, by runs — from their own state, never from a sport.
 */
export function resultDetail(state: ScoreState): { method: string | null; margin: string | null } {
  if (state.matchOver && state.shootout) {
    const a = state.shootout.a.filter(Boolean).length;
    const b = state.shootout.b.filter(Boolean).length;
    return { method: 'shootout', margin: `${a}–${b}` };
  }
  if (state.matchOver && state.bout?.method) return { method: state.bout.method, margin: state.bout.margin };
  const inn = state.innings;
  if (state.matchOver && state.winner && inn) {
    if (inn.phase === 'super_over') return { method: 'super_over', margin: null };
    const chase = inn.list[inn.list.length - 1]!;
    // The chasing side won by the wickets it had left; the defending side by the runs short.
    return chase.batting === state.winner
      ? { method: 'wickets', margin: String(chase.maxWickets - chase.wickets) }
      : { method: 'runs', margin: String((chase.target ?? 0) - 1 - chase.runs) };
  }
  return { method: null, margin: null };
}

// --- innings (plan 4) ------------------------------------------------------------

type InningsRule = Extract<ScoringRule, { kind: 'innings' }>;
type Ball = Extract<ScoreEvent, { type: 'ball' }>;

function freshInnings(batting: Side, target: number | null, maxBalls: number, maxWickets: number): InningsRecord {
  return { batting, runs: 0, wickets: 0, balls: 0, extras: 0, target, maxBalls, maxWickets };
}

/** A super over is one over and two wickets. */
const SUPER_OVER_WICKETS = 2;

function applyBall(state: ScoreState, ball: Ball, rule: InningsRule): ScoreState {
  const inn = state.innings;
  if (!inn) throw new ScoringInputError('this score has no innings');
  if (!Number.isInteger(ball.runs) || ball.runs < 0 || ball.runs > 7) {
    throw new ScoringInputError('runs off a ball are a whole number from 0 to 7');
  }
  const legal = ball.extra !== 'wide' && ball.extra !== 'no_ball';
  // After a no-ball, or on a free hit, only a run out dismisses.
  if (ball.wicket && ball.wicket !== 'run_out' && (ball.extra === 'no_ball' || (inn.freeHit && legal))) {
    throw new ScoringInputError('only a run out dismisses off a no-ball or a free hit');
  }
  if (ball.wicket && ball.extra === 'wide' && ball.wicket !== 'run_out' && ball.wicket !== 'stumped') {
    throw new ScoringInputError('off a wide a batter can only be run out or stumped');
  }

  const penalty = ball.extra === 'wide' ? rule.extras.wideRuns : ball.extra === 'no_ball' ? rule.extras.noBallRuns : 0;
  const extras = penalty + (ball.extra === 'bye' || ball.extra === 'leg_bye' || ball.extra === 'wide' ? ball.runs : 0);
  const cur = inn.list[inn.list.length - 1]!;
  const next: InningsRecord = {
    ...cur,
    runs: cur.runs + penalty + ball.runs,
    extras: cur.extras + extras,
    balls: cur.balls + (legal ? 1 : 0),
    wickets: cur.wickets + (ball.wicket ? 1 : 0),
  };
  const list = [...inn.list.slice(0, -1), next];
  const freeHit = ball.extra === 'no_ball' ? rule.extras.freeHit : legal ? false : inn.freeHit;
  const added = penalty + ball.runs;
  const current = inn.phase === 'main' ? { ...state.current, [next.batting]: state.current[next.batting] + added } : state.current;
  let s: ScoreState = { ...state, current, innings: { ...inn, list, freeHit } };

  const reached = next.target !== null && next.runs >= next.target;
  const ended = reached || next.balls >= next.maxBalls || next.wickets >= next.maxWickets;
  if (!ended) return s;
  s = { ...s, innings: { ...s.innings!, freeHit: false } };

  // The first innings of a pair: the other side chases runs + 1.
  if (next.target === null) {
    const chaser = other(next.batting);
    return {
      ...s,
      serving: chaser,
      innings: { ...s.innings!, list: [...list, freshInnings(chaser, next.runs + 1, next.maxBalls, next.maxWickets)] },
    };
  }

  // The chase is over.
  if (reached) return { ...s, matchOver: true, winner: next.batting };
  if (next.runs < next.target - 1) return { ...s, matchOver: true, winner: other(next.batting) };
  // Tied.
  if (rule.tiebreaker === 'none') return { ...s, matchOver: true, winner: null };
  // A super over: the side that batted second bats first in it.
  return {
    ...s,
    serving: next.batting,
    innings: {
      ...s.innings!,
      phase: 'super_over',
      list: [...list, freshInnings(next.batting, null, rule.ballsPerOver, SUPER_OVER_WICKETS)],
    },
  };
}

// --- series (plan 5) -------------------------------------------------------------

type SeriesRule = Extract<ScoringRule, { kind: 'series' }>;

/** Match points: a won unit is 1, a drawn unit (equal scores) half each. */
function seriesTally(units: GameScore[]): GameScore {
  return units.reduce(
    (t, u) => (u.a > u.b ? { ...t, a: t.a + 1 } : u.b > u.a ? { ...t, b: t.b + 1 } : { a: t.a + 0.5, b: t.b + 0.5 }),
    zero(),
  );
}

/** A unit score the rule accepts: first to pointsToWin, or winBy clear once past it. */
function validUnitScore(score: GameScore, rule: SeriesRule): boolean {
  const u = rule.unitScore;
  if (!u) return true;
  const w = Math.max(score.a, score.b);
  const l = Math.min(score.a, score.b);
  return w >= u.pointsToWin && w - l >= u.winBy && (w === u.pointsToWin || w - l === u.winBy);
}

function closeUnit(state: ScoreState, record: GameScore, rule: SeriesRule): ScoreState {
  const games = [...state.games, record];
  const tally = seriesTally(games);
  const base: ScoreState = { ...state, games, current: zero(), unitEvents: 0 };
  if (tally.a >= rule.unitsToWin) return { ...base, matchOver: true, winner: 'a' };
  if (tally.b >= rule.unitsToWin) return { ...base, matchOver: true, winner: 'b' };
  if (rule.maxUnits !== null && games.length >= rule.maxUnits) {
    const winner: Side | null = tally.a === tally.b ? null : tally.a > tally.b ? 'a' : 'b';
    return { ...base, matchOver: true, winner };
  }
  return base;
}

function applySeries(state: ScoreState, event: ScoreEvent, rule: SeriesRule): ScoreState {
  switch (event.type) {
    case 'unit_won': {
      if (rule.unitScoring !== 'win_only') throw new ScoringInputError(`a ${rule.unitName} here is won on points`);
      if (rule.unitScore) {
        const score = event.score;
        if (!score) throw new ScoringInputError(`a ${rule.unitName} needs its score`);
        if (score[event.side] <= score[other(event.side)] || !validUnitScore(score, rule)) {
          throw new ScoringInputError(`${score.a}–${score.b} is not a finished ${rule.unitName}`);
        }
        return closeUnit(state, score, rule);
      }
      return closeUnit(state, event.side === 'a' ? { a: 1, b: 0 } : { a: 0, b: 1 }, rule);
    }
    case 'unit_drawn':
      if (!rule.allowDraws) throw new ScoringInputError(`a ${rule.unitName} cannot be drawn`);
      return closeUnit(state, { a: 0.5, b: 0.5 }, rule);
    case 'points':
    case 'score': {
      if (rule.unitScoring !== 'points') throw new ScoringInputError(`a ${rule.unitName} here is won outright, not on points`);
      let value: number;
      if (event.type === 'score') {
        const action = rule.actions?.find((a) => a.key === event.action);
        if (!action) throw new ScoringInputError(`this sport has no "${event.action}" score`);
        value = action.value;
      } else {
        if (!Number.isInteger(event.value) || event.value < 0 || event.value > 1000) {
          throw new ScoringInputError('points are a whole number from 0 to 1000');
        }
        value = event.value;
      }
      const side = event.side;
      const current = { ...state.current, [side]: state.current[side] + value };
      const unitEvents = (state.unitEvents ?? 0) + 1;
      const next = { ...state, current, unitEvents };
      if (rule.unitPointTarget !== null && current[side] >= rule.unitPointTarget) return closeUnit(next, current, rule);
      if (rule.maxEventsPerUnit !== null && unitEvents >= rule.maxEventsPerUnit && current.a !== current.b) {
        return closeUnit(next, current, rule);
      }
      return next;
    }
    case 'unit_end':
      if (rule.unitScoring !== 'points') throw new ScoringInputError(`a ${rule.unitName} here is won outright`);
      if (state.current.a === state.current.b) throw new ScoringInputError(`a level ${rule.unitName} has no winner yet`);
      return closeUnit(state, state.current, rule);
    default:
      throw new ScoringInputError(`a series match does not take ${event.type}`);
  }
}

/** A typed series result: every unit must be one the engine would have closed, and someone must have won. */
function seriesWinnerOf(units: GameScore[], rule: SeriesRule): Side | null {
  let state: ScoreState = { ...initialState(rule), games: [] };
  for (const [i, u] of units.entries()) {
    if (state.matchOver) throw new ScoringInputError('a unit was played after the match was decided');
    if (u.a === u.b) {
      if (!rule.allowDraws) throw new ScoringInputError(`${rule.unitName} ${i + 1} has no winner`);
      state = closeUnit(state, { a: 0.5, b: 0.5 }, rule);
      continue;
    }
    if (rule.unitScore && !validUnitScore(u, rule)) {
      throw new ScoringInputError(`${rule.unitName} ${i + 1} (${u.a}–${u.b}) is not a finished ${rule.unitName}`);
    }
    state = closeUnit(state, u, rule);
  }
  if (!state.matchOver) throw new ScoringInputError('nobody has won the match yet');
  // A series played out level (a drawn chess match) ends with no winner.
  return state.winner;
}

// --- bouts (plan 6) ---------------------------------------------------------------

type BoutsRule = Extract<ScoringRule, { kind: 'bouts' }>;

const ended = (state: ScoreState, winner: Side, method: string, margin: string | null): ScoreState => ({
  ...state,
  matchOver: true,
  winner,
  bout: { ...state.bout!, method, margin },
});

/** Judges' totals across the rounds → the decision. */
function judgesDecision(state: ScoreState): ScoreState {
  const bout = state.bout!;
  const judges = bout.cards[0]?.length ?? 0;
  const totals = Array.from({ length: judges }, (_, j) =>
    bout.cards.reduce((t, round) => ({ a: t.a + round[j]!.a, b: t.b + round[j]!.b }), zero()),
  );
  const forA = totals.filter((t) => t.a > t.b).length;
  const forB = totals.filter((t) => t.b > t.a).length;
  const margin = totals.map((t) => `${t.a}–${t.b}`).join(', ');
  const winner: Side | null = forA > forB && forA * 2 > judges ? 'a' : forB > forA && forB * 2 > judges ? 'b' : null;
  if (!winner) return { ...state, matchOver: true, winner: null, bout: { ...bout, method: 'draw', margin } };
  const won = winner === 'a' ? forA : forB;
  const lost = winner === 'a' ? forB : forA;
  const method = won === judges ? 'unanimous_decision' : lost > 0 ? 'split_decision' : 'majority_decision';
  return ended(state, winner, method, margin);
}

/** A points bout (or round) is over on the gap. */
function checkGap(state: ScoreState, rule: BoutsRule): ScoreState {
  const { a, b } = state.current;
  if (rule.pointGap === null || Math.abs(a - b) < rule.pointGap) return state;
  const leader: Side = a > b ? 'a' : 'b';
  if (rule.roundsToWin !== null) return closeBoutRound(state, leader, rule);
  return ended(state, leader, 'point_gap', `${a}–${b}`);
}

/** Rounds-to-win: the round goes to `winner`; first to roundsToWin takes the bout. */
function closeBoutRound(state: ScoreState, winner: Side, rule: BoutsRule): ScoreState {
  const bout = state.bout!;
  const roundsWon = { ...bout.roundsWon, [winner]: bout.roundsWon[winner] + 1 };
  const next: ScoreState = {
    ...state,
    games: [...state.games, state.current],
    current: zero(),
    bout: { ...bout, roundsWon, round: bout.round + 1, senshu: null, lastScorer: null },
  };
  const margin = `${roundsWon.a}–${roundsWon.b}`;
  if (roundsWon[winner] >= (rule.roundsToWin ?? 1)) return ended(next, winner, 'rounds', margin);
  if (bout.round >= rule.rounds) return ended(next, roundsWon.a > roundsWon.b ? 'a' : 'b', 'rounds', margin);
  return next;
}

function applyBout(state: ScoreState, event: ScoreEvent, rule: BoutsRule): ScoreState {
  const bout = state.bout;
  if (!bout) throw new ScoringInputError('this score has no bout');
  switch (event.type) {
    case 'finish':
      if (!rule.finishes.includes(event.method)) throw new ScoringInputError(`this sport does not end by ${event.method}`);
      return ended(state, event.side, event.method, `round ${bout.round}`);

    case 'round_cards': {
      if (rule.decision !== 'judges') throw new ScoringInputError('this sport is scored on points, not judges’ cards');
      if (event.cards.length !== rule.judges) throw new ScoringInputError(`a round needs ${rule.judges} cards`);
      for (const c of event.cards) {
        const valid = [c.a, c.b].every((n) => Number.isInteger(n) && n >= 6 && n <= 10) && Math.max(c.a, c.b) === 10;
        if (!valid) throw new ScoringInputError(`${c.a}–${c.b} is not a 10-point-must card`);
      }
      const next: ScoreState = { ...state, bout: { ...bout, cards: [...bout.cards, event.cards], round: bout.round + 1 } };
      return bout.round >= rule.rounds ? judgesDecision(next) : next;
    }

    case 'score': {
      if (rule.decision !== 'points') throw new ScoringInputError('this sport is scored on judges’ cards');
      const action = rule.actions.find((a) => a.key === event.action);
      if (!action) throw new ScoringInputError(`this sport has no "${event.action}" score`);
      const unopposed = state.current.a === 0 && state.current.b === 0;
      const senshu = rule.firstPointAdvantage && !bout.senshu && unopposed ? event.side : bout.senshu;
      const next: ScoreState = {
        ...state,
        current: { ...state.current, [event.side]: state.current[event.side] + action.value },
        bout: { ...bout, senshu, lastScorer: event.side },
      };
      return checkGap(next, rule);
    }

    case 'penalty': {
      const penalties = { ...bout.penalties, [event.side]: bout.penalties[event.side] + 1 };
      const to = other(event.side);
      let next: ScoreState = { ...state, bout: { ...bout, penalties } };
      if (rule.maxPenalties !== null && penalties[event.side] >= rule.maxPenalties) {
        return ended(next, to, 'disqualification', `${penalties[event.side]} penalties`);
      }
      if (rule.penaltyToOpponent > 0) {
        next = {
          ...next,
          current: { ...next.current, [to]: next.current[to] + rule.penaltyToOpponent },
          bout: { ...next.bout!, lastScorer: to },
        };
        return checkGap(next, rule);
      }
      return next;
    }

    case 'round_end': {
      if (rule.decision !== 'points') throw new ScoringInputError('a judged round ends with its cards');
      const { a, b } = state.current;
      const leader: Side | null = a === b ? null : a > b ? 'a' : 'b';
      if (rule.roundsToWin !== null) {
        const w = leader ?? bout.lastScorer;
        if (!w) throw new ScoringInputError('a level round with no score has no winner');
        return closeBoutRound(state, w, rule);
      }
      if (bout.round < rule.rounds) return { ...state, bout: { ...bout, round: bout.round + 1 } };
      const margin = `${a}–${b}`;
      const final: ScoreState = { ...state, games: [state.current] };
      if (leader) return ended(final, leader, 'points', margin);
      if (rule.firstPointAdvantage && bout.senshu) return ended(final, bout.senshu, 'senshu', margin);
      if (bout.lastScorer) return ended(final, bout.lastScorer, 'criteria', margin);
      throw new ScoringInputError('a level bout with no score needs a decision — record the finish');
    }

    default:
      throw new ScoringInputError(`a bout does not take ${event.type}`);
  }
}
