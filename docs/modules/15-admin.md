# 15 — admin

| | |
|---|---|
| **Sprint** | 7 (core, Phase 1) · 12 (moderation, support, fraud, reports — Phase 2) |
| **Phase** | 1 and 2 — each rule is tagged |
| **Depends on** | identity, organizers, events, venues, payments, notifications |
| **Owns** | `audit_log`, `moderation_reports`, `support_tickets`, `support_messages`, `fraud_signals`, `platform_metrics_daily` |
| **Rule prefix** | `admin R*` |

The operations surface: user management, organizer and venue management, event moderation,
payments management, reports, fraud review and support. It powers the internal admin dashboard, a
separate web client that talks to the same GraphQL endpoint.

**This module changes almost nothing itself.** Every admin action is a named service method on
the module that owns the data (R3). What `admin` owns is the audit trail, the queues (reports,
tickets, fraud signals) and the platform-wide read models.

[ADR 0001](../decisions/0001-neon-over-supabase.md) asked for "a read-only internal admin view
early". Sprint 7 is that, plus the few write actions a first tournament needs.

---

## Service interface

```ts
// Phase 1 — Sprint 7
lookupUser(admin, { email?, userId? })                    => AdminUserView      // masked PII (R4)
revealPii(admin, userId, reason)                          => { email, phone }   // audited
suspendUser(admin, userId, reason)                        => void   // → identity.suspend
reinstateUser(admin, userId, reason)                      => void   // → identity.reinstate
verifyOrganizer(admin, organizerId, status, reason)       => void   // → organizers.setVerification
hideEvent(admin, eventId, reason) / unhideEvent(...)      => void   // → events.moderate
cancelEvent(admin, eventId, reason)                       => void   // → events.cancel (R5)
refundOverride(admin, paymentId, amountPaise, reason)     => Refund // → payments.refund
holdPayout(admin, payoutId, reason) / releasePayout(...)  => void   // → payments
approveVenueClaim(admin, claimId, decision, reason)       => void   // → venues.decideClaim
grantPlatformRole(admin, userId, role | null, reason)     => void   // → identity (R1)
auditLog(admin, filter, page)                             => Page<AuditEntry>

// Phase 2 — Sprint 12
report(actor, { targetType, targetId, reason, note })     => ModerationReport
moderationQueue(admin, filter, page)                      => Page<ModerationReport>
resolveReport(admin, reportId, action, reason)            => ModerationReport
openTicket(actor, { subject, body, linkedType?, linkedId?, requestId? }) => SupportTicket
replyTicket(staff, ticketId, { body, internal })          => SupportMessage
setTicketStatus(staff, ticketId, status)                  => SupportTicket
myTickets(actor, page)                                    => Page<SupportTicket>
recordSignal(input: FraudSignalInput)                     => FraudSignal        // jobs call this
fraudQueue(admin, filter, page)                           => Page<FraudCase>
platformReport(admin, { from, to })                       => PlatformReport
```

## GraphQL

```graphql
# Staff-only fields. authScopes checks identity.platformRoleFor(); the service re-checks (R1).
Query.adminUser(email: String, userId: ID): AdminUserView
Query.adminAuditLog(filter: AuditFilter, first: Int = 50, after: String): AuditConnection!
Query.adminModerationQueue(status: ReportStatus, first: Int = 50, after: String): ReportConnection!
Query.adminSupportTickets(status: TicketStatus, first: Int = 50, after: String): TicketConnection!
Query.adminFraudQueue(first: Int = 50, after: String): FraudCaseConnection!
Query.adminPlatformReport(from: Date!, to: Date!): PlatformReport!

Mutation.adminSuspendUser / adminReinstateUser / adminRevealPii
Mutation.adminVerifyOrganizer / adminHideEvent / adminUnhideEvent / adminCancelEvent
Mutation.adminRefund / adminHoldPayout / adminReleasePayout
Mutation.adminDecideVenueClaim / adminResolveReport / adminReplyTicket / adminSetTicketStatus
Mutation.adminGrantPlatformRole

# Player-facing, Phase 2
Mutation.reportContent(input: ReportInput!): ReportPayload!
Mutation.openSupportTicket(input: SupportTicketInput!): SupportTicketPayload!
Mutation.replySupportTicket(input: SupportReplyInput!): SupportTicketPayload!
Query.mySupportTickets(first: Int = 20, after: String): TicketConnection!
```

