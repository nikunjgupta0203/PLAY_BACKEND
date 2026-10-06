-- 036 — the admin portal and organisations (PLAY_FRONTEND/docs/modules/25-admin-portal.md,
-- 26-hosting-tab.md, 27-organisations.md).

-- ── portal R3 — every staff action, who did it, and the reason they gave ─────
CREATE TABLE "audit_log" (
    "id"            UUID PRIMARY KEY,
    "actor_user_id" UUID NOT NULL REFERENCES "users"("id"),
    "action"        TEXT NOT NULL,
    "target_type"   TEXT NOT NULL,
    "target_id"     TEXT NOT NULL,
    "reason"        TEXT,
    "details"       JSONB NOT NULL DEFAULT '{}',
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "audit_log_created_at_idx" ON "audit_log" ("created_at" DESC);
CREATE INDEX "audit_log_target_idx" ON "audit_log" ("target_type", "target_id", "created_at" DESC);

-- ── org — an owner (or member) invited by email before they have an account ─
CREATE TABLE "organisation_invites" (
    "id"                   UUID PRIMARY KEY,
    "organizer_profile_id" UUID NOT NULL REFERENCES "organizer_profiles"("id") ON DELETE CASCADE,
    "email"                CITEXT NOT NULL,
    "role"                 TEXT NOT NULL CHECK ("role" IN ('owner', 'admin', 'member')),
    "invited_by"           UUID NOT NULL REFERENCES "users"("id"),
    "expires_at"           TIMESTAMPTZ(6) NOT NULL,
    "claimed_at"           TIMESTAMPTZ(6),
    "claimed_by"           UUID REFERENCES "users"("id"),
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Read on every sign-in: only the open ones matter.
CREATE INDEX "organisation_invites_open_email_idx" ON "organisation_invites" ("email")
    WHERE "claimed_at" IS NULL;

-- ── portal R6 — a session belongs to the app or to the portal, never both ───
ALTER TABLE "refresh_tokens"
    ADD COLUMN "client" TEXT NOT NULL DEFAULT 'app' CHECK ("client" IN ('app', 'portal'));

-- ── org R6 — an organisation is paid into its own account ────────────────────
-- A person keeps one personal account; an organisation has one of its own,
-- saved by its owner (user_id), who is told about it.
ALTER TABLE "payout_accounts"
    ADD COLUMN "organizer_profile_id" UUID REFERENCES "organizer_profiles"("id");

ALTER TABLE "payout_accounts" DROP CONSTRAINT "payout_accounts_user_id_key";

CREATE UNIQUE INDEX "payout_accounts_personal_user_key" ON "payout_accounts" ("user_id")
    WHERE "organizer_profile_id" IS NULL;
CREATE UNIQUE INDEX "payout_accounts_organisation_key" ON "payout_accounts" ("organizer_profile_id")
    WHERE "organizer_profile_id" IS NOT NULL;
