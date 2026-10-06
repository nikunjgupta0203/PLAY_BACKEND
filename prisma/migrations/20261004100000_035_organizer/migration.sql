-- 035 — the in-app organizer section and the fixes from the 2026-10-04 flow
-- review (docs/platform-flow-review-2026-10-04.md, F1–F27).

-- F3 — a player can report an event that did not happen as promised. An open
-- report holds the host's payout until PL4Y staff settle it.
CREATE TABLE "event_reports" (
    "id"               UUID         NOT NULL,
    "event_id"         UUID         NOT NULL,
    "reporter_user_id" UUID         NOT NULL,
    "reason"           TEXT         NOT NULL,
    "details"          TEXT,
    "status"           TEXT         NOT NULL DEFAULT 'open',
    "resolution_note"  TEXT,
    "resolved_by"      UUID,
    "resolved_at"      TIMESTAMPTZ(6),
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "event_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_reports_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
    CONSTRAINT "event_reports_reporter_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id"),
    CONSTRAINT "event_reports_resolver_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "event_reports_status_check" CHECK ("status" IN ('open', 'resolved', 'dismissed')),
    CONSTRAINT "event_reports_reason_check" CHECK ("reason" IN ('did_not_happen', 'different_from_listing', 'unfair_results', 'host_conduct', 'other'))
);
CREATE INDEX "event_reports_event_idx" ON "event_reports" ("event_id", "status");
-- One open report per player per event: a second tap adds nothing.
CREATE UNIQUE INDEX "event_reports_one_open_idx" ON "event_reports" ("event_id", "reporter_user_id") WHERE "status" = 'open';

-- F3 — staff released a payout held for review; automatic review holds stop
-- applying unless a report arrives after this.
ALTER TABLE "payouts" ADD COLUMN "review_cleared_at" TIMESTAMPTZ(6);
-- F27 — on an event the host cancelled, the gateway's fees on its refunded
-- payments come out of the host's next payout (frozen with the rest of the quote).
ALTER TABLE "payouts" ADD COLUMN "gateway_fees_paise" BIGINT NOT NULL DEFAULT 0;

-- F18 — when the venue or dates changed after people entered. Entrants may
-- withdraw with a full refund for 48 hours after it.
ALTER TABLE "events" ADD COLUMN "terms_changed_at" TIMESTAMPTZ(6);

-- F27 — the host's refund policy. standard: full refund until the cutoff,
-- nothing after. flexible: full until the cutoff, half until the start.
ALTER TABLE "events" ADD COLUMN "refund_policy" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "events" ADD CONSTRAINT "events_refund_policy_check" CHECK ("refund_policy" IN ('standard', 'flexible'));

-- F14 — how long a match in this draw takes (the scheduler's slot). Null = 45.
ALTER TABLE "event_categories" ADD COLUMN "match_minutes" SMALLINT;
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_match_minutes_check"
    CHECK ("match_minutes" IS NULL OR "match_minutes" BETWEEN 5 AND 480);
-- F23 — a knockout without a Plate may add a match for third place.
ALTER TABLE "event_categories" ADD COLUMN "third_place" BOOLEAN NOT NULL DEFAULT false;
-- F24 — what the draw is played for, and the host's own format notes.
ALTER TABLE "event_categories" ADD COLUMN "prizes" TEXT;
ALTER TABLE "event_categories" ADD COLUMN "rules_note" TEXT;
-- F21, F22 — the scoring rule this draw is played under, frozen when it is set
-- (a host's chosen format) or at publish (the sport's default then).
ALTER TABLE "event_categories" ADD COLUMN "scoring_rule" JSONB;
-- F12 — the host was warned this draw is short of its minimum.
ALTER TABLE "event_categories" ADD COLUMN "short_warned_at" TIMESTAMPTZ(6);

-- F23 — a plain knockout, no Plate.
ALTER TABLE "event_categories" DROP CONSTRAINT "event_categories_draw_type_check";
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_draw_type_check"
    CHECK ("draw_type" IN ('single_elim_with_plate', 'single_elim', 'league', 'groups_knockout'));
ALTER TABLE "tournaments" DROP CONSTRAINT "tournaments_draw_type_check";
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_draw_type_check"
    CHECK ("draw_type" IN ('single_elim_with_plate', 'single_elim', 'league', 'groups_knockout'));
ALTER TABLE "matches" DROP CONSTRAINT "matches_bracket_check";
ALTER TABLE "matches" ADD CONSTRAINT "matches_bracket_check"
    CHECK ("bracket" IN ('championship', 'plate', 'league', 'group', 'third_place'));

-- F14 — courts the host declares for their own event ("Court 1, Court 2 at
-- the park"). A court belongs to a venue OR to one event, never both.
ALTER TABLE "venue_courts" ALTER COLUMN "venue_id" DROP NOT NULL;
ALTER TABLE "venue_courts" ADD COLUMN "event_id" UUID;
ALTER TABLE "venue_courts" ADD CONSTRAINT "venue_courts_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE;
ALTER TABLE "venue_courts" ADD CONSTRAINT "venue_courts_owner_check"
    CHECK (("venue_id" IS NULL) <> ("event_id" IS NULL));
CREATE UNIQUE INDEX "venue_courts_event_id_name_key" ON "venue_courts" ("event_id", "name") WHERE "event_id" IS NOT NULL;

-- F20 — a walk-in with no PL4Y account. A guest is a user row that can never
-- sign in (its address is not deliverable) and is never emailed.
ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;

-- F27 — what the gateway kept on a captured payment, and the ledger row for it.
ALTER TABLE "payments" ADD COLUMN "fee_paise" BIGINT;
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind_check";
ALTER TABLE "ledger_entries"
    ADD CONSTRAINT "ledger_entries_kind_check"
    CHECK ("kind" IN (
        'charge', 'platform_fee', 'tax', 'refund', 'fee_reversal', 'tax_reversal',
        'host_commission', 'commission_tax', 'tds_withheld', 'host_payout',
        'host_receivable', 'receivable_recovered', 'gateway_fee'
    ));
