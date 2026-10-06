# All-sports scoring — design

**Date:** 2026-09-29 · **Modules:** `sport`, `scoring`, `tournament`, `rating` · **Status:** proposal

## Goal

Every sport in the target list can be scored live (or entered as a result) on the platform, without
breaking the rule that makes multi-sport cheap today:

> sport R5 / scoring R4 — scoring semantics live in the `ScoringRule` document. The engine switches
> on `rule.kind` (the scoring **family**), never on the sport.

33 sports don't need 33 engines. They reduce to **8 scoring families**. Adding a sport should still
mean adding a seed row (sport R1). Code changes only when we add a new family, never a new sport.

## Where we are

| Have | Gap for the full list |
|---|---|
| Families `rally`, `sets`, `goals` | 5 more families needed (below) |
| `Side = 'a' \| 'b'`: two sides per match | Races, lifting, golf, BR esports have **N entrants** |
| One input: `recordPoint(side)` | Cricket balls, 3-pointers, judges' cards, attempts need **typed events** |
| One `ScoreState` shape for every family | Each family needs its own state shape |
| `winnerOf` throws on a level score | Chess, football leagues and cricket all have **draws / ties / no result** |
| `outcome`: played / walkover / retired / forfeit | Combat needs a **method** (KO, submission, split decision, fall…) |

What stays as-is: append-only event log (R2), full state per event (R3), `expectedSeq` concurrency
(R1), outbox fan-out (R5), offline queue (R9) and result finality (R6, R11–R14). These already work
for any sport.

---

## The 8 families

### Head-to-head (two sides, `Match`)

| Family | Status | Sports |
|---|---|---|
| `rally` | exists | Pickleball, Badminton, Table Tennis, **Volleyball, Squash** |
| `sets` | exists, small additions | Tennis, **Padel** |
| `goals` | exists, small additions | Football, Basketball, **Kabaddi** (also EA FC-style esports) |
| `series` | **new** | Chess, Snooker, Pool, Billiards, Carrom, Esports (map-based) |
| `innings` | **new** | Cricket (all variants: T10/T20/ODI/box/tennis-ball) |
| `bouts` | **new** | Boxing, MMA, Wrestling, Karate, Taekwondo |

### Field (N entrants, new `Heat`)

| Family | Status | Sports |
|---|---|---|
| `performance` | **new** | Running, Cycling, Swimming, Athletics, Powerlifting, Weightlifting, Calisthenics, Gym/Fitness challenges, Esports battle royale |
| `scorecard` | **new** | Golf, Bowling, Archery |

`scorecard` sports can also be played head-to-head (golf match play, a bowling duel, archery set
system). In that case the format's rule uses `series` instead. Scoring rules are already
per `(sport, format)`, so this needs no new mechanism.

---

## Family rule shapes (additions to `scoringRuleSchema`)

### Existing families: small extensions

```ts
// rally: no change needed. Volleyball, squash are pure seed rows.

// sets: padel + amateur tennis short formats
finalSetMatchTiebreak?: { pointsToWin: number; winBy: number } | null; // super tiebreak to 10
// golden point / star point = existing gameWinBy: 1

// goals: basketball, kabaddi
scoreValues?: number[];          // [1,2,3] basketball; kabaddi allows a raid worth up to N
maxScorePerEvent?: number;       // kabaddi multi-point raids, all-out bonus
repeatExtraPeriods?: boolean;    // basketball overtime repeats until someone leads
```

### `series`: best-of-N units, each unit won outright or on points

```ts
{
  kind: 'series',
  unitName: 'frame' | 'rack' | 'game' | 'map' | 'board' | 'end',
  unitsToWin: number,                 // race to N / best of 2N-1
  unitScoring: 'win_only' | 'points', // pool vs snooker
  unitPointTarget?: number,           // carrom 25, billiards 150
  maxEventsPerUnit?: number,          // carrom: 8 boards per game
  allowDraws: boolean,                // chess
  drawValue?: number,                 // 0.5
  unitWinValue?: number,              // archery set system: win 2, tie 1
  matchPointTarget?: number,          // archery set system: first to 6 set points
}
```

Events: `unit_won{side}`, `unit_drawn`, `points{side, value}` (snooker pot / break, carrom board).
Snooker break tracking (highest break) is derived from consecutive `points` events by one side.

### `innings`: cricket

