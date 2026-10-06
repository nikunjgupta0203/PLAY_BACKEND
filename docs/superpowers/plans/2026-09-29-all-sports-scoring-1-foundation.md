# All-Sports Scoring, Plan 1: Typed Score Events + Rally/Sets/Goals Sports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score volleyball, squash, padel, kabaddi, and live football and basketball (with overtime and penalty shootouts), end to end, by teaching the engine typed score events instead of only "a point to side A or B".

**Architecture:** The engine stays a pure function over a complete score (scoring R3), with the only switch on `rule.kind` (scoring R4). A new `applyEvent(state, event, rule)` takes a typed event: `point`, `score` (with a named action worth N points), `period_end`, `shootout_kick`. The existing `applyPoint` becomes `applyEvent(state, { type: 'point', side }, rule)`. The goals family gains named score actions, periods, extra-time blocks and a shootout. The sets family gains a match tiebreak in place of the deciding set. Four new sports are seed rows only. The server stores the event next to the full state it produced, and a new `recordScoreEvent` mutation takes it. The app keeps its copy of the engine in step through a shared set of golden fixtures that both repos test against.

**Tech Stack:** Backend: TypeScript, Zod, Prisma 5 + Postgres, Pothos GraphQL, Vitest. App: Expo / React Native, Jest.

**Spec:** `PALY_BACKEND/docs/superpowers/specs/2026-09-29-all-sports-scoring-design.md` (Phase 0 foundation, as far as rally/sets/goals need it, plus Phase 1 "Free wins"). Rules text for every sport: the published demo `https://claude.ai/artifact/SdF2y2WjQyQ3Gz8tJ9zacr` ("How scoring works" panel).

## Where this sits (the full roadmap)

The spec's 8 phases become 8 plans. Each one ships working, tested software on its own. This is Plan 1. Write each later plan when its turn comes, against the code as it is then.

| Plan | Delivers | Depends on |
|---|---|---|
| **1 (this)** | Typed score events; goals actions, periods, extra time, shootout; sets match tiebreak; volleyball, squash, padel, kabaddi seeds; app engine parity | — |
| 2 | App scoring pads for goals (action buttons, End period, shootout) and padel/tennis point calls (15/30/40, Deuce, AD) | 1 |
| 3 | Results with no winner: `draw`, `tie`, `no_result`; `method` and `margin` columns; draws allowed only in league / round-robin stages; rating scores a draw 0.5 | 1 |
| 4 | Cricket: `innings` family, ball-by-ball events, batting and bowling cards, super over | 1, 3 |
| 5 | `series` family: snooker, pool, billiards, carrom, chess (with a Swiss stage), map-based esports | 1, 3 |
| 6 | `bouts` family: judge cards with a `judge` grant, points bouts with point-gap stops, finish methods | 1, 3 |
| 7 | Field contests: `heats` tables, heats→final and leaderboard stages, `performance` family (running, cycling, swimming, athletics, lifting, calisthenics, gym, battle royale), CSV import | 1 |
| 8 | `scorecard` family: golf (course par from venues), bowling, archery | 7 |

## Global Constraints

