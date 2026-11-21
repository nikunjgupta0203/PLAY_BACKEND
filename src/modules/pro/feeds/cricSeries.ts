/**
 * 2026-11-21 — "all cricket": one CricAPI follow with ref `*` follows every
 * series whose name is one of the competitions on the founder's list (ICC,
 * bilateral tours, franchise leagues, Indian and overseas domestic, legends),
 * instead of a follow per series that would need a new id every season.
 *
 * The series list (`series`, 25 a page) is newest start first; a fixtures
 * import reads pages until series began more than SERIES_LOOKBACK_DAYS ago
 * (a Ranji or Sheffield Shield season runs four to five months), then reads
 * series_info only for the wanted series that are on now or start within a
 * fortnight. Everything here is pure: the adapter makes the calls.
 */
import { num, obj, str } from './types.js';

/** The follow ref that means "every series on the list". */
export const ALL_CRICKET = '*';
export const SERIES_PAGE_ROWS = 25;
export const MAX_SERIES_PAGES = 16;
export const SERIES_LOOKBACK_DAYS = 200;
/** A fixtures import reads series_info for at most this many series (two calls a day each). */
export const MAX_SERIES = 45;

const DAY = 86_400_000;

/** Competitions by name, as CricAPI spells them (apostrophes are often left out: "Womens"). */
const COMPETITIONS: RegExp[] = [
  // International, ICC and multi-team (1–14)
  /\bICC\b/i,
  /world cup/i,
  /champions trophy/i,
  /world test championship/i,
  /asia cup/i,
  /asian games/i,
  /commonwealth games/i,
  /\bashes\b/i,
  // Associate and other T20I/ODI series, tri-series (21)
  /\bT20Is?\b|\bODIs?\b|tri-?series|triangular|quadrangular/i,
  // Men's and women's franchise leagues (22–41)
  /indian premier league|\bIPL\b/i,
  /big bash/i,
  /pakistan super league|\bPSL\b/i,
  /\bSA20\b/i,
  /international league t20|\bILT20\b/i,
  /caribbean premier league|\bCPL\b/i,
  /the hundred/i,
  /vitality blast|t20 blast/i,
  /major league cricket/i,
  /bangladesh premier league|\bBPL\b/i,
  /lanka premier league|\bLPL\b/i,
  /super smash/i,
  /global t20/i,
  /nepal premier league/i,
  /abu dhabi t10/i,
  /women'?s premier league|\bWPL\b/i,
  // Indian domestic, men (42–49) and women (50–52)
  /ranji trophy/i,
  /vijay hazare/i,
  /syed mushtaq ali/i,
  /duleep trophy/i,
  /irani (cup|trophy)/i,
  /c\.?\s?k\.? nayudu/i,
  /cooch behar/i,
  /vinoo mankad/i,
  /senior women'?s (one[- ]day|t20)/i,
  /women'?s (u|under)[- ]?(19|23)/i,
  // Indian state T20 leagues (53–62)
  /tamil nadu premier league|\bTNPL\b/i,
  /maharaja trophy/i,
  /delhi premier league/i,
  /\bUP T20\b|uttar pradesh t20/i,
  /mumbai t20/i,
  /bengal pro t20/i,
  /saurashtra pro t20/i,
  /\bMP (t20 )?league\b|madhya pradesh (t20 )?league/i,
  /andhra premier league/i,
  /kerala cricket league/i,
  // Other countries' domestic competitions (63–72)
  /sheffield shield/i,
  /marsh (one[- ]day )?cup/i,
  /county championship/i,
  /one[- ]day cup/i,
  /\bCSA\b/i,
  /plunket shield/i,
  /ford trophy/i,
  /quaid[- ]e[- ]azam/i,
  /west indies championship|four[- ]day championship/i,
  // Legends (73–74)
  /championship of legends/i,
  /legends league/i,
];

/** Senior national sides that make a bilateral tour worth following (15–21). */
const NATIONS = [
  'india', 'australia', 'england', 'south africa', 'new zealand', 'pakistan', 'sri lanka', 'bangladesh', 'west indies', 'afghanistan', 'ireland', 'zimbabwe',
  'nepal', 'usa', 'united states', 'netherlands', 'scotland', 'uae', 'united arab emirates', 'oman', 'namibia', 'canada', 'papua new guinea', 'png',
  'hong kong', 'kenya', 'uganda', 'malaysia', 'singapore', 'kuwait', 'bahrain', 'qatar', 'saudi arabia', 'jersey', 'thailand', 'japan', 'italy', 'germany',
];

