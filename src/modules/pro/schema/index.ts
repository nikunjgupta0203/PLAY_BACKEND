/**
 * pro — GraphQL surface (Floodlight redesign §4.3, Match Centre).
 *
 * Players read the board, one match, its moments and its chat, and post in
 * the chat. PL4Y staff (portal) enter everything else: until a data feed is
 * signed, the score is typed by a person.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requestLoader } from '../../../graphql/requestLoader.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { SportRef } from '../../sport/schema/index.js';
import { sport } from '../../sport/index.js';
import { WATCH_SPORT_SLUGS } from '../watchSports.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { MOMENT_KINDS, FOLLOW_PROVIDERS, pro, proFeeds, proMatchChannel } from '../index.js';
import type { Innings, MomentKind, ProChatMessage, ProMatch, ProMoment, ProStat, ProStatus, ProTeam, ProWinner, FeedFollow, RunSummary } from '../index.js';
import type { FeedProvider, FeedStatus } from '../../../platform/feeds.js';

const ProStatusEnum = builder.enumType('ProMatchStatus', {
  values: {
    SCHEDULED: { value: 'scheduled' },
    LIVE: { value: 'live' },
    BREAK: { value: 'break', description: 'Innings break, half time: still live for the board.' },
    FINISHED: { value: 'finished' },
    ABANDONED: { value: 'abandoned' },
  } as const,
});

const MomentKindEnum = builder.enumType('ProMomentKind', {
  values: Object.fromEntries(MOMENT_KINDS.map((k) => [k.toUpperCase(), { value: k }])) as Record<string, { value: MomentKind }>,
});

const WinnerEnum = builder.enumType('ProMatchWinner', {
  values: { HOME: { value: 'home' }, AWAY: { value: 'away' }, DRAW: { value: 'draw' } } as const,
});

const BoardFilterEnum = builder.enumType('ProBoardFilter', {
  values: { LIVE: { value: 'live' }, UPCOMING: { value: 'upcoming' }, FINISHED: { value: 'finished' } } as const,
});

export const ProTeamRef = builder.objectRef<ProTeam>('ProTeam').implement({
  description: 'A professional team. `tint` is the code circle’s colour, from data.',
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    shortCode: t.exposeString('shortCode'),
    tint: t.exposeString('tint'),
    sport: t.field({
      type: SportRef,
      resolve: async (team) => {
        const { sport } = await import('../../sport/index.js');
        return sport.byId(team.sportId);
      },
    }),
  }),
});

const StatRef = builder.objectRef<ProStat>('ProMatchStat').implement({
  fields: (t) => ({ label: t.exposeString('label'), value: t.exposeString('value') }),
});

const ScoreRowRef = builder.objectRef<Innings['rows'][number]>('ProScoreRow').implement({
  fields: (t) => ({
    name: t.exposeString('name'),
    detail: t.string({ nullable: true, resolve: (r) => r.detail ?? null }),
    cells: t.exposeStringList('cells'),
  }),
});

const InningsRef = builder.objectRef<Innings>('ProInnings').implement({
  description: 'One table of the scorecard: a batting or bowling card, a box score.',
  fields: (t) => ({
    team: t.exposeString('team'),
    title: t.exposeString('title'),
    columns: t.exposeStringList('columns'),
    rows: t.field({ type: [ScoreRowRef], resolve: (i) => i.rows }),
    footer: t.string({ nullable: true, resolve: (i) => i.footer ?? null }),
  }),
});

const MomentRef = builder.objectRef<ProMoment>('ProMoment').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    atLabel: t.exposeString('atLabel', { nullable: true }),
    kind: t.field({ type: MomentKindEnum, resolve: (m) => m.kind }),
    title: t.exposeString('title'),
    detail: t.exposeString('detail', { nullable: true }),
    createdAt: t.field({ type: 'DateTime', resolve: (m) => m.createdAt }),
  }),
});

const ChatMessageRef = builder.objectRef<ProChatMessage>('ProChatMessage').implement({
  description: 'pro R4 — a message in a match’s public room. Render `body` as plain text.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    hidden: t.exposeBoolean('hidden', { description: 'Staff only see these; players never get them.' }),
    createdAt: t.field({ type: 'DateTime', resolve: (m) => m.createdAt }),
    mine: t.boolean({ resolve: (m, _a, ctx) => ctx.actor?.userId === m.userId }),
    author: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (m, _a, ctx) => ctx.loaders.publicProfileByUser.load(m.userId),
    }),
  }),
});

const ChatPageRef = builder
  .objectRef<{ nodes: ProChatMessage[]; hasNextPage: boolean; endCursor: string | null }>('ProChatPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [ChatMessageRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
      endCursor: t.exposeString('endCursor', { nullable: true }),
    }),
  });

/** One batched read per request: a 30-match board is one query, not 60. */
const teamOf = (ctx: Ctx, id: string) =>
  requestLoader<string, ProTeam | null>(ctx, 'proTeam', async (ids) => {
    const found = await pro.teamsByIds(ids);
    return ids.map((i) => found.get(i) ?? null);
  }).load(id);

