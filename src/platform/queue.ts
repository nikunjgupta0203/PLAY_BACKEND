/**
 * Job queues on Postgres (conventions.md §6). Every job is idempotent, because
 * every job can be retried — and a job re-added while an earlier copy ran can
 * run twice.
 *
 * The outbox's own pattern: rows claimed with FOR UPDATE SKIP LOCKED, so any
 * number of workers share a queue without a broker. A delay is `run_at`, a
 * retry is `run_at` pushed back, and a worker that dies holding a job gives it
 * back when its lease runs out. Polling, not LISTEN/NOTIFY: Neon's pooled
 * endpoint is PgBouncer in transaction mode, where a LISTEN does not survive
 * (ADR 0001 §C3).
 */
import { db as defaultDb, type Db, type Tx } from './db.js';
import { nextRun, parseCron } from './cron.js';
import { logger } from './logging/index.js';

export const QUEUES = {
  realtime: 'realtime',
  identity: 'identity',
  events: 'events',
  registration: 'registration',
  payments: 'payments',
  tournament: 'tournament',
  rating: 'rating',
  notify: 'notify',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobsOptions {
  /** Tries in total, the first included. */
  attempts?: number;
  /** The first retry waits this long; each later one twice the one before. */
  backoffMs?: number;
  /** Earliest start, in ms from now. */
  delay?: number;
  /** At most one queued-or-running job per queue carries this key; another add is a no-op. */
  jobId?: string;
}

export const defaultJobOptions = { attempts: 3, backoffMs: 1_000 } satisfies JobsOptions;

/** What a processor is handed. */
export interface Job<T = unknown> {
  id: bigint;
  name: string;
  data: T;
  /** 1 on the first try. */
  attempts: number;
}

export type Processor = (job: Job) => Promise<unknown>;

/** How long a claimed job is its worker's before it is presumed dead. Renewed while it runs. */
const LEASE_MS = 5 * 60_000;

interface Claimed {
  id: bigint;
  name: string;
  data: unknown;
  attempts: number;
  maxAttempts: number;
}

async function insertJob(
  client: Db | Tx,
  queueName: string,
  name: string,
  data: unknown,
  opts: JobsOptions,
): Promise<boolean> {
  const attempts = opts.attempts ?? defaultJobOptions.attempts;
  const backoffMs = opts.backoffMs ?? defaultJobOptions.backoffMs;
  const delay = Math.max(opts.delay ?? 0, 0);
  const inserted = await client.$executeRaw`
    INSERT INTO jobs (queue, name, data, dedupe_key, max_attempts, backoff_ms, run_at)
    VALUES (${queueName}, ${name}, ${JSON.stringify(data ?? {})}::jsonb, ${opts.jobId ?? null},
            ${attempts}, ${backoffMs}, now() + ${delay}::float8 * interval '1 millisecond')
    ON CONFLICT (queue, dedupe_key) WHERE state IN ('queued', 'active') DO NOTHING`;
  return inserted > 0;
}

export function createJobStore(db: Db, opts: { leaseMs?: number } = {}) {
  const leaseMs = opts.leaseMs ?? LEASE_MS;

  return {
    /** True when a job was written; false when a queued-or-running copy already holds `jobId`. */
    add(queueName: string, name: string, data: unknown, jobOpts: JobsOptions = {}): Promise<boolean> {
      return insertJob(db, queueName, name, data, jobOpts);
    },

    /** Due jobs, and jobs whose lease ran out, oldest first. Each claim is an attempt. */
    claim(queueName: string, limit: number): Promise<Claimed[]> {
      return db.$queryRaw<Claimed[]>`
        UPDATE jobs
           SET state = 'active', attempts = attempts + 1,
               locked_until = now() + ${leaseMs}::float8 * interval '1 millisecond'
         WHERE id IN (
           SELECT id FROM jobs
            WHERE queue = ${queueName}
              AND ((state = 'queued' AND run_at <= now())
                OR (state = 'active' AND locked_until < now()))
            ORDER BY run_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
         )
        RETURNING id, name, data, attempts::int AS attempts, max_attempts::int AS "maxAttempts"`;
    },

    /** The heartbeat: a job still running keeps its lease. */
    async extend(id: bigint): Promise<void> {
      await db.$executeRaw`
        UPDATE jobs SET locked_until = now() + ${leaseMs}::float8 * interval '1 millisecond'
         WHERE id = ${id} AND state = 'active'`;
    },

    async complete(id: bigint): Promise<void> {
      await db.$executeRaw`
        UPDATE jobs SET state = 'completed', finished_at = now(), locked_until = NULL
         WHERE id = ${id} AND state = 'active'`;
    },

    /** Back to the queue after a backoff, or `failed` when that was the last attempt. */
    async fail(id: bigint, error: string): Promise<'queued' | 'failed'> {
      const out = await db.$queryRaw<{ state: 'queued' | 'failed' }[]>`
        UPDATE jobs
           SET state = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
               run_at = CASE WHEN attempts < max_attempts
                             THEN now() + backoff_ms * power(2, attempts - 1) * interval '1 millisecond'
                             ELSE run_at END,
               finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
               locked_until = NULL,
               last_error = ${error.slice(0, 2_000)}
         WHERE id = ${id}
        RETURNING state`;
      return out[0]?.state ?? 'failed';
    },

    /**
     * Registers a repeatable, keyed "<queue>:<name>". The same pattern again
     * keeps its next time — a redeploy must not push a weekly job back a week.
     */
    async schedule(queueName: string, name: string, cron: string): Promise<void> {
      parseCron(cron);
      const key = `${queueName}:${name}`;
      const existing = await db.jobSchedule.findUnique({ where: { key } });
      if (existing && existing.cron === cron && existing.queue === queueName) return;
      const nextRunAt = nextRun(cron, new Date());
      await db.jobSchedule.upsert({
        where: { key },
        create: { key, queue: queueName, name, cron, nextRunAt },
        update: { queue: queueName, name, cron, nextRunAt },
      });
    },

    /** Drops every schedule not in `keep` — a job removed from the code stops running. */
    async pruneSchedules(keep: string[]): Promise<number> {
      const { count } = await db.jobSchedule.deleteMany({ where: { key: { notIn: keep } } });
      return count;
    },

    /**
     * Queues each due schedule ONCE and moves it to its next time after now.
     * A service that slept through six runs wakes up to one, not six.
     */
    tickSchedules(): Promise<number> {
      return db.$transaction(async (tx) => {
        const due = await tx.$queryRaw<{ key: string; queue: string; name: string; cron: string }[]>`
          SELECT key, queue, name, cron FROM job_schedules
           WHERE next_run_at <= now()
           FOR UPDATE SKIP LOCKED`;
        for (const s of due) {
          await insertJob(tx, s.queue, s.name, {}, { ...defaultJobOptions, jobId: `schedule:${s.key}` });
          await tx.jobSchedule.update({ where: { key: s.key }, data: { nextRunAt: nextRun(s.cron, new Date()) } });
        }
        return due.length;
      });
    },

    /** Retention: completed after 7 days, failed after 30 (kept that long for inspection). */
    prune(): Promise<number> {
      return db.$executeRaw`
        DELETE FROM jobs
         WHERE (state = 'completed' AND finished_at < now() - interval '7 days')
            OR (state = 'failed' AND finished_at < now() - interval '30 days')`;
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;

interface Closable {
  close(): Promise<void>;
}

export function createQueueRuntime(
  db: Db,
  opts: { pollMs?: number; leaseMs?: number; tickMs?: number } = {},
) {
  const leaseMs = opts.leaseMs ?? LEASE_MS;
  const store = createJobStore(db, { leaseMs });
  const pollMs = opts.pollMs ?? 1_000;
  const tickMs = opts.tickMs ?? 15_000;
  const open = new Set<Closable>();

  function queue(name: QueueName | string) {
    return {
      add: (jobName: string, data: unknown, jobOpts?: JobsOptions) => store.add(name, jobName, data, jobOpts),
    };
  }

  function startWorker(name: QueueName | string, processor: Processor, wopts: { concurrency?: number } = {}): Closable {
    const concurrency = wopts.concurrency ?? 5;
    const running = new Set<Promise<void>>();
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const run = async (row: Claimed): Promise<void> => {
      if (row.attempts > row.maxAttempts) {
        // Its lease ran out on the last attempt: the worker died mid-job, again.
        await store.fail(row.id, 'lease expired on the last attempt');
        logger.error({ queue: name, jobId: String(row.id), job: row.name }, 'job failed: lease expired');
        return;
      }
      const heartbeat = setInterval(() => {
        store.extend(row.id).catch((err: unknown) => logger.warn({ err, jobId: String(row.id) }, 'job lease renewal failed'));
      }, Math.max(leaseMs / 2, 10));
      try {
        await processor({ id: row.id, name: row.name, data: row.data, attempts: row.attempts });
        await store.complete(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const state = await store.fail(row.id, message).catch(() => 'queued' as const);
        logger.error(
          { queue: name, jobId: String(row.id), job: row.name, attempt: row.attempts, final: state === 'failed', err: message },
          'job failed',
        );
      } finally {
        clearInterval(heartbeat);
      }
    };

    const poll = async (): Promise<void> => {
      timer = undefined;
      if (stopped) return;
      const free = concurrency - running.size;
      let claimed = 0;
      if (free > 0) {
        try {
          const rows = await store.claim(name, free);
          claimed = rows.length;
          for (const row of rows) {
            const p: Promise<void> = run(row).finally(() => running.delete(p));
            running.add(p);
          }
        } catch (err) {
          logger.error({ queue: name, err }, 'job claim failed');
        }
      }
      // A full batch means more is probably waiting.
      if (!stopped) timer = setTimeout(() => void poll(), claimed > 0 && claimed === free ? 0 : pollMs);
    };

    const handle: Closable = {
      async close() {
        stopped = true;
        if (timer) clearTimeout(timer);
        await Promise.allSettled([...running]);
        open.delete(handle);
      },
    };
    open.add(handle);
    void poll();
    return handle;
  }

  /** Turns due schedules into jobs every `tickMs`. One per process is enough; SKIP LOCKED makes more harmless. */
  function startScheduler(): Closable {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      store
        .tickSchedules()
        .catch((err: unknown) => logger.error({ err }, 'schedule tick failed'))
        .finally(() => {
          busy = false;
        });
    }, tickMs);
    const handle: Closable = {
      async close() {
        clearInterval(timer);
        open.delete(handle);
      },
    };
    open.add(handle);
    return handle;
  }

  /** Stops every worker and the scheduler, waiting for running jobs. */
  async function close(): Promise<void> {
    await Promise.all([...open].map((c) => c.close()));
  }

  return { store, queue, startWorker, startScheduler, close };
}

const runtime = createQueueRuntime(defaultDb);

export const jobStore = runtime.store;
export const queue = runtime.queue;
export const startWorker = runtime.startWorker;
export const startScheduler = runtime.startScheduler;
export const closeQueues = runtime.close;
