/**
 * identity — GraphQL surface (docs/modules/01-identity.md).
 *
 * Resolvers never touch Prisma (conventions.md §1): they call the service and
 * shape the result. Expected failures come back as a typed `userError` field
 * rather than as GraphQL errors (conventions.md §3).
 */
import { builder } from '../../../graphql/builder.js';
import { identity } from '../index.js';
import { db } from '../../../platform/db.js';
import {
  attempt,
  requireActor,
  UserErrorRef,
  type UserErrorShape,
} from '../../../graphql/userError.js';

// ─── types ───────────────────────────────────────────────────────────────────

interface ViewerShape {
  id: string;
  email: string;
  displayName: string;
  phoneE164: string | null;
  avatarPublicId: string | null;
  createdAt: Date;
}

const Viewer = builder.objectRef<ViewerShape>('Viewer').implement({
  description: 'The signed-in user.',
  fields: (t) => ({
    id: t.exposeID('id'),
    email: t.exposeString('email'),
    displayName: t.exposeString('displayName'),
    /** identity R12 — contact only, never an identity. */
    contactPhone: t.string({ nullable: true, resolve: (u) => u.phoneE164 }),
    createdAt: t.field({ type: 'DateTime', resolve: (u) => u.createdAt }),
    platformRole: t.string({
      nullable: true,
      description:
        'admin, support or finance for PL4Y staff; null for everyone else. The admin portal reads it to decide what to show (portal R1).',
      resolve: (u, _args, ctx) => ctx.loaders.platformRole.load(u.id),
    }),
  }),
});

interface SessionShape {
  accessToken: string;
  refreshToken: string;
  isNewUser: boolean;
}

const Session = builder.objectRef<SessionShape>('Session').implement({
  fields: (t) => ({
    accessToken: t.exposeString('accessToken'),
    refreshToken: t.exposeString('refreshToken'),
    isNewUser: t.exposeBoolean('isNewUser'),
  }),
});

interface GrantShape {
  eventId: string;
  userId: string;
  role: string;
}

const EventGrant = builder.objectRef<GrantShape>('EventGrant').implement({
  description: 'Organizer permission is a grant on one event, not a global role.',
  fields: (t) => ({
    eventId: t.exposeID('eventId'),
    userId: t.exposeID('userId'),
    role: t.exposeString('role'),
  }),
});

/** portal R6 — which client a session is for. The portal signs in staff only. */
const AuthClientEnum = builder.enumType('AuthClient', {
  values: { APP: { value: 'app' }, PORTAL: { value: 'portal' } } as const,
});

// ─── payloads ────────────────────────────────────────────────────────────────

const RequestOtpPayload = builder
  .objectRef<{ challengeId: string | null; userError: UserErrorShape | null }>(
    'RequestOtpPayload',
  )
  .implement({
    fields: (t) => ({
      challengeId: t.string({ nullable: true, resolve: (p) => p.challengeId }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const SessionPayload = builder
  .objectRef<{ session: SessionShape | null; userError: UserErrorShape | null }>(
    'SessionPayload',
  )
  .implement({
    fields: (t) => ({
      session: t.field({ type: Session, nullable: true, resolve: (p) => p.session }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ViewerPayload = builder
  .objectRef<{ viewer: ViewerShape | null; userError: UserErrorShape | null }>(
    'ViewerPayload',
  )
  .implement({
    fields: (t) => ({
      viewer: t.field({ type: Viewer, nullable: true, resolve: (p) => p.viewer }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const OkPayload = builder
  .objectRef<{ ok: boolean }>('OkPayload')
  .implement({ fields: (t) => ({ ok: t.exposeBoolean('ok') }) });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function viewerFor(userId: string): Promise<ViewerShape | null> {
  const u = await db.user.findUnique({ where: { id: userId } });
  return u
    ? {
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        phoneE164: u.phoneE164,
        avatarPublicId: u.avatarPublicId,
        createdAt: u.createdAt,
      }
    : null;
}

// ─── queries ─────────────────────────────────────────────────────────────────

builder.queryFields((t) => ({
  me: t.field({
    type: Viewer,
    nullable: true,
    resolve: async (_root, _args, ctx) =>
      ctx.actor ? viewerFor(ctx.actor.userId) : null,
  }),

  myEventGrants: t.field({
    type: [EventGrant],
    resolve: async (_root, _args, ctx) => {
      const actor = requireActor(ctx);
      return identity.grantsForUser(actor.userId);
    },
  }),
}));

// ─── mutations ───────────────────────────────────────────────────────────────

const RequestAccountDeletionPayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('RequestAccountDeletionPayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  requestOtp: t.field({
    type: RequestOtpPayload,
    args: { email: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const { data, userError } = await attempt(() =>
        identity.requestOtp(args.email, 'login', ctx.ip),
      );
      return { challengeId: data?.challengeId ?? null, userError };
    },
  }),

  verifyOtp: t.field({
    type: SessionPayload,
    args: {
      email: t.arg.string({ required: true }),
      code: t.arg.string({ required: true }),
      deviceLabel: t.arg.string(),
      client: t.arg({ type: AuthClientEnum, defaultValue: 'app' }),
    },
    resolve: async (_root, args) => {
      const { data, userError } = await attempt(() =>
        identity.verifyOtp(args.email, args.code, args.deviceLabel ?? undefined, args.client ?? 'app'),
      );
      return {
        session: data
          ? {
              accessToken: data.access,
              refreshToken: data.refresh,
              isNewUser: data.isNewUser,
            }
          : null,
        userError,
      };
    },
  }),

  refreshSession: t.field({
    type: SessionPayload,
    args: {
      refreshToken: t.arg.string({ required: true }),
      client: t.arg({ type: AuthClientEnum, defaultValue: 'app' }),
    },
    resolve: async (_root, args) => {
      const { data, userError } = await attempt(() =>
        identity.rotateSession(args.refreshToken, args.client ?? 'app'),
      );
      return {
        session: data
          ? { accessToken: data.access, refreshToken: data.refresh, isNewUser: false }
          : null,
        userError,
      };
    },
  }),

  logout: t.field({
    type: OkPayload,
    args: { allDevices: t.arg.boolean({ defaultValue: false }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      if (args.allDevices) await identity.revokeAllSessions(actor.userId);
      else await identity.revokeSession(actor.userId, actor.sessionId);
      return { ok: true };
    },
  }),

  /** identity R12 — stored, never verified, never an auth factor. */
  setContactPhone: t.field({
    type: ViewerPayload,
    args: { phone: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        identity.setPhone(actor.userId, args.phone ?? null),
      );
      return { viewer: await viewerFor(actor.userId), userError };
    },
  }),

  requestAccountDeletion: t.field({
    type: RequestAccountDeletionPayload,
    description:
      'identity R18 — revokes every session now; personal data is scrubbed after 30 days. ' +
      'ACCOUNT_DELETION_BLOCKED while the account has a confirmed place in an upcoming event.',
    resolve: async (_root, _args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => identity.requestAccountDeletion(actor));
      return { ok: userError === null, userError };
    },
  }),
}));

/** Other modules hang their viewer fields here (Viewer.organisations, Viewer.isHosting). */
export { Viewer as ViewerRef };
