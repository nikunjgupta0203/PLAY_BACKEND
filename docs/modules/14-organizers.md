# 14 — organizers

| | |
|---|---|
| **Sprint** | 7 |
| **Phase** | 1 |
| **Depends on** | identity, events, registration, payments, notifications |
| **Owns** | `organizer_profiles`, `organizer_members`, `organizer_broadcasts`, `event_stats_daily` |
| **Rule prefix** | `organizers R*` |

The organizer as a business rather than a person: a public profile, a team of members, a
verification state, a way to talk to entrants, and the dashboard that tells them how an event is
doing.

Sprint 7 was previously "organizer surface — events + identity grants, no new module". It became a
module because four things had nowhere to live: an organizer's public page, multi-person organizer
teams, broadcast messages to entrants, and event analytics.

**Money is not here.** Payout accounts and settlements are `payments` (R13–R18). This module asks
`payments` whether an organizer can be paid; it never moves money.

---

## Service interface

```ts
create(actor, input)                                  => OrganizerProfile
update(actor, organizerId, patch)                     => OrganizerProfile
bySlug(slug: string) / byId(organizerId: string)      => OrganizerProfile
listForUser(userId: string)                           => OrganizerMembership[]
addMember(actor, organizerId, { userId, role })       => OrganizerMembership
removeMember(actor, organizerId, userId)              => void
requestVerification(actor, organizerId, input)        => OrganizerProfile
setVerification(admin: AdminActor, organizerId, status, reason) => OrganizerProfile  // admin calls this
canPublishPaid(organizerId: string)                   => { ok: boolean, missing: string[] }  // events calls this (R5)
broadcast(actor, eventId, { audience, subject, body, email }) => Broadcast
eventAnalytics(actor, eventId)                        => EventAnalytics
organizerAnalytics(actor, organizerId, { from, to })  => OrganizerAnalytics
```

## GraphQL

```graphql
Query.organizer(slug: String!): OrganizerProfile
Query.eventAnalytics(eventId: ID!): EventAnalytics!
Query.organizerAnalytics(organizerId: ID!, from: Date!, to: Date!): OrganizerAnalytics!

type Viewer { organizers: [OrganizerMembership!]! }

type OrganizerProfile {
  id: ID!
  slug: String!
  name: String!
  logoUrl: String
  bio: String
  city: String
  verification: OrganizerVerification!   # UNVERIFIED | PENDING | VERIFIED | REJECTED | SUSPENDED
  events(status: EventStatus, first: Int = 20, after: String): EventConnection!
  eventsHosted: Int!
}

type EventAnalytics {
  views: Int!                  # approximate — R9
  registrationsBegun: Int!
  confirmedEntries: Int!
  fillRate: Float!             # confirmed / capacity, across categories
  checkedIn: Int!
  noShows: Int!
  refundsCount: Int!
  grossPaise: Int!             # from payments.ledgerSummary — R8
  refundedPaise: Int!
  netPaise: Int!
  payoutStatus: PayoutStatus
  byCategory: [CategoryAnalytics!]!
  asOf: DateTime!
}

Mutation.createOrganizer(input: CreateOrganizerInput!): OrganizerPayload!
Mutation.updateOrganizer(input: UpdateOrganizerInput!): OrganizerPayload!
Mutation.addOrganizerMember(input: AddOrganizerMemberInput!): OrganizerMemberPayload!
Mutation.removeOrganizerMember(input: RemoveOrganizerMemberInput!): OrganizerMemberPayload!
Mutation.requestOrganizerVerification(input: VerificationInput!): OrganizerPayload!
Mutation.sendEventBroadcast(input: EventBroadcastInput!): EventBroadcastPayload!
```

---

## Rules

**R1** — An organizer profile is an entity, not a user. A user may belong to several organizers;
every event belongs to exactly one organizer profile through `events.organizer_profile_id`
(events R13). A solo organizer gets a personal organizer profile created on their first event.

> **Decided 2026-10-06 — null is the design.** `events.organizer_profile_id` stays nullable and
> 014's NOT NULL plan is dropped. Null means "hosted by the player themselves" (`events.organizer_id`
> is the host); a value means an organisation, created by PL4Y staff (org R1). The personal
> profiles 014 backfilled read the same as null. Requiring a profile on every event would mean
> creating a fake organisation per player, which org R1 (staff create organisations, verified) rules
> out.

**R2** — Membership roles are `owner`, `admin` and `member`. Creating or managing events requires
`owner` or `admin`. An organizer always has at least one `owner`; removing the last owner returns
`LAST_OWNER`.

**R3** — Membership becomes event access by **materialising grants**, not by a second lookup.
When an `owner`/`admin` joins, or an event is created under the organizer, this module calls
`identity.syncOrganizerGrants(tx, …)` in the same transaction, writing `event_staff` rows with
`source = 'organizer'` (identity R16). Removing a member deletes those rows in the same
transaction. `identity` stays at L0, and revocation is still effective on the next request
(identity R10).

**R4** — The organizer `slug` is permanent once any of its events has been published — the same
deep-link argument as `events R8`.

**R5** — Verification states are `unverified → pending → verified | rejected`, plus `suspended`.
Drafts and free categories need nothing. **Publishing a category with `entry_fee_paise > 0`
requires `verified` and an active payout account** (`payments R13`). `canPublishPaid` returns
what is missing so the organizer UI can show a checklist rather than an error.

**R6** — Broadcasts reach a chosen audience — `confirmed`, `category:<id>`, `checked_in` or
`waitlist` — through `notifications.emitBulk` with the `organizer.message` template. When
`email = true`, this module sends the email itself through the Resend adapter (the module that owns
the action sends its email — `payments R12`). The body is plain text, at most 1,000 characters.

