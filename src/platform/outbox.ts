/**
 * Transactional outbox (platform R5, R6).
 *
 * Modules talk to each other synchronously through service calls. Side effects
 * that can fail independently — a push, a ranking rebuild, a Pusher publish —
 * are written here INSIDE the same transaction as the state change, then
 * drained into the Postgres job queue (platform/queue.ts) by the worker.
 *
 * No in-process event emitter: it looks decoupled and quietly loses work
 * whenever the process dies mid-request.
 */
import type { Tx } from './db.js';
import { db } from './db.js';

export interface OutboxMessage {
  topic: string;
  payload: Record<string, unknown>;
  requestId?: string;
}

/** Write inside the caller's transaction. Never call this outside one. */
export async function write(tx: Tx, msg: OutboxMessage): Promise<void> {
  await tx.outbox.create({
    data: {
      topic: msg.topic,
      payload: msg.payload as object,
      requestId: msg.requestId ?? null,
    },
  });
}

/**
 * Claim a batch with FOR UPDATE SKIP LOCKED so two workers never dispatch the
 * same row. Dispatch is at-least-once, so every consumer must be idempotent.
 */
export async function claimBatch(limit = 100): Promise<
  { id: bigint; topic: string; payload: unknown; requestId: string | null }[]
> {
  return db.$queryRaw`
    UPDATE outbox
       SET claimed_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox
        WHERE processed_at IS NULL
          AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
    RETURNING id, topic, payload, request_id AS "requestId";
  `;
}

export async function markProcessed(ids: bigint[]): Promise<void> {
  if (ids.length === 0) return;
  await db.outbox.updateMany({
    where: { id: { in: ids } },
    data: { processedAt: new Date() },
  });
}

export async function markFailed(id: bigint, error: string): Promise<void> {
  await db.outbox.update({
    where: { id },
    data: { claimedAt: null, lastError: error.slice(0, 2000) },
  });
}

export const outbox = { write, claimBatch, markProcessed, markFailed };
