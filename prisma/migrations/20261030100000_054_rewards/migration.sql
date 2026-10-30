-- 054 — PL4Y Rewards: the first-payment discount and the referral reward
-- (docs/plans/2026-10-30-feature-brief.md, phase 1).
--
-- One rewards system across every paid service. PL4Y funds every discount:
-- an order keeps its undiscounted price (`gross_paise`) beside what the
-- player paid (`amount_paise`), so hosts, venues and community owners are
-- paid on the gross and the difference is PL4Y's.

-- The rules, edited by PL4Y staff in the portal. Exactly one row.
CREATE TABLE "reward_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "percent_bps" INTEGER NOT NULL DEFAULT 1000,
    "cap_paise" BIGINT NOT NULL DEFAULT 10000,
    "min_order_paise" BIGINT NOT NULL DEFAULT 10000,
    "referral_enabled" BOOLEAN NOT NULL DEFAULT true,
    "referral_expiry_days" INTEGER NOT NULL DEFAULT 90,
    "referral_monthly_cap" INTEGER NOT NULL DEFAULT 20,
    "referral_window_days" INTEGER NOT NULL DEFAULT 7,
    "allow_stacking" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" UUID REFERENCES "users"("id"),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reward_settings_single_check" CHECK ("id" = 1),
    CONSTRAINT "reward_settings_values_check" CHECK (
        "percent_bps" BETWEEN 0 AND 10000 AND "cap_paise" >= 0 AND "min_order_paise" >= 0
        AND "referral_expiry_days" BETWEEN 1 AND 3650 AND "referral_monthly_cap" BETWEEN 0 AND 1000
        AND "referral_window_days" BETWEEN 0 AND 365)
);
INSERT INTO "reward_settings" ("id") VALUES (1);

-- A player's own code, made the first time they ask for it.
ALTER TABLE "users" ADD COLUMN "referral_code" CITEXT;
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- One per referred player: who brought them, and whether it paid off.
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "referrer_id" UUID NOT NULL REFERENCES "users"("id"),
    "referred_id" UUID NOT NULL REFERENCES "users"("id"),
    "code" TEXT NOT NULL,
    -- pending: waiting for the first payment. converted: the referrer's reward
    -- is issued. held: a fraud check stopped it for PL4Y staff. rejected: never pays.
    "status" TEXT NOT NULL DEFAULT 'pending',
    "hold_reason" TEXT,
    "payment_order_id" UUID REFERENCES "payment_orders"("id"),
    "converted_at" TIMESTAMPTZ(6),
    "reviewed_by" UUID REFERENCES "users"("id"),
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "referrals_status_check" CHECK ("status" IN ('pending', 'converted', 'held', 'rejected')),
    CONSTRAINT "referrals_not_self_check" CHECK ("referrer_id" <> "referred_id")
);
CREATE UNIQUE INDEX "referrals_referred_key" ON "referrals"("referred_id");
CREATE INDEX "referrals_referrer_idx" ON "referrals"("referrer_id", "created_at" DESC);
CREATE INDEX "referrals_status_idx" ON "referrals"("status", "created_at");

-- A discount a player holds. The first-payment one is made on first use (one
-- per player, ever); a referral one is issued when the referral converts.
CREATE TABLE "rewards" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL REFERENCES "users"("id"),
    "kind" TEXT NOT NULL,
    -- available | used | expired | void. An open order that counted it lists
    -- it in payment_orders.reward_ids; only that order's capture uses it.
    "status" TEXT NOT NULL DEFAULT 'available',
    "percent_bps" INTEGER NOT NULL,
    "cap_paise" BIGINT NOT NULL,
    "referral_id" UUID REFERENCES "referrals"("id"),
    "expires_at" TIMESTAMPTZ(6),
    "used_order_id" UUID REFERENCES "payment_orders"("id"),
    "used_at" TIMESTAMPTZ(6),
    "discount_paise" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewards_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rewards_kind_check" CHECK ("kind" IN ('first_payment', 'referral')),
    CONSTRAINT "rewards_status_check" CHECK ("status" IN ('available', 'used', 'expired', 'void')),
    CONSTRAINT "rewards_referral_check" CHECK (("kind" = 'referral') = ("referral_id" IS NOT NULL)),
    CONSTRAINT "rewards_used_check" CHECK ("status" <> 'used' OR ("used_order_id" IS NOT NULL AND "used_at" IS NOT NULL))
);
-- Once per player, and one reward per converted referral.
CREATE UNIQUE INDEX "rewards_first_payment_key" ON "rewards"("user_id") WHERE "kind" = 'first_payment';
CREATE UNIQUE INDEX "rewards_referral_key" ON "rewards"("referral_id");
CREATE INDEX "rewards_user_idx" ON "rewards"("user_id", "created_at" DESC);
CREATE INDEX "rewards_expiring_idx" ON "rewards"("expires_at") WHERE "status" = 'available';

-- Who paid, before any discount, and how much PL4Y took off.
ALTER TABLE "payment_orders" ADD COLUMN "payer_user_id" UUID REFERENCES "users"("id");
ALTER TABLE "payment_orders" ADD COLUMN "gross_paise" BIGINT;
ALTER TABLE "payment_orders" ADD COLUMN "discount_paise" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "payment_orders" ADD COLUMN "reward_ids" UUID[] NOT NULL DEFAULT '{}';

UPDATE "payment_orders" po SET "payer_user_id" = r."captain_user_id"
  FROM "registrations" r WHERE po."registration_id" = r."id";
UPDATE "payment_orders" po SET "payer_user_id" = b."user_id"
  FROM "court_bookings" b WHERE po."booking_id" = b."id";
UPDATE "payment_orders" po SET "payer_user_id" = cp."user_id"
  FROM "community_payments" cp WHERE po."community_payment_id" = cp."id";
UPDATE "payment_orders" SET "gross_paise" = "amount_paise";
ALTER TABLE "payment_orders" ALTER COLUMN "gross_paise" SET NOT NULL;

ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_discount_check"
    CHECK ("discount_paise" >= 0 AND "amount_paise" = "gross_paise" - "discount_paise");
-- "Has this player ever paid?" — the first-payment and referral checks.
CREATE INDEX "payment_orders_payer_paid_idx" ON "payment_orders"("payer_user_id") WHERE "status" = 'paid';

-- What PL4Y paid on the player's behalf, and its reversal on a full refund.
-- Both feed the host's payout quote, so the seller is paid on the gross.
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind_check";
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_kind_check"
    CHECK ("kind" IN (
        'charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal',
        'host_commission', 'commission_tax', 'tds_withheld', 'host_payout',
        'host_receivable', 'receivable_recovered', 'gateway_fee',
        'reward_discount', 'reward_reversal'
    ));
