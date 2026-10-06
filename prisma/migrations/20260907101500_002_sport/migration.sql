-- 002 — sport (docs/modules/02-sport.md)
--
-- The registry that makes multi-sport real rather than aspirational. Every row
-- here is seed data under version control (sport R1); there are no runtime
-- writes in Phase 1. A second sport is an INSERT, not a code change.

-- CreateTable
CREATE TABLE "sports" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "sports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "formats" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "team_size" SMALLINT NOT NULL,

    CONSTRAINT "formats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_bands" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "lower_bound" DECIMAL(4,2),
    "upper_bound" DECIMAL(4,2),
    "sort_order" SMALLINT NOT NULL,

    CONSTRAINT "skill_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scoring_rules" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "format_id" UUID,
    "rule" JSONB NOT NULL,

    CONSTRAINT "scoring_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sports_slug_key" ON "sports"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "formats_sport_id_key_key" ON "formats"("sport_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "skill_bands_sport_id_key_key" ON "skill_bands"("sport_id", "key");

-- CreateIndex
-- NULLS NOT DISTINCT (PG15+) is the point: format_id IS NULL means "the default
-- rule for this sport", and two defaults is a seed bug that would otherwise
-- surface much later as an arbitrary scoringRuleFor() answer.
CREATE UNIQUE INDEX "scoring_rules_sport_id_format_id_key"
    ON "scoring_rules"("sport_id", "format_id") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "formats" ADD CONSTRAINT "formats_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_bands" ADD CONSTRAINT "skill_bands_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_format_id_fkey" FOREIGN KEY ("format_id") REFERENCES "formats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints — text + CHECK, never a Postgres enum (conventions.md §2).
ALTER TABLE "formats"
    ADD CONSTRAINT "formats_team_size_check" CHECK ("team_size" > 0);

ALTER TABLE "skill_bands"
    ADD CONSTRAINT "skill_bands_bounds_check"
    CHECK ("lower_bound" IS NULL OR "upper_bound" IS NULL OR "lower_bound" <= "upper_bound");
