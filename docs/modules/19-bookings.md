# 19 — bookings

| | |
|---|---|
| **Sprint** | 14 |
| **Phase** | **3** |
| **Depends on** | identity, venues, payments, notifications |
| **Owns** | `venue_booking_policies`, `court_availability_rules`, `court_blackouts`, `court_bookings` |
| **Rule prefix** | `bookings R*` |
| **Risk** | **Money + a double-booked physical court** |

Court availability, bookings, and the venue management dashboard. Architecture §9 deferred this
as "a second commerce domain". This spec is that domain, written so it reuses every correctness
lesson from `registration` and `payments` rather than relearning them.

`venues R4` still stands. `venues.freeCourts` is a tournament-scheduling concept. **This** module
is the booking API.

---

## Service interface

```ts
availability(venueId, date, { sportId?, durationMinutes? })  => CourtSlot[]
quote(courtId, { startsAt, endsAt })                          => BookingQuote      // R5
hold(actor, { courtId, startsAt, endsAt })                    => { booking, order } // R2
confirmFromPayment(paymentId)                                 => Booking            // payments calls this
failFromPayment(paymentId, reason)                            => Booking
expireHold(bookingId)                                         => void
cancel(actor, bookingId)                                      => Booking            // player, R6
venueCancel(staff, bookingId, reason)                         => Booking            // full refund
createWalkIn(staff, { courtId, startsAt, endsAt, name, phone, paymentMode }) => Booking   // R8
checkIn(staff, bookingId) / markNoShow(staff, bookingId)      => Booking
setAvailabilityRules(staff, courtId, rules[])                 => void
addBlackout(staff, { courtId?, venueId, startsAt, endsAt, kind, note }) => Blackout
setPolicy(staff, venueId, policy)                             => BookingPolicy
schedule(staff, venueId, date)                                => CourtSchedule      // dashboard grid
dashboard(staff, venueId, { from, to })                       => VenueDashboard     // occupancy, revenue
listForUser(userId, page)                                     => Page<Booking>
```

## GraphQL

```graphql
Query.courtAvailability(venueId: ID!, date: Date!, sportId: ID, durationMinutes: Int = 60): [CourtSlot!]!
Query.venueSchedule(venueId: ID!, date: Date!): CourtSchedule!          # venue staff
Query.venueDashboard(venueId: ID!, from: Date!, to: Date!): VenueDashboard!   # owner / manager

type Viewer { bookings(first: Int = 20, after: String): BookingConnection! }

type CourtSlot {
  court: Court!
  startsAt: DateTime!
  endsAt: DateTime!
  pricePaise: Int!
  available: Boolean!
}

type Booking {
  id: ID!
  venue: Venue!
  court: Court!
  startsAt: DateTime!
  endsAt: DateTime!
  status: BookingStatus!      # HELD | CONFIRMED | CHECKED_IN | CANCELLED | EXPIRED | NO_SHOW | PAYMENT_FAILED
  amountPaise: Int!
  holdExpiresAt: DateTime
}

Mutation.holdCourtBooking(input: HoldCourtBookingInput!): HoldCourtBookingPayload!   # returns razorpay order
Mutation.cancelCourtBooking(bookingId: ID!): BookingPayload!
Mutation.createWalkInBooking(input: WalkInInput!): BookingPayload!
Mutation.checkInBooking(bookingId: ID!): BookingPayload!
Mutation.markBookingNoShow(bookingId: ID!): BookingPayload!
Mutation.setCourtAvailability(input: CourtAvailabilityInput!): CourtAvailabilityPayload!
Mutation.addCourtBlackout(input: CourtBlackoutInput!): CourtBlackoutPayload!
Mutation.setVenueBookingPolicy(input: BookingPolicyInput!): BookingPolicyPayload!
```

---

## Rules

**R1** — **No double-booking, enforced by Postgres.** `court_bookings` carries an exclusion
constraint over `(court_id, tstzrange(starts_at, ends_at))` for rows in `held`, `confirmed` or
`checked_in`. As with seat holds, correctness never lives in Redis: a lost key would put two groups
on one physical court.

