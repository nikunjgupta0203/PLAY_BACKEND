/**
 * tournament — the draw, tested without a database.
 *
 * Draw generation is the one piece of this module that is pure, and it is also
 * the piece where a mistake is invisible until a Saturday morning: a bracket
 * that looks plausible, wires two players into the same slot, and strands the
 * Plate. The checklist asks for sizes 4, 8, 16, 32 and non-powers-of-two with
 * byes; the properties below are asserted for all of them at once rather than
 * spot-checked, because "no unfilled slots" is a statement about every position
 * in the draw, not about a sample.
 */
import { describe, expect, it } from 'vitest';
import {
  bracketSizeFor,
  isBye,
  planDraw,
  seedEntries,
  seedPositions,
  type DrawEntry,
  type PlannedMatch,
} from './draw.js';

const BASE = new Date('2026-09-01T00:00:00.000Z');

/** n entries, rated so that entry i is the i-th seed. */
function entries(n: number): DrawEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    registrationId: `reg-${String(i + 1).padStart(2, '0')}`,
    rating: 2000 - i,
    confirmedAt: new Date(BASE.getTime() + i * 1000),
  }));
}

const key = (m: PlannedMatch): string => `${m.bracket}:${m.round}:${m.slot}`;

describe('seedPositions (R4)', () => {
  it('R4: places seeds so the top two can only meet in the final', () => {
    expect(seedPositions(4)).toEqual([1, 4, 2, 3]);
    expect(seedPositions(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedPositions(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]);
  });

  it('R4: every first-round pair sums to size + 1', () => {
    for (const size of [4, 8, 16, 32, 64]) {
      const order = seedPositions(size);
      expect(order).toHaveLength(size);
      expect(new Set(order).size).toBe(size);
      for (let i = 0; i < size; i += 2) {
        expect(order[i]! + order[i + 1]!).toBe(size + 1);
      }
    }
  });

  it('R4: seed 1 and seed 2 are in opposite halves at every size', () => {
    for (const size of [4, 8, 16, 32, 64]) {
      const order = seedPositions(size);
      expect(order.indexOf(1)).toBeLessThan(size / 2);
      expect(order.indexOf(2)).toBeGreaterThanOrEqual(size / 2);
    }
  });
});

describe('seedEntries (R2)', () => {
  it('R2: settled rating descending', () => {
    const seeded = seedEntries([
      { registrationId: 'c', rating: 1500, confirmedAt: BASE },
      { registrationId: 'a', rating: 1900, confirmedAt: BASE },
      { registrationId: 'b', rating: 1700, confirmedAt: BASE },
    ]);
    expect(seeded.map((s) => s.registrationId)).toEqual(['a', 'b', 'c']);
    expect(seeded.map((s) => s.seed)).toEqual([1, 2, 3]);
  });

  it('R2: unrated entries sort last, whatever order they arrive in', () => {
    const seeded = seedEntries([
      { registrationId: 'unrated-1', rating: null, confirmedAt: BASE },
      { registrationId: 'rated', rating: 1200, confirmedAt: new Date(BASE.getTime() + 5000) },
      { registrationId: 'unrated-2', rating: null, confirmedAt: new Date(BASE.getTime() + 10) },
    ]);
    expect(seeded.map((s) => s.registrationId)).toEqual(['rated', 'unrated-1', 'unrated-2']);
  });

  it('R2: a tie is broken by confirmation time, so the draw is reproducible', () => {
    const tied: DrawEntry[] = [
      { registrationId: 'late', rating: 1600, confirmedAt: new Date(BASE.getTime() + 1000) },
      { registrationId: 'early', rating: 1600, confirmedAt: BASE },
    ];
    expect(seedEntries(tied).map((s) => s.registrationId)).toEqual(['early', 'late']);
    // Same input, opposite arrival order, same answer.
    expect(seedEntries([...tied].reverse()).map((s) => s.registrationId)).toEqual([
      'early',
      'late',
    ]);
  });

  it('R2: entries confirmed in the same millisecond still order deterministically', () => {
    const same: DrawEntry[] = [
      { registrationId: 'b', rating: null, confirmedAt: BASE },
      { registrationId: 'a', rating: null, confirmedAt: BASE },
    ];
    expect(seedEntries(same).map((s) => s.registrationId)).toEqual(['a', 'b']);
    expect(seedEntries([...same].reverse()).map((s) => s.registrationId)).toEqual(['a', 'b']);
  });
});

describe('bracketSizeFor (R3)', () => {
  it('R3: the next power of two, never smaller than the four-entry floor', () => {
    expect(bracketSizeFor(4)).toBe(4);
    expect(bracketSizeFor(5)).toBe(8);
    expect(bracketSizeFor(8)).toBe(8);
    expect(bracketSizeFor(9)).toBe(16);
    expect(bracketSizeFor(16)).toBe(16);
    expect(bracketSizeFor(17)).toBe(32);
    expect(bracketSizeFor(32)).toBe(32);
  });
});

describe('planDraw', () => {
  it('the Done when case: 32 entries make 31 Championship and 15 Plate matches', () => {
    const plan = planDraw(entries(32));
    expect(plan.bracketSize).toBe(32);
    expect(plan.plateSize).toBe(16);
    expect(plan.matches.filter((m) => m.bracket === 'championship')).toHaveLength(31);
    expect(plan.matches.filter((m) => m.bracket === 'plate')).toHaveLength(15);
    // Nothing is a bye: 32 entries fill a 32 bracket exactly.
    expect(plan.matches.filter(isBye)).toHaveLength(0);
  });

  it('R3: byes go to the top seeds and are one short of a full bracket each', () => {
    const plan = planDraw(entries(21));
    expect(plan.bracketSize).toBe(32);

    const byes = plan.matches.filter(isBye);
    expect(byes).toHaveLength(32 - 21);

    // The players who got them are exactly seeds 1..11.
    const seedOf = new Map(plan.seeds.map((s) => [s.registrationId, s.seed]));
    const advanced = byes.map((m) => seedOf.get((m.sideA ?? m.sideB)!)!).sort((a, b) => a - b);
    expect(advanced).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  });

  it('R4: the top two seeds are on opposite sides of the Championship', () => {
    const plan = planDraw(entries(16));
    const top = plan.seeds[0]!.registrationId;
    const second = plan.seeds[1]!.registrationId;
    const half = (id: string): number => {
      const m = plan.matches.find(
        (x) => x.round === 1 && x.bracket === 'championship' && (x.sideA === id || x.sideB === id),
      )!;
      return m.slot < 4 ? 0 : 1;
    };
    expect(half(top)).not.toBe(half(second));
  });

  it('R5: every first-round contest drops its loser into the Plate, and no bye does', () => {
    const plan = planDraw(entries(13));
    const firstRound = plan.matches.filter((m) => m.bracket === 'championship' && m.round === 1);

    for (const match of firstRound) {
      const isContest = match.sideA !== null && match.sideB !== null;
      expect(match.loserTo !== null).toBe(isContest);
      if (match.loserTo) expect(match.loserTo.bracket).toBe('plate');
    }

    // 13 entries in a 16 bracket: 5 contests, 3 byes... and a Plate sized to
    // the five losers rather than to half the bracket.
    const contests = firstRound.filter((m) => m.sideA !== null && m.sideB !== null);
    expect(contests).toHaveLength(5);
    expect(plan.plateSize).toBe(8);
  });

  it('R5: no Plate position is fed twice, and only Plate byes are fed at all', () => {
    for (const n of [4, 5, 6, 7, 8, 9, 11, 13, 16, 17, 21, 25, 32]) {
      const plan = planDraw(entries(n));
      const wired = plan.matches
        .filter((m) => m.loserTo)
        .map((m) => `${m.loserTo!.round}:${m.loserTo!.slot}:${m.loserTo!.side}`);
      expect(new Set(wired).size).toBe(wired.length);

      const plateFirstRoundSlots = plan.matches.filter(
        (m) => m.bracket === 'plate' && m.round === 1,
      ).length;
      // Every wired position exists, and at most every position is wired.
      expect(wired.length).toBeLessThanOrEqual(plateFirstRoundSlots * 2);
    }
  });

  it('R5: winner wiring reaches every position exactly once, in both brackets', () => {
    for (const n of [4, 5, 6, 7, 8, 9, 11, 13, 16, 17, 21, 25, 32]) {
      const plan = planDraw(entries(n));
      const byKey = new Map(plan.matches.map((m) => [key(m), m]));

      // Every wire points at a match that exists.
      for (const match of plan.matches) {
        for (const wire of [match.winnerTo, match.loserTo]) {
          if (!wire) continue;
          expect(byKey.has(`${wire.bracket}:${wire.round}:${wire.slot}`)).toBe(true);
        }
      }

      // Every slot above round 1 is fed by exactly two matches — one per side —
      // which is the property that makes "zero unfilled slots" true by
      // construction rather than by luck.
      const fedBy = new Map<string, number>();
      for (const match of plan.matches) {
        if (!match.winnerTo) continue;
        const k = `${match.winnerTo.bracket}:${match.winnerTo.round}:${match.winnerTo.slot}:${match.winnerTo.side}`;
        fedBy.set(k, (fedBy.get(k) ?? 0) + 1);
      }
      for (const count of fedBy.values()) expect(count).toBe(1);

      for (const match of plan.matches) {
        if (match.round === 1) continue;
        for (const side of [0, 1]) {
          expect(fedBy.get(`${key(match)}:${side}`)).toBe(1);
        }
      }
    }
  });

  it('R5: exactly one Championship final and at most one Plate final', () => {
    for (const n of [4, 5, 8, 13, 16, 32]) {
      const plan = planDraw(entries(n));
      const finals = plan.matches.filter((m) => m.winnerTo === null);
      expect(finals.filter((m) => m.bracket === 'championship')).toHaveLength(1);
      expect(finals.filter((m) => m.bracket === 'plate').length).toBeLessThanOrEqual(1);
    }
  });

  it('R5: a single first-round loser gets no Plate — there is nobody to play', () => {
    // 5 entries in a bracket of 8: seeds 4 and 5 are the only contest.
    const plan = planDraw(entries(5));
    expect(plan.plateSize).toBe(0);
    expect(plan.matches.filter((m) => m.bracket === 'plate')).toHaveLength(0);
    expect(plan.matches.filter((m) => m.loserTo)).toHaveLength(0);
  });

  it('every entry appears exactly once in the first round', () => {
    for (const n of [4, 5, 6, 7, 8, 9, 11, 13, 16, 17, 21, 25, 32]) {
      const plan = planDraw(entries(n));
      const placed = plan.matches
        .filter((m) => m.bracket === 'championship' && m.round === 1)
        .flatMap((m) => [m.sideA, m.sideB])
        .filter((id): id is string => id !== null);
      expect(placed).toHaveLength(n);
      expect(new Set(placed).size).toBe(n);
    }
  });

  it('R2, R6: the same entries in any order produce the identical draw', () => {
    const source = entries(11);
    const forwards = planDraw(source);
    const backwards = planDraw([...source].reverse());
    expect(backwards).toEqual(forwards);
  });
});
