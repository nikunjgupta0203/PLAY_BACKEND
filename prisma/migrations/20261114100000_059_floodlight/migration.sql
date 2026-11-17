-- 059 — Floodlight redesign (PLAY_FRONTEND/docs/design/redesign-a-floodlight.md).
--
-- PL4Y becomes a sports media app as well as a place to play:
--   · content: stories, shorts, explainers and originals PL4Y publishes;
--   · pro: professional matches PL4Y staff enter by hand (no data feed yet),
--     with key moments, a scorecard and one public chat room per match;
--   · predictions: free questions on those matches. Points have no cash value,
--     are never bought and never redeemed — a product rule, not just copy;
--   · communities: photo, video, poll and club-event posts;
--   · events: experience kinds (screenings, meetups, fitness) and "By PL4Y";
--   · profiles: a self-declared athlete label, favourite teams, own records.

-- --- content --------------------------------------------------------------------

CREATE TABLE "content_items" (
    "id" UUID NOT NULL,
    -- story: an article. short: a vertical video. explainer: "Explained · 60 sec".
    -- original: a PL4Y Originals feature, shown as the Home hero.
    "kind" TEXT NOT NULL,
    "sport_id" UUID REFERENCES "sports"("id"),
    "title" TEXT NOT NULL,
    "kicker" TEXT,
    "summary" TEXT,
    "body" TEXT,
    "cover_public_id" TEXT,
    -- A short's video: an https URL (Cloudinary or YouTube), played in a web view.
    "video_url" TEXT,
    "duration_seconds" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6),
    "author_user_id" UUID REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "content_items_kind_check" CHECK ("kind" IN ('story', 'short', 'explainer', 'original')),
    CONSTRAINT "content_items_status_check" CHECK ("status" IN ('draft', 'published', 'archived')),
    CONSTRAINT "content_items_title_check" CHECK (char_length("title") BETWEEN 1 AND 140),
    CONSTRAINT "content_items_video_check" CHECK ("video_url" IS NULL OR "video_url" ~ '^https://'),
    CONSTRAINT "content_items_short_video_check" CHECK ("kind" <> 'short' OR "status" <> 'published' OR "video_url" IS NOT NULL),
    CONSTRAINT "content_items_published_check" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL),
    CONSTRAINT "content_items_duration_check" CHECK ("duration_seconds" IS NULL OR "duration_seconds" BETWEEN 1 AND 36000)
);
CREATE INDEX "content_items_feed_idx" ON "content_items"("kind", "published_at" DESC, "id" DESC) WHERE "status" = 'published';
CREATE INDEX "content_items_staff_idx" ON "content_items"("updated_at" DESC);

-- --- pro matches ----------------------------------------------------------------

CREATE TABLE "pro_teams" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL REFERENCES "sports"("id"),
    "name" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    -- The code circle's colour. Data, not a theme token.
    "tint" TEXT NOT NULL DEFAULT '#2C2C24',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_teams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pro_teams_code_check" CHECK (char_length("short_code") BETWEEN 1 AND 5),
    CONSTRAINT "pro_teams_name_check" CHECK (char_length("name") BETWEEN 1 AND 80),
    CONSTRAINT "pro_teams_tint_check" CHECK ("tint" ~ '^#[0-9A-Fa-f]{6}$')
);
CREATE UNIQUE INDEX "pro_teams_sport_name_key" ON "pro_teams"("sport_id", lower("name"));

CREATE TABLE "pro_matches" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL REFERENCES "sports"("id"),
    "league" TEXT NOT NULL,
    "stage" TEXT,
    "home_team_id" UUID NOT NULL REFERENCES "pro_teams"("id"),
    "away_team_id" UUID NOT NULL REFERENCES "pro_teams"("id"),
    "venue_name" TEXT,
    "city" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    -- "2nd innings", "67'", "Game 2" — what the LIVE pill says.
    "status_detail" TEXT,
    -- Scores are text: "182/4" in cricket, "2" in football, "21-17, 14-9" in badminton.
    "home_score" TEXT,
    "away_score" TEXT,
    -- "20 ov", "14.2 ov".
    "home_detail" TEXT,
    "away_detail" TEXT,
    -- "MI need 41 off 34".
    "note" TEXT,
    -- [{ "label": "Run rate", "value": "9.42" }, …]
    "stats" JSONB NOT NULL DEFAULT '[]',
    -- ["1", "4", "W", "0", "6", "1"] — the balls of the over in play.
    "current_over" JSONB NOT NULL DEFAULT '[]',
    -- [{ "team": "MI", "title": "Batting", "rows": [{ "name", "detail", "r", "b", "fours", "sixes" }] }]
    "scorecard" JSONB NOT NULL DEFAULT '[]',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "chat_open" BOOLEAN NOT NULL DEFAULT true,
    -- manual: entered by PL4Y staff. A data feed writes its own name later.
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "provider_ref" TEXT,
    "created_by" UUID REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_matches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pro_matches_status_check" CHECK ("status" IN ('scheduled', 'live', 'break', 'finished', 'abandoned')),
    CONSTRAINT "pro_matches_teams_check" CHECK ("home_team_id" <> "away_team_id")
);
CREATE INDEX "pro_matches_board_idx" ON "pro_matches"("starts_at");
CREATE INDEX "pro_matches_live_idx" ON "pro_matches"("status") WHERE "status" IN ('live', 'break');
CREATE UNIQUE INDEX "pro_matches_provider_key" ON "pro_matches"("provider", "provider_ref") WHERE "provider_ref" IS NOT NULL;

