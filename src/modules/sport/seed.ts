/**
 * sport — seed data (sport R1).
 *
 * Every sport, format, skill band and scoring rule is version-controlled data.
 * There are no runtime writes in Phase 1; admin editing is a later concern.
 *
 * A second sport is an entry in this file plus `pnpm seed`. If adding one ever
 * requires a code change somewhere else, that somewhere else has a bug.
 */
import type { Db, Tx } from '../../platform/db.js';
import { newId } from '../../platform/ids.js';
import { parseScoringRule, type ScoringRule } from './service/scoringRule.js';

export interface FormatSeed {
  key: string;
  name: string;
  teamSize: number;
  /** Overrides the sport-wide rule for this format only. */
  scoringRule?: ScoringRule;
}

export interface SkillBandSeed {
  key: string;
  label: string;
  lowerBound: number | null;
  upperBound: number | null;
}

export interface SportSeed {
  slug: string;
  name: string;
  sortOrder: number;
  formats: FormatSeed[];
  skillBands: SkillBandSeed[];
  /** The default, used whenever a format has no rule of its own. */
  scoringRule: ScoringRule;
}

/**
 * sport R2 — one ladder for every sport (issue log 2026-10-06 #5): the
 * DUPR-style 2.5–5.0+ scale pickleball launched with, so a level reads the
 * same whichever sport a player picks. Migration 038 moved the old
 * Beginner / Intermediate / Advanced / Open keys onto it.
 */
export const SKILL_BANDS: SkillBandSeed[] = [
  { key: '2.5', label: '2.5 · Beginner', lowerBound: 2.5, upperBound: 2.99 },
  { key: '3.0', label: '3.0 · Novice', lowerBound: 3.0, upperBound: 3.49 },
  { key: '3.5', label: '3.5 · Intermediate', lowerBound: 3.5, upperBound: 3.99 },
  { key: '4.0', label: '4.0 · Advanced', lowerBound: 4.0, upperBound: 4.49 },
  { key: '4.5', label: '4.5 · Competitive', lowerBound: 4.5, upperBound: 4.99 },
  { key: '5.0+', label: '5.0+ · Pro', lowerBound: 5.0, upperBound: null },
];

export const PICKLEBALL: SportSeed = {
  slug: 'pickleball',
  name: 'Pickleball',
  sortOrder: 0,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
    { key: 'mixed_doubles', name: 'Mixed Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'rally',
    pointsToWin: 11,
    winBy: 2,
    hardCap: 15,
    gamesToWin: 2,
    serveModel: 'rally',
    decidingGame: { pointsToWin: 15, hardCap: 21 },
    switchEndsAt: 6,
  },
};

export const BADMINTON: SportSeed = {
  slug: 'badminton',
  name: 'Badminton',
  sortOrder: 1,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
    { key: 'mixed_doubles', name: 'Mixed Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'rally',
    pointsToWin: 21,
    winBy: 2,
    hardCap: 30,
    gamesToWin: 2,
    serveModel: 'rally',
    switchEndsAt: 11,
  },
};

export const TABLE_TENNIS: SportSeed = {
  slug: 'table-tennis',
  name: 'Table Tennis',
  sortOrder: 2,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'rally',
    pointsToWin: 11,
    winBy: 2,
    hardCap: null,
    gamesToWin: 3,
    serveModel: 'rally',
  },
};

export const TENNIS: SportSeed = {
  slug: 'tennis',
  name: 'Tennis',
  sortOrder: 3,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
    { key: 'mixed_doubles', name: 'Mixed Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'sets',
    gamePointsToWin: 4,
    setGamesToWin: 6,
    setWinBy: 2,
    setsToWin: 2,
    setTiebreakAt: 6,
    tiebreakPointsToWin: 7,
    tiebreakWinBy: 2,
    finalSetIsFullSet: false,
  },
};

