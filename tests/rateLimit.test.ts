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
