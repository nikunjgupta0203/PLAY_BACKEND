/**
 * chat — service layer (docs/superpowers/specs/2026-09-29-chat-design.md).
 *
 * One-to-one conversations between players. Shared play opens a chat directly
 * (R2); anyone else gets one message as a request (R3), and may ask again 5 days after a decline (R10). Blocks are silent (R6).
 *
 * Services never import GraphQL types (conventions.md §1). Profiles, shared
 * play and the rate limiter arrive as ports.
 */
import type { Db, Tx } from '../../../platform/db.js';
import { newId } from '../../../platform/ids.js';
import { UserError } from '../../../platform/errors/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';

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

export const MESSAGE_MAX = 2_000;
export const REQUEST_WINDOW = { seconds: 86_400, max: 10 };
export const MESSAGE_WINDOW = { seconds: 60, max: 30 };
/** R8 — how much of a message a push shows. */
export const PREVIEW_MAX = 80;
/** R10 — how long after a decline the sender may ask again. */
export const RESEND_AFTER_MS = 5 * 86_400_000;

export type ConversationStatus = 'request' | 'active' | 'declined';

export interface Actor {
  userId: string;
}

/** A conversation as ONE side sees it. */
export interface ConversationView {
  id: string;
  viewerId: string;
  otherId: string;
  /** `declined` only ever reaches the sender: the decliner no longer sees the conversation (R3). */
  status: 'request' | 'active' | 'declined';
  /** The viewer is the one being asked (R3). */
  isIncomingRequest: boolean;
  /** Whether the viewer can send right now. */
  canSend: boolean;
  /** R10 — when the sender of a declined request may ask again. Null otherwise, and after a block (R6). */
  canResendAt: Date | null;
  viewerLastReadAt: Date | null;
  lastMessageAt: Date | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
}

/** What a profile shows about messaging its owner. */
export interface Messaging {
  canMessage: boolean;
  /** Sending would be (or already is) a request rather than an open chat. */
  isRequest: boolean;
  conversationId: string | null;
  /** The viewer has blocked this player. */
  blocked: boolean;
  /** R10 — the viewer's request to this player was declined. */
  requestDeclined: boolean;
  /** R10 — when the viewer may ask again. Null when not declined, or when blocked (R6). */
  canResendAt: Date | null;
}

export interface Page<T> {
  nodes: T[];
  cursors: string[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// --- ports -------------------------------------------------------------------

export interface ChatProfile {
  id: string;
  userId: string;
  visibility: 'public' | 'players_only' | 'private';
}

export interface ProfilesPort {
  findByUserId(userId: string): Promise<ChatProfile | null>;
  findById(playerId: string): Promise<ChatProfile | null>;
}

/** R2 — played a completed match together, or partners on a live entry. */
export interface SharedPlayPort {
  sharePlay(a: ChatProfile, b: ChatProfile): Promise<boolean>;
}

export interface LimiterPort {
  consume(
    key: string,
    window: { seconds: number; max: number },
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface ChatDeps {
  db: Db;
  profiles: ProfilesPort;
  sharedPlay: SharedPlayPort;
  limiter: LimiterPort;
  now?: () => Date;
}

// --- helpers -----------------------------------------------------------------

type Row = {
  id: string;
  playerLowId: string;
  playerHighId: string;
  initiatorId: string;
  status: string;
  lowLastReadAt: Date | null;
  highLastReadAt: Date | null;
  lastMessageAt: Date | null;
  declinedAt: Date | null;
  createdAt: Date;
};

const cannotMessage = () =>
  new UserError(ChatCode.CANNOT_MESSAGE, 'You can’t message this player.');
const notFound = () =>
  new UserError(ChatCode.CONVERSATION_NOT_FOUND, 'That conversation does not exist.');

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const isLow = (row: Row, playerId: string) => row.playerLowId === playerId;
const otherOf = (row: Row, playerId: string) => (isLow(row, playerId) ? row.playerHighId : row.playerLowId);
const readAtOf = (row: Row, playerId: string) => (isLow(row, playerId) ? row.lowLastReadAt : row.highLastReadAt);
const readColumn = (row: Row, playerId: string) =>
  isLow(row, playerId) ? ('lowLastReadAt' as const) : ('highLastReadAt' as const);

const resendAt = (row: Row): Date | null =>
  row.declinedAt ? new Date(row.declinedAt.getTime() + RESEND_AFTER_MS) : null;

const encodeCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  return id && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}

export function createChatService(deps: ChatDeps) {
  const { db, profiles, sharedPlay, limiter } = deps;
  const now = deps.now ?? (() => new Date());

  async function me(actor: Actor): Promise<ChatProfile> {
    const found = await profiles.findByUserId(actor.userId);
    if (!found) throw cannotMessage();
    return found;
  }

  /** R6 — [viewer blocked other, other blocked viewer]. */
  async function blocksBetween(viewerId: string, otherId: string): Promise<[boolean, boolean]> {
    const rows = await db.playerBlock.findMany({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: otherId },
          { blockerId: otherId, blockedId: viewerId },
        ],
      },
      select: { blockerId: true },
    });
    return [rows.some((r) => r.blockerId === viewerId), rows.some((r) => r.blockerId === otherId)];
  }

