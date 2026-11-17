/**
 * The feed jobs (G1): import fixtures for what PL4Y follows, and poll the
 * matches that are live or about to start. Every write goes through the pro
 * service (pro.createMatch / pro.updateMatch / pro.addFeedMoment), so the
 * Match Centre, the realtime channel, "match is live" pushes and settle
 * suggestions behave exactly as they do for a staff edit.
 *
 * feeds R4 — only matches that are live, on a break, or due within 15 minutes
 *   are polled, each provider no more often than its pollMinutes.
 * feeds R5 — a poll sends only what changed. Nothing new just marks the
 *   match checked (G9), so a quiet poll costs no realtime publish.
 */
import { FeedBudgetSpent, feedHttp, scrubKeys, type FeedBudget, type FeedProvider, type Fetcher } from '../../../platform/feeds.js';
import type { Db } from '../../../platform/db.js';
import { newId } from '../../../platform/ids.js';
import { UserError } from '../../../platform/errors/index.js';
import type { LivePatch, ProMatch, ProService } from '../service/index.js';
import type { FeedFollow, FeedMatch, ScoreAdapter } from './types.js';

export type ScoreProvider = 'cricapi' | 'api_football' | 'api_basketball' | 'api_nfl' | 'api_baseball' | 'api_hockey' | 'api_rugby' | 'api_mma' | 'jolpica' | 'lichess' | 'pandascore' | 'snooker_org';
export type NewsProvider = 'google_news' | 'newsdata';
export const FOLLOW_PROVIDERS: readonly FeedProvider[] = [
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
];

const AHEAD_MS = 15 * 60_000;

export interface RunSummary {
  provider: FeedProvider;
  created: number;
  updated: number;
  unchanged: number;
  skipped: string | null;
  errors: string[];
}

export interface FeedRunnerDeps {
  db: Db;
  pro: ProService;
  budget: FeedBudget;
  adapters: ScoreAdapter[];
  fetcher?: Fetcher;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  now?: () => Date;
}

const same = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date ? new Date(a as Date).getTime() === new Date(b as Date).getTime() : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** feeds R5 — the keys of the feed's view that differ from the match, minus what staff locked. Pure. */
export function feedPatch(current: ProMatch, feed: FeedMatch): LivePatch {
  const want: Record<string, unknown> = { ...feed.live };
  if (feed.startsAt) want['startsAt'] = feed.startsAt;
  if (feed.league) want['league'] = feed.league;
  if (feed.stage) want['stage'] = feed.stage;
  if (feed.venueName) want['venueName'] = feed.venueName;
  if (feed.city) want['city'] = feed.city;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(want)) {
    if (value === undefined || current.feedLocked.includes(key)) continue;
    if (!same(value, (current as unknown as Record<string, unknown>)[key])) patch[key] = value;
  }
  return patch as LivePatch;
}

/**
 * feeds R6 — what a fixtures import may change on a match that already exists:
 * its schedule (time, stage, venue), and only while it is still scheduled,
 * that it was postponed or called off. Never scores, stats or moments. Pure.
 */
export function scheduleView(current: ProMatch, feed: FeedMatch): FeedMatch {
  const stillScheduled = current.status === 'scheduled' && (feed.live.status === 'scheduled' || feed.live.status === 'abandoned');
  return {
    ...feed,
    startsAt: current.status === 'scheduled' ? feed.startsAt : null,
    live: stillScheduled ? { status: feed.live.status, statusDetail: feed.live.statusDetail } : {},
    moments: [],
  };
}

