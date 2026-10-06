-- 017 — notifications (docs/modules/11-notifications.md).
--
-- The feed, the devices it pushes to, and what each player has muted. Nothing
-- here references another module's tables but `users`: the module is handed a
-- user id, a template key and a payload, and depends on nobody.

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "target_kind" TEXT,
    "target_id" TEXT,
    "target_route" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_registrations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "push_enabled" BOOLEAN NOT NULL DEFAULT true,
    "muted" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quiet_hours" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- The feed reads newest first per user, with the id as the cursor tiebreak.
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "notifications"("user_id", "created_at" DESC, "id" DESC);

-- The badge (R9 on the client) is a count of this, per user, on every cold start.
CREATE INDEX "notifications_unread_idx" ON "notifications"("user_id") WHERE "read_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "device_registrations_token_key" ON "device_registrations"("token");

-- CreateIndex
CREATE INDEX "device_registrations_user_id_idx" ON "device_registrations"("user_id");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_check"
    CHECK ("target_kind" IS NULL
           OR "target_kind" IN ('event', 'match', 'player', 'venue', 'game', 'community', 'route'));

-- R10 — a route target names a route and nothing else; an entity target names an id.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_route_check"
    CHECK (("target_kind" = 'route') = ("target_route" IS NOT NULL));

ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_platform_check"
    CHECK ("platform" IN ('ios', 'android', 'web'));
