/**
 * CricketData.org (CricAPI v1) → pro matches (§5.1). Free tier: 100 calls a day.
 *
 * One `currentMatches` call refreshes every live match at once; a match that
 * drops off that list is fetched once more by id to read its result. The
 * scorecard costs a call of its own, so it is read for featured matches every
 * 30 minutes (5 on a paid plan, see cricCadence) and once at the end. Ball-by-ball is a paid feature: the
 * current over is left to staff. 064 — the toss (match_info) and the squads
 * (match_squad) are read once each, at most one try per half hour.
 *
 * A follow's `ref` is a CricAPI series id.
 */
import { config } from '../../../platform/config.js';
import { FeedBudgetSpent, type FeedHttp } from '../../../platform/feeds.js';
import { MAX_BALLS, MAX_PROGRESS, STALE_LIVE_MS } from '../service/index.js';
import type { BallEvent, Fact, Innings, LivePatch, ProgressPoint, ProMatch, ProStatus, Squad, Stat, Winner } from '../service/index.js';
import { arr, codeFor, cut, logoUrl, num, obj, ordinal, str, utcDate, type FeedFollow, type FeedMatch, type FeedPace, type ScoreAdapter } from './types.js';
import { ALL_CRICKET, MAX_SERIES, MAX_SERIES_PAGES, SERIES_PAGE_ROWS, moreSeries, pickCricSeries } from './cricSeries.js';

const BASE = 'https://api.cricapi.com/v1';
const RESERVE = 10;

/**
 * How often the live score and the featured scorecard refresh. The free plan
 * (100 calls a day, 10 kept back) covers a whole Test day only at a score
 * every 10 minutes and a scorecard every 30: about 66 calls for ~7.5 hours of
 * play (every 5 and 15 was ~125, out by mid-afternoon). A paid plan
 * (CRICAPI_DAILY_LIMIT 1000 or more; S = 2,000) refreshes every minute with
 * the scorecard every 5: about 550 calls a day. 2026-11-21 — a match that is
 * not featured gets its scorecard too, less often: hourly (free), every 15
 * minutes (paid). Pure.
 */
export function cricCadence(dailyLimit: number): { pollMinutes: number; scorecardMinutes: number; otherScorecardMinutes: number } {
  return dailyLimit >= 1000
    ? { pollMinutes: 1, scorecardMinutes: 5, otherScorecardMinutes: 15 }
    : { pollMinutes: 10, scorecardMinutes: 30, otherScorecardMinutes: 60 };
}

/**
 * currentMatches pages: CricAPI sends 25 rows a page (seen 2026-11-21: 84 rows,
 * so 4 pages). A poll reads at most this many pages.
 */
const PAGE_ROWS = 25;
const MAX_PAGES = 4;
/**
 * 2026-11-21 — on a paid plan (a poll a minute), up to this many matches under
 * way are read one by one with match_info (it carries the score and the toss):
 * a call per match instead of up to four pages of currentMatches. With more,
 * the pages are read, every PAGED_MINUTES, and matches that are not featured
 * get their scorecard hourly (PAGED_CARD_MINUTES), so a busy day still fits
 * 2,000 calls: a dry run of "all cricket" on 21 Nov found 18 matches on at once
 * (~4 pages + 18 cards every 15 min would be ~150 calls an hour; this is ~90).
 */
const BY_ID_MAX = 3;
const PAGED_MINUTES = 5;
const PAGED_CARD_MINUTES = 60;
/** A fixture past its start that has not gone live is read on every poll for this long, then half-hourly. */
const FRESH_START_MS = 30 * 60_000;

/** Under way, or past its start: CricAPI should list it. A fixture still to come may not be yet. */
const started = (w: Pick<ProMatch, 'status' | 'startsAt'>, now: Date) => w.status === 'live' || w.status === 'break' || w.startsAt.getTime() <= now.getTime();
/**
 * A repair run fixes at most this many matches (one or two calls each). 2026-11-21 —
 * "all cricket" made ~20 finished matches without a card in one import; at 6 a run,
 * twice a day, the last waited two days. A paid plan takes 40, and also repairs every
 * RECOVER_MINUTES from the live poll (ScoreAdapter.recoverMinutes).
 */
