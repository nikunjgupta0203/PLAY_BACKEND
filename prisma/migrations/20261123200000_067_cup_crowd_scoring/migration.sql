-- 067 — Cup crowd scoring (founder rules, 2026-11-23).
--
-- A right normal pick earns round(crowd_base × (1 − p)), where p is the crowd
-- share of the picked answer AT THE MOMENT OF THE PICK:
--   p = (picks on that answer + crowd_prior ÷ answers) ÷ (all picks + crowd_prior),
-- counting only active players' picks (the picker's own pick is not counted),
-- clamped to [crowd_min_pct, crowd_max_pct] %. Bold, early calls pay most.
-- Exact score stays a flat `points` (25; a third for the right result).
--
-- The settings live on the competition and are COPIED onto each question when
-- it is created, so a change mid-season only affects questions made after it.

ALTER TABLE "competitions"
    ADD COLUMN "crowd_base" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "crowd_prior" INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN "crowd_min_pct" SMALLINT NOT NULL DEFAULT 5,
    ADD COLUMN "crowd_max_pct" SMALLINT NOT NULL DEFAULT 95,
    -- A specialist title needs this many picks in the sport.
    ADD COLUMN "specialist_min_picks" INTEGER NOT NULL DEFAULT 10,
    ADD CONSTRAINT "competitions_crowd_base_check" CHECK ("crowd_base" BETWEEN 1 AND 500),
    ADD CONSTRAINT "competitions_crowd_prior_check" CHECK ("crowd_prior" BETWEEN 0 AND 1000),
    ADD CONSTRAINT "competitions_crowd_pct_check" CHECK ("crowd_min_pct" BETWEEN 1 AND 49 AND "crowd_max_pct" BETWEEN 51 AND 99),
    ADD CONSTRAINT "competitions_specialist_min_check" CHECK ("specialist_min_picks" BETWEEN 0 AND 500);

ALTER TABLE "competition_questions"
    ADD COLUMN "crowd_base" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "crowd_prior" INTEGER NOT NULL DEFAULT 10,
    ADD COLUMN "crowd_min_pct" SMALLINT NOT NULL DEFAULT 5,
    ADD COLUMN "crowd_max_pct" SMALLINT NOT NULL DEFAULT 95;

-- What the pick was worth when it was made: the locked crowd share and the
-- points (before any bonus multiplier) a right answer earns.
ALTER TABLE "competition_picks"
    ADD COLUMN "crowd_share" NUMERIC(5, 4),
    ADD COLUMN "base_points" INTEGER;
