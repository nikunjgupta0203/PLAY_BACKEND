# 24 — careers (Campus Ambassador Program and Sales Internship)

A shareable, sign-in-free application form for two opportunities, and its
review in the admin portal. Form app: `PLAY_FRONTEND/apps/careers`. Portal:
`apps/admin` → `/careers`.

## Steps

1. **Welcome** — pick the Campus Ambassador Program or the Sales Internship.
   `?role=ambassador` or `?role=sales` on the link preselects one.
2. **About you** (both) — name, email, mobile with country code, city,
   college / organisation, course and year, LinkedIn and Instagram (optional),
   resume (optional PDF), how they heard about PL4Y.
3. **The opportunity's questions** — `AMBASSADOR` or `SALES` in form.ts. The
   sales experience description is asked only after "Yes".
4. **Review** — every answer with Edit per section, one consent, a privacy note.
5. **Submitted** — reference, "Follow PL4Y on Instagram" (only when the form
   app has `NEXT_PUBLIC_INSTAGRAM_URL`), Close.

Questions: `src/modules/careers/service/form.ts` (the contract). The form app
keeps a copy in `src/lib/form.ts`; keep the two in step.

## Rules

- **R1** One application per submission. Nobody signs in.
- **R2** Answers are checked with the partnerships answer checker; answers to
  questions not asked (the other opportunity's, or an unmet follow-up) are
  dropped.
- **R3** The same client token submitted again returns the first application,
  so a double tap or a retry never makes two.
- **R4** Applicant confirmation + team email, both best effort. Team inbox:
  `CAREER_NOTIFY_EMAILS`, or `PARTNERSHIP_NOTIFY_EMAILS` when empty. The team
  email links to `${PORTAL_URL}/careers/{id}`.
- **R5** Resume: one PDF, at most 5 MB. `careerResumeUpload` signs ONE upload
  straight to Cloudinary as a **private raw** file in
  `pl4y/careers/{clientToken}/`. On submit the public_id must be in that
  folder; when Cloudinary answers, the file must exist and be within 5 MB (an
  oversize one is deleted). Staff open it with `openCareerResume`, a signed
  download link that expires in 5 minutes. There is no public URL.
- **R6** 10/hour and 30/day per IP, 5/day per email, 20 upload signatures an
  hour per IP. A filled hidden field gets a fake receipt and stores nothing.
- **R7** Statuses: `new` → `under_review` → `shortlisted` → `interview` →
  `selected` / `rejected`. Every move is kept in `career_status_changes` with
  who and when; `status_changed_at` holds the latest. Staff notes in
  `career_notes`, never shown to the applicant. Reading and opening resumes:
  any platform staff. Changing: admin and support. CSV export cells that start
  with `= + - @` are prefixed with `'`.
- **R8** Retention: the worker's nightly `purge-career-applications` deletes
  applications (notes, history and the resume file with them) 12 months after
  their last status change. The form's privacy note says the same.

## Tables (migration 052)

`career_applications`, `career_notes`, `career_status_changes`.

## Deploy

Backend (migration 052) → portal → careers app. The careers app calls the API
from the browser, so its origin must be in `CORS_ORIGINS`. Set
`CAREER_NOTIFY_EMAILS`, and `NEXT_PUBLIC_INSTAGRAM_URL` on the form app once
the official profile link is known.
