/**
 * organisations — GraphQL (PLAY_FRONTEND/docs/modules/27-organisations.md).
 *
 * The public page, what members do from the app, and what PL4Y staff do from
 * the portal (`admin*`, portal sessions only — portal R2). Every staff write
 * takes a reason and is audited (portal R3).
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { audited, requirePlatformStaff, requireReason } from '../../../graphql/staff.js';
import { recordAudit } from '../../../platform/audit.js';
import { db } from '../../../platform/db.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { newId } from '../../../platform/ids.js';
import { UserError, forbidden } from '../../../platform/errors/index.js';
import { EventRef } from '../../events/schema/index.js';
import { events } from '../../events/index.js';
import type { Event } from '../../events/index.js';
import { identity } from '../../identity/index.js';
import { ViewerRef } from '../../identity/schema/index.js';
import { PayoutAccountRef, PayoutRef } from '../../payments/schema/payouts.js';
import { MediaUploadPayload } from '../../venues/schema/index.js';
import { OrgCode, organisations } from '../index.js';
import type { Invite, Member, Organisation, OrgRole } from '../index.js';

// --- access ------------------------------------------------------------------------

interface Access {
  role: OrgRole | null;
  /** A PL4Y staff member on a portal session. */
  staff: boolean;
}

async function accessTo(org: Organisation, ctx: Ctx): Promise<Access> {
  if (!ctx.actor) return { role: null, staff: false };
  const staff = ctx.actor.client === 'portal' && (await ctx.loaders.platformRole.load(ctx.actor.userId)) !== null;
  return { role: await organisations.roleOf(org.id, ctx.actor.userId), staff };
}

const runs = (a: Access) => a.staff || a.role === 'owner' || a.role === 'admin';

// --- types ---------------------------------------------------------------------------

const VerificationEnum = builder.enumType('OrganisationVerification', {
  values: {
    UNVERIFIED: { value: 'unverified' },
    PENDING: { value: 'pending' },
    VERIFIED: { value: 'verified' },
    REJECTED: { value: 'rejected' },
    SUSPENDED: { value: 'suspended' },
  } as const,
});

const RoleEnum = builder.enumType('OrganisationRole', {
  values: { OWNER: { value: 'owner' }, ADMIN: { value: 'admin' }, MEMBER: { value: 'member' } } as const,
});

/** Who may be added: the owner is only ever set by staff (org R2). */
const AddableRoleEnum = builder.enumType('OrganisationAddableRole', {
  values: { ADMIN: { value: 'admin' }, MEMBER: { value: 'member' } } as const,
});

interface MemberShape extends Member {
  displayName: string;
  avatarPublicId: string | null;
}

const MemberRef = builder.objectRef<MemberShape>('OrganisationMember').implement({
  fields: (t) => ({
    userId: t.exposeID('userId'),
    displayName: t.exposeString('displayName'),
    avatarUrl: t.string({ nullable: true, resolve: (m) => cloudinary.url(m.avatarPublicId, TRANSFORMS.avatarSm) }),
    role: t.field({ type: RoleEnum, resolve: (m) => m.role }),
    joinedAt: t.field({ type: 'DateTime', resolve: (m) => m.joinedAt }),
  }),
});

const InviteRef = builder.objectRef<Invite>('OrganisationInvite').implement({
  description: 'Someone added by email before they had a PL4Y account. Signing in with that email claims it.',
  fields: (t) => ({
    id: t.exposeID('id'),
    email: t.exposeString('email'),
    role: t.field({ type: RoleEnum, resolve: (i) => i.role }),
    expiresAt: t.field({ type: 'DateTime', resolve: (i) => i.expiresAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (i) => i.createdAt }),
  }),
});

async function withPeople(members: Member[]): Promise<MemberShape[]> {
  const users = await identity.usersByIds(members.map((m) => m.userId));
  const byId = new Map(users.map((u) => [u.id, u]));
  return members.map((m) => ({
    ...m,
    displayName: byId.get(m.userId)?.displayName ?? 'PL4Y player',
    avatarPublicId: byId.get(m.userId)?.avatarPublicId ?? null,
  }));
}

