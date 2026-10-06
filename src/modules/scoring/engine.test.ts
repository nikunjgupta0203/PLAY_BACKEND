/**
 * scoring — the engine, tested without a database.
 *
 * The checklist asks for applyPoint unit-tested against the pickleball rule:
 * win-by-2, hard cap, the shorter (here: longer) deciding game. The rules below
 * are taken from the SEED rather than written out, so a test cannot quietly
 * agree with an engine that has drifted from the data it will actually run on.
 */
import { describe, expect, it } from 'vitest';
import { BADMINTON, BASKETBALL, CHESS, CRICKET, FOOTBALL, KABADDI, PADEL, PICKLEBALL, VOLLEYBALL } from '../sport/seed.js';
import type { ScoringRule } from '../sport/index.js';
import {
  applyEvent,
  resultDetail,
  applyPoint,
  initialState,
  ScoringInputError,
  winnerOf,
  drawable,
  type ScoreEvent,
  type ScoreState,
  type Side,
} from './engine.js';

const pickleball = PICKLEBALL.scoringRule;

function play(rule: ScoringRule, rallies: string, from: ScoreState = initialState(rule)): ScoreState {
  let state = from;
  for (const ch of rallies) state = applyPoint(state, ch as Side, rule);
  return state;
}

const times = (side: Side, n: number) => side.repeat(n);

describe('rally family', () => {
  it('scoring R4: a game ends at the target only when ahead by winBy', () => {
    const tenAll = play(pickleball, 'ab'.repeat(10));
    expect(tenAll.current).toEqual({ a: 10, b: 10 });

    const afterEleven = play(pickleball, 'a', tenAll);
    expect(afterEleven.games).toHaveLength(0);
    expect(afterEleven.current).toEqual({ a: 11, b: 10 });

    const won = play(pickleball, 'a', afterEleven);
    expect(won.games).toEqual([{ a: 12, b: 10 }]);
    expect(won.current).toEqual({ a: 0, b: 0 });
  });

  it('scoring R4: the hard cap ends a game with a one-point lead', () => {
    const deuce = play(pickleball, 'ab'.repeat(14));
    const capped = play(pickleball, 'a', deuce);
    expect(capped.games).toEqual([{ a: 15, b: 14 }]);
  });

  it('scoring R4: the deciding game uses its own shape', () => {
    // One game each, then the decider is to 15 (capped at 21), not to 11.
    const oneAll = play(pickleball, times('a', 11) + times('b', 11));
    expect(oneAll.games).toHaveLength(2);
    const elevenLove = play(pickleball, times('a', 11), oneAll);
    expect(elevenLove.matchOver).toBe(false);
    const done = play(pickleball, times('a', 4), elevenLove);
    expect(done.matchOver).toBe(true);
    expect(done.winner).toBe('a');
    expect(done.games[2]).toEqual({ a: 15, b: 0 });
  });

  it('scoring R3: every state is the whole score, not a delta', () => {
    const s = play(pickleball, times('a', 11) + 'bb');
    expect(s).toMatchObject({
      games: [{ a: 11, b: 0 }],
      current: { a: 0, b: 2 },
      serving: 'b',
      matchOver: false,
    });
  });

  it('rally serve: whoever wins the rally serves next', () => {
    expect(play(pickleball, 'b').serving).toBe('b');
    expect(play(pickleball, 'ba').serving).toBe('a');
  });

  it('side-out serve: the receiver winning a rally takes the serve and scores nothing', () => {
    const sideOut: ScoringRule = {
      ...(pickleball as Extract<ScoringRule, { kind: 'rally' }>),
      serveModel: 'side_out',
    };
    const s = play(sideOut, 'b');
    expect(s.current).toEqual({ a: 0, b: 0 });
    expect(s.serving).toBe('b');
    expect(play(sideOut, 'bb').current).toEqual({ a: 0, b: 1 });
  });

  it('refuses a point after the match is over', () => {
    const over = play(pickleball, times('a', 22));
    expect(over.matchOver).toBe(true);
    expect(() => applyPoint(over, 'b', pickleball)).toThrow(ScoringInputError);
  });

  it('scoring R4: a second sport is a different rule, not a branch', () => {
    // Badminton to 21 with no special decider. Same code path.
    const s = play(BADMINTON.scoringRule, times('a', 20));
    expect(s.games).toHaveLength(0);
    expect(play(BADMINTON.scoringRule, 'a', s).games).toEqual([{ a: 21, b: 0 }]);
  });
});

