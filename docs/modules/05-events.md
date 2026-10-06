# 05 — events

| | |
|---|---|
| **Sprint** | 3 |
| **Phase** | 1 |
| **Depends on** | sport, venues, identity |
| **Owns** | `events`, `event_categories`, `event_media` |
| **Rule prefix** | `events R*` |

The thing a player discovers, and the categories they actually register for. Owns capacity and the
**single price-quote function** that both `registration` and `payments` call — so what the player
agreed to and what Razorpay charges cannot drift.

Highest read volume in the system.

---

## Event vs category

An **event** is a tournament a player finds. An **event category** is what they register for —
Men's Doubles 3.5, Mixed Doubles Open. Capacity, fee and format live on the **category**, never the
event, because one tournament sells eight different draws at eight different prices.

---

## Service interface

```ts
search(filter: EventFilter, page: CursorPage)      => Page<Event>
bySlug(slug: string)                               => Event
byId(eventId: string)                              => Event
create(actor: OrganizerActor, input)               => Event
update(actor, eventId, patch)                      => Event
publish(actor, eventId)                            => Event
cancel(actor, eventId, reason)                     => Event
addCategory(actor, eventId, input)                 => EventCategory
capacityOf(categoryId)                             => { capacity, taken, held, remaining }
priceQuote(categoryId)                             => PriceQuote      // R3
markLive(eventId) / markCompleted(eventId)         => Event
moderate(admin: AdminActor, eventId, 'hide' | 'unhide', reason) => Event   // R12
createForSeason(tx, actor, input)                  => Event               // leagues calls this (R11)
setCategoryAllowlist(tx, categoryId, { userIds, until }) => void          // leagues calls this (R14)
isAllowed(categoryId, userId)                      => boolean             // registration calls this (R14)
registerPublishGate(gate: PublishGate)             => void                // composition root (R10)
```

## GraphQL

```graphql
Query.events(filter: EventFilter, first: Int = 20, after: String): EventConnection!
Query.event(slug: String!): Event

type Event implements Node {
  id: ID!
  slug: String!
  title: String!
  sport: Sport!
  venue: Venue
  city: String!
  startsAt: DateTime!
  registrationClosesAt: DateTime!
  status: EventStatus!             # LIVE flips the detail screen into Live Mode
  categories: [EventCategory!]!
  kind: EventKind!                 # TOURNAMENT | LEAGUE_SEASON — R11
  organizer: OrganizerSummary!     # backed by organizer_profiles — R13
  viewerRegistration: Registration # null unless the viewer registered
  tournament: Tournament           # bracket + standings, once drawn
}

type EventCategory implements Node {
  id: ID!
  name: String!
  format: MatchFormat!
  capacity: Int!
  entriesRemaining: Int!           # subtracts live holds — R5
  availability: Availability!      # OPEN | ALMOST_FULL | FULL | CLOSED
  priceQuote: PriceQuote!
}

type PriceQuote {
  entryFeePaise: Int!
  platformFeePaise: Int!
  taxPaise: Int!
  totalPaise: Int!
  currency: String!
}

input EventFilter {
  sportId: ID, city: String, near: GeoPointInput, radiusKm: Float,
  from: DateTime, to: DateTime, skillBand: String,
  format: MatchFormat, maxPricePaise: Int,
  kind: EventKind                  # R11
}
```

---

## Lifecycle

```
draft ──publish──▶ published ──first match starts──▶ live ──▶ completed
  │                    │
  └──────────────── cancelled
                       │
                       └─▶ payments.bulkRefund() for every confirmed registration
```

---

## Rules

**R1** — Publishing requires at least one category, a city or venue, and
`registration_closes_at < starts_at`. **Publish is the validation gate**; drafts may be incomplete.

**R2** — Once published, `starts_at`, fees and capacity may only change while a category has **zero
confirmed registrations**. After that they are frozen — players agreed to specific terms.

