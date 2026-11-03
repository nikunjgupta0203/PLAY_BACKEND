-- 058 — Cue-sports launch: venue table bookings with payment preferences,
-- configurable commission with a per-venue introductory period, venue- and
-- PL4Y-funded offers that stack, pay-at-venue bookings, booking codes,
-- reminders and booking payouts (docs/plans/2026-11-03-cue-launch.md).
--
-- Every new column defaults to what the app did before, so existing bookings
-- and venues behave exactly as they did until an owner changes a setting.

-- --- 1. Pricing and commission settings, edited in the admin portal ----------------

CREATE TABLE "pricing_settings" (
    "id"                        SMALLINT PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
    -- PL4Y's commission on a venue's share of a table booking, and on pay-at-venue payments.
    "booking_commission_bps"    INTEGER NOT NULL DEFAULT 1000 CHECK ("booking_commission_bps" BETWEEN 0 AND 5000),
    "venue_pay_commission_bps"  INTEGER NOT NULL DEFAULT 1000 CHECK ("venue_pay_commission_bps" BETWEEN 0 AND 5000),
    -- The introductory period: every venue's first N days at this rate (0% at launch).
    "intro_enabled"             BOOLEAN NOT NULL DEFAULT true,
    "intro_days"                INTEGER NOT NULL DEFAULT 30 CHECK ("intro_days" BETWEEN 0 AND 365),
    "intro_commission_bps"      INTEGER NOT NULL DEFAULT 0 CHECK ("intro_commission_bps" BETWEEN 0 AND 5000),
    -- Bookings made before this instant are never settled into a venue payout.
    "launched_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- Stacking: whether a venue offer and a PL4Y offer both apply to one booking.
    "allow_stacking"            BOOLEAN NOT NULL DEFAULT true,
    -- What the PL4Y offer's percentage is taken of: the price after the venue's discount, or the original.
    "platform_discount_base"    TEXT NOT NULL DEFAULT 'after_venue' CHECK ("platform_discount_base" IN ('after_venue', 'original')),
    -- All discounts together never take more than this share of the original price.
    "max_discount_bps"          INTEGER NOT NULL DEFAULT 10000 CHECK ("max_discount_bps" BETWEEN 0 AND 10000),
    -- Whether the welcome/referral reward (054) also applies on top of a PL4Y offer.
    "rewards_with_promos"       BOOLEAN NOT NULL DEFAULT true,
    "updated_by"                UUID REFERENCES "users"("id"),
    "updated_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
INSERT INTO "pricing_settings" ("id") VALUES (1);

-- One row per venue that has started taking money through PL4Y: its
-- introductory period, and an optional commission that overrides the default.
CREATE TABLE "venue_commercial_terms" (
    "venue_id"                UUID PRIMARY KEY REFERENCES "venues"("id") ON DELETE CASCADE,
    "intro_starts_at"         TIMESTAMPTZ(6) NOT NULL,
    "intro_ends_at"           TIMESTAMPTZ(6) NOT NULL,
    "commission_bps_override" INTEGER CHECK ("commission_bps_override" BETWEEN 0 AND 5000),
    "note"                    TEXT,
    "updated_by"              UUID REFERENCES "users"("id"),
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CHECK ("intro_ends_at" >= "intro_starts_at")
);

-- Venues already in business through PL4Y start their 30 days today.
INSERT INTO "venue_commercial_terms" ("venue_id", "intro_starts_at", "intro_ends_at")
SELECT v."id", now(), now() + interval '30 days'
  FROM "venues" v
 WHERE v."deleted_at" IS NULL
   AND (v."pay_at_venue_enabled"
        OR EXISTS (SELECT 1 FROM "venue_booking_policies" p WHERE p."venue_id" = v."id" AND p."bookable"));

-- --- 2. Booking policy: durations, intervals, payment options -----------------------

ALTER TABLE "venue_booking_policies" DROP CONSTRAINT IF EXISTS "venue_booking_policies_min_slot_minutes_check";
ALTER TABLE "venue_booking_policies"
    ADD CONSTRAINT "venue_booking_policies_min_slot_check" CHECK ("min_slot_minutes" BETWEEN 10 AND 360),
    -- Start times are every this many minutes.
    ADD COLUMN "slot_step_minutes" SMALLINT NOT NULL DEFAULT 30
        CHECK ("slot_step_minutes" IN (5, 10, 15, 20, 30, 60)),
    -- The durations a player can pick, e.g. {30,40,60,90}. Empty: any multiple of the step from the minimum.
    ADD COLUMN "duration_options" SMALLINT[] NOT NULL DEFAULT '{60,90,120}',
    -- online | at_venue | both — what the player may choose at checkout.
    ADD COLUMN "payment_options" TEXT NOT NULL DEFAULT 'online'
        CHECK ("payment_options" IN ('online', 'at_venue', 'both'));

-- Before 058 start times stepped by the minimum slot; keep each venue's grid as it was.
UPDATE "venue_booking_policies" SET "slot_step_minutes" = LEAST("min_slot_minutes", 60);

-- --- 3. Offers: venue-funded (owner) and PL4Y-funded (portal) -------------------------

CREATE TABLE "offers" (
    "id"                 UUID PRIMARY KEY,
    -- venue: the venue gives it and it comes out of the venue's share.
    -- platform: PL4Y gives it; the venue is paid as if it did not exist.
    "funded_by"          TEXT NOT NULL CHECK ("funded_by" IN ('venue', 'platform')),
    -- Required for a venue offer; for a PL4Y offer, null = every venue.
    "venue_id"           UUID REFERENCES "venues"("id") ON DELETE CASCADE,
    "title"              TEXT NOT NULL CHECK (char_length("title") BETWEEN 3 AND 60),
    "description"        TEXT CHECK ("description" IS NULL OR char_length("description") <= 300),
    "kind"               TEXT NOT NULL CHECK ("kind" IN ('percent', 'flat')),
    "percent_bps"        INTEGER NOT NULL DEFAULT 0 CHECK ("percent_bps" BETWEEN 0 AND 10000),
    "flat_paise"         BIGINT NOT NULL DEFAULT 0 CHECK ("flat_paise" >= 0),
    -- A cap on what one booking gets off (e.g. 10% up to ₹100). Null: no cap.
    "max_discount_paise" BIGINT CHECK ("max_discount_paise" IS NULL OR "max_discount_paise" > 0),
    -- Eligibility.
    "min_amount_paise"   BIGINT NOT NULL DEFAULT 0 CHECK ("min_amount_paise" >= 0),
    "min_minutes"        INTEGER NOT NULL DEFAULT 0 CHECK ("min_minutes" BETWEEN 0 AND 720),
    -- 0 = Monday … 6 = Sunday. Empty: every day.
    "weekdays"           SMALLINT[] NOT NULL DEFAULT '{}',
    -- A time-of-day window the booking must start in (minutes after local midnight). Both or neither.
    "time_from_min"      SMALLINT CHECK ("time_from_min" BETWEEN 0 AND 1440),
    "time_to_min"        SMALLINT CHECK ("time_to_min" BETWEEN 0 AND 1440),
    -- Only for someone who has never booked or paid at this venue (a PL4Y offer: anywhere).
    "first_booking_only" BOOLEAN NOT NULL DEFAULT false,
    "starts_at"          TIMESTAMPTZ(6) NOT NULL,
    "ends_at"            TIMESTAMPTZ(6),
    -- Null: unlimited.
    "usage_limit"        INTEGER CHECK ("usage_limit" IS NULL OR "usage_limit" > 0),
    "per_user_limit"     INTEGER CHECK ("per_user_limit" IS NULL OR "per_user_limit" > 0),
    "active"             BOOLEAN NOT NULL DEFAULT true,
    -- Notifications sent once: new offer, and expiring within a day.
    "announced_at"       TIMESTAMPTZ(6),
    "expiry_notified_at" TIMESTAMPTZ(6),
    "created_by"         UUID NOT NULL REFERENCES "users"("id"),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CHECK ("funded_by" = 'platform' OR "venue_id" IS NOT NULL),
    CHECK (("kind" = 'percent' AND "percent_bps" > 0) OR ("kind" = 'flat' AND "flat_paise" > 0)),
    CHECK (("time_from_min" IS NULL) = ("time_to_min" IS NULL)),
    CHECK ("time_from_min" IS NULL OR "time_from_min" < "time_to_min"),
    CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at")
);
CREATE INDEX "offers_venue_idx" ON "offers" ("venue_id", "active");
CREATE INDEX "offers_platform_idx" ON "offers" ("funded_by", "active");

-- Who used which offer on which booking. 'reserved' while a booking is held
-- or payable, 'redeemed' once paid, 'released' when it was not.
CREATE TABLE "offer_redemptions" (
    "id"             UUID PRIMARY KEY,
    "offer_id"       UUID NOT NULL REFERENCES "offers"("id") ON DELETE CASCADE,
    "user_id"        UUID NOT NULL REFERENCES "users"("id"),
    "booking_id"     UUID NOT NULL REFERENCES "court_bookings"("id") ON DELETE CASCADE,
    "funded_by"      TEXT NOT NULL CHECK ("funded_by" IN ('venue', 'platform')),
    "discount_paise" BIGINT NOT NULL CHECK ("discount_paise" >= 0),
    "status"         TEXT NOT NULL DEFAULT 'reserved' CHECK ("status" IN ('reserved', 'redeemed', 'released')),
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "offer_redemptions_booking_key" UNIQUE ("offer_id", "booking_id")
);
CREATE INDEX "offer_redemptions_offer_idx" ON "offer_redemptions" ("offer_id", "status");
CREATE INDEX "offer_redemptions_user_idx" ON "offer_redemptions" ("user_id", "offer_id");

-- --- 4. Bookings: codes, discounts, payment status, settlement ------------------------

ALTER TABLE "court_bookings" DROP CONSTRAINT IF EXISTS "court_bookings_payment_mode_check";
ALTER TABLE "court_bookings"
    ADD CONSTRAINT "court_bookings_payment_mode_check" CHECK ("payment_mode" IN ('online', 'at_venue', 'offline', 'comp')),
    -- "BK-7K3Q9XA2": what the player quotes at the desk and on support.
    ADD COLUMN "booking_code" TEXT,
    -- The price before any discount. court_paise = base − venue discount − PL4Y discount.
    ADD COLUMN "base_paise" BIGINT,
    ADD COLUMN "venue_offer_id" UUID REFERENCES "offers"("id") ON DELETE SET NULL,
    ADD COLUMN "venue_discount_paise" BIGINT NOT NULL DEFAULT 0 CHECK ("venue_discount_paise" >= 0),
    ADD COLUMN "platform_offer_id" UUID REFERENCES "offers"("id") ON DELETE SET NULL,
    ADD COLUMN "platform_discount_paise" BIGINT NOT NULL DEFAULT 0 CHECK ("platform_discount_paise" >= 0),
    -- pending (online, unpaid) | paid | due (pay at venue) | failed (last attempt failed, hold alive)
    -- | void (nothing owed) | waived (free) | refunded | partially_refunded
    ADD COLUMN "payment_status" TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN "payment_method" TEXT,
    -- Who holds the money: PL4Y (online, or paid in the app) or the venue (paid at the desk).
    ADD COLUMN "collected_by" TEXT CHECK ("collected_by" IN ('pl4y', 'venue')),
    ADD COLUMN "paid_at" TIMESTAMPTZ(6),
    ADD COLUMN "refunded_paise" BIGINT NOT NULL DEFAULT 0 CHECK ("refunded_paise" >= 0),
    -- Settlement, frozen at booking: what the venue earns before commission (base − the venue's
    -- own discount; PL4Y's discount is PL4Y's), PL4Y's rate, and the commission on it.
    ADD COLUMN "venue_gross_paise" BIGINT NOT NULL DEFAULT 0 CHECK ("venue_gross_paise" >= 0),
    ADD COLUMN "commission_bps" INTEGER NOT NULL DEFAULT 0 CHECK ("commission_bps" BETWEEN 0 AND 5000),
    ADD COLUMN "commission_paise" BIGINT NOT NULL DEFAULT 0 CHECK ("commission_paise" >= 0),
    ADD COLUMN "payout_id" UUID REFERENCES "venue_payouts"("id") ON DELETE SET NULL,
    ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(6);

UPDATE "court_bookings" SET
    "booking_code" = 'BK-' || upper(substr(md5("id"::text), 1, 8)),
    "base_paise" = "court_paise",
    "payment_status" = CASE
        WHEN "payment_mode" = 'comp' THEN 'waived'
        WHEN "payment_mode" = 'offline' THEN 'paid'
        WHEN "status" = 'held' THEN 'pending'
        WHEN "status" IN ('confirmed', 'checked_in', 'completed', 'no_show') THEN 'paid'
        WHEN "status" = 'cancelled' AND "amount_paise" > 0 THEN 'refunded'
        ELSE 'void' END,
    "collected_by" = CASE
        WHEN "payment_mode" = 'offline' THEN 'venue'
        WHEN "payment_mode" = 'online' AND "status" IN ('confirmed', 'checked_in', 'completed', 'no_show') THEN 'pl4y'
        ELSE NULL END;

ALTER TABLE "court_bookings"
    ALTER COLUMN "booking_code" SET NOT NULL,
    ALTER COLUMN "base_paise" SET NOT NULL,
    ADD CONSTRAINT "court_bookings_booking_code_key" UNIQUE ("booking_code"),
    ADD CONSTRAINT "court_bookings_payment_status_check" CHECK ("payment_status" IN
        ('pending', 'paid', 'due', 'failed', 'void', 'waived', 'refunded', 'partially_refunded')),
    ADD CONSTRAINT "court_bookings_discounts_check" CHECK (
        "court_paise" = "base_paise" - "venue_discount_paise" - "platform_discount_paise"),
    ADD CONSTRAINT "court_bookings_commission_check" CHECK ("commission_paise" <= "venue_gross_paise");

CREATE INDEX "court_bookings_payout_idx" ON "court_bookings" ("venue_id", "payment_status") WHERE "payout_id" IS NULL;
CREATE INDEX "court_bookings_reminder_idx" ON "court_bookings" ("starts_at") WHERE "status" = 'confirmed' AND "reminder_sent_at" IS NULL;

-- --- 5. Venue payouts settle bookings too -------------------------------------------------

ALTER TABLE "venue_payouts" ADD COLUMN "booking_count" INTEGER NOT NULL DEFAULT 0;