**R2** — Hold, then pay. A booking starts `held` with a **10-minute TTL** (config) and a payment
order (`payments R20`, subject `booking`). It confirms **only** on a verified `payment.captured`
or on reconciliation (`payments R5`).

**R3** — An expired hold must stop blocking **the instant it expires**, but an exclusion constraint
cannot use `now()`. So the insert path first expires stale holds on the same court, in the same
transaction, before inserting:

```sql
UPDATE court_bookings SET status = 'expired'
 WHERE court_id = $1 AND status = 'held' AND hold_expires_at <= now()
   AND tstzrange(starts_at, ends_at) && tstzrange($2, $3);
INSERT INTO court_bookings (...) VALUES (...);   -- exclusion constraint decides
```

The `release-booking-hold` job and the one-minute sweep tidy up, but they are not what makes
availability correct. This is the same principle as `registration R5`.

**R4** — Availability is derived, never stored: opening rules, minus blackouts, minus live
bookings. An event that uses a venue's courts **reserves them as a blackout** of kind `event`,
created by venue staff when they accept the organizer's reservation. The tournament scheduler then
assigns only among courts reserved to that event. Tournament play and public bookings never
compete for one court at runtime.

**R5** — `quote()` is the only place booking money is computed: the slot price from the rule
matching weekday and time band, times duration, plus platform fee, plus tax (bps). It is frozen
onto the booking at hold time. `payments` calls the same function, as with `events R3`.

**R6** — Cancellation policy is per venue, with defaults: **full refund ≥ 24 h** before start,
**50% ≥ 6 h**, **nothing after**. Platform fee is retained on player cancellation and refunded on
venue cancellation. Refunds go through `payments.refund` (idempotent, `payments R7`).

**R7** — The venue dashboard is gated by `venue_staff` grants (`identity R17`). `desk` can view the
schedule, create walk-ins, check in and mark no-shows. `manager` also edits rules, prices,
blackouts and policy. `owner` also manages staff and the payout account. Grants are read per
request, like event grants.

**R8** — Walk-in and phone bookings pass through the **same exclusion constraint**, with
`payment_mode = 'offline'`. The desk has no bypass. Offline money never enters the ledger, but it
is reported separately on the dashboard.

**R9** — Venue payouts use a payout account with `owner_type = 'venue'` (`payments R13`) and settle
**weekly** for confirmed bookings whose start time has passed (`payments R14`).

**R10** — Anti-hoarding: bookable up to **14 days** ahead (venue-configurable, maximum 60); slots of
30 minutes or more; at most **3 hours per user per venue per day**; at most **2 concurrent holds**
per user.

**R11** — Open-play sessions at a bookable venue (`games R8`) reserve their courts with
`confirmed` bookings of `kind = 'open_play'` created by venue staff. A game never books courts on
its own.

**R12** — No-shows are marked by the desk. **Three in 60 days** records a fraud signal
(`admin R8`). There is no automatic ban.

---

## Schema

