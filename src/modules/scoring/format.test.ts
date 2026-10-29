/**
 * scoring — the match format players choose for a casual match (games R18),
 * tested without a database against the seeded rules.
 */
import { describe, expect, it } from 'vitest';
import { CHESS, FOOTBALL, PICKLEBALL, POOL, TENNIS, VOLLEYBALL } from '../sport/seed.js';
import type { ScoringRule } from '../sport/index.js';
import { casualWinnerOf, checkFormat, defaultFormat, formatOptions, withFormat, type MatchFormat } from './engine.js';

const rule = (seed: { scoringRule: unknown }) => seed.scoringRule as ScoringRule;
const judge = (r: ScoringRule, f: MatchFormat, units: { a: number; b: number }[]) => casualWinnerOf(units, withFormat(r, f), f);

describe('match format — the players choose the points and the number of games', () => {
  it('starts from the sport’s usual format', () => {
    expect(defaultFormat(rule(PICKLEBALL))).toEqual({ pointsToWin: 11, games: 3, bestOf: true });
    expect(defaultFormat(rule(TENNIS))).toMatchObject({ games: 3, bestOf: true });
    expect(defaultFormat(rule(CHESS))).toEqual({ pointsToWin: null, games: 1, bestOf: false });
    expect(defaultFormat(rule(FOOTBALL))).toBeNull();
    expect(formatOptions(rule(FOOTBALL))).toBeNull();
    expect(formatOptions(rule(POOL))).toEqual({ points: false });
  });

  it('issue #2: there is no points cap — a game is won at the target by two, however long it runs', () => {
    const pickleball = rule(PICKLEBALL);
    const usual = defaultFormat(pickleball)!;
    // The sport's rule caps a game at 15; a casual match does not.
    expect(judge(pickleball, usual, [{ a: 17, b: 15 }])).toBe('a');
    expect(() => judge(pickleball, usual, [{ a: 18, b: 15 }])).toThrow(/not a finished game/);
  });

  it('issue #2: score entry is held to the points the players chose', () => {
    const pickleball = rule(PICKLEBALL);
    const to15: MatchFormat = { pointsToWin: 15, games: 1, bestOf: true };
    expect(judge(pickleball, to15, [{ a: 15, b: 9 }])).toBe('a');
    expect(() => judge(pickleball, to15, [{ a: 11, b: 9 }])).toThrow(/not a finished game/);
    const to21: MatchFormat = { pointsToWin: 21, games: 3, bestOf: true };
    expect(judge(pickleball, to21, [{ a: 21, b: 19 }, { a: 18, b: 21 }, { a: 21, b: 10 }])).toBe('a');
  });

  it('issue #3: best of N stops once a side has won most; play exactly N may end level', () => {
    const pickleball = rule(PICKLEBALL);
    const bestOf5: MatchFormat = { pointsToWin: 11, games: 5, bestOf: true };
    expect(judge(pickleball, bestOf5, [{ a: 11, b: 3 }, { a: 11, b: 4 }, { a: 11, b: 5 }])).toBe('a');
    expect(() =>
      judge(pickleball, bestOf5, [{ a: 11, b: 3 }, { a: 11, b: 4 }, { a: 11, b: 5 }, { a: 3, b: 11 }]),
    ).toThrow(/after the match was decided/);

    const exactly4: MatchFormat = { pointsToWin: 11, games: 4, bestOf: false };
    expect(judge(pickleball, exactly4, [{ a: 11, b: 3 }, { a: 11, b: 4 }, { a: 3, b: 11 }, { a: 4, b: 11 }])).toBeNull();
    expect(judge(pickleball, exactly4, [{ a: 11, b: 3 }, { a: 11, b: 4 }, { a: 11, b: 5 }, { a: 4, b: 11 }])).toBe('a');
    expect(() => judge(pickleball, exactly4, Array.from({ length: 5 }, () => ({ a: 11, b: 2 })))).toThrow(/at most 4 games/);
  });

  it('keeps volleyball’s shorter deciding set only while the target is the sport’s own', () => {
    const volleyball = rule(VOLLEYBALL);
    const usual = defaultFormat(volleyball)!;
    expect(withFormat(volleyball, usual)).toMatchObject({ decidingGame: { pointsToWin: 15 } });
    expect(withFormat(volleyball, { ...usual, pointsToWin: 21 })).not.toHaveProperty('decidingGame');
  });

  it('tennis: the chosen number is games per set', () => {
    const tennis = rule(TENNIS);
    const fast4: MatchFormat = { pointsToWin: 4, games: 3, bestOf: true };
    expect(judge(tennis, fast4, [{ a: 4, b: 2 }, { a: 4, b: 1 }])).toBe('a');
    expect(() => judge(tennis, fast4, [{ a: 3, b: 1 }])).toThrow(/not a finished set/);
    // The usual six-game set is not finished at 4–1 any more than it was before.
    expect(() => judge(tennis, defaultFormat(tennis)!, [{ a: 4, b: 1 }])).toThrow(/not a finished set/);
  });

  it('refuses numbers that do not make a match', () => {
    const pickleball = rule(PICKLEBALL);
    expect(() => checkFormat(pickleball, { pointsToWin: 0, games: 3, bestOf: true })).toThrow(/points to win/);
    expect(() => checkFormat(pickleball, { pointsToWin: 11, games: 0, bestOf: true })).toThrow(/number of games/);
    expect(() => checkFormat(rule(FOOTBALL), { pointsToWin: null, games: 1, bestOf: true })).toThrow(/one final score/);
    // Points that do not apply are dropped, not refused.
    expect(checkFormat(rule(POOL), { pointsToWin: 7, games: 9, bestOf: true })).toEqual({ pointsToWin: null, games: 9, bestOf: true });
  });
});
