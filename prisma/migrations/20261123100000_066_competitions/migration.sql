-- 066 — Prediction competitions (Campus Prediction Cup, 2026-11-23).
--
-- A competition is its own space, fully apart from Floodlight predictions:
-- its own questions, picks and points ledger. A Cup pick never changes PL4Y
-- points or Rankings, and a normal pick never counts for a Cup.
--
-- One structure serves every segment. Season 1 is `segment = 'campus'` with
-- colleges as its groups; a corporate league is the same rows with
-- `segment = 'corporate'` and companies as groups, a gym league uses gyms.
-- Nothing in the schema knows what a college is: `group_noun` names the
-- groups on screen ("college", "company", "gym").
--
--   competitions          one season of one segment
--   competition_groups    the teams players play for (a college, a company)
--   competition_codes     join codes (AMB-002), each tied to one group and an ambassador
--   competition_members   user → group, set once from a code, locked for the season
--   competition_moments   bonus moments: big events whose questions earn ×1.5 / ×2
--   competition_questions rolling questions: open `open_hours` before the event, lock at its start
--   competition_options   a choice question's options
--   competition_picks     one pick per member per question
--   competition_points    the ledger, unique on (competition, user, reason, ref)

CREATE TABLE "competitions" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    -- campus | corporate | gym | community | other. A CHECK, not an enum, so a segment is one line to add.
    "segment" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "season_label" TEXT NOT NULL,
    -- One line under the name on the Home card: "All sports · college vs college".
    "tagline" TEXT,
    -- What a group is called on screen, singular and plural.
    "group_noun" TEXT NOT NULL DEFAULT 'college',
    "group_noun_plural" TEXT NOT NULL DEFAULT 'colleges',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    -- draft: staff only. live: on Home, joinable, playable. ended: read-only results.
    "status" TEXT NOT NULL DEFAULT 'draft',
    -- A group's score is the average of its top `team_size` players (a missing slot counts 0).
    "team_size" INTEGER NOT NULL DEFAULT 20,
    -- A member is active with a pick in the last `active_days` days.
    "active_days" INTEGER NOT NULL DEFAULT 14,
    -- Questions open this many hours before the event starts.
    "open_hours" INTEGER NOT NULL DEFAULT 24,
    -- false: a player can join a group from the list without a code.
    "code_required" BOOLEAN NOT NULL DEFAULT true,
    "on_home" BOOLEAN NOT NULL DEFAULT true,
    "home_order" INTEGER NOT NULL DEFAULT 0,
    -- [{ "title": "Top college", "detail": "trophy and a free PL4Y screening pass" }]
    "prizes" JSONB NOT NULL DEFAULT '[]',
    -- [{ "label": "Correct pick", "value": "+10" }]
    "scoring" JSONB NOT NULL DEFAULT '[]',
    "fine_print" TEXT,
    "created_by" UUID REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "competitions_segment_check" CHECK ("segment" IN ('campus', 'corporate', 'gym', 'community', 'other')),
    CONSTRAINT "competitions_status_check" CHECK ("status" IN ('draft', 'live', 'ended')),
    CONSTRAINT "competitions_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 60),
    CONSTRAINT "competitions_name_check" CHECK (char_length("name") BETWEEN 3 AND 60),
    CONSTRAINT "competitions_dates_check" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "competitions_team_size_check" CHECK ("team_size" BETWEEN 1 AND 500),
    CONSTRAINT "competitions_active_days_check" CHECK ("active_days" BETWEEN 1 AND 90),
    CONSTRAINT "competitions_open_hours_check" CHECK ("open_hours" BETWEEN 1 AND 336)
);
CREATE UNIQUE INDEX "competitions_slug_key" ON "competitions"("slug");
CREATE INDEX "competitions_home_idx" ON "competitions"("home_order", "starts_at") WHERE "status" = 'live' AND "on_home";

