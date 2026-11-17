/**
 * Formula 1 from Jolpica (the Ergast successor; free, no key). Shapes checked
 * against the live API, 2026-11-17. Jolpica has schedules, standings and
 * results, not live timing.
 *
 * A Grand Prix has twenty drivers, and a pro match has two sides: the sides
 * are the championship's top two when the race is imported (the title fight),
 * so a "Who finishes ahead?" question has a natural pair. The full top-10
 * classification goes in the scorecard; the sides' scores are their finishing
 * positions ("P1", "DNF").
 *
 *   · A follow's `ref` is the season ("2026"), or "current".
 *   · Fixtures: the season's races from a day ago to a fortnight ahead.
 *   · Live: a race whose start has passed is "Race on" until its results are
 *     published (usually within hours of the flag), then finished.
 *
 * Match ref: `<season>-<round>`. A driver's ref is their Jolpica driverId.
 */
import type { FeedHttp } from '../../../platform/feeds.js';
import type { Innings, LivePatch, Winner } from '../service/index.js';
import { arr, cut, num, obj, str, type FeedFollow, type FeedMatch, type FeedSide, type ScoreAdapter, type WatchedMatch } from './types.js';

const BASE = 'https://api.jolpi.ca/ergast/f1';
const HORIZON_MS = 14 * 86_400_000;

const driverSide = (d: Record<string, unknown>): FeedSide | null => {
  const id = str(d['driverId']);
  const family = str(d['familyName']);
  if (!id || !family) return null;
  return { ref: id, name: cut([str(d['givenName']), family].filter(Boolean).join(' '), 60)!, code: (str(d['code']) ?? family.slice(0, 3)).toUpperCase() };
};

/** The schedule's races. Pure. */
export function parseF1Races(json: unknown): { season: string; round: string; name: string; startsAt: Date | null; circuit: string | null; city: string | null }[] {
  const races = arr(obj(obj(obj(json)['MRData'])['RaceTable'])['Races']).map(obj);
  return races.flatMap((r) => {
    const season = str(r['season']);
    const round = str(r['round']);
    const name = str(r['raceName']);
    if (!season || !round || !name) return [];
    const date = str(r['date']);
    const time = str(r['time']) ?? '12:00:00Z';
    const at = date ? new Date(`${date}T${time.endsWith('Z') ? time : `${time}Z`}`) : null;
    const circuit = obj(r['Circuit']);
    return [{ season, round, name, startsAt: at && !Number.isNaN(at.getTime()) ? at : null, circuit: str(circuit['circuitName']), city: str(obj(circuit['Location'])['locality']) }];
  });
}

/** The championship's top two drivers. Pure. */
export function parseF1Leaders(json: unknown): FeedSide[] {
  const lists = arr(obj(obj(obj(json)['MRData'])['StandingsTable'])['StandingsLists']).map(obj);
  return arr(lists[0]?.['DriverStandings'])
    .map(obj)
    .slice(0, 2)
    .map((s) => driverSide(obj(s['Driver'])))
    .filter((s): s is FeedSide => s !== null);
}

