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
import { GameScoreInput, GameScoreRef, MatchSideEnum, ScoringRuleRef } from '../../scoring/schema/index.js';
import { gameCursor, gameResults, games } from '../index.js';
import type { Game, GameComment, GameResult, Tally } from '../index.js';

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
  venueId: 'A listed venue. Leave out to name the place.',
  location: 'games R9 — an optional pin for placeName.',
  placeName: 'games R9 — where the game is, when it is not at a listed venue.',
} as const;

const CreateGameInput = builder.inputType('CreateGameInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    venueId: t.id({ description: placeFields.venueId }),
    location: t.field({ type: GeoPointInput, description: placeFields.location }),
    placeName: t.string({ description: placeFields.placeName }),
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
    placeName: t.string({ description: placeFields.placeName }),
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

// ─── results: the "unranked matches" (games R12–R17) ────────────────────────────────

const GameResultStatusEnum = builder.enumType('GameResultStatus', {
  description:
    'PENDING — waiting for the other side (it confirms itself after an hour). CONFIRMED — it counts. ' +
    'DISPUTED — the other side said it is not right; it counts for nothing.',
  values: {
    PENDING: { value: 'pending' },
    CONFIRMED: { value: 'confirmed' },
    DISPUTED: { value: 'disputed' },
  } as const,
});

const GameResultRef = builder.objectRef<GameResult>('GameResult').implement({
  description:
    'One match played inside a casual game. Unranked: it never moves a rating, a ranking or a badge.',
  fields: (t) => ({
    id: t.exposeID('id'),
    gameId: t.exposeID('gameId'),
    game: t.field({
      type: GameRef,
      nullable: true,
      description: 'The game it was played in: its sport, place and day.',
      resolve: (r) => games.findById(r.gameId),
    }),
    sideA: t.field({
      type: [PlayerProfileRef],
      resolve: async (r, _args, ctx) => present(await ctx.loaders.publicProfileByUser.loadMany(r.sideA)),
    }),
    sideB: t.field({
      type: [PlayerProfileRef],
      resolve: async (r, _args, ctx) => present(await ctx.loaders.publicProfileByUser.loadMany(r.sideB)),
    }),
    games: t.field({
      type: [GameScoreRef],
      description: 'Games, sets, frames, or one final score, as the sport is scored. `a` is side A.',
      resolve: (r) => r.games,
    }),
    winner: t.field({ type: MatchSideEnum, nullable: true, description: 'Null is a draw.', resolve: (r) => r.winner }),
    method: t.exposeString('method', { nullable: true, description: 'How a bout ended early (ko, tko…).' }),
    status: t.field({ type: GameResultStatusEnum, resolve: (r) => r.status }),
    enteredBy: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (r, _args, ctx) => ctx.loaders.publicProfileByUser.load(r.enteredBy),
    }),
    autoConfirmAt: t.field({
      type: 'DateTime',
      description: 'games R15 — when an unanswered result confirms itself.',
      resolve: (r) => r.autoConfirmAt,
    }),
    playedAt: t.field({ type: 'DateTime', resolve: (r) => r.playedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    viewerSide: t.field({
      type: MatchSideEnum,
      nullable: true,
      description: 'The side the viewer played on; null when they were not in this match.',
      resolve: (r, _args, ctx) => gameResults.viewerCan(r, ctx.actor?.userId ?? null).side,
    }),
    viewerCanConfirm: t.boolean({
      description: 'The viewer is on the side that did not enter it, and it is still waiting.',
      resolve: (r, _args, ctx) => gameResults.viewerCan(r, ctx.actor?.userId ?? null).confirm,
    }),
    viewerCanRemove: t.boolean({
      description: 'The viewer entered it and nobody has confirmed it.',
      resolve: (r, _args, ctx) => gameResults.viewerCan(r, ctx.actor?.userId ?? null).remove,
    }),
  }),
});

builder.objectFields(GameRef, (t) => ({
  results: t.field({
    type: [GameResultRef],
    description:
      'Confirmed results for anyone; unanswered and disputed ones only for the players in that match. Oldest first.',
    resolve: (g, _args, ctx) => gameResults.forGame(g.id, ctx.actor?.userId ?? null),
  }),
  resultsOpenAt: t.field({
    type: 'DateTime',
    description: 'games R12 — results can be entered from an hour after the start.',
    resolve: (g) => gameResults.windowOf(g).opensAt,
  }),
  viewerCanAddResult: t.boolean({
    description: 'The viewer joined, the results window is open, and this sport is played as matches.',
    resolve: (g, _args, ctx) => gameResults.canAdd(g, ctx.actor?.userId ?? null),
  }),
  scoringRule: t.field({
    type: ScoringRuleRef,
    nullable: true,
    description:
      'games R14 — how this sport is scored, so the result form can speak it (games to 11, sets, goals…). ' +
      'Null when the sport has no rule.',
    resolve: async (g) => {
      const rule = await sport.scoringRuleFor(g.sportId).catch(() => null);
      return rule ? { kind: rule.kind, definition: JSON.stringify(rule) } : null;
    },
  }),
}));

const TallyRef = builder.objectRef<Tally>('UnrankedTally').implement({
  description: 'games R16 — across every confirmed unranked result. Separate from the ranked record.',
  fields: (t) => ({
    played: t.exposeInt('played'),
    won: t.exposeInt('won'),
    lost: t.exposeInt('lost'),
    drawn: t.exposeInt('drawn'),
  }),
});

/** A profile is a player id; results are stored by user id. */
async function userIdOf(playerId: string): Promise<string | null> {
  return (await profile.briefById(playerId))?.userId ?? null;
}

builder.objectFields(PlayerProfileRef, (t) => ({
  unrankedResults: t.field({
    type: [GameResultRef],
    description: 'games R16 — confirmed results of casual games this player was in, newest game first.',
    args: { first: t.arg.int({ defaultValue: 10 }) },
    resolve: async (p, args) => {
      const userId = await userIdOf(p.id);
      return userId ? gameResults.forUser(userId, { first: args.first ?? 10 }) : [];
    },
  }),
  unrankedTally: t.field({
    type: TallyRef,
    resolve: async (p) => {
      const userId = await userIdOf(p.id);
      return userId ? gameResults.tallyFor(userId) : { played: 0, won: 0, lost: 0, drawn: 0 };
    },
  }),
}));

const GameResultPayload = builder
  .objectRef<{ result: GameResult | null; game: Game | null; userError: UserErrorShape | null }>('GameResultPayload')
  .implement({
    fields: (t) => ({
      result: t.field({ type: GameResultRef, nullable: true, resolve: (p) => p.result }),
      game: t.field({ type: GameRef, nullable: true, description: 'The game, with its results as they now stand.', resolve: (p) => p.game }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const AddGameResultInput = builder.inputType('AddGameResultInput', {
  description:
    'games R13, R14 — sides are joined players (player ids) and whoever enters it must be on one. ' +
    'The score is held to the sport’s rule; a casual match may be shorter than the full format, or level.',
  fields: (t) => ({
    gameId: t.id({ required: true }),
    sideA: t.idList({ required: true }),
    sideB: t.idList({ required: true }),
    games: t.field({ type: [GameScoreInput], required: true }),
    finish: t.string({ description: 'A bout that ended early: one of the rule’s finishes. Needs `winner`.' }),
    winner: t.field({ type: MatchSideEnum }),
  }),
});

builder.mutationFields((t) => ({
  addGameResult: t.field({
    type: GameResultPayload,
    description:
      'Enters one match of a casual game. The other side is asked to confirm; unanswered, it confirms itself after an hour. ' +
      'RESULTS_NOT_OPEN, RESULTS_CLOSED, RESULTS_NOT_SUPPORTED, INVALID_RESULT.',
    args: { input: t.arg({ type: AddGameResultInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const i = args.input;
      const gameId = String(i.gameId);
      const [sideA, sideB] = await Promise.all([userIdsOf(i.sideA.map(String)), userIdsOf(i.sideB.map(String))]);
      const { data, userError } = await attempt(() =>
        gameResults.add(actor, {
          gameId,
          sideA,
          sideB,
          games: i.games.map((g) => ({ a: g.a, b: g.b })),
          finish: i.finish ?? null,
          winner: i.winner ?? null,
        }),
      );
      return { result: data, game: data ? await games.findById(gameId) : null, userError };
    },
  }),

  confirmGameResult: t.field({
    type: GameResultPayload,
    description: 'games R15 — a player on the side that did not enter it says it is right.',
    args: { resultId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => gameResults.confirm(actor, String(args.resultId)));
      return { result: data, game: data ? await games.findById(data.gameId) : null, userError };
    },
  }),

  disputeGameResult: t.field({
    type: GameResultPayload,
    description: 'games R15 — "not right": the result counts for nothing and whoever entered it is told.',
    args: { resultId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => gameResults.dispute(actor, String(args.resultId)));
      return { result: data, game: data ? await games.findById(data.gameId) : null, userError };
    },
  }),

  removeGameResult: t.field({
    type: GamePayload,
    description: 'Whoever entered a result takes it back, while nobody has confirmed it.',
    args: { gameId: t.arg.id({ required: true }), resultId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => gameResults.remove(actor, String(args.resultId)));
      return { game: await games.findById(String(args.gameId)), userError };
    },
  }),
}));

export { GameRef };
