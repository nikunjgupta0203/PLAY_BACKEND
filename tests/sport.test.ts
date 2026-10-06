/**
 * sport — service tests against a real Postgres (conventions.md §5).
 * Every numbered rule has at least one test that names it, so `grep 'R5:'`
 * finds the test for sport R5.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { scoringRuleSchema, type ScoringRule } from '../src/modules/sport/service/scoringRule.js';
import { KABADDI, LAUNCH_SPORTS, PADEL, PICKLEBALL, SQUASH, VOLLEYBALL, seedSport, type SportSeed } from '../src/modules/sport/seed.js';

/** The fixtures below are all rally-family; this just gets TS's narrowing to agree. */
function asRally(rule: ScoringRule): Extract<ScoringRule, { kind: 'rally' }> {
  if (rule.kind !== 'rally') throw new Error(`expected rally scoring, got ${rule.kind}`);
  return rule;
}

/**
 * The **Done when** foil. Different scoring, same doubles structure — chosen so
 * that anything hard-coded for pickleball shows up rather than coincidentally
 * working.
 */
const BADMINTON: SportSeed = {
  slug: 'badminton',
  name: 'Badminton',
  sortOrder: 1,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
  ],
  // Not a DUPR ladder. Nothing outside the module may assume one (R2).
  skillBands: [
    { key: 'beginner', label: 'Beginner', lowerBound: null, upperBound: null },
    { key: 'intermediate', label: 'Intermediate', lowerBound: null, upperBound: null },
    { key: 'advanced', label: 'Advanced', lowerBound: null, upperBound: null },
  ],
  scoringRule: {
    kind: 'rally',
    pointsToWin: 21,
    winBy: 2,
    hardCap: 30,
    gamesToWin: 2,
    serveModel: 'rally',
    switchEndsAt: 11,
  },
};

let prisma: PrismaClient;
let sport: SportService;

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  sport = buildModules(prisma).sport;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  // R4's cache has no TTL by design, so a truncating suite must drop it.
  sport.refresh();
  await seedSport(prisma, PICKLEBALL);
  sport.refresh();
});

