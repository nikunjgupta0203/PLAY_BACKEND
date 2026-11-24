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
  crowdPoints,
  crowdShare,
  prizeRanks,
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
  it('R5: a right choice earns its locked points × multiplier; exact score in full, right result a third', () => {
    const q = { kind: 'choice' as const, points: 10, multiplier: 1.5, correctOptionId: 'a', correctHome: null, correctAway: null };
    expect(scorePick(q, { optionId: 'a', home: null, away: null, basePoints: 14 })).toEqual({ correct: true, points: 21 });
    expect(scorePick(q, { optionId: 'b', home: null, away: null, basePoints: 6 })).toEqual({ correct: false, points: 0 });
    // A pick made before 067 (no lock) falls back to the flat points.
    expect(scorePick(q, { optionId: 'a', home: null, away: null })).toEqual({ correct: true, points: 15 });
    const e = { kind: 'exact_score' as const, points: 25, multiplier: 2, correctOptionId: null, correctHome: 2, correctAway: 1 };
    expect(scorePick(e, { optionId: null, home: 2, away: 1 })).toEqual({ correct: true, points: 50 });
    expect(scorePick(e, { optionId: null, home: 3, away: 0 })).toEqual({ correct: false, points: 16 });
    expect(scorePick(e, { optionId: null, home: 0, away: 0 })).toEqual({ correct: false, points: 0 });
  });

  it('067 R5: crowd odds: the founder examples, the even start and the 5–95% cap', () => {
    const s = { base: 20, prior: 10, minPct: 5, maxPct: 95 };
    expect(crowdPoints(0.5, 20)).toBe(10);
    expect(crowdPoints(0.32, 20)).toBe(14);
    expect(crowdPoints(0.68, 20)).toBe(6);
    // Nobody has picked: 50/50 for two answers, a third each for three.
    expect(crowdShare(0, 0, 2, s)).toBe(0.5);
    expect(crowdShare(0, 0, 3, s)).toBeCloseTo(1 / 3);
    // (picks on it + 10 / answers) / (all picks + 10): 2 of 5 picks, two answers -> 7/15.
    expect(crowdShare(2, 5, 2, s)).toBeCloseTo(7 / 15);
    // The cap keeps every right pick between 1 and 19 points.
    expect(crowdShare(0, 1000, 2, s)).toBe(0.05);
    expect(crowdShare(1000, 1000, 2, s)).toBe(0.95);
    expect(crowdPoints(0.05, 20)).toBe(19);
    expect(crowdPoints(0.95, 20)).toBe(1);
  });

  it('067 R7: equal points share a rank; prize order is exact scores, then accuracy, then the earlier pick', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 11, 1, 10, min));
    const stats = new Map([
      ['a', { exact: 0, settled: 10, correct: 5, firstPick: t(1) }],
      ['b', { exact: 1, settled: 10, correct: 2, firstPick: t(9) }],
      ['c', { exact: 0, settled: 10, correct: 8, firstPick: t(5) }],
      ['d', { exact: 0, settled: 10, correct: 8, firstPick: t(2) }],
    ]);
    const rows = prizeRanks(['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, score: key === 'e' ? 5 : 50 })), stats);
    expect(rows.map((r) => `${r.key}${r.rank}`)).toEqual(['b1', 'd1', 'c1', 'a1', 'e5']);
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

describe('competitions: entry by college, optional code (068)', () => {
  it('pick a college from the list; an ambassador code is optional and must be the college’s', async () => {
    const c = await cup({ codeRequired: false });
    const dtu = await college(c, 'DTU', 'AMB-001');
    const nsut = await college(c, 'NSUT', 'AMB-002');
    const [a, b, d] = [await user('Aarav M'), await user('Ishita K'), await user('Dev T')];
    // No code: joins, no credit.
    expect(await cups.join(a, { groupId: dtu.id })).toMatchObject({ groupId: dtu.id, code: null });
    // The college's own code: joins, and the ambassador gets the credit.
    expect(await cups.join(b, { groupId: dtu.id, code: ' amb-001 ' })).toMatchObject({ groupId: dtu.id, code: 'AMB-001' });
    // Another college's code: refused, nothing joined.
    expect(await codeOf(() => cups.join(d, { groupId: dtu.id, code: 'AMB-002' }))).toBe(CompetitionCode.CODE_WRONG_GROUP);
    expect(await codeOf(() => cups.join(d, { groupId: nsut.id, code: 'WHAT-9' }))).toBe(CompetitionCode.CODE_INVALID);
    expect(await cups.join(d, { groupId: nsut.id })).toMatchObject({ groupId: nsut.id });
  });

  it('a college that is not listed is typed in: made once, marked as added by the player, then reused', async () => {
    const c = await cup({ codeRequired: false });
    await college(c, 'DTU', 'AMB-001');
    const [a, b] = [await user('Aarav M'), await user('Ishita K')];
    const m = await cups.join(a, { competitionId: c.id, newGroup: { name: '  Amity   Noida ', city: 'Noida' } });
    const g = await prisma.competitionGroup.findUniqueOrThrow({ where: { id: m.groupId } });
    expect([g.name, g.city, g.addedByUserId]).toEqual(['Amity Noida', 'Noida', a]);
    // The same name in any case joins that group, not a second one.
    expect((await cups.join(b, { competitionId: c.id, newGroup: { name: 'AMITY NOIDA' } })).groupId).toBe(m.groupId);
    expect(await prisma.competitionGroup.count({ where: { competitionId: c.id } })).toBe(2);
    // A typed name that is a listed college joins it.
    const e = await user('Esha P');
    expect((await cups.join(e, { competitionId: c.id, newGroup: { name: 'dtu' } })).groupId).not.toBe(m.groupId);
  });

  it('typing a college: refused where a code is required, for a bad name, or once you play for another', async () => {
    const strict = await cup();
    const a = await user('Aarav M');
    expect(await codeOf(() => cups.join(a, { competitionId: strict.id, newGroup: { name: 'Amity' } }))).toBe(CompetitionCode.CODE_REQUIRED);
    const c = await cup({ slug: 'open-cup', codeRequired: false });
    const dtu = await college(c, 'DTU', 'AMB-001');
    expect(await codeOf(() => cups.join(a, { competitionId: c.id, newGroup: { name: 'A' } }))).toBe(CompetitionCode.INVALID);
    await cups.join(a, { groupId: dtu.id });
    expect(await codeOf(() => cups.join(a, { competitionId: c.id, newGroup: { name: 'Amity' } }))).toBe(CompetitionCode.ALREADY_IN_GROUP);
    // Nothing was made for the refused attempts.
    expect(await prisma.competitionGroup.count({ where: { competitionId: c.id, addedByUserId: { not: null } } })).toBe(0);
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
    // a backed the home side first (a third of the crowd): round(20 x 2/3) = 13, x 2 for the moment.
    expect(pts.map((p) => [p.userId, p.points])).toEqual([
      [a, 26],
      [a, 25],
      [b, 8],
    ]);
    expect(await cups.voidOpenForMatch(m.id)).toBe(1);
  });
});

describe('competitions: crowd scoring (067)', () => {
  async function twoWay(c: Competition) {
    return cups.createQuestion(null, {
      competitionId: c.id,
      sportId: cricket,
      eventLabel: 'T20 · MI v CSK',
      kind: 'choice',
      prompt: 'Who wins?',
      startsAt: new Date(clock.getTime() + 2 * H),
      options: [{ label: 'MI' }, { label: 'CSK' }],
    });
  }

  it('locks the share at the pick (own pick not counted); the same answer again keeps the lock; a switch re-prices', async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    const [a, b, d] = [await user('Aarav M'), await user('Ishita K'), await user('Dev T')];
    for (const u of [a, b, d]) await cups.join(u, { code: 'AMB-002' });
    const q = await twoWay(c);
    const [mi, csk] = q.options.map((o) => o.id) as [string, string];
    const first = await cups.pick(a, q.id, { optionId: mi });
    expect([first.crowdShare, first.basePoints]).toEqual([0.5, 10]);
    await cups.pick(b, q.id, { optionId: mi });
    await cups.pick(d, q.id, { optionId: mi });
    // Re-tapping MI never re-prices a's pick, though MI is now the favourite.
    expect((await cups.pick(a, q.id, { optionId: mi })).basePoints).toBe(10);
    // Switching to CSK does: the others are 2 on MI, 0 on CSK -> (0 + 5) / 12.
    const switched = await cups.pick(a, q.id, { optionId: csk });
    expect(switched.crowdShare).toBeCloseTo(0.4167, 3);
    expect(switched.basePoints).toBe(12);
    // The crowd a viewer sees leaves their own pick out.
    const crowd = (await cups.crowdFor([q.id], d)).get(q.id)!;
    expect(crowd.get(mi)).toBeCloseTo((1 + 5) / 12);
  });

  it("a deactivated player's picks do not move the crowd", async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    const [a, gone] = [await user('Aarav M'), await user('Gone G')];
    for (const u of [a, gone]) await cups.join(u, { code: 'AMB-002' });
    const q = await twoWay(c);
    await cups.pick(gone, q.id, { optionId: q.options[0]!.id });
    await prisma.user.update({ where: { id: gone }, data: { status: 'deactivated' } });
    expect((await cups.pick(a, q.id, { optionId: q.options[0]!.id })).crowdShare).toBe(0.5);
  });

  it('settings are copied onto each question, so a change mid-season only affects new ones', async () => {
    const c = await cup();
    const before = await twoWay(c);
    await cups.saveCompetition(null, c.id, { ...c, crowdBase: 30, crowdPrior: 4 });
    const after = await twoWay(c);
    expect(before.crowd).toMatchObject({ base: 20, prior: 10 });
    expect(after.crowd).toMatchObject({ base: 30, prior: 4 });
  });

  it('exact scores are football only; extra time and penalties wait for staff', async () => {
    const c = await cup();
    await college(c, 'DTU', 'AMB-002');
    expect(
      await codeOf(() =>
        cups.createQuestion(null, { competitionId: c.id, sportId: cricket, eventLabel: 'Test', kind: 'exact_score', startsAt: new Date(clock.getTime() + 2 * H) }),
      ),
    ).toBe(CompetitionCode.INVALID);
    const me = await user('Aarav M');
    await cups.join(me, { code: 'AMB-002' });
    const m = await proMatch();
    const exact = await cups.createQuestion(null, { competitionId: c.id, matchId: m.id, kind: 'exact_score' });
    await cups.pick(me, exact.id, { home: 1, away: 1 });
    expect(await cups.settleFromMatch(m.id, { homeScore: '2', awayScore: '1', winner: 'home', afterExtraTime: true })).toEqual({ suggested: 0, settled: 0 });
    expect((await cups.question(exact.id))?.status).toBe('open');
  });

  it('a specialist title needs the minimum picks in that sport', async () => {
    const c = await cup({ specialistMinPicks: 2 });
    await college(c, 'DTU', 'AMB-002');
    const me = await user('Aarav M');
    await cups.join(me, { code: 'AMB-002' });
    const q = await twoWay(c);
    await cups.pick(me, q.id, { optionId: q.options[0]!.id });
    await cups.settle(null, q.id, { optionId: q.options[0]!.id });
    const one = await cups.board(c.id, me, 'specialists');
    expect(one.rows[0]?.subtitle).toBe('No one with 2+ picks yet');
    const q2 = await twoWay(c);
    await cups.pick(me, q2.id, { optionId: q2.options[0]!.id });
    await cups.settle(null, q2.id, { optionId: q2.options[0]!.id });
    expect((await cups.board(c.id, me, 'specialists')).rows[0]?.subtitle).toMatch(/^You · DTU/);
  });
});

