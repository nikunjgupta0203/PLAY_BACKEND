# 11 — notifications

| | |
|---|---|
| **Sprint** | 9 |
| **Phase** | 1 |
| **Depends on** | identity |
| **Owns** | `notifications`, `device_registrations`, `notification_preferences` |
| **Rule prefix** | `notifications R*` |

One `emit` call, two destinations: a **durable in-app feed row** and a **best-effort push** through
Pusher Beams. Consumes domain events from every module above it and depends on none of them.

**Transactional email is not this module's job.** OTP codes, receipts and partner invites are sent
by the module that owns the action, through the Resend adapter. This module owns the notification
*feed* and *push*; adding email as a third channel here is a Phase 2 conversation.

---

## Service interface

```ts
emit(userId, template: TemplateKey, payload)   => Notification
emitBulk(userIds[], template, payload)         => { queued: number }
feed(actor, page)                              => Page<Notification>
unreadCount(actor)                             => number
markRead(actor, ids[])                         => void
markAllRead(actor)                             => void
registerDevice(actor, { token, platform })     => void
unregisterDevice(actor, token)                 => void
preferences(actor)                             => Preferences
setPreferences(actor, prefs)                   => Preferences
```

## GraphQL

```graphql
Query.notifications(first: Int = 20, after: String): NotificationConnection!
Query.unreadNotificationCount: Int!

Mutation.markNotificationsRead(ids: [ID!]!): MarkReadPayload!
Mutation.markAllNotificationsRead: MarkReadPayload!
Mutation.registerDevice(input: RegisterDeviceInput!): RegisterDevicePayload!
Mutation.setNotificationPreferences(input: PreferencesInput!): PreferencesPayload!

type Notification {
  id: ID!
  template: String!
  title: String!
  body: String!
  deepLink: Node          # Event, Match, PlayerProfile, Game, Venue or Community — R9
  deepLinkRoute: DeepLinkRoute   # non-entity screens — R10
  readAt: DateTime
  createdAt: DateTime!
}
```

---

## Templates

The eight triggers from the product brief. Copy lives in versioned templates with typed payloads.

| Key | Fired by | Deep link | Quiet hours |
|---|---|---|---|
| `registration.confirmed` | payments | Event Detail | Respected |
| `partner.invite` | registration | Registration Step 2b | Respected |
| `match.starting_soon` | tournament | Match Detail | **Overrides** |
| `match.result` | scoring | Match Detail | Respected |
| `ranking.changed` | rating | Rankings | Respected |
| `payment.updated` | payments | Payments history | Respected |
| `game.invite` | games | Game Detail | Respected |
| `organizer.message` | organizers | Event Detail | Respected |

### Templates added for feature coverage

Ten of these close existing gaps: a module already emitted the event to `notifications`, but no
template rendered it.

| Key | Fired by | Deep link | Quiet hours | Sprint |
|---|---|---|---|---|
| `chat.request` | chat | Conversation (route) | Respected | — |
| `chat.message` | chat — first unread only (chat R8) | Conversation (route) | Respected | — |
| `achievement.earned` | profile | Player Profile | Respected | 9 |
| `staff.granted` | identity | Event Detail | Respected | 9 |
| `registration.expired` | registration | Event Detail | Respected | 9 |
| `event.cancelled` | events | Event Detail | Respected | 9 |
| `draw.generated` | tournament | Event Detail | Respected | 9 |
| `waitlist.offer` | registration | Event Detail | Respected — the offer waits (registration R17) | 9 |
| `payout.updated` | payments | route `organizer_payouts` | Respected | 9 |
| `organizer.verified` | organizers | route `organizer_dashboard` | Respected | 9 |
| `challenge.received` | social | Player Profile | Respected | 10 |
| `challenge.responded` | social | Game | Respected | 10 |
| `game.joined` | games | Game | Respected | 10 |
| `game.cancelled` | games | Game | Respected | 10 |
| `game.waitlist_promoted` | games | Game | Respected | 11 |
| `community.invite` | communities | Community | Respected | 11 |
| `community.join_request` | communities | Community | Respected | 11 |
| `community.announcement` | communities | Community | Respected | 11 |
| `venue.review_reply` | venues | Venue | Respected | 11 |
| `support.reply` | admin | route `support_ticket` | Respected | 12 |
| `league.fixture` | leagues | Match | Respected | 13 |
| `booking.confirmed` | bookings | Venue | Respected | 14 |
| `booking.reminder` | bookings | Venue | Respected | 14 |
| `ticket.issued` | ticketing | Event Detail | Respected | 15 |
| `partner.declined` | registration (`invite.declined`) | Event Detail | Respected | 9 |
| `category.cancelled` | events (`category.cancelled`) | Event Detail | Respected | 9 |
| `match.result_disputed` | scoring (`result.disputed`) — players and organizer | Match Detail | Respected | 9 |
| `match.result_pending` | scoring (`result.submitted`) — the answering side; carries `autoConfirmMinutes` (scoring R11) | Match Detail | Respected | 9 |
| `match.result_reminder` | scoring (`result.reminder`) — the answering side, once (scoring R14) | Match Detail | Respected | 9 |
| `match.results_waiting` | scoring (`results.waiting`) — event owners and managers, grouped (scoring R13) | Event Detail | Respected | 9 |
| `rating.changed` | rating (`rating.changed`) — settled changes only, skipped under 1 point | Player | Respected | 9 |

