/**
 * notifications — service layer (docs/modules/11-notifications.md).
 *
 * One `emit`, two destinations: a durable feed row, always (R1), and a push
 * job that may be suppressed, may fail and may be dropped without the player
 * losing anything, because the row is already there.
 *
 * This module is handed a user id, a template key and a typed payload. It
 * never reads another module's tables and imports none of them; working out
 * WHO to tell and WHAT the facts are is the caller's job (src/notify.ts).
 */
import type { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import type { PushGateway, PushTicket } from '../../../platform/push.js';
import {
  DEEP_LINK_ROUTES,
  inQuietHours,
  isTemplateKey,
  overridesQuietHours,
  quietHoursEnd,
  render,
  type DeepLinkRoute,
  type Target,
  type TemplateKey,
  type TemplatePayloads,
} from '../templates.js';

export const NotificationCode = {
  INVALID_DEVICE_TOKEN: 'INVALID_DEVICE_TOKEN',
  UNKNOWN_TEMPLATE: 'UNKNOWN_TEMPLATE',
} as const;

/** R7 — one large tournament cannot stall the queue. */
export const BULK_CHUNK = 500;

export interface Actor {
  userId: string;
}

export interface Notification {
  id: string;
  userId: string;
  template: string;
  payload: unknown;
  title: string;
  body: string;
  target: Target | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface Preferences {
  pushEnabled: boolean;
  muted: TemplateKey[];
  quietHours: boolean;
}

/** `quiet_hours` means held until 07:00 IST, not dropped (R3). */
export type Delivery =
  | 'sent'
  | 'no_device'
  | 'push_disabled'
  | 'muted'
  | 'quiet_hours'
  | 'already_read'
  | 'missing';

export interface NotificationsDeps {
  db: Db;
  push: PushGateway;
  /**
   * Queue the push for a row, now or at `at`. The worker runs `deliver`;
   * tests may run it inline.
   */
  enqueuePush(notificationIds: string[], opts?: { at?: Date }): Promise<void>;
  /** Queue a receipt check for tickets the push service accepted (R6). */
  enqueueReceiptCheck(tickets: PushTicket[]): Promise<void>;
  /** Best-effort badge hint on private-user-{id}. Never fails an emit. */
  announce(userIds: string[]): Promise<void>;
  now?: () => Date;
}

const DEFAULTS: Preferences = { pushEnabled: true, muted: [], quietHours: true };

/** Expo push tokens. A string that is not one never reaches the table. */
const TOKEN = /^Expo(nent)?PushToken\[[^\]]{1,200}\]$/;

type Row = {
  id: string;
  userId: string;
  template: string;
  payload: Prisma.JsonValue;
  targetKind: string | null;
  targetId: string | null;
  targetRoute: string | null;
  readAt: Date | null;
  createdAt: Date;
};

function targetOf(row: Row): Target | null {
  if (row.targetKind === 'route') {
    const route = row.targetRoute as DeepLinkRoute;
    if (!DEEP_LINK_ROUTES.includes(route)) return null;
    return row.targetId ? { kind: 'route', route, id: row.targetId } : { kind: 'route', route };
  }
  if (!row.targetKind || !row.targetId) return null;
  if (row.targetKind === 'event') {
    const slug = (row.payload as { eventSlug?: unknown } | null)?.eventSlug;
    return typeof slug === 'string' ? { kind: 'event', id: row.targetId, slug } : null;
  }
  return { kind: row.targetKind as Exclude<Target['kind'], 'event' | 'route'>, id: row.targetId };
}

function toNotification(row: Row): Notification {
  const copy = render(row.template, row.payload) ?? { title: 'PL4Y', body: '' };
  return {
    id: row.id,
    userId: row.userId,
    template: row.template,
    payload: row.payload,
    title: copy.title,
    body: copy.body,
    target: targetOf(row),
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

function columns(target: Target | null) {
  if (!target) return { targetKind: null, targetId: null, targetRoute: null };
  if (target.kind === 'route') {
    return { targetKind: 'route', targetId: target.id ?? null, targetRoute: target.route };
  }
  return { targetKind: target.kind, targetId: target.id, targetRoute: null };
}

/** An event is reached by slug; the slug rides in the payload so the row is self-contained. */
function storedPayload(payload: object, target: Target | null): Prisma.InputJsonValue {
  const out = target?.kind === 'event' ? { ...payload, eventSlug: target.slug } : payload;
  return out as Prisma.InputJsonValue;
}

const cursorOf = (n: { createdAt: Date; id: string }) =>
  Buffer.from(`${n.createdAt.toISOString()}|${n.id}`).toString('base64url');

function parseCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

export function createNotificationsService(deps: NotificationsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // --- emit (R1) -----------------------------------------------------------

  async function emit<K extends TemplateKey>(
    userId: string,
    template: K,
    payload: TemplatePayloads[K],
    target: Target | null,
  ): Promise<Notification> {
    const row = await db.notification.create({
      data: {
        id: newId(),
        userId,
        template,
        payload: storedPayload(payload, target),
        ...columns(target),
      },
    });
    await deps.enqueuePush([row.id]);
    await deps.announce([userId]).catch(() => undefined);
    return toNotification(row);
  }

  /** R7 — rows in chunks of 500, one push job per chunk. */
  async function emitBulk<K extends TemplateKey>(
    userIds: string[],
    template: K,
    payload: TemplatePayloads[K],
    target: Target | null,
  ): Promise<{ queued: number }> {
    const unique = [...new Set(userIds)];
    for (let i = 0; i < unique.length; i += BULK_CHUNK) {
      const chunk = unique.slice(i, i + BULK_CHUNK);
      const rows = chunk.map((userId) => ({
        id: newId(),
        userId,
        template,
        payload: storedPayload(payload, target),
        ...columns(target),
      }));
      await db.notification.createMany({ data: rows });
      await deps.enqueuePush(rows.map((r) => r.id));
      await deps.announce(chunk).catch(() => undefined);
    }
    return { queued: unique.length };
  }

  // --- push (R2, R3, R6) ---------------------------------------------------

  /** Why a row will or will not be pushed. Pure over its inputs, so the rules test without a phone. */
  function pushDecision(template: string, prefs: Preferences, at: Date): Delivery | null {
    if (!prefs.pushEnabled) return 'push_disabled';
    if (isTemplateKey(template) && prefs.muted.includes(template)) return 'muted';
    const override = isTemplateKey(template) && overridesQuietHours(template);
    if (prefs.quietHours && !override && inQuietHours(at)) return 'quiet_hours';
    return null;
  }

  /**
   * The `send-push` job. R2 — preferences decide the push and nothing else;
   * the row this reads was written before any of them were consulted.
   */
  async function deliver(notificationIds: string[]): Promise<Record<string, Delivery>> {
    const out: Record<string, Delivery> = {};
    const rows = await db.notification.findMany({ where: { id: { in: notificationIds } } });
    const found = new Set(rows.map((r) => r.id));
    for (const id of notificationIds) if (!found.has(id)) out[id] = 'missing';

    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [prefRows, devices] = await Promise.all([
      db.notificationPreferences.findMany({ where: { userId: { in: userIds } } }),
      db.deviceRegistration.findMany({ where: { userId: { in: userIds } } }),
    ]);
    const prefs = new Map(prefRows.map((p) => [p.userId, p]));
    const tokens = new Map<string, string[]>();
    for (const d of devices) tokens.set(d.userId, [...(tokens.get(d.userId) ?? []), d.token]);

    // The app-icon badge each push carries: the recipient's unread count.
    const unread = await db.notification.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, readAt: null },
      _count: { _all: true },
    });
    const badges = new Map(unread.map((u) => [u.userId, u._count._all]));

    const at = now();
    const held: string[] = [];
    const messages: {
      to: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
      badge: number;
    }[] = [];
    for (const row of rows) {
      // Seen in the app before the push went out (a held push, most often):
      // buzzing the phone about it now is noise.
      if (row.readAt) {
        out[row.id] = 'already_read';
        continue;
      }
      const p = prefs.get(row.userId);
      const decision = pushDecision(
        row.template,
        p ? { pushEnabled: p.pushEnabled, muted: p.muted as TemplateKey[], quietHours: p.quietHours } : DEFAULTS,
        at,
      );
      if (decision) {
        out[row.id] = decision;
        if (decision === 'quiet_hours') held.push(row.id);
        continue;
      }
      const userTokens = tokens.get(row.userId) ?? [];
      if (userTokens.length === 0) {
        out[row.id] = 'no_device';
        continue;
      }
      const n = toNotification(row);
      // The payload carries only what routes the tap. The app refetches the
      // feed for everything else (client notifications R1).
      const data = { notificationId: row.id, target: n.target };
      const badge = badges.get(row.userId) ?? 0;
      for (const to of userTokens) messages.push({ to, title: n.title, body: n.body, data, badge });
      out[row.id] = 'sent';
    }

    // R3 — held, not dropped: the same rows are delivered again at 07:00 IST,
    // when preferences and read state are re-read.
    if (held.length > 0) await deps.enqueuePush(held, { at: quietHoursEnd(at) });

    if (messages.length > 0) {
      const result = await deps.push.send(messages);
      await pruneTokens(result.invalidTokens);
      if (result.tickets.length > 0) await deps.enqueueReceiptCheck(result.tickets);
    }
    return out;
  }

  /** R6 — deleted on the spot, never retried. */
  async function pruneTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await db.deviceRegistration.deleteMany({ where: { token: { in: tokens } } });
    logger.info({ count: tokens.length }, 'pruned invalid push tokens');
  }

  /** The `check-push-receipts` job: dead tokens surface on receipts, minutes after the send. */
  async function checkReceipts(tickets: PushTicket[]): Promise<{ pruned: number }> {
    const { invalidTokens } = await deps.push.checkReceipts(tickets);
    await pruneTokens(invalidTokens);
    return { pruned: invalidTokens.length };
  }

  // --- the feed (R8 — always the actor's own) -----------------------------

  async function feed(
    actor: Actor,
    page: { first: number; after?: string | null },
  ): Promise<{ edges: { cursor: string; node: Notification }[]; hasNextPage: boolean }> {
    const after = page.after ? parseCursor(page.after) : null;
    const rows = await db.notification.findMany({
      where: {
        userId: actor.userId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.first + 1,
    });
    const edges = rows.slice(0, page.first).map((row) => ({ cursor: cursorOf(row), node: toNotification(row) }));
    return { edges, hasNextPage: rows.length > page.first };
  }

  const unreadCount = (actor: Actor): Promise<number> =>
    db.notification.count({ where: { userId: actor.userId, readAt: null } });

  /** R8 — another user's ids are silently ignored: no leak of whether they exist. */
  async function markRead(actor: Actor, ids: string[]): Promise<number> {
    if (ids.length === 0) return unreadCount(actor);
    await db.notification.updateMany({
      where: { id: { in: ids.slice(0, 100) }, userId: actor.userId, readAt: null },
      data: { readAt: now() },
    });
    return unreadCount(actor);
  }

  async function markAllRead(actor: Actor): Promise<number> {
    await db.notification.updateMany({
      where: { userId: actor.userId, readAt: null },
      data: { readAt: now() },
    });
    return 0;
  }

  // --- devices -------------------------------------------------------------

  /**
   * Upsert by token. A token already registered to somebody else moves: the
   * phone changed hands (or accounts), and pushing the previous owner's
   * notifications to it would be a leak.
   */
  async function registerDevice(
    actor: Actor,
    input: { token: string; platform: 'ios' | 'android' | 'web' },
  ): Promise<void> {
    if (!TOKEN.test(input.token)) {
      throw new UserError(NotificationCode.INVALID_DEVICE_TOKEN, 'That is not a push token this app issues.');
    }
    await db.deviceRegistration.upsert({
      where: { token: input.token },
      create: { id: newId(), userId: actor.userId, token: input.token, platform: input.platform },
      update: { userId: actor.userId, platform: input.platform, lastSeenAt: now() },
    });
  }

  async function unregisterDevice(actor: Actor, token: string): Promise<void> {
    await db.deviceRegistration.deleteMany({ where: { token, userId: actor.userId } });
  }

  // --- preferences (R2) ----------------------------------------------------

  async function preferences(actor: Actor): Promise<Preferences> {
    const row = await db.notificationPreferences.findUnique({ where: { userId: actor.userId } });
    return row
      ? { pushEnabled: row.pushEnabled, muted: row.muted.filter(isTemplateKey), quietHours: row.quietHours }
      : { ...DEFAULTS };
  }

  async function setPreferences(actor: Actor, input: Partial<Preferences>): Promise<Preferences> {
    const unknown = (input.muted ?? []).filter((k) => !isTemplateKey(k));
    if (unknown.length > 0) {
      throw new UserError(NotificationCode.UNKNOWN_TEMPLATE, `Unknown notification kind: ${unknown[0]}.`);
    }
    const current = await preferences(actor);
    const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    await db.notificationPreferences.upsert({
      where: { userId: actor.userId },
      create: { userId: actor.userId, ...next },
      update: next,
    });
    return next as Preferences;
  }

  return {
    emit,
    emitBulk,
    deliver,
    checkReceipts,
    pushDecision,
    feed,
    unreadCount,
    markRead,
    markAllRead,
    registerDevice,
    unregisterDevice,
    preferences,
    setPreferences,
  };
}

export type NotificationsService = ReturnType<typeof createNotificationsService>;
