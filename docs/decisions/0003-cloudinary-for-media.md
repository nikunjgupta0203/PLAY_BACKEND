# ADR 0003 — Cloudinary for media

**Status:** Accepted
**Date:** 2026-09-05
**Deciders:** Backend
**Supersedes:** the "S3-compatible object storage + CDN" placeholder in ADR 0001 and the original
architecture

---

## Context

The original design used S3-compatible object storage with presigned direct upload, a CDN in front,
and an unspecified image-transform step. ADR 0001 listed "Supabase Storage resizes images for you"
as a genuine thing we were giving up by choosing Neon.

**Cloudinary replaces all of it**, and closes that gap.

## The decision

Cloudinary is the only media store. Avatars, event covers, event galleries and venue photos all
live there. There is no S3 bucket, no separate CDN configuration, and no image-resizing service to
write.

**We store `public_id`, never a URL.** URLs are derived at render time with a named transformation.

## Why

- **Transforms are the product.** Every image in this app is displayed at several sizes: an avatar
  in a 32 px ranking row, a 96 px profile header and a 160 px match card; an event cover as a hero
  and as a list thumbnail. Cloudinary does that from one upload, on demand, cached at the edge.
  Doing it ourselves means an upload pipeline, a worker, derivative storage and cache invalidation.
- **It removes a service, not just a bucket.** S3 + CloudFront + a Lambda resizer is three things to
  configure, monitor and pay for. This is one.
- **Format and quality negotiation is free.** `f_auto,q_auto` serves AVIF or WebP to devices that
  accept it and falls back automatically. On Indian mobile networks that is a real bandwidth saving
  on exactly the screens that are image-heavy.
- **Upload presets are a policy surface.** Allowed formats, maximum file size, dimension caps and
  moderation are configured once on the preset rather than enforced in application code at every
  call site.

## What we give up

- **Vendor lock-in on URLs.** Cloudinary URLs encode transformations. Migrating away means
  re-uploading every asset *and* rewriting every URL-construction site. Mitigation: all URL building
  goes through one function in `platform/cloudinary.ts` — never string-concatenated in a resolver —
  so the blast radius of a future migration is one file plus a backfill.
- **Usage-based pricing on transformations, not just storage.** A transformation is billed the first
  time it is generated. Undisciplined per-call sizing (`w_237` here, `w_241` there) multiplies the
  bill for no visible benefit. See C1.
- **It is not general-purpose object storage.** Invoices, exports and any future non-image artefact
  do not belong here. When that need arrives, add object storage for it — do not force a PDF through
  an image CDN.

## Consequences

### C1 — Named transformations only

Define transformations **in Cloudinary**, reference them **by name**. Never build ad-hoc
transformation strings in application code.

```
t_avatar_sm     32×32   c_fill,g_face,f_auto,q_auto
t_avatar_md     96×96   c_fill,g_face,f_auto,q_auto
t_avatar_lg    160×160  c_fill,g_face,f_auto,q_auto
t_event_cover  1200×630 c_fill,f_auto,q_auto
t_event_thumb   400×225 c_fill,f_auto,q_auto
t_venue_photo   800×600 c_fill,f_auto,q_auto
```

Two reasons this matters. It caps the number of distinct derivatives, which caps the bill. And
changing the avatar size later is a Cloudinary console change rather than a mobile release —
which, for a native app on a review cycle, is the difference between an afternoon and a fortnight.

### C2 — Signed uploads, never an unsigned preset

The client never holds the API secret and never uploads with an unsigned preset — that is an open
door to arbitrary uploads billed to us. The flow:

1. Client asks the API for an upload signature, naming what it intends to upload.
2. Server authorizes the actor, then signs `timestamp + public_id + folder + upload_preset` with the
   API secret and returns the signature with a short expiry.
3. Client uploads **directly** to Cloudinary with that signature.
4. Client sends the returned `public_id` back; the server validates it matches what it signed, then
   persists it.

Step 4's validation is the part teams skip. Without it a client can upload under a signature you
issued and then hand you a *different* `public_id` pointing at somebody else's asset.

### C3 — The database stores `public_id`, and a URL is never persisted

```sql
avatar_public_id   text        -- 'pl4y/avatars/9f2c…'
cover_public_id    text
photo_public_ids   text[]
```

URLs are built in the GraphQL layer by `cloudinary.url(publicId, 't_avatar_md')`. A persisted URL
freezes a transformation, a delivery hostname and a version into the database, and every one of
those will change.

### C4 — Deletion is explicit

Replacing an avatar must call `uploader.destroy(oldPublicId)`. Orphaned assets are billed storage
that nothing references. A nightly `prune-orphan-media` job reconciles Cloudinary's asset list
against the `public_id` values in the database and reports — **reports**, not deletes, until it has
run clean for a fortnight.

### C5 — Folder structure is fixed at launch

```
pl4y/avatars/{playerId}
pl4y/events/{eventId}/cover
pl4y/events/{eventId}/gallery/{n}
pl4y/venues/{venueId}/{n}
```

Folders are effectively part of the `public_id` and are painful to reorganise later. Decide once.

### C6 — Moderation hook, unused for now

The upload preset supports moderation. Phase 1 does not enable it — venue and event imagery is
organizer-supplied and volume is low, matching the manual-moderation stance in `venues R3`. The
seam is here so that turning it on later is a preset change, not a pipeline.

## Revisit this if

- Monthly transformation spend outgrows storage spend by a wide margin, which would mean C1 is not
  being followed and derivatives are proliferating.
- We need to store non-image artefacts at volume — invoices, data exports, video. Add object storage
  for those rather than stretching this decision.

## References

- `modules/03-profile.md` R6 — avatar upload
- `modules/04-venues.md` — venue photos
- `modules/05-events.md` — event cover and gallery
- ADR 0001 § "What we give up" — the image-transform gap this closes
