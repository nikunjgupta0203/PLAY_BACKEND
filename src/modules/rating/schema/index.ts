/**
 * rating — GraphQL surface (docs/modules/08-rating.md).
 *
 * The doc writes the scope argument as `union RankingScope = National | City |
 * AgeBand`. GraphQL has no input unions, and `scope` is an ARGUMENT, so it
 * arrives here as a one-of input object: a `kind` enum plus the value that kind
 * needs. The vocabulary is still closed, which is what R10 is actually about —
 * an open-ended scope string is an unbounded table.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { requireActor } from '../../../graphql/userError.js';
import { UserError } from '../../../platform/errors/index.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { profile } from '../../profile/index.js';
import { rating } from '../index.js';
import type { PlayerRating, RankingRow, RankingScope, RatingEvent, Standing } from '../index.js';

// --- scope (R10) -------------------------------------------------------------

const RankingScopeKind = builder.enumType('RankingScopeKind', {
  description:
    'rating R10 — the ranking scopes that exist. Enumerated, not arbitrary: an ' +
    'open-ended scope string is an unbounded table.',
  values: { NATIONAL: {}, CITY: {}, AGE_BAND: {} } as const,
});

const RankingScopeInput = builder.inputType('RankingScopeInput', {
  description: 'NATIONAL takes no value; CITY and AGE_BAND require one.',
  fields: (t) => ({
    kind: t.field({ type: RankingScopeKind, required: true }),
    value: t.string({ required: false }),
  }),
});

function toScope(input: { kind: 'NATIONAL' | 'CITY' | 'AGE_BAND'; value?: string | null }): RankingScope {
  if (input.kind === 'NATIONAL') return { kind: 'national' };
  const value = input.value?.trim();
  if (!value) {
    throw new UserError('INVALID_SCOPE', `A ${input.kind} ranking needs a value.`);
  }
  return input.kind === 'CITY' ? { kind: 'city', value } : { kind: 'age', value };
}

// --- types -------------------------------------------------------------------

const RankingRowRef = builder.objectRef<RankingRow>('RankingRow').implement({
  description:
    'One place on a leaderboard. `rank` is dense — two players on the same ' +
    'rating share a place — and `movement` is stored rather than computed, so ' +
    'the up/down arrow costs no second query (rating R11).',
  fields: (t) => ({
    rank: t.exposeInt('rank'),
    player: t.field({
      type: PlayerProfileRef,
      nullable: true,
      // Speed — a leaderboard page's players in one batch, not one read per row.
      resolve: (row, _args, ctx) => ctx.loaders.publicProfile.load(row.playerId),
    }),
    rating: t.float({ resolve: (r) => r.rating }),
    matchesPlayed: t.exposeInt('matchesPlayed'),
    movement: t.int({
      description: 'Places gained since the previous rebuild. +3 is up three.',
      resolve: (r) => r.movement,
    }),
  }),
});

const NextPlaceRef = builder
  .objectRef<{ rank: number; rating: number }>('NextPlace')
  .implement({
    description: 'The place directly above yours on a board.',
    fields: (t) => ({
      rank: t.exposeInt('rank'),
      rating: t.float({ resolve: (r) => r.rating }),
    }),
  });

const MyRankingRef = builder.objectRef<Standing>('MyRanking').implement({
  description:
    'Where the viewer stands on one board (rating R9, R11). Read from Postgres, ' +
    'never the board cache, so it is right the moment a rebuild lands.',
  fields: (t) => ({
    row: t.field({
      type: RankingRowRef,
      nullable: true,
      description: 'Null when unranked on this board (fewer than five settled matches, or another city).',
      resolve: (s) => s.row,
    }),
    next: t.field({
      type: NextPlaceRef,
      nullable: true,
      description: 'The place above; null at the top or when unranked.',
      resolve: (s) => s.next,
    }),
    updatedAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'When the board was last rebuilt (rating R4 — weekly).',
      resolve: (s) => s.updatedAt,
    }),
  }),
});

const PlayerRatingRef = builder.objectRef<PlayerRating>('PlayerRating').implement({
  description:
    'rating R2 — the SETTLED rating, and whether it is fit to show. `provisional` ' +
    'is true below five settled matches, and the app renders *unranked* rather ' +
    'than a number nobody should act on (R9).',
  fields: (t) => ({
    sportId: t.exposeID('sportId'),
    rating: t.float({ resolve: (r) => r.rating }),
    deviation: t.float({
      description: 'Glicko-2 RD. It grows while a player is away (rating R1).',
      resolve: (r) => r.rd,
    }),
    matchesPlayed: t.exposeInt('matchesPlayed'),
    provisional: t.exposeBoolean('provisional'),
  }),
});

const RatingEventRef = builder.objectRef<RatingEvent>('RatingEvent').implement({
  description:
    'One row of the append-only log. A provisional row is the number a player ' +
    'was shown the moment their result was confirmed; the weekly period writes ' +
    'the settled row that supersedes it, and both stay (rating R3).',
  fields: (t) => ({
    id: t.id({ resolve: (e) => e.id.toString() }),
    matchId: t.id({ nullable: true, resolve: (e) => e.matchId }),
    ratingBefore: t.float({ resolve: (e) => e.ratingBefore }),
    ratingAfter: t.float({ resolve: (e) => e.ratingAfter }),
    deviationAfter: t.float({ resolve: (e) => e.rdAfter }),
    isProvisional: t.exposeBoolean('isProvisional'),
    algoVersion: t.exposeString('algoVersion'),
    at: t.field({ type: 'DateTime', resolve: (e) => e.createdAt }),
  }),
});

const SportRankRef = builder
  .objectRef<{ sportId: string; rank: number }>('SportRank')
  .implement({
    description: "One sport's place on the national board.",
    fields: (t) => ({
      sportId: t.exposeID('sportId'),
      rank: t.exposeInt('rank'),
    }),
  });

/**
 * A profile's national places, one per ranked sport. Boards are public, so
 * this is shown on anyone's profile, never gated by visibility (profile R6).
 */
