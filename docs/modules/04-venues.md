# 04 — venues

| | |
|---|---|
| **Sprint** | 3 (module) · 10 (discovery screens) · 11 (reviews, claims, playing-area kinds) |
| **Phase** | 1 |
| **Depends on** | nothing |
| **Owns** | `venues`, `venue_courts`, `venue_reviews`, `venue_visits`, `venue_claims` |
| **Rule prefix** | `venues R*` |

Where play happens. Deliberately thin: courts exist so a tournament can be scheduled onto them, and
so a player can find a place to play. **No booking, no inventory, no availability calendar** —
that is Phase 3, specified in [19-bookings.md](./19-bookings.md). This module stays the venue
directory: profiles, courts, reviews and ownership claims.

---

## Service interface

```ts
search({ near?: GeoPoint, radiusKm?, city?, sportId? }, page)  => Page<Venue>
byId(venueId: string)                                          => Venue
courtsFor(venueId: string)                                     => Court[]
create(actor: OrganizerActor, input)                           => Venue
update(actor, venueId, patch)                                  => Venue
// "Available" here means: not already assigned within THIS tournament. (R4)
freeCourts(venueId, window: { from, to }, tournamentId)        => Court[]
reviews(venueId, page)                                         => Page<VenueReview>
review(actor, venueId, { stars, body })                        => VenueReview   // R6, R7
replyToReview(actor, reviewId, body)                           => VenueReview   // R8
claim(actor, venueId, evidence)                                => VenueClaim    // R9
decideClaim(admin: AdminActor, claimId, decision, reason)      => VenueClaim    // admin calls this
recordVisit(payload)                                           => void          // projection job (R6)
```

## GraphQL

```graphql
Query.venues(near: GeoPointInput, radiusKm: Float = 10, city: String,
             sportId: ID, first: Int = 20, after: String): VenueConnection!
Query.venue(id: ID!): Venue

type Venue implements Node {   # deep-link target — conventions §4
  id: ID!
  name: String!
  address: String!
  city: String!
  location: GeoPoint!
  courts: [Court!]!
  sports: [Sport!]!
  amenities: [String!]!
  photoUrls: [String!]!
  description: String
  openingHours: [OpeningHours!]!
  rating: Float                # null until 3 reviews — R7
  reviewCount: Int!
  reviews(first: Int = 10, after: String): VenueReviewConnection!
  viewerCanReview: Boolean!    # R6
  bookable: Boolean!           # true once bookings are enabled — 19-bookings
}

type Court {
  id: ID!
  name: String!          # "Court 3"
  surface: String
  indoor: Boolean!
  kind: PlayingAreaKind!       # COURT | TURF | GROUND | PITCH | TABLE — R10
  sports: [Sport!]!
}

Mutation.reviewVenue(input: ReviewVenueInput!): VenueReviewPayload!
Mutation.replyToVenueReview(input: ReplyVenueReviewInput!): VenueReviewPayload!
Mutation.claimVenue(input: ClaimVenueInput!): VenueClaimPayload!
```

---

## Rules

**R1** — Radius search uses the PostGIS `gist` index on `geo` and is **capped at 50 km**. An
uncapped radius query is a table scan wearing a filter.

**R2** — A court belongs to exactly one venue and carries `surface`, `indoor` and `sport_ids[]` —
one physical court often serves several sports.

**R3** — Venues are created by organizers and are visible to everyone. Moderation is manual in
Phase 1. That is acceptable at this volume and should be revisited before it is not.

**R4** — Court *availability* in Phase 1 means only "is this court already assigned to another match
in this tournament". It is a scheduling concept, not a booking one. `freeCourts` takes a
`tournamentId` precisely so nobody mistakes it for a booking API.

**R5** — Venues are soft-deleted. A completed tournament must keep resolving where it was played.

**R6** *(Sprint 11)* — A user may review a venue only if they **played there within the last 12
months**: a completed match, a game they joined that took place, or a completed booking.
Eligibility reads `venue_visits`, a projection written from `match.completed`, `game.past` and
`booking.completed`; this module never reads those modules' tables. One review per user per venue,
editable: 1–5 stars and at most 1,000 characters.

**R7** — `rating_avg` and `rating_count` on `venues` are updated **in the same transaction** as the
review write, and exclude hidden reviews. `rating` appears only once a venue has **3 reviews**; one
furious review is not a rating.

**R8** — Venue staff (`identity R17`) may post **one public reply** per review. They cannot edit or
delete reviews; they can report one (`admin R6`).

**R9** *(Sprint 11)* — Venue claims: a user submits evidence of ownership or management, and an
admin approves or rejects it (`admin R3`). Approval creates the `owner` grant in `venue_staff` in
the same transaction. A venue has one owner and at most one pending claim. Until a venue is
claimed, its creating organizer may edit it (R3); after that, only venue staff can.

**R10** — Playing areas are sport-agnostic: `venue_courts.kind` is `court`, `turf`, `ground`,
`pitch` or `table`. The GraphQL type keeps the name `Court`, because renaming a type is a breaking
API change; `kind` carries the distinction.

**R11** — `description` (at most 2,000 characters) and `contact_phone` are optional, trimmed, and
stored as null when blank. Both are edited by whoever may edit the venue (R3).