- **scoring R4:** no branch on a sport anywhere in `scoring/`. The only switch is on `rule.kind`. `grep -rn "pickleball\|volleyball\|kabaddi\|padel\|squash" src/modules/scoring --include=*.ts` must match only test files.
- **scoring R3:** every event's `state_after` is the complete score. The event itself is stored alongside for the timeline and stats, never as a delta to replay.
- **sport R1:** every sport, format and rule is seed data. A new sport is an entry in `src/modules/sport/seed.ts` plus `pnpm seed`, with zero code changes elsewhere.
- **sport R5:** new concepts are fields on the rule document (`scoringRuleSchema`), validated by Zod on seed.
- Stored states from before this plan (no `period`, no `shootout`, no `matchTiebreak` fields) must keep working: every new `ScoreState` field is optional and read with a default.
- `recordPoint` and its GraphQL mutation keep working unchanged for existing clients.
- Rule values for the new sports (copied into seeds exactly):
  - Volleyball indoor: rally, 25 points, win by 2, no cap, best of 5, deciding set to 15 (no cap). Beach format: 21 points, best of 3, deciding set to 15.
  - Squash: rally (PAR), 11 points, win by 2, no cap, best of 5.
  - Padel: sets, games to 4 points with golden point (`gameWinBy: 1`), set to 6 by 2, tiebreak at 6–6 to 7 by 2, best of 3, match tiebreak to 10 by 2 instead of a third set.
  - Kabaddi: goals, 2 periods of 20 minutes, league default `tiebreaker: 'none'`; actions Raid +1, Raid +2, Raid +3, Bonus +1, Tackle +1, Super tackle +2, All out +2.
  - Basketball: actions Free throw +1, 2 points +2, 3 points +3; 4 × 10 min; overtime blocks of 1 period × 5 min, repeated until someone leads.
  - Football: action Goal +1; 2 × 45; extra time block of 2 periods × 15 min, then a penalty shootout (5 kicks each, stops when one side can't catch up, then sudden death).
- Every test names the rule it proves (`scoring R4:` …).

## Review Focus

1. **A state stored before this plan** (no `period` field) takes a new `period_end` event without crashing: it is treated as period 1. Covered in Task 2.
2. **A score action the rule doesn't have** (a `3pt` sent to a football match): rejected as input, and nothing is stored. Covered in Tasks 2 and 4.
3. **A shootout kick from the wrong team** (the same team kicking twice in a row): rejected. Covered in Task 2.
4. **Football level after the first half of extra time:** play continues to the second half of extra time instead of ending or going to penalties. Covered in Task 2.
5. **The app and server disagreeing on a new event** (for example, a basketball overtime): both repos run the same fixtures file, so a drift fails a test in whichever repo changed. Covered in Task 5.

---

### Task 1: Rule shapes for score actions, extra time and the match tiebreak, plus four new sports

**Repo:** `PALY_BACKEND`

**Files:**
- Modify: `src/modules/sport/service/scoringRule.ts`
- Modify: `src/modules/sport/seed.ts`
- Test: `tests/sport.test.ts`, `src/modules/sport/scoringRule.test.ts` (create if absent; check `ls src/modules/sport` first and add to an existing rule test file if one exists)

**Interfaces:**
- Produces (used by Task 2):
  - goals rule fields: `actions?: { key: string; label: string; value: number }[]`, `extraPeriods?: number`, `repeatExtraPeriods?: boolean`
  - sets rule field: `finalSetMatchTiebreak?: { pointsToWin: number; winBy: number } | null`
  - exported seeds `VOLLEYBALL`, `SQUASH`, `PADEL`, `KABADDI`, all in `LAUNCH_SPORTS`

- [ ] **Step 1: Write the failing tests**

Rule-schema tests (`src/modules/sport/scoringRule.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { parseScoringRule } from './service/scoringRule.js';
import { BASKETBALL, FOOTBALL, KABADDI, PADEL, SQUASH, VOLLEYBALL } from './seed.js';

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
```

Multi-sport acceptance (`tests/sport.test.ts`), add:

```ts
  it('sport R1: volleyball, squash, padel and kabaddi are seed rows with their own rules', async () => {
    for (const slug of ['volleyball', 'squash', 'padel', 'kabaddi']) {
      const s = await sport.bySlug(slug);
      const rule = await sport.scoringRuleFor(s.id);
      expect(rule.kind).toBe({ volleyball: 'rally', squash: 'rally', padel: 'sets', kabaddi: 'goals' }[slug]);
    }
    const volleyball = await sport.bySlug('volleyball');
    const beach = (await sport.formatsFor(volleyball.id)).find((f) => f.key === 'beach')!;
    expect(await sport.scoringRuleFor(volleyball.id, beach.id)).toMatchObject({ pointsToWin: 21, gamesToWin: 2 });
  });
```

(Use whatever variable the file already uses for the sport service and seeding in its `beforeAll`; the file's existing multi-sport acceptance test shows it.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/sport tests/sport.test.ts`
Expected: FAIL — `VOLLEYBALL` etc. are not exported, and unknown keys (`actions`, `finalSetMatchTiebreak`) are rejected by `.strict()`.

- [ ] **Step 3: Extend the rule schema**

In `src/modules/sport/service/scoringRule.ts`:

Add to `setsRule` (inside `z.object({ … })`, before `.strict()`):

```ts
    /**
     * A tiebreak game in place of the deciding set: padel and many club formats
     * play a "super tiebreak" to 10, win by 2, at one set all. Absent/null = play the set.
     */
    finalSetMatchTiebreak: z.object({ pointsToWin: count, winBy: z.number().int().min(1) }).strict().nullable().optional(),
```

Replace `goalsRule` with:

```ts
const scoreAction = z
  .object({
    /** Stable id stored on the event: 'goal', 'three', 'raid', 'super_tackle'. */
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** What the scorer's button says. */
    label: z.string().min(1).max(24),
    value: count,
  })
  .strict();

/** A running score over a clock, in periods. Football, hockey, basketball, kabaddi. */
const goalsRule = z
  .object({
    kind: z.literal('goals'),
    periods: count,
    periodMinutes: count,
    /** How a level match resolves when the format requires a winner (knockout play). */
    tiebreaker: z.enum(['extra_period', 'shootout', 'extra_period_then_shootout', 'none']),
    /** Required unless tiebreaker is 'none' or 'shootout'. */
    extraPeriodMinutes: count.nullable(),
    /** What a score can be worth, and what to call it. Absent = one action, Goal +1. */
    actions: z.array(scoreAction).min(1).optional(),
    /** Periods in one block of extra time: 2 halves in football, 1 overtime in basketball. Absent = 2. */
    extraPeriods: count.optional(),
    /** Basketball: play another block while still level. Absent = false. */
    repeatExtraPeriods: z.boolean().optional(),
  })
  .strict();
```

In `superRefine`, inside `if (rule.kind === 'goals') { … }`, add:

```ts
      const keys = (rule.actions ?? []).map((a) => a.key);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions'], message: 'action keys must be unique' });
      }
```

Update the file's top comment list of families: goals now covers kabaddi, and sets covers padel.

- [ ] **Step 4: Add the seeds**

In `src/modules/sport/seed.ts`, add before `LAUNCH_SPORTS` (skill bands follow the existing qualitative ladder; copy the `beginner / intermediate / advanced / open` block from `TENNIS`):

```ts
const QUALITATIVE_BANDS: SkillBandSeed[] = [
  { key: 'beginner', label: 'Beginner', lowerBound: null, upperBound: null },
  { key: 'intermediate', label: 'Intermediate', lowerBound: null, upperBound: null },
  { key: 'advanced', label: 'Advanced', lowerBound: null, upperBound: null },
  { key: 'open', label: 'Open', lowerBound: null, upperBound: null },
];

export const VOLLEYBALL: SportSeed = {
  slug: 'volleyball',
  name: 'Volleyball',
  sortOrder: 6,
  formats: [
    { key: 'indoor', name: 'Indoor 6v6', teamSize: 6 },
    {
      key: 'beach',
      name: 'Beach 2v2',
      teamSize: 2,
      // FIVB beach: sets to 21, best of 3, deciding set to 15.
      scoringRule: { kind: 'rally', pointsToWin: 21, winBy: 2, hardCap: null, gamesToWin: 2, serveModel: 'rally', decidingGame: { pointsToWin: 15, hardCap: null } },
    },
  ],
  skillBands: QUALITATIVE_BANDS,
  // FIVB indoor: sets to 25, win by 2, best of 5, the fifth to 15.
  scoringRule: { kind: 'rally', pointsToWin: 25, winBy: 2, hardCap: null, gamesToWin: 3, serveModel: 'rally', decidingGame: { pointsToWin: 15, hardCap: null } },
};

export const SQUASH: SportSeed = {
  slug: 'squash',
  name: 'Squash',
  sortOrder: 7,
  formats: [
    { key: 'singles', name: 'Singles', teamSize: 1 },
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
  ],
  skillBands: QUALITATIVE_BANDS,
  // World Squash PAR-11: every rally scores, 10–10 needs 2 clear, best of 5.
  scoringRule: { kind: 'rally', pointsToWin: 11, winBy: 2, hardCap: null, gamesToWin: 3, serveModel: 'rally' },
};

export const PADEL: SportSeed = {
  slug: 'padel',
  name: 'Padel',
  sortOrder: 8,
  formats: [
    { key: 'doubles', name: 'Doubles', teamSize: 2 },
    { key: 'mixed_doubles', name: 'Mixed Doubles', teamSize: 2 },
  ],
  skillBands: QUALITATIVE_BANDS,
  // FIP club play: golden point at deuce (gameWinBy 1), tiebreak at 6–6,
  // super tiebreak to 10 instead of a third set.
  scoringRule: {
    kind: 'sets',
    gamePointsToWin: 4,
    gameWinBy: 1,
    setGamesToWin: 6,
    setWinBy: 2,
    setsToWin: 2,
    setTiebreakAt: 6,
    tiebreakPointsToWin: 7,
    tiebreakWinBy: 2,
    finalSetIsFullSet: false,
    finalSetMatchTiebreak: { pointsToWin: 10, winBy: 2 },
  },
};

export const KABADDI: SportSeed = {
  slug: 'kabaddi',
  name: 'Kabaddi',
  sortOrder: 9,
  formats: [{ key: 'standard', name: 'Standard (7-a-side)', teamSize: 7 }],
  skillBands: QUALITATIVE_BANDS,
  scoringRule: {
    kind: 'goals',
    periods: 2,
    periodMinutes: 20,
    // League play takes the draw; a knockout format overrides this.
    tiebreaker: 'none',
    extraPeriodMinutes: null,
    actions: [
      { key: 'raid_1', label: 'Raid +1', value: 1 },
      { key: 'raid_2', label: 'Raid +2', value: 2 },
      { key: 'raid_3', label: 'Raid +3', value: 3 },
      { key: 'bonus', label: 'Bonus +1', value: 1 },
      { key: 'tackle', label: 'Tackle +1', value: 1 },
      { key: 'super_tackle', label: 'Super tackle +2', value: 2 },
      { key: 'all_out', label: 'All out +2', value: 2 },
    ],
  },
};
```

Update the two existing goals seeds:

```ts
  // FOOTBALL.scoringRule
  scoringRule: {
    kind: 'goals',
    periods: 2,
    periodMinutes: 45,
    tiebreaker: 'extra_period_then_shootout',
    extraPeriodMinutes: 15,
    extraPeriods: 2,
    actions: [{ key: 'goal', label: 'Goal', value: 1 }],
  },
```

```ts
  // BASKETBALL.scoringRule
  scoringRule: {
    kind: 'goals',
    periods: 4,
    periodMinutes: 10,
    tiebreaker: 'extra_period',
    extraPeriodMinutes: 5,
    extraPeriods: 1,
    repeatExtraPeriods: true,
    actions: [
      { key: 'free_throw', label: 'Free throw', value: 1 },
      { key: 'two', label: '2 points', value: 2 },
      { key: 'three', label: '3 points', value: 3 },
    ],
  },
```

Append the four new seeds to `LAUNCH_SPORTS` after `BASKETBALL`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/modules/sport tests/sport.test.ts`
Expected: all PASS.

- [ ] **Step 6: Run the whole suite (seeds feed other modules' tests)**

Run: `npm test`
Expected: all PASS. If a test counts sports or lists slugs (for example Explore filters or ranking tabs), update its expected list to include the four new slugs; that is the point of sport R1, not a regression.

- [ ] **Step 7: Commit**

```bash
git add src/modules/sport tests/sport.test.ts
git commit -m "feat(sport): score actions, extra-time blocks and match tiebreak in the rule; volleyball, squash, padel, kabaddi"
```

---

### Task 2: The engine takes typed events

**Repo:** `PALY_BACKEND`

**Files:**
- Modify: `src/modules/scoring/engine.ts`
- Test: `src/modules/scoring/engine.test.ts`
- Create: `src/modules/scoring/fixtures/engine-fixtures.json` (golden fixtures, shared with the app in Task 5)
- Create: `src/modules/scoring/fixtures.test.ts`

**Interfaces:**
- Consumes: rule fields from Task 1.
- Produces (used by Tasks 3–5):
  ```ts
  export type ScoreEvent =
    | { type: 'point'; side: Side }
    | { type: 'score'; side: Side; action: string }
    | { type: 'period_end' }
    | { type: 'shootout_kick'; side: Side; scored: boolean };
  export function applyEvent(state: ScoreState, event: ScoreEvent, rule: ScoringRule): ScoreState;
  export function actionsOf(rule: Extract<ScoringRule, { kind: 'goals' }>): { key: string; label: string; value: number }[];
  // ScoreState gains optional fields:
  //   period?: number                               (goals: 1-based; absent = 1)
  //   shootout?: { a: boolean[]; b: boolean[] } | null  (goals: kicks taken)
  //   matchTiebreak?: boolean                        (sets: the current tiebreak replaces the deciding set)
  ```
  `applyPoint(state, side, rule)` stays exported and equals `applyEvent(state, { type: 'point', side }, rule)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/modules/scoring/engine.test.ts` (import `applyEvent`, `type ScoreEvent` from `./engine.js`, and `BASKETBALL, FOOTBALL, KABADDI, PADEL, VOLLEYBALL` from `../sport/seed.js`):

```ts
function run(rule: ScoringRule, events: ScoreEvent[], from: ScoreState = initialState(rule)): ScoreState {
  return events.reduce((s, e) => applyEvent(s, e, rule), from);
}
const score = (side: Side, action: string): ScoreEvent => ({ type: 'score', side, action });
const endPeriod: ScoreEvent = { type: 'period_end' };
const kick = (side: Side, scored: boolean): ScoreEvent => ({ type: 'shootout_kick', side, scored });

describe('goals family: typed events', () => {
  const basketball = BASKETBALL.scoringRule;
  const football = FOOTBALL.scoringRule;
  const kabaddi = KABADDI.scoringRule;

  it('scoring R4: an action is worth what the rule says', () => {
    const s = run(basketball, [score('a', 'three'), score('b', 'two'), score('a', 'free_throw')]);
    expect(s.current).toEqual({ a: 4, b: 2 });
  });

  it('scoring R4: an action the rule does not have is refused', () => {
    expect(() => run(football, [score('a', 'three')])).toThrow(ScoringInputError);
  });

  it('a point on a goals rule is its first action (old clients keep working)', () => {
    expect(run(football, [{ type: 'point', side: 'b' }]).current).toEqual({ a: 0, b: 1 });
  });

  it('periods advance, and a lead at the end of regulation ends the match', () => {
    const s = run(basketball, [score('a', 'two'), endPeriod, endPeriod, endPeriod]);
    expect(s.period).toBe(4);
    const over = run(basketball, [endPeriod], s);
    expect(over).toMatchObject({ matchOver: true, winner: 'a' });
  });

  it('basketball: level after regulation plays overtime until someone leads', () => {
    let s = run(basketball, [endPeriod, endPeriod, endPeriod, endPeriod]);
    expect(s).toMatchObject({ period: 5, matchOver: false });
    s = run(basketball, [endPeriod], s); // still level after OT1
    expect(s).toMatchObject({ period: 6, matchOver: false });
    s = run(basketball, [score('b', 'free_throw'), endPeriod], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
  });

  it('football: extra time is a block of two halves; level after the first half plays the second', () => {
    let s = run(football, [endPeriod, endPeriod]); // 0–0 after 90
    expect(s.period).toBe(3);
    s = run(football, [score('a', 'goal'), endPeriod], s); // lead after ET first half: play on
    expect(s).toMatchObject({ period: 4, matchOver: false });
    s = run(football, [endPeriod], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
  });

  it('football: level after extra time goes to a shootout that stops once a side cannot catch up', () => {
    let s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod]);
    expect(s.shootout).toEqual({ a: [], b: [] });
    s = run(football, [kick('a', true), kick('b', false), kick('a', true), kick('b', false), kick('a', true)], s);
    // 3–0 with B on 2 kicks: B can reach at most 3 with 3 left… still alive.
    expect(s.matchOver).toBe(false);
    s = run(football, [kick('b', false)], s); // 3–0, B has 2 left: cannot catch up
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
  });

  it('football: a shootout level after five each goes to sudden death', () => {
    const five = Array.from({ length: 5 }, () => [kick('a', true), kick('b', true)]).flat();
    let s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod, ...five]);
    expect(s.matchOver).toBe(false);
    s = run(football, [kick('a', false), kick('b', true)], s);
    expect(s).toMatchObject({ matchOver: true, winner: 'b' });
  });

  it('a shootout kick out of turn is refused', () => {
    const s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod, kick('a', true)]);
    expect(() => run(football, [kick('a', true)], s)).toThrow(ScoringInputError);
  });

  it('scores are refused during a shootout, and kicks before one', () => {
    const s = run(football, [endPeriod, endPeriod, endPeriod, endPeriod]);
    expect(() => run(football, [score('a', 'goal')], s)).toThrow(ScoringInputError);
    expect(() => run(football, [kick('a', true)])).toThrow(ScoringInputError);
  });

  it('kabaddi league: level at full time ends with no winner', () => {
    const s = run(kabaddi, [score('a', 'raid_2'), score('b', 'super_tackle'), endPeriod, endPeriod]);
    expect(s).toMatchObject({ matchOver: true, winner: null, current: { a: 2, b: 2 } });
  });

  it('a state stored before periods existed is period 1', () => {
    const old = { ...initialState(basketball) } as ScoreState;
    delete (old as { period?: number }).period;
    expect(run(basketball, [endPeriod], old).period).toBe(2);
  });
});