builder.objectField(PlayerProfileRef, 'nationalRanks', (t) =>
  t.field({
    type: [SportRankRef],
    description: 'National rank per sport. Sports the player is unranked in are left out.',
    resolve: async (p) => {
      const rows = await Promise.all(
        p.sports.map(async (s) => ({
          sportId: s.sportId,
          rank: await rating.rankFor(s.sportId, { kind: 'national' }, p.id),
        })),
      );
      return rows.filter((r): r is { sportId: string; rank: number } => r.rank !== null);
    },
  }),
);

// --- queries -----------------------------------------------------------------

builder.queryFields((t) => ({
  rankings: t.connection(
    {
      type: RankingRowRef,
      description:
        'A leaderboard. Only settled ratings with five or more matches appear ' +
        '(rating R9), and the first page of every board is served from cache.',
      args: {
        sportId: t.arg.id({ required: true }),
        scope: t.arg({ type: RankingScopeInput, required: true }),
      },
      resolve: async (_root, args) => {
        if (args.last || args.before) {
          throw new UserError('UNSUPPORTED_PAGINATION', 'rankings paginate forward only.');
        }
        const page = await rating.leaderboard(args.sportId.toString(), toScope(args.scope), {
          first: clampFirst(args.first, 50),
          after: args.after ?? null,
        });
        return {
          edges: page.nodes.map((node) => ({ cursor: node.rank.toString(), node })),
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: false,
            startCursor: page.nodes[0]?.rank.toString() ?? null,
            endCursor: page.endCursor,
          },
        };
      },
    },
    {},
    {},
  ),

  myRanking: t.field({
    type: MyRankingRef,
    description: 'Your own place on one board, and when that board was last rebuilt.',
    args: {
      sportId: t.arg.id({ required: true }),
      scope: t.arg({ type: RankingScopeInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const me = await profile.byUserId(actor.userId);
      return rating.myStanding(args.sportId.toString(), toScope(args.scope), me.id);
    },
  }),

  playerRating: t.field({
    type: PlayerRatingRef,
    description: 'The settled rating for one player in one sport.',
    args: { playerId: t.arg.id({ required: true }), sportId: t.arg.id({ required: true }) },
    resolve: (_root, args) =>
      rating.ratingFor(args.playerId.toString(), args.sportId.toString()),
  }),

  ratingHistory: t.connection(
    {
      type: RatingEventRef,
      description: 'Your own rating log, newest first. Provisional rows included.',
      args: { sportId: t.arg.id({ required: true }) },
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        const me = await profile.byUserId(actor.userId);
        if (args.last || args.before) {
          throw new UserError('UNSUPPORTED_PAGINATION', 'ratingHistory paginates forward only.');
        }
        const page = await rating.historyFor(me.id, args.sportId.toString(), {
          first: clampFirst(args.first, 20),
          after: args.after ?? null,
        });
        return {
          edges: page.nodes.map((node) => ({ cursor: node.id.toString(), node })),
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: false,
            startCursor: page.nodes[0]?.id.toString() ?? null,
            endCursor: page.endCursor,
          },
        };
      },
    },
    {},
    {},
  ),
}));

export { PlayerRatingRef, RankingRowRef, RatingEventRef };