**R3** — `priceQuote` is the only place money is computed: `entry + platform fee + tax(bps)`. The
client never calculates a total, and `payments` calls this same function when creating an order.

**R4** — Availability is derived, never stored: `remaining ≤ 0` → `FULL`;
`remaining ≤ 10% of capacity` → `ALMOST_FULL`; past `registration_closes_at` → `CLOSED`.

**R5** — `capacityOf` subtracts **live seat holds** as well as confirmed entries. If the card says
two spots left while two people are in checkout, the third player pays and is then told the draw is
full. Counting holds makes the badge, the button and the database agree — worst case becomes "shows
full briefly, then reopens" instead of "took money, then refunded".

**R6** — Discovery reads only touch the partial index on `status IN ('published','live')`. Draft and
cancelled events are not in the index and are never listed. Radius search is capped at 50 km.

**R7** — Cancelling an event is irreversible and enqueues a **full refund including the platform
fee** for every confirmed registration.

**R8** — The `slug` is permanent once published. It is a deep link that will exist in someone's
WhatsApp forever.

**R9** — A category that has not reached its minimum entries at `registration_closes_at` is
auto-cancelled and fully refunded.

**R10** *(Sprint 7)* — Publishing a category with `entry_fee_paise > 0` also requires the event's
host's payout account to be `verified` (payouts R5, spec 2026-10-02-host-payouts). The check is a
`PublishGate` injected at the composition root, so `events` never imports `payments`. Platform staff
pass without an account. Free categories publish without it.

**R11** *(Sprint 13)* — `events.kind` is `tournament` or `league_season`. Discovery filters on it,
and that filter is the difference between "discover tournaments" and "discover leagues". Only
`leagues` creates league seasons, through `createForSeason`, and their categories use
`draw_type = 'round_robin'`.

**R12** *(Sprint 7)* — Moderation hides; it does not cancel. `hidden_at` is set only through
`moderate`, which `admin` calls. A hidden event leaves the discovery indexes (the partial predicate
includes `hidden_at IS NULL`), while its entrants, staff and deep links keep working. No money
moves; cancelling is R7.

**R13** *(Sprint 7)* — Every event belongs to an organizer profile. `organizer_profile_id` is added
nullable, backfilled with a personal organizer profile for each existing organizer user, then made
`NOT NULL`: expand, deploy, contract (architecture §8). `organizer_id` remains the creating user.

**R14** *(Sprint 13)* — A category may carry a **priority allow-list** with an `until` time. Before
`until`, only listed users may begin a registration (`PRIORITY_WINDOW`); after it, the list is
ignored. `leagues` writes the list for promotion and relegation (`leagues R4`), and `registration`
checks it in `begin` alongside the R7 eligibility check.

---

## Schema