const RECHECK_MAX_FREE = 6;
const RECHECK_MAX_PAID = 40;
const RECOVER_MINUTES = 30;

/**
 * 2026-11-21 — after a repair try, a match waits before the next: two hours, or a
 * quarter of its age if longer (a week-old match waits ~2 days), so one CricAPI has
 * no card for does not spend calls every half hour. Pure.
 */
export function recheckWait(startsAt: Date, now: Date): number {
  return Math.max(2 * 3_600_000, (now.getTime() - startsAt.getTime()) / 4);
}

/** Batting cards a scorecard holds, and innings a score line shows ("557 & 12/1" = 2). Pure. */
const battingCards = (m: Pick<ProMatch, 'scorecard'>) => m.scorecard.filter((t) => /^batting/i.test(t.title ?? '')).length;
const inningsPlayed = (m: Pick<ProMatch, 'homeScore' | 'awayScore'>) =>
  [m.homeScore, m.awayScore].reduce((n, s) => n + (s ? s.split('&').filter((p) => p.trim()).length : 0), 0);

/**
 * 2026-11-21 — whether a fixtures import should look at this match again:
 * - still scheduled 3 hours after its start (the live poll never found it: it
 *   was off the first page of currentMatches, or the day's calls were spent);
 * - a result of the last 14 days with no score or no scorecard at all (made
 *   from the schedule list after it was played: that list carries neither);
 * - a result of the last 3 days whose scorecard has fewer batting cards than
 *   innings played (CricAPI's card lagged when the match ended).
 * Pure.
 */
export function cricRecheck(m: Pick<ProMatch, 'status' | 'startsAt' | 'homeScore' | 'awayScore' | 'scorecard'>, now: Date): boolean {
  const age = now.getTime() - m.startsAt.getTime();
  if (m.status === 'scheduled') return age >= 3 * 3_600_000 && age <= 3 * 86_400_000;
  if (m.status !== 'finished' || age < 0 || age > 14 * 86_400_000) return false;
  if ((!m.homeScore && !m.awayScore) || battingCards(m) === 0) return true;
  return age <= 3 * 86_400_000 && battingCards(m) < Math.min(inningsPlayed(m), 4);
}

/**
 * 2026-11-20 — whether a live poll is due. A Test stays "live" for five days,
 * so polling at stumps every 10 minutes spent ~80 of the free plan's 90 calls
 * overnight and the score froze before lunch on day 5. When every watched
 * match is at stumps, poll once an hour (15 min on a paid plan), except from
 * 15 minutes before to 45 minutes after the hour of day the match first
 * started, when the next day's play usually begins. Pure.
 */
export function cricPollDue(watch: Pick<ProMatch, 'status' | 'statusDetail' | 'startsAt'>[], last: Date | null, now: Date, pollMinutes: number): boolean {
  if (!last) return true;
  const since = now.getTime() - last.getTime();
  const every = (minutes: number) => since >= minutes * 60_000 - 5_000;
  const atStumps = (w: (typeof watch)[number]) => w.status === 'break' && /stumps/i.test(w.statusDetail ?? '');
  if (!watch.length || !watch.every(atStumps)) return every(pollMinutes);
  const DAY = 86_400_000;
  const nearDailyStart = watch.some((w) => {
    const offset = (((now.getTime() - w.startsAt.getTime()) % DAY) + DAY) % DAY;
    return offset >= DAY - 15 * 60_000 || offset <= 45 * 60_000;
  });
  return every(nearDailyStart ? pollMinutes : pollMinutes === 1 ? 15 : 60);
}