describe('sets family', () => {
  const tennis: ScoringRule = {
    kind: 'sets',
    gamePointsToWin: 4,
    setGamesToWin: 6,
    setWinBy: 2,
    setsToWin: 2,
    setTiebreakAt: 6,
    tiebreakPointsToWin: 7,
    tiebreakWinBy: 2,
    finalSetIsFullSet: false,
  };
  const game = (side: Side) => times(side, 4);

  it('a game needs a two-point lead past deuce', () => {
    const deuce = play(tennis, 'ab'.repeat(3));
    const adv = play(tennis, 'a', deuce);
    expect(adv.current).toEqual({ a: 0, b: 0 });
    expect(play(tennis, 'a', adv).current).toEqual({ a: 1, b: 0 });
  });

  it('serve changes every game', () => {
    expect(play(tennis, game('a')).serving).toBe('b');
  });

  it('six-all goes to a tiebreak, which decides the set 7–6', () => {
    let s = initialState(tennis);
    for (let i = 0; i < 6; i++) s = play(tennis, game('a') + game('b'), s);
    expect(s.tiebreak).toBe(true);
    s = play(tennis, times('a', 7), s);
    expect(s.games).toEqual([{ a: 7, b: 6 }]);
    expect(s.tiebreak).toBe(false);
  });

  it('two sets wins the match', () => {
    const s = play(tennis, game('a').repeat(12));
    expect(s.matchOver).toBe(true);
    expect(s.winner).toBe('a');
  });
});

describe('goals family', () => {
  it('counts and never ends on a goal', () => {
    const football: ScoringRule = {
      kind: 'goals',
      periods: 2,
      periodMinutes: 45,
      tiebreaker: 'shootout',
      extraPeriodMinutes: null,
    };
    const s = play(football, 'aab');
    expect(s.current).toEqual({ a: 2, b: 1 });
    expect(s.serving).toBeNull();
    expect(s.matchOver).toBe(false);
  });
});

describe('winnerOf — a result entered without a point log (scoring R10)', () => {
  it('accepts a real best-of-three', () => {
    expect(winnerOf([{ a: 11, b: 7 }, { a: 9, b: 11 }, { a: 15, b: 13 }], pickleball)).toBe('a');
  });

  it('rejects a game the engine would have ended earlier', () => {
    expect(() => winnerOf([{ a: 13, b: 7 }, { a: 11, b: 0 }], pickleball)).toThrow(/not a finished game/);
  });

  it('rejects a game played after the match was decided', () => {
    expect(() =>
      winnerOf([{ a: 11, b: 0 }, { a: 11, b: 0 }, { a: 11, b: 0 }], pickleball),
    ).toThrow(/after the match was decided/);
  });

  it('rejects an unfinished match', () => {
    expect(() => winnerOf([{ a: 11, b: 0 }], pickleball)).toThrow(/nobody has won/);
  });

  it('accepts the hard cap', () => {
    expect(winnerOf([{ a: 15, b: 14 }, { a: 11, b: 3 }], pickleball)).toBe('a');
  });

  it('accepts a padel match tiebreak as the deciding set, and only a finished one', () => {
    const padel = PADEL.scoringRule;
    expect(winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 8 }], padel)).toBe('a');
    expect(winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 12, b: 10 }], padel)).toBe('a');
    expect(() => winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 9 }], padel)).toThrow(ScoringInputError);
    expect(() => winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 13, b: 10 }], padel)).toThrow(ScoringInputError);
  });
});

