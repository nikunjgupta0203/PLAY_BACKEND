# 06 — registration

| | |
|---|---|
| **Sprint** | 4 |
| **Phase** | 1 |
| **Depends on** | events, payments, profile |
| **Owns** | `registrations`, `teams`, `team_members`, `registration_invites`, `seat_holds`, `waitlist_entries`, `partner_requests` |
| **Rule prefix** | `registration R*` |
| **Risk** | **Highest in the system — write the tests first** |

The five-step flow from the brief, as one state machine. Three failure modes here cost real money:
**overselling** a draw with physical courts, **double-charging** a player, and a **partner who never
accepts**.

> Start this module by writing the two tests in **Done when**. Not the resolvers. Not the schema
> browser. The tests.

---

## Service interface

```ts
begin(actor, { eventCategoryId })                => Registration
invitePartner(actor, { registrationId, email })  => Invite
acceptInvite(actor, token: string)               => Registration   // takes the hold
declineInvite(actor, token: string)              => void
confirmFromPayment(paymentId: string)            => Registration   // payments calls this
failFromPayment(paymentId, reason)               => Registration
expireHold(holdId: string)                       => void           // the job calls this
cancel(actor, registrationId)                    => Registration
checkIn(actor, registrationId)                   => Registration
listForEvent(actor, eventId, filter, page)       => Page<Registration>
listForUser(userId)                              => Registration[]
confirmedForCategory(categoryId)                 => Registration[]  // tournament calls this

// Phase 1 additions — Sprints 4, 5, 7
checkInToken(actor, registrationId)              => string          // QR payload (R13)
checkInByToken(actor, token)                     => Registration    // staff scan (R13)
checkInRoster(actor, eventId)                    => RosterEntry[]   // offline scanning (R13)
organizerAddEntry(actor, categoryId, input)      => Registration    // R14
substituteMember(actor, registrationId, { outUserId, inUserId }) => Registration   // R15
organizerWithdraw(actor, registrationId, { refundPaise, reason }) => Registration  // R16
joinWaitlist(actor, { eventCategoryId })         => Registration    // R17
leaveWaitlist(actor, registrationId)             => Registration
promoteWaitlist(categoryId)                      => Registration | null   // job
// Phase 2 — Sprint 11
postPartnerRequest(actor, { eventCategoryId, note }) => PartnerRequest    // R20
withdrawPartnerRequest(actor, requestId)         => void
partnerRequestsFor(categoryId, page)             => Page<PartnerRequest>
```

## GraphQL

```graphql
Mutation.beginRegistration(input: BeginRegistrationInput!): BeginRegistrationPayload!
Mutation.invitePartner(input: InvitePartnerInput!): InvitePartnerPayload!
Mutation.acceptPartnerInvite(token: String!): AcceptPartnerInvitePayload!
Mutation.declinePartnerInvite(token: String!): DeclinePartnerInvitePayload!
Mutation.cancelRegistration(registrationId: ID!): CancelRegistrationPayload!
Mutation.checkIn(registrationId: ID!): CheckInPayload!
Mutation.checkInByToken(token: String!): CheckInPayload!                               # R13
Mutation.organizerAddEntry(input: OrganizerAddEntryInput!): RegistrationPayload!       # R14
Mutation.substituteTeamMember(input: SubstituteInput!): RegistrationPayload!           # R15
Mutation.organizerWithdrawEntry(input: OrganizerWithdrawInput!): RegistrationPayload!  # R16
Mutation.joinWaitlist(eventCategoryId: ID!): RegistrationPayload!                      # R17
Mutation.leaveWaitlist(registrationId: ID!): RegistrationPayload!
Mutation.postPartnerRequest(input: PartnerRequestInput!): PartnerRequestPayload!       # R20
Mutation.withdrawPartnerRequest(requestId: ID!): PartnerRequestPayload!
Query.checkInRoster(eventId: ID!): [RosterEntry!]!                                     # staff — R13

type Registration implements Node {
  id: ID!
  event: Event!
  category: EventCategory!
  status: RegistrationStatus!
  team: Team
  amountPaise: Int!
  holdExpiresAt: DateTime      # non-null while payment_pending
  seed: Int                    # set at draw time
  checkInQr: String            # team members only, confirmed entries — R13
  waitlistPosition: Int        # non-null while waitlisted — R17
  paymentMode: PaymentMode!    # ONLINE | OFFLINE | COMP — R14
  createdAt: DateTime!
}
```

---

## State machine

