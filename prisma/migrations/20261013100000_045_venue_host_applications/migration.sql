-- 045 — venue host applications.
--
-- A player asks to list their venue from Home. The row waits for PL4Y staff in
-- the portal; approving it creates the venue with the applicant as its owner.
-- The bank details are the applicant's payout account (`payout_accounts`), so
-- the PAN and account number stay sealed in one place and are not copied here.
CREATE TABLE "venue_host_applications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "venue_name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "sport_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "court_count" SMALLINT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "status_reason" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "venue_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "venue_host_applications_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_status_check"
    CHECK ("status" IN ('pending', 'approved', 'rejected'));

ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_court_count_check"
    CHECK ("court_count" BETWEEN 1 AND 50);

-- The map point is optional (the applicant may not be at the venue); staff give one when approving.
ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_point_check"
    CHECK (("lat" IS NULL) = ("lng" IS NULL));

-- An approved application names the venue it became.
ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_venue_check"
    CHECK ("venue_id" IS NULL OR "status" = 'approved');

CREATE INDEX "venue_host_applications_status_created_at_idx"
    ON "venue_host_applications"("status", "created_at");

CREATE INDEX "venue_host_applications_user_id_created_at_idx"
    ON "venue_host_applications"("user_id", "created_at" DESC);

-- One open application per person: a second submit while the first waits is refused.
CREATE UNIQUE INDEX "venue_host_applications_one_pending_idx"
    ON "venue_host_applications"("user_id") WHERE "status" = 'pending';

ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