/** Who sees which of an organisation's events: everyone the public ones, its members and staff all. */
const PUBLIC_STATUSES = ['published', 'live', 'completed'];

const OrganisationRef = builder.objectRef<Organisation>('Organisation').implement({
  description: 'org — a club, academy or company PL4Y verified. Its members host events under its name.',
  fields: (t) => ({
    id: t.exposeID('id'),
    slug: t.exposeString('slug'),
    name: t.exposeString('name'),
    bio: t.string({ nullable: true, resolve: (o) => o.bio }),
    city: t.string({ nullable: true, resolve: (o) => o.city }),
    logoUrl: t.string({ nullable: true, resolve: (o) => cloudinary.url(o.logoPublicId, TRANSFORMS.avatarMd) }),
    contactEmail: t.string({ nullable: true, resolve: (o) => o.contactEmail }),
    contactPhone: t.string({ nullable: true, resolve: (o) => o.contactPhone }),
    verification: t.field({ type: VerificationEnum, resolve: (o) => o.verification }),
    verified: t.boolean({ resolve: (o) => o.verification === 'verified' }),
    createdAt: t.field({ type: 'DateTime', resolve: (o) => o.createdAt }),
    verificationNote: t.string({
      nullable: true,
      description: 'Why it is suspended. PL4Y staff and the organisation’s owner and admins only.',
      resolve: async (o, _args, ctx) => (runs(await accessTo(o, ctx)) ? o.verificationNote : null),
    }),
    eventsHosted: t.int({
      description: 'org R4 — events run to the end.',
      resolve: (o) => organisations.hostedCount(o.id),
    }),
    viewerRole: t.field({
      type: RoleEnum,
      nullable: true,
      resolve: async (o, _args, ctx) => (await accessTo(o, ctx)).role,
    }),
    members: t.field({
      type: [MemberRef],
      description: 'Its members and staff see the team; everyone else an empty list.',
      resolve: async (o, _args, ctx) => {
        const access = await accessTo(o, ctx);
        if (!access.staff && !access.role) return [];
        return withPeople(await organisations.membersOf(o.id));
      },
    }),
    invites: t.field({
      type: [InviteRef],
      description: 'Open invites. The owner, admins and staff only.',
      resolve: async (o, _args, ctx) => (runs(await accessTo(o, ctx)) ? organisations.openInvitesOf(o.id) : []),
    }),
    events: t.field({
      type: [EventRef],
      description: 'org R8 — the public its published and past events; members and staff every one, drafts included.',
      resolve: async (o, _args, ctx) => {
        const access = await accessTo(o, ctx);
        const all = access.staff || access.role !== null;
        const ids = await organisations.eventIdsOf(o.id, all ? undefined : PUBLIC_STATUSES);
        const found = await Promise.all(ids.map((id) => events.findById(id)));
        return found.filter((e): e is Event => e !== null);
      },
    }),
    payoutAccount: t.field({
      type: PayoutAccountRef,
      nullable: true,
      description: 'org R6 — where its money goes. The owner and staff only.',
      resolve: async (o, _args, ctx) => {
        const access = await accessTo(o, ctx);
        if (!access.staff && access.role !== 'owner') return null;
        const { payouts } = await import('../../payments/index.js');
        return payouts.organisationAccount(o.id);
      },
    }),
    payouts: t.field({
      type: [PayoutRef],
      description: 'org R6 — the owner and staff only, newest first.',
      resolve: async (o, _args, ctx) => {
        const access = await accessTo(o, ctx);
        if (!access.staff && access.role !== 'owner') return [];
        const { payouts } = await import('../../payments/index.js');
        return payouts.organisationPayouts(o.id, 20);
      },
    }),
  }),
});

const MembershipRef = builder
  .objectRef<{ organisation: Organisation; role: OrgRole }>('OrganisationMembership')
  .implement({
    fields: (t) => ({
      organisation: t.field({ type: OrganisationRef, resolve: (m) => m.organisation }),
      role: t.field({ type: RoleEnum, resolve: (m) => m.role }),
    }),
  });

builder.objectField(ViewerRef, 'organisations', (t) =>
  t.field({
    type: [MembershipRef],
    description: 'org R6 — the organisations the viewer belongs to, for “Host as” and the Hosting tab.',
    resolve: (v) => organisations.membershipsOf(v.id),
  }),
);