```
              ┌──────────────── expired ◀──── hold TTL / invite TTL
              │
draft ──▶ awaiting_partner ──▶ payment_pending ──▶ confirmed ──▶ checked_in
  │                                  │                 │
  └────▶ payment_pending             ▼                 ▼
         (singles)             payment_failed        refunded / withdrawn
```

| From | Trigger | To | In the same transaction |
|---|---|---|---|
| — | `begin` | `draft` | Price quote frozen onto `amount_paise` |
| `draft` | `invitePartner` | `awaiting_partner` | Invite + token; email and push. **No hold** |
| `awaiting_partner` | `acceptInvite` | `payment_pending` | Team written; hold acquired; expiry job scheduled |
| `draft` | `begin` (singles) | `payment_pending` | Hold acquired; order created; expiry job scheduled |
| `payment_pending` | `confirmFromPayment` | `confirmed` | Hold consumed; confirmation push; capacity recount |
| `payment_pending` | `failFromPayment` | `payment_failed` | Hold left alive until TTL |
| `payment_failed` | `confirmFromPayment` | `confirmed` | Only while the hold is live (same-order retry captured after the failure); hold consumed. Otherwise payments refunds the capture in full (`late_capture`) |
| `payment_pending` | `expireHold` | `expired` | Hold released; capacity returns; waitlist promoted |
| `awaiting_partner` | invite expiry | `expired` | Captain notified with a one-tap re-invite |
| `confirmed` | `cancel` | `refunded` | Refund per policy; slot returns; waitlist promoted |
| `confirmed` | `checkIn` | `checked_in` | Organizer dashboard count updates |
| `confirmed` | `checkInByToken` | `checked_in` | Same guard as `checkIn` (R10, R13) |
| `payment_pending` | `confirmFree` | `confirmed` | Zero-total category; no order; hold consumed (R18) |
| `draft` | `joinWaitlist` | `waitlisted` | Category full; **no hold** (R17) |
| `awaiting_partner` | `acceptInvite` while full | `waitlisted` | Team written; **no hold** (R17) |
| `waitlisted` | `promoteWaitlist` | `payment_pending` | Hold acquired through the R4 query; offer notified (R17) |
| `waitlisted` | `leaveWaitlist` | `withdrawn` | Position released |
| — | `organizerAddEntry` | `confirmed` | Capacity through the R4 query; `payment_mode` offline or comp (R14) |
| `confirmed` | `organizerWithdraw` | `withdrawn` | Refund at organizer discretion; slot returns; walkovers after the draw (R16) |

---

## Rules

**R1** — A player may hold at most one live entry per category. Enforced by a **unique partial
index**, not by a read-then-write check.

**R2** — **No seat hold is taken while a registration awaits a partner.** A 48-hour hold would let
one player park a slot in a popular draw for two days. Capacity is reserved when the team becomes
real.

**R3** — Hold TTL is 10 minutes; partner invite TTL is 48 hours. Both are config, not literals.

**R4** — Capacity is decided inside a transaction that takes `FOR UPDATE` on the category row and
counts confirmed entries plus unexpired holds. An insert that would exceed capacity **returns zero
rows**, which the caller maps to `CATEGORY_FULL` — no exception, no retry loop.

**R5** — An expired hold stops blocking capacity **the instant it expires**, because the count
predicate is `expires_at > now()`. The release job flips `released_at` and moves the registration to
`expired`; it is not what makes capacity correct.

**R6** — The captain pays for the whole team. Split payment is deferred: it needs a second payment
state machine and lets a partner strand a confirmed entry.

**R7** — A partner must satisfy the category's skill and age constraints. Validated **at accept**,
not at invite, because the partner may not have had an account at invite time.

**R8** — Payment failure leaves the hold alive until its TTL so a retry does not lose the slot. Only
expiry releases it.

**R9** — Cancelling after `cancellation_cutoff_at` refunds nothing but **still returns the slot** and
promotes the waitlist. Punishing the player should not punish the draw.

**R10** — Check-in is allowed only within two hours either side of the event start, and only for
`confirmed` entries.

**R11** — Every transition goes through **one guard function** consulting the table above. There is
no other write path to `registrations.status`, and a disallowed transition throws
`ILLEGAL_TRANSITION` rather than silently no-opping.

**R12** — Partner invites go to an **email address** ([ADR 0002](../decisions/0002-email-otp-via-resend.md)).
Because players know each other's phone numbers and not each other's emails, `invitePartner` must
also accept an existing PL4Y player selected by in-app search — display name or email — and fall
back to typing an address only when the partner has no account. Typing an email you may not know is
the friction most likely to cost doubles registrations, and this is the mitigation for it.