describe('sets family: match tiebreak (padel)', () => {
  const padel = PADEL.scoringRule;
  const game = (side: Side) => Array.from({ length: 4 }, () => ({ type: 'point', side }) as ScoreEvent);
  const set = (side: Side) => Array.from({ length: 6 }, () => game(side)).flat();

  it('golden point: at 40–40 the next point wins the game', () => {
    const deuce = run(padel, ['a', 'b', 'a', 'b', 'a', 'b'].map((side) => ({ type: 'point', side: side as Side })));
    expect(deuce.points).toEqual({ a: 3, b: 3 });
    expect(run(padel, [{ type: 'point', side: 'b' }], deuce).current).toEqual({ a: 0, b: 1 });
  });

  it('at one set all a match tiebreak to 10, win by 2, decides it', () => {
    let s = run(padel, [...set('a'), ...set('b')]);
    expect(s).toMatchObject({ tiebreak: true, matchTiebreak: true, matchOver: false });
    const pts = (side: Side, n: number) => Array.from({ length: n }, () => ({ type: 'point', side }) as ScoreEvent);
    s = run(padel, [...pts('a', 9), ...pts('b', 9)], s);
    expect(s.matchOver).toBe(false); // 9–9
    s = run(padel, pts('a', 1), s);
    expect(s.matchOver).toBe(false); // 10–9: not 2 clear
    s = run(padel, pts('a', 1), s);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
    expect(s.games.at(-1)).toEqual({ a: 11, b: 9 });
  });
});

