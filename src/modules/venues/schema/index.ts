/**
 * venues — GraphQL surface (docs/modules/04-venues.md).
 *
 * Resolvers never touch Prisma (conventions.md §1): they call the service and
 * shape the result. `Venue` is not a Node type — conventions.md §4 fixes the
 * Node list at Event, Match, PlayerProfile and Game, and a venue is a place you
 * find through an event rather than a deep-link target of its own.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { GeoPointInput, GeoPointRef } from '../../../graphql/geo.js';
import { requirePlatformStaff, requireReason } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { recordAudit } from '../../../platform/audit.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { db } from '../../../platform/db.js';
import { SystemError, UserError } from '../../../platform/errors/index.js';
import { identity } from '../../identity/index.js';
import { profile } from '../../profile/index.js';
import { sport } from '../../sport/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { venues } from '../index.js';
import type { Court, CourtKind, OpeningHours, Venue, VenueReview } from '../index.js';

// --- types -------------------------------------------------------------------

const PlayingAreaKind = builder.enumType('PlayingAreaKind', {
  description: 'venues R10 — what a playing area is called: a court, a turf, a table…',
  values: {
    COURT: { value: 'court' as CourtKind },
    TURF: { value: 'turf' as CourtKind },
    GROUND: { value: 'ground' as CourtKind },
    PITCH: { value: 'pitch' as CourtKind },
    TABLE: { value: 'table' as CourtKind },
  },
});

const OpeningHoursRef = builder.objectRef<OpeningHours>('OpeningHours').implement({
  description:
    'venues R12 — one opening window in the venue’s local time. A day with two sessions ' +
    'has two windows; a day with none is closed.',
  fields: (t) => ({
    day: t.exposeInt('day', { description: '0 is Monday, 6 is Sunday.' }),
    opens: t.exposeString('opens', { description: 'HH:MM' }),
    closes: t.exposeString('closes', { description: 'HH:MM' }),
  }),
});

interface ReviewAuthor {
  id: string;
  displayName: string;
  avatarPublicId: string | null;
}

const VenueReviewAuthorRef = builder.objectRef<ReviewAuthor>('VenueReviewAuthor').implement({
  description: 'The reviewer, by player profile id — open it with `playerProfile(id:)`.',
  fields: (t) => ({
    id: t.exposeID('id'),
    displayName: t.exposeString('displayName'),
    avatarUrl: t.string({
      nullable: true,
      resolve: (a) => cloudinary.url(a.avatarPublicId, TRANSFORMS.avatarSm),
    }),
  }),
});

const VenueReviewRef = builder.objectRef<VenueReview>('VenueReview').implement({
  description: 'venues R6–R8 — one player’s review of a venue they played at.',
  fields: (t) => ({
    id: t.exposeID('id'),
    stars: t.exposeInt('stars'),
    body: t.string({ nullable: true, resolve: (r) => r.body }),
    author: t.field({
      type: VenueReviewAuthorRef,
      nullable: true,
      resolve: async (r) => {
        const p = await profile.findByUserId(r.userId);
        return p ? { id: p.id, displayName: p.displayName, avatarPublicId: p.avatarPublicId } : null;
      },
    }),
    reply: t.string({
      nullable: true,
      description: 'R8 — the venue’s one public answer.',
      resolve: (r) => r.replyBody,
    }),
    repliedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.repliedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (r) => r.updatedAt }),
  }),
});

const VenueReviewConnectionRef = builder.connectionObject(
  { type: VenueReviewRef, name: 'VenueReviewConnection' },
  { name: 'VenueReviewEdge' },
);

const CourtRef = builder.objectRef<Court>('Court').implement({
  description:
    'One playing surface. A court belongs to exactly one venue and may serve ' +
    'several sports (venues R2).',
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name', { description: '"Court 3"' }),
    surface: t.string({ nullable: true, resolve: (c) => c.surface }),
    indoor: t.exposeBoolean('indoor'),
    kind: t.field({ type: PlayingAreaKind, resolve: (c) => c.kind }),
    active: t.exposeBoolean('active'),
    sports: t.field({
      type: [SportRef],
      resolve: (c) => Promise.all(c.sportIds.map((id) => sport.byId(id))),
    }),
  }),
});

const VenueRef = builder.objectRef<Venue>('Venue').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    address: t.exposeString('address'),
    city: t.exposeString('city'),
    location: t.field({ type: GeoPointRef, resolve: (v) => v.location }),
    amenities: t.stringList({ resolve: (v) => v.amenities }),
    courts: t.field({ type: [CourtRef], resolve: (v) => venues.courtsFor(v.id) }),
    sports: t.field({
      type: [SportRef],
      description: 'The union over this venue’s active courts.',
      resolve: async (v) => {
        const ids = await venues.sportsAt(v.id);
        return Promise.all(ids.map((id) => sport.byId(id)));
      },
    }),
    /** ADR 0003 §C1 — built at render from a named transformation, never stored. */
    photoUrls: t.stringList({
      resolve: (v) =>
        v.photoPublicIds
          .map((id) => cloudinary.url(id, TRANSFORMS.venuePhoto))
          .filter((url): url is string => url !== null),
    }),
    distanceKm: t.float({
      nullable: true,
      description: 'Distance from the search centre. Null unless `near` was given.',
      resolve: (v) => (v.distanceM === null ? null : v.distanceM / 1000),
    }),
    description: t.string({ nullable: true, resolve: (v) => v.description }),
    openingHours: t.field({ type: [OpeningHoursRef], resolve: (v) => v.openingHours }),
    contactPhone: t.string({ nullable: true, resolve: (v) => v.contactPhone }),
    rating: t.float({
      nullable: true,
      description: 'venues R7 — the average of visible reviews. Null until there are 3.',
      resolve: (v) => v.rating,
    }),
    reviewCount: t.exposeInt('reviewCount'),
    reviews: t.connection(
      {
        type: VenueReviewRef,
        description: 'Newest first. Forward pagination only.',
        resolve: async (v, args) => {
          if (args.last != null || args.before != null) {
            throw new SystemError('BAD_USER_INPUT', 'reviews supports forward pagination only');
          }
          const page = await venues.reviews(v.id, {
            first: clampFirst(args.first, 10),
            after: args.after ?? null,
          });
          const edges = page.nodes.map((node, i) => ({ cursor: page.cursors[i] ?? '', node }));
          return {
            edges,
            pageInfo: {
              hasNextPage: page.hasNextPage,
              hasPreviousPage: args.after != null,
              startCursor: edges[0]?.cursor ?? null,
              endCursor: page.endCursor,
            },
          };
        },
      },
      VenueReviewConnectionRef,
    ),
    viewerCanReview: t.boolean({
      description: 'venues R6 — you played here in the last 12 months. False when signed out.',
      resolve: (v, _args, ctx) =>
        ctx.actor ? venues.canReview(ctx.actor.userId, v.id) : false,
    }),
    viewerReview: t.field({
      type: VenueReviewRef,
      nullable: true,
      description: 'Your own review, to edit. One per player per venue.',
      resolve: (v, _args, ctx) => (ctx.actor ? venues.reviewBy(ctx.actor.userId, v.id) : null),
    }),
    viewerManages: t.boolean({
      description: 'You may edit this venue and reply to its reviews (venues R3, R8).',
      resolve: (v, _args, ctx) => ctx.actor?.userId === v.createdBy,
    }),
  }),
});