function run(rule: ScoringRule, events: ScoreEvent[], from: ScoreState = initialState(rule)): ScoreState {
  return events.reduce((s, e) => applyEvent(s, e, rule), from);
}
const score = (side: Side, action: string): ScoreEvent => ({ type: 'score', side, action });
const endPeriod: ScoreEvent = { type: 'period_end' };
const kick = (side: Side, scored: boolean): ScoreEvent => ({ type: 'shootout_kick', side, scored });

describe('goals family: typed events', () => {
  const basketball = BASKETBALL.scoringRule;
  const football = FOOTBALL.scoringRule;
  const kabaddi = KABADDI.scoringRule;

  it('scoring R4: an action is worth what the rule says', () => {
    const s = run(basketball, [score('a', 'three'), score('b', 'two'), score('a', 'free_throw')]);
    expect(s.current).toEqual({ a: 4, b: 2 });
  });

  it('scoring R4: an action the rule does not have is refused', () => {
    expect(() => run(football, [score('a', 'three')])).toThrow(ScoringInputError);
  });

  it('a point on a goals rule is its first action (old clients keep working)', () => {
    expect(run(football, [{ type: 'point', side: 'b' }]).current).toEqual({ a: 0, b: 1 });
  });

  it('periods advance, and a lead at the end of regulation ends the match', () => {
    const s = run(basketball, [score('a', 'two'), endPeriod, endPeriod, endPeriod]);
    expect(s.period).toBe(4);
    const over = run(basketball, [endPeriod], s);
    expect(over).toMatchObject({ matchOver: true, winner: 'a' });
  });

  it('basketball: level after regulation plays overtime until someone leads', () => {
    let s = run(basketball, [endPeriod, endPeriod, endPeriod, endPeriod]);
    expect(s).toMatchObject({ period: 5, matchOver: false });
    s = run(basketball, [endPeriod], s); // still level after OT1
    expect(s).toMatchObject({ period: 6, matchOver: false });
    s = run(basketball, [score('b', 'free_throw'), endPeriod], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
  });

  it('football: extra time is a block of two halves; level after the first half plays the second', () => {
    let s = run(football, [endPeriod, endPeriod]); // 0–0 after 90
    expect(s.period).toBe(3);
    s = run(football, [score('a', 'goal'), endPeriod], s); // lead after ET first half: play on
    expect(s).toMatchObject({ period: 4, matchOver: false });
    s = run(football, [endPeriod], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
  });

  it('football: level after extra time goes to a shootout that stops once a side cannot catch up', () => {
    let s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod]);
    expect(s.shootout).toEqual({ a: [], b: [] });
    s = run(football, [kick('a', true), kick('b', false), kick('a', true), kick('b', false), kick('a', true)], s);
    // 3–0 with B on 2 kicks: B can reach at most 3 with 3 left… still alive.
    expect(s.matchOver).toBe(false);
    s = run(football, [kick('b', false)], s); // 3–0, B has 2 left: cannot catch up
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
  });

  it('football: a shootout level after five each goes to sudden death', () => {
    const five = Array.from({ length: 5 }, () => [kick('a', true), kick('b', true)]).flat();
    let s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod, ...five]);
    expect(s.matchOver).toBe(false);
    s = run(football, [kick('a', false), kick('b', true)], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
  });

  it('a shootout kick out of turn is refused', () => {
    const s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod, kick('a', true)]);
    expect(() => run(football, [kick('a', true)], s)).toThrow(ScoringInputError);
  });

  it('either side may take the first kick (the coin toss), and turns alternate from it', () => {
    const level = run(football, [endPeriod, endPeriod, endPeriod, endPeriod]);
    let s = run(football, [kick('b', true)], level);
    expect(s.shootout).toMatchObject({ first: 'b', a: [], b: [true] });
    expect(() => run(football, [kick('b', true)], s)).toThrow(ScoringInputError);
    // B 3 of 4, A 0 of 3: A can reach 2 at most, so B's fourth kick decides it.
    s = run(football, [kick('a', false), kick('b', true), kick('a', false), kick('b', false), kick('a', false), kick('b', true)], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
  });

  it('a shootout stored before the first kicker was recorded is read as A first', () => {
    const level = run(football, [endPeriod, endPeriod, endPeriod, endPeriod]);
    const old = { ...level, shootout: { a: [true], b: [] } } as ScoreState;
    expect(() => run(football, [kick('a', true)], old)).toThrow(ScoringInputError);
    expect(run(football, [kick('b', true)], old).shootout).toMatchObject({ a: [true], b: [true] });
  });

  it('scores are refused during a shootout, and kicks before one', () => {
    const s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod]);
    expect(() => run(football, [score('a', 'goal')], s)).toThrow(ScoringInputError);
    expect(() => run(football, [kick('a', true)])).toThrow(ScoringInputError);
  });

  it('a rule with no tiebreaker: level at full time ends with no winner', () => {
    const noTiebreak = { ...kabaddi, tiebreaker: 'none' as const };
    const s = run(noTiebreak, [score('a', 'raid_2'), score('b', 'super_tackle'), endPeriod, endPeriod]);
    expect(s).toMatchObject({ matchOver: true, winner: null, current: { a: 2, b: 2 } });
  });

  it('seeded kabaddi: level at full time goes to a shootout, not a draw', () => {
    const s = run(kabaddi, [score('a', 'raid_2'), score('b', 'super_tackle'), endPeriod, endPeriod]);
    expect(s).toMatchObject({ matchOver: false, winner: null, shootout: { a: [], b: [] } });
  });

  it('a state stored before periods existed is period 1', () => {
    const old = { ...initialState(basketball) } as ScoreState;
    delete (old as { period?: number }).period;
    expect(run(basketball, [endPeriod], old).period).toBe(2);
  });
});

