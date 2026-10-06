# Chat: Show a Declined Request, Allow a New One After 5 Days — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a player declines a message request, the sender sees "Declined" (in the inbox, the conversation and on the profile) and can send one new request 5 days after the decline.

**Architecture:** One new column, `conversations.declined_at`, records when a request was declined. The chat service stops hiding `declined` from the sender, and exposes `canResendAt = declined_at + 5 days`. A send after that moment turns the same conversation back into a `request` (same row, same history). The request-per-day limit, R4 (private profiles) and R6 (blocks) apply to the new request exactly as to a first one. The app reads the new status and date; it adds no rules of its own.

**Tech Stack:** Backend: TypeScript, Prisma 5 + Postgres, Pothos GraphQL, Vitest with a real Postgres (testcontainers). App: Expo / React Native, TanStack Query, Jest + @testing-library/react-native.

**Spec:** `PALY_BACKEND/docs/superpowers/specs/2026-09-29-chat-design.md` (amended in Task 1: chat R3 changes, new chat R10).

Repos: backend is `PALY_BACKEND/` (spelling is the repo's own), app is `PLAY_FRONTEND/`. Paths below are relative to each repo root and each task says which repo.

## Global Constraints

- The resend wait is exactly **5 days** (`5 * 86_400_000` ms) after the decline, measured on the server clock. At exactly 5 days the send is allowed (`>=`).
- A resent request is a **request** in every sense: the sender gets one message until the recipient accepts or replies (chat R3), it counts toward **10 new requests per sender per day** (chat R5), a `private` recipient takes none (chat R4), and any block stops it (chat R6).
- A block stays **silent** (chat R6): when the recipient has blocked the sender, the sender may still see "Declined", but never a resend date that would then fail.
- The decliner's view does not change: a declined request stays out of their inbox until the sender asks again.
- Every declined row has a `declined_at`, and no other row does (database CHECK).
- Error codes are the ones in `ChatCode`; the new one is `REQUEST_DECLINED` with `retryAfterSeconds`.
- Services never import GraphQL types; resolvers never touch Prisma (conventions.md §1).
- Every test names the rule it proves (`R10:` …) so `grep 'R10:'` finds it.

## Review Focus

1. **Exactly at the 5-day mark:** a send at `declined_at + 5 days` succeeds; one millisecond earlier fails with `REQUEST_DECLINED`. Covered in Task 2.
2. **The recipient blocks after declining:** the sender sees "Declined" with no date, and a send fails with `CANNOT_MESSAGE`, not `REQUEST_DECLINED`. Covered in Task 2.
3. **The recipient went private after declining:** the resend is refused (R4) and the profile button disappears. Covered in Task 2.
4. **Two devices resend at the same moment:** only one message goes through; the other gets `CANNOT_MESSAGE` (one message per request). Covered in Task 2.
5. **A second decline:** the 5 days start again from the new decline, not the first. Covered in Task 2.

---

### Task 1: Store when a request was declined (backend)

**Repo:** `PALY_BACKEND`

**Files:**
- Create: `prisma/migrations/20260929140000_025_chat_request_resend/migration.sql`
- Modify: `prisma/schema.prisma` (model `Conversation`, around line 1234)
- Modify: `docs/superpowers/specs/2026-09-29-chat-design.md` (rule R3, new R10)
- Modify: `docs/modules/13-social.md` only if it restates chat R3 (search for "declined" first; change nothing else)

**Interfaces:**
- Produces: column `conversations.declined_at timestamptz NULL`; Prisma field `Conversation.declinedAt: Date | null`.

- [ ] **Step 1: Write the migration**

`prisma/migrations/20260929140000_025_chat_request_resend/migration.sql`:

```sql
-- 025 — a declined message request can be asked again after 5 days (chat R10).
-- declined_at is when the request was declined; the sender may ask again at
-- declined_at + 5 days.

ALTER TABLE "conversations" ADD COLUMN "declined_at" TIMESTAMPTZ(6);

-- Requests declined before this migration have no decline time. Their last
-- message is the closest honest stand-in.
UPDATE "conversations"
   SET "declined_at" = COALESCE("last_message_at", "created_at")
 WHERE "status" = 'declined';

ALTER TABLE "conversations" ADD CONSTRAINT "conversations_declined_at_check"
  CHECK (("status" = 'declined') = ("declined_at" IS NOT NULL));
```

- [ ] **Step 2: Add the field to the Prisma model**

In `prisma/schema.prisma`, inside `model Conversation`, after `lastMessageAt`:

```prisma
  /// chat R10 — when the request was declined. Set exactly when status is `declined`.
  declinedAt     DateTime? @map("declined_at") @db.Timestamptz(6)
```

- [ ] **Step 3: Regenerate the client and check it compiles**

Run: `npx prisma generate && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Amend the spec**

In `docs/superpowers/specs/2026-09-29-chat-design.md`, replace the R3 bullet with:

```markdown
- **chat R3 — Everyone else is a message request.** The conversation starts as `request`; the
  sender may send **one** message until the recipient accepts. The recipient accepts explicitly or by
  replying, or declines. A declined request leaves the recipient's inbox, and the **sender sees it
  as declined** (amended 2026-09-29; it used to read as still pending).
```

and add after R9:

```markdown
- **chat R10 — Asking again.** Five days after a decline (`declined_at + 5 days`), the sender may send
  one new message. It reopens the same conversation as a `request`, with its history, and is a new
  request in every way: it notifies the recipient, counts toward R5's daily limit, and is refused by
  R4 and R6. Each decline starts its own 5 days. Before then a send fails with `REQUEST_DECLINED`
  and `retryAfterSeconds`. When the recipient has blocked the sender, the sender sees "declined"
  with no date, and a send fails with `CANNOT_MESSAGE` (R6 stays silent).
```

In the schema block of the same file, add `declined_at` to the `conversations(...)` line, and in the error-code paragraph add `REQUEST_DECLINED` (R10, with `retryAfterSeconds`). In the GraphQL block, change `status: ConversationStatus!` to note `REQUEST | ACTIVE | DECLINED`, add `canResendAt: DateTime` to `Conversation`, and add `requestDeclined: Boolean!, canResendAt: DateTime` to `Messaging`.

- [ ] **Step 5: Run the existing chat tests (migration applies, nothing else changed yet)**

Run: `npx vitest run tests/chat.test.ts`
Expected: all PASS (the service does not use the column yet).

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/20260929140000_025_chat_request_resend prisma/schema.prisma docs/superpowers/specs/2026-09-29-chat-design.md
git commit -m "feat(chat): record when a message request was declined (chat R10)"
```

---

### Task 2: Show the decline to the sender and allow a new request after 5 days (backend service)

**Repo:** `PALY_BACKEND`

**Files:**
- Modify: `src/modules/chat/service/index.ts`
- Test: `tests/chat.test.ts`

**Interfaces:**
- Consumes: `Conversation.declinedAt` (Task 1).
- Produces (used by Task 3):
  - `ChatCode.REQUEST_DECLINED = 'REQUEST_DECLINED'`
  - `RESEND_AFTER_MS = 5 * 86_400_000`
  - `ConversationView.status: 'request' | 'active' | 'declined'` and `ConversationView.canResendAt: Date | null`
  - `Messaging.requestDeclined: boolean` and `Messaging.canResendAt: Date | null`

- [ ] **Step 1: Write the failing tests**

In `tests/chat.test.ts`, add a helper under `const tick = …`:

```ts
const DAY = 86_400_000;
```

Replace the whole test `'R3: accept opens it; decline hides it from the recipient and tells the sender nothing'` with:

```ts
  it('R3: accept opens it; decline hides it from the recipient and shows the sender it was declined', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    const meera = await makePlayer('Meera');

    const first = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi' });
    expect(await chat.accept(asha.actor, first.conversation.id)).toMatchObject({ status: 'active' });
    await expect(chat.accept(ravi.actor, first.conversation.id)).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });

    const second = await chat.send(meera.actor, { playerId: asha.playerId, body: 'Hi' });
    await chat.decline(asha.actor, second.conversation.id);
    expect(await chat.byId(asha.userId, second.conversation.id)).toBeNull();
    expect((await chat.list(asha.userId, { first: 10 })).nodes.map((c) => c.id)).toEqual([first.conversation.id]);

    // Meera is told, with the date she may ask again, and cannot send before it.
    expect(await chat.byId(meera.userId, second.conversation.id)).toMatchObject({
      status: 'declined',
      canSend: false,
      canResendAt: new Date(clock.getTime() + 5 * DAY),
    });
    expect(await chat.messagingWith(meera.userId, asha.playerId)).toMatchObject({
      canMessage: false,
      isRequest: true,
      requestDeclined: true,
      canResendAt: new Date(clock.getTime() + 5 * DAY),
    });
    await expect(chat.send(meera.actor, { playerId: asha.playerId, body: '?' })).rejects.toMatchObject({
      code: 'REQUEST_DECLINED',
      retryAfterSeconds: 5 * 86_400,
    });
  });
```

Add a new `describe` block after `describe('who may message whom', …)`:

```ts
describe('asking again after a decline (R10)', () => {
  async function declined() {
    const meera = await makePlayer('Meera');
    const asha = await makePlayer('Asha');
    const { conversation } = await chat.send(meera.actor, { playerId: asha.playerId, body: 'Hi' });
    await chat.decline(asha.actor, conversation.id);
    return { meera, asha, id: conversation.id, declinedAt: clock };
  }

  it('R10: exactly 5 days after the decline the sender may send one new request', async () => {
    const { meera, asha, id } = await declined();

    tick(5 * DAY - 1);
    await expect(chat.send(meera.actor, { playerId: asha.playerId, body: 'Still up for a game?' })).rejects.toMatchObject({
      code: 'REQUEST_DECLINED',
      retryAfterSeconds: 1,
    });

    tick(1);
    expect(await chat.byId(meera.userId, id)).toMatchObject({ status: 'declined', canSend: true });
    expect(await chat.messagingWith(meera.userId, asha.playerId)).toMatchObject({ canMessage: true, requestDeclined: true });

    const again = await chat.send(meera.actor, { playerId: asha.playerId, body: 'Still up for a game?' });
    expect(again.conversation).toMatchObject({ id, status: 'request', canSend: false, canResendAt: null });

    // It is a request again: back in Asha's inbox, history included, and one message only.
    expect(await chat.byId(asha.userId, id)).toMatchObject({ status: 'request', isIncomingRequest: true });
    const page = await chat.messages(asha.userId, id, { first: 10 });
    expect(page.nodes.map((m) => m.body)).toEqual(['Still up for a game?', 'Hi']);
    tick();
    await expect(chat.send(meera.actor, { playerId: asha.playerId, body: 'Hello?' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
  });

  it('R10: the new request notifies the recipient like a first one', async () => {
    const { meera, asha } = await declined();
    tick(5 * DAY);
    await chat.send(meera.actor, { playerId: asha.playerId, body: 'Again' });
    const rows = await prisma.outbox.findMany({ where: { topic: 'chat.message.sent' }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => (r.payload as { notify: string | null }).notify)).toEqual(['request', 'request']);
  });

  it('R10: a second decline starts its own 5 days', async () => {
    const { meera, asha, id } = await declined();
    tick(5 * DAY);
    await chat.send(meera.actor, { playerId: asha.playerId, body: 'Again' });
    tick(DAY);
    await chat.decline(asha.actor, id);
    expect(await chat.byId(meera.userId, id)).toMatchObject({
      status: 'declined',
      canSend: false,
      canResendAt: new Date(clock.getTime() + 5 * DAY),
    });
  });

  it('R10, R5: asking again counts toward the daily request limit', async () => {
    const { meera, asha } = await declined();
    tick(5 * DAY);
    // Ten fresh requests today fill the daily limit (R5); asking again would be the eleventh.
    for (let i = 0; i < 10; i++) {
      const other = await makePlayer(`Q${i}`);
      await chat.send(meera.actor, { playerId: other.playerId, body: 'Hi' });
    }
    await expect(chat.send(meera.actor, { playerId: asha.playerId, body: 'Again' })).rejects.toMatchObject({
      code: 'REQUEST_LIMIT',
    });
  });

  it('R10, R4: a recipient who has gone private takes no new request', async () => {
    const { meera, asha } = await declined();
    await prisma.playerProfile.update({ where: { id: asha.playerId }, data: { visibility: 'private' } });
    tick(5 * DAY);
    expect(await chat.messagingWith(meera.userId, asha.playerId)).toMatchObject({ canMessage: false });
    await expect(chat.send(meera.actor, { playerId: asha.playerId, body: 'Again' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
  });

  it('R10, R6: after a block the sender sees "declined" with no date, and cannot send', async () => {
    const { meera, asha, id } = await declined();
    await chat.block(asha.actor, meera.playerId);
    tick(5 * DAY);
    expect(await chat.byId(meera.userId, id)).toMatchObject({ status: 'declined', canSend: false, canResendAt: null });
    expect(await chat.messagingWith(meera.userId, asha.playerId)).toMatchObject({
      canMessage: false,
      requestDeclined: true,
      canResendAt: null,
    });
    await expect(chat.send(meera.actor, { playerId: asha.playerId, body: 'Again' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
  });

  it('R10: two devices asking again at once send one message', async () => {
    const { meera, asha, id } = await declined();
    tick(5 * DAY);
    const results = await Promise.allSettled([
      chat.send(meera.actor, { playerId: asha.playerId, body: 'Phone' }),
      chat.send(meera.actor, { playerId: asha.playerId, body: 'Tablet' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await chat.messages(asha.userId, id, { first: 10 })).nodes).toHaveLength(2);
  });
});
```


- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/chat.test.ts -t "R10|R3: accept opens it"`
Expected: FAIL. The R3 test fails on `status: 'declined'` (the service still says `request`), and the R10 tests fail on `REQUEST_DECLINED` (the service throws `CANNOT_MESSAGE`).

- [ ] **Step 3: Implement the service changes**

In `src/modules/chat/service/index.ts`:

(a) Add the code and the constant:

```ts
export const ChatCode = {
  /** R1, R3, R4, R6 — one code for every refusal, so a block is indistinguishable. */
  CANNOT_MESSAGE: 'CANNOT_MESSAGE',
  CANNOT_BLOCK_SELF: 'CANNOT_BLOCK_SELF',
  /** R10 — a declined sender asking again before the wait is over. */
  REQUEST_DECLINED: 'REQUEST_DECLINED',
  /** R5 — new requests per day. */
  REQUEST_LIMIT: 'REQUEST_LIMIT',
  /** R5 — messages per minute. */
  MESSAGE_LIMIT: 'MESSAGE_LIMIT',
  /** R5 — 1 to 2,000 characters once trimmed. */
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
} as const;
```

and under `PREVIEW_MAX`:

```ts
/** R10 — how long after a decline the sender may ask again. */
export const RESEND_AFTER_MS = 5 * 86_400_000;
```

(b) Change `ConversationView.status` and add `canResendAt`:

```ts
  /** `declined` only ever reaches the sender: the decliner no longer sees the conversation (R3). */
  status: 'request' | 'active' | 'declined';
  /** R10 — when the sender of a declined request may ask again. Null otherwise, and after a block (R6). */
  canResendAt: Date | null;
```

(c) Add to `Messaging`:

```ts
  /** R10 — the viewer's request to this player was declined. */
  requestDeclined: boolean;
  /** R10 — when the viewer may ask again. Null when not declined, or when blocked (R6). */
  canResendAt: Date | null;
```

(d) Add `declinedAt: Date | null;` to `type Row`, and below `readColumn` add:

```ts
const resendAt = (row: Row): Date | null =>
  row.declinedAt ? new Date(row.declinedAt.getTime() + RESEND_AFTER_MS) : null;
```

(e) Replace `view`:

```ts
  function view(row: Row, viewerId: string, blocked: boolean): ConversationView {
    const viewerIsInitiator = row.initiatorId === viewerId;
    const incoming = row.status === 'request' && !viewerIsInitiator;
    // R3 — only the sender ever holds a declined conversation.
    const declined = row.status === 'declined' && viewerIsInitiator;
    // R6 — a block must not surface as a date that then fails.
    const canResendAt = declined && !blocked ? resendAt(row) : null;
    const resendOpen = canResendAt !== null && now() >= canResendAt;
    // Replying to a request accepts it (R3), so the one being asked can always send.
    const canSend = !blocked && (row.status === 'active' || incoming || resendOpen);
    return {
      id: row.id,
      viewerId,
      otherId: otherOf(row, viewerId),
      status: row.status === 'active' ? 'active' : declined ? 'declined' : 'request',
      isIncomingRequest: incoming,
      canSend,
      canResendAt,
      viewerLastReadAt: readAtOf(row, viewerId),
      lastMessageAt: row.lastMessageAt,
    };
  }
```

(f) In `messagingWith`, replace everything from `if (viewerBlocked) return …` to the end of the function with:

```ts
    const declined = visible?.status === 'declined' && visible.initiatorId === viewer.id;
    const none = { requestDeclined: false, canResendAt: null };
    if (viewerBlocked) return { canMessage: false, isRequest: false, conversationId: null, blocked: true, ...none };
    if (otherBlocked) {
      // R6 — silent: they may see their request was declined, never a date.
      return {
        canMessage: false,
        isRequest: declined,
        conversationId: visible?.id ?? null,
        blocked: false,
        requestDeclined: declined,
        canResendAt: null,
      };
    }
    if (visible) {
      const v = view(visible, viewer.id, false);
      // R4 — asking again is a new request, which a private player takes none of.
      const canMessage = v.status === 'declined' ? v.canSend && other.visibility !== 'private' : v.canSend;
      return {
        canMessage,
        isRequest: v.status !== 'active',
        conversationId: visible.id,
        blocked: false,
        requestDeclined: v.status === 'declined',
        canResendAt: v.status === 'declined' && other.visibility !== 'private' ? v.canResendAt : null,
      };
    }
    const shared = await sharedPlay.sharePlay(viewer, other);
    return {
      canMessage: shared || other.visibility !== 'private',
      isRequest: !shared,
      conversationId: null,
      blocked: false,
      ...none,
    };
  }
