-- 037 — the 2026-10-05 backlog (PLAY_FRONTEND/docs/backlog/remaining-work.md):
-- audit outcome, settled-by-default disputes, the support / moderation / fraud
-- queues (15-admin Phase 2), venue staff and court bookings (19-bookings).

-- ── 15-admin R2 — an audit row is written BEFORE the action ─────────────────
-- Services do not take the caller's transaction, and several staff actions
-- call a gateway that cannot sit inside one. So the row is written first as
-- `pending`, then marked `succeeded`; a refused action deletes it. A crash
-- between the two leaves `pending` in the log: the record is never lost, and
-- the portal says the outcome is unknown.
ALTER TABLE "audit_log"
    ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'succeeded'
        CHECK ("outcome" IN ('pending', 'succeeded'));
CREATE INDEX "audit_log_actor_idx" ON "audit_log" ("actor_user_id", "created_at" DESC);

-- ── gap #20 — a dispute PL4Y never settles is settled by default ────────────
-- `default` keeps the submitted result, like `auto` has no person behind it,
-- and is never rated.
ALTER TABLE "match_results" DROP CONSTRAINT "match_results_confirmed_via_check";
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_via_check"
    CHECK ("confirmed_via" IS NULL OR "confirmed_via" IN ('opponent', 'staff', 'auto', 'default'));
ALTER TABLE "match_results" DROP CONSTRAINT "match_results_confirmed_check";
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_check"
    CHECK (
        ("confirmed_at" IS NULL AND "confirmed_by" IS NULL)
     OR ("confirmed_at" IS NOT NULL AND ("confirmed_by" IS NULL) = ("confirmed_via" IN ('auto', 'default')))
    );

-- ── 15-admin R6 — reports on people, venue reviews and chat messages ────────
-- Events keep their own reports (event_reports), because those hold a payout.
CREATE TABLE "moderation_reports" (
    "id"            UUID PRIMARY KEY,
    "reporter_id"   UUID NOT NULL REFERENCES "users"("id"),
    "target_type"   TEXT NOT NULL CHECK ("target_type" IN ('player', 'venue_review', 'message')),
    "target_id"     UUID NOT NULL,
    "reason"        TEXT NOT NULL CHECK ("reason" IN ('spam', 'abuse', 'fake', 'unsafe', 'inaccurate', 'other')),
    "note"          TEXT CHECK ("note" IS NULL OR char_length("note") <= 1000),
    "status"        TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'actioned', 'dismissed')),
    "resolution"    TEXT,
    "resolved_by"   UUID REFERENCES "users"("id"),
    "resolved_at"   TIMESTAMPTZ(6),
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
-- R6: one open report per reporter per target.
CREATE UNIQUE INDEX "moderation_reports_one_open"
    ON "moderation_reports" ("reporter_id", "target_type", "target_id") WHERE "status" = 'open';
CREATE INDEX "moderation_reports_target_open_idx"
    ON "moderation_reports" ("target_type", "target_id") WHERE "status" = 'open';
CREATE INDEX "moderation_reports_status_idx" ON "moderation_reports" ("status", "created_at");