```ts
{
  kind: 'innings',
  oversPerInnings: number,            // 10, 20, 50, or 6 for box cricket
  ballsPerOver: number,               // 6
  inningsPerSide: 1,                  // multi-day out of scope for v1
  wicketsPerInnings: number,          // playersPerSide - 1; box cricket often fewer
  maxOversPerBowler: number | null,
  extras: { wideRuns: number; noBallRuns: number; rebowlWideAndNoBall: boolean; freeHit: boolean },
  lastManStands: boolean,             // gully/tennis-ball formats
  tiebreaker: 'super_over' | 'none',
}
```

Event: `ball{ runs, extra: 'none'|'wide'|'no_ball'|'bye'|'leg_bye', wicket?: {kind, outPlayerId},
strikerId?, bowlerId? }` and official events `end_innings`, `revise_target` (manual DLS: we store
the official's target, we don't compute DLS).
State: per innings runs/wickets/legal balls/extras, current batters & bowler, target, required rate.
Result: won by N runs / N wickets / tie / no result.

### `bouts`: combat

```ts
{
  kind: 'bouts',
  rounds: number,
  roundSeconds: number,
  decision: 'judges_10pt' | 'points',   // boxing/MMA vs wrestling/karate/TKD
  judges?: number,                      // 3
  scoreValues?: number[],               // karate 1/2/3; wrestling 1/2/4/5; TKD 1–5
  roundsToWin?: number,                 // TKD best-of-3 rounds
  pointGapStoppage?: number | null,     // technical superiority / point-gap end
  firstPointAdvantage?: boolean,        // karate senshu
  finishes: ('ko'|'tko'|'submission'|'dq'|'fall'|'gap'|'rsc'|'injury')[],
}
```

Events: `points{side, value}`, `penalty{side}`, `round_card{judgeId, a, b}` (judged sports), and
`finish{side, method, round, time}`, which ends the match immediately.
Exact point gaps per sport (wrestling style, TKD) go in seed data and are checked against the
current federation rulebook when seeding. They are not written into code.

### `performance`: field, measured marks

```ts
{
  kind: 'performance',
  measure: 'time' | 'distance' | 'height' | 'weight' | 'reps' | 'points' | 'judged',
  better: 'lower' | 'higher',
  attempts: number,                     // 1 for a race, 3 for jumps/lifts
  aggregate: 'best' | 'sum_of_best_per_lift' | 'sum',
  lifts?: string[],                     // ['squat','bench','deadlift'] / ['snatch','clean_jerk']
  refereeValidity?: { refs: 3; goodNeeded: 2 },  // lifting lights
  verticalProgression?: boolean,        // high jump / pole vault: 3 fails at a height = out
  judgePanel?: { judges: number; dropHighLow: boolean }, // calisthenics freestyle
  placementPoints?: number[],           // battle royale placement table
  perKillPoints?: number,
  tiebreak: ('bodyweight'|'countback'|'earlier_attempt'|'fewer_fails'|'photo')[],
  statuses: ('DNS'|'DNF'|'DQ'|'NM')[],
}
```

Events: `attempt{entryId, lift?, value, valid}` and `mark{entryId, value}`; `status{entryId, code}`.
Bulk result import (CSV from chip timing / swim timing systems) is also supported, recorded as
`source: 'imported'`.

### `scorecard`: field, per-hole / per-frame / per-end cards

```ts
{
  kind: 'scorecard',
  method: 'strokes' | 'tenpin' | 'ends',
  units: number,                        // 18 holes / 10 frames / 12 ends
  par?: number[],                       // from the venue/course, per hole
  handicap?: 'none' | 'net',
  arrowsPerEnd?: number, maxArrowValue?: number,  // archery 10 (X counts 10, tracked for ties)
}
```

`tenpin` is a scoring method, not a sport branch: strike/spare bonuses and the 3-ball 10th frame
live in the engine, and the card is computed from the rolls.

---

## Cross-cutting changes

### 1. Engine: one module per family, one registry

```
scoring/engine/
  index.ts        // registry: kind → { initial, apply, validateResult, summarize }
  rally.ts  sets.ts  goals.ts  series.ts  innings.ts  bouts.ts
  performance.ts  scorecard.ts
```

`switch (rule.kind)` exists **only** in the registry. `applyPoint` stays as a compatibility wrapper
for rally/sets/goals so current clients keep working. The engine must remain a pure function shared
by server and app (`Match.scoringRule` already carries the rule to the client). If it isn't already a
shared workspace package, it should be made one (`@play/scoring-engine`).