**R12** — `opening_hours` is a list of windows `{ day, opens, closes }` in the venue's local time:
`day` 0 is Monday, times are `HH:MM`, and `opens` is before `closes`. A day with two sessions has two
windows; a day with none is closed. An update replaces the whole week, and a malformed window is
`INVALID_OPENING_HOURS` rather than a partial write.

---

## Schema

```sql
CREATE TABLE venues (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  address       text NOT NULL,
  city          text NOT NULL,
  geo           geography(Point,4326) NOT NULL,
  amenities     text[] NOT NULL DEFAULT '{}',
  photo_public_ids text[] NOT NULL DEFAULT '{}',   -- Cloudinary public_ids
  created_by    uuid NOT NULL REFERENCES users(id),
  deleted_at    timestamptz,                       -- R5
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venues_geo_idx ON venues USING gist (geo) WHERE deleted_at IS NULL;
CREATE INDEX venues_city_idx ON venues (city) WHERE deleted_at IS NULL;

CREATE TABLE venue_courts (
  id            uuid PRIMARY KEY,
  venue_id      uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name          text NOT NULL,                     -- "Court 3"
  surface       text,
  indoor        boolean NOT NULL DEFAULT false,
  sport_ids     uuid[] NOT NULL DEFAULT '{}',      -- R2
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (venue_id, name)
);

-- Sprint 11 additions
ALTER TABLE venues
  ADD COLUMN description   text,
  ADD COLUMN opening_hours jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN contact_phone text,
  ADD COLUMN rating_avg    numeric(3,2),                  -- R7
  ADD COLUMN rating_count  integer NOT NULL DEFAULT 0;
ALTER TABLE venue_courts
  ADD COLUMN kind text NOT NULL DEFAULT 'court'
  CHECK (kind IN ('court','turf','ground','pitch','table'));   -- R10
ALTER TABLE venue_staff ADD FOREIGN KEY (venue_id) REFERENCES venues(id);   -- identity R17

-- R6. Projection of "played here".
CREATE TABLE venue_visits (
  venue_id      uuid NOT NULL REFERENCES venues(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  source        text NOT NULL CHECK (source IN ('match','game','booking')),
  source_id     uuid NOT NULL,
  visited_at    timestamptz NOT NULL,
  PRIMARY KEY (source, source_id, user_id)
);
CREATE INDEX ON venue_visits (venue_id, user_id, visited_at DESC);

CREATE TABLE venue_reviews (
  id            uuid PRIMARY KEY,
  venue_id      uuid NOT NULL REFERENCES venues(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  stars         smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body          text CHECK (char_length(body) <= 1000),
  reply_body    text,                                     -- R8
  replied_by    uuid REFERENCES users(id),
  replied_at    timestamptz,
  hidden_at     timestamptz,                              -- admin R6
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, user_id)
);
CREATE INDEX ON venue_reviews (venue_id, created_at DESC) WHERE hidden_at IS NULL;

CREATE TABLE venue_claims (
  id            uuid PRIMARY KEY,
  venue_id      uuid NOT NULL REFERENCES venues(id),
  claimant_id   uuid NOT NULL REFERENCES users(id),
  evidence      jsonb NOT NULL,                           -- photo public_ids only (ADR 0003)
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX venue_claim_one_pending ON venue_claims (venue_id) WHERE status = 'pending';
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `VENUE_NOT_FOUND` | user | Includes soft-deleted |
| `RADIUS_TOO_LARGE` | user | Over 50 km — R1 |
| `COURT_IN_USE` | user | Cannot deactivate a court with scheduled matches |
| `REVIEW_NOT_ELIGIBLE` | user | Explain "play here first" — R6 |
| `VENUE_ALREADY_CLAIMED` | user | R9 |
| `CLAIM_PENDING` | user | R9 |

## Emits

| Event | Consumers |
|---|---|
| `venue.updated` | discovery |
| `venue.reviewed` | notifications (venue staff), admin |
| `venue.claim_decided` | notifications |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `project-venue-visits` | `match.completed`, `game.past`, `booking.completed` | 3 × exp | Alert; eligibility lags |

---

## Done when

A venue with four courts can be created, found by a 10 km radius query from a map centre, and have
its courts assigned to matches by the tournament scheduler **without double-booking a court inside
one event**.

---

## Implementation checklist

- [ ] Verify `postgis` is enabled on Neon **before starting** — [ADR 0001 § C1](../decisions/0001-neon-over-supabase.md)
- [ ] Migration `004_venues.sql`
- [ ] Radius search with a 50 km cap and an explicit `ORDER BY` distance
- [ ] `freeCourts(venueId, window, tournamentId)` — scoped to one tournament (R4)
- [ ] Soft delete honoured in every read path and in both partial indexes
- [ ] Venue photos via signed Cloudinary upload; store `public_id`, render with `t_venue_photo`
- [ ] Tests naming R1, R4, R5
- [x] `venue_visits` projection from `match.completed`; reviews with eligibility and in-transaction aggregate (R6, R7). Backfill: `pnpm backfill:match-history`
- [x] Reply (R8) — by the venue's creator until claims create venue staff
- [ ] Claims with admin decision creating the owner grant (R9) — needs the admin surface
- [x] `venue_courts.kind` (R10); description, opening hours, contact phone (R12)
- [x] Tests naming R6, R7, R8, R10, R12 (R9 with claims)
