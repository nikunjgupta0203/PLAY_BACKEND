-- 041 — chat: edit (within 15 minutes), delete and reply to messages.
--
-- Delete is soft: the row stays, so the thread keeps its "message deleted"
-- placeholder, a reply keeps pointing at what it answered, and a moderation
-- report on the message keeps its evidence. The body is never sent to a player
-- once deleted_at is set.
--
-- reply_to_id is always a message in the same conversation (the service checks
-- it); SET NULL only matters if a conversation's rows are ever hard-deleted.
ALTER TABLE "messages"
    ADD COLUMN "edited_at"   TIMESTAMPTZ(6),
    ADD COLUMN "deleted_at"  TIMESTAMPTZ(6),
    ADD COLUMN "reply_to_id" UUID REFERENCES "messages" ("id") ON DELETE SET NULL;

CREATE INDEX "messages_reply_to_id_idx" ON "messages" ("reply_to_id");
