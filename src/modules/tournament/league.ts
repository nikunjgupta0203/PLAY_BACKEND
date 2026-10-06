/**
 * tournament — leagues and group stages as PURE FUNCTIONS, like draw.ts.
 *
 *   league           every entry plays every other once; a table decides it.
 *   groups_knockout  entries split into groups of about four, each a little
 *                    league; the top two of every group then play a knockout.
 *
 * A league match may end level (a draw), which a knockout match never may:
 * the table gives 3 points for a win, 1 for a draw, 0 for a loss.
 */
import { seedPositions } from './draw.js';

export const DRAW_TYPES = ['single_elim_with_plate', 'single_elim', 'league', 'groups_knockout'] as const;
export type DrawType = (typeof DRAW_TYPES)[number];

/** A league needs three entries to be more than one match; groups need two groups of three. */
export const MIN_LEAGUE_ENTRIES = 3;
export const MIN_GROUP_ENTRIES = 6;
export const POINTS = { win: 3, draw: 1, loss: 0 } as const;
/** How many of each group go through to the knockout. */
export const QUALIFY_PER_GROUP = 2;

export interface Fixture {
  /** 1-based matchday. */
  round: number;
  /** 0-based within the matchday. */
  slot: number;
  a: string;
  b: string;
}

/**
 * The circle method: n entries (n even) play n − 1 matchdays with everybody
 * playing once each; an odd count adds a rest day per entry. Home and away
 * alternate for the fixed entry so no one is always side A.
 */
export function roundRobin(entries: string[]): Fixture[] {
  const ring: (string | null)[] = entries.length % 2 === 0 ? [...entries] : [...entries, null];
  const n = ring.length;
  const out: Fixture[] = [];
  for (let round = 1; round < n; round += 1) {
    let slot = 0;
    for (let i = 0; i < n / 2; i += 1) {
      const x = ring[i]!;
      const y = ring[n - 1 - i]!;
      if (x === null || y === null) continue;
      const flip = i === 0 && round % 2 === 0;
      out.push({ round, slot: slot++, a: flip ? y : x, b: flip ? x : y });
    }
    // Keep the first entry fixed; rotate the rest one place clockwise.
    ring.splice(1, 0, ring.pop()!);
  }
  return out;
}

/** About four to a group, never fewer than two groups. */
export function groupCountFor(entryCount: number): number {
  return Math.max(2, Math.floor(entryCount / 4));
}

/** Seeded entries dealt serpentine into groups, so every group gets a fair share of the seeds. */
export function planGroups(seeded: string[], groupCount: number): string[][] {
  const groups: string[][] = Array.from({ length: groupCount }, () => []);
  seeded.forEach((entry, i) => {
    const lap = Math.floor(i / groupCount);
    const at = i % groupCount;
    groups[lap % 2 === 0 ? at : groupCount - 1 - at]!.push(entry);
  });
  return groups;
}

export interface PlayedMatch {
  a: string;
  b: string;
  /** Null for a draw. */
  winner: string | null;
  /** Goals, runs, points over every set — whatever the scoreline counts. Null for a walkover. */
  tallyA: number | null;
  tallyB: number | null;
}

export interface TableRow {
  registrationId: string;
  place: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  scoreFor: number;
  scoreAgainst: number;
  points: number;
}

/**
 * The table: points, then score difference, then score for, then points in
 * the matches between the entries still level, then the seeding (the order of
 * `entries`). Entrants level on all of those share nothing — a table has no
 * shared places, the seeding decides.
 */
export function leagueTable(entries: string[], played: PlayedMatch[]): TableRow[] {
  const rows = new Map<string, TableRow>(
    entries.map((id) => [
      id,
      { registrationId: id, place: 0, played: 0, won: 0, drawn: 0, lost: 0, scoreFor: 0, scoreAgainst: 0, points: 0 },
    ]),
  );
  for (const m of played) {
    const a = rows.get(m.a);
    const b = rows.get(m.b);
    if (!a || !b) continue;
    for (const [me, myTally, theirTally] of [
      [a, m.tallyA, m.tallyB],
      [b, m.tallyB, m.tallyA],
    ] as const) {
      me.played += 1;
      me.scoreFor += myTally ?? 0;
      me.scoreAgainst += theirTally ?? 0;
      if (m.winner === null) {
        me.drawn += 1;
        me.points += POINTS.draw;
      } else if (m.winner === me.registrationId) {
        me.won += 1;
        me.points += POINTS.win;
      } else {
        me.lost += 1;
        me.points += POINTS.loss;
      }
    }
  }
  const seed = new Map(entries.map((id, i) => [id, i]));
  const overall = (x: TableRow, y: TableRow): number =>
    y.points - x.points ||
    y.scoreFor - y.scoreAgainst - (x.scoreFor - x.scoreAgainst) ||
    y.scoreFor - x.scoreFor;
  const sorted = [...rows.values()].sort(overall);

  // Head-to-head as a mini-league among exactly the entries still level, so a
  // three-way cycle (a beat b, b beat c, c beat a) stays level and falls to the seeding.
  const out: TableRow[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && overall(sorted[i]!, sorted[j]!) === 0) j += 1;
    const tied = sorted.slice(i, j);
    const inTie = new Set(tied.map((r) => r.registrationId));
    const mini = new Map(tied.map((r) => [r.registrationId, 0]));
    for (const m of played) {
      if (!inTie.has(m.a) || !inTie.has(m.b)) continue;
      if (m.winner === null) {
        mini.set(m.a, mini.get(m.a)! + POINTS.draw);
        mini.set(m.b, mini.get(m.b)! + POINTS.draw);
      } else if (inTie.has(m.winner)) {
        mini.set(m.winner, mini.get(m.winner)! + POINTS.win);
      }
    }
    tied.sort(
      (x, y) =>
        mini.get(y.registrationId)! - mini.get(x.registrationId)! ||
        seed.get(x.registrationId)! - seed.get(y.registrationId)!,
    );
    out.push(...tied);
    i = j;
  }
  return out.map((r, i) => ({ ...r, place: i + 1 }));
}

/**
 * Who plays the knockout, best seed first: every group winner, then every
 * runner-up, the runners-up turned so that no first-round match is a rematch
 * of a group game. Feed the order to planDraw as its seeding.
 */
export function knockoutSeeding(tables: TableRow[][]): string[] {
  const winners = tables.map((t) => t[0]?.registrationId).filter((id): id is string => !!id);
  const runners = tables.map((t) => t[1]?.registrationId).filter((id): id is string => !!id);
  const groupOf = new Map<string, number>();
  tables.forEach((t, g) => t.forEach((r) => groupOf.set(r.registrationId, g)));

  const size = 2 ** Math.ceil(Math.log2(Math.max(2, winners.length + runners.length)));
  const positions = seedPositions(Math.max(4, size));
  const clashes = (order: string[]): boolean => {
    const bySeed = (s: number) => order[s - 1];
    for (let i = 0; i < positions.length; i += 2) {
      const x = bySeed(positions[i]!);
      const y = bySeed(positions[i + 1]!);
      if (x && y && groupOf.get(x) === groupOf.get(y)) return true;
    }
    return false;
  };
  for (const turned of [runners, [...runners].reverse()]) {
    for (let k = 0; k < turned.length; k += 1) {
      const order = [...winners, ...turned.slice(k), ...turned.slice(0, k)];
      if (!clashes(order)) return order;
    }
  }
  return [...winners, ...runners];
}
