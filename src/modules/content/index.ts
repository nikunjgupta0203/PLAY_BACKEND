/** The ONLY surface other modules may import (conventions.md §1). */
import { config } from '../../platform/config.js';
import { db } from '../../platform/db.js';
import { logger } from '../../platform/logging/index.js';
import { feedBudget, proFeeds } from '../pro/index.js';
import { createNewsImporter, type NewsFollow } from './feeds/news.js';
import { createContentService } from './service/index.js';

export const content = createContentService({ db });

/** content R5, G6 — the headline importer the worker runs. Follows live with the score feeds' (pro_feed_follows). */
export const news = createNewsImporter({
  content,
  budget: feedBudget,
  async follows() {
    const all = await proFeeds.follows();
    return all.filter((f): f is typeof f & NewsFollow => f.provider === 'google_news' || f.provider === 'newsdata');
  },
  async sportName(sportId) {
    return (await db.sport.findUnique({ where: { id: sportId }, select: { name: true } }))?.name ?? null;
  },
  async recordFollow(id, result) {
    await db.proFeedFollow.updateMany({
      where: { id },
      data: result.ok ? { lastImportAt: new Date(), lastError: null } : { lastError: (result.error ?? 'failed').slice(0, 300) },
    });
  },
  keys: { rss: config.NEWS_RSS_ENABLED, newsdata: config.NEWSDATA_KEY, unsplash: config.UNSPLASH_KEY, pexels: config.PEXELS_KEY },
  log: logger,
});

export { CONTENT_KINDS, ContentCode, LINK_DAYS } from './service/index.js';
export { decodeEntities, parseGoogleNews, parseNewsData, parsePexels, parseUnsplash, pickPhoto } from './feeds/news.js';
export type { ContentInput, ContentItem, ContentKind, ContentService, ContentStatus, HomeShelf, LinkInput } from './service/index.js';
