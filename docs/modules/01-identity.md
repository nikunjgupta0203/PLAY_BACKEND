# 01 — identity

| | |
|---|---|
| **Sprint** | 1 |
| **Phase** | 1 |
| **Depends on** | nothing |
| **Blocks** | everything |
| **Owns** | `users`, `otp_challenges`, `refresh_tokens`, `event_staff`, `platform_staff`, `venue_staff` |
| **Rule prefix** | `identity R*` |

Who a user is, how they prove it, and what they are allowed to do.

**Email-first.** A six-digit code is delivered by email through Resend; there is no SMS provider.
Phone number is optional, unverified contact information. See
[ADR 0002](../decisions/0002-email-otp-via-resend.md) for the reasoning and the risks.

**Organizer permission is a grant on an event, never a role on a person.**

---

## Service interface

```ts
requestOtp(email: string, purpose: OtpPurpose)    => { challengeId, retryAfterSeconds }
verifyOtp(email: string, code: string, device?)   => { access, refresh, isNewUser }
rotateSession(refreshToken: string)               => { access, refresh }
revokeSession(actor: Actor, sessionId: string)    => void
revokeAllSessions(userId: string)                 => void
setPhone(actor, phone: E164 | null)               => User      // contact only (R12)
grantsFor(userId: string, eventId: string)        => Grant | null
grantsForUser(userId: string)                     => Grant[]
addStaff(actor, eventId, userId, role)            => Grant
removeStaff(actor, eventId, userId)               => void
suspend(actor: AdminActor, userId, reason)        => void
handleDeliveryEvent(payload)                      => void      // Resend webhook (R13)
reinstate(actor: AdminActor, userId, reason)      => void      // R18
requestAccountDeletion(actor)                     => void      // R18
platformRoleFor(userId: string)                   => PlatformRole | null      // R15
setPlatformRole(tx, actor: AdminActor, userId, role | null) => void           // admin calls this
syncOrganizerGrants(tx, { organizerProfileId, userId, eventIds, role | null }) => void  // R16
venueGrantsFor(userId: string, venueId: string)   => VenueGrant | null        // R17
addVenueStaff(tx, actor, venueId, userId, role)   => VenueGrant
removeVenueStaff(actor, venueId, userId)          => void
```

`Grant` is `{ eventId, role: 'owner' | 'manager' | 'scorer' }`. When a user holds grants from more
than one source on the same event, `grantsFor` returns the highest (R16).
`PlatformRole` is `'admin' | 'support' | 'finance'`. `VenueGrant` is
`{ venueId, role: 'owner' | 'manager' | 'desk' }`.

## GraphQL

```graphql
Query.me: Viewer

Mutation.requestOtp(email: String!): RequestOtpPayload!
Mutation.verifyOtp(email: String!, code: String!): VerifyOtpPayload!
Mutation.refreshSession(refreshToken: String!): RefreshSessionPayload!
Mutation.logout(allDevices: Boolean = false): LogoutPayload!
Mutation.setContactPhone(phone: String): ViewerPayload!
Mutation.addEventStaff(input: AddEventStaffInput!): AddEventStaffPayload!
Mutation.removeEventStaff(input: RemoveEventStaffInput!): RemoveEventStaffPayload!
Mutation.addVenueStaff(input: AddVenueStaffInput!): AddVenueStaffPayload!          # R17
Mutation.removeVenueStaff(input: RemoveVenueStaffInput!): RemoveVenueStaffPayload!
Mutation.requestAccountDeletion: RequestAccountDeletionPayload!                    # R18
```

Resend's delivery webhook is **not** GraphQL. It is `POST /webhooks/resend`, signature-verified,
alongside the Razorpay webhook.

---

## Rules

**R1** — OTP is six digits, argon2id-hashed at rest, ten-minute TTL. The plaintext code is never
stored and never logged, at any level.

**R2** — Five verification attempts per challenge, then the challenge burns regardless of remaining
TTL.

**R3** — Send limits, sliding window in Postgres (`rate_limit_hits`): **3 per email per 15 min**, **20 per IP per hour**,
**200 per IP per day**. Exceeding any returns `OTP_THROTTLED` with `retryAfterSeconds`.

**R4** — Verification takes the same code path and the same wall-clock time whether or not the email
exists. The endpoint must not be a user-enumeration oracle. Emails are normalised — trimmed,
lowercased, stored as `citext` — before lookup, so `Ravi@Example.com` and `ravi@example.com` are one
account.

**R5** — Access tokens are RS256 JWTs valid 15 minutes, carrying `sub`, `sid`, `ver` and **no role
or grant claim** (see R10).

**R6** — Refresh tokens are opaque 256-bit values stored hashed, valid 60 days, and rotate on every
use.

**R7** — Presenting a refresh token that has already been spent revokes the entire `family_id`.
Every device in that lineage must log in again.

**R8** — A user with `status != 'active'` cannot be issued tokens, and existing sessions are revoked
on suspension.