export function createFeedRunner(deps: FeedRunnerDeps) {
  const { db, pro, budget } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? { info() {}, warn() {} };

  // --- follows ---------------------------------------------------------------------

  const toFollow = (r: Awaited<ReturnType<Db['proFeedFollow']['findFirstOrThrow']>>): FeedFollow & { lastImportAt: Date | null; lastError: string | null } => ({
    id: r.id,
    provider: r.provider as FeedProvider,
    ref: r.ref,
    sportId: r.sportId,
    name: r.name,
    season: r.season,
    enabled: r.enabled,
    lastImportAt: r.lastImportAt,
    lastError: r.lastError,
  });

  async function follows(provider?: FeedProvider | null) {
    const rows = await db.proFeedFollow.findMany({ where: provider ? { provider } : {}, orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(toFollow);
  }

  async function saveFollow(id: string | null, input: { provider: FeedProvider; ref: string; sportId: string; name: string; season?: string | null; enabled?: boolean | null }) {
    if (!FOLLOW_PROVIDERS.includes(input.provider)) throw new UserError('INVALID_FEED_FOLLOW', 'That is not a feed PL4Y can follow.');
    const ref = input.ref.trim();
    const name = input.name.trim();
    const season = input.season?.trim() || null;
    if (ref.length < 1 || ref.length > 120) throw new UserError('INVALID_FEED_FOLLOW', 'Give the feed’s id (or a search, for news): 1 to 120 characters.');
    if (name.length < 1 || name.length > 60) throw new UserError('INVALID_FEED_FOLLOW', 'Give it a name of 1 to 60 characters, as players will see it.');
    if (input.provider === 'api_football' && !(season && /^\d{4}$/.test(season))) {
      throw new UserError('INVALID_FEED_FOLLOW', 'An API-Football league needs its season year, like 2026.');
    }
    const data = { provider: input.provider, ref, sportId: input.sportId, name, season, enabled: input.enabled ?? true };
    try {
      const row = id ? await db.proFeedFollow.update({ where: { id }, data }) : await db.proFeedFollow.create({ data: { id: newId(), ...data } });
      return toFollow(row);
    } catch (e) {
      if (/pro_feed_follows_key|P2002/.test(String((e as { code?: string }).code ?? e))) {
        throw new UserError('INVALID_FEED_FOLLOW', 'PL4Y already follows that.');
      }
      if ((e as { code?: string }).code === 'P2025') throw new UserError('INVALID_FEED_FOLLOW', 'That follow is no longer there.');
      throw e;
    }
  }

  async function deleteFollow(id: string): Promise<void> {
    await db.proFeedFollow.deleteMany({ where: { id } });
  }

  // --- writing a feed match -------------------------------------------------------

  async function apply(provider: FeedProvider, feed: FeedMatch, sportId: string | null, follow: FeedFollow | null): Promise<'created' | 'updated' | 'unchanged' | 'skipped'> {
    const existing = await pro.matchByProvider(provider, feed.ref);
    let match = existing;
    let created = false;
    if (!match) {
      // Only a fixtures import makes matches: it knows the sport, the league and both sides.
      if (!sportId || !feed.home || !feed.away || !feed.startsAt) return 'skipped';
      const home = await pro.feedTeam(sportId, provider, feed.home.ref, feed.home.name, feed.home.code);
      const away = await pro.feedTeam(sportId, provider, feed.away.ref, feed.away.name, feed.away.code);
      if (home.id === away.id) return 'skipped';
      try {
        match = await pro.createMatch(null, {
          sportId,
          league: (feed.league ?? follow?.name ?? 'Match').slice(0, 60),
          stage: feed.stage,
          homeTeamId: home.id,
          awayTeamId: away.id,
          venueName: feed.venueName,
          city: feed.city,
          startsAt: feed.startsAt,
          provider,
          providerRef: feed.ref,
        });
        created = true;
      } catch (e) {
        // Another run made it a moment ago (the provider_ref index is unique).
        match = await pro.matchByProvider(provider, feed.ref);
        if (!match) throw e;
      }
    }
    // feeds R6 — a fixtures import never touches a match already under way: schedule lists are
    // staler than live polls (CricAPI's has no scores at all). Live state comes from polls only.
    const view = !created && follow ? scheduleView(match, feed) : feed;
    const patch = feedPatch(match, view);
    const changed = Object.keys(patch).length > 0;
    if (changed) await pro.updateMatch(match.id, patch, { source: 'feed' });
    let moments = 0;
    for (const m of view.moments) if (await pro.addFeedMoment(match.id, m.ref, m)) moments += 1;
    if (!changed && !follow) await pro.touchFeedChecked([match.id]);
    return created ? 'created' : changed || moments ? 'updated' : 'unchanged';
  }

  async function sportIdOf(slug: string): Promise<string | null> {
    return (await db.sport.findFirst({ where: { slug }, select: { id: true } }))?.id ?? null;
  }

  const blank = (provider: FeedProvider): RunSummary => ({ provider, created: 0, updated: 0, unchanged: 0, skipped: null, errors: [] });

  async function fail(summary: RunSummary, err: unknown): Promise<void> {
    const message = scrubKeys(err instanceof Error ? err.message : String(err));
    summary.errors.push(message);
    if (!(err instanceof FeedBudgetSpent)) await budget.recordError(summary.provider, message);
  }

  // --- jobs ------------------------------------------------------------------------

  /** Daily, and from the portal: fixtures for every enabled follow (or one). */
  async function importFixtures(opts: { followId?: string | null } = {}): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const a of deps.adapters) {
      const summary = blank(a.provider);
      out.push(summary);
      if (!a.configured()) {
        summary.skipped = 'no key set';
        continue;
      }
      const list = (await follows(a.provider)).filter((f) => f.enabled && (!opts.followId || f.id === opts.followId));
      if (!list.length) {
        summary.skipped = 'nothing followed';
        continue;
      }
      const http = feedHttp(budget, a.provider, deps.fetcher);
      for (const follow of list) {
        try {
          const matches = await a.fixtures(follow, http, now());
          for (const m of matches) {
            try {
              const r = await apply(a.provider, m, follow.sportId, follow);
              if (r === 'created') summary.created += 1;
              else if (r === 'updated') summary.updated += 1;
              else summary.unchanged += 1;
            } catch (err) {
              await fail(summary, err);
            }
          }
          await db.proFeedFollow.update({ where: { id: follow.id }, data: { lastImportAt: now(), lastError: null } });
        } catch (err) {
          await fail(summary, err);
          await db.proFeedFollow.update({ where: { id: follow.id }, data: { lastError: scrubKeys(String((err as Error).message ?? err)).slice(0, 300) } });
        }
      }
      log.info({ ...summary }, 'feed fixtures imported');
    }
    return out;
  }

  /** feeds R4 — every minute from the worker; each provider decides if it is due. */
  async function pollLive(opts: { force?: boolean } = {}): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    const t = now();
    for (const a of deps.adapters) {
      const summary = blank(a.provider);
      out.push(summary);
      if (!a.configured()) {
        summary.skipped = 'no key set';
        continue;
      }
      const watch = await pro.feedWatchList(a.provider, AHEAD_MS);
      if (!watch.length) {
        summary.skipped = 'nothing live or about to start';
        continue;
      }
      const last = await budget.lastLivePoll(a.provider);
      if (!opts.force && last && t.getTime() - last.getTime() < a.pollMinutes * 60_000 - 5_000) {
        summary.skipped = 'not due yet';
        continue;
      }
      await budget.markLivePoll(a.provider);
      const teamIds = [...new Set(watch.flatMap((w) => [w.homeTeamId, w.awayTeamId]))];
      const refs = new Map((await db.proTeam.findMany({ where: { id: { in: teamIds } }, select: { id: true, providerRef: true } })).map((x) => [x.id, x.providerRef]));
      const watched = watch.map((w) => ({ ...w, homeRef: refs.get(w.homeTeamId) ?? null, awayRef: refs.get(w.awayTeamId) ?? null }));
      const http = feedHttp(budget, a.provider, deps.fetcher);
      try {
        const sportId = await sportIdOf(a.sportSlug);
        for (const m of await a.live(watched, http, t)) {
          try {
            const r = await apply(a.provider, m, sportId, null);
            if (r === 'updated') summary.updated += 1;
            else summary.unchanged += 1;
          } catch (err) {
            await fail(summary, err);
          }
        }
      } catch (err) {
        await fail(summary, err);
      }
      if (summary.errors.length) log.warn({ ...summary }, 'feed live poll had errors');
    }
    return out;
  }

  return { follows, saveFollow, deleteFollow, importFixtures, pollLive, status: budget.status, apply };
}

export type FeedRunner = ReturnType<typeof createFeedRunner>;