export const ProMatchRef = builder.objectRef<ProMatch>('ProMatch').implement({
  description: 'A professional match. Entered by PL4Y staff while there is no data feed (`provider` = manual).',
  fields: (t) => ({
    id: t.exposeID('id'),
    league: t.exposeString('league'),
    stage: t.exposeString('stage', { nullable: true }),
    sport: t.field({
      type: SportRef,
      resolve: async (m) => {
        const { sport } = await import('../../sport/index.js');
        return sport.byId(m.sportId);
      },
    }),
    home: t.field({ type: ProTeamRef, resolve: async (m, _a, ctx) => (await teamOf(ctx, m.homeTeamId))! }),
    away: t.field({ type: ProTeamRef, resolve: async (m, _a, ctx) => (await teamOf(ctx, m.awayTeamId))! }),
    venueName: t.exposeString('venueName', { nullable: true }),
    city: t.exposeString('city', { nullable: true }),
    startsAt: t.field({ type: 'DateTime', resolve: (m) => m.startsAt }),
    status: t.field({ type: ProStatusEnum, resolve: (m) => m.status }),
    isLive: t.boolean({ resolve: (m) => m.status === 'live' || m.status === 'break' }),
    statusDetail: t.exposeString('statusDetail', { nullable: true, description: '"2nd innings", "67\'".' }),
    homeScore: t.exposeString('homeScore', { nullable: true }),
    awayScore: t.exposeString('awayScore', { nullable: true }),
    homeDetail: t.exposeString('homeDetail', { nullable: true, description: '"20 ov".' }),
    awayDetail: t.exposeString('awayDetail', { nullable: true }),
    note: t.exposeString('note', { nullable: true, description: '"MI need 41 off 34".' }),
    stats: t.field({ type: [StatRef], resolve: (m) => m.stats }),
    currentOver: t.exposeStringList('currentOver', { description: 'The balls of the over in play: "1", "4", "W", "6".' }),
    scorecard: t.field({ type: [InningsRef], resolve: (m) => m.scorecard }),
    featured: t.exposeBoolean('featured'),
    chatOpen: t.exposeBoolean('chatOpen'),
    provider: t.exposeString('provider', { description: 'manual, or the feed that keeps it current: cricapi, api_football, snooker_org.' }),
    providerRef: t.exposeString('providerRef', { nullable: true }),
    feedLocked: t.exposeStringList('feedLocked', { description: 'pro R8 — fields staff edited by hand; the feed leaves them alone until handed back.' }),
    winner: t.field({ type: WinnerEnum, nullable: true, resolve: (m) => m.winner }),
    updatedAt: t.field({ type: 'DateTime', resolve: (m) => m.updatedAt }),
    scoreCheckedAt: t.field({
      type: 'DateTime',
      description: 'G9 — when the score was last confirmed: the latest feed check or edit. "Updated 3 min ago".',
      resolve: (m) => (m.feedCheckedAt && m.feedCheckedAt > m.updatedAt ? m.feedCheckedAt : m.updatedAt),
    }),
    channel: t.string({ description: 'pro R5 — subscribe for `pro.match.updated` and `pro.chat.message`.', resolve: (m) => proMatchChannel(m.id) }),
    moments: t.field({
      type: [MomentRef],
      args: { first: t.arg.int({ defaultValue: 30 }) },
      resolve: (m, args) => pro.moments(m.id, args.first ?? 30),
    }),
    chatCount: t.int({ description: 'Fans who have said something in the room.', resolve: (m) => pro.chatterCount(m.id) }),
  }),
});

