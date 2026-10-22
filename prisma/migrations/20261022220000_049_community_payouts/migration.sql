-- 049 — creator payouts for paid communities (communities R8, R10).
--
-- One payout per community per calendar month (India time), for the
-- memberships paid in it. The amounts are frozen when the month is settled:
-- what members paid, PL4Y's 5% (frozen on each payment), the GST on that
-- commission and the TDS, at the rates host payouts use. Paid by hand from
-- PL4Y's bank (PAYOUT_PROVIDER=manual) and marked paid with the UTR, like a
-- host payout; separate from `payouts`, which is one per event.
CREATE TABLE "community_payouts" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "payout_account_id" UUID,
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

    CONSTRAINT "community_payouts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_status_check"
    CHECK ("status" IN ('held', 'ready', 'paid'));
ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_period_check"
    CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_amount_check"
    CHECK ("amount_paise" = "gross_paise" - "commission_paise" - "commission_tax_paise" - "tds_paise" AND "amount_paise" >= 0);
-- A paid payout says how, and a ready one has somewhere to go.
ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_paid_check"
    CHECK ("status" <> 'paid' OR ("utr" IS NOT NULL AND "paid_at" IS NOT NULL));
ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_ready_check"
    CHECK ("status" = 'held' OR "payout_account_id" IS NOT NULL);

-- One payout per community per month: a retried settle job never pays twice.
CREATE UNIQUE INDEX "community_payouts_period_key" ON "community_payouts"("community_id", "period");
CREATE INDEX "community_payouts_status_idx" ON "community_payouts"("status", "created_at");

ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "community_payouts" ADD CONSTRAINT "community_payouts_payout_account_id_fkey"
    FOREIGN KEY ("payout_account_id") REFERENCES "payout_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Which payout a membership payment was settled in: it is counted once, ever.
ALTER TABLE "community_payments" ADD COLUMN "payout_id" UUID REFERENCES "community_payouts"("id");
CREATE INDEX "community_payments_unsettled_idx" ON "community_payments"("paid_at")
    WHERE "status" = 'paid' AND "payout_id" IS NULL;
