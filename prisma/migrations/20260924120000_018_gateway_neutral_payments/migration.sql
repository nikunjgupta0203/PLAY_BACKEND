-- 018 — payments: gateway-neutral column names.
--
-- Razorpay is gone; the payments module now talks to a `PaymentGateway` port
-- (src/platform/paymentGateway.ts). The ids these columns hold are whatever the
-- configured provider issues, so they are named for the role, not the vendor.
-- Renames only: no data moves, and every unique index keeps its guarantee.

ALTER TABLE "payment_orders" RENAME COLUMN "razorpay_order_id" TO "gateway_order_id";
ALTER INDEX "payment_orders_razorpay_order_id_key" RENAME TO "payment_orders_gateway_order_id_key";

ALTER TABLE "payments" RENAME COLUMN "razorpay_payment_id" TO "gateway_payment_id";
ALTER INDEX "payments_razorpay_payment_id_key" RENAME TO "payments_gateway_payment_id_key";

ALTER TABLE "refunds" RENAME COLUMN "razorpay_refund_id" TO "gateway_refund_id";
ALTER INDEX "refunds_razorpay_refund_id_key" RENAME TO "refunds_gateway_refund_id_key";

ALTER TABLE "payment_webhook_events" RENAME COLUMN "razorpay_event_id" TO "gateway_event_id";

ALTER TABLE "payout_accounts" RENAME COLUMN "razorpay_account_id" TO "gateway_account_id";
ALTER INDEX "payout_accounts_razorpay_account_id_key" RENAME TO "payout_accounts_gateway_account_id_key";
