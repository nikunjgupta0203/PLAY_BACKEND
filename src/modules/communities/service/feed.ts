/**
 * communities R9 — the members' feed and group chat.
 *
 * Both are for active members only, in every community type (R6). Any member
 * posts and chats; admins pin a post and remove anyone's post or message. A
 * removed message keeps its body for moderation and is never sent to players.
 * No push per post or message: members read them when they open the community.
 */
import type { Db } from '../../../platform/db.js';
import { UserError, forbidden } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
import type { Role } from '../repo/index.js';
import type { Actor, Page } from './index.js';

export const FeedCode = {
  POST_NOT_FOUND: 'POST_NOT_FOUND',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  INVALID_POST: 'INVALID_POST',
  POSTING_TOO_FAST: 'POSTING_TOO_FAST',
} as const;

export const POST_MAX = 2000;
export const MESSAGE_MAX = 1000;
export const POST_WINDOW: Window = { seconds: 3600, max: 10 };
export const MESSAGE_WINDOW: Window = { seconds: 60, max: 20 };

export interface Post {
  id: string;
  communityId: string;
  authorUserId: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
}

export interface Message {
  id: string;
  communityId: string;
  senderUserId: string;
  /** Empty once removed: the body never leaves the server after that. */
  body: string;
  deleted: boolean;
  createdAt: Date;
}

export interface FeedDeps {
  db: Db;
  limiter: { consume(key: string, window: Window): Promise<LimitResult> };
  roleOf(communityId: string, userId: string | null): Promise<Role | null>;
  now?: () => Date;
}

const asPost = (r: { id: string; communityId: string; authorUserId: string; body: string; pinnedAt: Date | null; createdAt: Date }): Post => ({
  id: r.id,
  communityId: r.communityId,
  authorUserId: r.authorUserId,
  body: r.body,
  pinned: r.pinnedAt !== null,
  createdAt: r.createdAt,
});

const asMessage = (r: { id: string; communityId: string; senderUserId: string; body: string; deletedAt: Date | null; createdAt: Date }): Message => ({
  id: r.id,
  communityId: r.communityId,
  senderUserId: r.senderUserId,
  body: r.deletedAt ? '' : r.body,
  deleted: r.deletedAt !== null,
  createdAt: r.createdAt,
});

/** Cursor on (created_at, id), newest first. */
export const cursorOf = (r: { createdAt: Date; id: string }): string =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');

function decode(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

const olderThan = (c: { createdAt: Date; id: string } | null) =>
  c ? { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] } : {};