```

(g) In `send`, pull the request-limit check into one place and add the R10 gate. Replace the block from `const needsShared = …` to the closing brace of `if (!existing && !shared) { … }` with:

```ts
    // Shared play is only worth asking when it could change the answer.
    const needsShared = !existing || (existing.status === 'request' && existing.initiatorId === sender.id);
    const shared = needsShared ? await sharedPlay.sharePlay(sender, recipient) : false;

    // R10 — a declined sender may ask again once the wait is over.
    const askingAgain = existing?.status === 'declined' && existing.initiatorId === sender.id;
    if (askingAgain) {
      const openAt = resendAt(existing)!; // set whenever status is declined (migration 025 CHECK)
      const waitMs = openAt.getTime() - now().getTime();
      if (waitMs > 0) {
        throw new UserError(ChatCode.REQUEST_DECLINED, 'Your request was declined. You can ask again later.', {
          retryAfterSeconds: Math.ceil(waitMs / 1000),
        });
      }
    }

    if ((!existing && !shared) || askingAgain) {
      if (recipient.visibility === 'private') throw cannotMessage(); // R4
      const requests = await limiter.consume(`chat:req:${sender.id}`, REQUEST_WINDOW);
      if (!requests.allowed) {
        throw new UserError(ChatCode.REQUEST_LIMIT, 'You’ve sent too many message requests today.', {
          retryAfterSeconds: requests.retryAfterSeconds,
        });
      }
    }