**R7** — Broadcasts are capped at **5 per event per 24 hours** and stored permanently. Every one is
evidence if an entrant says they were never told about a venue change.

**R8** — Analytics are **read models**, never computed from another module's tables at read time.
Counts are projected into `event_stats_daily` from outbox topics (`registration.begun`,
`registration.confirmed`, `registration.checked_in`, `refund.processed`). Money figures come from
`payments.ledgerSummary(eventId)`, because the ledger is the only source of truth for money
(`payments R6`). Every figure carries `asOf`.

**R9** — Event page views are counted per event per day (there is no Redis since migration 023: an
in-process tally flushed to Postgres, or a `views` table deduped per viewer) and rolled into
`event_stats_daily` nightly. Views are approximate and labelled that way; losing a flush loses a
few views and nothing else.

**R10** — Analytics are visible to `owner` and `manager` grants only. A `scorer` never sees revenue.

**R11** — Event staff see an entrant's `phone_e164` only for `confirmed` and `checked_in` entries
in their own event, and every reveal is logged. It is the tournament-morning reason
`identity R12` exists, and nothing more.

---

## Schema

```sql
CREATE TABLE organizer_profiles (
  id                uuid PRIMARY KEY,
  slug              text UNIQUE NOT NULL,            -- permanent once an event publishes (R4)
  name              text NOT NULL,
  bio               text,
  city              text,
  logo_public_id    text,                            -- Cloudinary
  contact_email     citext,
  contact_phone     text,
  verification      text NOT NULL DEFAULT 'unverified' CHECK (verification IN
                      ('unverified','pending','verified','rejected','suspended')),
  verification_note text,
  verified_at       timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizer_members (
  organizer_profile_id uuid NOT NULL REFERENCES organizer_profiles(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id),
  role                 text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_profile_id, user_id)
);
CREATE INDEX ON organizer_members (user_id);

CREATE TABLE organizer_broadcasts (
  id              uuid PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES events(id),
  sent_by         uuid NOT NULL REFERENCES users(id),
  audience        text NOT NULL,                     -- 'confirmed' | 'category:<id>' | …
  subject         text NOT NULL,
  body            text NOT NULL CHECK (char_length(body) <= 1000),
  with_email      boolean NOT NULL DEFAULT false,
  recipient_count integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON organizer_broadcasts (event_id, created_at DESC);   -- R7 window check

-- Read model (R8). Rows are upserted by projection jobs, never by a request.
CREATE TABLE event_stats_daily (
  event_id            uuid NOT NULL REFERENCES events(id),
  event_category_id   uuid REFERENCES event_categories(id),   -- null = event total
  day                 date NOT NULL,                          -- event-local timezone
  views               integer NOT NULL DEFAULT 0,             -- approximate (R9)
  registrations_begun integer NOT NULL DEFAULT 0,
  confirmed           integer NOT NULL DEFAULT 0,
  checked_in          integer NOT NULL DEFAULT 0,
  refunds             integer NOT NULL DEFAULT 0,
  UNIQUE NULLS NOT DISTINCT (event_id, event_category_id, day)
);
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `ORGANIZER_NOT_FOUND` | user | Not found state |
| `SLUG_TAKEN` | user | Inline on the slug field |
| `LAST_OWNER` | user | Explain an owner must remain — R2 |
| `ORGANIZER_NOT_VERIFIED` | user | Show the verification checklist — R5 |
| `PAYOUT_ACCOUNT_REQUIRED` | user | Route to payout setup — R5 |
| `BROADCAST_LIMIT` | user | Show when the next broadcast is allowed — R7 |
| `FORBIDDEN` | system | Not an owner/admin of this organizer |

## Emits

| Event | Consumers |
|---|---|
| `organizer.verified` | notifications, admin |
| `organizer.member_added` | notifications |
| `broadcast.sent` | notifications, admin (audit) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `project-event-stats` | Outbox topics in R8 | 3 × exp | Alert; dashboard serves stale |
| `rollup-event-views` | Nightly | 3 × exp | Drop — views are approximate |
| `send-broadcast-email` | `sendEventBroadcast` with email | 3 × exp | Alert |

---

## Done when

A verified organizer with an active payout account publishes a paid event. An `admin` member of
that organizer manages the event **without a direct `event_staff` row**, and loses access on their
very next request after being removed. A broadcast reaches every confirmed entrant's in-app feed.
The event dashboard's net revenue matches `ledger_entries` to the paisa.

---

## Implementation checklist

- [ ] Migration `014_organizers.sql`; expand `events.organizer_profile_id` (nullable), backfill a
      personal organizer per existing organizer user, then contract to `NOT NULL` (events R13)
- [ ] Membership + last-owner guard (R2)
- [ ] `identity.syncOrganizerGrants` wired into membership and event-creation transactions (R3)
- [ ] Verification request flow; `setVerification` exposed to `admin` only (R5)
- [ ] `canPublishPaid` called from the events publish gate (events R10)
- [ ] Broadcast with audience resolution through `registration.listForEvent`, 5/24h cap (R6, R7)
- [ ] `event_stats_daily` projections + nightly HyperLogLog roll-up (R8, R9)
- [ ] `payments.ledgerSummary` for money figures; `asOf` on every response (R8)
- [ ] Phone reveal limited to confirmed entrants, and logged (R11)
- [ ] Tests naming R2, R3, R5, R7, R8, R10, R11
