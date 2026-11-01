/**
 * portal — adminCreateUser and adminUpdateUser, run through the real GraphQL
 * schema with a portal session, so who may call them and what they write are
 * tested where the rules live.
 *
 * Unlike the service suites this one needs the production singletons (the
 * schema binds them), so the test database URL is set BEFORE anything from
 * src/ is imported, and the suite refuses to start unless it points at this
 * machine. .env is never the database here.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { GraphQLSchema } from 'graphql';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';

let prisma: PrismaClient;
let run: (actorId: string, source: string, variables: Record<string, unknown>) => Promise<Record<string, unknown>>;

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const host = new URL(started.url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`refusing to run against ${host}`);
  process.env.DATABASE_URL = started.url;
  process.env.DIRECT_DATABASE_URL = started.url;
  process.env.EMAIL_TRANSPORT = 'console';
  process.env.PUSH_TRANSPORT = 'console';

  // The schema is built with the CommonJS copy of graphql; run it with the same one.
  const { graphql } = createRequire(import.meta.url)('graphql') as typeof import('graphql');
  const { schema } = (await import('../src/schema.js')) as { schema: GraphQLSchema };
  const { buildContext } = await import('../src/graphql/context.js');
  const { signAccessToken } = await import('../src/platform/auth/tokens.js');
  run = async (actorId, source, variables) => {
    const token = await signAccessToken({ sub: actorId, sid: randomUUID(), ver: 1, client: 'portal' });
    const req = { get: (h: string) => (h.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined), ip: '127.0.0.1' };
    const contextValue = await buildContext({ req: req as never });
    const result = await graphql({ schema, source, variableValues: variables, contextValue });
    if (result.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '));
    return result.data as Record<string, unknown>;
  };
});

afterAll(async () => {
  const { disconnectDb } = await import('../src/platform/db.js');
  await disconnectDb();
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

async function person(email: string, name: string, role?: 'admin' | 'support' | 'finance'): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email, displayName: name } });
  await prisma.playerProfile.create({ data: { id: randomUUID(), userId: id, city: 'Delhi' } });
  if (role) await prisma.platformStaff.create({ data: { userId: id, role } });
  return id;
}

const CREATE = `
  mutation ($input: AdminCreateUserInput!, $reason: String!) {
    adminCreateUser(input: $input, reason: $reason) { user { id displayName emailMasked phoneMasked city } userError { code message } }
  }`;
const UPDATE = `
  mutation ($userId: ID!, $input: AdminUpdateUserInput!, $reason: String!) {
    adminUpdateUser(userId: $userId, input: $input, reason: $reason) { user { id displayName emailMasked phoneMasked city bio } userError { code message } }
  }`;

type Payload = { user: Record<string, unknown> | null; userError: { code: string; message: string } | null };
const create = async (actor: string, input: Record<string, unknown>, reason = 'Signed up at the desk') =>
  (await run(actor, CREATE, { input, reason })).adminCreateUser as Payload;
const update = async (actor: string, userId: string, input: Record<string, unknown>, reason = 'They asked support') =>
  (await run(actor, UPDATE, { userId, input, reason })).adminUpdateUser as Payload;

describe('portal — adminCreateUser', () => {
  it('support creates an account with its profile and city, audited with the reason', async () => {
    const support = await person('support@example.com', 'Support', 'support');
    const r = await create(support, { email: 'Desk@Example.com', displayName: '  Ravi   Kumar ', phone: '98765 43210', city: 'Gurugram' });
    expect(r.userError).toBeNull();
    expect(r.user).toMatchObject({ displayName: 'Ravi Kumar', emailMasked: 'd***@example.com', phoneMasked: '******3210', city: 'Gurugram' });

    const id = r.user!.id as string;
    expect(await prisma.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ email: 'desk@example.com', status: 'active' });
    const audit = await prisma.auditLog.findMany({ where: { targetId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'user.create', actorUserId: support, reason: 'Signed up at the desk', outcome: 'succeeded' });
  });

  it('refuses a taken email, a bad name and a short reason, and leaves no audit row', async () => {
    const admin = await person('admin@example.com', 'Admin', 'admin');
    await person('taken@example.com', 'Taken');
    expect((await create(admin, { email: 'taken@example.com', displayName: 'Again' })).userError?.code).toBe('EMAIL_TAKEN');
    expect((await create(admin, { email: 'new@example.com', displayName: 'R' })).userError?.code).toBe('INVALID_DISPLAY_NAME');
    expect((await create(admin, { email: 'new@example.com', displayName: 'Ravi' }, 'no')).userError?.code).toBe('REASON_REQUIRED');
    expect(await prisma.user.count()).toBe(2);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('finance staff, and players, cannot create accounts', async () => {
    const finance = await person('finance@example.com', 'Finance', 'finance');
    const player = await person('player@example.com', 'Player');
    await expect(create(finance, { email: 'x@example.com', displayName: 'Xavier' })).rejects.toThrow();
    await expect(create(player, { email: 'x@example.com', displayName: 'Xavier' })).rejects.toThrow();
    expect(await prisma.user.count({ where: { email: 'x@example.com' } })).toBe(0);
  });
});

describe('portal — adminUpdateUser', () => {
  it('an admin changes name, email, phone, city and bio; the city change clears the map pin', async () => {
    const admin = await person('admin@example.com', 'Admin', 'admin');
    const target = await person('old@example.com', 'Old Name');
    await prisma.$executeRaw`UPDATE player_profiles SET geo = ST_SetSRID(ST_MakePoint(77.2, 28.6), 4326)::geography WHERE user_id = ${target}::uuid`;

    const r = await update(admin, target, {
      displayName: 'New Name',
      email: 'new@example.com',
      phone: '+91 98765 43210',
      city: 'Noida',
      bio: 'Plays doubles on weekends',
    });
    expect(r.userError).toBeNull();
    expect(r.user).toMatchObject({ displayName: 'New Name', emailMasked: 'n**@example.com', city: 'Noida', bio: 'Plays doubles on weekends' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: target } })).toMatchObject({ email: 'new@example.com', phoneE164: '+91 98765 43210' });
    const [pin] = await prisma.$queryRaw<{ hasGeo: boolean }[]>`SELECT geo IS NOT NULL AS "hasGeo" FROM player_profiles WHERE user_id = ${target}::uuid`;
    expect(pin?.hasGeo).toBe(false);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: target } });
    expect(audit).toMatchObject({ action: 'user.update', outcome: 'succeeded', details: { fields: ['displayName', 'email', 'phone', 'city', 'bio'] } });
  });

  it('null or empty clears phone, city and bio; leaving a field out keeps it', async () => {
    const admin = await person('admin@example.com', 'Admin', 'admin');
    const target = await person('p@example.com', 'Player');
    await prisma.user.update({ where: { id: target }, data: { phoneE164: '9876543210' } });
    await prisma.playerProfile.update({ where: { userId: target }, data: { bio: 'Hello' } });

    const r = await update(admin, target, { phone: null, bio: '' });
    expect(r.userError).toBeNull();
    expect(r.user).toMatchObject({ phoneMasked: null, bio: null, city: 'Delhi', displayName: 'Player' });
  });

  it('support edits names but not the sign-in email', async () => {
    const support = await person('support@example.com', 'Support', 'support');
    const target = await person('p@example.com', 'Player');
    expect((await update(support, target, { displayName: 'Fixed Name' })).user).toMatchObject({ displayName: 'Fixed Name' });
    expect((await update(support, target, { email: 'other@example.com' })).userError?.code).toBe('ADMIN_ONLY');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target } })).email).toBe('p@example.com');
  });

  it('nobody edits themselves; finance cannot edit anyone', async () => {
    const admin = await person('admin@example.com', 'Admin', 'admin');
    const finance = await person('finance@example.com', 'Finance', 'finance');
    expect((await update(admin, admin, { displayName: 'Me Again' })).userError?.code).toBe('CANNOT_EDIT_SELF');
    await expect(update(finance, admin, { displayName: 'Hacked' })).rejects.toThrow();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin } })).displayName).toBe('Admin');
  });

  it('says so when nothing changed, an email is taken, or the account is being deleted — and audits none of them', async () => {
    const admin = await person('admin@example.com', 'Admin', 'admin');
    const target = await person('p@example.com', 'Player');
    await person('taken@example.com', 'Taken');
    expect((await update(admin, target, { displayName: 'Player', city: 'Delhi' })).userError?.code).toBe('NOTHING_CHANGED');
    expect((await update(admin, target, { email: 'TAKEN@example.com' })).userError?.code).toBe('EMAIL_TAKEN');
    expect((await update(admin, target, { phone: '123' })).userError?.code).toBe('INVALID_PHONE');
    expect((await update(admin, target, { bio: 'x'.repeat(161) })).userError?.code).toBe('INVALID_INPUT');
    expect((await update(admin, randomUUID(), { displayName: 'Nobody' })).userError?.code).toBe('USER_NOT_FOUND');
    await prisma.user.update({ where: { id: target }, data: { status: 'deleted', deletionRequestedAt: new Date() } });
    expect((await update(admin, target, { displayName: 'Still Here' })).userError?.code).toBe('ACCOUNT_NOT_EDITABLE');
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('a walk-in guest takes a new name but has no city or email to change', async () => {
    const admin = await person('admin@example.com', 'Admin', 'admin');
    const guest = randomUUID();
    await prisma.user.create({ data: { id: guest, email: `guest-${guest}@guest.pl4y.invalid`, displayName: 'Walk In', isGuest: true } });
    expect((await update(admin, guest, { displayName: 'Walk-in Ravi' })).user).toMatchObject({ displayName: 'Walk-in Ravi' });
    expect((await update(admin, guest, { city: 'Delhi' })).userError?.code).toBe('INVALID_INPUT');
    expect((await update(admin, guest, { email: 'g@example.com' })).userError?.code).toBe('ACCOUNT_NOT_EDITABLE');
  });
});
