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
