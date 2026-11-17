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

export type PostKind = 'text' | 'photo' | 'video' | 'poll' | 'event';
export const POST_KINDS: readonly PostKind[] = ['text', 'photo', 'video', 'poll', 'event'];
export const MAX_PHOTOS = 6;
export const POLL_MIN = 2;
export const POLL_MAX = 4;

export interface Post {
  id: string;
  communityId: string;
  authorUserId: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  /** Floodlight — what the post carries besides its text. */
  kind: PostKind;
  photoPublicIds: string[];
  videoUrl: string | null;
  event: { title: string; startsAt: Date; place: string | null } | null;
}

/** Floodlight — the extras a post can carry. Text-only posts pass none. */
export interface PostExtras {
  kind?: PostKind;
  photoPublicIds?: string[];
  videoUrl?: string | null;
  pollOptions?: string[];
  event?: { title: string; startsAt: Date; place?: string | null } | null;
}

export interface Poll {
  postId: string;
  total: number;
  options: { id: string; label: string; votes: number; percent: number }[];
  myOptionId: string | null;
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
  /** ADR 0003 §C2 — the folder a community's post photos must live under. */
  photoRoot?(communityId: string): string;
  now?: () => Date;
}

type PostRow = {
  id: string;
  communityId: string;
  authorUserId: string;
  body: string;
  pinnedAt: Date | null;
  createdAt: Date;
  kind: string;
  photoPublicIds: string[];
  videoUrl: string | null;
  eventTitle: string | null;
  eventStartsAt: Date | null;
  eventPlace: string | null;
};