```

(h) In the transaction, replace the `else { … }` branch (the one starting `const senderIsInitiator = row.initiatorId === sender.id;`) with:

```ts
      } else {
        const senderIsInitiator = row.initiatorId === sender.id;
        let status = row.status as ConversationStatus;
        if (status === 'request' && senderIsInitiator && !shared) throw cannotMessage(); // R3 — one until accepted
        if (status === 'declined' && senderIsInitiator) {
          // R10 — re-checked under the pair lock: another device may have asked first,
          // or the recipient declined again since the check above.
          const openAt = resendAt(row);
          if (!openAt || at < openAt) throw cannotMessage();
          row = await tx.conversation.update({
            where: { id: row.id },
            data: { status: 'request', declinedAt: null },
          });
          notify = 'request';
        } else {
          // Replying accepts (R3); shared play since the request opens it too (R2).
          if (status !== 'active') status = 'active';
          const recipientRead = readAtOf(row, recipient.id);
          // R8 — push only the first unread message.
          notify = !row.lastMessageAt || (recipientRead && recipientRead >= row.lastMessageAt) ? 'message' : null;
          if (status !== row.status) {
            row = await tx.conversation.update({ where: { id: row.id }, data: { status, declinedAt: null } });
          }
        }
      }
```

(i) In `decline`, record the time:

```ts
  /** R3, R10 — leaves the viewer's inbox; the sender sees it declined and may ask again in 5 days. */
  async function decline(actor: Actor, conversationId: string): Promise<void> {
    const { row } = await incomingRequest(actor, conversationId);
    if (row.status === 'request') {
      await db.conversation.update({ where: { id: row.id }, data: { status: 'declined', declinedAt: now() } });
    }
  }
