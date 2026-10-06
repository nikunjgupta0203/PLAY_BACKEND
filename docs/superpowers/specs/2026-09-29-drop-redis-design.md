# Drop Redis — jobs, rate limits and caching on Postgres

**Status:** approved 2026-09-29 · **Owner:** platform

## Why

Render's free Key Value (Redis) has no persistence and a 25 MB cap: every restart loses the delayed
jobs (seat-hold release, registration close, quiet-hours pushes) and the five-minute sweeps quietly
clean up after it. Anything better is a paid plan. Postgres (Neon) is already the source of truth,
already persistent, and already polled every 250 ms by the outbox drain — so it never idles and a
queue on it costs nothing extra.

## What Redis does today, and what replaces it

| Today | Replacement |
|---|---|
| BullMQ — 8 queues, delayed jobs, `jobId` dedupe, retries with exponential backoff, per-queue concurrency, 10 cron repeatables | A `jobs` table claimed with `FOR UPDATE SKIP LOCKED` (the outbox's own pattern), plus a `job_schedules` table for the cron repeatables. `platform/queue.ts` keeps its call shape: `queue(name).add(jobName, data, opts)`, `startWorker(name, processor, { concurrency })`, `closeQueues()` |
| Sliding-window limiter (`rl:*` sorted sets) — OTP sends, organizer messages, Pusher auth | A `rate_limit_hits` table behind the same `consume` / `consumeAll` / `reset` signatures, serialised per key with `pg_advisory_xact_lock` |
| Ranking board cache (`rank:*`) | Removed. The rating service already treats the cache as optional and reads Postgres when it is absent |

**Not pg-boss.** The app talks to Neon through PgBouncer in transaction mode (ADR 0001 §C2); a
library that owns its own `pg` pool and session state is a second connection story to get right.
The queue needs ~250 lines on the Prisma client we already have.

## Semantics that must survive the move

- **Delayed jobs** — `delay` ms → `run_at`.
- **Dedupe** — `jobId` becomes `dedupe_key`: at most one *queued or running* job per
  `(queue, dedupe_key)`; a second `add` meanwhile is a no-op. Once it has finished, a new copy may be
  queued — every job is idempotent (conventions §6), and this fixes BullMQ's quirk where a retained
  completed job swallowed later `rebuild-rankings-{sport}` requests.
- **Retries** — `attempts` (default 3), backoff `1000 ms × 2^(attempt−1)`. Final failure → `failed`,
  kept for inspection (30 days).
- **Stalls** — a claimed job holds a 5-minute lease (`locked_until`). A crashed worker's job is
  reclaimed after the lease; one past its attempts is failed without running.
- **Concurrency** — per queue, per process, as BullMQ did (tournament and rating stay at 1).
- **Repeatables** — 5-field cron in UTC (`*`, `*/n`, `a`, `a-b`, `a,b`). A schedule fires once per
  due tick even after a long sleep (no catch-up storm). Schedules not registered at boot are deleted.
- **Housekeeping** — completed jobs pruned after 7 days, failed after 30; rate-limit rows older than
  the longest window (24 h) pruned hourly.

## Out of scope

- Moving live-score fan-out: it already publishes straight from the outbox drain (scoring R5).
- LISTEN/NOTIFY wake-ups — not available through PgBouncer transaction mode; 1 s polling is enough.

## Done when

- `bullmq`, `ioredis`, `@testcontainers/redis` are gone from `package.json`; `REDIS_URL` is gone from
  config, `.env.example`, `render.yaml`, `docker-compose.yml`.
- `pnpm check` passes (typecheck, lint, guard, tests), including new DB-backed suites for the queue
  and the limiter.
- `/readyz` checks Postgres only.
