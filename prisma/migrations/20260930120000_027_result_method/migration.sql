-- 027 — how a match was won (all-sports scoring, plan 3). The scoreline says
-- who won; method and margin say how: a shootout 4–3 today, later a knockout
-- in round 2 or a win by 23 runs. Null for a win in normal play.

ALTER TABLE "match_results" ADD COLUMN "method" TEXT;
ALTER TABLE "match_results" ADD COLUMN "margin" TEXT;

ALTER TABLE "match_results" ADD CONSTRAINT "match_results_method_check"
  CHECK ("method" IS NULL OR "method" ~ '^[a-z][a-z_]*$');
-- A margin only ever qualifies a method.
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_margin_check"
  CHECK ("margin" IS NULL OR "method" IS NOT NULL);