Admin operations ship as a **separate trusted-document set**. The mobile app's document hashes can
never call an admin field, even if a staff member is signed in on their phone.

---

## Rules

**R1** *(P1)* — Platform roles are `admin`, `support` and `finance`. They live in
`identity.platform_staff` (identity R15), are read per request, and are **never a JWT claim**.
Admin fields also require a session issued within the last **12 hours**: a stolen 60-day refresh
token must not open the admin dashboard.

| Capability | support | finance | admin |
|---|---|---|---|
| Look up users, organizers, events, payments (masked) | ✓ | ✓ | ✓ |
| Reveal PII | ticket-linked only | — | ✓ |
| Suspend / reinstate users; hide events; resolve reports | ✓ | — | ✓ |
| Verify organizers; decide venue claims | — | — | ✓ |
| Refund override; hold / release payouts; cancel events | — | ✓ | ✓ |
| Grant platform roles | — | — | ✓ |

**R2** *(P1)* — Every admin mutation writes an `audit_log` row **in the same transaction** as the
change it records: actor, action, target, a before/after summary, a **required non-empty reason**
and the `requestId`. The table is append-only; the application database role has no `UPDATE` or
`DELETE` on it.

**R3** *(P1)* — Admin never writes another module's tables. Each action calls the owning module's
service method, passing the transaction client so the audit row and the change commit together.
The admin module is a surface, an audit trail and a set of queues.

**R4** *(P1)* — Least-privilege PII. Lookups return masked email (`r•••@example.com`) and phone.
`revealPii` needs a reason, is audited, and is allowed for `support` only when the user has an
open ticket.

**R5** *(P1)* — **Hide** and **cancel** are different actions. Hiding removes an event from
discovery while entrants keep access (events R12) and moves no money. Cancelling triggers
`events R7` refunds, so it requires `finance` or `admin`.

**R6** *(P2)* — Any signed-in user can report a profile, venue review, event, game, community or
community announcement. There is at most one open report per reporter per target. User-generated
content (reviews, announcements, community pages) is **auto-hidden once 5 distinct reporters**
(config) flag it, until reviewed. Events are never auto-hidden, because money is attached; they
jump the queue instead.

**R7** *(P2)* — Support tickets are opened in-app. The client attaches its last `requestId`, so
support can trace the exact call (platform R8). Statuses are
`open → pending_user → resolved → closed`. A staff reply notifies the user through the
`support.reply` template and by email. **Internal notes are never returned to the user**, and the
resolver's field-level check enforces it.

**R8** *(P2)* — Fraud signals are **recorded, not punished automatically**. Detectors write
`fraud_signals` rows with a score:

| Detector | Source |
|---|---|
| Many accounts on one device token | notifications device registrations |
| High refund-after-confirm rate for a user | payments `refund.processed` |
| Repeated disposable-domain or throttled OTP attempts | identity (R3, R14) |
| Chargebacks / disputes | payments R19 |
| Organizer cancellation rate above threshold | events `event.cancelled` |
| Repeated booking no-shows | bookings R12 |

When an entity's score crosses the threshold, a review case opens. **The only automatic action
allowed is `payments.holdPayout`**, which is reversible. Suspension is always a human decision.

**R9** *(P2)* — Platform reports read `platform_metrics_daily`, a nightly read model: signups, the
OTP funnel, registrations, GMV, refunds, payouts, active players, events published and support
volume. Report queries run against the **read replica**, never the primary.

**R10** *(P1)* — The admin module has no path into a user's notification feed (notifications R8)
or into another user's session. Support "acting as" a user does not exist.

---

## Schema

