# 22 — partnerships

| | |
|---|---|
| **Sprint** | 2026-10-23 · from the Google Doc "PL4Y Partnership Forms — Complete Product & Development Specification" |
| **Depends on** | identity (staff names), platform (email, Cloudinary, rate limits) |
| **Owns** | `partnership_applications`, `partnership_notes`, `partnership_status_changes` |
| **Rule prefix** | `partnerships R*` |
| **Form app** | `PLAY_FRONTEND/apps/partners` (its own deploy) · portal page `PLAY_FRONTEND/apps/admin/src/app/(portal)/partnerships` |

A shareable, PL4Y-branded form for clubs, colleges, venues, event organisers, campus
ambassadors, brands and anyone else who wants to partner with PL4Y before launch. No app and
no account: one link, one application, reviewed by PL4Y staff in the portal.

The question list lives in `src/modules/partnerships/service/form.ts`. The form app keeps its own
copy (with placeholders and hints) in `apps/partners/src/lib/form.ts`; **keys, kinds, options
and required flags must match** — the server is the one that holds to them.

---

## Rules

**R1 — one application, every category.** The shared details (the "About you" step) are entered
once. The applicant picks one or more of seven categories (`community`, `college`, `venue`,
`events`, `ambassador`, `brand`, `other`) and answers one section per category, all in one
submission and one row. Sections for categories they picked and then dropped are not sent on.

**R2 — answers are checked against the form.** Every answer is checked by kind (text lengths,
email, phone with 8–15 digits, http(s) links, whole numbers, dates, options from the list,
yes/no, images), required questions must be answered, and a question with a `when` is only
asked when its condition is met. Unknown keys are dropped, not refused. A refusal names the
question (`details.field`, e.g. `venue.locations.1.city`) so the form can point at it. Both
consents (accurate; may be contacted) are required — a CHECK backs it. Permission to publish
their profile, logo, photos or activities is separate and optional.

**R3 — one attempt, one application.** The form makes a UUID (`clientToken`) per attempt.
Submitting it again — a double tap, a retry after a dropped connection, two at once — returns the
first application's receipt. Unique index on `client_token`.

**R4 — the emails never cost an application.** The row is stored first. Then the applicant gets
a confirmation (reference, organisation, categories, date; never "approved"), and every address in
`PARTNERSHIP_NOTIFY_EMAILS` gets a heads-up linking to `${PORTAL_URL}/partnerships/{id}`. A failed
confirmation is recorded (`confirmation_email = failed`) and shown in the portal.

**R5 — spam.** A hidden field (`trap`) filled in gets a believable receipt and nothing is stored.
Submissions are limited to 10 an hour and 30 a day per IP, and 5 a day per email. Image upload
signatures (one image each, into `pl4y/partners/{clientToken}/`) are limited to 120 an hour per
IP, and every image in the answers must sit under that attempt's folder (ADR 0003 §C2). The form
accepts JPEG, PNG, WebP and HEIC up to 8 MB; supporting documents are asked for as links.

**R6 — the portal.** Anyone with a portal session reads applications; admin and support change
them. Search (organisation, contact, email, phone, reference), filter (category, city, status),
the whole application with every section, internal notes, status with a full history (who, when),
verified (who, when), an assignee from PL4Y staff, a follow-up date, and CSV export of every match
(5,000 at most; cells starting `= + - @` are quoted so spreadsheets do not run them). Statuses:
submitted → under review → contacted → in discussion → confirmed → launch ready → active, plus
on hold and closed. Notes are never shown to the applicant.

**R7 — the same organisation, again.** An application lists others with the same email, phone or
organisation name as possible duplicates. Staff link one to an earlier one; both stay, with their
own history.

## Data and retention

Applications hold contact details of people who are not PL4Y users. They are kept while PL4Y is
working with the applicant; closed applications should be deleted after 24 months (no job does it
yet). Database backups are Neon's point-in-time restore. Uploaded images stay in Cloudinary under
`pl4y/partners/`; an upload from an attempt that was never submitted is an orphan nothing deletes
yet.

## Not built (spec §16 "later")

Save-and-resume by email (the form keeps a draft on the device instead), automated follow-up
reminders, smarter duplicate matching, finer portal permissions, applicant edits after submitting.