```

(j) Update the file's top comment: change "anyone else gets one message as a request (R3)" to "anyone else gets one message as a request (R3), and may ask again 5 days after a decline (R10)".

- [ ] **Step 4: Run the chat tests**

Run: `npx vitest run tests/chat.test.ts`
Expected: all PASS, including the untouched R1–R9 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0. (The GraphQL layer still compiles: `status` widened, and `Messaging` gained fields the resolver passes through untouched. If typecheck flags `ConversationStatusEnum` in `schema/index.ts`, that is Task 3's first step; do it here instead.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/chat/service/index.ts tests/chat.test.ts
git commit -m "feat(chat): senders see a declined request and may ask again after 5 days (chat R10)"
```

---

### Task 3: Expose the decline in GraphQL (backend)

**Repo:** `PALY_BACKEND`

**Files:**
- Modify: `src/modules/chat/schema/index.ts`
- Regenerate: `schema.graphql` (via `npm run schema:generate`)
- Test: `tests/chat.test.ts` is the behaviour test; this task adds a schema snapshot check through the regenerated file.

**Interfaces:**
- Consumes: `ConversationView.status | canResendAt`, `Messaging.requestDeclined | canResendAt` (Task 2).
- Produces (used by Tasks 4–5): GraphQL `ConversationStatus.DECLINED`, `Conversation.canResendAt: DateTime`, `Messaging.requestDeclined: Boolean!`, `Messaging.canResendAt: DateTime`, error code `REQUEST_DECLINED` in `UserError.code` with `retryAfterSeconds`.

