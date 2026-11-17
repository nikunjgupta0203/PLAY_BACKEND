/**
 * API-Football v3 (API-Sports) → pro matches (§5.1). Free tier: 100 calls a day.
 *
 * Built for what the FREE plan allows (checked with a real key, 2026-11-17):
 * `season=` only 2022–2024, `date=` only yesterday to tomorrow, no `ids=`,
 * `live=all` fine. So:
 *   · Fixtures: `fixtures?date=` for today and tomorrow, one call per date
 *     shared by every follow, kept to the followed leagues. The schedule
 *     reaches about a day ahead; the twice-daily import keeps it rolling.
 *   · Live: one `fixtures?live=all` call per refresh refreshes every watched
 *     match, with its events (goals, cards → moments). Statistics come only
 *     with `ids=`, so the free plan shows no stats tiles.
 *   · A watched match gone from the live list has ended: its day's `date=`
 *     list (one call, shared) gives the result.
 *
 * A follow's `ref` is the league id; `season` is unused on this plan.
 */
import { config } from '../../../platform/config.js';
import type { FeedHttp } from '../../../platform/feeds.js';
import type { LivePatch, MomentKind, ProMatch, ProStatus, Stat, Winner } from '../service/index.js';
import { arr, codeFor, cut, num, obj, str, type FeedFollow, type FeedMatch, type FeedMoment, type ScoreAdapter } from './types.js';

const BASE = 'https://v3.football.api-sports.io';
/** `date=` with `timezone=UTC` is a UTC calendar day. */
const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
const RESERVE = 10;

const STATUS: Record<string, [ProStatus, string | null]> = {
  TBD: ['scheduled', 'Time to be confirmed'],
  NS: ['scheduled', null],
  PST: ['scheduled', 'Postponed'],
  '1H': ['live', null],
  '2H': ['live', null],
  ET: ['live', null],
  P: ['live', 'Penalties'],
  LIVE: ['live', null],
  HT: ['break', 'Half time'],
  BT: ['break', 'Extra time break'],
  INT: ['break', 'Interrupted'],
  SUSP: ['break', 'Suspended'],
  FT: ['finished', 'Full time'],
  AET: ['finished', 'After extra time'],
  PEN: ['finished', 'After penalties'],
  AWD: ['finished', 'Awarded'],
  WO: ['finished', 'Walkover'],
  CANC: ['abandoned', 'Cancelled'],
  ABD: ['abandoned', 'Abandoned'],
};

function body(json: unknown): unknown[] {
  const b = obj(json);
  const errors = b['errors'];
  const list = Array.isArray(errors) ? errors.map(String) : Object.values(obj(errors)).map(String);
  if (list.length) throw new Error(`api_football: ${list.join('; ')}`);
  return arr(b['response']);
}

const STAT_ROWS: [string, string][] = [
  ['Ball Possession', 'Possession'],
  ['Total Shots', 'Shots'],
  ['Shots on Goal', 'On target'],
  ['Corner Kicks', 'Corners'],
  ['Fouls', 'Fouls'],
  ['Yellow Cards', 'Yellow cards'],
];

function statsOf(fx: Record<string, unknown>, homeId: string): Stat[] {
  const sides = arr(fx['statistics']).map(obj);
  if (sides.length < 2) return [];
  const homeSide = sides.find((s) => str(obj(s['team'])['id']) === homeId) ?? sides[0]!;
  const awaySide = sides.find((s) => s !== homeSide) ?? sides[1]!;
  const value = (side: Record<string, unknown>, type: string) => str(arr(side['statistics']).map(obj).find((x) => str(x['type']) === type)?.['value']) ?? '0';
  return STAT_ROWS.filter(([type]) => arr(homeSide['statistics']).some((x) => str(obj(x)['type']) === type))
    // Compact, to fit a stat tile: "57–43%", "8–5".
    .map(([type, label]) => {
      const h = value(homeSide, type);
      const a = value(awaySide, type);
      const pct = h.endsWith('%') && a.endsWith('%');
      return { label, value: (pct ? `${h.slice(0, -1)}–${a}` : `${h}–${a}`).slice(0, 20) };
    })
    .slice(0, 6);
}

function momentsOf(fx: Record<string, unknown>): FeedMoment[] {
  return arr(fx['events'])
    .map(obj)
    .flatMap((e): FeedMoment[] => {
      const type = str(e['type'])?.toLowerCase();
      const detail = str(e['detail']) ?? '';
      const time = obj(e['time']);
      const elapsed = num(time['elapsed']);
      const extra = num(time['extra']);
      const player = str(obj(e['player'])['name']) ?? 'Unknown';
      const team = str(obj(e['team'])['name']);
      const at = elapsed === null ? null : extra ? `${elapsed}+${extra}'` : `${elapsed}'`;
      let kind: MomentKind;
      let title: string;
      if (type === 'goal') {
        if (/missed penalty/i.test(detail)) return [];
        kind = 'goal';
        title = /own goal/i.test(detail) ? `Own goal · ${player}` : /penalty/i.test(detail) ? `Penalty goal · ${player}` : `Goal · ${player}`;
      } else if (type === 'card') {
        kind = 'card';
        title = `${/red/i.test(detail) ? 'Red' : 'Yellow'} card · ${player}`;
      } else {
        return [];
      }
      const assist = str(obj(e['assist'])['name']);
      return [
        {
          ref: `${elapsed ?? ''}+${extra ?? ''}|${type}|${detail}|${player}`.slice(0, 120),
          atLabel: at,
          kind,
          title: cut(title, 80)!,
          detail: cut([team, kind === 'goal' && assist ? `assist ${assist}` : null].filter(Boolean).join(' · ') || null, 160),
        },
      ];
    });
}