export function createCommunityFeed(deps: FeedDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const empty = <T>(): Page<T> => ({ nodes: [], hasNextPage: false, endCursor: null });
  const isAdmin = (role: Role | null) => role === 'owner' || role === 'admin';

  async function requireMember(actor: Actor, communityId: string): Promise<Role> {
    const role = await deps.roleOf(communityId, actor.userId);
    if (!role) throw forbidden();
    return role;
  }

  async function slowDown(key: string, window: Window): Promise<void> {
    const limit = await deps.limiter.consume(key, window);
    if (!limit.allowed) {
      throw new UserError(FeedCode.POSTING_TOO_FAST, 'You’re posting too quickly. Try again in a moment.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
  }

  async function touch(communityId: string): Promise<void> {
    await db.community.update({ where: { id: communityId }, data: { lastActivityAt: now() } });
  }

  function text(raw: string, max: number, what: string): string {
    const body = raw.trim();
    if (body.length < 1 || body.length > max) throw new UserError(FeedCode.INVALID_POST, `A ${what} is 1 to ${max} characters.`);
    return body;
  }

  // --- the feed --------------------------------------------------------------------

  /** Newest first. Empty to anyone who is not an active member (R6). */
  async function posts(communityId: string, viewerUserId: string | null, page: { first: number; after?: string | null }): Promise<Page<Post>> {
    if (!(await deps.roleOf(communityId, viewerUserId))) return empty();
    const first = Math.min(Math.max(page.first, 1), 50);
    const rows = await db.communityPost.findMany({
      where: { communityId, deletedAt: null, hiddenAt: null, ...olderThan(decode(page.after)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: first + 1,
    });
    const nodes = rows.slice(0, first).map(asPost);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > first, endCursor: last ? cursorOf(last) : null };
  }

  /** The one pinned post, shown above the feed. */
  async function pinnedPost(communityId: string, viewerUserId: string | null): Promise<Post | null> {
    if (!(await deps.roleOf(communityId, viewerUserId))) return null;
    const row = await db.communityPost.findFirst({
      where: { communityId, deletedAt: null, hiddenAt: null, pinnedAt: { not: null } },
      orderBy: { pinnedAt: 'desc' },
    });
    return row ? asPost(row) : null;
  }

  async function createPost(actor: Actor, communityId: string, raw: string): Promise<Post> {
    await requireMember(actor, communityId);
    const body = text(raw, POST_MAX, 'post');
    await slowDown(`communities:post:${actor.userId}`, POST_WINDOW);
    const row = await db.communityPost.create({ data: { id: newId(), communityId, authorUserId: actor.userId, body } });
    await touch(communityId);
    return asPost(row);
  }

  async function postOf(postId: string) {
    const row = await db.communityPost.findUnique({ where: { id: postId } });
    if (!row || row.deletedAt) throw new UserError(FeedCode.POST_NOT_FOUND, 'That post is no longer there.');
    return row;
  }

  /** The author, or an admin. */
  async function deletePost(actor: Actor, postId: string): Promise<void> {
    const row = await postOf(postId);
    const role = await requireMember(actor, row.communityId);
    if (row.authorUserId !== actor.userId && !isAdmin(role)) throw forbidden();
    await db.communityPost.update({ where: { id: postId }, data: { deletedAt: now(), pinnedAt: null } });
  }

  /** Admins. One pinned post at a time: pinning one unpins the last. */
  async function pinPost(actor: Actor, postId: string, pinned: boolean): Promise<Post> {
    const row = await postOf(postId);
    if (!isAdmin(await requireMember(actor, row.communityId))) throw forbidden();
    const updated = await db.$transaction(async (tx) => {
      if (pinned) {
        await tx.communityPost.updateMany({ where: { communityId: row.communityId, pinnedAt: { not: null } }, data: { pinnedAt: null } });
      }
      return tx.communityPost.update({ where: { id: postId }, data: { pinnedAt: pinned ? now() : null } });
    });
    return asPost(updated);
  }

  // --- the chat --------------------------------------------------------------------

  /** Newest first; `before` pages back through older messages. Empty to non-members (R6). */
  async function messages(
    communityId: string,
    viewerUserId: string | null,
    page: { first: number; before?: string | null },
  ): Promise<Page<Message>> {
    if (!(await deps.roleOf(communityId, viewerUserId))) return empty();
    const first = Math.min(Math.max(page.first, 1), 100);
    const rows = await db.communityMessage.findMany({
      where: { communityId, ...olderThan(decode(page.before)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: first + 1,
    });
    const nodes = rows.slice(0, first).map(asMessage);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > first, endCursor: last ? cursorOf(last) : null };
  }

  async function sendMessage(actor: Actor, communityId: string, raw: string): Promise<Message> {
    await requireMember(actor, communityId);
    const body = text(raw, MESSAGE_MAX, 'message');
    await slowDown(`communities:message:${actor.userId}`, MESSAGE_WINDOW);
    const row = await db.communityMessage.create({ data: { id: newId(), communityId, senderUserId: actor.userId, body } });
    await touch(communityId);
    return asMessage(row);
  }

  /** The sender, or an admin. Gone for everyone; the body stays for moderation. */
  async function deleteMessage(actor: Actor, messageId: string): Promise<Message> {
    const row = await db.communityMessage.findUnique({ where: { id: messageId } });
    if (!row) throw new UserError(FeedCode.MESSAGE_NOT_FOUND, 'That message is no longer there.');
    const role = await requireMember(actor, row.communityId);
    if (row.senderUserId !== actor.userId && !isAdmin(role)) throw forbidden();
    if (row.deletedAt) return asMessage(row);
    return asMessage(await db.communityMessage.update({ where: { id: messageId }, data: { deletedAt: now() } }));
  }

  return { posts, pinnedPost, createPost, deletePost, pinPost, messages, sendMessage, deleteMessage };
}

export type CommunityFeed = ReturnType<typeof createCommunityFeed>;
