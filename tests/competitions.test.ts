/**
 * 066 — prediction competitions (Campus Prediction Cup), against a real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { CRICKET, FOOTBALL, seedSport } from '../src/modules/sport/seed.js';
import { createProService, type ProService } from '../src/modules/pro/service/index.js';
import {
  CompetitionCode,
  createCompetitionsService,
  denseRanks,
  groupScore,
  istMonthStart,
  scorePick,
  shortName,
  winnerQuestionFor,
  type Competition,
  type CompetitionsService,
  type Reminder,
} from '../src/modules/competitions/service/index.js';

let prisma: PrismaClient;
let db: Db;
let clock: Date;
let football: string;
let cricket: string;
let pro: ProService;
let cups: CompetitionsService;
const sent: Reminder[] = [];

const H = 3_600_000;
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

async function user(name: string): Promise<string> {
  const id = newId();
  await prisma.user.create({ data: { id, email: `${name}-${id}@example.com`.toLowerCase(), displayName: name } });
  await prisma.playerProfile.create({ data: { id: newId(), userId: id } });
  return id;
}

async function cup(over: Partial<Parameters<CompetitionsService['saveCompetition']>[2]> = {}): Promise<Competition> {
  return cups.saveCompetition(null, null, {
    slug: 'campus-cup-s1',
    segment: 'campus',
    name: 'Campus Prediction Cup',
    seasonLabel: 'Season 1',
    startsAt: new Date(clock.getTime() - 24 * H),
    endsAt: new Date(clock.getTime() + 180 * 24 * H),
    status: 'live',
    teamSize: 2,
    ...over,
  });
}

async function college(c: Competition, name: string, code: string) {
  const g = await cups.saveGroup(c.id, null, { name, fullName: `${name} University`, leadName: 'Shlok D.' });
  await cups.saveCode({ groupId: g.id, code, ambassadorName: 'Shlok D.' });
  return g;
}

async function proMatch(at = new Date(clock.getTime() + 3 * H)) {
  const home = await pro.saveTeam(null, { sportId: football, name: 'Arsenal', shortCode: 'ARS' });
  const away = await pro.saveTeam(null, { sportId: football, name: 'Chelsea', shortCode: 'CHE' });
  return pro.createMatch(null, { sportId: football, league: 'Premier League', homeTeamId: home.id, awayTeamId: away.id, startsAt: at });
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
  clock = new Date('2026-12-03T06:30:00.000Z'); // 12:00 IST
  football = await seedSport(prisma, FOOTBALL);
  cricket = await seedSport(prisma, CRICKET);
  sent.length = 0;
  pro = createProService({ db, limiter: allow, now: () => clock, publish: async () => {}, wentLive: async () => {} });
  cups = createCompetitionsService({
    db,
    now: () => clock,
    async match(id) {
      const m = await pro.match(id);
      if (!m) return null;
      const [home, away, sport] = await Promise.all([
        prisma.proTeam.findUniqueOrThrow({ where: { id: m.homeTeamId } }),
        prisma.proTeam.findUniqueOrThrow({ where: { id: m.awayTeamId } }),
        prisma.sport.findUniqueOrThrow({ where: { id: m.sportId } }),
      ]);
      return { id: m.id, sportId: m.sportId, sportSlug: sport.slug, league: m.league, stage: m.stage, home: home.name, away: away.name, startsAt: m.startsAt, status: m.status };
    },
    upcomingMatches: async () => [],
    async notify(r) {
      sent.push(r);
    },
  });
});

describe('competitions: pure rules', () => {
  it('R5: right choice × multiplier; exact score in full, right result a third', () => {
    const q = { kind: 'choice' as const, points: 10, multiplier: 1.5, correctOptionId: 'a', correctHome: null, correctAway: null };
    expect(scorePick(q, { optionId: 'a', home: null, away: null })).toEqual({ correct: true, points: 15 });
    expect(scorePick(q, { optionId: 'b', home: null, away: null })).toEqual({ correct: false, points: 0 });
    const e = { kind: 'exact_score' as const, points: 25, multiplier: 2, correctOptionId: null, correctHome: 2, correctAway: 1 };
    expect(scorePick(e, { optionId: null, home: 2, away: 1 })).toEqual({ correct: true, points: 50 });
    expect(scorePick(e, { optionId: null, home: 3, away: 0 })).toEqual({ correct: false, points: 16 });
    expect(scorePick(e, { optionId: null, home: 0, away: 0 })).toEqual({ correct: false, points: 0 });
  });

  it('R7: a group scores the average of its top N, a missing slot counting 0', () => {
    expect(groupScore([100, 50, 10], 2)).toBe(75);
    expect(groupScore([100], 2)).toBe(50);
    expect(groupScore([], 20)).toBe(0);
    expect(denseRanks([{ key: 'a', score: 5 }, { key: 'b', score: 9 }, { key: 'c', score: 5 }]).map((r) => [r.key, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 2],
    ]);
  });

  it('boards show a first name and an initial; months are India time', () => {
    expect(shortName('Aarav Kumar Mehta')).toBe('Aarav M.');
    expect(shortName('Riya')).toBe('Riya');
    expect(shortName('  ')).toBe('Player');
    // 1 Dec 00:10 IST is still 30 Nov in UTC.
    expect(istMonthStart(new Date('2026-11-30T18:40:00.000Z')).toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });

  it('a Test match offers a draw; T20 does not', () => {
    const t = winnerQuestionFor({ sportSlug: 'cricket', league: '2nd Test', stage: null, home: 'India', away: 'New Zealand' });
    expect(t.options.map((o) => o.outcome)).toEqual(['home', 'draw', 'away']);
    expect(t.prompt).toBe('What is the result?');
    expect(winnerQuestionFor({ sportSlug: 'cricket', league: 'IPL', stage: null, home: 'MI', away: 'CSK' }).options).toHaveLength(2);
  });
});

describe('competitions: joining (R3)', () => {
  it('joins with a code, once; the group is locked for the season', async () => {
    const c = await cup();
    const dtu = await college(c, 'DTU', 'AMB-002');
    const nsut = await college(c, 'NSUT', 'AMB-003');
    const me = await user('Shlok Dutta');
    const preview = await cups.previewCode(' amb-002 ');
    expect(preview?.group.name).toBe('DTU');
    const m = await cups.join(me, { code: 'amb-002' });
    expect(m.groupId).toBe(dtu.id);
    expect(m.code).toBe('AMB-002');
    // Same group again: a no-op. Another group: refused.
    expect((await cups.join(me, { code: 'AMB-002' })).groupId).toBe(dtu.id);
    expect(await codeOf(() => cups.join(me, { code: 'AMB-003' }))).toBe(CompetitionCode.ALREADY_IN_GROUP);
    expect(await codeOf(() => cups.join(me, { groupId: nsut.id }))).toBe(CompetitionCode.CODE_REQUIRED);
    expect(await codeOf(() => cups.join(me, { code: 'NOPE-1' }))).toBe(CompetitionCode.CODE_INVALID);
  });

  it('a switched-off code, a draft or a finished season cannot be joined', async () => {
    const c = await cup();
    const g = await college(c, 'DTU', 'AMB-002');
    await cups.saveCode({ groupId: g.id, code: 'AMB-002', active: false });
    expect(await codeOf(async () => cups.join(await user('A'), { code: 'AMB-002' }))).toBe(CompetitionCode.CODE_INVALID);
    const draft = await cup({ slug: 'draft-cup', status: 'draft' });
    await college(draft, 'IITD', 'AMB-900');
    expect(await codeOf(async () => cups.join(await user('B'), { code: 'AMB-900' }))).toBe(CompetitionCode.CLOSED);
  });

  it('R2: a corporate league is the same structure, fully apart from the campus one', async () => {
    const campus = await cup();
    await college(campus, 'DTU', 'AMB-002');
    const corp = await cup({ slug: 'office-league-s1', segment: 'corporate', name: 'Office Prediction League', groupNoun: 'company', codeRequired: false });
    expect(corp.groupNounPlural).toBe('companies');
    const acme = await cups.saveGroup(corp.id, null, { name: 'Acme' });
    const me = await user('Riya Shah');
    await cups.join(me, { code: 'AMB-002' });
    // A player can be in one group per competition, and one competition never sees the other.
    const m = await cups.join(me, { groupId: acme.id });
    expect(m.competitionId).toBe(corp.id);
    expect((await cups.mine(me)).map((x) => x.slug).sort()).toEqual(['campus-cup-s1', 'office-league-s1']);
    expect((await cups.forHome(me)).length).toBe(2);
  });
});

describe('competitions: questions and picks (R4, R5)', () => {
  it('opens open_hours before the event and locks at its start; members only', async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    const me = await user('Shlok Dutta');
    const later = await cups.createQuestion(null, {
      competitionId: c.id,
      sportId: cricket,
      eventLabel: 'IPL Auction',
      kind: 'choice',
      prompt: 'Who goes for the most?',
      startsAt: new Date(clock.getTime() + 30 * H),
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(later.opensAt.toISOString()).toBe(new Date(clock.getTime() + 6 * H).toISOString());
    expect(await codeOf(() => cups.pick(me, later.id, { optionId: later.options[0]!.id }))).toBe(CompetitionCode.NOT_MEMBER);
    await cups.join(me, { code: 'AMB-002' });
    expect(await codeOf(() => cups.pick(me, later.id, { optionId: later.options[0]!.id }))).toBe(CompetitionCode.NOT_OPEN);
    expect((await cups.upcomingQuestions(c.id)).map((q) => q.id)).toEqual([later.id]);
    clock = new Date(clock.getTime() + 7 * H);
    expect((await cups.openQuestions(c.id)).map((q) => q.id)).toEqual([later.id]);
    await cups.pick(me, later.id, { optionId: later.options[0]!.id });
    await cups.pick(me, later.id, { optionId: later.options[1]!.id }); // changed
    expect((await cups.picksFor(me, [later.id])).get(later.id)?.optionId).toBe(later.options[1]!.id);
    clock = new Date(clock.getTime() + 24 * H);
    expect(await codeOf(() => cups.pick(me, later.id, { optionId: later.options[0]!.id }))).toBe(CompetitionCode.LOCKED);
  });

  it('R1: a Cup pick and its points never touch Floodlight predictions', async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    const me = await user('Shlok Dutta');
    await cups.join(me, { code: 'AMB-002' });
    const m = await proMatch();
    const q = await cups.createQuestion(null, { competitionId: c.id, matchId: m.id, kind: 'choice' });
    expect(q.prompt).toBe('Who wins?');
    expect(q.options.map((o) => o.label)).toEqual(['Arsenal', 'Draw', 'Chelsea']);
    await cups.pick(me, q.id, { optionId: q.options[0]!.id });
    await cups.settle(null, q.id, { optionId: q.options[0]!.id });
    expect(await prisma.predictionPick.count()).toBe(0);
    expect(await prisma.predictionPoint.count()).toBe(0);
    expect(await prisma.competitionPoint.count()).toBe(1);
    // Settling twice is refused; the ledger stays at one row.
    expect(await codeOf(() => cups.settle(null, q.id, { optionId: q.options[0]!.id }))).toBe(CompetitionCode.ALREADY_SETTLED);
  });

  it('R6: the match result settles tagged options and exact scores; an abandoned match voids', async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    const a = await user('Aarav Mehta');
    const b = await user('Ishita Kapoor');
    await cups.join(a, { code: 'AMB-002' });
    await cups.join(b, { code: 'AMB-002' });
    const m = await proMatch();
    const moment = await cups.saveMoment(c.id, null, { sportId: football, title: 'Boxing Day', multiplier: 2, startsAt: m.startsAt });
    const who = await cups.createQuestion(null, { competitionId: c.id, matchId: m.id, kind: 'choice', momentId: moment.id });
    expect(who.multiplier).toBe(2);
    const exact = await cups.createQuestion(null, { competitionId: c.id, matchId: m.id, kind: 'exact_score' });
    expect(exact.points).toBe(25);
    const free = await cups.createQuestion(null, { competitionId: c.id, matchId: m.id, kind: 'choice', prompt: 'First scorer?', options: [{ label: 'Saka' }, { label: 'Palmer' }] });
    await cups.pick(a, who.id, { optionId: who.options[0]!.id });
    await cups.pick(b, who.id, { optionId: who.options[2]!.id });
    await cups.pick(a, exact.id, { home: 2, away: 1 });
    await cups.pick(b, exact.id, { home: 1, away: 0 });
    const r = await cups.settleFromMatch(m.id, { homeScore: '2', awayScore: '1', winner: 'home' });
    expect(r).toEqual({ suggested: 2, settled: 2 });
    expect((await cups.question(free.id))?.status).toBe('open'); // untagged: waits for staff
    const pts = await prisma.competitionPoint.findMany({ orderBy: { points: 'desc' } });
    expect(pts.map((p) => [p.userId, p.points])).toEqual([
      [a, 25],
      [a, 20],
      [b, 8],
    ]);
    expect(await cups.voidOpenForMatch(m.id)).toBe(1);
  });
});

describe('competitions: boards and standing (R7)', () => {
  async function setup() {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    await college(c, 'NSUT', 'AMB-003');
    const [a, b, x, y] = [await user('Aarav Mehta'), await user('Ishita Kapoor'), await user('Tanvi Kaur'), await user('Shlok Dutta')];
    for (const u of [a, b]) await cups.join(u, { code: 'AMB-002' });
    for (const u of [x, y]) await cups.join(u, { code: 'AMB-003' });
    const q = await cups.createQuestion(null, {
      competitionId: c.id,
      sportId: cricket,
      eventLabel: '2nd Test',
      kind: 'choice',
      prompt: 'What is the result?',
      startsAt: new Date(clock.getTime() + 2 * H),
      points: 40,
      options: [{ label: 'India' }, { label: 'NZ' }],
    });
    await cups.pick(a, q.id, { optionId: q.options[0]!.id });
    await cups.pick(b, q.id, { optionId: q.options[0]!.id });
    await cups.pick(x, q.id, { optionId: q.options[0]!.id });
    await cups.pick(y, q.id, { optionId: q.options[1]!.id });
    await cups.settle(null, q.id, { optionId: q.options[0]!.id });
    return { c, a, b, x, y };
  }

  it('groups: average of the top N; players: everyone; my group; specialists', async () => {
    const { c, a, y } = await setup();
    const groups = await cups.board(c.id, y, 'groups');
    expect(groups.rows.map((r) => [r.title, r.rank, r.score, r.isMe])).toEqual([
      ['DTU', 1, 40, false],
      ['NSUT', 2, 20, true],
    ]);
    expect(groups.rows[0]!.subtitle).toBe('2 active');
    const players = await cups.board(c.id, y, 'players');
    expect(players.size).toBe(4);
    expect(players.rows.map((r) => r.rank)).toEqual([1, 1, 1, 4]);
    expect(players.rows.find((r) => r.isMe)?.title).toBe('You · Shlok D.');
    const mine = await cups.board(c.id, a, 'my_group');
    expect(mine.rows).toHaveLength(2);
    expect(mine.rows.find((r) => r.isMe)?.key).toBe(a);
    const specialists = await cups.board(c.id, a, 'specialists');
    expect(specialists.rows[0]?.title).toBe('Cricket Guru');
    expect(specialists.rows[0]?.score).toBe(40);
  });

  it('standing: group rank, the group ahead, my ranks, accuracy and share code', async () => {
    const { c, y } = await setup();
    const s = await cups.standing(c.id, y);
    expect(s).not.toBeNull();
    expect(s!.group.rank).toBe(2);
    expect(s!.ahead).toEqual({ name: 'DTU', by: 20 });
    expect(s!.groups).toBe(2);
    expect(s!.rank).toBe(4);
    expect(s!.players).toBe(4);
    expect(s!.rankInGroup).toBe(2);
    expect(s!.points).toBe(0);
    expect(s!.accuracy).toBe(0);
    expect(s!.sportsPlayed).toBe(1);
    expect(s!.shareCode).toBe('AMB-003');
    expect(s!.group.qualified).toBe(true);
    expect(await cups.standing(c.id, await user('Nobody'))).toBeNull();
  });
});

describe('competitions: reminders (R8)', () => {
  it('opened questions reach followers once; locking ones reach active members who have not picked', async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    const fan = await user('Aarav Mehta');
    const idle = await user('Ishita Kapoor');
    await cups.join(fan, { code: 'AMB-002' });
    await cups.join(idle, { code: 'AMB-002' });
    const warm = await cups.createQuestion(null, {
      competitionId: c.id,
      sportId: cricket,
      eventLabel: 'BBL',
      kind: 'choice',
      prompt: 'Who wins?',
      startsAt: new Date(clock.getTime() + 5 * H),
      options: [{ label: 'A' }, { label: 'B' }],
    });
    await cups.pick(fan, warm.id, { optionId: warm.options[0]!.id });
    await cups.sendReminders();
    // fan played cricket → told about cricket; idle never did and has no profile sport.
    expect(sent.filter((r) => r.template === 'cup.questions_open').flatMap((r) => r.userIds)).toEqual([fan]);
    sent.length = 0;
    await cups.sendReminders();
    expect(sent).toEqual([]); // once only

    await cups.createQuestion(null, {
      competitionId: c.id,
      sportId: cricket,
      eventLabel: 'BBL 2',
      kind: 'choice',
      prompt: 'Who wins?',
      startsAt: new Date(clock.getTime() + 50 * 60_000),
      options: [{ label: 'A' }, { label: 'B' }],
    });
    await cups.sendReminders();
    const locking = sent.filter((r) => r.template === 'cup.locking_soon');
    // fan is active and has not picked the new one; idle is not active.
    expect(locking.flatMap((r) => r.userIds)).toEqual([fan]);
    expect(locking[0]!.payload).toMatchObject({ count: 1 });
  });
});
