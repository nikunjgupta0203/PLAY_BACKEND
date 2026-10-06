-- 024 — chat replaces follows (docs/superpowers/specs/2026-09-29-chat-design.md).
-- Players connect through shared play and conversations, not a follower count.

DROP TABLE "follows";

-- The notification registry renders on read (notifications R4); a row whose
-- template no longer exists must not reach it.
DELETE FROM "notifications" WHERE "template" = 'follow.created';

CREATE TABLE "conversations" (
    "id"                UUID PRIMARY KEY,
    "player_low_id"     UUID NOT NULL REFERENCES "player_profiles"("id") ON DELETE CASCADE,
    "player_high_id"    UUID NOT NULL REFERENCES "player_profiles"("id") ON DELETE CASCADE,
    "initiator_id"      UUID NOT NULL,
    "status"            TEXT NOT NULL CHECK ("status" IN ('request', 'active', 'declined')),
    "low_last_read_at"  TIMESTAMPTZ(6),
    "high_last_read_at" TIMESTAMPTZ(6),
    "last_message_at"   TIMESTAMPTZ(6),
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- The pair is stored sorted, so one pair is one row (chat R1).
    CHECK ("player_low_id" < "player_high_id"),
    CHECK ("initiator_id" IN ("player_low_id", "player_high_id"))
);
CREATE UNIQUE INDEX "conversations_player_low_id_player_high_id_key"
    ON "conversations" ("player_low_id", "player_high_id");
CREATE INDEX "conversations_player_high_id_idx" ON "conversations" ("player_high_id");

-- chat R9 — append-only, like match_score_events.
CREATE TABLE "messages" (
    "id"              UUID PRIMARY KEY,
    "conversation_id" UUID NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
    "sender_id"       UUID NOT NULL REFERENCES "player_profiles"("id") ON DELETE CASCADE,
    "body"            TEXT NOT NULL CHECK (char_length("body") BETWEEN 1 AND 2000),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "messages_conversation_id_created_at_id_idx"
    ON "messages" ("conversation_id", "created_at" DESC, "id" DESC);

-- chat R6.
CREATE TABLE "player_blocks" (
    "blocker_id" UUID NOT NULL REFERENCES "player_profiles"("id") ON DELETE CASCADE,
    "blocked_id" UUID NOT NULL REFERENCES "player_profiles"("id") ON DELETE CASCADE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    PRIMARY KEY ("blocker_id", "blocked_id"),
    CHECK ("blocker_id" <> "blocked_id")
);
CREATE INDEX "player_blocks_blocked_id_idx" ON "player_blocks" ("blocked_id");
