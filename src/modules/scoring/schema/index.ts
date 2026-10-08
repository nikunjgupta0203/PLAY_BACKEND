/**
 * scoring — GraphQL surface (docs/modules/10-scoring.md).
 *
 * Adds the score to `Match` rather than defining a second match type: the
 * spectator's page, the scorer's page and the bracket all read one object, so
 * a cache normalised on `Match.id` cannot disagree with itself.
 *
 * Point mutations return `MatchPayload` — the whole match, fresh — on success
 * AND on failure. SCORE_STALE (R1) is only useful to a client that is told what
 * the server now holds, and a UserError carries a code and a message, not a
 * score; the payload's `match` is where the server state travels.
 */
import { builder } from '../../../graphql/builder.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { isUserError, UserError } from '../../../platform/errors/index.js';
import { RegistrationRef } from '../../registration/schema/index.js';
import { tournament } from '../../tournament/index.js';
import type { Match } from '../../tournament/index.js';
import { MatchPayload, MatchRef } from '../../tournament/schema/index.js';
import { kicksNext, scoring } from '../index.js';
import type {
  BoutState,
  Dismissal,
  GameScore,
  InningsRecord,
  InningsState,
  Outcome,
  ResultRow,
  ScoreEvent,
  ScoreState,
  Shootout,
  Side,
} from '../index.js';
import type { ConfirmedVia, ResultSource } from '../finality.js';

// --- enums -------------------------------------------------------------------

const MatchSideEnum = builder.enumType('MatchSide', {
  description: 'A is `Match.sideA`, B is `Match.sideB`.',
  values: { A: { value: 'a' as Side }, B: { value: 'b' as Side } },
});

const MatchOutcomeEnum = builder.enumType('MatchOutcome', {
  description:
    'scoring R10 — only PLAYED carries a point log, and only PLAYED moves a ' +
    'rating (rating R7).',
  values: {
    PLAYED: { value: 'played' as Outcome },
    WALKOVER: { value: 'walkover' as Outcome },
    RETIRED: { value: 'retired' as Outcome },
    FORFEIT: { value: 'forfeit' as Outcome },
  },
});

const ResultSourceEnum = builder.enumType('ResultSource', {
  description:
    'scoring R12 — LIVE came from the point log; TYPED was entered on the result ' +
    'screen. A result a player typed never confirms itself.',
  values: {
    LIVE: { value: 'live' as ResultSource },
    TYPED: { value: 'typed' as ResultSource },
  },
});

const ResultConfirmationEnum = builder.enumType('ResultConfirmation', {
  description: 'How a result became final (scoring R6, R11).',
  values: {
    OPPONENT: { value: 'opponent' as ConfirmedVia },
    STAFF: { value: 'staff' as ConfirmedVia },
    AUTO: { value: 'auto' as ConfirmedVia },
    DEFAULT: {
      value: 'default' as ConfirmedVia,
      description: 'gap #20 — a dispute nobody settled, closed on the submitted result. Never rated.',
    },
  },
});

const ScoringKindEnum = builder.enumType('ScoringKind', {
  description:
    'The scoring family. RALLY: points within games (pickleball, badminton, table tennis, volleyball, squash). ' +
    'SETS: points within games within sets (tennis, padel). GOALS: a running score over periods (football, basketball, kabaddi). ' +
    'INNINGS: runs and wickets over a number of balls, one innings a side (cricket). ' +
    'SERIES: a race of units — frames, racks, games, maps (snooker, pool, billiards, carrom, chess, esports). ' +
    'BOUTS: rounds between two fighters, on judges’ cards or on points (boxing, MMA, wrestling, karate, taekwondo).',
  values: {
    RALLY: { value: 'rally' as ScoreState['kind'] },
    SETS: { value: 'sets' as ScoreState['kind'] },
    GOALS: { value: 'goals' as ScoreState['kind'] },
    INNINGS: { value: 'innings' as ScoreState['kind'] },
    SERIES: { value: 'series' as ScoreState['kind'] },
    BOUTS: { value: 'bouts' as ScoreState['kind'] },
  },
});

const BallExtraEnum = builder.enumType('BallExtra', {
  description: 'Plan 4 — what kind of extra a delivery was. Absent for a fair ball.',
  values: {
    WIDE: { value: 'wide' as const },
    NO_BALL: { value: 'no_ball' as const },
    BYE: { value: 'bye' as const },
    LEG_BYE: { value: 'leg_bye' as const },
  },
});