CREATE TABLE "pro_match_moments" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL REFERENCES "pro_matches"("id") ON DELETE CASCADE,
    -- "14.2", "67'".
    "at_label" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_match_moments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pro_match_moments_kind_check" CHECK ("kind" IN ('six', 'four', 'wicket', 'milestone', 'goal', 'card', 'point', 'other'))
);
CREATE INDEX "pro_match_moments_match_idx" ON "pro_match_moments"("match_id", "created_at" DESC);

-- One public room per match. A hidden message keeps its body for moderation.
CREATE TABLE "pro_match_messages" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL REFERENCES "pro_matches"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id"),
    "body" TEXT NOT NULL,
    "hidden_at" TIMESTAMPTZ(6),
    "hidden_by" UUID REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_match_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pro_match_messages_body_check" CHECK (char_length("body") BETWEEN 1 AND 500)
);
CREATE INDEX "pro_match_messages_room_idx" ON "pro_match_messages"("match_id", "created_at" DESC, "id" DESC);

-- Favourite teams on a profile.
CREATE TABLE "pro_team_fans" (
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "team_id" UUID NOT NULL REFERENCES "pro_teams"("id") ON DELETE CASCADE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pro_team_fans_pkey" PRIMARY KEY ("user_id", "team_id")
);

-- --- predictions ----------------------------------------------------------------

CREATE TABLE "prediction_questions" (
    "id" UUID NOT NULL,
    "match_id" UUID REFERENCES "pro_matches"("id") ON DELETE CASCADE,
    "sport_id" UUID NOT NULL REFERENCES "sports"("id"),
    -- choice: pick one option (winner, yes/no). exact_score: two numbers.
    -- player_pick: pick one player.
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 10,
    -- A live question: asked during play, shown in the Match Centre.
    "live" BOOLEAN NOT NULL DEFAULT false,
    "locks_at" TIMESTAMPTZ(6) NOT NULL,
    -- open → settled | void. "Locked" is open past locks_at.
    "status" TEXT NOT NULL DEFAULT 'open',
    "correct_option_id" UUID,
    "correct_home" INTEGER,
    "correct_away" INTEGER,
    "settled_at" TIMESTAMPTZ(6),
    "settled_by" UUID REFERENCES "users"("id"),
    "created_by" UUID REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prediction_questions_kind_check" CHECK ("kind" IN ('choice', 'exact_score', 'player_pick')),
    CONSTRAINT "prediction_questions_status_check" CHECK ("status" IN ('open', 'settled', 'void')),
    CONSTRAINT "prediction_questions_points_check" CHECK ("points" BETWEEN 1 AND 500),
    CONSTRAINT "prediction_questions_prompt_check" CHECK (char_length("prompt") BETWEEN 3 AND 200),
    CONSTRAINT "prediction_questions_score_check" CHECK (
        ("correct_home" IS NULL OR "correct_home" BETWEEN 0 AND 999)
        AND ("correct_away" IS NULL OR "correct_away" BETWEEN 0 AND 999))
);
CREATE INDEX "prediction_questions_open_idx" ON "prediction_questions"("locks_at") WHERE "status" = 'open';
CREATE INDEX "prediction_questions_match_idx" ON "prediction_questions"("match_id", "created_at");

CREATE TABLE "prediction_options" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL REFERENCES "prediction_questions"("id") ON DELETE CASCADE,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "prediction_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prediction_options_label_check" CHECK (char_length("label") BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX "prediction_options_position_key" ON "prediction_options"("question_id", "position");

ALTER TABLE "prediction_questions"
    ADD CONSTRAINT "prediction_questions_correct_option_fkey"
    FOREIGN KEY ("correct_option_id") REFERENCES "prediction_options"("id");

-- One pick per player per question; changeable until the question locks.
CREATE TABLE "prediction_picks" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL REFERENCES "prediction_questions"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "option_id" UUID REFERENCES "prediction_options"("id") ON DELETE CASCADE,
    "home" INTEGER,
    "away" INTEGER,
    -- Set at settlement. Null while open, and for a void question.
    "correct" BOOLEAN,
    "points_awarded" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_picks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prediction_picks_answer_check" CHECK (
        ("option_id" IS NOT NULL AND "home" IS NULL AND "away" IS NULL)
        OR ("option_id" IS NULL AND "home" BETWEEN 0 AND 999 AND "away" BETWEEN 0 AND 999))
);
CREATE UNIQUE INDEX "prediction_picks_one_key" ON "prediction_picks"("question_id", "user_id");
CREATE INDEX "prediction_picks_user_idx" ON "prediction_picks"("user_id", "created_at" DESC);

