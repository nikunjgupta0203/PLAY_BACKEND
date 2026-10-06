/**
 * tournament — draw generation as a PURE FUNCTION (docs/modules/09-tournament.md).
 *
 * Nothing here touches a database, a clock or a random number generator. Given
 * the same entries it produces the same bracket, which is what makes R2's
 * "a regenerated draw is reproducible" a property rather than a hope, and what
 * lets sizes 4, 8, 16, 32 and every awkward number between them be tested
 * without a Postgres.
 *
 * The output is a complete WIRING (R5): every match already knows the match and
 * the side its winner goes to, and — for a first-round contest — the Plate
 * position its loser drops into. Advancement is then one write per side with no
 * traversal, which is what makes it safe to serialise and safe to retry
 * (R9, R10).
 */

export type BracketType = 'championship' | 'plate';

/** R7 — below four entries the category is refunded rather than played. */
export const MIN_ENTRIES = 4;

/** One confirmed entry, as it arrives from `registration`. */
export interface DrawEntry {
  registrationId: string;
  /**
   * R2 — the SETTLED rating. A provisional one is not fit to rank on
   * (rating R9), so the caller passes null and the entry seeds as unrated.
   */
  rating: number | null;
  /** R2's deterministic tie-break: who got their money in first. */
  confirmedAt: Date;
}

export interface SeededEntry extends DrawEntry {
  /** 1 is the top seed. */
  seed: number;
}

/** Where a player goes when a match resolves. `side` is 0 for A, 1 for B. */
export interface Wire {
  bracket: BracketType;
  round: number;
  slot: number;
  side: 0 | 1;
}

export interface PlannedMatch {
  bracket: BracketType;
  /** 1-based. Round 1 is the first one played in that bracket. */
  round: number;
  /** 0-based within the round, top of the bracket first. */
  slot: number;
  /** Filled at draw time in Championship round 1 only; null everywhere else. */
  sideA: string | null;
  sideB: string | null;
  /** Null on a final — a champion advances nowhere. */
  winnerTo: Wire | null;
  /**
   * Null unless this is a Championship round-1 CONTEST. A bye has no loser to
   * drop into the Plate, and the Plate is sized so that it does not wait for
   * one (R5).
   */
  loserTo: Wire | null;
}

export interface DrawPlan {
  /** R3 — the next power of two at or above the entry count. */
  bracketSize: number;
  /** R5 — the next power of two at or above the first-round loser count. */
  plateSize: number;
  seeds: SeededEntry[];
  matches: PlannedMatch[];
}

/** R3 — 5 entries play a bracket of 8; the other three positions are byes. */
export function bracketSizeFor(entryCount: number): number {
  let size = MIN_ENTRIES;
  while (size < entryCount) size *= 2;
  return size;
}

/**
 * R4 — standard bracket positions: 1 v 16, 8 v 9, 4 v 13, 5 v 12, … The
 * property that matters is that the top two seeds meet in the final and not
 * before, and it holds by construction: each doubling pairs every seed already
 * placed with the one that keeps every pair summing to the same number.
 */
export function seedPositions(size: number): number[] {
  if (size < 2) return [1];
  let order = [1, 2];
  while (order.length < size) {
    const pairSum = order.length * 2 + 1;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed, pairSum - seed);
    }
    order = next;
  }
  return order;
}

/**
 * R2 — settled rating descending, unrated last, tie-broken by confirmation time
 * and then by id.
 *
 * The id is not decoration: two entries confirmed in the same millisecond
 * (a webhook batch, a seeded fixture) would otherwise seed in whatever order
 * the database felt like returning them, and a draw that reorders itself
 * between two generations is not reproducible.
 */
export function seedEntries(entries: DrawEntry[]): SeededEntry[] {
  return [...entries]
    .sort((a, b) => {
      if (a.rating !== b.rating) {
        if (a.rating === null) return 1;
        if (b.rating === null) return -1;
        return b.rating - a.rating;
      }
      const byTime = a.confirmedAt.getTime() - b.confirmedAt.getTime();
      if (byTime !== 0) return byTime;
      return a.registrationId < b.registrationId ? -1 : 1;
    })
    .map((entry, index) => ({ ...entry, seed: index + 1 }));
}