describe('competitions: boards and standing (R7)', () => {
  async function setup() {
    const c = await cup({ specialistMinPicks: 1 });
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
    // Crowd odds as the picks came in: a 50% -> 10, b 55% -> 9, x 58% -> 8; y backed NZ and missed.
    // DTU (10 + 9) / 2 = 9.5 -> 10; NSUT (8 + 0) / 2 = 4.
    expect(groups.rows.map((r) => [r.title, r.rank, r.score, r.isMe])).toEqual([
      ['DTU', 1, 10, false],
      ['NSUT', 2, 4, true],
    ]);
    expect(groups.rows[0]!.subtitle).toBe('2 active');
    const players = await cups.board(c.id, y, 'players');
    expect(players.size).toBe(4);
    expect(players.rows.map((r) => [r.rank, r.score])).toEqual([
      [1, 10],
      [2, 9],
      [3, 8],
      [4, 0],
    ]);
    expect(players.rows.find((r) => r.isMe)?.title).toBe('You · Shlok D.');
    const mine = await cups.board(c.id, a, 'my_group');
    expect(mine.rows).toHaveLength(2);
    expect(mine.rows.find((r) => r.isMe)?.key).toBe(a);
    const specialists = await cups.board(c.id, a, 'specialists');
    expect(specialists.rows[0]?.title).toBe('Cricket Guru');
    expect(specialists.rows[0]?.score).toBe(10);
  });

  it('standing: group rank, the group ahead, my ranks, accuracy and share code', async () => {
    const { c, y } = await setup();
    const s = await cups.standing(c.id, y);
    expect(s).not.toBeNull();
    expect(s!.group.rank).toBe(2);
    expect(s!.ahead).toEqual({ name: 'DTU', by: 6 });
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
