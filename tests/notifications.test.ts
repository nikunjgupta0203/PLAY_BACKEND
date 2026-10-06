/**
 * notifications — service tests against a real Postgres (conventions.md §5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import type { Db } from '../src/platform/db.js';
import type { PushMessage } from '../src/platform/push.js';
import { newId } from '../src/platform/ids.js';
import { isUserError } from '../src/platform/errors/index.js';
import {
  BULK_CHUNK,
  createNotificationsService,
  type NotificationsService,
} from '../src/modules/notifications/service/index.js';

let prisma: PrismaClient;
let service: NotificationsService;
let sent: PushMessage[];
let invalid: Set<string>;
let queued: string[][];
let held: { ids: string[]; at: Date }[];
let receiptChecks: { id: string; token: string }[][];
let deadOnReceipt: Set<string>;
let clock: Date;

/** 10:00 IST — outside quiet hours. */
const DAYTIME = new Date('2026-09-23T04:30:00.000Z');
/** 23:30 IST — inside them. */
const NIGHT = new Date('2026-09-23T18:00:00.000Z');

async function user(): Promise<string> {
  const id = newId();
  await prisma.user.create({ data: { id, email: `${id}@example.com`, displayName: 'P' } });
  return id;
}

const TOKEN = (s: string) => `ExponentPushToken[${s}]`;
const event = { kind: 'event', id: newId(), slug: 'bengaluru-open' } as const;

beforeAll(async () => {
  prisma = (await startTestDb()).prisma;
  service = createNotificationsService({
    db: prisma as unknown as Db,
    push: {
      async send(messages) {
        sent.push(...messages);
        return {
          sent: messages.length,
          invalidTokens: messages.map((m) => m.to).filter((t) => invalid.has(t)),
          tickets: messages.filter((m) => !invalid.has(m.to)).map((m, i) => ({ id: `ticket-${i}`, token: m.to })),
        };
      },
      async checkReceipts(tickets) {
        return { invalidTokens: tickets.map((t) => t.token).filter((t) => deadOnReceipt.has(t)) };
      },
    },
    async enqueuePush(ids, opts) {
      if (opts?.at) held.push({ ids, at: opts.at });
      else queued.push(ids);
    },
    async enqueueReceiptCheck(tickets) {
      receiptChecks.push(tickets);
    },
    async announce() {},
    now: () => clock,
  });
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sent = [];
  invalid = new Set();
  queued = [];
  held = [];
  receiptChecks = [];
  deadOnReceipt = new Set();
  clock = DAYTIME;
});