const roundsIn = (size: number): number => Math.log2(size);

/**
 * The single-elimination skeleton for one bracket: every match, and every
 * winner wire. Round r slot i feeds round r+1 slot ⌊i/2⌋ on side i%2, which is
 * the whole of "advancement" once the sides are filled in.
 */
function skeleton(bracket: BracketType, size: number): PlannedMatch[] {
  const matches: PlannedMatch[] = [];
  const rounds = roundsIn(size);
  for (let round = 1; round <= rounds; round += 1) {
    const count = size / 2 ** round;
    for (let slot = 0; slot < count; slot += 1) {
      matches.push({
        bracket,
        round,
        slot,
        sideA: null,
        sideB: null,
        winnerTo:
          round === rounds
            ? null
            : { bracket, round: round + 1, slot: Math.floor(slot / 2), side: (slot % 2) as 0 | 1 },
        loserTo: null,
      });
    }
  }
  return matches;
}

/**
 * R5, R6 — Championship and Plate, seeded, wired, in ONE pass.
 *
 * The Plate is sized to the number of first-round LOSERS rather than to half
 * the bracket, which is the only sizing that stays honest when there are byes:
 * a bye produces a winner and no loser, so a Plate sized off the bracket would
 * contain positions that nothing can ever fill and matches that nothing can
 * ever resolve.
 */
export function planDraw(entries: DrawEntry[]): DrawPlan {
  const seeds = seedEntries(entries);
  const bracketSize = bracketSizeFor(seeds.length);
  const positions = seedPositions(bracketSize);
  const entryBySeed = new Map(seeds.map((e) => [e.seed, e]));

  const championship = skeleton('championship', bracketSize);
  const byPosition = (index: number): string | null =>
    entryBySeed.get(positions[index] ?? 0)?.registrationId ?? null;

  const firstRound = championship.filter((m) => m.round === 1);
  for (const match of firstRound) {
    match.sideA = byPosition(match.slot * 2);
    match.sideB = byPosition(match.slot * 2 + 1);
  }

  /**
   * The contests — the matches that will actually produce a loser. Ordered by
   * the better seed in each, so the Plate's own byes go to the losers who came
   * out of the strongest half of the draw rather than to whoever happened to be
   * written first.
   */
  const contests = firstRound
    .filter((m) => m.sideA !== null && m.sideB !== null)
    .map((m) => ({
      match: m,
      bestSeed: Math.min(positions[m.slot * 2] ?? 0, positions[m.slot * 2 + 1] ?? 0),
    }))
    .sort((a, b) => a.bestSeed - b.bestSeed || a.match.slot - b.match.slot)
    .map((c) => c.match);

  // One loser cannot play a Plate. Three or more can; two play a Plate final.
  const plateSize = contests.length < 2 ? 0 : plateSizeFor(contests.length);
  const plate = plateSize === 0 ? [] : skeleton('plate', plateSize);

  if (plateSize > 0) {
    const platePositions = seedPositions(plateSize);
    const plateFirstRound = plate.filter((m) => m.round === 1);
    for (const match of plateFirstRound) {
      for (const side of [0, 1] as const) {
        // The n-th best loser the Championship can produce. Positions beyond
        // the contest count are Plate byes: nothing is wired into them, which
        // is exactly how a bye is recognised later — an empty slot with no
        // feeder is never going to fill.
        const loserSeed = platePositions[match.slot * 2 + side] ?? 0;
        const source = contests[loserSeed - 1];
        if (!source) continue;
        source.loserTo = { bracket: 'plate', round: 1, slot: match.slot, side };
      }
    }
  }

  return { bracketSize, plateSize, seeds, matches: [...championship, ...plate] };
}

/**
 * The Plate has no four-entry floor of its own — R7 is about whether a category
 * is played at all, and a two-loser Plate is one honest match.
 */
function plateSizeFor(count: number): number {
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

/**
 * A first-round position with one player and no opponent (R3). The caller
 * writes it as a real match row with `status = 'walkover'` and advances its
 * winner at draw time, so nothing downstream has a special case for byes.
 */
export const isBye = (match: PlannedMatch): boolean =>
  match.round === 1 &&
  match.bracket === 'championship' &&
  (match.sideA === null) !== (match.sideB === null);
