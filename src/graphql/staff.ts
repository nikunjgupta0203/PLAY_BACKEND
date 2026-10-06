/**
 * PL4Y staff (identity R15) — the people who use the admin portal
 * (PLAY_FRONTEND/docs/modules/25-admin-portal.md). Read per request through the
 * loader, never a claim in the token.
 *
 * Lives beside `userError.ts` because no single module owns it: events,
 * scoring, registration, payments and organisations all have staff-only fields.
 */
import { UserError, forbidden } from '../platform/errors/index.js';
import { abandonAudit, beginAudit, settleAudit, type AuditEntry } from '../platform/audit.js';
import { db } from '../platform/db.js';
import type { Ctx } from './context.js';
import { requireActor } from './userError.js';

export type PlatformStaffRole = 'admin' | 'support' | 'finance';

/**
 * portal R1, R2 — a staff role AND a portal session. A staff member signed in
 * on their phone is a player there: the app's session never reaches a staff
 * field, whoever holds it.
 */
export async function requirePlatformStaff(
  ctx: Ctx,
  roles: PlatformStaffRole[] = ['admin', 'support', 'finance'],
): Promise<{ userId: string; role: PlatformStaffRole }> {
  const actor = requireActor(ctx);
  if (actor.client !== 'portal') throw forbidden();
  const role = (await ctx.loaders.platformRole.load(actor.userId)) as PlatformStaffRole | null;
  if (!role || !roles.includes(role)) throw forbidden();
  return { userId: actor.userId, role };
}

/** portal R3 — a reason of at least 5 characters, kept in the audit log. */
export const MIN_REASON = 5;

export function requireReason(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed.length < MIN_REASON) {
    throw new UserError('REASON_REQUIRED', `Say why, in at least ${MIN_REASON} characters. It goes in the audit log.`);
  }
  return trimmed;
}

/**
 * portal R3, 15-admin R2 — checks the reason, writes the audit row, runs the
 * action, then marks the row done. A refused action deletes its row: it
 * changed nothing. A crash between the action and the mark leaves the row
 * `pending`, so the record survives (see platform/audit.ts).
 */
export async function audited<T>(
  staff: { userId: string },
  what: Omit<AuditEntry, 'actorUserId' | 'reason'>,
  rawReason: string | null | undefined,
  fn: (reason: string) => Promise<T>,
): Promise<T> {
  const reason = requireReason(rawReason);
  const auditId = await beginAudit(db, { ...what, actorUserId: staff.userId, reason });
  let result: T;
  try {
    result = await fn(reason);
  } catch (err) {
    await abandonAudit(db, auditId);
    throw err;
  }
  await settleAudit(db, auditId);
  return result;
}