`match.result` carries `auto` — "Confirmed automatically." — when scoring's sweep confirmed it (scoring R11).

`organizer.message` is produced by `Mutation.messageEventPlayers(eventId, message)` — event staff
only, 1–500 characters, at most 5 an hour per event — which writes `event.message` to the outbox;
the worker fans it out to every confirmed entrant.

---

## Rules

**R1** — The in-app row is **always** written, inside the emitting module's transaction via the
outbox. Push delivery is a separate, failable job.

**R2** — Preferences gate **push**, never the feed. A player who muted push still sees their
registration confirmation in the app.

**R3** — Quiet hours are **22:00–07:00 IST**. Only `match.starting_soon` overrides them — someone is
standing on a court waiting. A push inside them is **held, not dropped**: `send-push` re-queues it for
07:00 IST, when preferences and read state are checked again. A row already read by then is not pushed.

**R4** — Copy lives in versioned templates with typed payloads. **No message string is assembled at
a call site.**

**R5** — Every notification carries a deep link resolving to one of the four `Node` types — Event,
Match, PlayerProfile, Game. A notification you cannot act on is noise. *(The target list is
extended by R9 and R10.)*

**R6** — A device token that the push service reports invalid is **deleted on the spot**, not retried
— on the send ticket, or on its receipt (`check-push-receipts`, 15 minutes after the send).

Every push carries the recipient's unread count as the app-icon `badge`; the app keeps the icon
badge in step with `unreadNotificationCount` and clears it on sign-out.

**R7** — `emitBulk` to an entire event chunks at **500 recipients per job**, so one large tournament
cannot stall the queue.

**R8** — Notifications are read-scoped to their owner. There is no admin path to another user's feed
through this API.

**R9** *(Sprint 11)* — `Node` gains two deep-link targets, `Venue` and `Community`
(conventions §4). Every template added for venues, bookings and communities links to one of them.

**R10** *(Sprint 9)* — Screens that are not entities — organizer payouts, the organizer dashboard,
a support ticket — use a **closed enum of route deep links** (`organizer_payouts`,
`organizer_dashboard`, `support_ticket`) plus an id. Adding a route is a code change, reviewed like
a new `Node` type, never a free-form string.

**R11** *(Sprint 7)* — User-written text carried by a notification (organizer broadcasts, community
announcements, support replies) is a **typed payload field**, escaped when rendered. R4 still
holds: the copy around it lives in the template.

---

## Schema

```sql
CREATE TABLE notifications (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  template      text NOT NULL,
  payload       jsonb NOT NULL,
  deep_link_type text,                 -- 'event' | 'match' | 'player' | 'game' | 'venue' | 'community' | 'route'
  deep_link_id  uuid,
  deep_link_route text,                -- set when deep_link_type = 'route' (R10)
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_feed_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id)
  WHERE read_at IS NULL;

CREATE TABLE device_registrations (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         text NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('ios','android','web')),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX ON device_registrations (user_id);

CREATE TABLE notification_preferences (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled  boolean NOT NULL DEFAULT true,
  muted         text[] NOT NULL DEFAULT '{}',   -- template keys
  quiet_hours   boolean NOT NULL DEFAULT true
);
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `UNKNOWN_TEMPLATE` | system | Deploy problem — template not registered |
| `DEVICE_TOKEN_INVALID` | system | Handled internally by R6; never surfaced |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `send-push` | Outbox | 3 × exp | **Drop** — the in-app feed row persists |
| `send-push-bulk` | `emitBulk` | 3 × exp | Alert |
| `check-push-receipts` | 15 min after a send | 3 × exp | Drop — the next send reports a dead token too |
| `prune-notifications` | Nightly, 180-day retention | 3 × exp | Drop |

---

## Done when

All eight templates fire end to end from their **real triggers**, arrive on a physical device, open
the right screen, and still appear in the in-app feed with push disabled at the OS level.

Each template added for feature coverage passes the same check in the sprint that introduces it.

---

## Implementation checklist

- [ ] Migration `011_notifications.sql`
- [ ] Template registry with typed payloads and a compile-time exhaustiveness check (R4)
- [ ] `emit()` writing the feed row through the outbox (R1)
- [ ] Pusher Beams adapter; invalid-token cleanup (R6)
- [ ] Quiet-hours logic with the `match.starting_soon` override (R3)
- [ ] Preferences gating push only (R2)
- [ ] Deep-link resolution to the four `Node` types (R5)
- [ ] `emitBulk` chunking at 500 (R7)
- [ ] Wire every producing module's outbox topic to its template
- [ ] End-to-end test on a real device for all eight templates — the **Done when**
- [ ] Tests naming R1, R2, R3, R5, R7, R8
- [ ] Register each feature-coverage template in the sprint listed for it (R9, R10)
- [ ] Route deep-link enum (R10); escaped user-text payload fields (R11)
- [ ] Tests naming R9, R10, R11

---

## Additions 2026-10-04 (flow review F3, F12, F18, F19, F25)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

New templates: `event.changed` (F18), `draw.finished` (F25 — everyone in the draw, with the winner),
`event.report_resolved` (F3 — the reporter), and to the host or managers `host.new_entry`, `host.draw_short`,
`host.draw_cancelled`, `host.ready_to_draw`, `host.event_completed` (F12). `event.cancelled` carries the
host's reason (F19). Host notices and `match.results_waiting` target `organizer_dashboard` with the event
slug as `id`, which the app opens as the organizer section.
