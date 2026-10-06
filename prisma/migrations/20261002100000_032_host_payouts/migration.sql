-- 032 — hosts are paid (spec 2026-10-02-host-payouts). One payout account per
-- user, verified by a penny test; one payout per event per account, settled
-- 72 h after the event ends through PayU Payouts.

-- payments R13's sub-merchant table (migration 013) was never wired to code and
-- this design supersedes it. Refuse rather than drop anything real.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "payout_accounts") THEN
        RAISE EXCEPTION 'payout_accounts (R13) has rows; migrate them before 032';
    END IF;
END $$;
DROP TABLE "payout_accounts";

CREATE TABLE "payout_accounts" (
    "id"                 UUID PRIMARY KEY,
    "user_id"            UUID NOT NULL UNIQUE REFERENCES "users"("id"),
    "legal_name"         TEXT NOT NULL,
    -- payouts R2 — sealed with PAYOUT_DATA_KEY; only the last four are clear.
    "pan_cipher"         BYTEA NOT NULL,
    "pan_last4"          TEXT NOT NULL,
    "account_cipher"     BYTEA NOT NULL,
    "account_last4"      TEXT NOT NULL,
    "ifsc"               TEXT NOT NULL,
    "pan_surname_ok"     BOOLEAN NOT NULL,
    "bank_name_returned" TEXT,
    "name_match"         SMALLINT,
    "status"             TEXT NOT NULL DEFAULT 'checking'
        CHECK ("status" IN ('checking', 'verified', 'needs_review', 'rejected', 'suspended')),
    "status_reason"      TEXT,
    "verify_ref"         TEXT,
    "check_attempts"     SMALLINT NOT NULL DEFAULT 0,
    "reviewed_by"        UUID REFERENCES "users"("id"),
    "reviewed_at"        TIMESTAMPTZ(6),
    "verified_at"        TIMESTAMPTZ(6),
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The staff queue reads only the accounts waiting on a person.
CREATE INDEX "payout_accounts_review_idx" ON "payout_accounts" ("created_at")
    WHERE "status" = 'needs_review';

CREATE TABLE "payouts" (
    "id"                   UUID PRIMARY KEY,
    "payout_account_id"    UUID NOT NULL REFERENCES "payout_accounts"("id"),
    "event_id"             UUID NOT NULL REFERENCES "events"("id"),
    "entry_fees_paise"     BIGINT NOT NULL DEFAULT 0,
    "refunds_paise"        BIGINT NOT NULL DEFAULT 0,
    "commission_paise"     BIGINT NOT NULL DEFAULT 0,
    "commission_tax_paise" BIGINT NOT NULL DEFAULT 0,
    "tds_paise"            BIGINT NOT NULL DEFAULT 0,
    "receivables_paise"    BIGINT NOT NULL DEFAULT 0,
    "amount_paise"         BIGINT NOT NULL DEFAULT 0,
    "status"               TEXT NOT NULL DEFAULT 'scheduled'
        CHECK ("status" IN ('scheduled', 'held', 'awaiting_funds', 'sending', 'paid', 'failed')),
    -- 'staff:<reason>' for a staff hold (released only by staff), otherwise automatic.
    "hold_reason"          TEXT,
    -- The merchantRefId of the current attempt: the payout id, then <id>-r<n>.
    "transfer_ref"         TEXT UNIQUE,
    "provider_status"      TEXT,
    "provider_ref"         TEXT,
    "attempts"             SMALLINT NOT NULL DEFAULT 0,
    "last_error"           TEXT,
    "due_at"               TIMESTAMPTZ(6) NOT NULL,
    "sent_at"              TIMESTAMPTZ(6),
    "paid_at"              TIMESTAMPTZ(6),
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- payments R15 — a retried settle job can never create a second payout.
    UNIQUE ("event_id", "payout_account_id")
);

CREATE INDEX "payouts_due_idx" ON "payouts" ("due_at")
    WHERE "status" IN ('scheduled', 'held', 'awaiting_funds');
CREATE INDEX "payouts_sending_idx" ON "payouts" ("sent_at") WHERE "status" = 'sending';

ALTER TABLE "ledger_entries" ADD COLUMN "payout_id" UUID REFERENCES "payouts"("id");
CREATE INDEX "ledger_entries_payout_idx" ON "ledger_entries" ("payout_id");

-- payments R18 — every payout movement is a ledger row.
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind_check";
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_kind_check"
    CHECK ("kind" IN (
        'charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal',
        'host_commission', 'commission_tax', 'tds_withheld', 'host_payout',
        'host_receivable', 'receivable_recovered'
    ));