```sql
CREATE TABLE events (
  id              uuid PRIMARY KEY,
  sport_id        uuid NOT NULL REFERENCES sports(id),
  organizer_id    uuid NOT NULL REFERENCES users(id),
  venue_id        uuid REFERENCES venues(id),
  slug            text UNIQUE NOT NULL,             -- permanent (R8)
  title           text NOT NULL,
  description     text,
  city            text NOT NULL,
  geo             geography(Point,4326),
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  registration_closes_at timestamptz NOT NULL,
  cancellation_cutoff_at timestamptz,               -- full refund before this
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','live','completed','cancelled')),
  cover_public_id text,                             -- Cloudinary public_id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The Explore query. Partial: unpublished events are never listed,
-- so they should not be in the index either. (R6)
CREATE INDEX events_discovery_idx ON events (sport_id, city, starts_at)
  WHERE status IN ('published','live');
CREATE INDEX events_geo_idx ON events USING gist (geo)
  WHERE status IN ('published','live');

CREATE TABLE event_categories (
  id                 uuid PRIMARY KEY,
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sport_id           uuid NOT NULL REFERENCES sports(id),
  name               text NOT NULL,                 -- "Men's Doubles 3.5"
  format             text NOT NULL,
  team_size          smallint NOT NULL DEFAULT 1,
  draw_type          text NOT NULL DEFAULT 'single_elim_with_plate',
  skill_min          numeric(4,2),  skill_max numeric(4,2),
  age_min            smallint,      age_max   smallint,
  capacity           integer NOT NULL CHECK (capacity > 0),
  min_entries        smallint NOT NULL DEFAULT 4,   -- R9
  entry_fee_paise    bigint NOT NULL,
  platform_fee_paise bigint NOT NULL DEFAULT 0,
  tax_bps            integer NOT NULL DEFAULT 1800, -- 18% GST in basis points
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','full','closed','drawn','completed','cancelled'))
);
CREATE INDEX ON event_categories (event_id);

CREATE TABLE event_media (
  id            uuid PRIMARY KEY,
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  public_id     text NOT NULL,                    -- Cloudinary public_id
  kind          text NOT NULL CHECK (kind IN ('cover','gallery','sponsor')),
  sort_order    smallint NOT NULL DEFAULT 0
);

-- Sprint 7 (R12, R13) and Sprint 13 (R11, R14) additions
ALTER TABLE events
  ADD COLUMN kind text NOT NULL DEFAULT 'tournament'
    CHECK (kind IN ('tournament','league_season')),                       -- R11
  ADD COLUMN hidden_at timestamptz,                                       -- R12
  ADD COLUMN organizer_profile_id uuid REFERENCES organizer_profiles(id); -- R13; NOT NULL after backfill

DROP INDEX events_discovery_idx;
DROP INDEX events_geo_idx;
CREATE INDEX events_discovery_idx ON events (sport_id, kind, city, starts_at)
  WHERE status IN ('published','live') AND hidden_at IS NULL;
CREATE INDEX events_geo_idx ON events USING gist (geo)
  WHERE status IN ('published','live') AND hidden_at IS NULL;

ALTER TABLE event_categories DROP CONSTRAINT IF EXISTS event_categories_draw_type_check;
ALTER TABLE event_categories ADD CONSTRAINT event_categories_draw_type_check
  CHECK (draw_type IN ('single_elim_with_plate','round_robin'));

CREATE TABLE event_category_allowlists (                                  -- R14
  event_category_id uuid NOT NULL REFERENCES event_categories(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id),
  until             timestamptz NOT NULL,
  PRIMARY KEY (event_category_id, user_id)
);
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `EVENT_NOT_FOUND` | user | Also for draft/cancelled to a non-organizer |
| `REGISTRATION_CLOSED` | user | Past `registration_closes_at` |
| `INVALID_EVENT_WINDOW` | user | Publish validation — R1 |
| `EVENT_HAS_ENTRIES` | user | Frozen-field edit attempt — R2 |
| `RADIUS_TOO_LARGE` | user | Over 50 km |
| `FORBIDDEN` | system | Not staff on this event |
| `ORGANIZER_NOT_VERIFIED` | user | Publish gate — R10 |
| `PAYOUT_ACCOUNT_REQUIRED` | user | Publish gate — R10 |
| `PRIORITY_WINDOW` | user | Show when open registration starts — R14 |

## Emits

| Event | Consumers |
|---|---|
| `event.published` | notifications, discovery |
| `event.cancelled` | payments, notifications, ticketing, discovery |
| `event.hidden` | discovery, notifications (staff) |
| `event.live` | notifications, realtime |
| `category.full` | notifications (waitlist) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `close-registration` | Delayed to `registration_closes_at` | 3 × exp | Alert |
| `refund-under-minimum` | At close, if entries < `min_entries` | 3 × exp | **Page** |
| `promote-to-live` | First match starts | 3 × exp | Alert |

---

## Done when

Explore returns correct results for a filter combining sport, city, date range, skill band and
price, at **p95 under 200 ms against 10,000 seeded events**. The price shown on the confirm screen
is byte-identical to the amount Razorpay is asked to charge.

---

## Implementation checklist

- [ ] Migration `005_events.sql` + the deferred `event_staff.event_id` FK from module 01
- [ ] `priceQuote()` as a pure function over the category row (R3) — unit tested with tax edge cases
- [ ] `capacityOf()` counting confirmed entries **and** unexpired holds (R5)
- [ ] Publish validation gate (R1); frozen-field guard after first confirmed entry (R2)
- [ ] Cursor pagination on `(starts_at, id)`
- [ ] Partial indexes + PostGIS radius search, 50 km cap
- [ ] Seed 10,000 events and measure the discovery query — this is the **Done when**
- [ ] `close-registration` and `refund-under-minimum` jobs
- [ ] Organizer mutations gated on `event_staff` via `identity.grantsFor`
- [ ] Tests naming R1, R2, R3, R4, R5, R7, R9
- [ ] *(Sprint 7)* `organizer_profile_id` expand → backfill → contract (R13)
- [ ] *(Sprint 7)* `PublishGate` injected at composition for paid categories (R10)
- [ ] *(Sprint 7)* `moderate` + `hidden_at` in both discovery index predicates (R12)
- [x] `events.kind` (default `tournament`) and `EventFilter.kind`; `EventFilter.query` over title and venue name, trigram-indexed (R11, discovery R1)
- [ ] *(Sprint 13)* `createForSeason`; category allow-lists (R11, R14)
- [ ] Tests naming R10, R11, R12, R13, R14

---

## Additions 2026-10-04 (flow review F3, F8, F12, F14, F16–F19, F21–F24, F27)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

- **F18** — After entries, the dates and place may still change until a draw is made or the event is live
  (then `EVENT_UNDER_WAY`). The change stamps `events.terms_changed_at` and emits `event.terms_changed`;
  entrants may withdraw in full for 48 h (`TERMS_CHANGE_WINDOW_MS`). A patch value equal to what is stored
  is not a change.
- **F16** — `min_entries` may go **down** after entries (not below the draw floor) while the draw still takes
  entries; raising it is a change of terms.
- **F8** — `registrationClosePreview(eventId)`: per open draw, confirmed, minimum, players paying, `willCancel`.
- **F19** — `removeEventCategory`: only a draw with no registration rows; a published event keeps one.
- **F21, F22** — `EventCategoryInput.tweaks` (points, games, sets, period minutes, overs), applied by the sport
  module's `tweakRule` and frozen in `event_categories.scoring_rule`. Every draw without one gets the sport's
  rule frozen at publish (or at add, once published). Scoring reads the frozen rule.
- **F14, F23, F24** — per draw: `match_minutes` (5–480), `third_place` (with `single_elim`), `prizes`,
  `rules_note`. `single_elim` joins `DRAW_TYPES` (floor 4).
- **F14** — event courts: `addEventCourt` / `removeEventCourt` (retire), `Event.courts`. Stored as
  `venue_courts` rows with `event_id` set and `venue_id` null.
- **F3** — `event_reports`: `reportEvent` (an entrant, from the start to 14 days after the end, one open per
  player; emits `event.reported`), `resolveEventReport` and `eventReports` (PL4Y staff), `Event.viewerReport`,
  `openReports(eventId)` for payouts. `OrganizerSummary.verified`, `eventsHosted`.
- **F12** — hourly `warn-short-categories`: a day before close, each draw short of its minimum emits
  `category.short` once (`short_warned_at`).
- **F27** — `events.refund_policy`: `standard` | `flexible`; after payment it may only become `flexible`.
- **F7** — a manager cannot re-add another manager as a scorer.
- `myHostedEvents` returns every event the user has any grant on; `Event.viewerRole`, `Event.location`.
- PL4Y staff read any event by slug, whatever its status (`findBySlugForStaff`).
