/**
 * communities — GraphQL (docs/modules/17-communities.md).
 *
 * Anyone signed in reads what a card shows: name, cover, sport, city, labels,
 * price and member count. Posts and chat are for active members; the member
 * list of a private community too (R6). `viewerState` is the one field a
 * client needs to pick its button.
 */
import DataLoader from 'dataloader';
import { builder, clampFirst } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { SystemError, UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { profile } from '../../profile/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { sport } from '../../sport/index.js';
import { MediaUploadPayload } from '../../venues/schema/index.js';
import { CommunityCode, communities, communityCursor, communityFeed, feedCursor } from '../index.js';
import type { Community, Earnings, JoinRequest, Membership, Message, Post, SortKey, Viewer } from '../index.js';
import { payments } from '../../payments/index.js';
import { CreatePaymentOrderPayload, RefreshPaymentPayload } from '../../payments/schema/index.js';

// --- enums ------------------------------------------------------------------------

const VisibilityEnum = builder.enumType('CommunityVisibility', {
  description: 'communities R1, R2 — PUBLIC: listed and open to find. PRIVATE: membership is approved by an admin.',
  values: { PUBLIC: { value: 'public' }, PRIVATE: { value: 'private' } } as const,
});

const AccessEnum = builder.enumType('CommunityAccess', {
  values: { FREE: { value: 'free' }, PAID: { value: 'paid' } } as const,
});

const BillingEnum = builder.enumType('CommunityBilling', {
  description: 'How long one payment lasts. ONE_TIME is membership for good.',
  values: { ONE_TIME: { value: 'one_time' }, MONTHLY: { value: 'monthly' }, YEARLY: { value: 'yearly' } } as const,
});

const RoleEnum = builder.enumType('CommunityRole', {
  values: { OWNER: { value: 'owner' }, ADMIN: { value: 'admin' }, MEMBER: { value: 'member' } } as const,
});

const ViewerStateEnum = builder.enumType('CommunityViewerState', {
  description:
    'NONE — not in it. REQUESTED — waiting for an admin. APPROVED_TO_PAY — approved, pay to join. ' +
    'MEMBER — in it. EXPIRED — a paid period ended: renew. REMOVED — an admin removed them; they cannot rejoin.',
  values: {
    NONE: { value: 'none' },
    REQUESTED: { value: 'requested' },
    APPROVED_TO_PAY: { value: 'approved_to_pay' },
    MEMBER: { value: 'member' },
    EXPIRED: { value: 'expired' },
    REMOVED: { value: 'removed' },
  } as const,
});

const SortEnum = builder.enumType('CommunitySort', {
  values: { RECENT: { value: 'recent' }, POPULAR: { value: 'popular' } } as const,
});

const RequestStatusEnum = builder.enumType('CommunityJoinRequestStatus', {
  values: {
    PENDING: { value: 'pending' },
    APPROVED: { value: 'approved' },
    REJECTED: { value: 'rejected' },
    CANCELLED: { value: 'cancelled' },
    EXPIRED: { value: 'expired' },
    JOINED: { value: 'joined' },
  } as const,
});

// --- the viewer, batched per request -------------------------------------------------

const viewerLoaders = new WeakMap<Ctx, DataLoader<string, Viewer>>();

/** A list of 20 cards asks for 20 viewer states; this makes it two queries. */
function viewerOf(ctx: Ctx, communityId: string): Promise<Viewer> {
  let loader = viewerLoaders.get(ctx);
  if (!loader) {
    const userId = ctx.actor?.userId ?? null;
    loader = new DataLoader(async (ids: readonly string[]) => {
      const map = await communities.viewers([...ids], userId);
      return ids.map((id) => map.get(id)!);
    });
    viewerLoaders.set(ctx, loader);
  }
  return loader.load(communityId);
}

const isAdmin = (v: Viewer) => v.role === 'owner' || v.role === 'admin';
const paise = (v: bigint | null): number | null => (v === null ? null : Number(v));

// --- types --------------------------------------------------------------------------

const CommunityRef = builder.objectRef<Community>('Community');

const MemberRef = builder.objectRef<Membership>('CommunityMember').implement({
  fields: (t) => ({
    player: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (m, _args, ctx) => ctx.loaders.publicProfileByUser.load(m.userId),
    }),
    role: t.field({ type: RoleEnum, resolve: (m) => m.role }),
    joinedAt: t.field({ type: 'DateTime', resolve: (m) => m.joinedAt }),
  }),
});