// --- payloads ----------------------------------------------------------------

const VenuePayload = builder
  .objectRef<{ venue: Venue | null; userError: UserErrorShape | null }>('VenuePayload')
  .implement({
    fields: (t) => ({
      venue: t.field({ type: VenueRef, nullable: true, resolve: (p) => p.venue }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const VenueReviewPayload = builder
  .objectRef<{ review: VenueReview | null; userError: UserErrorShape | null }>('VenueReviewPayload')
  .implement({
    fields: (t) => ({
      review: t.field({ type: VenueReviewRef, nullable: true, resolve: (p) => p.review }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const CourtPayload = builder
  .objectRef<{ court: Court | null; userError: UserErrorShape | null }>('CourtPayload')
  .implement({
    fields: (t) => ({
      court: t.field({ type: CourtRef, nullable: true, resolve: (p) => p.court }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

interface UploadShape {
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

const MediaUpload = builder.objectRef<UploadShape>('MediaUpload').implement({
  description:
    'A short-lived signature for a direct-to-Cloudinary upload (ADR 0003 §C2). ' +
    'Send the resulting public_id back through the matching add mutation.',
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

const MediaUploadPayload = builder
  .objectRef<{ upload: UploadShape | null; userError: UserErrorShape | null }>(
    'MediaUploadPayload',
  )
  .implement({
    fields: (t) => ({
      upload: t.field({ type: MediaUpload, nullable: true, resolve: (p) => p.upload }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ------------------------------------------------------------------

const OpeningHoursInput = builder.inputType('OpeningHoursInput', {
  fields: (t) => ({
    day: t.int({ required: true, description: '0 is Monday, 6 is Sunday.' }),
    opens: t.string({ required: true, description: 'HH:MM' }),
    closes: t.string({ required: true, description: 'HH:MM' }),
  }),
});

const ReviewVenueInput = builder.inputType('ReviewVenueInput', {
  description: 'venues R6 — creates your review, or edits it if you already wrote one.',
  fields: (t) => ({
    venueId: t.id({ required: true }),
    stars: t.int({ required: true, description: '1-5.' }),
    body: t.string({ description: 'At most 1,000 characters.' }),
  }),
});

const ReplyVenueReviewInput = builder.inputType('ReplyVenueReviewInput', {
  fields: (t) => ({
    reviewId: t.id({ required: true }),
    body: t.string({ required: true }),
  }),
});

const CourtInput = builder.inputType('CourtInput', {
  fields: (t) => ({
    name: t.string({ required: true }),
    surface: t.string(),
    indoor: t.boolean(),
    kind: t.field({ type: PlayingAreaKind }),
    sportIds: t.idList(),
  }),
});

const CreateVenueInput = builder.inputType('CreateVenueInput', {
  fields: (t) => ({
    name: t.string({ required: true }),
    address: t.string({ required: true }),
    city: t.string({ required: true }),
    location: t.field({ type: GeoPointInput, required: true }),
    amenities: t.stringList(),
    photoPublicIds: t.stringList({
      description: 'Cloudinary public_ids, never URLs (ADR 0003 §C3).',
    }),
    courts: t.field({ type: [CourtInput] }),
  }),
});

function createInputOf(i: typeof CreateVenueInput.$inferInput): Parameters<typeof venues.create>[1] {
  return {
    name: i.name,
    address: i.address,
    city: i.city,
    location: { lat: i.location.lat, lng: i.location.lng },
    amenities: i.amenities ?? undefined,
    photoPublicIds: i.photoPublicIds ?? undefined,
    courts:
      i.courts?.map((c) => ({
        name: c.name,
        surface: c.surface ?? null,
        indoor: c.indoor ?? false,
        kind: c.kind ?? undefined,
        sportIds: (c.sportIds ?? []).map(String),
      })) ?? undefined,
  };
}

/**
 * Portal staff (admin, support) manage any venue as its owner would (venues
 * Actor.platformStaff). Anyone else, and staff on their phone, is themselves.
 */
async function venueActor(ctx: Ctx) {
  const actor = requireActor(ctx);
  if (actor.client !== 'portal') return actor;
  const role = await ctx.loaders.platformRole.load(actor.userId);
  return { ...actor, platformStaff: role === 'admin' || role === 'support' };
}

const UpdateVenueInput = builder.inputType('UpdateVenueInput', {
  description: 'Only the fields present are written.',
  fields: (t) => ({
    name: t.string(),
    address: t.string(),
    city: t.string(),
    location: t.field({ type: GeoPointInput }),
    amenities: t.stringList(),
    photoPublicIds: t.stringList(),
    description: t.string(),
    openingHours: t.field({ type: [OpeningHoursInput], description: 'Replaces the whole week.' }),
    contactPhone: t.string(),
  }),
});

const UpdateCourtInput = builder.inputType('UpdateCourtInput', {
  fields: (t) => ({
    name: t.string(),
    surface: t.string(),
    indoor: t.boolean(),
    kind: t.field({ type: PlayingAreaKind }),
    sportIds: t.idList(),
    active: t.boolean({
      description: 'Retiring a court with scheduled matches fails with COURT_IN_USE.',
    }),
  }),
});

// --- queries -----------------------------------------------------------------

/** Same (sort key, id) pair the service pages on (conventions.md §4). */
const cursorFor = (v: Venue, byDistance: boolean): string =>
  Buffer.from(
    `${byDistance ? String(v.distanceM ?? 0) : v.name}|${v.id}`,
    'utf8',
  ).toString('base64url');

builder.queryFields((t) => ({
  venue: t.field({
    type: VenueRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    // Null, not VENUE_NOT_FOUND: a nullable field already says "no such venue",
    // and a query has no payload type to carry a user error (conventions.md §3).
    resolve: (_root, args) => venues.findById(args.id),
  }),

  venues: t.connection(
    {
      type: VenueRef,
      description:
        'Venues near a point, in a city, or hosting a sport. Radius is capped at 50 km (venues R1).',
      args: {
        near: t.arg({ type: GeoPointInput }),
        radiusKm: t.arg.float({ defaultValue: 10 }),
        city: t.arg.string(),
        sportId: t.arg.id(),
        query: t.arg.string({ description: 'discovery R1 — free text over name and address.' }),
      },
      resolve: async (_root, args) => {
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'venues supports forward pagination only');
        }
        const first = clampFirst(args.first, 20);
        const near = args.near ? { lat: args.near.lat, lng: args.near.lng } : null;
        const page = await venues.search(
          {
            near,
            radiusKm: args.radiusKm ?? null,
            city: args.city ?? null,
            sportId: args.sportId ?? null,
            query: args.query ?? null,
          },
          { first, after: args.after ?? null },
        );
        const edges = page.nodes.map((node) => ({
          cursor: cursorFor(node, near !== null),
          node,
        }));
        return {
          edges,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: page.endCursor,
          },
        };
      },
    },
    // The doc's names. Without them Pothos derives `QueryVenuesConnection`, and
    // the committed SDL is the client contract (conventions.md §4).
    { name: 'VenueConnection' },
    { name: 'VenueEdge' },
  ),
}));

// --- mutations ---------------------------------------------------------------

builder.mutationFields((t) => ({
  createVenue: t.field({
    type: VenuePayload,
    description:
      'venues R3 — anyone signed in may add a venue; moderation is manual in Phase 1.',
    args: { input: t.arg({ type: CreateVenueInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => venues.create(actor, createInputOf(args.input)));
      return { venue: data, userError };
    },
  }),

  adminCreateVenue: t.field({
    type: VenuePayload,
    description:
      'portal — PL4Y staff add a venue. With `ownerEmail`, that PL4Y account owns it: edits it ' +
      'and runs its desk from the app. Without, staff manage it from the portal.',
    args: {
      input: t.arg({ type: CreateVenueInput, required: true }),
      ownerEmail: t.arg.string(),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const { data, userError } = await attempt(async () => {
        const reason = requireReason(args.reason);
        const email = args.ownerEmail?.trim() || null;
        const owner = email ? await identity.findByEmail(email) : null;
        if (email && !owner) {
          throw new UserError(
            'OWNER_NOT_FOUND',
            'Nobody has a PL4Y account with that email. Ask them to sign up first, or leave it empty.',
          );
        }
        const created = await venues.create(
          { userId: staff.userId, platformStaff: true },
          createInputOf(args.input),
          { ownerId: owner?.id },
        );
        // Recorded against the id it was just given.
        await recordAudit(db, {
          actorUserId: staff.userId,
          action: 'venue.create',
          targetType: 'venue',
          targetId: created.id,
          reason,
          details: { name: created.name, city: created.city, ownerEmail: email },
        });
        return created;
      });
      return { venue: data, userError };
    },
  }),

  updateVenue: t.field({
    type: VenuePayload,
    args: {
      venueId: t.arg.id({ required: true }),
      input: t.arg({ type: UpdateVenueInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await venueActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.update(actor, args.venueId, {
          name: args.input.name ?? undefined,
          address: args.input.address ?? undefined,
          city: args.input.city ?? undefined,
          location: args.input.location
            ? { lat: args.input.location.lat, lng: args.input.location.lng }
            : undefined,
          amenities: args.input.amenities ?? undefined,
          photoPublicIds: args.input.photoPublicIds ?? undefined,
          description: args.input.description === undefined ? undefined : args.input.description,
          openingHours: args.input.openingHours ?? undefined,
          contactPhone: args.input.contactPhone === undefined ? undefined : args.input.contactPhone,
        }),
      );
      return { venue: data, userError };
    },
  }),

  addCourt: t.field({
    type: CourtPayload,
    args: {
      venueId: t.arg.id({ required: true }),
      input: t.arg({ type: CourtInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await venueActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.addCourt(actor, args.venueId, {
          name: args.input.name,
          surface: args.input.surface ?? null,
          indoor: args.input.indoor ?? false,
          kind: args.input.kind ?? undefined,
          sportIds: args.input.sportIds ?? [],
        }),
      );
      return { court: data, userError };
    },
  }),

  updateCourt: t.field({
    type: CourtPayload,
    args: {
      courtId: t.arg.id({ required: true }),
      input: t.arg({ type: UpdateCourtInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await venueActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.updateCourt(actor, args.courtId, {
          name: args.input.name ?? undefined,
          surface: args.input.surface === undefined ? undefined : args.input.surface,
          indoor: args.input.indoor ?? undefined,
          kind: args.input.kind ?? undefined,
          sportIds: args.input.sportIds ?? undefined,
          active: args.input.active ?? undefined,
        }),
      );
      return { court: data, userError };
    },
  }),

  venuePhotoUploadSignature: t.field({
    type: MediaUploadPayload,
    description:
      'ADR 0003 §C2 — the client uploads straight to Cloudinary under this ' +
      'signature, then reports the public_id back through addVenuePhoto.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await venueActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.photoUploadSignature(actor, args.venueId),
      );
      return { upload: data, userError };
    },
  }),

  addVenuePhoto: t.field({
    type: VenuePayload,
    args: {
      venueId: t.arg.id({ required: true }),
      publicId: t.arg.string({ required: true, description: 'Never a URL (ADR 0003 §C3).' }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await venueActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.addPhoto(actor, args.venueId, args.publicId),
      );
      return { venue: data, userError };
    },
  }),

  reviewVenue: t.field({
    type: VenueReviewPayload,
    description:
      'venues R6, R7 — only after playing here in the last 12 months (REVIEW_NOT_ELIGIBLE). ' +
      'A second call edits your review.',
    args: { input: t.arg({ type: ReviewVenueInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.review(actor, args.input.venueId, {
          stars: args.input.stars,
          body: args.input.body ?? null,
        }),
      );
      return { review: data, userError };
    },
  }),

  replyToVenueReview: t.field({
    type: VenueReviewPayload,
    description: 'venues R8 — the venue’s one public reply to a review.',
    args: { input: t.arg({ type: ReplyVenueReviewInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        venues.replyToReview(actor, args.input.reviewId, args.input.body),
      );
      return { review: data, userError };
    },
  }),

  deleteVenue: t.field({
    type: VenuePayload,
    description: 'venues R5 — soft delete. Completed tournaments keep resolving their venue.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await venueActor(ctx);
      const { userError } = await attempt(() => venues.remove(actor, args.venueId));
      return { venue: null, userError };
    },
  }),
}));

export { VenueRef, CourtRef, MediaUpload, MediaUploadPayload };