-- ── 15-admin R7 — support tickets ────────────────────────────────────────────
CREATE TABLE "support_tickets" (
    "id"                UUID PRIMARY KEY,
    "user_id"           UUID NOT NULL REFERENCES "users"("id"),
    "subject"           TEXT NOT NULL CHECK (char_length("subject") BETWEEN 3 AND 140),
    "linked_type"       TEXT CHECK ("linked_type" IS NULL OR "linked_type" IN ('event', 'registration', 'payment', 'booking', 'payout')),
    "linked_id"         UUID,
    "request_id"        TEXT,
    "status"            TEXT NOT NULL DEFAULT 'open'
                            CHECK ("status" IN ('open', 'pending_user', 'resolved', 'closed')),
    "assigned_to"       UUID REFERENCES "users"("id"),
    "first_response_at" TIMESTAMPTZ(6),
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" ("status", "created_at");
CREATE INDEX "support_tickets_user_idx" ON "support_tickets" ("user_id", "created_at" DESC);

CREATE TABLE "support_messages" (
    "id"         UUID PRIMARY KEY,
    "ticket_id"  UUID NOT NULL REFERENCES "support_tickets"("id") ON DELETE CASCADE,
    "author_id"  UUID NOT NULL REFERENCES "users"("id"),
    "body"       TEXT NOT NULL CHECK (char_length("body") BETWEEN 1 AND 4000),
    -- R7: never returned to the user.
    "internal"   BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "support_messages_ticket_idx" ON "support_messages" ("ticket_id", "created_at");

-- ── 15-admin R8 — fraud signals: recorded, never punished automatically ────
CREATE TABLE "fraud_signals" (
    "id"           UUID PRIMARY KEY,
    "subject_type" TEXT NOT NULL CHECK ("subject_type" IN ('user', 'organisation', 'venue', 'device')),
    "subject_id"   TEXT NOT NULL,
    "detector"     TEXT NOT NULL,
    "score"        SMALLINT NOT NULL CHECK ("score" BETWEEN 1 AND 100),
    -- One signal per (detector, subject, window): detectors run again and again.
    "dedupe_key"   TEXT NOT NULL UNIQUE,
    "evidence"     JSONB NOT NULL DEFAULT '{}',
    "reviewed_at"  TIMESTAMPTZ(6),
    "reviewed_by"  UUID REFERENCES "users"("id"),
    "outcome"      TEXT CHECK ("outcome" IS NULL OR "outcome" IN ('confirmed', 'dismissed')),
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CHECK (("reviewed_at" IS NULL) = ("outcome" IS NULL))
);
CREATE INDEX "fraud_signals_subject_idx" ON "fraud_signals" ("subject_type", "subject_id", "created_at" DESC);
CREATE INDEX "fraud_signals_open_idx" ON "fraud_signals" ("created_at") WHERE "reviewed_at" IS NULL;

-- ── bookings R7 — who runs a venue's desk ───────────────────────────────────
CREATE TABLE "venue_staff" (
    "venue_id"   UUID NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
    "user_id"    UUID NOT NULL REFERENCES "users"("id"),
    "role"       TEXT NOT NULL CHECK ("role" IN ('owner', 'manager', 'desk')),
    "granted_by" UUID REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    PRIMARY KEY ("venue_id", "user_id")
);
CREATE INDEX "venue_staff_user_idx" ON "venue_staff" ("user_id");

-- ── 19-bookings ─────────────────────────────────────────────────────────────
CREATE TABLE "venue_booking_policies" (
    "venue_id"             UUID PRIMARY KEY REFERENCES "venues"("id") ON DELETE CASCADE,
    "bookable"             BOOLEAN NOT NULL DEFAULT false,
    "advance_days"         SMALLINT NOT NULL DEFAULT 14 CHECK ("advance_days" BETWEEN 1 AND 60),
    "min_slot_minutes"     SMALLINT NOT NULL DEFAULT 60 CHECK ("min_slot_minutes" >= 30 AND "min_slot_minutes" % 30 = 0),
    "full_refund_hours"    SMALLINT NOT NULL DEFAULT 24 CHECK ("full_refund_hours" >= 0),
    "partial_refund_hours" SMALLINT NOT NULL DEFAULT 6 CHECK ("partial_refund_hours" >= 0),
    "partial_refund_bps"   INTEGER NOT NULL DEFAULT 5000 CHECK ("partial_refund_bps" BETWEEN 0 AND 10000),
    "platform_fee_paise"   BIGINT NOT NULL DEFAULT 0 CHECK ("platform_fee_paise" >= 0),
    "tax_bps"              INTEGER NOT NULL DEFAULT 0 CHECK ("tax_bps" BETWEEN 0 AND 10000),
    "timezone"             TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CHECK ("partial_refund_hours" <= "full_refund_hours")
);

CREATE TABLE "court_availability_rules" (
    "id"                   UUID PRIMARY KEY,
    "court_id"             UUID NOT NULL REFERENCES "venue_courts"("id") ON DELETE CASCADE,
    -- 0 = Monday … 6 = Sunday, like venues.opening_hours.
    "weekday"              SMALLINT NOT NULL CHECK ("weekday" BETWEEN 0 AND 6),
    "opens_at"             TIME NOT NULL,
    "closes_at"            TIME NOT NULL CHECK ("closes_at" > "opens_at"),
    "price_per_hour_paise" BIGINT NOT NULL CHECK ("price_per_hour_paise" >= 0)
);
CREATE INDEX "court_availability_rules_court_idx" ON "court_availability_rules" ("court_id", "weekday");

CREATE TABLE "court_blackouts" (
    "id"         UUID PRIMARY KEY,
    "venue_id"   UUID NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
    -- Null: the whole venue.
    "court_id"   UUID REFERENCES "venue_courts"("id") ON DELETE CASCADE,
    "kind"       TEXT NOT NULL CHECK ("kind" IN ('maintenance', 'event', 'private', 'holiday')),
    "event_id"   UUID REFERENCES "events"("id") ON DELETE SET NULL,
    "starts_at"  TIMESTAMPTZ(6) NOT NULL,
    "ends_at"    TIMESTAMPTZ(6) NOT NULL CHECK ("ends_at" > "starts_at"),
    "note"       TEXT,
    "created_by" UUID NOT NULL REFERENCES "users"("id"),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "court_blackouts_range_idx" ON "court_blackouts"
    USING gist ("venue_id", tstzrange("starts_at", "ends_at"));

CREATE TABLE "court_bookings" (
    "id"              UUID PRIMARY KEY,
    "venue_id"        UUID NOT NULL REFERENCES "venues"("id"),
    "court_id"        UUID NOT NULL REFERENCES "venue_courts"("id"),
    -- Null for a walk-in (R8).
    "user_id"         UUID REFERENCES "users"("id"),
    "walk_in_name"    TEXT,
    "walk_in_phone"   TEXT,
    "starts_at"       TIMESTAMPTZ(6) NOT NULL,
    "ends_at"         TIMESTAMPTZ(6) NOT NULL CHECK ("ends_at" > "starts_at"),
    "status"          TEXT NOT NULL DEFAULT 'held' CHECK ("status" IN
                        ('held', 'confirmed', 'checked_in', 'completed', 'cancelled', 'expired', 'no_show', 'payment_failed')),
    "payment_mode"    TEXT NOT NULL DEFAULT 'online' CHECK ("payment_mode" IN ('online', 'offline', 'comp')),
    "hold_expires_at" TIMESTAMPTZ(6),
    -- R5 — the frozen quote.
    "court_paise"        BIGINT NOT NULL CHECK ("court_paise" >= 0),
    "platform_fee_paise" BIGINT NOT NULL DEFAULT 0 CHECK ("platform_fee_paise" >= 0),
    "tax_paise"          BIGINT NOT NULL DEFAULT 0 CHECK ("tax_paise" >= 0),
    "amount_paise"       BIGINT NOT NULL CHECK ("amount_paise" >= 0),
    "cancelled_by"    UUID REFERENCES "users"("id"),
    "cancel_reason"   TEXT,
    "cancelled_at"    TIMESTAMPTZ(6),
    "checked_in_at"   TIMESTAMPTZ(6),
    "created_by"      UUID NOT NULL REFERENCES "users"("id"),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CHECK ("user_id" IS NOT NULL OR "walk_in_name" IS NOT NULL),
    CHECK (("status" = 'held') = ("hold_expires_at" IS NOT NULL)),
    -- R1 — no double-booking among live rows. Postgres decides, nothing else.
    CONSTRAINT "court_bookings_no_overlap" EXCLUDE USING gist (
        "court_id" WITH =,
        tstzrange("starts_at", "ends_at") WITH &&
    ) WHERE ("status" IN ('held', 'confirmed', 'checked_in'))
);
CREATE INDEX "court_bookings_user_idx" ON "court_bookings" ("user_id", "starts_at" DESC);
CREATE INDEX "court_bookings_venue_idx" ON "court_bookings" ("venue_id", "starts_at");
CREATE INDEX "court_bookings_held_idx" ON "court_bookings" ("hold_expires_at") WHERE "status" = 'held';

-- ── payments R20 — an order pays for an entry OR a court booking ────────────
ALTER TABLE "payment_orders" ALTER COLUMN "registration_id" DROP NOT NULL;
ALTER TABLE "payment_orders" ADD COLUMN "booking_id" UUID REFERENCES "court_bookings"("id");
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_subject_check"
    CHECK (("registration_id" IS NULL) <> ("booking_id" IS NULL));
CREATE INDEX "payment_orders_booking_idx" ON "payment_orders" ("booking_id") WHERE "booking_id" IS NOT NULL;
