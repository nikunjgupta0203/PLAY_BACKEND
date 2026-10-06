/**
 * identity — service tests against a real Postgres (conventions.md §5).
 * Every numbered rule has at least one test that names it, so `grep 'R7:'`
 * finds the test for identity R7.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import {
  createIdentityService,
  IdentityCode,
  normaliseEmail,
  type IdentityService,
} from '../src/modules/identity/service/index.js';
import { buildModules } from './helpers/modules.js';
import type { EmailMessage, EmailTransport, SendResult } from '../src/platform/email.js';
import type { LimitResult, Window } from '../src/platform/rateLimit.js';

/** Captures sent mail so a test can read the code out of the subject. */
class CapturingTransport implements EmailTransport {
  sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<SendResult> {
    this.sent.push(msg);
    return { messageId: `msg_${this.sent.length}` };
  }
  lastCode(): string {
    const last = this.sent.at(-1);
    if (!last) throw new Error('no email sent');
    const m = /(\d{6})/.exec(last.subject);
    if (!m?.[1]) throw new Error(`no code in subject: ${last.subject}`);
    return m[1];
  }
}

/** In-memory sliding window: the limiter itself is tested in rateLimit.test.ts. */
class FakeLimiter {
  private hits = new Map<string, number[]>();
  blocked = false;
  async consumeAll(checks: { key: string; window: Window }[]): Promise<LimitResult> {
    if (this.blocked) return { allowed: false, retryAfterSeconds: 42, remaining: 0 };
    const now = Date.now();
    for (const { key, window } of checks) {
      const list = (this.hits.get(key) ?? []).filter((t) => t > now - window.seconds * 1000);
      if (list.length >= window.max) {
        return { allowed: false, retryAfterSeconds: window.seconds, remaining: 0 };
      }
      list.push(now);
      this.hits.set(key, list);
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: 0 };
  }
  reset() {
    this.hits.clear();
    this.blocked = false;
  }
}

let prisma: PrismaClient;
let mail: CapturingTransport;
let limiter: FakeLimiter;
let identity: IdentityService;

/**
 * The minimum an `event_staff` row needs to point at. Written straight to the
 * tables rather than through the events service: identity owns the grant, and
 * this suite should not need the events module to test one.
 */
async function eventOwnedBy(organizerId: string): Promise<string> {
  const sportId = randomUUID();
  const eventId = randomUUID();
  const day = 86_400_000;
  await prisma.sport.create({
    data: { id: sportId, slug: `sport-${sportId.slice(0, 8)}`, name: 'Test Sport' },
  });
  await prisma.event.create({
    data: {
      id: eventId,
      sportId,
      organizerId,
      slug: `event-${eventId.slice(0, 8)}`,
      title: 'Staffed Event',
      city: 'Bengaluru',
      startsAt: new Date(Date.now() + 30 * day),
      endsAt: new Date(Date.now() + 31 * day),
      registrationClosesAt: new Date(Date.now() + 25 * day),
    },
  });
  return eventId;
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  mail = new CapturingTransport();
  limiter = new FakeLimiter();
  identity = createIdentityService({
    db: prisma as never,
    email: mail,
    limiter,
    profile: buildModules(prisma).profile,
  });
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  mail.sent = [];
  limiter.reset();
});

/** Sign up a fresh account and return its tokens. */
/**
 * A real organizer profile. `event_staff.organizer_profile_id` gained its
 * foreign key with the organizers migration (014), so an invented id is a
 * constraint violation rather than an orphan row.
 */
