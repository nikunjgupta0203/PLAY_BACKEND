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
