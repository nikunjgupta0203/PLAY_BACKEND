-- 060 — Floodlight live data feeds (PLAY_FRONTEND/docs/design/floodlight-data-sources.md).
--
-- Pro matches, their teams and moments can now come from an outside score feed
-- (CricAPI, API-Football, snooker.org) as well as from PL4Y staff. Prediction
-- options can be tied to a result so a finished match suggests the answer, and
-- content gains `link` items: outside headlines, shown with their source.

-- --- pro: feeds (G1, G2) -----------------------------------------------------------

-- A team a feed created or matched, so the next import finds it by the feed's id.
ALTER TABLE "pro_teams"
    ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN "provider_ref" TEXT;
CREATE UNIQUE INDEX "pro_teams_provider_key" ON "pro_teams"("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;

ALTER TABLE "pro_matches"
    -- G2 — fields PL4Y staff edited by hand. The feed leaves them alone until staff hand them back.
    ADD COLUMN "feed_locked" TEXT[] NOT NULL DEFAULT '{}',
    -- G9 — the last time a feed confirmed this match, changed or not.
    ADD COLUMN "feed_checked_at" TIMESTAMPTZ(6),
    -- Who won, once finished: from the feed, or set by staff. Settle suggestions read it.
    ADD COLUMN "winner" TEXT,
    ADD CONSTRAINT "pro_matches_winner_check" CHECK ("winner" IS NULL OR "winner" IN ('home', 'away', 'draw'));
CREATE INDEX "pro_matches_feed_idx" ON "pro_matches"("provider", "starts_at") WHERE "provider" <> 'manual';

-- A feed's goal or card, written once however many polls see it.
ALTER TABLE "pro_match_moments" ADD COLUMN "provider_ref" TEXT;
CREATE UNIQUE INDEX "pro_match_moments_ref_key" ON "pro_match_moments"("match_id", "provider_ref") WHERE "provider_ref" IS NOT NULL;

-- What PL4Y follows on each feed: a CricAPI series, an API-Football league + season,
-- a snooker.org event, a news search. Staff add them in the portal (/pro/feeds).
CREATE TABLE "pro_feed_follows" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "sport_id" UUID NOT NULL REFERENCES "sports"("id"),
    "name" TEXT NOT NULL,
    "season" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_import_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_feed_follows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pro_feed_follows_provider_check" CHECK ("provider" IN ('cricapi', 'api_football', 'snooker_org', 'google_news', 'newsdata')),
    CONSTRAINT "pro_feed_follows_ref_check" CHECK (char_length("ref") BETWEEN 1 AND 120),
    CONSTRAINT "pro_feed_follows_name_check" CHECK (char_length("name") BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX "pro_feed_follows_key" ON "pro_feed_follows"("provider", "ref", coalesce("season", ''));

-- G10 — calls made today (IST) per provider, against its daily limit. One row each;
-- `day` rolls over on the first call of a new day.
CREATE TABLE "pro_feed_providers" (
    "provider" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "last_call_at" TIMESTAMPTZ(6),
    "last_live_poll_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "last_error_at" TIMESTAMPTZ(6),

    CONSTRAINT "pro_feed_providers_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "pro_feed_providers_calls_check" CHECK ("calls" >= 0)
);

-- --- predictions: settle suggestions (G3, G4) --------------------------------------

-- What an option means for the result, so "Mumbai City" can be read as "home".
ALTER TABLE "prediction_options"
    ADD COLUMN "outcome" TEXT,
    ADD CONSTRAINT "prediction_options_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('home', 'draw', 'away'));

-- The answer the final score points to. Staff confirm it; nothing settles on its own.
ALTER TABLE "prediction_questions"
    ADD COLUMN "suggested_option_id" UUID REFERENCES "prediction_options"("id") ON DELETE SET NULL,
    ADD COLUMN "suggested_home" INTEGER,
    ADD COLUMN "suggested_away" INTEGER,
    ADD COLUMN "suggested_at" TIMESTAMPTZ(6),
    ADD CONSTRAINT "prediction_questions_suggested_check" CHECK (
        ("suggested_home" IS NULL OR "suggested_home" BETWEEN 0 AND 999)
        AND ("suggested_away" IS NULL OR "suggested_away" BETWEEN 0 AND 999));

-- --- content: outside headlines (G6) -----------------------------------------------

ALTER TABLE "content_items" DROP CONSTRAINT "content_items_kind_check";
ALTER TABLE "content_items"
    ADD CONSTRAINT "content_items_kind_check" CHECK ("kind" IN ('story', 'short', 'explainer', 'original', 'link')),
    -- A link item: the headline, its publisher and where it lives. Never the article body.
    ADD COLUMN "source_name" TEXT,
    ADD COLUMN "source_url" TEXT,
    -- An outside picture (the story's own, or an Unsplash / Pexels fallback), used as given.
    ADD COLUMN "image_url" TEXT,
    ADD COLUMN "image_credit" TEXT,
    ADD COLUMN "image_credit_url" TEXT,
    ADD CONSTRAINT "content_items_source_check" CHECK ("source_url" IS NULL OR "source_url" ~ '^https?://'),
    ADD CONSTRAINT "content_items_image_check" CHECK ("image_url" IS NULL OR "image_url" ~ '^https://'),
    ADD CONSTRAINT "content_items_link_check" CHECK ("kind" <> 'link' OR ("source_url" IS NOT NULL AND "source_name" IS NOT NULL AND "body" IS NULL));
CREATE UNIQUE INDEX "content_items_source_key" ON "content_items"("source_url") WHERE "source_url" IS NOT NULL;
