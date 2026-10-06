-- 013 — payments, Sprint 7: payout accounts (docs/modules/07-payments.md R13)
--
-- Organizers and venues are paid through Razorpay Route linked accounts. KYC
-- documents go to Razorpay and never to this database. The status column is
-- driven by Route account webhooks, never by the answer to the create call.

CREATE TABLE "payout_accounts" (
    "id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    -- No FK: the owner is an organizer profile or a venue, owned by other modules.
    "owner_id" UUID NOT NULL,
    "razorpay_account_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payout_accounts_owner_type_check" CHECK ("owner_type" IN ('organizer', 'venue')),
    CONSTRAINT "payout_accounts_status_check" CHECK ("status" IN
      ('created', 'under_review', 'needs_clarification', 'active', 'suspended'))
);

CREATE UNIQUE INDEX "payout_accounts_razorpay_account_id_key"
    ON "payout_accounts" ("razorpay_account_id");

-- One account per owner. A retried create collides here instead of opening a
-- second Route account.
CREATE UNIQUE INDEX "payout_accounts_owner_type_owner_id_key"
    ON "payout_accounts" ("owner_type", "owner_id");
