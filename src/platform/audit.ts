/**
 * portal R3 — the audit trail. Every staff action that moves money, changes
 * who may do what, or settles a result writes one row: who did it, what, on
 * what, and the reason they gave.
 *
 * Lives in platform because every module has staff actions and none of them
 * owns the trail. Pass the transaction when there is one, so the row commits
 * with the change it records.
 *
 * 15-admin R2 asks for the row in the same transaction as the change. Our
 * services do not take the caller's transaction, and several staff actions
 * call a payment gateway that cannot sit inside one. So `beginAudit` writes
 * the row FIRST as `pending`; the action runs; `settleAudit` marks it
 * `succeeded`, or `abandonAudit` deletes it when the action was refused. A
 * crash in between leaves `pending` in the log — the record is never lost, and
 * the portal shows the outcome as unknown so someone checks the target.
 */
import type { Prisma } from '@prisma/client';
import type { Db, Tx } from './db.js';
import { newId } from './ids.js';

export interface AuditEntry {
  actorUserId: string;
  /** Verb-first, dotted: `payout.release`, `organisation.create`. */
  action: string;
  targetType:
    | 'event'
    | 'event_report'
    | 'match'
    | 'payout'
    | 'payout_account'
    | 'registration'
    | 'user'
    | 'organisation'
    | 'platform_staff'
    | 'moderation_report'
    | 'support_ticket'
    | 'fraud_signal'
    | 'venue'
    | 'court_booking';
  targetId: string;
  reason?: string | null;
  details?: Record<string, unknown>;
}

/** One finished action, written at once (`succeeded`). */
export async function recordAudit(conn: Db | Tx, entry: AuditEntry): Promise<void> {
  await conn.auditLog.create({ data: toRow(newId(), entry, 'succeeded') });
}

/** 15-admin R2 — the row, before the action. Returns its id for `settleAudit` / `abandonAudit`. */
export async function beginAudit(conn: Db | Tx, entry: AuditEntry): Promise<string> {
  const id = newId();
  await conn.auditLog.create({ data: toRow(id, entry, 'pending') });
  return id;
}

export async function settleAudit(conn: Db | Tx, id: string): Promise<void> {
  await conn.auditLog.update({ where: { id }, data: { outcome: 'succeeded' } });
}

/** A refused action changed nothing, so it leaves no row (15-admin, Done when). */
export async function abandonAudit(conn: Db | Tx, id: string): Promise<void> {
  await conn.auditLog.deleteMany({ where: { id, outcome: 'pending' } });
}

function toRow(id: string, entry: AuditEntry, outcome: 'pending' | 'succeeded') {
  return {
    id,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    reason: entry.reason?.trim() || null,
    details: (entry.details ?? {}) as Prisma.InputJsonValue,
    outcome,
  };
}