describe('rally family: new sports are rules, not branches', () => {
  it('scoring R4: volleyball’s fifth set is to 15', () => {
    const v = VOLLEYBALL.scoringRule;
    const set = (side: Side, n: number) => Array.from({ length: n }, () => ({ type: 'point', side }) as ScoreEvent);
    let s = run(v, [...set('a', 25), ...set('b', 25), ...set('a', 25), ...set('b', 25)]);
    s = run(v, set('a', 15), s);
    expect(s).toMatchObject({ matchOver: true, winner: 'a' });
  });
});
```

Also extend the `winnerOf` block:

```ts
  it('accepts a padel match tiebreak as the deciding set, and only a finished one', () => {
    const padel = PADEL.scoringRule;
    expect(winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 8 }], padel)).toBe('a');
    expect(winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 12, b: 10 }], padel)).toBe('a');
    expect(() => winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 9 }], padel)).toThrow(ScoringInputError);
    expect(() => winnerOf([{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 13, b: 10 }], padel)).toThrow(ScoringInputError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modules/scoring/engine.test.ts`
Expected: FAIL — `applyEvent` is not exported.

- [ ] **Step 3: Implement**

In `src/modules/scoring/engine.ts`:

(a) Extend `ScoreState` (all optional, so stored states from before still type-check and parse):

```ts
  /** Goals only — the period being played, 1-based. Absent in states stored before periods existed: read as 1. */
  period?: number;
  /** Goals only — kicks taken in a shootout, in order. Null/absent when there is none. */
  shootout?: { a: boolean[]; b: boolean[] } | null;
  /** Sets only — the current tiebreak replaces the deciding set (`finalSetMatchTiebreak`). */
  matchTiebreak?: boolean;
```

(b) Add the event type, after `ScoringInputError`:

```ts
/** What a scorer can record. The family decides which it accepts. */
export type ScoreEvent =
  | { type: 'point'; side: Side }
  | { type: 'score'; side: Side; action: string }
  | { type: 'period_end' }
  | { type: 'shootout_kick'; side: Side; scored: boolean };
```

(c) `initialState`: add `period: rule.kind === 'goals' ? 1 : undefined, shootout: null` for goals only — write it as:

```ts
export function initialState(rule: ScoringRule, firstServer: Side = 'a'): ScoreState {
  return {
    kind: rule.kind,
    games: [],
    current: zero(),
    points: rule.kind === 'sets' ? zero() : null,
    tiebreak: false,
    serving: rule.kind === 'goals' ? null : firstServer,
    matchOver: false,
    winner: null,
    ...(rule.kind === 'goals' ? { period: 1, shootout: null } : {}),
  };
}
```

(d) Replace `applyPoint` with `applyEvent` plus a wrapper:

```ts
/**
 * One thing that happened, recorded by a scorer. What it does to the score is
 * the rule's business; throws ScoringInputError on a match that is already
 * over, a state from a different family, or an event the family does not take.
 */
export function applyEvent(state: ScoreState, event: ScoreEvent, rule: ScoringRule): ScoreState {
  if (state.matchOver) throw new ScoringInputError('the match is already over');
  if (state.kind !== rule.kind) {
    throw new ScoringInputError(`a ${state.kind} score cannot take a ${rule.kind} event`);
  }
  switch (rule.kind) {
    case 'rally':
      if (event.type !== 'point') throw new ScoringInputError(`a rally match takes points, not ${event.type}`);
      return applyRally(state, event.side, rule);
    case 'sets':
      if (event.type !== 'point') throw new ScoringInputError(`a sets match takes points, not ${event.type}`);
      return applySets(state, event.side, rule);
    case 'goals':
      return applyGoals(state, event, rule);
  }
}

/** One rally, goal or point won by `side`. Kept for recordPoint and older clients. */
export function applyPoint(state: ScoreState, side: Side, rule: ScoringRule): ScoreState {
  return applyEvent(state, { type: 'point', side }, rule);
}
```

(e) Add the goals section (replacing the old one-line goals case):

```ts
// --- goals -------------------------------------------------------------------

type GoalsRule = Extract<ScoringRule, { kind: 'goals' }>;

const DEFAULT_ACTIONS = [{ key: 'goal', label: 'Goal', value: 1 }];

/** The scorer's buttons, in order. A rule with none scores one Goal at a time. */
export function actionsOf(rule: GoalsRule): { key: string; label: string; value: number }[] {
  return rule.actions ?? DEFAULT_ACTIONS;
}

const kicksNext = (so: { a: boolean[]; b: boolean[] }): Side => (so.a.length <= so.b.length ? 'a' : 'b');

/** Five kicks each, stopping as soon as one side cannot catch up; then sudden death in pairs. */
function shootoutWinner(so: { a: boolean[]; b: boolean[] }): Side | null {
  const ga = so.a.filter(Boolean).length;
  const gb = so.b.filter(Boolean).length;
  const la = so.a.length;
  const lb = so.b.length;
  if (la <= 5 && lb <= 5 && !(la === 5 && lb === 5)) {
    if (ga + (5 - la) < gb) return 'b';
    if (gb + (5 - lb) < ga) return 'a';
    return null;
  }
  if (la === lb && ga !== gb) return ga > gb ? 'a' : 'b';
  return null;
}

function applyGoals(state: ScoreState, event: ScoreEvent, rule: GoalsRule): ScoreState {
  const period = state.period ?? 1;
  const shootout = state.shootout ?? null;

  if (event.type === 'point' || event.type === 'score') {
    if (shootout) throw new ScoringInputError('the match is in a shootout; record kicks');
    const action =
      event.type === 'point' ? actionsOf(rule)[0]! : actionsOf(rule).find((a) => a.key === event.action);
    if (!action) throw new ScoringInputError(`this sport has no "${(event as { action: string }).action}" score`);
    return { ...state, period, current: { ...state.current, [event.side]: state.current[event.side] + action.value } };
  }

  if (event.type === 'shootout_kick') {
    if (!shootout) throw new ScoringInputError('there is no shootout');
    if (kicksNext(shootout) !== event.side) throw new ScoringInputError('it is the other side’s kick');
    const next = { ...shootout, [event.side]: [...shootout[event.side], event.scored] };
    const winner = shootoutWinner(next);
    return { ...state, shootout: next, matchOver: winner !== null, winner };
  }

  // period_end
  if (shootout) throw new ScoringInputError('the match is in a shootout');
  if (period < rule.periods) return { ...state, period: period + 1 };

  const level = state.current.a === state.current.b;
  const leader: Side = state.current.a > state.current.b ? 'a' : 'b';
  const hasExtra = rule.tiebreaker === 'extra_period' || rule.tiebreaker === 'extra_period_then_shootout';
  const block = rule.extraPeriods ?? 2;
  const extraPlayed = period - rule.periods;

  // Mid-way through a block of extra time (football's first half of ET): play on, whatever the score.
  if (extraPlayed > 0 && extraPlayed % block !== 0) return { ...state, period: period + 1 };

  if (!level) return { ...state, matchOver: true, winner: leader };

  const mayPlayExtra = hasExtra && (extraPlayed === 0 || rule.repeatExtraPeriods === true);
  if (mayPlayExtra) return { ...state, period: period + 1 };
  if (rule.tiebreaker === 'shootout' || rule.tiebreaker === 'extra_period_then_shootout') {
    return { ...state, shootout: { a: [], b: [] } };
  }
  // tiebreaker 'none': a level match is over with no winner (a league draw).
  return { ...state, matchOver: true, winner: null };
}
```

(f) Sets: the match tiebreak. In `applySets`, replace the `if (state.tiebreak) { … }` block with:

```ts
  if (state.tiebreak) {
    const target =
      state.matchTiebreak && rule.finalSetMatchTiebreak
        ? rule.finalSetMatchTiebreak
        : { pointsToWin: rule.tiebreakPointsToWin, winBy: rule.tiebreakWinBy };
    const won = mine >= target.pointsToWin && mine - theirs >= target.winBy;
    if (!won) {
      // The first tiebreak point is served alone, then two each.
      const played = points.a + points.b;
      const serving = played % 2 === 1 ? other(state.serving ?? 'a') : state.serving;
      return { ...state, points, serving };
    }
    // A match tiebreak is recorded as the deciding "set", by its points (10–8).
    if (state.matchTiebreak) return closeSet({ ...state, matchTiebreak: false }, points, side, rule);
    // A set tiebreak decides the set by one game.
    return closeSet(state, add(state.current, side), side, rule);
  }
```

and at the end of `closeSet`, before `return`, decide whether the next thing is a match tiebreak:

```ts
function closeSet(state: ScoreState, set: GameScore, side: Side, rule: SetsRule): ScoreState {
  const games = [...state.games, set];
  const over = wonCount(games, side) >= rule.setsToWin;
  const toMatchTiebreak =
    !over &&
    !!rule.finalSetMatchTiebreak &&
    wonCount(games, 'a') === rule.setsToWin - 1 &&
    wonCount(games, 'b') === rule.setsToWin - 1;
  return {
    ...state,
    games,
    current: zero(),
    points: zero(),
    tiebreak: toMatchTiebreak,
    matchTiebreak: toMatchTiebreak,
    serving: state.tiebreak ? other(state.serving ?? 'a') : state.serving,
    matchOver: over,
    winner: over ? side : null,
  };
}
```

(g) `winnerOf`, sets branch: accept a match-tiebreak score as the deciding set. Replace the `else { … }` sets validation with:

```ts
    } else {
      const g = u[w];
      const og = u[other(w)];
      const deciding = tally.a === rule.setsToWin - 1 && tally.b === rule.setsToWin - 1;
      const mtb = rule.finalSetMatchTiebreak;
      if (deciding && mtb) {
        const finished = g >= mtb.pointsToWin && g - og >= mtb.winBy && (g === mtb.pointsToWin || g - og === mtb.winBy);
        if (!finished) throw new ScoringInputError(`the match tiebreak (${u.a}–${u.b}) is not finished`);
      } else {
        const outright = g >= rule.setGamesToWin && g - og >= rule.setWinBy;
        const byTiebreak =
          rule.setTiebreakAt !== null &&
          !(isFinalSet(rule, i) && rule.finalSetIsFullSet) &&
          og === rule.setTiebreakAt &&
          g === rule.setTiebreakAt + 1;
        if (!outright && !byTiebreak) {
          throw new ScoringInputError(`set ${i + 1} (${u.a}–${u.b}) is not a finished set`);
        }
      }
    }
