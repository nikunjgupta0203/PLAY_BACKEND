-- 051 — PL4Y Shop vendor applications (docs/modules/23-vendors.md).
--
-- One row per submission of the vendor partnership form: seller, products and
-- fulfilment answers as three JSON documents, with the columns the portal
-- searches and filters on copied out of them. No bank details or identity
-- documents are collected at this stage.
--
-- Nobody signs in to apply. `client_token` is the form's own id for one
-- attempt: a second submit with it returns the first application (R3).
CREATE TABLE "vendor_applications" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "client_token" UUID NOT NULL,
    "seller_type" TEXT NOT NULL,
    "store_name" TEXT,
    "contact_name" TEXT NOT NULL,
    "contact_email" CITEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "sports" TEXT[] NOT NULL,
    "gst_status" TEXT NOT NULL,
    "commercial_model" TEXT NOT NULL,
    "seller" JSONB NOT NULL DEFAULT '{}',
    "products" JSONB NOT NULL DEFAULT '{}',
    "fulfilment" JSONB NOT NULL DEFAULT '{}',
    "consented_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "confirmation_email" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vendor_applications_reference_key" ON "vendor_applications"("reference");
CREATE UNIQUE INDEX "vendor_applications_client_token_key" ON "vendor_applications"("client_token");
CREATE INDEX "vendor_applications_status_created_at_idx" ON "vendor_applications"("status", "created_at" DESC);
CREATE INDEX "vendor_applications_created_at_idx" ON "vendor_applications"("created_at" DESC);
CREATE INDEX "vendor_applications_contact_email_idx" ON "vendor_applications"("contact_email");
CREATE INDEX "vendor_applications_contact_phone_idx" ON "vendor_applications"("contact_phone");
CREATE INDEX "vendor_applications_sports_idx" ON "vendor_applications" USING GIN ("sports");

ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_seller_type_check"
    CHECK ("seller_type" IN ('brand', 'retailer', 'distributor', 'individual'));
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_store_name_check"
    CHECK ("store_name" IS NOT NULL OR "seller_type" = 'individual');
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_sports_check"
    CHECK (cardinality("sports") >= 1);
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_gst_status_check"
    CHECK ("gst_status" IN ('registered', 'applied', 'not_registered'));
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_commercial_model_check"
    CHECK ("commercial_model" IN ('commission', 'vendor_plan', 'unsure'));
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_status_check"
    CHECK ("status" IN ('new', 'reviewing', 'more_info_needed', 'approved', 'rejected'));
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_confirmation_email_check"
    CHECK ("confirmation_email" IN ('pending', 'sent', 'failed'));
ALTER TABLE "vendor_applications" ADD CONSTRAINT "vendor_applications_documents_check"
    CHECK (jsonb_typeof("seller") = 'object' AND jsonb_typeof("products") = 'object' AND jsonb_typeof("fulfilment") = 'object');

-- R6 — staff's own notes. Never shown to the seller.
CREATE TABLE "vendor_notes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vendor_notes_application_id_created_at_idx" ON "vendor_notes"("application_id", "created_at");

ALTER TABLE "vendor_notes" ADD CONSTRAINT "vendor_notes_body_check"
    CHECK (char_length("body") BETWEEN 1 AND 4000);
ALTER TABLE "vendor_notes" ADD CONSTRAINT "vendor_notes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "vendor_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_notes" ADD CONSTRAINT "vendor_notes_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R6 — every status an application has been in, and who moved it. The first
-- row (from NULL to new, by nobody) is the submission itself.
CREATE TABLE "vendor_status_changes" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_status_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vendor_status_changes_application_id_created_at_idx" ON "vendor_status_changes"("application_id", "created_at");

ALTER TABLE "vendor_status_changes" ADD CONSTRAINT "vendor_status_changes_application_id_fkey"
    FOREIGN KEY ("application_id") REFERENCES "vendor_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vendor_status_changes" ADD CONSTRAINT "vendor_status_changes_by_user_id_fkey"
    FOREIGN KEY ("by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