### 2. Typed score events

- New mutation `recordScoreEvent(input: { matchId | heatId, expectedSeq, event: JSON })`. The event is
  validated by the family's Zod schema. `recordPoint` stays.
- `match_score_events.kind` CHECK expands; add `payload jsonb` (the event) and optional
  `actor_player_id` for player-level stats (who scored, who bowled).
- R1–R3 unchanged: `state_after` is still the complete state.

### 3. Score state per family, generic summary for everyone

`ScoreState` becomes a union keyed by `kind`. Spectator lists, brackets and notifications should not
need to know about families, so every family also implements `summarize(state, rule)`:

```graphql
type ScoreSummary { a: String!  b: String!  status: String! }   # "182/6 (20)" · "Sharma won by 4 wkts"
type ScoreState   { kind: ScoringKind!  summary: ScoreSummary!  detail: JSON!  seq: Int! … }
```

Keep the existing `games/current/points/serving` fields for rally/sets/goals.

### 4. Field contests: `Heat`

`Match` stays two-sided. Field sports get new tables owned by `scoring`:

- `heats`: event, round (heat / semi / final / flight), sport, rule, status, `score_seq`
- `heat_entries`: registration, lane/bib/tee time, `mark`, `rank`, `status` (DNS/DNF/DQ),
  `detail jsonb` (attempts, card)
- `heat_score_events`: same append-only guarantees as `match_score_events`

`tournament` gains stage types: **heats → final** (qualify top N / fastest losers), **leaderboard**
(golf stroke play, bowling, BR), **flight/total** (lifting), plus **Swiss** and **round robin** for
chess.

### 5. Results: draws, methods, field results

- `match_results.winner_registration_id` becomes nullable; `outcome` adds `draw`, `tie`, `no_result`.
- New `method` column: `ko|tko|submission|decision_unanimous|decision_split|decision_majority|fall|
  gap|dq|runs|wickets|super_over|...`, plus `margin text` ("by 23 runs").
- Draws are only accepted in stages that allow them (league/Swiss). A knockout stage still requires
  the rule's tiebreaker (existing behaviour).
- `winnerOf` → `validateResult(rule, submitted)` per family, so typed results are held to the same
  rules as live ones (existing principle).
- Finality (R6, R11–R14) applies to heats too: a heat result is confirmed by the official/staff, not
  by "the other side".

### 6. Rating

- Head-to-head families feed Glicko as today. Draws score 0.5 (chess, football, cricket tie).
- Field families do **not** feed Glicko in v1. They produce **personal bests** and **leaderboards**
  (per sport, per event/distance, per band). Gym/Fitness is PB-only.
- `rating R7` exclusions extend to `no_result` and non-`played` methods.

### 7. Officials

Judged sports (boxing/MMA cards, calisthenics freestyle) need several people to submit for the same
match. Add a `judge` grant. Each judge's card is a separate event, and the engine aggregates them
(majority / split / drop high-low).

### 8. App: one scoring pad per family, not per sport

The frontend `11-live-scoring` gets 8 pads: tap-a-side (rally/sets), score-with-value (goals),
unit tracker (series), **ball-by-ball** (innings), round clock + cards (bouts), attempt sheet
(performance), card grid (scorecard). Labels (frame/map/rack, "raid", "3PT") come from the rule.

---

## Sport-by-sport

