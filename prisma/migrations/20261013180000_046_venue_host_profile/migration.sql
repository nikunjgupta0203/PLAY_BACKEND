-- 046 — the venue host application grows into a partner profile.
--
-- `details` holds what the longer form asks (contact person, facilities and
-- opening hours, prices and booking policies, partnership and consents) as one
-- document: it is read whole, by a person, when the application is reviewed.
-- An application sent by the first form keeps `{}`.
--
-- `photo_public_ids` are the venue photos the applicant uploaded, as Cloudinary
-- public_ids under their own folder; they become the venue's photos on approval.
ALTER TABLE "venue_host_applications"
    ADD COLUMN "details" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "photo_public_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "venue_host_applications" ADD CONSTRAINT "venue_host_applications_details_check"
    CHECK (jsonb_typeof("details") = 'object');
