-- 042 — account deactivation and casual games.
--
-- Deactivation (identity R19): a fourth account status. The row, the profile,
-- the ratings and every entry stay exactly as they are; only the status moves,
-- and it moves back when the player signs in and confirms. Nothing is scrubbed:
-- scrub-deleted-users reads status = 'deleted' only.
ALTER TABLE "users" DROP CONSTRAINT "users_status_check";
ALTER TABLE "users"
    ADD CONSTRAINT "users_status_check"
    CHECK ("status" IN ('active', 'suspended', 'deleted', 'deactivated'));
ALTER TABLE "users" ADD COLUMN "deactivated_at" TIMESTAMPTZ(6);

-- Casual games (docs/modules/12-games.md, v2 flow). No money, no bracket, no
-- rating. A game is at a listed venue or at a pin on the map — never free text.
CREATE TABLE "games" (
    "id"               UUID PRIMARY KEY,
    "host_user_id"     UUID NOT NULL REFERENCES "users" ("id"),
    "sport_id"         UUID NOT NULL REFERENCES "sports" ("id"),
    "venue_id"         UUID REFERENCES "venues" ("id"),
    "geo"              geography(Point, 4326),
    "place_name"       TEXT,
    "city"             TEXT NOT NULL DEFAULT '',
    "starts_at"        TIMESTAMPTZ(6) NOT NULL,
    "ends_at"          TIMESTAMPTZ(6) NOT NULL,
    "timezone"         TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "max_players"      SMALLINT NOT NULL,
    "min_players"      SMALLINT,
    "skill_band"       TEXT,
    "notes"            TEXT,
    "status"           TEXT NOT NULL DEFAULT 'open',
    "cancel_reason"    TEXT,
    "cancelled_at"     TIMESTAMPTZ(6),
    "completed_at"     TIMESTAMPTZ(6),
    "reminder_sent_at" TIMESTAMPTZ(6),
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "games_status_check" CHECK ("status" IN ('open', 'full', 'cancelled', 'completed')),
    CONSTRAINT "games_place_check" CHECK ("venue_id" IS NOT NULL OR ("geo" IS NOT NULL AND "place_name" IS NOT NULL)),
    CONSTRAINT "games_time_check" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "games_capacity_check" CHECK ("max_players" BETWEEN 2 AND 64),
    CONSTRAINT "games_minimum_check" CHECK ("min_players" IS NULL OR ("min_players" BETWEEN 2 AND "max_players"))
);

-- Discovery only reads games people can still see on a list.
CREATE INDEX "games_upcoming_idx" ON "games" ("starts_at", "id") WHERE "status" IN ('open', 'full');
CREATE INDEX "games_host_idx" ON "games" ("host_user_id", "starts_at" DESC);
CREATE INDEX "games_geo_idx" ON "games" USING gist ("geo");

-- 'left' and 'removed' rows are kept: a removed player cannot rejoin (the
-- host's removal is the only safety valve), and a count of who left is the
-- no-show data the spec asks to collect before deciding on penalties.
CREATE TABLE "game_participants" (
    "game_id"    UUID NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
    "user_id"    UUID NOT NULL REFERENCES "users" ("id"),
    "status"     TEXT NOT NULL DEFAULT 'joined',
    "joined_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    PRIMARY KEY ("game_id", "user_id"),
    CONSTRAINT "game_participants_status_check" CHECK ("status" IN ('joined', 'left', 'removed'))
);
CREATE INDEX "game_participants_user_idx" ON "game_participants" ("user_id", "status");

CREATE TABLE "game_invites" (
    "game_id"    UUID NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
    "user_id"    UUID NOT NULL REFERENCES "users" ("id"),
    "invited_by" UUID NOT NULL REFERENCES "users" ("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    PRIMARY KEY ("game_id", "user_id")
);
CREATE INDEX "game_invites_user_idx" ON "game_invites" ("user_id");

-- The joined players' thread: "running late", "which court?".
CREATE TABLE "game_comments" (
    "id"         UUID PRIMARY KEY,
    "game_id"    UUID NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
    "user_id"    UUID NOT NULL REFERENCES "users" ("id"),
    "body"       TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "game_comments_game_idx" ON "game_comments" ("game_id", "created_at");