```

(The existing rule for "outright" allows 7–5 via `setWinBy`; it also allows 8–6 when a format has no tiebreak. Leave that as it is.)

Update the file's top comment: the switch is on `rule.kind`, and events are typed (`ScoreEvent`).

- [ ] **Step 4: Write the golden fixtures (shared with the app)**

`src/modules/scoring/fixtures/engine-fixtures.json` — each case is a rule slug, a list of events, and the expected final state fields. Generate it from the engine once, then commit it; it is the contract the app's copy must meet.

Create `scripts/write-engine-fixtures.ts`:

```ts
/**
 * Writes the engine's golden fixtures (scoring R4 parity with the app's copy).
 * Run after any engine change: `npx tsx scripts/write-engine-fixtures.ts`.
 */
import { writeFileSync } from 'node:fs';
import { applyEvent, initialState, type ScoreEvent } from '../src/modules/scoring/engine.js';
import { LAUNCH_SPORTS } from '../src/modules/sport/seed.js';

const p = (side: 'a' | 'b', n = 1): ScoreEvent[] => Array.from({ length: n }, () => ({ type: 'point', side }));
const end: ScoreEvent = { type: 'period_end' };
const cases: { name: string; sport: string; events: ScoreEvent[] }[] = [
  { name: 'pickleball deciding game to 15', sport: 'pickleball', events: [...p('a', 11), ...p('b', 11), ...p('a', 15)] },
  { name: 'badminton cap at 30', sport: 'badminton', events: [...Array.from({ length: 29 }, () => [...p('a'), ...p('b')]).flat(), ...p('b')] },
  { name: 'tennis deuce and a set tiebreak', sport: 'tennis', events: [...Array.from({ length: 6 }, () => [...p('a', 4), ...p('b', 4)]).flat(), ...p('a', 7)] },
  { name: 'padel golden point', sport: 'padel', events: ['a', 'b', 'a', 'b', 'a', 'b', 'b'].flatMap((s) => p(s as 'a' | 'b')) },
  { name: 'volleyball five sets', sport: 'volleyball', events: [...p('a', 25), ...p('b', 25), ...p('a', 25), ...p('b', 25), ...p('a', 15)] },
  { name: 'basketball overtime', sport: 'basketball', events: [end, end, end, end, { type: 'score', side: 'b', action: 'three' }, end] },
  { name: 'football extra time then penalties', sport: 'football', events: [end, end, end, end, ...['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'].map((s, i) => ({ type: 'shootout_kick' as const, side: s as 'a' | 'b', scored: i % 4 !== 3 }))] },
  { name: 'kabaddi league draw', sport: 'kabaddi', events: [{ type: 'score', side: 'a', action: 'raid_2' }, { type: 'score', side: 'b', action: 'all_out' }, end, end] },
];

const out = cases.map((c) => {
  const seed = LAUNCH_SPORTS.find((s) => s.slug === c.sport)!;
  const rule = seed.scoringRule;
  const final = c.events.reduce((s, e) => applyEvent(s, e, rule), initialState(rule));
  return { ...c, rule, final };
});
writeFileSync('src/modules/scoring/fixtures/engine-fixtures.json', JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.length} cases`);
```

Run: `npx tsx scripts/write-engine-fixtures.ts`
Expected: `wrote 8 cases`, and the JSON file exists.

Then `src/modules/scoring/fixtures.test.ts`:

```ts
/** scoring R4 — the engine meets its own golden fixtures; the app runs the same file. */
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/engine-fixtures.json' with { type: 'json' };
import { applyEvent, initialState, type ScoreEvent, type ScoreState } from './engine.js';
import type { ScoringRule } from '../sport/index.js';

describe('engine golden fixtures', () => {
  for (const f of fixtures as { name: string; rule: ScoringRule; events: ScoreEvent[]; final: ScoreState }[]) {
    it(`scoring R4: ${f.name}`, () => {
      const final = f.events.reduce((s, e) => applyEvent(s, e, f.rule), initialState(f.rule));
      expect(final).toEqual(f.final);
    });
  }
});
```

If the project's TypeScript config rejects `with { type: 'json' }`, use `JSON.parse(readFileSync(new URL('./fixtures/engine-fixtures.json', import.meta.url), 'utf8'))` instead.

Every case must end on its last event: an event after the match is over throws, and the script then fails. (The football case is decided on the 8th kick: A 4 of 4, B 2 of 4, B can reach 3 at most.) Open the generated JSON and check three results by hand against the rules before committing: basketball overtime ends `winner: 'b'` with `period: 5`; football ends `matchOver: true` with a shootout winner; kabaddi ends `winner: null`. A fixture generated from a wrong engine would only freeze the bug.

- [ ] **Step 5: Run the engine tests**