const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** Behind pace, the live poll waits this long (the free plan's cadence). */
const BEHIND_MINUTES = 10;

/**
 * 2026-11-21 — whether today's calls are ahead of pace: more spent than the
 * share of the IST day gone by, plus 15% of the limit to spare for the busy
 * hours (Australian and Indian cricket bunch up in the IST daytime). With "all
 * cricket" followed, a Ranji round alone is 19 matches at once. Pure.
 */
export function cricBehind(pace: FeedPace | undefined, now: Date): boolean {
  if (!pace || pace.limit <= 0) return false;
  const gone = ((((now.getTime() + IST_MS) % DAY_MS) + DAY_MS) % DAY_MS) / DAY_MS;
  return pace.used > pace.limit * Math.min(1, gone + 0.15);
}

/**
 * 2026-11-21 — minutes between live polls: the plan's cadence; on a paid plan
 * with more than BY_ID_MAX matches under way (list pages), PAGED_MINUTES; and
 * never less than BEHIND_MINUTES while behind pace. Pure.
 */
export function cricEvery(watch: Pick<ProMatch, 'status' | 'startsAt' | 'providerRef'>[], now: Date, pace: FeedPace | undefined, pollMinutes: number): number {
  const paged = pollMinutes === 1 && watch.filter((w) => w.providerRef && started(w, now)).length > BY_ID_MAX;
  const every = paged ? PAGED_MINUTES : pollMinutes;
  return cricBehind(pace, now) ? Math.max(every, BEHIND_MINUTES) : every;
}

/** One series_info's matches for the next fortnight, and anything still under way. Pure. */
function seriesMatches(data: Record<string, unknown>, league: string | null, now: Date): FeedMatch[] {
  const horizon = now.getTime() + 14 * DAY_MS;
  return arr(data['matchList'])
    .map((m) => parseCricMatch(m, league))
    .filter(
      (m): m is FeedMatch =>
        m !== null &&
        m.startsAt !== null &&
        m.startsAt.getTime() <= horizon &&
        // A Test on day 3 started three days ago and is still on: keep what is under way.
        // 2026-11-21 — but not for ever: CricAPI's series lists still call some October
        // matches started-not-ended, and `*` imported them as live.
        (m.startsAt.getTime() >= now.getTime() - 2 * DAY_MS ||
          ((m.live.status === 'live' || m.live.status === 'break') && m.startsAt.getTime() >= now.getTime() - STALE_LIVE_MS)),
    );
}

/** 2026-11-20 — the toss and squads are read only this close to the start (a Test seen on day 5 never asks). */
const EXTRAS_WINDOW_MS = 6 * 3_600_000;

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

const FORMATS: Record<string, string> = { t20: 'T20', odi: 'ODI', test: 'Test', t10: 'T10' };

/** "India won the toss and chose to bat" as an Info row, when the payload says (match_info, scorecard). Pure. */
export function cricToss(raw: unknown): Fact | null {
  const m = obj(raw);
  const winner = str(m['tossWinner']);
  if (!winner) return null;
  const choice = (str(m['tossChoice']) ?? '').toLowerCase();
  const chose = /bat/.test(choice) ? 'chose to bat' : /bowl|field/.test(choice) ? 'chose to bowl' : null;
  const name = winner.replace(/\b\w/g, (c) => c.toUpperCase());
  return { label: 'Toss', value: cut(chose ? `${name}, ${chose}` : `${name} won`, 120)! };
}

/** 064 — the Info rows a CricAPI match carries: format, then the toss if known. Pure. */
export function cricFacts(raw: unknown): Fact[] {
  const m = obj(raw);
  const out: Fact[] = [];
  const type = (str(m['matchType']) ?? '').toLowerCase();
  if (FORMATS[type]) out.push({ label: 'Format', value: FORMATS[type]! });
  const toss = cricToss(m);
  if (toss) out.push(toss);
  return out;
}

/** 064 — match_squad → two squads, home side first. Pure. */
export function parseCricSquads(raw: unknown, home: string, away: string): Squad[] {
  const sides = arr(raw).map(obj);
  const pick = (name: string) => sides.find((s) => (str(s['teamName']) ?? '').toLowerCase() === name.toLowerCase());
  const ordered = [pick(home), pick(away)];
  // Names that differ ("India" vs "India Women"): fall back to the feed's own order.
  const list = ordered.every(Boolean) ? (ordered as Record<string, unknown>[]) : sides.slice(0, 2);
  return list
    .map((s) => ({
      team: cut(str(s['teamName']) ?? '', 40) ?? '',
      players: arr(s['players'])
        .map(obj)
        .slice(0, 40)
        .map((p) => ({ name: cut(str(p['name']) ?? '', 60) ?? '', role: cut(str(p['role']) ?? null, 40) }))
        .filter((p) => p.name !== ''),
    }))
    .filter((s) => s.team !== '' && s.players.length > 0);
}

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
  const infoOf = (name: string) => info.find((t) => str(t['name'])?.toLowerCase() === name.toLowerCase());
  const codeOf = (name: string) => str(infoOf(name)?.['shortname']) ?? codeFor(name);
  // 065 — teamInfo.img is the badge (icon512.png when CricAPI has none: dropped by logoUrl).
  const logoOf = (name: string) => logoUrl(infoOf(name)?.['img']);

  const status = statusOf(m);
  const scores = scoresOf(m, teams);
  const sideScores = (name: string) => scores.filter((s) => s.team === name.toLowerCase());
  const home = sideScores(homeName);
  const away = sideScores(awayName);
  const text = str(m['status']);
  const matchType = (str(m['matchType']) ?? '').toLowerCase();

  const live: LivePatch = { status };
  const facts = cricFacts(m);
  if (facts.length) live.facts = facts;
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
    home: { ref: `name:${homeName.toLowerCase()}`, name: homeName, code: codeOf(homeName), logo: logoOf(homeName) },
    away: { ref: `name:${awayName.toLowerCase()}`, name: awayName, code: codeOf(awayName), logo: logoOf(awayName) },
    live,
    moments: [],
  };
}

