-- 052 — careers applications: Campus Ambassador Program and Sales Internship
-- (docs/modules/24-careers.md).
--
-- One row per submission of the careers form: the basic details and the
-- opportunity's own answers as two JSON documents, with the columns the portal
-- searches and filters on copied out of them. A resume, when given, is a
-- private Cloudinary file named by its public_id, never a URL.
--
-- Nobody signs in to apply. `client_token` is the form's own id for one
-- attempt: a second submit with it returns the first application (R3).
CREATE TABLE "career_applications" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "client_token" UUID NOT NULL,
    "opportunity" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "organisation" TEXT NOT NULL,
    "basic" JSONB NOT NULL DEFAULT '{}',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "resume_public_id" TEXT,
    "resume_name" TEXT,
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "confirmation_email" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "career_applications_reference_key" ON "career_applications"("reference");
CREATE UNIQUE INDEX "career_applications_client_token_key" ON "career_applications"("client_token");
CREATE INDEX "career_applications_opportunity_status_created_at_idx" ON "career_applications"("opportunity", "status", "created_at" DESC);
CREATE INDEX "career_applications_created_at_idx" ON "career_applications"("created_at" DESC);
CREATE INDEX "career_applications_email_idx" ON "career_applications"("email");
CREATE INDEX "career_applications_status_changed_at_idx" ON "career_applications"("status_changed_at");

ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_opportunity_check"
    CHECK ("opportunity" IN ('campus_ambassador', 'sales_internship'));
ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_status_check"
    CHECK ("status" IN ('new', 'under_review', 'shortlisted', 'interview', 'selected', 'rejected'));
ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_confirmation_email_check"
    CHECK ("confirmation_email" IN ('pending', 'sent', 'failed'));
ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_resume_check"
    CHECK (("resume_public_id" IS NULL) = ("resume_name" IS NULL));
ALTER TABLE "career_applications" ADD CONSTRAINT "career_applications_documents_check"
    CHECK (jsonb_typeof("basic") = 'object' AND jsonb_typeof("answers") = 'object');

-- R7 — staff's own notes. Never shown to the applicant.
CREATE TABLE "career_notes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "career_notes_application_id_created_at_idx" ON "career_notes"("application_id", "created_at");

ALTER TABLE "career_notes" ADD CONSTRAINT "career_notes_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "career_notes" ADD CONSTRAINT "career_notes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_notes" ADD CONSTRAINT "career_notes_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R7 — every status an application has been in, who moved it and when. The
-- first row (from NULL to new, by nobody) is the submission itself.
CREATE TABLE "career_status_changes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "career_status_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "career_status_changes_application_id_created_at_idx" ON "career_status_changes"("application_id", "created_at");

ALTER TABLE "career_status_changes" ADD CONSTRAINT "career_status_changes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "career_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "career_status_changes" ADD CONSTRAINT "career_status_changes_by_user_id_fkey"
    FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
