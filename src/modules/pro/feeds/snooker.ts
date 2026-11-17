/**
 * snooker.org → pro matches (§5.6, the cue launch). Needs an approved
 * X-Requested-By value from webmaster@snooker.org; free for non-commercial
 * use with credit, so commercial use needs their OK first (§9).
 *
 * Fixtures: the event's matches (?t=6&e=) plus its players (?t=9&e=) for
 * names, and its rounds (?t=12&e=) for "Quarter-final · Best of 11".
 * Live: one ?t=7 call (every ongoing match). A watched match that leaves that
 * list is read once by event / round / number for its result.
 *
 * In pro_matches a snooker "team" is a player. A follow's `ref` is the event id.
 */
import { config } from '../../../platform/config.js';
import type { FeedHttp } from '../../../platform/feeds.js';
import type { LivePatch, ProMatch, ProStatus, Winner } from '../service/index.js';
import { arr, cut, num, obj, str, utcDate, type FeedFollow, type FeedMatch, type ScoreAdapter } from './types.js';

const BASE = 'https://api.snooker.org/';
const RESERVE = 20;

export interface SnookerPlayer {
  id: string;
  name: string;
  code: string;
}

export interface SnookerRound {
  name: string | null;
  bestOf: number | null;
}

export function parseSnookerPlayers(raw: unknown): Map<string, SnookerPlayer> {
  const out = new Map<string, SnookerPlayer>();
  for (const p of arr(raw).map(obj)) {
    const id = str(p['ID']);
    if (!id) continue;
    const last = str(p['LastName']) ?? '';
    const name = [str(p['FirstName']), str(p['MiddleName']), last].filter(Boolean).join(' ') || str(p['ShortName']) || `Player ${id}`;
    out.set(id, { id, name, code: (last || name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'TBC' });
  }
  return out;
}

export function parseSnookerRounds(raw: unknown): Map<string, SnookerRound> {
  const out = new Map<string, SnookerRound>();
  for (const r of arr(raw).map(obj)) {
    const round = str(r['Round']);
    if (!round) continue;
    const distance = num(r['Distance']);
    out.set(round, { name: str(r['RoundName']), bestOf: distance && distance > 0 ? distance * 2 - 1 : null });
  }
  return out;
}

/**
 * One snooker.org match. `ongoing` is true when it came from the ongoing
 * list (?t=7): that list is what says a match is in play. Pure.
 */
export function parseSnookerMatch(
  raw: unknown,
  ctx: { players: Map<string, SnookerPlayer>; rounds: Map<string, SnookerRound>; league: string | null; ongoing: boolean },
): FeedMatch | null {
  const m = obj(raw);
  const event = str(m['EventID']);
  const round = str(m['Round']);
  const number = str(m['Number']);
  const p1 = str(m['Player1ID']);
  const p2 = str(m['Player2ID']);
  if (!event || !round || !number || !p1 || !p2 || p1 === '0' || p2 === '0') return null; // 0: the player isn't known yet
  const winnerId = str(m['WinnerID']);
  const s1 = num(m['Score1']) ?? 0;
  const s2 = num(m['Score2']) ?? 0;
  const ended = (winnerId !== null && winnerId !== '0') || !!str(m['EndDate']);
  const status: ProStatus = ctx.ongoing ? (m['OnBreak'] === true ? 'break' : 'live') : ended ? 'finished' : 'scheduled';
  const info = ctx.rounds.get(round);

  const live: LivePatch = { status };
  if (status !== 'scheduled') {
    live.homeScore = String(s1);
    live.awayScore = String(s2);
    live.statusDetail = status === 'live' ? `Frame ${s1 + s2 + 1}` : status === 'break' ? 'Interval' : 'Result';
    const walkover = m['Walkover1'] === true || m['Walkover2'] === true;
    live.note = cut(walkover ? 'Walkover' : info?.bestOf ? `Best of ${info.bestOf}` : null, 120);
  }
  if (status === 'finished') {
    const winner: Winner | null = winnerId === p1 ? 'home' : winnerId === p2 ? 'away' : null;
    live.winner = winner;
  }
  const player = (id: string) => ctx.players.get(id);
  const a = player(p1);
  const b = player(p2);
  return {
    ref: `${event}-${round}-${number}`,
    startsAt: utcDate(m['ScheduledDate']) ?? utcDate(m['StartDate']) ?? utcDate(m['InitDate']),
    league: ctx.league,
    stage: cut(info?.name ?? `Round ${round}`, 60),
    venueName: null,
    city: null,
    home: a ? { ref: `p:${a.id}`, name: a.name, code: a.code } : null,
    away: b ? { ref: `p:${b.id}`, name: b.name, code: b.code } : null,
    live,
    moments: [],
  };
}

export function snookerAdapter(id: () => string = () => config.SNOOKER_API_ID): ScoreAdapter {
  const headers = () => ({ 'X-Requested-By': id() });
  const none = { players: new Map<string, SnookerPlayer>(), rounds: new Map<string, SnookerRound>(), league: null };
  return {
    provider: 'snooker_org',
    sportSlug: 'snooker',
    pollMinutes: 5,
    configured: () => id() !== '',
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const e = encodeURIComponent(follow.ref);
      const players = parseSnookerPlayers(await http.json(`${BASE}?t=9&e=${e}`, { headers: headers() }));
      const rounds = parseSnookerRounds(await http.json(`${BASE}?t=12&e=${e}`, { headers: headers() }).catch(() => []));
      const matches = arr(await http.json(`${BASE}?t=6&e=${e}`, { headers: headers() }));
      const horizon = now.getTime() + 14 * 86_400_000;
      return matches
        .map((m) => parseSnookerMatch(m, { players, rounds, league: follow.name, ongoing: false }))
        .filter((m): m is FeedMatch => m !== null && m.home !== null && m.away !== null && m.startsAt !== null && m.startsAt.getTime() <= horizon && m.startsAt.getTime() >= now.getTime() - 2 * 86_400_000);
    },
    async live(watch: ProMatch[], http: FeedHttp) {
      const ongoing = arr(await http.json(`${BASE}?t=7`, { headers: headers(), reserve: RESERVE }))
        .map((m) => parseSnookerMatch(m, { ...none, ongoing: true }))
        .filter((m): m is FeedMatch => m !== null);
      const byRef = new Map(ongoing.map((m) => [m.ref, m]));
      const out: FeedMatch[] = [];
      for (const w of watch) {
        if (!w.providerRef) continue;
        const found = byRef.get(w.providerRef);
        if (found) {
          out.push({ ...found, league: null, stage: null });
          continue;
        }
        if (w.status !== 'live' && w.status !== 'break') continue;
        const [e, r, n] = w.providerRef.split('-');
        try {
          const one = await http.json(`${BASE}?e=${e}&r=${r}&n=${n}`, { headers: headers(), reserve: RESERVE });
          const m = parseSnookerMatch(Array.isArray(one) ? one[0] : one, { ...none, ongoing: false });
          if (m) out.push({ ...m, league: null, stage: null });
        } catch {
          // Next poll tries again.
        }
      }
      return out;
    },
  };
}