/** 065 — this payload's innings totals as worm points, innings in batting order. Pure. */
export function cricProgress(raw: unknown): ProgressPoint[] {
  const m = obj(raw);
  const teams = arr(m['teams']).map((t) => str(t)).filter((t): t is string => t !== null);
  if (teams.length < 2) return [];
  const info = arr(m['teamInfo']).map(obj);
  const codeOf = (lower: string) => {
    const name = teams.find((t) => t.toLowerCase() === lower) ?? lower;
    return (str(info.find((t) => str(t['name'])?.toLowerCase() === name.toLowerCase())?.['shortname']) ?? codeFor(name)).slice(0, 10);
  };
  return scoresOf(m, teams)
    .slice(0, 4)
    .map((s, i) => ({ inn: i + 1, team: codeOf(s.team) || 'BAT', b: Math.min(balls(s.o), 3000), r: Math.min(s.r, 2000), w: Math.min(s.w, 10) }))
    .filter((p) => p.b > 0);
}

/**
 * 065 — the worm keeps one point per innings per over: a new reading in the
 * same over replaces the old one. Oldest points drop off past MAX_PROGRESS.
 * Pure.
 */
export function mergeProgress(had: ProgressPoint[], now: ProgressPoint[]): ProgressPoint[] {
  const byOver = new Map<string, ProgressPoint>();
  for (const p of [...had, ...now]) {
    const key = `${p.inn}:${Math.floor(Math.max(p.b - 1, 0) / 6)}`;
    const prev = byOver.get(key);
    if (!prev || p.b >= prev.b) byOver.set(key, p);
  }
  return [...byOver.values()].sort((a, b) => a.inn - b.inn || a.b - b.b).slice(-MAX_PROGRESS);
}

/**
 * 065 — CricAPI match_bbb → deliveries, oldest first. The shape is from
 * CricAPI's docs as remembered, not yet checked against a live paid
 * response, so every field is optional and a ball without an over and ball
 * number is skipped. `inning` counts from 0 when any ball says 0. Pure.
 */
