/**
 * Outside headlines for Home's "Trending" (§5.3, G6). content R5: headline,
 * publisher, link and a picture — never the article text.
 *
 * Sources, per follow (portal /pro/feeds): Google News RSS (a search, no key,
 * NEWS_RSS_ENABLED) and NewsData.io (a search; its free tier is 12 hours late,
 * so it is the fallback). A headline with no picture gets a generic sport
 * photo from Unsplash (or Pexels), credited to its photographer, and never a
 * photo of a real player or team (§5.4): the search is the sport's name only.
 */
import { FeedBudgetSpent, feedHttp, scrubKeys, type FeedBudget, type FeedHttp, type Fetcher } from '../../../platform/feeds.js';
import type { ContentService, LinkInput } from '../service/index.js';

export interface NewsFollow {
  id: string;
  provider: 'google_news' | 'newsdata';
  ref: string;
  sportId: string;
  name: string;
  enabled: boolean;
}

export interface Headline {
  title: string;
  url: string;
  sourceName: string;
  publishedAt: Date;
  imageUrl: string | null;
}

export interface Photo {
  url: string;
  credit: string;
  creditUrl: string;
  /** Unsplash: hit once when the photo is used (their API terms). */
  trackUrl: string | null;
}

const PER_FOLLOW = 8;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(v: string): string {
  return v
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .trim();
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decodeEntities(m[1]!) : null;
};

/** Google News RSS → headlines. "Headline - Publisher" loses its tail. Pure. */
export function parseGoogleNews(xml: string): Headline[] {
  const out: Headline[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const item = m[1]!;
    const link = tag(item, 'link');
    const source = tag(item, 'source');
    let title = tag(item, 'title');
    if (!title || !link || !/^https?:\/\//.test(link)) continue;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const at = new Date(tag(item, 'pubDate') ?? '');
    const media = /<media:content[^>]*\burl="(https:\/\/[^"]+)"/i.exec(item)?.[1] ?? null;
    out.push({
      title,
      url: link,
      sourceName: source ?? 'Google News',
      publishedAt: Number.isNaN(at.getTime()) ? new Date() : at,
      imageUrl: media ? decodeEntities(media) : null,
    });
  }
  return out;
}

