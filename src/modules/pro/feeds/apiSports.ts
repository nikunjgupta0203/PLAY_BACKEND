/**
 * API-Sports, the other sports (Floodlight watch sports, 2026-11-17):
 * basketball, American football, baseball, ice hockey, rugby and MMA. One
 * API_SPORTS_KEY covers them all; each sport is its own API with its own
 * free 100 calls a day, so each is its own provider and budget.
 *
 * Built like API-Football for the free plan: `date=` for today and tomorrow
 * (one call per day per sport, shared by every follow), kept to the followed
 * leagues. A live refresh re-reads today's list (and yesterday's, for a game
 * that started before midnight UTC): these APIs have no free `live=all` for
 * every sport, and one list call refreshes every watched game at once.
 *
 * A follow's `ref` is the league id (NFL 1, MLB 1, NHL 57, NBA 12); for MMA,
 * a word in the event name ("UFC"), since fights belong to events, not leagues.
 */
import { config } from '../../../platform/config.js';
import type { FeedHttp, FeedProvider } from '../../../platform/feeds.js';
import type { LivePatch, ProMatch, ProStatus, Winner } from '../service/index.js';
import { arr, codeFor, cut, num, obj, str, type FeedFollow, type FeedMatch, type ScoreAdapter } from './types.js';

export interface ApiSportsSpec {
  provider: FeedProvider;
  sportSlug: string;
  host: string;
  /** `games` for team sports, `fights` for MMA. */
  path: 'games' | 'fights';
  /** Whether a level score at full time is a result (rugby, the NFL regular season) or impossible (basketball, baseball, hockey). */
  draws: boolean;
  pollMinutes: number;
}

export const API_SPORTS: ApiSportsSpec[] = [
  { provider: 'api_basketball', sportSlug: 'basketball', host: 'https://v1.basketball.api-sports.io', path: 'games', draws: false, pollMinutes: 10 },
  { provider: 'api_nfl', sportSlug: 'american-football', host: 'https://v1.american-football.api-sports.io', path: 'games', draws: true, pollMinutes: 10 },
  { provider: 'api_baseball', sportSlug: 'baseball', host: 'https://v1.baseball.api-sports.io', path: 'games', draws: false, pollMinutes: 10 },
  { provider: 'api_hockey', sportSlug: 'ice-hockey', host: 'https://v1.hockey.api-sports.io', path: 'games', draws: false, pollMinutes: 10 },
  { provider: 'api_rugby', sportSlug: 'rugby', host: 'https://v1.rugby.api-sports.io', path: 'games', draws: true, pollMinutes: 10 },
  { provider: 'api_mma', sportSlug: 'mma', host: 'https://v1.mma.api-sports.io', path: 'fights', draws: true, pollMinutes: 15 },
];

const RESERVE = 10;
const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** API-Sports answers 200 with `errors` set when the plan or the key refuses. */
export function apiSportsBody(json: unknown, provider: string): unknown[] {
  const b = obj(json);
  const errors = b['errors'];
  const list = Array.isArray(errors) ? errors.map(String) : Object.values(obj(errors)).map(String);
  if (list.length) throw new Error(`${provider}: ${list.join('; ')}`);
  return arr(b['response']);
}

const SCHEDULED = new Set(['NS', 'TBD']);
const POSTPONED = new Set(['POST', 'PST']);
const CALLED_OFF = new Set(['CANC', 'ABD', 'SUSP']);
const FINISHED = new Set(['FT', 'AOT', 'AET', 'AP', 'APT', 'AWD', 'AW', 'WO']);
const BREAK = new Set(['HT', 'BT', 'PT', 'INTR', 'EOR']);

