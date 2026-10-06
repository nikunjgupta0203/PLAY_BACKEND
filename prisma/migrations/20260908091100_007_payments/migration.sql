-- 007 — payments (docs/modules/07-payments.md)
--
-- Razorpay orders, webhook ingest, refunds and a ledger.
--
-- `payment_webhook_events` has the razorpay event id as its PRIMARY KEY on
-- purpose: ingest claims that id before doing anything else, so a duplicate
-- delivery inserts nothing and is answered 200 immediately (payments R3). That
-- primary key is the whole idempotency story.
--
-- `ledger_entries` — not `payments` — is what reconciles against a Razorpay
-- settlement report (payments R6).

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "razorpay_order_id" TEXT NOT NULL,
    "entry_fee_paise" BIGINT NOT NULL,
    "platform_fee_paise" BIGINT NOT NULL,
    "tax_paise" BIGINT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'created',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "payment_order_id" UUID NOT NULL,
    "razorpay_payment_id" TEXT NOT NULL,
    "method" TEXT,
    "amount_paise" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "failure_reason" TEXT,
    "captured_at" TIMESTAMPTZ(6),
    "raw" JSONB NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "razorpay_refund_id" TEXT,
    "amount_paise" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "razorpay_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("razorpay_event_id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "registration_id" UUID,
    "payment_id" UUID,
    "refund_id" UUID,
    "kind" TEXT NOT NULL,
    "amount_paise" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_razorpay_order_id_key" ON "payment_orders" ("razorpay_order_id");

-- CreateIndex
CREATE INDEX "payment_orders_registration_id_idx" ON "payment_orders" ("registration_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_razorpay_payment_id_key" ON "payments" ("razorpay_payment_id");

-- CreateIndex
CREATE INDEX "payments_payment_order_id_idx" ON "payments" ("payment_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_razorpay_refund_id_key" ON "refunds" ("razorpay_refund_id");

-- CreateIndex
-- payments R7 — refunds are idempotent on this key. Retrying a refund must
-- never send money twice, and a UNIQUE constraint is the only version of that
-- promise which survives two workers racing.
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds" ("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds" ("payment_id");

-- CreateIndex
CREATE INDEX "ledger_entries_registration_id_idx" ON "ledger_entries" ("registration_id");

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_order_id_fkey" FOREIGN KEY ("payment_order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Status vocabularies as text + CHECK (conventions.md §2).
ALTER TABLE "payment_orders"
    ADD CONSTRAINT "payment_orders_status_check"
    CHECK ("status" IN ('created', 'attempted', 'paid', 'failed', 'expired'));

ALTER TABLE "payments"
    ADD CONSTRAINT "payments_status_check"
    CHECK ("status" IN ('authorized', 'captured', 'failed', 'refunded', 'partially_refunded'));

ALTER TABLE "refunds"
    ADD CONSTRAINT "refunds_status_check"
    CHECK ("status" IN ('pending', 'processed', 'failed'));

-- A zero or negative refund is not a refund. payments R8 keeps the total below
-- what was captured; this keeps each row above nothing.
ALTER TABLE "refunds"
    ADD CONSTRAINT "refunds_amount_paise_check" CHECK ("amount_paise" > 0);

-- payments R6 — the kinds that make a settlement report reconcile. A movement
-- that does not fit one of these is a movement nobody modelled.
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_kind_check"
    CHECK ("kind" IN ('charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal'));