const DismissalEnum = builder.enumType('Dismissal', {
  description: 'Plan 4 — how a batter was out off a delivery.',
  values: {
    BOWLED: { value: 'bowled' as const },
    CAUGHT: { value: 'caught' as const },
    LBW: { value: 'lbw' as const },
    STUMPED: { value: 'stumped' as const },
    RUN_OUT: { value: 'run_out' as const },
    HIT_WICKET: { value: 'hit_wicket' as const },
    OTHER: { value: 'other' as const },
  },
});

const InningsRecordRef = builder.objectRef<InningsRecord>('InningsRecord').implement({
  fields: (t) => ({
    batting: t.field({ type: MatchSideEnum, resolve: (r) => r.batting }),
    runs: t.exposeInt('runs'),
    wickets: t.exposeInt('wickets'),
    balls: t.exposeInt('balls', { description: 'Legal deliveries. Overs are balls ÷ the rule’s ballsPerOver.' }),
    extras: t.exposeInt('extras'),
    target: t.int({ nullable: true, description: 'Runs needed to win, for a chasing innings.', resolve: (r) => r.target }),
    maxBalls: t.exposeInt('maxBalls'),
    maxWickets: t.exposeInt('maxWickets'),
  }),
});

const RoundCardsRef = builder.objectRef<GameScore[]>('RoundCards').implement({
  description: 'One round’s cards, one per judge.',
  fields: (t) => ({ judges: t.field({ type: [GameScoreRef], resolve: (c) => c }) }),
});

const BoutRef = builder.objectRef<BoutState>('Bout').implement({
  description: 'BOUTS only.',
  fields: (t) => ({
    round: t.exposeInt('round', { description: '1-based; one past the last once the bout is over.' }),
    cards: t.field({ type: [RoundCardsRef], description: 'Judged bouts: every round’s cards.', resolve: (b) => b.cards }),
    roundsWon: t.field({ type: GameScoreRef, resolve: (b) => b.roundsWon }),
    penalties: t.field({ type: GameScoreRef, resolve: (b) => b.penalties }),
    senshu: t.field({ type: MatchSideEnum, nullable: true, description: 'Karate: the first unopposed point.', resolve: (b) => b.senshu }),
    method: t.string({ nullable: true, resolve: (b) => b.method }),
    margin: t.string({ nullable: true, resolve: (b) => b.margin }),
  }),
});

const InningsRef = builder.objectRef<InningsState>('Innings').implement({
  description: 'INNINGS only — every innings so far, the current one last.',
  fields: (t) => ({
    list: t.field({ type: [InningsRecordRef], resolve: (s) => s.list }),
    phase: t.string({ description: 'main | super_over', resolve: (s) => s.phase }),
    freeHit: t.exposeBoolean('freeHit', { description: 'The next legal ball is a free hit: only a run out dismisses.' }),
  }),
});

const ScoreEventTypeEnum = builder.enumType('ScoreEventType', {
  description: 'What a scorer recorded. The sport’s rule decides which it takes (scoring R4).',
  values: {
    POINT: { value: 'point' as const },
    SCORE: { value: 'score' as const, description: 'A named score action: `action` is one of the rule’s action keys.' },
    PERIOD_END: { value: 'period_end' as const },
    SHOOTOUT_KICK: { value: 'shootout_kick' as const, description: '`scored` says whether it went in.' },
    BALL: { value: 'ball' as const, description: 'INNINGS — one delivery: `runs`, optional `extra` and `wicket`.' },
    UNIT_WON: { value: 'unit_won' as const, description: 'SERIES — a unit won by `side`, with `unitScore` where the rule wants one.' },
    UNIT_DRAWN: { value: 'unit_drawn' as const, description: 'SERIES — a drawn unit (chess): half a point each.' },
    UNIT_END: { value: 'unit_end' as const, description: 'SERIES — close a points unit; the higher score takes it.' },
    POINTS: { value: 'points' as const, description: 'SERIES — `value` points to `side` inside the unit.' },
    ROUND_CARDS: { value: 'round_cards' as const, description: 'BOUTS (judged) — the round’s `cards`, one per judge, 10-point must.' },
    ROUND_END: { value: 'round_end' as const, description: 'BOUTS (points) — the round’s clock ran out.' },
    PENALTY: { value: 'penalty' as const, description: 'BOUTS — a penalty against `side`.' },
    FINISH: { value: 'finish' as const, description: 'BOUTS — `side` won early by `method` (ko, submission, fall…).' },
  },
});

