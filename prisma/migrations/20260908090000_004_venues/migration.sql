-- 004 — venues (docs/modules/04-venues.md)
--
-- Where play happens. Deliberately thin: courts exist so a tournament can be
-- scheduled onto them, and so a player can find a place to play. No booking, no
-- inventory, no availability calendar — that is Phase 3.

-- CreateExtension
-- venues R1 — radius search rides a gist index on geography. Three modules
-- depend on this extension; ADR 0001 §C1 says verify it on Neon before Sprint 3.
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "geo" geography(Point, 4326) NOT NULL,
    "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "photo_public_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_courts" (
    "id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "surface" TEXT,
    "indoor" BOOLEAN NOT NULL DEFAULT false,
    "sport_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "venue_courts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- venues R1, R5 — both discovery indexes are PARTIAL on `deleted_at IS NULL`,
-- which Prisma cannot express. Discovery never reads a deleted venue, so a
-- deleted venue does not belong in the index it reads.
CREATE INDEX "venues_geo_idx" ON "venues" USING GIST ("geo") WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "venues_city_idx" ON "venues" ("city") WHERE "deleted_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "venue_courts_venue_id_name_key" ON "venue_courts" ("venue_id", "name");

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_courts" ADD CONSTRAINT "venue_courts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
