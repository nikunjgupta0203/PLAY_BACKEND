-- 043 — results of casual games ("unranked matches").
--
-- One game is often several matches (eight people rotating through doubles),
-- so a game holds many results. Each names who was on each side and the score,
-- held to the sport's own scoring rule. They show on a player's profile under
-- Unranked and never touch rating, rankings, badges or the ranked W–L.
--
-- side_a / side_b are user ids, like game_participants. A result is `pending`
-- until someone on the other side confirms it, or `auto_confirm_at` passes.
CREATE TABLE "game_results" (
    "id"              UUID PRIMARY KEY,
    "game_id"         UUID NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
    "sport_id"        UUID NOT NULL REFERENCES "sports" ("id"),
    "side_a"          UUID[] NOT NULL,
    "side_b"          UUID[] NOT NULL,
    -- [{ a, b }] — games, sets, frames, or one final score, as the sport is scored.
    "games"           JSONB NOT NULL,
    -- 'a' | 'b'; NULL is a draw.
    "winner"          TEXT,
    -- How a bout ended early (ko, tko, submission…). NULL for a win on the score.
    "method"          TEXT,
    "status"          TEXT NOT NULL DEFAULT 'pending',
    "entered_by"      UUID NOT NULL REFERENCES "users" ("id"),
    "auto_confirm_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmed_at"    TIMESTAMPTZ(6),
    -- opponent | auto
    "confirmed_via"   TEXT,
    "disputed_by"     UUID REFERENCES "users" ("id"),
    "disputed_at"     TIMESTAMPTZ(6),
    -- The game's start: what a profile sorts and dates the result by.
    "played_at"       TIMESTAMPTZ(6) NOT NULL,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "game_results_status_check" CHECK ("status" IN ('pending', 'confirmed', 'disputed')),
    CONSTRAINT "game_results_winner_check" CHECK ("winner" IS NULL OR "winner" IN ('a', 'b')),
    CONSTRAINT "game_results_sides_check" CHECK (cardinality("side_a") >= 1 AND cardinality("side_b") >= 1 AND NOT ("side_a" && "side_b"))
);

CREATE INDEX "game_results_game_idx" ON "game_results" ("game_id", "created_at");
-- A profile's Unranked list: "results this user played in".
CREATE INDEX "game_results_side_a_idx" ON "game_results" USING gin ("side_a");
CREATE INDEX "game_results_side_b_idx" ON "game_results" USING gin ("side_b");
-- The sweep that confirms what nobody answered.
CREATE INDEX "game_results_pending_idx" ON "game_results" ("auto_confirm_at") WHERE "status" = 'pending';