// --- payloads ------------------------------------------------------------------------

const OrganisationPayload = builder
  .objectRef<{ organisation: Organisation | null; userError: UserErrorShape | null }>('OrganisationPayload')
  .implement({
    fields: (t) => ({
      organisation: t.field({ type: OrganisationRef, nullable: true, resolve: (p) => p.organisation }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const CreateOrganisationPayload = builder
  .objectRef<{ organisation: Organisation | null; ownerInvited: boolean; userError: UserErrorShape | null }>(
    'CreateOrganisationPayload',
  )
  .implement({
    fields: (t) => ({
      organisation: t.field({ type: OrganisationRef, nullable: true, resolve: (p) => p.organisation }),
      ownerInvited: t.boolean({
        description: 'The owner had no account, so they were emailed an invite.',
        resolve: (p) => p.ownerInvited,
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const AddMemberPayload = builder
  .objectRef<{ member: MemberShape | null; invite: Invite | null; userError: UserErrorShape | null }>(
    'AddOrganisationMemberPayload',
  )
  .implement({
    fields: (t) => ({
      member: t.field({ type: MemberRef, nullable: true, resolve: (p) => p.member }),
      invite: t.field({
        type: InviteRef,
        nullable: true,
        description: 'Set instead of `member` when the address has no account yet.',
        resolve: (p) => p.invite,
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const OrgOkPayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('OrganisationOkPayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const OrganisationPage = builder
  .objectRef<{ nodes: Organisation[]; hasNextPage: boolean; total: number }>('OrganisationPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [OrganisationRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
      total: t.exposeInt('total'),
    }),
  });

// --- inputs ----------------------------------------------------------------------------

const OrganisationDetailsInput = builder.inputType('OrganisationDetailsInput', {
  description: 'Fields left out are unchanged; null clears one. `name` is PL4Y staff’s to change.',
  fields: (t) => ({
    name: t.string(),
    bio: t.string(),
    city: t.string(),
    logoPublicId: t.string({ description: 'From organisationLogoUploadSignature: `folder/publicId`.' }),
    contactEmail: t.string(),
    contactPhone: t.string(),
  }),
});

const CreateOrganisationInput = builder.inputType('CreateOrganisationInput', {
  fields: (t) => ({
    name: t.string({ required: true }),
    ownerEmail: t.string({ required: true, description: 'Becomes the owner, or is emailed an invite.' }),
    city: t.string(),
    bio: t.string(),
    contactEmail: t.string(),
    contactPhone: t.string(),
  }),
});

type DetailsArg = {
  name?: string | null;
  bio?: string | null;
  city?: string | null;
  logoPublicId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
};

/** GraphQL's "absent" is undefined; the service reads null as "clear it". A null name means unchanged. */
function detailsPatch(input: DetailsArg, organisationId: string) {
  const patch: Parameters<typeof organisations.update>[2] = {};
  if (input.name != null) patch.name = input.name;
  for (const key of ['bio', 'city', 'contactEmail', 'contactPhone'] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.logoPublicId !== undefined) {
    // ADR 0003 §C2 — only an upload made under this organisation's own signature.
    const root = `${cloudinary.folders.organisationRoot(organisationId)}/`;
    if (input.logoPublicId !== null && (!input.logoPublicId.startsWith(root) || input.logoPublicId.length === root.length)) {
      throw new UserError(OrgCode.INVALID_ORGANISATION_FIELD, 'That upload does not belong to this organisation.');
    }
    patch.logoPublicId = input.logoPublicId;
  }
  return patch;
}

async function memberShape(member: Member | null): Promise<MemberShape | null> {
  return member ? ((await withPeople([member]))[0] ?? null) : null;
}

// --- queries ---------------------------------------------------------------------------

builder.queryFields((t) => ({
  organisation: t.field({
    type: OrganisationRef,
    nullable: true,
    description: 'org R8 — an organisation’s page, by slug.',
    args: { slug: t.arg.string({ required: true }) },
    resolve: (_root, args) => organisations.bySlug(args.slug),
  }),

  adminOrganisations: t.field({
    type: OrganisationPage,
    description: 'portal — every organisation, newest first. Staff only.',
    args: {
      search: t.arg.string(),
      verification: t.arg({ type: VerificationEnum }),
      first: t.arg.int(),
      offset: t.arg.int(),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return organisations.list({
        search: args.search,
        verification: args.verification ?? null,
        first: clampFirst(args.first, 50),
        offset: Math.max(args.offset ?? 0, 0),
      });
    },
  }),

  adminOrganisation: t.field({
    type: OrganisationRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return organisations.findById(String(args.id));
    },
  }),
}));

// --- members, in the app ------------------------------------------------------------------

builder.mutationFields((t) => ({
  updateOrganisation: t.field({
    type: OrganisationPayload,
    description: 'The owner or an admin: logo, description, city and contact. Not the name.',
    args: { organisationId: t.arg.id({ required: true }), input: t.arg({ type: OrganisationDetailsInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(() => organisations.update(actor, id, detailsPatch(args.input, id)));
      return { organisation: data, userError };
    },
  }),

  organisationLogoUploadSignature: t.field({
    type: MediaUploadPayload,
    description: 'ADR 0003 §C2 — upload the logo under this signature, then save `folder/publicId` as logoPublicId.',
    args: { organisationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      requireActor(ctx);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(async () => {
        const org = await organisations.byId(id);
        if (!runs(await accessTo(org, ctx))) throw forbidden();
        return cloudinary.signUpload({ publicId: `logo-${newId()}`, folder: cloudinary.folders.organisationRoot(id) });
      });
      return { upload: data, userError };
    },
  }),

  addOrganisationMember: t.field({
    type: AddMemberPayload,
    description: 'The owner adds admins and members; an admin adds members. No account yet: they are emailed an invite.',
    args: {
      organisationId: t.arg.id({ required: true }),
      email: t.arg.string({ required: true }),
      role: t.arg({ type: AddableRoleEnum, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        organisations.addMember(actor, String(args.organisationId), { email: args.email, role: args.role }),
      );
      return { member: await memberShape(data?.member ?? null), invite: data?.invite ?? null, userError };
    },
  }),

  removeOrganisationMember: t.field({
    type: OrgOkPayload,
    args: { organisationId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        organisations.removeMember(actor, String(args.organisationId), String(args.userId)),
      );
      return { ok: userError === null, userError };
    },
  }),

  leaveOrganisation: t.field({
    type: OrgOkPayload,
    description: 'org R9 — your own events stay yours.',
    args: { organisationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => organisations.leave(actor, String(args.organisationId)));
      return { ok: userError === null, userError };
    },
  }),

  cancelOrganisationInvite: t.field({
    type: OrgOkPayload,
    args: { inviteId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => organisations.cancelInvite(actor, String(args.inviteId)));
      return { ok: userError === null, userError };
    },
  }),
}));

// --- staff, in the portal (portal R2, R3) ---------------------------------------------------

const SUPPORT: ('admin' | 'support')[] = ['admin', 'support'];

builder.mutationFields((t) => ({
  adminCreateOrganisation: t.field({
    type: CreateOrganisationPayload,
    description: 'org R1 — created verified, with its owner (or an invite to them).',
    args: { input: t.arg({ type: CreateOrganisationInput, required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const { data, userError } = await attempt(async () => {
        const reason = requireReason(args.reason);
        const created = await organisations.create(staff, {
          name: args.input.name,
          ownerEmail: args.input.ownerEmail,
          city: args.input.city ?? null,
          bio: args.input.bio ?? null,
          contactEmail: args.input.contactEmail ?? null,
          contactPhone: args.input.contactPhone ?? null,
        });
        // Recorded against the id it was just given.
        await recordAudit(db, {
          actorUserId: staff.userId,
          action: 'organisation.create',
          targetType: 'organisation',
          targetId: created.organisation.id,
          reason,
          details: { ownerEmail: args.input.ownerEmail, ownerInvited: created.ownerInvited },
        });
        return created;
      });
      return { organisation: data?.organisation ?? null, ownerInvited: data?.ownerInvited ?? false, userError };
    },
  }),

  adminUpdateOrganisation: t.field({
    type: OrganisationPayload,
    args: {
      organisationId: t.arg.id({ required: true }),
      input: t.arg({ type: OrganisationDetailsInput, required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'organisation.update', targetType: 'organisation', targetId: id }, args.reason, () =>
          organisations.update(staff, id, detailsPatch(args.input, id), true),
        ),
      );
      return { organisation: data, userError };
    },
  }),

  adminSetOrganisationOwner: t.field({
    type: CreateOrganisationPayload,
    description: 'org R2 — the only way ownership moves. The previous owner stays on as an admin.',
    args: {
      organisationId: t.arg.id({ required: true }),
      email: t.arg.string({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: 'organisation.set_owner', targetType: 'organisation', targetId: id, details: { email: args.email } },
          args.reason,
          () => organisations.setOwner(staff, id, args.email),
        ),
      );
      return { organisation: data?.organisation ?? null, ownerInvited: data?.invited ?? false, userError };
    },
  }),

  adminSuspendOrganisation: t.field({
    type: OrganisationPayload,
    description: 'org R7 — no publishing, no entries, payouts held. The reason is shown to its owner.',
    args: { organisationId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'organisation.suspend', targetType: 'organisation', targetId: id }, args.reason, (reason) =>
          organisations.suspend(staff, id, reason),
        ),
      );
      return { organisation: data, userError };
    },
  }),

  adminReinstateOrganisation: t.field({
    type: OrganisationPayload,
    args: { organisationId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'organisation.reinstate', targetType: 'organisation', targetId: id }, args.reason, () =>
          organisations.reinstate(staff, id),
        ),
      );
      return { organisation: data, userError };
    },
  }),

  adminAddOrganisationMember: t.field({
    type: AddMemberPayload,
    args: {
      organisationId: t.arg.id({ required: true }),
      email: t.arg.string({ required: true }),
      role: t.arg({ type: AddableRoleEnum, required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const id = String(args.organisationId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          {
            action: 'organisation.add_member',
            targetType: 'organisation',
            targetId: id,
            details: { email: args.email, role: args.role },
          },
          args.reason,
          () => organisations.addMember(staff, id, { email: args.email, role: args.role }, true),
        ),
      );
      return { member: await memberShape(data?.member ?? null), invite: data?.invite ?? null, userError };
    },
  }),

  adminRemoveOrganisationMember: t.field({
    type: OrgOkPayload,
    args: {
      organisationId: t.arg.id({ required: true }),
      userId: t.arg.id({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const id = String(args.organisationId);
      const { userError } = await attempt(() =>
        audited(
          staff,
          {
            action: 'organisation.remove_member',
            targetType: 'organisation',
            targetId: id,
            details: { userId: String(args.userId) },
          },
          args.reason,
          () => organisations.removeMember(staff, id, String(args.userId), true),
        ),
      );
      return { ok: userError === null, userError };
    },
  }),

  adminResendOrganisationInvite: t.field({
    type: OrgOkPayload,
    args: { inviteId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const inviteId = String(args.inviteId);
      const { userError } = await attempt(async () => {
        const reason = requireReason(args.reason);
        const invite = await organisations.resendInvite(staff, inviteId, true);
        await recordAudit(db, {
          actorUserId: staff.userId,
          action: 'organisation.resend_invite',
          targetType: 'organisation',
          targetId: invite.organisationId,
          reason,
          details: { email: invite.email },
        });
      });
      return { ok: userError === null, userError };
    },
  }),

  adminCancelOrganisationInvite: t.field({
    type: OrgOkPayload,
    args: { inviteId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, SUPPORT);
      const inviteId = String(args.inviteId);
      const { userError } = await attempt(async () => {
        const reason = requireReason(args.reason);
        const invite = await organisations.cancelInvite(staff, inviteId, true);
        await recordAudit(db, {
          actorUserId: staff.userId,
          action: 'organisation.cancel_invite',
          targetType: 'organisation',
          targetId: invite.organisationId,
          reason,
          details: { email: invite.email },
        });
      });
      return { ok: userError === null, userError };
    },
  }),
}));

export { MembershipRef, OrganisationRef };