```sql
-- Append-only (R2). REVOKE UPDATE, DELETE ON audit_log FROM app_role;
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_role    text NOT NULL,
  action        text NOT NULL,                  -- 'user.suspend' | 'event.hide' | …
  target_type   text NOT NULL,
  target_id     text NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) > 0),
  diff          jsonb NOT NULL DEFAULT '{}',
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (target_type, target_id, created_at DESC);
CREATE INDEX ON audit_log (actor_user_id, created_at DESC);

CREATE TABLE moderation_reports (
  id            uuid PRIMARY KEY,
  reporter_id   uuid NOT NULL REFERENCES users(id),
  target_type   text NOT NULL CHECK (target_type IN
                  ('player','venue_review','event','game','community','community_announcement')),
  target_id     uuid NOT NULL,
  reason        text NOT NULL CHECK (reason IN
                  ('spam','abuse','fake','unsafe','inaccurate','other')),
  note          text,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','actioned','dismissed')),
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- R6: one open report per reporter per target.
CREATE UNIQUE INDEX moderation_one_open
  ON moderation_reports (reporter_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX ON moderation_reports (target_type, target_id) WHERE status = 'open';

CREATE TABLE support_tickets (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  subject       text NOT NULL,
  linked_type   text,                            -- 'registration' | 'payment' | 'booking' | …
  linked_id     uuid,
  request_id    text,                            -- R7
  status        text NOT NULL DEFAULT 'open' CHECK (status IN
                  ('open','pending_user','resolved','closed')),
  assigned_to   uuid REFERENCES users(id),
  first_response_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON support_tickets (status, created_at);
CREATE INDEX ON support_tickets (user_id, created_at DESC);

CREATE TABLE support_messages (
  id            uuid PRIMARY KEY,
  ticket_id     uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users(id),
  body          text NOT NULL,
  internal      boolean NOT NULL DEFAULT false,  -- never shown to the user (R7)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fraud_signals (
  id            bigserial PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('user','organizer','venue','device')),
  subject_id    text NOT NULL,
  detector      text NOT NULL,
  score         smallint NOT NULL CHECK (score BETWEEN 1 AND 100),
  evidence      jsonb NOT NULL DEFAULT '{}',
  reviewed_at   timestamptz,
  reviewed_by   uuid REFERENCES users(id),
  outcome       text CHECK (outcome IN ('confirmed','dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fraud_signals (subject_type, subject_id, created_at DESC);

CREATE TABLE platform_metrics_daily (
  day           date NOT NULL,
  metric        text NOT NULL,                   -- 'signups' | 'gmv_paise' | …
  dimension     text NOT NULL DEFAULT '',        -- '' | 'city:Bengaluru' | 'sport:<id>'
  value         bigint NOT NULL,
  PRIMARY KEY (day, metric, dimension)
);
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `FORBIDDEN` | system | No platform role, or role lacks the capability — R1 |
| `STEP_UP_REQUIRED` | system | Session older than 12 h — re-verify OTP (R1) |
| `REASON_REQUIRED` | user | Empty reason on an admin action — R2 |
| `REPORT_ALREADY_OPEN` | user | Show "already reported" — R6 |
| `TICKET_CLOSED` | user | Offer to open a new ticket |

## Emits

| Event | Consumers |
|---|---|
| `admin.action` | (audit export) |
| `content.hidden` | owning module (hides the target), notifications |
| `support.replied` | notifications |
| `fraud.case_opened` | payments (optional payout hold — R8) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `detect-fraud-signals` | Outbox topics in R8 | 3 × exp | Alert |
| `build-platform-metrics` | Nightly, read replica | 3 × exp | Alert; reports serve stale |
| `ticket-sla-sweep` | Every 15 min | 3 × exp | Alert |

---

## Done when

**Phase 1:** Every admin action shown in the dashboard appears in `audit_log` with its reason, and a
deliberately failed action leaves no audit row and no change. A `support` user cannot refund. A
session older than 12 hours is refused with `STEP_UP_REQUIRED`.

**Phase 2:** Five distinct reports on a venue review hide it until a moderator acts. A support
reply reaches the user's feed and inbox, and internal notes never appear in any user-facing
response. A chargeback opens a fraud case and holds that organizer's pending payout without
suspending anyone.

---

## Implementation checklist

- [ ] Migration `015_admin.sql`; revoke `UPDATE`/`DELETE` on `audit_log` from the app role (R2)
- [ ] `identity.platform_staff` loader + 12-hour step-up check (R1)
- [ ] Separate trusted-document set for the admin web client
- [ ] Audit helper that takes the caller's `tx` (R2, R3)
- [ ] Masked lookups + audited `revealPii` (R4)
- [ ] Phase 1 actions wired to owning modules: suspend, reinstate, verify organizer, hide/cancel
      event, refund override, payout hold, venue claims, platform roles
- [ ] *(P2)* Reports with the 5-reporter auto-hide for UGC (R6)
- [ ] *(P2)* Support tickets with `requestId`, internal notes, `support.reply` template (R7)
- [ ] *(P2)* Fraud detectors → signals → cases; payout hold as the only automatic action (R8)
- [ ] *(P2)* `platform_metrics_daily` nightly build on the read replica (R9)
- [ ] Tests naming R1, R2, R3, R4, R5, R6, R7, R8, R10
