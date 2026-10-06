/**
 * organisations — organiser accounts (PLAY_FRONTEND/docs/modules/27-organisations.md,
 * PALY_BACKEND/docs/modules/14-organizers.md).
 *
 * An organisation is a club, academy or company that PL4Y staff create (org R1).
 * Its members host events under its name; its owner and admins run every one
 * of them (org R5) through organizer-sourced grants, which only
 * `identity.syncOrganizerGrants` writes (identity R16).
 *
 * 014's `is_personal` profiles stand for a player hosting as themselves. They
 * are never listed, never shown and never managed here.
 */
import type { Db, Tx } from '../../../platform/db.js';
import { newId } from '../../../platform/ids.js';
import { UserError, forbidden } from '../../../platform/errors/index.js';

export const OrgCode = {
  ORGANISATION_NOT_FOUND: 'ORGANISATION_NOT_FOUND',
  INVALID_ORGANISATION_FIELD: 'INVALID_ORGANISATION_FIELD',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  CANNOT_REMOVE_OWNER: 'CANNOT_REMOVE_OWNER',
  OWNER_CANNOT_LEAVE: 'OWNER_CANNOT_LEAVE',
  ORGANISATION_SUSPENDED: 'ORGANISATION_SUSPENDED',
  INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
} as const;

export type OrgRole = 'owner' | 'admin' | 'member';
export type Verification = 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended';

export interface Organisation {
  id: string;
  slug: string;
  name: string;
  bio: string | null;
  city: string | null;
  logoPublicId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  verification: Verification;
  verificationNote: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface Member {
  userId: string;
  role: OrgRole;
  joinedAt: Date;
}

export interface Invite {
  id: string;
  organisationId: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
  claimedAt: Date | null;
  createdAt: Date;
}

export interface OrganisationInput {
  name?: string;
  bio?: string | null;
  city?: string | null;
  logoPublicId?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface OrganisationDeps {
  db: Db;
  identity: {
    findByEmail(email: string): Promise<{ id: string; displayName: string } | null>;
    syncOrganizerGrants(
      tx: Tx,
      input: { organizerProfileId: string; userId: string; eventIds: string[] | 'all'; role: 'owner' | 'manager' | 'scorer' | null },
    ): Promise<void>;
  };
  /** A person's notification. Absent in tests that do not read them. */
  notify?(userId: string, organisation: Organisation, change: 'added' | 'owner' | 'removed' | 'suspended' | 'reinstated', role: OrgRole | null): Promise<void>;
  /** The invite email to someone with no account yet. */
  sendInvite?(to: string, organisation: Organisation, role: OrgRole, expiresAt: Date): Promise<void>;
  /** org R2 — an organisation's bank account follows its owner. */
  payouts?: { setOrganisationAccountHolder(organisationId: string, userId: string, tx?: Tx): Promise<void> };
  now?: () => Date;
}

/** org — an invite waits two weeks for its person to sign up. */
export const INVITE_TTL_MS = 14 * 24 * 3_600_000;

const NAME_MAX = 80;
const BIO_MAX = 600;
const CITY_MAX = 60;
const PHONE_MAX = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** org R5 — what membership means on each of the organisation's events. */
const GRANT_FOR: Record<OrgRole, 'owner' | 'manager' | null> = { owner: 'owner', admin: 'manager', member: null };

/** Ended or cancelled events keep their history: a new owner takes over what is still running. */
const OPEN_EVENT_STATUSES = ['draft', 'published', 'live'];

type Row = Awaited<ReturnType<Db['organizerProfile']['findUniqueOrThrow']>>;

function toOrganisation(r: Row): Organisation {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    bio: r.bio,
    city: r.city,
    logoPublicId: r.logoPublicId,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    verification: r.verification as Verification,
    verificationNote: r.verificationNote,
    verifiedAt: r.verifiedAt,
    createdAt: r.createdAt,
  };
}

const invalid = (message: string) => new UserError(OrgCode.INVALID_ORGANISATION_FIELD, message);
const notFound = () => new UserError(OrgCode.ORGANISATION_NOT_FOUND, 'That organisation could not be found.');

export function slugifyName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return base || 'organisation';
}

function trimmedOrNull(v: string | null | undefined): string | null {
  const t = v?.trim() ?? '';
  return t === '' ? null : t;
}