/** A provider status → ours, with the words players see. Pure. */
export function apiSportsStatus(short: string | null, long: string | null): { status: ProStatus; detail: string | null } {
  const s = (short ?? '').toUpperCase();
  if (SCHEDULED.has(s) || (!s && !long)) return { status: 'scheduled', detail: s === 'TBD' ? 'Time to be confirmed' : null };
  if (POSTPONED.has(s)) return { status: 'scheduled', detail: 'Postponed' };
  if (CALLED_OFF.has(s)) return { status: 'abandoned', detail: long ? cut(long, 30) : 'Called off' };
  if (FINISHED.has(s) || /^finished|^game finished|^after/i.test(long ?? '')) return { status: 'finished', detail: s === 'FT' || !long ? 'Full time' : cut(long, 30) };
  if (BREAK.has(s)) return { status: 'break', detail: long ? cut(long, 30) : 'Break' };
  return { status: 'live', detail: long ? cut(long, 30) : s || 'Live' };
}

/** A side's score: a number, or an object with `total` (basketball, NFL, baseball). */
const totalOf = (v: unknown): number | null => num(v) ?? num(obj(v)['total']);

/** "2026-11-17T00:30:00+00:00", or the NFL's { date, time, timestamp }. */
function startOf(g: Record<string, unknown>): Date | null {
  const game = obj(g['game']);
  const raw = g['date'] ?? game['date'];
  const ts = num(g['timestamp']) ?? num(obj(raw)['timestamp']);
  if (ts !== null) return new Date(ts * 1000);
  const s = str(raw);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One game (or fight) from any of these APIs. Pure. */
export function parseApiSportsGame(raw: unknown, spec: Pick<ApiSportsSpec, 'path' | 'draws'>, league: string | null): FeedMatch | null {
  const g = obj(raw);
  const game = obj(g['game']);
  const id = str(g['id']) ?? str(game['id']);
  if (!id) return null;
  const startsAt = startOf(g);
  const statusRaw = obj(g['status'] ?? game['status']);
  const { status, detail } = apiSportsStatus(str(statusRaw['short']), str(statusRaw['long']));

  let home: FeedMatch['home'] = null;
  let away: FeedMatch['away'] = null;
  let homeWon: boolean | null = null;
  let awayWon: boolean | null = null;
  if (spec.path === 'fights') {
    const f = obj(g['fighters']);
    const a = obj(f['first']);
    const b = obj(f['second']);
    const an = str(a['name']);
    const bn = str(b['name']);
    if (an && str(a['id'])) home = { ref: `f:${str(a['id'])}`, name: an, code: codeFor(an.split(' ').pop() ?? an) };
    if (bn && str(b['id'])) away = { ref: `f:${str(b['id'])}`, name: bn, code: codeFor(bn.split(' ').pop() ?? bn) };
    homeWon = a['winner'] === true ? true : null;
    awayWon = b['winner'] === true ? true : null;
  } else {
    const t = obj(g['teams']);
    const a = obj(t['home']);
    const b = obj(t['away']);
    const an = str(a['name']);
    const bn = str(b['name']);
    if (an && str(a['id'])) home = { ref: str(a['id'])!, name: an, code: codeFor(an) };
    if (bn && str(b['id'])) away = { ref: str(b['id'])!, name: bn, code: codeFor(bn) };
  }

  const live: LivePatch = { status, statusDetail: detail };
  if (spec.path === 'games' && status !== 'scheduled') {
    const scores = obj(g['scores']);
    const h = totalOf(scores['home']);
    const a = totalOf(scores['away']);
    if (h !== null) live.homeScore = String(h);
    if (a !== null) live.awayScore = String(a);
    if (status === 'finished' && h !== null && a !== null) {
      const winner: Winner | null = h > a ? 'home' : a > h ? 'away' : spec.draws ? 'draw' : null;
      live.winner = winner;
      live.note = winner === 'home' ? `${home?.name ?? 'Home'} win` : winner === 'away' ? `${away?.name ?? 'Away'} win` : winner === 'draw' ? 'Draw' : null;
    }
  }
  if (spec.path === 'fights' && status === 'finished') {
    const winner: Winner | null = homeWon ? 'home' : awayWon ? 'away' : null;
    live.winner = winner;
    live.homeScore = homeWon ? 'W' : awayWon ? 'L' : null;
    live.awayScore = awayWon ? 'W' : homeWon ? 'L' : null;
    live.note = winner === 'home' ? `${home?.name} wins` : winner === 'away' ? `${away?.name} wins` : null;
  }

  const lg = obj(g['league']);
  const venue = obj(game['venue']);
  const stage = spec.path === 'fights'
    ? [str(g['category']), g['is_main'] === true ? 'Main event' : null].filter(Boolean).join(' · ') || null
    : [str(game['stage']) ?? str(g['stage']), str(game['week']) ?? str(g['week'])].filter(Boolean).join(' · ') || null;
  return {
    ref: id,
    startsAt,
    league: cut(league ?? (spec.path === 'fights' ? str(g['slug']) : str(lg['name'])), 60),
    stage: cut(stage, 60),
    venueName: cut(str(venue['name']) ?? (typeof g['venue'] === 'string' ? str(g['venue']) : str(obj(g['venue'])['name'])), 80),
    city: cut(str(venue['city']), 60),
    home,
    away,
    live,
    moments: [],
  };
}

/** Does this game belong to the follow? League id for games, a word in the event name for fights. */
export function apiSportsFollows(raw: unknown, spec: Pick<ApiSportsSpec, 'path'>, follow: Pick<FeedFollow, 'ref'>): boolean {
  const g = obj(raw);
  if (spec.path === 'fights') return (str(g['slug']) ?? '').toLowerCase().includes(follow.ref.trim().toLowerCase());
  return str(obj(g['league'])['id']) === follow.ref.trim();
}

export function apiSportsAdapter(spec: ApiSportsSpec, key: () => string = () => config.API_SPORTS_KEY): ScoreAdapter {
  const headers = () => ({ 'x-apisports-key': key() });
  const byDate = new Map<string, { at: number; list: Promise<unknown[]> }>();
  const dayList = (http: FeedHttp, day: string, now: Date, reserve = 0, fresh = false): Promise<unknown[]> => {
    const hit = byDate.get(day);
    if (!fresh && hit && now.getTime() - hit.at < 10 * 60_000) return hit.list;
    const list = http.json(`${spec.host}/${spec.path}?date=${day}&timezone=UTC`, { headers: headers(), reserve }).then((j) => apiSportsBody(j, spec.provider));
    list.catch(() => byDate.delete(day));
    byDate.set(day, { at: now.getTime(), list });
    return list;
  };
  const idOf = (raw: unknown) => str(obj(raw)['id']) ?? str(obj(obj(raw)['game'])['id']);

  return {
    provider: spec.provider,
    sportSlug: spec.sportSlug,
    pollMinutes: spec.pollMinutes,
    configured: () => key() !== '',
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const out: FeedMatch[] = [];
      // Yesterday too: Matches › Results shows what just finished, with its score.
      for (const day of [utcDay(new Date(now.getTime() - 86_400_000)), utcDay(now), utcDay(new Date(now.getTime() + 86_400_000))]) {
        for (const g of await dayList(http, day, now)) {
          if (!apiSportsFollows(g, spec, follow)) continue;
          const m = parseApiSportsGame(g, spec, spec.path === 'fights' ? null : follow.name || null);
          if (m && m.startsAt && m.home && m.away) out.push(m);
        }
      }
      return out;
    },
    async live(watch: ProMatch[], http: FeedHttp, now: Date) {
      const wanted = new Set(watch.map((w) => w.providerRef).filter((r): r is string => !!r));
      // Today, plus yesterday when a watched game started then (a late game runs past midnight UTC).
      const days = new Set(watch.map((w) => utcDay(w.startsAt)).filter((d) => d >= utcDay(new Date(now.getTime() - 86_400_000))));
      days.add(utcDay(now));
      const out: FeedMatch[] = [];
      for (const day of days) {
        for (const g of await dayList(http, day, now, RESERVE, true)) {
          const id = idOf(g);
          if (!id || !wanted.has(id)) continue;
          const m = parseApiSportsGame(g, spec, null);
          // The league and stage stay as the import named them.
          if (m) out.push({ ...m, league: null, stage: null });
        }
      }
      return out;
    },
  };
}
