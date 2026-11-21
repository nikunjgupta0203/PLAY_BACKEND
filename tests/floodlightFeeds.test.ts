/**
 * Floodlight live data (migration 060): the feed adapters, the call budget,
 * staff locks, settle suggestions and outside headlines — against a real
 * Postgres, with the providers replaced by a canned fetcher.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createFeedBudget, feedDay, FEED_PROVIDERS, scrubKeys, type FeedBudget, type FeedProvider, type Fetcher } from '../src/platform/feeds.js';
import { CRICKET, FOOTBALL, SNOOKER, seedSport } from '../src/modules/sport/seed.js';
import { createProService, leagueTier, type ProService } from '../src/modules/pro/service/index.js';
import { createFeedRunner, feedPatch, type FeedRunner } from '../src/modules/pro/feeds/runner.js';
import { cricSeriesDates, cricSeriesWanted, moreSeries, pickCricSeries } from '../src/modules/pro/feeds/cricSeries.js';
import { cricapiAdapter, cricBehind, cricCadence, cricEvery, cricPollDue, cricRecheck, recheckWait, cricFacts, cricProgress, mergeProgress, parseCricBalls, inningsTeams, parseCricMatch, parseCricScorecard, parseCricSquads } from '../src/modules/pro/feeds/cricapi.js';
import { apiFootballAdapter, parseFootballFixture } from '../src/modules/pro/feeds/apiFootball.js';
import { parseSnookerMatch, parseSnookerPlayers, parseSnookerRounds, snookerAdapter } from '../src/modules/pro/feeds/snooker.js';
import { codeFor, logoUrl } from '../src/modules/pro/feeds/types.js';
import { createPredictionsService, suggestAnswer, type PredictionsService } from '../src/modules/predictions/service/index.js';
import { createContentService, type ContentService } from '../src/modules/content/service/index.js';
import { createNewsImporter, parseGoogleNews, plainSummary, parseNewsData, parsePexels, parseUnsplash, pickPhoto } from '../src/modules/content/feeds/news.js';

let prisma: PrismaClient;
let db: Db;
let clock: Date;
let football: string;
let cricket: string;
let snooker: string;
let pro: ProService;
let predictions: PredictionsService;
let content: ContentService;
let budget: FeedBudget;
let runner: FeedRunner;
let calls: string[];
let routes: [RegExp, string | (() => string)][];
const limits = Object.fromEntries(FEED_PROVIDERS.map((p) => [p, 100])) as Record<FeedProvider, number>;
const configured = Object.fromEntries(FEED_PROVIDERS.map((p) => [p, true])) as Record<FeedProvider, boolean>;

const fetcher: Fetcher = async (url) => {
  calls.push(url);
  const hit = routes.find(([re]) => re.test(url));
  if (!hit) return { ok: false, status: 404, text: async () => 'not found' };
  const body = typeof hit[1] === 'function' ? hit[1]() : hit[1];
  return { ok: true, status: 200, text: async () => body };
};

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};

// --- canned provider responses -------------------------------------------------------

const cricMatch = (over: Record<string, unknown> = {}) => ({
  id: 'cric-1',
  name: 'India vs Australia, 3rd T20I',
  matchType: 't20',
  status: 'Match starts at 14:00 GMT',
  venue: 'Wankhede Stadium, Mumbai',
  dateTimeGMT: '2026-11-14T13:30:00',
  teams: ['India', 'Australia'],
  teamInfo: [
    { name: 'India', shortname: 'IND' },
    { name: 'Australia', shortname: 'AUS' },
  ],
  score: [],
  matchStarted: false,
  matchEnded: false,
  ...over,
});

const ok = (data: unknown) => JSON.stringify({ status: 'success', data, info: { hitsToday: 3, hitsLimit: 100 } });

const fixture = (over: { status?: string; elapsed?: number | null; goals?: [number | null, number | null]; winner?: [boolean | null, boolean | null]; events?: unknown[]; statistics?: unknown[] } = {}) => ({
  fixture: { id: 9001, date: '2026-11-14T14:00:00+00:00', status: { short: over.status ?? 'NS', long: 'x', elapsed: over.elapsed ?? null }, venue: { name: 'Mumbai Football Arena', city: 'Mumbai' } },
  league: { id: 323, name: 'Indian Super League', round: 'Regular Season - 9' },
  teams: { home: { id: 101, name: 'Mumbai City', winner: over.winner?.[0] ?? null }, away: { id: 202, name: 'Bengaluru FC', winner: over.winner?.[1] ?? null } },
  goals: { home: over.goals?.[0] ?? null, away: over.goals?.[1] ?? null },
  score: { penalty: { home: null, away: null } },
  events: over.events ?? [],
  statistics: over.statistics ?? [],
});

const football200 = (list: unknown[]) => JSON.stringify({ errors: [], results: list.length, response: list });

beforeAll(async () => {
  prisma = (await startTestDb()).prisma;
  db = prisma as unknown as Db;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  clock = new Date('2026-11-14T13:20:00.000Z'); // 18:50 IST, ten minutes before the cricket
  football = await seedSport(prisma, FOOTBALL);
  cricket = await seedSport(prisma, CRICKET);
  snooker = await seedSport(prisma, SNOOKER);
  calls = [];
  routes = [];
  predictions = createPredictionsService({
    db,
    now: () => clock,
    matchSport: async (id) => (await pro.match(id))?.sportId ?? null,
    friendsOf: async () => [],
    communityMembers: async () => [],
    cityPeers: async () => ({ city: null, userIds: [] }),
  });
  pro = createProService({
    db,
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 9 }) },
    now: () => clock,
    finished: async (m) => {
      await predictions.suggestForMatch(m.id, { homeScore: m.homeScore, awayScore: m.awayScore, winner: m.winner });
    },
    abandoned: async (m) => {
      await predictions.voidOpenForMatch(m.id);
    },
  });
  content = createContentService({ db, now: () => clock });
  budget = createFeedBudget({ db, limits: { ...limits }, configured, now: () => clock });
  runner = createFeedRunner({
    db,
    pro,
    budget,
    adapters: [cricapiAdapter(() => 'k-cric', 100), apiFootballAdapter(() => 'k-foot'), snookerAdapter(() => 'pl4y')],
    fetcher,
    now: () => clock,
  });
});

// --- pure parsers ------------------------------------------------------------------------

describe('adapters (pure)', () => {
  it('codes come from names', () => {
    expect(codeFor('Manchester City')).toBe('MCI');
    expect(codeFor('FC Goa')).toBe('GOA');
    expect(codeFor('India')).toBe('IND');
  });

  it('a CricAPI match: live, on a break, finished with a winner, abandoned', () => {
    const live = parseCricMatch(
      cricMatch({ matchStarted: true, status: 'Australia need 41 runs in 34 balls', score: [{ r: 182, w: 4, o: '20', inning: 'India Inning 1' }, { r: 142, w: 3, o: '14.2', inning: 'Australia Inning 1' }] }),
      'India tour',
    )!;
    expect(live.live).toMatchObject({ status: 'live', homeScore: '182/4', awayScore: '142/3', homeDetail: '20 ov', awayDetail: '14.2 ov', statusDetail: '2nd innings', note: 'Australia need 41 runs in 34 balls' });
    expect(live.live.stats).toEqual([{ label: 'Run rate', value: '9.91' }, { label: 'Target', value: '183' }]);
    expect(live.startsAt?.toISOString()).toBe('2026-11-14T13:30:00.000Z');
    expect(live).toMatchObject({ venueName: 'Wankhede Stadium', city: 'Mumbai', stage: '3rd T20I', home: { code: 'IND' }, away: { code: 'AUS' } });

    expect(parseCricMatch(cricMatch({ matchStarted: true, status: 'Innings Break', score: [{ r: 182, w: 10, o: '19.4', inning: 'India Inning 1' }] }), null)!.live).toMatchObject({ status: 'break', homeScore: '182', statusDetail: 'Innings break' });
    expect(parseCricMatch(cricMatch({ matchStarted: true, matchEnded: true, status: 'Australia won by 6 wkts' }), null)!.live).toMatchObject({ status: 'finished', winner: 'away', statusDetail: 'Result' });
    expect(parseCricMatch(cricMatch({ matchStarted: true, matchEnded: true, status: 'Match drawn' }), null)!.live.winner).toBe('draw');
    expect(parseCricMatch(cricMatch({ matchEnded: true, status: 'Match abandoned due to rain' }), null)!.live.status).toBe('abandoned');
    expect(parseCricMatch({ id: 'x', teams: ['Only one'] }, null)).toBeNull();
  });

  it('CricAPI refresh speed follows the plan: free = 10 min, paid (1000+ a day) = every minute', () => {
    expect(cricCadence(100)).toEqual({ pollMinutes: 10, scorecardMinutes: 30, otherScorecardMinutes: 60 });
    expect(cricCadence(2000)).toEqual({ pollMinutes: 1, scorecardMinutes: 5, otherScorecardMinutes: 15 });
    expect(cricapiAdapter(() => 'k', 100).pollMinutes).toBe(10);
    expect(cricapiAdapter(() => 'k', 2000).pollMinutes).toBe(1);
  });

  it('065 — team logos: https badges only, never the CricAPI icon512 placeholder; a staff logo is kept', async () => {
    expect(logoUrl('https://h.cricapi.com/img/teams/9-637877070670541994.webp')).toBe('https://h.cricapi.com/img/teams/9-637877070670541994.webp');
    expect(logoUrl('https://h.cricapi.com/img/icon512.png')).toBeNull();
    expect(logoUrl('http://media.api-sports.io/football/teams/33.png')).toBeNull();
    expect(logoUrl(42)).toBeNull();
    const m = parseCricMatch(cricMatch({ teamInfo: [{ name: 'India', shortname: 'IND', img: 'https://h.cricapi.com/img/teams/ind.webp' }, { name: 'Australia', shortname: 'AUS', img: 'https://h.cricapi.com/img/icon512.png' }] }), null)!;
    expect(m.home).toMatchObject({ code: 'IND', logo: 'https://h.cricapi.com/img/teams/ind.webp' });
    expect(m.away!.logo).toBeNull();

    const made = await pro.feedTeam(cricket, 'cricapi', 'name:india', 'India', 'IND', 'https://x.test/a.png');
    expect(made.logoUrl).toBe('https://x.test/a.png');
    await pro.saveTeam(made.id, { sportId: cricket, name: 'India', shortCode: 'IND', logoUrl: 'https://x.test/staff.png' });
    expect((await pro.feedTeam(cricket, 'cricapi', 'name:india', 'India', 'IND', 'https://x.test/b.png')).logoUrl).toBe('https://x.test/staff.png');
    expect(await codeOf(() => pro.saveTeam(made.id, { sportId: cricket, name: 'India', shortCode: 'IND', logoUrl: 'ftp://nope' }))).toBe('INVALID_PRO_TEAM');
    expect((await pro.saveTeam(made.id, { sportId: cricket, name: 'India', shortCode: 'IND', logoUrl: '' })).logoUrl).toBeNull();
  });

  it('065 — the worm: one point per innings per over; ball by ball parsed defensively', () => {
    const raw = cricMatch({ matchStarted: true, score: [{ r: 182, w: 4, o: '20', inning: 'India Inning 1' }, { r: 42, w: 1, o: '5.2', inning: 'Australia Inning 1' }] });
    expect(cricProgress(raw)).toEqual([
      { inn: 1, team: 'IND', b: 120, r: 182, w: 4 },
      { inn: 2, team: 'AUS', b: 32, r: 42, w: 1 },
    ]);
    // A later reading in the same over replaces the earlier one; a new over adds a point.
    const had = [{ inn: 2, team: 'AUS', b: 31, r: 40, w: 1 }, { inn: 2, team: 'AUS', b: 24, r: 30, w: 1 }];
    expect(mergeProgress(had, [{ inn: 2, team: 'AUS', b: 33, r: 44, w: 1 }])).toEqual([
      { inn: 2, team: 'AUS', b: 24, r: 30, w: 1 },
      { inn: 2, team: 'AUS', b: 33, r: 44, w: 1 },
    ]);
    const balls = parseCricBalls({
      bbb: [
        { n: 2, inning: 0, over: 0, ball: 2, batsman: { name: 'Rohit' }, bowler: { name: 'Starc' }, runs: 4, extras: 0 },
        { n: 1, inning: 0, over: 0, ball: 1, batsman: { name: 'Rohit' }, bowler: { name: 'Starc' }, runs: 0, extras: 1 },
        { n: 3, inning: 0, over: 0, ball: 3, batsman: { name: 'Rohit' }, bowler: { name: 'Starc' }, runs: 0, dismissal: 'caught' },
        { inning: 0, runs: 1 },
      ],
    });
    expect(balls.map((b) => [b.inn, b.over, b.ball, b.runs, b.extras, b.wicket])).toEqual([
      [1, 0, 1, 0, 1, false],
      [1, 0, 2, 4, 0, false],
      [1, 0, 3, 0, 0, true],
    ]);
    expect(balls[1]!.text).toBe('Starc to Rohit, FOUR');
    expect(parseCricBalls(null)).toEqual([]);
  });

  it('a CricAPI fixture whose sides are not known yet (Tbc) is skipped, not imported', () => {
    expect(parseCricMatch(cricMatch({ teams: ['Tbc', 'Tbc'] }), null)).toBeNull();
    expect(parseCricMatch(cricMatch({ teams: ['India', 'TBA'] }), null)).toBeNull();
    expect(parseCricMatch(cricMatch({}), null)).not.toBeNull();
  });

  it('CricAPI\'s "A,B Inning 1" label is the side that did not bat before (real responses, 2026-11-17)', () => {
    // Nagaland made 205/5 and won by 80: the 125/9 is Manipur's, though Nagaland is named first.
    const ngl = parseCricMatch(
      cricMatch({ teams: ['Nagaland', 'Manipur'], matchStarted: true, matchEnded: true, status: 'Nagaland won by 80 runs', score: [{ r: 205, w: 5, o: '20', inning: 'nagaland Inning 1' }, { r: 125, w: 9, o: '20', inning: 'Nagaland,Manipur Inning 1' }] }),
      null,
    )!;
    expect(ngl.live).toMatchObject({ homeScore: '205/5', awayScore: '125/9', winner: 'home' });
    // Same label, chasing side named first: South Africa (350/4) trail Bangladesh (400) by 50.
    const rsa = parseCricMatch(
      cricMatch({ teams: ['South Africa', 'Bangladesh'], matchStarted: true, status: 'Day 3: 1st Session - South Africa trail by 50 runs', score: [{ r: 400, w: 10, o: '101.2', inning: 'bangladesh Inning 1' }, { r: 350, w: 4, o: '82', inning: 'South Africa,Bangladesh Inning 1' }] }),
      null,
    )!;
    expect(rsa.live).toMatchObject({ homeScore: '350/4', awayScore: '400' });
    expect(inningsTeams(['united tigers Inning 1', 'United Tigers,Yas Lions Inning 1'], ['United Tigers', 'Yas Lions'])).toEqual(['united tigers', 'yas lions']);
  });

  it('a CricAPI scorecard fits the scorecard shape, latest innings first', () => {
    const card = parseCricScorecard({
      teams: ['India', 'Australia'],
      teamInfo: [{ name: 'India', shortname: 'IND' }, { name: 'Australia', shortname: 'AUS' }],
      score: [{ r: 182, w: 4, o: '20', inning: 'India Inning 1' }, { r: 100, w: 2, o: '11', inning: 'Australia Inning 1' }],
      scorecard: [
        { inning: 'India Inning 1', batting: [{ batsman: { name: 'R Sharma' }, 'dismissal-text': 'c Smith b Starc', r: 64, b: 38, '4s': 6, '6s': 3, sr: 168.42 }], bowling: [{ bowler: { name: 'M Starc' }, o: 4, m: 0, r: 32, w: 2, eco: 8 }] },
        { inning: 'Australia Inning 1', batting: [{ batsman: { name: 'S Smith' }, r: 40, b: 30, '4s': 4, '6s': 1, sr: 133.33 }], bowling: [] },
      ],
    });
    expect(card.map((c) => `${c.team} ${c.title}`)).toEqual(['AUS Batting', 'IND Bowling', 'IND Batting', 'AUS Bowling']);
    expect(card[2]).toMatchObject({ columns: ['R', 'B', '4s', '6s', 'SR'], rows: [{ name: 'R Sharma', detail: 'c Smith b Starc', cells: ['64', '38', '6', '3', '168.42'] }], footer: 'Total 182/4 (20 ov)' });
  });

  it('an API-Football fixture: minute, stats, goals and cards as moments, the winner', () => {
    const live = parseFootballFixture(
      fixture({
        status: '2H',
        elapsed: 67,
        goals: [2, 1],
        events: [
          { time: { elapsed: 12, extra: null }, team: { name: 'Mumbai City' }, player: { name: 'J. Chhangte' }, assist: { name: 'G. Stewart' }, type: 'Goal', detail: 'Normal Goal' },
          { time: { elapsed: 45, extra: 2 }, team: { name: 'Bengaluru FC' }, player: { name: 'S. Chhetri' }, assist: {}, type: 'Card', detail: 'Yellow Card' },
          { time: { elapsed: 50, extra: null }, team: { name: 'Bengaluru FC' }, player: { name: 'A' }, type: 'subst', detail: 'Substitution 1' },
        ],
        statistics: [
          { team: { id: 101 }, statistics: [{ type: 'Ball Possession', value: '58%' }, { type: 'Total Shots', value: 11 }, { type: 'Corner Kicks', value: 6 }] },
          { team: { id: 202 }, statistics: [{ type: 'Ball Possession', value: '42%' }, { type: 'Total Shots', value: 7 }, { type: 'Corner Kicks', value: 2 }] },
        ],
      }),
      'ISL',
    )!;
    expect(live.live).toMatchObject({ status: 'live', statusDetail: "67'", homeScore: '2', awayScore: '1' });
    expect(live.live.stats).toEqual([
      { label: 'Possession', value: '58–42%' },
      { label: 'Shots', value: '11–7' },
      { label: 'Corners', value: '6–2' },
    ]);
    expect(live.moments.map((m) => [m.atLabel, m.kind, m.title])).toEqual([
      ["12'", 'goal', 'Goal · J. Chhangte'],
      ["45+2'", 'card', 'Yellow card · S. Chhetri'],
    ]);
    expect(live).toMatchObject({ league: 'ISL', stage: 'Regular Season - 9', home: { ref: '101', code: 'MCI' }, away: { ref: '202', code: 'BEN' } });
    expect(parseFootballFixture(fixture({ status: 'HT', goals: [0, 0] }), null)!.live).toMatchObject({ status: 'break', statusDetail: 'Half time' });
    expect(parseFootballFixture(fixture({ status: 'FT', goals: [1, 1] }), null)!.live).toMatchObject({ status: 'finished', winner: 'draw' });
    expect(parseFootballFixture(fixture({ status: 'PEN', goals: [1, 1], winner: [false, true] }), null)!.live.winner).toBe('away');
    expect(parseFootballFixture(fixture({ status: 'ABD' }), null)!.live).toMatchObject({ status: 'abandoned', homeScore: null });
  });

  it('a snooker.org match: players as sides, frames as the score', () => {
    const players = parseSnookerPlayers([{ ID: 1, FirstName: 'Judd', LastName: 'Trump' }, { ID: 2, FirstName: 'Mark', LastName: 'Selby' }]);
    const rounds = parseSnookerRounds([{ Round: 13, RoundName: 'Quarter-finals', Distance: 6 }]);
    const m = { EventID: 1500, Round: 13, Number: 2, Player1ID: 1, Player2ID: 2, Score1: 4, Score2: 3, WinnerID: 0, OnBreak: false, ScheduledDate: '2026-11-14T13:00:00Z', StartDate: '2026-11-14T13:05:00Z', EndDate: '' };
    const live = parseSnookerMatch(m, { players, rounds, league: 'UK Championship', ongoing: true })!;
    expect(live).toMatchObject({ ref: '1500-13-2', stage: 'Quarter-finals', home: { name: 'Judd Trump', code: 'TRU' }, away: { name: 'Mark Selby' } });
    expect(live.live).toMatchObject({ status: 'live', homeScore: '4', awayScore: '3', statusDetail: 'Frame 8', note: 'Best of 11' });
    expect(parseSnookerMatch({ ...m, Score1: 6, WinnerID: 1, EndDate: '2026-11-14T17:00:00Z' }, { players, rounds, league: null, ongoing: false })!.live).toMatchObject({ status: 'finished', winner: 'home' });
    expect(parseSnookerMatch({ ...m, Player2ID: 0 }, { players, rounds, league: null, ongoing: false })).toBeNull();
  });

  it('settle suggestions read the result, never guess', () => {
    const options = [
      { id: 'h', label: 'Mumbai City', detail: null, position: 0, outcome: 'home' as const },
      { id: 'd', label: 'Draw', detail: null, position: 1, outcome: 'draw' as const },
      { id: 'a', label: 'Bengaluru', detail: null, position: 2, outcome: 'away' as const },
    ];
    expect(suggestAnswer({ kind: 'exact_score', options: [] }, { homeScore: '2', awayScore: '1', winner: null })).toEqual({ optionId: null, home: 2, away: 1 });
    expect(suggestAnswer({ kind: 'exact_score', options: [] }, { homeScore: '182/4', awayScore: '180/9', winner: 'home' })).toBeNull();
    expect(suggestAnswer({ kind: 'choice', options }, { homeScore: '1', awayScore: '1', winner: null })).toEqual({ optionId: 'd', home: null, away: null });
    expect(suggestAnswer({ kind: 'choice', options }, { homeScore: '182/4', awayScore: '180/9', winner: 'home' })?.optionId).toBe('h');
    expect(suggestAnswer({ kind: 'choice', options: options.map((o) => ({ ...o, outcome: null })) }, { homeScore: '2', awayScore: '0', winner: 'home' })).toBeNull();
    expect(suggestAnswer({ kind: 'player_pick', options }, { homeScore: '2', awayScore: '0', winner: 'home' })).toBeNull();
  });

  it('news descriptions: NewsData sends one; a Google News description is only the headline again', () => {
    expect(plainSummary('<a href="https://x">India seal the series</a>&nbsp;&nbsp;<font color="#6f6f6f">ESPNcricinfo</font>', 'India seal the series', 'ESPNcricinfo')).toBeNull();
    const d = 'Rohit Sharma&#39;s side won by 7 wickets in Pune to take an unbeatable 2-0 lead, with Jadeja taking five.';
    expect(plainSummary(`<p>${d}</p>`, 'India win', 'TOI')).toBe("Rohit Sharma's side won by 7 wickets in Pune to take an unbeatable 2-0 lead, with Jadeja taking five.");
    expect(plainSummary('x'.repeat(400), 't', null)!.length).toBe(300);
    expect(parseNewsData({ status: 'success', results: [{ title: 'ISL: Mumbai win', link: 'https://example.com/a', description: d, pubDate: '2026-11-14 09:00:00' }] })[0]!.summary).toMatch(/^Rohit Sharma's side/);
  });

  it('headlines: Google News RSS, NewsData, and credited pictures', () => {
    const rss = `<rss><channel><item><title>India seal the series &amp; top the table - ESPNcricinfo</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate><source url="https://www.espncricinfo.com">ESPNcricinfo</source></item><item><title>No link</title></item></channel></rss>`;
    expect(parseGoogleNews(rss)).toEqual([
      { title: 'India seal the series & top the table', url: 'https://news.google.com/rss/articles/abc', sourceName: 'ESPNcricinfo', publishedAt: new Date('2026-11-14T10:00:00Z'), imageUrl: null, summary: null },
    ]);
    expect(parseNewsData({ status: 'success', results: [{ title: 'ISL: Mumbai win', link: 'https://example.com/a', source_name: 'Example', pubDate: '2026-11-14 09:00:00', image_url: 'https://img.example.com/a.jpg' }] })[0]).toMatchObject({
      sourceName: 'Example',
      publishedAt: new Date('2026-11-14T09:00:00Z'),
      imageUrl: 'https://img.example.com/a.jpg',
    });
    expect(() => parseNewsData({ status: 'error', results: { message: 'Invalid key' } })).toThrow(/Invalid key/);
    const u = parseUnsplash({ results: [{ urls: { regular: 'https://images.unsplash.com/p1?ixid=1' }, user: { name: 'Jane Doe', links: { html: 'https://unsplash.com/@jane' } }, links: { download_location: 'https://api.unsplash.com/photos/p1/download' } }] });
    expect(u[0]).toEqual({ url: 'https://images.unsplash.com/p1?ixid=1', credit: 'Photo: Jane Doe on Unsplash', creditUrl: 'https://unsplash.com/@jane?utm_source=pl4y&utm_medium=referral', trackUrl: 'https://api.unsplash.com/photos/p1/download' });
    expect(parsePexels({ photos: [{ src: { large: 'https://images.pexels.com/1.jpg' }, photographer: 'Raj', url: 'https://www.pexels.com/photo/1' }] })[0]!.credit).toBe('Photo: Raj on Pexels');
    expect(pickPhoto(u, 'a')).toBe(pickPhoto(u, 'a'));
    expect(scrubKeys('GET https://x/y?apikey=SECRET&id=1')).toBe('GET https://x/y?apikey=…&id=1');
  });
});

// --- G10: the call budget ----------------------------------------------------------------

describe('call budget', () => {
  it('stops at the limit, keeps the live reserve, and starts again on a new IST day', async () => {
    const small = createFeedBudget({ db, limits: { ...limits, cricapi: 3 }, configured, now: () => clock });
    expect(await small.spend('cricapi', 1)).toBe(true);
    expect(await small.spend('cricapi', 1)).toBe(true);
    // A live poll keeps one call back for tomorrow's fixtures …
    expect(await small.spend('cricapi', 1)).toBe(false);
    // … which the fixtures import may use.
    expect(await small.spend('cricapi')).toBe(true);
    expect(await small.spend('cricapi')).toBe(false);
    const status = (await small.status()).find((s) => s.provider === 'cricapi')!;
    expect(status).toMatchObject({ callsToday: 3, dailyLimit: 3, configured: true });
    clock = new Date('2026-11-14T18:31:00.000Z'); // 00:01 IST the next day
    expect(feedDay(clock)).toBe('2026-11-15');
    expect(await small.spend('cricapi')).toBe(true);
    expect((await small.status()).find((s) => s.provider === 'cricapi')!.callsToday).toBe(1);
  });

  it('a capped provider makes no call and the run says so', async () => {
    const capped = createFeedRunner({
      db,
      pro,
      budget: createFeedBudget({ db, limits: { ...limits, cricapi: 1 }, configured, now: () => clock }),
      adapters: [cricapiAdapter(() => 'k', 100)],
      fetcher,
      now: () => clock,
    });
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ info: { name: 'Series' }, matchList: [cricMatch()] })]];
    await capped.importFixtures();
    calls = [];
    const runs = await capped.pollLive();
    expect(calls).toEqual([]);
    expect(runs[0]!.errors[0]).toMatch(/limit is reached/);
  });
});

// --- G1: importing and polling -----------------------------------------------------------

describe('feed runner', () => {
  it('imports fixtures once, claiming teams staff already made', async () => {
    const india = await pro.saveTeam(null, { sportId: cricket, name: 'India', shortCode: 'IND' });
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ info: { name: 'Australia tour of India' }, matchList: [cricMatch(), cricMatch({ id: 'cric-far', dateTimeGMT: '2027-03-01T10:00:00' })] })]];
    const first = await runner.importFixtures();
    expect(first.find((r) => r.provider === 'cricapi')).toMatchObject({ created: 1, errors: [] });
    expect(first.find((r) => r.provider === 'api_football')!.skipped).toBe('nothing followed');
    const again = await runner.importFixtures();
    expect(again.find((r) => r.provider === 'cricapi')).toMatchObject({ created: 0, unchanged: 1 });
    const [m] = await prisma.proMatch.findMany();
    expect(m).toMatchObject({ provider: 'cricapi', providerRef: 'cric-1', league: 'India tour', homeTeamId: india.id, status: 'scheduled' });
    expect(await prisma.proTeam.findUnique({ where: { id: india.id } })).toMatchObject({ provider: 'cricapi', providerRef: 'name:india' });
    expect(calls.every((c) => c.includes('apikey=k-cric'))).toBe(true);
    expect((await runner.follows())[0]!.lastImportAt).not.toBeNull();
  });

  it('polls a live match, respects staff locks, and only when due', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    const id = (await prisma.proMatch.findFirstOrThrow()).id;

    let score = [{ r: 45, w: 1, o: '5.2', inning: 'India Inning 1' }];
    routes = [[/currentMatches/, () => ok([cricMatch({ matchStarted: true, status: 'India opt to bat', score })])]];
    await runner.pollLive();
    expect(await pro.match(id)).toMatchObject({ status: 'live', homeScore: '45/1', homeDetail: '5.2 ov', feedLocked: [] });

    // Staff correct the note by hand: the feed leaves it alone from now on.
    await pro.updateMatch(id, { note: 'Rohit retired hurt', homeScore: '45/1' });
    expect((await pro.match(id))!.feedLocked).toEqual(['note']);

    clock = new Date(clock.getTime() + 2 * 60_000);
    score = [{ r: 60, w: 1, o: '7', inning: 'India Inning 1' }];
    expect((await runner.pollLive()).find((r) => r.provider === 'cricapi')!.skipped).toBe('not due yet');

    // The free plan polls every 10 minutes (cricCadence).
    clock = new Date(clock.getTime() + 9 * 60_000);
    await runner.pollLive();
    expect(await pro.match(id)).toMatchObject({ homeScore: '60/1', note: 'Rohit retired hurt' });

    // A quiet poll writes nothing but the check time (G9).
    clock = new Date(clock.getTime() + 11 * 60_000);
    const before = (await pro.match(id))!;
    await runner.pollLive();
    const after = (await pro.match(id))!;
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.feedCheckedAt).toEqual(clock);

    // Handed back, the feed writes it again.
    await pro.releaseFeed(id);
    clock = new Date(clock.getTime() + 11 * 60_000);
    await runner.pollLive();
    expect((await pro.match(id))!.note).toBe('India opt to bat');
  });

  it('064 — Info and Squads: format from the fixture, the toss and squads read once each', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    const id = (await prisma.proMatch.findFirstOrThrow()).id;
    expect((await pro.match(id))!.facts).toEqual([{ label: 'Format', value: 'T20' }]);

    clock = new Date('2026-11-14T13:31:00.000Z'); // a half hour: the extras are due
    const live = () => ok([cricMatch({ matchStarted: true, status: 'India opt to bat', score: [{ r: 12, w: 0, o: '1.4', inning: 'India Inning 1' }] })]);
    const squad = (team: string, names: string[]) => ({ teamName: team, shortname: team.slice(0, 3).toUpperCase(), players: names.map((name) => ({ name, role: 'Batsman' })) });
    routes = [
      [/currentMatches/, live],
      [/match_info/, ok(cricMatch({ matchStarted: true, tossWinner: 'india', tossChoice: 'batting' }))],
      // The feed lists the away side first: Squads still lead with the home side.
      [/match_squad/, ok([squad('Australia', ['S Smith']), squad('India', ['R Sharma', 'V Kohli'])])],
    ];
    calls = [];
    await runner.pollLive();
    const m = (await pro.match(id))!;
    expect(m.facts).toEqual([
      { label: 'Format', value: 'T20' },
      { label: 'Toss', value: 'India, chose to bat' },
    ]);
    expect(m.squads.map((s) => `${s.team}:${s.players.length}`)).toEqual(['India:2', 'Australia:1']);
    expect(m.squads[0]!.players[0]).toEqual({ name: 'R Sharma', role: 'Batsman' });

    // The next half hour: the toss is kept without asking again, the squads are not read twice.
    clock = new Date('2026-11-14T14:01:00.000Z');
    calls = [];
    await runner.pollLive();
    expect(calls.some((c) => /match_info|match_squad/.test(c))).toBe(false);
    expect((await pro.match(id))!.facts.map((f) => f.label)).toEqual(['Format', 'Toss']);
  });

  it('064 — a match CricAPI has no squad for is not asked about', async () => {
    expect(parseCricSquads([{ teamName: 'India', players: [] }], 'India', 'Australia')).toEqual([]);
    expect(cricFacts({ matchType: 'odi', tossWinner: 'Australia', tossChoice: 'bowl' })).toEqual([
      { label: 'Format', value: 'ODI' },
      { label: 'Toss', value: 'Australia, chose to bowl' },
    ]);
    expect(cricFacts({ matchType: 'hundred' })).toEqual([]);
  });

  it('a fixtures import never touches a match under way (feeds R6)', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    const id = (await prisma.proMatch.findFirstOrThrow()).id;
    routes = [[/currentMatches/, ok([cricMatch({ matchStarted: true, status: 'India opt to bat', score: [{ r: 45, w: 1, o: '5.2', inning: 'India Inning 1' }] })])]];
    await runner.pollLive();
    // The series list says "started" but carries no scores.
    routes = [[/series_info/, ok({ matchList: [cricMatch({ matchStarted: true, venue: 'Wankhede Stadium, Mumbai' })] })]];
    const runs = await runner.importFixtures();
    expect(runs.find((r) => r.provider === 'cricapi')).toMatchObject({ unchanged: 1, errors: [] });
    expect(await pro.match(id)).toMatchObject({ status: 'live', homeScore: '45/1' });

    // A fixture still to come does take a new time, or a call-off.
    routes = [[/series_info/, ok({ matchList: [cricMatch(), cricMatch({ id: 'cric-2', teams: ['Sri Lanka', 'Australia'], dateTimeGMT: '2026-11-16T09:00:00' })] })]];
    await runner.importFixtures();
    routes = [[/series_info/, ok({ matchList: [cricMatch({ id: 'cric-2', teams: ['Sri Lanka', 'Australia'], dateTimeGMT: '2026-11-17T09:00:00' })] })]];
    await runner.importFixtures();
    expect((await pro.matchByProvider('cricapi', 'cric-2'))!.startsAt.toISOString()).toBe('2026-11-17T09:00:00.000Z');
  });

  it('football: moments once, then the result suggests the answers', async () => {
    await runner.saveFollow(null, { provider: 'api_football', ref: '323', season: '2026', sportId: football, name: 'ISL' });
    // Free plan (real key, 2026-11-17): no season=, no ids=; date= is yesterday (results), today and tomorrow, shared by follows.
    routes = [[/fixtures\?date=2026-11-13/, football200([])], [/fixtures\?date=2026-11-14/, football200([fixture(), { ...fixture(), league: { id: 999, name: 'Other league' }, fixture: { ...fixture().fixture, id: 9002 } }])], [/fixtures\?date=2026-11-15/, football200([])]];
    await runner.importFixtures();
    expect(calls).toEqual([expect.stringMatching(/fixtures\?date=2026-11-13&timezone=UTC/), expect.stringMatching(/fixtures\?date=2026-11-14&timezone=UTC/), expect.stringMatching(/fixtures\?date=2026-11-15&timezone=UTC/)]);
    expect(await prisma.proMatch.count()).toBe(1); // only the followed league
    const m = (await prisma.proMatch.findFirstOrThrow({ include: { homeTeam: true } }));
    expect(m.homeTeam).toMatchObject({ name: 'Mumbai City', shortCode: 'MCI', provider: 'api_football', providerRef: '101' });

    const winner = await predictions.createQuestion(null, {
      matchId: m.id,
      kind: 'choice',
      prompt: 'Who wins?',
      locksAt: new Date('2026-11-14T14:00:00Z'),
      options: [{ label: 'Mumbai City', outcome: 'home' }, { label: 'Draw', outcome: 'draw' }, { label: 'Bengaluru FC', outcome: 'away' }],
    });
    const exact = await predictions.createQuestion(null, { matchId: m.id, kind: 'exact_score', prompt: 'Final score?', locksAt: new Date('2026-11-14T14:00:00Z') });

    const goal = { time: { elapsed: 12, extra: null }, team: { name: 'Mumbai City' }, player: { name: 'J. Chhangte' }, assist: {}, type: 'Goal', detail: 'Normal Goal' };
    routes = [[/fixtures\?live=all/, football200([fixture({ status: '1H', elapsed: 20, goals: [1, 0], events: [goal] })])]];
    clock = new Date('2026-11-14T13:55:00Z');
    await runner.pollLive();
    clock = new Date('2026-11-14T13:59:00Z');
    await runner.pollLive();
    expect(await prisma.proMatchMoment.count({ where: { matchId: m.id } })).toBe(1);

    // Full time: gone from the live list; its day's list has the result.
    routes = [[/fixtures\?live=all/, football200([])], [/fixtures\?date=2026-11-14/, football200([fixture({ status: 'FT', goals: [2, 1], winner: [true, false], events: [goal] })])]];
    clock = new Date('2026-11-14T16:00:00Z');
    await runner.pollLive();
    expect(await pro.match(m.id)).toMatchObject({ status: 'finished', winner: 'home', homeScore: '2', awayScore: '1' });
    const w = (await predictions.question(winner.id))!;
    expect(w.suggestedOptionId).toBe(w.options.find((o) => o.outcome === 'home')!.id);
    expect(w.status).toBe('open'); // staff confirm: nothing settles on its own
    expect(await predictions.question(exact.id)).toMatchObject({ suggestedHome: 2, suggestedAway: 1 });

    // Finished: no longer polled.
    calls = [];
    clock = new Date('2026-11-14T16:10:00Z');
    expect((await runner.pollLive()).find((r) => r.provider === 'api_football')!.skipped).toBe('nothing live or about to start');
    expect(calls).toEqual([]);
  });

  it('an abandoned match voids its open questions (predictions R9)', async () => {
    await runner.saveFollow(null, { provider: 'api_football', ref: '323', season: '2026', sportId: football, name: 'ISL' });
    routes = [[/fixtures\?date=/, football200([fixture()])]];
    await runner.importFixtures();
    const m = await prisma.proMatch.findFirstOrThrow();
    const q = await predictions.createQuestion(null, { matchId: m.id, kind: 'exact_score', prompt: 'Final score?', locksAt: new Date('2026-11-14T14:00:00Z') });
    routes = [[/fixtures\?live=all/, football200([fixture({ status: 'ABD' })])]];
    clock = new Date('2026-11-14T13:55:00Z');
    await runner.pollLive();
    expect((await predictions.question(q.id))!.status).toBe('void');
  });

  it('snooker: players become sides; a provider error is recorded, never thrown', async () => {
    await runner.saveFollow(null, { provider: 'snooker_org', ref: '1500', sportId: snooker, name: 'UK Championship' });
    routes = [
      [/t=9&e=1500/, JSON.stringify([{ ID: 1, FirstName: 'Judd', LastName: 'Trump' }, { ID: 2, FirstName: 'Mark', LastName: 'Selby' }])],
      [/t=12&e=1500/, JSON.stringify([{ Round: 13, RoundName: 'Quarter-finals', Distance: 6 }])],
      [/t=6&e=1500/, JSON.stringify([{ EventID: 1500, Round: 13, Number: 2, Player1ID: 1, Player2ID: 2, Score1: 0, Score2: 0, WinnerID: 0, ScheduledDate: '2026-11-14T13:30:00Z' }])],
    ];
    const runs = await runner.importFixtures();
    expect(runs.find((r) => r.provider === 'snooker_org')).toMatchObject({ created: 1 });
    expect((await prisma.proMatch.findFirstOrThrow({ include: { homeTeam: true } }))).toMatchObject({ stage: 'Quarter-finals', homeTeam: { name: 'Judd Trump', shortCode: 'TRU' } });

    routes = []; // ?t=7 now fails with a 404
    const poll = await runner.pollLive();
    expect(poll.find((r) => r.provider === 'snooker_org')!.errors[0]).toMatch(/HTTP 404/);
    expect((await budget.status()).find((s) => s.provider === 'snooker_org')!.lastError).toMatch(/HTTP 404/);
  });

  it('follows are checked', async () => {
    expect(await codeOf(() => runner.saveFollow(null, { provider: 'api_football', ref: '323', sportId: football, name: 'ISL' }))).toBe('INVALID_FEED_FOLLOW');
    await runner.saveFollow(null, { provider: 'cricapi', ref: 's', sportId: cricket, name: 'IPL' });
    expect(await codeOf(() => runner.saveFollow(null, { provider: 'cricapi', ref: 's', sportId: cricket, name: 'IPL again' }))).toBe('INVALID_FEED_FOLLOW');
  });

  it('feedPatch sends only what changed and never a locked field', async () => {
    const t1 = await pro.saveTeam(null, { sportId: football, name: 'A', shortCode: 'A' });
    const t2 = await pro.saveTeam(null, { sportId: football, name: 'B', shortCode: 'B' });
    const m = await pro.createMatch(null, { sportId: football, league: 'L', homeTeamId: t1.id, awayTeamId: t2.id, startsAt: clock, provider: 'api_football', providerRef: 'r' });
    const patch = feedPatch({ ...m, homeScore: '1', feedLocked: ['awayScore'] }, { ref: 'r', startsAt: clock, league: null, stage: null, venueName: null, city: null, home: null, away: null, live: { homeScore: '1', awayScore: '3', status: 'live' }, moments: [] });
    expect(patch).toEqual({ status: 'live' });
  });
});

// --- G3: outcomes on options --------------------------------------------------------------

describe('prediction outcomes', () => {
  it('only a choice question on a match can tie options to the result, one each', async () => {
    const t1 = await pro.saveTeam(null, { sportId: football, name: 'A', shortCode: 'A' });
    const t2 = await pro.saveTeam(null, { sportId: football, name: 'B', shortCode: 'B' });
    const m = await pro.createMatch(null, { sportId: football, league: 'L', homeTeamId: t1.id, awayTeamId: t2.id, startsAt: new Date(clock.getTime() + 3_600_000) });
    const at = new Date(clock.getTime() + 3_600_000);
    expect(
      await codeOf(() => predictions.createQuestion(null, { sportId: football, kind: 'choice', prompt: 'Who?', locksAt: at, options: [{ label: 'A', outcome: 'home' }, { label: 'B' }] })),
    ).toBe('INVALID_QUESTION');
    expect(
      await codeOf(() => predictions.createQuestion(null, { matchId: m.id, kind: 'choice', prompt: 'Who?', locksAt: at, options: [{ label: 'A', outcome: 'home' }, { label: 'B', outcome: 'home' }] })),
    ).toBe('INVALID_QUESTION');
    const q = await predictions.createQuestion(null, { matchId: m.id, kind: 'choice', prompt: 'Who?', locksAt: at, options: [{ label: 'A', outcome: 'home' }, { label: 'B', outcome: 'away' }] });
    expect(q.options.map((o) => o.outcome)).toEqual(['home', 'away']);

    // Staff finish a manual match: suggestions come from the same hook.
    await pro.updateMatch(m.id, { status: 'finished', homeScore: '0', awayScore: '2' });
    expect((await predictions.question(q.id))!.suggestedOptionId).toBe(q.options[1]!.id);
    // A corrected score re-suggests.
    await pro.updateMatch(m.id, { homeScore: '3' });
    expect((await predictions.question(q.id))!.suggestedOptionId).toBe(q.options[0]!.id);
    // Manual matches never lock.
    expect((await pro.match(m.id))!.feedLocked).toEqual([]);
  });
});

// --- G6: outside headlines ------------------------------------------------------------------

describe('headlines', () => {
  it('imports once per address, credits fallback pictures, shows in Trending, archives after 14 days', async () => {
    await runner.saveFollow(null, { provider: 'google_news', ref: 'cricket india', sportId: cricket, name: 'Cricket' });
    const rss = (n: number) =>
      `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>Headline ${i} - Cricbuzz</title><link>https://news.google.com/rss/articles/${i}</link><pubDate>Sat, 14 Nov 2026 1${i}:00:00 GMT</pubDate><source url="https://cricbuzz.com">Cricbuzz</source></item>`).join('')}</channel></rss>`;
    routes = [
      [/news\.google\.com\/rss\/search\?q=cricket\+india/, rss(2)],
      [/api\.unsplash\.com\/search\/photos\?query=Cricket/, JSON.stringify({ results: [{ urls: { regular: 'https://images.unsplash.com/c1' }, user: { name: 'Jane', links: { html: 'https://unsplash.com/@jane' } }, links: { download_location: 'https://api.unsplash.com/photos/c1/download' } }] })],
      [/api\.unsplash\.com\/photos\/c1\/download/, '{}'],
    ];
    const news = createNewsImporter({
      content,
      budget,
      follows: async () => (await runner.follows()).filter((f) => f.provider === 'google_news') as never,
      sportName: async () => 'Cricket',
      recordFollow: async () => undefined,
      keys: { rss: true, newsdata: '', unsplash: 'u-key', pexels: '' },
      fetcher,
    });
    expect(await news.run()).toMatchObject({ imported: 2, errors: [] });
    expect(calls.filter((c) => c.includes('/search/photos'))).toHaveLength(1);
    routes[0] = [/news\.google\.com/, rss(3)];
    expect((await news.run()).imported).toBe(1);

    const links = await prisma.contentItem.findMany({ where: { kind: 'link' }, orderBy: { publishedAt: 'desc' } });
    expect(links).toHaveLength(3);
    expect(links[0]).toMatchObject({ status: 'published', title: 'Headline 2', sourceName: 'Cricbuzz', body: null, imageUrl: 'https://images.unsplash.com/c1', imageCredit: 'Photo: Jane on Unsplash' });

    // Trending mixes PL4Y's stories (featured first) and outside links.
    const story = await content.save(null, null, { kind: 'story', title: 'Our story', featured: true });
    await content.setStatus(story.id, 'published');
    const shelf = await content.homeShelf(null);
    expect(shelf.stories.map((s) => s.kind)).toEqual(['story', 'link', 'link', 'link']);

    clock = new Date(clock.getTime() + 15 * 86_400_000);
    routes[0] = [/news\.google\.com/, rss(0)];
    expect((await news.run()).archived).toBe(3);
  });

  it('a link needs its source and carries no body', async () => {
    expect(await codeOf(() => content.save(null, null, { kind: 'link', title: 'Headline' }))).toBe('INVALID_CONTENT');
    expect(await codeOf(() => content.save(null, null, { kind: 'link', title: 'H', sourceName: 'X', sourceUrl: 'https://x.com/a', body: 'copied text' }))).toBe('INVALID_CONTENT');
    const item = await content.save(null, null, { kind: 'link', title: 'H', sourceName: 'X', sourceUrl: 'https://x.com/a' });
    expect(item).toMatchObject({ kind: 'link', sourceUrl: 'https://x.com/a', sourceName: 'X' });
  });

  it('the database refuses a link without a source', async () => {
    await expect(prisma.contentItem.create({ data: { id: newId(), kind: 'link', title: 'x' } })).rejects.toThrow(/content_items_link_check/);
  });
});

describe('watch sports (founder list, 2026-11-17)', () => {
  it('are the 11 sports, each with a seed entry and a row the migrations create or the seed always had', async () => {
    const { WATCH_SPORT_SLUGS } = await import('../src/modules/pro/watchSports.js');
    const { LAUNCH_SPORTS } = await import('../src/modules/sport/seed.js');
    const { readFileSync, readdirSync } = await import('node:fs');
    expect(WATCH_SPORT_SLUGS).toHaveLength(11);
    const seeded = new Set(LAUNCH_SPORTS.map((s) => s.slug));
    expect(WATCH_SPORT_SLUGS.filter((s) => !seeded.has(s))).toEqual([]);
    // Production never runs the seed: the sports added for watching must come with a migration.
    const dir = readdirSync('prisma/migrations').find((d) => d.endsWith('_061_watch_sports'))!;
    const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8');
    for (const slug of ['american-football', 'baseball', 'ice-hockey', 'rugby', 'formula-1']) expect(sql).toContain(`'${slug}'`);
  });
});

describe('CricAPI call budget at stumps + late logos (2026-11-20)', () => {
  // The free plan's 90 calls ran out at 12:32 IST on day 5 of SA v BAN: a Test at stumps
  // was polled every 10 minutes all night, with the toss and squads asked every half hour.
  const start = new Date('2026-11-15T07:30:00.000Z');
  const at = (iso: string) => new Date(iso);
  const stumps = { status: 'break' as const, statusDetail: 'Stumps', startsAt: start };

  it('at stumps polls hourly, but every 10 min around the hour play began; live keeps 10 min', () => {
    const last = at('2026-11-19T20:00:00.000Z');
    expect(cricPollDue([stumps], last, at('2026-11-19T20:11:00.000Z'), 10)).toBe(false);
    expect(cricPollDue([stumps], last, at('2026-11-19T21:00:00.000Z'), 10)).toBe(true);
    // 07:15–08:15 UTC is near the daily start (07:30): back to 10 minutes.
    expect(cricPollDue([stumps], at('2026-11-20T07:10:00.000Z'), at('2026-11-20T07:20:00.000Z'), 10)).toBe(true);
    expect(cricPollDue([stumps], at('2026-11-20T08:00:00.000Z'), at('2026-11-20T08:10:00.000Z'), 10)).toBe(true);
    // Lunch, tea, rain or live play: the plain cadence.
    expect(cricPollDue([{ ...stumps, statusDetail: 'Lunch' }], last, at('2026-11-19T20:10:00.000Z'), 10)).toBe(true);
    expect(cricPollDue([stumps, { ...stumps, status: 'live', statusDetail: '1st innings' }], last, at('2026-11-19T20:10:00.000Z'), 10)).toBe(true);
    // A paid plan waits 15 minutes at stumps; a first poll is always due.
    expect(cricPollDue([stumps], last, at('2026-11-19T20:14:00.000Z'), 1)).toBe(false);
    expect(cricPollDue([stumps], last, at('2026-11-19T20:15:00.000Z'), 1)).toBe(true);
    expect(cricPollDue([stumps], null, at('2026-11-19T20:01:00.000Z'), 10)).toBe(true);
  });

  it('a whole day of a Test at stumps overnight fits the free plan', () => {
    // Stumps 15:30 UTC → play 07:30 UTC next day, then a day's play to stumps again.
    let last: Date | null = null;
    let polls = 0;
    for (let t = at('2026-11-18T18:30:00.000Z').getTime(); t < at('2026-11-19T18:30:00.000Z').getTime(); t += 60_000) {
      const now = new Date(t);
      const live = now >= at('2026-11-19T07:30:00.000Z') && now < at('2026-11-19T15:30:00.000Z');
      if (cricPollDue([live ? { ...stumps, status: 'live', statusDetail: '3rd innings' } : stumps], last, now, 10)) {
        polls += 1;
        last = now;
      }
    }
    // ~48 polls of play + ~16 overnight, leaving room for scorecards and fixtures inside 90.
    expect(polls).toBeLessThanOrEqual(66);
  });

  it('a Test first seen mid-match never asks for the toss or squads', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'SA v BAN' });
    clock = at('2026-11-19T09:31:00.000Z');
    const test = (over: Record<string, unknown>) => cricMatch({ matchType: 'test', dateTimeGMT: '2026-11-15T07:30:00', teams: ['South Africa', 'Bangladesh'], teamInfo: [], ...over });
    routes = [[/series_info/, ok({ matchList: [test({ matchStarted: true, status: 'Day 5: 1st Session', score: [{ r: 557, w: 10, o: '150', inning: 'South Africa Inning 1' }] })] })]];
    await runner.importFixtures();
    routes = [
      [/currentMatches/, ok([test({ matchStarted: true, status: 'Day 5: 1st Session', score: [{ r: 557, w: 10, o: '150', inning: 'South Africa Inning 1' }] })])],
      [/match_info/, ok(test({ matchStarted: true }))],
      [/match_squad/, ok([])],
    ];
    calls = [];
    await runner.pollLive();
    expect(calls.filter((c) => /currentMatches/.test(c))).toHaveLength(1);
    expect(calls.some((c) => /match_info|match_squad/.test(c))).toBe(false);
  });

  it('a fixtures import fills badges on teams of matches made before 065, never over a staff logo', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    const m = await prisma.proMatch.findFirstOrThrow();
    expect((await prisma.proTeam.findUniqueOrThrow({ where: { id: m.homeTeamId } })).logoUrl).toBeNull();
    await prisma.proTeam.update({ where: { id: m.awayTeamId }, data: { logoUrl: 'https://x.test/staff.png' } });

    const badges = [
      { name: 'India', shortname: 'IND', img: 'https://h.cricapi.com/img/teams/ind.webp' },
      { name: 'Australia', shortname: 'AUS', img: 'https://h.cricapi.com/img/teams/aus.webp' },
    ];
    routes = [[/series_info/, ok({ matchList: [cricMatch({ teamInfo: badges })] })]];
    await runner.importFixtures();
    expect((await prisma.proTeam.findUniqueOrThrow({ where: { id: m.homeTeamId } })).logoUrl).toBe('https://h.cricapi.com/img/teams/ind.webp');
    expect((await prisma.proTeam.findUniqueOrThrow({ where: { id: m.awayTeamId } })).logoUrl).toBe('https://x.test/staff.png');
  });
});

describe('CricAPI matches the poll missed (2026-11-21)', () => {
  // Prod, 21 Nov: two WBBL matches (01:00 and 04:30 UTC) were still "scheduled" at 11:09 UTC.
  // The poll read only page 1 of currentMatches and never looked a missing fixture up by id.
  const follow = () => runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
  const page = (data: unknown[], totalRows: number) => JSON.stringify({ status: 'success', data, info: { offsetRows: 0, totalRows } });
  const other = (i: number) => cricMatch({ id: `other-${i}`, teams: [`Side ${i}`, `Team ${i}`], matchStarted: true, status: 'In progress' });
  const card = (innings: number) => ({
    ...cricMatch({
      matchStarted: true,
      matchEnded: true,
      status: 'Australia won by 6 wkts',
      score: [
        { r: 150, w: 7, o: '20', inning: 'India Inning 1' },
        { r: 151, w: 4, o: '18.2', inning: 'Australia Inning 1' },
      ],
    }),
    scorecard: ['India Inning 1', 'Australia Inning 1'].slice(0, innings).map((inning) => ({
      inning,
      batting: [{ batsman: { name: 'A Batter' }, r: 50, b: 30 }],
      bowling: [{ bowler: { name: 'A Bowler' }, o: 4, r: 30, w: 2 }],
    })),
  });

  it('reads the next page of currentMatches when a started match is not on the first', async () => {
    await follow();
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    clock = new Date('2026-11-14T13:41:00.000Z');
    const first = Array.from({ length: 25 }, (_, i) => other(i));
    const live = cricMatch({ matchStarted: true, status: 'India opt to bat', score: [{ r: 30, w: 0, o: '3', inning: 'India Inning 1' }] });
    routes = [
      [/currentMatches.*offset=0/, page(first, 26)],
      [/currentMatches.*offset=25/, page([live], 26)],
    ];
    calls = [];
    await runner.pollLive();
    expect(calls.filter((c) => /currentMatches/.test(c))).toHaveLength(2);
    expect(await pro.matchByProvider('cricapi', 'cric-1')).toMatchObject({ status: 'live', homeScore: '30/0' });

    // Back on page 1: one call does.
    clock = new Date('2026-11-14T13:52:00.000Z');
    routes = [[/currentMatches/, page([live, ...first.slice(0, 24)], 26)]];
    calls = [];
    await runner.pollLive();
    expect(calls.filter((c) => /currentMatches/.test(c))).toHaveLength(1);
  });

  it('a fixture past its start on no page is read by id: it ends, with its scorecard', async () => {
    await follow();
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    // Before the start a missing fixture is not looked up.
    routes = [[/currentMatches/, page([other(1)], 1)]];
    calls = [];
    await runner.pollLive();
    expect(calls.some((c) => /match_info/.test(c))).toBe(false);

    clock = new Date('2026-11-14T17:01:00.000Z');
    routes = [
      [/currentMatches/, page([other(1)], 1)],
      [/match_info/, ok(card(2))],
      [/match_scorecard/, ok(card(2))],
    ];
    await runner.pollLive();
    const m = (await pro.matchByProvider('cricapi', 'cric-1'))!;
    expect(m).toMatchObject({ status: 'finished', winner: 'away', homeScore: '150/7', awayScore: '151/4' });
    expect(m.scorecard.filter((t) => /^Batting/.test(t.title))).toHaveLength(2);
  });

  it('a live match that is not featured gets its scorecard on the hour', async () => {
    await follow();
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await runner.importFixtures();
    const live = ok([cricMatch({ matchStarted: true, status: 'India opt to bat', score: [{ r: 30, w: 0, o: '3', inning: 'India Inning 1' }] })]);
    routes = [
      [/currentMatches/, live],
      [/match_scorecard/, ok(card(1))],
      [/match_info|match_squad/, ok(cricMatch({ matchStarted: true }))],
    ];
    clock = new Date('2026-11-14T13:41:00.000Z');
    calls = [];
    await runner.pollLive();
    expect(calls.some((c) => /match_scorecard/.test(c))).toBe(false);
    clock = new Date('2026-11-14T14:01:00.000Z');
    await runner.pollLive();
    expect(calls.filter((c) => /match_scorecard/.test(c))).toHaveLength(1);
    expect((await pro.matchByProvider('cricapi', 'cric-1'))!.scorecard.length).toBeGreaterThan(0);
  });

  it('what to re-check: stuck fixtures, blank results, short scorecards; never a complete one', () => {
    const now = new Date('2026-11-21T12:30:00.000Z');
    const cards = (n: number) => Array.from({ length: n }, () => ({ title: 'Batting', team: 'X', columns: [], rows: [], footer: null }));
    const base = { status: 'finished' as const, startsAt: new Date('2026-11-19T08:10:00.000Z'), homeScore: '225/3' as string | null, awayScore: '226/4' as string | null, scorecard: cards(0) };
    expect(cricRecheck({ ...base, status: 'scheduled', startsAt: new Date('2026-11-21T01:00:00.000Z') }, now)).toBe(true);
    expect(cricRecheck({ ...base, status: 'scheduled', startsAt: new Date('2026-11-21T11:00:00.000Z') }, now)).toBe(false);
    expect(cricRecheck({ ...base, scorecard: cards(1) }, now)).toBe(true);
    expect(cricRecheck({ ...base, scorecard: cards(2) }, now)).toBe(false);
    expect(cricRecheck({ ...base, homeScore: '557 & 12/1', awayScore: '400 & 168', scorecard: cards(4) }, now)).toBe(false);
    expect(cricRecheck({ ...base, startsAt: new Date('2026-11-16T08:10:00.000Z'), homeScore: null, awayScore: null }, now)).toBe(true);
    // An old short card is left alone; so is anything past the Results window.
    expect(cricRecheck({ ...base, startsAt: new Date('2026-11-16T08:10:00.000Z'), scorecard: cards(1) }, now)).toBe(false);
    expect(cricRecheck({ ...base, startsAt: new Date('2026-11-01T08:10:00.000Z'), homeScore: null, awayScore: null }, now)).toBe(false);
  });

  it('a fixtures import repairs a stuck fixture and a blank result in one call each, and leaves good ones alone', async () => {
    await follow();
    const played = cricMatch({ id: 'cric-done', teams: ['Sri Lanka', 'Pakistan'], teamInfo: [], matchStarted: true, matchEnded: true, status: 'Pakistan won by 3 runs' });
    routes = [[/series_info/, ok({ matchList: [cricMatch(), played] })]];
    await runner.importFixtures();
    // Made from the schedule after it was played: finished, no score.
    expect(await pro.matchByProvider('cricapi', 'cric-done')).toMatchObject({ status: 'finished', homeScore: null });

    clock = new Date('2026-11-15T00:30:00.000Z');
    const done = {
      ...card(2),
      id: 'cric-done',
      teams: ['Sri Lanka', 'Pakistan'],
      teamInfo: [],
      status: 'Pakistan won by 3 runs',
      score: [
        { r: 160, w: 9, o: '20', inning: 'Pakistan Inning 1' },
        { r: 157, w: 8, o: '20', inning: 'Sri Lanka Inning 1' },
      ],
      scorecard: [
        { inning: 'Pakistan Inning 1', batting: [], bowling: [] },
        { inning: 'Sri Lanka Inning 1', batting: [], bowling: [] },
      ],
    };
    routes = [
      [/series_info/, ok({ matchList: [] })],
      [/match_scorecard.*id=cric-done/, ok(done)],
      [/match_scorecard.*id=cric-1/, ok(card(2))],
    ];
    calls = [];
    const runs = await runner.importFixtures();
    expect(runs.find((r) => r.provider === 'cricapi')).toMatchObject({ updated: 2, errors: [] });
    expect(calls.filter((c) => /match_scorecard/.test(c))).toHaveLength(2);
    expect(calls.some((c) => /match_info/.test(c))).toBe(false);
    expect(await pro.matchByProvider('cricapi', 'cric-1')).toMatchObject({ status: 'finished', homeScore: '150/7', winner: 'away' });
    expect(await pro.matchByProvider('cricapi', 'cric-done')).toMatchObject({ homeScore: '157/8', awayScore: '160/9', winner: 'away' });

    // Both are whole now: the next import makes no repair calls.
    calls = [];
    await runner.importFixtures();
    expect(calls.some((c) => /match_scorecard|match_info/.test(c))).toBe(false);
  });
});

describe('CricAPI paid plan + all cricket (2026-11-21)', () => {
  const paidRunner = () =>
    createFeedRunner({ db, pro, budget, adapters: [cricapiAdapter(() => 'k-cric', 2000)], fetcher, now: () => clock });

  it('the founder list, by series name (real CricAPI names)', () => {
    const wanted = [
      "ICC Men's Cricket World Cup 2027",
      'ICC Under 19 Women\'s T20 World Cup 2027',
      'ICC World Test Championship Final 2027',
      "ACC Men's Asia Cup Rising Stars 2026",
      'The Ashes 2027',
      'Womens Ashes, 2027',
      'Australia tour of India, 2027',
      'India Women tour of South Africa, 2026',
      'India A tour of Nepal, 2026',
      'England Women U19 tour of India 2026',
      'Bangladesh Women tour of England, 2027',
      'Sri Lanka tour of New Zealand 2027',
      'Bangladesh tour of Nepal, 2027',
      'Australia vs England, 150th Anniversary One-off Test Match, 2027',
      'Malaysia Womens T20I Tri-Series 2026',
      'Indian Premier League 2027',
      'Big Bash League 2026-27',
      'Womens Big Bash League 2026',
      'SA20, 2027',
      'International League T20 2026',
      'Super Smash 2026-27',
      "Women's Premier League 2027",
      'Nepal Premier League 2026',
      'Abu Dhabi T10 League 2026',
      'Ranji Trophy Elite 2026-27',
      'Vijay Hazare Trophy Plate 2026',
      'Syed Mushtaq Ali Trophy Elite 2026',
      'Col C K Nayudu Trophy 2026-27',
      'Cooch Behar Trophy 2026-27',
      "Senior Women's One Day Trophy 2026-27",
      'Tamil Nadu Premier League 2026',
      'Maharaja Trophy KSCA T20 2026',
      'Sheffield Shield 2026-27',
      'Plunket Shield 2026-27',
      'CSA Provincial One-Day Challenge Division One 2027',
      'County Championship Division One 2026',
      'World Championship of Legends 2026',
    ];
    for (const name of wanted) expect([name, cricSeriesWanted(name)]).toEqual([name, true]);
    for (const name of ['Ireland A tour of Zimbabwe, 2026', 'England Lions tour of West Indies, 2026', 'Hong Kong Sixes 2026', 'Pakistan Shaheens tour of Australia 2026', 'Western Australia vs England 2026']) {
      expect([name, cricSeriesWanted(name)]).toEqual([name, false]);
    }
  });

  it('series dates: an end with no year is the first on or after the start; a start with no year is a stale row', () => {
    expect(cricSeriesDates('2026-12-12', 'Jan 26')!.end.toISOString().slice(0, 10)).toBe('2027-01-26');
    expect(cricSeriesDates('2026-11-14', 'Dec 06')!.end.toISOString().slice(0, 10)).toBe('2026-12-06');
    expect(cricSeriesDates('Mar 11', 'Mar 15')).toBeNull();
    const now = new Date('2026-11-21T12:00:00Z');
    const row = (id: string, name: string, startDate: string, endDate: string, matches = 5) => ({ id, name, startDate, endDate, matches });
    const picked = pickCricSeries(
      [
        row('a', 'Big Bash League 2026-27', '2026-12-12', 'Jan 26'), // starts in 21 days: not yet
        row('b', 'Sri Lanka tour of New Zealand 2027', '2026-11-25', 'Dec 06'),
        row('b2', 'Sri Lanka tour of New Zealand 2027', '2026-11-25', 'Dec 06'), // listed twice
        row('c', 'Plunket Shield 2026-27', '2026-11-18', 'Mar 29'),
        row('d', 'Syed Mushtaq Ali Trophy Elite 2026', '2026-11-14', 'Dec 06', 0), // no matches
        row('e', 'Abu Dhabi T10 League 2026', '2026-11-07', 'Nov 18'), // ended 3 days ago
        row('f', 'Womens Big Bash League 2026', '2026-10-29', 'Dec 05'), // followed by name already
      ],
      now,
      new Set(['f']),
    );
    expect(picked.map((s) => s.id)).toEqual(['b', 'c']);
    expect(moreSeries(Array.from({ length: 25 }, () => row('x', 'x', '2026-09-01', 'Sep 30')), now)).toBe(true);
    expect(moreSeries(Array.from({ length: 25 }, () => row('x', 'x', '2026-03-01', 'Mar 30')), now)).toBe(false);
  });

  it('a `*` follow imports every wanted series under its own name, minus series followed by name', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: '*', sportId: cricket, name: 'All cricket' });
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-wbbl', sportId: cricket, name: "Women's Big Bash League" });
    const series = (id: string, name: string, startDate: string) => ({ id, name, startDate, endDate: 'Dec 20', matches: 10 });
    // CricAPI lists some series twice under two ids: the second WBBL listing must not come in by `*`.
    const page1 = Array.from({ length: 25 }, (_, i) => series(`s${i}`, i === 0 ? 'Syed Mushtaq Ali Trophy Elite 2026' : i === 1 ? 'Hong Kong Sixes 2026' : 'Womens Big Bash League 2026', '2026-11-10'));
    page1[2] = series('series-wbbl', 'Womens Big Bash League 2026', '2026-10-29');
    routes = [
      [/series\?.*offset=0/, ok(page1)],
      [/series\?.*offset=25/, ok([series('old', 'Ranji Trophy Elite 2025-26', '2025-10-15')])],
      [/series_info.*id=s0/, ok({ matchList: [cricMatch({ id: 'smat-1', teams: ['Mumbai', 'Delhi'], teamInfo: [] })] })],
      [/series_info.*id=series-wbbl/, ok({ matchList: [cricMatch({ id: 'wbbl-1', teams: ['Perth Scorchers Women', 'Sydney Sixers Women'], teamInfo: [] })] })],
    ];
    calls = [];
    const runs = await runner.importFixtures();
    expect(runs.find((r) => r.provider === 'cricapi')).toMatchObject({ created: 2, errors: [] });
    expect(await pro.matchByProvider('cricapi', 'smat-1')).toMatchObject({ league: 'Syed Mushtaq Ali Trophy Elite 2026' });
    expect(await pro.matchByProvider('cricapi', 'wbbl-1')).toMatchObject({ league: "Women's Big Bash League" });
    // Two list pages, then the wanted series once each: the WBBL only through its own follow.
    expect(calls.filter((c) => /\/series\?/.test(c))).toHaveLength(2);
    expect(calls.filter((c) => /series_info.*id=series-wbbl/.test(c))).toHaveLength(1);
    expect(calls.filter((c) => /series_info.*id=s0\b/.test(c))).toHaveLength(1);
    expect(calls.filter((c) => /series_info/.test(c))).toHaveLength(2);
  });

  it('pace: behind by more than 15% of the limit slows the poll to 10 minutes', () => {
    // 18:30 UTC = midnight IST; 06:30 UTC = noon IST, half the day gone.
    const noon = new Date('2026-11-21T06:30:00.000Z');
    expect(cricBehind({ used: 1200, limit: 2000 }, noon)).toBe(false); // 60% < 50% + 15%
    expect(cricBehind({ used: 1400, limit: 2000 }, noon)).toBe(true);
    expect(cricBehind(undefined, noon)).toBe(false);
    const live = (n: number) => Array.from({ length: n }, (_, i) => ({ status: 'live' as const, startsAt: new Date('2026-11-21T04:00:00Z'), providerRef: `m${i}` }));
    expect(cricEvery(live(3), noon, { used: 100, limit: 2000 }, 1)).toBe(1);
    expect(cricEvery(live(4), noon, { used: 100, limit: 2000 }, 1)).toBe(5);
    expect(cricEvery(live(2), noon, { used: 1400, limit: 2000 }, 1)).toBe(10);
    expect(cricEvery(live(5), noon, { used: 100, limit: 100 }, 10)).toBe(10);
  });

  it('paid: a few live matches are read by id (score and toss in one), nothing started costs nothing, ball by ball only where offered', async () => {
    const paid = paidRunner();
    await paid.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour' });
    routes = [[/series_info/, ok({ matchList: [cricMatch()] })]];
    await paid.importFixtures();

    // 13:20, ten minutes before the start: watched, but no call.
    calls = [];
    await paid.pollLive();
    expect(calls).toEqual([]);

    let bbbEnabled = false;
    routes = [
      [/match_info/, () => ok(cricMatch({ matchStarted: true, status: 'India opt to bat', tossWinner: 'india', tossChoice: 'bat', bbbEnabled, score: [{ r: 8, w: 0, o: '1', inning: 'India Inning 1' }] }))],
      [/match_scorecard/, ok({ ...cricMatch({ matchStarted: true }), scorecard: [] })],
      [/match_squad/, ok([])],
      [/match_bbb/, ok({ bbb: [{ inning: 0, over: 0, ball: 1, runs: 4, batsman: { name: 'R Sharma' }, bowler: { name: 'M Starc' } }] })],
    ];
    const id = (await pro.matchByProvider('cricapi', 'cric-1'))!.id;
    await prisma.proMatch.update({ where: { id }, data: { featured: true } });
    clock = new Date('2026-11-14T13:32:00.000Z');
    calls = [];
    await paid.pollLive();
    expect(calls.some((c) => /currentMatches/.test(c))).toBe(false);
    expect(calls.some((c) => /match_bbb/.test(c))).toBe(false);
    expect(await pro.match(id)).toMatchObject({ status: 'live', homeScore: '8/0' });
    expect((await pro.match(id))!.facts.map((f) => f.label)).toEqual(['Format', 'Toss']);

    bbbEnabled = true;
    clock = new Date('2026-11-14T13:33:00.000Z');
    calls = [];
    await paid.pollLive();
    expect(calls.filter((c) => /match_bbb/.test(c))).toHaveLength(1);
    expect((await pro.match(id))!.balls).toHaveLength(1);
  });
});

describe('the board with all cricket followed (2026-11-21)', () => {
  // Prod, 21 Nov: 17 cricket matches live; NZ v India was 14th (Home shows 8), behind four
  // October matches CricAPI still lists as under way and a run of CSA / Plunket Shield games.
  it('leagues by tier: India first, then internationals, big leagues, domestic', () => {
    expect(leagueTier('India tour of New Zealand 2026')).toBe(0);
    expect(leagueTier('Indian Premier League 2027')).toBe(0);
    expect(leagueTier('England tour of Australia, 2026')).toBe(1);
    expect(leagueTier("ICC Women's Emerging Nations Trophy, 2026")).toBe(1);
    expect(leagueTier('Big Bash League 2026-27')).toBe(2);
    expect(leagueTier('CSA Four-Day Series Division One 2026-27')).toBe(3);
    expect(leagueTier('Plunket Shield 2026-27')).toBe(3);
  });

  it('live: featured first, then tier, then start; stale "live" matches are not on the board', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'x' });
    clock = new Date('2026-11-21T12:00:00.000Z');
    const mk = (id: string, league: string, start: string, teams: [string, string]) =>
      cricMatch({ id, teams, teamInfo: [], dateTimeGMT: start, matchStarted: true, status: 'Day 2: Stumps', score: [{ r: 100, w: 2, o: '30', inning: `${teams[0]} Inning 1` }] });
    const list = [
      mk('csa', 'CSA', '2026-11-19T08:00:00', ['Titans', 'Warriors']),
      mk('nzind', 'NZ', '2026-11-19T22:00:00', ['New Zealand', 'India']),
      mk('eng', 'ENG', '2026-11-21T08:15:00', ['Australia', 'England']),
      mk('october', 'Ranji', '2026-10-11T04:00:00', ['Arunachal Pradesh', 'Nagaland']),
    ];
    const names: Record<string, string> = { csa: 'CSA Four-Day Series Division One 2026-27', nzind: 'India tour of New Zealand 2026', eng: 'England tour of Australia, 2026', october: 'Ranji Trophy Plate 2026-27' };
    routes = [[/series_info/, ok({ matchList: list })]];
    await runner.importFixtures();
    // The October match is not imported as live any more.
    expect(await pro.matchByProvider('cricapi', 'october')).toBeNull();
    for (const [ref, league] of Object.entries(names)) {
      const m = await pro.matchByProvider('cricapi', ref);
      if (m) await prisma.proMatch.update({ where: { id: m.id }, data: { league } });
    }
    // One made before this fix, live since October: hidden from the board.
    const old = await pro.matchByProvider('cricapi', 'csa');
    await prisma.proMatch.create({
      data: { ...(await prisma.proMatch.findUniqueOrThrow({ where: { id: old!.id } })), id: newId(), providerRef: 'october', league: 'Ranji Trophy Plate 2026-27', startsAt: new Date('2026-10-11T04:00:00Z'), status: 'live' } as never,
    });
    const order = async () => (await pro.board({ sportId: cricket, status: 'live' })).map((m) => m.providerRef);
    expect(await order()).toEqual(['nzind', 'eng', 'csa']);
    // Featured leads.
    await prisma.proMatch.update({ where: { id: old!.id }, data: { featured: true } });
    expect(await order()).toEqual(['csa', 'nzind', 'eng']);
  });
});

describe('scorecards for matches first seen mid-match (2026-11-21)', () => {
  // Prod, 21 Nov 13:05 UTC: 10 of 13 under-way matches (NZ v India at stumps among them) and
  // 21 of 37 results had no scorecard after the first "all cricket" import.
  const nzInd = (over: Record<string, unknown> = {}) =>
    cricMatch({ id: 'nzind', matchType: 'test', teams: ['New Zealand', 'India'], teamInfo: [], dateTimeGMT: '2026-11-19T22:00:00', matchStarted: true, status: 'Day 3: Stumps', score: [{ r: 368, w: 10, o: '110', inning: 'New Zealand Inning 1' }, { r: 486, w: 4, o: '120', inning: 'India Inning 1' }], ...over });
  const card = () => ({ ...nzInd(), scorecard: [{ inning: 'New Zealand Inning 1', batting: [{ batsman: { name: 'K Williamson' }, r: 120 }], bowling: [] }, { inning: 'India Inning 1', batting: [{ batsman: { name: 'S Gill' }, r: 150 }], bowling: [] }] });

  it('a match at stumps with no scorecard gets one on the next half hour, once', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'India tour of New Zealand 2026' });
    clock = new Date('2026-11-21T13:05:00.000Z');
    routes = [[/series_info/, ok({ matchList: [nzInd()] })]];
    await runner.importFixtures();
    expect((await pro.matchByProvider('cricapi', 'nzind'))!).toMatchObject({ status: 'break', scorecard: [] });

    routes = [
      [/currentMatches/, ok([nzInd()])],
      [/match_scorecard/, ok(card())],
    ];
    clock = new Date('2026-11-21T13:31:00.000Z');
    calls = [];
    await runner.pollLive({ force: true });
    expect(calls.filter((c) => /match_scorecard/.test(c))).toHaveLength(1);
    expect((await pro.matchByProvider('cricapi', 'nzind'))!.scorecard.length).toBeGreaterThan(0);
    // Has one now: stumps does not ask again.
    clock = new Date('2026-11-21T14:31:00.000Z');
    calls = [];
    await runner.pollLive({ force: true });
    expect(calls.some((c) => /match_scorecard/.test(c))).toBe(false);
  });

  it('a result with a score but no card is repaired; a try that finds none waits before the next', async () => {
    await runner.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'x' });
    const done = cricMatch({ id: 'smat', teams: ['Punjab', 'Tamil Nadu'], teamInfo: [], dateTimeGMT: '2026-11-16T08:00:00', matchStarted: true, matchEnded: true, status: 'Punjab won by 5 wkts' });
    // Imported the day it was played, finished, with a score but no card (what prod had).
    clock = new Date('2026-11-16T12:00:00.000Z');
    routes = [[/series_info/, ok({ matchList: [done] })]];
    await runner.importFixtures();
    const made = (await pro.matchByProvider('cricapi', 'smat'))!;
    expect(made).toMatchObject({ status: 'finished', scorecard: [] });
    await prisma.proMatch.update({ where: { id: made.id }, data: { homeScore: '180/5', awayScore: '176/9' } });
    clock = new Date('2026-11-21T12:00:00.000Z');
    expect(cricRecheck({ ...made, homeScore: '180/5', awayScore: '176/9' }, clock)).toBe(true);

    // CricAPI has no card for it yet: one try, then it waits (5 days old → ~1.3 days).
    routes = [
      [/series_info/, ok({ matchList: [] })],
      [/match_scorecard/, ok({ ...done, scorecard: [] })],
    ];
    calls = [];
    await runner.importFixtures();
    expect(calls.filter((c) => /match_scorecard/.test(c))).toHaveLength(1);
    clock = new Date('2026-11-21T18:00:00.000Z');
    calls = [];
    await runner.importFixtures();
    expect(calls.some((c) => /match_scorecard/.test(c))).toBe(false);
  });

  it('cricRecheck: no card at all is repaired for 14 days; the wait grows with age', () => {
    const now = new Date('2026-11-21T12:00:00.000Z');
    const base = { status: 'finished' as const, homeScore: '180/5' as string | null, awayScore: '176/9' as string | null, scorecard: [] as never[] };
    expect(cricRecheck({ ...base, startsAt: new Date('2026-11-14T08:00:00Z') }, now)).toBe(true);
    expect(cricRecheck({ ...base, startsAt: new Date('2026-11-05T08:00:00Z') }, now)).toBe(false);
    expect(recheckWait(new Date('2026-11-21T08:00:00Z'), now)).toBe(2 * 3_600_000);
    expect(recheckWait(new Date('2026-11-13T12:00:00Z'), now)).toBe(2 * 86_400_000);
  });

  it('paid: the live poll repairs every half hour, not only at the fixtures import', async () => {
    const paid = createFeedRunner({ db, pro, budget, adapters: [cricapiAdapter(() => 'k-cric', 2000)], fetcher, now: () => clock });
    await paid.saveFollow(null, { provider: 'cricapi', ref: 'series-1', sportId: cricket, name: 'x' });
    clock = new Date('2026-11-21T10:00:00.000Z');
    routes = [[/series_info/, ok({ matchList: [nzInd({ id: 'blank', dateTimeGMT: '2026-11-20T08:00:00', matchEnded: true, status: 'India won by 10 wkts' })] })]];
    await paid.importFixtures();
    const blank = (await pro.matchByProvider('cricapi', 'blank'))!;
    // Made finished; then a card-less score from the series list, as prod had.
    await prisma.proMatch.update({ where: { id: blank.id }, data: { scorecard: [] } });
    routes = [[/match_scorecard/, ok({ ...card(), id: 'blank', matchEnded: true, status: 'India won by 10 wkts' })]];
    // The import at 10:00 already tried it (CricAPI had no card then): it waits (a day old → ~9 h).
    clock = new Date('2026-11-21T10:40:00.000Z');
    calls = [];
    await paid.pollLive();
    expect(calls.some((c) => /match_scorecard/.test(c))).toBe(false);
    clock = new Date('2026-11-21T19:00:00.000Z');
    calls = [];
    await paid.pollLive();
    expect(calls.filter((c) => /match_scorecard/.test(c))).toHaveLength(1);
    expect((await pro.matchByProvider('cricapi', 'blank'))!.scorecard.length).toBeGreaterThan(0);
    // Ten minutes later: not again.
    clock = new Date('2026-11-21T19:10:00.000Z');
    calls = [];
    await paid.pollLive();
    expect(calls.some((c) => /match_scorecard/.test(c))).toBe(false);
  });
});
