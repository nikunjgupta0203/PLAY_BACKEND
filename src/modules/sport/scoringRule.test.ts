import { describe, expect, it } from 'vitest';
import { parseScoringRule, RuleTweakError, tweakRule } from './service/scoringRule.js';
import { BASKETBALL, FOOTBALL, KABADDI, PADEL, PICKLEBALL, SQUASH, VOLLEYBALL } from './seed.js';

describe('scoring rule shapes (sport R5)', () => {
  it('sport R5: every launch rule parses, including format overrides', () => {
    for (const s of [VOLLEYBALL, SQUASH, PADEL, KABADDI, BASKETBALL, FOOTBALL]) {
      expect(() => parseScoringRule(s.scoringRule)).not.toThrow();
      for (const f of s.formats) if (f.scoringRule) expect(() => parseScoringRule(f.scoringRule)).not.toThrow();
    }
  });

  it('sport R5: goals actions need unique keys and positive values', () => {
    const base = { kind: 'goals', periods: 2, periodMinutes: 20, tiebreaker: 'none', extraPeriodMinutes: null };
    expect(() =>
      parseScoringRule({ ...base, actions: [{ key: 'goal', label: 'Goal', value: 1 }, { key: 'goal', label: 'Goal', value: 2 }] }),
    ).toThrow(/unique/);
    expect(() => parseScoringRule({ ...base, actions: [{ key: 'goal', label: 'Goal', value: 0 }] })).toThrow();
  });

  it('sport R5: a match tiebreak needs a real target', () => {
    const padel = { ...PADEL.scoringRule, finalSetMatchTiebreak: { pointsToWin: 0, winBy: 2 } };
    expect(() => parseScoringRule(padel)).toThrow();
  });
});

describe('every launch sport (sport R1, R5)', () => {
  it('sport R5: every seeded rule and format override parses', async () => {
    const { LAUNCH_SPORTS } = await import('./seed.js');
    for (const s of LAUNCH_SPORTS) {
      expect(() => parseScoringRule(s.scoringRule), s.slug).not.toThrow();
      for (const f of s.formats) if (f.scoringRule) expect(() => parseScoringRule(f.scoringRule), `${s.slug}/${f.key}`).not.toThrow();
    }
  });
});

describe('F21 — a host’s match format (tweakRule)', () => {
  const pickleball = parseScoringRule(PICKLEBALL.scoringRule);

  it('one game is played to the points the host sees, not to the deciding game’s', () => {
    const one = tweakRule(pickleball, { gamesToWin: 1 });
    expect(one).toMatchObject({ kind: 'rally', gamesToWin: 1, pointsToWin: 11 });
    expect(one).not.toHaveProperty('decidingGame');
  });

  it('shorter games keep a deciding game no longer than the others, and a cap that fits', () => {
    const r = tweakRule(pickleball, { pointsToWin: 7 }) as { pointsToWin: number; hardCap: number; decidingGame?: { pointsToWin: number } };
    expect(r.pointsToWin).toBe(7);
    expect(r.decidingGame?.pointsToWin).toBe(7);
    expect(r.hardCap).toBeGreaterThanOrEqual(7);
  });

  it('refuses a knob the sport is not scored by, and numbers out of range', () => {
    expect(() => tweakRule(pickleball, { periodMinutes: 20 })).toThrow(RuleTweakError);
    expect(() => tweakRule(pickleball, { pointsToWin: 99 })).toThrow(RuleTweakError);
  });

  it('changes nothing when the host changed nothing', () => {
    expect(tweakRule(pickleball, {})).toBe(pickleball);
  });
});