```sql
CREATE TABLE venue_booking_policies (
  venue_id              uuid PRIMARY KEY REFERENCES venues(id),
  bookable              boolean NOT NULL DEFAULT false,
  advance_days          smallint NOT NULL DEFAULT 14 CHECK (advance_days BETWEEN 1 AND 60),
  min_slot_minutes      smallint NOT NULL DEFAULT 60 CHECK (min_slot_minutes >= 30),
  full_refund_hours     smallint NOT NULL DEFAULT 24,
  partial_refund_hours  smallint NOT NULL DEFAULT 6,
  partial_refund_bps    integer  NOT NULL DEFAULT 5000,
  platform_fee_paise    bigint   NOT NULL DEFAULT 0,
  tax_bps               integer  NOT NULL DEFAULT 1800,
  timezone              text     NOT NULL DEFAULT 'Asia/Kolkata'
);

CREATE TABLE court_availability_rules (
  id              uuid PRIMARY KEY,
  court_id        uuid NOT NULL REFERENCES venue_courts(id),
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at        time NOT NULL,
  closes_at       time NOT NULL CHECK (closes_at > opens_at),
  price_per_hour_paise bigint NOT NULL CHECK (price_per_hour_paise >= 0),
  sport_ids       uuid[] NOT NULL DEFAULT '{}'      -- empty = every sport the court serves
);
CREATE INDEX ON court_availability_rules (court_id, weekday);

CREATE TABLE court_blackouts (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL REFERENCES venues(id),
  court_id        uuid REFERENCES venue_courts(id),  -- null = whole venue
  kind            text NOT NULL CHECK (kind IN ('maintenance','event','private','holiday')),
  event_id        uuid REFERENCES events(id),        -- kind = 'event' (R4)
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL CHECK (ends_at > starts_at),
  note            text,
  created_by      uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX court_blackouts_range_idx ON court_blackouts
  USING gist (venue_id, tstzrange(starts_at, ends_at));

CREATE TABLE court_bookings (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL REFERENCES venues(id),
  court_id        uuid NOT NULL REFERENCES venue_courts(id),
  user_id         uuid REFERENCES users(id),         -- null for walk-ins
  walk_in_name    text,
  walk_in_phone   text,
  kind            text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','open_play')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL CHECK (ends_at > starts_at),
  status          text NOT NULL DEFAULT 'held' CHECK (status IN
                    ('held','confirmed','checked_in','cancelled','expired','no_show','payment_failed')),
  payment_mode    text NOT NULL DEFAULT 'online' CHECK (payment_mode IN ('online','offline','comp')),
  hold_expires_at timestamptz,
  amount_paise    bigint NOT NULL,                   -- frozen quote (R5)
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR walk_in_name IS NOT NULL),
  -- R1: no double-booking among live rows.
  EXCLUDE USING gist (
    court_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('held','confirmed','checked_in'))
);
CREATE INDEX ON court_bookings (user_id, starts_at DESC);
CREATE INDEX ON court_bookings (venue_id, starts_at);
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `SLOT_UNAVAILABLE` | user | The exclusion constraint fired; refresh availability |
| `BOOKING_HOLD_EXPIRED` | user | Return to the slot picker |
| `OUTSIDE_BOOKING_WINDOW` | user | R10 |
| `BOOKING_LIMIT_EXCEEDED` | user | R10 |
| `VENUE_NOT_BOOKABLE` | user | Venue has no booking policy enabled |
| `CANCELLATION_WINDOW_CLOSED` | user | Explain the policy — R6 |
| `FORBIDDEN` | system | Not venue staff — R7 |

## Emits

| Event | Consumers |
|---|---|
| `booking.confirmed` | notifications, venues (visits projection) |
| `booking.cancelled` | notifications, payments |
| `booking.completed` | venues (review eligibility — venues R6) |
| `booking.no_show` | admin (fraud — R12) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `release-booking-hold` | Delayed +10 min | 3 × exp | Alert |
| `sweep-booking-holds` | Every minute | 3 × exp | Alert |
| `booking-reminder` | 2 h before start | 3 × exp | Drop |
| `complete-bookings` | Hourly — past `ends_at` | 3 × exp | Drop |

---

## Done when

Fifty concurrent holds on the same court and slot produce **exactly one** booking. An expired hold
frees its slot for the very next insert, **without waiting for the sweep**. A court reserved for a
tournament shows unavailable to players. A desk walk-in on a held slot is refused. A cancellation
25 hours before start refunds the entry amount in full, exactly once.

---

## Implementation checklist

- [ ] **Write the concurrency test first** (the Done when), before any resolver
- [ ] Migration `019_bookings.sql` with the partial exclusion constraint (needs `btree_gist`)
- [ ] Expire-then-insert in one transaction (R3)
- [ ] `quote()` as a pure function; `payments` subject `booking` (R5, payments R20)
- [ ] Availability derivation including event blackouts (R4)
- [ ] Venue dashboard: schedule grid, walk-ins, check-in, no-show; grants via `identity R17` (R7, R8)
- [ ] Cancellation policy with refunds through `payments.refund` (R6)
- [ ] Weekly venue payouts (R9)
- [ ] Anti-hoarding limits (R10)
- [ ] Tests naming R1, R2, R3, R4, R5, R6, R7, R8, R10
