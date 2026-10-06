-- 025 — a declined message request can be asked again after 5 days (chat R10).
-- declined_at is when the request was declined; the sender may ask again at
-- declined_at + 5 days.

ALTER TABLE "conversations" ADD COLUMN "declined_at" TIMESTAMPTZ(6);

-- Requests declined before this migration have no decline time. Their last
-- message is the closest honest stand-in.
UPDATE "conversations"
   SET "declined_at" = COALESCE("last_message_at", "created_at")
 WHERE "status" = 'declined';

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_declined_at_check"
  CHECK (("status" = 'declined') = ("declined_at" IS NOT NULL));
