/**
 * profile — GraphQL surface (docs/modules/03-profile.md).
 *
 * Resolvers never touch Prisma (conventions.md §1): they call the service and
 * shape the result. `PlayerProfile` is one of the four Node types, because a
 * profile is a deep-link target (conventions.md §4).
 *
 * `recentResults` from the module doc is not here yet, and is not a stub: it
 * needs `matches`, which lands with `scoring` (Sprint 8). The `home` query the
 * checklist names lives in its own module (docs/modules/21-home.md), because
 * it reads events and registration and profile may not.
 * `rank` IS here and returns null, which is its documented meaning until the
 * `rating` module fills the rankings board.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { SystemError } from '../../../platform/errors/index.js';
import { events } from '../../events/index.js';
import { EventRef } from '../../events/schema/index.js';
import { sport } from '../../sport/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { profile } from '../index.js';
import type {
  Achievement,
  MatchHistoryRow,
  PlayedWith,
  PlayerSport,
  PublicProfile,
  StatsSnapshot,
  Visibility,
} from '../index.js';

// --- enums -------------------------------------------------------------------

const ProfileVisibility = builder.enumType('ProfileVisibility', {
  description:
    'Who may see contact details and activity. Competitive record is visible ' +
    'regardless: you cannot enter a public draw and hide the outcome (profile R5).',
  values: {
    PUBLIC: { value: 'public' as Visibility },
    PLAYERS_ONLY: { value: 'players_only' as Visibility },
    PRIVATE: { value: 'private' as Visibility },
  },
});

// --- types -------------------------------------------------------------------

const PlayerSportRef = builder.objectRef<PlayerSport>('PlayerSport').implement({
  description:
    'One sport a player has selected. `skillBand` is self-declared and editable; ' +
    '`rating` is derived and read-only to the player (profile R3).',
  fields: (t) => ({
    sport: t.field({ type: SportRef, resolve: (s) => sport.byId(s.sportId) }),
    skillBand: t.exposeString('skillBand'),
    rating: t.float({ nullable: true, resolve: (s) => s.rating }),
    ratingProvisional: t.boolean({ resolve: (s) => s.isProvisional }),
    rank: t.int({
      nullable: true,
      description: 'Null when unranked. Filled by the rating module (Sprint 6).',
      resolve: () => null,
    }),
    matchesPlayed: t.exposeInt('matchesPlayed'),
  }),
});

const AchievementRef = builder.objectRef<Achievement>('Achievement').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    key: t.exposeString('key'),
    sport: t.field({
      type: SportRef,
      nullable: true,
      resolve: (a) => (a.sportId ? sport.byId(a.sportId) : null),
    }),
    eventId: t.id({ nullable: true, resolve: (a) => a.eventId }),
    earnedAt: t.field({ type: 'DateTime', resolve: (a) => a.earnedAt }),
  }),
});

/** profile R8 — materialised on match completion; the Home screen reads it, never aggregates. */
const StatsSnapshotRef = builder.objectRef<StatsSnapshot>('StatsSnapshot').implement({
  description: "profile R8 — one sport's record, materialised on match completion.",
  fields: (t) => ({
    sport: t.field({ type: SportRef, resolve: (s) => sport.byId(s.sportId) }),
    matchesPlayed: t.exposeInt('matchesPlayed'),
    wins: t.exposeInt('wins'),
    losses: t.exposeInt('losses'),
    winRate: t.exposeFloat('winRate', { description: '0-1. Zero when nothing has been played.' }),
    currentStreak: t.exposeInt('currentStreak'),
    tournamentsPlayed: t.exposeInt('tournamentsPlayed'),
    bestFinish: t.exposeString('bestFinish', { nullable: true }),
    updatedAt: t.field({ type: 'DateTime', nullable: true, resolve: (s) => s.updatedAt }),
  }),
});

