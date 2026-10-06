-- 028 — heats (all-sports scoring, plans 7 and 8). A field contest — a race, a
-- lifting flight, a long jump, a judged routine, a battle-royale lobby, a
-- group of golfers, bowlers or archers — has many entrants, not two sides, so
-- it is scored as a heat rather than a match. Same guarantees as a match:
-- the score log is append-only and every write carries the expected seq.

CREATE TABLE "heats" (
    "id"                UUID PRIMARY KEY,
    "event_category_id" UUID NOT NULL REFERENCES "event_categories"("id") ON DELETE CASCADE,
    "name"              TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'live' CHECK ("status" IN ('live', 'closed')),
    "score_seq"         INTEGER NOT NULL DEFAULT 0,
    -- The whole field state (scoring R3), never a delta.
    "current_state"     JSONB NOT NULL,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "heats_event_category_id_idx" ON "heats" ("event_category_id");

CREATE TABLE "heat_entries" (
    "heat_id"         UUID NOT NULL REFERENCES "heats"("id") ON DELETE CASCADE,
    "registration_id" UUID NOT NULL REFERENCES "registrations"("id") ON DELETE CASCADE,
    -- Lane, bib, flight order or tee time: the organizer's running order.
    "position"        INTEGER NOT NULL,
    PRIMARY KEY ("heat_id", "registration_id")
);

CREATE TABLE "heat_score_events" (
    "id"          BIGSERIAL PRIMARY KEY,
    "heat_id"     UUID NOT NULL REFERENCES "heats"("id") ON DELETE CASCADE,
    "seq"         INTEGER NOT NULL CHECK ("seq" > 0),
    "event"       JSONB NOT NULL,
    "state_after" JSONB NOT NULL,
    "recorded_by" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    UNIQUE ("heat_id", "seq")
);

-- scoring R2 — append-only, like match_score_events.
CREATE FUNCTION heat_score_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'heat_score_events is append-only (scoring R2)';
END
$$;

CREATE TRIGGER heat_score_events_no_update
    BEFORE UPDATE ON "heat_score_events"
    FOR EACH ROW EXECUTE FUNCTION heat_score_events_append_only();