describe('sets family: match tiebreak (padel)', () => {
  const padel = PADEL.scoringRule;
  const game = (side: Side) => Array.from({ length: 4 }, () => ({ type: 'point', side }) as ScoreEvent);
  const set = (side: Side) => Array.from({ length: 6 }, () => game(side)).flat();

  it('golden point: at 40–40 the next point wins the game', () => {
    const deuce = run(padel, ['a', 'b', 'a', 'b', 'a', 'b'].map((side) => ({ type: 'point', side: side as Side })));
    expect(deuce.points).toEqual({ a: 3, b: 3 });
    expect(run(padel, [{ type: 'point', side: 'b' }], deuce).current).toEqual({ a: 0, b: 1 });
  });

  it('at one set all a match tiebreak to 10, win by 2, decides it', () => {
    let s = run(padel, [...set('a'), ...set('b')]);
    expect(s).toMatchObject({ tiebreak: true, matchTiebreak: true, matchOver: false });
    const pts = (side: Side, n: number) => Array.from({ length: n }, () => ({ type: 'point', side }) as ScoreEvent);
    s = run(padel, [...pts('a', 9), ...pts('b', 9)], s);
    expect(s.matchOver).toBe(false); // 9–9
    s = run(padel, pts('a', 1), s);
    expect(s.matchOver).toBe(false); // 10–9: not 2 clear
    s = run(padel, pts('a', 1), s);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
    expect(s.games.at(-1)).toEqual({ a: 11, b: 9 });
  });
});

describe('rally family: new sports are rules, not branches', () => {
  it('scoring R4: volleyball’s fifth set is to 15', () => {
    const v = VOLLEYBALL.scoringRule;
    const set = (side: Side, n: number) => Array.from({ length: n }, () => ({ type: 'point', side }) as ScoreEvent);
    let s = run(v, [...set('a', 25), ...set('b', 25), ...set('a', 25), ...set('b', 25)]);
    s = run(v, set('a', 15), s);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
  });
});

describe('resultDetail — how a match was won (plan 3)', () => {
  const football = FOOTBALL.scoringRule;
  const end: ScoreEvent = { type: 'period_end' };
  const k = (side: Side, scored: boolean): ScoreEvent => ({ type: 'shootout_kick', side, scored });

  it('a shootout win is method shootout with the kick tally as the margin', () => {
    const s = [end, end, end, end, k('a', true), k('b', false), k('a', true), k('b', false), k('a', true), k('b', false)]
      .reduce((st, e) => applyEvent(st, e, football), initialState(football));
    expect(s.matchOver).toBe(true);
    expect(resultDetail(s)).toEqual({ method: 'shootout', margin: '3–0' });
  });

  it('a win in normal or extra time has no method', () => {
    const s = [{ type: 'score', side: 'a', action: 'goal' } as ScoreEvent, end, end].reduce(
      (st, e) => applyEvent(st, e, football),
      initialState(football),
    );
    expect(resultDetail(s)).toEqual({ method: null, margin: null });
  });
});

