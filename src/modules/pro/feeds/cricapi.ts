/**
 * CricketData.org (CricAPI v1) → pro matches (§5.1). Free tier: 100 calls a day.
 *
 * One `currentMatches` call refreshes every live match at once; a match that
 * drops off that list is fetched once more by id to read its result. The
 * scorecard costs a call of its own, so it is read for featured matches about
 * every 15 minutes and once at the end. Ball-by-ball is a paid feature: the
 * current over is left to staff.
 *
 * A follow's `ref` is a CricAPI series id.
 */
import { config } from '../../../platform/config.js';
import type { FeedHttp } from '../../../platform/feeds.js';
import type { Innings, LivePatch, ProMatch, ProStatus, Stat, Winner } from '../service/index.js';
import { arr, codeFor, cut, num, obj, ordinal, str, utcDate, type FeedFollow, type FeedMatch, type ScoreAdapter } from './types.js';

const BASE = 'https://api.cricapi.com/v1';
const RESERVE = 10;
const POLL_MINUTES = 5;

function body(json: unknown): Record<string, unknown> {
  const b = obj(json);
  if (b['status'] !== 'success') throw new Error(`cricapi: ${str(b['reason']) ?? str(b['status']) ?? 'request failed'}`);
  return b;
}

interface Score {
  r: number;
  w: number;
  o: string;
  team: string;
}

const balls = (overs: string): number => {
  const [whole, part] = overs.split('.');
  return Number(whole || 0) * 6 + Number(part || 0);
};

/** "India Inning 1" → "india". */
const inningTeam = (inning: string): string => inning.replace(/\s+inning\s*\d*\s*$/i, '').trim().toLowerCase();

/**
 * Which team batted in each innings, lower-cased, in order. CricAPI names the
 * side batting second oddly: "Nagaland,Manipur Inning 1" (seen 2026-11-17 on
 * live data) means the team that did NOT bat in the innings before, whatever
 * the order of the names. A plain "nagaland Inning 1" is that team. Pure.
 */
export function inningsTeams(labels: string[], teams: string[]): string[] {
  const known = teams.map((t) => t.toLowerCase());
  const out: string[] = [];
  for (const label of labels) {
    const names = inningTeam(label)
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const matches = names.map((n) => known.find((k) => k === n) ?? known.find((k) => n.startsWith(k)) ?? null).filter((n): n is string => n !== null);
    const distinct = [...new Set(matches)];
    if (distinct.length === 1) out.push(distinct[0]!);
    else if (distinct.length > 1) {
      const previous = out.at(-1);
      out.push(distinct.find((n) => n !== previous) ?? distinct[0]!);
    } else out.push(names[0] ?? '');
  }
  return out;
}

function scoresOf(m: Record<string, unknown>, teams: string[]): Score[] {
  const raw = arr(m['score']).map(obj);
  const who = inningsTeams(raw.map((s) => str(s['inning']) ?? ''), teams);
  return raw.map((s, i) => ({ r: num(s['r']) ?? 0, w: num(s['w']) ?? 0, o: str(s['o']) ?? '0', team: who[i] ?? '' }));
}

const scoreText = (s: Score) => (s.w >= 10 ? `${s.r}` : `${s.r}/${s.w}`);

function winnerOf(m: Record<string, unknown>, home: string, away: string): Winner | null {
  const named = str(m['matchWinner'])?.toLowerCase();
  if (named) return named === home.toLowerCase() ? 'home' : named === away.toLowerCase() ? 'away' : null;
  const text = (str(m['status']) ?? '').toLowerCase();
  if (text.includes(`${home.toLowerCase()} won`)) return 'home';
  if (text.includes(`${away.toLowerCase()} won`)) return 'away';
  if (/\b(draw|drawn|tied)\b/.test(text)) return 'draw';
  return null;
}

const BREAK = /innings break|stumps|lunch|tea\b|drinks|rain|delayed|interrupted|bad light/i;

function statusOf(m: Record<string, unknown>): ProStatus {
  const text = str(m['status']) ?? '';
  if (m['matchEnded'] === true) return /abandon|cancel/i.test(text) ? 'abandoned' : 'finished';
  if (m['matchStarted'] === true) return BREAK.test(text) ? 'break' : 'live';
  return 'scheduled';
}

const PLACEHOLDER_TEAM = /^\s*(tbc|tba|tbd|to be (confirmed|announced|decided))\s*$/i;

