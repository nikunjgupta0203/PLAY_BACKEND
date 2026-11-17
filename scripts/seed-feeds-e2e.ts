/**
 * LOCAL e2e only: plays the score and news providers with canned responses, so
 * the 060 feed path (import → live poll → finish → settle suggestions,
 * headlines with a credited fallback picture) can be seen in the app without
 * provider keys. Writes through the real runner, adapters and services.
 *
 *   tsx scripts/seed-feeds-e2e.ts      (with DATABASE_URL pointing at the e2e DB)
 */
import { config } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { createFeedBudget, FEED_PROVIDERS, type FeedProvider, type Fetcher } from '../src/platform/feeds.js';
import { pro } from '../src/modules/pro/index.js';
import { predictions } from '../src/modules/predictions/index.js';
import { content } from '../src/modules/content/index.js';
import { createFeedRunner } from '../src/modules/pro/feeds/runner.js';
import { apiFootballAdapter } from '../src/modules/pro/feeds/apiFootball.js';
import { createNewsImporter } from '../src/modules/content/feeds/news.js';

if (config.NODE_ENV === 'production') throw new Error('e2e seed: never in production');

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+00:00');
let phase: 'fixtures' | 'live' | 'final' = 'fixtures';

const fx = (id: number, home: [number, string], away: [number, string], start: number, over: Record<string, unknown> = {}) => ({
  fixture: { id, date: iso(start), status: { short: 'NS', elapsed: null }, venue: { name: 'Mumbai Football Arena', city: 'Mumbai' }, ...((over['fixture'] as object) ?? {}) },
  league: { id: 323, name: 'Indian Super League', round: 'Regular Season - 9' },
  teams: { home: { id: home[0], name: home[1], winner: null }, away: { id: away[0], name: away[1], winner: null } },
  goals: { home: null, away: null },
  score: { penalty: { home: null, away: null } },
  events: [],
  statistics: [],
  ...over,
});

const LIVE_ID = 990101;
const DONE_ID = 990102;
const liveStart = now - 34 * 60_000;
const doneStart = now - 3 * 3_600_000;

const live = () =>
  fx(LIVE_ID, [9901, 'Mumbai City FC'], [9902, 'Bengaluru FC'], liveStart, {
    fixture: { id: LIVE_ID, date: iso(liveStart), status: { short: '1H', elapsed: 34 }, venue: { name: 'Mumbai Football Arena', city: 'Mumbai' } },
    goals: { home: 1, away: 0 },
    events: [
      { time: { elapsed: 12, extra: null }, team: { name: 'Mumbai City FC' }, player: { name: 'L. Chhangte' }, assist: { name: 'J. Stewart' }, type: 'Goal', detail: 'Normal Goal' },
      { time: { elapsed: 29, extra: null }, team: { name: 'Bengaluru FC' }, player: { name: 'S. Chhetri' }, assist: {}, type: 'Card', detail: 'Yellow Card' },
    ],
    statistics: [
      { team: { id: 9901 }, statistics: [{ type: 'Ball Possession', value: '57%' }, { type: 'Total Shots', value: 8 }, { type: 'Shots on Goal', value: 4 }, { type: 'Corner Kicks', value: 5 }] },
      { team: { id: 9902 }, statistics: [{ type: 'Ball Possession', value: '43%' }, { type: 'Total Shots', value: 5 }, { type: 'Shots on Goal', value: 1 }, { type: 'Corner Kicks', value: 2 }] },
    ],
  });

const done = (finished: boolean) =>
  fx(DONE_ID, [9903, 'FC Goa'], [9904, 'Kerala Blasters FC'], doneStart, {
    fixture: { id: DONE_ID, date: iso(doneStart), status: finished ? { short: 'FT', elapsed: 90 } : { short: '2H', elapsed: 80 }, venue: { name: 'Fatorda Stadium', city: 'Margao' } },
    goals: { home: 2, away: finished ? 2 : 1 },
    teams: { home: { id: 9903, name: 'FC Goa', winner: finished ? false : null }, away: { id: 9904, name: 'Kerala Blasters FC', winner: finished ? false : null } },
  });