const MatchHistoryOutcomeEnum = builder.enumType('MatchHistoryOutcome', {
  values: {
    PLAYED: { value: 'played' as MatchHistoryRow['outcome'] },
    WALKOVER: { value: 'walkover' as MatchHistoryRow['outcome'] },
    RETIRED: { value: 'retired' as MatchHistoryRow['outcome'] },
    FORFEIT: { value: 'forfeit' as MatchHistoryRow['outcome'] },
  },
});

const PlayerGameScoreRef = builder
  .objectRef<{ for: number; against: number }>('PlayerGameScore')
  .implement({
    description: "One game (rally) or set, from the profile owner's side.",
    fields: (t) => ({
      for: t.exposeInt('for'),
      against: t.exposeInt('against'),
    }),
  });

/** Opponents and partners are shown as the viewer is allowed to see them (R4). */
const playersAsSeen = async (ids: string[], viewerUserId: string | null) =>
  (await Promise.all(ids.map((id) => profile.publicView(viewerUserId, id)))).filter(
    (p): p is PublicProfile => p !== null,
  );

// Declared before PlayerProfileRef is implemented; its player fields point back at it.
const PlayerProfileRef = builder.objectRef<PublicProfile>('PlayerProfile');

/** One connection type for every paged list of players (search). */
const PlayerConnectionRef = builder.connectionObject(
  { type: PlayerProfileRef, name: 'PlayerConnection' },
  { name: 'PlayerEdge' },
);

const MatchResultSummaryRef = builder.objectRef<MatchHistoryRow>('MatchResultSummary').implement({
  description:
    'profile R12 — one completed match from one player\'s side. Part of the competitive ' +
    'record, so it is visible on every profile (R5).',
  fields: (t) => ({
    matchId: t.exposeID('matchId'),
    sport: t.field({ type: SportRef, resolve: (r) => sport.byId(r.sportId) }),
    event: t.field({
      type: EventRef,
      nullable: true,
      resolve: (r) => (r.eventId ? events.findById(r.eventId) : null),
    }),
    won: t.exposeBoolean('won'),
    outcome: t.field({ type: MatchHistoryOutcomeEnum, resolve: (r) => r.outcome }),
    games: t.field({
      type: [PlayerGameScoreRef],
      description: 'Empty for a walkover.',
      resolve: (r) => r.games,
    }),
    partners: t.field({
      type: [PlayerProfileRef],
      resolve: (r, _args, ctx) => playersAsSeen(r.partnerIds, ctx.actor?.userId ?? null),
    }),
    opponents: t.field({
      type: [PlayerProfileRef],
      resolve: (r, _args, ctx) => playersAsSeen(r.opponentIds, ctx.actor?.userId ?? null),
    }),
    completedAt: t.field({ type: 'DateTime', resolve: (r) => r.completedAt }),
  }),
});

const PlayedWithRef = builder.objectRef<PlayedWith>('PlayedWith').implement({
  description: 'profile R10 — a player shared a completed match with, as partner or opponent.',
  fields: (t) => ({
    player: t.field({ type: PlayerProfileRef, resolve: (r) => r.player }),
    matches: t.exposeInt('matches'),
    lastPlayedAt: t.field({ type: 'DateTime', resolve: (r) => r.lastPlayedAt }),
  }),
});

const AvatarSize = builder.enumType('AvatarSize', {
  description: 'Named Cloudinary transformations (ADR 0003 §C1). Not free-form sizes.',
  values: { sm: {}, md: {}, lg: {} } as const,
});

