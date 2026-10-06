/**
 * The contract between `sport` and `scoring` (sport R5).
 *
 * Get this shape right and a second sport is a row; get it wrong and it is a
 * refactor. When `scoring` needs a new concept — a let, a tiebreak variant, a
 * whole new scoring family — it is added HERE, never branched on over
 * `sport.slug`.
 *
 * `kind` is the discriminant: every sport's scoring reduces to one of a few
 * families, not one shape stretched to fit all of them. A pickleball rally
 * and a football scoreline are not the same concept with different numbers —
 * forcing them into one shape is exactly the hardcoding this file exists to
 * prevent. Add a new family here when an existing one genuinely does not fit
 * (cricket's overs/wickets, say); do not add a family for a sport that is
 * really just a rally game with different numbers (badminton, table tennis).
 *
 * The column is `jsonb`, so nothing in Postgres validates it. This schema is
 * what does, on seed (sport R1).
 *
 * Families in use: rally (pickleball, badminton, table tennis, volleyball,
 * squash), sets (tennis, padel), goals (football, basketball, kabaddi).
 */
import { z } from 'zod';

const count = z.number().int().positive();

const gameShape = z.object({
  pointsToWin: count,
  /** null = unlimited deuce. */
  hardCap: count.nullable(),
});

/** Point-per-rally, best-of-N-games. Pickleball, badminton, table tennis, volleyball, squash. */
const rallyRule = gameShape
  .extend({
    kind: z.literal('rally'),
    /** 2 for "win by two". 1 for sudden death at the target. */
    winBy: z.number().int().min(1),
    /** 2 means best of three. */
    gamesToWin: count,
    serveModel: z.enum(['rally', 'side_out']),
    /** The deciding game is often shorter. Absent = same as the others. */
    decidingGame: gameShape.optional(),
    /** Point at which ends are switched in the deciding game. */
    switchEndsAt: count.optional(),
  })
  .strict();

/** Games within sets within a match. Tennis, and anything scored the same way. */
const setsRule = z
  .object({
    kind: z.literal('sets'),
    /** Points to win a game — 4 for standard tennis (deuce past 3-3). */
    gamePointsToWin: count,
    /** 2 for deuce/advantage; 1 for no-ad scoring. Absent = 2. */
    gameWinBy: z.number().int().min(1).optional(),
    /** Games to win a set — 6, subject to winBy unless the set tiebreak fires first. */
    setGamesToWin: count,
    setWinBy: z.number().int().min(1),
    /** Sets to win the match — 2 for best of three, 3 for best of five. */
    setsToWin: count,
    /** Games-apiece that triggers a set tiebreak. null = play the set out with no tiebreak. */
    setTiebreakAt: count.nullable(),
    tiebreakPointsToWin: count,
    tiebreakWinBy: z.number().int().min(1),
    /** Some tours play a full extra set in the decider instead of a match tiebreak. */
    finalSetIsFullSet: z.boolean(),
    /**
     * A tiebreak game in place of the deciding set: padel and many club formats
     * play a "super tiebreak" to 10, win by 2, at one set all. Absent/null = play the set.
     */
    finalSetMatchTiebreak: z.object({ pointsToWin: count, winBy: z.number().int().min(1) }).strict().nullable().optional(),
  })
  .strict();

const scoreAction = z
  .object({
    /** Stable id stored on the event: 'goal', 'three', 'raid', 'super_tackle'. */
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** What the scorer's button says. */
    label: z.string().min(1).max(24),
    value: count,
  })
  .strict();