export function createOrganisationService(deps: OrganisationDeps) {
  const { db, identity } = deps;
  const now = deps.now ?? (() => new Date());

  // --- reads -------------------------------------------------------------------

  async function findById(id: string, conn: Db | Tx = db): Promise<Organisation | null> {
    const row = await conn.organizerProfile.findUnique({ where: { id } });
    return row && !row.isPersonal ? toOrganisation(row) : null;
  }

  async function byId(id: string, conn: Db | Tx = db): Promise<Organisation> {
    const found = await findById(id, conn);
    if (!found) throw notFound();
    return found;
  }

  async function bySlug(slug: string): Promise<Organisation | null> {
    const row = await db.organizerProfile.findUnique({ where: { slug } });
    return row && !row.isPersonal ? toOrganisation(row) : null;
  }

  async function byIds(ids: string[]): Promise<Organisation[]> {
    if (ids.length === 0) return [];
    const rows = await db.organizerProfile.findMany({ where: { id: { in: [...new Set(ids)] }, isPersonal: false } });
    return rows.map(toOrganisation);
  }

  /** portal — every organisation, newest first, by name or slug. */
  async function list(filter: {
    search?: string | null;
    verification?: Verification | null;
    first: number;
    offset?: number;
  }): Promise<{ nodes: Organisation[]; hasNextPage: boolean; total: number }> {
    const q = filter.search?.trim();
    const where = {
      isPersonal: false,
      ...(filter.verification ? { verification: filter.verification } : {}),
      ...(q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { slug: { contains: q.toLowerCase() } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.organizerProfile.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: filter.offset ?? 0,
        take: filter.first + 1,
      }),
      db.organizerProfile.count({ where }),
    ]);
    return { nodes: rows.slice(0, filter.first).map(toOrganisation), hasNextPage: rows.length > filter.first, total };
  }

  async function membersOf(organisationId: string): Promise<Member[]> {
    const rows = await db.organizerMember.findMany({
      where: { organizerProfileId: organisationId },
      orderBy: [{ createdAt: 'asc' }],
    });
    const rank: Record<string, number> = { owner: 0, admin: 1, member: 2 };
    return rows
      .map((r) => ({ userId: r.userId, role: r.role as OrgRole, joinedAt: r.createdAt }))
      .sort((a, b) => rank[a.role]! - rank[b.role]!);
  }

  async function openInvitesOf(organisationId: string): Promise<Invite[]> {
    const rows = await db.organisationInvite.findMany({
      where: { organizerProfileId: organisationId, claimedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toInvite);
  }

  function toInvite(r: Awaited<ReturnType<Db['organisationInvite']['findUniqueOrThrow']>>): Invite {
    return {
      id: r.id,
      organisationId: r.organizerProfileId,
      email: r.email,
      role: r.role as OrgRole,
      expiresAt: r.expiresAt,
      claimedAt: r.claimedAt,
      createdAt: r.createdAt,
    };
  }

  async function roleOf(organisationId: string, userId: string, conn: Db | Tx = db): Promise<OrgRole | null> {
    const row = await conn.organizerMember.findUnique({
      where: { organizerProfileId_userId: { organizerProfileId: organisationId, userId } },
    });
    return (row?.role as OrgRole | undefined) ?? null;
  }

  async function ownerOf(organisationId: string, conn: Db | Tx = db): Promise<string | null> {
    const row = await conn.organizerMember.findFirst({ where: { organizerProfileId: organisationId, role: 'owner' } });
    return row?.userId ?? null;
  }

  /** Viewer.organisations — every real organisation the user belongs to. */
  async function membershipsOf(userId: string): Promise<{ organisation: Organisation; role: OrgRole }[]> {
    const rows = await db.organizerMember.findMany({
      where: { userId, organisation: { isPersonal: false } },
      include: { organisation: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ organisation: toOrganisation(r.organisation), role: r.role as OrgRole }));
  }

  /** The organisation's events, soonest first: drafts only for its members (the caller decides). */
  async function eventIdsOf(organisationId: string, statuses?: string[]): Promise<string[]> {
    const rows = await db.event.findMany({
      where: { organizerProfileId: organisationId, ...(statuses ? { status: { in: statuses } } : {}) },
      select: { id: true },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => r.id);
  }

  /** org R4 — events run to the end, the trust line on the organisation's page. */
  async function hostedCount(organisationId: string): Promise<number> {
    return db.event.count({ where: { organizerProfileId: organisationId, status: 'completed' } });
  }

  // --- validation ----------------------------------------------------------------

  function cleanFields(input: OrganisationInput): OrganisationInput {
    const out: OrganisationInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim().replace(/\s+/g, ' ');
      if (name.length < 2) throw invalid('Give the organisation a name of at least 2 characters.');
      if (name.length > NAME_MAX) throw invalid(`Keep the name under ${NAME_MAX} characters.`);
      out.name = name;
    }
    if (input.bio !== undefined) {
      const bio = trimmedOrNull(input.bio);
      if (bio && bio.length > BIO_MAX) throw invalid(`Keep the description under ${BIO_MAX} characters.`);
      out.bio = bio;
    }
    if (input.city !== undefined) {
      const city = trimmedOrNull(input.city);
      if (city && city.length > CITY_MAX) throw invalid(`Keep the city under ${CITY_MAX} characters.`);
      out.city = city;
    }
    if (input.contactEmail !== undefined) {
      const email = trimmedOrNull(input.contactEmail)?.toLowerCase() ?? null;
      if (email && !EMAIL_RE.test(email)) throw invalid('That contact email does not look right.');
      out.contactEmail = email;
    }
    if (input.contactPhone !== undefined) {
      const phone = trimmedOrNull(input.contactPhone);
      if (phone && (phone.length > PHONE_MAX || !/^\+?[0-9 ()-]{6,}$/.test(phone))) {
        throw invalid('That contact phone does not look right.');
      }
      out.contactPhone = phone;
    }
    if (input.logoPublicId !== undefined) out.logoPublicId = trimmedOrNull(input.logoPublicId);
    return out;
  }

  function cleanEmail(raw: string): string {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw invalid('Enter a valid email address.');
    return email;
  }

  async function uniqueSlug(name: string, conn: Db | Tx): Promise<string> {
    const base = slugifyName(name);
    for (let n = 1; n < 1000; n += 1) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (!(await conn.organizerProfile.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
    }
    return `${base}-${newId().slice(0, 8)}`;
  }

  // --- grants (org R5) -------------------------------------------------------------

  /** One member's grants on every event the organisation hosts, to match their role. */
  async function syncMember(tx: Tx, organisationId: string, userId: string, role: OrgRole | null): Promise<void> {
    const eventIds = (
      await tx.event.findMany({ where: { organizerProfileId: organisationId }, select: { id: true } })
    ).map((e) => e.id);
    if (eventIds.length === 0) return;
    await identity.syncOrganizerGrants(tx, {
      organizerProfileId: organisationId,
      userId,
      eventIds,
      role: role ? GRANT_FOR[role] : null,
    });
  }

  /** A new event hosted as the organisation: its owner and admins run it from the first instant. */
  async function syncEventGrants(tx: Tx, organisationId: string, eventId: string): Promise<void> {
    const members = await tx.organizerMember.findMany({
      where: { organizerProfileId: organisationId, role: { in: ['owner', 'admin'] } },
    });
    for (const m of members) {
      await identity.syncOrganizerGrants(tx, {
        organizerProfileId: organisationId,
        userId: m.userId,
        eventIds: [eventId],
        role: GRANT_FOR[m.role as OrgRole],
      });
    }
  }

  /**
   * org R3 — may this person host an event as the organisation? Members may;
   * a suspended organisation hosts nothing (R7). Returns who the event's
   * owner is: the organisation's.
   */
  async function forHosting(organisationId: string, userId: string): Promise<{ ownerId: string; role: OrgRole }> {
    const org = await findById(organisationId);
    if (!org) throw notFound();
    const role = await roleOf(organisationId, userId);
    if (!role) throw new UserError(OrgCode.NOT_A_MEMBER, 'You are not a member of that organisation.');
    if (org.verification === 'suspended') {
      throw new UserError(OrgCode.ORGANISATION_SUSPENDED, `${org.name} is suspended and cannot host events right now.`);
    }
    const ownerId = await ownerOf(organisationId);
    if (!ownerId) throw new UserError(OrgCode.ORGANISATION_SUSPENDED, `${org.name} has no owner yet, so it cannot host events.`);
    return { ownerId, role };
  }

  // --- membership changes ----------------------------------------------------------

  /**
   * org R2 — the one way ownership moves. The previous owner stays on as an
   * admin; the organisation's running events, and its bank account's notices,
   * go to the new owner.
   */
  async function makeOwnerTx(tx: Tx, organisationId: string, userId: string): Promise<void> {
    const previous = await ownerOf(organisationId, tx);
    if (previous === userId) return;
    if (previous) {
      await tx.organizerMember.update({
        where: { organizerProfileId_userId: { organizerProfileId: organisationId, userId: previous } },
        data: { role: 'admin' },
      });
      await syncMember(tx, organisationId, previous, 'admin');
    }
    await tx.organizerMember.upsert({
      where: { organizerProfileId_userId: { organizerProfileId: organisationId, userId } },
      create: { organizerProfileId: organisationId, userId, role: 'owner' },
      update: { role: 'owner' },
    });
    await syncMember(tx, organisationId, userId, 'owner');
    await tx.event.updateMany({
      where: { organizerProfileId: organisationId, status: { in: OPEN_EVENT_STATUSES } },
      data: { organizerId: userId },
    });
    await deps.payouts?.setOrganisationAccountHolder(organisationId, userId, tx);
  }

  /** An invite for someone with no account yet; one open invite per address, renewed when sent again. */
  async function inviteTx(
    tx: Tx,
    organisationId: string,
    email: string,
    role: OrgRole,
    invitedBy: string,
  ): Promise<Invite> {
    const expiresAt = new Date(now().getTime() + INVITE_TTL_MS);
    const open = await tx.organisationInvite.findFirst({
      where: { organizerProfileId: organisationId, email, claimedAt: null },
    });
    const row = open
      ? await tx.organisationInvite.update({ where: { id: open.id }, data: { role, expiresAt, invitedBy } })
      : await tx.organisationInvite.create({
          data: { id: newId(), organizerProfileId: organisationId, email, role, invitedBy, expiresAt },
        });
    // Only one person can be invited to own it.
    if (role === 'owner') {
      await tx.organisationInvite.deleteMany({
        where: { organizerProfileId: organisationId, role: 'owner', claimedAt: null, id: { not: row.id } },
      });
    }
    return toInvite(row);
  }

  /** org R1 — staff create an organisation, verified, with its owner or an invite to them. */
  async function create(
    staff: { userId: string },
    input: OrganisationInput & { name: string; ownerEmail: string },
  ): Promise<{ organisation: Organisation; ownerInvited: boolean }> {
    const fields = cleanFields(input);
    const ownerEmail = cleanEmail(input.ownerEmail);
    const owner = await identity.findByEmail(ownerEmail);
    const id = newId();
    const at = now();

    const invite = await db.$transaction(async (tx) => {
      await tx.organizerProfile.create({
        data: {
          id,
          slug: await uniqueSlug(fields.name!, tx),
          name: fields.name!,
          bio: fields.bio ?? null,
          city: fields.city ?? null,
          logoPublicId: fields.logoPublicId ?? null,
          contactEmail: fields.contactEmail ?? null,
          contactPhone: fields.contactPhone ?? null,
          // Staff creating it is the verification (org R1).
          verification: 'verified',
          verifiedAt: at,
          isPersonal: false,
          createdBy: staff.userId,
        },
      });
      if (owner) {
        await tx.organizerMember.create({ data: { organizerProfileId: id, userId: owner.id, role: 'owner' } });
        return null;
      }
      return inviteTx(tx, id, ownerEmail, 'owner', staff.userId);
    });

    const organisation = await byId(id);
    if (owner) await deps.notify?.(owner.id, organisation, 'owner', 'owner');
    if (invite) await deps.sendInvite?.(ownerEmail, organisation, 'owner', invite.expiresAt);
    return { organisation, ownerInvited: invite !== null };
  }

  /**
   * Staff change anything; an owner or admin changes how the organisation
   * presents itself, never its name (that is who PL4Y verified).
   */
  async function update(
    actor: { userId: string },
    organisationId: string,
    patch: OrganisationInput,
    asStaff = false,
  ): Promise<Organisation> {
    const org = await byId(organisationId);
    if (!asStaff) {
      const role = await roleOf(organisationId, actor.userId);
      if (role !== 'owner' && role !== 'admin') throw forbidden();
      if (patch.name !== undefined && patch.name.trim() !== org.name) {
        throw invalid('Only PL4Y can change an organisation’s name. Contact support.');
      }
    }
    const fields = cleanFields(patch);
    await db.organizerProfile.update({ where: { id: organisationId }, data: { ...fields, updatedAt: now() } });
    return byId(organisationId);
  }

  /** org R2 — staff only. An address with no account gets an owner invite instead. */
  async function setOwner(
    staff: { userId: string },
    organisationId: string,
    rawEmail: string,
  ): Promise<{ organisation: Organisation; invited: boolean }> {
    const organisation = await byId(organisationId);
    const email = cleanEmail(rawEmail);
    const user = await identity.findByEmail(email);
    if (!user) {
      const invite = await db.$transaction((tx) => inviteTx(tx, organisationId, email, 'owner', staff.userId));
      await deps.sendInvite?.(email, organisation, 'owner', invite.expiresAt);
      return { organisation, invited: true };
    }
    await db.$transaction((tx) => makeOwnerTx(tx, organisationId, user.id));
    await deps.notify?.(user.id, organisation, 'owner', 'owner');
    return { organisation, invited: false };
  }

  /** org R7 — staff only. Publishing and entries stop; payouts for its events are held. */
  async function suspend(_staff: { userId: string }, organisationId: string, reason: string): Promise<Organisation> {
    await byId(organisationId);
    await db.organizerProfile.update({
      where: { id: organisationId },
      data: { verification: 'suspended', verificationNote: reason.trim(), updatedAt: now() },
    });
    const organisation = await byId(organisationId);
    const owner = await ownerOf(organisationId);
    if (owner) await deps.notify?.(owner, organisation, 'suspended', null);
    return organisation;
  }

  async function reinstate(_staff: { userId: string }, organisationId: string): Promise<Organisation> {
    const org = await byId(organisationId);
    if (org.verification !== 'suspended') return org;
    await db.organizerProfile.update({
      where: { id: organisationId },
      data: { verification: 'verified', verificationNote: null, verifiedAt: now(), updatedAt: now() },
    });
    const organisation = await byId(organisationId);
    const owner = await ownerOf(organisationId);
    if (owner) await deps.notify?.(owner, organisation, 'reinstated', null);
    return organisation;
  }

  /**
   * Who may add whom: staff anyone, the owner admins and members, an admin
   * members. An address with no account gets an invite.
   */
  async function addMember(
    actor: { userId: string },
    organisationId: string,
    input: { email: string; role: 'admin' | 'member' },
    asStaff = false,
  ): Promise<{ member: Member | null; invite: Invite | null }> {
    const organisation = await byId(organisationId);
    if (input.role !== 'admin' && input.role !== 'member') throw invalid('Pick admin or member.');
    if (!asStaff) {
      const mine = await roleOf(organisationId, actor.userId);
      if (mine !== 'owner' && mine !== 'admin') throw forbidden();
      if (input.role === 'admin' && mine !== 'owner') throw forbidden();
    }
    const email = cleanEmail(input.email);
    const user = await identity.findByEmail(email);

    if (!user) {
      const invite = await db.$transaction((tx) => inviteTx(tx, organisationId, email, input.role, actor.userId));
      await deps.sendInvite?.(email, organisation, input.role, invite.expiresAt);
      return { member: null, invite };
    }

    const existing = await roleOf(organisationId, user.id);
    if (existing) throw new UserError(OrgCode.ALREADY_MEMBER, 'That person is already in this organisation.');
    const member = await db.$transaction(async (tx) => {
      const row = await tx.organizerMember.create({
        data: { organizerProfileId: organisationId, userId: user.id, role: input.role },
      });
      await syncMember(tx, organisationId, user.id, input.role);
      return { userId: row.userId, role: row.role as OrgRole, joinedAt: row.createdAt };
    });
    await deps.notify?.(user.id, organisation, 'added', input.role);
    return { member, invite: null };
  }

  /** The owner is never removed, only replaced (org R2). Admins remove members; the owner, anyone else. */
  async function removeMember(
    actor: { userId: string },
    organisationId: string,
    userId: string,
    asStaff = false,
  ): Promise<void> {
    const organisation = await byId(organisationId);
    const theirs = await roleOf(organisationId, userId);
    if (!theirs) return;
    if (theirs === 'owner') {
      throw new UserError(OrgCode.CANNOT_REMOVE_OWNER, 'The owner cannot be removed. PL4Y can make someone else the owner.');
    }
    if (!asStaff) {
      const mine = await roleOf(organisationId, actor.userId);
      if (mine !== 'owner' && mine !== 'admin') throw forbidden();
      if (theirs === 'admin' && mine !== 'owner') throw forbidden();
    }
    await db.$transaction(async (tx) => {
      await tx.organizerMember.delete({
        where: { organizerProfileId_userId: { organizerProfileId: organisationId, userId } },
      });
      await syncMember(tx, organisationId, userId, null);
    });
    await deps.notify?.(userId, organisation, 'removed', null);
  }

  /** org R9 — leaving never touches the person's own events. */
  async function leave(actor: { userId: string }, organisationId: string): Promise<void> {
    await byId(organisationId);
    const mine = await roleOf(organisationId, actor.userId);
    if (!mine) return;
    if (mine === 'owner') {
      throw new UserError(OrgCode.OWNER_CANNOT_LEAVE, 'The owner cannot leave. Ask PL4Y to make someone else the owner first.');
    }
    await db.$transaction(async (tx) => {
      await tx.organizerMember.delete({
        where: { organizerProfileId_userId: { organizerProfileId: organisationId, userId: actor.userId } },
      });
      await syncMember(tx, organisationId, actor.userId, null);
    });
  }

  async function inviteOrThrow(inviteId: string): Promise<Invite> {
    const row = await db.organisationInvite.findUnique({ where: { id: inviteId } });
    if (!row || row.claimedAt) throw new UserError(OrgCode.INVITE_NOT_FOUND, 'That invite is no longer open.');
    return toInvite(row);
  }

  async function assertCanInvite(actor: { userId: string }, invite: Invite, asStaff: boolean): Promise<void> {
    if (asStaff) return;
    const mine = await roleOf(invite.organisationId, actor.userId);
    if (mine !== 'owner' && mine !== 'admin') throw forbidden();
    if (invite.role !== 'member' && mine !== 'owner') throw forbidden();
  }

  async function resendInvite(actor: { userId: string }, inviteId: string, asStaff = false): Promise<Invite> {
    const invite = await inviteOrThrow(inviteId);
    await assertCanInvite(actor, invite, asStaff);
    const expiresAt = new Date(now().getTime() + INVITE_TTL_MS);
    const row = await db.organisationInvite.update({ where: { id: inviteId }, data: { expiresAt } });
    await deps.sendInvite?.(invite.email, await byId(invite.organisationId), invite.role, expiresAt);
    return toInvite(row);
  }

  async function cancelInvite(actor: { userId: string }, inviteId: string, asStaff = false): Promise<Invite> {
    const invite = await inviteOrThrow(inviteId);
    await assertCanInvite(actor, invite, asStaff);
    await db.organisationInvite.delete({ where: { id: inviteId } });
    return invite;
  }

  /**
   * identity's sign-in hook: every open invite to this address becomes a
   * membership (or the ownership) the moment its person signs in.
   */
  async function claimInvites(user: { userId: string; email: string }): Promise<number> {
    const open = await db.organisationInvite.findMany({
      where: { email: user.email.toLowerCase(), claimedAt: null, expiresAt: { gt: now() } },
      orderBy: { createdAt: 'asc' },
    });
    let claimed = 0;
    for (const invite of open) {
      const role = invite.role as OrgRole;
      const took = await db.$transaction(async (tx) => {
        const { count } = await tx.organisationInvite.updateMany({
          where: { id: invite.id, claimedAt: null },
          data: { claimedAt: now(), claimedBy: user.userId },
        });
        if (count !== 1) return false;
        if (role === 'owner') {
          await makeOwnerTx(tx, invite.organizerProfileId, user.userId);
          return true;
        }
        if (await roleOf(invite.organizerProfileId, user.userId, tx)) return true;
        await tx.organizerMember.create({
          data: { organizerProfileId: invite.organizerProfileId, userId: user.userId, role },
        });
        await syncMember(tx, invite.organizerProfileId, user.userId, role);
        return true;
      });
      if (!took) continue;
      claimed += 1;
      const organisation = await findById(invite.organizerProfileId);
      if (organisation) await deps.notify?.(user.userId, organisation, role === 'owner' ? 'owner' : 'added', role);
    }
    return claimed;
  }

  return {
    findById,
    byId,
    bySlug,
    byIds,
    list,
    membersOf,
    openInvitesOf,
    roleOf,
    ownerOf,
    membershipsOf,
    eventIdsOf,
    hostedCount,
    forHosting,
    syncEventGrants,
    create,
    update,
    setOwner,
    suspend,
    reinstate,
    addMember,
    removeMember,
    leave,
    resendInvite,
    cancelInvite,
    claimInvites,
  };
}

export type OrganisationService = ReturnType<typeof createOrganisationService>;
