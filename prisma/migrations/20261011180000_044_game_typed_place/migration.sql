-- 044 — a game's place may be typed.
--
-- The map is out of the app for now, so a game that is not at a listed venue
-- is at a place the host names ("Law Garden courts, Ahmedabad"). The pin
-- (`geo`) stays for games that have one and is no longer required.
ALTER TABLE "games" DROP CONSTRAINT "games_place_check";
ALTER TABLE "games"
    ADD CONSTRAINT "games_place_check"
    CHECK ("venue_id" IS NOT NULL OR "place_name" IS NOT NULL);