**R9** — The first successful `verifyOtp` for an email creates the `users` row **and** the
`player_profiles` row in one transaction. A user without a profile is not a state the system can be
in.

**R10** — Grants are read from `event_staff` per request and memoised in a request-scoped loader,
never cached across requests. An organizer's permission is revocable and lives on a screen that can
rewrite match results; a 15-minute stale grant is unacceptable. One indexed lookup is the price.

**R11** — `scorer` is the lowest grant and is scoped to live scoring only. It cannot generate a
draw, cannot refund, and cannot correct a completed match.

**R12** — `phone_e164` is **optional, unverified contact information**. It is nullable, it is not
unique, and it is **never an authentication factor**. Organizers need to reach players on a
tournament morning; that is the only reason it exists.

**R13** — Email addresses that hard-bounce are marked `email_status = 'bounced'` from the Resend
webhook. A bounced address cannot receive further OTP sends; `requestOtp` returns
`EMAIL_UNDELIVERABLE` and tells the user to correct their address rather than letting them retry
into a void.

**R14** — `requestOtp` rejects known disposable email domains with `EMAIL_DOMAIN_NOT_ALLOWED`. This
is refund-fraud prevention on a platform that takes money and gives it back, not spam prevention.
The blocklist is config, refreshed on deploy.

**R15** *(Sprint 7)* — Platform roles — `admin`, `support`, `finance` — live in `platform_staff`,
are read per request through a request-scoped loader, and are **never a JWT claim**, for the same
reason as R10. They change only through the `admin` module, which audits every change
(`admin R2`). The first `admin` is bootstrapped by a one-off CLI command,
`pnpm admin:grant <email>`, which writes the same audit row.

**R16** *(Sprint 7)* — `event_staff.source` is `direct` or `organizer`. Organizer-derived rows are
written and removed **only** by `syncOrganizerGrants`, which `organizers` calls inside its own
transaction (`organizers R3`). `addStaff` and `removeStaff` touch only `direct` rows, and a sync
never touches those. A user with rows from both sources gets the higher role. Revocation still
takes effect on the very next request (R10).

**R17** *(Sprint 11)* — Venue management permission is a grant on a venue, never a role on a
person. It is stored in `venue_staff` with roles `owner`, `manager` and `desk`, and read per
request like event grants. The `owner` grant is created only when an admin approves a venue claim
(`venues R9`); owners then add managers and desk staff.

**R18** *(Sprint 7)* — `reinstate` returns a suspended user to `active`. Revoked sessions stay
revoked, and the user signs in again. `requestAccountDeletion` sets `status = 'deleted'` and
revokes every session immediately. After a **30-day grace period**, `scrub-deleted-users` replaces
the email with `deleted+<id>@invalid`, clears phone, display name and avatar, and emits
`user.scrubbed` so profile and notifications scrub theirs. Ledger rows, registrations and match
results are **retained** with the user reference, because financial and competitive records must
survive (conventions §2). Deletion is refused with `ACCOUNT_DELETION_BLOCKED` while the user has a
confirmed entry in an upcoming event, or owns an organizer with an unsettled payout.

---

## Schema

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           citext UNIQUE NOT NULL,        -- the identity (R4)
  phone_e164      text,                          -- optional contact only (R12)
  email_status    text NOT NULL DEFAULT 'ok'
                  CHECK (email_status IN ('ok','bounced','complained')),  -- R13
  display_name    text NOT NULL,
  avatar_public_id text,                         -- Cloudinary (ADR 0003 §C3)
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges (
  id              uuid PRIMARY KEY,
  email           citext NOT NULL,
  code_hash       text NOT NULL,                 -- argon2id; never the plaintext
  purpose         text NOT NULL CHECK (purpose IN ('signup','login','email_change')),
  attempts        smallint NOT NULL DEFAULT 0,
  consumed_at     timestamptz,
  expires_at      timestamptz NOT NULL,
  resend_message_id text,                        -- correlate with delivery events (R13)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_challenges (email, created_at DESC);

CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  token_hash      text NOT NULL UNIQUE,
  family_id       uuid NOT NULL,                 -- rotation lineage
  device_label    text,
  revoked_at      timestamptz,
  replaced_by     uuid REFERENCES refresh_tokens(id),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family_id);