- [ ] **Step 1: Add the enum value and fields**

In `src/modules/chat/schema/index.ts`:

```ts
const ConversationStatusEnum = builder.enumType('ConversationStatus', {
  description:
    'chat R3 — a request becomes active when the other player accepts or replies. ' +
    'DECLINED is only ever shown to the sender (chat R10).',
  values: {
    REQUEST: { value: 'request' as const },
    ACTIVE: { value: 'active' as const },
    DECLINED: { value: 'declined' as const },
  },
});
```

In `ConversationRef` fields, after `canSend`:

```ts
    canResendAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'chat R10 — when you may send a new request after a decline. Null otherwise.',
      resolve: (c) => c.canResendAt,
    }),
```

In `MessagingRef` fields, after `blocked`:

```ts
    requestDeclined: t.exposeBoolean('requestDeclined', {
      description: 'chat R10 — your message request to this player was declined.',
    }),
    canResendAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'chat R10 — when you may send a new request. Null when not declined.',
      resolve: (m) => m.canResendAt,
    }),
```

Change the `ConversationPayload.conversation` description from `'Null after a decline: the request left your inbox.'` to `'Null after you decline: the request left your inbox.'`.

- [ ] **Step 2: Regenerate the schema file**

Run: `npm run schema:generate`
Expected: `schema.graphql` now contains `DECLINED` under `enum ConversationStatus`, `canResendAt: DateTime` on `Conversation` and `Messaging`, and `requestDeclined: Boolean!` on `Messaging`. Check with:

