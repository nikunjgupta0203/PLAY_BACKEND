/**
 * The field engine (plans 7, 8): contests with many entrants — races, lifts,
 * jumps, judged routines, battle royale, and golf, bowling and archery cards.
 */
import { describe, expect, it } from 'vitest';
import {
  applyFieldEvent,
  bowlingTotal,
  FieldInputError,
  initialFieldState,
  qualifiers,
  splitIntoHeats,
  standings,
  type FieldEvent,
  type FieldRule,
} from './field.js';

const run = (rule: FieldRule, events: FieldEvent[], entries = ['e1', 'e2', 'e3']) =>
  events.reduce((s, e) => applyFieldEvent(s, e, rule), initialFieldState(rule, entries));

const race: FieldRule = {
  kind: 'performance', measure: 'time', better: 'lower', attempts: 1, lifts: null, refereeLights: null,
  judges: null, dropHighLow: false, placementPoints: null, perKillPoints: null,
};

describe('performance (plan 7)', () => {
  it('a race: the lowest time wins; DNF and DNS rank after every finisher', () => {
    const s = run(race, [
      { type: 'mark', entry: 'e2', value: 2095 },
      { type: 'mark', entry: 'e1', value: 2180 },
      { type: 'status', entry: 'e3', code: 'DNF' },
    ]);
    expect(standings(s, race).map((r) => [r.entry, r.place, r.value])).toEqual([
      ['e2', 1, 2095],
      ['e1', 2, 2180],
      ['e3', null, null],
    ]);
  });

  it('a race gives one mark per entrant', () => {
    const s = run(race, [{ type: 'mark', entry: 'e1', value: 60 }]);
    expect(() => applyFieldEvent(s, { type: 'mark', entry: 'e1', value: 59 }, race)).toThrow(FieldInputError);
    expect(() => applyFieldEvent(s, { type: 'mark', entry: 'nobody', value: 59 }, race)).toThrow(FieldInputError);
  });

  it('jumps: three attempts, best counts, a foul is no mark, equal bests split on the next best', () => {
    const jump: FieldRule = { ...race, measure: 'distance', better: 'higher', attempts: 3 };
    const s = run(jump, [
      { type: 'attempt', entry: 'e1', lift: null, value: 6.05, valid: true },
      { type: 'attempt', entry: 'e2', lift: null, value: 6.11, valid: false },
      { type: 'attempt', entry: 'e1', lift: null, value: 5.9, valid: true },
      { type: 'attempt', entry: 'e2', lift: null, value: 6.05, valid: true },
      { type: 'attempt', entry: 'e2', lift: null, value: 5.95, valid: true },
    ]);
    const table = standings(s, jump);
    expect(table.map((r) => r.entry)).toEqual(['e2', 'e1', 'e3']);
    expect(table[0]).toMatchObject({ value: 6.05, place: 1 });
    expect(() =>
      [1, 2].reduce((st) => applyFieldEvent(st, { type: 'attempt', entry: 'e2', lift: null, value: 6, valid: true }, jump), s),
    ).toThrow(FieldInputError);
  });

  it('lifting: the total is the best good lift of each; a lift with no good attempt is no total', () => {
    const power: FieldRule = { ...race, measure: 'weight', better: 'higher', attempts: 3, lifts: ['squat', 'bench'], refereeLights: 3 };
    const s = run(power, [
      { type: 'attempt', entry: 'e1', lift: 'squat', value: 140, valid: true },
      { type: 'attempt', entry: 'e1', lift: 'squat', value: 150, valid: false },
      { type: 'attempt', entry: 'e1', lift: 'bench', value: 80, valid: true },
      { type: 'attempt', entry: 'e2', lift: 'squat', value: 160, valid: true },
      { type: 'attempt', entry: 'e2', lift: 'bench', value: 90, valid: false },
    ]);
    expect(standings(s, power).map((r) => [r.entry, r.value])).toEqual([
      ['e1', 220],
      ['e2', null],
      ['e3', null],
    ]);
    expect(() => applyFieldEvent(s, { type: 'attempt', entry: 'e1', lift: 'deadlift', value: 1, valid: true }, power)).toThrow(
      FieldInputError,
    );
  });

  it('judged: the panel’s scores with the highest and lowest dropped, averaged', () => {
    const judged: FieldRule = { ...race, measure: 'judged', better: 'higher', judges: 5, dropHighLow: true };
    const s = run(judged, [
      { type: 'judge_scores', entry: 'e1', scores: [8.6, 8.9, 8.4, 9.3, 8.7] },
      { type: 'judge_scores', entry: 'e2', scores: [8.5, 8.2, 8.6, 8.3, 8.4] },
    ]);
    expect(standings(s, judged).slice(0, 2).map((r) => [r.entry, r.value])).toEqual([
      ['e1', 8.73],
      ['e2', 8.4],
    ]);
    expect(() => applyFieldEvent(s, { type: 'judge_scores', entry: 'e3', scores: [9, 9] }, judged)).toThrow(FieldInputError);
  });

  it('battle royale: placement points plus kills, summed over matches', () => {
    const br: FieldRule = { ...race, measure: 'points', better: 'higher', placementPoints: [10, 6, 5], perKillPoints: 1 };
    const s = run(br, [
      { type: 'placement', entry: 'e1', place: 2, kills: 4 },
      { type: 'placement', entry: 'e2', place: 1, kills: 1 },
      { type: 'placement', entry: 'e1', place: 1, kills: 3 },
    ]);
    expect(standings(s, br).map((r) => [r.entry, r.value])).toEqual([
      ['e1', 23],
      ['e2', 11],
      ['e3', null],
    ]);
  });
});

