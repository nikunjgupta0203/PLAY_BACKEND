/**
 * predictions — GraphQL surface (Floodlight §4.4 Predictions, §4.10 Rankings).
 *
 * predictions R1 — free to play: no entry fee, no buying points, no cash
 * prizes. Nothing here takes a payment or issues a reward.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requestLoader } from '../../../graphql/requestLoader.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { ProMatchRef } from '../../pro/schema/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { predictions } from '../index.js';
import type {
  Badge,
  Board,
  BoardEntry,
  BoardScope,
  Challenge,
  ChallengeTask,
  PredictionOption,
  PredictionOutcome,
  PredictionPick,
  PredictionQuestion,
  PredictionStats,
  QuestionKind,
  Split,
} from '../index.js';

const KindEnum = builder.enumType('PredictionKind', {
  values: { CHOICE: { value: 'choice' }, EXACT_SCORE: { value: 'exact_score' }, PLAYER_PICK: { value: 'player_pick' } } as const,
});

const StatusEnum = builder.enumType('PredictionStatus', {
  values: { OPEN: { value: 'open' }, SETTLED: { value: 'settled' }, VOID: { value: 'void' } } as const,
});

const OutcomeEnum = builder.enumType('PredictionOutcome', {
  description: 'predictions R8 — what an option means for the match result.',
  values: { HOME: { value: 'home' }, DRAW: { value: 'draw' }, AWAY: { value: 'away' } } as const,
});

const ScopeEnum = builder.enumType('PredictionBoardScope', {
  values: {
    GLOBAL: { value: 'global' },
    FRIENDS: { value: 'friends', description: 'Players you have an active chat with, and you.' },
    SPORT: { value: 'sport' },
    COMMUNITY: { value: 'community', description: 'One community you are in, or all of yours.' },
    CITY: { value: 'city' },
  } as const,
});

const splitOf = (ctx: Ctx, questionId: string) =>
  requestLoader<string, Split>(ctx, 'predictionSplit', async (ids) => {
    const found = await predictions.splits(ids);
    return ids.map((id) => found.get(id) ?? { questionId: id, total: 0, byOption: new Map() });
  }).load(questionId);

const myPickOf = (ctx: Ctx, questionId: string) => {
  const userId = ctx.actor?.userId;
  if (!userId) return Promise.resolve(null);
  return requestLoader<string, PredictionPick | null>(ctx, `predictionPick:${userId}`, async (ids) => {
    const found = await predictions.picksFor(userId, ids);
    return ids.map((id) => found.get(id) ?? null);
  }).load(questionId);
};

const percent = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

type OptionView = PredictionOption & { questionId: string; correctOptionId: string | null; settled: boolean };

const OptionRef = builder.objectRef<OptionView>('PredictionOption').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    label: t.exposeString('label'),
    detail: t.exposeString('detail', { nullable: true }),
    outcome: t.field({ type: OutcomeEnum, nullable: true, resolve: (o) => o.outcome }),
    picks: t.int({ resolve: async (o, _a, ctx) => (await splitOf(ctx, o.questionId)).byOption.get(o.id) ?? 0 }),
    percent: t.int({
      description: 'Share of all picks, 0–100.',
      resolve: async (o, _a, ctx) => {
        const s = await splitOf(ctx, o.questionId);
        return percent(s.byOption.get(o.id) ?? 0, s.total);
      },
    }),
    isCorrect: t.boolean({ nullable: true, description: 'Null until settled.', resolve: (o) => (o.settled ? o.id === o.correctOptionId : null) }),
  }),
});

const PickRef = builder.objectRef<PredictionPick>('PredictionPick').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    optionId: t.id({ nullable: true, resolve: (p) => p.optionId }),
    home: t.exposeInt('home', { nullable: true }),
    away: t.exposeInt('away', { nullable: true }),
    correct: t.exposeBoolean('correct', { nullable: true, description: 'Null while open, and on a void question.' }),
    pointsAwarded: t.exposeInt('pointsAwarded', { nullable: true }),
    createdAt: t.field({ type: 'DateTime', resolve: (p) => p.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (p) => p.updatedAt }),
  }),
});

export const PredictionQuestionRef = builder.objectRef<PredictionQuestion>('PredictionQuestion').implement({
  description: 'predictions R1 — a free question. Points have no cash value.',
  fields: (t) => ({
    id: t.exposeID('id'),
    kind: t.field({ type: KindEnum, resolve: (q) => q.kind }),
    prompt: t.exposeString('prompt'),
    points: t.exposeInt('points'),
    live: t.exposeBoolean('live'),
    locksAt: t.field({ type: 'DateTime', resolve: (q) => q.locksAt }),
    isLocked: t.boolean({ description: 'No more picks: past the lock time, settled or void.', resolve: (q) => q.status !== 'open' || q.locksAt.getTime() <= Date.now() }),
    status: t.field({ type: StatusEnum, resolve: (q) => q.status }),
    options: t.field({
      type: [OptionRef],
      resolve: (q) => q.options.map((o) => ({ ...o, questionId: q.id, correctOptionId: q.correctOptionId, settled: q.status === 'settled' })),
    }),
    totalPicks: t.int({ resolve: async (q, _a, ctx) => (await splitOf(ctx, q.id)).total }),
    correctHome: t.exposeInt('correctHome', { nullable: true }),
    correctAway: t.exposeInt('correctAway', { nullable: true }),
    settledAt: t.field({ type: 'DateTime', nullable: true, resolve: (q) => q.settledAt }),
    suggestedOptionId: t.id({ nullable: true, description: 'predictions R8 — the answer the final score points to. Staff confirm it.', resolve: (q) => q.suggestedOptionId }),
    suggestedHome: t.exposeInt('suggestedHome', { nullable: true }),
    suggestedAway: t.exposeInt('suggestedAway', { nullable: true }),
    suggestedAt: t.field({ type: 'DateTime', nullable: true, resolve: (q) => q.suggestedAt }),
    myPick: t.field({ type: PickRef, nullable: true, resolve: (q, _a, ctx) => myPickOf(ctx, q.id) }),
    sport: t.field({
      type: SportRef,
      resolve: async (q) => {
        const { sport } = await import('../../sport/index.js');
        return sport.byId(q.sportId);
      },
    }),
    match: t.field({
      type: ProMatchRef,
      nullable: true,
      resolve: async (q) => {
        if (!q.matchId) return null;
        const { pro } = await import('../../pro/index.js');
        return pro.match(q.matchId);
      },
    }),
  }),
});

builder.objectField(ProMatchRef, 'questions', (t) =>
  t.field({
    type: [PredictionQuestionRef],
    description: 'The Match Centre’s Predict tab: every question on the match, newest first.',
    resolve: (m) => predictions.forMatch(m.id),
  }),
);

const StatsRef = builder.objectRef<PredictionStats>('PredictionStats').implement({
  fields: (t) => ({
    points: t.exposeInt('points'),
    picks: t.exposeInt('picks'),
    settled: t.exposeInt('settled'),
    correct: t.exposeInt('correct'),
    accuracy: t.exposeInt('accuracy', { nullable: true, description: '0–100. Null before anything settles.' }),
    streak: t.exposeInt('streak'),
    bestStreak: t.exposeInt('bestStreak'),
  }),
});

const TaskRef = builder.objectRef<ChallengeTask>('PredictionChallengeTask').implement({
  fields: (t) => ({
    key: t.exposeString('key'),
    label: t.exposeString('label'),
    progress: t.exposeInt('progress'),
    target: t.exposeInt('target'),
    done: t.exposeBoolean('done'),
  }),
});

const ChallengeRef = builder.objectRef<Challenge>('PredictionChallenge').implement({
  description: 'predictions R6 — today’s (IST) challenge. Finishing it adds `bonus` points once.',
  fields: (t) => ({
    date: t.exposeString('date'),
    bonus: t.exposeInt('bonus'),
    completed: t.exposeBoolean('completed'),
    tasks: t.field({ type: [TaskRef], resolve: (c) => c.tasks }),
  }),
});

const BadgeRef = builder.objectRef<Badge>('PredictionBadge').implement({
  fields: (t) => ({
    key: t.exposeString('key'),
    name: t.exposeString('name'),
    description: t.exposeString('description'),
    earned: t.exposeBoolean('earned'),
  }),
});

const ResultRef = builder.objectRef<{ pick: PredictionPick; question: PredictionQuestion }>('PredictionResult').implement({
  fields: (t) => ({
    pick: t.field({ type: PickRef, resolve: (r) => r.pick }),
    question: t.field({ type: PredictionQuestionRef, resolve: (r) => r.question }),
  }),
});

const CityRankRef = builder.objectRef<{ rank: number; city: string }>('PredictionCityRank').implement({
  fields: (t) => ({ rank: t.exposeInt('rank'), city: t.exposeString('city') }),
});

const MyPredictionsRef = builder.objectRef<{ userId: string }>('MyPredictions').implement({
  description: 'Everything on the Predict screen for the signed-in player.',
  fields: (t) => ({
    stats: t.field({ type: StatsRef, resolve: (m) => predictions.stats(m.userId) }),
    cityRank: t.field({ type: CityRankRef, nullable: true, resolve: (m) => predictions.cityRank(m.userId) }),
    challenge: t.field({ type: ChallengeRef, resolve: (m) => predictions.challenge(m.userId) }),
    picksThisWeek: t.int({ description: 'Picks made in the last 7 days, settled or not.', resolve: (m) => predictions.picksThisWeek(m.userId) }),
    badges: t.field({ type: [BadgeRef], resolve: (m) => predictions.badges(m.userId) }),
    results: t.field({
      type: [ResultRef],
      args: { first: t.arg.int({ defaultValue: 10 }) },
      resolve: (m, args) => predictions.results(m.userId, args.first ?? 10),
    }),
  }),
});

const EntryRef = builder.objectRef<BoardEntry>('PredictionBoardEntry').implement({
  fields: (t) => ({
    rank: t.exposeInt('rank'),
    points: t.exposeInt('points'),
    isMe: t.boolean({ resolve: (e, _a, ctx) => ctx.actor?.userId === e.userId }),
    player: t.field({ type: PlayerProfileRef, nullable: true, resolve: (e, _a, ctx) => ctx.loaders.publicProfileByUser.load(e.userId) }),
  }),
});

const BoardRef = builder.objectRef<Board>('PredictionBoard').implement({
  description: 'predictions R7 — ranked by total pick points. Pick points never change a player’s rating.',
  fields: (t) => ({
    entries: t.field({ type: [EntryRef], resolve: (b) => b.entries }),
    me: t.field({ type: EntryRef, nullable: true, description: 'Your own row, pinned below the list.', resolve: (b) => b.me }),
    size: t.exposeInt('size'),
  }),
});

builder.queryFields((t) => ({
  predictionQuestions: t.field({
    type: [PredictionQuestionRef],
    description: 'Open questions, soonest to lock first.',
    args: {
      matchId: t.arg.id(),
      sportId: t.arg.id(),
      live: t.arg.boolean(),
      includeLocked: t.arg.boolean({ defaultValue: false }),
      first: t.arg.int({ defaultValue: 20 }),
    },
    resolve: (_root, args) =>
      predictions.openQuestions({
        matchId: args.matchId ? String(args.matchId) : null,
        sportId: args.sportId ? String(args.sportId) : null,
        live: args.live ?? null,
        includeLocked: args.includeLocked ?? false,
        first: args.first ?? 20,
      }),
  }),
  predictionQuestion: t.field({
    type: PredictionQuestionRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args) => predictions.question(String(args.id)),
  }),
  myPredictions: t.field({
    type: MyPredictionsRef,
    resolve: (_root, _args, ctx) => ({ userId: requireActor(ctx).userId }),
  }),
  predictionLeaderboard: t.field({
    type: BoardRef,
    args: {
      scope: t.arg({ type: ScopeEnum, required: true }),
      sportId: t.arg.id(),
      communityId: t.arg.id(),
      first: t.arg.int({ defaultValue: 50 }),
    },
    resolve: (_root, args, ctx) =>
      predictions.leaderboard(ctx.actor?.userId ?? null, args.scope as BoardScope, {
        sportId: args.sportId ? String(args.sportId) : null,
        communityId: args.communityId ? String(args.communityId) : null,
        first: args.first ?? 50,
      }),
  }),
}));

const PickPayload = builder
  .objectRef<{ pick: PredictionPick | null; question: PredictionQuestion | null; userError: UserErrorShape | null }>('MakePredictionPayload')
  .implement({
    fields: (t) => ({
      pick: t.field({ type: PickRef, nullable: true, resolve: (p) => p.pick }),
      question: t.field({ type: PredictionQuestionRef, nullable: true, description: 'Fresh, with the new split.', resolve: (p) => p.question }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  makePrediction: t.field({
    type: PickPayload,
    description: 'predictions R2 — pick an option, or give both scores for an exact-score question. Changeable until it locks.',
    args: {
      questionId: t.arg.id({ required: true }),
      optionId: t.arg.id(),
      home: t.arg.int(),
      away: t.arg.int(),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const questionId = String(args.questionId);
      const { data, userError } = await attempt(() =>
        predictions.pick(actor.userId, questionId, {
          optionId: args.optionId ? String(args.optionId) : null,
          home: args.home ?? null,
          away: args.away ?? null,
        }),
      );
      return { pick: data, question: data ? await predictions.question(questionId) : null, userError };
    },
  }),
}));

// --- PL4Y staff -------------------------------------------------------------------

const OptionInput = builder.inputType('PredictionOptionInput', {
  fields: (t) => ({
    label: t.string({ required: true }),
    detail: t.string(),
    outcome: t.field({ type: OutcomeEnum, description: 'A choice question on a match: ties the option to the result for settle suggestions.' }),
  }),
});

const QuestionInput = builder.inputType('PredictionQuestionInput', {
  fields: (t) => ({
    matchId: t.id(),
    sportId: t.id({ description: 'Needed only without a match.' }),
    kind: t.field({ type: KindEnum, required: true }),
    prompt: t.string({ required: true }),
    points: t.int({ description: 'Default 10, or 30 for a live question.' }),
    live: t.boolean(),
    locksAt: t.field({ type: 'DateTime', required: true }),
    options: t.field({ type: [OptionInput], description: '2 to 6; none for an exact-score question.' }),
  }),
});

const QuestionPatch = builder.inputType('PredictionQuestionPatch', {
  fields: (t) => ({ prompt: t.string(), locksAt: t.field({ type: 'DateTime' }), points: t.int() }),
});

const QuestionPayload = builder
  .objectRef<{ question: PredictionQuestion | null; userError: UserErrorShape | null }>('PredictionQuestionPayload')
  .implement({
    fields: (t) => ({
      question: t.field({ type: PredictionQuestionRef, nullable: true, resolve: (p) => p.question }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const EDITORS = ['admin', 'support'] as const;

builder.queryFields((t) => ({
  adminPredictionQuestions: t.field({
    type: [PredictionQuestionRef],
    description: 'Portal — every question, newest first.',
    args: { first: t.arg.int({ defaultValue: 100 }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return predictions.staffList(args.first ?? 100);
    },
  }),
}));

builder.mutationFields((t) => ({
  adminCreatePredictionQuestion: t.field({
    type: QuestionPayload,
    args: { input: t.arg({ type: QuestionInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        predictions.createQuestion(staff.userId, {
          matchId: i.matchId ? String(i.matchId) : null,
          sportId: i.sportId ? String(i.sportId) : null,
          kind: i.kind as QuestionKind,
          prompt: i.prompt,
          points: i.points ?? null,
          live: i.live ?? false,
          locksAt: i.locksAt,
          options: (i.options ?? []).map((o) => ({ label: o.label, detail: o.detail ?? null, outcome: (o.outcome as PredictionOutcome | null | undefined) ?? null })),
        }),
      );
      return { question: data, userError };
    },
  }),
  adminUpdatePredictionQuestion: t.field({
    type: QuestionPayload,
    description: 'Portal — only while open. Set `locksAt` to now to lock it early.',
    args: { id: t.arg.id({ required: true }), input: t.arg({ type: QuestionPatch, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        predictions.updateQuestion(String(args.id), {
          prompt: i.prompt ?? undefined,
          locksAt: i.locksAt ?? undefined,
          points: i.points ?? undefined,
        }),
      );
      return { question: data, userError };
    },
  }),
  adminSettlePredictionQuestion: t.field({
    type: QuestionPayload,
    description: 'predictions R3 — marks every pick and writes points, once. Settles a result: the reason is audited.',
    args: {
      id: t.arg.id({ required: true }),
      optionId: t.arg.id(),
      home: t.arg.int(),
      away: t.arg.int(),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const id = String(args.id);
      const answer = { optionId: args.optionId ? String(args.optionId) : null, home: args.home ?? null, away: args.away ?? null };
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'prediction.settle', targetType: 'prediction_question', targetId: id, details: answer }, args.reason, () =>
          predictions.settle(staff.userId, id, answer),
        ),
      );
      return { question: data, userError };
    },
  }),
  adminVoidPredictionQuestion: t.field({
    type: QuestionPayload,
    description: 'predictions R4 — nobody earns anything. Audited.',
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'prediction.void', targetType: 'prediction_question', targetId: id, details: {} }, args.reason, () =>
          predictions.voidQuestion(id),
        ),
      );
      return { question: data, userError };
    },
  }),
}));