/** Converts one API-Football fixture. Pure. */
export function parseFootballFixture(raw: unknown, league: string | null): FeedMatch | null {
  const fx = obj(raw);
  const fixture = obj(fx['fixture']);
  const ref = str(fixture['id']);
  const teams = obj(fx['teams']);
  const home = obj(teams['home']);
  const away = obj(teams['away']);
  const homeId = str(home['id']);
  const awayId = str(away['id']);
  const homeName = str(home['name']);
  const awayName = str(away['name']);
  if (!ref || !homeId || !awayId || !homeName || !awayName) return null;

  const st = obj(fixture['status']);
  const short = str(st['short']) ?? 'NS';
  const [status, label] = STATUS[short] ?? ['scheduled', str(st['long'])];
  const elapsed = num(st['elapsed']);
  const extra = num(st['extra']);
  const goals = obj(fx['goals']);
  const pens = obj(obj(fx['score'])['penalty']);

  const live: LivePatch = { status };
  live.statusDetail = cut(label ?? (status === 'live' && elapsed !== null ? (extra ? `${elapsed}+${extra}'` : `${elapsed}'`) : null), 40);
  if (status !== 'scheduled') {
    live.homeScore = str(goals['home']) ?? (status === 'abandoned' ? null : '0');
    live.awayScore = str(goals['away']) ?? (status === 'abandoned' ? null : '0');
    const ph = num(pens['home']);
    const pa = num(pens['away']);
    live.note = ph !== null && pa !== null ? `Penalties ${ph}–${pa}` : null;
    const stats = statsOf(fx, homeId);
    if (stats.length) live.stats = stats;
  }
  if (status === 'finished') {
    const winner: Winner | null =
      home['winner'] === true ? 'home' : away['winner'] === true ? 'away' : str(goals['home']) !== null && str(goals['home']) === str(goals['away']) ? 'draw' : null;
    live.winner = winner;
  }
  const venue = obj(fixture['venue']);
  const lg = obj(fx['league']);
  const kickoff = str(fixture['date']);
  const startsAt = kickoff ? new Date(kickoff) : null;
  return {
    ref,
    startsAt: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
    league: league ?? cut(str(lg['name']), 60),
    stage: cut(str(lg['round']), 60),
    venueName: cut(str(venue['name']), 80),
    city: cut(str(venue['city']), 60),
    home: { ref: homeId, name: homeName, code: codeFor(homeName) },
    away: { ref: awayId, name: awayName, code: codeFor(awayName) },
    live,
    moments: momentsOf(fx),
  };
}

export function apiFootballAdapter(key: () => string = () => config.API_SPORTS_KEY): ScoreAdapter {
  const headers = () => ({ 'x-apisports-key': key() });
  // One `date=` list per day, shared by every follow in a run (and by a poll's
  // finished matches). Kept 10 minutes: a run is seconds, the next is hours away.
  const byDate = new Map<string, { at: number; list: Promise<unknown[]> }>();
  const dayList = (http: FeedHttp, day: string, now: Date, reserve = 0): Promise<unknown[]> => {
    const hit = byDate.get(day);
    if (hit && now.getTime() - hit.at < 10 * 60_000) return hit.list;
    const list = http.json(`${BASE}/fixtures?date=${day}&timezone=UTC`, { headers: headers(), reserve }).then(body);
    list.catch(() => byDate.delete(day));
    byDate.set(day, { at: now.getTime(), list });
    return list;
  };
  const leagueOf = (fx: unknown) => str(obj(obj(fx)['league'])['id']);
  const fixtureId = (fx: unknown) => str(obj(obj(fx)['fixture'])['id']);

  return {
    provider: 'api_football',
    sportSlug: 'football',
    pollMinutes: 3,
    configured: () => key() !== '',
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const days = [utcDay(now), utcDay(new Date(now.getTime() + 86_400_000))];
      const out: FeedMatch[] = [];
      for (const day of days) {
        for (const fx of await dayList(http, day, now)) {
          if (leagueOf(fx) !== follow.ref) continue;
          const m = parseFootballFixture(fx, follow.name || null);
          if (m && m.startsAt) out.push(m);
        }
      }
      return out;
    },
    async live(watch: ProMatch[], http: FeedHttp, now: Date) {
      const wanted = new Set(watch.map((w) => w.providerRef).filter((r): r is string => !!r));
      const live = body(await http.json(`${BASE}/fixtures?live=all`, { headers: headers(), reserve: RESERVE }));
      const out: FeedMatch[] = [];
      const seen = new Set<string>();
      for (const fx of live) {
        const id = fixtureId(fx);
        if (!id || !wanted.has(id)) continue;
        const m = parseFootballFixture(fx, null);
        // The league name stays as the follow named it at import: null leaves it.
        if (m) {
          out.push({ ...m, league: null });
          seen.add(id);
        }
      }
      // Off the live list while we had it live: it ended. Its day's list has the result.
      for (const w of watch) {
        if (!w.providerRef || seen.has(w.providerRef) || (w.status !== 'live' && w.status !== 'break')) continue;
        // The free plan reads yesterday to tomorrow only: an older day is a refused call that still costs.
        if (utcDay(w.startsAt) < utcDay(new Date(now.getTime() - 86_400_000))) continue;
        try {
          const fx = (await dayList(http, utcDay(w.startsAt), now, RESERVE)).find((x) => fixtureId(x) === w.providerRef);
          const m = fx ? parseFootballFixture(fx, null) : null;
          if (m) out.push({ ...m, league: null });
        } catch {
          // Next poll tries again.
        }
      }
      return out;
    },
  };
}
