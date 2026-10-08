/**
 * chat — service tests against a real Postgres (conventions.md §5).
 * Every rule has a test that names it: `grep 'R3:'` finds chat R3.
 * Shared play (R2) is a port; which pairs share it is set per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import { createChatService, type ChatService } from '../src/modules/chat/service/index.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import { createRateLimiter } from '../src/platform/rateLimit.js';
import type { Db, Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';

let prisma: PrismaClient;
let profile: ProfileService;
let chat: ChatService;
let clock: Date;
const shared = new Set<string>();
const key = (a: string, b: string) => [a, b].sort().join('|');

interface Player {
  userId: string;
  playerId: string;
  actor: { userId: string };
}

async function makePlayer(name: string): Promise<Player> {
  const userId = newId();
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: `${name.toLowerCase()}@example.com`, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  return { userId, playerId, actor: { userId } };
}

const tick = (ms = 1_000) => {
  clock = new Date(clock.getTime() + ms);
};
const DAY = 86_400_000;

beforeAll(async () => {
  ({ prisma } = await startTestDb());
  profile = buildModules(prisma).profile;
  const limiter = createRateLimiter(prisma as unknown as Db);
  chat = createChatService({
    db: prisma as unknown as Db,
    profiles: {
      findByUserId: (userId) => profile.findByUserId(userId),
      findById: (playerId) => profile.findById(playerId),
    },
    sharedPlay: { sharePlay: async (a, b) => shared.has(key(a.id, b.id)) },
    limiter: { consume: (k, w) => limiter.consume(k, w, clock.getTime()) },
    now: () => clock,
  });
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  shared.clear();
  clock = new Date('2026-09-29T10:00:00Z');
});

describe('who may message whom', () => {
  it('R1: never yourself, never a player who does not exist', async () => {
    const ravi = await makePlayer('Ravi');
    await expect(chat.send(ravi.actor, { playerId: ravi.playerId, body: 'hi' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
    await expect(chat.send(ravi.actor, { playerId: newId(), body: 'hi' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
  });

  it('R2: shared play opens the conversation active, both ways', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    shared.add(key(ravi.playerId, asha.playerId));

    expect(await chat.messagingWith(ravi.userId, asha.playerId)).toMatchObject({
      canMessage: true,
      isRequest: false,
      conversationId: null,
    });
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Doubles Saturday?' });
    expect(conversation).toMatchObject({ status: 'active', canSend: true, isIncomingRequest: false });

    tick();
    await chat.send(ravi.actor, { playerId: asha.playerId, body: '8am?' });
    tick();
    await chat.send(asha.actor, { playerId: ravi.playerId, body: 'In' });
    const page = await chat.messages(asha.userId, conversation.id, { first: 10 });
    expect(page.nodes.map((m) => m.body)).toEqual(['In', '8am?', 'Doubles Saturday?']);
  });

  it('R3: without shared play the first message is a request, and the sender gets exactly one', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');

    expect((await chat.messagingWith(ravi.userId, asha.playerId))?.isRequest).toBe(true);
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi, saw your match' });
    expect(conversation).toMatchObject({ status: 'request', canSend: false, isIncomingRequest: false });

    await expect(chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hello?' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
    const incoming = await chat.byId(asha.userId, conversation.id);
    expect(incoming).toMatchObject({ status: 'request', isIncomingRequest: true, canSend: true });
  });

  it('R3: replying accepts the request', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi' });

    tick();
    await chat.send(asha.actor, { playerId: ravi.playerId, body: 'Hey!' });
    expect(await chat.byId(ravi.userId, conversation.id)).toMatchObject({ status: 'active', canSend: true });
    tick();
    await expect(chat.send(ravi.actor, { playerId: asha.playerId, body: 'Great' })).resolves.toBeTruthy();
  });

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

  it('R2: shared play since the request lets the sender continue', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi' });
    shared.add(key(ravi.playerId, asha.playerId));
    tick();
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Good game today!' });
    expect(conversation.status).toBe('active');
  });

  it('R4: a private player takes no requests, but shared play still reaches them', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    await profile.setVisibility(asha.actor, 'private');

    expect(await chat.messagingWith(ravi.userId, asha.playerId)).toMatchObject({ canMessage: false });
    await expect(chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });

    shared.add(key(ravi.playerId, asha.playerId));
    await expect(chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi partner' })).resolves.toBeTruthy();
  });
});

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
    // The conversation itself agrees: no send box, no date to wait for.
    const { id } = (await chat.list(meera.userId, { first: 5 })).nodes[0]!;
    for (const v of [await chat.byId(meera.userId, id), (await chat.list(meera.userId, { first: 5 })).nodes[0]]) {
      expect(v).toMatchObject({ id, status: 'declined', canSend: false, canResendAt: null });
    }
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

describe('limits (R5)', () => {
  it('R5: a message is 1 to 2,000 characters once trimmed', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    for (const body of ['   ', 'x'.repeat(2_001)]) {
      await expect(chat.send(ravi.actor, { playerId: asha.playerId, body })).rejects.toMatchObject({
        code: 'INVALID_MESSAGE',
      });
    }
    const { message } = await chat.send(ravi.actor, { playerId: asha.playerId, body: '  hi  ' });
    expect(message.body).toBe('hi');
  });

  it('R5: ten new requests a day', async () => {
    const ravi = await makePlayer('Ravi');
    for (let i = 0; i < 10; i++) {
      const p = await makePlayer(`P${i}`);
      await chat.send(ravi.actor, { playerId: p.playerId, body: 'hi' });
    }
    const eleventh = await makePlayer('Eleventh');
    await expect(chat.send(ravi.actor, { playerId: eleventh.playerId, body: 'hi' })).rejects.toMatchObject({
      code: 'REQUEST_LIMIT',
    });
  });

  it('R5: thirty messages a minute, with the wait', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    shared.add(key(ravi.playerId, asha.playerId));
    for (let i = 0; i < 30; i++) await chat.send(ravi.actor, { playerId: asha.playerId, body: `m${i}` });
    const err = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'one more' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'MESSAGE_LIMIT' });
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('blocking (R6)', () => {
  it('R6: a block stops both directions, hides the chat from the blocker, and is silent', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    shared.add(key(ravi.playerId, asha.playerId));
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'hi' });

    await chat.block(asha.actor, ravi.playerId);
    await chat.block(asha.actor, ravi.playerId); // idempotent
    await expect(chat.send(ravi.actor, { playerId: asha.playerId, body: 'hello?' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
    await expect(chat.send(asha.actor, { playerId: ravi.playerId, body: 'x' })).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE',
    });
    expect(await chat.byId(asha.userId, conversation.id)).toBeNull();
    expect((await chat.list(asha.userId, { first: 10 })).nodes).toEqual([]);
    expect(await chat.messagingWith(asha.userId, ravi.playerId)).toMatchObject({ blocked: true, canMessage: false });
    // Ravi is not told: the conversation is still there, it just cannot take a message.
    expect(await chat.byId(ravi.userId, conversation.id)).toMatchObject({ canSend: false });
    expect(await chat.messagingWith(ravi.userId, asha.playerId)).toMatchObject({ blocked: false, canMessage: false });

    await chat.unblock(asha.actor, ravi.playerId);
    await expect(chat.send(ravi.actor, { playerId: asha.playerId, body: 'hi again' })).resolves.toBeTruthy();
  });

  it('R6: you cannot block yourself', async () => {
    const ravi = await makePlayer('Ravi');
    await expect(chat.block(ravi.actor, ravi.playerId)).rejects.toMatchObject({ code: 'CANNOT_BLOCK_SELF' });
  });
});

describe('read state and notifications (R7, R8)', () => {
  it('R7: unread counts messages from the other side after your last read', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    shared.add(key(ravi.playerId, asha.playerId));
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'one' });
    tick();
    await chat.send(ravi.actor, { playerId: asha.playerId, body: 'two' });

    const seen = await chat.byId(asha.userId, conversation.id);
    expect(await chat.unreadIn(seen!)).toBe(2);
    expect(await chat.unreadConversationCount(asha.userId)).toBe(1);
    // Your own messages are never unread to you.
    expect(await chat.unreadConversationCount(ravi.userId)).toBe(0);

    tick();
    await chat.markRead(asha.actor, conversation.id);
    expect(await chat.unreadIn((await chat.byId(asha.userId, conversation.id))!)).toBe(0);
    expect(await chat.unreadConversationCount(asha.userId)).toBe(0);
  });

  it('R7, R9: the batched inbox reads agree with the one-at-a-time ones', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    const meera = await makePlayer('Meera');
    const dev = await makePlayer('Dev');
    shared.add(key(ravi.playerId, asha.playerId));
    shared.add(key(meera.playerId, asha.playerId));
    await chat.send(ravi.actor, { playerId: asha.playerId, body: 'one' });
    tick();
    await chat.send(ravi.actor, { playerId: asha.playerId, body: 'two' });
    tick();
    await chat.send(meera.actor, { playerId: asha.playerId, body: 'hi' });
    tick();
    await chat.send(asha.actor, { playerId: meera.playerId, body: 'hello' });
    tick();
    await chat.send(asha.actor, { playerId: dev.playerId, body: 'only mine' }); // a request Asha sent

    const inbox = (await chat.list(asha.userId, { first: 10 })).nodes;
    expect(inbox).toHaveLength(3);
    const counts = await chat.unreadCounts(inbox);
    const lasts = await chat.lastMessages(inbox.map((c) => c.id));
    for (const c of inbox) {
      expect(counts.get(c.id)).toBe(await chat.unreadIn(c));
      expect(lasts.get(c.id)).toEqual(await chat.lastMessage(c.id));
    }
    expect([...counts.values()].sort()).toEqual([0, 0, 2]);
    expect(await chat.lastMessages([])).toEqual(new Map());

    const views = await profile.publicViews(asha.userId, [ravi.playerId, meera.playerId, newId()]);
    expect(views.size).toBe(2);
    expect(views.get(ravi.playerId)).toEqual(await profile.publicView(asha.userId, ravi.playerId));
  });

  it('R8: a request notifies; after that only the first unread message does', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    const notified = async () =>
      (await prisma.outbox.findMany({ where: { topic: 'chat.message.sent' }, orderBy: { id: 'asc' } })).map(
        (r) => (r.payload as { notify: string | null }).notify,
      );

    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'Hi' });
    tick();
    await chat.send(asha.actor, { playerId: ravi.playerId, body: 'Hey' }); // Ravi read everything: notify
    tick();
    await chat.send(asha.actor, { playerId: ravi.playerId, body: 'You there?' }); // still unread: quiet
    tick();
    await chat.markRead(ravi.actor, conversation.id);
    tick();
    await chat.send(asha.actor, { playerId: ravi.playerId, body: 'Saturday then' }); // read again: notify

    expect(await notified()).toEqual(['request', 'message', null, 'message']);
    const last = await prisma.outbox.findFirstOrThrow({ where: { topic: 'chat.message.sent' }, orderBy: { id: 'desc' } });
    expect(last.payload).toMatchObject({ recipientUserId: ravi.userId, preview: 'Saturday then' });
  });
});

describe('inbox (R9)', () => {
  it('R9: newest activity first, paged; messages newest first, paged', async () => {
    const ravi = await makePlayer('Ravi');
    const others = [await makePlayer('A'), await makePlayer('B'), await makePlayer('C')];
    for (const o of others) {
      shared.add(key(ravi.playerId, o.playerId));
      tick();
      await chat.send(ravi.actor, { playerId: o.playerId, body: `hi ${o.playerId}` });
    }
    tick();
    await chat.send(others[0]!.actor, { playerId: ravi.playerId, body: 'back to top' });

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await chat.list(ravi.userId, { first: 2, after });
      seen.push(...page.nodes.map((c) => c.otherId));
      if (!page.hasNextPage) break;
      after = page.endCursor;
    }
    expect(seen).toEqual([others[0]!.playerId, others[2]!.playerId, others[1]!.playerId]);

    const conv = (await chat.list(ravi.userId, { first: 1 })).nodes[0]!;
    const first = await chat.messages(ravi.userId, conv.id, { first: 1 });
    expect(first.nodes[0]?.body).toBe('back to top');
    const rest = await chat.messages(ravi.userId, conv.id, { first: 5, after: first.endCursor });
    expect(rest.nodes.map((m) => m.body)).toEqual([`hi ${others[0]!.playerId}`]);
  });

  it('a stranger reads nothing of a conversation they are not in', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    const eve = await makePlayer('Eve');
    const { conversation } = await chat.send(ravi.actor, { playerId: asha.playerId, body: 'private' });
    expect(await chat.byId(eve.userId, conversation.id)).toBeNull();
    expect((await chat.messages(eve.userId, conversation.id, { first: 10 })).nodes).toEqual([]);
    await expect(chat.markRead(eve.actor, conversation.id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
  });

  it('two first messages racing open one conversation', async () => {
    const ravi = await makePlayer('Ravi');
    const asha = await makePlayer('Asha');
    shared.add(key(ravi.playerId, asha.playerId));
    await Promise.all([
      chat.send(ravi.actor, { playerId: asha.playerId, body: 'a' }),
      chat.send(asha.actor, { playerId: ravi.playerId, body: 'b' }),
    ]);
    expect(await prisma.conversation.count()).toBe(1);
    expect(await prisma.message.count()).toBe(2);
  });
});