const JoinRequestRef = builder.objectRef<JoinRequest>('CommunityJoinRequest').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    status: t.field({ type: RequestStatusEnum, resolve: (r) => r.status }),
    note: t.exposeString('note', { nullable: true }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    approvalExpiresAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'communities R4 — an approval to pay lapses here.',
      resolve: (r) => r.approvalExpiresAt,
    }),
    player: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (r, _args, ctx) => ctx.loaders.publicProfileByUser.load(r.userId),
    }),
    community: t.field({ type: CommunityRef, nullable: true, resolve: (r) => communities.findById(r.communityId) }),
  }),
});

builder.objectType(CommunityRef, {
  description: 'A club, group or team. Two choices make its type: visibility (public/private) and access (free/paid).',
  fields: (t) => ({
    id: t.exposeID('id'),
    slug: t.exposeString('slug'),
    name: t.exposeString('name'),
    description: t.exposeString('description', { nullable: true }),
    sport: t.field({ type: SportRef, resolve: (c) => sport.byId(c.sportId) }),
    city: t.exposeString('city'),
    coverUrl: t.string({ nullable: true, resolve: (c) => cloudinary.url(c.coverPublicId, TRANSFORMS.eventCover) }),
    visibility: t.field({ type: VisibilityEnum, resolve: (c) => c.visibility }),
    discoverable: t.boolean({
      description: 'communities R2 — listed in Discover. Always true for a public community.',
      resolve: (c) => c.visibility === 'public' || c.discoverable,
    }),
    access: t.field({ type: AccessEnum, resolve: (c) => c.access }),
    pricePaise: t.int({ nullable: true, description: 'Paid communities: one period’s price.', resolve: (c) => paise(c.pricePaise) }),
    billing: t.field({ type: BillingEnum, nullable: true, resolve: (c) => c.billing }),
    benefits: t.exposeStringList('benefits'),
    memberCount: t.exposeInt('memberCount'),
    createdAt: t.field({ type: 'DateTime', resolve: (c) => c.createdAt }),
    owner: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (c, _args, ctx) => ctx.loaders.publicProfileByUser.load(c.ownerUserId),
    }),
    viewerState: t.field({ type: ViewerStateEnum, resolve: async (c, _args, ctx) => (await viewerOf(ctx, c.id)).state }),
    viewerRole: t.field({
      type: RoleEnum,
      nullable: true,
      description: 'Set while the viewer is an active member.',
      resolve: async (c, _args, ctx) => (await viewerOf(ctx, c.id)).role,
    }),
    viewerRequest: t.field({
      type: JoinRequestRef,
      nullable: true,
      description: 'The viewer’s open request: waiting, or approved and waiting for the payment.',
      resolve: async (c, _args, ctx) => (await viewerOf(ctx, c.id)).request,
    }),
    inviteCode: t.string({
      nullable: true,
      description: 'communities R3 — for admins to share as a link. Null for everyone else.',
      resolve: async (c, _args, ctx) => (isAdmin(await viewerOf(ctx, c.id)) ? c.inviteCode : null),
    }),
    pendingRequestCount: t.int({
      description: 'Waiting requests. Zero for anyone but admins.',
      resolve: async (c, _args, ctx) => (isAdmin(await viewerOf(ctx, c.id)) ? communities.pendingCount(c.id) : 0),
    }),
    joinRequests: t.field({
      type: [JoinRequestRef],
      description: 'communities R5 — waiting requests (oldest first) and approvals waiting for payment. Admins only; empty otherwise.',
      resolve: (c, _args, ctx) => (ctx.actor ? communities.joinRequests(ctx.actor, c.id) : []),
    }),
    hidden: t.boolean({
      description: 'PL4Y staff hid it. Members still see it; nobody else does.',
      resolve: (c) => c.hiddenAt !== null,
    }),
  }),
});