describe('innings family (plan 4)', () => {
  // A small rule so a whole match fits in a test: 2 overs of 6, 3 wickets.
  const rule: ScoringRule = {
    kind: 'innings', oversPerInnings: 2, ballsPerOver: 6, wicketsPerInnings: 3, maxOversPerBowler: null,
    extras: { wideRuns: 1, noBallRuns: 1, freeHit: true }, tiebreaker: 'super_over',
  };
  const ball = (runs: number, extra: 'wide' | 'no_ball' | 'bye' | 'leg_bye' | null = null, wicket: string | null = null): ScoreEvent =>
    ({ type: 'ball', runs, extra, wicket }) as ScoreEvent;
  const dots = (n: number) => Array.from({ length: n }, () => ball(0));
  const play = (events: ScoreEvent[], from = initialState(rule, 'a')) => events.reduce((s, e) => applyEvent(s, e, rule), from);

  it('the side named first bats first; runs and legal balls add up', () => {
    const s = play([ball(4), ball(1), ball(6)]);
    expect(s.serving).toBe('a'); // batting
    expect(s.innings?.list[0]).toMatchObject({ batting: 'a', runs: 11, balls: 3, wickets: 0 });
    expect(s.current).toEqual({ a: 11, b: 0 });
  });

  it('a wide and a no-ball give runs, are not legal balls, and the no-ball earns a free hit', () => {
    const s = play([ball(0, 'wide'), ball(4, 'no_ball')]);
    expect(s.innings?.list[0]).toMatchObject({ runs: 6, balls: 0, extras: 2 });
    expect(s.innings?.freeHit).toBe(true);
    expect(() => play([ball(0, null, 'bowled')], s)).toThrow(ScoringInputError);
    const out = play([ball(0, null, 'run_out')], s);
    expect(out.innings?.list[0]).toMatchObject({ wickets: 1, balls: 1 });
    expect(out.innings?.freeHit).toBe(false);
  });

  it('byes and leg byes are legal balls and count as extras', () => {
    const s = play([ball(2, 'bye'), ball(1, 'leg_bye')]);
    expect(s.innings?.list[0]).toMatchObject({ runs: 3, extras: 3, balls: 2 });
  });

  it('the innings ends when the overs run out, and the other side chases runs + 1', () => {
    const s = play([ball(4), ...dots(11)]);
    expect(s.innings?.list).toHaveLength(2);
    expect(s.innings?.list[1]).toMatchObject({ batting: 'b', runs: 0, target: 5 });
    expect(s.serving).toBe('b');
  });

  it('the innings ends when the wickets fall', () => {
    const s = play([ball(0, null, 'bowled'), ball(0, null, 'caught'), ball(0, null, 'lbw')]);
    expect(s.innings?.list).toHaveLength(2);
    expect(s.innings?.list[0]).toMatchObject({ wickets: 3, balls: 3 });
  });

  it('reaching the target wins by the wickets left', () => {
    const s = play([ball(4), ...dots(11), ball(0, null, 'bowled'), ball(6)]);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
    expect(resultDetail(s)).toEqual({ method: 'wickets', margin: '2' });
  });

  it('falling short loses by the runs short', () => {
    const s = play([ball(6), ball(4), ...dots(10), ball(1), ...dots(11)]);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
    expect(resultDetail(s)).toEqual({ method: 'runs', margin: '9' });
  });

  it('a tie goes to a super over — the chasing side bats first — decided like a match', () => {
    let s = play([ball(4), ...dots(11), ball(4), ...dots(11)]);
    expect(s.matchOver).toBe(false);
    expect(s.innings).toMatchObject({ phase: 'super_over' });
    expect(s.serving).toBe('b');
    s = play([ball(6), ...dots(5)], s); // b 6 in the over; a chases 7
    expect(s.innings?.list.at(-1)).toMatchObject({ batting: 'a', target: 7 });
    s = play([ball(0, null, 'bowled'), ball(0, null, 'bowled')], s); // two wickets end a super over
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
    expect(resultDetail(s)).toEqual({ method: 'super_over', margin: null });
  });

  it('with no tiebreaker a tie ends with no winner', () => {
    const tie: ScoringRule = { ...rule, tiebreaker: 'none' } as ScoringRule;
    const s = [ball(4), ...dots(11), ball(4), ...dots(11)].reduce((st, e) => applyEvent(st, e, tie), initialState(tie, 'a'));
    expect(s).toMatchObject({ matchOver: true, winner: null });
  });

  it('a typed result is the two totals: the higher wins, a level score needs the super over', () => {
    expect(winnerOf([{ a: 150, b: 142 }], rule)).toBe('a');
    expect(() => winnerOf([{ a: 150, b: 150 }], rule)).toThrow(ScoringInputError);
  });
});

