/**
 * competitions — GraphQL surface (066, Campus Prediction Cup).
 *
 * competitions R1 — a separate space: nothing here reads or writes
 * Floodlight predictions, PL4Y points or Rankings, and nothing takes a
 * payment. Prizes are described in copy and handed out by PL4Y.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requestLoader } from '../../../graphql/requestLoader.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { ProMatchRef } from '../../pro/schema/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { competitions, crowdPoints, earnable } from '../index.js';
import type {
  Competition,
  CompetitionBoard,
  CompetitionBoardKind,
  CompetitionBoardPeriod,
  CompetitionBoardRow,
  CompetitionGroup,
  CompetitionJoinCode,
  CompetitionMember,
  CompetitionMoment,
  CompetitionOption,
  CompetitionOutcome,
  CompetitionPick,
  CompetitionPrize,
  CompetitionQuestion,
  CompetitionQuestionKind,
  CompetitionQuestionStatus,
  CompetitionScoringLine,
  CompetitionSegment,
  CompetitionSplit,
  CompetitionStanding,
  CompetitionStatus,
} from '../index.js';

const SegmentEnum = builder.enumType('CompetitionSegment', {
  values: { CAMPUS: { value: 'campus' }, CORPORATE: { value: 'corporate' }, GYM: { value: 'gym' }, COMMUNITY: { value: 'community' }, OTHER: { value: 'other' } } as const,
});
const StatusEnum = builder.enumType('CompetitionStatus', {
  values: { DRAFT: { value: 'draft' }, LIVE: { value: 'live' }, ENDED: { value: 'ended' } } as const,
});
const KindEnum = builder.enumType('CompetitionQuestionKind', {
  values: { CHOICE: { value: 'choice' }, EXACT_SCORE: { value: 'exact_score' } } as const,
});
const QStatusEnum = builder.enumType('CompetitionQuestionStatus', {
  values: { OPEN: { value: 'open' }, SETTLED: { value: 'settled' }, VOID: { value: 'void' } } as const,
});
const OutcomeEnum = builder.enumType('CompetitionOutcome', {
  values: { HOME: { value: 'home' }, DRAW: { value: 'draw' }, AWAY: { value: 'away' } } as const,
});
const BoardKindEnum = builder.enumType('CompetitionBoardKind', {
  values: {
    GROUPS: { value: 'groups', description: 'Every group, by the average of its top players.' },
    PLAYERS: { value: 'players', description: 'Every member, by Cup points.' },
    MY_GROUP: { value: 'my_group', description: 'The members of your group.' },
    SPECIALISTS: { value: 'specialists', description: 'The leader of each sport in your group.' },
  } as const,
});
const PeriodEnum = builder.enumType('CompetitionBoardPeriod', {
  values: { SEASON: { value: 'season' }, MONTH: { value: 'month', description: 'This calendar month, India time.' }, WEEK: { value: 'week', description: 'The last 7 days.' } } as const,
});

// --- per-request loaders ---

const splitOf = (ctx: Ctx, questionId: string) =>
  requestLoader<string, CompetitionSplit>(ctx, 'competitionSplit', async (ids) => {
    const found = await competitions.splits(ids);
    return ids.map((id) => found.get(id) ?? { questionId: id, total: 0, byOption: new Map() });
  }).load(questionId);

const myPickOf = (ctx: Ctx, questionId: string) => {
  const userId = ctx.actor?.userId;
  if (!userId) return Promise.resolve(null);
  return requestLoader<string, CompetitionPick | null>(ctx, `competitionPick:${userId}`, async (ids) => {
    const found = await competitions.picksFor(userId, ids);
    return ids.map((id) => found.get(id) ?? null);
  }).load(questionId);
};

const memberCountOf = (ctx: Ctx, groupId: string) =>
  requestLoader<string, number>(ctx, 'competitionMemberCount', async (ids) => {
    const found = await competitions.memberCounts(ids);
    return ids.map((id) => found.get(id) ?? 0);
  }).load(groupId);

const standingOf = (ctx: Ctx, competitionId: string): Promise<CompetitionStanding | null> => {
  const userId = ctx.actor?.userId;
  if (!userId) return Promise.resolve(null);
  return requestLoader<string, CompetitionStanding | null>(ctx, `competitionStanding:${userId}`, (ids) =>
    Promise.all(ids.map((id) => competitions.standing(id, userId))),
  ).load(competitionId);
};

const competitionOf = (ctx: Ctx, id: string) =>
  requestLoader<string, Competition | null>(ctx, 'competitionById', (ids) => Promise.all(ids.map((x) => competitions.byId(x)))).load(id);

const sportOf = async (id: string) => {
  const { sport } = await import('../../sport/index.js');
  return sport.byId(id);
};

const percent = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

/**
 * 067 — the crowd. `forPricing`: as this viewer would be priced now (their own
 * pick left out, as when they pick). Otherwise everyone's picks: the % shown.
 */