`invitePartner` takes `playerId` (the `PlayerProfile.id` search returns), `playerUserId`, or
`email` — in that order of preference.

A private profile is refused the same as an unknown id (profile R4 — not distinguishable from
missing), whether addressed by `playerId` or `playerUserId`. When the invitee is resolved from an
account id rather than typed by the captain, the `Invite` handed back has its `invitedEmail`
masked (e.g. `a•••@example.com`); the real address is still what is stored and emailed.

> **Watch this:** doubles entries that reach `awaiting_partner` but never reach `payment_pending`.
> If that ratio degrades against singles, revisit ADR 0002 rather than blaming the funnel.

**R13** *(Sprint 5)* — **QR check-in.** A confirmed entry's QR carries
`base64url(registrationId ‖ keyId ‖ HMAC-SHA256(CHECKIN_TOKEN_SECRET, registrationId))`. Rendering
it writes no row, and `keyId` lets the secret rotate. Staff with any event grant scan it into
`checkInByToken`, which goes through the same guard as `checkIn` (R10, R11). The scan is
idempotent: re-scanning a checked-in entry returns it unchanged, with the original time. Staff
devices may download `checkInRoster` (token hashes, names, category) to scan offline, then replay
check-ins on reconnect.

**R14** *(Sprint 7)* — **Manual entries.** Until the draw is generated, an `owner` or `manager` may
add an entry for a player who paid offline or is complimentary (`payment_mode = 'offline' | 'comp'`).
The entry goes through the **same capacity query** (R4), the same one-live-entry index (R1) and the
same eligibility check (R7); there is no bypass. No ledger row is written, since no money passed
through the platform. Organizer analytics reports offline entries separately.

**R15** *(Sprint 7)* — **Substitution.** Before the draw, the captain (by sending a new invite) or
an `owner`/`manager` (directly) may replace a team member. After the draw, only an
`owner`/`manager` may, and only for an entry that has no completed match. The incoming player must
pass R7 and must not already hold a live entry in the category. Completed matches keep their
original players for rating.

**R16** *(Sprint 7)* — **Organizer withdrawal.** An `owner` or `manager` may withdraw a confirmed
entry, giving a reason and a refund amount at their discretion (the "organizer discretion" row of
the payments refund policy). Before the draw, the slot returns and the waitlist is promoted. After
the draw, every unplayed match of the entry becomes a walkover to the opponent
(`tournament R18`).

**R17** *(Sprint 5)* — **Waitlist.** When a player begins a registration for a full category, they
are offered the waitlist. A waitlisted entry is a registration in `waitlisted`, ordered by
`waitlist_entries.created_at`, and it holds **no seat** (R2). A doubles team can join the waitlist
only after the partner has accepted. When capacity returns, `promote-waitlist` moves the head of
the list to `payment_pending` by acquiring a hold through the R4 query, with a **30-minute** TTL
(config). An offer made during quiet hours (`notifications R3`) expires at **08:00 IST** instead.
If an offer lapses, the entry expires and the next one is promoted.

**R18** *(Sprint 4)* — **Free categories.** When the quote total is zero, the hold is acquired and
the entry confirmed **in the same transaction** through `confirmFree`. No payment order exists.
Capacity is still decided by R4.

**R19** *(Sprint 13)* — In team-format leagues, `begin` may take a `communityTeamId`. The roster is
**copied** into `team_members` at that moment, and later roster changes in `communities` do not
alter the entry; `leagues R7` governs mid-season additions.

**R20** *(Sprint 11)* — **Partner requests.** A player may post an open request for a partner in a
doubles category, with a note. The request creates **no registration and no hold**. It is visible
to eligible players through `EventCategory.partnerRequests` and ranked by `discovery R8`. A player
may have one open request per category; it closes at `registration_closes_at`, or when that player
begins an entry.

---

## The capacity query

```sql
-- Zero rows returned means "full". The caller maps that to CATEGORY_FULL. (R4)
WITH locked AS (
  SELECT id, capacity FROM event_categories WHERE id = $1 FOR UPDATE
),
used AS (
  SELECT
    (SELECT count(*) FROM registrations
      WHERE event_category_id = $1
        AND status IN ('confirmed','checked_in','payment_pending'))        AS taken,
    (SELECT coalesce(sum(seats),0) FROM seat_holds
      WHERE event_category_id = $1
        AND released_at IS NULL
        AND expires_at > now())                                            AS held
)
INSERT INTO seat_holds (id, event_category_id, registration_id, seats, expires_at)
SELECT $2, locked.id, $3, 1, now() + interval '10 minutes'
  FROM locked, used
 WHERE used.taken + used.held + 1 <= locked.capacity
RETURNING id, expires_at;
```

