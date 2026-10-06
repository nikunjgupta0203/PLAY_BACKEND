-- 033 — fixes from the 2026-10-03 gap review (docs/gap-fixes-2026-10-03.md).

-- gap #15 — a refund the gateway failed is sent again under a fresh receipt;
-- this counts the tries, and after the last one the refund is marked failed
-- and finance is alerted.
ALTER TABLE "refunds" ADD COLUMN "attempts" SMALLINT NOT NULL DEFAULT 0;

-- gap #25 — when verified bank details change: the name they were verified
-- under (a different name goes to a person, not the auto-check), and when the
-- change happened (payouts wait 48 h after it).
ALTER TABLE "payout_accounts" ADD COLUMN "verified_legal_name" TEXT;
ALTER TABLE "payout_accounts" ADD COLUMN "details_changed_at" TIMESTAMPTZ(6);
UPDATE "payout_accounts" SET "verified_legal_name" = "legal_name" WHERE "status" = 'verified';

-- gap #20 — an open dispute keeps reminding the organizer, and escalates to
-- PL4Y staff once the event is a day over.
ALTER TABLE "match_results" ADD COLUMN "dispute_alerted_at" TIMESTAMPTZ(6);
ALTER TABLE "match_results" ADD COLUMN "escalated_at" TIMESTAMPTZ(6);

-- gap #8 — the database's own refusal of a category that cannot be a draw.
-- NOT VALID: rows written before this rule are left alone (some carry the old
-- default of four minimum entries on a smaller draw); every new or edited row
-- is checked.
ALTER TABLE "event_categories"
    ADD CONSTRAINT "event_categories_fee_check"
    CHECK ("entry_fee_paise" >= 0 AND "platform_fee_paise" >= 0) NOT VALID;
ALTER TABLE "event_categories"
    ADD CONSTRAINT "event_categories_tax_check"
    CHECK ("tax_bps" BETWEEN 0 AND 10000) NOT VALID;
ALTER TABLE "event_categories"
    ADD CONSTRAINT "event_categories_min_entries_check"
    CHECK ("min_entries" >= 1 AND "min_entries" <= "capacity") NOT VALID;