builder.objectFields(CommunityRef, (t) => ({
  members: t.connection(
    {
      type: MemberRef,
      description: 'communities R6 — owner, admins, then members by join date. Empty to non-members of a private community.',
      resolve: async (c, args, ctx) => {
        const page = await communities.members(c, ctx.actor?.userId ?? null, {
          first: clampFirst(args.first, 30),
          after: args.after ?? null,
        });
        return {
          edges: page.nodes.map((node, i) => ({ cursor: `${page.endCursor ?? ''}:${i}`, node })),
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: null,
            endCursor: page.endCursor,
          },
        };
      },
    },
    { name: 'CommunityMemberConnection' },
    { name: 'CommunityMemberEdge' },
  ),
}));

// --- payloads -------------------------------------------------------------------------

const CommunityPayload = builder
  .objectRef<{ community: Community | null; userError: UserErrorShape | null }>('CommunityPayload')
  .implement({
    fields: (t) => ({
      community: t.field({ type: CommunityRef, nullable: true, resolve: (p) => p.community }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RequestToJoinPayload = builder
  .objectRef<{ community: Community | null; request: JoinRequest | null; userError: UserErrorShape | null }>(
    'RequestToJoinCommunityPayload',
  )
  .implement({
    fields: (t) => ({
      community: t.field({ type: CommunityRef, nullable: true, resolve: (p) => p.community }),
      request: t.field({
        type: JoinRequestRef,
        nullable: true,
        description: 'Null when the invite code let the player straight in (a free private community).',
        resolve: (p) => p.request,
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const JoinRequestPayload = builder
  .objectRef<{ request: JoinRequest | null; userError: UserErrorShape | null }>('CommunityJoinRequestPayload')
  .implement({
    fields: (t) => ({
      request: t.field({ type: JoinRequestRef, nullable: true, resolve: (p) => p.request }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs -------------------------------------------------------------------------------

const CreateCommunityInput = builder.inputType('CreateCommunityInput', {
  fields: (t) => ({
    name: t.string({ required: true }),
    description: t.string(),
    sportId: t.id({ required: true }),
    city: t.string(),
    visibility: t.field({ type: VisibilityEnum, required: true }),
    discoverable: t.boolean({ description: 'Private only: listed in Discover (default true). Off: reachable by invite link only.' }),
    access: t.field({ type: AccessEnum, required: true }),
    pricePaise: t.int({ description: 'Paid only: ₹10 to ₹50,000, in paise.' }),
    billing: t.field({ type: BillingEnum, description: 'Paid only.' }),
    benefits: t.stringList({ description: 'Up to 6 lines a member gets.' }),
  }),
});

const UpdateCommunityInput = builder.inputType('UpdateCommunityInput', {
  description: 'Admins. Only what is given changes. Visibility and access are fixed at creation (communities R1).',
  fields: (t) => ({
    communityId: t.id({ required: true }),
    name: t.string(),
    description: t.string({ description: 'Null clears it.' }),
    sportId: t.id(),
    city: t.string(),
    coverPublicId: t.string({ description: 'From communityCoverUploadSignature: `folder/publicId`. Null removes the cover.' }),
    discoverable: t.boolean(),
    pricePaise: t.int({ description: 'Paid only. Applies to the next payment.' }),
    billing: t.field({ type: BillingEnum }),
    benefits: t.stringList(),
  }),
});

/** Player ids (what the app holds) → user ids (what membership stores). */
async function userIdOf(playerId: string): Promise<string> {
  const brief = await profile.briefById(playerId);
  if (!brief) throw new UserError(CommunityCode.NOT_A_MEMBER, 'That player is not a member.');
  return brief.userId;
}

// --- queries ----------------------------------------------------------------------------------

builder.queryFields((t) => ({
  community: t.field({
    type: CommunityRef,
    nullable: true,
    description:
      'The community page, by id, slug or invite code. Null when it does not exist, or is private, unlisted and the viewer has no way in (R2).',
    args: { id: t.arg.id(), slug: t.arg.string(), inviteCode: t.arg.string() },
    resolve: (_root, args, ctx) => {
      const actor = requireActor(ctx);
      return communities.lookup(
        { id: args.id ? String(args.id) : null, slug: args.slug ?? null, inviteCode: args.inviteCode ?? null },
        actor.userId,
      );
    },
  }),

  communities: t.connection(
    {
      type: CommunityRef,
      description: 'Discover Communities (R2): public ones and private ones their creator listed.',
      args: {
        search: t.arg.string({ description: 'Matched against the name.' }),
        sportId: t.arg.id(),
        city: t.arg.string(),
        access: t.arg({ type: AccessEnum }),
        sort: t.arg({ type: SortEnum, defaultValue: 'recent' }),
        notJoined: t.arg.boolean({ description: 'Leave out communities the viewer is already in.' }),
      },
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'communities supports forward pagination only');
        }
        const sort: SortKey = args.sort ?? 'recent';
        const data = await communities.search(
          {
            text: args.search ?? null,
            sportId: args.sportId ? String(args.sportId) : null,
            city: args.city ?? null,
            access: args.access ?? null,
            sort,
            notJoinedBy: args.notJoined ? actor.userId : null,
          },
          { first: clampFirst(args.first, 20), after: args.after ?? null },
        );
        const edges = data.nodes.map((node) => ({ cursor: communityCursor(node, sort), node }));
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
    { name: 'CommunityConnection' },
    { name: 'CommunityEdge' },
  ),

  myCommunities: t.field({
    type: [CommunityRef],
    description: 'Communities the viewer is an active member of, most recently active first.',
    resolve: (_root, _args, ctx) => communities.listForUser(requireActor(ctx).userId),
  }),

  myCommunityRequests: t.field({
    type: [JoinRequestRef],
    description: 'The viewer’s open requests: waiting for an admin, or approved and waiting for payment.',
    resolve: (_root, _args, ctx) => communities.requestsForUser(requireActor(ctx).userId),
  }),
}));

// --- mutations --------------------------------------------------------------------------------

builder.mutationFields((t) => ({
  createCommunity: t.field({
    type: CommunityPayload,
    description: 'The creator becomes its owner and first member. INVALID_COMMUNITY, COMMUNITY_LIMIT.',
    args: { input: t.arg({ type: CreateCommunityInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        communities.create(actor, {
          name: i.name,
          description: i.description ?? null,
          sportId: String(i.sportId),
          city: i.city ?? null,
          visibility: i.visibility,
          discoverable: i.discoverable ?? null,
          access: i.access,
          pricePaise: i.pricePaise ?? null,
          billing: i.billing ?? null,
          benefits: i.benefits ?? null,
        }),
      );
      return { community: data, userError };
    },
  }),

  updateCommunity: t.field({
    type: CommunityPayload,
    args: { input: t.arg({ type: UpdateCommunityInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const i = args.input;
      const id = String(i.communityId);
      const { data, userError } = await attempt(async () => {
        if (i.coverPublicId != null) {
          // ADR 0003 §C2 — only an asset uploaded under this community's root.
          const root = `${cloudinary.folders.communityRoot(id)}/`;
          if (!i.coverPublicId.startsWith(root) || i.coverPublicId.length === root.length) {
            throw new UserError(CommunityCode.INVALID_COMMUNITY, 'That cover was not uploaded for this community.');
          }
        }
        return communities.update(actor, id, {
          ...(i.name != null ? { name: i.name } : {}),
          ...(i.description !== undefined ? { description: i.description } : {}),
          ...(i.sportId ? { sportId: String(i.sportId) } : {}),
          ...(i.city != null ? { city: i.city } : {}),
          ...(i.coverPublicId !== undefined ? { coverPublicId: i.coverPublicId } : {}),
          ...(i.discoverable != null ? { discoverable: i.discoverable } : {}),
          ...(i.pricePaise != null ? { pricePaise: i.pricePaise } : {}),
          ...(i.billing ? { billing: i.billing } : {}),
          ...(i.benefits ? { benefits: i.benefits } : {}),
        });
      });
      return { community: data, userError };
    },
  }),

  communityCoverUploadSignature: t.field({
    type: MediaUploadPayload,
    description: 'ADR 0003 §C2 — upload the cover under this signature, then save `folder/publicId` as coverPublicId. Admins.',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const id = String(args.communityId);
      const { data, userError } = await attempt(async () => {
        const role = await communities.roleOf(id, actor.userId);
        if (role !== 'owner' && role !== 'admin') throw forbidden();
        return cloudinary.signUpload({ publicId: `cover-${newId()}`, folder: cloudinary.folders.communityRoot(id) });
      });
      return { upload: data, userError };
    },
  }),

  deleteCommunity: t.field({
    type: CommunityPayload,
    description: 'The owner only. It leaves Discover and every member’s list. `community` is null on success.',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => communities.remove(actor, String(args.communityId)));
      return { community: null, userError };
    },
  }),

  joinCommunity: t.field({
    type: CommunityPayload,
    description:
      'communities R3 — a free public community, or a free private one with its invite code. ' +
      'REQUEST_REQUIRED, PAYMENT_REQUIRED, ALREADY_MEMBER, REMOVED_FROM_COMMUNITY, COMMUNITY_FULL.',
    args: { communityId: t.arg.id({ required: true }), inviteCode: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communities.join(actor, String(args.communityId), args.inviteCode ?? null));
      return { community: data, userError };
    },
  }),

  requestToJoinCommunity: t.field({
    type: RequestToJoinPayload,
    description:
      'communities R3, R4 — a private community. With its invite code, a free one lets the player in and a paid one counts as approved. ' +
      'JOIN_REQUEST_PENDING, ALREADY_MEMBER, REMOVED_FROM_COMMUNITY, REQUEST_LIMIT.',
    args: { communityId: t.arg.id({ required: true }), note: t.arg.string(), inviteCode: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        communities.requestToJoin(actor, String(args.communityId), { note: args.note ?? null, inviteCode: args.inviteCode ?? null }),
      );
      return { community: data?.community ?? null, request: data?.request ?? null, userError };
    },
  }),

  cancelCommunityRequest: t.field({
    type: CommunityPayload,
    description: 'The asker withdraws a waiting request or an approval to pay.',
    args: { requestId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communities.cancelRequest(actor, String(args.requestId)));
      return { community: data, userError };
    },
  }),

  respondToCommunityRequest: t.field({
    type: JoinRequestPayload,
    description: 'Admins. Free: approving makes a member. Paid: approving gives 7 days to pay (R4). REQUEST_NOT_FOUND once answered.',
    args: { requestId: t.arg.id({ required: true }), approve: t.arg.boolean({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communities.respond(actor, String(args.requestId), args.approve));
      return { request: data, userError };
    },
  }),

  leaveCommunity: t.field({
    type: CommunityPayload,
    description: 'OWNER_MUST_TRANSFER for the owner (R5).',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communities.leave(actor, String(args.communityId)));
      return { community: data, userError };
    },
  }),

  removeCommunityMember: t.field({
    type: CommunityPayload,
    description: 'Admins remove members; only the owner removes an admin. The removed player cannot rejoin (R6).',
    args: { communityId: t.arg.id({ required: true }), playerId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () =>
        communities.removeMember(actor, String(args.communityId), await userIdOf(String(args.playerId))),
      );
      return { community: data, userError };
    },
  }),

  setCommunityRole: t.field({
    type: CommunityPayload,
    description: 'The owner makes a member an admin, or an admin a member.',
    args: {
      communityId: t.arg.id({ required: true }),
      playerId: t.arg.id({ required: true }),
      role: t.arg({ type: RoleEnum, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () => {
        if (args.role === 'owner') {
          throw new UserError(CommunityCode.INVALID_COMMUNITY, 'Use transferCommunityOwnership to hand over ownership.');
        }
        return communities.setRole(actor, String(args.communityId), await userIdOf(String(args.playerId)), args.role);
      });
      return { community: data, userError };
    },
  }),

  transferCommunityOwnership: t.field({
    type: CommunityPayload,
    description: 'The owner hands over to an active member and becomes an admin (R5).',
    args: { communityId: t.arg.id({ required: true }), playerId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () =>
        communities.transferOwnership(actor, String(args.communityId), await userIdOf(String(args.playerId))),
      );
      return { community: data, userError };
    },
  }),

  resetCommunityInvite: t.field({
    type: CommunityPayload,
    description: 'Admins. The old invite link stops working.',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communities.resetInvite(actor, String(args.communityId)));
      return { community: data, userError };
    },
  }),
}));

// ─── the feed and the chat (communities R9) ──────────────────────────────────────────

const PostRef = builder.objectRef<Post>('CommunityPost').implement({
  description: 'communities R9 — a post in the members’ feed. Plain text.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    pinned: t.exposeBoolean('pinned'),
    createdAt: t.field({ type: 'DateTime', resolve: (p) => p.createdAt }),
    author: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (p, _args, ctx) => ctx.loaders.publicProfileByUser.load(p.authorUserId),
    }),
    mine: t.boolean({ resolve: (p, _args, ctx) => ctx.actor?.userId === p.authorUserId }),
    viewerCanDelete: t.boolean({
      description: 'The author, or an admin.',
      resolve: async (p, _args, ctx) => ctx.actor?.userId === p.authorUserId || isAdmin(await viewerOf(ctx, p.communityId)),
    }),
  }),
});

const MessageRef = builder.objectRef<Message>('CommunityMessage').implement({
  description: 'communities R9 — a line in the members’ group chat. `body` is empty once removed.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    deleted: t.exposeBoolean('deleted'),
    createdAt: t.field({ type: 'DateTime', resolve: (m) => m.createdAt }),
    sender: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (m, _args, ctx) => ctx.loaders.publicProfileByUser.load(m.senderUserId),
    }),
    mine: t.boolean({ resolve: (m, _args, ctx) => ctx.actor?.userId === m.senderUserId }),
    viewerCanDelete: t.boolean({
      resolve: async (m, _args, ctx) =>
        !m.deleted && (ctx.actor?.userId === m.senderUserId || isAdmin(await viewerOf(ctx, m.communityId))),
    }),
  }),
});

