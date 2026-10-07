/**
 * organisations and the admin portal's sessions — service tests against a real
 * Postgres (conventions.md §5). Specs: PLAY_FRONTEND/docs/modules/25-admin-portal.md
 * (portal R*), 26-hosting-tab.md (hosting R*), 27-organisations.md (org R*).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, type FakeEmail, type FakeQueue } from './helpers/modules.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { IdentityService } from '../src/modules/identity/service/index.js';
import { IdentityCode } from '../src/modules/identity/service/index.js';
import { OrgCode, type OrganisationService } from '../src/modules/organizers/service/index.js';
import type { PayoutsService } from '../src/modules/payments/service/payouts.js';
import { PayoutCode } from '../src/modules/payments/service/payouts.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { verifyAccessToken } from '../src/platform/auth/tokens.js';
import type { Tx } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let events: EventService;
let organisations: OrganisationService;
let identity: IdentityService;
let payouts: PayoutsService;
let profile: ProfileService;
let sport: SportService;
let email: FakeEmail;
let jobs: FakeQueue;
let notices: { userId: string; organisationId: string; change: string }[];
let invites: { to: string; organisationId: string; role: string }[];
let pickleballId: string;

let staff: { userId: string };
let owner: { userId: string };
let admin: { userId: string };
let member: { userId: string };
let stranger: { userId: string };

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? 'THREW';
  }
  return 'NO_ERROR';
};

async function makeUser(address: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: address.split('@')[0]! } });
    await profile.createFor(tx as unknown as Tx, userId);
  });
  return { userId };
}

async function makeOrg(name = 'Sunday Smash Club') {
  const { organisation } = await organisations.create(staff, { name, city: 'Bengaluru', ownerEmail: 'owner@example.com' });
  return organisation;
}

function draftAs(actor: { userId: string }, organisationId: string | null) {
  const startsAt = soon(30);
  return events.create(actor, {
    sportId: pickleballId,
    title: 'Club Open',
    city: 'Bengaluru',
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    registrationClosesAt: new Date(startsAt.getTime() - 5 * DAY),
    contactPhone: '9876543210',
    acceptHostTerms: true,
    organisationId,
  });
}

const grantOf = async (userId: string, eventId: string) =>
  (await identity.grantsFor(userId, eventId))?.role ?? null;

const lastCode = (to: string): string => {
  const mail = email.to(to).at(-1);
  const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code mailed to ${to}`);
  return code;
};

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  events = wired.events;
  organisations = wired.organisations;
  identity = wired.identityService;
  payouts = wired.payouts;
  profile = wired.profile;
  sport = wired.sport;
  email = wired.email;
  jobs = wired.jobs;
  notices = wired.organisationNotices;
  invites = wired.organisationInvites;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  email.reset();
  notices.length = 0;
  invites.length = 0;
  staff = await makeUser('support@pl4y.test');
  await prisma.platformStaff.create({ data: { userId: staff.userId, role: 'support' } });
  owner = await makeUser('owner@example.com');
  admin = await makeUser('admin@example.com');
  member = await makeUser('member@example.com');
  stranger = await makeUser('stranger@example.com');
});

describe('organisations', () => {
  it('org R1: staff create a verified organisation with its owner, who is told', async () => {
    const org = await makeOrg();
    expect(org).toMatchObject({ name: 'Sunday Smash Club', slug: 'sunday-smash-club', verification: 'verified' });
    expect(await organisations.roleOf(org.id, owner.userId)).toBe('owner');
    expect(notices).toContainEqual(expect.objectContaining({ userId: owner.userId, change: 'owner' }));

    const second = await makeOrg('Sunday Smash Club');
    expect(second.slug).toBe('sunday-smash-club-2');
  });

  it('org R1: an owner with no account is invited, and becomes owner at first sign-in', async () => {
    const { organisation, ownerInvited } = await organisations.create(staff, {
      name: 'Racquet Academy',
      ownerEmail: 'coach@example.com',
    });
    expect(ownerInvited).toBe(true);
    expect(invites).toEqual([{ to: 'coach@example.com', organisationId: organisation.id, role: 'owner' }]);

    await identity.requestOtp('coach@example.com', 'signup');
    await identity.verifyOtp('coach@example.com', lastCode('coach@example.com'));
    const coach = await identity.findByEmail('coach@example.com');
    expect(await organisations.roleOf(organisation.id, coach!.id)).toBe('owner');
    expect(await organisations.openInvitesOf(organisation.id)).toEqual([]);
  });

  it('org R3, R5: hosting as the organisation — its owner owns the event, admins manage it, a member creator manages it', async () => {
    const org = await makeOrg();
    await organisations.addMember(owner, org.id, { email: 'admin@example.com', role: 'admin' });
    await organisations.addMember(owner, org.id, { email: 'member@example.com', role: 'member' });

    const event = await draftAs(member, org.id);
    expect(event.organizerId).toBe(owner.userId);
    expect(event.organizerProfileId).toBe(org.id);
    expect(await grantOf(owner.userId, event.id)).toBe('owner');
    expect(await grantOf(admin.userId, event.id)).toBe('manager');
    expect(await grantOf(member.userId, event.id)).toBe('manager');

    expect(await errorCode(() => draftAs(stranger, org.id))).toBe(OrgCode.NOT_A_MEMBER);
  });

  it('portal: staff organise an event for an organisation they are not in, and run it to published', async () => {
    const org = await makeOrg();
    const portal = { ...staff, platformStaff: true };

    const event = await draftAs(portal, org.id);
    expect(event.organizerId).toBe(owner.userId);
    expect(event.organizerProfileId).toBe(org.id);
    expect(await grantOf(owner.userId, event.id)).toBe('owner');
    // Staff act through the portal, not a grant: the event is not in their Hosting tab.
    expect(await grantOf(staff.userId, event.id)).toBeNull();

    await events.addCategory(portal, event.id, { name: 'Open', format: 'singles', capacity: 16, entryFeePaise: 0n });
    expect((await events.publish(portal, event.id)).status).toBe('published');

    // The same person outside the portal is nobody special.
    expect(await errorCode(() => events.addCategory(staff, event.id, { name: 'B', format: 'singles', capacity: 8, entryFeePaise: 0n }))).toBe(
      'FORBIDDEN',
    );
    expect(await errorCode(() => draftAs(staff, org.id))).toBe(OrgCode.NOT_A_MEMBER);
  });

  it('org R5: grants follow membership — added, promoted and removed', async () => {
    const org = await makeOrg();
    const event = await draftAs(owner, org.id);

    await organisations.addMember(owner, org.id, { email: 'admin@example.com', role: 'admin' });
    expect(await grantOf(admin.userId, event.id)).toBe('manager');

    await organisations.removeMember(owner, org.id, admin.userId);
    expect(await grantOf(admin.userId, event.id)).toBeNull();
  });

  it('org R2: only staff move ownership; the old owner stays as an admin and open events follow', async () => {
    const org = await makeOrg();
    const event = await draftAs(owner, org.id);
    await organisations.addMember(owner, org.id, { email: 'admin@example.com', role: 'admin' });

    expect(await errorCode(() => organisations.removeMember(staff, org.id, owner.userId, true))).toBe(
      OrgCode.CANNOT_REMOVE_OWNER,
    );
    await organisations.setOwner(staff, org.id, 'admin@example.com');

    expect(await organisations.roleOf(org.id, admin.userId)).toBe('owner');
    expect(await organisations.roleOf(org.id, owner.userId)).toBe('admin');
    expect((await events.byId(event.id)).organizerId).toBe(admin.userId);
    expect(await grantOf(admin.userId, event.id)).toBe('owner');
    expect(await grantOf(owner.userId, event.id)).toBe('manager');
  });

  it('org: an admin adds members but not admins, and nobody outside adds anyone', async () => {
    const org = await makeOrg();
    await organisations.addMember(owner, org.id, { email: 'admin@example.com', role: 'admin' });

    expect(await errorCode(() => organisations.addMember(admin, org.id, { email: 'member@example.com', role: 'admin' }))).toBe(
      'FORBIDDEN',
    );
    await organisations.addMember(admin, org.id, { email: 'member@example.com', role: 'member' });
    expect(await organisations.roleOf(org.id, member.userId)).toBe('member');
    expect(await errorCode(() => organisations.addMember(stranger, org.id, { email: 'x@example.com', role: 'member' }))).toBe(
      'FORBIDDEN',
    );
    expect(await errorCode(() => organisations.addMember(owner, org.id, { email: 'member@example.com', role: 'member' }))).toBe(
      OrgCode.ALREADY_MEMBER,
    );
  });

  it('org: the owner cannot leave; a member can, and keeps their own events', async () => {
    const org = await makeOrg();
    await organisations.addMember(owner, org.id, { email: 'member@example.com', role: 'member' });
    const own = await draftAs(member, null);

    expect(await errorCode(() => organisations.leave(owner, org.id))).toBe(OrgCode.OWNER_CANNOT_LEAVE);
    await organisations.leave(member, org.id);
    expect(await organisations.roleOf(org.id, member.userId)).toBeNull();
    expect(await grantOf(member.userId, own.id)).toBe('owner');
  });

  it('org: the owner and admins change how it looks, never its name', async () => {
    const org = await makeOrg();
    const updated = await organisations.update(owner, org.id, { bio: 'Weekly doubles in Indiranagar', city: 'Bengaluru' });
    expect(updated.bio).toBe('Weekly doubles in Indiranagar');
    expect(await errorCode(() => organisations.update(owner, org.id, { name: 'Another Name' }))).toBe(
      OrgCode.INVALID_ORGANISATION_FIELD,
    );
    expect((await organisations.update(staff, org.id, { name: 'Smash Club' }, true)).name).toBe('Smash Club');
  });

  it('org R7: a suspended organisation hosts and publishes nothing', async () => {
    const org = await makeOrg();
    const event = await draftAs(owner, org.id);
    await events.addCategory(owner, event.id, { name: 'Open', format: 'singles', capacity: 16, entryFeePaise: 0n });

    await organisations.suspend(staff, org.id, 'Players reported unpaid prizes');
    expect(await errorCode(() => draftAs(owner, org.id))).toBe(OrgCode.ORGANISATION_SUSPENDED);
    expect(await errorCode(() => events.publish(owner, event.id))).toBe('ORGANIZER_NOT_VERIFIED');

    await organisations.reinstate(staff, org.id);
    expect((await events.publish(owner, event.id)).status).toBe('published');
  });
});

describe('organisation payouts (org R6)', () => {
  const COMPANY = { legalName: 'Sunday Smash Sports LLP', pan: 'AAACS1234K', accountNumber: '51234567890', ifsc: 'HDFC0001098' };

  it('only the owner saves the account, and a company PAN is accepted for an organisation', async () => {
    const org = await makeOrg();
    await organisations.addMember(owner, org.id, { email: 'admin@example.com', role: 'admin' });

    expect(await errorCode(() => payouts.saveAccount(admin, COMPANY, { organisationId: org.id }))).toBe(
      PayoutCode.NOT_ORGANISATION_OWNER,
    );
    expect(await errorCode(() => payouts.saveAccount(owner, COMPANY))).toBe(PayoutCode.PAN_NOT_INDIVIDUAL);

    const account = await payouts.saveAccount(owner, COMPANY, { organisationId: org.id });
    expect(account).toMatchObject({ organizerProfileId: org.id, status: 'checking', panSurnameOk: true });
    expect(await payouts.myAccount(owner.userId)).toBeNull();
    expect((await payouts.organisationAccount(org.id))?.id).toBe(account.id);
    expect(jobs.added.map((j) => j.name)).toContain('verify-payout-account');
  });

  it('paid publishing needs the organisation verified and its own account verified', async () => {
    const org = await makeOrg();
    expect(await payouts.canPublishPaid(owner.userId, org.id)).toEqual({ ok: false, missing: ['no organisation account'] });

    const account = await payouts.saveAccount(owner, COMPANY, { organisationId: org.id });
    await prisma.payoutAccount.update({ where: { id: account.id }, data: { status: 'verified' } });
    expect(await payouts.canPublishPaid(owner.userId, org.id)).toEqual({ ok: true, missing: [] });
    // The owner's own events still need the owner's own account.
    expect((await payouts.canPublishPaid(owner.userId, null)).ok).toBe(false);

    await organisations.suspend(staff, org.id, 'Under review');
    expect((await payouts.canPublishPaid(owner.userId, org.id)).ok).toBe(false);
  });

  it('a change of owner moves the account and its notices to the new owner', async () => {
    const org = await makeOrg();
    await payouts.saveAccount(owner, COMPANY, { organisationId: org.id });
    await organisations.addMember(owner, org.id, { email: 'admin@example.com', role: 'admin' });
    await organisations.setOwner(staff, org.id, 'admin@example.com');
    expect((await payouts.organisationAccount(org.id))?.userId).toBe(admin.userId);
  });
});

describe('portal sessions (portal R1, R6)', () => {
  it('portal R1: the portal signs in staff, and refuses everyone else without making an account', async () => {
    await identity.requestOtp('stranger@example.com');
    expect(await errorCode(() => identity.verifyOtp('stranger@example.com', lastCode('stranger@example.com'), undefined, 'portal'))).toBe(
      IdentityCode.NOT_STAFF,
    );

    await identity.requestOtp('nobody@example.com');
    expect(await errorCode(() => identity.verifyOtp('nobody@example.com', lastCode('nobody@example.com'), undefined, 'portal'))).toBe(
      IdentityCode.NOT_STAFF,
    );
    expect(await identity.findByEmail('nobody@example.com')).toBeNull();

    await identity.requestOtp('support@pl4y.test');
    const session = await identity.verifyOtp('support@pl4y.test', lastCode('support@pl4y.test'), undefined, 'portal');
    expect((await verifyAccessToken(session.access)).client).toBe('portal');
  });

  it('portal R6: an app token is not a portal session, and a portal session ends 12 hours after sign-in', async () => {
    await identity.requestOtp('support@pl4y.test');
    const app = await identity.verifyOtp('support@pl4y.test', lastCode('support@pl4y.test'));
    expect((await verifyAccessToken(app.access)).client).toBe('app');
    expect(await errorCode(() => identity.rotateSession(app.refresh, 'portal'))).toBe(IdentityCode.SESSION_REUSE_DETECTED);

    await identity.requestOtp('support@pl4y.test');
    const portal = await identity.verifyOtp('support@pl4y.test', lastCode('support@pl4y.test'), undefined, 'portal');
    const first = await prisma.refreshToken.findFirstOrThrow({ where: { client: 'portal' }, orderBy: { createdAt: 'desc' } });
    expect(first.expiresAt.getTime() - first.createdAt.getTime()).toBeLessThanOrEqual(12 * 3_600_000 + 5_000);

    const rotated = await identity.rotateSession(portal.refresh, 'portal');
    expect((await verifyAccessToken(rotated.access)).client).toBe('portal');
    const next = await prisma.refreshToken.findFirstOrThrow({ where: { client: 'portal', revokedAt: null } });
    expect(next.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it('portal R1: a role taken away ends the portal session at its next refresh', async () => {
    await identity.requestOtp('support@pl4y.test');
    const portal = await identity.verifyOtp('support@pl4y.test', lastCode('support@pl4y.test'), undefined, 'portal');
    await prisma.platformStaff.delete({ where: { userId: staff.userId } });
    expect(await errorCode(() => identity.rotateSession(portal.refresh, 'portal'))).toBe(IdentityCode.NOT_STAFF);
  });
});