-- FK to events lands in the events migration (05), after that table exists.
CREATE TABLE event_staff (
  event_id        uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('owner','manager','scorer')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_staff (user_id);

-- R16 (Sprint 7): organizer-derived grants live beside direct ones.
ALTER TABLE event_staff
  ADD COLUMN source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','organizer')),
  ADD COLUMN organizer_profile_id uuid;           -- FK lands in 014_organizers
ALTER TABLE event_staff DROP CONSTRAINT event_staff_pkey;
ALTER TABLE event_staff ADD PRIMARY KEY (event_id, user_id, source);

-- R18 (Sprint 7)
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;

-- R15 (Sprint 7)
CREATE TABLE platform_staff (
  user_id         uuid PRIMARY KEY REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('admin','support','finance')),
  granted_by      uuid REFERENCES users(id),      -- null only for the CLI bootstrap
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- R17 (Sprint 11). FK to venues lands with the venues Sprint 11 migration.
CREATE TABLE venue_staff (
  venue_id        uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('owner','manager','desk')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, user_id)
);
CREATE INDEX ON venue_staff (user_id);
CREATE UNIQUE INDEX venue_one_owner ON venue_staff (venue_id) WHERE role = 'owner';
```

---

## Email delivery

Resend, from a **dedicated auth subdomain** kept separate from marketing mail so a future campaign
cannot damage the reputation that logins depend on.

| Setting | Value |
|---|---|
| Sender | `PL4Y <support@getpl4y.com>` |
| DNS | SPF, DKIM and DMARC published and verified **before Sprint 1 identity work** |
| Template | Plain, single-purpose: the code, its expiry, and "you can ignore this if it wasn't you" |
| Subject | Contains the code — many clients preview it, saving the user from opening the mail |
| Webhook | `POST /webhooks/resend` → `delivered`, `bounced`, `complained` |

**The OTP funnel is a dashboard from day one:** requested → delivered → verified. A drop in
delivered-to-verified is a signup outage, and without this instrumentation it presents as
"conversion is down." See [ADR 0002 § C2](../decisions/0002-email-otp-via-resend.md).

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `OTP_INVALID` | user | Inline on the code field |
| `OTP_EXPIRED` | user | Offer resend |
| `OTP_THROTTLED` | user | Disable resend for `retryAfterSeconds` |
| `EMAIL_UNDELIVERABLE` | user | Ask the user to correct their address — R13 |
| `EMAIL_DOMAIN_NOT_ALLOWED` | user | Ask for a different address — R14 |
| `SESSION_REUSE_DETECTED` | system | Clear tokens, route to login |
| `ACCOUNT_SUSPENDED` | system | Account error screen |
| `ACCOUNT_DELETION_BLOCKED` | user | List what must finish first — R18 |

## Emits

| Event | Consumers |
|---|---|
| `user.created` | profile, notifications |
| `user.suspended` | registration |
| `staff.granted` | notifications |
| `user.reinstated` | notifications |
| `user.deletion_requested` | registration, organizers |
| `user.scrubbed` | profile, notifications, discovery |
| `platform_role.changed` | admin |

## Jobs

| Job | Schedule | Retry | Final failure |
|---|---|---|---|
| `send-otp-email` | On `requestOtp` | 3 × exp | **Alert** — signups are blocked |
| `purge-expired-otp` | Hourly | 3 × exp | Drop |
| `purge-revoked-tokens` | Daily, 90-day retention | 3 × exp | Drop |
| `scrub-deleted-users` | Daily, 30-day grace | 3 × exp | Alert — a deletion request is overdue |

---

## Done when

A real inbox receives a code and exchanges it for a token pair. Replaying a spent refresh token
forces re-login on **both** devices in the family. An organizer whose `event_staff` row is deleted
loses access on their **very next request**, not up to fifteen minutes later. And the OTP funnel
dashboard shows requested / delivered / verified with real numbers.

---

## Implementation checklist

- [ ] **Verify the Resend sending domain and publish SPF/DKIM/DMARC before anything else**
      ([ADR 0002 § C1](../decisions/0002-email-otp-via-resend.md))
- [ ] Migration `001_identity.sql`
- [ ] Email normalisation (trim, lowercase, `citext`) applied on every read and write path (R4)
- [ ] argon2id hashing for OTP codes; verify no code reaches a log line, including the subject
- [x] Sliding-window limiter, three windows (R3) — Postgres since migration 023
- [ ] Resend adapter behind an interface; OTP template with the code in the subject
- [ ] `POST /webhooks/resend` with signature verification → `email_status` (R13)
- [ ] Disposable-domain blocklist in config (R14)
- [ ] Constant-time verify path for unknown emails (R4) — test with a timing assertion
- [ ] RS256 keypair from config; `sub`/`sid`/`ver` claims only
- [ ] Refresh rotation with `family_id` and `replaced_by`; reuse revokes the family
- [ ] `verifyOtp` creates user + profile in one transaction (R9) — calls `profile.createFor()`
- [ ] `grantsFor` behind a request-scoped DataLoader (R10)
- [ ] `setContactPhone` — stored, never verified, never an auth factor (R12)
- [ ] OTP funnel dashboard: requested / delivered / verified
- [ ] Tests naming R2, R3, R4, R7, R9, R10, R12, R13
- [ ] *(Sprint 7)* `platform_staff` loader + `pnpm admin:grant` bootstrap (R15)
- [ ] *(Sprint 7)* `event_staff.source`; `syncOrganizerGrants`; highest-role resolution (R16)
- [ ] *(Sprint 7)* `reinstate`, `requestAccountDeletion`, `scrub-deleted-users` (R18)
- [ ] *(Sprint 11)* `venue_staff` grants + loader (R17)
- [ ] Tests naming R15, R16, R17, R18
