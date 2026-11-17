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
import { createProService, type ProService } from '../src/modules/pro/service/index.js';
import { createFeedRunner, feedPatch, type FeedRunner } from '../src/modules/pro/feeds/runner.js';
import { cricapiAdapter, inningsTeams, parseCricMatch, parseCricScorecard } from '../src/modules/pro/feeds/cricapi.js';
import { apiFootballAdapter, parseFootballFixture } from '../src/modules/pro/feeds/apiFootball.js';
import { parseSnookerMatch, parseSnookerPlayers, parseSnookerRounds, snookerAdapter } from '../src/modules/pro/feeds/snooker.js';
import { codeFor } from '../src/modules/pro/feeds/types.js';
import { createPredictionsService, suggestAnswer, type PredictionsService } from '../src/modules/predictions/service/index.js';
import { createContentService, type ContentService } from '../src/modules/content/service/index.js';
import { createNewsImporter, parseGoogleNews, parseNewsData, parsePexels, parseUnsplash, pickPhoto } from '../src/modules/content/feeds/news.js';

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
    adapters: [cricapiAdapter(() => 'k-cric'), apiFootballAdapter(() => 'k-foot'), snookerAdapter(() => 'pl4y')],
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

  it('headlines: Google News RSS, NewsData, and credited pictures', () => {
    const rss = `<rss><channel><item><title>India seal the series &amp; top the table - ESPNcricinfo</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate><source url="https://www.espncricinfo.com">ESPNcricinfo</source></item><item><title>No link</title></item></channel></rss>`;
    expect(parseGoogleNews(rss)).toEqual([
      { title: 'India seal the series & top the table', url: 'https://news.google.com/rss/articles/abc', sourceName: 'ESPNcricinfo', publishedAt: new Date('2026-11-14T10:00:00Z'), imageUrl: null },
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
      adapters: [cricapiAdapter(() => 'k')],
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

    clock = new Date(clock.getTime() + 4 * 60_000);
    await runner.pollLive();
    expect(await pro.match(id)).toMatchObject({ homeScore: '60/1', note: 'Rohit retired hurt' });

    // A quiet poll writes nothing but the check time (G9).
    clock = new Date(clock.getTime() + 6 * 60_000);
    const before = (await pro.match(id))!;
    await runner.pollLive();
    const after = (await pro.match(id))!;
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.feedCheckedAt).toEqual(clock);

    // Handed back, the feed writes it again.
    await pro.releaseFeed(id);
    clock = new Date(clock.getTime() + 6 * 60_000);
    await runner.pollLive();
    expect((await pro.match(id))!.note).toBe('India opt to bat');
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
    // Free plan (real key, 2026-11-17): no season=, no ids=; date= is today and tomorrow, shared by follows.
    routes = [[/fixtures\?date=2026-11-14/, football200([fixture(), { ...fixture(), league: { id: 999, name: 'Other league' }, fixture: { ...fixture().fixture, id: 9002 } }])], [/fixtures\?date=2026-11-15/, football200([])]];
    await runner.importFixtures();
    expect(calls).toEqual([expect.stringMatching(/fixtures\?date=2026-11-14&timezone=UTC/), expect.stringMatching(/fixtures\?date=2026-11-15&timezone=UTC/)]);
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
