/**
 * Floodlight redesign (migration 059) — pro matches, predictions, content and
 * the richer community posts, against a real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { FOOTBALL, seedSport } from '../src/modules/sport/seed.js';
import { boardOrder, createProService, ProCode, type ProMatch, type ProService } from '../src/modules/pro/service/index.js';
import {
  createPredictionsService,
  DAILY_BONUS,
  PredictionCode,
  rankRows,
  scorePick,
  streaks,
  type PredictionsService,
} from '../src/modules/predictions/service/index.js';
import { ContentCode, createContentService, type ContentService } from '../src/modules/content/service/index.js';
import { createCommunityFeed, FeedCode } from '../src/modules/communities/service/feed.js';
import { createProfileExtras, RecordCode } from '../src/modules/profile/service/floodlight.js';

let prisma: PrismaClient;
let db: Db;
let clock: Date;
let football: string;
let pro: ProService;
let predictions: PredictionsService;
let content: ContentService;
const published: { matchId: string; event: string }[] = [];
const told: { userIds: string[]; correct: boolean; points: number }[] = [];
const wentLive: string[][] = [];
const friends = new Map<string, string[]>();

const allow = { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) };

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    throw e;
  }
  return 'NO_ERROR';
};

async function user(name: string, city: string | null = null): Promise<string> {
  const id = newId();
  await prisma.user.create({ data: { id, email: `${name}-${id}@example.com`.toLowerCase(), displayName: name } });
  await prisma.playerProfile.create({ data: { id: newId(), userId: id, city } });
  return id;
}

let teamPair: { home: string; away: string } | null = null;
async function teams(): Promise<{ home: string; away: string }> {
  if (teamPair) return teamPair;
  const home = await pro.saveTeam(null, { sportId: football, name: 'Mumbai City', shortCode: 'mci', tint: '#1e3a6b' });
  const away = await pro.saveTeam(null, { sportId: football, name: 'Bengaluru FC', shortCode: 'BFC' });
  teamPair = { home: home.id, away: away.id };
  return teamPair;
}

async function match(at = new Date(clock.getTime() + 3_600_000)): Promise<ProMatch> {
  const t = await teams();
  return pro.createMatch(null, { sportId: football, league: 'ISL', homeTeamId: t.home, awayTeamId: t.away, startsAt: at });
}

beforeAll(async () => {
  prisma = (await startTestDb()).prisma;
  db = prisma as unknown as Db;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  clock = new Date('2026-11-14T06:30:00.000Z'); // 12:00 IST
  football = await seedSport(prisma, FOOTBALL);
  published.length = 0;
  teamPair = null;
  told.length = 0;
  wentLive.length = 0;
  friends.clear();
  pro = createProService({
    db,
    limiter: allow,
    now: () => clock,
    async publish(matchId, event) {
      published.push({ matchId, event });
    },
    async wentLive(_m, fans) {
      wentLive.push(fans);
    },
  });
  predictions = createPredictionsService({
    db,
    now: () => clock,
    matchSport: async (id) => (await pro.match(id))?.sportId ?? null,
    friendsOf: async (u) => friends.get(u) ?? [],
    communityMembers: async () => [],
    async cityPeers(u) {
      const me = await prisma.playerProfile.findUnique({ where: { userId: u } });
      if (!me?.city) return { city: null, userIds: [] };
      const peers = await prisma.playerProfile.findMany({ where: { city: me.city } });
      return { city: me.city, userIds: peers.map((p) => p.userId) };
    },
    async notify(userIds, p) {
      told.push({ userIds, correct: p.correct, points: p.points });
    },
  });
  content = createContentService({ db, now: () => clock });
});

// --- pro --------------------------------------------------------------------------

describe('pro matches', () => {
  it('pro R3: the board shows live first, then upcoming soonest, then latest results', () => {
    const m = (status: ProMatch['status'], h: number) => ({ status, startsAt: new Date(Date.UTC(2026, 10, 14, h)) }) as ProMatch;
    const sorted = [m('finished', 1), m('scheduled', 9), m('live', 5), m('scheduled', 7), m('finished', 3)].sort(boardOrder);
    expect(sorted.map((x) => `${x.status}@${x.startsAt.getUTCHours()}`)).toEqual([
      'live@5',
      'scheduled@7',
      'scheduled@9',
      'finished@3',
      'finished@1',
    ]);
  });

  it('pro R2: stats, the over and the scorecard are shape-checked; R5: every change is published', async () => {
    const m = await match();
    expect(await codeOf(() => pro.updateMatch(m.id, { stats: [{ label: 'Run rate' }] }))).toBe(ProCode.INVALID_MATCH);
    expect(await codeOf(() => pro.updateMatch(m.id, { currentOver: ['1', '4', 'WIDE+'] }))).toBe(ProCode.INVALID_MATCH);
    const live = await pro.updateMatch(m.id, {
      status: 'live',
      homeScore: '2',
      awayScore: '1',
      statusDetail: "67'",
      stats: [{ label: 'Possession', value: '54%' }],
      scorecard: [{ team: 'MCI', title: 'Shots', columns: ['On', 'Off'], rows: [{ name: 'Chhetri', cells: ['3', '1'] }] }],
    });
    expect(live.stats).toEqual([{ label: 'Possession', value: '54%' }]);
    expect(live.scorecard[0]?.rows[0]?.cells).toEqual(['3', '1']);
    expect(published.map((p) => p.event)).toContain('pro.match.updated');
  });

  it('pro R6: going live tells the fans of either team, once', async () => {
    const m = await match();
    const fan = await user('Asha');
    await pro.setFavouriteTeams(fan, [m.homeTeamId]);
    await pro.updateMatch(m.id, { status: 'live' });
    await pro.updateMatch(m.id, { homeScore: '1' });
    expect(wentLive).toEqual([[fan]]);
    expect(await codeOf(() => pro.setFavouriteTeams(fan, Array.from({ length: 11 }, () => newId())))).toBe(ProCode.TOO_MANY_TEAMS);
  });

  it('pro R3: a fixture 12 hours past its start that never went live leaves the board; a stuck live match stops being polled after 6 days', async () => {
    const soon = await match(new Date(clock.getTime() + 3_600_000));
    const late = await match(new Date(clock.getTime() - 3_600_000)); // running late: still shown
    const forgotten = await match(new Date(clock.getTime() - 13 * 3_600_000));
    const ids = (await pro.board({})).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([soon.id, late.id]));
    expect(ids).not.toContain(forgotten.id);

    const t = await teams();
    const feed = (startsAt: Date, ref: string) =>
      pro.createMatch(null, { sportId: football, league: 'ISL', homeTeamId: t.home, awayTeamId: t.away, startsAt, provider: 'api_football', providerRef: ref });
    const stuck = await feed(new Date(clock.getTime() - 7 * 86_400_000), 'old');
    const testMatch = await feed(new Date(clock.getTime() - 3 * 86_400_000), 'test-day-3');
    for (const m of [stuck, testMatch]) await pro.updateMatch(m.id, { status: 'live' });
    const watched = (await pro.feedWatchList('api_football', 15 * 60_000)).map((m) => m.id);
    expect(watched).toContain(testMatch.id);
    expect(watched).not.toContain(stuck.id);
  });

  it('pro R4: the chat refuses when closed; a hidden message is gone for players, kept for staff', async () => {
    const m = await match();
    const asha = await user('Asha');
    const staff = await user('Staff');
    const msg = await pro.sendMessage(asha, m.id, '  What a goal  ');
    expect(msg.body).toBe('What a goal');
    expect(await codeOf(() => pro.sendMessage(asha, m.id, ' '))).toBe(ProCode.INVALID_MESSAGE);
    await pro.hideMessage(staff, msg.id);
    expect((await pro.chat(m.id, {})).nodes).toEqual([]);
    expect((await pro.chat(m.id, {}, { staff: true })).nodes[0]).toMatchObject({ body: 'What a goal', hidden: true });
    await pro.updateMatch(m.id, { chatOpen: false });
    expect(await codeOf(() => pro.sendMessage(asha, m.id, 'hello'))).toBe(ProCode.CHAT_CLOSED);
  });
});

// --- predictions ---------------------------------------------------------------------

describe('predictions', () => {
  async function winner(locksInMs = 3_600_000, opts: { live?: boolean } = {}) {
    const m = await match();
    return predictions.createQuestion(null, {
      matchId: m.id,
      kind: 'choice',
      prompt: 'Who wins?',
      live: opts.live ?? false,
      locksAt: new Date(clock.getTime() + locksInMs),
      options: [{ label: 'Mumbai City' }, { label: 'Draw' }, { label: 'Bengaluru FC' }],
    });
  }

  it('predictions R3: scoring is pure — exact score earns all, the right result a third', () => {
    const q = { kind: 'exact_score' as const, points: 30, correctOptionId: null, correctHome: 2, correctAway: 1 };
    expect(scorePick(q, { optionId: null, home: 2, away: 1 })).toEqual({ correct: true, points: 30 });
    expect(scorePick(q, { optionId: null, home: 3, away: 0 })).toEqual({ correct: false, points: 10 });
    expect(scorePick(q, { optionId: null, home: 1, away: 1 })).toEqual({ correct: false, points: 0 });
    expect(streaks([true, true, false, true, true, true]).best).toBe(3);
    expect(streaks([true, false, true]).streak).toBe(1);
    expect(rankRows([{ userId: 'a', points: 10 }, { userId: 'b', points: 30 }, { userId: 'c', points: 10 }]).map((r) => r.rank)).toEqual([1, 2, 2]);
  });

  it('predictions R2: one pick per player, changeable until the lock, refused after', async () => {
    const q = await winner(60_000);
    const asha = await user('Asha');
    await predictions.pick(asha, q.id, { optionId: q.options[0]!.id });
    await predictions.pick(asha, q.id, { optionId: q.options[2]!.id });
    const picks = await prisma.predictionPick.findMany({ where: { questionId: q.id } });
    expect(picks).toHaveLength(1);
    expect(picks[0]!.optionId).toBe(q.options[2]!.id);
    expect(await codeOf(() => predictions.pick(asha, q.id, { optionId: newId() }))).toBe(PredictionCode.INVALID_PICK);
    clock = new Date(clock.getTime() + 61_000);
    expect(await codeOf(() => predictions.pick(asha, q.id, { optionId: q.options[0]!.id }))).toBe(PredictionCode.LOCKED);
  });

  it('predictions R3, R5: settling marks every pick and writes points once; a second settle is refused', async () => {
    const q = await winner();
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    await predictions.pick(asha, q.id, { optionId: q.options[0]!.id });
    await predictions.pick(ravi, q.id, { optionId: q.options[1]!.id });
    const split = (await predictions.splits([q.id])).get(q.id)!;
    expect(split.total).toBe(2);

    await predictions.settle(null, q.id, { optionId: q.options[0]!.id });
    expect(await codeOf(() => predictions.settle(null, q.id, { optionId: q.options[1]!.id }))).toBe(PredictionCode.ALREADY_SETTLED);
    expect((await predictions.stats(asha)).points).toBe(10);
    expect((await predictions.stats(ravi)).points).toBe(0);
    expect((await predictions.stats(asha)).accuracy).toBe(100);
    expect(told).toEqual([
      { userIds: [asha], correct: true, points: 10 },
      { userIds: [ravi], correct: false, points: 0 },
    ]);
    expect(await prisma.predictionPoint.count()).toBe(1);
  });

  it('predictions R3: settling under concurrency still pays once', async () => {
    const q = await winner();
    const asha = await user('Asha');
    await predictions.pick(asha, q.id, { optionId: q.options[0]!.id });
    const results = await Promise.allSettled([
      predictions.settle(null, q.id, { optionId: q.options[0]!.id }),
      predictions.settle(null, q.id, { optionId: q.options[0]!.id }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.predictionPoint.count()).toBe(1);
  });

  it('predictions R4: a void question pays nothing and never counts for accuracy', async () => {
    const q = await winner();
    const asha = await user('Asha');
    await predictions.pick(asha, q.id, { optionId: q.options[0]!.id });
    await predictions.voidQuestion(q.id);
    const s = await predictions.stats(asha);
    expect(s).toMatchObject({ points: 0, settled: 0, accuracy: null });
    expect(await codeOf(() => predictions.pick(asha, q.id, { optionId: q.options[0]!.id }))).toBe(PredictionCode.LOCKED);
  });

  it('predictions R6: the daily challenge adds its bonus once, when all three tasks are done', async () => {
    const asha = await user('Asha');
    const qs = [await winner(), await winner(), await winner(3_600_000, { live: true })];
    const m = await match();
    const exact = await predictions.createQuestion(null, { matchId: m.id, kind: 'exact_score', prompt: 'Final score?', locksAt: new Date(clock.getTime() + 3_600_000) });
    expect(await codeOf(() => predictions.createQuestion(null, { matchId: m.id, kind: 'choice', prompt: 'One option', locksAt: clock, options: [{ label: 'A' }] }))).toBe(
      PredictionCode.INVALID_QUESTION,
    );
    for (const q of qs) await predictions.pick(asha, q.id, { optionId: q.options[0]!.id });
    expect((await predictions.challenge(asha)).completed).toBe(false);
    await predictions.pick(asha, exact.id, { home: 2, away: 1 });
    await predictions.pick(asha, exact.id, { home: 3, away: 1 });
    expect((await predictions.challenge(asha)).completed).toBe(true);
    expect(await predictions.picksThisWeek(asha)).toBe(4);
    expect((await predictions.stats(asha)).points).toBe(DAILY_BONUS);
    expect((await predictions.badges(asha)).find((b) => b.key === 'daily_1')?.earned).toBe(true);
  });

  it('predictions R3: a right-result exact score is told its third, not "0 points"', async () => {
    const m = await match();
    const q = await predictions.createQuestion(null, { matchId: m.id, kind: 'exact_score', prompt: 'Final score?', points: 30, locksAt: new Date(clock.getTime() + 3_600_000) });
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    const meera = await user('Meera');
    await predictions.pick(asha, q.id, { home: 2, away: 1 });
    await predictions.pick(ravi, q.id, { home: 3, away: 0 });
    await predictions.pick(meera, q.id, { home: 0, away: 0 });
    await predictions.settle(null, q.id, { home: 2, away: 1 });
    expect(told).toEqual([
      { userIds: [asha], correct: true, points: 30 },
      { userIds: [ravi], correct: false, points: 10 },
      { userIds: [meera], correct: false, points: 0 },
    ]);
    // A settled question takes no more picks, and its match can no longer be deleted.
    expect(await codeOf(() => predictions.pick(meera, q.id, { home: 2, away: 1 }))).toBe(PredictionCode.LOCKED);
    expect(await codeOf(() => pro.deleteMatch(m.id))).toBe(ProCode.INVALID_MATCH);
  });

  it('predictions R7: leaderboards rank by points; friends and city scopes narrow it; your row is pinned', async () => {
    const q = await winner();
    const asha = await user('Asha', 'Gurugram');
    const ravi = await user('Ravi', 'Gurugram');
    const meera = await user('Meera', 'Pune');
    for (const u of [asha, ravi, meera]) await predictions.pick(u, q.id, { optionId: q.options[u === ravi ? 1 : 0]!.id });
    await predictions.settle(null, q.id, { optionId: q.options[0]!.id });

    const global = await predictions.leaderboard(ravi, 'global');
    expect(global.entries.map((e) => e.rank)).toEqual([1, 1]);
    expect(global.me).toBeNull();
    friends.set(asha, [meera]);
    expect((await predictions.leaderboard(asha, 'friends')).size).toBe(2);
    const city = await predictions.leaderboard(asha, 'city');
    expect(city.entries.map((e) => e.userId)).toEqual([asha]);
    expect(await predictions.cityRank(asha)).toEqual({ rank: 1, city: 'Gurugram' });
  });
});

// --- content -------------------------------------------------------------------------

describe('content', () => {
  it('content R1–R3: drafts are hidden, a short needs a video to publish, publishing stamps the date once', async () => {
    const short = await content.save(null, null, { kind: 'short', title: 'Top 5 smashes' });
    expect(await content.item(short.id)).toBeNull();
    expect(await codeOf(() => content.setStatus(short.id, 'published'))).toBe(ContentCode.INVALID);
    expect(await codeOf(() => content.save(null, short.id, { kind: 'short', title: 'x', videoUrl: 'http://insecure.example' }))).toBe(ContentCode.INVALID);
    await content.save(null, short.id, { kind: 'short', title: 'Top 5 smashes', videoUrl: 'https://videos.example.com/a.mp4' });
    const live = await content.setStatus(short.id, 'published');
    const first = live.publishedAt;
    clock = new Date(clock.getTime() + 60_000);
    await content.setStatus(short.id, 'draft');
    expect((await content.setStatus(short.id, 'published')).publishedAt).toEqual(first);
    expect((await content.feed({ kind: 'short' })).nodes.map((n) => n.id)).toEqual([short.id]);
  });

  it('content R1: a search keeps filtering on the next page', async () => {
    for (const title of ['Kohli century', 'ISL roundup', 'Kohli fifty', 'Kohli duck']) {
      const s = await content.save(null, null, { kind: 'story', title });
      await content.setStatus(s.id, 'published');
      clock = new Date(clock.getTime() + 60_000);
    }
    const page1 = await content.feed({ q: 'kohli', first: 2 });
    expect(page1.hasNextPage).toBe(true);
    const page2 = await content.feed({ q: 'kohli', first: 2, after: page1.endCursor });
    expect(page2.nodes.map((n) => n.title)).toEqual(['Kohli century']);
  });

  it('content R4: the Home shelf picks a featured original first', async () => {
    const a = await content.save(null, null, { kind: 'original', title: 'Older original' });
    const b = await content.save(null, null, { kind: 'original', title: 'Featured original', featured: true });
    await content.setStatus(b.id, 'published');
    clock = new Date(clock.getTime() + 60_000);
    await content.setStatus(a.id, 'published');
    expect((await content.homeShelf(null)).hero?.id).toBe(b.id);
  });
});

// --- communities: Floodlight posts ------------------------------------------------------

describe('community posts', () => {
  async function community(owner: string): Promise<string> {
    const id = newId();
    await prisma.community.create({ data: { id, slug: `c-${id}`, name: 'Delhi FC Fans', sportId: football, inviteCode: id.slice(0, 8), ownerUserId: owner } });
    return id;
  }

  const feedFor = (members: Set<string>) =>
    createCommunityFeed({
      db,
      limiter: allow,
      roleOf: async (_c, u) => (u && members.has(u) ? 'member' : null),
      photoRoot: (c) => `pl4y/communities/${c}/posts`,
      now: () => clock,
    });

  it('polls: 2–4 options, one changeable vote per member, percentages add up', async () => {
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    const c = await community(asha);
    const feed = feedFor(new Set([asha, ravi]));
    expect(await codeOf(() => feed.createPost({ userId: asha }, c, 'Kit colour?', { kind: 'poll', pollOptions: ['Blue'] }))).toBe(FeedCode.INVALID_POST);
    const post = await feed.createPost({ userId: asha }, c, 'Kit colour?', { kind: 'poll', pollOptions: ['Blue', 'Red'] });
    const blue = (await feed.polls([post.id], asha)).get(post.id)!.options[0]!.id;
    const red = (await feed.polls([post.id], asha)).get(post.id)!.options[1]!.id;
    await feed.vote({ userId: asha }, post.id, blue);
    await feed.vote({ userId: ravi }, post.id, blue);
    const poll = await feed.vote({ userId: ravi }, post.id, red);
    expect(poll.options.map((o) => o.percent)).toEqual([50, 50]);
    expect(poll.myOptionId).toBe(red);
  });

  it('photos must be under the community’s folder; events take RSVPs until they start', async () => {
    const asha = await user('Asha');
    const c = await community(asha);
    const feed = feedFor(new Set([asha]));
    await expect(feed.createPost({ userId: asha }, c, '', { kind: 'photo', photoPublicIds: ['pl4y/avatars/someone'] })).rejects.toThrow('Forbidden');
    const photo = await feed.createPost({ userId: asha }, c, '', { kind: 'photo', photoPublicIds: [`pl4y/communities/${c}/posts/p1`] });
    expect(photo.photoPublicIds).toHaveLength(1);
    const ev = await feed.createPost({ userId: asha }, c, 'Sunday kickabout', {
      kind: 'event',
      event: { title: 'Sunday 5-a-side', startsAt: new Date(clock.getTime() + 86_400_000), place: 'Siri Fort' },
    });
    expect(await feed.rsvp({ userId: asha }, ev.id, true)).toEqual({ count: 1, going: true });
    expect(await feed.rsvp({ userId: asha }, ev.id, true)).toEqual({ count: 1, going: true });
    expect((await feed.upcomingEvents([c])).map((p) => p.id)).toEqual([ev.id]);
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    expect(await codeOf(() => feed.rsvp({ userId: asha }, ev.id, true))).toBe(FeedCode.INVALID_POST);
  });
});

// --- profile ---------------------------------------------------------------------------

describe('profile', () => {
  it('profile R20, R21: the athlete label is the player’s own words; records are capped and theirs alone', async () => {
    const extras = createProfileExtras({ db, now: () => clock });
    const asha = await user('Asha');
    const ravi = await user('Ravi');
    expect(await extras.setAthleteLabel(asha, '  State-level   shuttler ')).toBe('State-level shuttler');
    expect(await codeOf(() => extras.setAthleteLabel(asha, 'x'.repeat(41)))).toBe(RecordCode.INVALID_LABEL);
    expect(await codeOf(() => extras.addRecord(asha, { title: 'Won', year: 2099 }))).toBe(RecordCode.INVALID_RECORD);
    const rec = await extras.addRecord(asha, { title: 'District champion', year: 2024 });
    await extras.deleteRecord(ravi, rec.id);
    const mine = await prisma.playerProfile.findUniqueOrThrow({ where: { userId: asha } });
    expect((await extras.records(mine.id)).map((r) => r.title)).toEqual(['District champion']);
    expect((await extras.athletes({})).length).toBe(1);
    // "Athletes to follow" never lists the viewer.
    expect(await extras.athletes({ excludeUserId: asha })).toEqual([]);
    expect((await extras.athletes({ excludeUserId: ravi })).length).toBe(1);
  });
});

// --- predictions R10: the system question -------------------------------------------

describe('predictions R10 — a "Who wins?" on every upcoming feed match, settled by the result', () => {
  it('makes one per feed match (not manual, not one that has a question), and settles it from the result', async () => {
    const t = await teams();
    const at = new Date(clock.getTime() + 5 * 3_600_000);
    const feed = await pro.createMatch(null, { sportId: football, league: 'ISL', homeTeamId: t.home, awayTeamId: t.away, startsAt: at, provider: 'api_football', providerRef: 'fx-1' });
    const manual = await pro.createMatch(null, { sportId: football, league: 'ISL', homeTeamId: t.home, awayTeamId: t.away, startsAt: at });
    const staffed = await pro.createMatch(null, { sportId: football, league: 'ISL', homeTeamId: t.home, awayTeamId: t.away, startsAt: at, provider: 'api_football', providerRef: 'fx-2' });
    await predictions.createQuestion(await user('Staff'), { matchId: staffed.id, kind: 'choice', prompt: 'First scorer?', locksAt: at, options: [{ label: 'A' }, { label: 'B' }] });

    expect(await predictions.autoWinnerQuestions()).toBe(1);
    expect(await predictions.autoWinnerQuestions()).toBe(0); // once only
    expect(await predictions.forMatch(manual.id)).toHaveLength(0);
    const [q] = await predictions.forMatch(feed.id);
    expect(q).toMatchObject({ prompt: 'Who wins?', locksAt: at, points: 10 });
    expect(q!.options.map((o) => [o.label, o.outcome])).toEqual([['Mumbai City', 'home'], ['Draw', 'draw'], ['Bengaluru FC', 'away']]);

    const fan = await user('Fan');
    await predictions.pick(fan, q!.id, { optionId: q!.options[0]!.id });
    clock = new Date(at.getTime() + 2 * 3_600_000);
    await pro.updateMatch(feed.id, { status: 'finished', homeScore: '2', awayScore: '1', winner: 'home' });
    await predictions.suggestForMatch(feed.id, { homeScore: '2', awayScore: '1', winner: 'home' });
    expect(await predictions.autoSettleMatch(feed.id)).toBe(1);
    const settled = await predictions.question(q!.id);
    expect(settled?.status).toBe('settled');
    expect((await predictions.stats(fan)).points).toBe(10);
  });

  it('never settles a staff question on its own', async () => {
    const m = await match();
    const q = await predictions.createQuestion(await user('Staff'), { matchId: m.id, kind: 'choice', prompt: 'Who wins?', locksAt: m.startsAt, options: [{ label: 'Mumbai City', outcome: 'home' }, { label: 'Bengaluru FC', outcome: 'away' }] });
    clock = new Date(m.startsAt.getTime() + 3 * 3_600_000);
    await predictions.suggestForMatch(m.id, { homeScore: '1', awayScore: '0', winner: 'home' });
    expect(await predictions.autoSettleMatch(m.id)).toBe(0);
    expect((await predictions.question(q.id))?.status).toBe('open');
  });
});
