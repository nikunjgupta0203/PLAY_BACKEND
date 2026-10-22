-- 047 — communities (docs/modules/17-communities.md).
--
-- Two independent choices at creation — public or private, free or paid —
-- give the four community types (R1). Members are stored by user id, like
-- games. Money for paid communities arrives in a later migration; this one
-- already carries the price so a paid community can be listed with it.
CREATE TABLE "communities" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sport_id" UUID NOT NULL,
    "city" TEXT NOT NULL DEFAULT '',
    "cover_public_id" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "discoverable" BOOLEAN NOT NULL DEFAULT true,
    "access" TEXT NOT NULL DEFAULT 'free',
    "price_paise" BIGINT,
    "billing" TEXT,
    "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invite_code" TEXT NOT NULL,
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "owner_user_id" UUID NOT NULL,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hidden_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "communities" ADD CONSTRAINT "communities_visibility_check"
    CHECK ("visibility" IN ('public', 'private'));
ALTER TABLE "communities" ADD CONSTRAINT "communities_access_check"
    CHECK ("access" IN ('free', 'paid'));
ALTER TABLE "communities" ADD CONSTRAINT "communities_billing_check"
    CHECK ("billing" IS NULL OR "billing" IN ('one_time', 'monthly', 'yearly'));
-- R1 — a paid community always has a price and a period; a free one has neither.
ALTER TABLE "communities" ADD CONSTRAINT "communities_paid_check"
    CHECK (("access" = 'paid') = ("price_paise" IS NOT NULL AND "billing" IS NOT NULL));
-- R7 — ₹10 to ₹50,000.
ALTER TABLE "communities" ADD CONSTRAINT "communities_price_check"
    CHECK ("price_paise" IS NULL OR "price_paise" BETWEEN 1000 AND 5000000);
ALTER TABLE "communities" ADD CONSTRAINT "communities_name_check"
    CHECK (char_length("name") BETWEEN 3 AND 60);
ALTER TABLE "communities" ADD CONSTRAINT "communities_description_check"
    CHECK ("description" IS NULL OR char_length("description") <= 1000);
ALTER TABLE "communities" ADD CONSTRAINT "communities_member_count_check"
    CHECK ("member_count" >= 0);

CREATE UNIQUE INDEX "communities_slug_key" ON "communities"("slug");
CREATE UNIQUE INDEX "communities_invite_code_key" ON "communities"("invite_code");
CREATE INDEX "communities_owner_idx" ON "communities"("owner_user_id") WHERE "deleted_at" IS NULL;
-- R2 — Discover reads only what it may list, so the index holds only that.
CREATE INDEX "communities_discover_idx" ON "communities"("sport_id", "last_activity_at" DESC, "id" DESC)
    WHERE "hidden_at" IS NULL AND "deleted_at" IS NULL AND ("visibility" = 'public' OR "discoverable");

ALTER TABLE "communities" ADD CONSTRAINT "communities_sport_id_fkey"
    FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "communities" ADD CONSTRAINT "communities_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "community_members" (
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "paid_until" TIMESTAMPTZ(6),
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_members_pkey" PRIMARY KEY ("community_id", "user_id")
);

ALTER TABLE "community_members" ADD CONSTRAINT "community_members_role_check"
    CHECK ("role" IN ('owner', 'admin', 'member'));
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_status_check"
    CHECK ("status" IN ('active', 'left', 'removed', 'expired'));

CREATE INDEX "community_members_user_idx" ON "community_members"("user_id", "status");
-- R5 — exactly one owner among the active members.
CREATE UNIQUE INDEX "community_members_one_owner_idx" ON "community_members"("community_id")
    WHERE "role" = 'owner' AND "status" = 'active';

ALTER TABLE "community_members" ADD CONSTRAINT "community_members_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "community_join_requests" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "approval_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_join_requests_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'joined'));
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_note_check"
    CHECK ("note" IS NULL OR char_length("note") <= 300);
-- R4 — an approval to pay always says until when.
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_approval_check"
    CHECK ("status" <> 'approved' OR "approval_expires_at" IS NOT NULL);

-- R4 — one open request (waiting, or approved and waiting for payment) per person.
CREATE UNIQUE INDEX "community_join_requests_one_open_idx" ON "community_join_requests"("community_id", "user_id")
    WHERE "status" IN ('pending', 'approved');
CREATE INDEX "community_join_requests_community_idx" ON "community_join_requests"("community_id", "status", "created_at");
CREATE INDEX "community_join_requests_user_idx" ON "community_join_requests"("user_id", "status");

ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_join_requests" ADD CONSTRAINT "community_join_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- R9 — the feed. Any member posts; admins pin and remove.
CREATE TABLE "community_posts" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "pinned_at" TIMESTAMPTZ(6),
    "hidden_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 2000);

CREATE INDEX "community_posts_feed_idx" ON "community_posts"("community_id", "created_at" DESC, "id" DESC)
    WHERE "deleted_at" IS NULL AND "hidden_at" IS NULL;

ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- R9 — the members' group chat. Soft delete: the body stays for moderation.
CREATE TABLE "community_messages" (
    "id" UUID NOT NULL,
    "community_id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 1000);

CREATE INDEX "community_messages_thread_idx" ON "community_messages"("community_id", "created_at" DESC, "id" DESC);

ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_community_id_fkey"
    FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
