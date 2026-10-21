import { describe, expect, it } from 'vitest';
import { analyticsFrom, istDate, type AnalyticsRow } from '../src/modules/profile/service/analytics.js';

const NOW = new Date('2026-10-21T06:30:00Z'); // Wednesday 12:00 IST
const DAY = 86_400_000;

let n = 0;
const row = (daysAgo: number, won: boolean, over: Partial<AnalyticsRow> = {}): AnalyticsRow => ({
  matchId: `m${String(++n).padStart(3, '0')}`,
  eventId: null,
  partnerIds: [],
  opponentIds: ['o1'],
  won,
  outcome: 'played',
  games: won ? [{ for: 11, against: 7 }] : [{ for: 7, against: 11 }],
  completedAt: new Date(NOW.getTime() - daysAgo * DAY),
  ...over,
});

describe('analyticsFrom (profile R16)', () => {
  it('R16: counts only the period, and compares with the period before it', () => {
    const rows = [row(5, true), row(10, false), row(40, true), row(100, false), row(120, false)];
    const a = analyticsFrom(rows, { now: NOW, days: 90 });
    expect([a.played, a.wins, a.losses]).toEqual([3, 2, 1]);
    expect(a.winRate).toBeCloseTo(2 / 3);
    expect(a.previousWinRate).toBe(0);
    expect(a.allTimeMatches).toBe(5);

    const all = analyticsFrom(rows, { now: NOW, days: null });
    expect(all.played).toBe(5);
    expect(all.since).toBeNull();
    expect(all.previousWinRate).toBeNull();
  });

  it('R16: an empty history has no rates, not zero', () => {
    const a = analyticsFrom([], { now: NOW, days: 30 });
    expect(a.winRate).toBeNull();
    expect(a.previousWinRate).toBeNull();
    expect(a.currentStreak).toBe(0);
    expect(a.months).toHaveLength(6);
    expect(a.weekdays).toHaveLength(7);
    expect(a.margins).toEqual(Array(16).fill(0));
  });

  it('R16: streaks are signed from the newest match, best streak is all time', () => {
    const rows = [row(9, true), row(8, true), row(7, true), row(6, false), row(2, true), row(1, true)];
    const a = analyticsFrom(rows, { now: NOW, days: 30 });
    expect(a.currentStreak).toBe(2);
    expect(a.bestWinStreak).toBe(3);
    expect(analyticsFrom([row(2, true), row(1, false), row(0, false)], { now: NOW, days: 30 }).currentStreak).toBe(-2);
  });

  it('R16: form is the last ten, oldest first', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(12 - i, i % 3 !== 0));
    const a = analyticsFrom(rows, { now: NOW, days: 30 });
    expect(a.form).toEqual(rows.slice(-10).map((r) => r.won));
  });

  it('R16: splits singles from doubles and counts events once', () => {
    const rows = [
      row(1, true, { partnerIds: ['p1'], eventId: 'e1' }),
      row(2, false, { partnerIds: ['p1'], eventId: 'e1' }),
      row(3, true, { eventId: 'e2' }),
    ];
    const a = analyticsFrom(rows, { now: NOW, days: 30 });
    expect(a.doubles).toEqual({ played: 2, wins: 1 });
    expect(a.singles).toEqual({ played: 1, wins: 1 });
    expect(a.events).toBe(2);
    expect(a.partners).toEqual([{ playerId: 'p1', played: 2, wins: 1 }]);
    expect(a.opponents).toEqual([{ playerId: 'o1', played: 3, wins: 2 }]);
  });

  it('R16: deciders, close games and margins come from the game scores', () => {
    const rows = [
      row(1, true, { games: [{ for: 11, against: 9 }, { for: 5, against: 11 }, { for: 12, against: 10 }] }),
      row(2, false, { games: [{ for: 2, against: 11 }, { for: 10, against: 11 }] }),
      row(3, true, { outcome: 'walkover', games: [] }),
    ];
    const a = analyticsFrom(rows, { now: NOW, days: 30 });
    expect(a.deciders).toEqual({ played: 1, wins: 1 });
    expect(a.closeGames).toEqual({ played: 3, wins: 2 });
    expect(a.outcomes).toEqual({ played: 2, walkover: 1, retired: 0, forfeit: 0 });
    // won by 2 twice → bucket 9; lost by 6 → 2; lost by 9 → 0 (8+); lost by 1 → 7.
    expect(a.margins[9]).toBe(2);
    expect(a.margins[2]).toBe(1);
    expect(a.margins[0]).toBe(1);
    expect(a.margins[7]).toBe(1);
    expect(a.margins.reduce((s, x) => s + x, 0)).toBe(5);
  });

  it('R16: days and weekdays are IST', () => {
    // 20:00 UTC on a Tuesday is 01:30 Wednesday in IST.
    const late = new Date('2026-10-20T20:00:00Z');
    const a = analyticsFrom([row(0, true, { completedAt: late })], { now: NOW, days: 30 });
    expect(istDate(late)).toBe('2026-10-21');
    expect(a.activity).toEqual([{ date: '2026-10-21', matches: 1 }]);
    expect(a.weekdays.find((d) => d.played > 0)?.weekday).toBe(3);
  });

  it('R16: months are the last six calendar months, whatever the period', () => {
    const rows = [row(0, true), row(35, false), row(400, true)];
    const a = analyticsFrom(rows, { now: NOW, days: 30 });
    expect(a.months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(a.months.at(-1)).toEqual({ month: '2026-10', played: 1, wins: 1 });
    expect(a.months.at(-2)).toEqual({ month: '2026-09', played: 1, wins: 0 });
  });
});
