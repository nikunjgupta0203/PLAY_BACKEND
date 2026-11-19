/**
 * content — what PL4Y publishes: stories, shorts, explainers and originals
 * (Floodlight §4.1 Home). Written and published by PL4Y staff in the portal.
 *
 * content R1 — players only ever see `published` items, newest first.
 * content R2 — a short needs an https video URL to publish; it plays in a
 *   web view in the app (no native player), so a Cloudinary MP4 or a
 *   YouTube link both work.
 * content R3 — publishing stamps `published_at` the first time; archiving
 *   takes an item off every feed without deleting it.
 * content R4 — the Home shelf: one hero original (a featured one first),
 *   the newest shorts, stories and the latest explainer. "Trending" mixes
 *   PL4Y's stories (featured first) with outside headlines (060).
 * content R5 (060) — a `link` item is an outside headline: the title, the
 *   publisher, the address and a picture. Never the article's text. It opens
 *   at its source in the in-app browser. Imported links de-duplicate by
 *   address and are archived after 14 days.
 */
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const ContentCode = {
  NOT_FOUND: 'CONTENT_NOT_FOUND',
  INVALID: 'INVALID_CONTENT',
} as const;

export type ContentKind = 'story' | 'short' | 'explainer' | 'original' | 'link';
export type ContentStatus = 'draft' | 'published' | 'archived';
export const CONTENT_KINDS: readonly ContentKind[] = ['story', 'short', 'explainer', 'original', 'link'];
/** content R5 — how long an outside headline stays up. */
export const LINK_DAYS = 14;

export interface ContentItem {
  id: string;
  kind: ContentKind;
  sportId: string | null;
  title: string;
  kicker: string | null;
  summary: string | null;
  body: string | null;
  coverPublicId: string | null;
  videoUrl: string | null;
  durationSeconds: number | null;
  sourceName: string | null;
  sourceUrl: string | null;
  imageUrl: string | null;
  imageCredit: string | null;
  imageCreditUrl: string | null;
  status: ContentStatus;
  featured: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
}

/** content R5 — one imported headline. */
export interface LinkInput {
  sportId: string | null;
  title: string;
  kicker: string | null;
  sourceName: string;
  sourceUrl: string;
  imageUrl: string | null;
  imageCredit: string | null;
  imageCreditUrl: string | null;
  publishedAt: Date;
  /** The publisher's description (plain text), when the feed sends one. */
  summary?: string | null;
}

export interface ContentInput {
  kind: ContentKind;
  sportId?: string | null;
  title: string;
  kicker?: string | null;
  summary?: string | null;
  body?: string | null;
  coverPublicId?: string | null;
  videoUrl?: string | null;
  durationSeconds?: number | null;
  featured?: boolean | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface HomeShelf {
  hero: ContentItem | null;
  shorts: ContentItem[];
  stories: ContentItem[];
  explainer: ContentItem | null;
}

export interface ContentDeps {
  db: Db;
  now?: () => Date;
}

type Row = Awaited<ReturnType<Db['contentItem']['findFirstOrThrow']>>;

const toItem = (r: Row): ContentItem => ({
  id: r.id,
  kind: r.kind as ContentKind,
  sportId: r.sportId,
  title: r.title,
  kicker: r.kicker,
  summary: r.summary,
  body: r.body,
  coverPublicId: r.coverPublicId,
  videoUrl: r.videoUrl,
  durationSeconds: r.durationSeconds,
  sourceName: r.sourceName,
  sourceUrl: r.sourceUrl,
  imageUrl: r.imageUrl,
  imageCredit: r.imageCredit,
  imageCreditUrl: r.imageCreditUrl,
  status: r.status as ContentStatus,
  featured: r.featured,
  publishedAt: r.publishedAt,
  updatedAt: r.updatedAt,
});

const cursorOf = (r: { publishedAt: Date | null; id: string }): string =>
  Buffer.from(`${(r.publishedAt ?? new Date(0)).toISOString()}|${r.id}`).toString('base64url');

function decode(cursor: string | null | undefined): { publishedAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const publishedAt = new Date(at ?? '');
  return id && !Number.isNaN(publishedAt.getTime()) ? { publishedAt, id } : null;
}

function text(raw: string | null | undefined, max: number, what: string): string | null {
  if (raw === undefined || raw === null) return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.length > max) throw new UserError(ContentCode.INVALID, `${what} is at most ${max} characters.`);
  return v;
}

function webAddress(raw: string | null | undefined, what: string, https = false): string | null {
  const v = text(raw, 1000, what);
  if (v === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new UserError(ContentCode.INVALID, `${what} is not a web address.`);
  }
  if (https ? parsed.protocol !== 'https:' : !/^https?:$/.test(parsed.protocol)) {
    throw new UserError(ContentCode.INVALID, `${what} starts with ${https ? 'https://' : 'http:// or https://'}.`);
  }
  return parsed.toString();
}

