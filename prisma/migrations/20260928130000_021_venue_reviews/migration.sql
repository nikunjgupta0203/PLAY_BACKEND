-- venues R6–R8, R10, R12 — venue profile details, playing-area kinds, the
-- "played here" projection and reviews. Claims (R9) need admin and come later.
ALTER TABLE "venues"
    ADD COLUMN "description"   TEXT CHECK (char_length("description") <= 2000),
    ADD COLUMN "opening_hours" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "contact_phone" TEXT,
    ADD COLUMN "rating_avg"    NUMERIC(3, 2),
    ADD COLUMN "rating_count"  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "venue_courts"
    ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'court'
    CHECK ("kind" IN ('court', 'turf', 'ground', 'pitch', 'table'));

-- R6. Projection of "played here".
CREATE TABLE "venue_visits" (
    "venue_id"   UUID NOT NULL REFERENCES "venues"("id"),
    "user_id"    UUID NOT NULL REFERENCES "users"("id"),
    "source"     TEXT NOT NULL CHECK ("source" IN ('match', 'game', 'booking')),
    "source_id"  UUID NOT NULL,
    "visited_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "venue_visits_pkey" PRIMARY KEY ("source", "source_id", "user_id")
);
CREATE INDEX "venue_visits_venue_id_user_id_visited_at_idx"
    ON "venue_visits" ("venue_id", "user_id", "visited_at" DESC);

CREATE TABLE "venue_reviews" (
    "id"         UUID PRIMARY KEY,
    "venue_id"   UUID NOT NULL REFERENCES "venues"("id"),
    "user_id"    UUID NOT NULL REFERENCES "users"("id"),
    "stars"      SMALLINT NOT NULL CHECK ("stars" BETWEEN 1 AND 5),
    "body"       TEXT CHECK (char_length("body") <= 1000),
    "reply_body" TEXT CHECK (char_length("reply_body") <= 1000),       -- R8
    "replied_by" UUID REFERENCES "users"("id"),
    "replied_at" TIMESTAMPTZ(6),
    "hidden_at"  TIMESTAMPTZ(6),                                       -- admin R6
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "venue_reviews_venue_id_user_id_key" UNIQUE ("venue_id", "user_id")
);
-- The review list reads only visible rows, newest first.
CREATE INDEX "venue_reviews_venue_id_created_at_idx"
    ON "venue_reviews" ("venue_id", "created_at" DESC) WHERE "hidden_at" IS NULL;
