-- 029 — heat rounds. A category's heats run in rounds: round 1 splits the
-- entries into heats; the top of each closed heat (and the best of the rest)
-- go through to round 2, and so on to the final.

ALTER TABLE "heats" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 1 CHECK ("round" >= 1);
CREATE INDEX "heats_event_category_id_round_idx" ON "heats" ("event_category_id", "round");
