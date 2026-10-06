/**
 * identity — service layer (docs/modules/01-identity.md).
 *
 * Services take plain domain objects and never import GraphQL types
 * (conventions.md §1), which is what makes them callable from resolvers,
 * workers and webhook handlers alike.
 *
 * Dependencies are injected so tests can wire a real test Postgres without
 * touching the production singletons.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Db, Tx } from '../../../platform/db.js';
import type { EmailTransport } from '../../../platform/email.js';
import { newId } from '../../../platform/ids.js';
import { config, isProd } from '../../../platform/config.js';
import { UserError } from '../../../platform/errors/index.js';
import * as otpCodes from '../../../platform/auth/otp.js';
import * as tokens from '../../../platform/auth/tokens.js';
import type { AuthClient } from '../../../platform/auth/tokens.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import { logger } from '../../../platform/logging/index.js';
import { otpEmail } from './otpEmail.js';

/** Constant-time: the test code is a live credential in production. */
function sameCode(given: string, expected: string): boolean {
  if (expected === '' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export const IdentityCode = {
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_THROTTLED: 'OTP_THROTTLED',
  EMAIL_UNDELIVERABLE: 'EMAIL_UNDELIVERABLE',
  EMAIL_DOMAIN_NOT_ALLOWED: 'EMAIL_DOMAIN_NOT_ALLOWED',
  SESSION_REUSE_DETECTED: 'SESSION_REUSE_DETECTED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  INVALID_EMAIL: 'INVALID_EMAIL',
  /** R18 — list what must finish first. */
  ACCOUNT_DELETION_BLOCKED: 'ACCOUNT_DELETION_BLOCKED',
  /** portal R1 — the code was right, but the portal is for PL4Y staff. */
  NOT_STAFF: 'NOT_STAFF',
} as const;

/** `payout_change` — gap #25: a fresh code before verified bank details are replaced. Never signs anyone in. */
export type OtpPurpose = 'signup' | 'login' | 'email_change' | 'payout_change';
export type StaffRole = 'owner' | 'manager' | 'scorer';
/** R16 — where a grant came from. */
export type GrantSource = 'direct' | 'organizer';
/** R15 — never a JWT claim. */
export type PlatformRole = 'admin' | 'support' | 'finance';

export interface Grant {
  eventId: string;
  userId: string;
  role: StaffRole;
}

export interface SessionPair {
  access: string;
  refresh: string;
  isNewUser: boolean;
}

export interface Limiter {
  consumeAll(checks: { key: string; window: Window }[]): Promise<LimitResult>;
}

export interface ProfilePort {
  /** identity R9 — profile is created in the same transaction as its user. */
  createFor(tx: Tx, userId: string): Promise<string>;
}

/**
 * R18 — something that must finish before an account can be deleted: a
 * confirmed place in an upcoming draw, an organizer still owed a payout.
 * Returns the blocker codes, or nothing. Registered at the composition root,
 * because identity sits at L0 and may import none of the modules that know.
 */
export type DeletionGuard = (userId: string) => Promise<string[]>;

/**
 * Something to do each time a person signs in to the app, such as claiming an
 * organisation invite sent to their address before they had an account (org).
 * A hook that fails is logged; it never fails the sign-in.
 */
export type SignInHook = (user: { userId: string; email: string }) => Promise<void>;

export type { AuthClient };

export interface IdentityDeps {
  db: Db;
  email: EmailTransport;
  limiter: Limiter;
  profile: ProfilePort;
  deletionGuards?: DeletionGuard[];
  signInHooks?: SignInHook[];
  /** R18 — 30 days unless a test says otherwise. */
  deletionGraceDays?: number;
  now?: () => Date;
}

/** identity R3 — SMS was a budget control; these are an abuse control. */
export const OTP_WINDOWS = {
  perEmail: { seconds: 15 * 60, max: 3 },
  perIpHour: { seconds: 3600, max: 20 },
  perIpDay: { seconds: 86_400, max: 200 },
} satisfies Record<string, Window>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DAY_MS = 86_400_000;
const SCRUBBED_DISPLAY_NAME = 'Deleted player';
const scrubbedEmail = (userId: string) => `deleted+${userId}@invalid`;

/**
 * identity R4 — trimmed and lowercased before every read and write, so
 * Ravi@Example.com and ravi@example.com are one account. The column is citext
 * as well; this is belt and braces, and it keeps the rule testable.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const ROLE_RANK: Record<StaffRole, number> = { owner: 3, manager: 2, scorer: 1 };

/**
 * R16 — a user holding a direct grant and an organizer-derived one on the same
 * event gets the higher of the two. Exported so every reader of `event_staff`
 * resolves it the same way.
 */
export function highestGrant<T extends { role: string }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const rank = ROLE_RANK[row.role as StaffRole] ?? 0;
    if (!best || rank > (ROLE_RANK[best.role as StaffRole] ?? 0)) best = row;
  }
  return best;
}

