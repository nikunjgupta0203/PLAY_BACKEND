import { describe, expect, it } from 'vitest';
import { seedPositions } from './draw.js';
import { groupCountFor, knockoutSeeding, leagueTable, planGroups, roundRobin, type TableRow } from './league.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i + 1}`);

describe('roundRobin', () => {
  for (const n of [3, 4, 5, 6, 7, 8]) {
    it(`${n} entries: every pair meets exactly once, nobody twice on a matchday`, () => {
      const fixtures = roundRobin(ids(n));
      expect(fixtures).toHaveLength((n * (n - 1)) / 2);
      const pairs = new Set(fixtures.map((f) => [f.a, f.b].sort().join('-')));
      expect(pairs.size).toBe(fixtures.length);
      const days = new Map<number, string[]>();
      for (const f of fixtures) days.set(f.round, [...(days.get(f.round) ?? []), f.a, f.b]);
      for (const playing of days.values()) expect(new Set(playing).size).toBe(playing.length);
      expect(days.size).toBe(n % 2 === 0 ? n - 1 : n);
    });
  }
});

describe('groups', () => {
  it('about four to a group, never fewer than two', () => {
    expect([6, 8, 10, 12, 16].map(groupCountFor)).toEqual([2, 2, 2, 3, 4]);
  });

  it('deals the seeds serpentine', () => {
    expect(planGroups(ids(8), 2)).toEqual([['e1', 'e4', 'e5', 'e8'], ['e2', 'e3', 'e6', 'e7']]);
  });
});

describe('leagueTable', () => {
  const [a, b, c] = ['a', 'b', 'c'];

  it('3 for a win, 1 for a draw; then difference, then scored', () => {
    const table = leagueTable([a, b, c], [
      { a, b, winner: a, tallyA: 2, tallyB: 0 },
      { a: b, b: c, winner: null, tallyA: 1, tallyB: 1 },
      { a, b: c, winner: null, tallyA: 0, tallyB: 0 },
    ]);
    expect(table.map((r) => [r.registrationId, r.points, r.won, r.drawn, r.lost, r.scoreFor - r.scoreAgainst])).toEqual([
      [a, 4, 1, 1, 0, 2],
      [c, 2, 0, 2, 0, 0],
      [b, 1, 0, 1, 1, -2],
    ]);
    expect(table.map((r) => r.place)).toEqual([1, 2, 3]);
  });

  it('level on points, difference and scored: the match between them decides, then the seeding', () => {
    const level = leagueTable([a, b, c], [
      { a, b, winner: b, tallyA: 1, tallyB: 2 },
      { a, b: c, winner: a, tallyA: 2, tallyB: 1 },
      { a: b, b: c, winner: c, tallyA: 1, tallyB: 2 },
    ]);
    // All on 3 points, difference 0, scored 3: a three-way head-to-head is level too, so seeding.
    expect(level.map((r) => r.registrationId)).toEqual([a, b, c]);
    const two = leagueTable([a, b], [{ a, b, winner: b, tallyA: 0, tallyB: 0 }]);
    expect(two[0]!.registrationId).toBe(b);
  });
});

describe('knockoutSeeding', () => {
  const table = (...names: string[]): TableRow[] =>
    names.map((registrationId, i) => ({
      registrationId, place: i + 1, played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0,
    }));
  const firstRound = (order: string[]) => {
    const size = 2 ** Math.ceil(Math.log2(Math.max(4, order.length)));
    const pos = seedPositions(size);
    const out: string[][] = [];
    for (let i = 0; i < pos.length; i += 2) out.push([order[pos[i]! - 1] ?? '-', order[pos[i + 1]! - 1] ?? '-']);
    return out;
  };

  for (const groups of [2, 3, 4]) {
    it(`${groups} groups: winners seeded first, no group rematch in round one`, () => {
      const letters = 'ABCD'.slice(0, groups).split('');
      const order = knockoutSeeding(letters.map((g) => table(`${g}1`, `${g}2`, `${g}3`)));
      expect(order.slice(0, groups)).toEqual(letters.map((g) => `${g}1`));
      expect(order).toHaveLength(groups * 2);
      for (const [x, y] of firstRound(order)) {
        if (x && y && x !== '-' && y !== '-') expect(x[0]).not.toBe(y[0]);
      }
    });
  }
});