// --- types -------------------------------------------------------------------

const GameScoreRef = builder.objectRef<GameScore>('GameScore').implement({
  fields: (t) => ({
    a: t.exposeInt('a'),
    b: t.exposeInt('b'),
  }),
});

const ShootoutRef = builder.objectRef<Shootout & { over: boolean }>('Shootout').implement({
  description: 'Kicks taken, in order: true scored, false missed.',
  fields: (t) => ({
    a: t.field({ type: ['Boolean'], resolve: (s) => s.a }),
    b: t.field({ type: ['Boolean'], resolve: (s) => s.b }),
    first: t.field({
      type: MatchSideEnum,
      nullable: true,
      description: 'Who kicked first (the coin toss). Null before the first kick.',
      resolve: (s) => s.first ?? (s.a.length + s.b.length > 0 ? ('a' as Side) : null),
    }),
    next: t.field({
      type: MatchSideEnum,
      nullable: true,
      description: 'Who kicks next. Null before the first kick (either side may) and once decided.',
      resolve: (s) => (s.over ? null : kicksNext(s)),
    }),
  }),
});

type ScoreStateOut = ScoreState & { seq: number };

const ScoreStateRef = builder.objectRef<ScoreStateOut>('ScoreState').implement({
  description:
    'scoring R3 — always the complete score, never a delta. A client that missed ' +
    'ten updates is correct on receiving the eleventh.',
  fields: (t) => ({
    kind: t.field({ type: ScoringKindEnum, resolve: (s) => s.kind }),
    games: t.field({
      type: [GameScoreRef],
      description:
        'Completed games (RALLY) or sets, each holding the games won in it (SETS). ' +
        'Empty for GOALS.',
      resolve: (s) => s.games,
    }),
    current: t.field({
      type: GameScoreRef,
      description:
        'Points in the game being played (RALLY), games in the current set (SETS), ' +
        'or the running score (GOALS).',
      resolve: (s) => s.current,
    }),
    points: t.field({
      type: GameScoreRef,
      nullable: true,
      description: 'SETS only — points in the current game or tiebreak.',
      resolve: (s) => s.points,
    }),
    tiebreak: t.exposeBoolean('tiebreak'),
    serving: t.field({
      type: MatchSideEnum,
      nullable: true,
      description: 'Null for a family with no serve.',
      resolve: (s) => s.serving,
    }),
    matchOver: t.exposeBoolean('matchOver'),
    winner: t.field({ type: MatchSideEnum, nullable: true, resolve: (s) => s.winner }),
    period: t.int({
      nullable: true,
      description: 'GOALS only — the period being played, 1-based. Beyond the rule’s `periods` it is extra time.',
      resolve: (s) => (s.kind === 'goals' ? s.period ?? 1 : null),
    }),
    shootout: t.field({
      type: ShootoutRef,
      nullable: true,
      resolve: (s) => (s.shootout ? { ...s.shootout, over: s.matchOver } : null),
    }),
    matchTiebreak: t.boolean({
      description: 'SETS only — the tiebreak being played replaces the deciding set.',
      resolve: (s) => s.matchTiebreak ?? false,
    }),
    innings: t.field({ type: InningsRef, nullable: true, resolve: (s) => s.innings ?? null }),
    bout: t.field({ type: BoutRef, nullable: true, resolve: (s) => s.bout ?? null }),
    seq: t.int({
      description: 'The `expectedSeq` the next write must carry (scoring R1).',
      resolve: (s) => s.seq,
    }),
  }),
});

const ScoringRuleRef = builder
  .objectRef<{ kind: ScoreState['kind']; definition: string }>('ScoringRule')
  .implement({
    description:
      'scoring R4 — what a point means, from the sport module. Clients count with ' +
      'it; they never branch on the sport.',
    fields: (t) => ({
      kind: t.field({ type: ScoringKindEnum, resolve: (r) => r.kind }),
      definition: t.exposeString('definition', {
        description:
          'The rule document as JSON, discriminated by `kind`. Its shape is the ' +
          'sport module’s `scoringRuleSchema`.',
      }),
    }),
  });

