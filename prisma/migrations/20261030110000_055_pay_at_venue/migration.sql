-- 055 — Pay at Venue (docs/plans/2026-10-30-feature-brief.md, phase 3).
--
-- A player at a venue pays through PL4Y for the time they played: they pick
-- an activity, enter the minutes, and PL4Y prices it from the venue's hourly
-- rate. Not a booking: nothing is held on a court. The venue is paid once a
-- month, by hand like community payouts (049), less PL4Y's 10% commission.

-- The owner sets rates; PL4Y staff switch the button on.
ALTER TABLE "venues" ADD COLUMN "pay_at_venue_enabled" BOOLEAN NOT NULL DEFAULT false;

-- One hourly rate per activity or resource: "Badminton court", "Table tennis".
CREATE TABLE "venue_pay_rates" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL REFERENCES "venues"("id") ON DELETE CASCADE,
    "label" TEXT NOT NULL,
    "sport_id" UUID REFERENCES "sports"("id"),
    "rate_per_hour_paise" BIGINT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_pay_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_pay_rates_label_check" CHECK (char_length("label") BETWEEN 2 AND 60),
    -- ₹10 to ₹1,00,000 an hour.
    CONSTRAINT "venue_pay_rates_rate_check" CHECK ("rate_per_hour_paise" BETWEEN 1000 AND 10000000)
);
CREATE INDEX "venue_pay_rates_venue_idx" ON "venue_pay_rates"("venue_id", "position");

-- One payment for one stretch of play. The rate, label and commission are
-- frozen when the player starts, so a later rate change never reprices it.
CREATE TABLE "venue_payments" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL REFERENCES "venues"("id"),
    "rate_id" UUID NOT NULL REFERENCES "venue_pay_rates"("id"),
    "user_id" UUID NOT NULL REFERENCES "users"("id"),
    "label" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "rate_per_hour_paise" BIGINT NOT NULL,
    -- The price of the time: what the venue is paid on. A reward discount is PL4Y's.
    "amount_paise" BIGINT NOT NULL,
    -- PL4Y's 10%, frozen here; taken from the venue's side at payout.
    "commission_paise" BIGINT NOT NULL,
    -- held | paid | expired | failed | refunded
    "status" TEXT NOT NULL DEFAULT 'held',
    "hold_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "payment_id" UUID REFERENCES "payments"("id"),
    "paid_at" TIMESTAMPTZ(6),
    "payout_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_payments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_payments_status_check" CHECK ("status" IN ('held', 'paid', 'expired', 'failed', 'refunded')),
    CONSTRAINT "venue_payments_minutes_check" CHECK ("minutes" BETWEEN 10 AND 600),
    CONSTRAINT "venue_payments_amount_check" CHECK ("amount_paise" > 0 AND "commission_paise" BETWEEN 0 AND "amount_paise"),
    CONSTRAINT "venue_payments_paid_check" CHECK ("status" NOT IN ('paid', 'refunded') OR ("payment_id" IS NOT NULL AND "paid_at" IS NOT NULL))
);
CREATE INDEX "venue_payments_venue_idx" ON "venue_payments"("venue_id", "created_at" DESC);
CREATE INDEX "venue_payments_user_idx" ON "venue_payments"("user_id", "created_at" DESC);

-- One payout per venue per calendar month (India time), paid by hand.
CREATE TABLE "venue_payouts" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL REFERENCES "venues"("id") ON DELETE RESTRICT,
    "owner_user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "payout_account_id" UUID REFERENCES "payout_accounts"("id") ON DELETE RESTRICT,
    "period" TEXT NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "gross_paise" BIGINT NOT NULL,
    "commission_paise" BIGINT NOT NULL,
    "commission_tax_paise" BIGINT NOT NULL,
    "tds_paise" BIGINT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "hold_reason" TEXT,
    "utr" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "marked_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_payouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "venue_payouts_status_check" CHECK ("status" IN ('held', 'ready', 'paid')),
    CONSTRAINT "venue_payouts_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "venue_payouts_amount_check"
        CHECK ("amount_paise" = "gross_paise" - "commission_paise" - "commission_tax_paise" - "tds_paise" AND "amount_paise" >= 0),
    CONSTRAINT "venue_payouts_paid_check" CHECK ("status" <> 'paid' OR ("utr" IS NOT NULL AND "paid_at" IS NOT NULL)),
    CONSTRAINT "venue_payouts_ready_check" CHECK ("status" = 'held' OR "payout_account_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "venue_payouts_period_key" ON "venue_payouts"("venue_id", "period");
CREATE INDEX "venue_payouts_status_idx" ON "venue_payouts"("status", "created_at");

ALTER TABLE "venue_payments" ADD CONSTRAINT "venue_payments_payout_id_fkey"
    FOREIGN KEY ("payout_id") REFERENCES "venue_payouts"("id");
CREATE INDEX "venue_payments_unsettled_idx" ON "venue_payments"("paid_at")
    WHERE "status" = 'paid' AND "payout_id" IS NULL;

-- payments R20 — a fourth subject. Still exactly one per order.
ALTER TABLE "payment_orders" ADD COLUMN "venue_payment_id" UUID REFERENCES "venue_payments"("id");
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_subject_check";
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_subject_check"
    CHECK (num_nonnulls("registration_id", "booking_id", "community_payment_id", "venue_payment_id") = 1);
CREATE INDEX "payment_orders_venue_payment_idx" ON "payment_orders" ("venue_payment_id")
    WHERE "venue_payment_id" IS NOT NULL;