---

## Schema

```sql
CREATE TABLE teams (
  id              uuid PRIMARY KEY,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  name            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  is_captain      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE registrations (
  id              uuid PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES events(id),
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  sport_id        uuid NOT NULL REFERENCES sports(id),
  captain_user_id uuid NOT NULL REFERENCES users(id),      -- the payer (R6)
  team_id         uuid REFERENCES teams(id),               -- null for singles
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN (
                    'draft','awaiting_partner','payment_pending','confirmed',
                    'checked_in','withdrawn','expired','payment_failed','refunded')),
  seed            integer,
  amount_paise    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz
);

-- R1
CREATE UNIQUE INDEX reg_one_live_per_player
  ON registrations (event_category_id, captain_user_id)
  WHERE status IN ('awaiting_partner','payment_pending','confirmed','checked_in');

CREATE TABLE registration_invites (
  id              uuid PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  invited_email   citext NOT NULL,        -- the partner may have no account yet
  invited_user_id uuid REFERENCES users(id),
  token           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','declined','expired')),
  expires_at      timestamptz NOT NULL,   -- +48h (R3)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON registration_invites (invited_email) WHERE status = 'pending';

-- Correctness lives in Postgres, not Redis: a lost key here means an
-- oversold tournament with physical courts.
CREATE TABLE seat_holds (
  id                uuid PRIMARY KEY,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  registration_id   uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  seats             smallint NOT NULL DEFAULT 1,
  expires_at        timestamptz NOT NULL,
  released_at       timestamptz
);
CREATE INDEX seat_holds_active_idx ON seat_holds (event_category_id)
  WHERE released_at IS NULL;

-- R13–R20 additions
ALTER TABLE registrations
  ADD COLUMN payment_mode text NOT NULL DEFAULT 'online'
    CHECK (payment_mode IN ('online','offline','comp')),         -- R14
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN checked_in_by uuid REFERENCES users(id),             -- R13
  ADD COLUMN source_community_id uuid,                            -- R19; FK in 017_communities
  ADD COLUMN withdrawn_reason text;                               -- R16
ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check CHECK (status IN (
  'draft','awaiting_partner','waitlisted','payment_pending','confirmed',
  'checked_in','withdrawn','expired','payment_failed','refunded'));

-- R1 now treats a waitlisted entry as live.
DROP INDEX reg_one_live_per_player;
CREATE UNIQUE INDEX reg_one_live_per_player
  ON registrations (event_category_id, captain_user_id)
  WHERE status IN ('awaiting_partner','waitlisted','payment_pending','confirmed','checked_in');

CREATE TABLE waitlist_entries (                                   -- R17
  registration_id   uuid PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  offered_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON waitlist_entries (event_category_id, created_at) WHERE offered_at IS NULL;

CREATE TABLE partner_requests (                                   -- R20
  id                uuid PRIMARY KEY,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  note              text CHECK (char_length(note) <= 280),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_request_one_open
  ON partner_requests (event_category_id, user_id) WHERE status = 'open';
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `CATEGORY_FULL` | user | "Event full" empty state; offer the waitlist |
| `HOLD_EXPIRED` | user | Return to Step 1, explain the slot was released |
| `ALREADY_REGISTERED` | user | Route to the existing registration |
| `PARTNER_ALREADY_ENTERED` | user | Inline on the partner field |
| `PARTNER_INELIGIBLE` | user | Inline — skill band or age — R7 |
| `INVITE_EXPIRED` | user | Offer re-invite |
| `CHECKIN_WINDOW_CLOSED` | user | Show the window |
| `NO_SPORT_SELECTED` | user | Route to profile setup |
| `ILLEGAL_TRANSITION` | system | Bug. Log loudly |
| `CHECKIN_TOKEN_INVALID` | user | Red scan screen — R13 |
| `WAITLIST_OFFER_EXPIRED` | user | Offer to rejoin the waitlist — R17 |
| `SUBSTITUTION_LOCKED` | user | Entry already has a completed match — R15 |
| `PRIORITY_WINDOW` | user | Show when open registration starts — events R14 |
| `PARTNER_REQUEST_EXISTS` | user | Show the open request — R20 |

## Emits

| Event | Consumers |
|---|---|
| `registration.confirmed` | notifications, realtime |
| `registration.expired` | notifications, realtime |
| `registration.payment_failed` | realtime |
| `registration.cancelled` | realtime |
| `hold.created` | registration (`release-hold`), realtime |
| `invite.created` | notifications, realtime |
| `invite.declined` | realtime |
| `capacity.changed` | events (cache bust) |
| `registration.begun` | organizers (analytics) |
| `registration.checked_in` | organizers (analytics), realtime |
| `registration.withdrawn` | tournament (walkovers), payments, notifications |
| `waitlist.offered` | notifications |
| `partner_request.created` | discovery |

`realtime` = `registration.updated` on `private-user-{id}` for every entrant — see
[00-platform § Realtime](./00-platform.md#realtime).

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `release-hold` | Delayed +10 min | 3 × exp | **Alert** — capacity stuck |
| `expire-invite` | Delayed +48 h | 3 × exp | Log; nightly sweep |
| `sweep-stale-holds` | Every 5 min | 3 × exp | Alert |
| `promote-waitlist` | On capacity release | 3 × exp | Alert |
| `close-partner-requests` | At `registration_closes_at` | 3 × exp | Drop |

---

## Done when

Two tests pass, and they are written **before any resolver in this module exists**.

1. **Capacity holds under concurrency.** Fire fifty concurrent registrations at a ten-entry
   category and assert exactly ten confirm — never eleven, never nine.
2. **Payment confirmation is idempotent.** Deliver the same `payment.captured` webhook five times
   and assert one confirmed registration, one payment row, one ledger entry, one push.

---

## Implementation checklist

- [ ] **Write the two Done-when tests first.** They will fail. Good.
- [ ] Migration `006_registration.sql` including the unique partial index (R1)
- [ ] Transition guard function + table; make `status` unwritable elsewhere (R11)
- [ ] `acquireHold` raw SQL with `FOR UPDATE` (R4) — zero rows ⇒ `CATEGORY_FULL`
- [ ] `release-hold` delayed job + `sweep-stale-holds` safety net (R5)
- [ ] Partner invite: token generation, email + push, deep link, bind-on-signup
- [ ] **Player search in the invite field** (R12) — the mitigation for email-based invites
- [ ] Funnel metric: `awaiting_partner` entries that never reach `payment_pending`
- [ ] Eligibility check at accept, not invite (R7)
- [ ] `confirmFromPayment` / `failFromPayment` as the only entry points from `payments`
- [ ] Cancellation policy windows; call `payments.refund()` (R9)
- [ ] Check-in window guard (R10)
- [ ] Waitlist promotion on capacity release
- [ ] Tests naming R1, R2, R4, R5, R7, R8, R9, R10, R11, R12
- [ ] *(Sprint 4)* `confirmFree` for zero-total categories (R18)
- [ ] *(Sprint 5)* `waitlisted` status, `waitlist_entries`, 30-minute offers with the quiet-hours rule (R17)
- [ ] *(Sprint 5)* Signed check-in token, `checkInByToken`, offline roster (R13); `CHECKIN_TOKEN_SECRET` in config
- [ ] *(Sprint 7)* Manual entries through the R4 query (R14); substitution (R15); organizer withdrawal (R16)
- [ ] *(Sprint 11)* Partner requests (R20)
- [ ] *(Sprint 13)* Community team roster snapshot (R19)
- [ ] Tests naming R13, R14, R15, R16, R17, R18, R20

---

## Additions 2026-10-04 (flow review F2, F13, F18, F20, F27)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

- **F2** — `removeRegistration` always refunds an online-paid entry in full; `refund` only matters for cash
  and comp entries.
- **F13** — check-in opens 2 h before the start and stays open until the end (at least 2 h after the start).
  Staff check anyone in. Self check-in sends `at` (the phone's location) and must be within
  `SELF_CHECKIN_RADIUS_M` (1 km) of the event's pin or venue when either is known
  (`CHECKIN_LOCATION_REQUIRED`, `CHECKIN_TOO_FAR`). Scorers may read the entry list.
- **F18** — within 48 h of `terms_changed_at`, a withdrawal is refunded in full whatever the cutoff.
- **F27** — under `flexible`, a withdrawal after the cutoff and before the start refunds half the entry fee
  (`FLEXIBLE_LATE_REFUND_BPS`); the entry is `withdrawn`.
- **F20** — `addOfflineRegistration` takes an email **or** `guestName`, and for doubles `partnerEmail` or
  `partnerName`; it seats into `open`, `full` or `closed` draws (not drawn). A guest is a `users` row with
  `is_guest`, an address on `guest.pl4y.invalid`, never emailed (the transport drops it).
- PL4Y staff read any event's entry list.