  /** `closed`: the other side blocked the viewer, or (for a declined request) went private — R4, R6. */
  function view(row: Row, viewerId: string, closed: boolean): ConversationView {
    const viewerIsInitiator = row.initiatorId === viewerId;
    const incoming = row.status === 'request' && !viewerIsInitiator;
    // R3 — only the sender ever holds a declined conversation.
    const declined = row.status === 'declined' && viewerIsInitiator;
    // R6 — a block must not surface as a date that then fails.
    const canResendAt = declined && !closed ? resendAt(row) : null;
    const resendOpen = canResendAt !== null && now() >= canResendAt;
    // Replying to a request accepts it (R3), so the one being asked can always send.
    const canSend = !closed && (row.status === 'active' || incoming || resendOpen);
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

  /** Asking again is a new request (R10), which a private player takes none of (R4). */
  async function resendClosed(row: Row, viewerId: string): Promise<boolean> {
    if (row.status !== 'declined' || row.initiatorId !== viewerId) return false;
    return (await profiles.findById(otherOf(row, viewerId)))?.visibility === 'private';
  }

  async function viewFor(row: Row, viewerId: string, blocked: boolean): Promise<ConversationView> {
    return view(row, viewerId, blocked || (await resendClosed(row, viewerId)));
  }

  /** A conversation the viewer may see, or null. Hidden: declined by the viewer, or the other side blocked by the viewer. */
  async function visibleRow(viewerId: string, conversationId: string): Promise<{ row: Row; blocked: boolean } | null> {
    const row = await db.conversation.findUnique({ where: { id: conversationId } });
    if (!row || (row.playerLowId !== viewerId && row.playerHighId !== viewerId)) return null;
    if (row.status === 'declined' && row.initiatorId !== viewerId) return null;
    const [viewerBlocked, otherBlocked] = await blocksBetween(viewerId, otherOf(row, viewerId));
    if (viewerBlocked) return null;
    return { row, blocked: otherBlocked };
  }

  // --- reads -----------------------------------------------------------------

  /** What a profile shows about messaging `playerId`. Null on your own profile or signed out. */
  async function messagingWith(viewerUserId: string | null, playerId: string): Promise<Messaging | null> {
    if (!viewerUserId) return null;
    const viewer = await profiles.findByUserId(viewerUserId);
    const other = await profiles.findById(playerId);
    if (!viewer || !other || viewer.id === other.id) return null;

    const [viewerBlocked, otherBlocked] = await blocksBetween(viewer.id, other.id);
    const [low, high] = pair(viewer.id, other.id);
    const row = await db.conversation.findUnique({
      where: { playerLowId_playerHighId: { playerLowId: low, playerHighId: high } },
    });
    // A request the viewer declined is not a conversation they can see.
    const visible = row && !(row.status === 'declined' && row.initiatorId !== viewer.id) ? row : null;
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

  /** R3, R6 — active chats and requests either way, newest activity first. */
  async function list(
    viewerUserId: string,
    opts: { first: number; after?: string | null },
  ): Promise<Page<ConversationView>> {
    const empty = { nodes: [], cursors: [], hasNextPage: false, endCursor: null };
    const viewer = await profiles.findByUserId(viewerUserId);
    if (!viewer) return empty;
    const first = Math.min(Math.max(opts.first, 1), 50);
    const blocked = (
      await db.playerBlock.findMany({ where: { blockerId: viewer.id }, select: { blockedId: true } })
    ).map((b) => b.blockedId);
    const blockedBy = new Set(
      (await db.playerBlock.findMany({ where: { blockedId: viewer.id }, select: { blockerId: true } })).map(
        (b) => b.blockerId,
      ),
    );
    const cursor = opts.after ? decodeCursor(opts.after) : null;

    const rows = await db.conversation.findMany({
      where: {
        AND: [
          {
            OR: [
              { playerLowId: viewer.id, playerHighId: { notIn: blocked } },
              { playerHighId: viewer.id, playerLowId: { notIn: blocked } },
            ],
          },
          { OR: [{ status: { not: 'declined' } }, { initiatorId: viewer.id }] },
          { lastMessageAt: { not: null } },
          cursor
            ? {
                OR: [
                  { lastMessageAt: { lt: cursor.at } },
                  { lastMessageAt: cursor.at, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: first + 1,
    });
    const page = rows.slice(0, first);
    const nodes = await Promise.all(page.map((r) => viewFor(r, viewer.id, blockedBy.has(otherOf(r, viewer.id)))));
    const cursors = page.map((r) => encodeCursor(r.lastMessageAt!, r.id));
    return { nodes, cursors, hasNextPage: rows.length > first, endCursor: cursors.at(-1) ?? null };
  }

  async function byId(viewerUserId: string, conversationId: string): Promise<ConversationView | null> {
    const viewer = await profiles.findByUserId(viewerUserId);
    if (!viewer) return null;
    const found = await visibleRow(viewer.id, conversationId);
    return found ? viewFor(found.row, viewer.id, found.blocked) : null;
  }

  /** R9 — newest first, keyset on (created_at, id). */
  async function messages(
    viewerUserId: string,
    conversationId: string,
    opts: { first: number; after?: string | null },
  ): Promise<Page<ChatMessage>> {
    const empty = { nodes: [], cursors: [], hasNextPage: false, endCursor: null };
    const viewer = await profiles.findByUserId(viewerUserId);
    if (!viewer || !(await visibleRow(viewer.id, conversationId))) return empty;
    const first = Math.min(Math.max(opts.first, 1), 100);
    const cursor = opts.after ? decodeCursor(opts.after) : null;
    const rows = await db.message.findMany({
      where: {
        conversationId,
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: first + 1,
    });
    const page = rows.slice(0, first);
    const cursors = page.map((m) => encodeCursor(m.createdAt, m.id));
    return { nodes: page, cursors, hasNextPage: rows.length > first, endCursor: cursors.at(-1) ?? null };
  }

  async function lastMessage(conversationId: string): Promise<ChatMessage | null> {
    return db.message.findFirst({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }

  /** R7 — messages from the other side the viewer has not read. */
  async function unreadIn(c: ConversationView): Promise<number> {
    return db.message.count({
      where: {
        conversationId: c.id,
        senderId: c.otherId,
        ...(c.viewerLastReadAt ? { createdAt: { gt: c.viewerLastReadAt } } : {}),
      },
    });
  }

  /** R7 — conversations with anything unread, for the inbox badge. */
  async function unreadConversationCount(viewerUserId: string): Promise<number> {
    const viewer = await profiles.findByUserId(viewerUserId);
    if (!viewer) return 0;
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM conversations c
       WHERE (c.player_low_id = ${viewer.id}::uuid OR c.player_high_id = ${viewer.id}::uuid)
         AND (c.status = 'active' OR (c.status = 'request' AND c.initiator_id <> ${viewer.id}::uuid))
         AND NOT EXISTS (
           SELECT 1 FROM player_blocks b
            WHERE b.blocker_id = ${viewer.id}::uuid
              AND b.blocked_id = CASE WHEN c.player_low_id = ${viewer.id}::uuid
                                      THEN c.player_high_id ELSE c.player_low_id END)
         AND EXISTS (
           SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id
              AND m.sender_id <> ${viewer.id}::uuid
              AND m.created_at > COALESCE(
                    CASE WHEN c.player_low_id = ${viewer.id}::uuid
                         THEN c.low_last_read_at ELSE c.high_last_read_at END,
                    '-infinity'::timestamptz))`;
    return rows[0]?.n ?? 0;
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Sends `body` to `playerId`, opening the conversation if there is none.
   * R2 shared play opens it `active`; otherwise it is a `request` (R3, R4, R5).
   */
  async function send(
    actor: Actor,
    input: { playerId: string; body: string },
  ): Promise<{ conversation: ConversationView; message: ChatMessage }> {
    const body = input.body.trim();
    if (body.length < 1 || body.length > MESSAGE_MAX) {
      throw new UserError(ChatCode.INVALID_MESSAGE, `A message is 1 to ${MESSAGE_MAX} characters.`);
    }
    const sender = await me(actor);
    if (sender.id === input.playerId) throw cannotMessage();
    const recipient = await profiles.findById(input.playerId);
    if (!recipient) throw cannotMessage();
    if ((await blocksBetween(sender.id, recipient.id)).some(Boolean)) throw cannotMessage();

    const perMinute = await limiter.consume(`chat:msg:${sender.id}`, MESSAGE_WINDOW);
    if (!perMinute.allowed) {
      throw new UserError(ChatCode.MESSAGE_LIMIT, 'You’re sending messages too quickly.', {
        retryAfterSeconds: perMinute.retryAfterSeconds,
      });
    }

    const [low, high] = pair(sender.id, recipient.id);
    const existing = await db.conversation.findUnique({
      where: { playerLowId_playerHighId: { playerLowId: low, playerHighId: high } },
    });

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

    const at = now();
    return db.$transaction(async (tx: Tx) => {
      // One pair, one writer: two first messages racing must not both open it.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chat:${low}:${high}`}))`;
      let row = await tx.conversation.findUnique({
        where: { playerLowId_playerHighId: { playerLowId: low, playerHighId: high } },
      });
      let notify: 'request' | 'message' | null;

      if (!row) {
        row = await tx.conversation.create({
          data: {
            id: newId(),
            playerLowId: low,
            playerHighId: high,
            initiatorId: sender.id,
            status: shared ? 'active' : 'request',
            createdAt: at,
          },
        });
        notify = shared ? 'message' : 'request';
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

      const message = await tx.message.create({
        data: { id: newId(), conversationId: row.id, senderId: sender.id, body, createdAt: at },
      });
      row = await tx.conversation.update({
        where: { id: row.id },
        data: { lastMessageAt: at, [readColumn(row, sender.id)]: at },
      });
      await outboxWrite(tx, {
        topic: 'chat.message.sent',
        payload: {
          conversationId: row.id,
          senderId: sender.id,
          recipientId: recipient.id,
          recipientUserId: recipient.userId,
          notify,
          preview: body.slice(0, PREVIEW_MAX),
        },
      });
      return { conversation: view(row, sender.id, false), message };
    });
  }

  /** The recipient's side of an open request, or throws. */
  async function incomingRequest(actor: Actor, conversationId: string) {
    const viewer = await me(actor);
    const found = await visibleRow(viewer.id, conversationId);
    if (!found || found.row.initiatorId === viewer.id) throw notFound();
    return { viewer, row: found.row };
  }

  async function accept(actor: Actor, conversationId: string): Promise<ConversationView> {
    const { viewer, row } = await incomingRequest(actor, conversationId);
    const updated =
      row.status === 'request'
        ? await db.conversation.update({ where: { id: row.id }, data: { status: 'active' } })
        : row;
    return view(updated, viewer.id, false);
  }

  /** R3, R10 — leaves the viewer's inbox; the sender sees it declined and may ask again in 5 days. */
  async function decline(actor: Actor, conversationId: string): Promise<void> {
    const { row } = await incomingRequest(actor, conversationId);
    if (row.status === 'request') {
      await db.conversation.update({ where: { id: row.id }, data: { status: 'declined', declinedAt: now() } });
    }
  }

  async function markRead(actor: Actor, conversationId: string): Promise<ConversationView> {
    const viewer = await me(actor);
    const found = await visibleRow(viewer.id, conversationId);
    if (!found) throw notFound();
    const updated = await db.conversation.update({
      where: { id: found.row.id },
      data: { [readColumn(found.row, viewer.id)]: now() },
    });
    return viewFor(updated, viewer.id, found.blocked);
  }

  /** R6 — idempotent, silent to the blocked player. */
  async function block(actor: Actor, playerId: string): Promise<void> {
    const viewer = await me(actor);
    if (viewer.id === playerId) throw new UserError(ChatCode.CANNOT_BLOCK_SELF, 'You can’t block yourself.');
    if (!(await profiles.findById(playerId))) throw cannotMessage();
    await db.playerBlock.upsert({
      where: { blockerId_blockedId: { blockerId: viewer.id, blockedId: playerId } },
      create: { blockerId: viewer.id, blockedId: playerId },
      update: {},
    });
  }

  async function unblock(actor: Actor, playerId: string): Promise<void> {
    const viewer = await me(actor);
    await db.playerBlock.deleteMany({ where: { blockerId: viewer.id, blockedId: playerId } });
  }

  return {
    messagingWith,
    list,
    byId,
    messages,
    lastMessage,
    unreadIn,
    unreadConversationCount,
    send,
    accept,
    decline,
    markRead,
    block,
    unblock,
  };
}

export type ChatService = ReturnType<typeof createChatService>;