Run: `git diff --stat schema.graphql && grep -n "DECLINED\|requestDeclined\|canResendAt" schema.graphql`
Expected: the four additions, nothing else changed.

- [ ] **Step 3: Run the full backend check**

Run: `npm run check`
Expected: typecheck, lint, guard and all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/chat/schema/index.ts schema.graphql
git commit -m "feat(chat): DECLINED status and canResendAt in the GraphQL API (chat R10)"
```

---

### Task 4: Show "Declined" in the inbox and the conversation (app)

**Repo:** `PLAY_FRONTEND`

**Files:**
- Modify: `apps/player/src/features/chat/api.ts` (type + fragment)
- Modify: `apps/player/src/core/time.ts` (add `formatShortDate`)
- Modify: `apps/player/src/core/copy.ts` (`chat` section)
- Create: `apps/player/src/features/chat/declined.ts`
- Modify: `apps/player/src/features/chat/screens/InboxScreen.tsx` (row chip)
- Modify: `apps/player/src/features/chat/screens/ConversationScreen.tsx` (note above the composer)
- Test: `apps/player/src/features/chat/chat.test.tsx`

**Interfaces:**
- Consumes: GraphQL `Conversation.status` including `DECLINED`, `Conversation.canResendAt` (Task 3).
- Produces: `declinedNote(c, name, now?) => string | null`; `formatShortDate(iso) => string`; copy keys `copy.chat.declined`, `copy.chat.declinedUntil`, `copy.chat.declinedCanResend`, `copy.chat.declinedChip`, `copy.chat.errors.REQUEST_DECLINED`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/player/src/features/chat/chat.test.tsx`:

```tsx
import { declinedNote } from './declined';

describe('chat R10: a declined request', () => {
  const declined: ConversationSummary = {
    ...base,
    status: 'DECLINED',
    canSend: false,
    canResendAt: '2026-10-04T10:00:00.000Z',
    lastMessage: { ...base.lastMessage!, body: 'Hi' },
  };

  it('is marked Declined in the inbox, not as a request', async () => {
    await render(<ConversationRow conversation={declined} onOpen={jest.fn()} />);
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.queryByText('Request')).toBeNull();
  });

  it('tells the sender when they can ask again', () => {
    expect(declinedNote(declined, 'Asha')).toBe('Asha declined your request. You can send a new one on 4 Oct.');
  });

  it('says they can ask now once the wait is over', () => {
    expect(declinedNote({ ...declined, canSend: true }, 'Asha')).toBe(
      'Asha declined your request. You can send a new request now.',
    );
  });

  it('gives no date when the server gives none (a block stays silent)', () => {
    expect(declinedNote({ ...declined, canResendAt: null }, 'Asha')).toBe('Asha declined your request.');
  });

  it('says nothing about a conversation that is not declined', () => {
    expect(declinedNote(base, 'Asha')).toBeNull();
  });
});
```

Also add `canResendAt: null,` to the `base` fixture at the top of the file (after `canSend: true,`).

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `apps/player`): `npx jest src/features/chat/chat.test.tsx`
Expected: FAIL with "Cannot find module './declined'".

- [ ] **Step 3: Add the type and fragment field**

In `apps/player/src/features/chat/api.ts`:

```ts
export interface ConversationSummary {
  id: string;
  other: ChatPlayer | null;
  /** DECLINED only reaches the sender (chat R10). */
  status: 'REQUEST' | 'ACTIVE' | 'DECLINED';
  /** chat R3 — you are being asked. */
  isIncomingRequest: boolean;
  canSend: boolean;
  /** chat R10 — when you may send a new request after a decline. */
  canResendAt: string | null;
  unreadCount: number;
  lastMessage: ChatMessage | null;
  lastMessageAt: string | null;
}
```

and in `CONVERSATION_FIELDS` add `canResendAt` on the line after `canSend`.

- [ ] **Step 4: Add the date formatter**

In `apps/player/src/core/time.ts`, after `formatRelative`:

```ts
/** "4 Oct" — a calendar day on the device's clock, for dates that are not event times. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: deviceTz(), day: 'numeric', month: 'short' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
```

The test expects "4 Oct" for `2026-10-04T10:00:00Z`; that holds for any device time zone from UTC−10 to UTC+13, which covers the test runner. If the runner's zone is set elsewhere, set `TZ=Asia/Kolkata` in the Jest config rather than changing the assertion.