Run: `npx vitest run src/modules/scoring`
Expected: all PASS, old and new.

- [ ] **Step 6: Check R4**

Run: `grep -rn "pickleball\|volleyball\|kabaddi\|padel\|squash\|football\|basketball" src/modules/scoring --include=*.ts | grep -v "\.test\.ts"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/modules/scoring/engine.ts src/modules/scoring/engine.test.ts src/modules/scoring/fixtures src/modules/scoring/fixtures.test.ts scripts/write-engine-fixtures.ts
git commit -m "feat(scoring): typed score events — actions, periods, extra time, shootout, match tiebreak"
```

---

### Task 3: Store the event and record it (service)

**Repo:** `PALY_BACKEND`

**Files:**
- Create: `prisma/migrations/20260929150000_026_score_event_payload/migration.sql`
- Modify: `prisma/schema.prisma` (model `MatchScoreEvent`, ~line 1101)
- Modify: `src/modules/scoring/repo/index.ts` (`ScoreEventKind`, `append`, `events`)
- Modify: `src/modules/scoring/service/index.ts` (`recordEvent`; `recordPoint` delegates)
- Modify: `docs/modules/10-scoring.md` (schema block, service interface, checklist)
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Consumes: `applyEvent`, `ScoreEvent` (Task 2).
- Produces (used by Task 4): `scoring.recordEvent(actor, { matchId, event: ScoreEvent, expectedSeq }): Promise<Snapshot>`; `ScoreEventRow.event: ScoreEvent | null`.

- [ ] **Step 1: Write the failing tests**

In `tests/scoring.test.ts`, find how existing tests build a live match (a helper that seeds an event, category, draw and match, then calls `scoring.start`). Reuse it with a goals sport. Add:

```ts
describe('typed score events', () => {
  it('scoring R4: a basketball three is worth 3, and the event is kept with the state', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    const snap = await scoring.recordEvent(scorer, {
      matchId: match.id,
      event: { type: 'score', side: 'a', action: 'three' },
      expectedSeq: 1,
    });
    expect(snap.state?.current).toEqual({ a: 3, b: 0 });
    const [, last] = await scoring.timeline(match.id);
    expect(last).toMatchObject({ kind: 'event', scoringSide: 'a', event: { type: 'score', side: 'a', action: 'three' } });
  });

  it('scoring R1: a typed event carries expectedSeq like a point', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    await expect(
      scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'period_end' }, expectedSeq: 0 }),
    ).rejects.toMatchObject({ code: 'SCORE_STALE' });
  });

  it('an event the sport does not take is refused and nothing is stored', async () => {
    const { match, scorer } = await liveMatch({ sport: 'football' });
    await expect(
      scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'score', side: 'a', action: 'three' }, expectedSeq: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
    expect(await scoring.timeline(match.id)).toHaveLength(1); // just the start
  });

  it('scoring R6: the event that ends the match submits the result', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    let seq = 1;
    const rec = async (event: ScoreEvent) => {
      await scoring.recordEvent(scorer, { matchId: match.id, event, expectedSeq: seq });
      seq += 1;
    };
    await rec({ type: 'score', side: 'b', action: 'two' });
    for (let i = 0; i < 4; i++) await rec({ type: 'period_end' });
    expect(await scoring.resultFor(match.id)).toMatchObject({ outcome: 'played', source: 'live' });
  });

  it('scoring R2: undo takes back a typed event', async () => {
    const { match, scorer } = await liveMatch({ sport: 'basketball' });
    await scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'score', side: 'a', action: 'three' }, expectedSeq: 1 });
    const after = await scoring.undo(scorer, { matchId: match.id, expectedSeq: 2 });
    expect(after.state?.current).toEqual({ a: 0, b: 0 });
  });
});
```

If the file has no `liveMatch({ sport })` helper, write one next to the existing match helper: it must seed the named sport's event category (format = the sport's first format key) and return `{ match, scorer }` with `scoring.start` already called (seq 1). Model it line for line on the helper the existing pickleball tests use; do not invent a new seeding path.

Also: a level kabaddi league match ends with `winner: null`. Until Plan 3 adds draws to results, the service must not try to submit a result without a winner. Add:

```ts
  it('a level match with no tiebreaker ends live scoring without submitting a result (draws come in Plan 3)', async () => {
    const { match, scorer } = await liveMatch({ sport: 'kabaddi' });
    await scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'period_end' }, expectedSeq: 1 });
    const snap = await scoring.recordEvent(scorer, { matchId: match.id, event: { type: 'period_end' }, expectedSeq: 2 });
    expect(snap.state).toMatchObject({ matchOver: true, winner: null });
    expect(await scoring.resultFor(match.id)).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scoring.test.ts -t "typed score events|level match"`
Expected: FAIL — `scoring.recordEvent` is not a function.

- [ ] **Step 3: Migration**

`prisma/migrations/20260929150000_026_score_event_payload/migration.sql`:

```sql
-- 026 — typed score events (all-sports scoring, plan 1). The event is kept next
-- to the complete state it produced (scoring R3): the state is the truth, the
-- event is what happened, for the timeline and for player stats later.

ALTER TABLE "match_score_events" ADD COLUMN "event" JSONB;

ALTER TABLE "match_score_events" DROP CONSTRAINT "match_score_events_kind_check";
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_kind_check"
  CHECK ("kind" IN ('start', 'point', 'undo', 'event'));

-- 016 tied scoring_side to kind = 'point'. An event names its side when it has
-- one (a score, a kick) and not otherwise (period_end).
ALTER TABLE "match_score_events" DROP CONSTRAINT "match_score_events_side_check";
ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_side_check"
  CHECK (("kind" = 'point' AND "scoring_side" IS NOT NULL)
      OR ("kind" = 'event')
      OR ("kind" IN ('start', 'undo') AND "scoring_side" IS NULL));

ALTER TABLE "match_score_events" ADD CONSTRAINT "match_score_events_event_check"
  CHECK (("kind" = 'event') = ("event" IS NOT NULL));
```

(Constraint names are the ones migration 016 created, lines 73–77. The append-only trigger from 016 stays untouched; ALTER TABLE on constraints is not an UPDATE of rows.)

- [ ] **Step 4: Prisma model**

In `model MatchScoreEvent`: change the `kind` doc comment to `/// start | point | undo | event. CHECK in the migration.`, change the `scoringSide` comment to `/// a | b. Set for a point, and for an event that has a side.`, and add after `stateAfter`:

```prisma
  /// The typed event for kind = 'event' (a score action, a period end, a kick). Null otherwise.
  event       Json?
```

Run: `npx prisma generate`

- [ ] **Step 5: Repo**

In `src/modules/scoring/repo/index.ts`:
- Add `'event'` to the `ScoreEventKind` union.
- Import `type ScoreEvent` from `'../engine.js'`.
- Add `event: ScoreEvent | null;` to `ScoreEventRow` and to `append`'s input.
- In `append`'s `data`, add `event: input.event === null ? Prisma.JsonNull : (input.event as unknown as Prisma.InputJsonValue),`.
- In `events`' mapper, add `event: (r.event ?? null) as ScoreEvent | null,`.
- Every existing `append` call site passes `event: null` (in the service: `start`, `recordPoint`, `undo`).

- [ ] **Step 6: Service**

In `src/modules/scoring/service/index.ts`:

Add to `ScoringCode`:

```ts
  /** R4 — an event the sport's rule does not take (a 3-pointer in football, a kick out of turn). */
  INVALID_EVENT: 'INVALID_EVENT',
```

Import `applyEvent` and `type ScoreEvent` from `'../engine.js'` (keep `applyPoint` only if still used). Export `type ScoreEvent` from the service's type re-exports.