/** A race's published result → the live patch for the two sides. Pure. */
export function parseF1Result(json: unknown, sides: { home: string | null; away: string | null }): LivePatch | null {
  const race = obj(arr(obj(obj(obj(json)['MRData'])['RaceTable'])['Races'])[0]);
  const results = arr(race['Results']).map(obj);
  if (!results.length) return null;
  const placeOf = (driverId: string | null) => {
    const r = results.find((x) => str(obj(x['Driver'])['driverId']) === driverId);
    if (!r) return { label: null as string | null, n: Number.POSITIVE_INFINITY };
    const classified = /^\d+$/.test(str(r['positionText']) ?? '');
    return { label: classified ? `P${str(r['position'])}` : 'DNF', n: classified ? (num(r['position']) ?? 99) : 99 };
  };
  const h = placeOf(sides.home);
  const a = placeOf(sides.away);
  const winner: Winner | null = h.n < a.n ? 'home' : a.n < h.n ? 'away' : null;
  const top = results.slice(0, 10).map((r) => {
    const d = obj(r['Driver']);
    const name = [str(d['givenName']), str(d['familyName'])].filter(Boolean).join(' ');
    const time = str(obj(r['Time'])['time']) ?? str(r['status']);
    return {
      name: cut(`${str(r['position'])}. ${name}`, 60)!,
      detail: cut([str(obj(r['Constructor'])['name']), time].filter(Boolean).join(' · '), 80),
      cells: [str(r['grid']) ?? '–', str(r['points']) ?? '0'].map((c) => c.slice(0, 10)),
    };
  });
  const first = obj(results[0]!['Driver']);
  const card: Innings = { team: 'Result', title: cut(str(race['raceName']) ?? 'Grand Prix', 40)!, columns: ['Grid', 'Pts'], rows: top, footer: 'Top 10. Points as awarded; results from Jolpica.' };
  return {
    status: 'finished',
    statusDetail: 'Result',
    homeScore: h.label,
    awayScore: a.label,
    winner,
    note: cut(`Winner: ${[str(first['givenName']), str(first['familyName'])].filter(Boolean).join(' ')} (${str(obj(results[0]!['Constructor'])['name']) ?? ''})`, 120),
    scorecard: [card],
  };
}

export function jolpicaAdapter(): ScoreAdapter {
  return {
    provider: 'jolpica',
    sportSlug: 'formula-1',
    pollMinutes: 15,
    configured: () => true,
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const season = /^\d{4}$/.test(follow.ref.trim()) ? follow.ref.trim() : 'current';
      const races = parseF1Races(await http.json(`${BASE}/${season}.json`));
      const soon = races.filter((r) => r.startsAt && r.startsAt.getTime() >= now.getTime() - 86_400_000 && r.startsAt.getTime() <= now.getTime() + HORIZON_MS);
      // The last race already run, with its result, so Results is never empty between races.
      const last = races.filter((r) => r.startsAt && r.startsAt.getTime() < now.getTime() - 86_400_000).at(-1);
      if (!soon.length && !last) return [];
      const [home, away] = parseF1Leaders(await http.json(`${BASE}/${season}/driverStandings.json`));
      if (!home || !away) return [];
      const out: FeedMatch[] = [];
      if (last) {
        const result = parseF1Result(await http.json(`${BASE}/${last.season}/${last.round}/results.json`), { home: home.ref, away: away.ref });
        if (result) {
          out.push({
            ref: `${last.season}-${last.round}`,
            startsAt: last.startsAt,
            league: cut(follow.name || `Formula 1 ${last.season}`, 60),
            stage: cut(`Round ${last.round} · ${last.name}`, 60),
            venueName: cut(last.circuit, 80),
            city: cut(last.city, 60),
            home,
            away,
            live: result,
            moments: [],
          });
        }
      }
      return out.concat(soon.map((r) => ({
        ref: `${r.season}-${r.round}`,
        startsAt: r.startsAt,
        league: cut(follow.name || `Formula 1 ${r.season}`, 60),
        stage: cut(`Round ${r.round} · ${r.name}`, 60),
        venueName: cut(r.circuit, 80),
        city: cut(r.city, 60),
        home,
        away,
        live: { status: 'scheduled' as const },
        moments: [],
      })));
    },
    async live(watch: WatchedMatch[], http: FeedHttp, now: Date) {
      const out: FeedMatch[] = [];
      for (const w of watch) {
        if (!w.providerRef || w.startsAt.getTime() > now.getTime()) continue;
        const [season, round] = w.providerRef.split('-');
        const patch = parseF1Result(await http.json(`${BASE}/${season}/${round}/results.json`), { home: w.homeRef, away: w.awayRef });
        out.push({
          ref: w.providerRef,
          startsAt: null,
          league: null,
          stage: null,
          venueName: null,
          city: null,
          home: null,
          away: null,
          live: patch ?? { status: 'live', statusDetail: 'Race on', note: 'Results within hours of the flag' },
          moments: [],
        });
      }
      return out;
    },
  };
}