export function parseCricBalls(raw: unknown): BallEvent[] {
  const list = arr(obj(raw)['bbb']).map(obj);
  const zeroBased = list.some((b) => num(b['inning']) === 0);
  const nameOf = (v: unknown) => cut(str(obj(v)['name']) ?? str(v), 60) ?? null;
  const out: BallEvent[] = [];
  const seen = new Set<string>();
  for (const b of list) {
    const over = num(b['over']);
    const ball = num(b['ball']);
    if (over === null || ball === null || over < 0 || ball < 0) continue;
    const inn = Math.min(Math.max((num(b['inning']) ?? 0) + (zeroBased ? 1 : 0), 1), 4);
    const key = `${inn}:${over}:${ball}:${num(b['n']) ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const runs = Math.min(Math.max(num(b['runs']) ?? 0, 0), 10);
    const extras = Math.min(Math.max((num(b['extras']) ?? 0) + (num(b['penalty']) ?? 0), 0), 10);
    const wicket = Boolean(b['dismissal'] ?? b['wicket'] ?? b['isWicket'] ?? false) && b['dismissal'] !== 'not out';
    const batter = nameOf(b['batsman'] ?? b['batter']);
    const bowler = nameOf(b['bowler']);
    const what = wicket ? 'OUT' : runs === 4 ? 'FOUR' : runs === 6 ? 'SIX' : runs === 1 ? '1 run' : `${runs} runs`;
    const who = bowler && batter ? `${bowler} to ${batter}, ` : '';
    out.push({
      inn,
      over: Math.min(over, 500),
      ball: Math.min(ball, 15),
      runs,
      extras,
      wicket,
      batter,
      bowler,
      text: cut(`${who}${what}${extras ? ` (+${extras} extras)` : ''}`, 160) ?? null,
    });
  }
  return out.sort((a, b) => a.inn - b.inn || a.over - b.over || a.ball - b.ball);
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

export function cricapiAdapter(key: () => string = () => config.CRICAPI_KEY, dailyLimit: number = config.CRICAPI_DAILY_LIMIT): ScoreAdapter {
  const { pollMinutes, scorecardMinutes, otherScorecardMinutes } = cricCadence(dailyLimit);
  // 065 — ball by ball costs a call a poll: only a paid plan can afford it.
  const ballByBall = pollMinutes === 1;
  const url = (path: string, params: Record<string, string>) =>
    `${BASE}/${path}?${new URLSearchParams({ apikey: key(), ...params }).toString()}`;
  // 2026-11-21 — when each match was last tried by `recover` (recheckWait). In memory: a
  // worker restart only means one early try.
  const tried = new Map<string, number>();

  async function scorecard(http: FeedHttp, ref: string): Promise<Innings[] | undefined> {
    try {
      return parseCricScorecard(body(await http.json(url('match_scorecard', { id: ref }), { reserve: RESERVE }))['data']);
    } catch {
      return undefined;
    }
  }

  /**
   * 2026-11-21 — currentMatches, a page at a time, until every match in `want`
   * is found or the list ends. One page holds 25 matches: on a busy day (a
   * round of Indian domestic games) a WBBL match was not on the first page,
   * so it never went live and its result was never read. A later page that
   * fails keeps what the earlier pages found.
   */
  async function current(http: FeedHttp, want: string[]): Promise<Map<string | null, unknown>> {
    const byRef = new Map<string | null, unknown>();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let b: Record<string, unknown>;
      try {
        b = body(await http.json(url('currentMatches', { offset: String(offset) }), { reserve: RESERVE }));
      } catch (e) {
        if (page === 0) throw e;
        break;
      }
      const rows = arr(b['data']);
      for (const m of rows) byRef.set(str(obj(m)['id']), m);
      offset += rows.length;
      const total = num(obj(b['info'])['totalRows']);
      const more = rows.length > 0 && (total !== null ? offset < total : rows.length >= PAGE_ROWS);
      if (!more || want.every((ref) => byRef.has(ref))) break;
    }
    return byRef;
  }

  return {
    provider: 'cricapi',
    sportSlug: 'cricket',
    pollMinutes,
    due: (watch, last, now, pace) => cricPollDue(watch, last, now, cricEvery(watch, now, pace, pollMinutes)),
    configured: () => key() !== '',
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date, followed: ReadonlySet<string> = new Set()) {
      // 2026-11-21 — `*`: every series on the founder's list (cricSeries.ts).
      if (follow.ref === ALL_CRICKET) {
        const rows: unknown[] = [];
        for (let page = 0; page < MAX_SERIES_PAGES; page += 1) {
          const list = arr(body(await http.json(url('series', { offset: String(page * SERIES_PAGE_ROWS) })))['data']);
          rows.push(...list);
          if (!moreSeries(list, now)) break;
        }
        const out: FeedMatch[] = [];
        for (const s of pickCricSeries(rows, now, followed).slice(0, MAX_SERIES)) {
          try {
            out.push(...seriesMatches(obj(body(await http.json(url('series_info', { id: s.id })))['data']), s.name, now));
          } catch (e) {
            if (e instanceof FeedBudgetSpent) throw e;
            // One series CricAPI can't answer for: the rest still import.
          }
        }
        return out;
      }
      const data = obj(body(await http.json(url('series_info', { id: follow.ref })))['data']);
      return seriesMatches(data, follow.name || str(obj(data['info'])['name']), now);
    },
    async live(watch: ProMatch[], http: FeedHttp, now: Date, pace?: FeedPace) {
      const underWayNow = watch.filter((w) => w.providerRef && started(w, now));
      // 2026-11-21 — a paid plan reads a few matches by id; otherwise the list, page by page.
      const byId = ballByBall && underWayNow.length <= BY_ID_MAX;
      const byRef = byId ? new Map<string | null, unknown>() : await current(http, underWayNow.map((w) => w.providerRef!));
      // Behind today's pace: no hourly scorecards for other matches, no ball by ball.
      const behind = cricBehind(pace, now);
      const step = cricEvery(watch, now, pace, pollMinutes);
      const out: FeedMatch[] = [];
      // 064 — extras cost a call each, so at most one try per half hour until they land.
      const halfHour = now.getUTCMinutes() % 30 < step;
      for (const w of watch) {
        if (!w.providerRef) continue;
        let raw = byRef.get(w.providerRef);
        // Off the list while we had it live: it ended. One call reads the result.
        // 2026-11-21 — and a fixture past its start that no page lists: read it by id, every
        // poll for half an hour, then half-hourly up to 6 hours (a postponed match must not
        // spend the day's calls; the next fixtures import's recover picks up anything later).
        const sinceStart = now.getTime() - w.startsAt.getTime();
        const lookUp =
          w.status === 'live' ||
          w.status === 'break' ||
          (w.status === 'scheduled' && started(w, now) && sinceStart <= EXTRAS_WINDOW_MS && (sinceStart <= FRESH_START_MS || halfHour));
        if (!raw && lookUp) {
          try {
            raw = body(await http.json(url('match_info', { id: w.providerRef }), { reserve: RESERVE }))['data'];
          } catch {
            continue;
          }
        }
        const parsed = raw ? parseCricMatch(raw, null) : null;
        if (!parsed) continue;
        const ended = parsed.live.status === 'finished' && w.status !== 'finished';
        // 2026-11-21 — every live match gets a scorecard; featured ones more often.
        const cardEvery = w.featured ? scorecardMinutes : byId ? otherScorecardMinutes : Math.max(otherScorecardMinutes, PAGED_CARD_MINUTES);
        const cardDue = now.getUTCMinutes() % cardEvery < step;
        const underWay = parsed.live.status === 'live' || parsed.live.status === 'break';
        // Toss and squads: only around the start. Without this a match that never lists them
        // (or one first seen mid-Test) spent two calls every half hour, day and night.
        const nearStart = now.getTime() - w.startsAt.getTime() <= EXTRAS_WINDOW_MS;
        // 2026-11-21 — and an under-way match with no card yet gets one now (at most a try a half
        // hour): "all cricket" brought in NZ v India and a dozen others at stumps, and they had
        // none until play restarted. Play stopping (stumps, innings break) reads one too.
        const firstCard = underWay && !w.scorecard.length && halfHour;
        const paused = w.status === 'live' && parsed.live.status === 'break';
        if (ended || paused || firstCard || (parsed.live.status === 'live' && cardDue && (w.featured || !behind))) {
          const card = await scorecard(http, w.providerRef);
          if (card && card.length) parsed.live.scorecard = card;
        }

        // The toss: currentMatches leaves it out; match_info has it. Once known, keep it.
        const facts = (parsed.live.facts as Fact[] | undefined) ?? [];
        if (!facts.some((f) => f.label === 'Toss')) {
          let toss = w.facts.find((f) => f.label === 'Toss') ?? null;
          if (!toss && underWay && halfHour && nearStart) {
            try {
              toss = cricToss(body(await http.json(url('match_info', { id: w.providerRef }), { reserve: RESERVE }))['data']);
            } catch {
              toss = null;
            }
          }
          if (toss) facts.push(toss);
        }
        if (facts.length) parsed.live.facts = facts;

        // Squads: read once, around the toss.
        const listed = obj(raw)['hasSquad'] !== false;
        if (!w.squads.length && listed && (underWay || parsed.live.status === 'scheduled') && halfHour && nearStart && parsed.home && parsed.away) {
          try {
            const squads = parseCricSquads(body(await http.json(url('match_squad', { id: w.providerRef }), { reserve: RESERVE }))['data'], parsed.home.name, parsed.away.name);
            if (squads.length) parsed.live.squads = squads;
          } catch {
            // Not listed yet: the next half hour tries again.
          }
        }

        // 065 — the worm (Graphs tab): this poll's innings totals, merged into what the match had.
        if (raw && underWay) {
          const merged = mergeProgress(w.progress ?? [], cricProgress(raw));
          if (merged.length) parsed.live.progress = merged;
        }
        // 065 — ball by ball (Overs, Commentary): a paid plan only, featured matches, a call each poll.
        // 2026-11-21 — and only where CricAPI says it has it: most matches (even AUS v ENG
        // T20Is) say bbbEnabled false and answer "Not able to get BBB", a wasted call a minute.
        if (ballByBall && !behind && w.featured && parsed.live.status === 'live' && obj(raw)['bbbEnabled'] === true) {
          try {
            const list = parseCricBalls(body(await http.json(url('match_bbb', { id: w.providerRef }), { reserve: RESERVE }))['data']);
            if (list.length) parsed.live.balls = list.slice(-MAX_BALLS);
          } catch {
            // Not offered for this match, or not on this plan: the tabs stay hidden.
          }
        }
        out.push(parsed);
      }
      return out;
    },
    /**
     * 2026-11-21 — repairs after a fixtures import (cricRecheck), newest first,
     * at most RECHECK_MAX. match_scorecard carries the match state as well as
     * the cards, so one call usually does; match_info only when it says
     * nothing about the state (or has no card yet: a match not played).
     */
    recoverMinutes: ballByBall ? RECOVER_MINUTES : undefined,
    async recover(candidates: ProMatch[], http: FeedHttp, now: Date) {
      const out: FeedMatch[] = [];
      const due = candidates.filter((m) => {
        if (!m.providerRef || !cricRecheck(m, now)) return false;
        const last = tried.get(m.providerRef);
        return last === undefined || now.getTime() - last >= recheckWait(m.startsAt, now);
      });
      for (const w of due.slice(0, ballByBall ? RECHECK_MAX_PAID : RECHECK_MAX_FREE)) {
        tried.set(w.providerRef!, now.getTime());
        try {
          let card: Record<string, unknown> | null = null;
          try {
            card = obj(body(await http.json(url('match_scorecard', { id: w.providerRef! }), { reserve: RESERVE }))['data']);
          } catch (e) {
            if (e instanceof FeedBudgetSpent) throw e;
          }
          const hasState = card !== null && (typeof card['matchEnded'] === 'boolean' || typeof card['matchStarted'] === 'boolean');
          const state = hasState ? card : body(await http.json(url('match_info', { id: w.providerRef! }), { reserve: RESERVE }))['data'];
          const parsed = parseCricMatch(state, null);
          if (!parsed) continue;
          const innings = card ? parseCricScorecard(card) : [];
          if (innings.length && parsed.live.status !== 'scheduled') parsed.live.scorecard = innings;
          out.push(parsed);
        } catch (e) {
          if (e instanceof FeedBudgetSpent) break;
          // One match CricAPI can't answer for: the next import tries again.
        }
      }
      return out;
    },
  };
}
