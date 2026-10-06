-- 015 — onboarding_pending_sport_ids column (docs/modules/03-profile.md), R6
-- Track which sports still need a skill answer during onboarding.

ALTER TABLE "player_profiles" ADD COLUMN "onboarding_pending_sport_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
