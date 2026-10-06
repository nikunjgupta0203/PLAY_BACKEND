-- 003 — profile (docs/modules/03-profile.md)
--
-- 001 created a player_profiles stub because identity R9 needs a profile to
-- exist in the same transaction as its user. This migration completes the
-- module: sports per player, achievements, follows, and the CHECK constraints
-- the stub deferred.

-- CreateExtension
-- profile.search() matches display names with ILIKE '%q%'. Only a trigram
-- index serves that; a btree on display_name would not be read.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateTable
CREATE TABLE "player_sports" (
    "player_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "skill_band" TEXT NOT NULL,
    "rating" DECIMAL(7,2),
    "rating_dev" DECIMAL(7,2),
    "volatility" DECIMAL(7,5),
    "is_provisional" BOOLEAN NOT NULL DEFAULT true,
    "matches_played" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "player_sports_pkey" PRIMARY KEY ("player_id","sport_id")
);

-- CreateTable
CREATE TABLE "achievements" (
    "id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "sport_id" UUID,
    "key" TEXT NOT NULL,
    "event_id" UUID,
    "earned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "follower_id" UUID NOT NULL,
    "followee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id","followee_id")
);

-- CreateIndex
-- The leaderboard read. NULLS LAST is deliberate and Prisma cannot express it:
-- an unrated player belongs at the bottom of a board, not the top.
CREATE INDEX "player_sports_sport_id_rating_idx" ON "player_sports"("sport_id", "rating" DESC NULLS LAST);

-- CreateIndex
-- NULLS NOT DISTINCT (PG15+): event_id IS NULL is a standing achievement, and
-- 'first_win' must be awarded to a player once, not once per insert (R7-style
-- idempotency for the award path).
CREATE UNIQUE INDEX "achievements_player_id_key_event_id_key"
    ON "achievements"("player_id", "key", "event_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "follows_followee_id_idx" ON "follows"("followee_id");

-- CreateIndex
CREATE INDEX "users_display_name_idx" ON "users" USING GIN ("display_name" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "player_sports" ADD CONSTRAINT "player_sports_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_sports" ADD CONSTRAINT "player_sports_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "achievements" ADD CONSTRAINT "achievements_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_fkey" FOREIGN KEY ("followee_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- profile R4 — the three visibilities, as text + CHECK so a fourth is a data
-- change rather than a migration (conventions.md §2).
ALTER TABLE "player_profiles"
    ADD CONSTRAINT "player_profiles_visibility_check"
    CHECK ("visibility" IN ('public', 'players_only', 'private'));

-- profile R7 — self-follow is rejected by the service AND here, because the
-- service is not the only thing that will ever write this table.
ALTER TABLE "follows"
    ADD CONSTRAINT "follows_no_self_check" CHECK ("follower_id" <> "followee_id");
