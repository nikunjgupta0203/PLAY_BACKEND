-- 050 — partnership applications (docs/modules/22-partnerships.md).
--
-- One row per submission of the shareable partnership form, however many
-- categories it covers (R1): the shared organisation and contact details once,
-- and one answer document per selected category in `sections`. The columns
-- the portal searches and filters on are copied out of `profile`; everything
-- else is read whole, by a person, when the application is reviewed.
--
-- Nobody signs in to apply. `client_token` is the form's own id for one
-- attempt: a second submit with it returns the first application (R3).
CREATE TABLE "partnership_applications" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "client_token" UUID NOT NULL,
    "applicant_type" TEXT NOT NULL,
    "organisation_name" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "contact_email" CITEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "categories" TEXT[] NOT NULL,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "sections" JSONB NOT NULL DEFAULT '{}',
    "consent_accurate" BOOLEAN NOT NULL,
    "consent_contact" BOOLEAN NOT NULL,
    "consent_publish" BOOLEAN NOT NULL DEFAULT false,
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "verified_at" TIMESTAMPTZ(6),
    "verified_by" UUID,
    "assigned_to" UUID,
    "follow_up_on" DATE,
    "linked_application_id" UUID,
    "confirmation_email" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partnership_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "partnership_applications_reference_key" ON "partnership_applications"("reference");
CREATE UNIQUE INDEX "partnership_applications_client_token_key" ON "partnership_applications"("client_token");
CREATE INDEX "partnership_applications_status_created_at_idx" ON "partnership_applications"("status", "created_at" DESC);
CREATE INDEX "partnership_applications_created_at_idx" ON "partnership_applications"("created_at" DESC);
CREATE INDEX "partnership_applications_contact_email_idx" ON "partnership_applications"("contact_email");
CREATE INDEX "partnership_applications_contact_phone_idx" ON "partnership_applications"("contact_phone");
CREATE INDEX "partnership_applications_categories_idx" ON "partnership_applications" USING GIN ("categories");

ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_applicant_type_check"
    CHECK ("applicant_type" IN ('company', 'club', 'college', 'individual', 'other'));
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_categories_check"
    CHECK (cardinality("categories") >= 1
       AND "categories" <@ ARRAY['community', 'college', 'venue', 'events', 'ambassador', 'brand', 'other']::TEXT[]);
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_status_check"
    CHECK ("status" IN ('submitted', 'under_review', 'contacted', 'in_discussion', 'confirmed',
                        'launch_ready', 'active', 'on_hold', 'closed'));
-- R2 — nothing is stored without both required consents.
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_consent_check"
    CHECK ("consent_accurate" AND "consent_contact");
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_confirmation_email_check"
    CHECK ("confirmation_email" IN ('pending', 'sent', 'failed'));
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_documents_check"
    CHECK (jsonb_typeof("profile") = 'object' AND jsonb_typeof("sections") = 'object');
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_not_self_linked_check"
    CHECK ("linked_application_id" IS NULL OR "linked_application_id" <> "id");

ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_verified_by_fkey"
    FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_assigned_to_fkey"
    FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "partnership_applications" ADD CONSTRAINT "partnership_applications_linked_application_id_fkey"
    FOREIGN KEY ("linked_application_id") REFERENCES "partnership_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- R6 — staff's own notes. Never shown to the applicant.
CREATE TABLE "partnership_notes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partnership_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "partnership_notes_application_id_created_at_idx" ON "partnership_notes"("application_id", "created_at");

ALTER TABLE "partnership_notes" ADD CONSTRAINT "partnership_notes_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "partnership_notes" ADD CONSTRAINT "partnership_notes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "partnership_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partnership_notes" ADD CONSTRAINT "partnership_notes_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R6 — every status an application has been in, and who moved it. The first
-- row (from NULL to submitted, by nobody) is the submission itself.
CREATE TABLE "partnership_status_changes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partnership_status_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "partnership_status_changes_application_id_created_at_idx" ON "partnership_status_changes"("application_id", "created_at");

ALTER TABLE "partnership_status_changes" ADD CONSTRAINT "partnership_status_changes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "partnership_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partnership_status_changes" ADD CONSTRAINT "partnership_status_changes_by_user_id_fkey"
    FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