/** NewsData.io /latest → headlines. Pure. */
export function parseNewsData(json: unknown): Headline[] {
  const b = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (b['status'] !== 'success') {
    const r = (b['results'] ?? {}) as Record<string, unknown>;
    throw new Error(`newsdata: ${String(r['message'] ?? b['status'] ?? 'request failed')}`);
  }
  const results = Array.isArray(b['results']) ? (b['results'] as Record<string, unknown>[]) : [];
  return results.flatMap((r) => {
    const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
    const url = typeof r['link'] === 'string' ? r['link'] : '';
    if (!title || !/^https?:\/\//.test(url)) return [];
    // "2026-11-15 09:30:00" is UTC.
    const raw = typeof r['pubDate'] === 'string' ? r['pubDate'] : '';
    const at = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    const image = typeof r['image_url'] === 'string' && /^https:\/\//.test(r['image_url']) ? r['image_url'] : null;
    const source = (typeof r['source_name'] === 'string' && r['source_name']) || (typeof r['source_id'] === 'string' && r['source_id']) || 'News';
    return [{ title, url, sourceName: source, publishedAt: Number.isNaN(at.getTime()) ? new Date() : at, imageUrl: image }];
  });
}

const UTM = 'utm_source=pl4y&utm_medium=referral';

export function parseUnsplash(json: unknown): Photo[] {
  const results = ((json as Record<string, unknown>)?.['results'] ?? []) as Record<string, unknown>[];
  return (Array.isArray(results) ? results : []).flatMap((p) => {
    const urls = (p['urls'] ?? {}) as Record<string, unknown>;
    const user = (p['user'] ?? {}) as Record<string, unknown>;
    const links = (p['links'] ?? {}) as Record<string, unknown>;
    const userLinks = (user['links'] ?? {}) as Record<string, unknown>;
    const url = typeof urls['regular'] === 'string' ? urls['regular'] : null;
    if (!url || !/^https:\/\//.test(url)) return [];
    const profile = typeof userLinks['html'] === 'string' ? userLinks['html'] : 'https://unsplash.com';
    return [
      {
        url,
        credit: `Photo: ${String(user['name'] ?? 'Unsplash')} on Unsplash`,
        creditUrl: `${profile}${profile.includes('?') ? '&' : '?'}${UTM}`,
        trackUrl: typeof links['download_location'] === 'string' ? links['download_location'] : null,
      },
    ];
  });
}

export function parsePexels(json: unknown): Photo[] {
  const photos = ((json as Record<string, unknown>)?.['photos'] ?? []) as Record<string, unknown>[];
  return (Array.isArray(photos) ? photos : []).flatMap((p) => {
    const src = (p['src'] ?? {}) as Record<string, unknown>;
    const url = typeof src['large'] === 'string' ? src['large'] : null;
    if (!url || !/^https:\/\//.test(url)) return [];
    return [
      {
        url,
        credit: `Photo: ${String(p['photographer'] ?? 'Pexels')} on Pexels`,
        creditUrl: typeof p['url'] === 'string' ? p['url'] : 'https://www.pexels.com',
        trackUrl: null,
      },
    ];
  });
}

/** The same headline always gets the same photo of its sport's set. Pure. */
export function pickPhoto(photos: Photo[], key: string): Photo | null {
  if (!photos.length) return null;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return photos[h % photos.length]!;
}

export interface NewsImporterDeps {
  content: ContentService;
  budget: FeedBudget;
  follows(): Promise<NewsFollow[]>;
  sportName(sportId: string): Promise<string | null>;
  recordFollow(id: string, result: { ok: boolean; error?: string }): Promise<void>;
  keys: { rss: boolean; newsdata: string; unsplash: string; pexels: string };
  fetcher?: Fetcher;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

export interface NewsSummary {
  imported: number;
  archived: number;
  skipped: string | null;
  errors: string[];
}

export function createNewsImporter(deps: NewsImporterDeps) {
  const log = deps.log ?? { info() {}, warn() {} };
  const http = (p: 'google_news' | 'newsdata' | 'unsplash' | 'pexels'): FeedHttp => feedHttp(deps.budget, p, deps.fetcher);

  async function headlines(f: NewsFollow): Promise<Headline[]> {
    if (f.provider === 'google_news') {
      const q = new URLSearchParams({ q: f.ref, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' });
      return parseGoogleNews(await http('google_news').text(`https://news.google.com/rss/search?${q.toString()}`));
    }
    const q = new URLSearchParams({ apikey: deps.keys.newsdata, q: f.ref, language: 'en', country: 'in', category: 'sports' });
    return parseNewsData(await http('newsdata').json(`https://newsdata.io/api/1/latest?${q.toString()}`));
  }

  async function photosFor(sport: string): Promise<Photo[]> {
    if (deps.keys.unsplash) {
      try {
        const q = new URLSearchParams({ query: sport, orientation: 'landscape', per_page: '12', content_filter: 'high' });
        const list = parseUnsplash(await http('unsplash').json(`https://api.unsplash.com/search/photos?${q.toString()}`, { headers: { Authorization: `Client-ID ${deps.keys.unsplash}` } }));
        if (list.length) return list;
      } catch (err) {
        if (!(err instanceof FeedBudgetSpent)) await deps.budget.recordError('unsplash', scrubKeys(String((err as Error).message ?? err)));
      }
    }
    if (deps.keys.pexels) {
      try {
        const q = new URLSearchParams({ query: sport, orientation: 'landscape', per_page: '12' });
        return parsePexels(await http('pexels').json(`https://api.pexels.com/v1/search?${q.toString()}`, { headers: { Authorization: deps.keys.pexels } }));
      } catch (err) {
        if (!(err instanceof FeedBudgetSpent)) await deps.budget.recordError('pexels', scrubKeys(String((err as Error).message ?? err)));
      }
    }
    return [];
  }

  async function run(): Promise<NewsSummary> {
    const summary: NewsSummary = { imported: 0, archived: 0, skipped: null, errors: [] };
    summary.archived = await deps.content.archiveOldLinks();
    const on = (f: NewsFollow) => f.enabled && (f.provider === 'google_news' ? deps.keys.rss : deps.keys.newsdata !== '');
    const list = (await deps.follows()).filter(on);
    if (!list.length) {
      summary.skipped = 'no news feed is switched on and followed';
      return summary;
    }
    const photoCache = new Map<string, Photo[]>();
    for (const f of list) {
      try {
        const found = (await headlines(f)).slice(0, PER_FOLLOW);
        const known = await deps.content.knownLinks(found.map((h) => h.url));
        const fresh = found.filter((h) => !known.has(h.url));
        const sport = (await deps.sportName(f.sportId)) ?? f.name;
        const items: LinkInput[] = [];
        for (const h of fresh) {
          let photo: Photo | null = null;
          if (!h.imageUrl) {
            if (!photoCache.has(sport)) photoCache.set(sport, await photosFor(sport));
            photo = pickPhoto(photoCache.get(sport)!, h.url);
            if (photo?.trackUrl && deps.keys.unsplash) {
              await http('unsplash').text(photo.trackUrl, { headers: { Authorization: `Client-ID ${deps.keys.unsplash}` } }).catch(() => undefined);
            }
          }
          items.push({
            sportId: f.sportId,
            title: h.title,
            kicker: f.name,
            sourceName: h.sourceName,
            sourceUrl: h.url,
            imageUrl: h.imageUrl ?? photo?.url ?? null,
            imageCredit: h.imageUrl ? null : (photo?.credit ?? null),
            imageCreditUrl: h.imageUrl ? null : (photo?.creditUrl ?? null),
            publishedAt: h.publishedAt,
          });
        }
        summary.imported += await deps.content.importLinks(items);
        await deps.recordFollow(f.id, { ok: true });
      } catch (err) {
        const message = scrubKeys(String((err as Error).message ?? err));
        summary.errors.push(message);
        if (!(err instanceof FeedBudgetSpent)) await deps.budget.recordError(f.provider, message);
        await deps.recordFollow(f.id, { ok: false, error: message });
      }
    }
    log.info({ ...summary }, 'news headlines imported');
    return summary;
  }

  return { run };
}

export type NewsImporter = ReturnType<typeof createNewsImporter>;