const asPost = (r: PostRow): Post => ({
  id: r.id,
  communityId: r.communityId,
  authorUserId: r.authorUserId,
  body: r.body,
  pinned: r.pinnedAt !== null,
  createdAt: r.createdAt,
  kind: r.kind as PostKind,
  photoPublicIds: r.photoPublicIds,
  videoUrl: r.videoUrl,
  event: r.eventTitle && r.eventStartsAt ? { title: r.eventTitle, startsAt: r.eventStartsAt, place: r.eventPlace } : null,
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

  /**
   * Floodlight — a post may carry photos, a video link, a poll or a club event.
   * Text is required for a text post and a poll (its question); a photo, video
   * or event post may go without a caption.
   */
  async function createPost(actor: Actor, communityId: string, raw: string, extras: PostExtras = {}): Promise<Post> {
    await requireMember(actor, communityId);
    const kind = extras.kind ?? 'text';
    if (!POST_KINDS.includes(kind)) throw new UserError(FeedCode.INVALID_POST, 'That is not a kind of post.');
    const captionOptional = kind === 'photo' || kind === 'video' || kind === 'event';
    const body = captionOptional && raw.trim().length === 0 ? '' : text(raw, POST_MAX, kind === 'poll' ? 'poll question' : 'post');

    const photos = kind === 'photo' ? [...new Set(extras.photoPublicIds ?? [])] : [];
    if (kind === 'photo') {
      if (photos.length < 1 || photos.length > MAX_PHOTOS) throw new UserError(FeedCode.INVALID_POST, `Add 1 to ${MAX_PHOTOS} photos.`);
      const root = deps.photoRoot?.(communityId);
      if (root && photos.some((p) => !p.startsWith(`${root}/`))) throw forbidden();
    }
    let videoUrl: string | null = null;
    if (kind === 'video') {
      try {
        const u = new URL((extras.videoUrl ?? '').trim());
        if (u.protocol !== 'https:') throw new Error('not https');
        videoUrl = u.toString();
      } catch {
        throw new UserError(FeedCode.INVALID_POST, 'Add a video link that starts with https://.');
      }
    }
    const options = kind === 'poll' ? (extras.pollOptions ?? []).map((o) => o.trim()).filter(Boolean) : [];
    if (kind === 'poll') {
      if (options.length < POLL_MIN || options.length > POLL_MAX) throw new UserError(FeedCode.INVALID_POST, `A poll has ${POLL_MIN} to ${POLL_MAX} options.`);
      if (options.some((o) => o.length > 80)) throw new UserError(FeedCode.INVALID_POST, 'A poll option is at most 80 characters.');
      if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new UserError(FeedCode.INVALID_POST, 'Each poll option is different.');
    }
    let event: { eventTitle: string; eventStartsAt: Date; eventPlace: string | null } | null = null;
    if (kind === 'event') {
      const title = (extras.event?.title ?? '').trim();
      const startsAt = extras.event?.startsAt;
      if (title.length < 1 || title.length > 80) throw new UserError(FeedCode.INVALID_POST, 'An event needs a name, up to 80 characters.');
      if (!startsAt || Number.isNaN(startsAt.getTime())) throw new UserError(FeedCode.INVALID_POST, 'An event needs a date and time.');
      if (startsAt.getTime() < now().getTime()) throw new UserError(FeedCode.INVALID_POST, 'An event is in the future.');
      const place = extras.event?.place?.trim() || null;
      if (place && place.length > 120) throw new UserError(FeedCode.INVALID_POST, 'The place is at most 120 characters.');
      event = { eventTitle: title, eventStartsAt: startsAt, eventPlace: place };
    }

    await slowDown(`communities:post:${actor.userId}`, POST_WINDOW);
    const row = await db.communityPost.create({
      data: {
        id: newId(),
        communityId,
        authorUserId: actor.userId,
        body,
        kind,
        photoPublicIds: photos,
        videoUrl,
        ...(event ?? {}),
        ...(options.length ? { pollOptions: { create: options.map((label, position) => ({ id: newId(), label, position })) } } : {}),
      },
    });
    await touch(communityId);
    return asPost(row);
  }

  // --- Floodlight: polls and club events ------------------------------------------

  async function polls(postIds: readonly string[], viewerUserId: string | null): Promise<Map<string, Poll>> {
    const out = new Map<string, Poll>();
    if (postIds.length === 0) return out;
    const [options, counts, mine] = await Promise.all([
      db.communityPollOption.findMany({ where: { postId: { in: [...postIds] } }, orderBy: [{ position: 'asc' }] }),
      db.communityPollVote.groupBy({ by: ['optionId'], where: { postId: { in: [...postIds] } }, _count: { _all: true } }),
      viewerUserId ? db.communityPollVote.findMany({ where: { postId: { in: [...postIds] }, userId: viewerUserId } }) : Promise.resolve([]),
    ]);
    const votes = new Map(counts.map((c) => [c.optionId, c._count._all]));
    const myVote = new Map(mine.map((v) => [v.postId, v.optionId]));
    for (const postId of postIds) {
      const own = options.filter((o) => o.postId === postId);
      if (!own.length) continue;
      const total = own.reduce((n, o) => n + (votes.get(o.id) ?? 0), 0);
      out.set(postId, {
        postId,
        total,
        options: own.map((o) => {
          const v = votes.get(o.id) ?? 0;
          return { id: o.id, label: o.label, votes: v, percent: total ? Math.round((v / total) * 100) : 0 };
        }),
        myOptionId: myVote.get(postId) ?? null,
      });
    }
    return out;
  }

  /** Members; a vote can be changed. */
  async function vote(actor: Actor, postId: string, optionId: string): Promise<Poll> {
    const row = await postOf(postId);
    await requireMember(actor, row.communityId);
    const option = await db.communityPollOption.findUnique({ where: { id: optionId } });
    if (!option || option.postId !== postId) throw new UserError(FeedCode.INVALID_POST, 'Pick one of the poll’s options.');
    await db.communityPollVote.upsert({
      where: { postId_userId: { postId, userId: actor.userId } },
      create: { postId, userId: actor.userId, optionId },
      update: { optionId, createdAt: now() },
    });
    return (await polls([postId], actor.userId)).get(postId)!;
  }

  async function rsvps(postIds: readonly string[], viewerUserId: string | null): Promise<Map<string, { count: number; going: boolean }>> {
    const out = new Map<string, { count: number; going: boolean }>();
    if (postIds.length === 0) return out;
    const [counts, mine] = await Promise.all([
      db.communityPostRsvp.groupBy({ by: ['postId'], where: { postId: { in: [...postIds] } }, _count: { _all: true } }),
      viewerUserId ? db.communityPostRsvp.findMany({ where: { postId: { in: [...postIds] }, userId: viewerUserId } }) : Promise.resolve([]),
    ]);
    const going = new Set(mine.map((m) => m.postId));
    for (const id of postIds) out.set(id, { count: counts.find((c) => c.postId === id)?._count._all ?? 0, going: going.has(id) });
    return out;
  }

  /** "I'm in" — members, on an event post that has not started. */
  async function rsvp(actor: Actor, postId: string, going: boolean): Promise<{ count: number; going: boolean }> {
    const row = await postOf(postId);
    await requireMember(actor, row.communityId);
    if (row.kind !== 'event') throw new UserError(FeedCode.INVALID_POST, 'Only an event post takes an RSVP.');
    if (going) {
      if (row.eventStartsAt && row.eventStartsAt.getTime() < now().getTime()) throw new UserError(FeedCode.INVALID_POST, 'That event has started.');
      await db.communityPostRsvp.createMany({ data: [{ postId, userId: actor.userId }], skipDuplicates: true });
    } else {
      await db.communityPostRsvp.deleteMany({ where: { postId, userId: actor.userId } });
    }
    return (await rsvps([postId], actor.userId)).get(postId)!;
  }

  /** Club events coming up in these communities, soonest first: My PL4Y and Home. */
  async function upcomingEvents(communityIds: string[], first = 10): Promise<Post[]> {
    if (communityIds.length === 0) return [];
    const rows = await db.communityPost.findMany({
      where: { communityId: { in: communityIds }, kind: 'event', deletedAt: null, hiddenAt: null, eventStartsAt: { gte: now() } },
      orderBy: [{ eventStartsAt: 'asc' }],
      take: Math.min(Math.max(first, 1), 50),
    });
    return rows.map(asPost);
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

  return { posts, pinnedPost, createPost, deletePost, pinPost, messages, sendMessage, deleteMessage, polls, vote, rsvps, rsvp, upcomingEvents };
}

export type CommunityFeed = ReturnType<typeof createCommunityFeed>;
