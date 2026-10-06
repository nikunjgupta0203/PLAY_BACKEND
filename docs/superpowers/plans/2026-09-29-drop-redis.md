# Drop Redis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the job queue, the rate limiter and every cache on Postgres so the backend needs no Redis.

**Architecture:** A `jobs` table claimed with `FOR UPDATE SKIP LOCKED` (the outbox's pattern) replaces
BullMQ behind the same `queue(name).add(...)` / `startWorker(...)` surface; a `job_schedules` table
plus a small UTC cron parser replaces BullMQ repeatables; a `rate_limit_hits` table serialised by
`pg_advisory_xact_lock` replaces the Redis sorted-set limiter; the ranking cache is simply not wired.

**Tech Stack:** Node 22, TypeScript, Prisma 6 (raw SQL for claims), Postgres 16, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-29-drop-redis-design.md`

## Global Constraints

- No new runtime dependency. Remove `bullmq`, `ioredis`, `@testcontainers/redis`.
- Every SQL path works through PgBouncer transaction mode: `pg_advisory_xact_lock` only, no LISTEN, no session `SET` (ADR 0001 §C3, `pnpm guard`).
- Never edit an applied migration (Prisma checksums them). New migration: `20260929120000_023_jobs_and_rate_limits`.
- Call sites keep compiling unchanged: `queue(QUEUES.x).add(name, data, { ...defaultJobOptions, delay?, jobId?, attempts? })`, `startWorker(name, processor, { concurrency? })`, `closeQueues()`, `consume`, `consumeAll`, `reset`.
- Dedupe: at most one `queued` or `active` job per `(queue, dedupe_key)`.
- Backoff: `backoff_ms × 2^(attempts−1)`; default `attempts: 3`, `backoffMs: 1000`.
- Lease 5 min, renewed every 2.5 min while a job runs. Poll every 1 s; scheduler tick every 15 s.
- Retention: completed jobs 7 days, failed 30 days, rate-limit rows 24 h.

## Review Focus

1. A job running longer than its lease (weekly `run-period`, a big `bulk-refund`) must not be claimed a second time — Task 3 heartbeat test.
2. A service that slept for hours (Render free) fires each overdue schedule **once**, not once per missed slot — Task 3 schedule test.
3. Two requests racing for the last rate-limit slot: exactly `max` succeed — Task 4 concurrency test.
4. Shutdown mid-job waits for the job instead of abandoning it active — Task 3 close test.
5. The same `jobId` added while an earlier copy is still running is a no-op, and a completed copy never blocks a new one — Task 3 dedupe test.

---

### Task 1: UTC cron parser

**Files:**
- Create: `src/platform/cron.ts`
- Test: `src/platform/cron.test.ts`

**Interfaces:**
- Produces: `parseCron(pattern: string): void` (throws on a bad pattern), `nextRun(pattern: string, after: Date): Date` — first matching minute strictly after `after`, UTC.

- [ ] **Step 1: Write the failing test** — `src/platform/cron.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { nextRun, parseCron } from './cron.js';

const at = (iso: string) => new Date(iso);

describe('nextRun', () => {
  it('steps: */5 lands on the next multiple of five', () => {
    expect(nextRun('*/5 * * * *', at('2026-09-29T10:02:30Z'))).toEqual(at('2026-09-29T10:05:00Z'));
  });
  it('is strictly after: a pattern matching `after` itself moves on', () => {
    expect(nextRun('0 * * * *', at('2026-09-29T10:00:00Z'))).toEqual(at('2026-09-29T11:00:00Z'));
  });
  it('every minute rounds up to the next whole minute', () => {
    expect(nextRun('* * * * *', at('2026-09-29T10:00:59.999Z'))).toEqual(at('2026-09-29T10:01:00Z'));
  });
  it('daily at a fixed time rolls to tomorrow once passed', () => {
    expect(nextRun('15 3 * * *', at('2026-09-29T03:15:00Z'))).toEqual(at('2026-09-30T03:15:00Z'));
  });
  it('weekly: rating R4 period, Sunday 21:30 UTC', () => {
    // 2026-09-28 is a Monday.
    expect(nextRun('30 21 * * 0', at('2026-09-28T00:00:00Z'))).toEqual(at('2026-10-04T21:30:00Z'));
  });
  it('lists and ranges', () => {
    expect(nextRun('0 9-10,14 * * *', at('2026-09-29T10:30:00Z'))).toEqual(at('2026-09-29T14:00:00Z'));
  });
  it('day-of-month and day-of-week both restricted: either matches (standard cron)', () => {
    // 2026-10-01 is a Thursday; the 5th is the first Monday after it.
    expect(nextRun('0 0 1 * 1', at('2026-09-29T00:00:00Z'))).toEqual(at('2026-10-01T00:00:00Z'));
  });
});

describe('parseCron', () => {
  it.each(['61 * * * *', '* * *', '*/0 * * * *', 'a * * * *', '* * * * 7', '5-1 * * * *'])(
    'rejects %s',
    (bad) => {
      expect(() => parseCron(bad)).toThrow(/cron/);
    },
  );
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `pnpm vitest run src/platform/cron.test.ts`

- [ ] **Step 3: Implement** — `src/platform/cron.ts`

```ts
/**
 * Five-field cron in UTC, for the job schedules in worker.ts.
 *
 * Only what those schedules need: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, and lists
 * of them. A pattern outside that throws at registration — at boot, not in the
 * middle of the week the job was meant to run.
 */
interface Field {
  name: string;
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
];

interface Cron {
  fields: Set<number>[];
  /** Standard cron: when BOTH day fields are restricted, either one matching is enough. */
  domAny: boolean;
  dowAny: boolean;
}

function parseField(text: string, field: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m?.[1]) throw new Error(`cron: bad ${field.name} "${part}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    let lo = field.min;
    let hi = field.max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number) as [number, number | undefined];
      lo = a;
      hi = b ?? (m[2] === undefined ? a : field.max);
    }
    if (step < 1 || lo < field.min || hi > field.max || lo > hi) {
      throw new Error(`cron: ${field.name} "${part}" is out of range`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function compile(pattern: string): Cron {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: "${pattern}" needs five fields`);
  return {
    fields: parts.map((p, i) => parseField(p, FIELDS[i]!)),
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

/** Throws when the pattern is not one this parser understands. */
export function parseCron(pattern: string): void {
  compile(pattern);
}

function matches(c: Cron, t: Date): boolean {
  const [minute, hour, dom, month, dow] = c.fields as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!minute.has(t.getUTCMinutes()) || !hour.has(t.getUTCHours())) return false;
  if (!month.has(t.getUTCMonth() + 1)) return false;
  const domOk = dom.has(t.getUTCDate());
  const dowOk = dow.has(t.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** The first minute strictly after `after` that the pattern matches. */
export function nextRun(pattern: string, after: Date): Date {
  const c = compile(pattern);
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  // A year of minutes: every valid pattern matches inside it.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, t)) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new Error(`cron: "${pattern}" never fires`);
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm vitest run src/platform/cron.test.ts`

- [ ] **Step 5: Commit** — `git add src/platform/cron.ts src/platform/cron.test.ts && git commit -m "feat(platform): UTC cron parser for Postgres job schedules"`

---

### Task 2: Migration and Prisma models

**Files:**
- Create: `prisma/migrations/20260929120000_023_jobs_and_rate_limits/migration.sql`
- Modify: `prisma/schema.prisma` (after `model Outbox`)

**Interfaces:**
- Produces: tables `jobs`, `job_schedules`, `rate_limit_hits`; Prisma delegates `db.job`, `db.jobSchedule`, `db.rateLimitHit`.

- [ ] **Step 1: Write the migration**

```sql
-- 023 — the job queue and the rate limiter move from Redis to Postgres
-- (docs/superpowers/specs/2026-09-29-drop-redis-design.md).

-- One row per job. Claimed with FOR UPDATE SKIP LOCKED, like the outbox.
CREATE TABLE "jobs" (
    "id"           BIGSERIAL PRIMARY KEY,
    "queue"        TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "data"         JSONB NOT NULL DEFAULT '{}',
    "dedupe_key"   TEXT,
    "state"        TEXT NOT NULL DEFAULT 'queued'
                   CHECK ("state" IN ('queued', 'active', 'completed', 'failed')),
    "attempts"     SMALLINT NOT NULL DEFAULT 0,
    "max_attempts" SMALLINT NOT NULL DEFAULT 3 CHECK ("max_attempts" >= 1),
    "backoff_ms"   INTEGER NOT NULL DEFAULT 1000,
    "run_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "locked_until" TIMESTAMPTZ(6),
    "last_error"   TEXT,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "finished_at"  TIMESTAMPTZ(6)
);

-- The claim: due work per queue.
CREATE INDEX "jobs_due_idx" ON "jobs" ("queue", "run_at") WHERE "state" = 'queued';
-- Leases that ran out — a worker died holding them.
CREATE INDEX "jobs_lease_idx" ON "jobs" ("queue", "locked_until") WHERE "state" = 'active';
-- At most one pending-or-running copy per key. A completed copy never blocks a new one.
CREATE UNIQUE INDEX "jobs_dedupe_idx" ON "jobs" ("queue", "dedupe_key")
    WHERE "state" IN ('queued', 'active');
-- Retention pruning.
CREATE INDEX "jobs_finished_idx" ON "jobs" ("finished_at") WHERE "state" IN ('completed', 'failed');

-- The repeatables. `key` is "<queue>:<name>".
CREATE TABLE "job_schedules" (
    "key"         TEXT PRIMARY KEY,
    "queue"       TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "cron"        TEXT NOT NULL,
    "next_run_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- One row per consumed attempt of a sliding window.
CREATE TABLE "rate_limit_hits" (
    "id"  BIGSERIAL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "at"  TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX "rate_limit_hits_key_at_idx" ON "rate_limit_hits" ("key", "at");
CREATE INDEX "rate_limit_hits_at_idx" ON "rate_limit_hits" ("at");
```

- [ ] **Step 2: Add the models to `prisma/schema.prisma`, directly after `model Outbox { ... }`**

```prisma
/// The job queue (platform/queue.ts). Partial indexes live in migration 023.
model Job {
  id          BigInt    @id @default(autoincrement())
  queue       String
  name        String
  data        Json      @default("{}")
  dedupeKey   String?   @map("dedupe_key")
  /// queued | active | completed | failed. CHECK in the migration.
  state       String    @default("queued")
  attempts    Int       @default(0) @db.SmallInt
  maxAttempts Int       @default(3) @map("max_attempts") @db.SmallInt
  backoffMs   Int       @default(1000) @map("backoff_ms")
  runAt       DateTime  @default(now()) @map("run_at") @db.Timestamptz(6)
  lockedUntil DateTime? @map("locked_until") @db.Timestamptz(6)
  lastError   String?   @map("last_error")
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  finishedAt  DateTime? @map("finished_at") @db.Timestamptz(6)

  @@map("jobs")
}

/// Repeatable jobs. `key` is "<queue>:<name>".
model JobSchedule {
  key       String   @id
  queue     String
  name      String
  cron      String
  nextRunAt DateTime @map("next_run_at") @db.Timestamptz(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("job_schedules")
}

/// platform/rateLimit.ts — one row per consumed attempt.
model RateLimitHit {
  id  BigInt   @id @default(autoincrement())
  key String
  at  DateTime @db.Timestamptz(6)

  @@index([key, at])
  @@index([at])
  @@map("rate_limit_hits")
}
```

- [ ] **Step 3: Validate and generate** — Run: `pnpm prisma validate && pnpm db:generate`. Expected: valid schema, client generated. (The migration itself is exercised by the DB-backed suites in Tasks 3–4.)

- [ ] **Step 4: Commit** — `git add prisma && git commit -m "feat(db): 023 jobs, job_schedules, rate_limit_hits"`

---

### Task 3: Postgres job queue, scheduler, and worker wiring

**Files:**
- Rewrite: `src/platform/queue.ts`
- Modify: `src/worker.ts` (repeatables → schedules, maintenance queue, scheduler start/stop)
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `nextRun`, `parseCron` (Task 1); `db.job`, `db.jobSchedule` (Task 2); `Db`, `Tx` from `platform/db.ts`.
- Produces:
  - `QUEUES` (adds `maintenance`), `QueueName`, `JobsOptions { attempts?, backoffMs?, delay?, jobId? }`, `defaultJobOptions`, `Job<T> { id: bigint; name: string; data: T; attempts: number }`, `Processor`.
  - `createJobStore(db: Db, opts?: { leaseMs?: number })` → `{ add, claim, complete, fail, extend, schedule, pruneSchedules, tickSchedules, prune }`.
  - `createQueueRuntime(db: Db, opts?: { pollMs?: number; leaseMs?: number; tickMs?: number })` → `{ store, queue, startWorker, startScheduler, close }`.
  - Module singletons: `queue`, `startWorker`, `startScheduler`, `closeQueues`, `jobStore`.

- [ ] **Step 1: Write the failing test** — `tests/queue.test.ts`

```ts
/**
 * The Postgres job queue (platform/queue.ts) against a real database: the
 * claim, dedupe and lease semantics live in SQL and a partial unique index,
 * which is exactly what a mock would hide (conventions.md §5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { createJobStore, createQueueRuntime, type Job } from '../src/platform/queue.js';

let prisma: PrismaClient;
let store: ReturnType<typeof createJobStore>;

beforeAll(async () => {
  ({ prisma } = await startTestDb());
  store = createJobStore(prisma);
});
afterAll(async () => {
  await stopTestDb();
});
beforeEach(async () => {
  await truncateAll(prisma);
});

const rows = () => prisma.job.findMany({ orderBy: { id: 'asc' } });
const makeDue = (id: bigint) =>
  prisma.$executeRaw`UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = ${id}`;

describe('add and claim', () => {
  it('a job is claimed once, with its data and a first attempt', async () => {
    await store.add('events', 'close-registration', { eventId: 'e1' });
    const [job] = await store.claim('events', 5);
    expect(job).toMatchObject({ name: 'close-registration', data: { eventId: 'e1' }, attempts: 1 });
    expect(await store.claim('events', 5)).toHaveLength(0);
    expect((await rows())[0]!.state).toBe('active');
  });

  it('queues are separate', async () => {
    await store.add('events', 'x', {});
    expect(await store.claim('payments', 5)).toHaveLength(0);
  });

  it('a delayed job is not claimable until it is due', async () => {
    await store.add('registration', 'release-hold', { holdId: 'h' }, { delay: 60_000 });
    expect(await store.claim('registration', 5)).toHaveLength(0);
    await makeDue((await rows())[0]!.id);
    expect(await store.claim('registration', 5)).toHaveLength(1);
  });

  it('dedupe: one queued-or-running copy per jobId; a completed copy blocks nothing', async () => {
    expect(await store.add('rating', 'rebuild-rankings', {}, { jobId: 'rebuild-s1' })).toBe(true);
    expect(await store.add('rating', 'rebuild-rankings', {}, { jobId: 'rebuild-s1' })).toBe(false);
    const [job] = await store.claim('rating', 1);
    expect(await store.add('rating', 'rebuild-rankings', {}, { jobId: 'rebuild-s1' })).toBe(false);
    await store.complete(job!.id);
    expect(await store.add('rating', 'rebuild-rankings', {}, { jobId: 'rebuild-s1' })).toBe(true);
    expect(await rows()).toHaveLength(2);
  });
});

describe('failure', () => {
  it('retries with doubling backoff, then fails for good and keeps the error', async () => {
    await store.add('payments', 'apply-webhook', {}, { attempts: 3, backoffMs: 1_000 });
    for (const [attempt, minDelay] of [[1, 1_000], [2, 2_000]] as const) {
      const [job] = await store.claim('payments', 1);
      expect(job!.attempts).toBe(attempt);
      const before = Date.now();
      expect(await store.fail(job!.id, `boom ${attempt}`)).toBe('queued');
      const row = (await rows())[0]!;
      expect(row.runAt.getTime()).toBeGreaterThanOrEqual(before + minDelay - 50);
      await makeDue(row.id);
    }
    const [last] = await store.claim('payments', 1);
    expect(await store.fail(last!.id, 'boom 3')).toBe('failed');
    const row = (await rows())[0]!;
    expect(row).toMatchObject({ state: 'failed', lastError: 'boom 3' });
    expect(row.finishedAt).not.toBeNull();
  });

  it('a lease that ran out is claimed again — the worker holding it died', async () => {
    await store.add('tournament', 'schedule-courts', {});
    const [first] = await store.claim('tournament', 1);
    expect(await store.claim('tournament', 1)).toHaveLength(0);
    await prisma.$executeRaw`UPDATE jobs SET locked_until = now() - interval '1 second'`;
    const [again] = await store.claim('tournament', 1);
    expect(again).toMatchObject({ id: first!.id, attempts: 2 });
  });
});

describe('schedules', () => {
  it('registers with the next matching time, and rejects a bad pattern at registration', async () => {
    await store.schedule('identity', 'purge-expired-otp', '0 * * * *');
    const s = await prisma.jobSchedule.findUniqueOrThrow({ where: { key: 'identity:purge-expired-otp' } });
    expect(s.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(s.nextRunAt.getUTCMinutes()).toBe(0);
    await expect(store.schedule('identity', 'bad', '99 * * * *')).rejects.toThrow(/cron/);
  });

  it('re-registering the same pattern keeps the time; a new pattern re-times it', async () => {
    await store.schedule('notify', 'prune', '30 4 * * *');
    await prisma.jobSchedule.update({ where: { key: 'notify:prune' }, data: { nextRunAt: new Date('2030-01-01T00:00:00Z') } });
    await store.schedule('notify', 'prune', '30 4 * * *');
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { key: 'notify:prune' } })).nextRunAt).toEqual(
      new Date('2030-01-01T00:00:00Z'),
    );
    await store.schedule('notify', 'prune', '45 4 * * *');
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { key: 'notify:prune' } })).nextRunAt.getUTCMinutes()).toBe(45);
  });

  it('an overdue schedule fires ONCE however long the service slept, then moves to the future', async () => {
    await store.schedule('tournament', 'sweep-results', '* * * * *');
    await prisma.jobSchedule.updateMany({ data: { nextRunAt: new Date(Date.now() - 6 * 3_600_000) } });
    expect(await store.tickSchedules()).toBe(1);
    const jobs = await rows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queue: 'tournament', name: 'sweep-results', dedupeKey: 'schedule:tournament:sweep-results' });
    const s = await prisma.jobSchedule.findFirstOrThrow();
    expect(s.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(await store.tickSchedules()).toBe(0);
  });

  it('a schedule due again while its last run is still queued does not stack a second copy', async () => {
    await store.schedule('tournament', 'sweep-results', '* * * * *');
    await prisma.jobSchedule.updateMany({ data: { nextRunAt: new Date(Date.now() - 1_000) } });
    await store.tickSchedules();
    await prisma.jobSchedule.updateMany({ data: { nextRunAt: new Date(Date.now() - 1_000) } });
    await store.tickSchedules();
    expect(await rows()).toHaveLength(1);
  });

  it('schedules no longer registered are dropped', async () => {
    await store.schedule('identity', 'a', '0 * * * *');
    await store.schedule('identity', 'b', '0 * * * *');
    expect(await store.pruneSchedules(['identity:a'])).toBe(1);
    expect((await prisma.jobSchedule.findMany()).map((s) => s.key)).toEqual(['identity:a']);
  });
});

describe('retention', () => {
  it('prunes completed jobs after 7 days and failed ones after 30', async () => {
    const day = 86_400_000;
    const now = Date.now();
    await prisma.job.createMany({
      data: [
        { queue: 'q', name: 'old-done', state: 'completed', finishedAt: new Date(now - 8 * day) },
        { queue: 'q', name: 'new-done', state: 'completed', finishedAt: new Date(now - 1 * day) },
        { queue: 'q', name: 'old-failed', state: 'failed', finishedAt: new Date(now - 31 * day) },
        { queue: 'q', name: 'new-failed', state: 'failed', finishedAt: new Date(now - 8 * day) },
        { queue: 'q', name: 'queued', state: 'queued' },
      ],
    });
    expect(await store.prune()).toBe(2);
    expect((await rows()).map((r) => r.name)).toEqual(['new-done', 'new-failed', 'queued']);
  });
});

describe('runtime', () => {
  it('a worker runs queued jobs and marks them completed', async () => {
    const rt = createQueueRuntime(prisma, { pollMs: 20 });
    const seen: Job[] = [];
    rt.startWorker('events', async (job) => {
      seen.push(job);
    });
    await rt.queue('events').add('promote-to-live', { eventId: 'e1' });
    await vi.waitFor(async () => expect((await rows())[0]!.state).toBe('completed'), { timeout: 5_000 });
    expect(seen.map((j) => j.name)).toEqual(['promote-to-live']);
    await rt.close();
  });

  it('a throwing processor is retried until its attempts run out', async () => {
    const rt = createQueueRuntime(prisma, { pollMs: 20 });
    let calls = 0;
    rt.startWorker('notify', async () => {
      calls += 1;
      throw new Error('push down');
    });
    await rt.queue('notify').add('send-push', {}, { attempts: 2, backoffMs: 10 });
    await vi.waitFor(async () => expect((await rows())[0]!.state).toBe('failed'), { timeout: 5_000 });
    expect(calls).toBe(2);
    await rt.close();
  });

  it('concurrency 1 never runs two jobs of a queue at once', async () => {
    const rt = createQueueRuntime(prisma, { pollMs: 10 });
    let inFlight = 0;
    let peak = 0;
    rt.startWorker(
      'rating',
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
      },
      { concurrency: 1 },
    );
    for (let i = 0; i < 4; i++) await rt.queue('rating').add('rebuild-rankings', { i });
    await vi.waitFor(async () => expect((await rows()).every((r) => r.state === 'completed')).toBe(true), {
      timeout: 5_000,
    });
    expect(peak).toBe(1);
    await rt.close();
  });

  it('a job outliving its lease is kept by the heartbeat, not claimed a second time', async () => {
    const rt = createQueueRuntime(prisma, { pollMs: 10, leaseMs: 200 });
    let calls = 0;
    rt.startWorker('rating', async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 700));
    });
    await rt.queue('rating').add('run-period', {});
    await vi.waitFor(async () => expect((await rows())[0]!.state).toBe('completed'), { timeout: 5_000 });
    expect(calls).toBe(1);
    await rt.close();
  });

  it('close waits for a running job to finish', async () => {
    const rt = createQueueRuntime(prisma, { pollMs: 10 });
    let started = false;
    rt.startWorker('payments', async () => {
      started = true;
      await new Promise((r) => setTimeout(r, 200));
    });
    await rt.queue('payments').add('process-refund', {});
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 });
    await rt.close();
    expect((await rows())[0]!.state).toBe('completed');
  });

  it('the scheduler turns a due schedule into a job', async () => {
    const rt = createQueueRuntime(prisma, { tickMs: 20 });
    await rt.store.schedule('maintenance', 'prune-jobs', '0 4 * * *');
    await prisma.jobSchedule.updateMany({ data: { nextRunAt: new Date(Date.now() - 1_000) } });
    rt.startScheduler();
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1), { timeout: 5_000 });
    await rt.close();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (`createJobStore` not exported)**

Run: `pnpm vitest run tests/queue.test.ts`

- [ ] **Step 3: Rewrite `src/platform/queue.ts`**

```ts
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
```

- [ ] **Step 4: Run the suite — expect PASS**

Run: `pnpm vitest run tests/queue.test.ts`

- [ ] **Step 5: Wire `src/worker.ts`**

Replace the import line for the queue:

```ts
import { QUEUES, closeQueues, defaultJobOptions, jobStore, queue, startScheduler, startWorker } from './platform/queue.js';
```

Replace the whole `registerRepeatables` function with:

```ts
/** [queue, job, cron in UTC]. Anything not listed here is unscheduled at boot. */
const SCHEDULES: [string, string, string][] = [
  // identity — purge jobs (docs/modules/01-identity.md § Jobs)
  [QUEUES.identity, 'purge-expired-otp', '0 * * * *'],
  [QUEUES.identity, 'purge-revoked-tokens', '15 3 * * *'],
  // identity R18 — a deletion request past its 30-day grace. Final failure
  // alerts: a deletion request is overdue.
  [QUEUES.identity, 'scrub-deleted-users', '45 3 * * *'],
  // events — the safety net behind the per-event delayed job above.
  [QUEUES.events, 'sweep-registration-close', '*/5 * * * *'],
  // registration R5 — the safety net behind every delayed release job.
  [QUEUES.registration, 'sweep-stale-holds', '*/5 * * * *'],
  // payments R9 — turns a lost webhook from a support ticket into a thirty-minute delay.
  [QUEUES.payments, 'reconcile-pending', '*/15 * * * *'],
  // scoring R11, R13, R14 — every minute: auto_confirm_at is a floor, and a
  // minute late is the most anyone waits past it.
  [QUEUES.tournament, 'sweep-results', '* * * * *'],
  // notifications — 180-day feed retention.
  [QUEUES.notify, 'prune-notifications', '30 4 * * *'],
  // rating R4 — Monday 03:00 IST, which is 21:30 UTC on Sunday. India has one
  // offset and no daylight saving, so this is a constant, not a conversion.
  [QUEUES.rating, 'run-period', '30 21 * * 0'],
  // platform — the queue's own retention.
  [QUEUES.maintenance, 'prune-jobs', '0 4 * * *'],
];

async function registerSchedules(): Promise<void> {
  for (const [queueName, name, cron] of SCHEDULES) {
    await jobStore.schedule(queueName, name, cron);
  }
  const dropped = await jobStore.pruneSchedules(SCHEDULES.map(([q, n]) => `${q}:${n}`));
  if (dropped > 0) logger.info({ dropped }, 'unregistered stale job schedules');
}
```

In `startWorkers`, replace `await registerRepeatables();` with `await registerSchedules();`, add the maintenance worker before the outbox drain block:

```ts
  startWorker(QUEUES.maintenance, async (job) => {
    switch (job.name) {
      case 'prune-jobs': {
        const count = await jobStore.prune();
        if (count > 0) logger.info({ count }, 'pruned finished jobs');
        return;
      }
      default:
        logger.warn({ job: job.name }, 'unknown maintenance job');
    }
  });

  const scheduler = startScheduler();
```

and make the returned stop function stop both: `return () => { clearInterval(timer); void scheduler.close(); };`

Update the two comments that blame Redis for lost delayed jobs (`'event.published'` handler and the old `registerRepeatables` block) to say "a delayed job that is lost" — the sweeps stay as defence in depth.

- [ ] **Step 6: Typecheck** — Run: `pnpm typecheck`. Expected: clean (notifications and payments call sites compile unchanged).

- [ ] **Step 7: Commit** — `git add src/platform/queue.ts src/worker.ts tests/queue.test.ts && git commit -m "feat(platform): job queue on Postgres replaces BullMQ"`

---

### Task 4: Rate limiter on Postgres

**Files:**
- Rewrite: `src/platform/rateLimit.ts`
- Modify: `src/worker.ts` (maintenance `prune-rate-limits` schedule + case)
- Test: `tests/rateLimit.test.ts`

**Interfaces:**
- Consumes: `db.rateLimitHit` (Task 2); `QUEUES.maintenance`, `SCHEDULES` (Task 3).
- Produces: `Window`, `LimitResult` (unchanged), `createRateLimiter(db: Db)` → `{ consume, consumeAll, reset, prune }`; singletons `consume`, `consumeAll`, `reset`, `pruneRateLimits`; `LONGEST_WINDOW_SECONDS = 86_400`.

- [ ] **Step 1: Write the failing test** — `tests/rateLimit.test.ts`

```ts
/** platform/rateLimit.ts against a real database — the race is the point. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { createRateLimiter } from '../src/platform/rateLimit.js';

let prisma: PrismaClient;
let limiter: ReturnType<typeof createRateLimiter>;
const W = { seconds: 10, max: 3 };
const T0 = Date.parse('2026-09-29T10:00:00Z');

beforeAll(async () => {
  ({ prisma } = await startTestDb());
  limiter = createRateLimiter(prisma);
});
afterAll(async () => {
  await stopTestDb();
});
beforeEach(async () => {
  await truncateAll(prisma);
});

describe('consume', () => {
  it('allows `max` inside the window, counting down what remains', async () => {
    expect((await limiter.consume('k', W, T0)).remaining).toBe(2);
    expect((await limiter.consume('k', W, T0 + 1_000)).remaining).toBe(1);
    expect(await limiter.consume('k', W, T0 + 2_000)).toEqual({ allowed: true, retryAfterSeconds: 0, remaining: 0 });
  });

  it('rejects past max with the wait until the oldest hit leaves, without consuming', async () => {
    for (const dt of [0, 1_000, 2_000]) await limiter.consume('k', W, T0 + dt);
    expect(await limiter.consume('k', W, T0 + 5_000)).toEqual({ allowed: false, retryAfterSeconds: 5, remaining: 0 });
    expect(await prisma.rateLimitHit.count()).toBe(3);
    // The oldest hit leaves at exactly T0 + 10 s.
    expect((await limiter.consume('k', W, T0 + 10_000)).allowed).toBe(true);
  });

  it('keys are independent', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('a', W, T0);
    expect((await limiter.consume('b', W, T0)).allowed).toBe(true);
  });

  it('racing requests never get more than max between them', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => limiter.consume('race', W, T0)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(await prisma.rateLimitHit.count({ where: { key: 'race' } })).toBe(3);
  });
});

describe('consumeAll', () => {
  it('the first rejection wins and later windows are not consumed', async () => {
    const tight = { seconds: 60, max: 1 };
    await limiter.consume('email', tight, T0);
    const r = await limiter.consumeAll(
      [
        { key: 'email', window: tight },
        { key: 'ip', window: W },
      ],
      T0 + 1_000,
    );
    expect(r.allowed).toBe(false);
    expect(await prisma.rateLimitHit.count({ where: { key: 'ip' } })).toBe(0);
  });
});

describe('reset and prune', () => {
  it('reset clears one key', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('k', W, T0);
    await limiter.reset('k');
    expect((await limiter.consume('k', W, T0)).allowed).toBe(true);
  });

  it('prune drops rows older than the longest window and keeps the rest', async () => {
    await limiter.consume('old', W, Date.now() - 25 * 3_600_000);
    await limiter.consume('new', W, Date.now());
    expect(await limiter.prune()).toBe(1);
    expect((await prisma.rateLimitHit.findMany()).map((r) => r.key)).toEqual(['new']);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (`createRateLimiter` not exported)**

Run: `pnpm vitest run tests/rateLimit.test.ts`

- [ ] **Step 3: Rewrite `src/platform/rateLimit.ts`**

```ts
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
    const cutoff = new Date(now - window.seconds * 1000);
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rl:${key}`}))`;
      await tx.rateLimitHit.deleteMany({ where: { key, at: { lte: cutoff } } });
      const count = await tx.rateLimitHit.count({ where: { key } });

      if (count >= window.max) {
        const oldest = await tx.rateLimitHit.findFirst({ where: { key }, orderBy: { at: 'asc' } });
        const oldestMs = oldest?.at.getTime() ?? now;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldestMs + window.seconds * 1000 - now) / 1000));
        return { allowed: false, retryAfterSeconds, remaining: 0 };
      }

      await tx.rateLimitHit.create({ data: { key, at: new Date(now) } });
      return { allowed: true, retryAfterSeconds: 0, remaining: window.max - count - 1 };
    });
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
```

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm vitest run tests/rateLimit.test.ts`

- [ ] **Step 5: Schedule the prune in `src/worker.ts`**

Add `import { pruneRateLimits } from './platform/rateLimit.js';`, append to `SCHEDULES`:

```ts
  [QUEUES.maintenance, 'prune-rate-limits', '5 * * * *'],
```

and add to the maintenance worker's switch:

```ts
      case 'prune-rate-limits': {
        const count = await pruneRateLimits();
        if (count > 0) logger.info({ count }, 'pruned rate-limit rows');
        return;
      }
```

- [ ] **Step 6: Typecheck** — `pnpm typecheck`. Expected: clean.

- [ ] **Step 7: Commit** — `git add src/platform/rateLimit.ts src/worker.ts tests/rateLimit.test.ts && git commit -m "feat(platform): rate limiter on Postgres"`

---

### Task 5: Remove Redis

**Files:**
- Delete: `src/platform/redis.ts`
- Modify: `src/modules/rating/index.ts`, `src/modules/rating/service/index.ts` (comments only), `src/app.ts`, `src/all.ts`, `src/worker.ts`, `src/platform/config.ts`, `src/platform/config.test.ts`, `scripts/seed-dev-data.ts`, `scripts/write-schema.ts`, `tests/helpers/modules.ts`, `tests/identity.test.ts` (comments), `package.json`, `docker-compose.yml`, `.env.example`, `render.yaml`

**Interfaces:**
- Consumes: Tasks 3–4 (nothing imports `platform/redis.ts` any more once this task is done).

- [ ] **Step 1: Rating stops wiring a cache.** In `src/modules/rating/index.ts` delete the `redis` import, the `TTL_SECONDS` constant, the `cache` object and its doc comment, the `cache,` property passed to `createRatingService`, and the now-unused `logger` import and `RankingRow`/`BoardCachePort` type imports if nothing else uses them. `BoardCachePort` stays in the service (tests inject a fake; the port is optional). In `src/modules/rating/service/index.ts` change the two "Redis copy" comments to "An optional copy of the top of each board" and "The board is served from Postgres when the cache is not there".

- [ ] **Step 2: Entry points.**
  - `src/app.ts`: drop the `redis` / `disconnectRedis` import, the `await redis.ping();` line, change the readiness body to `{ ok: true, postgres: true }`, delete the `await disconnectRedis();` shutdown line.
  - `src/all.ts`: drop the `disconnectRedis` import and call; the header comment reads "share the db and queue connections".
  - `src/worker.ts`: drop the `disconnectRedis` import and call.
  - `src/platform/config.ts`: delete `REDIS_URL: z.string().url(),`. `src/platform/config.test.ts`: delete the `REDIS_URL` fixture line.

- [ ] **Step 3: Scripts and test comments.**
  - `scripts/seed-dev-data.ts` (~line 611): the teardown imports only `closeQueues`; remove the Redis import and `disconnectRedis()` call, comment says "the queues".
  - `scripts/write-schema.ts` line 8 comment: "module singletons (Prisma)".
  - `tests/helpers/modules.ts` header: "bind the real db and Cloudinary". `tests/identity.test.ts`: "In-memory sliding window, so the suite needs no database round-trips."

- [ ] **Step 4: Dependencies and deploy files.**
  - Run: `pnpm remove bullmq ioredis @testcontainers/redis`
  - `docker-compose.yml`: delete the `redis` service and the `pl4y_redis` volume.
  - `.env.example`: delete `REDIS_URL="redis://localhost:6379"`.
  - `render.yaml`: delete the `keyvalue` service block and its comment, the `REDIS_URL` envVar on `pl4y-api`, and the header bullet about free Key Value; add "· jobs live in Postgres (`jobs` table), so a restart or a sleep loses none of them."

- [ ] **Step 5: Verify nothing references Redis.**

Run: `grep -rniE "redis|bullmq|ioredis" src tests scripts package.json docker-compose.yml render.yaml .env.example`
Expected: no output.

- [ ] **Step 6: Full check** — Run: `pnpm check`. Expected: typecheck, lint, guard and every test pass.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "chore: remove Redis — queue, limiter and cache run on Postgres"`

---

### Task 6: Docs

**Files:**
- Modify: `docs/architecture.md`, `docs/conventions.md`, `docs/modules/00-platform.md`, `src/platform/outbox.ts` (header comment)

- [ ] **Step 1:** `docs/architecture.md` — diagram: worker "Postgres job queue", data row drops "Redis 7"; stack table row `Jobs | Postgres (jobs table, SKIP LOCKED) | Delayed jobs, cron schedules (job_schedules), retries`; `/readyz` comment "pg reachable"; file tree drops `redis.ts`, adds `cron.ts`; replace "### What Redis holds" with "### Where the fast state lives": rate limits → `rate_limit_hits` (24 h), jobs → `jobs` (7/30-day retention), ranking board → read from Postgres; keep the "never" rule re-worded as "correctness state never lives in a cache". Environments row "Docker Postgres"; drop `REDIS_URL=`.
- [ ] **Step 2:** `docs/conventions.md` line 38 and `src/platform/outbox.ts` header: "drained into the Postgres job queue by the worker".
- [ ] **Step 3:** `docs/modules/00-platform.md`: file list — remove `redis.ts`, `queue.ts` "Postgres job queue + worker + scheduler", add `cron.ts`, `rateLimit.ts` "Postgres sliding window"; checklist items reworded (readyz checks Postgres).
- [ ] **Step 4: Verify** — `grep -rniE "redis|bullmq" docs --include=*.md | grep -v superpowers/` shows only historical ADR mentions, if any.
- [ ] **Step 5: Commit** — `git add docs src/platform/outbox.ts && git commit -m "docs: jobs and rate limits live in Postgres"`
