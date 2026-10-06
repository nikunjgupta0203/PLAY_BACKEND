-- 019 — result finality (docs/superpowers/specs/2026-09-27-result-finality-design.md).
--
-- scoring R11–R14: how a result was entered, when it confirms itself, how it was
-- confirmed, and the stamps that keep the sweep's reminders and alerts once-only.

ALTER TABLE "match_results"
    ADD COLUMN "source" TEXT,
    ADD COLUMN "submitter_role" TEXT,
    ADD COLUMN "auto_confirm_at" TIMESTAMPTZ(6),
    ADD COLUMN "confirmed_via" TEXT,
    ADD COLUMN "reminded_at" TIMESTAMPTZ(6),
    ADD COLUMN "staff_alerted_at" TIMESTAMPTZ(6);

-- Backfill (pre-launch rows only). A played result on a match whose point log
-- ended the match came from the log; anything else was typed. Nobody knows who
-- submitted as what, so every existing row is a player's, and every existing
-- confirmation the opponent's. Existing pending rows keep auto_confirm_at NULL:
-- they stay on the paths they were submitted under.
UPDATE "match_results" r
   SET "source" = CASE
         WHEN r."outcome" = 'played' AND m."current_score"->>'matchOver' = 'true' THEN 'live'
         ELSE 'typed'
       END
  FROM "matches" m
 WHERE m."id" = r."match_id";
UPDATE "match_results" SET "submitter_role" = 'player';
UPDATE "match_results" SET "confirmed_via" = 'opponent' WHERE "confirmed_at" IS NOT NULL;

ALTER TABLE "match_results"
    ALTER COLUMN "source" SET NOT NULL,
    ALTER COLUMN "submitter_role" SET NOT NULL;

ALTER TABLE "match_results" ADD CONSTRAINT "match_results_source_check"
    CHECK ("source" IN ('live', 'typed'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_submitter_role_check"
    CHECK ("submitter_role" IN ('player', 'staff'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_via_check"
    CHECK ("confirmed_via" IS NULL OR "confirmed_via" IN ('opponent', 'staff', 'auto'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_via_pair_check"
    CHECK (("confirmed_at" IS NULL) = ("confirmed_via" IS NULL));

-- 016 required a confirmer on every confirmation. The sweep (R11) confirms as
-- nobody: `confirmed_by` is empty exactly when the system confirmed it.
ALTER TABLE "match_results" DROP CONSTRAINT "match_results_confirmed_check";
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_check"
    CHECK (
        ("confirmed_at" IS NULL AND "confirmed_by" IS NULL)
     OR ("confirmed_at" IS NOT NULL AND ("confirmed_by" IS NULL) = ("confirmed_via" = 'auto'))
    );

-- The sweep reads only what is still waiting (R11, R13, R14).
CREATE INDEX "match_results_pending_idx" ON "match_results" ("submitted_at")
    WHERE "confirmed_at" IS NULL AND "disputed_at" IS NULL;
