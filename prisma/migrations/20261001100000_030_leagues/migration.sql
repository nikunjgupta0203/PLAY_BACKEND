-- 030 — leagues and group stages. A category may now be drawn as a league
-- (everyone plays everyone; a table decides) or as groups then a knockout.
-- A league or group match may end level, so a confirmed result may have no
-- winner: a draw.

-- The draw types the system can generate.
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_draw_type_check"
    CHECK ("draw_type" IN ('single_elim_with_plate', 'league', 'groups_knockout'));
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_draw_type_check"
    CHECK ("draw_type" IN ('single_elim_with_plate', 'league', 'groups_knockout'));

-- League matches, and group matches with the group they belong to. A group
-- stage numbers its slots across all groups within a matchday, so the
-- (tournament, bracket, round, slot) key still holds.
ALTER TABLE "matches" DROP CONSTRAINT "matches_bracket_check";
ALTER TABLE "matches" ADD CONSTRAINT "matches_bracket_check"
    CHECK ("bracket" IN ('championship', 'plate', 'league', 'group'));
ALTER TABLE "matches" ADD COLUMN "group_no" SMALLINT;
ALTER TABLE "matches" ADD CONSTRAINT "matches_group_no_check"
    CHECK (("bracket" = 'group') = ("group_no" IS NOT NULL) AND ("group_no" IS NULL OR "group_no" >= 1));

-- What a table counts: the scoreline's totals (goals, runs, points over every
-- set), written with the result. Null until then, and for a walkover.
ALTER TABLE "matches" ADD COLUMN "tally_a" INTEGER;
ALTER TABLE "matches" ADD COLUMN "tally_b" INTEGER;

-- A draw: a played result with neither a winner nor a loser.
ALTER TABLE "match_results" ALTER COLUMN "winner_registration_id" DROP NOT NULL;
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_draw_check"
    CHECK ("winner_registration_id" IS NOT NULL
        OR ("outcome" = 'played' AND "loser_registration_id" IS NULL));

-- A league's "size" is its entry count, and a league of three is a league.
ALTER TABLE "tournaments" DROP CONSTRAINT "tournaments_bracket_size_check";
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_bracket_size_check"
    CHECK ("bracket_size" >= 4 OR ("draw_type" = 'league' AND "bracket_size" >= 3));