describe('series family (plan 5)', () => {
  const base = {
    kind: 'series', unitName: 'frame', unitsToWin: 3, maxUnits: null, unitScoring: 'win_only',
    unitPointTarget: null, maxEventsPerUnit: null, allowDraws: false, unitScore: null,
  } as const;
  const race = base as unknown as ScoringRule; // pool: race to 3 racks
  const run = (rule: ScoringRule, events: ScoreEvent[]) => events.reduce((s, e) => applyEvent(s, e, rule), initialState(rule));
  const won = (side: Side, score?: { a: number; b: number }): ScoreEvent => ({ type: 'unit_won', side, score: score ?? null });
  const pts = (side: Side, value: number): ScoreEvent => ({ type: 'points', side, value });

  it('a race to N: units won are counted, the Nth wins the match', () => {
    const s = run(race, [won('a'), won('b'), won('a'), won('a')]);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
    expect(s.games).toEqual([{ a: 1, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 0 }, { a: 1, b: 0 }]);
  });

  it('points units (snooker): points in the frame, the scorer closes it, the higher score takes it', () => {
    const snooker = { ...base, unitScoring: 'points', unitsToWin: 1 } as unknown as ScoringRule;
    let s = run(snooker, [pts('a', 7), pts('b', 4), pts('a', 1)]);
    expect(s.current).toEqual({ a: 8, b: 4 });
    s = applyEvent(s, { type: 'unit_end' }, snooker);
    expect(s).toMatchObject({ matchOver: true, winner: 'a', games: [{ a: 8, b: 4 }] });
    const level = run(snooker, [pts('a', 4), pts('b', 4)]);
    expect(() => applyEvent(level, { type: 'unit_end' }, snooker)).toThrow(ScoringInputError);
  });

  it('a point target ends the unit by itself (billiards to 150)', () => {
    const billiards = { ...base, unitScoring: 'points', unitsToWin: 1, unitPointTarget: 10 } as unknown as ScoringRule;
    const s = run(billiards, [pts('a', 3), pts('b', 9), pts('b', 2)]);
    expect(s).toMatchObject({ matchOver: true, winner: 'b', games: [{ a: 3, b: 11 }] });
  });

  it('carrom: a game ends at the target or after the last board, higher score winning', () => {
    const carrom = { ...base, unitName: 'board', unitScoring: 'points', unitsToWin: 2, unitPointTarget: 25, maxEventsPerUnit: 2 } as unknown as ScoringRule;
    const s = run(carrom, [pts('a', 5), pts('b', 3)]); // two boards: 5–3
    expect(s.games).toEqual([{ a: 5, b: 3 }]);
    expect(s.current).toEqual({ a: 0, b: 0 });
  });

  it('chess: a drawn game is half a point each; a single drawn game is a drawn match', () => {
    const chess = { ...base, unitName: 'game', unitsToWin: 1, maxUnits: 1, allowDraws: true } as unknown as ScoringRule;
    expect(run(chess, [{ type: 'unit_drawn' }])).toMatchObject({ matchOver: true, winner: null, games: [{ a: 0.5, b: 0.5 }] });
    expect(run(chess, [won('b')])).toMatchObject({ matchOver: true, winner: 'b' });
    expect(() => run(race, [{ type: 'unit_drawn' }])).toThrow(ScoringInputError);
  });

  it('esports: a map needs a valid round score (13, or 2 clear in overtime)', () => {
    const maps = { ...base, unitName: 'map', unitsToWin: 2, unitScore: { pointsToWin: 13, winBy: 2 } } as unknown as ScoringRule;
    expect(() => run(maps, [won('a', { a: 13, b: 12 })])).toThrow(ScoringInputError);
    expect(() => run(maps, [won('a')])).toThrow(ScoringInputError);
    const s = run(maps, [won('a', { a: 13, b: 9 }), won('a', { a: 15, b: 13 })]);
    expect(s).toMatchObject({ matchOver: true, winner: 'a', games: [{ a: 13, b: 9 }, { a: 15, b: 13 }] });
  });

  it('a typed series result is its units; the winner is who reached the target', () => {
    expect(winnerOf([{ a: 1, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 0 }, { a: 1, b: 0 }], race)).toBe('a');
    expect(() => winnerOf([{ a: 1, b: 0 }, { a: 1, b: 0 }], race)).toThrow(ScoringInputError);
  });
});