const MatchResultRef = builder.objectRef<ResultRow>('MatchResult').implement({
  description:
    'HOW a match was won. It advances the bracket only once confirmed — by the ' +
    'other side, by a scorer who scored it, by an organizer 15 minutes later, or ' +
    'by itself at autoConfirmAt (scoring R6, R11, R12).',
  fields: (t) => ({
    outcome: t.field({ type: MatchOutcomeEnum, resolve: (r) => r.outcome }),
    method: t.string({
      nullable: true,
      description: 'How it was won beyond the scoreline: "shootout" today. Null for a win in normal play.',
      resolve: (r) => r.method,
    }),
    margin: t.string({
      nullable: true,
      description: 'Qualifies the method — the shootout tally "4–3". Null without a method.',
      resolve: (r) => r.margin,
    }),
    games: t.field({
      type: [GameScoreRef],
      description: 'Empty for a walkover (R10).',
      resolve: (r) => r.games,
    }),
    winner: t.field({
      type: RegistrationRef,
      nullable: true,
      description: 'Null for a draw.',
      resolve: (r, _args, ctx) => (r.winnerRegistrationId ? ctx.loaders.registration.load(r.winnerRegistrationId) : null),
    }),
    isDraw: t.boolean({
      description: 'A league or group match that ended level.',
      resolve: (r) => r.winnerRegistrationId === null,
    }),
    submittedAt: t.field({ type: 'DateTime', resolve: (r) => r.submittedAt }),
    confirmedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.confirmedAt }),
    disputedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.disputedAt }),
    disputeReason: t.string({ nullable: true, resolve: (r) => r.disputeReason }),
    source: t.field({ type: ResultSourceEnum, resolve: (r) => r.source }),
    autoConfirmAt: t.field({
      type: 'DateTime',
      nullable: true,
      description:
        'When it confirms itself if nobody disputes it (R11). Null: a person must confirm it.',
      resolve: (r) => r.autoConfirmAt,
    }),
    confirmedVia: t.field({
      type: ResultConfirmationEnum,
      nullable: true,
      resolve: (r) => r.confirmedVia,
    }),
    overrideOpensAt: t.field({
      type: 'DateTime',
      description: 'When an organizer may confirm on the other side’s behalf (R6).',
      resolve: (r) => scoring.overrideOpensAt(r),
    }),
    viewerCanConfirm: t.boolean({
      resolve: async (r, _args, ctx) => {
        const match = await scoring.matchInfo(r.matchId);
        if (!match) return false;
        return (await scoring.resultAccess(ctx.actor, match, r)).canConfirm;
      },
    }),
    viewerCanDispute: t.boolean({
      resolve: async (r, _args, ctx) => {
        const match = await scoring.matchInfo(r.matchId);
        if (!match) return false;
        return (await scoring.resultAccess(ctx.actor, match, r)).canDispute;
      },
    }),
  }),
});

// --- fields on Match ---------------------------------------------------------

builder.objectFields(MatchRef, (t) => ({
  currentScore: t.field({
    type: ScoreStateRef,
    nullable: true,
    description: 'Null until the match is started.',
    resolve: async (m) => {
      const snap = await scoring.snapshot(m.id);
      return snap.state ? { ...snap.state, seq: snap.seq } : null;
    },
  }),
  result: t.field({
    type: MatchResultRef,
    nullable: true,
    description: 'Null until a result is submitted.',
    resolve: (m) => scoring.resultFor(m.id),
  }),
  scoringRule: t.field({
    type: ScoringRuleRef,
    resolve: async (m) => {
      const rule = await scoring.ruleForMatch(m.id);
      return { kind: rule.kind, definition: JSON.stringify(rule) };
    },
  }),
  viewerSide: t.field({
    type: MatchSideEnum,
    nullable: true,
    description: 'The side the viewer plays on, if they play in this match.',
    resolve: async (m, _args, ctx) => (await scoring.access(ctx.actor, m.id)).side,
  }),
  viewerCanScore: t.boolean({
    description: 'A staff grant on the event, or a place in this match.',
    resolve: async (m, _args, ctx) => (await scoring.access(ctx.actor, m.id)).canScore,
  }),
}));

// --- payloads ----------------------------------------------------------------