const crowdOf = (ctx: Ctx, questionId: string, forPricing = false) => {
  const viewer = forPricing ? (ctx.actor?.userId ?? null) : null;
  return requestLoader<string, Map<string, number>>(ctx, `competitionCrowd:${viewer ?? '-'}`, async (ids) => {
    const found = await competitions.crowdFor(ids, viewer);
    return ids.map((id) => found.get(id) ?? new Map());
  }).load(questionId);
};

// --- types ---

const PrizeRef = builder.objectRef<CompetitionPrize>('CompetitionPrize').implement({
  fields: (t) => ({ title: t.exposeString('title'), detail: t.exposeString('detail') }),
});
const ScoringRef = builder.objectRef<CompetitionScoringLine>('CompetitionScoringLine').implement({
  fields: (t) => ({ label: t.exposeString('label'), value: t.exposeString('value') }),
});

export const CompetitionGroupRef = builder.objectRef<CompetitionGroup>('CompetitionGroup').implement({
  description: 'The team a player plays for: a college, a company, a gym.',
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    fullName: t.exposeString('fullName', { nullable: true }),
    city: t.exposeString('city', { nullable: true }),
    leadName: t.exposeString('leadName', { nullable: true }),
    hidden: t.boolean({ resolve: (g) => g.status === 'hidden' }),
    memberCount: t.int({ resolve: (g, _a, ctx) => memberCountOf(ctx, g.id) }),
  }),
});

const JoinCodeRef = builder.objectRef<CompetitionJoinCode>('CompetitionJoinCode').implement({
  fields: (t) => ({
    code: t.exposeString('code'),
    ambassadorName: t.exposeString('ambassadorName', { nullable: true }),
    active: t.exposeBoolean('active'),
  }),
});

builder.objectField(CompetitionGroupRef, 'codes', (t) =>
  t.field({
    type: [JoinCodeRef],
    description: 'Portal only.',
    resolve: async (g, _a, ctx) => {
      await requirePlatformStaff(ctx);
      return competitions.codesFor(g.id);
    },
  }),
);

const MomentRef = builder.objectRef<CompetitionMoment>('CompetitionMoment').implement({
  description: 'A bonus moment: a big event whose questions earn more.',
  fields: (t) => ({
    id: t.exposeID('id'),
    title: t.exposeString('title'),
    subtitle: t.exposeString('subtitle', { nullable: true }),
    multiplier: t.exposeFloat('multiplier'),
    startsAt: t.field({ type: 'DateTime', resolve: (m) => m.startsAt }),
    opensAt: t.field({
      type: 'DateTime',
      description: 'When its questions open: `openHours` before the start.',
      resolve: async (m, _a, ctx) => new Date(m.startsAt.getTime() - ((await competitionOf(ctx, m.competitionId))?.openHours ?? 24) * 3_600_000),
    }),
    sport: t.field({ type: SportRef, resolve: (m) => sportOf(m.sportId) }),
  }),
});

type OptionView = CompetitionOption & { questionId: string; correctOptionId: string | null; settled: boolean; multiplier: number; crowdBase: number };
const OptionRef = builder.objectRef<OptionView>('CompetitionOption').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    label: t.exposeString('label'),
    outcome: t.field({ type: OutcomeEnum, nullable: true, resolve: (o) => o.outcome }),
    picks: t.int({ resolve: async (o, _a, ctx) => (await splitOf(ctx, o.questionId)).byOption.get(o.id) ?? 0 }),
    percent: t.int({ resolve: async (o, _a, ctx) => {
      const s = await splitOf(ctx, o.questionId);
      return percent(s.byOption.get(o.id) ?? 0, s.total);
    } }),
    isCorrect: t.boolean({ nullable: true, resolve: (o) => (o.settled ? o.id === o.correctOptionId : null) }),
    crowdPercent: t.int({
      description: '067 — the crowd share (all picks plus the starting picks, 5–95% cap), 0–100.',
      resolve: async (o, _a, ctx) => Math.round(((await crowdOf(ctx, o.questionId)).get(o.id) ?? 0) * 100),
    }),
    pays: t.int({
      description: '067 — what a right pick on this option earns if made now, multiplier included.',
      resolve: async (o, _a, ctx) => {
        const share = (await crowdOf(ctx, o.questionId, true)).get(o.id) ?? 0.5;
        return Math.round(crowdPoints(share, o.crowdBase) * o.multiplier);
      },
    }),
  }),
});

const PickRef = builder.objectRef<CompetitionPick>('CompetitionPick').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    optionId: t.id({ nullable: true, resolve: (p) => p.optionId }),
    home: t.exposeInt('home', { nullable: true }),
    away: t.exposeInt('away', { nullable: true }),
    correct: t.exposeBoolean('correct', { nullable: true }),
    pointsAwarded: t.exposeInt('pointsAwarded', { nullable: true }),
    crowdPercent: t.int({ nullable: true, description: '067 — the crowd share locked when you picked, 0–100.', resolve: (p) => (p.crowdShare === null ? null : Math.round(p.crowdShare * 100)) }),
    basePoints: t.exposeInt('basePoints', { nullable: true, description: '067 — what a right answer earns, before any bonus multiplier.' }),
    updatedAt: t.field({ type: 'DateTime', resolve: (p) => p.updatedAt }),
  }),
});

