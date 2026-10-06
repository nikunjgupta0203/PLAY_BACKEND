/**
 * sport — service layer (docs/modules/02-sport.md).
 *
 * The registry that makes multi-sport real rather than aspirational. Scoring
 * rules live here as DATA, which is what keeps `if (sport === 'pickleball')`
 * out of the scoring module.
 *
 * Read-mostly, seeded from version control, cached for the process lifetime
 * (sport R1, R4).
 */
import type { Db } from '../../../platform/db.js';
import { SystemError, UserError } from '../../../platform/errors/index.js';
import { parseScoringRule, type ScoringRule } from './scoringRule.js';

export { parseScoringRule, RuleTweakError, scoringRuleSchema, TWEAK_LIMITS, tweakRule } from './scoringRule.js';
export type { RuleTweaks, ScoringRule } from './scoringRule.js';

export const SportCode = {
  SPORT_NOT_FOUND: 'SPORT_NOT_FOUND',
  /** Seed data is incomplete. A deploy problem, not something a player can fix. */
  NO_SCORING_RULE: 'NO_SCORING_RULE',
} as const;

export interface Sport {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  sortOrder: number;
}

export interface Format {
  id: string;
  sportId: string;
  key: string;
  name: string;
  teamSize: number;
}

export interface SkillBand {
  id: string;
  sportId: string;
  key: string;
  label: string;
  lowerBound: number | null;
  upperBound: number | null;
  sortOrder: number;
}

export interface SportDeps {
  db: Db;
}

/** Everything this module knows, loaded once. */
interface Registry {
  sports: Sport[];
  bySlug: Map<string, Sport>;
  byId: Map<string, Sport>;
  formats: Map<string, Format[]>;
  skillBands: Map<string, SkillBand[]>;
  /** Keyed `sportId:formatId`, with `sportId:` holding the sport-wide default. */
  scoringRules: Map<string, ScoringRule>;
}

const ruleKey = (sportId: string, formatId?: string | null) =>
  `${sportId}:${formatId ?? ''}`;

/** Decimal columns arrive as Prisma.Decimal; the domain speaks numbers. */
const num = (v: { toNumber(): number } | null): number | null =>
  v === null ? null : v.toNumber();

export function createSportService(deps: SportDeps) {
  /**
   * sport R4 — populated on first read, no TTL. This table changes on deploy,
   * not at runtime, so a per-request round trip would buy nothing.
   *
   * The promise itself is memoised rather than its result: two concurrent first
   * reads must not both load.
   */
  let loading: Promise<Registry> | null = null;

  async function load(): Promise<Registry> {
    const [sports, formats, skillBands, rules] = await Promise.all([
      deps.db.sport.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      deps.db.format.findMany({ orderBy: { name: 'asc' } }),
      deps.db.skillBand.findMany({ orderBy: { sortOrder: 'asc' } }),
      deps.db.scoringRule.findMany(),
    ]);

    const registry: Registry = {
      sports,
      bySlug: new Map(sports.map((s) => [s.slug, s])),
      byId: new Map(sports.map((s) => [s.id, s])),
      formats: new Map(),
      skillBands: new Map(),
      scoringRules: new Map(),
    };

    for (const f of formats) {
      const list = registry.formats.get(f.sportId) ?? [];
      list.push(f);
      registry.formats.set(f.sportId, list);
    }
    for (const b of skillBands) {
      const list = registry.skillBands.get(b.sportId) ?? [];
      list.push({
        id: b.id,
        sportId: b.sportId,
        key: b.key,
        label: b.label,
        lowerBound: num(b.lowerBound),
        upperBound: num(b.upperBound),
        sortOrder: b.sortOrder,
      });
      registry.skillBands.set(b.sportId, list);
    }
    for (const r of rules) {
      // Parsed on read, not trusted: jsonb has no shape and bad seed data must
      // fail loudly at boot rather than during a match.
      registry.scoringRules.set(ruleKey(r.sportId, r.formatId), parseScoringRule(r.rule));
    }

    return registry;
  }

  function registry(): Promise<Registry> {
    loading ??= load().catch((err: unknown) => {
      // A failed load must not be cached, or the process never recovers.
      loading = null;
      throw err;
    });
    return loading;
  }

  /**
   * Drops the cache. Only the seed script and tests call this — sport R4 says
   * the process lifetime is the TTL, and inserting a sport is a deploy.
   */
  function refresh(): void {
    loading = null;
  }

  /** sport R3 — soft-disabled sports are hidden here, not deleted. */
  async function list(): Promise<Sport[]> {
    const reg = await registry();
    return reg.sports.filter((s) => s.active);
  }

  /** Null rather than a throw: `Query.sport(slug:)` is a nullable field. */
  async function findBySlug(slug: string): Promise<Sport | null> {
    const reg = await registry();
    return reg.bySlug.get(slug) ?? null;
  }

  async function bySlug(slug: string): Promise<Sport> {
    const found = await findBySlug(slug);
    if (!found) {
      throw new UserError(SportCode.SPORT_NOT_FOUND, 'That sport is not available.');
    }
    return found;
  }

  /**
   * sport R3 — resolves inactive sports too. A match played two years ago must
   * keep rendering its sport after that sport is retired.
   */
  async function byId(sportId: string): Promise<Sport> {
    const reg = await registry();
    const found = reg.byId.get(sportId);
    if (!found) {
      throw new UserError(SportCode.SPORT_NOT_FOUND, 'That sport is not available.');
    }
    return found;
  }

  async function formatsFor(sportId: string): Promise<Format[]> {
    const reg = await registry();
    return reg.formats.get(sportId) ?? [];
  }

  /** sport R2 — bands are per sport. Nothing outside this module assumes a scale. */
  async function skillBandsFor(sportId: string): Promise<SkillBand[]> {
    const reg = await registry();
    return reg.skillBands.get(sportId) ?? [];
  }

  /** True when `key` is a band this sport actually defines. Used by profile R3. */
  async function hasSkillBand(sportId: string, key: string): Promise<boolean> {
    const bands = await skillBandsFor(sportId);
    return bands.some((b) => b.key === key);
  }

  /**
   * sport R5 — the ONLY source of scoring semantics. A format-specific rule
   * wins; otherwise the sport-wide default applies.
   */
  async function scoringRuleFor(sportId: string, formatId?: string): Promise<ScoringRule> {
    const reg = await registry();
    const rule =
      (formatId ? reg.scoringRules.get(ruleKey(sportId, formatId)) : undefined) ??
      reg.scoringRules.get(ruleKey(sportId, null));
    if (!rule) {
      throw new SystemError(
        SportCode.NO_SCORING_RULE,
        `No scoring rule seeded for sport ${sportId}`,
      );
    }
    return rule;
  }

  return {
    list,
    bySlug,
    findBySlug,
    byId,
    formatsFor,
    skillBandsFor,
    hasSkillBand,
    scoringRuleFor,
    refresh,
  };
}

export type SportService = ReturnType<typeof createSportService>;