builder.node(PlayerProfileRef, {
  id: { resolve: (p) => p.id },
  loadOne: (id, ctx) => profile.publicView(ctx.actor?.userId ?? null, id),
  fields: (t) => ({
    id: t.exposeID('id'),
    displayName: t.exposeString('displayName'),
    /**
     * ADR 0003 §C1, §C3 — built at render from a named transformation. Never
     * persisted, and never string-built here.
     */
    avatarUrl: t.string({
      nullable: true,
      args: {
        size: t.arg({ type: AvatarSize, defaultValue: 'md' }),
      },
      resolve: (p, args) =>
        cloudinary.url(
          p.avatarPublicId,
          args.size === 'sm'
            ? TRANSFORMS.avatarSm
            : args.size === 'lg'
              ? TRANSFORMS.avatarLg
              : TRANSFORMS.avatarMd,
        ),
    }),
    /** Null when the viewer may not see it — never an error (profile R4). */
    city: t.string({ nullable: true, resolve: (p) => p.city }),
    bio: t.string({ nullable: true, resolve: (p) => p.bio }),
    detailsVisible: t.boolean({
      description: 'False when city and bio were withheld for this viewer.',
      resolve: (p) => p.detailsVisible,
    }),
    sports: t.field({ type: [PlayerSportRef], resolve: (p) => p.sports }),
    achievements: t.field({ type: [AchievementRef], resolve: (p) => p.achievements }),
    visibility: t.field({ type: ProfileVisibility, resolve: (p) => p.visibility }),
    onboardingPendingSportIds: t.idList({
      description: 'Sports selected but not yet skill-rated. Empty for anyone but the owner.',
      resolve: (p) => p.onboardingPendingSportIds,
    }),
    stats: t.field({
      type: [StatsSnapshotRef],
      description: 'profile R8 — one materialised snapshot per selected sport.',
      resolve: (p) => profile.statsFor(p.id),
    }),
    playedWith: t.field({
      type: [PlayedWithRef],
      description:
        'profile R10 — who this player has played with, most recent first. Empty when the ' +
        'profile details are withheld from the viewer (R4).',
      args: { first: t.arg.int({ defaultValue: 20 }) },
      resolve: (p, args, ctx) =>
        profile.playedWith(p.id, { viewerUserId: ctx.actor?.userId ?? null, first: clampFirst(args.first, 20) }),
    }),
    recentResults: t.field({
      type: [MatchResultSummaryRef],
      description: 'profile R14 — the newest completed matches, every sport.',
      args: { first: t.arg.int({ defaultValue: 5 }) },
      resolve: (p, args) => profile.recentResults(p.id, clampFirst(args.first, 5)),
    }),
    matchHistory: t.connection(
      {
        type: MatchResultSummaryRef,
        description: 'profile R12 — every completed match, newest first. Forward pagination only.',
        args: { sportId: t.arg.id() },
        resolve: async (p, args) => {
          if (args.last != null || args.before != null) {
            throw new SystemError('BAD_USER_INPUT', 'matchHistory supports forward pagination only');
          }
          const page = await profile.matchHistory(p.id, {
            sportId: args.sportId ?? null,
            first: clampFirst(args.first, 20),
            after: args.after ?? null,
          });
          return {
            edges: page.nodes.map((node) => ({ cursor: profile.historyCursor(node), node })),
            pageInfo: {
              hasNextPage: page.hasNextPage,
              hasPreviousPage: args.after != null,
              startCursor: null,
              endCursor: page.endCursor,
            },
          };
        },
      },
      { name: 'MatchHistoryConnection' },
      { name: 'MatchHistoryEdge' },
    ),
  }),
});

// --- payloads ----------------------------------------------------------------