const MatchResultPayload = builder
  .objectRef<{ match: Match | null; result: ResultRow | null; userError: UserErrorShape | null }>(
    'MatchResultPayload',
  )
  .implement({
    fields: (t) => ({
      match: t.field({ type: MatchRef, nullable: true, resolve: (p) => p.match }),
      result: t.field({ type: MatchResultRef, nullable: true, resolve: (p) => p.result }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ------------------------------------------------------------------

const RecordPointInput = builder.inputType('RecordPointInput', {
  fields: (t) => ({
    matchId: t.id({ required: true }),
    side: t.field({ type: MatchSideEnum, required: true, description: 'Who won the rally.' }),
    expectedSeq: t.int({
      required: true,
      description: 'R1 — `currentScore.seq` as this device last knew it.',
    }),
  }),
});

const UndoPointInput = builder.inputType('UndoPointInput', {
  fields: (t) => ({
    matchId: t.id({ required: true }),
    expectedSeq: t.int({ required: true }),
  }),
});

const GameScoreInput = builder.inputType('GameScoreInput', {
  fields: (t) => ({
    a: t.int({ required: true }),
    b: t.int({ required: true }),
  }),
});

const SubmitMatchResultInput = builder.inputType('SubmitMatchResultInput', {
  description:
    'A result entered rather than tapped. PLAYED is checked against the sport’s ' +
    'rule; the others need `winner` and no score (R10).',
  fields: (t) => ({
    matchId: t.id({ required: true }),
    outcome: t.field({ type: MatchOutcomeEnum, required: true }),
    games: t.field({ type: [GameScoreInput], required: false }),
    winner: t.field({ type: MatchSideEnum, required: false }),
    penalties: t.field({
      type: GameScoreInput,
      required: false,
      description:
        'The tiebreaker that decided a level knockout: a goals match’s shootout, or a cricket match’s super over (runs). Required then; refused otherwise.',
    }),
    finish: t.string({
      required: false,
      description: 'A bout won early — one of the sport’s finishes (ko, tko, submission, fall…). Needs `winner`.',
    }),
  }),
});

const DisputeMatchResultInput = builder.inputType('DisputeMatchResultInput', {
  fields: (t) => ({
    matchId: t.id({ required: true }),
    reason: t.string({ required: true }),
  }),
});

// --- mutations ---------------------------------------------------------------

const RecordScoreEventInput = builder.inputType('RecordScoreEventInput', {
  fields: (t) => ({
    matchId: t.id({ required: true }),
    expectedSeq: t.int({ required: true, description: 'R1 — `currentScore.seq` as this device last knew it.' }),
    type: t.field({ type: ScoreEventTypeEnum, required: true }),
    side: t.field({ type: MatchSideEnum, required: false, description: 'Required for POINT, SCORE and SHOOTOUT_KICK.' }),
    action: t.string({ required: false, description: 'SCORE only — a key from the rule’s actions.' }),
    scored: t.boolean({ required: false, description: 'SHOOTOUT_KICK only.' }),
    runs: t.int({ required: false, description: 'BALL only — runs taken off the delivery.' }),
    extra: t.field({ type: BallExtraEnum, required: false, description: 'BALL only.' }),
    wicket: t.field({ type: DismissalEnum, required: false, description: 'BALL only — how a batter was out.' }),
    value: t.int({ required: false, description: 'POINTS only.' }),
    unitScore: t.field({ type: GameScoreInput, required: false, description: 'UNIT_WON only, where the rule wants a score.' }),
    cards: t.field({ type: [GameScoreInput], required: false, description: 'ROUND_CARDS only — one per judge.' }),
    method: t.string({ required: false, description: 'FINISH only — ko, tko, submission, fall…' }),
  }),
});

function toScoreEvent(i: {
  type: ScoreEvent['type'];
  side?: Side | null;
  action?: string | null;
  scored?: boolean | null;
  runs?: number | null;
  extra?: 'wide' | 'no_ball' | 'bye' | 'leg_bye' | null;
  wicket?: Dismissal | null;
  value?: number | null;
  unitScore?: { a: number; b: number } | null;
  cards?: { a: number; b: number }[] | null;
  method?: string | null;
}): ScoreEvent {
  const needSide = () => {
    if (!i.side) throw new UserError('INVALID_EVENT', `${i.type} needs a side`);
    return i.side;
  };
  switch (i.type) {
    case 'point':
      return { type: 'point', side: needSide() };
    case 'score':
      if (!i.action) throw new UserError('INVALID_EVENT', 'a score needs an action');
      return { type: 'score', side: needSide(), action: i.action };
    case 'period_end':
      return { type: 'period_end' };
    case 'shootout_kick':
      if (i.scored == null) throw new UserError('INVALID_EVENT', 'a kick needs scored: true or false');
      return { type: 'shootout_kick', side: needSide(), scored: i.scored };
    case 'ball':
      if (i.runs == null) throw new UserError('INVALID_EVENT', 'a delivery needs runs (0 for a dot ball)');
      return { type: 'ball', runs: i.runs, extra: i.extra ?? null, wicket: i.wicket ?? null };
    case 'unit_won':
      return { type: 'unit_won', side: needSide(), score: i.unitScore ? { a: i.unitScore.a, b: i.unitScore.b } : null };
    case 'unit_drawn':
      return { type: 'unit_drawn' };
    case 'unit_end':
      return { type: 'unit_end' };
    case 'points':
      if (i.value == null) throw new UserError('INVALID_EVENT', 'points need a value');
      return { type: 'points', side: needSide(), value: i.value };
    case 'round_cards':
      if (!i.cards?.length) throw new UserError('INVALID_EVENT', 'a round needs its cards');
      return { type: 'round_cards', cards: i.cards.map((c) => ({ a: c.a, b: c.b })) };
    case 'round_end':
      return { type: 'round_end' };
    case 'penalty':
      return { type: 'penalty', side: needSide() };
    case 'finish':
      if (!i.method) throw new UserError('INVALID_EVENT', 'a finish needs its method');
      return { type: 'finish', side: needSide(), method: i.method };
  }
}

/**
 * A point write: on ANY failure the payload still carries the match as the
 * server now has it, because that is what the client needs next — the scorer
 * resolving SCORE_STALE looks at it (live-scoring R6), and MATCH_NOT_LIVE is
 * answered by showing where the match went.
 */
async function pointWrite(
  matchId: string,
  fn: () => Promise<unknown>,
): Promise<{ match: Match | null; userError: UserErrorShape | null }> {
  let userError: UserErrorShape | null = null;
  try {
    await fn();
  } catch (e) {
    if (!isUserError(e)) throw e;
    userError = { code: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds ?? null };
  }
  const match = await tournament.matchById(matchId).catch(() => null);
  return { match, userError };
}

async function resultWrite(
  matchId: string,
  fn: () => Promise<ResultRow>,
): Promise<{ match: Match | null; result: ResultRow | null; userError: UserErrorShape | null }> {
  const { data, userError } = await attempt(fn);
  const match = await tournament.matchById(matchId).catch(() => null);
  return { match, result: data ?? (await scoring.resultFor(matchId)), userError };
}

builder.queryFields((t) => ({
  eventPendingResults: t.field({
    type: [MatchRef],
    description:
      'F12, F15 — results on this event that nobody has confirmed yet, disputes first. ' +
      'Event staff only. What the organizer section lists under "needs you".',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const ids = await scoring.pendingForEvent(actor, String(args.eventId));
      const found = await Promise.all(ids.map((id) => tournament.matchById(id).catch(() => null)));
      return found.filter((m): m is Match => m !== null);
    },
  }),

  escalatedResults: t.field({
    type: [MatchRef],
    description: 'F9 — PL4Y staff only: disputes handed to PL4Y and still open, oldest first.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      const ids = await scoring.escalatedResults();
      const found = await Promise.all(ids.map((id) => tournament.matchById(id).catch(() => null)));
      return found.filter((m): m is Match => m !== null);
    },
  }),
}));

builder.mutationFields((t) => ({
  startMatch: t.field({
    type: MatchPayload,
    description: 'Opens the point log. Idempotent on a live match.',
    args: {
      matchId: t.arg.id({ required: true }),
      firstServer: t.arg({ type: MatchSideEnum, required: false }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.matchId.toString();
      return pointWrite(matchId, () => scoring.start(actor, matchId, args.firstServer ?? 'a'));
    },
  }),

  recordPoint: t.field({
    type: MatchPayload,
    description:
      'R1 — rejected with SCORE_STALE when `expectedSeq` is not the server’s; the ' +
      'payload then carries the server’s match. The last point of a match submits ' +
      'its result (R6).',
    args: { input: t.arg({ type: RecordPointInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return pointWrite(matchId, () =>
        scoring.recordPoint(actor, {
          matchId,
          side: args.input.side,
          expectedSeq: args.input.expectedSeq,
        }),
      );
    },
  }),

  recordScoreEvent: t.field({
    type: MatchPayload,
    description:
      'Any typed score event (scoring R1–R5): a score action, a period end, a shootout kick. ' +
      'Rejected with SCORE_STALE like recordPoint, and with INVALID_EVENT when the sport’s rule ' +
      'does not take it. The event that ends the match submits its result (R6).',
    args: { input: t.arg({ type: RecordScoreEventInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return pointWrite(matchId, () =>
        scoring.recordEvent(actor, {
          matchId,
          expectedSeq: args.input.expectedSeq,
          event: toScoreEvent(args.input),
        }),
      );
    },
  }),

  undoPoint: t.field({
    type: MatchPayload,
    description: 'R2 — an appended event, never a delete. Takes back the last point standing.',
    args: { input: t.arg({ type: UndoPointInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return pointWrite(matchId, () =>
        scoring.undo(actor, { matchId, expectedSeq: args.input.expectedSeq }),
      );
    },
  }),

  submitMatchResult: t.field({
    type: MatchResultPayload,
    args: { input: t.arg({ type: SubmitMatchResultInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return resultWrite(matchId, () =>
        scoring.submitResult(actor, {
          matchId,
          outcome: args.input.outcome,
          games: (args.input.games ?? []).map((g) => ({ a: g.a, b: g.b })),
          winner: args.input.winner ?? null,
          penalties: args.input.penalties ? { a: args.input.penalties.a, b: args.input.penalties.b } : null,
          finish: args.input.finish ?? null,
        }),
      );
    },
  }),

  settleEscalatedResult: t.field({
    type: MatchResultPayload,
    description:
      'F9 — PL4Y staff settle a dispute: KEEP the submitted result, or send the right one in ' +
      '`input`. Confirmed at once either way.',
    args: {
      matchId: t.arg.id({ required: true }),
      keep: t.arg.boolean({ required: true }),
      input: t.arg({ type: SubmitMatchResultInput }),
      reason: t.arg.string({ required: true, description: 'portal R3 — kept in the audit log.' }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const matchId = String(args.matchId);
      return resultWrite(matchId, () =>
        audited(
          staff,
          { action: args.keep ? 'match.settle_keep' : 'match.settle_correct', targetType: 'match', targetId: matchId },
          args.reason,
          () =>
            scoring.platformSettle(staff.userId, {
              matchId,
              keep: args.keep,
              outcome: args.input?.outcome,
              games: (args.input?.games ?? []).map((g) => ({ a: g.a, b: g.b })),
              winner: args.input?.winner ?? null,
              penalties: args.input?.penalties ? { a: args.input.penalties.a, b: args.input.penalties.b } : null,
              finish: args.input?.finish ?? null,
            }),
        ),
      );
    },
  }),

  confirmMatchResult: t.field({
    type: MatchResultPayload,
    description:
      'R6 — the other side, or an owner/manager 15 minutes after submission ' +
      '(at once when disputed). Advances the bracket.',
    args: { matchId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.matchId.toString();
      return resultWrite(matchId, () => scoring.confirmResult(actor, matchId));
    },
  }),

  disputeMatchResult: t.field({
    type: MatchResultPayload,
    args: { input: t.arg({ type: DisputeMatchResultInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return resultWrite(matchId, () => scoring.disputeResult(actor, matchId, args.input.reason));
    },
  }),

  correctMatchResult: t.field({
    type: MatchResultPayload,
    description:
      'R7, R8 — an owner or manager corrects a CONFIRMED result. A new winner takes the ' +
      'old one’s place in the next match, which must not have started yet. Ratings are redone.',
    args: { input: t.arg({ type: SubmitMatchResultInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return resultWrite(matchId, () =>
        scoring.correctResult(actor, {
          matchId,
          outcome: args.input.outcome,
          games: (args.input.games ?? []).map((g) => ({ a: g.a, b: g.b })),
          winner: args.input.winner ?? null,
          penalties: args.input.penalties ? { a: args.input.penalties.a, b: args.input.penalties.b } : null,
          finish: args.input.finish ?? null,
        }),
      );
    },
  }),
}));
import './field.js';