describe('bouts family (plan 6)', () => {
  const judged = {
    kind: 'bouts', rounds: 3, roundSeconds: 180, decision: 'judges', judges: 3, actions: [], pointGap: null,
    roundsToWin: null, firstPointAdvantage: false, penaltyToOpponent: 0, maxPenalties: null,
    finishes: ['ko', 'tko', 'dq'],
  } as unknown as ScoringRule;
  const wrestling = {
    ...(judged as object), rounds: 2, decision: 'points', judges: null, pointGap: 10, penaltyToOpponent: 1, maxPenalties: 3,
    actions: [{ key: 'one', label: '+1', value: 1 }, { key: 'two', label: '+2', value: 2 }, { key: 'four', label: '+4', value: 4 }, { key: 'five', label: '+5', value: 5 }],
    finishes: ['fall', 'injury'],
  } as unknown as ScoringRule;
  const karate = { ...(wrestling as object), rounds: 1, pointGap: 8, penaltyToOpponent: 0, maxPenalties: 5, firstPointAdvantage: true } as unknown as ScoringRule;
  const tkd = { ...(wrestling as object), rounds: 3, roundsToWin: 2, pointGap: 12, maxPenalties: null } as unknown as ScoringRule;

  const run = (rule: ScoringRule, events: ScoreEvent[]) => events.reduce((s, e) => applyEvent(s, e, rule), initialState(rule));
  const sc = (side: Side, action: string): ScoreEvent => ({ type: 'score', side, action });
  const cards = (...c: [number, number][]): ScoreEvent => ({ type: 'round_cards', cards: c.map(([a, b]) => ({ a, b })) });
  const endRound: ScoreEvent = { type: 'round_end' };

  it('judges: 10-point-must cards each round; the totals decide unanimous, split or majority', () => {
    const unanimous = run(judged, [cards([10, 9], [10, 9], [10, 9]), cards([9, 10], [10, 9], [10, 9]), cards([10, 9], [10, 9], [10, 9])]);
    expect(unanimous).toMatchObject({ matchOver: true, winner: 'a' });
    expect(resultDetail(unanimous)).toEqual({ method: 'unanimous_decision', margin: '29–28, 30–27, 30–27' });
    const split = run(judged, [cards([10, 9], [10, 9], [9, 10]), cards([10, 9], [9, 10], [9, 10]), cards([9, 10], [10, 9], [10, 9])]);
    expect(resultDetail(split).method).toBe('split_decision');
    const majority = run(judged, [cards([10, 9], [10, 10], [10, 9]), cards([10, 9], [9, 10], [10, 9]), cards([9, 10], [10, 9], [9, 10])]);
    expect(resultDetail(majority).method).toBe('majority_decision');
  });

  it('judges: a card must have 10 for the round winner, and one per judge', () => {
    expect(() => run(judged, [cards([10, 9], [10, 9])])).toThrow(ScoringInputError);
    expect(() => run(judged, [cards([9, 8], [10, 9], [10, 9])])).toThrow(ScoringInputError);
  });

  it('a finish ends the bout at once with its method and round', () => {
    const s = run(judged, [cards([10, 9], [10, 9], [10, 9]), { type: 'finish', side: 'b', method: 'ko' }]);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
    expect(resultDetail(s)).toEqual({ method: 'ko', margin: 'round 2' });
    expect(() => run(judged, [{ type: 'finish', side: 'a', method: 'fall' }])).toThrow(ScoringInputError);
  });

  it('points: moves score their value; a 10-point lead ends it (technical superiority)', () => {
    const s = run(wrestling, [sc('a', 'four'), sc('a', 'five'), sc('b', 'two'), sc('a', 'two'), sc('a', 'one')]);
    expect(s).toMatchObject({ matchOver: true, winner: 'a', current: { a: 12, b: 2 } });
    expect(resultDetail(s)).toEqual({ method: 'point_gap', margin: '12–2' });
  });

  it('points: a penalty gives the opponent a point, and too many disqualify', () => {
    let s = run(wrestling, [{ type: 'penalty', side: 'a' }]);
    expect(s.current).toEqual({ a: 0, b: 1 });
    s = run(wrestling, [{ type: 'penalty', side: 'a' }, { type: 'penalty', side: 'a' }, { type: 'penalty', side: 'a' }]);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
    expect(resultDetail(s).method).toBe('disqualification');
  });

  it('points: at the end the leader wins; level goes to senshu (first unopposed point) where the rule has it', () => {
    const s = run(wrestling, [sc('b', 'two'), endRound, sc('a', 'one'), endRound]);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
    expect(resultDetail(s)).toEqual({ method: 'points', margin: '1–2' });
    const level = run(karate, [sc('b', 'one'), sc('a', 'one'), endRound]);
    expect(level).toMatchObject({ matchOver: true, winner: 'b' });
    expect(resultDetail(level).method).toBe('senshu');
  });

  it('rounds to win (taekwondo): each round on points, first to two; a gap ends the round', () => {
    let s = run(tkd, [sc('a', 'five'), endRound]);
    expect(s.bout?.roundsWon).toEqual({ a: 1, b: 0 });
    expect(s.current).toEqual({ a: 0, b: 0 });
    s = run(tkd, [sc('a', 'five'), endRound, sc('a', 'five'), sc('a', 'five'), sc('a', 'two')]); // 12 gap ends round 2
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
    expect(resultDetail(s)).toEqual({ method: 'rounds', margin: '2–0' });
  });
});

describe('league and group matches — a level score is a draw', () => {
  it('drawable takes away the knockout tiebreaker and nothing else', () => {
    expect(drawable(FOOTBALL.scoringRule)).toMatchObject({ kind: 'goals', tiebreaker: 'none' });
    expect(drawable(CRICKET.scoringRule)).toMatchObject({ kind: 'innings', tiebreaker: 'none' });
    expect(drawable(PICKLEBALL.scoringRule)).toBe(PICKLEBALL.scoringRule);
    expect(drawable(CHESS.scoringRule)).toBe(CHESS.scoringRule);
  });

  it('a typed level score is a draw in a league, and still refused in a knockout', () => {
    expect(winnerOf([{ a: 1, b: 1 }], drawable(FOOTBALL.scoringRule))).toBeNull();
    expect(() => winnerOf([{ a: 1, b: 1 }], FOOTBALL.scoringRule)).toThrow(/enter the tiebreaker/);
    expect(winnerOf([{ a: 2, b: 1 }], drawable(FOOTBALL.scoringRule))).toBe('a');
  });

  it('a chess match played out level has no winner', () => {
    expect(winnerOf([{ a: 0, b: 0 }], CHESS.scoringRule)).toBeNull();
  });
});
