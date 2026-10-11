/**
 * scoring — the casual judge (games R14), tested without a database.
 *
 * Rules come from the SEED, like the engine's own tests, so this cannot agree
 * with a judge that has drifted from the sports it will actually score.
 */
import { describe, expect, it } from 'vitest';
import { BOXING, CHESS, CRICKET, FOOTBALL, PADEL, PICKLEBALL, POOL, RUNNING, SNOOKER, TENNIS } from '../sport/seed.js';
import type { ScoringRule } from '../sport/index.js';
import { casualWinnerOf, ScoringInputError, winnerOf } from './engine.js';

const rule = (seed: { scoringRule: unknown }) => seed.scoringRule as ScoringRule;

describe('casualWinnerOf — a casual result, held to the sport one unit at a time', () => {
  it('games R14: a rally game must be a finished game, but one game is a match', () => {
    const pickleball = rule(PICKLEBALL);
    expect(casualWinnerOf([{ a: 11, b: 8 }], pickleball)).toBe('a');
    expect(casualWinnerOf([{ a: 10, b: 12 }], pickleball)).toBe('b');
    // The full-format judge refuses the same score: nobody has won two games.
    expect(() => winnerOf([{ a: 11, b: 8 }], pickleball)).toThrow(ScoringInputError);

    expect(() => casualWinnerOf([{ a: 11, b: 10 }], pickleball)).toThrow(/not a finished game/);
    expect(() => casualWinnerOf([{ a: 13, b: 7 }], pickleball)).toThrow(/not a finished game/);
    expect(() => casualWinnerOf([{ a: 8, b: 8 }], pickleball)).toThrow(/has no winner/);
    expect(() => casualWinnerOf([], pickleball)).toThrow(/needs a score/);
    expect(() => casualWinnerOf([{ a: 11.5, b: 8 }], pickleball)).toThrow(/whole numbers/);
  });

  it('games R14: the side with more games wins, level is a draw, and the deciding game keeps its own length', () => {
    const pickleball = rule(PICKLEBALL);
    expect(casualWinnerOf([{ a: 11, b: 8 }, { a: 11, b: 6 }], pickleball)).toBe('a');
    expect(casualWinnerOf([{ a: 11, b: 8 }, { a: 6, b: 11 }], pickleball)).toBeNull();
    // Game three is the decider, to 15 in this rule.
    expect(casualWinnerOf([{ a: 11, b: 8 }, { a: 6, b: 11 }, { a: 15, b: 13 }], pickleball)).toBe('a');
    expect(() => casualWinnerOf([{ a: 11, b: 8 }, { a: 6, b: 11 }, { a: 11, b: 9 }], pickleball)).toThrow(/game 3/);
    // Never more games than the format can hold.
    expect(() =>
      casualWinnerOf([{ a: 11, b: 8 }, { a: 6, b: 11 }, { a: 15, b: 13 }, { a: 11, b: 1 }], pickleball),
    ).toThrow(/at most 3 games/);
  });

  it('games R14: sets are finished sets, by two games, a tiebreak, or a match tiebreak', () => {
    const tennis = rule(TENNIS);
    expect(casualWinnerOf([{ a: 6, b: 4 }], tennis)).toBe('a');
    expect(casualWinnerOf([{ a: 6, b: 7 }, { a: 7, b: 5 }], tennis)).toBeNull();
    expect(() => casualWinnerOf([{ a: 6, b: 5 }], tennis)).toThrow(/not a finished set/);
    // Padel plays a match tiebreak to 10 in place of the third set.
    expect(casualWinnerOf([{ a: 6, b: 3 }, { a: 4, b: 6 }, { a: 10, b: 8 }], rule(PADEL))).toBe('a');
  });

  it('games R14: a final score wins on the total, and a level one is a draw', () => {
    expect(casualWinnerOf([{ a: 3, b: 1 }], rule(FOOTBALL))).toBe('a');
    expect(casualWinnerOf([{ a: 2, b: 2 }], rule(FOOTBALL))).toBeNull();
    expect(casualWinnerOf([{ a: 142, b: 156 }], rule(CRICKET))).toBe('b');
    expect(casualWinnerOf([{ a: 28, b: 29 }], rule(BOXING))).toBe('b');
  });

  it('games R14: a race of units counts them; a unit can be level only where the sport allows', () => {
    const pool = rule(POOL);
    const racks = (a: number, b: number) => [
      ...Array.from({ length: a }, () => ({ a: 1, b: 0 })),
      ...Array.from({ length: b }, () => ({ a: 0, b: 1 })),
    ];
    expect(casualWinnerOf(racks(3, 1), pool)).toBe('a');
    expect(casualWinnerOf(racks(2, 2), pool)).toBeNull();
    expect(() => casualWinnerOf([{ a: 0, b: 0 }], pool)).toThrow(/has no winner/);
    // A chess game may be drawn.
    expect(casualWinnerOf([{ a: 0, b: 0 }], rule(CHESS))).toBeNull();
    expect(casualWinnerOf([{ a: 1, b: 0 }], rule(CHESS))).toBe('a');
    // Snooker frames are entered with their points.
    expect(casualWinnerOf([{ a: 64, b: 31 }, { a: 12, b: 70 }, { a: 55, b: 48 }], rule(SNOOKER))).toBe('a');
  });

  it('games R14: a sport scored in heats has no match result', () => {
    expect(() => casualWinnerOf([{ a: 1, b: 0 }], rule(RUNNING))).toThrow(/heats, not matches/);
  });
});
