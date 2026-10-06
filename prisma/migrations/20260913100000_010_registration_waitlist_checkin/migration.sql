-- 010 — registration: free entries, waitlist, QR check-in, organizer entries
-- (docs/modules/06-registration.md R13, R14, R16, R17, R18)
--
-- Fix-forward on 006. Nothing here changes how capacity is decided: a
-- waitlisted entry holds NO seat (R2, R17), so the FOR UPDATE query in R4 and
-- the seat_holds partial index are untouched.

-- registration R14 — how the entry was paid for. `offline` and `comp` entries
-- are added by staff and write no ledger row.
ALTER TABLE "registrations"
    ADD COLUMN "payment_mode" TEXT NOT NULL DEFAULT 'online',
    ADD COLUMN "checked_in_at" TIMESTAMPTZ(6),   -- R13 — the ORIGINAL scan time
    ADD COLUMN "checked_in_by" UUID,             -- R13
    ADD COLUMN "withdrawn_reason" TEXT;          -- R16

ALTER TABLE "registrations"
    ADD CONSTRAINT "registrations_payment_mode_check"
    CHECK ("payment_mode" IN ('online', 'offline', 'comp'));

ALTER TABLE "registrations"
    ADD CONSTRAINT "registrations_checked_in_by_fkey"
    FOREIGN KEY ("checked_in_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- registration R17 — `waitlisted` joins the state machine.
ALTER TABLE "registrations" DROP CONSTRAINT "registrations_status_check";
ALTER TABLE "registrations"
    ADD CONSTRAINT "registrations_status_check"
    CHECK ("status" IN (
      'draft', 'awaiting_partner', 'waitlisted', 'payment_pending', 'confirmed',
      'checked_in', 'withdrawn', 'expired', 'payment_failed', 'refunded'));

-- registration R1 — a waitlisted entry is a live entry. Without this a player
-- could sit on the waitlist AND begin a second entry in the same draw.
DROP INDEX "reg_one_live_per_player";
CREATE UNIQUE INDEX "reg_one_live_per_player"
    ON "registrations" ("event_category_id", "captain_user_id")
    WHERE "status" IN ('awaiting_partner', 'waitlisted', 'payment_pending', 'confirmed', 'checked_in');

-- registration R17 — the queue. Ordered by `created_at`, which is the moment
-- the entry joined, not the moment the registration row was created.
CREATE TABLE "waitlist_entries" (
    "registration_id" UUID NOT NULL,
    "event_category_id" UUID NOT NULL,
    -- Set when the head of the queue is promoted. The row stays afterwards, so
    -- a lapsed offer can be told apart from an ordinary expired hold.
    "offered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("registration_id")
);

-- Only entries still waiting are ever read in queue order.
CREATE INDEX "waitlist_entries_queue_idx"
    ON "waitlist_entries" ("event_category_id", "created_at") WHERE "offered_at" IS NULL;

ALTER TABLE "waitlist_entries"
    ADD CONSTRAINT "waitlist_entries_registration_id_fkey"
    FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "waitlist_entries"
    ADD CONSTRAINT "waitlist_entries_event_category_id_fkey"
    FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
