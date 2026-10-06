import { PrismaClient } from '@prisma/client';
import { config, isProd } from './config.js';

/**
 * Prisma runs against Neon's POOLED endpoint (PgBouncer, transaction mode).
 * Migrations use DIRECT_DATABASE_URL — see ADR 0001 §C2.
 *
 * Under transaction pooling, session-scoped state does not survive between
 * statements: use pg_advisory_xact_lock, never pg_advisory_lock; SET LOCAL,
 * never bare SET (ADR 0001 §C3, enforced by scripts/guard.ts).
 */
export const db = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['warn', 'error'],
  datasources: { db: { url: config.DATABASE_URL } },
  // Prisma's default unless raised — scripts run far from the database (a
  // laptop seeding a remote one) need more than 5 s per transaction.
  transactionOptions: { timeout: config.DB_TX_TIMEOUT_MS },
});

export type Db = typeof db;
/** A transaction client — what services accept so callers control the boundary. */
export type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

export async function disconnectDb(): Promise<void> {
  await db.$disconnect();
}