/** Converts one CricAPI match (series_info matchList, currentMatches or match_info). Pure. */
export function parseCricMatch(raw: unknown, league: string | null): FeedMatch | null {
  const m = obj(raw);
  const ref = str(m['id']);
  const teams = arr(m['teams']).map((t) => str(t)).filter((t): t is string => t !== null);
  if (!ref || teams.length < 2) return null;
  const [homeName, awayName] = teams as [string, string];
  // A knockout fixture before its sides are known ("Tbc v Tbc"): skip it until the teams are named,
  // or "Tbc" becomes a team players can follow and a match nobody can predict.
  if (PLACEHOLDER_TEAM.test(homeName) || PLACEHOLDER_TEAM.test(awayName)) return null;
  const info = arr(m['teamInfo']).map(obj);
  const codeOf = (name: string) => str(info.find((t) => str(t['name'])?.toLowerCase() === name.toLowerCase())?.['shortname']) ?? codeFor(name);

  const status = statusOf(m);
  const scores = scoresOf(m, teams);
  const sideScores = (name: string) => scores.filter((s) => s.team === name.toLowerCase());
  const home = sideScores(homeName);
  const away = sideScores(awayName);
  const text = str(m['status']);
  const matchType = (str(m['matchType']) ?? '').toLowerCase();

  const live: LivePatch = { status };
  if (status !== 'scheduled') {
    live.homeScore = home.length ? home.map(scoreText).join(' & ') : null;
    live.awayScore = away.length ? away.map(scoreText).join(' & ') : null;
    live.homeDetail = home.length ? `${home.at(-1)!.o} ov` : null;
    live.awayDetail = away.length ? `${away.at(-1)!.o} ov` : null;
    live.note = cut(text, 120);
    live.statusDetail =
      status === 'live'
        ? `${ordinal(Math.max(scores.length, 1))} innings`
        : status === 'break'
          ? cut((BREAK.exec(text ?? '')?.[0] ?? 'Break').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), 40)
          : status === 'finished'
            ? 'Result'
            : 'Abandoned';
    const stats: Stat[] = [];
    const batting = scores.at(-1);
    if (batting && (status === 'live' || status === 'break') && balls(batting.o) > 0) {
      stats.push({ label: 'Run rate', value: ((batting.r * 6) / balls(batting.o)).toFixed(2) });
      if ((matchType === 't20' || matchType === 'odi') && scores.length === 2) stats.push({ label: 'Target', value: String(scores[0]!.r + 1) });
    }
    live.stats = stats;
    if (status === 'finished') live.winner = winnerOf(m, homeName, awayName);
  }

  return {
    ref,
    startsAt: utcDate(m['dateTimeGMT']) ?? utcDate(m['date']),
    league,
    stage: cut(str(m['name'])?.split(',')[1]?.trim() ?? null, 60),
    venueName: cut(str(m['venue'])?.split(',')[0]?.trim() ?? null, 80),
    city: cut((str(m['venue'])?.includes(',') ? str(m['venue'])!.split(',').at(-1)!.trim() : null) || null, 60),
    home: { ref: `name:${homeName.toLowerCase()}`, name: homeName, code: codeOf(homeName) },
    away: { ref: `name:${awayName.toLowerCase()}`, name: awayName, code: codeOf(awayName) },
    live,
    moments: [],
  };
}

/**
 * A CricAPI scorecard → pro R2 innings tables, latest innings first. Up to two
 * innings get batting and bowling; a longer match keeps the last four batting
 * cards (the shape holds four tables). Pure.
 */
