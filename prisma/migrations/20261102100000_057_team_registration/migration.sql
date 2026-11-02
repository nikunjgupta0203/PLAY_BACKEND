-- 057 — Team registration: pay first, invite after; per-player check-in;
-- replacements; a history of every roster change (docs/modules/06-registration.md R21–R27).

-- R21 — how a team draw takes entries. All of these default to what the app
-- did before this migration, so existing draws behave exactly as they did.
ALTER TABLE "event_categories"
    -- true: the captain pays for the team first and invites teammates after.
    -- false: every teammate accepts before anyone pays (R2, the old flow).
    ADD COLUMN "teammates_after_payment" BOOLEAN NOT NULL DEFAULT false,
    -- optional | required
    ADD COLUMN "team_name_rule" TEXT NOT NULL DEFAULT 'optional',
    -- How the host typed the fee. The stored entry fee is ALWAYS the whole
    -- entry's price; 'player' only changes how it is labelled (fee ÷ team size).
    ADD COLUMN "fee_basis" TEXT NOT NULL DEFAULT 'team',
    -- Null = the format's team size. A team is complete at min, and can never exceed max.
    ADD COLUMN "min_team_size" SMALLINT,
    ADD COLUMN "max_team_size" SMALLINT,
    -- Null = until the event starts.
    ADD COLUMN "invite_deadline_at" TIMESTAMPTZ(6),
    ADD COLUMN "roster_lock_at" TIMESTAMPTZ(6),
    ADD COLUMN "allow_replacements" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "waitlist_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "event_categories"
    ADD CONSTRAINT "event_categories_team_name_rule_check" CHECK ("team_name_rule" IN ('optional', 'required')),
    ADD CONSTRAINT "event_categories_fee_basis_check" CHECK ("fee_basis" IN ('team', 'player')),
    ADD CONSTRAINT "event_categories_team_sizes_check" CHECK (
        ("min_team_size" IS NULL OR "min_team_size" >= 1)
        AND ("max_team_size" IS NULL OR "max_team_size" <= 30)
        AND ("min_team_size" IS NULL OR "max_team_size" IS NULL OR "min_team_size" <= "max_team_size")
    );

-- R22 — a shareable link is not addressed to anybody: no email, no account.
ALTER TABLE "registration_invites" ALTER COLUMN "invited_email" DROP NOT NULL;
-- R25 — accepting this invite takes this member's place on the team.
ALTER TABLE "registration_invites"
    ADD COLUMN "replaces_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    ADD COLUMN "last_sent_at" TIMESTAMPTZ(6),
    ADD COLUMN "sent_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "registration_invites" DROP CONSTRAINT "registration_invites_status_check";
ALTER TABLE "registration_invites"
    ADD CONSTRAINT "registration_invites_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'declined', 'expired', 'revoked'));
CREATE INDEX "registration_invites_invited_user_pending_idx"
    ON "registration_invites" ("invited_user_id") WHERE "status" = 'pending';

-- R24 — each player on an entry is checked in on their own; one row each, so a
-- second scan cannot check the same player in twice.
CREATE TABLE "registration_checkins" (
    "registration_id" UUID NOT NULL REFERENCES "registrations"("id") ON DELETE CASCADE,
    "user_id" UUID NOT NULL REFERENCES "users"("id"),
    "checked_in_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_in_by" UUID REFERENCES "users"("id"),
    -- self | staff | qr
    "method" TEXT NOT NULL,
    CONSTRAINT "registration_checkins_pkey" PRIMARY KEY ("registration_id", "user_id")
);

-- Entries checked in before this table existed: everyone on them arrived.
INSERT INTO "registration_checkins" ("registration_id", "user_id", "checked_in_at", "checked_in_by", "method")
SELECT r."id", coalesce(m."user_id", r."captain_user_id"), coalesce(r."checked_in_at", now()), r."checked_in_by", 'staff'
  FROM "registrations" r
  LEFT JOIN "team_members" m ON m."team_id" = r."team_id"
 WHERE r."status" = 'checked_in'
ON CONFLICT DO NOTHING;

-- R26 — every change to an entry's team, and every manual change by staff,
-- with who made it, when, and why.
CREATE TABLE "registration_history" (
    "id" UUID NOT NULL,
    "registration_id" UUID NOT NULL REFERENCES "registrations"("id") ON DELETE CASCADE,
    "kind" TEXT NOT NULL,
    "actor_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "subject_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
    "reason" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "registration_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "registration_history_registration_idx" ON "registration_history" ("registration_id", "created_at");