const ProfilePayload = builder
  .objectRef<{ profile: PublicProfile | null; userError: UserErrorShape | null }>(
    'ProfilePayload',
  )
  .implement({
    fields: (t) => ({
      profile: t.field({ type: PlayerProfileRef, nullable: true, resolve: (p) => p.profile }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

interface AvatarUploadShape {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  publicId: string;
  folder: string;
  uploadPreset: string;
  signature: string;
  uploadUrl: string;
  expiresAt: Date;
}

const AvatarUpload = builder.objectRef<AvatarUploadShape>('AvatarUpload').implement({
  description:
    'A short-lived signature for a direct-to-Cloudinary upload (ADR 0003 §C2). ' +
    'Send the resulting public_id back through setAvatar.',
  fields: (t) => ({
    cloudName: t.exposeString('cloudName'),
    apiKey: t.exposeString('apiKey'),
    timestamp: t.exposeInt('timestamp'),
    publicId: t.exposeString('publicId'),
    folder: t.exposeString('folder'),
    uploadPreset: t.exposeString('uploadPreset'),
    signature: t.exposeString('signature'),
    uploadUrl: t.exposeString('uploadUrl'),
    expiresAt: t.field({ type: 'DateTime', resolve: (u) => u.expiresAt }),
  }),
});

const AvatarUploadPayload = builder
  .objectRef<{ upload: AvatarUploadShape | null; userError: UserErrorShape | null }>(
    'AvatarUploadPayload',
  )
  .implement({
    fields: (t) => ({
      upload: t.field({ type: AvatarUpload, nullable: true, resolve: (p) => p.upload }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ------------------------------------------------------------------

const PlayerSportInput = builder.inputType('PlayerSportInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    skillBand: t.string({ required: true }),
  }),
});

const UpdateProfileSportsInput = builder.inputType('UpdateProfileSportsInput', {
  description: 'Replaces the whole selection. An empty list clears it.',
  fields: (t) => ({
    sports: t.field({ type: [PlayerSportInput], required: true }),
  }),
});

const SelectOnboardingSportsInput = builder.inputType('SelectOnboardingSportsInput', {
  fields: (t) => ({
    sportIds: t.idList({ required: true }),
  }),
});

const UpdateProfileDetailsInput = builder.inputType('UpdateProfileDetailsInput', {
  description: 'profile R15 — only the fields present are written. A blank bio clears it.',
  fields: (t) => ({
    displayName: t.string({ description: '2-40 characters.' }),
    bio: t.string({ description: 'At most 160 characters.' }),
  }),
});

const UpdateProfileLocationInput = builder.inputType('UpdateProfileLocationInput', {
  fields: (t) => ({
    city: t.string(),
    lat: t.float(),
    lng: t.float(),
  }),
});

// --- queries -----------------------------------------------------------------

/** Same (display_name, id) key the service pages on (conventions.md §4). */
const cursorFor = (p: PublicProfile): string =>
  Buffer.from(`${p.displayName}|${p.id}`, 'utf8').toString('base64url');

builder.queryFields((t) => ({
  myProfile: t.field({
    type: PlayerProfileRef,
    nullable: true,
    description:
      "The signed-in player's own profile. A fresh install reads it here rather than " +
      'walking the player through onboarding again.',
    resolve: async (_root, _args, ctx) => {
      const actor = requireActor(ctx);
      const own = await profile.findByUserId(actor.userId);
      return own ? profile.publicView(actor.userId, own.id) : null;
    },
  }),

  playerProfile: t.field({
    type: PlayerProfileRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    // profile R4 — a private profile comes back null-filled, not missing and
    // not an error, so the two cases stay indistinguishable.
    resolve: (_root, args, ctx) => profile.publicView(ctx.actor?.userId ?? null, args.id),
  }),

  players: t.connection(
    {
      type: PlayerProfileRef,
      description: 'Player search by display name. Private profiles never appear.',
      args: {
        query: t.arg.string({ required: true }),
        sportId: t.arg.id(),
      },
      resolve: async (_root, args, ctx) => {
        // Relay's connection arguments are all present because the shape is
        // part of the spec, but there is no screen that walks a search result
        // upwards. Saying so beats quietly returning the first page instead.
        if (args.last !== undefined && args.last !== null) {
          throw new SystemError('BAD_USER_INPUT', 'players supports forward pagination only');
        }
        if (args.before !== undefined && args.before !== null) {
          throw new SystemError('BAD_USER_INPUT', 'players supports forward pagination only');
        }
        const first = clampFirst(args.first, 20);
        const page = await profile.search({
          query: args.query,
          sportId: args.sportId ?? null,
          viewerUserId: ctx.actor?.userId ?? null,
          first,
          after: args.after ?? null,
        });
        const edges = page.nodes.map((node) => ({ cursor: cursorFor(node), node }));
        return {
          edges,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after !== undefined && args.after !== null,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: page.endCursor,
          },
        };
      },
    },
    // The doc's name. Without it Pothos derives
    // `QueryPlayersConnection`, and the committed SDL is the client contract
    // (conventions.md §4).
    PlayerConnectionRef,
  ),

  /** home — "Players near you". A shop window, not a browse: a flat list, no paging. */
  recommendedPlayers: t.field({
    type: [PlayerProfileRef],
    args: {
      city: t.arg.string(),
      sportId: t.arg.id(),
      first: t.arg.int({ defaultValue: 10 }),
    },
    resolve: (_root, args, ctx) =>
      profile.recommended({
        city: args.city ?? null,
        sportId: args.sportId ?? null,
        viewerUserId: ctx.actor?.userId ?? null,
        first: args.first ?? 10,
      }),
  }),
}));

// --- mutations ---------------------------------------------------------------

/** Every mutation here answers with the actor's own profile as the viewer sees it. */
async function ownView(userId: string): Promise<PublicProfile | null> {
  const me = await profile.findByUserId(userId);
  return me ? profile.publicView(userId, me.id) : null;
}

builder.mutationFields((t) => ({
  updateProfileSports: t.field({
    type: ProfilePayload,
    args: { input: t.arg({ type: UpdateProfileSportsInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        profile.updateSports(
          actor,
          args.input.sports.map((s) => ({ sportId: s.sportId, skillBand: s.skillBand })),
        ),
      );
      return { profile: await ownView(actor.userId), userError };
    },
  }),

  selectOnboardingSports: t.field({
    type: ProfilePayload,
    args: { input: t.arg({ type: SelectOnboardingSportsInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        profile.selectOnboardingSports(actor, args.input.sportIds),
      );
      return { profile: await ownView(actor.userId), userError };
    },
  }),

  updateProfileLocation: t.field({
    type: ProfilePayload,
    args: { input: t.arg({ type: UpdateProfileLocationInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { lat, lng } = args.input;
      const { userError } = await attempt(() =>
        profile.updateLocation(actor, {
          city: args.input.city ?? null,
          // A half-supplied coordinate is a client bug; treat it as no coordinate.
          geo: lat !== null && lat !== undefined && lng !== null && lng !== undefined
            ? { lat, lng }
            : null,
        }),
      );
      return { profile: await ownView(actor.userId), userError };
    },
  }),

  updateProfileDetails: t.field({
    type: ProfilePayload,
    args: { input: t.arg({ type: UpdateProfileDetailsInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        profile.updateDetails(actor, {
          displayName: args.input.displayName ?? null,
          bio: args.input.bio === undefined ? undefined : args.input.bio,
        }),
      );
      return { profile: await ownView(actor.userId), userError };
    },
  }),

  setProfileVisibility: t.field({
    type: ProfilePayload,
    args: { visibility: t.arg({ type: ProfileVisibility, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        profile.setVisibility(actor, args.visibility),
      );
      return { profile: await ownView(actor.userId), userError };
    },
  }),

  /** profile R6 — the client uploads directly to Cloudinary under this signature. */
  requestAvatarUpload: t.field({
    type: AvatarUploadPayload,
    resolve: async (_root, _args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => profile.avatarUploadSignature(actor));
      return { upload: data, userError };
    },
  }),

  setAvatar: t.field({
    type: ProfilePayload,
    args: { publicId: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => profile.setAvatar(actor, args.publicId));
      return { profile: await ownView(actor.userId), userError };
    },
  }),

}));

/** `rating` renders a leaderboard row as a player card; `home` renders the snapshot. */
export { PlayerProfileRef, StatsSnapshotRef };
