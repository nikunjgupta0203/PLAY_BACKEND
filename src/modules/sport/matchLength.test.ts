import { describe, expect, it } from 'vitest';
import { typicalMatchMinutes } from './service/matchLength.js';

describe('N12 — typical match length per format', () => {
  it('a best-of-3 pickleball match to 11 is about half an hour', () => {
    expect(typicalMatchMinutes({ kind: 'rally', pointsToWin: 11, gamesToWin: 2 })).toBe(35);
  });

  it('one game to 15 is short', () => {
    expect(typicalMatchMinutes({ kind: 'rally', pointsToWin: 15, gamesToWin: 1 })).toBe(20);
  });

  it('a full football match counts both halves and half-time', () => {
    expect(typicalMatchMinutes({ kind: 'goals', periods: 2, periodMinutes: 45 })).toBe(115);
  });

  it('5-a-side with 10-minute halves fits in half an hour', () => {
    expect(typicalMatchMinutes({ kind: 'goals', periods: 2, periodMinutes: 10 })).toBe(35);
  });

  it('a T20 takes about three hours, box cricket about 70 minutes', () => {
    expect(typicalMatchMinutes({ kind: 'innings', oversPerInnings: 20 })).toBe(180);
    expect(typicalMatchMinutes({ kind: 'innings', oversPerInnings: 6 })).toBe(70);
  });

  it('a one-day match is capped at eight hours', () => {
    expect(typicalMatchMinutes({ kind: 'innings', oversPerInnings: 50 })).toBe(420);
  });

  it('a race or a scorecard falls back to 45 — it is never booked as a match', () => {
    expect(typicalMatchMinutes({ kind: 'performance' })).toBe(45);
    expect(typicalMatchMinutes(null)).toBe(45);
  });
});
