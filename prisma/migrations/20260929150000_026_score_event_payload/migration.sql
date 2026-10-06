-- 026 — typed score events (all-sports scoring, plan 1). The event is kept next
-- to the complete state it produced (scoring R3): the state is the truth, the
-- event is what happened, for the timeline and for player stats later.

ALTER TABLE "match_score_events" ADD COLUMN "event" JSONB;

ALTER TABLE "match_score_events" DROP CONSTRAINT "match_score_events_kind_check";
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_kind_check"
  CHECK ("kind" IN ('start', 'point', 'undo', 'event'));

-- 016 tied scoring_side to kind = 'point'. An event names its side when it has
-- one (a score, a kick) and not otherwise (period_end).
ALTER TABLE "match_score_events" DROP CONSTRAINT "match_score_events_side_check";
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_side_check"
  CHECK ((("kind" = 'point' AND "scoring_side" IS NOT NULL)
      OR ("kind" = 'event')
      OR ("kind" IN ('start', 'undo') AND "scoring_side" IS NULL))
     AND ("scoring_side" IS NULL OR "scoring_side" IN ('a', 'b')));

ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_event_check"
  CHECK (("kind" = 'event') = ("event" IS NOT NULL));
