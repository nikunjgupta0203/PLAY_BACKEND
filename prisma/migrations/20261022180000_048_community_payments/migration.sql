-- 048 — paid community memberships (communities R8, payments R20).
--
-- A `community_payments` row is one period of one member's membership: held
-- while they pay, paid once the capture lands. It is the payment subject, the
-- way a court booking is. The member pays the listed price; PL4Y's 5% is
-- frozen on the row as `commission_paise` and taken from the creator's side at
-- payout, so the order carries no platform fee and no tax.
CREATE TABLE "community_payments" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "billing" TEXT NOT NULL,
    "price_paise" BIGINT NOT NULL,
    "commission_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "hold_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "payment_id" UUID,
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_payments_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_status_check"
    CHECK ("status" IN ('held', 'paid', 'expired', 'refunded'));
ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_billing_check"
    CHECK ("billing" IN ('one_time', 'monthly', 'yearly'));
ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_amounts_check"
    CHECK ("price_paise" > 0 AND "commission_paise" >= 0 AND "commission_paise" <= "price_paise");
-- A paid period says when it started; a one-time membership has no end.
ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_paid_check"
    CHECK ("status" <> 'paid' OR ("period_start" IS NOT NULL AND "paid_at" IS NOT NULL AND "payment_id" IS NOT NULL));

-- One checkout at a time per member and community.
CREATE UNIQUE INDEX "community_payments_one_held_idx" ON "community_payments"("community_id", "user_id")
    WHERE "status" = 'held';
CREATE INDEX "community_payments_community_idx" ON "community_payments"("community_id", "status", "paid_at");
CREATE INDEX "community_payments_user_idx" ON "community_payments"("user_id", "created_at" DESC);

ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_payments" ADD CONSTRAINT "community_payments_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- payments R20 — a third subject. Still exactly one per order.
ALTER TABLE "payment_orders" ADD COLUMN "community_payment_id" UUID REFERENCES "community_payments"("id");
ALTER TABLE "payment_orders" DROP CONSTRAINT "payment_orders_subject_check";
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_subject_check"
    CHECK (num_nonnulls("registration_id", "booking_id", "community_payment_id") = 1);
CREATE INDEX "payment_orders_community_payment_idx" ON "payment_orders" ("community_payment_id")
    WHERE "community_payment_id" IS NOT NULL;

-- communities R8 — the renewal reminder goes out once per period.
ALTER TABLE "community_members" ADD COLUMN "renewal_reminded_at" TIMESTAMPTZ(6);
