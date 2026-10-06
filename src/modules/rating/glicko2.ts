/**
 * rating — the Glicko-2 engine (docs/modules/08-rating.md).
 *
 * A PURE function of its arguments. No database, no clock, no configuration
 * read from the environment: given the same inputs it returns the same numbers
 * forever, which is the property the determinism replay test in "Done when"
 * actually checks. Everything stateful lives in service/index.ts.
 *
 * Glicko-2 rather than Elo (R1) because amateur players compete in bursts. The
 * rating deviation grows while a player is away, so a returning player's rating
 * moves quickly to find its level again and a regular's does not swing on one
 * upset. Elo cannot express that — it treats a rating from March as exactly as
 * reliable as one from yesterday.
 *
 * The implementation follows Glickman's "Example of the Glicko-2 system"
 * (glicko.net/glicko/glicko2.pdf) step for step, and glicko2.test.ts checks it
 * against the worked example in that paper. If you change anything here, that
 * test is the one that tells you whether you were right.
 */

/** R8 — every stored row carries this. A new model is a new version, not a migration. */
export const ALGO_VERSION = 'glicko2-v1';

/**
 * The Glicko-2 scale factor. Ratings are held on the familiar 1500-centred
 * scale and converted in and out, because that is the number a player sees.
 */
const SCALE = 173.7178;

/** System constant: how much volatility may move in one period. */
export const TAU = 0.5;

/** Convergence tolerance for the volatility iteration, from the paper. */
const EPSILON = 0.000001;

export interface Rating {
  rating: number;
  rd: number;
  volatility: number;
}

/** One opponent in a rating period. `score` is 1 win, 0.5 draw, 0 loss. */
export interface Opponent {
  rating: number;
  rd: number;
  score: number;
}

/**
 * An unrated player. RD 350 is "we know nothing", which is why a first result
 * moves the number a long way and the fifth barely does.
 */
export const UNRATED: Rating = { rating: 1500, rd: 350, volatility: 0.06 };

/**
 * R6 — a win against a team rated far below you counts for less.
 *
 * Glicko-2 has no notion of weighting, so the weight multiplies both the
 * information a game carries (`v`) and the change it drives (`delta`), which is
 * the same as counting the game as a fraction of a game. Damping only a WIN is
 * deliberate: beating a much weaker team should not inflate a ranking, but
 * LOSING to one is real information and counts in full.
 *
 * The threshold is the doc's; the weight is a policy dial, and it lives here as
 * a named constant so that changing it is a one-line, reviewable decision
 * rather than an arithmetic edit inside the loop.
 */
export const MISMATCH_THRESHOLD = 400;
export const MISMATCH_WEIGHT = 0.5;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

const expected = (mu: number, muJ: number, phiJ: number): number =>
  1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** R6 — the weight one game contributes, before any Glicko arithmetic. */
export function weightOf(playerRating: number, opponent: Opponent): number {
  const isWin = opponent.score > 0.5;
  const gap = playerRating - opponent.rating;
  return isWin && gap > MISMATCH_THRESHOLD ? MISMATCH_WEIGHT : 1;
}

/**
 * The volatility iteration — step 5 of the paper, solved with the Illinois
 * variant of regula falsi.
 *
 * It is the only part of Glicko-2 that is not a closed form, and it is the part
 * everyone gets wrong: `B` has to be bracketed differently depending on whether
 * the observed change exceeds what the current uncertainty can explain.
 */
function newVolatility(phi: number, sigma: number, v: number, delta: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const phiSq = phi * phi;
  const deltaSq = delta * delta;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const denom = phiSq + v + ex;
    return (ex * (deltaSq - phiSq - v - ex)) / (2 * denom * denom) - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    // Walk down in steps of tau until f turns negative — the paper's fallback
    // when the change is small enough to be explained by existing uncertainty.
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
      // Not expected to trigger; a runaway here would be an infinite loop in a
      // job that pages someone, so it is bounded rather than trusted.
      if (k > 1000) break;
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPSILON && guard < 1000) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      // The Illinois half-step. Without it one endpoint sticks and the
      // iteration crawls.
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    guard += 1;
  }

  return Math.exp(A / 2);
}

/**
 * One rating period's worth of results for one competitor.
 *
 * Called with every opponent faced in the period (the settled path, R4) or with
 * exactly one (the provisional path, R3). Glicko-2 is defined over periods; a
 * single-game period is a legitimate special case of it, not a different
 * formula, which is what lets both numbers live in the same log.
 */