- [ ] **Step 5: Add the copy**

In `apps/player/src/core/copy.ts`, in `chat`, replace the `waiting` comment and add the new keys after `waiting`:

```ts
    /** chat R3 — a sender waits for an answer. */
    waiting: (name: string) => `Request sent. You can send more once ${name} replies.`,
    /** chat R10 — the sender's view of a declined request. */
    declined: (name: string) => `${name} declined your request.`,
    declinedUntil: (name: string, date: string) => `${name} declined your request. You can send a new one on ${date}.`,
    declinedCanResend: (name: string) => `${name} declined your request. You can send a new request now.`,
    declinedChip: 'Declined',
```

and in `chat.errors` add:

```ts
      REQUEST_DECLINED: 'This request was declined. You can send a new one 5 days after.',
```

- [ ] **Step 6: Write `declined.ts`**

`apps/player/src/features/chat/declined.ts`:

```ts
/**
 * chat R10 — what the sender of a declined request is told.
 *
 * The server decides everything: whether it is declined (status), whether they
 * may ask again yet (canSend), and when (canResendAt). A missing date means the
 * server chose not to give one (a block, chat R6); say "declined" and nothing more.
 */
import { copy } from '../../core/copy';
import { formatShortDate } from '../../core/time';
import type { ConversationSummary } from './api';

export function declinedNote(
  c: Pick<ConversationSummary, 'status' | 'canSend' | 'canResendAt'>,
  name: string,
): string | null {
  if (c.status !== 'DECLINED') return null;
  if (c.canSend) return copy.chat.declinedCanResend(name);
  return c.canResendAt ? copy.chat.declinedUntil(name, formatShortDate(c.canResendAt)) : copy.chat.declined(name);
}
```

- [ ] **Step 7: Show the chip in the inbox row**

In `apps/player/src/features/chat/screens/InboxScreen.tsx`, replace

```tsx
          {c.isIncomingRequest ? <Chip kind="neutral" label={copy.chat.request} /> : null}
```

with

```tsx
          {c.isIncomingRequest ? <Chip kind="neutral" label={copy.chat.request} /> : null}
          {c.status === 'DECLINED' ? <Chip kind="neutral" label={copy.chat.declinedChip} /> : null}
```

and update the file's top comment: the server now also returns the viewer's own declined requests (chat R10), still with no client-side filtering.

- [ ] **Step 8: Show the note in the conversation**

In `apps/player/src/features/chat/screens/ConversationScreen.tsx`:

Import `declinedNote` from `'../declined'`. After `const canSend = …`, add:

```tsx
  const declined = c ? declinedNote(c, name) : null;
```

Replace the composer expression with:

```tsx
  const composer = canSend ? (
    <View style={styles.composerWrap}>
      {declined ? (
        <Text variant="bodyS" color="ink2" style={styles.note}>
          {declined}
        </Text>
      ) : null}
      {error ? <InlineError message={error} /> : null}
      <View style={styles.composer}>
        {/* unchanged TextInput and send button */}
      </View>
    </View>
  ) : (
    <Text variant="bodyS" color="ink2" style={styles.note}>
      {declined ??
        (c && c.status === 'REQUEST' && !c.isIncomingRequest ? copy.chat.waiting(name) : copy.chat.cantReply)}
    </Text>
  );
```

(Keep the existing `TextInput` and `Pressable` children exactly as they are; only the `declined` line above `error` is new.)

Update the file's top comment: replace "a declined request reads exactly the same, because the server tells them nothing more" with "a declined request says so, with the date they may ask again (chat R10)".

- [ ] **Step 9: Run the tests**

Run (from `apps/player`): `npx jest src/features/chat`
Expected: all PASS.

- [ ] **Step 10: Typecheck**

Run (from `apps/player`): `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add apps/player/src/features/chat apps/player/src/core/time.ts apps/player/src/core/copy.ts
git commit -m "feat(chat): show a declined request and when a new one can be sent (chat R10)"
```

---

### Task 5: The profile button says "Request declined", then offers a new request (app)

**Repo:** `PLAY_FRONTEND`

**Files:**
- Modify: `apps/player/src/features/profile/api.ts` (`Messaging` type + query)
- Modify: `apps/player/src/features/profile/components/ProfileHero.tsx` (button label)
- Modify: `apps/player/src/core/copy.ts` (`profile.requestDeclined`)
- Modify: `docs/modules/21-chat.md`
- Test: `apps/player/src/features/profile/components/ProfileHero.test.tsx`

**Interfaces:**
- Consumes: GraphQL `Messaging.requestDeclined`, `Messaging.canResendAt` (Task 3).
- Produces: `copy.profile.requestDeclined = 'Request declined'`.

- [ ] **Step 1: Write the failing test**