export const CompetitionQuestionRef = builder.objectRef<CompetitionQuestion>('CompetitionQuestion').implement({
  description: 'competitions R4 — opens `openHours` before its event and locks when it starts.',
  fields: (t) => ({
    id: t.exposeID('id'),
    kind: t.field({ type: KindEnum, resolve: (q) => q.kind }),
    prompt: t.exposeString('prompt'),
    eventLabel: t.exposeString('eventLabel'),
    points: t.exposeInt('points'),
    multiplier: t.exposeFloat('multiplier'),
    earnable: t.int({ description: 'What a right answer pays, multiplier included.', resolve: (q) => earnable(q) }),
    startsAt: t.field({ type: 'DateTime', resolve: (q) => q.startsAt }),
    opensAt: t.field({ type: 'DateTime', resolve: (q) => q.opensAt }),
    locksAt: t.field({ type: 'DateTime', resolve: (q) => q.locksAt }),
    isOpen: t.boolean({ resolve: (q) => q.status === 'open' && q.opensAt.getTime() <= Date.now() && q.locksAt.getTime() > Date.now() }),
    isLocked: t.boolean({ resolve: (q) => q.status !== 'open' || q.locksAt.getTime() <= Date.now() }),
    status: t.field({ type: QStatusEnum, resolve: (q) => q.status }),
    options: t.field({
      type: [OptionRef],
      resolve: (q) => q.options.map((o) => ({ ...o, questionId: q.id, correctOptionId: q.correctOptionId, settled: q.status === 'settled', multiplier: q.multiplier, crowdBase: q.crowd.base })),
    }),
    totalPicks: t.int({ resolve: async (q, _a, ctx) => (await splitOf(ctx, q.id)).total }),
    correctHome: t.exposeInt('correctHome', { nullable: true }),
    correctAway: t.exposeInt('correctAway', { nullable: true }),
    suggestedOptionId: t.id({ nullable: true, resolve: (q) => q.suggestedOptionId }),
    suggestedHome: t.exposeInt('suggestedHome', { nullable: true }),
    suggestedAway: t.exposeInt('suggestedAway', { nullable: true }),
    settledAt: t.field({ type: 'DateTime', nullable: true, resolve: (q) => q.settledAt }),
    myPick: t.field({ type: PickRef, nullable: true, resolve: (q, _a, ctx) => myPickOf(ctx, q.id) }),
    sport: t.field({ type: SportRef, resolve: (q) => sportOf(q.sportId) }),
    momentId: t.id({ nullable: true, resolve: (q) => q.momentId }),
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

type GroupStandingView = CompetitionStanding['group'];
const GroupStandingRef = builder.objectRef<GroupStandingView>('CompetitionGroupStanding').implement({
  fields: (t) => ({
    groupId: t.id({ resolve: (g) => g.groupId }),
    name: t.exposeString('name'),
    rank: t.exposeInt('rank'),
    score: t.exposeInt('score'),
    active: t.exposeInt('active', { description: 'Members with a pick in the last `activeDays` days.' }),
    members: t.exposeInt('members'),
    qualified: t.exposeBoolean('qualified', { description: 'At least `teamSize` active members: eligible for group prizes.' }),
    move: t.exposeInt('move', { nullable: true, description: 'Places gained since a week ago.' }),
  }),
});

const AheadRef = builder.objectRef<{ name: string; by: number }>('CompetitionAhead').implement({
  fields: (t) => ({ name: t.exposeString('name'), by: t.exposeInt('by') }),
});

const StandingRef = builder.objectRef<CompetitionStanding>('CompetitionStanding').implement({
  description: 'The signed-in member’s place: their group, their rank, their Cup points. Never PL4Y points.',
  fields: (t) => ({
    group: t.field({ type: CompetitionGroupRef, resolve: async (s) => (await competitions.group(s.member.groupId))! }),
    groupStanding: t.field({ type: GroupStandingRef, resolve: (s) => s.group }),
    groups: t.exposeInt('groups', { description: 'How many groups the board ranks.' }),
    ahead: t.field({ type: AheadRef, nullable: true, resolve: (s) => s.ahead }),
    rank: t.exposeInt('rank'),
    move: t.exposeInt('move', { nullable: true }),
    players: t.exposeInt('players'),
    rankInGroup: t.exposeInt('rankInGroup'),
    groupPlayers: t.exposeInt('groupPlayers'),
    points: t.exposeInt('points'),
    picks: t.exposeInt('picks'),
    accuracy: t.exposeInt('accuracy', { nullable: true }),
    sportsPlayed: t.exposeInt('sportsPlayed'),
    shareCode: t.exposeString('shareCode', { nullable: true }),
    joinedAt: t.field({ type: 'DateTime', resolve: (s) => s.member.joinedAt }),
  }),
});

const BoardRowRef = builder.objectRef<CompetitionBoardRow>('CompetitionBoardRow').implement({
  fields: (t) => ({
    rank: t.exposeInt('rank', { nullable: true, description: 'Null on the specialists board.' }),
    key: t.exposeString('key'),
    title: t.exposeString('title'),
    subtitle: t.exposeString('subtitle'),
    score: t.exposeInt('score'),
    move: t.exposeInt('move', { nullable: true }),
    isNew: t.exposeBoolean('isNew'),
    isMe: t.exposeBoolean('isMe'),
  }),
});

const BoardRef = builder.objectRef<CompetitionBoard>('CompetitionBoard').implement({
  fields: (t) => ({
    kind: t.field({ type: BoardKindEnum, resolve: (b) => b.kind }),
    rows: t.field({ type: [BoardRowRef], resolve: (b) => b.rows }),
    me: t.field({ type: BoardRowRef, nullable: true, description: 'Your row, when it is below the list.', resolve: (b) => b.me }),
    size: t.exposeInt('size'),
  }),
});

const WeekSportRef = builder.objectRef<{ sportId: string; picks: number; settled: number; correct: number }>('CompetitionWeekSport').implement({
  fields: (t) => ({
    sport: t.field({ type: SportRef, resolve: (s) => sportOf(s.sportId) }),
    picks: t.exposeInt('picks'),
    settled: t.exposeInt('settled'),
    correct: t.exposeInt('correct'),
  }),
});
const BestCallRef = builder.objectRef<{ label: string; points: number }>('CompetitionBestCall').implement({
  fields: (t) => ({ label: t.exposeString('label'), points: t.exposeInt('points') }),
});
type WeekView = Awaited<ReturnType<typeof competitions.week>>;
const WeekRef = builder.objectRef<WeekView>('CompetitionWeek').implement({
  description: 'The share card: the last 7 days.',
  fields: (t) => ({
    picks: t.exposeInt('picks'),
    accuracy: t.exposeInt('accuracy', { nullable: true }),
    sports: t.field({ type: [WeekSportRef], resolve: (w) => w.sports }),
    best: t.field({ type: BestCallRef, nullable: true, resolve: (w) => w.best }),
  }),
});

export const CompetitionRef = builder.objectRef<Competition>('Competition').implement({
  description: 'competitions R1, R2 — a prediction competition played for a group. Its points are its own.',
  fields: (t) => ({
    id: t.exposeID('id'),
    slug: t.exposeString('slug'),
    segment: t.field({ type: SegmentEnum, resolve: (c) => c.segment }),
    name: t.exposeString('name'),
    seasonLabel: t.exposeString('seasonLabel'),
    tagline: t.exposeString('tagline', { nullable: true }),
    groupNoun: t.exposeString('groupNoun'),
    groupNounPlural: t.exposeString('groupNounPlural'),
    startsAt: t.field({ type: 'DateTime', resolve: (c) => c.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (c) => c.endsAt }),
    status: t.field({ type: StatusEnum, resolve: (c) => c.status }),
    isPlayable: t.boolean({ resolve: (c) => competitions.isPlayable(c) }),
    teamSize: t.exposeInt('teamSize'),
    activeDays: t.exposeInt('activeDays'),
    openHours: t.exposeInt('openHours'),
    codeRequired: t.exposeBoolean('codeRequired'),
    onHome: t.exposeBoolean('onHome'),
    homeOrder: t.exposeInt('homeOrder'),
    prizes: t.field({ type: [PrizeRef], resolve: (c) => c.prizes }),
    scoring: t.field({ type: [ScoringRef], resolve: (c) => c.scoring }),
    finePrint: t.exposeString('finePrint', { nullable: true }),
    crowdBase: t.exposeInt('crowdBase', { description: '067 — a right pick earns round(crowdBase × (1 − crowd share)).' }),
    crowdPrior: t.exposeInt('crowdPrior', { description: '067 — starting picks, spread evenly, so every question starts even.' }),
    crowdMinPct: t.exposeInt('crowdMinPct'),
    crowdMaxPct: t.exposeInt('crowdMaxPct'),
    specialistMinPicks: t.exposeInt('specialistMinPicks'),
    groupsPlaying: t.int({ resolve: async (c) => (await competitions.counts(c.id)).groupsPlaying }),
    players: t.int({ resolve: async (c) => (await competitions.counts(c.id)).players }),
    openQuestionCount: t.int({ resolve: async (c) => (await competitions.openSummary(c.id)).questions }),
    openSportCount: t.int({ resolve: async (c) => (await competitions.openSummary(c.id)).sports }),
    nextToLock: t.field({ type: CompetitionQuestionRef, nullable: true, resolve: async (c) => (await competitions.openSummary(c.id)).next }),
    me: t.field({ type: StandingRef, nullable: true, description: 'Null when you are not in it (or signed out).', resolve: (c, _a, ctx) => standingOf(ctx, c.id) }),
    myWeek: t.field({
      type: WeekRef,
      nullable: true,
      resolve: async (c, _a, ctx) => {
        const userId = ctx.actor?.userId;
        if (!userId || !(await competitions.membership(c.id, userId))) return null;
        return competitions.week(c.id, userId);
      },
    }),
    sports: t.field({
      type: [SportRef],
      description: 'Sports with open or upcoming questions.',
      resolve: async (c) => {
        const ids = await competitions.sportsInPlay(c.id);
        return (await Promise.all(ids.map(sportOf))).filter((s): s is NonNullable<typeof s> => !!s);
      },
    }),
    moments: t.field({ type: [MomentRef], description: 'Bonus moments still ahead.', resolve: (c) => competitions.moments(c.id, { upcomingOnly: true }) }),
    openQuestions: t.field({
      type: [CompetitionQuestionRef],
      args: { sportId: t.arg.id(), first: t.arg.int({ defaultValue: 50 }) },
      resolve: (c, args) => competitions.openQuestions(c.id, { sportId: args.sportId ? String(args.sportId) : null, first: args.first ?? 50 }),
    }),
    openingSoon: t.field({
      type: [CompetitionQuestionRef],
      args: { first: t.arg.int({ defaultValue: 30 }) },
      resolve: (c, args) => competitions.upcomingQuestions(c.id, { first: args.first ?? 30 }),
    }),
    groups: t.field({
      type: [CompetitionGroupRef],
      description: 'The list behind "Find your college".',
      args: { search: t.arg.string() },
      resolve: (c, args) => competitions.groups(c.id, args.search ?? null),
    }),
    board: t.field({
      type: BoardRef,
      args: { kind: t.arg({ type: BoardKindEnum, required: true }), period: t.arg({ type: PeriodEnum }), first: t.arg.int({ defaultValue: 50 }) },
      resolve: (c, args, ctx) =>
        competitions.board(c.id, ctx.actor?.userId ?? null, args.kind as CompetitionBoardKind, { period: (args.period ?? 'season') as CompetitionBoardPeriod, first: args.first ?? 50 }),
    }),
  }),
});

const CodePreviewRef = builder.objectRef<{ code: CompetitionJoinCode; group: CompetitionGroup; competition: Competition }>('CompetitionCodePreview').implement({
  fields: (t) => ({
    code: t.string({ resolve: (p) => p.code.code }),
    ambassadorName: t.string({ nullable: true, resolve: (p) => p.code.ambassadorName }),
    group: t.field({ type: CompetitionGroupRef, resolve: (p) => p.group }),
    competition: t.field({ type: CompetitionRef, resolve: (p) => p.competition }),
    groupRank: t.int({
      nullable: true,
      resolve: async (p) => (await competitions.groupStandings(p.competition)).find((s) => s.groupId === p.group.id)?.rank ?? null,
    }),
  }),
});

const visible = (c: Competition | null, ctx: Ctx): Promise<Competition | null> => {
  if (!c) return Promise.resolve(null);
  if (c.status !== 'draft') return Promise.resolve(c);
  // A draft is staff-only: the portal previews it.
  return requirePlatformStaff(ctx).then(
    () => c,
    () => null,
  );
};

builder.queryFields((t) => ({
  homeCompetitions: t.field({
    type: [CompetitionRef],
    description: 'Home’s top card(s): live competitions, the ones you play first.',
    resolve: (_r, _a, ctx) => competitions.forHome(ctx.actor?.userId ?? null),
  }),
  competition: t.field({
    type: CompetitionRef,
    nullable: true,
    args: { slug: t.arg.string(), id: t.arg.id() },
    resolve: async (_r, args, ctx) => visible(args.id ? await competitions.byId(String(args.id)) : args.slug ? await competitions.bySlug(args.slug) : null, ctx),
  }),
  competitionCode: t.field({
    type: CodePreviewRef,
    nullable: true,
    description: 'What a join code joins, before joining. Null for an unknown code.',
    args: { code: t.arg.string({ required: true }) },
    resolve: async (_r, args) => {
      const found = await competitions.previewCode(args.code);
      return found && competitions.isPlayable(found.competition) ? found : null;
    },
  }),
}));

const JoinPayload = builder
  .objectRef<{ competition: Competition | null; userError: UserErrorShape | null }>('JoinCompetitionPayload')
  .implement({
    fields: (t) => ({
      competition: t.field({ type: CompetitionRef, nullable: true, resolve: (p) => p.competition }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PickPayload = builder
  .objectRef<{ pick: CompetitionPick | null; question: CompetitionQuestion | null; userError: UserErrorShape | null }>('MakeCompetitionPickPayload')
  .implement({
    fields: (t) => ({
      pick: t.field({ type: PickRef, nullable: true, resolve: (p) => p.pick }),
      question: t.field({ type: CompetitionQuestionRef, nullable: true, resolve: (p) => p.question }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  joinCompetition: t.field({
    type: JoinPayload,
    description: 'competitions R3 — join with a code (or a group, where no code is needed). Locked for the season.',
    args: { code: t.arg.string(), groupId: t.arg.id() },
    resolve: async (_r, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => competitions.join(actor.userId, { code: args.code ?? null, groupId: args.groupId ? String(args.groupId) : null }));
      return { competition: data ? await competitions.byId(data.competitionId) : null, userError };
    },
  }),
  makeCompetitionPick: t.field({
    type: PickPayload,
    description: 'competitions R4 — pick an option, or both scores. Changeable until it locks.',
    args: { questionId: t.arg.id({ required: true }), optionId: t.arg.id(), home: t.arg.int(), away: t.arg.int() },
    resolve: async (_r, args, ctx) => {
      const actor = requireActor(ctx);
      const questionId = String(args.questionId);
      const { data, userError } = await attempt(() =>
        competitions.pick(actor.userId, questionId, { optionId: args.optionId ? String(args.optionId) : null, home: args.home ?? null, away: args.away ?? null }),
      );
      return { pick: data, question: data ? await competitions.question(questionId) : null, userError };
    },
  }),
}));

// --- PL4Y staff (portal) -----------------------------------------------------------

const EDITORS = ['admin', 'support'] as const;

const PrizeInput = builder.inputType('CompetitionPrizeInput', {
  fields: (t) => ({ title: t.string({ required: true }), detail: t.string({ required: true }) }),
});
const ScoringInput = builder.inputType('CompetitionScoringLineInput', {
  fields: (t) => ({ label: t.string({ required: true }), value: t.string({ required: true }) }),
});
const CompetitionInputRef = builder.inputType('CompetitionInput', {
  fields: (t) => ({
    slug: t.string({ required: true }),
    segment: t.field({ type: SegmentEnum, required: true }),
    name: t.string({ required: true }),
    seasonLabel: t.string({ required: true }),
    tagline: t.string(),
    groupNoun: t.string({ description: 'college, company, gym…' }),
    groupNounPlural: t.string(),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', required: true }),
    status: t.field({ type: StatusEnum }),
    teamSize: t.int(),
    activeDays: t.int(),
    openHours: t.int(),
    codeRequired: t.boolean(),
    onHome: t.boolean(),
    homeOrder: t.int(),
    prizes: t.field({ type: [PrizeInput] }),
    scoring: t.field({ type: [ScoringInput] }),
    finePrint: t.string(),
    crowdBase: t.int(),
    crowdPrior: t.int(),
    crowdMinPct: t.int(),
    crowdMaxPct: t.int(),
    specialistMinPicks: t.int(),
  }),
});
const GroupInputRef = builder.inputType('CompetitionGroupInput', {
  fields: (t) => ({
    name: t.string({ required: true }),
    fullName: t.string(),
    city: t.string(),
    leadName: t.string(),
    hidden: t.boolean(),
  }),
});
const MomentInputRef = builder.inputType('CompetitionMomentInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    title: t.string({ required: true }),
    subtitle: t.string(),
    multiplier: t.float(),
    startsAt: t.field({ type: 'DateTime', required: true }),
  }),
});
const OptionInput = builder.inputType('CompetitionOptionInput', {
  fields: (t) => ({ label: t.string({ required: true }), outcome: t.field({ type: OutcomeEnum }) }),
});
const QuestionInputRef = builder.inputType('CompetitionQuestionInput', {
  fields: (t) => ({
    competitionId: t.id({ required: true }),
    momentId: t.id(),
    matchId: t.id({ description: 'A pro match: sets the sport, the start, the event name, and settles tagged options from the result.' }),
    sportId: t.id({ description: 'Needed only without a match.' }),
    eventLabel: t.string(),
    kind: t.field({ type: KindEnum, required: true }),
    prompt: t.string({ description: 'Defaults: "Who wins?" with a match, "Call the exact score".' }),
    points: t.int({ description: 'Default 10, or 25 for an exact score.' }),
    multiplier: t.float({ description: 'Default: the moment’s, else 1.' }),
    startsAt: t.field({ type: 'DateTime' }),
    opensAt: t.field({ type: 'DateTime', description: 'Default: `openHours` before the start.' }),
    locksAt: t.field({ type: 'DateTime', description: 'Default: the start.' }),
    options: t.field({ type: [OptionInput], description: 'A choice question: 2 to 6. None with a match: the two sides (and a draw).' }),
  }),
});
const QuestionPatchRef = builder.inputType('CompetitionQuestionPatch', {
  fields: (t) => ({
    prompt: t.string(),
    eventLabel: t.string(),
    points: t.int(),
    multiplier: t.float(),
    opensAt: t.field({ type: 'DateTime' }),
    locksAt: t.field({ type: 'DateTime' }),
  }),
});

const CompetitionPayload = builder.objectRef<{ competition: Competition | null; userError: UserErrorShape | null }>('CompetitionPayload').implement({
  fields: (t) => ({
    competition: t.field({ type: CompetitionRef, nullable: true, resolve: (p) => p.competition }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});
const GroupPayload = builder.objectRef<{ group: CompetitionGroup | null; userError: UserErrorShape | null }>('CompetitionGroupPayload').implement({
  fields: (t) => ({
    group: t.field({ type: CompetitionGroupRef, nullable: true, resolve: (p) => p.group }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});
const CodePayload = builder.objectRef<{ code: CompetitionJoinCode | null; userError: UserErrorShape | null }>('CompetitionCodePayload').implement({
  fields: (t) => ({
    code: t.field({ type: JoinCodeRef, nullable: true, resolve: (p) => p.code }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});
const MomentPayload = builder.objectRef<{ moment: CompetitionMoment | null; userError: UserErrorShape | null }>('CompetitionMomentPayload').implement({
  fields: (t) => ({
    moment: t.field({ type: MomentRef, nullable: true, resolve: (p) => p.moment }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});
const QuestionPayload = builder.objectRef<{ question: CompetitionQuestion | null; userError: UserErrorShape | null }>('CompetitionQuestionPayload').implement({
  fields: (t) => ({
    question: t.field({ type: CompetitionQuestionRef, nullable: true, resolve: (p) => p.question }),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});
const CountPayload = builder.objectRef<{ count: number; userError: UserErrorShape | null }>('CompetitionCountPayload').implement({
  fields: (t) => ({
    count: t.exposeInt('count'),
    userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
  }),
});

const MemberRef = builder.objectRef<CompetitionMember>('CompetitionMemberRow').implement({
  fields: (t) => ({
    userId: t.id({ resolve: (m) => m.userId }),
    name: t.string({
      resolve: async (m) => {
        const { db } = await import('../../../platform/db.js');
        return (await db.user.findUnique({ where: { id: m.userId }, select: { displayName: true } }))?.displayName ?? 'Player';
      },
    }),
    group: t.field({ type: CompetitionGroupRef, resolve: async (m) => (await competitions.group(m.groupId))! }),
    code: t.exposeString('code', { nullable: true }),
    joinedAt: t.field({ type: 'DateTime', resolve: (m) => m.joinedAt }),
  }),
});

builder.objectFields(CompetitionRef, (t) => ({
  adminGroups: t.field({
    type: [CompetitionGroupRef],
    description: 'Portal — every group, hidden ones too.',
    resolve: async (c, _a, ctx) => {
      await requirePlatformStaff(ctx);
      return competitions.groups(c.id, null, true);
    },
  }),
  adminMoments: t.field({
    type: [MomentRef],
    description: 'Portal — every bonus moment.',
    resolve: async (c, _a, ctx) => {
      await requirePlatformStaff(ctx);
      return competitions.moments(c.id);
    },
  }),
  adminQuestions: t.field({
    type: [CompetitionQuestionRef],
    description: 'Portal — every question, latest event first.',
    args: { status: t.arg({ type: QStatusEnum }), first: t.arg.int({ defaultValue: 200 }) },
    resolve: async (c, args, ctx) => {
      await requirePlatformStaff(ctx);
      return competitions.staffQuestions(c.id, { status: (args.status as CompetitionQuestionStatus | null) ?? null, first: args.first ?? 200 });
    },
  }),
  adminMembers: t.field({
    type: [MemberRef],
    description: 'Portal — newest first.',
    args: { groupId: t.arg.id(), first: t.arg.int({ defaultValue: 200 }) },
    resolve: async (c, args, ctx) => {
      await requirePlatformStaff(ctx);
      return competitions.staffMembers(c.id, { groupId: args.groupId ? String(args.groupId) : null, first: args.first ?? 200 });
    },
  }),
}));

builder.queryFields((t) => ({
  adminCompetitions: t.field({
    type: [CompetitionRef],
    resolve: async (_r, _a, ctx) => {
      await requirePlatformStaff(ctx);
      return competitions.staffList();
    },
  }),
}));

builder.mutationFields((t) => ({
  adminSaveCompetition: t.field({
    type: CompetitionPayload,
    description: 'Create (no id) or edit a competition.',
    args: { id: t.arg.id(), input: t.arg({ type: CompetitionInputRef, required: true }) },
    resolve: async (_r, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        competitions.saveCompetition(staff.userId, args.id ? String(args.id) : null, {
          slug: i.slug,
          segment: i.segment as CompetitionSegment,
          name: i.name,
          seasonLabel: i.seasonLabel,
          tagline: i.tagline ?? null,
          groupNoun: i.groupNoun ?? null,
          groupNounPlural: i.groupNounPlural ?? null,
          startsAt: i.startsAt,
          endsAt: i.endsAt,
          status: (i.status as CompetitionStatus | null | undefined) ?? null,
          teamSize: i.teamSize ?? null,
          activeDays: i.activeDays ?? null,
          openHours: i.openHours ?? null,
          codeRequired: i.codeRequired ?? null,
          onHome: i.onHome ?? null,
          homeOrder: i.homeOrder ?? null,
          prizes: i.prizes ?? null,
          scoring: i.scoring ?? null,
          finePrint: i.finePrint ?? null,
          crowdBase: i.crowdBase ?? null,
          crowdPrior: i.crowdPrior ?? null,
          crowdMinPct: i.crowdMinPct ?? null,
          crowdMaxPct: i.crowdMaxPct ?? null,
          specialistMinPicks: i.specialistMinPicks ?? null,
        }),
      );
      return { competition: data, userError };
    },
  }),
  adminSaveCompetitionGroup: t.field({
    type: GroupPayload,
    args: { competitionId: t.arg.id({ required: true }), id: t.arg.id(), input: t.arg({ type: GroupInputRef, required: true }) },
    resolve: async (_r, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        competitions.saveGroup(String(args.competitionId), args.id ? String(args.id) : null, {
          name: i.name,
          fullName: i.fullName ?? null,
          city: i.city ?? null,
          leadName: i.leadName ?? null,
          status: i.hidden ? 'hidden' : 'active',
        }),
      );
      return { group: data, userError };
    },
  }),
  adminSaveCompetitionCode: t.field({
    type: CodePayload,
    description: 'Add a join code to a group, or edit / switch off an existing one.',
    args: { groupId: t.arg.id({ required: true }), code: t.arg.string({ required: true }), ambassadorName: t.arg.string(), active: t.arg.boolean() },
    resolve: async (_r, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(() =>
        competitions.saveCode({ groupId: String(args.groupId), code: args.code, ambassadorName: args.ambassadorName ?? null, active: args.active ?? true }),
      );
      return { code: data, userError };
    },
  }),
  adminSaveCompetitionMoment: t.field({
    type: MomentPayload,
    args: { competitionId: t.arg.id({ required: true }), id: t.arg.id(), input: t.arg({ type: MomentInputRef, required: true }) },
    resolve: async (_r, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        competitions.saveMoment(String(args.competitionId), args.id ? String(args.id) : null, {
          sportId: String(i.sportId),
          title: i.title,
          subtitle: i.subtitle ?? null,
          multiplier: i.multiplier ?? null,
          startsAt: i.startsAt,
        }),
      );
      return { moment: data, userError };
    },
  }),
  adminDeleteCompetitionMoment: t.field({
    type: 'Boolean',
    description: 'Its open questions drop back to ×1.',
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      return competitions.deleteMoment(String(args.id));
    },
  }),
  adminCreateCompetitionQuestion: t.field({
    type: QuestionPayload,
    args: { input: t.arg({ type: QuestionInputRef, required: true }) },
    resolve: async (_r, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        competitions.createQuestion(staff.userId, {
          competitionId: String(i.competitionId),
          momentId: i.momentId ? String(i.momentId) : null,
          matchId: i.matchId ? String(i.matchId) : null,
          sportId: i.sportId ? String(i.sportId) : null,
          eventLabel: i.eventLabel ?? null,
          kind: i.kind as CompetitionQuestionKind,
          prompt: i.prompt ?? null,
          points: i.points ?? null,
          multiplier: i.multiplier ?? null,
          startsAt: i.startsAt ?? null,
          opensAt: i.opensAt ?? null,
          locksAt: i.locksAt ?? null,
          options: (i.options ?? []).map((o) => ({ label: o.label, outcome: (o.outcome as CompetitionOutcome | null | undefined) ?? null })),
        }),
      );
      return { question: data, userError };
    },
  }),
  adminAddCompetitionWinnerQuestions: t.field({
    type: CountPayload,
    description: 'A "Who wins?" on every upcoming feed match in the window that has no Cup question yet.',
    args: {
      competitionId: t.arg.id({ required: true }),
      sportId: t.arg.id(),
      league: t.arg.string({ description: 'Part of the league name, e.g. "Premier League".' }),
      days: t.arg.int({ defaultValue: 3 }),
      points: t.arg.int(),
      momentId: t.arg.id(),
    },
    resolve: async (_r, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(() =>
        competitions.addWinnerQuestions(staff.userId, String(args.competitionId), {
          sportId: args.sportId ? String(args.sportId) : null,
          league: args.league ?? null,
          days: args.days ?? 3,
          points: args.points ?? null,
          momentId: args.momentId ? String(args.momentId) : null,
        }),
      );
      return { count: data ?? 0, userError };
    },
  }),
  adminUpdateCompetitionQuestion: t.field({
    type: QuestionPayload,
    description: 'Only while open. Set `locksAt` to now to lock it early.',
    args: { id: t.arg.id({ required: true }), input: t.arg({ type: QuestionPatchRef, required: true }) },
    resolve: async (_r, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        competitions.updateQuestion(String(args.id), {
          prompt: i.prompt ?? undefined,
          eventLabel: i.eventLabel ?? undefined,
          points: i.points ?? undefined,
          multiplier: i.multiplier ?? undefined,
          opensAt: i.opensAt ?? undefined,
          locksAt: i.locksAt ?? undefined,
        }),
      );
      return { question: data, userError };
    },
  }),
  adminSettleCompetitionQuestion: t.field({
    type: QuestionPayload,
    description: 'competitions R5 — marks every pick and writes Cup points, once. Audited.',
    args: { id: t.arg.id({ required: true }), optionId: t.arg.id(), home: t.arg.int(), away: t.arg.int(), reason: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const id = String(args.id);
      const answer = { optionId: args.optionId ? String(args.optionId) : null, home: args.home ?? null, away: args.away ?? null };
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'competition.settle', targetType: 'competition_question', targetId: id, details: answer }, args.reason, () =>
          competitions.settle(staff.userId, id, answer),
        ),
      );
      return { question: data, userError };
    },
  }),
  adminVoidCompetitionQuestion: t.field({
    type: QuestionPayload,
    description: 'Nobody earns anything. Audited.',
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_r, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'competition.void', targetType: 'competition_question', targetId: id, details: {} }, args.reason, () => competitions.voidQuestion(id)),
      );
      return { question: data, userError };
    },
  }),
}));
