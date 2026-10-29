-- 053 — every match is ranked (founder's v1.0 issue list, items 1–4).
--
-- 1. A casual game's results now feed rating, rankings, match history and
--    analytics like a tournament match. A rating row may therefore name a
--    game result instead of a tournament match, so `rating_events.match_id`
--    loses its foreign key to `matches` (player_match_history never had one).
-- 2. A casual game carries the format its players chose: the points a game is
--    played to and how many games (best of N, or exactly N). A result keeps
--    the format it was entered under. Null = the sport's usual format.
-- 3. A casual match can end level, so match history records a draw rather
--    than calling it a loss.
ALTER TABLE "rating_events" DROP CONSTRAINT IF EXISTS "rating_events_match_id_fkey";

ALTER TABLE "games" ADD COLUMN "match_format" JSONB;
ALTER TABLE "game_results" ADD COLUMN "match_format" JSONB;

ALTER TABLE "player_match_history" ADD COLUMN "drawn" BOOLEAN NOT NULL DEFAULT false;

-- The rating port reads a week's confirmed casual results per sport.
CREATE INDEX "game_results_sport_confirmed_idx" ON "game_results"("sport_id", "confirmed_at");