-- Every point a player earns, once. The leaderboard and totals are sums of this.
CREATE TABLE "prediction_points" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "sport_id" UUID REFERENCES "sports"("id"),
    "points" INTEGER NOT NULL,
    -- pick: a correct pick (ref = pick id). daily: the daily challenge bonus (ref = IST date).
    "reason" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_points_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prediction_points_reason_check" CHECK ("reason" IN ('pick', 'daily')),
    CONSTRAINT "prediction_points_positive_check" CHECK ("points" > 0)
);
CREATE UNIQUE INDEX "prediction_points_once_key" ON "prediction_points"("user_id", "reason", "ref");
CREATE INDEX "prediction_points_board_idx" ON "prediction_points"("created_at", "user_id");

-- --- communities: richer posts --------------------------------------------------

ALTER TABLE "community_posts" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "community_posts" ADD COLUMN "photo_public_ids" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "community_posts" ADD COLUMN "video_url" TEXT;
ALTER TABLE "community_posts" ADD COLUMN "event_title" TEXT;
ALTER TABLE "community_posts" ADD COLUMN "event_starts_at" TIMESTAMPTZ(6);
ALTER TABLE "community_posts" ADD COLUMN "event_place" TEXT;
-- A photo, video or event post may go without a caption.
ALTER TABLE "community_posts" DROP CONSTRAINT "community_posts_body_check";
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_body_check"
    CHECK (char_length("body") <= 2000 AND (char_length("body") >= 1 OR "kind" IN ('photo', 'video', 'event')));
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_kind_check"
    CHECK ("kind" IN ('text', 'photo', 'video', 'poll', 'event'));
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_video_check"
    CHECK ("video_url" IS NULL OR "video_url" ~ '^https://');
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_event_check"
    CHECK ("kind" <> 'event' OR ("event_title" IS NOT NULL AND "event_starts_at" IS NOT NULL));
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_photos_check"
    CHECK (cardinality("photo_public_ids") <= 6);
-- Club events coming up, for My PL4Y and Home.
CREATE INDEX "community_posts_events_idx" ON "community_posts"("community_id", "event_starts_at")
    WHERE "kind" = 'event' AND "deleted_at" IS NULL;

CREATE TABLE "community_poll_options" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL REFERENCES "community_posts"("id") ON DELETE CASCADE,
    "label" TEXT NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "community_poll_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "community_poll_options_label_check" CHECK (char_length("label") BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX "community_poll_options_position_key" ON "community_poll_options"("post_id", "position");

CREATE TABLE "community_poll_votes" (
    "post_id" UUID NOT NULL REFERENCES "community_posts"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "option_id" UUID NOT NULL REFERENCES "community_poll_options"("id") ON DELETE CASCADE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_poll_votes_pkey" PRIMARY KEY ("post_id", "user_id")
);
CREATE INDEX "community_poll_votes_option_idx" ON "community_poll_votes"("option_id");

-- "I'm in" on a club event post.
CREATE TABLE "community_post_rsvps" (
    "post_id" UUID NOT NULL REFERENCES "community_posts"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_post_rsvps_pkey" PRIMARY KEY ("post_id", "user_id")
);

-- --- events: experiences ---------------------------------------------------------

-- Null for a sports event (it shows under Tournaments). Otherwise what kind of
-- outing it is. Experiences have no draw: auto-draw skips them.
ALTER TABLE "events" ADD COLUMN "experience_kind" TEXT;
ALTER TABLE "events" ADD COLUMN "by_pl4y" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "events" ADD CONSTRAINT "events_experience_kind_check"
    CHECK ("experience_kind" IS NULL OR "experience_kind" IN ('screening', 'meetup', 'fitness', 'original'));

-- --- profiles --------------------------------------------------------------------

-- Self-declared, never verified: "State-level shuttler". Shown as an ATHLETE label.
ALTER TABLE "player_profiles" ADD COLUMN "athlete_label" TEXT;
ALTER TABLE "player_profiles" ADD CONSTRAINT "player_profiles_athlete_label_check"
    CHECK ("athlete_label" IS NULL OR char_length("athlete_label") BETWEEN 1 AND 40);

-- "My records — added by you". The player's word; PL4Y shows it as theirs.
CREATE TABLE "profile_records" (
    "id" UUID NOT NULL,
    "player_id" UUID NOT NULL REFERENCES "player_profiles"("id") ON DELETE CASCADE,
    "sport_id" UUID REFERENCES "sports"("id"),
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "year" SMALLINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profile_records_title_check" CHECK (char_length("title") BETWEEN 1 AND 80),
    CONSTRAINT "profile_records_detail_check" CHECK ("detail" IS NULL OR char_length("detail") <= 160),
    CONSTRAINT "profile_records_year_check" CHECK ("year" IS NULL OR "year" BETWEEN 1950 AND 2100)
);
CREATE INDEX "profile_records_player_idx" ON "profile_records"("player_id", "created_at" DESC);
