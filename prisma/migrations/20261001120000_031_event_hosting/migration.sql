-- 031 — players host events. A contact number for entrants, a note on where
-- exactly to go, proof the host accepted the hosting terms, and the platform's
-- commission frozen onto each category at the rate it was sold under.

ALTER TABLE "events" ADD COLUMN "contact_phone" TEXT;
ALTER TABLE "events" ADD COLUMN "location_note" TEXT;
ALTER TABLE "events" ADD COLUMN "host_terms_accepted_at" TIMESTAMPTZ(6);

ALTER TABLE "event_categories" ADD COLUMN "commission_bps" INTEGER NOT NULL DEFAULT 0
  CHECK ("commission_bps" BETWEEN 0 AND 10000);
