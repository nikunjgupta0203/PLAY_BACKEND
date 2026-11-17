/**
 * Outside data feeds (migration 060): the call budget and the one HTTP door
 * every feed goes through.
 *
 * feeds R1 — the app never calls a provider. The worker does, once for
 *   everyone, and keys never leave the server.
 * feeds R2 — G10: every call is counted against the provider's daily limit
 *   (IST day) before it is made. A call that would pass the limit is not
 *   made; the caller falls back to whatever staff enter by hand. Live polls
 *   keep a reserve so the next day's fixtures import still fits.
 * feeds R3 — a failed call is recorded on the provider (portal /pro/feeds),
 *   never thrown into a player's request.
 */
import type { Db } from './db.js';

export type FeedProvider =
  | 'cricapi'
  | 'api_football'
  | 'api_basketball'
  | 'api_nfl'
  | 'api_baseball'
  | 'api_hockey'
  | 'api_rugby'
  | 'api_mma'
  | 'jolpica'
  | 'lichess'
  | 'pandascore'
  | 'snooker_org'
  | 'google_news'
  | 'newsdata'
  | 'unsplash'
  | 'pexels';
export const FEED_PROVIDERS: readonly FeedProvider[] = [
  'cricapi',
  'api_football',
  'api_basketball',
  'api_nfl',
  'api_baseball',
  'api_hockey',
  'api_rugby',
  'api_mma',
  'jolpica',
  'lichess',
  'pandascore',
  'snooker_org',
  'google_news',
  'newsdata',
  'unsplash',
  'pexels',
];

export const FEED_LABELS: Record<FeedProvider, string> = {
  cricapi: 'CricketData.org (CricAPI)',
  api_football: 'API-Football',
  api_basketball: 'API-Basketball',
  api_nfl: 'API-American-Football (NFL)',
  api_baseball: 'API-Baseball',
  api_hockey: 'API-Hockey',
  api_rugby: 'API-Rugby',
  api_mma: 'API-MMA',
  jolpica: 'Jolpica F1',
  lichess: 'Lichess broadcasts',
  pandascore: 'PandaScore (esports)',
  snooker_org: 'snooker.org',
  google_news: 'Google News RSS',
  newsdata: 'NewsData.io',
  unsplash: 'Unsplash',
  pexels: 'Pexels',
};

/** The budget said no: the call was not made. */
export class FeedBudgetSpent extends Error {
  constructor(readonly provider: FeedProvider) {
    super(`${provider}: today's call limit is reached`);
  }
}

export interface FeedStatus {
  provider: FeedProvider;
  label: string;
  configured: boolean;
  callsToday: number;
  dailyLimit: number;
  lastCallAt: Date | null;
  lastLivePollAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

const IST_OFFSET_MS = 330 * 60_000;
/** The IST calendar day, YYYY-MM-DD. */
export const feedDay = (at: Date): string => new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

export interface FeedBudgetDeps {
  db: Db;
  limits: Record<FeedProvider, number>;
  configured: Record<FeedProvider, boolean>;
  now?: () => Date;
}

export function createFeedBudget(deps: FeedBudgetDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  /** feeds R2 — takes one call from today's budget, or says no. Atomic: two workers never both get the last one. */
  async function spend(provider: FeedProvider, reserve = 0): Promise<boolean> {
    const t = now();
    const day = feedDay(t);
    const cap = deps.limits[provider] - Math.max(reserve, 0);
    if (cap <= 0) return false;
    await db.$executeRaw`
      INSERT INTO pro_feed_providers (provider, day, calls) VALUES (${provider}, ${day}::date, 0)
      ON CONFLICT (provider) DO NOTHING`;
    const rows = await db.$queryRaw<{ calls: number }[]>`
      UPDATE pro_feed_providers
         SET calls = CASE WHEN day = ${day}::date THEN calls + 1 ELSE 1 END,
             day = ${day}::date,
             last_call_at = ${t}
       WHERE provider = ${provider}
         AND (day <> ${day}::date OR calls < ${cap})
      RETURNING calls`;
    return rows.length > 0;
  }

  async function recordError(provider: FeedProvider, message: string): Promise<void> {
    const t = now();
    const text = message.slice(0, 300);
    await db.$executeRaw`
      INSERT INTO pro_feed_providers (provider, day, calls, last_error, last_error_at)
      VALUES (${provider}, ${feedDay(t)}::date, 0, ${text}, ${t})
      ON CONFLICT (provider) DO UPDATE SET last_error = ${text}, last_error_at = ${t}`;
  }

  async function markLivePoll(provider: FeedProvider): Promise<void> {
    const t = now();
    await db.$executeRaw`
      INSERT INTO pro_feed_providers (provider, day, calls, last_live_poll_at) VALUES (${provider}, ${feedDay(t)}::date, 0, ${t})
      ON CONFLICT (provider) DO UPDATE SET last_live_poll_at = ${t}`;
  }

  async function lastLivePoll(provider: FeedProvider): Promise<Date | null> {
    const row = await db.proFeedProvider.findUnique({ where: { provider }, select: { lastLivePollAt: true } });
    return row?.lastLivePollAt ?? null;
  }

  async function status(): Promise<FeedStatus[]> {
    const rows = new Map((await db.proFeedProvider.findMany()).map((r) => [r.provider, r]));
    const today = feedDay(now());
    return FEED_PROVIDERS.map((provider) => {
      const r = rows.get(provider);
      const sameDay = r ? r.day.toISOString().slice(0, 10) === today : false;
      return {
        provider,
        label: FEED_LABELS[provider],
        configured: deps.configured[provider],
        callsToday: sameDay ? r!.calls : 0,
        dailyLimit: deps.limits[provider],
        lastCallAt: r?.lastCallAt ?? null,
        lastLivePollAt: r?.lastLivePollAt ?? null,
        lastError: r?.lastError ?? null,
        lastErrorAt: r?.lastErrorAt ?? null,
      };
    });
  }

  return { spend, recordError, markLivePoll, lastLivePoll, status };
}

export type FeedBudget = ReturnType<typeof createFeedBudget>;

export type Fetcher = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** What an adapter is handed: one provider's budgeted GET. */
export interface FeedHttp {
  json(url: string, opts?: { headers?: Record<string, string>; reserve?: number }): Promise<unknown>;
  text(url: string, opts?: { headers?: Record<string, string>; reserve?: number }): Promise<string>;
}

const TIMEOUT_MS = 15_000;

/** feeds R2, R3 — spend first, then call; a non-2xx or a timeout is an error with no key in it. */
export function feedHttp(budget: FeedBudget, provider: FeedProvider, fetcher: Fetcher = fetch as unknown as Fetcher): FeedHttp {
  async function get(url: string, opts: { headers?: Record<string, string>; reserve?: number } = {}): Promise<string> {
    if (!(await budget.spend(provider, opts.reserve ?? 0))) throw new FeedBudgetSpent(provider);
    const res = await fetcher(url, { headers: { accept: 'application/json, application/xml;q=0.9, */*;q=0.5', ...opts.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${provider}: HTTP ${res.status}`);
    return res.text();
  }
  return {
    text: get,
    async json(url, opts) {
      const body = await get(url, opts);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new Error(`${provider}: the response was not JSON`);
      }
    },
  };
}

/** For logs and the portal: a provider error never carries a key from the URL. */
export function scrubKeys(message: string): string {
  return message.replace(/(apikey|api_key|key|client_id)=[^&\s]+/gi, '$1=…');
}
