/**
 * games — GraphQL (docs/modules/12-games.md, "Create Game Flow v2").
 *
 * Everyone signed in sees a game's sport, time, place, host and player count.
 * The host's number and the thread are for joined players only (R8); the
 * invited list is for the host.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { GeoPointInput, GeoPointRef } from '../../../graphql/geo.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { SystemError } from '../../../platform/errors/index.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { profile } from '../../profile/index.js';
import type { PublicProfile } from '../../profile/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { sport } from '../../sport/index.js';
import { VenueRef } from '../../venues/schema/index.js';
import { gameCursor, games } from '../index.js';
import type { Game, GameComment } from '../index.js';

const GameStatusEnum = builder.enumType('GameStatus', {
  description: 'OPEN — places left. FULL — every place taken. COMPLETED — its end time has passed, or the host marked it played.',
  values: {
    OPEN: { value: 'open' },
    FULL: { value: 'full' },
    CANCELLED: { value: 'cancelled' },
    COMPLETED: { value: 'completed' },
  } as const,
});

const present = (rows: (PublicProfile | null | Error)[]): PublicProfile[] =>
  rows.filter((r): r is PublicProfile => r !== null && !(r instanceof Error));

const GameCommentRef = builder.objectRef<GameComment>('GameComment').implement({
  description: 'games R8 — one line in the joined players’ thread. Plain text.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    createdAt: t.field({ type: 'DateTime', resolve: (c) => c.createdAt }),
    author: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (c, _args, ctx) => ctx.loaders.publicProfileByUser.load(c.userId),
    }),
    mine: t.boolean({ resolve: (c, _args, ctx) => ctx.actor?.userId === c.userId }),
  }),
});

const GameRef = builder.objectRef<Game>('Game').implement({
  description: 'A casual game: no fee, no bracket, no rating. Separate from events.',
  fields: (t) => ({
    id: t.exposeID('id'),
    sport: t.field({ type: SportRef, resolve: (g) => sport.byId(g.sportId) }),
    venue: t.field({
      type: VenueRef,
      nullable: true,
      resolve: (g, _args, ctx) => (g.venueId ? ctx.loaders.venue.load(g.venueId) : null),
    }),
    placeName: t.string({
      description: 'The venue’s name, or the name the host gave the pin.',
      resolve: async (g, _args, ctx) =>
        (g.venueId ? (await ctx.loaders.venue.load(g.venueId))?.name : g.placeName) ?? g.city,
    }),
    city: t.exposeString('city'),
    location: t.field({
      type: GeoPointRef,
      nullable: true,
      description: 'The venue’s point, or the host’s pin.',
      resolve: async (g, _args, ctx) =>
        g.location ?? (g.venueId ? ((await ctx.loaders.venue.load(g.venueId))?.location ?? null) : null),
    }),
    startsAt: t.field({ type: 'DateTime', resolve: (g) => g.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (g) => g.endsAt }),
    timezone: t.exposeString('timezone'),
    maxPlayers: t.exposeInt('maxPlayers'),
    minPlayers: t.exposeInt('minPlayers', { nullable: true }),
    playerCount: t.int({ resolve: (g) => g.playerUserIds.length }),
    spotsLeft: t.int({ resolve: (g) => Math.max(g.maxPlayers - g.playerUserIds.length, 0) }),
    gameOn: t.boolean({
      description: 'True once a minimum was set and reached.',
      resolve: (g) => g.minPlayers !== null && g.playerUserIds.length >= g.minPlayers,
    }),
    skillBand: t.exposeString('skillBand', { nullable: true }),
    notes: t.exposeString('notes', { nullable: true }),
    status: t.field({ type: GameStatusEnum, resolve: (g) => g.status }),
    cancelReason: t.exposeString('cancelReason', { nullable: true }),
    distanceKm: t.float({ nullable: true, description: 'Set when the search had a map centre.', resolve: (g) => g.distanceKm }),
    host: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (g, _args, ctx) => ctx.loaders.publicProfileByUser.load(g.hostUserId),
    }),
    players: t.field({
      type: [PlayerProfileRef],
      description: 'Joined players, the host first.',
      resolve: async (g, _args, ctx) => present(await ctx.loaders.publicProfileByUser.loadMany(g.playerUserIds)),
    }),
    viewerIsHost: t.boolean({ resolve: (g, _args, ctx) => ctx.actor?.userId === g.hostUserId }),
    viewerHasJoined: t.boolean({
      resolve: (g, _args, ctx) => (ctx.actor ? g.playerUserIds.includes(ctx.actor.userId) : false),
    }),
    viewerIsInvited: t.boolean({
      resolve: (g, _args, ctx) => (ctx.actor ? games.isInvited(g.id, ctx.actor.userId) : false),
    }),
    hostPhone: t.string({
      nullable: true,
      description: 'games R8 — the host’s contact number, for joined players only. Null when the host gave none.',
      resolve: (g, _args, ctx) => games.hostPhone(g, ctx.actor?.userId ?? null),
    }),
    comments: t.field({
      type: [GameCommentRef],
      description: 'games R8 — the thread, oldest first. Empty for anyone who has not joined.',
      resolve: (g, _args, ctx) => games.comments(ctx.actor, g.id),
    }),
    invited: t.field({
      type: [PlayerProfileRef],
      description: 'Players the host invited who have not joined yet. Empty for everyone but the host.',
      resolve: async (g, _args, ctx) => {
        if (ctx.actor?.userId !== g.hostUserId) return [];
        return present(await ctx.loaders.publicProfileByUser.loadMany(await games.invitedUserIds(g.id)));
      },
    }),
  }),
});

// --- payloads ------------------------------------------------------------------

const GamePayload = builder
  .objectRef<{ game: Game | null; userError: UserErrorShape | null }>('GamePayload')
  .implement({
    fields: (t) => ({
      game: t.field({ type: GameRef, nullable: true, resolve: (p) => p.game }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const InviteToGamePayload = builder
  .objectRef<{ game: Game | null; invitedCount: number; userError: UserErrorShape | null }>('InviteToGamePayload')
  .implement({
    fields: (t) => ({
      game: t.field({ type: GameRef, nullable: true, resolve: (p) => p.game }),
      invitedCount: t.exposeInt('invitedCount', {
        description: 'How many were invited now. Players already in, already invited or removed are skipped.',
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const GameCommentPayload = builder
  .objectRef<{ comment: GameComment | null; userError: UserErrorShape | null }>('GameCommentPayload')
  .implement({
    fields: (t) => ({
      comment: t.field({ type: GameCommentRef, nullable: true, resolve: (p) => p.comment }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PlayerByPhonePayload = builder
  .objectRef<{ player: PublicProfile | null; userError: UserErrorShape | null }>('PlayerByPhonePayload')
  .implement({
    fields: (t) => ({
      player: t.field({
        type: PlayerProfileRef,
        nullable: true,
        description: 'Null when nobody on PL4Y gave that number: invite them with a link instead.',
        resolve: (p) => p.player,
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ----------------------------------------------------------------------

const placeFields = {
  venueId: 'A listed venue. Leave out to use a pin.',
  location: 'games R9 — the pin, when the game is not at a listed venue. Needs placeName.',
} as const;

const CreateGameInput = builder.inputType('CreateGameInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    venueId: t.id({ description: placeFields.venueId }),
    location: t.field({ type: GeoPointInput, description: placeFields.location }),
    placeName: t.string(),
    city: t.string(),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', required: true }),
    maxPlayers: t.int({ required: true }),
    minPlayers: t.int(),
    skillBand: t.string(),
    notes: t.string(),
    inviteUserIds: t.idList({ description: 'Players to invite as the game is published. Player ids.' }),
  }),
});

const UpdateGameInput = builder.inputType('UpdateGameInput', {
  description: 'Only what is given changes. A new time or place is told to every joined player (games R7).',
  fields: (t) => ({
    gameId: t.id({ required: true }),
    sportId: t.id(),
    venueId: t.id({ description: placeFields.venueId }),
    location: t.field({ type: GeoPointInput, description: placeFields.location }),
    placeName: t.string(),
    city: t.string(),
    startsAt: t.field({ type: 'DateTime' }),
    endsAt: t.field({ type: 'DateTime' }),
    maxPlayers: t.int(),
    minPlayers: t.int({ description: 'Null clears the minimum.' }),
    skillBand: t.string({ description: 'Null clears it.' }),
    notes: t.string({ description: 'Null clears them.' }),
  }),
});

/** Player ids (what the app holds) → user ids (what a game stores). Unknown ids are dropped. */
async function userIdsOf(playerIds: readonly string[]): Promise<string[]> {
  const briefs = await Promise.all(playerIds.map((id) => profile.briefById(String(id))));
  return briefs.flatMap((b) => (b ? [b.userId] : []));
}

