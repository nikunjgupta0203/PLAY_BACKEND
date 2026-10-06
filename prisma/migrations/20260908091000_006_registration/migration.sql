-- 006 — registration (docs/modules/06-registration.md)
--
-- The highest-risk module in the system. Read the two indexes at the bottom
-- before anything else: the unique partial index on `registrations` IS rule R1,
-- and the partial index on `seat_holds` is what makes the FOR UPDATE capacity
-- query in R4 cheap enough to hold a lock for.
--
-- Correctness lives here rather than in Redis. A lost key in a cache means an
-- oversold tournament with physical courts and players who travelled.

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "event_category_id" UUID NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "is_captain" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id","user_id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_category_id" UUID NOT NULL,
    "sport_id" UUID NOT NULL,
    "captain_user_id" UUID NOT NULL,
    "team_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "seed" INTEGER,
    "amount_paise" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_invites" (
    "id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "invited_email" CITEXT NOT NULL,
    "invited_user_id" UUID,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_holds" (
    "id" UUID NOT NULL,
    "event_category_id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "seats" SMALLINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "seat_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registrations_event_category_id_status_idx" ON "registrations" ("event_category_id", "status");

-- CreateIndex
CREATE INDEX "registrations_captain_user_id_idx" ON "registrations" ("captain_user_id");

-- CreateIndex
-- registration R1 — a player holds at most one LIVE entry per category, and it
-- is a constraint rather than a read-then-write check, because two concurrent
-- taps on a slow network are the normal case and not the edge case.
--
-- The status list is exactly the live states: a withdrawn or expired entry must
-- not block the player from trying again.
CREATE UNIQUE INDEX "reg_one_live_per_player"
    ON "registrations" ("event_category_id", "captain_user_id")
    WHERE "status" IN ('awaiting_partner', 'payment_pending', 'confirmed', 'checked_in');

-- CreateIndex
CREATE UNIQUE INDEX "registration_invites_token_key" ON "registration_invites" ("token");

-- CreateIndex
CREATE INDEX "registration_invites_invited_email_idx"
    ON "registration_invites" ("invited_email") WHERE "status" = 'pending';

-- CreateIndex
-- registration R4, R5 — the capacity query counts holds under a FOR UPDATE on
-- the category row. A released hold is never counted, so it does not belong in
-- the index that counts.
CREATE INDEX "seat_holds_active_idx" ON "seat_holds" ("event_category_id")
    WHERE "released_at" IS NULL;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_event_category_id_fkey" FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_event_category_id_fkey" FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "sports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_captain_user_id_fkey" FOREIGN KEY ("captain_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_holds" ADD CONSTRAINT "seat_holds_event_category_id_fkey" FOREIGN KEY ("event_category_id") REFERENCES "event_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_holds" ADD CONSTRAINT "seat_holds_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- registration R11 — the state machine, as text + CHECK. The guard function in
-- the service decides which transitions are legal; this decides which states
-- exist at all, and it is the backstop for anything that ever writes this table
-- without going through the guard.
ALTER TABLE "registrations"
    ADD CONSTRAINT "registrations_status_check"
    CHECK ("status" IN (
      'draft', 'awaiting_partner', 'payment_pending', 'confirmed',
      'checked_in', 'withdrawn', 'expired', 'payment_failed', 'refunded'));

ALTER TABLE "registration_invites"
    ADD CONSTRAINT "registration_invites_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'declined', 'expired'));

-- A hold for zero seats would silently take nothing while looking like it took
-- something, which is the worst shape a capacity bug can have.
ALTER TABLE "seat_holds"
    ADD CONSTRAINT "seat_holds_seats_check" CHECK ("seats" > 0);