/** F20 — walk-in guests' addresses. `.invalid` is reserved: no mail is ever delivered to it. */
export const GUEST_EMAIL_DOMAIN = 'guest.pl4y.invalid';

export function createIdentityService(deps: IdentityDeps) {
  const now = deps.now ?? (() => new Date());
  const { db, email, limiter, profile } = deps;
  const deletionGuards = [...(deps.deletionGuards ?? [])];
  const signInHooks = [...(deps.signInHooks ?? [])];

  async function runSignInHooks(userId: string, address: string): Promise<void> {
    for (const hook of signInHooks) {
      try {
        await hook({ userId, email: address });
      } catch (err) {
        logger.warn({ err, userId }, 'sign-in hook failed');
      }
    }
  }
  const graceMs = (deps.deletionGraceDays ?? 30) * DAY_MS;

  /** Uses the caller's transaction when there is one (admin R3), or opens one. */
  async function inTx<T>(tx: Tx | undefined, fn: (t: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : db.$transaction(fn);
  }

  function assertEmailShape(value: string): string {
    const normalised = normaliseEmail(value);
    if (!EMAIL_RE.test(normalised)) {
      throw new UserError(IdentityCode.INVALID_EMAIL, 'Enter a valid email address.');
    }
    return normalised;
  }

  /** identity R14 — refund-fraud prevention, not spam prevention. */
  function assertDomainAllowed(normalised: string): void {
    const domain = normalised.slice(normalised.lastIndexOf('@') + 1);
    if (config.DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
      throw new UserError(
        IdentityCode.EMAIL_DOMAIN_NOT_ALLOWED,
        'That email provider is not accepted. Please use a different address.',
      );
    }
  }

  async function requestOtp(
    rawEmail: string,
    purpose: OtpPurpose = 'login',
    ip = 'unknown',
  ): Promise<{ challengeId: string; retryAfterSeconds: number }> {
    const address = assertEmailShape(rawEmail);
    assertDomainAllowed(address);

    // R3 — three windows; the first rejection wins.
    const limit = await limiter.consumeAll([
      { key: `otp:email:${address}`, window: OTP_WINDOWS.perEmail },
      { key: `otp:ip:h:${ip}`, window: OTP_WINDOWS.perIpHour },
      { key: `otp:ip:d:${ip}`, window: OTP_WINDOWS.perIpDay },
    ]);
    if (!limit.allowed) {
      throw new UserError(IdentityCode.OTP_THROTTLED, 'Too many codes requested.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    // R13 — a hard-bounced address cannot receive further sends. Telling the
    // user to fix it beats letting them retry into a void.
    const existing = await db.user.findUnique({ where: { email: address } });
    if (existing && existing.emailStatus !== 'ok') {
      throw new UserError(
        IdentityCode.EMAIL_UNDELIVERABLE,
        'We cannot deliver email to that address. Please check it or use another.',
      );
    }
    if (existing && existing.status !== 'active') {
      // R8 — surfaced as a generic invalid so a suspended account is not
      // distinguishable from a wrong address at this step. A deleted one
      // (R18) is treated the same until it is scrubbed.
      throw new UserError(IdentityCode.OTP_INVALID, 'Unable to send a code.');
    }

    const code = otpCodes.generateCode();
    const codeHash = await otpCodes.hashCode(code);
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + config.OTP_TTL_MINUTES * 60_000);

    const challenge = await db.otpChallenge.create({
      data: { id: newId(), email: address, codeHash, purpose, expiresAt },
    });

    const sent = await email.send({
      to: address,
      ...otpEmail({ code, ttlMinutes: config.OTP_TTL_MINUTES, to: address, purpose }),
    });

    if (sent.messageId) {
      await db.otpChallenge.update({
        where: { id: challenge.id },
        data: { resendMessageId: sent.messageId },
      });
    }

    return { challengeId: challenge.id, retryAfterSeconds: 0 };
  }

  /** portal R1 — only PL4Y staff hold a portal session. Checked at sign-in and at every refresh. */
  async function assertPortalAccess(userId: string, client: AuthClient): Promise<void> {
    if (client !== 'portal') return;
    if (!(await platformRoleFor(userId))) {
      throw new UserError(IdentityCode.NOT_STAFF, 'This portal is for the PL4Y team.');
    }
  }

  async function verifyOtp(
    rawEmail: string,
    code: string,
    deviceLabel?: string,
    client: AuthClient = 'app',
  ): Promise<SessionPair> {
    const address = assertEmailShape(rawEmail);
    const at = now();

    // Dev list: local only, config refuses it in production. Test list: any
    // environment, with a code config forbids from being the dev default.
    const devBypass = !isProd && config.DEV_OTP_BYPASS_EMAILS.has(address) && code === config.DEV_OTP_CODE;
    const testBypass = config.TEST_LOGIN_EMAILS.has(address) && sameCode(code, config.TEST_LOGIN_CODE);
    if (devBypass || testBypass) {
      const user = await db.user.findUnique({ where: { email: address } });
      if (user && user.status === 'active') {
        await assertPortalAccess(user.id, client);
        const pair = await issueSession(user.id, deviceLabel, client);
        if (client === 'app') await runSignInHooks(user.id, address);
        return { ...pair, isNewUser: false };
      }
    }

    const challenge = await db.otpChallenge.findFirst({
      // gap #25 — a step-up code confirms an action; it never signs anyone in.
      where: { email: address, consumedAt: null, purpose: { not: 'payout_change' } },
      orderBy: { createdAt: 'desc' },
    });

    // R4 — an unknown email costs the same work as a known one, so this
    // endpoint cannot be turned into a user-enumeration oracle.
    if (!challenge) {
      await otpCodes.verifyCode(await otpCodes.decoy(), code);
      throw new UserError(IdentityCode.OTP_INVALID, 'That code is not correct.');
    }

    if (challenge.expiresAt <= at) {
      throw new UserError(IdentityCode.OTP_EXPIRED, 'That code has expired.');
    }

    // R2 — five attempts, then the challenge burns regardless of TTL.
    if (challenge.attempts >= config.OTP_MAX_ATTEMPTS) {
      await db.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: at },
      });
      throw new UserError(IdentityCode.OTP_INVALID, 'That code is no longer valid.');
    }

    const ok = await otpCodes.verifyCode(challenge.codeHash, code);
    if (!ok) {
      const updated = await db.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      if (updated.attempts >= config.OTP_MAX_ATTEMPTS) {
        await db.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: at },
        });
      }
      throw new UserError(IdentityCode.OTP_INVALID, 'That code is not correct.');
    }

    // portal R1 — the portal never creates an account; staff already have one.
    if (client === 'portal') {
      await db.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: at } });
      const staffUser = await db.user.findUnique({ where: { email: address } });
      if (!staffUser || staffUser.status !== 'active') {
        throw new UserError(IdentityCode.NOT_STAFF, 'This portal is for the PL4Y team.');
      }
      await assertPortalAccess(staffUser.id, client);
      return { ...(await issueSession(staffUser.id, deviceLabel, 'portal')), isNewUser: false };
    }

    // R9 — user and profile are created in one transaction. A user without a
    // profile is not a state the system can be in.
    const { userId, isNewUser } = await db.$transaction(async (tx) => {
      await tx.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: at },
      });

      const found = await tx.user.findUnique({ where: { email: address } });
      if (found) {
        if (found.status !== 'active') {
          throw new UserError(IdentityCode.ACCOUNT_SUSPENDED, 'This account is unavailable.');
        }
        return { userId: found.id, isNewUser: false };
      }

      const created = await tx.user.create({
        data: {
          id: newId(),
          email: address,
          displayName: address.slice(0, address.indexOf('@')),
        },
      });
      await profile.createFor(tx, created.id);
      await outboxWrite(tx, {
        topic: 'user.created',
        payload: { userId: created.id },
      });
      return { userId: created.id, isNewUser: true };
    });

    const pair = await issueSession(userId, deviceLabel);
    await runSignInHooks(userId, address);
    return { ...pair, isNewUser };
  }

  /**
   * gap #25 — a code to the signed-in person's own email, before an action
   * that would let a taken-over session redirect money. Throttled like a
   * sign-in code (R3).
   */
  async function requestStepUpCode(userId: string, purpose: 'payout_change'): Promise<{ sentTo: string }> {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') throw new UserError(IdentityCode.OTP_INVALID, 'Unable to send a code.');
    const limit = await limiter.consumeAll([{ key: `otp:email:${user.email}`, window: OTP_WINDOWS.perEmail }]);
    if (!limit.allowed) {
      throw new UserError(IdentityCode.OTP_THROTTLED, 'Too many codes requested.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const code = otpCodes.generateCode();
    const codeHash = await otpCodes.hashCode(code);
    const expiresAt = new Date(now().getTime() + config.OTP_TTL_MINUTES * 60_000);
    await db.otpChallenge.create({ data: { id: newId(), email: user.email, codeHash, purpose, expiresAt } });
    await email.send({
      to: user.email,
      ...otpEmail({ code, ttlMinutes: config.OTP_TTL_MINUTES, to: user.email, purpose }),
    });
    const at = user.email.indexOf('@');
    return { sentTo: `${user.email[0]}***${user.email.slice(at)}` };
  }

  /**
   * gap #25 — true once, for the latest unexpired code of this purpose. Five
   * wrong tries burn it, like a sign-in code (R2).
   */
  async function verifyStepUpCode(userId: string, purpose: 'payout_change', code: string): Promise<boolean> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return false;
    const at = now();
    const challenge = await db.otpChallenge.findFirst({
      where: { email: user.email, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge || challenge.expiresAt <= at || challenge.attempts >= config.OTP_MAX_ATTEMPTS) return false;
    if (!(await otpCodes.verifyCode(challenge.codeHash, code.trim()))) {
      await db.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      return false;
    }
    const { count } = await db.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: at },
    });
    return count === 1;
  }

  /** A fresh rotation family. Used on login. */
  async function issueSession(
    userId: string,
    deviceLabel?: string,
    client: AuthClient = 'app',
  ): Promise<{ access: string; refresh: string }> {
    const familyId = newId();
    return mintPair(userId, familyId, deviceLabel, undefined, client);
  }

  async function mintPair(
    userId: string,
    familyId: string,
    deviceLabel?: string,
    replaces?: string,
    client: AuthClient = 'app',
    /** portal R6 — a rotated portal token keeps its family's end. */
    expiresAt?: Date,
  ): Promise<{ access: string; refresh: string }> {
    const { token, hash } = tokens.newRefreshToken();
    const row = await db.refreshToken.create({
      data: {
        id: newId(),
        userId,
        tokenHash: hash,
        familyId,
        deviceLabel: deviceLabel ?? null,
        client,
        expiresAt: expiresAt ?? tokens.refreshExpiry(now(), client),
      },
    });
    if (replaces) {
      await db.refreshToken.update({
        where: { id: replaces },
        data: { replacedBy: row.id },
      });
    }
    const access = await tokens.signAccessToken({
      sub: userId,
      sid: familyId,
      ver: 0,
      client,
    });
    return { access, refresh: token };
  }

  /**
   * identity R6, R7 — rotate on every use. Presenting a token that has already
   * been spent revokes the ENTIRE family: every device in that lineage must log
   * in again.
   */
  async function rotateSession(
    refreshToken: string,
    client: AuthClient = 'app',
  ): Promise<{ access: string; refresh: string }> {
    const hash = tokens.hashRefreshToken(refreshToken);
    const row = await db.refreshToken.findUnique({ where: { tokenHash: hash } });

    // portal R6 — an app token is not a portal session, nor the other way round.
    if (!row || row.client !== client) {
      throw new UserError(IdentityCode.SESSION_REUSE_DETECTED, 'Please sign in again.');
    }

    const spent = row.replacedBy !== null || row.revokedAt !== null;
    if (spent) {
      await db.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: now() },
      });
      throw new UserError(IdentityCode.SESSION_REUSE_DETECTED, 'Please sign in again.');
    }

    if (row.expiresAt <= now()) {
      throw new UserError(IdentityCode.SESSION_REUSE_DETECTED, 'Please sign in again.');
    }

    const user = await db.user.findUnique({ where: { id: row.userId } });
    if (!user || user.status !== 'active') {
      throw new UserError(IdentityCode.ACCOUNT_SUSPENDED, 'This account is unavailable.');
    }

    // portal R1 — a role taken away ends the portal session at its next refresh.
    if (client === 'portal' && !(await platformRoleFor(row.userId))) {
      await db.refreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: now() },
      });
      throw new UserError(IdentityCode.NOT_STAFF, 'This portal is for the PL4Y team.');
    }

    await db.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: now() },
    });
    return mintPair(
      row.userId,
      row.familyId,
      row.deviceLabel ?? undefined,
      row.id,
      client,
      client === 'portal' ? row.expiresAt : undefined,
    );
  }

  async function revokeAllSessions(userId: string): Promise<void> {
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now() },
    });
  }

  async function revokeSession(userId: string, familyId: string): Promise<void> {
    await db.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: now() },
    });
  }

  // --- account status (R8, R18) -----------------------------------------------

  /**
   * R8 — suspension revokes existing sessions, not just future issuance.
   * `admin` passes its transaction so the audit row commits with the change.
   */
  async function suspend(userId: string, reason: string, tx?: Tx): Promise<void> {
    await inTx(tx, async (t) => {
      await t.user.update({ where: { id: userId }, data: { status: 'suspended' } });
      await t.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now() },
      });
      await outboxWrite(t, { topic: 'user.suspended', payload: { userId, reason } });
    });
  }

  /**
   * R18 — back to `active`. Sessions revoked by the suspension STAY revoked:
   * the user signs in again, on a device they can prove they hold.
   */
  async function reinstate(userId: string, reason: string, tx?: Tx): Promise<void> {
    await inTx(tx, async (t) => {
      const moved = await t.user.updateMany({
        where: { id: userId, status: 'suspended' },
        data: { status: 'active' },
      });
      if (moved.count === 0) return;
      await outboxWrite(t, { topic: 'user.reinstated', payload: { userId, reason } });
    });
  }

  /**
   * R18 — the user's own request. Every session is revoked at once; the
   * personal data goes after the grace period, in `scrubDeletedUsers`.
   *
   * Refused while anything registered as a guard still depends on the account
   * — a partner in an upcoming draw, an organizer still owed money.
   */
  async function requestAccountDeletion(actor: { userId: string }): Promise<void> {
    const user = await db.user.findUnique({ where: { id: actor.userId } });
    if (!user || user.status === 'deleted') return;

    const blockers = (await Promise.all(deletionGuards.map((g) => g(actor.userId)))).flat();
    if (blockers.length > 0) {
      throw new UserError(
        IdentityCode.ACCOUNT_DELETION_BLOCKED,
        'Your account cannot be deleted yet. Finish or withdraw from what is listed first.',
        { details: { blockers } },
      );
    }

    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: actor.userId },
        data: { status: 'deleted', deletionRequestedAt: now() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: actor.userId, revokedAt: null },
        data: { revokedAt: now() },
      });
      await outboxWrite(tx, {
        topic: 'user.deletion_requested',
        payload: { userId: actor.userId },
      });
    });
  }

  /** Composition roots add guards here; see DeletionGuard. */
  function registerDeletionGuard(guard: DeletionGuard): void {
    deletionGuards.push(guard);
  }

  /** Composition roots add hooks here; see SignInHook. */
  function registerSignInHook(hook: SignInHook): void {
    signInHooks.push(hook);
  }

  /**
   * R18 — `scrub-deleted-users`, daily. Replaces the email, clears phone,
   * display name and avatar, and emits `user.scrubbed` so profile and
   * notifications scrub theirs.
   *
   * The ROW stays. Ledger entries, registrations and match results keep their
   * user reference, because financial and competitive records must survive
   * (conventions.md §2). Scrubbing frees the address for a new signup.
   */
  async function scrubDeletedUsers(limit = 200): Promise<number> {
    const due = await db.user.findMany({
      where: {
        status: 'deleted',
        deletionRequestedAt: { lte: new Date(now().getTime() - graceMs) },
        NOT: { email: { endsWith: '@invalid' } },
      },
      select: { id: true },
      orderBy: { deletionRequestedAt: 'asc' },
      take: limit,
    });

    for (const { id } of due) {
      await db.$transaction(async (tx) => {
        await tx.user.update({
          where: { id },
          data: {
            email: scrubbedEmail(id),
            phoneE164: null,
            displayName: SCRUBBED_DISPLAY_NAME,
            avatarPublicId: null,
          },
        });
        await outboxWrite(tx, { topic: 'user.scrubbed', payload: { userId: id } });
      });
    }
    return due.length;
  }

  // --- event grants (R10, R16) ------------------------------------------------

  /**
   * identity R10 — read per request, memoised only for the life of that
   * request. Never cached across requests: an organizer's grant is revocable
   * and sits on a screen that can rewrite match results.
   *
   * R16 — a direct grant and an organizer-derived one resolve to the higher.
   */
  async function grantsFor(userId: string, eventId: string): Promise<Grant | null> {
    const rows = await db.eventStaff.findMany({ where: { eventId, userId } });
    const best = highestGrant(rows);
    return best ? { eventId: best.eventId, userId: best.userId, role: best.role as StaffRole } : null;
  }

  async function grantsForUser(userId: string): Promise<Grant[]> {
    const rows = await db.eventStaff.findMany({ where: { userId } });
    const byEvent = new Map<string, typeof rows>();
    for (const row of rows) byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row]);
    return [...byEvent.values()].map((eventRows) => {
      const best = highestGrant(eventRows)!;
      return { eventId: best.eventId, userId: best.userId, role: best.role as StaffRole };
    });
  }

  /** Everyone with a grant on the event, once each, at their highest role (R16). */
  async function staffFor(eventId: string): Promise<Grant[]> {
    const rows = await db.eventStaff.findMany({ where: { eventId } });
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    return [...byUser.values()].map((userRows) => {
      const best = highestGrant(userRows)!;
      return { eventId: best.eventId, userId: best.userId, role: best.role as StaffRole };
    });
  }

  /** R16 — touches only `direct` rows. A sync never touches these. */
  async function addStaff(eventId: string, userId: string, role: StaffRole, tx?: Tx): Promise<Grant> {
    const row = await (tx ?? db).eventStaff.upsert({
      where: { eventId_userId_source: { eventId, userId, source: 'direct' } },
      create: { eventId, userId, role, source: 'direct' },
      update: { role },
    });
    return { eventId: row.eventId, userId: row.userId, role: row.role as StaffRole };
  }

  async function removeStaff(eventId: string, userId: string): Promise<void> {
    await db.eventStaff.deleteMany({ where: { eventId, userId, source: 'direct' } });
  }

  /**
   * R16 — the ONLY writer of `source = 'organizer'` rows. `organizers` calls it
   * inside its own transaction (organizers R3), so a membership change and the
   * access it implies commit together, and revocation is effective on the very
   * next request (R10). `role: null` removes the organizer's rows for that
   * user; `eventIds: 'all'` means every event the organizer's rows cover.
   */
  async function syncOrganizerGrants(
    tx: Tx,
    input: {
      organizerProfileId: string;
      userId: string;
      eventIds: string[] | 'all';
      role: StaffRole | null;
    },
  ): Promise<void> {
    const { organizerProfileId, userId, eventIds, role } = input;

    if (role === null) {
      await tx.eventStaff.deleteMany({
        where: {
          userId,
          source: 'organizer',
          organizerProfileId,
          ...(eventIds === 'all' ? {} : { eventId: { in: eventIds } }),
        },
      });
      return;
    }

    const targets =
      eventIds === 'all'
        ? (
            await tx.eventStaff.findMany({
              where: { organizerProfileId, source: 'organizer' },
              select: { eventId: true },
              distinct: ['eventId'],
            })
          ).map((r) => r.eventId)
        : eventIds;

    for (const eventId of targets) {
      await tx.eventStaff.upsert({
        where: { eventId_userId_source: { eventId, userId, source: 'organizer' } },
        create: { eventId, userId, role, source: 'organizer', organizerProfileId },
        update: { role, organizerProfileId },
      });
    }
  }

  // --- platform roles (R15) ---------------------------------------------------

  /** Read per request through a request-scoped loader. Never a JWT claim. */
  async function platformRoleFor(userId: string): Promise<PlatformRole | null> {
    const row = await db.platformStaff.findUnique({ where: { userId } });
    return (row?.role as PlatformRole | undefined) ?? null;
  }

  /**
   * Changed only through `admin`, which audits every change in the same
   * transaction (admin R2). `grantedBy` is null only for the CLI bootstrap.
   */
  async function setPlatformRole(
    tx: Tx,
    grantedBy: string | null,
    userId: string,
    role: PlatformRole | null,
  ): Promise<void> {
    if (role === null) {
      await tx.platformStaff.deleteMany({ where: { userId } });
    } else {
      await tx.platformStaff.upsert({
        where: { userId },
        create: { userId, role, grantedBy },
        update: { role, grantedBy },
      });
    }
    await outboxWrite(tx, {
      topic: 'platform_role.changed',
      payload: { userId, role, grantedBy },
    });
  }

  // --- contact and profile fields ---------------------------------------------

  /** R12 — contact only. Stored, never verified, never an auth factor. */
  async function setPhone(userId: string, phone: string | null): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { phoneE164: phone } });
  }

  /**
   * `display_name` and `avatar_public_id` live on `users`, which this module
   * owns exclusively (conventions.md §1). `profile` renders both on every
   * player card, so they are read and written through here rather than with a
   * cross-module UPDATE.
   */
  async function usersByIds(
    ids: string[],
  ): Promise<{ id: string; displayName: string; avatarPublicId: string | null }[]> {
    if (ids.length === 0) return [];
    const rows = await db.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true, avatarPublicId: true },
    });
    return rows;
  }

  /**
   * The same rows, WITH the email address. A separate method on purpose:
   * usersByIds() feeds every player card in the graph, and an email address
   * that rides along on a render path is an email address that eventually gets
   * logged (conventions.md §8).
   *
   * Only the modules that actually send mail — registration invites, payment
   * receipts — call this one.
   */
  async function contactsByIds(
    ids: string[],
  ): Promise<{ id: string; displayName: string; email: string; phone: string | null }[]> {
    if (ids.length === 0) return [];
    const rows = await db.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true, email: true, phoneE164: true },
    });
    return rows.map(({ phoneE164, ...r }) => ({ ...r, phone: phoneE164 }));
  }

  /**
   * Binds a partner invite to an existing account when there is one
   * (registration R12), so accepting is one tap rather than a signup.
   */
  /**
   * F20 — a walk-in with no account. The address is on a reserved domain
   * nothing delivers to, so the row can never sign in (OTP mail goes nowhere)
   * and the email transport drops anything sent to it.
   */
  async function createGuest(displayName: string): Promise<{ id: string }> {
    const id = newId();
    await db.user.create({
      data: { id, email: `guest-${id}@${GUEST_EMAIL_DOMAIN}`, displayName: displayName.trim(), isGuest: true },
    });
    return { id };
  }

  async function findByEmail(
    address: string,
  ): Promise<{ id: string; displayName: string } | null> {
    const row = await db.user.findUnique({
      where: { email: normaliseEmail(address) },
      select: { id: true, displayName: true },
    });
    return row;
  }

  /** ADR 0003 §C3 — a Cloudinary public_id, never a URL. */
  async function setAvatar(userId: string, publicId: string | null): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { avatarPublicId: publicId } });
  }

  /** `display_name` lives on users; profile validates it and changes it through here. */
  async function setDisplayName(userId: string, displayName: string): Promise<void> {
    await db.user.update({ where: { id: userId }, data: { displayName } });
  }

  /** R13 — driven by the Resend delivery webhook. */
  async function recordDeliveryEvent(
    address: string,
    type: 'delivered' | 'bounced' | 'complained',
  ): Promise<void> {
    if (type === 'delivered') return;
    await db.user.updateMany({
      where: { email: normaliseEmail(address) },
      data: { emailStatus: type === 'bounced' ? 'bounced' : 'complained' },
    });
  }

  return {
    requestOtp,
    verifyOtp,
    requestStepUpCode,
    verifyStepUpCode,
    rotateSession,
    revokeSession,
    revokeAllSessions,
    suspend,
    reinstate,
    requestAccountDeletion,
    registerDeletionGuard,
    registerSignInHook,
    scrubDeletedUsers,
    grantsFor,
    grantsForUser,
    staffFor,
    addStaff,
    removeStaff,
    syncOrganizerGrants,
    platformRoleFor,
    setPlatformRole,
    setPhone,
    usersByIds,
    contactsByIds,
    createGuest,
    findByEmail,
    setAvatar,
    setDisplayName,
    recordDeliveryEvent,
    normaliseEmail,
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
