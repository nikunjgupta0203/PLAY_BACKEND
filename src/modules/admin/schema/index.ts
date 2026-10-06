/**
 * The admin portal's own reads and writes (PLAY_FRONTEND/docs/modules/25-admin-portal.md,
 * PALY_BACKEND/docs/modules/15-admin.md): the overview, finding a user or an
 * event, PL4Y's staff list, and the audit log.
 *
 * Portal sessions only (portal R2). Every write takes a reason and is audited
 * (portal R3). Each change is the owning module's own method; this file
 * decides who may call it.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { audited, requirePlatformStaff, type PlatformStaffRole } from '../../../graphql/staff.js';
import { attempt, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { EventRef, EventStatusEnum } from '../../events/schema/index.js';
import { events } from '../../events/index.js';
import type { Event, EventStatus } from '../../events/index.js';
import { identity } from '../../identity/index.js';
import { organisations } from '../../organizers/index.js';
import { MembershipRef } from '../../organizers/schema/index.js';

export const AdminCode = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  /** Nobody takes away their own admin role: another admin must. */
  CANNOT_CHANGE_OWN_ROLE: 'CANNOT_CHANGE_OWN_ROLE',
} as const;

// --- masking (15-admin R4) -----------------------------------------------------------

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local[0]}${'*'.repeat(Math.max(local.length - 1, 2))}${email.slice(at)}`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

// --- overview --------------------------------------------------------------------------

interface Overview {
  openReports: number;
  escalatedResults: number;
  payoutsNeedingAttention: number;
  accountsForReview: number;
  openOrganisationInvites: number;
  suspendedOrganisations: number;
  moderationCases: number;
  openTickets: number;
  fraudCases: number;
}

const OverviewRef = builder.objectRef<Overview>('AdminOverview').implement({
  description: 'portal — what is waiting on someone.',
  fields: (t) => ({
    openReports: t.exposeInt('openReports'),
    escalatedResults: t.exposeInt('escalatedResults'),
    payoutsNeedingAttention: t.exposeInt('payoutsNeedingAttention'),
    accountsForReview: t.exposeInt('accountsForReview'),
    openOrganisationInvites: t.exposeInt('openOrganisationInvites'),
    suspendedOrganisations: t.exposeInt('suspendedOrganisations'),
    moderationCases: t.exposeInt('moderationCases', { description: '15-admin R6 — reported people, reviews and messages waiting.' }),
    openTickets: t.exposeInt('openTickets', { description: '15-admin R7 — tickets waiting on support.' }),
    fraudCases: t.exposeInt('fraudCases', { description: '15-admin R8 — subjects over the review threshold.' }),
  }),
});

// --- users -------------------------------------------------------------------------------

interface AdminUser {
  id: string;
  displayName: string;
  email: string;
  phone: string | null;
  status: string;
  isGuest: boolean;
  avatarPublicId: string | null;
  createdAt: Date;
}

const AdminUserRef = builder.objectRef<AdminUser>('AdminUser').implement({
  description: 'portal — a person, with contact details masked (15-admin R4). adminRevealContact shows them, audited.',
  fields: (t) => ({
    id: t.exposeID('id'),
    displayName: t.exposeString('displayName'),
    emailMasked: t.string({ resolve: (u) => maskEmail(u.email) }),
    phoneMasked: t.string({ nullable: true, resolve: (u) => maskPhone(u.phone) }),
    status: t.exposeString('status', { description: 'active | suspended | deleted' }),
    isGuest: t.exposeBoolean('isGuest'),
    avatarUrl: t.string({ nullable: true, resolve: (u) => cloudinary.url(u.avatarPublicId, TRANSFORMS.avatarSm) }),
    createdAt: t.field({ type: 'DateTime', resolve: (u) => u.createdAt }),
    platformRole: t.string({ nullable: true, resolve: (u, _a, ctx) => ctx.loaders.platformRole.load(u.id) }),
    organisations: t.field({ type: [MembershipRef], resolve: (u) => organisations.membershipsOf(u.id) }),
    hostedEvents: t.field({
      type: [EventRef],
      description: 'Events they own, manage or score, newest first.',
      resolve: (u) => events.hostedBy(u.id),
    }),
    entriesCount: t.int({
      description: 'Registrations they made, in any state.',
      resolve: (u) => db.registration.count({ where: { captainUserId: u.id } }),
    }),
  }),
});

const USER_SELECT = {
  id: true,
  displayName: true,
  email: true,
  phoneE164: true,
  status: true,
  isGuest: true,
  avatarPublicId: true,
  createdAt: true,
} as const;

type UserRow = { id: string; displayName: string; email: string; phoneE164: string | null; status: string; isGuest: boolean; avatarPublicId: string | null; createdAt: Date };

const toAdminUser = (u: UserRow): AdminUser => ({ ...u, phone: u.phoneE164 });

async function adminUserById(id: string): Promise<AdminUser | null> {
  const row = await db.user.findUnique({ where: { id }, select: USER_SELECT });
  return row ? toAdminUser(row) : null;
}

const AdminUserPage = builder
  .objectRef<{ nodes: AdminUser[]; hasNextPage: boolean }>('AdminUserPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [AdminUserRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
    }),
  });

const ContactPayload = builder
  .objectRef<{ email: string | null; phone: string | null; userError: UserErrorShape | null }>('AdminContactPayload')
  .implement({
    fields: (t) => ({
      email: t.string({ nullable: true, resolve: (p) => p.email }),
      phone: t.string({ nullable: true, resolve: (p) => p.phone }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const AdminUserPayload = builder
  .objectRef<{ user: AdminUser | null; userError: UserErrorShape | null }>('AdminUserPayload')
  .implement({
    fields: (t) => ({
      user: t.field({ type: AdminUserRef, nullable: true, resolve: (p) => p.user }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- events ---------------------------------------------------------------------------------

const AdminEventPage = builder
  .objectRef<{ nodes: Event[]; hasNextPage: boolean; total: number }>('AdminEventPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [EventRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
      total: t.exposeInt('total'),
    }),
  });

// --- staff --------------------------------------------------------------------------------------

const StaffRoleEnum = builder.enumType('PlatformStaffRole', {
  values: { ADMIN: { value: 'admin' }, SUPPORT: { value: 'support' }, FINANCE: { value: 'finance' } } as const,
});

interface StaffMember {
  user: AdminUser;
  role: PlatformStaffRole;
  grantedByName: string | null;
  createdAt: Date;
}

const StaffMemberRef = builder.objectRef<StaffMember>('PlatformStaffMember').implement({
  fields: (t) => ({
    user: t.field({ type: AdminUserRef, resolve: (s) => s.user }),
    role: t.field({ type: StaffRoleEnum, resolve: (s) => s.role }),
    grantedByName: t.string({ nullable: true, resolve: (s) => s.grantedByName }),
    createdAt: t.field({ type: 'DateTime', resolve: (s) => s.createdAt }),
  }),
});

async function staffList(): Promise<StaffMember[]> {
  const rows = await db.platformStaff.findMany({
    orderBy: { createdAt: 'asc' },
    include: { user: { select: USER_SELECT }, grantor: { select: { displayName: true } } },
  });
  return rows.map((r) => ({
    user: toAdminUser(r.user),
    role: r.role as PlatformStaffRole,
    grantedByName: r.grantor?.displayName ?? null,
    createdAt: r.createdAt,
  }));
}

const StaffPayload = builder
  .objectRef<{ staff: StaffMember[] | null; userError: UserErrorShape | null }>('PlatformStaffPayload')
  .implement({
    fields: (t) => ({
      staff: t.field({ type: [StaffMemberRef], nullable: true, resolve: (p) => p.staff }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- audit log ----------------------------------------------------------------------------------

interface AuditRow {
  id: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  details: unknown;
  outcome: string;
  createdAt: Date;
}

const AuditEntryRef = builder.objectRef<AuditRow & { actorName: string }>('AuditEntry').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    actorUserId: t.exposeID('actorUserId'),
    actorName: t.exposeString('actorName'),
    action: t.exposeString('action'),
    targetType: t.exposeString('targetType'),
    targetId: t.exposeString('targetId'),
    reason: t.string({ nullable: true, resolve: (a) => a.reason }),
    details: t.string({ description: 'JSON.', resolve: (a) => JSON.stringify(a.details ?? {}) }),
    outcome: t.string({
      description: '15-admin R2 — `succeeded`, or `pending`: the action started and its outcome is unknown (check the target).',
      resolve: (a) => a.outcome,
    }),
    createdAt: t.field({ type: 'DateTime', resolve: (a) => a.createdAt }),
  }),
});

const AuditPage = builder
  .objectRef<{ nodes: (AuditRow & { actorName: string })[]; hasNextPage: boolean }>('AuditPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [AuditEntryRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
    }),
  });

// --- queries ---------------------------------------------------------------------------------------

builder.queryFields((t) => ({
  adminOverview: t.field({
    type: OverviewRef,
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      const { scoring } = await import('../../scoring/index.js');
      const { admin } = await import('../index.js');
      const [
        openReports,
        escalated,
        payoutsNeedingAttention,
        accountsForReview,
        openOrganisationInvites,
        suspendedOrganisations,
        moderationCases,
        openTickets,
        fraudCases,
      ] = await Promise.all([
          db.eventReport.count({ where: { status: 'open' } }),
          scoring.escalatedResults(),
          db.payout.count({ where: { status: { in: ['held', 'failed', 'awaiting_funds'] } } }),
          db.payoutAccount.count({ where: { status: 'needs_review' } }),
          db.organisationInvite.count({ where: { claimedAt: null, expiresAt: { gt: new Date() } } }),
          db.organizerProfile.count({ where: { isPersonal: false, verification: 'suspended' } }),
          admin.openReportCount(),
          admin.openTicketCount(),
          admin.openFraudCaseCount(),
        ]);
      return {
        openReports,
        escalatedResults: escalated.length,
        payoutsNeedingAttention,
        accountsForReview,
        openOrganisationInvites,
        suspendedOrganisations,
        moderationCases,
        openTickets,
        fraudCases,
      };
    },
  }),

  adminUsers: t.field({
    type: AdminUserPage,
    description: 'portal — find people by email or name, newest first.',
    args: { search: t.arg.string({ required: true }), first: t.arg.int(), offset: t.arg.int() },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const q = args.search.trim();
      const first = clampFirst(args.first, 25);
      if (q.length < 2) return { nodes: [], hasNextPage: false };
      const rows = await db.user.findMany({
        where: {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
            ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q }] : []),
          ],
        },
        select: USER_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: Math.max(args.offset ?? 0, 0),
        take: first + 1,
      });
      return { nodes: rows.slice(0, first).map(toAdminUser), hasNextPage: rows.length > first };
    },
  }),

  adminUser: t.field({
    type: AdminUserRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return adminUserById(String(args.id));
    },
  }),

  adminEvents: t.field({
    type: AdminEventPage,
    description: 'portal — any event, any status, by title or link; soonest start first.',
    args: {
      search: t.arg.string(),
      status: t.arg({ type: EventStatusEnum }),
      first: t.arg.int(),
      offset: t.arg.int(),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const q = args.search?.trim();
      const first = clampFirst(args.first, 50);
      const where = {
        ...(args.status ? { status: args.status as EventStatus } : {}),
        ...(q
          ? { OR: [{ title: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q.toLowerCase() } }] }
          : {}),
      };
      const [rows, total] = await Promise.all([
        db.event.findMany({
          where,
          select: { id: true },
          orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
          skip: Math.max(args.offset ?? 0, 0),
          take: first + 1,
        }),
        db.event.count({ where }),
      ]);
      const found = await Promise.all(rows.slice(0, first).map((r) => events.findById(r.id)));
      return { nodes: found.filter((e): e is Event => e !== null), hasNextPage: rows.length > first, total };
    },
  }),

  adminStaff: t.field({
    type: [StaffMemberRef],
    resolve: async (_root, _args, ctx) => {
      await requirePlatformStaff(ctx);
      return staffList();
    },
  }),

  adminAuditLog: t.field({
    type: AuditPage,
    description: 'portal — every staff action, newest first. Admins only; narrowed to one target when given.',
    args: {
      targetType: t.arg.string(),
      targetId: t.arg.string(),
      first: t.arg.int(),
      offset: t.arg.int(),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, args.targetId ? ['admin', 'support', 'finance'] : ['admin']);
      const first = clampFirst(args.first, 50);
      const rows = await db.auditLog.findMany({
        where: {
          ...(args.targetType ? { targetType: args.targetType } : {}),
          ...(args.targetId ? { targetId: args.targetId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: Math.max(args.offset ?? 0, 0),
        take: first + 1,
      });
      const names = new Map(
        (await identity.usersByIds(rows.map((r) => r.actorUserId))).map((u) => [u.id, u.displayName]),
      );
      return {
        nodes: rows.slice(0, first).map((r) => ({ ...r, actorName: names.get(r.actorUserId) ?? 'Unknown' })),
        hasNextPage: rows.length > first,
      };
    },
  }),
}));

// --- mutations ------------------------------------------------------------------------------------

builder.mutationFields((t) => ({
  adminRevealContact: t.field({
    type: ContactPayload,
    description: '15-admin R4 — a person’s full email and phone, for a reason that is audited.',
    args: { userId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx);
      const userId = String(args.userId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'user.reveal_contact', targetType: 'user', targetId: userId }, args.reason, async () => {
          const user = await adminUserById(userId);
          if (!user) throw new UserError(AdminCode.USER_NOT_FOUND, 'No such person.');
          return { email: user.email, phone: user.phone };
        }),
      );
      return { email: data?.email ?? null, phone: data?.phone ?? null, userError };
    },
  }),

  adminSuspendUser: t.field({
    type: AdminUserPayload,
    description: 'identity R8 — signs them out everywhere and stops new sign-ins.',
    args: { userId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const userId = String(args.userId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'user.suspend', targetType: 'user', targetId: userId }, args.reason, async (reason) => {
          if (userId === staff.userId) throw new UserError(AdminCode.CANNOT_CHANGE_OWN_ROLE, 'You cannot suspend yourself.');
          if (!(await adminUserById(userId))) throw new UserError(AdminCode.USER_NOT_FOUND, 'No such person.');
          await identity.suspend(userId, reason);
          return adminUserById(userId);
        }),
      );
      return { user: data, userError };
    },
  }),

  adminReinstateUser: t.field({
    type: AdminUserPayload,
    args: { userId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const userId = String(args.userId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'user.reinstate', targetType: 'user', targetId: userId }, args.reason, async (reason) => {
          await identity.reinstate(userId, reason);
          return adminUserById(userId);
        }),
      );
      return { user: data, userError };
    },
  }),

  adminSetPlatformRole: t.field({
    type: StaffPayload,
    description:
      'Admins only: make someone admin, support or finance, or (role null) take it away. ' +
      'By `userId` (staff already listed) or `email` (someone new).',
    args: {
      email: t.arg.string(),
      userId: t.arg.id(),
      role: t.arg({ type: StaffRoleEnum }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin']);
      const { data, userError } = await attempt(async () => {
        const user = args.userId
          ? await adminUserById(String(args.userId))
          : args.email
            ? await identity.findByEmail(args.email)
            : null;
        if (!user) throw new UserError(AdminCode.USER_NOT_FOUND, 'Nobody has a PL4Y account with that email. Ask them to sign up first.');
        if (user.id === staff.userId) {
          throw new UserError(AdminCode.CANNOT_CHANGE_OWN_ROLE, 'You cannot change your own role. Ask another admin.');
        }
        const role = args.role ?? null;
        return audited(
          staff,
          { action: 'platform_staff.set_role', targetType: 'platform_staff', targetId: user.id, details: { role } },
          args.reason,
          async () => {
            await db.$transaction((tx) => identity.setPlatformRole(tx, staff.userId, user.id, role));
            return staffList();
          },
        );
      });
      return { staff: data, userError };
    },
  }),
}));
