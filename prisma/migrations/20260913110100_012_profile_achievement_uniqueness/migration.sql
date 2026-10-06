-- 012 — profile fix-forward (docs/modules/03-profile.md R13)
--
-- `event_id` is null for most achievements ('first_win' has no event), and a
-- plain UNIQUE index treats NULLs as distinct — so the same achievement could
-- be awarded twice. NULLS NOT DISTINCT needs Postgres 15+.

-- Any duplicates already written would make the new constraint fail to build.
-- Keep the earliest award of each.
DELETE FROM "achievements" a
 USING "achievements" b
 WHERE a."player_id" = b."player_id"
   AND a."key" = b."key"
   AND a."event_id" IS NOT DISTINCT FROM b."event_id"
   AND (a."earned_at", a."id") > (b."earned_at", b."id");

DROP INDEX "achievements_player_id_key_event_id_key";

ALTER TABLE "achievements"
    ADD CONSTRAINT "achievements_award_uniq"
    UNIQUE NULLS NOT DISTINCT ("player_id", "key", "event_id");

-- R13 — tiered achievements (bronze / silver / gold as 1 / 2 / 3).
ALTER TABLE "achievements" ADD COLUMN "tier" SMALLINT;