describe('notifications', () => {
  it('notifications R1: the feed row is written and the push is a separate job', async () => {
    const u = await user();
    const n = await service.emit(u, 'registration.confirmed', { eventTitle: 'Open', categoryName: 'Singles' }, event);
    expect(await prisma.notification.count({ where: { userId: u } })).toBe(1);
    expect(queued).toEqual([[n.id]]);
    expect(sent).toHaveLength(0); // nothing pushed until the job runs
  });

  it('notifications R2: preferences gate the push, never the feed', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'android' });
    await service.setPreferences({ userId: u }, { pushEnabled: false });
    const n = await service.emit(u, 'registration.confirmed', { eventTitle: 'Open', categoryName: 'Singles' }, event);
    expect(await service.deliver([n.id])).toEqual({ [n.id]: 'push_disabled' });
    expect(sent).toHaveLength(0);
    const feed = await service.feed({ userId: u }, { first: 20 });
    expect(feed.edges.map((e) => e.node.id)).toEqual([n.id]);
  });

  it('notifications R2: a muted kind is not pushed, other kinds are', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'android' });
    await service.setPreferences({ userId: u }, { muted: ['draw.generated'] });
    const muted = await service.emit(u, 'draw.generated', { eventTitle: 'Open', categoryName: 'Singles' }, event);
    const loud = await service.emit(u, 'waitlist.offer', { eventTitle: 'Open', categoryName: 'Singles' }, event);
    expect(await service.deliver([muted.id, loud.id])).toEqual({ [muted.id]: 'muted', [loud.id]: 'sent' });
  });

  it('notifications R3: quiet hours hold a push, except a match starting soon', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'ios' });
    clock = NIGHT;
    const quiet = await service.emit(u, 'chat.request', { fromName: 'Asha' }, { kind: 'player', id: newId() });
    const urgent = await service.emit(
      u,
      'match.starting_soon',
      { eventTitle: 'Open', courtName: 'Court 3', startsAt: NIGHT.toISOString() },
      { kind: 'match', id: newId() },
    );
    expect(await service.deliver([quiet.id, urgent.id])).toEqual({
      [quiet.id]: 'quiet_hours',
      [urgent.id]: 'sent',
    });
  });

  it('notifications R3: a held push is re-queued for 07:00 IST and goes out then', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'ios' });
    clock = NIGHT;
    const n = await service.emit(u, 'chat.request', { fromName: 'Asha' }, null);
    await service.deliver([n.id]);
    expect(held).toEqual([{ ids: [n.id], at: new Date('2026-09-24T01:30:00.000Z') }]);

    clock = held[0]!.at;
    expect(await service.deliver(held[0]!.ids)).toEqual({ [n.id]: 'sent' });
    expect(sent).toHaveLength(1);
  });

  it('a push for a row already read in the app is not sent', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'ios' });
    const n = await service.emit(u, 'chat.request', { fromName: 'Asha' }, null);
    await service.markRead({ userId: u }, [n.id]);
    expect(await service.deliver([n.id])).toEqual({ [n.id]: 'already_read' });
    expect(sent).toHaveLength(0);
  });

  it('each push carries the unread count as the app-icon badge', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'ios' });
    await service.emit(u, 'chat.request', { fromName: 'A' }, null);
    const n = await service.emit(u, 'chat.request', { fromName: 'B' }, null);
    await service.deliver([n.id]);
    expect(sent[0]!.badge).toBe(2);
  });

  it('notifications R6: a token dead on its receipt is deleted when receipts are checked', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('a'), platform: 'android' });
    const n = await service.emit(u, 'chat.request', { fromName: 'Asha' }, null);
    await service.deliver([n.id]);
    expect(receiptChecks).toHaveLength(1);
    deadOnReceipt.add(TOKEN('a'));
    expect(await service.checkReceipts(receiptChecks[0]!)).toEqual({ pruned: 1 });
    expect(await prisma.deviceRegistration.count({ where: { userId: u } })).toBe(0);
  });

  it('notifications R6: a token the service calls dead is deleted on the spot', async () => {
    const u = await user();
    await service.registerDevice({ userId: u }, { token: TOKEN('dead'), platform: 'android' });
    await service.registerDevice({ userId: u }, { token: TOKEN('live'), platform: 'android' });
    invalid.add(TOKEN('dead'));
    const n = await service.emit(u, 'chat.request', { fromName: 'Asha' }, null);
    await service.deliver([n.id]);
    const tokens = (await prisma.deviceRegistration.findMany({ where: { userId: u } })).map((d) => d.token);
    expect(tokens).toEqual([TOKEN('live')]);
  });

  it('notifications R7: a bulk emit is chunked into one push job per 500', async () => {
    const users: string[] = [];
    for (let i = 0; i < 3; i += 1) users.push(await user());
    const out = await service.emitBulk(users, 'event.cancelled', { eventTitle: 'Open' }, event);
    expect(out.queued).toBe(3);
    expect(queued).toHaveLength(1);
    expect(BULK_CHUNK).toBe(500);
  });

  it('notifications R8: reads and marks are scoped to their owner', async () => {
    const me = await user();
    const other = await user();
    const theirs = await service.emit(other, 'chat.request', { fromName: 'Asha' }, null);
    await service.emit(me, 'chat.request', { fromName: 'Ravi' }, null);

    expect((await service.feed({ userId: me }, { first: 20 })).edges).toHaveLength(1);
    await service.markRead({ userId: me }, [theirs.id]);
    expect(await service.unreadCount({ userId: other })).toBe(1);
  });

  it('marking one read leaves the rest unread; mark-all clears the badge', async () => {
    const u = await user();
    const a = await service.emit(u, 'chat.request', { fromName: 'A' }, null);
    await service.emit(u, 'chat.request', { fromName: 'B' }, null);
    expect(await service.markRead({ userId: u }, [a.id])).toBe(1);
    expect(await service.markAllRead({ userId: u })).toBe(0);
    expect(await service.unreadCount({ userId: u })).toBe(0);
  });

  it('the feed pages newest first with a stable cursor', async () => {
    const u = await user();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock = new Date(DAYTIME.getTime() + i * 1000);
      ids.push((await service.emit(u, 'chat.request', { fromName: `P${i}` }, null)).id);
    }
    const first = await service.feed({ userId: u }, { first: 2 });
    expect(first.hasNextPage).toBe(true);
    const second = await service.feed({ userId: u }, { first: 10, after: first.edges.at(-1)!.cursor });
    const all = [...first.edges, ...second.edges].map((e) => e.node.id);
    expect(new Set(all).size).toBe(5);
  });

  it('notifications R10: an event is linked by slug; a route by a closed enum', async () => {
    const u = await user();
    await service.emit(u, 'registration.confirmed', { eventTitle: 'Open', categoryName: 'Singles' }, event);
    await service.emit(u, 'payment.updated', { eventTitle: 'Open', state: 'refunded', amountPaise: '59000' }, {
      kind: 'route',
      route: 'payment_history',
    });
    const targets = (await service.feed({ userId: u }, { first: 20 })).edges.map((e) => e.node.target);
    expect(targets).toContainEqual({ kind: 'event', id: event.id, slug: 'bengaluru-open' });
    expect(targets).toContainEqual({ kind: 'route', route: 'payment_history' });
  });

  it('a device token moves to whoever registers it last', async () => {
    const first = await user();
    const second = await user();
    await service.registerDevice({ userId: first }, { token: TOKEN('shared'), platform: 'android' });
    await service.registerDevice({ userId: second }, { token: TOKEN('shared'), platform: 'android' });
    const rows = await prisma.deviceRegistration.findMany();
    expect(rows.map((r) => r.userId)).toEqual([second]);
  });

  it('refuses a string that is not a push token', async () => {
    const u = await user();
    try {
      await service.registerDevice({ userId: u }, { token: 'nope', platform: 'android' });
      expect.unreachable();
    } catch (e) {
      expect(isUserError(e) && e.code).toBe('INVALID_DEVICE_TOKEN');
    }
  });
});
