-- 056 — Device sightings: every account a push token has been registered to
-- (docs/plans/2026-10-30-feature-brief.md, referral fraud checks).
--
-- `device_registrations` keeps one row per token and moves it to whoever signs
-- in last, so it cannot say that two accounts shared a phone. This table keeps
-- the history. Only a SHA-256 of the token is stored: it is compared, never
-- pushed to.

CREATE TABLE "device_sightings" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_sightings_pkey" PRIMARY KEY ("token_hash", "user_id")
);
CREATE INDEX "device_sightings_user_idx" ON "device_sightings"("user_id");

-- Today's registrations are the history we have.
INSERT INTO "device_sightings" ("token_hash", "user_id", "first_seen_at", "last_seen_at")
SELECT encode(sha256(convert_to("token", 'UTF8')), 'hex'), "user_id", "last_seen_at", "last_seen_at"
FROM "device_registrations"
ON CONFLICT DO NOTHING;