export const FOOTBALL: SportSeed = {
  slug: 'football',
  name: 'Football',
  sortOrder: 4,
  formats: [
    { key: 'five_a_side', name: '5-a-side', teamSize: 5 },
    { key: 'seven_a_side', name: '7-a-side', teamSize: 7 },
    { key: 'eleven_a_side', name: '11-a-side', teamSize: 11 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'goals',
    periods: 2,
    periodMinutes: 45,
    tiebreaker: 'extra_period_then_shootout',
    extraPeriodMinutes: 15,
    extraPeriods: 2,
    actions: [{ key: 'goal', label: 'Goal', value: 1 }],
  },
};

export const BASKETBALL: SportSeed = {
  slug: 'basketball',
  name: 'Basketball',
  sortOrder: 5,
  formats: [
    { key: 'five_on_five', name: '5-on-5', teamSize: 5 },
    { key: 'three_on_three', name: '3x3', teamSize: 3 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'goals',
    periods: 4,
    periodMinutes: 10,
    tiebreaker: 'extra_period',
    extraPeriodMinutes: 5,
    extraPeriods: 1,
    repeatExtraPeriods: true,
    actions: [
      { key: 'free_throw', label: 'Free throw', value: 1 },
      { key: 'two', label: '2 points', value: 2 },
      { key: 'three', label: '3 points', value: 3 },
    ],
  },
};

export const VOLLEYBALL: SportSeed = {
  slug: 'volleyball',
  name: 'Volleyball',
  sortOrder: 6,
  formats: [
    { key: 'indoor', name: 'Indoor 6v6', teamSize: 6 },
    {
      key: 'beach',
      name: 'Beach 2v2',
      teamSize: 2,
      // FIVB beach: sets to 21, best of 3, deciding set to 15.
      scoringRule: { kind: 'rally', pointsToWin: 21, winBy: 2, hardCap: null, gamesToWin: 2, serveModel: 'rally', decidingGame: { pointsToWin: 15, hardCap: null } },
    },
  ],
  skillBands: SKILL_BANDS,
  // FIVB indoor: sets to 25, win by 2, best of 5, the fifth to 15.
  scoringRule: { kind: 'rally', pointsToWin: 25, winBy: 2, hardCap: null, gamesToWin: 3, serveModel: 'rally', decidingGame: { pointsToWin: 15, hardCap: null } },
};

export const SQUASH: SportSeed = {
  slug: 'squash',
  name: 'Squash',
  sortOrder: 7,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  // World Squash PAR-11: every rally scores, 10–10 needs 2 clear, best of 5.
  scoringRule: { kind: 'rally', pointsToWin: 11, winBy: 2, hardCap: null, gamesToWin: 3, serveModel: 'rally' },
};

export const PADEL: SportSeed = {
  slug: 'padel',
  name: 'Padel',
  sortOrder: 8,
  formats: [
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
    { key: 'mixed_doubles', name: 'Mixed Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  // FIP club play: golden point at deuce (gameWinBy 1), tiebreak at 6–6,
  // super tiebreak to 10 instead of a third set.
  scoringRule: {
    kind: 'sets',
    gamePointsToWin: 4,
    gameWinBy: 1,
    setGamesToWin: 6,
    setWinBy: 2,
    setsToWin: 2,
    setTiebreakAt: 6,
    tiebreakPointsToWin: 7,
    tiebreakWinBy: 2,
    finalSetIsFullSet: false,
    finalSetMatchTiebreak: { pointsToWin: 10, winBy: 2 },
  },
};

export const KABADDI: SportSeed = {
  slug: 'kabaddi',
  name: 'Kabaddi',
  sortOrder: 9,
  formats: [{ key: 'standard', name: 'Standard (7-a-side)', teamSize: 7 }],
  skillBands: SKILL_BANDS,
  scoringRule: {
    kind: 'goals',
    periods: 2,
    periodMinutes: 20,
    // Binary scored/missed kicks stand in for the 5-raid tiebreaker until a
    // later plan models raid points; a level match must never finish as a draw.
    tiebreaker: 'shootout',
    extraPeriodMinutes: null,
    actions: [
      { key: 'raid_1', label: 'Raid +1', value: 1 },
      { key: 'raid_2', label: 'Raid +2', value: 2 },
      { key: 'raid_3', label: 'Raid +3', value: 3 },
      { key: 'bonus', label: 'Bonus +1', value: 1 },
      { key: 'tackle', label: 'Tackle +1', value: 1 },
      { key: 'super_tackle', label: 'Super tackle +2', value: 2 },
      { key: 'all_out', label: 'All out +2', value: 2 },
    ],
  },
};

const CRICKET_EXTRAS = { wideRuns: 1, noBallRuns: 1, freeHit: true };

export const CRICKET: SportSeed = {
  slug: 'cricket',
  name: 'Cricket',
  sortOrder: 10,
  formats: [
    { key: 't20', name: 'T20 (11-a-side)', teamSize: 11 },
    {
      key: 't10',
      name: 'T10 (11-a-side)',
      teamSize: 11,
      scoringRule: { kind: 'innings', oversPerInnings: 10, ballsPerOver: 6, wicketsPerInnings: 10, maxOversPerBowler: 2, extras: CRICKET_EXTRAS, tiebreaker: 'super_over' },
    },
    {
      key: 'odi',
      name: 'One-day (50 overs)',
      teamSize: 11,
      scoringRule: { kind: 'innings', oversPerInnings: 50, ballsPerOver: 6, wicketsPerInnings: 10, maxOversPerBowler: 10, extras: CRICKET_EXTRAS, tiebreaker: 'super_over' },
    },
    {
      key: 'box',
      name: 'Box cricket (6-a-side)',
      teamSize: 6,
      // Box cricket: 6 overs, the innings ends when 5 of 6 batters are out.
      scoringRule: { kind: 'innings', oversPerInnings: 6, ballsPerOver: 6, wicketsPerInnings: 5, maxOversPerBowler: 2, extras: CRICKET_EXTRAS, tiebreaker: 'super_over' },
    },
  ],
  skillBands: SKILL_BANDS,
  // MCC Laws for limited-overs cricket: T20, 4 overs a bowler, a free hit after a no-ball, a super over for a tie.
  scoringRule: { kind: 'innings', oversPerInnings: 20, ballsPerOver: 6, wicketsPerInnings: 10, maxOversPerBowler: 4, extras: CRICKET_EXTRAS, tiebreaker: 'super_over' },
};

const SINGLES_ONLY = [{ key: 'singles', name: 'Singles', teamSize: 1 }];
const SERIES = { maxUnits: null, allowDraws: false, unitScore: null, unitPointTarget: null, maxEventsPerUnit: null } as const;

export const SNOOKER: SportSeed = {
  slug: 'snooker',
  name: 'Snooker',
  sortOrder: 11,
  formats: SINGLES_ONLY,
  skillBands: SKILL_BANDS,
  // WPBSA: ball values 1–7, a frame to the higher score, best of 5 frames. A foul is points to the opponent.
  scoringRule: {
    kind: 'series', ...SERIES, unitName: 'frame', unitsToWin: 3, unitScoring: 'points',
    actions: [
      { key: 'red', label: 'Red', value: 1 },
      { key: 'yellow', label: 'Yellow', value: 2 },
      { key: 'green', label: 'Green', value: 3 },
      { key: 'brown', label: 'Brown', value: 4 },
      { key: 'blue', label: 'Blue', value: 5 },
      { key: 'pink', label: 'Pink', value: 6 },
      { key: 'black', label: 'Black', value: 7 },
    ],
  },
};

export const POOL: SportSeed = {
  slug: 'pool',
  name: 'Pool',
  sortOrder: 12,
  formats: [
    { key: 'nine_ball', name: '9-ball', teamSize: 1 },
    { key: 'eight_ball', name: '8-ball', teamSize: 1 },
  ],
  skillBands: SKILL_BANDS,
  // WPA: race to 5 racks.
  scoringRule: { kind: 'series', ...SERIES, unitName: 'rack', unitsToWin: 5, unitScoring: 'win_only' },
};

export const BILLIARDS: SportSeed = {
  slug: 'billiards',
  name: 'Billiards',
  sortOrder: 13,
  formats: SINGLES_ONLY,
  skillBands: SKILL_BANDS,
  // English billiards: pots, in-offs and cannons to 150; a foul is 2 to the opponent.
  scoringRule: {
    kind: 'series', ...SERIES, unitName: 'game', unitsToWin: 1, unitScoring: 'points', unitPointTarget: 150,
    actions: [
      { key: 'pot_red', label: 'Pot red', value: 3 },
      { key: 'pot_white', label: 'Pot white', value: 2 },
      { key: 'in_off_red', label: 'In-off red', value: 3 },
      { key: 'in_off_white', label: 'In-off white', value: 2 },
      { key: 'cannon', label: 'Cannon', value: 2 },
    ],
  },
};

export const CARROM: SportSeed = {
  slug: 'carrom',
  name: 'Carrom',
  sortOrder: 14,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
  ],
  skillBands: SKILL_BANDS,
  // ICF: a game to 25 points or 8 boards; best of 3 games. A board scores the coins left (+3 for the queen).
  scoringRule: { kind: 'series', ...SERIES, unitName: 'game', unitsToWin: 2, unitScoring: 'points', unitPointTarget: 25, maxEventsPerUnit: 8 },
};

export const CHESS: SportSeed = {
  slug: 'chess',
  name: 'Chess',
  sortOrder: 15,
  formats: [
    { key: 'classical', name: 'Classical', teamSize: 1 },
    { key: 'rapid', name: 'Rapid', teamSize: 1 },
    { key: 'blitz', name: 'Blitz', teamSize: 1 },
  ],
  skillBands: SKILL_BANDS,
  // FIDE: one game — a win is 1, a draw half each.
  scoringRule: { kind: 'series', ...SERIES, unitName: 'game', unitsToWin: 1, maxUnits: 1, unitScoring: 'win_only', allowDraws: true },
};

export const ESPORTS: SportSeed = {
  slug: 'esports',
  name: 'Esports',
  sortOrder: 16,
  formats: [
    { key: 'tactical_shooter', name: 'Tactical shooter (Valorant, CS2) · Best of 3', teamSize: 5 },
    {
      key: 'moba',
      name: 'MOBA (League, Dota) · Best of 3',
      teamSize: 5,
      scoringRule: { kind: 'series', ...SERIES, unitName: 'game', unitsToWin: 2, unitScoring: 'win_only' },
    },
    {
      // Battle royale is a field contest: one lobby, placement points plus kills.
      key: 'battle_royale',
      name: 'Battle royale (BGMI, Free Fire)',
      teamSize: 4,
      scoringRule: {
        kind: 'performance', measure: 'points', better: 'higher', attempts: 1, lifts: null, refereeLights: null,
        judges: null, dropHighLow: false, placementPoints: [10, 6, 5, 4, 3, 2, 1, 1], perKillPoints: 1,
      },
    },
    {
      key: 'one_v_one',
      name: '1v1 · Best of 3',
      teamSize: 1,
      scoringRule: { kind: 'series', ...SERIES, unitName: 'game', unitsToWin: 2, unitScoring: 'win_only' },
    },
  ],
  skillBands: SKILL_BANDS,
  // A map is first to 13 rounds, or 2 clear in overtime; best of 3 maps.
  scoringRule: { kind: 'series', ...SERIES, unitName: 'map', unitsToWin: 2, unitScoring: 'win_only', unitScore: { pointsToWin: 13, winBy: 2 } },
};

const BOUT = [{ key: 'bout', name: 'Bout', teamSize: 1 }];
const JUDGED = {
  decision: 'judges' as const,
  judges: 3,
  actions: [],
  pointGap: null,
  roundsToWin: null,
  firstPointAdvantage: false,
  penaltyToOpponent: 0,
  maxPenalties: null,
};

export const BOXING: SportSeed = {
  slug: 'boxing',
  name: 'Boxing',
  sortOrder: 17,
  formats: BOUT,
  skillBands: SKILL_BANDS,
  // 10-point must, three judges, 3 × 3 minutes (amateur).
  scoringRule: { kind: 'bouts', ...JUDGED, rounds: 3, roundSeconds: 180, finishes: ['ko', 'tko', 'rsc', 'dq'] },
};

export const MMA: SportSeed = {
  slug: 'mma',
  name: 'MMA',
  sortOrder: 18,
  formats: [
    { key: 'bout', name: 'Bout (3 rounds)', teamSize: 1 },
    {
      key: 'main_event',
      name: 'Main event (5 rounds)',
      teamSize: 1,
      scoringRule: { kind: 'bouts', ...JUDGED, rounds: 5, roundSeconds: 300, finishes: ['ko', 'tko', 'submission', 'dq'] },
    },
  ],
  skillBands: SKILL_BANDS,
  // Unified Rules: 10-point must, three judges, 3 × 5 minutes.
  scoringRule: { kind: 'bouts', ...JUDGED, rounds: 3, roundSeconds: 300, finishes: ['ko', 'tko', 'submission', 'dq'] },
};

const WRESTLING_MOVES = [
  { key: 'one', label: '+1', value: 1 },
  { key: 'takedown', label: '+2 Takedown', value: 2 },
  { key: 'four', label: '+4', value: 4 },
  { key: 'five', label: '+5 Grand throw', value: 5 },
];

export const WRESTLING: SportSeed = {
  slug: 'wrestling',
  name: 'Wrestling',
  sortOrder: 19,
  formats: [
    { key: 'freestyle', name: 'Freestyle', teamSize: 1 },
    {
      key: 'greco_roman',
      name: 'Greco-Roman',
      teamSize: 1,
      scoringRule: {
        kind: 'bouts', decision: 'points', judges: null, rounds: 2, roundSeconds: 180, actions: WRESTLING_MOVES, pointGap: 8,
        roundsToWin: null, firstPointAdvantage: false, penaltyToOpponent: 1, maxPenalties: 3, finishes: ['fall', 'injury', 'dq'],
      },
    },
  ],
  skillBands: SKILL_BANDS,
  // UWW freestyle: 2 × 3 minutes, a 10-point lead is technical superiority, a caution gives the opponent a point, three disqualify.
  scoringRule: {
    kind: 'bouts', decision: 'points', judges: null, rounds: 2, roundSeconds: 180, actions: WRESTLING_MOVES, pointGap: 10,
    roundsToWin: null, firstPointAdvantage: false, penaltyToOpponent: 1, maxPenalties: 3, finishes: ['fall', 'injury', 'dq'],
  },
};

export const KARATE: SportSeed = {
  slug: 'karate',
  name: 'Karate',
  sortOrder: 20,
  formats: [{ key: 'kumite', name: 'Kumite', teamSize: 1 }],
  skillBands: SKILL_BANDS,
  // WKF kumite: yuko 1, waza-ari 2, ippon 3; an 8-point lead ends it; senshu decides a level bout; hansoku on the 5th penalty.
  scoringRule: {
    kind: 'bouts', decision: 'points', judges: null, rounds: 1, roundSeconds: 180,
    actions: [
      { key: 'yuko', label: 'Yuko +1', value: 1 },
      { key: 'waza_ari', label: 'Waza-ari +2', value: 2 },
      { key: 'ippon', label: 'Ippon +3', value: 3 },
    ],
    pointGap: 8, roundsToWin: null, firstPointAdvantage: true, penaltyToOpponent: 0, maxPenalties: 5, finishes: ['dq', 'injury'],
  },
};

export const TAEKWONDO: SportSeed = {
  slug: 'taekwondo',
  name: 'Taekwondo',
  sortOrder: 21,
  formats: [{ key: 'kyorugi', name: 'Kyorugi', teamSize: 1 }],
  skillBands: SKILL_BANDS,
  // World Taekwondo: best of 3 rounds of 2 minutes, a 15-point gap ends a round (from June 2026, when a spinning head kick went to 6), a gam-jeom gives the opponent a point.
  scoringRule: {
    kind: 'bouts', decision: 'points', judges: null, rounds: 3, roundSeconds: 120,
    actions: [
      { key: 'punch', label: 'Punch +1', value: 1 },
      { key: 'body', label: 'Body +2', value: 2 },
      { key: 'head', label: 'Head +3', value: 3 },
      { key: 'spin_body', label: 'Spin body +4', value: 4 },
      { key: 'spin_head', label: 'Spin head +6', value: 6 },
    ],
    pointGap: 15, roundsToWin: 2, firstPointAdvantage: false, penaltyToOpponent: 1, maxPenalties: null, finishes: ['ko', 'dq', 'injury'],
  },
};

/** Plans 7, 8 — field contests are run as heats, never brackets. */
const MARK = {
  kind: 'performance' as const,
  attempts: 1,
  lifts: null,
  refereeLights: null,
  judges: null,
  dropHighLow: false,
  placementPoints: null,
  perKillPoints: null,
};
const INDIVIDUAL = [{ key: 'individual', name: 'Individual', teamSize: 1 }];
/** A race is timed in seconds; the lowest time wins. */
const RACE = { ...MARK, measure: 'time' as const, better: 'lower' as const };

export const RUNNING: SportSeed = {
  slug: 'running',
  name: 'Running',
  sortOrder: 22,
  formats: [
    { key: '5k', name: '5K', teamSize: 1 },
    { key: '10k', name: '10K', teamSize: 1 },
    { key: 'half_marathon', name: 'Half marathon', teamSize: 1 },
    { key: 'marathon', name: 'Marathon', teamSize: 1 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: RACE,
};

export const CYCLING: SportSeed = {
  slug: 'cycling',
  name: 'Cycling',
  sortOrder: 23,
  formats: [
    { key: 'time_trial', name: 'Time trial', teamSize: 1 },
    { key: 'road_race', name: 'Road race', teamSize: 1 },
  ],
  skillBands: SKILL_BANDS,
  // A time trial records each rider's own time (finish minus their start slot).
  scoringRule: RACE,
};

export const SWIMMING: SportSeed = {
  slug: 'swimming',
  name: 'Swimming',
  sortOrder: 24,
  formats: [
    { key: '50_free', name: '50 m freestyle', teamSize: 1 },
    { key: '100_free', name: '100 m freestyle', teamSize: 1 },
    { key: '100_breast', name: '100 m breaststroke', teamSize: 1 },
    { key: '100_back', name: '100 m backstroke', teamSize: 1 },
    { key: '100_fly', name: '100 m butterfly', teamSize: 1 },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: RACE,
};

const JUMP = { ...MARK, measure: 'distance' as const, better: 'higher' as const, attempts: 3 };

export const ATHLETICS: SportSeed = {
  slug: 'athletics',
  name: 'Athletics',
  sortOrder: 25,
  formats: [
    { key: '100m', name: '100 m', teamSize: 1 },
    { key: '400m', name: '400 m', teamSize: 1 },
    { key: 'long_jump', name: 'Long jump', teamSize: 1, scoringRule: JUMP },
    { key: 'shot_put', name: 'Shot put', teamSize: 1, scoringRule: JUMP },
    { key: 'javelin', name: 'Javelin', teamSize: 1, scoringRule: JUMP },
  ],
  skillBands: SKILL_BANDS,
  // Track events by default: time, lowest wins. Field events (jumps, throws): best of three, longest wins.
  scoringRule: RACE,
};

export const POWERLIFTING: SportSeed = {
  slug: 'powerlifting',
  name: 'Powerlifting',
  sortOrder: 26,
  formats: INDIVIDUAL,
  skillBands: SKILL_BANDS,
  // IPF: squat, bench, deadlift — 3 attempts each, 3 referees, total of the best good lifts.
  scoringRule: {
    ...MARK, measure: 'weight', better: 'higher', attempts: 3, lifts: ['squat', 'bench', 'deadlift'], refereeLights: 3,
  },
};

export const WEIGHTLIFTING: SportSeed = {
  slug: 'weightlifting',
  name: 'Weightlifting',
  sortOrder: 27,
  formats: INDIVIDUAL,
  skillBands: SKILL_BANDS,
  // IWF: snatch and clean & jerk — 3 attempts each, total of the best good lifts.
  scoringRule: {
    ...MARK, measure: 'weight', better: 'higher', attempts: 3, lifts: ['snatch', 'clean_and_jerk'], refereeLights: 3,
  },
};

export const CALISTHENICS: SportSeed = {
  slug: 'calisthenics',
  name: 'Calisthenics',
  sortOrder: 28,
  formats: [
    { key: 'freestyle', name: 'Freestyle', teamSize: 1 },
    {
      key: 'reps',
      name: 'Max reps',
      teamSize: 1,
      scoringRule: { ...MARK, measure: 'reps', better: 'higher' },
    },
  ],
  skillBands: SKILL_BANDS,
  // A 5-judge panel, the highest and lowest dropped, the middle three averaged.
  scoringRule: { ...MARK, measure: 'judged', better: 'higher', judges: 5, dropHighLow: true },
};

export const GYM: SportSeed = {
  slug: 'gym',
  name: 'Gym / Fitness',
  sortOrder: 29,
  formats: [
    { key: 'max_reps', name: 'Max reps challenge', teamSize: 1 },
    { key: 'max_weight', name: 'Max weight challenge', teamSize: 1, scoringRule: { ...MARK, measure: 'weight', better: 'higher', attempts: 3 } },
    { key: 'fastest_time', name: 'Fastest time challenge', teamSize: 1, scoringRule: RACE },
  ],
  skillBands: SKILL_BANDS,
  scoringRule: { ...MARK, measure: 'reps', better: 'higher' },
};

export const GOLF: SportSeed = {
  slug: 'golf',
  name: 'Golf',
  sortOrder: 30,
  formats: [
    { key: 'stroke_play', name: 'Stroke play (18 holes)', teamSize: 1 },
    {
      key: 'nine_holes',
      name: 'Stroke play (9 holes)',
      teamSize: 1,
      scoringRule: { kind: 'scorecard', method: 'strokes', units: 9, par: [4, 4, 3, 5, 4, 4, 3, 4, 5], arrowsPerEnd: null },
    },
  ],
  skillBands: SKILL_BANDS,
  // A par-72 card; a course's own pars replace these per event later.
  scoringRule: {
    kind: 'scorecard', method: 'strokes', units: 18,
    par: [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 5, 4, 4, 3, 4, 5, 4], arrowsPerEnd: null,
  },
};

export const BOWLING: SportSeed = {
  slug: 'bowling',
  name: 'Bowling',
  sortOrder: 31,
  formats: INDIVIDUAL,
  skillBands: SKILL_BANDS,
  // Ten-pin: 10 frames, strikes and spares score their bonus rolls.
  scoringRule: { kind: 'scorecard', method: 'tenpin', units: 10, par: null, arrowsPerEnd: null },
};

export const ARCHERY: SportSeed = {
  slug: 'archery',
  name: 'Archery',
  sortOrder: 32,
  formats: [{ key: 'recurve_70m', name: 'Recurve 70 m', teamSize: 1 }],
  skillBands: SKILL_BANDS,
  // World Archery: 6 ends of 6 arrows; ties on 10s (Xs included), then Xs.
  scoringRule: { kind: 'scorecard', method: 'ends', units: 6, par: null, arrowsPerEnd: 6 },
};

export const LAUNCH_SPORTS: SportSeed[] = [
  PICKLEBALL,
  BADMINTON,
  TABLE_TENNIS,
  TENNIS,
  FOOTBALL,
  BASKETBALL,
  VOLLEYBALL,
  SQUASH,
  PADEL,
  KABADDI,
  CRICKET,
  SNOOKER,
  POOL,
  BILLIARDS,
  CARROM,
  CHESS,
  ESPORTS,
  BOXING,
  MMA,
  WRESTLING,
  KARATE,
  TAEKWONDO,
  RUNNING,
  CYCLING,
  SWIMMING,
  ATHLETICS,
  POWERLIFTING,
  WEIGHTLIFTING,
  CALISTHENICS,
  GYM,
  GOLF,
  BOWLING,
  ARCHERY,
];

/**
 * Idempotent: `pnpm seed` runs on every deploy, and re-running it must not
 * duplicate a format or orphan a scoring rule.
 *
 * Returns the sport id so a caller — the multi-sport acceptance test, say —
 * can clean up after itself.
 */
export async function seedSport(db: Db | Tx, seed: SportSeed): Promise<string> {
  // The JSONB column has no shape of its own; this is the only thing that
  // validates it (sport R1, and the 02-sport checklist).
  parseScoringRule(seed.scoringRule);
  for (const f of seed.formats) {
    if (f.scoringRule) parseScoringRule(f.scoringRule);
  }

  const sportRow = await db.sport.upsert({
    where: { slug: seed.slug },
    create: {
      id: newId(),
      slug: seed.slug,
      name: seed.name,
      sortOrder: seed.sortOrder,
    },
    update: { name: seed.name, sortOrder: seed.sortOrder },
  });

  const formatIds = new Map<string, string>();
  for (const f of seed.formats) {
    const row = await db.format.upsert({
      where: { sportId_key: { sportId: sportRow.id, key: f.key } },
      create: {
        id: newId(),
        sportId: sportRow.id,
        key: f.key,
        name: f.name,
        teamSize: f.teamSize,
      },
      update: { name: f.name, teamSize: f.teamSize },
    });
    formatIds.set(f.key, row.id);
  }

  for (const [i, b] of seed.skillBands.entries()) {
    await db.skillBand.upsert({
      where: { sportId_key: { sportId: sportRow.id, key: b.key } },
      create: {
        id: newId(),
        sportId: sportRow.id,
        key: b.key,
        label: b.label,
        lowerBound: b.lowerBound,
        upperBound: b.upperBound,
        sortOrder: i,
      },
      update: {
        label: b.label,
        lowerBound: b.lowerBound,
        upperBound: b.upperBound,
        sortOrder: i,
      },
    });
  }

  const rules: [string | null, ScoringRule][] = [[null, seed.scoringRule]];
  for (const f of seed.formats) {
    if (f.scoringRule) rules.push([formatIds.get(f.key) ?? null, f.scoringRule]);
  }
  for (const [formatId, rule] of rules) {
    // findFirst + create rather than upsert: a compound unique whose second
    // column is NULL is not addressable through Prisma's `where` input.
    const existing = await db.scoringRule.findFirst({
      where: { sportId: sportRow.id, formatId },
    });
    if (existing) {
      await db.scoringRule.update({ where: { id: existing.id }, data: { rule } });
    } else {
      await db.scoringRule.create({
        data: { id: newId(), sportId: sportRow.id, formatId, rule },
      });
    }
  }

  return sportRow.id;
}

export async function seedLaunchSports(db: Db | Tx): Promise<string[]> {
  const ids: string[] = [];
  for (const s of LAUNCH_SPORTS) ids.push(await seedSport(db, s));
  return ids;
}
