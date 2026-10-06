-- 014 — organizers, Sprint 7 (docs/modules/14-organizers.md), and the events
-- columns that point at it (docs/modules/05-events.md R12, R13).

-- ── organizers R1 ───────────────────────────────────────────────────────────
CREATE TABLE "organizer_profiles" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,                        -- permanent once an event publishes (R4)
    "name" TEXT NOT NULL,
    "bio" TEXT,
    "city" TEXT,
    "logo_public_id" TEXT,                       -- Cloudinary (ADR 0003)
    "contact_email" CITEXT,
    "contact_phone" TEXT,
    "verification" TEXT NOT NULL DEFAULT 'unverified',
    "verification_note" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    -- The profile a solo organizer gets on their first event (R1). Not in the
    -- module doc's DDL: it is what makes "their personal profile" a lookup
    -- rather than a guess, and what makes the backfill below idempotent.
    "is_personal" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizer_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizer_profiles_verification_check" CHECK ("verification" IN
      ('unverified', 'pending', 'verified', 'rejected', 'suspended'))
);

CREATE UNIQUE INDEX "organizer_profiles_slug_key" ON "organizer_profiles" ("slug");
CREATE UNIQUE INDEX "organizer_profiles_one_personal"
    ON "organizer_profiles" ("created_by") WHERE "is_personal";

ALTER TABLE "organizer_profiles"
    ADD CONSTRAINT "organizer_profiles_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── organizers R2 ───────────────────────────────────────────────────────────
CREATE TABLE "organizer_members" (
    "organizer_profile_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizer_members_pkey" PRIMARY KEY ("organizer_profile_id", "user_id"),
    CONSTRAINT "organizer_members_role_check" CHECK ("role" IN ('owner', 'admin', 'member'))
);

CREATE INDEX "organizer_members_user_id_idx" ON "organizer_members" ("user_id");

ALTER TABLE "organizer_members"
    ADD CONSTRAINT "organizer_members_organizer_profile_id_fkey"
    FOREIGN KEY ("organizer_profile_id") REFERENCES "organizer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organizer_members"
    ADD CONSTRAINT "organizer_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- identity R16 — the FK 011 deferred.
ALTER TABLE "event_staff"
    ADD CONSTRAINT "event_staff_organizer_profile_id_fkey"
    FOREIGN KEY ("organizer_profile_id") REFERENCES "organizer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── events R12, R13 ─────────────────────────────────────────────────────────
-- Expand only. `organizer_profile_id` becomes NOT NULL in a later migration,
-- once no running code can insert an event without one (architecture §8).
ALTER TABLE "events"
    ADD COLUMN "organizer_profile_id" UUID,
    ADD COLUMN "hidden_at" TIMESTAMPTZ(6);

ALTER TABLE "events"
    ADD CONSTRAINT "events_organizer_profile_id_fkey"
    FOREIGN KEY ("organizer_profile_id") REFERENCES "organizer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "events_organizer_profile_id_idx" ON "events" ("organizer_profile_id");

-- events R12 — a hidden event leaves discovery, so it leaves the indexes that
-- serve discovery.
DROP INDEX "events_sport_id_city_starts_at_idx";
CREATE INDEX "events_sport_id_city_starts_at_idx" ON "events" ("sport_id", "city", "starts_at")
    WHERE "status" IN ('published', 'live') AND "hidden_at" IS NULL;

DROP INDEX "events_geo_idx";
CREATE INDEX "events_geo_idx" ON "events" USING GIST ("geo")
    WHERE "status" IN ('published', 'live') AND "hidden_at" IS NULL;

-- events R13 — backfill: a personal organizer profile for every user who has
-- created an event, owned by them, and every such event pointed at it. Runs
-- once per user, whatever it finds. Backfilled ids are random UUIDs rather than
-- UUIDv7: SQL has no v7 generator, and these rows are a one-off.
INSERT INTO "organizer_profiles" ("id", "slug", "name", "created_by", "is_personal")
SELECT gen_random_uuid(),
       'organizer-' || replace(u."id"::text, '-', ''),
       u."display_name",
       u."id",
       true
  FROM (SELECT DISTINCT "organizer_id" FROM "events" WHERE "organizer_profile_id" IS NULL) e
  JOIN "users" u ON u."id" = e."organizer_id"
ON CONFLICT ("created_by") WHERE "is_personal" DO NOTHING;

INSERT INTO "organizer_members" ("organizer_profile_id", "user_id", "role")
SELECT p."id", p."created_by", 'owner'
  FROM "organizer_profiles" p
 WHERE p."is_personal"
ON CONFLICT DO NOTHING;

UPDATE "events" e
   SET "organizer_profile_id" = p."id"
  FROM "organizer_profiles" p
 WHERE p."created_by" = e."organizer_id"
   AND p."is_personal"
   AND e."organizer_profile_id" IS NULL;

-- ── organizers R6, R7 ───────────────────────────────────────────────────────
CREATE TABLE "organizer_broadcasts" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "sent_by" UUID NOT NULL,
    "audience" TEXT NOT NULL,                    -- 'confirmed' | 'category:<id>' | 'checked_in' | 'waitlist'
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "with_email" BOOLEAN NOT NULL DEFAULT false,
    "recipient_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizer_broadcasts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizer_broadcasts_body_check" CHECK (char_length("body") BETWEEN 1 AND 1000)
);

-- R7 — the five-per-24-hours window check reads exactly this.
CREATE INDEX "organizer_broadcasts_event_id_created_at_idx"
    ON "organizer_broadcasts" ("event_id", "created_at" DESC);

ALTER TABLE "organizer_broadcasts"
    ADD CONSTRAINT "organizer_broadcasts_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organizer_broadcasts"
    ADD CONSTRAINT "organizer_broadcasts_sent_by_fkey"
    FOREIGN KEY ("sent_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── organizers R8, R9 — the analytics read model ────────────────────────────
-- Rows are upserted by projection jobs, never by a request.
CREATE TABLE "event_stats_daily" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "event_category_id" UUID,                    -- null = the event total
    "day" DATE NOT NULL,                         -- event-local
    "views" INTEGER NOT NULL DEFAULT 0,          -- approximate (R9)
    "registrations_begun" INTEGER NOT NULL DEFAULT 0,
    "confirmed" INTEGER NOT NULL DEFAULT 0,
    "checked_in" INTEGER NOT NULL DEFAULT 0,
    "refunds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_stats_daily_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_stats_daily_uniq" UNIQUE NULLS NOT DISTINCT ("event_id", "event_category_id", "day")
);

ALTER TABLE "event_stats_daily"
    ADD CONSTRAINT "event_stats_daily_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_stats_daily"
    ADD CONSTRAINT "event_stats_daily_event_category_id_fkey"
    FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Outbox dispatch is at-least-once. A counter that a redelivery can bump twice
-- is a dashboard that drifts upward forever, so every projected message is
-- recorded here in the same transaction as the increment it caused.
CREATE TABLE "event_stats_applied" (
    "topic" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_stats_applied_pkey" PRIMARY KEY ("topic", "subject_key")
);
