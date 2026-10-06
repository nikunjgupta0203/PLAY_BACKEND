-- 005 — events (docs/modules/05-events.md)
--
-- The thing a player discovers, and the categories they actually register for.
-- Capacity, fee and format live on the CATEGORY, never the event, because one
-- tournament sells eight draws at eight prices.
--
-- This is the highest read-volume table in the system, which is why every
-- discovery index below is partial (events R6).

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "organizer_id" UUID NOT NULL,
    "venue_id" UUID,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "city" TEXT NOT NULL,
    "geo" geography(Point, 4326),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "registration_closes_at" TIMESTAMPTZ(6) NOT NULL,
    "cancellation_cutoff_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "cover_public_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_categories" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "team_size" SMALLINT NOT NULL DEFAULT 1,
    "draw_type" TEXT NOT NULL DEFAULT 'single_elim_with_plate',
    "skill_min" DECIMAL(4,2),
    "skill_max" DECIMAL(4,2),
    "age_min" SMALLINT,
    "age_max" SMALLINT,
    "capacity" INTEGER NOT NULL,
    "min_entries" SMALLINT NOT NULL DEFAULT 4,
    "entry_fee_paise" BIGINT NOT NULL,
    "platform_fee_paise" BIGINT NOT NULL DEFAULT 0,
    "tax_bps" INTEGER NOT NULL DEFAULT 1800,
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "event_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_media" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "event_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_slug_key" ON "events" ("slug");

-- CreateIndex
-- events R6 — THE Explore query. Partial on the two statuses discovery reads:
-- an unlisted event should not cost anything to skip. Prisma cannot express the
-- WHERE clause, so the model declares the plain index and this is the truth.
CREATE INDEX "events_sport_id_city_starts_at_idx" ON "events" ("sport_id", "city", "starts_at")
    WHERE "status" IN ('published', 'live');

-- CreateIndex
CREATE INDEX "events_geo_idx" ON "events" USING GIST ("geo")
    WHERE "status" IN ('published', 'live');

-- CreateIndex
CREATE INDEX "event_categories_event_id_idx" ON "event_categories" ("event_id");

-- CreateIndex
CREATE INDEX "event_media_event_id_idx" ON "event_media" ("event_id");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_media" ADD CONSTRAINT "event_media_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- The FK 001 deferred: `event_staff` was created before `events` existed, and a
-- grant that outlives its event is a permission with nothing to point at.
ALTER TABLE "event_staff" ADD CONSTRAINT "event_staff_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- events lifecycle, as text + CHECK so a sixth state is a data change rather
-- than a migration (conventions.md §2).
ALTER TABLE "events"
    ADD CONSTRAINT "events_status_check"
    CHECK ("status" IN ('draft', 'published', 'live', 'completed', 'cancelled'));

ALTER TABLE "event_categories"
    ADD CONSTRAINT "event_categories_status_check"
    CHECK ("status" IN ('open', 'full', 'closed', 'drawn', 'completed', 'cancelled'));

-- A zero-capacity draw is a draw nobody can enter. The service refuses it too;
-- the service is not the only thing that will ever write this table.
ALTER TABLE "event_categories"
    ADD CONSTRAINT "event_categories_capacity_check" CHECK ("capacity" > 0);

ALTER TABLE "event_media"
    ADD CONSTRAINT "event_media_kind_check"
    CHECK ("kind" IN ('cover', 'gallery', 'sponsor'));
