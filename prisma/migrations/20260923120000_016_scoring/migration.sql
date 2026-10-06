-- 016 — scoring (docs/modules/10-scoring.md).
--
-- The point log and the result record. `matches.current_score` and
-- `matches.score_seq` already exist (009) and are the denormalised head of the
-- log: they move in the same transaction as the event that moved them.

-- CreateTable
CREATE TABLE "match_score_events" (
    "id" BIGSERIAL NOT NULL,
    "match_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "scoring_side" TEXT,
    "state_after" JSONB NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_score_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_results" (
    "match_id" UUID NOT NULL,
    "winner_registration_id" UUID NOT NULL,
    "loser_registration_id" UUID,
    "games" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "submitted_by" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "disputed_by" UUID,
    "disputed_at" TIMESTAMPTZ(6),
    "dispute_reason" TEXT,
    "rating_applied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "match_results_pkey" PRIMARY KEY ("match_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "match_score_events_match_id_seq_key" ON "match_score_events"("match_id", "seq");

-- CreateIndex
CREATE INDEX "match_results_confirmed_at_idx" ON "match_results"("confirmed_at");

-- AddForeignKey
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_winner_registration_id_fkey" FOREIGN KEY ("winner_registration_id") REFERENCES "registrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_loser_registration_id_fkey" FOREIGN KEY ("loser_registration_id") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_disputed_by_fkey" FOREIGN KEY ("disputed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Status columns are text + CHECK (conventions.md §2): extending a CHECK is not
-- a migration on an enum type.
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_kind_check"
    CHECK ("kind" IN ('start', 'point', 'undo'));
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_side_check"
    CHECK (("kind" = 'point') = ("scoring_side" IS NOT NULL)
           AND ("scoring_side" IS NULL OR "scoring_side" IN ('a', 'b')));
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_seq_check"
    CHECK ("seq" > 0);

ALTER TABLE "match_results" ADD CONSTRAINT "match_results_outcome_check"
    CHECK ("outcome" IN ('played', 'walkover', 'retired', 'forfeit'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_sides_check"
    CHECK ("loser_registration_id" IS NULL OR "loser_registration_id" <> "winner_registration_id");
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_check"
    CHECK (("confirmed_at" IS NULL) = ("confirmed_by" IS NULL));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_disputed_check"
    CHECK (("disputed_at" IS NULL) = ("disputed_by" IS NULL));

-- R2 — the log is evidence. The service only ever INSERTs; this makes that a
-- property of the table rather than of the code, so a well-meaning backfill
-- script cannot rewrite a point somebody watched happen. TRUNCATE (tests) and
-- the cascade from a regenerated draw, which can only run before any match has
-- started (tournament R8), are unaffected: a draw with a point log is locked.
CREATE FUNCTION match_score_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'match_score_events is append-only (scoring R2)';
END
$$;

CREATE TRIGGER match_score_events_no_update
    BEFORE UPDATE ON "match_score_events"
    FOR EACH ROW EXECUTE FUNCTION match_score_events_append_only();
