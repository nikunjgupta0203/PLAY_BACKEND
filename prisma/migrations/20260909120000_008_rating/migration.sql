-- 008 — rating (docs/modules/08-rating.md)
--
-- Glicko-2 per player per sport, written APPEND-ONLY, with `rankings` as a
-- cache rebuilt on write.
--
-- `rating_events` is a LOG. Nothing here is ever updated in place: a rating is
-- superseded by a later row, and every row carries the `algo_version` that
-- produced it. Replacing the model means writing 'glicko2-v2' and replaying the
-- log — no migration, no backfill, no lost history (rating R8). That is the
-- entire reason this table is shaped the way it is, and an UPDATE against it is
-- a bug rather than an optimisation.
--
-- `rankings` is the opposite: a derived cache, safe to truncate and rebuild,
-- and read by nothing that makes a decision.

-- CreateTable
CREATE TABLE "rating_periods" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "ran_at" TIMESTAMPTZ(6),
    "algo_version" TEXT NOT NULL,

    CONSTRAINT "rating_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating_events" (
    "id" BIGSERIAL NOT NULL,
    "player_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    -- No foreign key: `matches` belongs to tournament and lands in Sprint 8.
    -- The tournament migration adds the constraint, exactly as 005 added the
    -- one `event_staff` had been waiting for since 001.
    "match_id" UUID,
    "rating_period_id" UUID,
    "algo_version" TEXT NOT NULL,
    "rating_before" DECIMAL(7,2) NOT NULL,
    "rating_after" DECIMAL(7,2) NOT NULL,
    "rd_before" DECIMAL(7,2) NOT NULL,
    "rd_after" DECIMAL(7,2) NOT NULL,
    "volatility_after" DECIMAL(7,5) NOT NULL,
    -- How many matches this row covers: 1 for a provisional row, a whole
    -- period's card for a settled one. rating R9 ranks on a count of SETTLED
    -- matches, and a settled row carries no match_id — it is one update over a
    -- week, which is what Glicko-2 is defined over. Without this column the
    -- count would have to be kept somewhere outside the log, and anything
    -- outside the log does not survive a replay (R8).
    "matches_played" SMALLINT NOT NULL DEFAULT 0,
    "is_provisional" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rankings" (
    "sport_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "player_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "rating" DECIMAL(7,2) NOT NULL,
    "matches_played" INTEGER NOT NULL,
    "movement" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rankings_pkey" PRIMARY KEY ("sport_id","scope","player_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rating_periods_sport_id_starts_at_key"
    ON "rating_periods"("sport_id", "starts_at");

-- The history read: one player's ladder in one sport, newest first.
CREATE INDEX "rating_events_player_id_sport_id_created_at_idx"
    ON "rating_events"("player_id", "sport_id", "created_at" DESC);

-- rating R3 — ONE settled row per player per match. Provisional rows are
-- deliberately outside the index: a player may have a provisional row and the
-- settled row that supersedes it, and both belong in the log.
CREATE UNIQUE INDEX "rating_events_settled_uniq"
    ON "rating_events"("player_id", "match_id")
    WHERE "is_provisional" = false AND "match_id" IS NOT NULL;

-- rating R4 — `run-period` is retried three times and pages on final failure,
-- so it has to be safe to run twice. One settled row per player per period is
-- what makes the retry a no-op instead of a second rating change.
CREATE UNIQUE INDEX "rating_events_player_id_rating_period_id_key"
    ON "rating_events"("player_id", "rating_period_id")
    WHERE "rating_period_id" IS NOT NULL;

-- The leaderboard read (rating R11 — rank is stored, never computed per page).
CREATE INDEX "rankings_board_idx" ON "rankings"("sport_id", "scope", "rank");

-- AddForeignKey
ALTER TABLE "rating_periods" ADD CONSTRAINT "rating_periods_sport_id_fkey"
    FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_player_id_fkey"
    FOREIGN KEY ("player_id") REFERENCES "player_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_sport_id_fkey"
    FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_rating_period_id_fkey"
    FOREIGN KEY ("rating_period_id") REFERENCES "rating_periods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "rankings" ADD CONSTRAINT "rankings_sport_id_fkey"
    FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rankings" ADD CONSTRAINT "rankings_player_id_fkey"
    FOREIGN KEY ("player_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- rating R10 — the scope vocabulary, enforced rather than documented. An
-- open-ended scope string is an unbounded table, and the one thing a cache must
-- not be is unbounded.
ALTER TABLE "rankings"
    ADD CONSTRAINT "rankings_scope_check"
    CHECK ("scope" = 'national' OR "scope" LIKE 'city:%' OR "scope" LIKE 'age:%');

-- A rank is a position, and positions start at one.
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_rank_check" CHECK ("rank" >= 1);

-- A period that ends before it starts would silently rate nothing.
ALTER TABLE "rating_periods"
    ADD CONSTRAINT "rating_periods_window_check" CHECK ("ends_at" > "starts_at");
