/**
 * Esports from PandaScore (Floodlight watch sports, 2026-11-17). Needs
 * PANDASCORE_KEY (free plan: schedules, results and live scores of matches).
 *
 *   · A follow's `ref` is the league id (pandascore.co → League → id).
 *     Fixtures: `matches?filter[league_id]=` from a day ago to a fortnight
 *     ahead, one call per follow.
 *   · Live: `matches/running` (one call, every running match); a watched
 *     match gone from it is read by id (`matches?filter[id]=`) for its result.
 *
 * Match ref: the PandaScore match id. A team's ref is its PandaScore id.
 */
import { config } from '../../../platform/config.js';
import type { FeedHttp } from '../../../platform/feeds.js';
import type { LivePatch, ProStatus, Winner } from '../service/index.js';
import { arr, codeFor, cut, num, obj, str, type FeedFollow, type FeedMatch, type FeedSide, type ScoreAdapter, type WatchedMatch } from './types.js';

const BASE = 'https://api.pandascore.co';
const RESERVE = 20;

const STATUS: Record<string, ProStatus> = { not_started: 'scheduled', running: 'live', finished: 'finished', canceled: 'abandoned', postponed: 'scheduled' };

/** One PandaScore match. Pure. */
export function parsePandaMatch(raw: unknown, league: string | null): FeedMatch | null {
  const m = obj(raw);
  const id = str(m['id']);
  if (!id) return null;
  const sides = arr(m['opponents']).map((o) => obj(obj(o)['opponent']));
  const sideOf = (o: Record<string, unknown> | undefined): FeedSide | null => {
    const sid = o ? str(o['id']) : null;
    const name = o ? str(o['name']) : null;
    if (!sid || !name) return null;
    return { ref: sid, name: cut(name, 60)!, code: (str(o!['acronym']) ?? codeFor(name)).slice(0, 5).toUpperCase() };
  };
  const home = sideOf(sides[0]);
  const away = sideOf(sides[1]);
  const raws = str(m['status']) ?? 'not_started';
  const status = STATUS[raws] ?? 'scheduled';
  const live: LivePatch = { status, statusDetail: raws === 'postponed' ? 'Postponed' : null };
  const bestOf = num(m['number_of_games']);
  if (status !== 'scheduled') {
    const score = (sid: string | undefined) => num(obj(arr(m['results']).map(obj).find((r) => str(r['team_id']) === sid || str(r['player_id']) === sid))['score']);
    const h = score(home?.ref);
    const a = score(away?.ref);
    if (h !== null) live.homeScore = String(h);
    if (a !== null) live.awayScore = String(a);
    if (status === 'live') live.statusDetail = bestOf ? `Best of ${bestOf} · game ${Math.min((h ?? 0) + (a ?? 0) + 1, bestOf)}` : 'Live';
  }
  if (status === 'finished') {
    const w = str(m['winner_id']);
    const winner: Winner | null = w && w === home?.ref ? 'home' : w && w === away?.ref ? 'away' : m['draw'] === true ? 'draw' : null;
    live.winner = winner;
    live.statusDetail = 'Result';
    live.note = winner === 'home' ? `${home?.name} win` : winner === 'away' ? `${away?.name} win` : winner === 'draw' ? 'Draw' : null;
  }
  const game = str(obj(m['videogame'])['name']);
  return {
    ref: id,
    startsAt: (() => {
      const s = str(m['begin_at']) ?? str(m['scheduled_at']);
      const d = s ? new Date(s) : null;
      return d && !Number.isNaN(d.getTime()) ? d : null;
    })(),
    league: cut(league ?? str(obj(m['league'])['name']), 60),
    stage: cut([game, str(obj(m['tournament'])['name']), bestOf ? `Bo${bestOf}` : null].filter(Boolean).join(' · ') || null, 60),
    venueName: null,
    city: null,
    home,
    away,
    live,
    moments: [],
  };
}

export function pandascoreAdapter(key: () => string = () => config.PANDASCORE_KEY): ScoreAdapter {
  const headers = () => ({ Authorization: `Bearer ${key()}` });
  return {
    provider: 'pandascore',
    sportSlug: 'esports',
    pollMinutes: 5,
    configured: () => key() !== '',
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const from = new Date(now.getTime() - 86_400_000).toISOString();
      const to = new Date(now.getTime() + 14 * 86_400_000).toISOString();
      const q = `filter[league_id]=${encodeURIComponent(follow.ref.trim())}&range[begin_at]=${from},${to}&sort=begin_at&per_page=50`;
      return arr(await http.json(`${BASE}/matches?${q}`, { headers: headers() }))
        .map((m) => parsePandaMatch(m, follow.name || null))
        .filter((m): m is FeedMatch => m !== null && m.home !== null && m.away !== null && m.startsAt !== null);
    },
    async live(watch: WatchedMatch[], http: FeedHttp) {
      const wanted = new Set(watch.map((w) => w.providerRef).filter((r): r is string => !!r));
      const running = arr(await http.json(`${BASE}/matches/running?per_page=100`, { headers: headers(), reserve: RESERVE }));
      const out: FeedMatch[] = [];
      const seen = new Set<string>();
      for (const r of running) {
        const m = parsePandaMatch(r, null);
        if (m && wanted.has(m.ref)) {
          out.push({ ...m, league: null, stage: null });
          seen.add(m.ref);
        }
      }
      // Gone from the running list while we had it live: read it once for the result.
      const ended = watch.filter((w) => w.providerRef && !seen.has(w.providerRef) && (w.status === 'live' || w.status === 'break')).map((w) => w.providerRef!);
      if (ended.length) {
        const done = arr(await http.json(`${BASE}/matches?filter[id]=${ended.slice(0, 50).join(',')}`, { headers: headers(), reserve: RESERVE }));
        for (const r of done) {
          const m = parsePandaMatch(r, null);
          if (m) out.push({ ...m, league: null, stage: null });
        }
      }
      return out;
    },
  };
}