CREATE TABLE "competition_groups" (
    "id" UUID NOT NULL,
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    -- Short name on boards: "DTU".
    "name" TEXT NOT NULL,
    -- "Delhi Technological University".
    "full_name" TEXT,
    "city" TEXT,
    -- The Campus Lead shown on Join ("Ask Shlok D. for the code").
    "lead_name" TEXT,
    "lead_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    -- hidden: off the boards and the list; its members keep playing.
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "competition_groups_status_check" CHECK ("status" IN ('active', 'hidden')),
    CONSTRAINT "competition_groups_name_check" CHECK (char_length("name") BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX "competition_groups_name_key" ON "competition_groups"("competition_id", lower("name"));

CREATE TABLE "competition_codes" (
    -- Stored upper-case: "AMB-002".
    "code" TEXT NOT NULL,
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    "group_id" UUID NOT NULL REFERENCES "competition_groups"("id") ON DELETE CASCADE,
    "ambassador_name" TEXT,
    "ambassador_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_codes_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "competition_codes_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{2,23}$')
);
CREATE INDEX "competition_codes_group_idx" ON "competition_codes"("group_id");

CREATE TABLE "competition_members" (
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "group_id" UUID NOT NULL REFERENCES "competition_groups"("id"),
    -- The code they joined with (the ambassador who brought them). Null: joined from the list.
    "code" TEXT REFERENCES "competition_codes"("code") ON DELETE SET NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_members_pkey" PRIMARY KEY ("competition_id", "user_id")
);
CREATE INDEX "competition_members_group_idx" ON "competition_members"("group_id");
CREATE INDEX "competition_members_user_idx" ON "competition_members"("user_id");

CREATE TABLE "competition_moments" (
    "id" UUID NOT NULL,
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    "sport_id" UUID NOT NULL REFERENCES "sports"("id"),
    -- "SOLD! IPL Auction", "Abu Dhabi GP".
    "title" TEXT NOT NULL,
    -- "8 questions", "winner & podium".
    "subtitle" TEXT,
    "multiplier" NUMERIC(3, 1) NOT NULL DEFAULT 1.5,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_moments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "competition_moments_multiplier_check" CHECK ("multiplier" BETWEEN 1 AND 5),
    CONSTRAINT "competition_moments_title_check" CHECK (char_length("title") BETWEEN 2 AND 60)
);
CREATE INDEX "competition_moments_idx" ON "competition_moments"("competition_id", "starts_at");

CREATE TABLE "competition_questions" (
    "id" UUID NOT NULL,
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    "moment_id" UUID REFERENCES "competition_moments"("id") ON DELETE SET NULL,
    "sport_id" UUID NOT NULL REFERENCES "sports"("id"),
    -- A pro match: its result settles tagged questions within the feed's next poll.
    "match_id" UUID REFERENCES "pro_matches"("id") ON DELETE SET NULL,
    -- "Premier League · Arsenal v Chelsea · 10:00 pm".
    "event_label" TEXT NOT NULL,
    -- choice | exact_score
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 10,
    -- The moment's multiplier when it has one; points earned = round(points × multiplier).
    "multiplier" NUMERIC(3, 1) NOT NULL DEFAULT 1,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "opens_at" TIMESTAMPTZ(6) NOT NULL,
    "locks_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "correct_option_id" UUID,
    "correct_home" INTEGER,
    "correct_away" INTEGER,
    "suggested_option_id" UUID,
    "suggested_home" INTEGER,
    "suggested_away" INTEGER,
    "settled_at" TIMESTAMPTZ(6),
    "settled_by" UUID,
    -- Reminders, sent once each.
    "open_notified_at" TIMESTAMPTZ(6),
    "lock_notified_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "competition_questions_kind_check" CHECK ("kind" IN ('choice', 'exact_score')),
    CONSTRAINT "competition_questions_status_check" CHECK ("status" IN ('open', 'settled', 'void')),
    CONSTRAINT "competition_questions_points_check" CHECK ("points" BETWEEN 1 AND 500),
    CONSTRAINT "competition_questions_multiplier_check" CHECK ("multiplier" BETWEEN 1 AND 5),
    CONSTRAINT "competition_questions_window_check" CHECK ("opens_at" < "locks_at"),
    CONSTRAINT "competition_questions_prompt_check" CHECK (char_length("prompt") BETWEEN 3 AND 200)
);
CREATE INDEX "competition_questions_open_idx" ON "competition_questions"("competition_id", "locks_at") WHERE "status" = 'open';
CREATE INDEX "competition_questions_match_idx" ON "competition_questions"("match_id") WHERE "match_id" IS NOT NULL;
CREATE INDEX "competition_questions_staff_idx" ON "competition_questions"("competition_id", "starts_at" DESC);

CREATE TABLE "competition_options" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL REFERENCES "competition_questions"("id") ON DELETE CASCADE,
    "label" TEXT NOT NULL,
    "position" SMALLINT NOT NULL,
    -- home | draw | away: what picking it means for the match result.
    "outcome" TEXT,

    CONSTRAINT "competition_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "competition_options_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('home', 'draw', 'away'))
);
CREATE UNIQUE INDEX "competition_options_position_key" ON "competition_options"("question_id", "position");

CREATE TABLE "competition_picks" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL REFERENCES "competition_questions"("id") ON DELETE CASCADE,
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "option_id" UUID REFERENCES "competition_options"("id") ON DELETE CASCADE,
    "home" INTEGER,
    "away" INTEGER,
    "correct" BOOLEAN,
    "points_awarded" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_picks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "competition_picks_one_key" ON "competition_picks"("question_id", "user_id");
CREATE INDEX "competition_picks_user_idx" ON "competition_picks"("competition_id", "user_id", "created_at" DESC);

CREATE TABLE "competition_points" (
    "id" UUID NOT NULL,
    "competition_id" UUID NOT NULL REFERENCES "competitions"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "group_id" UUID NOT NULL REFERENCES "competition_groups"("id"),
    "sport_id" UUID REFERENCES "sports"("id"),
    "points" INTEGER NOT NULL,
    -- pick
    "reason" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competition_points_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "competition_points_once_key" ON "competition_points"("competition_id", "user_id", "reason", "ref");
CREATE INDEX "competition_points_board_idx" ON "competition_points"("competition_id", "created_at", "user_id");
