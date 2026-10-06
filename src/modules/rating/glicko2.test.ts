/**
 * The Glicko-2 engine, checked against the reference worked example in
 * Glickman's paper (glicko.net/glicko/glicko2.pdf, "Example of the Glicko-2
 * system") before it is trusted with anybody's ranking.
 *
 * Pure unit tests: no database, no container, milliseconds. Everything the
 * engine does is a function of its arguments, which is what makes the
 * determinism guarantee in the module's "Done when" achievable at all.
 */
import { describe, expect, it } from 'vitest';
import {
  MISMATCH_THRESHOLD,
  MISMATCH_WEIGHT,
  TAU,
  UNRATED,
  decay,
  quantise,
  splitShares,
  teamRating,
  update,
  updateTeam,
  weightOf,
  type Rating,
} from './glicko2.js';

/** The paper's subject: 1500 / 200 / 0.06, against three opponents. */
const SUBJECT: Rating = { rating: 1500, rd: 200, volatility: 0.06 };
const PAPER_OPPONENTS = [
  { rating: 1400, rd: 30, score: 1 },
  { rating: 1550, rd: 100, score: 0 },
  { rating: 1700, rd: 300, score: 0 },
];

describe('glicko2 — the reference example', () => {
  it("reproduces Glickman's worked example to the paper's own precision", () => {
    // The published answer: r' = 1464.06, RD' = 151.52, sigma' = 0.05999.
    // These opponents are all within 400 points, so no damping applies and the
    // engine is being asked exactly the question the paper asks.
    const after = update(SUBJECT, PAPER_OPPONENTS, TAU);

    expect(after.rd).toBeCloseTo(151.52, 2);
    // sigma' is 0.0599960; the paper prints 0.05999, truncated rather than
    // rounded, which is the same five digits it shows everywhere else.
    expect(Math.trunc(after.volatility * 1e5) / 1e5).toBe(0.05999);
    expect(after.volatility).toBeCloseTo(0.059996, 6);

    // The paper carries four decimal places through every intermediate step and
    // prints mu' = -0.2069, from which its r' = 1464.06 follows. We keep full
    // precision, so the comparison that actually means "we match the paper" is
    // against mu' — the last value before the printed rounding enters.
    const mu = (after.rating - 1500) / 173.7178;
    expect(Number(mu.toFixed(4))).toBe(-0.2069);
    expect(1500 + 173.7178 * -0.2069).toBeCloseTo(1464.06, 2);

    // And the exact figure, pinned: any change to the arithmetic that does not
    // move mu' by a printable amount would otherwise slip past the check above.
    expect(after.rating).toBeCloseTo(1464.0507, 4);
  });

  it('is deterministic — the same inputs give bit-identical outputs', () => {
    const a = update(SUBJECT, PAPER_OPPONENTS, TAU);
    const b = update(SUBJECT, PAPER_OPPONENTS, TAU);
    expect(a).toEqual(b);
  });

  it('a beaten favourite loses rating, and a winner against the field gains it', () => {
    const beaten = update(SUBJECT, [{ rating: 1400, rd: 30, score: 0 }]);
    expect(beaten.rating).toBeLessThan(SUBJECT.rating);

    const won = update(SUBJECT, [{ rating: 1700, rd: 30, score: 1 }]);
    expect(won.rating).toBeGreaterThan(SUBJECT.rating);
  });

  it('a result always sharpens the rating — RD falls when you play', () => {
    const after = update(SUBJECT, PAPER_OPPONENTS, TAU);
    expect(after.rd).toBeLessThan(SUBJECT.rd);
  });
});

describe('glicko2 R1 — deviation grows with inactivity', () => {
  it('a period with no games leaves the rating and widens the deviation', () => {
    const after = decay(SUBJECT);
    expect(after.rating).toBe(SUBJECT.rating);
    expect(after.rd).toBeGreaterThan(SUBJECT.rd);
    // Six weeks off makes the number less certain, not less true — the whole
    // reason this system was chosen over Elo.
    expect(after.volatility).toBe(SUBJECT.volatility);
  });

  it('an empty opponent list is the same thing as sitting the period out', () => {
    expect(update(SUBJECT, [])).toEqual(decay(SUBJECT));
  });

  it('deviation is capped at the unrated value, however long the absence', () => {
    let r: Rating = { rating: 1500, rd: 340, volatility: 0.06 };
    for (let i = 0; i < 200; i += 1) r = decay(r);
    expect(r.rd).toBe(UNRATED.rd);
    expect(r.rating).toBe(1500);
  });
});

describe('glicko2 R6 — a win against a much weaker team is damped', () => {
  it('weights a win beyond the threshold below one, and everything else at one', () => {
    expect(weightOf(1900, { rating: 1400, rd: 50, score: 1 })).toBe(MISMATCH_WEIGHT);
    // Exactly at the threshold is not beyond it.
    expect(weightOf(1800, { rating: 1400, rd: 50, score: 1 })).toBe(1);
    expect(weightOf(1900, { rating: 1899, rd: 50, score: 1 })).toBe(1);
  });

  it('losing to a much weaker team counts in full — that is real information', () => {
    expect(weightOf(1900, { rating: 1400, rd: 50, score: 0 })).toBe(1);
  });

  it('stacking soft draws moves the rating less than beating real opponents', () => {
    const strong: Rating = { rating: 1900, rd: 60, volatility: 0.06 };
    const soft = { rating: 1900 - MISMATCH_THRESHOLD - 100, rd: 60, score: 1 };
    const real = { rating: 1900 - MISMATCH_THRESHOLD + 100, rd: 60, score: 1 };

    const fromSoft = update(strong, [soft, soft, soft, soft]);
    const fromReal = update(strong, [real, real, real, real]);

    expect(fromSoft.rating).toBeGreaterThan(strong.rating);
    // Four easy wins are worth less than four honest ones, which is the rule.
    expect(fromSoft.rating - strong.rating).toBeLessThan(fromReal.rating - strong.rating);
  });

  it('a card of nothing but damped wins still moves the rating', () => {
    // Damped is not ignored. A player who only ever beats weaker opponents
    // should still climb, just slowly.
    const strong: Rating = { rating: 2000, rd: 80, volatility: 0.06 };
    const after = update(strong, [{ rating: 1000, rd: 60, score: 1 }]);
    expect(after.rating).toBeGreaterThan(strong.rating);
  });
});