Replace `recordPoint` with `recordEvent` plus a delegating `recordPoint`:

```ts
  /**
   * R1–R5 for any typed event. The event that ends the match also submits its
   * result (R6) — when it has a winner. A level match under a rule with no
   * tiebreaker ends with no winner; results without a winner arrive in plan 3.
   */
  async function recordEvent(
    actor: Actor,
    input: { matchId: string; event: ScoreEvent; expectedSeq: number },
  ): Promise<Snapshot> {
    const match = await assertCanScore(actor, input.matchId);
    const rule = await deps.ruleFor(match.eventCategoryId);

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, input.matchId);
      if (!head) throw notFound();
      if (input.expectedSeq !== head.scoreSeq) throw stale(head);
      if (head.status !== 'live' || !head.currentScore) throw notLive(head.status);

      let state: ScoreState;
      try {
        state = applyEvent(head.currentScore, input.event, rule);
      } catch (err) {
        if (err instanceof ScoringInputError) {
          if (head.currentScore.matchOver) throw notLive(head.status);
          throw new UserError(ScoringCode.INVALID_EVENT, err.message);
        }
        throw err;
      }

      const isPoint = input.event.type === 'point';
      const seq = head.scoreSeq + 1;
      await repo.append(tx, {
        matchId: input.matchId,
        seq,
        kind: isPoint ? 'point' : 'event',
        scoringSide: 'side' in input.event ? input.event.side : null,
        stateAfter: state,
        event: isPoint ? null : input.event,
        recordedBy: actor.userId,
      });

      if (state.matchOver && state.winner) {
        await submitIn(tx, match, actor, {
          outcome: 'played',
          winner: state.winner,
          // A goals match has no completed units; its result is the final score.
          games: state.kind === 'goals' ? [state.current] : state.games,
          source: 'live',
        });
      }

      await publishScore(tx, match, seq, state);
      return { state, seq };
    });
  }

  /** R1–R5 — a rally won by `side`. Kept for existing clients; the same write as recordEvent. */
  function recordPoint(actor: Actor, input: { matchId: string; side: Side; expectedSeq: number }): Promise<Snapshot> {
    return recordEvent(actor, { matchId: input.matchId, event: { type: 'point', side: input.side }, expectedSeq: input.expectedSeq });
  }
```

