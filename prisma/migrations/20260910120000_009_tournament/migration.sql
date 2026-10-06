-- 009 — tournament (docs/modules/09-tournament.md)
--
-- Draw generation with Championship AND Plate, court scheduling, advancement.
--
-- The load-bearing idea is in the four wiring columns on `matches`: every match
-- knows where its winner and its loser go BEFORE a single point is played
-- (R5). Confirming a result is then one write per side with no traversal of the
-- bracket, which is what makes advancement safe to serialise under a single
-- per-tournament advisory lock (R9) and safe to retry (R10).
--
-- A bye is stored as a REAL match row with one side null and status
-- 'walkover', so advancement has no special case (R3).

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_category_id" UUID NOT NULL,
    "draw_type" TEXT NOT NULL DEFAULT 'single_elim_with_plate',
    "bracket_size" SMALLINT NOT NULL,
    -- R5 — sized to the number of first-round losers, which is the number of
    -- round-1 matches that are a real contest rather than a bye.
    "plate_size" SMALLINT NOT NULL DEFAULT 0,
    "drawn_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "tournament_id" UUID NOT NULL,
    "event_category_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "bracket" TEXT NOT NULL,
    "round" SMALLINT NOT NULL,
    "slot" SMALLINT NOT NULL,
    "side_a_registration_id" UUID,
    "side_b_registration_id" UUID,
    -- Who came out of this match. `match_results` belongs to `scoring` (010)
    -- and records HOW it was won — the games, the outcome, who confirmed it.
    -- This column records THAT it was won, because the bracket needs it and a
    -- final has nowhere to advance a winner to: without it the champion of a
    -- draw is not derivable from the draw.
    "winner_registration_id" UUID,
    -- The wiring, generated at draw time in BOTH directions, so one write
    -- advances the winner and drops the loser into the plate (R5).
    "winner_match_id" UUID,
    "winner_slot" SMALLINT,
    "loser_match_id" UUID,
    "loser_slot" SMALLINT,
    "court_id" UUID,
    "scheduled_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    -- Denormalised; owned and written by `scoring` (010).
    "current_score" JSONB,
    "score_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "court_assignments" (
    "match_id" UUID NOT NULL,
    "court_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "assigned_by" TEXT NOT NULL,

    CONSTRAINT "court_assignments_pkey" PRIMARY KEY ("match_id")
);

-- CreateIndex
-- One draw per category. Generating twice is DRAW_ALREADY_GENERATED, and the
-- constraint is what makes that true under two simultaneous calls rather than
-- only in the read that precedes them.
CREATE UNIQUE INDEX "tournaments_event_category_id_key"
    ON "tournaments"("event_category_id");

CREATE INDEX "tournaments_event_id_idx" ON "tournaments"("event_id");

-- One match per position. The draw is generated in one transaction (R6), and
-- this is what makes a second, concurrent generation collide instead of
-- interleaving two half-brackets.
CREATE UNIQUE INDEX "matches_tournament_id_bracket_round_slot_key"
    ON "matches"("tournament_id", "bracket", "round", "slot");

-- The Live Mode read: what is on court right now in this draw.
CREATE INDEX "matches_live_idx" ON "matches"("event_category_id", "status", "scheduled_at");

-- Partial, because the query is partial: an unscheduled match is not on a court
-- and has no business in the index that answers "what is on this court".
CREATE INDEX "matches_court_idx" ON "matches"("court_id", "scheduled_at")
    WHERE "court_id" IS NOT NULL;

-- Advancement reads the wiring by TARGET — "what feeds this slot?" — which is
-- how a bye is told apart from a side that has simply not arrived yet.
CREATE INDEX "matches_winner_match_id_idx" ON "matches"("winner_match_id")
    WHERE "winner_match_id" IS NOT NULL;