// --- queries -----------------------------------------------------------------------

builder.queryFields((t) => ({
  game: t.field({
    type: GameRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => {
      requireActor(ctx);
      return games.findById(String(args.id));
    },
  }),

  games: t.connection(
    {
      type: GameRef,
      description:
        'Discover Games: open and full games that have not ended, soonest first. Filters: sport, dates, distance (capped at 50 km).',
      args: {
        sportId: t.arg.id(),
        from: t.arg({ type: 'DateTime' }),
        to: t.arg({ type: 'DateTime', description: 'Exclusive.' }),
        near: t.arg({ type: GeoPointInput }),
        radiusKm: t.arg.float(),
      },
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'games supports forward pagination only');
        }
        const { data, userError } = await attempt(() =>
          games.search(
            {
              sportId: args.sportId ? String(args.sportId) : null,
              from: args.from ?? null,
              to: args.to ?? null,
              near: args.near ? { lat: args.near.lat, lng: args.near.lng } : null,
              radiusKm: args.radiusKm ?? null,
              viewerUserId: actor.userId,
            },
            { first: clampFirst(args.first, 20), after: args.after ?? null },
          ),
        );
        if (!data) throw new SystemError('BAD_USER_INPUT', userError?.message ?? 'Invalid search');
        const edges = data.nodes.map((node) => ({ cursor: gameCursor(node), node }));
        return {
          edges,
          pageInfo: {
            hasNextPage: data.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: data.endCursor,
          },
        };
      },
    },
    { name: 'GameConnection' },
    { name: 'GameEdge' },
  ),

  myGames: t.field({
    type: [GameRef],
    description: 'My Games: games the viewer hosts, has joined or is invited to (last 90 days on), newest start first.',
    resolve: (_root, _args, ctx) => games.listForUser(requireActor(ctx).userId),
  }),

  myNextGame: t.field({
    type: GameRef,
    nullable: true,
    description: 'Home’s "Next up": the viewer’s next game that has not ended.',
    resolve: (_root, _args, ctx) => (ctx.actor ? games.nextForUser(ctx.actor.userId) : null),
  }),

  playerByPhone: t.field({
    type: PlayerByPhonePayload,
    description:
      'The invite screen’s "is this number on PL4Y?". Matches the contact number a player gave. Rate limited (LOOKUP_LIMIT).',
    args: { phone: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => games.lookupByPhone(actor, args.phone));
      if (!data) return { player: null, userError };
      const found = await ctx.loaders.publicProfileByUser.load(data.userId);
      // A private profile is not distinguishable from nobody (profile R4).
      return { player: found && found.visibility !== 'private' ? found : null, userError: null };
    },
  }),
}));

