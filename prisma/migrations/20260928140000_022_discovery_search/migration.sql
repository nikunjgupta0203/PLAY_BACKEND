-- events R11 — the tournament / league-season distinction discovery filters on.
ALTER TABLE "events"
    ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'tournament'
    CHECK ("kind" IN ('tournament', 'league_season'));

-- discovery R1 — free-text search. ILIKE '%q%' is served only by a trigram
-- index (pg_trgm is enabled by 003_profile). Partial, like every discovery
-- index: drafts and deleted rows are never searched.
CREATE INDEX "events_title_trgm_idx" ON "events" USING GIN ("title" gin_trgm_ops)
    WHERE "status" IN ('published', 'live');
CREATE INDEX "venues_name_trgm_idx" ON "venues" USING GIN ("name" gin_trgm_ops)
    WHERE "deleted_at" IS NULL;