describe('sport', () => {
  it('R1: the seed is idempotent — re-running it does not duplicate rows', async () => {
    await seedSport(prisma, PICKLEBALL);
    await seedSport(prisma, PICKLEBALL);

    expect(await prisma.sport.count()).toBe(1);
    expect(await prisma.format.count()).toBe(PICKLEBALL.formats.length);
    expect(await prisma.skillBand.count()).toBe(PICKLEBALL.skillBands.length);
    expect(await prisma.scoringRule.count()).toBe(1);
  });

  it('R1: bad seed data is rejected before it reaches the jsonb column', async () => {
    await expect(
      seedSport(prisma, {
        ...BADMINTON,
        // A cap below the target is unreachable — a typo that would otherwise
        // only surface mid-match.
        scoringRule: { ...asRally(BADMINTON.scoringRule), hardCap: 15 },
      }),
    ).rejects.toThrow();
  });

  it('R2: every launch sport offers the same 2.5–5.0+ ladder (issue log 2026-10-06 #5)', () => {
    for (const s of LAUNCH_SPORTS) {
      expect(s.skillBands.map((b) => b.key), s.slug).toEqual(['2.5', '3.0', '3.5', '4.0', '4.5', '5.0+']);
    }
  });

  it('R2: skill bands are per sport, and one sport\'s ladder is not the other\'s', async () => {
    await seedSport(prisma, BADMINTON);
    sport.refresh();

    const pickleball = await sport.bySlug('pickleball');
    const badminton = await sport.bySlug('badminton');

    const pickleballKeys = (await sport.skillBandsFor(pickleball.id)).map((b) => b.key);
    const badmintonKeys = (await sport.skillBandsFor(badminton.id)).map((b) => b.key);

    expect(pickleballKeys).toEqual(['2.5', '3.0', '3.5', '4.0', '4.5', '5.0+']);
    expect(badmintonKeys).toEqual(['beginner', 'intermediate', 'advanced']);
    expect(pickleballKeys.some((k) => badmintonKeys.includes(k))).toBe(false);

    // And a band from one sport is not valid for the other.
    expect(await sport.hasSkillBand(badminton.id, '3.5')).toBe(false);
    expect(await sport.hasSkillBand(pickleball.id, '3.5')).toBe(true);
  });

  it('R3: a retired sport disappears from the list but still resolves by id', async () => {
    const pickleball = await sport.bySlug('pickleball');
    await prisma.sport.update({ where: { id: pickleball.id }, data: { active: false } });
    sport.refresh();

    expect(await sport.list()).toEqual([]);
    // A match played last season must keep rendering its sport.
    await expect(sport.byId(pickleball.id)).resolves.toMatchObject({ slug: 'pickleball' });
  });

  it('R4: reads are served from cache — a write behind its back is not seen', async () => {
    const before = await sport.list();
    expect(before).toHaveLength(1);

    await seedSport(prisma, BADMINTON);

    // No refresh(): the cache has no TTL, because this table changes on deploy.
    expect(await sport.list()).toHaveLength(1);
    sport.refresh();
    expect(await sport.list()).toHaveLength(2);
  });

  it('R5: scoringRuleFor is the only source of scoring semantics', async () => {
    const pickleball = await sport.bySlug('pickleball');
    const rule = await sport.scoringRuleFor(pickleball.id);

    expect(rule).toEqual(PICKLEBALL.scoringRule);
    // Everything scoring needs is data on this document — no slug appears.
    expect(scoringRuleSchema.parse(rule)).toBeTruthy();
    expect(JSON.stringify(rule)).not.toContain('pickleball');
  });

  it('R5: a format-specific rule wins over the sport default', async () => {
    const singlesRule = { ...PICKLEBALL.scoringRule, gamesToWin: 1 };
    await seedSport(prisma, {
      ...PICKLEBALL,
      formats: PICKLEBALL.formats.map((f) =>
        f.key === 'singles' ? { ...f, scoringRule: singlesRule } : f,
      ),
    });
    sport.refresh();

    const pickleball = await sport.bySlug('pickleball');
    const formats = await sport.formatsFor(pickleball.id);
    const singles = formats.find((f) => f.key === 'singles');
    const doubles = formats.find((f) => f.key === 'doubles');

    expect(await sport.scoringRuleFor(pickleball.id, singles?.id)).toMatchObject({
      gamesToWin: 1,
    });
    expect(await sport.scoringRuleFor(pickleball.id, doubles?.id)).toMatchObject({
      gamesToWin: 2,
    });
  });

  it('R5: a sport with no seeded rule raises NO_SCORING_RULE, not a default', async () => {
    const orphan = await prisma.sport.create({
      data: { id: crypto.randomUUID(), slug: 'orphan', name: 'Orphan' },
    });
    sport.refresh();

    await expect(sport.scoringRuleFor(orphan.id)).rejects.toMatchObject({
      extensions: { code: 'NO_SCORING_RULE' },
    });
  });

  it('an unknown slug is SPORT_NOT_FOUND through bySlug and null through findBySlug', async () => {
    await expect(sport.bySlug('kabaddi')).rejects.toMatchObject({
      code: 'SPORT_NOT_FOUND',
    });
    expect(await sport.findBySlug('kabaddi')).toBeNull();
  });

  /**
   * The module's **Done when**: a second sport is an INSERT, not a code change.
   * Run once with a throwaway sport rather than discovering the problem in
   * year two. The row is deleted afterwards; the test stays.
   */
  it('Done when: a second sport works end to end with zero code changes', async () => {
    const badmintonId = await seedSport(prisma, BADMINTON);
    sport.refresh();

    // Discovery: it appears in the sport list, in order.
    const listed = await sport.list();
    expect(listed.map((s) => s.slug)).toEqual(['pickleball', 'badminton']);

    // Event creation: its formats are available and carry their own team sizes.
    const formats = await sport.formatsFor(badmintonId);
    expect(formats.map((f) => f.key).sort()).toEqual(['doubles', 'singles']);
    expect(formats.find((f) => f.key === 'doubles')?.teamSize).toBe(2);

    // Profile sport selection: its bands are available and validated per sport.
    expect(await sport.hasSkillBand(badmintonId, 'advanced')).toBe(true);

    // Scoring: entirely different semantics, no branch anywhere.
    const rule = await sport.scoringRuleFor(badmintonId);
    expect(rule).toMatchObject({ pointsToWin: 21, hardCap: 30, switchEndsAt: 11 });
    expect(asRally(rule).decidingGame).toBeUndefined();

    // Clean up the throwaway row (the fixture, not the test, is disposable).
    await prisma.scoringRule.deleteMany({ where: { sportId: badmintonId } });
    await prisma.skillBand.deleteMany({ where: { sportId: badmintonId } });
    await prisma.format.deleteMany({ where: { sportId: badmintonId } });
    await prisma.sport.delete({ where: { id: badmintonId } });
    sport.refresh();

    expect((await sport.list()).map((s) => s.slug)).toEqual(['pickleball']);
  });

  it('sport R1: volleyball, squash, padel and kabaddi are seed rows with their own rules', async () => {
    for (const seed of [VOLLEYBALL, SQUASH, PADEL, KABADDI]) await seedSport(prisma, seed);
    sport.refresh();
    for (const slug of ['volleyball', 'squash', 'padel', 'kabaddi']) {
      const s = await sport.bySlug(slug);
      const rule = await sport.scoringRuleFor(s.id);
      expect(rule.kind).toBe({ volleyball: 'rally', squash: 'rally', padel: 'sets', kabaddi: 'goals' }[slug]);
    }
    const volleyball = await sport.bySlug('volleyball');
    const beach = (await sport.formatsFor(volleyball.id)).find((f) => f.key === 'beach')!;
    expect(await sport.scoringRuleFor(volleyball.id, beach.id)).toMatchObject({ pointsToWin: 21, gamesToWin: 2 });
  });
});