// --- mutations -----------------------------------------------------------------------

builder.mutationFields((t) => ({
  createGame: t.field({
    type: GamePayload,
    description: 'Publishes a casual game at once. The host is its first player (games R1).',
    args: { input: t.arg({ type: CreateGameInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const i = args.input;
      const inviteUserIds = i.inviteUserIds ? await userIdsOf(i.inviteUserIds.map(String)) : [];
      const { data, userError } = await attempt(() =>
        games.create(
          actor,
          {
            sportId: String(i.sportId),
            venueId: i.venueId ? String(i.venueId) : null,
            location: i.location ? { lat: i.location.lat, lng: i.location.lng } : null,
            placeName: i.placeName ?? null,
            city: i.city ?? null,
            startsAt: i.startsAt,
            endsAt: i.endsAt,
            maxPlayers: i.maxPlayers,
            minPlayers: i.minPlayers ?? null,
            skillBand: i.skillBand ?? null,
            notes: i.notes ?? null,
          },
          { inviteUserIds },
        ),
      );
      return { game: data, userError };
    },
  }),

  updateGame: t.field({
    type: GamePayload,
    description: 'Host only. A new time or place notifies every joined player (games R7).',
    args: { input: t.arg({ type: UpdateGameInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        games.update(actor, String(i.gameId), {
          ...(i.sportId ? { sportId: String(i.sportId) } : {}),
          ...(i.venueId !== undefined ? { venueId: i.venueId ? String(i.venueId) : null } : {}),
          ...(i.location ? { location: { lat: i.location.lat, lng: i.location.lng } } : {}),
          ...(i.placeName != null ? { placeName: i.placeName } : {}),
          ...(i.city != null ? { city: i.city } : {}),
          ...(i.startsAt ? { startsAt: i.startsAt } : {}),
          ...(i.endsAt ? { endsAt: i.endsAt } : {}),
          ...(i.maxPlayers != null ? { maxPlayers: i.maxPlayers } : {}),
          ...(i.minPlayers !== undefined ? { minPlayers: i.minPlayers } : {}),
          ...(i.skillBand !== undefined ? { skillBand: i.skillBand } : {}),
          ...(i.notes !== undefined ? { notes: i.notes } : {}),
        }),
      );
      return { game: data, userError };
    },
  }),

  joinGame: t.field({
    type: GamePayload,
    description: 'Automatic while a place is free: no approval. GAME_FULL, GAME_CLOSED, GAME_REMOVED, ALREADY_JOINED.',
    args: { gameId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => games.join(actor, String(args.gameId)));
      return { game: data, userError };
    },
  }),

  leaveGame: t.field({
    type: GamePayload,
    description: 'A full game is open again. The host cannot leave: HOST_CANNOT_LEAVE — cancel instead.',
    args: { gameId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => games.leave(actor, String(args.gameId)));
      return { game: data, userError };
    },
  }),

  removeGamePlayer: t.field({
    type: GamePayload,
    description: 'Host only. The removed player cannot rejoin (games R5).',
    args: { gameId: t.arg.id({ required: true }), playerId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const [userId] = await userIdsOf([String(args.playerId)]);
      const { data, userError } = await attempt(() => games.removePlayer(actor, String(args.gameId), userId ?? ''));
      return { game: data, userError };
    },
  }),

  cancelGame: t.field({
    type: GamePayload,
    description: 'Host only. Every joined player is told.',
    args: { gameId: t.arg.id({ required: true }), reason: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => games.cancel(actor, String(args.gameId), args.reason ?? null));
      return { game: data, userError };
    },
  }),

  completeGame: t.field({
    type: GamePayload,
    description: 'Host only, once the game has started. A game also completes by itself when its end time passes.',
    args: { gameId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => games.complete(actor, String(args.gameId)));
      return { game: data, userError };
    },
  }),

  inviteToGame: t.field({
    type: InviteToGamePayload,
    description: 'Host only. Each invited player gets a notification that opens the game.',
    args: { gameId: t.arg.id({ required: true }), playerIds: t.arg.idList({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const gameId = String(args.gameId);
      const userIds = await userIdsOf(args.playerIds.map(String));
      const { data, userError } = await attempt(() => games.invite(actor, gameId, userIds));
      return { game: data ? await games.findById(gameId) : null, invitedCount: data?.invited.length ?? 0, userError };
    },
  }),

  addGameComment: t.field({
    type: GameCommentPayload,
    description: 'games R8 — joined players only.',
    args: { gameId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => games.addComment(actor, String(args.gameId), args.body));
      return { comment: data, userError };
    },
  }),
}));

export { GameRef };