describe('scorecard (plan 8)', () => {
  it('golf: strokes per hole, lowest total wins, shown against par', () => {
    const golf: FieldRule = { kind: 'scorecard', method: 'strokes', units: 3, par: [4, 3, 5], arrowsPerEnd: null };
    const s = run(golf, [
      { type: 'card', entry: 'e1', values: [4] },
      { type: 'card', entry: 'e1', values: [2] },
      { type: 'card', entry: 'e2', values: [5] },
    ]);
    const table = standings(s, golf);
    expect(table[0]).toMatchObject({ entry: 'e1', value: 6, display: '−1 thru 2' });
    expect(table[1]).toMatchObject({ entry: 'e2', value: 5, display: '+1 thru 1' });
    const done = run(golf, [{ type: 'card', entry: 'e1', values: [4] }, { type: 'card', entry: 'e1', values: [3] }, { type: 'card', entry: 'e1', values: [5] }]);
    expect(() => applyFieldEvent(done, { type: 'card', entry: 'e1', values: [4] }, golf)).toThrow(FieldInputError);
  });

  it('bowling: strikes and spares score their bonus rolls; a perfect game is 300', () => {
    expect(bowlingTotal(Array.from({ length: 12 }, () => 10))).toBe(300);
    expect(bowlingTotal([10, 7, 3, 9, 0, 10, 10, 8, 1])).toBe(104);
    const bowl: FieldRule = { kind: 'scorecard', method: 'tenpin', units: 10, par: null, arrowsPerEnd: null };
    const s = run(bowl, [{ type: 'card', entry: 'e1', values: [7] }]);
    expect(() => applyFieldEvent(s, { type: 'card', entry: 'e1', values: [4] }, bowl)).toThrow(FieldInputError); // 7 + 4 > 10
    expect(standings(run(bowl, [{ type: 'card', entry: 'e1', values: [10, 7, 3, 9, 0] }]), bowl)[0]).toMatchObject({ value: 48 });
  });

  it('archery: an end of arrows (X is 10, M is 0); ties split on 10s then Xs', () => {
    const arch: FieldRule = { kind: 'scorecard', method: 'ends', units: 6, par: null, arrowsPerEnd: 3 };
    const X = 11;
    const s = run(arch, [
      { type: 'card', entry: 'e1', values: [10, 10, 8] },
      { type: 'card', entry: 'e2', values: [X, 9, 8] },
    ]);
    expect(standings(s, arch).slice(0, 2).map((r) => [r.entry, r.value])).toEqual([
      ['e1', 28],
      ['e2', 27],
    ]);
    expect(() => applyFieldEvent(s, { type: 'card', entry: 'e3', values: [10, 10] }, arch)).toThrow(FieldInputError);
  });
});

describe('heats to a final', () => {
  const mark = (entry: string, value: number): FieldEvent => ({ type: 'mark', entry, value });
  const heat1 = run(race, [mark('a1', 10.1), mark('a2', 10.4), mark('a3', 10.9), mark('a4', 11.5)], ['a1', 'a2', 'a3', 'a4']);
  const heat2 = run(
    race,
    [mark('b1', 10.2), mark('b2', 10.6), mark('b3', 10.7), { type: 'status', entry: 'b4', code: 'DNF' }],
    ['b1', 'b2', 'b3', 'b4'],
  );

  it('splits entries into heats serpentine, so each heat gets a fair share of the order', () => {
    expect(splitIntoHeats(['1', '2', '3', '4', '5', '6', '7'], 3)).toEqual([['1', '6', '7'], ['2', '5'], ['3', '4']]);
    expect(splitIntoHeats(['1', '2'], 5)).toEqual([['1'], ['2']]);
  });

  it('the top places of every heat go through (Q), then the best of the rest across heats (q), best first', () => {
    expect(qualifiers([heat1, heat2], race, { perHeat: 2, best: 0 })).toEqual(['a1', 'b1', 'a2', 'b2']);
    // b3 (10.7) beats a3 (10.9) for the one fastest-loser place; b4 did not finish.
    expect(qualifiers([heat1, heat2], race, { perHeat: 2, best: 1 })).toEqual(['a1', 'b1', 'a2', 'b2', 'b3']);
    expect(qualifiers([heat1, heat2], race, { perHeat: 3, best: 5 })).toEqual(['a1', 'b1', 'a2', 'b2', 'b3', 'a3', 'a4']);
  });

  it('higher is better where the rule says so', () => {
    const jump: FieldRule = { ...race, measure: 'distance', better: 'higher' };
    const h = run(jump, [mark('a1', 6.1), mark('a2', 7.2)], ['a1', 'a2']);
    expect(qualifiers([h], jump, { perHeat: 1, best: 0 })).toEqual(['a2']);
  });
});