describe('glicko2 R5 — doubles', () => {
  it('a team rates as the mean of its members and the RMS of their deviations', () => {
    const team = teamRating([
      { rating: 1600, rd: 60, volatility: 0.06 },
      { rating: 1400, rd: 80, volatility: 0.06 },
    ]);
    expect(team.rating).toBe(1500);
    // RMS, not mean: 70 would be the mean, and uncertainties add in quadrature.
    expect(team.rd).toBeCloseTo(Math.sqrt((60 * 60 + 80 * 80) / 2), 10);
    expect(team.rd).toBeGreaterThan(70);
  });

  it('equal RD: both partners move by the same amount, and by the team delta', () => {
    const members: Rating[] = [
      { rating: 1500, rd: 200, volatility: 0.06 },
      { rating: 1500, rd: 200, volatility: 0.06 },
    ];
    const opponents = [{ rating: 1500, rd: 200, score: 1 }];

    const [a, b] = updateTeam(members, opponents);
    expect(a!.rating).toBeCloseTo(b!.rating, 10);

    // The doubles path collapses to the singles path when the partners are
    // indistinguishable — otherwise a doubles win would be worth half of one.
    const solo = update({ rating: 1500, rd: 200, volatility: 0.06 }, opponents);
    expect(a!.rating).toBeCloseTo(solo.rating, 10);
  });

  it('extreme RD: the less certain partner absorbs most of the change', () => {
    const known: Rating = { rating: 1500, rd: 40, volatility: 0.06 };
    const unknown: Rating = { rating: 1500, rd: 350, volatility: 0.06 };
    const before = teamRating([known, unknown]);

    const [afterKnown, afterUnknown] = updateTeam([known, unknown], [
      { rating: 1700, rd: 100, score: 1 },
    ]);

    const knownDelta = afterKnown!.rating - known.rating;
    const unknownDelta = afterUnknown!.rating - unknown.rating;
    expect(unknownDelta).toBeGreaterThan(knownDelta);
    // 350 to 40 is a ratio of 8.75, and the shares carry it exactly.
    expect(unknownDelta / knownDelta).toBeCloseTo(350 / 40, 6);

    // And the team's own rating moved by the team delta: the mean of the two
    // new ratings is the team's new rating, which is what makes the split a
    // redistribution rather than an invention.
    const after = teamRating([afterKnown!, afterUnknown!]);
    const teamDelta = update(before, [{ rating: 1700, rd: 100, score: 1 }]).rating - before.rating;
    expect(after.rating - before.rating).toBeCloseTo(teamDelta, 6);
  });

  it('shares sum to the team size, so nobody is silently halved', () => {
    const shares = splitShares([
      { rating: 1500, rd: 100, volatility: 0.06 },
      { rating: 1500, rd: 300, volatility: 0.06 },
    ]);
    expect(shares.reduce((s, x) => s + x, 0)).toBeCloseTo(2, 10);
  });

  it('two perfectly known partners split evenly rather than dividing by zero', () => {
    const shares = splitShares([
      { rating: 1500, rd: 0, volatility: 0.06 },
      { rating: 1500, rd: 0, volatility: 0.06 },
    ]);
    expect(shares).toEqual([1, 1]);
  });

  it('a doubles win sharpens both partners — RD falls for each of them', () => {
    const members: Rating[] = [
      { rating: 1500, rd: 200, volatility: 0.06 },
      { rating: 1520, rd: 120, volatility: 0.06 },
    ];
    const after = updateTeam(members, [{ rating: 1500, rd: 150, score: 1 }]);
    expect(after[0]!.rd).toBeLessThan(members[0]!.rd);
    expect(after[1]!.rd).toBeLessThan(members[1]!.rd);
    // The better-known partner stays the better-known one.
    expect(after[1]!.rd).toBeLessThan(after[0]!.rd);
  });

  it('a singles side is a one-member team, and takes the whole delta', () => {
    const solo: Rating = { rating: 1500, rd: 200, volatility: 0.06 };
    const opponents = [{ rating: 1600, rd: 100, score: 1 }];
    expect(updateTeam([solo], opponents)[0]).toEqual(update(solo, opponents));
  });
});

describe('glicko2 — storage precision', () => {
  it('quantises to the precision of the columns the numbers are stored in', () => {
    const q = quantise({ rating: 1464.0616, rd: 151.5165, volatility: 0.0599959 });
    expect(q).toEqual({ rating: 1464.06, rd: 151.52, volatility: 0.06 });
  });

  it('a quantised value survives a round trip unchanged', () => {
    const once = quantise(update(SUBJECT, PAPER_OPPONENTS));
    expect(quantise(once)).toEqual(once);
  });
});
