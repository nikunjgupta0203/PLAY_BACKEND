-- 040 — indexes for reads that were scanning (speed review, 2026-10-08).
--
-- Postgres does not index a foreign key by itself. Each index below backs a
-- read the app makes on a common screen, or one the worker makes every few
-- hundred milliseconds. The tables are small today, so plain CREATE INDEX
-- (inside the migration's transaction) is quick.

-- The outbox drain claims unprocessed rows in id order four times a second.
-- Without this it reads the whole table, every row ever written, each time.
-- (docs/reference/schema.sql always listed a pending index; no migration made it.)
CREATE INDEX "outbox_pending_idx" ON "outbox" ("id") WHERE "processed_at" IS NULL;

-- Every registration read looks up its live seat hold by registration.
CREATE INDEX "seat_holds_registration_live_idx" ON "seat_holds" ("registration_id")
  WHERE "released_at" IS NULL;

-- An event's entries (organizer desk, check-in roster, contact visibility).
CREATE INDEX "registrations_event_id_idx" ON "registrations" ("event_id");
CREATE INDEX "registrations_team_id_idx" ON "registrations" ("team_id");
-- "My entries" finds team entries by member; the primary key leads with team_id.
CREATE INDEX "team_members_user_id_idx" ON "team_members" ("user_id");
CREATE INDEX "teams_event_category_id_idx" ON "teams" ("event_category_id");
CREATE INDEX "registration_invites_registration_id_idx" ON "registration_invites" ("registration_id");

-- A host's events (Hosting tab, events-hosted count on every event page) and a venue's.
CREATE INDEX "events_organizer_id_idx" ON "events" ("organizer_id");
CREATE INDEX "events_venue_id_idx" ON "events" ("venue_id");
-- Discover and Home match a city under any spelling: lower(btrim(city)) IN (...).
CREATE INDEX "events_city_norm_idx" ON "events" (lower(btrim("city")), "starts_at");

-- A player's matches, from either side of the draw.
CREATE INDEX "matches_side_a_registration_id_idx" ON "matches" ("side_a_registration_id");
CREATE INDEX "matches_side_b_registration_id_idx" ON "matches" ("side_b_registration_id");

CREATE INDEX "rankings_player_id_idx" ON "rankings" ("player_id");
