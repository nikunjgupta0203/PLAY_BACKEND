import { describe, expect, it } from 'vitest';
import { badgesFromHistory, type BadgeHistoryRow } from '../src/modules/profile/service/badges.js';

const row = (won: boolean, over: Partial<BadgeHistoryRow> = {}): BadgeHistoryRow => ({
  won,
  sportId: 'pickleball',
  eventId: null,
  ...over,
});

const keys = (rows: BadgeHistoryRow[]) => badgesFromHistory(rows).map((b) => b.key);

describe('badgesFromHistory (profile R11)', () => {
  it('earns nothing from no matches or only losses', () => {
    expect(keys([])).toEqual([]);
    expect(keys([row(false), row(false)])).toEqual([]);
  });

  it('first win carries the sport of the match that earned it', () => {
    expect(badgesFromHistory([row(false), row(true, { sportId: 'badminton' })])).toEqual([
      { key: 'first_win', sportId: 'badminton' },
    ]);
  });

  it('counts wins across sports for 5 and 10 wins', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(true, { sportId: i % 2 ? 'badminton' : 'pickleball' }));
    expect(keys(rows)).toEqual(['first_win', 'streak_3', 'five_wins', 'streak_5', 'ten_wins']);
  });

  it('a loss resets the streak', () => {
    expect(keys([row(true), row(true), row(false), row(true), row(true)])).toEqual(['first_win']);
    expect(keys([row(true), row(true), row(false), row(true), row(true), row(true)])).toContain('streak_3');
  });

  it('first tournament comes from the first match played in an event, won or lost', () => {
    expect(badgesFromHistory([row(false), row(false, { eventId: 'e1', sportId: 'badminton' })])).toEqual([
      { key: 'first_tournament', sportId: 'badminton' },
    ]);
  });
});