/** A running score over a clock, in periods. Football, hockey, basketball, kabaddi. */
const goalsRule = z
  .object({
    kind: z.literal('goals'),
    periods: count,
    periodMinutes: count,
    /** How a level match resolves when the format requires a winner (knockout play). */
    tiebreaker: z.enum(['extra_period', 'shootout', 'extra_period_then_shootout', 'none']),
    /** Required unless tiebreaker is 'none' or 'shootout'. */
    extraPeriodMinutes: count.nullable(),
    /** What a score can be worth, and what to call it. Absent = one action, Goal +1. */
    actions: z.array(scoreAction).min(1).optional(),
    /** Periods in one block of extra time: 2 halves in football, 1 overtime in basketball. Absent = 2. */
    extraPeriods: count.optional(),
    /** Basketball: play another block while still level. Absent = false. */
    repeatExtraPeriods: z.boolean().optional(),
  })
  .strict();

/**
 * Plan 4 — runs and wickets over a fixed number of balls, one innings a side.
 * Cricket in every limited-overs shape (T20, T10, ODI, box, tennis-ball) is a
 * row of these numbers, never a branch.
 */
const inningsRule = z
  .object({
    kind: z.literal('innings'),
    /** 20 for T20, 6 for box cricket. */
    oversPerInnings: count,
    /** 6 legal deliveries. */
    ballsPerOver: count,
    /** Wickets that end an innings: 10 with eleven players. */
    wicketsPerInnings: count,
    /** 4 in T20. Null = no limit. */
    maxOversPerBowler: count.nullable(),
    extras: z
      .object({
        /** Runs a wide gives the batting side before any run off it. */
        wideRuns: z.number().int().min(0),
        noBallRuns: z.number().int().min(0),
        /** The ball after a no-ball is a free hit: only a run out dismisses. */
        freeHit: z.boolean(),
      })
      .strict(),
    /** A tie goes to a super over (one over, two wickets), repeated while still tied. */
    tiebreaker: z.enum(['super_over', 'none']),
  })
  .strict();

/**
 * Plan 5 — a race of units (frames, racks, games, maps, boards). A unit is won
 * outright (pool, chess, esports) or on points inside it (snooker, billiards,
 * carrom). Snooker, pool, billiards, carrom, chess and map-based esports are
 * rows of these numbers.
 */
const seriesRule = z
  .object({
    kind: z.literal('series'),
    /** What a unit is called: frame, rack, game, map, board. */
    unitName: z.string().regex(/^[a-z]+$/),
    /** Match points to win: 3 racks, 2 maps, 1 game. Draws score half. */
    unitsToWin: z.number().positive(),
    /** Most units a match can have (1 for a single chess game). Null = until someone wins. */
    maxUnits: count.nullable(),
    /** win_only: the scorer says who won each unit. points: points inside it decide it. */
    unitScoring: z.enum(['win_only', 'points']),
    /** A points unit ends by itself on reaching this (billiards 150, carrom 25). Null = the scorer ends it. */
    unitPointTarget: count.nullable(),
    /** A points unit also ends after this many scoring events (carrom: 8 boards). */
    maxEventsPerUnit: count.nullable(),
    /** A unit may be drawn (chess): half a point each. */
    allowDraws: z.boolean(),
    /** A won unit must carry a valid score: first to pointsToWin, or winBy clear past it (esports rounds). */
    unitScore: z.object({ pointsToWin: count, winBy: z.number().int().min(1) }).strict().nullable(),
    /** Named point buttons for a points unit (snooker balls). Absent = a free number. */
    actions: z.array(scoreAction).min(1).optional(),
  })
  .strict();

/**
 * Plan 6 — a bout between two fighters over rounds. Judged sports (boxing,
 * MMA) score each round on every judge's 10-point-must card; points sports
 * (wrestling, karate, taekwondo) score each move, with a gap that stops it.
 * Either ends at once on a finish (KO, submission, fall…).
 */