export function update(player: Rating, opponents: Opponent[], tau: number = TAU): Rating {
  if (opponents.length === 0) return decay(player);

  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;

  let vInv = 0;
  let deltaSum = 0;
  for (const o of opponents) {
    const muJ = (o.rating - 1500) / SCALE;
    const phiJ = o.rd / SCALE;
    const gj = g(phiJ);
    const e = expected(mu, muJ, phiJ);
    const w = weightOf(player.rating, o);
    vInv += w * gj * gj * e * (1 - e);
    deltaSum += w * gj * (o.score - e);
  }

  // Every game was damped to nothing — no information, so nothing but the
  // inactivity step applies. Dividing by zero here would produce NaN ratings.
  if (vInv === 0) return decay(player);

  const v = 1 / vInv;
  const delta = v * deltaSum;

  const sigmaPrime = newVolatility(phi, player.volatility, v, delta, tau);
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: SCALE * muPrime + 1500,
    rd: SCALE * phiPrime,
    volatility: sigmaPrime,
  };
}

/**
 * R1 — a period in which the player did not compete. The rating stands and the
 * deviation grows, which is the whole reason this system was chosen: six weeks
 * off should make the number less certain, not less true.
 */
export function decay(player: Rating): Rating {
  const phi = player.rd / SCALE;
  const phiStar = Math.sqrt(phi * phi + player.volatility * player.volatility);
  // RD is capped at the unrated value. Beyond 350 the rating carries no
  // information anyway, and an uncapped walk would eventually overflow the
  // numeric(7,2) column it is stored in.
  return {
    rating: player.rating,
    rd: Math.min(SCALE * phiStar, UNRATED.rd),
    volatility: player.volatility,
  };
}

// --- doubles (R5) ------------------------------------------------------------

/**
 * R5 — a team's rating is the MEAN of its members and its RD the
 * ROOT-MEAN-SQUARE of theirs.
 *
 * RMS rather than mean for the deviation because deviations are uncertainties:
 * they add in quadrature. A team of a known player and an unknown one is more
 * uncertain than the average of the two suggests.
 */
export function teamRating(members: Rating[]): Rating {
  if (members.length === 0) throw new Error('a team needs at least one member');
  const rating = members.reduce((s, m) => s + m.rating, 0) / members.length;
  const rd = Math.sqrt(members.reduce((s, m) => s + m.rd * m.rd, 0) / members.length);
  const volatility = members.reduce((s, m) => s + m.volatility, 0) / members.length;
  return { rating, rd, volatility };
}

/**
 * R5 — split the team's change between its members according to their RD.
 *
 * The doc says "inversely to their RD" and then says what it means: *the less
 * certain player absorbs more of the change, which is what RD means*. The
 * second clause is the operative one — a share proportional to RD — because a
 * high deviation is precisely the statement "this player's rating is the one we
 * should be willing to move".
 *
 * The shares sum to `n`, not to 1, so that the mean of the members' new ratings
 * equals the team's new rating. Two partners with equal RD therefore each move
 * by the full team delta, exactly as a singles player would, and the doubles
 * path collapses to the singles path rather than halving everyone's progress.
 */
export function splitShares(members: Rating[]): number[] {
  const total = members.reduce((s, m) => s + m.rd, 0);
  // Every member perfectly known: nothing to weight by, so share it evenly.
  if (total === 0) return members.map(() => 1);
  return members.map((m) => (members.length * m.rd) / total);
}

/**
 * The team update, distributed back onto its members.
 *
 * The team is rated as one competitor, and then each member takes their share
 * of the rating change. Deviation and volatility move by the same RATIO the
 * team's did: the match told us as much about each partner as it told us about
 * the pair, and a ratio preserves the ordering of who is better known.
 */
export function updateTeam(
  members: Rating[],
  opponents: Opponent[],
  tau: number = TAU,
): Rating[] {
  const before = teamRating(members);
  const after = update(before, opponents, tau);

  const delta = after.rating - before.rating;
  const rdRatio = before.rd === 0 ? 1 : after.rd / before.rd;
  const volRatio = before.volatility === 0 ? 1 : after.volatility / before.volatility;
  const shares = splitShares(members);

  return members.map((m, i) => ({
    rating: m.rating + delta * shares[i]!,
    rd: Math.min(m.rd * rdRatio, UNRATED.rd),
    volatility: m.volatility * volRatio,
  }));
}

/**
 * Stored as numeric(7,2) / numeric(7,5), so the engine's output is rounded to
 * the column's precision BEFORE it is written or compared. Otherwise a replay
 * reproduces a rating that differs from the stored one in the seventh decimal
 * and the determinism test fails for a reason that has nothing to do with the
 * algorithm.
 */
export function quantise(r: Rating): Rating {
  return {
    rating: Math.round(r.rating * 100) / 100,
    rd: Math.round(r.rd * 100) / 100,
    volatility: Math.round(r.volatility * 100000) / 100000,
  };
}
