# Chat, and "played with" instead of follows

**Status:** approved 2026-09-29 · **Owner:** chat (new module) + profile

## Why

Follows are being removed from the product. A follower count is a vanity number in a sports app;
what players actually need is to reach the person they just played, or the partner they are
entering with — "want to play doubles Saturday?" The connection is **shared play**, not a follow.

## What goes

`follows` (table, model, service, GraphQL fields `followerCount`, `followingCount`, `viewerFollows`,
`followsViewer`, `isFriend`, `followers`, `following`, `friends`, mutations `followPlayer` /
`unfollowPlayer`, `FollowState`, `CANNOT_FOLLOW_SELF`), the `follow.created` outbox topic and
notification template (existing feed rows with that template are deleted by the migration — the
registry renders on read and must not meet a key it no longer has). Frontend: the followers /
following / friends routes, `FollowListScreen`, `useFollowList`, `useFollowPlayer`, the Follow button
and the two count stats.

## What comes

### 1. Played with (profile)

`PlayerProfile.playedWith(first: Int = 20): [PlayedWith!]!` — the players this player has shared a
completed match with, as partner or opponent, most recent first, derived from
`player_match_history` (no new table). Each row: the player, `matches` count, `lastPlayedAt`.
Same R4 rule as the old follow lists: withheld entirely when the profile's details are withheld
from the viewer; a private player never appears in anyone's list except to themself.

### 2. Chat (new module `chat`)

Direct, one-to-one conversations between players. No groups, no attachments, no edits — text only.

**Rules**

- **chat R1 — Who may message whom.** Never yourself; never across a block in either direction.
- **chat R2 — Shared context opens a chat directly.** Two players share context when they have
  played a completed match together (partner or opponent) **or** are on the same registration
  team (a doubles pair, before their first match). A conversation between them starts `active`.
- **chat R3 — Everyone else is a message request.** The conversation starts as `request`; the
  sender may send **one** message until the recipient accepts. The recipient accepts explicitly or by
  replying, or declines. A declined request leaves the recipient's inbox, and the **sender sees it
  as declined** (amended 2026-09-29; it used to read as still pending).
- **chat R4 — Private profiles take no requests.** A `private` player can only be messaged through
  shared context (R2).
- **chat R5 — Limits.** 10 new requests per sender per day; 30 messages per sender per minute
  (the Postgres rate limiter). Message body 1–2,000 characters after trimming.
- **chat R6 — Blocking.** Either side may block the other at any time. A block hides the conversation
  from the blocker, stops all messages both ways, and is silent to the blocked player (their sends
  fail with the same `CANNOT_MESSAGE` as any other refusal). Unblock restores it.
- **chat R7 — Read state.** Each side has `last_read_at`. Unread = messages from the other side after
  it. `markConversationRead` moves it to now.
- **chat R8 — Notifications don't spam.** A push + feed row goes out for a **request**, and for a
  message only when it is the first unread one in that conversation for the recipient (they had
  read everything before it). Every message also publishes `chat.message` on
  `private-user-{recipientUserId}` — invalidation only, the app refetches.
- **chat R9 — Messages are append-only** and ordered by `(created_at, id)`. Pagination is keyset,
  newest first.
- **chat R10 — Asking again.** Five days after a decline (`declined_at + 5 days`), the sender may send
  one new message. It reopens the same conversation as a `request`, with its history, and is a new
  request in every way: it notifies the recipient, counts toward R5's daily limit, and is refused by
  R4 and R6. Each decline starts its own 5 days. Before then a send fails with `REQUEST_DECLINED`
  and `retryAfterSeconds`. When the recipient has blocked the sender, the sender sees "declined"
  with no date, and a send fails with `CANNOT_MESSAGE` (R6 stays silent).

**Schema** (migration `024_chat_replaces_follows`)

```
conversations(id uuid pk, player_low_id, player_high_id  -- sorted pair, UNIQUE
              initiator_id, status request|active|declined, declined_at,
              low_last_read_at, high_last_read_at, last_message_at, created_at)
messages(id uuid pk, conversation_id fk, sender_id fk, body text CHECK length 1..2000, created_at)
  INDEX (conversation_id, created_at desc, id desc)
player_blocks(blocker_id, blocked_id, created_at) PK(blocker_id, blocked_id), CHECK blocker<>blocked
DROP TABLE follows
DELETE FROM notifications WHERE template = 'follow.created'
```

**GraphQL**

```graphql
Query.conversations(first: Int = 20, after: String): ConversationConnection!   # active + incoming requests, newest activity first
Query.conversation(id: ID!): Conversation
Query.unreadConversationCount: Int!
PlayerProfile.viewerMessaging: Messaging          # null on your own profile / signed out
type Messaging { canMessage: Boolean!, isRequest: Boolean!, requestDeclined: Boolean!, canResendAt: DateTime, conversationId: ID, blocked: Boolean! }
type Conversation { id, other: PlayerProfile!, status: ConversationStatus! (REQUEST | ACTIVE | DECLINED), canResendAt: DateTime, isIncomingRequest: Boolean!,
                    canSend: Boolean!, unreadCount: Int!, lastMessage: Message, messages(first, after): MessageConnection! }
type Message { id, body, sentAt, fromViewer: Boolean! }
Mutation.sendMessage(input: { playerId: ID!, body: String! }): SendMessagePayload!   # opens the conversation if needed
Mutation.acceptMessageRequest(conversationId: ID!) / declineMessageRequest(conversationId: ID!): ConversationPayload!
Mutation.markConversationRead(conversationId: ID!): ConversationPayload!
Mutation.blockPlayer(playerId: ID!) / unblockPlayer(playerId: ID!): BlockPayload!
```

Error codes: `CANNOT_MESSAGE` (R1, R3 after the first message, R4, R6), `REQUEST_LIMIT` /
`MESSAGE_LIMIT` (R5, with `retryAfterSeconds`), `INVALID_MESSAGE` (R5 length),
`REQUEST_DECLINED` (R10, with `retryAfterSeconds`), `CONVERSATION_NOT_FOUND`.

Notification templates: `chat.request { fromName }`, `chat.message { fromName, preview }` (preview:
first 80 chars). Target: route `conversation` with the conversation id.

### 3. App

- Profile: Follow button → **Message** button (hidden when `canMessage` is false; says "Send request"
  when `isRequest`). Stat strip loses Followers/Following. New **Played with** section.
- Inbox at `/messages` (entry: chat icon beside the bell in the Home header, with unread badge):
  conversations with requests grouped on top. Conversation screen at `/messages/[id]`: messages,
  composer, accept/decline bar for an incoming request, block in the header menu.
- `private-user-{id}` `chat.message` → invalidate `['chat']`.
- Notification route `CONVERSATION` → `/messages/[id]`.

## Out of scope

Reporting (no admin module yet — block covers safety for now), group chats, media, typing
indicators, message deletion, and pushing the message body over Pusher.
