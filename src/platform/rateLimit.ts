/**
 * Sliding-window limiter on Postgres. identity R3 (OTP sends), organizer
 * messages (events), Pusher auth.
 *
 * One row per consumed attempt. Each check runs in its own transaction under a
 * per-key `pg_advisory_xact_lock` (ADR 0001 §C3), so two requests racing for
 * the last slot cannot both take it.
 */
import { db as defaultDb, type Db } from './db.js';

export interface Window {
  /** Window length in seconds. */
  seconds: number;
  /** Maximum events allowed inside the window. */
  max: number;
}

export interface LimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. 0 when allowed. */
  retryAfterSeconds: number;
  remaining: number;
}

/** The longest window anything uses (identity's per-IP day). Older rows are pruned. */
export const LONGEST_WINDOW_SECONDS = 86_400;

export function createRateLimiter(db: Db) {
  /**
   * Check-and-consume. Returns allowed:false without consuming when the window
   * is already full, so a rejected attempt does not extend the lockout.
   */
  async function consume(key: string, window: Window, now = Date.now()): Promise<LimitResult> {
    // Speed — one round trip: lock, prune, count and insert run inside the
    // rate_limit_consume function (migration 039), not as six statements.
    const rows = await db.$queryRaw<{ allowed: boolean; retry_after_seconds: number; remaining: number }[]>`
      SELECT allowed, retry_after_seconds, remaining
        FROM rate_limit_consume(${key}, ${new Date(now)}::timestamptz, ${window.seconds}::int, ${window.max}::int)`;
    const r = rows[0]!;
    return { allowed: r.allowed, retryAfterSeconds: r.retry_after_seconds, remaining: r.remaining };
  }

  /** Consume across several windows; the first rejection wins. */
  async function consumeAll(checks: { key: string; window: Window }[], now = Date.now()): Promise<LimitResult> {
    for (const c of checks) {
      const r = await consume(c.key, c.window, now);
      if (!r.allowed) return r;
    }
    return { allowed: true, retryAfterSeconds: 0, remaining: 0 };
  }

  async function reset(key: string): Promise<void> {
    await db.rateLimitHit.deleteMany({ where: { key } });
  }

  /** Rows no window can still see. Hourly, from the maintenance queue. */
  async function prune(): Promise<number> {
    const { count } = await db.rateLimitHit.deleteMany({
      where: { at: { lt: new Date(Date.now() - LONGEST_WINDOW_SECONDS * 1000) } },
    });
    return count;
  }

  return { consume, consumeAll, reset, prune };
}

const limiter = createRateLimiter(defaultDb);

export const consume = limiter.consume;
export const consumeAll = limiter.consumeAll;
export const reset = limiter.reset;
export const pruneRateLimits = limiter.prune;