export function parseCricScorecard(raw: unknown): Innings[] {
  const d = obj(raw);
  const info = arr(d['teamInfo']).map(obj);
  const teams = arr(d['teams']).map((t) => str(t)).filter((t): t is string => t !== null);
  const codeOf = (name: string) => str(info.find((t) => str(t['name'])?.toLowerCase() === name.toLowerCase())?.['shortname']) ?? codeFor(name);
  const scores = scoresOf(d, teams);
  const innings = arr(d['scorecard']).map(obj);
  const batted = inningsTeams(innings.map((inn) => str(inn['inning']) ?? ''), teams);
  const tables: Innings[] = [];
  const few = innings.length <= 2;
  innings.forEach((inn, i) => {
    const label = str(inn['inning']) ?? '';
    const battingName = teams.find((t) => t.toLowerCase() === batted[i]) ?? label.replace(/\s+inning.*$/i, '');
    const bowlingName = teams.find((t) => t !== battingName) ?? '';
    const s = scores[i];
    const title = few ? 'Batting' : `Batting · ${ordinal(i + 1)} inns`;
    tables.push({
      team: (codeOf(battingName) || 'BAT').slice(0, 10),
      title,
      columns: ['R', 'B', '4s', '6s', 'SR'],
      rows: arr(inn['batting'])
        .map(obj)
        .slice(0, 30)
        .map((b) => ({
          name: cut(str(obj(b['batsman'])['name']) ?? str(b['batsman']) ?? '—', 60)!,
          detail: cut(str(b['dismissal-text']) ?? null, 80),
          cells: [b['r'], b['b'], b['4s'], b['6s'], b['sr']].map((c) => (str(c) ?? '').slice(0, 10)),
        })),
      footer: s ? `Total ${scoreText(s)} (${s.o} ov)` : null,
    });
    if (few) {
      tables.push({
        team: (codeOf(bowlingName) || 'BOWL').slice(0, 10),
        title: 'Bowling',
        columns: ['O', 'M', 'R', 'W', 'Econ'],
        rows: arr(inn['bowling'])
          .map(obj)
          .slice(0, 30)
          .map((b) => ({
            name: cut(str(obj(b['bowler'])['name']) ?? str(b['bowler']) ?? '—', 60)!,
            detail: null,
            cells: [b['o'], b['m'], b['r'], b['w'], b['eco']].map((c) => (str(c) ?? '').slice(0, 10)),
          })),
        footer: null,
      });
    }
  });
  // Latest innings first: the batting card in play leads the Match Centre.
  const ordered = few ? (tables.length === 4 ? [tables[2]!, tables[3]!, tables[0]!, tables[1]!] : tables) : tables.reverse();
  return ordered.slice(0, 4);
}

export function cricapiAdapter(key: () => string = () => config.CRICAPI_KEY): ScoreAdapter {
  const url = (path: string, params: Record<string, string>) =>
    `${BASE}/${path}?${new URLSearchParams({ apikey: key(), ...params }).toString()}`;

  async function scorecard(http: FeedHttp, ref: string): Promise<Innings[] | undefined> {
    try {
      return parseCricScorecard(body(await http.json(url('match_scorecard', { id: ref }), { reserve: RESERVE }))['data']);
    } catch {
      return undefined;
    }
  }

  return {
    provider: 'cricapi',
    sportSlug: 'cricket',
    pollMinutes: POLL_MINUTES,
    configured: () => key() !== '',
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const data = obj(body(await http.json(url('series_info', { id: follow.ref })))['data']);
      const league = follow.name || str(obj(data['info'])['name']);
      const horizon = now.getTime() + 14 * 86_400_000;
      return arr(data['matchList'])
        .map((m) => parseCricMatch(m, league))
        .filter(
          (m): m is FeedMatch =>
            m !== null &&
            m.startsAt !== null &&
            m.startsAt.getTime() <= horizon &&
            // A Test on day 3 started three days ago and is still on: keep what is under way.
            (m.startsAt.getTime() >= now.getTime() - 2 * 86_400_000 || m.live.status === 'live' || m.live.status === 'break'),
        );
    },
    async live(watch: ProMatch[], http: FeedHttp, now: Date) {
      const current = arr(body(await http.json(url('currentMatches', { offset: '0' }), { reserve: RESERVE }))['data']);
      const byRef = new Map(current.map((m) => [str(obj(m)['id']), m]));
      const out: FeedMatch[] = [];
      for (const w of watch) {
        if (!w.providerRef) continue;
        let raw = byRef.get(w.providerRef);
        // Off the current list while we had it live: it ended. One call reads the result.
        if (!raw && (w.status === 'live' || w.status === 'break')) {
          try {
            raw = body(await http.json(url('match_info', { id: w.providerRef }), { reserve: RESERVE }))['data'];
          } catch {
            continue;
          }
        }
        const parsed = raw ? parseCricMatch(raw, null) : null;
        if (!parsed) continue;
        const ended = parsed.live.status === 'finished' && w.status !== 'finished';
        const quarter = now.getUTCMinutes() % 15 < POLL_MINUTES;
        if (ended || (w.featured && parsed.live.status === 'live' && quarter)) {
          const card = await scorecard(http, w.providerRef);
          if (card && card.length) parsed.live.scorecard = card;
        }
        out.push(parsed);
      }
      return out;
    },
  };
}