(`submitIn` stores `games` as the result's scoreline; `winnerOf` sums the units of a goals result, so `[state.current]` is the shape a typed goals result already uses.)

Add `recordEvent` to the returned service object.

In `src/modules/scoring/repo/index.ts`, `hasRecordedPoints` (the R12 witness test, ~line 240) counts only `kind: 'point'`. Change its filter to `kind: { in: ['point', 'event'] }` so a basketball or football scorer counts as having scored the match. Add a test beside the existing R12 witness test in `tests/scoring.test.ts`, copying its setup with `sport: 'basketball'` and one `score` event, asserting the same "may confirm at once" outcome.

`undo` needs no change: it replays every non-undo entry onto a stack (`kind === 'undo'` pops, anything else pushes), so an `event` row is taken back exactly like a point. The Step 1 undo test proves it.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/scoring.test.ts`
Expected: all PASS, including every pre-existing scoring test.

- [ ] **Step 8: Update the module doc**

In `docs/modules/10-scoring.md`: add `recordEvent(actor, { matchId, event, expectedSeq }) => MatchState` to the service interface; in the schema block change the `kind` CHECK to include `'event'` and add `event jsonb` (026); add a checklist line `- [x] Typed score events (plan 2026-09-29-all-sports-scoring-1): actions, periods, extra time, shootout, match tiebreak`.

- [ ] **Step 9: Commit**

```bash
git add prisma/migrations/20260929150000_026_score_event_payload prisma/schema.prisma src/modules/scoring tests/scoring.test.ts docs/modules/10-scoring.md
git commit -m "feat(scoring): recordEvent stores typed events next to the full state"
```

---

### Task 4: GraphQL — `recordScoreEvent`, and the new state fields

**Repo:** `PALY_BACKEND`

**Files:**
- Modify: `src/modules/scoring/schema/index.ts`
- Regenerate: `schema.graphql`
- Test: `tests/scoring.test.ts` (resolver-level test only if the file already tests resolvers through a GraphQL executor; otherwise the service tests from Task 3 are the behaviour tests and this task is checked by the schema diff)

**Interfaces:**
- Consumes: `scoring.recordEvent` (Task 3), `actionsOf` (Task 2).
- Produces (used by Plan 2's app pads):
  ```graphql
  enum ScoreEventType { POINT SCORE PERIOD_END SHOOTOUT_KICK }
  input RecordScoreEventInput { matchId: ID!, expectedSeq: Int!, type: ScoreEventType!, side: MatchSide, action: String, scored: Boolean }
  Mutation.recordScoreEvent(input: RecordScoreEventInput!): MatchPayload!
  type ScoreState { …existing…, period: Int, shootout: Shootout, matchTiebreak: Boolean! }
  type Shootout { a: [Boolean!]!, b: [Boolean!]!, next: MatchSide! }
  ```

- [ ] **Step 1: Add the enum, input and mutation**

In `src/modules/scoring/schema/index.ts`, next to the other enums:

```ts
const ScoreEventTypeEnum = builder.enumType('ScoreEventType', {
  description: 'What a scorer recorded. The sport’s rule decides which it takes (scoring R4).',
  values: {
    POINT: { value: 'point' as const },
    SCORE: { value: 'score' as const, description: 'A named score action: `action` is one of the rule’s action keys.' },
    PERIOD_END: { value: 'period_end' as const },
    SHOOTOUT_KICK: { value: 'shootout_kick' as const, description: '`scored` says whether it went in.' },
  },
});
```

Next to `RecordPointInput`:

```ts
const RecordScoreEventInput = builder.inputType('RecordScoreEventInput', {
  fields: (t) => ({
    matchId: t.id({ required: true }),
    expectedSeq: t.int({ required: true, description: 'R1 — `currentScore.seq` as this device last knew it.' }),
    type: t.field({ type: ScoreEventTypeEnum, required: true }),
    side: t.field({ type: MatchSideEnum, required: false, description: 'Required for POINT, SCORE and SHOOTOUT_KICK.' }),
    action: t.string({ required: false, description: 'SCORE only — a key from the rule’s actions.' }),
    scored: t.boolean({ required: false, description: 'SHOOTOUT_KICK only.' }),
  }),
});
```

A helper that turns the input into a `ScoreEvent` or a `UserError` (so a malformed input never reaches the engine):

```ts
function toScoreEvent(i: { type: ScoreEvent['type']; side?: Side | null; action?: string | null; scored?: boolean | null }): ScoreEvent {
  const needSide = () => {
    if (!i.side) throw new UserError('INVALID_EVENT', `${i.type} needs a side`);
    return i.side;
  };
  switch (i.type) {
    case 'point':
      return { type: 'point', side: needSide() };
    case 'score':
      if (!i.action) throw new UserError('INVALID_EVENT', 'a score needs an action');
      return { type: 'score', side: needSide(), action: i.action };
    case 'period_end':
      return { type: 'period_end' };
    case 'shootout_kick':
      if (i.scored == null) throw new UserError('INVALID_EVENT', 'a kick needs scored: true or false');
      return { type: 'shootout_kick', side: needSide(), scored: i.scored };
  }
}
```

(Import `UserError` from `'../../../platform/errors/index.js'` and `ScoreEvent` from `'../index.js'` if not already.)

The mutation, after `recordPoint` in `builder.mutationFields`. It uses the file's existing `pointWrite`, which returns the fresh match on success AND failure (so INVALID_EVENT and SCORE_STALE come back as a `userError` with the server's match). `toScoreEvent` runs inside the callback so its UserError is caught the same way:

```ts
  recordScoreEvent: t.field({
    type: MatchPayload,
    description:
      'Any typed score event (scoring R1–R5): a score action, a period end, a shootout kick. ' +
      'Rejected with SCORE_STALE like recordPoint, and with INVALID_EVENT when the sport’s rule ' +
      'does not take it. The event that ends the match submits its result (R6).',
    args: { input: t.arg({ type: RecordScoreEventInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const matchId = args.input.matchId.toString();
      return pointWrite(matchId, () =>
        scoring.recordEvent(actor, {
          matchId,
          expectedSeq: args.input.expectedSeq,
          event: toScoreEvent(args.input),
        }),
      );
    },
  }),
```

- [ ] **Step 2: Add the state fields**

In `ScoreStateRef` fields:

```ts
    period: t.int({
      nullable: true,
      description: 'GOALS only — the period being played, 1-based. Beyond the rule’s `periods` it is extra time.',
      resolve: (s) => (s.kind === 'goals' ? s.period ?? 1 : null),
    }),
    shootout: t.field({
      type: ShootoutRef,
      nullable: true,
      resolve: (s) => s.shootout ?? null,
    }),
    matchTiebreak: t.boolean({
      description: 'SETS only — the tiebreak being played replaces the deciding set.',
      resolve: (s) => s.matchTiebreak ?? false,
    }),
```

with, above `ScoreStateRef`:

```ts
const ShootoutRef = builder.objectRef<{ a: boolean[]; b: boolean[] }>('Shootout').implement({
  description: 'Kicks taken, in order: true scored, false missed.',
  fields: (t) => ({
    a: t.field({ type: ['Boolean'], resolve: (s) => s.a }),
    b: t.field({ type: ['Boolean'], resolve: (s) => s.b }),
    next: t.field({
      type: MatchSideEnum,
      description: 'Who kicks next.',
      resolve: (s) => (s.a.length <= s.b.length ? ('a' as Side) : ('b' as Side)),
    }),
  }),
});
```

- [ ] **Step 3: Regenerate and check the schema**

Run: `npm run schema:generate && grep -n "ScoreEventType\|recordScoreEvent\|RecordScoreEventInput\|type Shootout\|matchTiebreak\|period: Int" schema.graphql`
Expected: every name found once (the enum, the input, the mutation, the type, the two fields).

Also update the `ScoringKind` description to mention the new sports: `'RALLY: points within games (pickleball, badminton, table tennis, volleyball, squash). SETS: points within games within sets (tennis, padel). GOALS: a running score over periods (football, basketball, kabaddi).'`

- [ ] **Step 4: Full backend check**

Run: `npm run check`
Expected: typecheck, lint, guard and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/scoring/schema/index.ts schema.graphql
git commit -m "feat(scoring): recordScoreEvent mutation; period, shootout and matchTiebreak on ScoreState"
```

---

### Task 5: The app's engine stays in step

**Repo:** `PLAY_FRONTEND`

**Files:**
- Modify: `apps/player/src/features/scoring/model/rule.ts` (the client's copy of the rule type)
- Modify: `apps/player/src/features/scoring/model/engine.ts`
- Create: `apps/player/src/features/scoring/model/engine-fixtures.json` (a byte-for-byte copy of the backend file)
- Create: `apps/player/src/features/scoring/model/engine.fixtures.test.ts`
- Modify: `docs/modules/11-live-scoring.md` (R4 note)

**Interfaces:**
- Consumes: the backend's `src/modules/scoring/fixtures/engine-fixtures.json` (Task 2).
- Produces: the client `applyEvent`, `ScoreEvent`, `actionsOf` with the same signatures as the server's (Task 2), for Plan 2's pads.

- [ ] **Step 1: Copy the fixtures and write the failing test**

Run (from the `PLAY` root): `cp PALY_BACKEND/src/modules/scoring/fixtures/engine-fixtures.json PLAY_FRONTEND/apps/player/src/features/scoring/model/engine-fixtures.json`

`apps/player/src/features/scoring/model/engine.fixtures.test.ts`:

```ts
/**
 * live-scoring R4 — this engine and the server's must agree. The fixtures file
 * is copied from PALY_BACKEND/src/modules/scoring/fixtures/engine-fixtures.json;
 * when the server engine changes, regenerate it there and copy it here.
 */
import fixtures from './engine-fixtures.json';
import { applyEvent, initialState, type ScoreEvent, type ScoreState } from './engine';
import type { ScoringRule } from './rule';

describe('engine golden fixtures (shared with the server)', () => {
  for (const f of fixtures as unknown as { name: string; rule: ScoringRule; events: ScoreEvent[]; final: ScoreState }[]) {
    it(`live-scoring R4: ${f.name}`, () => {
      const final = f.events.reduce((s, e) => applyEvent(s, e, f.rule), initialState(f.rule));
      expect(final).toEqual(f.final);
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `apps/player`): `npx jest src/features/scoring/model/engine.fixtures.test.ts`
Expected: FAIL — `applyEvent` is not exported (and the rule type lacks the new fields).

- [ ] **Step 3: Port the engine changes**

Open the server's `src/modules/scoring/engine.ts` as changed in Task 2 and the client's `model/engine.ts` side by side. Apply the same changes to the client file: the `ScoreState` optional fields, `ScoreEvent`, `initialState`, `applyEvent` + `applyPoint` wrapper, the whole goals section (`DEFAULT_ACTIONS`, `actionsOf`, `kicksNext`, `shootoutWinner`, `applyGoals`), the sets `applyTiebreak`/`closeSet` changes and the `winnerOf` sets branch. The code is identical apart from import paths; copy it, don't rewrite it.

In `model/rule.ts`, add the same optional fields the server's Zod schema gained in Task 1 (`actions`, `extraPeriods`, `repeatExtraPeriods` on goals; `finalSetMatchTiebreak` on sets). If `rule.ts` also validates with Zod, copy the schema lines from the server file; if it is a plain type, add the fields as optional properties.

- [ ] **Step 4: Run the scoring tests**

Run (from `apps/player`): `npx jest src/features/scoring`
Expected: all PASS, including the existing queue and drain tests.

- [ ] **Step 5: Typecheck**

Run (from `apps/player`): `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Note the parity rule in the module doc**

In `docs/modules/11-live-scoring.md`, under R4, add:

```markdown
The client engine is a copy of the server's. `model/engine-fixtures.json` is copied from the backend
(`src/modules/scoring/fixtures/engine-fixtures.json`, written by `scripts/write-engine-fixtures.ts`),
and `engine.fixtures.test.ts` runs it here. A server engine change regenerates the file there, copies
it here, and fails this test until the copy is updated. A rule `kind` this build does not know still
paints nothing locally and waits for the server.
```

- [ ] **Step 7: Commit**

```bash
git add apps/player/src/features/scoring/model docs/modules/11-live-scoring.md
git commit -m "feat(scoring): client engine takes typed events, checked against the server's golden fixtures"
```

---

## Self-review notes

- Spec coverage for this plan's slice: engine typed events (spec §Cross-cutting 1–2), `ScoreState` additions (§3, as optional fields rather than a full union — the union arrives with the first family whose state is not games/current, in Plan 4), goals and sets extensions and the Phase 1 sports (§Existing families, §Sport-by-sport), app parity (§1). Draws, method and margin (§5) are Plan 3 by design; Task 3 makes a winnerless end safe until then.
- A shared npm package for the engine (spec §1) is not possible while the backend and app are separate git repos without a shared workspace; the fixtures file is the parity mechanism instead. Revisit if the repos are merged.
- `ScoreSummary` (spec §3, a generic `a` / `b` / `status` line for spectator lists) is left to Plan 2, where the first screen that needs it is built.