In `ProfileHero.test.tsx`, add `requestDeclined: false, canResendAt: null` to every `viewerMessaging` object literal already in the file (5 places: lines ~17, 57, 61, 67, 72). Then add:

```tsx
  it('chat R10: a declined request says so, then offers a new request once the wait is over', async () => {
    const waiting = {
      ...profile,
      viewerMessaging: {
        canMessage: false,
        isRequest: true,
        conversationId: 'c1',
        blocked: false,
        requestDeclined: true,
        canResendAt: '2026-10-04T10:00:00.000Z',
      },
    };
    const { rerender } = await render(<ProfileHero profile={waiting} isOwn={false} totalMatches={0} bestRank={null} tint={null} />);
    expect(screen.getByText('Request declined')).toBeTruthy();
    expect(screen.queryByText('Request sent')).toBeNull();

    const open = { ...waiting, viewerMessaging: { ...waiting.viewerMessaging, canMessage: true } };
    await rerender(<ProfileHero profile={open} isOwn={false} totalMatches={0} bestRank={null} tint={null} />);
    expect(screen.getByText('Send a message request')).toBeTruthy();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `apps/player`): `npx jest src/features/profile/components/ProfileHero.test.tsx`
Expected: the R10 test FAILS (the button reads "Request sent"); the others still pass.

- [ ] **Step 3: Add the fields to the profile type and query**

In `apps/player/src/features/profile/api.ts`:

```ts
export interface Messaging {
  canMessage: boolean;
  /** Sending is (or was) a message request, not an open chat (chat R3). */
  isRequest: boolean;
  conversationId: string | null;
  /** You have blocked this player (chat R6). */
  blocked: boolean;
  /** chat R10 — your request to this player was declined. */
  requestDeclined: boolean;
  /** chat R10 — when you may send a new request. */
  canResendAt: string | null;
}
```

and change the selection on line ~142 to:

```graphql
    viewerMessaging { canMessage isRequest conversationId blocked requestDeclined canResendAt }
```

- [ ] **Step 4: Add the copy**

In `copy.ts`, `profile` section, after `requestPending: 'Request sent',`:

```ts
    /** chat R10 — the sender's request was declined; the conversation says when they may ask again. */
    requestDeclined: 'Request declined',
```

- [ ] **Step 5: Change the button label**

In `ProfileHero.tsx`, replace the `label={…}` expression with:

```tsx
          label={
            messaging.requestDeclined
              ? messaging.canMessage
                ? copy.profile.sendRequest
                : copy.profile.requestDeclined
              : messaging.conversationId
                ? messaging.isRequest && !messaging.canMessage
                  ? copy.profile.requestPending
                  : copy.profile.message
                : messaging.isRequest
                  ? copy.profile.sendRequest
                  : copy.profile.message
          }
```

and change `variant` to:

```tsx
          variant={(messaging.isRequest && !messaging.conversationId) || messaging.requestDeclined ? 'ghost' : 'primary'}
```

Tapping either label opens the conversation (existing `onMessage`), which shows the date (Task 4) or the composer.

- [ ] **Step 6: Run the tests**

Run (from `apps/player`): `npx jest src/features/profile src/features/chat`
Expected: all PASS.

- [ ] **Step 7: Update the module doc**

In `docs/modules/21-chat.md`, in **Behaviour → Profile**, change the button list to:

```markdown
- **Profile** — someone else's profile shows one button driven by `viewerMessaging`: *Message*
  (shared play or an open chat), *Send a message request* (none yet, R3; or a declined request whose
  5 days are up, R10), *Request sent* (waiting), *Request declined* (R10, until the date), or nothing
  (R4 private, or blocked by them). Your own block shows a *Blocked* chip (R6).
- **Declined requests (R10)** — the sender sees a *Declined* chip in the inbox and, in the
  conversation, "Asha declined your request. You can send a new one on 4 Oct." Once the date passes
  the composer returns and the next send is a new request. With no date from the server (a block,
  R6) it says only that the request was declined.
```

and add `REQUEST_DECLINED` to the **Error copy** list. Change the Backend contract row from `chat R1`–`R9` to `chat R1`–`R10`.

- [ ] **Step 8: Typecheck and run all app tests**

Run (from `apps/player`): `npx tsc --noEmit && npx jest`
Expected: exit 0, all PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/player/src/features/profile apps/player/src/core/copy.ts docs/modules/21-chat.md
git commit -m "feat(profile): Request declined on the profile, then a new request after 5 days (chat R10)"
```

---

## Self-review notes

- Spec coverage: storage (Task 1), service rules R3 amendment and R10 including R4/R5/R6 interplay (Task 2), API (Task 3), inbox + conversation (Task 4), profile + docs (Task 5).
- Not included, by choice: a push notification to the sender when declined (the spec only asks that it is shown), and a cap on how many times someone can ask again (each decline restarts the 5 days, and blocking stops it for good). Both are one-line additions later if wanted.