const rss = `<rss><channel>
<item><title>India name unchanged XI for the Boxing Day Test - ESPNcricinfo</title><link>https://example.com/pl4y-e2e/india-xi</link><pubDate>${new Date(now - 40 * 60_000).toUTCString()}</pubDate><source url="https://www.espncricinfo.com">ESPNcricinfo</source></item>
<item><title>WPL auction: five players to watch - Cricbuzz</title><link>https://example.com/pl4y-e2e/wpl-auction</link><pubDate>${new Date(now - 2 * 3_600_000).toUTCString()}</pubDate><source url="https://www.cricbuzz.com">Cricbuzz</source></item>
</channel></rss>`;

const unsplash = JSON.stringify({
  results: [
    {
      urls: { regular: 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=1080&q=80' },
      user: { name: 'Alessandro Bogliari', links: { html: 'https://unsplash.com/@alessandrobogliari' } },
      links: {},
    },
  ],
});

const fetcher: Fetcher = async (url) => {
  const body = /fixtures\?date=/.test(url)
    ? JSON.stringify({ errors: [], response: [fx(LIVE_ID, [9901, 'Mumbai City FC'], [9902, 'Bengaluru FC'], liveStart), done(false)] })
    : /fixtures\?live=all/.test(url)
      ? JSON.stringify({ errors: [], response: [live(), done(phase === 'final')] })
      : /news\.google\.com/.test(url)
        ? rss
        : /api\.unsplash\.com/.test(url)
          ? unsplash
          : null;
  return body === null ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => body };
};

const limits = Object.fromEntries(FEED_PROVIDERS.map((p) => [p, 100])) as Record<FeedProvider, number>;
const configured = Object.fromEntries(FEED_PROVIDERS.map((p) => [p, true])) as Record<FeedProvider, boolean>;
const budget = createFeedBudget({ db, limits, configured });
const runner = createFeedRunner({ db, pro, budget, adapters: [apiFootballAdapter(() => 'e2e')], fetcher });

const sport = async (slug: string) => (await db.sport.findFirstOrThrow({ where: { slug }, select: { id: true } })).id;
const football = await sport('football');
const cricket = await sport('cricket');

const follows = await runner.follows();
if (!follows.some((f) => f.provider === 'api_football' && f.ref === '323')) {
  await runner.saveFollow(null, { provider: 'api_football', ref: '323', season: '2026', sportId: football, name: 'ISL' });
}
if (!follows.some((f) => f.provider === 'google_news')) {
  await runner.saveFollow(null, { provider: 'google_news', ref: 'cricket india', sportId: cricket, name: 'Cricket' });
}

console.log('fixtures', JSON.stringify((await runner.importFixtures()).filter((r) => r.provider === 'api_football')));
const doneMatch = (await pro.matchByProvider('api_football', String(DONE_ID)))!;
if (!(await predictions.forMatch(doneMatch.id)).length) {
  const locks = new Date(doneStart);
  await predictions.createQuestion(null, {
    matchId: doneMatch.id,
    kind: 'choice',
    prompt: 'Who wins in Goa?',
    locksAt: locks,
    options: [{ label: 'FC Goa', outcome: 'home' }, { label: 'Draw', outcome: 'draw' }, { label: 'Kerala Blasters FC', outcome: 'away' }],
  });
  await predictions.createQuestion(null, { matchId: doneMatch.id, kind: 'exact_score', prompt: 'Final score in Goa?', locksAt: locks });
}
phase = 'live';
console.log('live', JSON.stringify((await runner.pollLive({ force: true })).filter((r) => r.provider === 'api_football')));
phase = 'final';
console.log('final', JSON.stringify((await runner.pollLive({ force: true })).filter((r) => r.provider === 'api_football')));
for (const q of await predictions.forMatch(doneMatch.id)) {
  console.log('suggestion', q.prompt, q.suggestedOptionId ? q.options.find((o) => o.id === q.suggestedOptionId)?.label : `${q.suggestedHome}-${q.suggestedAway}`);
}
const liveMatch = (await pro.matchByProvider('api_football', String(LIVE_ID)))!;
await pro.updateMatch(liveMatch.id, { featured: true });
console.log('live match', liveMatch.id);

const news = createNewsImporter({
  content,
  budget,
  follows: async () => (await runner.follows()).filter((f) => f.provider === 'google_news') as never,
  sportName: async () => 'Cricket',
  recordFollow: async () => undefined,
  keys: { rss: true, newsdata: '', unsplash: 'e2e', pexels: '' },
  fetcher,
});
console.log('news', JSON.stringify(await news.run()));
await disconnectDb();