async function organizerProfileOf(userId: string): Promise<string> {
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO organizer_profiles (id, slug, name, created_by)
    VALUES (${id}::uuid, ${`org-${id.slice(0, 8)}`}, 'Test Club', ${userId}::uuid)
  `;
  return id;
}

async function signUp(address: string) {
  await identity.requestOtp(address, 'signup');
  return identity.verifyOtp(address, mail.lastCode());
}

describe('identity', () => {
  it('R1: the plaintext code is never stored — only an argon2id hash', async () => {
    await identity.requestOtp('player@example.com', 'signup');
    const code = mail.lastCode();
    const row = await prisma.otpChallenge.findFirstOrThrow();

    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash.startsWith('$argon2id$')).toBe(true);
  });

  it('R2: five attempts, then the challenge burns regardless of remaining TTL', async () => {
    const address = 'burn@example.com';
    await identity.requestOtp(address, 'signup');
    const realCode = mail.lastCode();

    for (let i = 0; i < 5; i++) {
      await expect(identity.verifyOtp(address, '000000')).rejects.toMatchObject({
        code: IdentityCode.OTP_INVALID,
      });
    }

    // The challenge is spent, so even the correct code no longer works.
    await expect(identity.verifyOtp(address, realCode)).rejects.toMatchObject({
      code: IdentityCode.OTP_INVALID,
    });
    const row = await prisma.otpChallenge.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
  });

  it('R3: exceeding a send window returns OTP_THROTTLED with retryAfterSeconds', async () => {
    limiter.blocked = true;
    await expect(identity.requestOtp('spam@example.com', 'signup')).rejects.toMatchObject({
      code: IdentityCode.OTP_THROTTLED,
      retryAfterSeconds: 42,
    });
    expect(mail.sent).toHaveLength(0);
  });

  it('R4: email is normalised, so one inbox is one account', async () => {
    expect(normaliseEmail('  Ravi@Example.COM ')).toBe('ravi@example.com');

    await signUp('Ravi@Example.com');
    await identity.requestOtp('ravi@EXAMPLE.com', 'login');
    await identity.verifyOtp('  RAVI@example.com  ', mail.lastCode());

    expect(await prisma.user.count()).toBe(1);
  });

  it('R4: an unknown email is not distinguishable from a wrong code', async () => {
    await expect(
      identity.verifyOtp('nobody@example.com', '123456'),
    ).rejects.toMatchObject({ code: IdentityCode.OTP_INVALID });
  });

  it('R6: refresh tokens are stored hashed and rotate on every use', async () => {
    const first = await signUp('rotate@example.com');
    const rotated = await identity.rotateSession(first.refresh);

    expect(rotated.refresh).not.toBe(first.refresh);
    const stored = await prisma.refreshToken.findMany();
    for (const row of stored) {
      expect(row.tokenHash).not.toBe(first.refresh);
      expect(row.tokenHash).not.toBe(rotated.refresh);
    }
  });

  it('R7: reusing a spent refresh token revokes the entire family', async () => {
    const first = await signUp('reuse@example.com');
    const second = await identity.rotateSession(first.refresh);

    // Replaying the spent token is the attack signal.
    await expect(identity.rotateSession(first.refresh)).rejects.toMatchObject({
      code: IdentityCode.SESSION_REUSE_DETECTED,
    });

    // The still-valid sibling token must also stop working: every device in
    // that lineage has to sign in again.
    await expect(identity.rotateSession(second.refresh)).rejects.toMatchObject({
      code: IdentityCode.SESSION_REUSE_DETECTED,
    });

    const live = await prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('R8: a suspended account cannot rotate, and its sessions are revoked', async () => {
    const session = await signUp('suspended@example.com');
    const user = await prisma.user.findFirstOrThrow();

    await identity.suspend(user.id, 'test');

    await expect(identity.rotateSession(session.refresh)).rejects.toMatchObject({
      code: IdentityCode.SESSION_REUSE_DETECTED,
    });
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('R9: the first verify creates user and profile in one transaction', async () => {
    const result = await signUp('first@example.com');
    expect(result.isNewUser).toBe(true);

    const user = await prisma.user.findFirstOrThrow();
    const profileRow = await prisma.playerProfile.findUnique({ where: { userId: user.id } });

    expect(profileRow).not.toBeNull();
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.playerProfile.count()).toBe(1);

    // A second login must not create a second user or profile.
    await identity.requestOtp('first@example.com', 'login');
    const again = await identity.verifyOtp('first@example.com', mail.lastCode());
    expect(again.isNewUser).toBe(false);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.playerProfile.count()).toBe(1);
  });

  it('R9: user.created is written to the outbox in the same transaction', async () => {
    await signUp('outbox@example.com');
    const rows = await prisma.outbox.findMany({ where: { topic: 'user.created' } });
    expect(rows).toHaveLength(1);
  });

  it('R10: a revoked grant is gone on the very next request', async () => {
    await signUp('organizer@example.com');
    const user = await prisma.user.findFirstOrThrow();
    // A grant points at a real event: `event_staff.event_id` gained its foreign
    // key with the events migration, so an invented id is now a constraint
    // violation rather than an orphan row.
    const eventId = await eventOwnedBy(user.id);

    await identity.addStaff(eventId, user.id, 'manager');
    expect(await identity.grantsFor(user.id, eventId)).toMatchObject({ role: 'manager' });

    await identity.removeStaff(eventId, user.id);
    // No cache to wait out — the next read is already correct.
    expect(await identity.grantsFor(user.id, eventId)).toBeNull();
  });

  it('staffFor: every user with a grant on the event, once, with their role', async () => {
    await signUp('owner@example.com');
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'owner@example.com' } });
    const eventId = await eventOwnedBy(owner.id);
    await signUp('manager@example.com');
    const manager = await prisma.user.findFirstOrThrow({ where: { email: 'manager@example.com' } });
    await signUp('helper@example.com');
    const helper = await prisma.user.findFirstOrThrow({ where: { email: 'helper@example.com' } });

    await identity.addStaff(eventId, owner.id, 'owner');
    await identity.addStaff(eventId, manager.id, 'manager');
    await identity.addStaff(eventId, helper.id, 'scorer');

    const staff = await identity.staffFor(eventId);
    expect(staff.map((g) => `${g.userId}:${g.role}`).sort()).toEqual(
      [`${owner.id}:owner`, `${manager.id}:manager`, `${helper.id}:scorer`].sort(),
    );
  });

  it('R12: phone is optional contact information, never an identity', async () => {
    await signUp('phone@example.com');
    const user = await prisma.user.findFirstOrThrow();
    expect(user.phoneE164).toBeNull();

    await identity.setPhone(user.id, '+919876543210');
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.phoneE164).toBe('+919876543210');

    // Not unique: two accounts may share a contact number.
    await signUp('phone2@example.com');
    const other = await prisma.user.findFirstOrThrow({ where: { email: 'phone2@example.com' } });
    await expect(identity.setPhone(other.id, '+919876543210')).resolves.toBeUndefined();
  });

  it('R13: a bounced address is refused further sends', async () => {
    await signUp('bounce@example.com');
    await identity.recordDeliveryEvent('bounce@example.com', 'bounced');

    await expect(identity.requestOtp('bounce@example.com', 'login')).rejects.toMatchObject({
      code: IdentityCode.EMAIL_UNDELIVERABLE,
    });
  });

  it('R14: disposable email domains are rejected before a code is sent', async () => {
    await expect(
      identity.requestOtp('throwaway@mailinator.com', 'signup'),
    ).rejects.toMatchObject({ code: IdentityCode.EMAIL_DOMAIN_NOT_ALLOWED });
    expect(mail.sent).toHaveLength(0);
  });

  it('expired codes are rejected as OTP_EXPIRED, not OTP_INVALID', async () => {
    const address = 'expired@example.com';
    await identity.requestOtp(address, 'signup');
    const code = mail.lastCode();

    await prisma.otpChallenge.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(identity.verifyOtp(address, code)).rejects.toMatchObject({
      code: IdentityCode.OTP_EXPIRED,
    });
  });
});

describe('identity — platform roles, organizer grants and account deletion', () => {
  const asTx = <T>(fn: (tx: never) => Promise<T>) => prisma.$transaction((tx) => fn(tx as never));

  it('R15: platform roles live in platform_staff and never ride in the token', async () => {
    const session = await signUp('staff@example.com');
    const user = await prisma.user.findFirstOrThrow();
    expect(await identity.platformRoleFor(user.id)).toBeNull();

    await asTx((tx) => identity.setPlatformRole(tx, null, user.id, 'finance'));
    expect(await identity.platformRoleFor(user.id)).toBe('finance');

    // The access token minted before the grant knows nothing about it, and
    // no claim could have gone stale: there is no role claim at all.
    const claims = JSON.parse(
      Buffer.from(session.access.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(claims)).not.toContain('role');

    await asTx((tx) => identity.setPlatformRole(tx, null, user.id, null));
    expect(await identity.platformRoleFor(user.id)).toBeNull();
    expect(await prisma.outbox.count({ where: { topic: 'platform_role.changed' } })).toBe(2);
  });

  it('R16: direct and organizer grants coexist, and the higher role wins', async () => {
    await signUp('member@example.com');
    const user = await prisma.user.findFirstOrThrow();
    const eventId = await eventOwnedBy(user.id);
    const organizerProfileId = await organizerProfileOf(user.id);

    await identity.addStaff(eventId, user.id, 'scorer');
    await asTx((tx) =>
      identity.syncOrganizerGrants(tx, {
        organizerProfileId,
        userId: user.id,
        eventIds: [eventId],
        role: 'manager',
      }),
    );
    expect(await identity.grantsFor(user.id, eventId)).toMatchObject({ role: 'manager' });
    expect(await identity.grantsForUser(user.id)).toEqual([
      { eventId, userId: user.id, role: 'manager' },
    ]);

    // removeStaff touches only the direct row; the organizer grant remains.
    await identity.removeStaff(eventId, user.id);
    expect(await identity.grantsFor(user.id, eventId)).toMatchObject({ role: 'manager' });
  });

  it('R16: a sync removal never touches a direct grant, and takes effect on the next read', async () => {
    await signUp('removed@example.com');
    const user = await prisma.user.findFirstOrThrow();
    const eventId = await eventOwnedBy(user.id);
    const organizerProfileId = await organizerProfileOf(user.id);

    await identity.addStaff(eventId, user.id, 'scorer');
    await asTx((tx) =>
      identity.syncOrganizerGrants(tx, {
        organizerProfileId,
        userId: user.id,
        eventIds: 'all',
        role: 'owner',
      }),
    );
    // 'all' with no organizer rows yet has nothing to extend to.
    expect(await identity.grantsFor(user.id, eventId)).toMatchObject({ role: 'scorer' });

    await asTx((tx) =>
      identity.syncOrganizerGrants(tx, {
        organizerProfileId,
        userId: user.id,
        eventIds: [eventId],
        role: 'owner',
      }),
    );
    expect(await identity.grantsFor(user.id, eventId)).toMatchObject({ role: 'owner' });

    await asTx((tx) =>
      identity.syncOrganizerGrants(tx, {
        organizerProfileId,
        userId: user.id,
        eventIds: 'all',
        role: null,
      }),
    );
    expect(await identity.grantsFor(user.id, eventId)).toMatchObject({ role: 'scorer' });
  });

  it('R16: the database refuses an organizer grant that names no organizer', async () => {
    await signUp('orphan@example.com');
    const user = await prisma.user.findFirstOrThrow();
    const eventId = await eventOwnedBy(user.id);
    await expect(
      prisma.eventStaff.create({
        data: { eventId, userId: user.id, role: 'owner', source: 'organizer' },
      }),
    ).rejects.toThrow();
  });

  it('R18: reinstate returns a suspended user to active, and revoked sessions stay revoked', async () => {
    const session = await signUp('appeal@example.com');
    const user = await prisma.user.findFirstOrThrow();

    await identity.suspend(user.id, 'chargeback pattern');
    await identity.reinstate(user.id, 'appeal upheld');

    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status).toBe('active');
    await expect(identity.rotateSession(session.refresh)).rejects.toMatchObject({
      code: IdentityCode.SESSION_REUSE_DETECTED,
    });
    // Signing in again works.
    await identity.requestOtp('appeal@example.com', 'login');
    await expect(identity.verifyOtp('appeal@example.com', mail.lastCode())).resolves.toBeDefined();
    expect(await prisma.outbox.count({ where: { topic: 'user.reinstated' } })).toBe(1);

    // Reinstating an active user is a no-op, not a second event.
    await identity.reinstate(user.id, 'again');
    expect(await prisma.outbox.count({ where: { topic: 'user.reinstated' } })).toBe(1);
  });

  it('R18: requesting deletion revokes every session at once and blocks sign-in', async () => {
    await signUp('leaving@example.com');
    const user = await prisma.user.findFirstOrThrow();

    await identity.requestAccountDeletion({ userId: user.id });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('deleted');
    expect(row.deletionRequestedAt).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    await expect(identity.requestOtp('leaving@example.com', 'login')).rejects.toMatchObject({
      code: IdentityCode.OTP_INVALID,
    });
    expect(await prisma.outbox.count({ where: { topic: 'user.deletion_requested' } })).toBe(1);
  });

  it('R18: deletion is refused with ACCOUNT_DELETION_BLOCKED while a guard reports a blocker', async () => {
    const guarded = createIdentityService({
      db: prisma as never,
      email: mail,
      limiter,
      profile: buildModules(prisma).profile,
      deletionGuards: [async () => ['UPCOMING_CONFIRMED_ENTRY']],
    });
    await signUp('committed@example.com');
    const user = await prisma.user.findFirstOrThrow();

    await expect(guarded.requestAccountDeletion({ userId: user.id })).rejects.toMatchObject({
      code: IdentityCode.ACCOUNT_DELETION_BLOCKED,
      details: { blockers: ['UPCOMING_CONFIRMED_ENTRY'] },
    });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('active');
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('R18: the scrub waits out the 30-day grace, then clears personal data and keeps the row', async () => {
    await signUp('gone@example.com');
    const user = await prisma.user.findFirstOrThrow();
    await identity.setPhone(user.id, '+919876543210');
    await identity.requestAccountDeletion({ userId: user.id });

    expect(await identity.scrubDeletedUsers()).toBe(0);

    await prisma.user.update({
      where: { id: user.id },
      data: { deletionRequestedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    expect(await identity.scrubDeletedUsers()).toBe(1);

    const scrubbed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(scrubbed.email).toBe(`deleted+${user.id}@invalid`);
    expect(scrubbed.phoneE164).toBeNull();
    expect(scrubbed.displayName).toBe('Deleted player');
    expect(scrubbed.status).toBe('deleted');
    expect(await prisma.outbox.count({ where: { topic: 'user.scrubbed' } })).toBe(1);

    // Idempotent, and the address is free for a brand-new account.
    expect(await identity.scrubDeletedUsers()).toBe(0);
    expect((await signUp('gone@example.com')).isNewUser).toBe(true);
  });
});