/** A second XI or youth side: followed only when it is India's (17–18). */
const SECOND_SIDE = /\b(a|lions|u-?19|under[- ]?19|u-?23|xi|emerging|academy|development|shaheens|wolves|invitational)\b/i;

/** "Bangladesh Women tour of England, 2027" → ["bangladesh women", "england"]. Pure. */
function tourSides(name: string): [string, string] | null {
  const m = /^(.+?)\s+(?:tour of|vs\.?|v)\s+(.+?)(?:,.*)?$/i.exec(name.trim());
  if (!m) return null;
  const clean = (s: string) => s.replace(/\b\d{4}(-\d{2,4})?\b/g, '').replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return [clean(m[1]!), clean(m[2]!)];
}

const nation = (side: string) => NATIONS.find((n) => side === n || side.startsWith(`${n} `)) ?? null;

/** Whether a series is on the founder's list, by its name. Pure. */
export function cricSeriesWanted(name: string): boolean {
  if (/sixes\b/i.test(name)) return false;
  const sides = tourSides(name);
  if (sides) {
    const [a, b] = sides;
    // India, any side: men, women, A, U19 (15–18).
    if (nation(a) === 'india' || nation(b) === 'india') return true;
    if (SECOND_SIDE.test(a) || SECOND_SIDE.test(b)) return false;
    // Senior national sides, men or women (19–21): "Western Australia vs England" is a club.
    if (nation(a) && nation(b)) return true;
  }
  return COMPETITIONS.some((re) => re.test(name));
}

/**
 * The series' dates. CricAPI sends startDate as "2026-11-14" and endDate as
 * "Dec 06" (no year: the first such date on or after the start). A start with
 * no year is a stale duplicate row (seen with 0 matches): null. Pure.
 */
export function cricSeriesDates(startRaw: unknown, endRaw: unknown): { start: Date; end: Date } | null {
  const s = str(startRaw);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const start = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  const e = str(endRaw);
  let end = start;
  if (e && /^\d{4}-\d{2}-\d{2}$/.test(e)) end = new Date(`${e}T23:59:59Z`);
  else if (e) {
    const guess = new Date(`${e} ${start.getUTCFullYear()} 23:59:59 UTC`);
    if (!Number.isNaN(guess.getTime())) end = guess < start ? new Date(`${e} ${start.getUTCFullYear() + 1} 23:59:59 UTC`) : guess;
  }
  return { start, end };
}

export interface WantedSeries {
  id: string;
  name: string;
}

/**
 * From series-list rows: the wanted series on now (ended no more than two days
 * ago) or starting within 14 days, with matches, one per name (CricAPI lists
 * some series twice), minus the ids in `skip` (followed one by one already).
 * Pure.
 */
export function pickCricSeries(rows: unknown[], now: Date, skip: ReadonlySet<string> = new Set()): WantedSeries[] {
  const out: WantedSeries[] = [];
  const names = new Set<string>();
  for (const raw of rows) {
    const r = obj(raw);
    const id = str(r['id']);
    const name = str(r['name']);
    if (!id || !name) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // Followed by name already: skip it, and any second listing of it under another id.
    if (skip.has(id)) {
      names.add(key);
      continue;
    }
    if ((num(r['matches']) ?? 0) <= 0) continue;
    const dates = cricSeriesDates(r['startDate'], r['endDate']);
    if (!dates) continue;
    if (dates.start.getTime() > now.getTime() + 14 * DAY || dates.end.getTime() < now.getTime() - 2 * DAY) continue;
    if (names.has(key) || !cricSeriesWanted(name)) continue;
    names.add(key);
    out.push({ id, name });
  }
  return out;
}

/** Whether to read the next page of the series list: the last row still began inside the lookback. Pure. */
export function moreSeries(rows: unknown[], now: Date): boolean {
  if (rows.length < SERIES_PAGE_ROWS) return false;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const dates = cricSeriesDates(obj(rows[i])['startDate'], null);
    if (dates) return dates.start.getTime() >= now.getTime() - SERIES_LOOKBACK_DAYS * DAY;
  }
  return true;
}