builder.objectFields(CommunityRef, (t) => ({
  pinnedPost: t.field({
    type: PostRef,
    nullable: true,
    description: 'Shown above the feed. Members only.',
    resolve: (c, _args, ctx) => communityFeed.pinnedPost(c.id, ctx.actor?.userId ?? null),
  }),
  posts: t.connection(
    {
      type: PostRef,
      description: 'communities R9 — the feed, newest first. Empty to anyone who is not an active member (R6).',
      resolve: async (c, args, ctx) => {
        const page = await communityFeed.posts(c.id, ctx.actor?.userId ?? null, {
          first: clampFirst(args.first, 20),
          after: args.after ?? null,
        });
        return {
          edges: page.nodes.map((node) => ({ cursor: feedCursor(node), node })),
          pageInfo: { hasNextPage: page.hasNextPage, hasPreviousPage: args.after != null, startCursor: null, endCursor: page.endCursor },
        };
      },
    },
    { name: 'CommunityPostConnection' },
    { name: 'CommunityPostEdge' },
  ),
  messages: t.field({
    type: [MessageRef],
    description:
      'communities R9 — the group chat, newest first (the client shows it oldest at the top). `before` is the oldest ' +
      'loaded message’s `cursor`. Empty to anyone who is not an active member (R6).',
    args: { first: t.arg.int({ defaultValue: 50 }), before: t.arg.string() },
    resolve: async (c, args, ctx) =>
      (await communityFeed.messages(c.id, ctx.actor?.userId ?? null, { first: args.first ?? 50, before: args.before ?? null })).nodes,
  }),
}));