const boutsRule = z
  .object({
    kind: z.literal('bouts'),
    rounds: count,
    roundSeconds: count,
    decision: z.enum(['judges', 'points']),
    /** judges: how many cards a round carries. Null for points. */
    judges: count.nullable(),
    /** points: what each move is worth (wrestling 1/2/4/5, karate 1/2/3). Empty for judges. */
    actions: z.array(scoreAction),
    /** points: a lead this big ends the bout — or the round, with roundsToWin. */
    pointGap: count.nullable(),
    /** Taekwondo: each round is won on points; first to this many rounds wins. Null = points carry over. */
    roundsToWin: count.nullable(),
    /** Karate senshu: the first unopposed point wins a level bout. */
    firstPointAdvantage: z.boolean(),
    /** Points a penalty gives the opponent (wrestling caution, taekwondo gam-jeom). 0 = a warning only. */
    penaltyToOpponent: z.number().int().min(0),
    /** Penalties that disqualify. Null = none do. */
    maxPenalties: count.nullable(),
    /** How a bout may end early: ko, tko, submission, fall, dq, injury, rsc. */
    finishes: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  })
  .strict();

/**
 * Plans 7, 8 — FIELD contests: many entrants in one heat, never two sides.
 * performance: a measured or judged mark (races, jumps, lifts, routines,
 * battle royale). scorecard: a card per entrant (golf, bowling, archery).
 * A category whose rule is one of these is run as heats, not a bracket.
 */
const performanceRule = z
  .object({
    kind: z.literal('performance'),
    measure: z.enum(['time', 'distance', 'height', 'weight', 'reps', 'points', 'judged']),
    better: z.enum(['lower', 'higher']),
    attempts: count,
    lifts: z.array(z.string().regex(/^[a-z_]+$/)).min(1).nullable(),
    refereeLights: count.nullable(),
    judges: count.nullable(),
    dropHighLow: z.boolean(),
    placementPoints: z.array(z.number().int().min(0)).min(1).nullable(),
    perKillPoints: z.number().int().min(0).nullable(),
  })
  .strict();

const scorecardRule = z
  .object({
    kind: z.literal('scorecard'),
    method: z.enum(['strokes', 'tenpin', 'ends']),
    units: count,
    par: z.array(count).nullable(),
    arrowsPerEnd: count.nullable(),
  })
  .strict();

export const scoringRuleSchema = z
  .discriminatedUnion('kind', [rallyRule, setsRule, goalsRule, inningsRule, seriesRule, boutsRule, performanceRule, scorecardRule])
  .superRefine((rule, ctx) => {
    if (rule.kind === 'rally') {
      // A cap below the target is unreachable, and a cap equal to it makes winBy
      // dead code. Both are seed typos that would only surface mid-tournament.
      const caps: [string, { pointsToWin: number; hardCap: number | null }][] = [
        ['hardCap', rule],
      ];
      if (rule.decidingGame) caps.push(['decidingGame.hardCap', rule.decidingGame]);
      for (const [path, game] of caps) {
        if (game.hardCap !== null && game.hardCap < game.pointsToWin) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: path.split('.'),
            message: `hardCap ${game.hardCap} is below pointsToWin ${game.pointsToWin}`,
          });
        }
      }
      const deciding = rule.decidingGame ?? rule;
      if (rule.switchEndsAt !== undefined && rule.switchEndsAt >= deciding.pointsToWin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['switchEndsAt'],
          message: 'ends must be switched before the deciding game can be won',
        });
      }
    }

    if (rule.kind === 'sets') {
      // Equal is the normal case — a set is won outright below this and a
      // tiebreak fires exactly at it (6-6 in standard tennis). Above it, the
      // tiebreak can never fire because the set is already over.
      if (rule.setTiebreakAt !== null && rule.setTiebreakAt > rule.setGamesToWin) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['setTiebreakAt'],
          message: 'a tiebreak cannot fire after the set is already won outright',
        });
      }
    }

    if (rule.kind === 'goals') {
      const keys = (rule.actions ?? []).map((a) => a.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions'], message: 'action keys must be unique' });
      }
      if (rule.tiebreaker.startsWith('extra_period') && rule.extraPeriodMinutes === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['extraPeriodMinutes'],
          message: 'an extra-period tiebreaker needs a period length',
        });
      }
    }
  });

export type ScoringRule = z.infer<typeof scoringRuleSchema>;

