-- 011 — identity, Sprint 7 (docs/modules/01-identity.md R15, R16, R18)

-- identity R16 — organizer-derived grants live beside direct ones. A user may
-- hold one of each on the same event; `grantsFor` resolves to the higher role.
ALTER TABLE "event_staff"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'direct',
    -- The FK to organizer_profiles lands with the organizers migration.
    ADD COLUMN "organizer_profile_id" UUID;

ALTER TABLE "event_staff"
    ADD CONSTRAINT "event_staff_source_check" CHECK ("source" IN ('direct', 'organizer'));

-- An organizer row always names the organizer that produced it, and a direct
-- row never does. That is what lets a sync delete exactly its own rows.
ALTER TABLE "event_staff"
    ADD CONSTRAINT "event_staff_source_organizer_check"
    CHECK (("source" = 'organizer') = ("organizer_profile_id" IS NOT NULL));

ALTER TABLE "event_staff" DROP CONSTRAINT "event_staff_pkey";
ALTER TABLE "event_staff"
    ADD CONSTRAINT "event_staff_pkey" PRIMARY KEY ("event_id", "user_id", "source");

-- identity R18 — account deletion with a 30-day grace period.
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" TIMESTAMPTZ(6);

ALTER TABLE "users"
    ADD CONSTRAINT "users_status_check" CHECK ("status" IN ('active', 'suspended', 'deleted'));

-- What scrub-deleted-users reads, daily.
CREATE INDEX "users_deletion_due_idx"
    ON "users" ("deletion_requested_at") WHERE "status" = 'deleted';

-- identity R15 — platform roles. Read per request, never a JWT claim.
CREATE TABLE "platform_staff" (
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    -- Null only for the CLI bootstrap of the first admin.
    "granted_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_staff_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "platform_staff_role_check" CHECK ("role" IN ('admin', 'support', 'finance'))
);

ALTER TABLE "platform_staff"
    ADD CONSTRAINT "platform_staff_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "platform_staff"
    ADD CONSTRAINT "platform_staff_granted_by_fkey"
    FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