builder.objectField(PlayerProfileRef, 'favouriteTeams', (t) =>
  t.field({
    type: [ProTeamRef],
    description: 'pro R6 — the teams this player follows. Hidden with the rest of the details.',
    resolve: async (p) => {
      if (!p.detailsVisible) return [];
      const { profileExtras } = await import('../../profile/index.js');
      const userId = await profileExtras.userIdOf(p.id);
      return userId ? pro.favouriteTeams(userId) : [];
    },
  }),
);

// --- players ----------------------------------------------------------------------

builder.queryFields((t) => ({
  proMatches: t.field({
    type: [ProMatchRef],
    description: 'pro R3 — the Matches board: live first, then upcoming soonest, then the latest results.',
    args: {
      sportId: t.arg.id(),
      filter: t.arg({ type: BoardFilterEnum }),
      q: t.arg.string({ description: 'A team name, short code or league.' }),
      first: t.arg.int({ defaultValue: 30 }),
    },
    resolve: (_root, args) =>
      pro.board({
        sportId: args.sportId ? String(args.sportId) : null,
        status: (args.filter as 'live' | 'upcoming' | 'finished' | null | undefined) ?? null,
        q: args.q ?? null,
        first: args.first ?? 30,
      }),
  }),
  proMatch: t.field({
    type: ProMatchRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args) => pro.match(String(args.id)),
  }),
  proSports: t.field({
    type: [SportRef],
    description: 'Floodlight — the sports PL4Y follows for matches, news and predictions, in display order. Not the sports offered for play (`sports`).',
    resolve: async () => {
      const found = await Promise.all(WATCH_SPORT_SLUGS.map((slug) => sport.findBySlug(slug)));
      return found.filter((s): s is NonNullable<typeof s> => s !== null && s.active);
    },
  }),
  proTeams: t.field({
    type: [ProTeamRef],
    args: { sportId: t.arg.id() },
    resolve: (_root, args) => pro.teams(args.sportId ? String(args.sportId) : null),
  }),
  proMatchChat: t.field({
    type: ChatPageRef,
    description: 'pro R4 — newest first; `before` pages back. Signed-in players only.',
    args: { matchId: t.arg.id({ required: true }), first: t.arg.int({ defaultValue: 30 }), before: t.arg.string() },
    resolve: (_root, args, ctx) => {
      requireActor(ctx);
      return pro.chat(String(args.matchId), { first: args.first ?? 30, before: args.before ?? null });
    },
  }),
  myFavouriteTeams: t.field({
    type: [ProTeamRef],
    resolve: (_root, _args, ctx) => pro.favouriteTeams(requireActor(ctx).userId),
  }),
}));

