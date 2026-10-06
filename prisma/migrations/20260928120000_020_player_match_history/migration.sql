-- profile R12 — player_match_history: one row per player per completed match,
-- written from `match.completed` and rewritten on a correction. Profile reads
-- this instead of `matches`, which belong to tournament.
CREATE TABLE "player_match_history" (
    "player_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "event_id" UUID,
    "partner_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "opponent_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "won" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL CHECK ("outcome" IN ('played', 'walkover', 'retired', 'forfeit')),
    "games" JSONB NOT NULL,
    "completed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "player_match_history_pkey" PRIMARY KEY ("player_id", "match_id")
);

-- R12 — keyset pagination on (completed_at, match_id), newest first.
CREATE INDEX "player_match_history_player_id_completed_at_match_id_idx"
    ON "player_match_history" ("player_id", "completed_at" DESC, "match_id");

-- A correction rewrites every row of one match.
CREATE INDEX "player_match_history_match_id_idx" ON "player_match_history" ("match_id");

ALTER TABLE "player_match_history" ADD CONSTRAINT "player_match_history_player_id_fkey"
    FOREIGN KEY ("player_id") REFERENCES "player_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "player_match_history" ADD CONSTRAINT "player_match_history_sport_id_fkey"
    FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