builder.objectFields(MessageRef, (t) => ({
  cursor: t.string({
    description: 'Pass as `before` to load the messages older than this one.',
    resolve: (m) => feedCursor(m),
  }),
}));

const PostPayload = builder
  .objectRef<{ post: Post | null; userError: UserErrorShape | null }>('CommunityPostPayload')
  .implement({
    fields: (t) => ({
      post: t.field({ type: PostRef, nullable: true, resolve: (p) => p.post }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const MessagePayload = builder
  .objectRef<{ message: Message | null; userError: UserErrorShape | null }>('CommunityMessagePayload')
  .implement({
    fields: (t) => ({
      message: t.field({ type: MessageRef, nullable: true, resolve: (p) => p.message }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  createCommunityPost: t.field({
    type: PostPayload,
    description: 'communities R9 — active members. Up to 2,000 characters. INVALID_POST, POSTING_TOO_FAST.',
    args: { communityId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communityFeed.createPost(actor, String(args.communityId), args.body));
      return { post: data, userError };
    },
  }),

  deleteCommunityPost: t.field({
    type: PostPayload,
    description: 'The author, or an admin. `post` is null on success.',
    args: { postId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => communityFeed.deletePost(actor, String(args.postId)));
      return { post: null, userError };
    },
  }),

  pinCommunityPost: t.field({
    type: PostPayload,
    description: 'Admins. One pinned post at a time.',
    args: { postId: t.arg.id({ required: true }), pinned: t.arg.boolean({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communityFeed.pinPost(actor, String(args.postId), args.pinned));
      return { post: data, userError };
    },
  }),

  sendCommunityMessage: t.field({
    type: MessagePayload,
    description: 'communities R9 — active members. Up to 1,000 characters. INVALID_POST, POSTING_TOO_FAST.',
    args: { communityId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communityFeed.sendMessage(actor, String(args.communityId), args.body));
      return { message: data, userError };
    },
  }),

  deleteCommunityMessage: t.field({
    type: MessagePayload,
    description: 'The sender, or an admin. Gone for everyone.',
    args: { messageId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => communityFeed.deleteMessage(actor, String(args.messageId)));
      return { message: data, userError };
    },
  }),
}));

// ─── paid memberships (communities R8) ─────────────────────────────────────────────

const EarningsRef = builder.objectRef<Earnings>('CommunityEarnings').implement({
  description: 'communities R8 — what members have paid, PL4Y’s 5%, and what the creator earns. Refunded payments are left out.',
  fields: (t) => ({
    paidCount: t.exposeInt('paidCount'),
    grossPaise: t.int({ resolve: (e) => Number(e.grossPaise) }),
    commissionPaise: t.int({ resolve: (e) => Number(e.commissionPaise) }),
    netPaise: t.int({ resolve: (e) => Number(e.netPaise) }),
    refundedCount: t.exposeInt('refundedCount'),
  }),
});

builder.objectFields(CommunityRef, (t) => ({
  viewerPaidUntil: t.field({
    type: 'DateTime',
    nullable: true,
    description: 'communities R8 — when the viewer’s paid period ends. Null for one-time and free memberships, and for the owner.',
    resolve: (c, _args, ctx) => communities.paidUntilOf(c.id, ctx.actor?.userId ?? null),
  }),
  earnings: t.field({
    type: EarningsRef,
    nullable: true,
    description: 'The owner only; null for everyone else.',
    resolve: (c, _args, ctx) => (ctx.actor ? communities.earnings(ctx.actor, c.id) : null),
  }),
}));

builder.mutationFields((t) => ({
  createCommunityPaymentOrder: t.field({
    type: CreatePaymentOrderPayload,
    description:
      'communities R8, payments R20 — Join & pay, Pay now after an approval, or Renew. The price is the community’s, ' +
      'frozen on a held period; there is no argument for a client amount. ' +
      'REQUEST_REQUIRED (private, not approved), ALREADY_MEMBER (paid up), REMOVED_FROM_COMMUNITY, COMMUNITY_FULL.',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () => {
        const held = await communities.startPayment(actor, String(args.communityId));
        return payments.createCommunityOrder(actor, held.id);
      });
      return { order: data, userError };
    },
  }),

  refreshCommunityPayment: t.field({
    type: RefreshPaymentPayload,
    description: 'The membership twin of refreshPayment, called while checkout is open. The webhook is still the truth.',
    args: { communityId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () => {
        const latest = await communities.latestPaymentOf(String(args.communityId), actor.userId);
        if (!latest) return { settled: false };
        return payments.refreshCommunityPayment(actor, latest.id);
      });
      return { settled: data?.settled ?? false, userError };
    },
  }),
}));

export { CommunityRef };