const ChatPayload = builder
  .objectRef<{ message: ProChatMessage | null; userError: UserErrorShape | null }>('SendProMatchMessagePayload')
  .implement({
    fields: (t) => ({
      message: t.field({ type: ChatMessageRef, nullable: true, resolve: (p) => p.message }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const TeamsPayload = builder
  .objectRef<{ teams: ProTeam[] | null; userError: UserErrorShape | null }>('SetFavouriteTeamsPayload')
  .implement({
    fields: (t) => ({
      teams: t.field({ type: [ProTeamRef], nullable: true, resolve: (p) => p.teams }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  sendProMatchMessage: t.field({
    type: ChatPayload,
    args: { matchId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => pro.sendMessage(actor.userId, String(args.matchId), args.body));
      return { message: data, userError };
    },
  }),
  setFavouriteTeams: t.field({
    type: TeamsPayload,
    description: 'pro R6 — replaces the list. Up to 10.',
    args: { teamIds: t.arg.idList({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => pro.setFavouriteTeams(actor.userId, args.teamIds.map(String)));
      return { teams: data, userError };
    },
  }),
}));

// --- PL4Y staff -------------------------------------------------------------------

const EDITORS = ['admin', 'support'] as const;

const TeamInput = builder.inputType('ProTeamInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    name: t.string({ required: true }),
    shortCode: t.string({ required: true }),
    tint: t.string(),
  }),
});

const MatchInput = builder.inputType('ProMatchInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    league: t.string({ required: true }),
    stage: t.string(),
    homeTeamId: t.id({ required: true }),
    awayTeamId: t.id({ required: true }),
    venueName: t.string(),
    city: t.string(),
    startsAt: t.field({ type: 'DateTime', required: true }),
    featured: t.boolean(),
  }),
});

const LiveInput = builder.inputType('ProMatchLiveInput', {
  description: 'Everything that changes during play. A field left out stays as it is; null clears it.',
  fields: (t) => ({
    status: t.field({ type: ProStatusEnum }),
    statusDetail: t.string(),
    homeScore: t.string(),
    awayScore: t.string(),
    homeDetail: t.string(),
    awayDetail: t.string(),
    note: t.string(),
    stats: t.field({ type: ['JSONObject'], description: '[{ label, value }] — up to 6.' }),
    currentOver: t.stringList({ description: 'Up to 12 balls.' }),
    scorecard: t.field({ type: ['JSONObject'], description: '[{ team, title, columns, rows: [{ name, detail, cells }], footer }]' }),
    featured: t.boolean(),
    chatOpen: t.boolean(),
    startsAt: t.field({ type: 'DateTime' }),
    league: t.string(),
    stage: t.string(),
    venueName: t.string(),
    city: t.string(),
    winner: t.field({ type: WinnerEnum, description: 'Once finished: who won. Settle suggestions read it.' }),
  }),
});

const MomentInput = builder.inputType('ProMomentInput', {
  fields: (t) => ({
    atLabel: t.string(),
    kind: t.field({ type: MomentKindEnum, required: true }),
    title: t.string({ required: true }),
    detail: t.string(),
  }),
});

const TeamPayload = builder
  .objectRef<{ team: ProTeam | null; userError: UserErrorShape | null }>('ProTeamPayload')
  .implement({
    fields: (t) => ({
      team: t.field({ type: ProTeamRef, nullable: true, resolve: (p) => p.team }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const MatchPayload = builder
  .objectRef<{ match: ProMatch | null; userError: UserErrorShape | null }>('ProMatchPayload')
  .implement({
    fields: (t) => ({
      match: t.field({ type: ProMatchRef, nullable: true, resolve: (p) => p.match }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const MomentPayload = builder
  .objectRef<{ moment: ProMoment | null; userError: UserErrorShape | null }>('ProMomentPayload')
  .implement({
    fields: (t) => ({
      moment: t.field({ type: MomentRef, nullable: true, resolve: (p) => p.moment }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const OkPayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('ProOkPayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

/** `undefined` (left out) stays as it is; `null` clears. */
const keep = <T>(args: Record<string, unknown>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(args, key) ? (args[key] as T) : undefined;

builder.queryFields((t) => ({
  adminProMatches: t.field({
    type: [ProMatchRef],
    description: 'Portal — every pro match, newest start first.',
    args: { first: t.arg.int({ defaultValue: 100 }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return pro.staffList(args.first ?? 100);
    },
  }),
  adminProMatchChat: t.field({
    type: ChatPageRef,
    description: 'Portal — the room with hidden messages included (marked), for moderation.',
    args: { matchId: t.arg.id({ required: true }), first: t.arg.int({ defaultValue: 100 }), before: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return pro.chat(String(args.matchId), { first: args.first ?? 100, before: args.before ?? null }, { staff: true });
    },
  }),
}));

builder.mutationFields((t) => ({
  adminSaveProTeam: t.field({
    type: TeamPayload,
    description: 'Portal — create a team, or edit one when `id` is given.',
    args: { id: t.arg.id(), input: t.arg({ type: TeamInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(() =>
        pro.saveTeam(args.id ? String(args.id) : null, { ...args.input, sportId: String(args.input.sportId) }),
      );
      return { team: data, userError };
    },
  }),
  adminCreateProMatch: t.field({
    type: MatchPayload,
    args: { input: t.arg({ type: MatchInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        pro.createMatch(staff.userId, {
          sportId: String(i.sportId),
          league: i.league,
          stage: i.stage ?? null,
          homeTeamId: String(i.homeTeamId),
          awayTeamId: String(i.awayTeamId),
          venueName: i.venueName ?? null,
          city: i.city ?? null,
          startsAt: i.startsAt,
          featured: i.featured ?? false,
        }),
      );
      return { match: data, userError };
    },
  }),
  adminUpdateProMatch: t.field({
    type: MatchPayload,
    description: 'Portal — the live desk: status, score, over, stats, scorecard. Published to open Match Centres at once.',
    args: { id: t.arg.id({ required: true }), input: t.arg({ type: LiveInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input as Record<string, unknown>;
      const { data, userError } = await attempt(() =>
        pro.updateMatch(String(args.id), {
          status: (keep<ProStatus | null>(i, 'status') ?? undefined) as ProStatus | undefined,
          statusDetail: keep(i, 'statusDetail'),
          homeScore: keep(i, 'homeScore'),
          awayScore: keep(i, 'awayScore'),
          homeDetail: keep(i, 'homeDetail'),
          awayDetail: keep(i, 'awayDetail'),
          note: keep(i, 'note'),
          stats: keep(i, 'stats') ?? undefined,
          currentOver: keep(i, 'currentOver') ?? undefined,
          scorecard: keep(i, 'scorecard') ?? undefined,
          featured: keep<boolean | null>(i, 'featured') ?? undefined,
          chatOpen: keep<boolean | null>(i, 'chatOpen') ?? undefined,
          startsAt: keep<Date | null>(i, 'startsAt') ?? undefined,
          league: keep<string | null>(i, 'league') ?? undefined,
          stage: keep(i, 'stage'),
          venueName: keep(i, 'venueName'),
          city: keep(i, 'city'),
          winner: keep<ProWinner | null>(i, 'winner'),
        }),
      );
      return { match: data, userError };
    },
  }),
  adminReleaseProMatchFeed: t.field({
    type: MatchPayload,
    description: 'pro R8 — hands locked fields back to the feed (all of them when `fields` is left out).',
    args: { id: t.arg.id({ required: true }), fields: t.arg.stringList() },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(() => pro.releaseFeed(String(args.id), args.fields ?? null));
      return { match: data, userError };
    },
  }),
  adminDeleteProMatch: t.field({
    type: OkPayload,
    description: 'Portal — removes the match, its moments, chat and questions. Admins; the reason is audited.',
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin']);
      const id = String(args.id);
      const { userError } = await attempt(() =>
        audited(staff, { action: 'pro_match.delete', targetType: 'pro_match', targetId: id, details: {} }, args.reason, () => pro.deleteMatch(id)),
      );
      return { ok: !userError, userError };
    },
  }),
  adminAddProMoment: t.field({
    type: MomentPayload,
    args: { matchId: t.arg.id({ required: true }), input: t.arg({ type: MomentInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(() => pro.addMoment(String(args.matchId), args.input));
      return { moment: data, userError };
    },
  }),
  adminDeleteProMoment: t.field({
    type: OkPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { userError } = await attempt(() => pro.deleteMoment(String(args.id)));
      return { ok: !userError, userError };
    },
  }),
  adminHideProMatchMessage: t.field({
    type: OkPayload,
    description: 'Portal — moderation. The message is gone for players; the body stays here. Audited.',
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const id = String(args.id);
      const { userError } = await attempt(() =>
        audited(staff, { action: 'pro_chat.hide', targetType: 'pro_match_message', targetId: id, details: {} }, args.reason, () =>
          pro.hideMessage(staff.userId, id),
        ),
      );
      return { ok: !userError, userError };
    },
  }),
}));

// --- feeds (060, portal /pro/feeds) -------------------------------------------------

const FeedProviderEnum = builder.enumType('FeedProvider', {
  values: {
    CRICAPI: { value: 'cricapi' },
    API_FOOTBALL: { value: 'api_football' },
    API_BASKETBALL: { value: 'api_basketball', description: 'Basketball: a follow is the league id.' },
    API_NFL: { value: 'api_nfl', description: 'American football: a follow is the league id (NFL = 1).' },
    API_BASEBALL: { value: 'api_baseball', description: 'Baseball: a follow is the league id (MLB = 1).' },
    API_HOCKEY: { value: 'api_hockey', description: 'Ice hockey: a follow is the league id (NHL = 57).' },
    API_RUGBY: { value: 'api_rugby', description: 'Rugby: a follow is the league id.' },
    API_MMA: { value: 'api_mma', description: 'MMA: a follow is a word in the event name, like "UFC".' },
    JOLPICA: { value: 'jolpica', description: 'Formula 1 (Jolpica, no key): a follow is the season, or "current".' },
    LICHESS: { value: 'lichess', description: 'Chess (Lichess broadcasts, no key): a follow is the broadcast tournament id.' },
    PANDASCORE: { value: 'pandascore', description: 'Esports (PandaScore): a follow is the league id.' },
    SNOOKER_ORG: { value: 'snooker_org' },
    GOOGLE_NEWS: { value: 'google_news' },
    NEWSDATA: { value: 'newsdata' },
    UNSPLASH: { value: 'unsplash' },
    PEXELS: { value: 'pexels' },
  } as const,
});

const FeedStatusRef = builder.objectRef<FeedStatus>('FeedProviderStatus').implement({
  description: 'G10 — one provider: is a key set, calls today (IST) against its limit, the last error.',
  fields: (t) => ({
    provider: t.field({ type: FeedProviderEnum, resolve: (s) => s.provider }),
    label: t.exposeString('label'),
    configured: t.exposeBoolean('configured', { description: 'A key (or the switch) is set on the worker.' }),
    callsToday: t.exposeInt('callsToday'),
    dailyLimit: t.exposeInt('dailyLimit'),
    capped: t.boolean({ resolve: (s) => s.callsToday >= s.dailyLimit }),
    lastCallAt: t.field({ type: 'DateTime', nullable: true, resolve: (s) => s.lastCallAt }),
    lastLivePollAt: t.field({ type: 'DateTime', nullable: true, resolve: (s) => s.lastLivePollAt }),
    lastError: t.exposeString('lastError', { nullable: true }),
    lastErrorAt: t.field({ type: 'DateTime', nullable: true, resolve: (s) => s.lastErrorAt }),
  }),
});

type FollowView = FeedFollow & { lastImportAt: Date | null; lastError: string | null };

const FollowRef = builder.objectRef<FollowView>('FeedFollow').implement({
  description: 'Something PL4Y follows on a feed: a CricAPI series, an API-Football league + season, a snooker.org event, a news search.',
  fields: (t) => ({
    id: t.exposeID('id'),
    provider: t.field({ type: FeedProviderEnum, resolve: (f) => f.provider }),
    ref: t.exposeString('ref'),
    name: t.exposeString('name'),
    season: t.exposeString('season', { nullable: true }),
    enabled: t.exposeBoolean('enabled'),
    lastImportAt: t.field({ type: 'DateTime', nullable: true, resolve: (f) => f.lastImportAt }),
    lastError: t.exposeString('lastError', { nullable: true }),
    sport: t.field({
      type: SportRef,
      resolve: async (f) => {
        const { sport } = await import('../../sport/index.js');
        return sport.byId(f.sportId);
      },
    }),
  }),
});

const RunRef = builder.objectRef<RunSummary>('FeedRunSummary').implement({
  fields: (t) => ({
    provider: t.field({ type: FeedProviderEnum, resolve: (r) => r.provider }),
    created: t.exposeInt('created'),
    updated: t.exposeInt('updated'),
    unchanged: t.exposeInt('unchanged'),
    skipped: t.exposeString('skipped', { nullable: true }),
    errors: t.exposeStringList('errors'),
  }),
});

const FeedJobEnum = builder.enumType('FeedJob', {
  values: {
    FIXTURES: { value: 'fixtures', description: 'Import fixtures for every enabled follow.' },
    LIVE: { value: 'live', description: 'Poll live matches now, due or not.' },
    NEWS: { value: 'news', description: 'Import headlines now.' },
  } as const,
});

const FollowInput = builder.inputType('FeedFollowInput', {
  fields: (t) => ({
    provider: t.field({ type: FeedProviderEnum, required: true }),
    ref: t.string({ required: true, description: 'The feed’s id (series, league, event), or the search for news.' }),
    sportId: t.id({ required: true }),
    name: t.string({ required: true, description: 'As players see it: "IPL 2026", "ISL".' }),
    season: t.string({ description: 'API-Football: the season year.' }),
    enabled: t.boolean(),
  }),
});

const FollowPayload = builder
  .objectRef<{ follow: FollowView | null; userError: UserErrorShape | null }>('FeedFollowPayload')
  .implement({
    fields: (t) => ({
      follow: t.field({ type: FollowRef, nullable: true, resolve: (p) => p.follow }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RunPayload = builder
  .objectRef<{ runs: RunSummary[]; userError: UserErrorShape | null }>('FeedRunPayload')
  .implement({
    fields: (t) => ({
      runs: t.field({ type: [RunRef], resolve: (p) => p.runs }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  adminFeedProviders: t.field({
    type: [FeedStatusRef],
    description: 'Portal — G10: each provider’s calls today against its limit.',
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return proFeeds.status();
    },
  }),
  adminFeedFollows: t.field({
    type: [FollowRef],
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return proFeeds.follows();
    },
  }),
}));

builder.mutationFields((t) => ({
  adminSaveFeedFollow: t.field({
    type: FollowPayload,
    description: 'Portal — follow a series, league, event or news search (or edit one when `id` is given).',
    args: { id: t.arg.id(), input: t.arg({ type: FollowInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      if (!FOLLOW_PROVIDERS.includes(i.provider as FeedProvider)) {
        return { follow: null, userError: { code: 'INVALID_FEED_FOLLOW', message: 'Pictures are not followed: they fill in for headlines with none.' } };
      }
      const { data, userError } = await attempt(() =>
        proFeeds.saveFollow(args.id ? String(args.id) : null, {
          provider: i.provider as FeedProvider,
          ref: i.ref,
          sportId: String(i.sportId),
          name: i.name,
          season: i.season ?? null,
          enabled: i.enabled ?? true,
        }),
      );
      return { follow: data, userError };
    },
  }),
  adminDeleteFeedFollow: t.field({
    type: OkPayload,
    description: 'Portal — stop following. Matches already imported stay.',
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { userError } = await attempt(() => proFeeds.deleteFollow(String(args.id)));
      return { ok: !userError, userError };
    },
  }),
  adminRunFeed: t.field({
    type: RunPayload,
    description: 'Portal — run a feed job now. Spends calls from the same daily budget.',
    args: { job: t.arg({ type: FeedJobEnum, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(async () => {
        if (args.job === 'fixtures') {
          const runs = await proFeeds.importFixtures();
          // predictions R10 — the portal's "run now" makes the questions too.
          const { predictions } = await import('../../predictions/index.js');
          await predictions.autoWinnerQuestions();
          return runs;
        }
        if (args.job === 'live') return proFeeds.pollLive({ force: true });
        const { news } = await import('../../content/index.js');
        const r = await news.run();
        return [{ provider: 'google_news' as const, created: r.imported, updated: r.archived, unchanged: 0, skipped: r.skipped, errors: r.errors }];
      });
      return { runs: data ?? [], userError };
    },
  }),
}));