| Sport | Family | Default rule (seed) | Formats (examples) |
|---|---|---|---|
| Cricket | innings | 20 overs, 6 balls, 10 wkts, super over | T10, T20, ODI, box (6 overs), tennis-ball |
| Football | goals | 2×45, extra time then shootout | 11s, 7s, 5s futsal |
| Basketball | goals | 4×10, values 1/2/3, repeating OT | 5v5, 3x3 (to 21) |
| Volleyball | rally | 25, win by 2, best of 5, decider 15 | indoor, beach (21/15, best of 3) |
| Kabaddi | goals | 2×20, multi-point raids, shootout | standard, circle |
| Badminton | rally | seeded | singles, doubles, mixed |
| Tennis | sets | seeded | best of 3, super-tiebreak decider, Fast4 |
| Table Tennis | rally | seeded | singles, doubles |
| Pickleball | rally | seeded | singles, doubles, mixed |
| Padel | sets | golden point, 6-6 TB, super-TB decider | doubles |
| Squash | rally | 11 PAR, win by 2, best of 5 | singles, doubles |
| Running | performance | time, lower, 1 attempt | 5K, 10K, half, marathon, track |
| Cycling | performance | time, lower | time trial, road race (placing), criterium |
| Swimming | performance | time, lower, heats → final | per stroke/distance |
| Gym / Fitness | performance | reps/weight/time challenges | + PB activity log (see open questions) |
| Golf | scorecard | strokes, 18 holes, par from course | stroke play, match play (series), net |
| Boxing | bouts | judges_10pt, 3 judges | amateur 3×3, pro N rounds |
| MMA | bouts | judges_10pt, KO/TKO/sub | 3×5, 5×5 |
| Wrestling | bouts | points, fall, tech superiority | freestyle, Greco-Roman |
| Karate | bouts | points 1/2/3, gap stop, senshu | kumite (kata → performance/judged) |
| Taekwondo | bouts | points, rounds to win | kyorugi (poomsae → performance/judged) |
| Powerlifting | performance | weight, 3×3 lifts, 2/3 lights, total | raw, equipped, per weight class |
| Weightlifting | performance | weight, snatch + C&J, total | per weight class |
| Calisthenics | performance | judged panel or reps | freestyle, endurance, battles (series) |
| Athletics | performance | per event (time/distance/height) | sprints, jumps (vertical), throws |
| Bowling | scorecard | tenpin, 10 frames | singles, series of 3 games |
| Archery | scorecard | ends × arrows, X for ties | ranking round; H2H set system (series) |
| Snooker | series | frames, points, best of N | 6-red, 15-red |
| Pool | series | racks, win only, race to N | 8-ball, 9-ball |
| Billiards | series | points to target | English billiards |
| Carrom | series | games to 25 / 8 boards, best of 3 | singles, doubles |
| Chess | series | 1 game, draws 0.5 | classical/rapid/blitz; Swiss events |
| Esports | series / goals / performance | best-of maps | per title: Valorant/CS2 (series), EA FC (goals), BGMI/Free Fire (performance) |

---

## Phases

Each phase ends with a **multi-sport acceptance test**: seed the phase's sports and score a real
historical match/scorecard from start to finish (golden fixture). The final state must match the
published result.

| # | Phase | Delivers | Size |
|---|---|---|---|
| 0 | **Foundation** | Engine registry, typed events + `payload`, `ScoreState` union + `summary`, draws/method/margin on results, shared engine package | M |
| 1 | **Free wins** | Volleyball, Squash (seed only); Padel (+super-TB); Basketball values/OT; Kabaddi | S |
| 2 | **Cricket** | `innings` family, ball-by-ball pad, scorecard (batting/bowling), super over | L |
| 3 | **Series** | Chess (+ Swiss stage), Pool, Snooker, Billiards, Carrom, Esports (map-based) | M |
| 4 | **Combat** | `bouts` family, round clock, judge grant + cards, finish methods | M |
| 5 | **Field** | `Heat` tables, heats→final & leaderboard stages, `performance` family: Running, Swimming, Cycling, Athletics, lifting, Calisthenics, BR esports, CSV import | L |
| 6 | **Scorecard** | Golf (course par data from venues), Bowling, Archery | M |
| 7 | **Fitness & stats** | Gym PB/activity log, player-level stats (top scorer, batting avg), PB leaderboards | M |

Cricket is placed right after the foundation work because it is likely the highest-demand sport for
this market. Phases 3–6 are independent of each other after Phase 0 and can run in parallel.

## Out of scope (v1)

Multi-day / Test cricket, computed DLS (officials enter revised targets), combined events
(decathlon), electronic-timing hardware integration beyond CSV import, VAR/replay review, and
per-title esports stat APIs.

## Open questions

1. **Gym/Fitness:** is this competitions (challenges, powerlifting-style meets) or personal workout
   tracking? The second is a separate feature, not scoring.
2. **Priority:** confirm cricket goes first after the foundation, or pick another sport.
3. **Stats depth:** result-only per sport at first, or player-level stats (cricket scorecards, top
   scorers) from day one? This decides whether `actor_player_id` is required in Phase 0.
4. **Esports titles:** which titles at launch? Battle royale (BGMI/Free Fire) pulls field contests
   (Phase 5) forward.