CREATE INDEX "matches_loser_match_id_idx" ON "matches"("loser_match_id")
    WHERE "loser_match_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_event_category_id_fkey"
    FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_tournament_id_fkey"
    FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_event_category_id_fkey"
    FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_sport_id_fkey"
    FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_side_a_registration_id_fkey"
    FOREIGN KEY ("side_a_registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_side_b_registration_id_fkey"
    FOREIGN KEY ("side_b_registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_registration_id_fkey"
    FOREIGN KEY ("winner_registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_match_id_fkey"
    FOREIGN KEY ("winner_match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_loser_match_id_fkey"
    FOREIGN KEY ("loser_match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "matches" ADD CONSTRAINT "matches_court_id_fkey"
    FOREIGN KEY ("court_id") REFERENCES "venue_courts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "court_assignments" ADD CONSTRAINT "court_assignments_match_id_fkey"
    FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "court_assignments" ADD CONSTRAINT "court_assignments_court_id_fkey"
    FOREIGN KEY ("court_id") REFERENCES "venue_courts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Status as text + CHECK, never a Postgres enum (conventions.md §2): a state
-- machine that cannot be extended without a migration is a state machine that
-- will be extended by a boolean somewhere else.
ALTER TABLE "matches" ADD CONSTRAINT "matches_status_check"
    CHECK ("status" IN ('scheduled','ready','live','awaiting_confirm','completed','walkover','void'));

ALTER TABLE "matches" ADD CONSTRAINT "matches_bracket_check"
    CHECK ("bracket" IN ('championship','plate'));

ALTER TABLE "matches" ADD CONSTRAINT "matches_round_check" CHECK ("round" >= 1);
ALTER TABLE "matches" ADD CONSTRAINT "matches_slot_check" CHECK ("slot" >= 0);

-- A side is 0 or 1. There is no third side of a match, and a typo that writes
-- one should fail at the database rather than strand a player nowhere.
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_slot_check"
    CHECK ("winner_slot" IS NULL OR "winner_slot" IN (0,1));
ALTER TABLE "matches" ADD CONSTRAINT "matches_loser_slot_check"
    CHECK ("loser_slot" IS NULL OR "loser_slot" IN (0,1));

-- Wiring is a pair: a destination without a slot places a player nowhere, and a
-- slot without a destination is a column nobody reads.
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_wiring_check"
    CHECK (("winner_match_id" IS NULL) = ("winner_slot" IS NULL));
ALTER TABLE "matches" ADD CONSTRAINT "matches_loser_wiring_check"
    CHECK (("loser_match_id" IS NULL) = ("loser_slot" IS NULL));

-- The same entry cannot be on both sides of one match.
ALTER TABLE "matches" ADD CONSTRAINT "matches_distinct_sides_check"
    CHECK ("side_a_registration_id" IS NULL
        OR "side_b_registration_id" IS NULL
        OR "side_a_registration_id" <> "side_b_registration_id");

-- A winner is one of the two sides. Anything else is a bug that would put a
-- player who never entered into the next round.
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_is_a_side_check"
    CHECK ("winner_registration_id" IS NULL
        OR "winner_registration_id" = "side_a_registration_id"
        OR "winner_registration_id" = "side_b_registration_id");

-- A match cannot advance into itself. A cycle in the wiring is an infinite
-- advancement loop, and one CHECK is cheaper than discovering that at 11am on a
-- Saturday.
ALTER TABLE "matches" ADD CONSTRAINT "matches_no_self_wiring_check"
    CHECK ("winner_match_id" IS DISTINCT FROM "id" AND "loser_match_id" IS DISTINCT FROM "id");

-- R7 — a draw needs at least four entries, so the smallest bracket is four.
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_bracket_size_check"
    CHECK ("bracket_size" >= 4);

ALTER TABLE "court_assignments" ADD CONSTRAINT "court_assignments_assigned_by_check"
    CHECK ("assigned_by" IN ('scheduler','organizer'));

ALTER TABLE "court_assignments" ADD CONSTRAINT "court_assignments_window_check"
    CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

-- The booked window of an assignment: 45 minutes is the assumed length of a
-- match with no recorded end.
--
-- This exists as a function because an index expression must be IMMUTABLE and
-- `timestamptz + interval` is only STABLE — Postgres marks it so because an
-- interval carrying months or days lands on a different instant depending on
-- the session time zone. '45 minutes' carries neither, so the addition here
-- genuinely does not depend on any session state, and IMMUTABLE is the truth
-- rather than a promise we are hoping nobody checks.
--
-- The interval is duplicated in MATCH_MINUTES in the service. If one changes,
-- the other has to: a scheduler planning 30-minute slots against a constraint
-- that reserves 45 would propose times the database then rejects.
CREATE FUNCTION court_booking_window(starts_at timestamptz, ends_at timestamptz)
RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT tstzrange(starts_at, coalesce(ends_at, starts_at + interval '45 minutes'))
$$;

-- The whole point of the table. Two matches cannot occupy one court at the same
-- time, and the DATABASE guarantees it rather than the scheduler, because the
-- scheduler is not the only thing that writes here: R13 lets an organizer
-- reassign courts by hand all day.
ALTER TABLE "court_assignments" ADD CONSTRAINT "court_assignments_no_overlap"
    EXCLUDE USING gist (
        "court_id" WITH =,
        court_booking_window("starts_at", "ends_at") WITH &&
    );

-- The foreign key `rating_events` has been waiting for since 008 — exactly as
-- 005 added the one `event_staff` had been waiting for since 001.
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_match_id_fkey"
    FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