/** Reads one back out of `jsonb`. Throws with the field path on bad seed data. */
export function parseScoringRule(value: unknown): ScoringRule {
  return scoringRuleSchema.parse(value);
}

/**
 * F21 — the few numbers a host may change about how a match is played, so an
 * event fits its day: shorter games, fewer sets, shorter halves, fewer overs.
 * Everything else about the sport's rule stays as seeded.
 */
export interface RuleTweaks {
  /** rally: points to win a game (11, 15, 21…). */
  pointsToWin?: number | null;
  /** rally: games to win the match (1 = one game, 2 = best of three). */
  gamesToWin?: number | null;
  /** sets: sets to win the match (1 = one set, 2 = best of three). */
  setsToWin?: number | null;
  /** goals: minutes in each period. */
  periodMinutes?: number | null;
  /** innings: overs a side. */
  oversPerInnings?: number | null;
}

/** The ranges a host may pick from, per knob. Outside them the rule is refused. */
export const TWEAK_LIMITS = {
  pointsToWin: [5, 30],
  gamesToWin: [1, 3],
  setsToWin: [1, 3],
  periodMinutes: [5, 60],
  oversPerInnings: [1, 50],
} as const;

export class RuleTweakError extends Error {}

/**
 * The sport's rule with the host's numbers in. Pure. A knob that does not
 * belong to this kind of rule is refused rather than ignored, so a host never
 * believes they changed something they did not.
 */
export function tweakRule(rule: ScoringRule, tweaks: RuleTweaks): ScoringRule {
  const set = Object.entries(tweaks).filter(([, v]) => v !== null && v !== undefined) as [keyof RuleTweaks, number][];
  if (set.length === 0) return rule;
  const next: Record<string, unknown> = structuredClone(rule) as unknown as Record<string, unknown>;
  const allowed: Record<ScoringRule['kind'], (keyof RuleTweaks)[]> = {
    rally: ['pointsToWin', 'gamesToWin'],
    sets: ['setsToWin'],
    goals: ['periodMinutes'],
    innings: ['oversPerInnings'],
    series: [],
    bouts: [],
    performance: [],
    scorecard: [],
  };
  for (const [key, value] of set) {
    if (!allowed[rule.kind].includes(key)) {
      throw new RuleTweakError(`This sport's matches cannot change ${key}.`);
    }
    const [lo, hi] = TWEAK_LIMITS[key];
    if (!Number.isInteger(value) || value < lo || value > hi) {
      throw new RuleTweakError(`${key} must be a whole number from ${lo} to ${hi}.`);
    }
    next[key] = value;
  }
  if (rule.kind === 'rally' && tweaks.pointsToWin) {
    // A cap or a shorter decider sized for the old target no longer fits it.
    const target = tweaks.pointsToWin;
    if (rule.hardCap !== null) next['hardCap'] = Math.max(target, rule.hardCap - rule.pointsToWin + target);
    if (rule.decidingGame) {
      const deciding = Math.min(rule.decidingGame.pointsToWin, target);
      next['decidingGame'] = {
        pointsToWin: deciding,
        hardCap: rule.decidingGame.hardCap === null ? null : Math.max(deciding, rule.decidingGame.hardCap - rule.decidingGame.pointsToWin + deciding),
      };
    }
    if (rule.switchEndsAt !== undefined) {
      const deciding = (next['decidingGame'] as { pointsToWin: number } | undefined)?.pointsToWin ?? target;
      next['switchEndsAt'] = Math.max(1, Math.ceil(deciding / 2));
    }
  }
  // A one-game match has no separate deciding game: its one game is played to
  // the points the host sees ("1 game to 11"), not to the decider's 15.
  if (rule.kind === 'rally' && next['gamesToWin'] === 1 && next['decidingGame'] !== undefined) {
    delete next['decidingGame'];
  }
  const parsed = scoringRuleSchema.safeParse(next);
  if (!parsed.success) throw new RuleTweakError('Those numbers do not make a playable match.');
  return parsed.data;
}