function videoOf(raw: string | null | undefined): string | null {
  const v = text(raw, 500, 'The video link');
  if (v === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new UserError(ContentCode.INVALID, 'The video link is not a web address.');
  }
  if (parsed.protocol !== 'https:') throw new UserError(ContentCode.INVALID, 'The video link starts with https://.');
  return parsed.toString();
}

export function createContentService(deps: ContentDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const published = { status: 'published' } as const;

  /** content R1 — newest first. */
  async function feed(filter: { kind?: ContentKind | null; sportId?: string | null; first?: number; after?: string | null; q?: string | null }): Promise<Page<ContentItem>> {
    const first = Math.min(Math.max(filter.first ?? 20, 1), 50);
    const c = decode(filter.after);
    const q = filter.q?.trim();
    const rows = await db.contentItem.findMany({
      where: {
        ...published,
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.sportId ? { sportId: filter.sportId } : {}),
        // Both filters are ORs: keep them under AND, or the cursor's OR replaces the search's on page 2.
        AND: [
          ...(q ? [{ OR: [{ title: { contains: q, mode: 'insensitive' as const } }, { kicker: { contains: q, mode: 'insensitive' as const } }] }] : []),
          ...(c ? [{ OR: [{ publishedAt: { lt: c.publishedAt } }, { publishedAt: c.publishedAt, id: { lt: c.id } }] }] : []),
        ],
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: first + 1,
    });
    const nodes = rows.slice(0, first).map(toItem);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > first, endCursor: last ? cursorOf(last) : null };
  }

  /** content R1 — a draft or archived item is not there, to players. */
  async function item(id: string, opts: { staff?: boolean } = {}): Promise<ContentItem | null> {
    const row = await db.contentItem.findUnique({ where: { id } });
    if (!row) return null;
    if (!opts.staff && row.status !== 'published') return null;
    return toItem(row);
  }

  /** content R4. */
  async function homeShelf(sportId: string | null): Promise<HomeShelf> {
    const sport = sportId ? { OR: [{ sportId }, { sportId: null }] } : {};
    const newest = { orderBy: [{ publishedAt: 'desc' as const }, { id: 'desc' as const }] };
    const [hero, shorts, stories, explainer] = await Promise.all([
      db.contentItem.findFirst({ where: { ...published, kind: 'original', ...sport }, orderBy: [{ featured: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }] }),
      db.contentItem.findMany({ where: { ...published, kind: 'short', ...sport }, ...newest, take: 8 }),
      db.contentItem.findMany({ where: { ...published, kind: { in: ['story', 'link'] }, ...sport }, orderBy: [{ featured: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }], take: 6 }),
      db.contentItem.findFirst({ where: { ...published, kind: 'explainer', ...sport }, ...newest }),
    ]);
    return {
      hero: hero ? toItem(hero) : null,
      shorts: shorts.map(toItem),
      stories: stories.map(toItem),
      explainer: explainer ? toItem(explainer) : null,
    };
  }

  // --- staff ---------------------------------------------------------------------

  async function staffList(filter: { status?: ContentStatus | null; kind?: ContentKind | null; first?: number }): Promise<ContentItem[]> {
    const rows = await db.contentItem.findMany({
      where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.kind ? { kind: filter.kind } : {}) },
      orderBy: [{ updatedAt: 'desc' }],
      take: Math.min(Math.max(filter.first ?? 100, 1), 300),
    });
    return rows.map(toItem);
  }

  function fields(input: ContentInput) {
    if (!CONTENT_KINDS.includes(input.kind)) throw new UserError(ContentCode.INVALID, 'That is not a content kind.');
    const title = input.title.trim();
    if (title.length < 1 || title.length > 140) throw new UserError(ContentCode.INVALID, 'A title is 1 to 140 characters.');
    const duration = input.durationSeconds ?? null;
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 36_000)) {
      throw new UserError(ContentCode.INVALID, 'The length is in whole seconds.');
    }
    const link = input.kind === 'link';
    const sourceUrl = webAddress(input.sourceUrl, 'The source link');
    const sourceName = text(input.sourceName, 60, 'The source');
    if (link && (!sourceUrl || !sourceName)) throw new UserError(ContentCode.INVALID, 'A link needs its source and its address.');
    if (link && input.body?.trim()) throw new UserError(ContentCode.INVALID, 'A link carries no article text: it opens at its source.');
    return {
      kind: input.kind,
      sportId: input.sportId ?? null,
      sourceName: link ? sourceName : null,
      sourceUrl: link ? sourceUrl : null,
      title,
      kicker: text(input.kicker, 40, 'The kicker'),
      summary: text(input.summary, 280, 'The summary'),
      body: text(input.body, 20_000, 'The story'),
      coverPublicId: text(input.coverPublicId, 300, 'The cover'),
      videoUrl: videoOf(input.videoUrl),
      durationSeconds: duration,
      featured: input.featured ?? false,
    };
  }

  async function save(authorUserId: string | null, id: string | null, input: ContentInput): Promise<ContentItem> {
    const data = fields(input);
    if (id) {
      const before = await db.contentItem.findUnique({ where: { id } });
      if (!before) throw new UserError(ContentCode.NOT_FOUND, 'That item is no longer there.');
      if (before.status === 'published' && data.kind === 'short' && !data.videoUrl) {
        throw new UserError(ContentCode.INVALID, 'A published short needs its video link.');
      }
      return toItem(await db.contentItem.update({ where: { id }, data: { ...data, updatedAt: now() } }));
    }
    return toItem(await db.contentItem.create({ data: { id: newId(), ...data, authorUserId } }));
  }

  /** content R2, R3. */
  async function setStatus(id: string, status: ContentStatus): Promise<ContentItem> {
    const row = await db.contentItem.findUnique({ where: { id } });
    if (!row) throw new UserError(ContentCode.NOT_FOUND, 'That item is no longer there.');
    if (status === 'published' && row.kind === 'short' && !row.videoUrl) {
      throw new UserError(ContentCode.INVALID, 'Add the video link before publishing a short.');
    }
    const t = now();
    return toItem(
      await db.contentItem.update({
        where: { id },
        data: { status, updatedAt: t, ...(status === 'published' && !row.publishedAt ? { publishedAt: t } : {}) },
      }),
    );
  }

  // --- content R5: imported headlines ---------------------------------------------

  /** Writes new headlines as published links; an address already here is skipped. Returns how many were new. */
  async function importLinks(items: LinkInput[]): Promise<number> {
    const t = now();
    const rows = items.flatMap((i) => {
      try {
        const title = i.title.trim().replace(/\s+/g, ' ');
        const sourceUrl = webAddress(i.sourceUrl, 'The source link');
        if (!title || !sourceUrl) return [];
        const at = i.publishedAt.getTime() > t.getTime() || Number.isNaN(i.publishedAt.getTime()) ? t : i.publishedAt;
        return [
          {
            id: newId(),
            kind: 'link',
            sportId: i.sportId,
            title: title.length > 140 ? `${title.slice(0, 139)}…` : title,
            kicker: i.kicker ? i.kicker.slice(0, 40) : null,
            summary: i.summary?.trim() ? i.summary.trim().slice(0, 300) : null,
            sourceName: i.sourceName.trim().slice(0, 60) || 'News',
            sourceUrl,
            imageUrl: i.imageUrl && /^https:\/\//.test(i.imageUrl) ? i.imageUrl.slice(0, 1000) : null,
            imageCredit: i.imageCredit ? i.imageCredit.slice(0, 120) : null,
            imageCreditUrl: i.imageCreditUrl && /^https?:\/\//.test(i.imageCreditUrl) ? i.imageCreditUrl.slice(0, 1000) : null,
            status: 'published',
            publishedAt: at,
            createdAt: t,
            updatedAt: t,
          },
        ];
      } catch {
        return [];
      }
    });
    if (!rows.length) return 0;
    const res = await db.contentItem.createMany({ data: rows, skipDuplicates: true });
    return res.count;
  }

  /** Addresses already stored, so the importer spends no picture search on them. */
  async function knownLinks(urls: string[]): Promise<Set<string>> {
    if (!urls.length) return new Set();
    const rows = await db.contentItem.findMany({ where: { sourceUrl: { in: urls } }, select: { sourceUrl: true } });
    return new Set(rows.map((r) => r.sourceUrl!).filter(Boolean));
  }

  /** content R5 — outside headlines come down after 14 days (kept, so they never import twice). */
  async function archiveOldLinks(): Promise<number> {
    const before = new Date(now().getTime() - LINK_DAYS * 86_400_000);
    const { count } = await db.contentItem.updateMany({
      where: { kind: 'link', status: 'published', publishedAt: { lt: before } },
      data: { status: 'archived', updatedAt: now() },
    });
    return count;
  }

  async function remove(id: string): Promise<void> {
    await db.contentItem.deleteMany({ where: { id, status: { not: 'published' } } });
  }

  return { feed, item, homeShelf, staffList, save, setStatus, remove, importLinks, knownLinks, archiveOldLinks };
}

export type ContentService = ReturnType<typeof createContentService>;
