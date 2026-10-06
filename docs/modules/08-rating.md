# 08 — rating

| | |
|---|---|
| **Sprint** | 6 |
| **Phase** | 1 |
| **Depends on** | scoring, profile |
| **Owns** | `rating_events`, `rating_periods`, `rankings` |
| **Rule prefix** | `rating R*` |

Glicko-2 per player per sport, written **append-only**, with rankings as a cache rebuilt on write.
The algorithm is replaceable; the log is not.

> Built in Sprint 6, before `scoring` exists in Sprint 8. Develop and test it against the seeded
> tournament fixture, which produces confirmed match results without the live-scoring path.

---

## Why not Elo

Amateur players do not play continuously — they play four matches on a Saturday and then nothing
for six weeks. Elo has no memory of that gap and treats a rating from March as exactly as reliable
as one from yesterday.

Glicko-2 carries a **rating deviation** that grows with inactivity, so a returning player's rating
moves quickly to find its level again and a regular's does not swing on one upset. That is the
difference between a leaderboard players trust and one they dismiss.

---

## Service interface

```ts
applyMatch(matchId: string)                    => RatingEvent[]   // provisional
runPeriod(periodId: string)                    => { playersUpdated: number }
rebuildRankings(sportId, scope: RankingScope)  => { ranked: number }
ratingFor(playerId, sportId)                   => { rating, rd, provisional }
historyFor(playerId, sportId, page)            => Page<RatingEvent>
leaderboard(sportId, scope, page)              => Page<RankingRow>
replay(sportId, fromDate, algoVersion)         => void            // backfill only
```

## GraphQL

```graphql
Query.rankings(sportId: ID!, scope: RankingScope!,
               first: Int = 50, after: String): RankingConnection!

type RankingRow {
  rank: Int!
  player: PlayerProfile!
  rating: Float!
  matchesPlayed: Int!
  movement: Int!        # vs the previous rebuild; +3 means "up three places"
}

union RankingScope = National | City | AgeBand
```

---

## Two numbers, honestly labelled

Glicko-2 is defined over rating **periods**, batching results. Players want their rating to move the
moment they win. So: both.

| Value | Computed | Shown as |
|---|---|---|
| **provisional** | Immediately after each confirmed result, single-match update | The number that moves on Match Detail, badged `PROVISIONAL` |
| **settled** | Weekly period job, Monday 03:00 IST | The rating on the profile, and the **only** input to `rankings` |

Provisional rows carry `is_provisional = true` and are superseded when the period runs. Both live in
the same log, so a player's history reads continuously.

---

## Rules

**R1** — Ratings are Glicko-2, not Elo. Rating deviation grows with inactivity.

**R2** — Two numbers exist and are labelled differently in the UI: provisional and settled. Never
show one where the other is meant.

**R3** — Provisional rows carry `is_provisional = true` and are superseded by the period job.

**R4** — The rating period runs weekly, **Monday 03:00 IST**, over every match confirmed since the
previous period.

**R5** — For doubles: a team's rating is the **mean** of its members, its RD the **root-mean-square**
of theirs. The team-level delta is split between partners **inversely to their RD** — the less
certain player absorbs more of the change, which is what RD means.

**R6** — A win against a team rated more than **400 points below** yours contributes at reduced
weight, so stacking soft draws cannot inflate a ranking.

**R7** — Walkovers, retirements and forfeits do **not** affect either player's rating. Only
`outcome = 'played'` reaches the engine.

**R8** — Every row carries `algo_version`. Replacing the model means writing `glicko2-v2` and
replaying the log — **no migration**. This is the whole point of the append-only design.

**R9** — A player needs **five settled matches** in a sport before appearing in `rankings`. Below
that the profile shows *unranked* rather than a misleading number.

**R10** — Ranking scopes are enumerated, not arbitrary: `national`, `city:<name>`, `age:<band>`. An
open-ended scope string is an unbounded table.

**R11** — `movement` is computed against the previous rebuild and stored, so the leaderboard's
up/down arrow costs no second query.

**R12** — Ratings reach `player_sports` **only** through `profile.applyRating()`. This module never
issues an `UPDATE` against another module's table.

---

## Schema

```sql
CREATE TABLE rating_periods (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  ran_at        timestamptz,
  algo_version  text NOT NULL,
  UNIQUE (sport_id, starts_at)
);

CREATE TABLE rating_events (
  id               bigserial PRIMARY KEY,
  player_id        uuid NOT NULL REFERENCES player_profiles(id),
  sport_id         uuid NOT NULL REFERENCES sports(id),
  match_id         uuid REFERENCES matches(id),
  rating_period_id uuid REFERENCES rating_periods(id),
  algo_version     text NOT NULL,              -- 'glicko2-v1' (R8)
  rating_before    numeric(7,2) NOT NULL,
  rating_after     numeric(7,2) NOT NULL,
  rd_before        numeric(7,2) NOT NULL,
  rd_after         numeric(7,2) NOT NULL,
  volatility_after numeric(7,5) NOT NULL,
  is_provisional   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rating_events (player_id, sport_id, created_at DESC);
-- One settled row per player per match. (R3)
CREATE UNIQUE INDEX rating_events_settled_uniq
  ON rating_events (player_id, match_id) WHERE is_provisional = false;

CREATE TABLE rankings (
  sport_id       uuid NOT NULL REFERENCES sports(id),
  scope          text NOT NULL,                -- 'national' | 'city:Bengaluru' (R10)
  player_id      uuid NOT NULL REFERENCES player_profiles(id),
  rank           integer NOT NULL,             -- dense
  rating         numeric(7,2) NOT NULL,
  matches_played integer NOT NULL,
  movement       integer NOT NULL DEFAULT 0,   -- R11
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (sport_id, scope, player_id)
);
CREATE INDEX rankings_board_idx ON rankings (sport_id, scope, rank);
```

### Ranking rebuild

```sql
INSERT INTO rankings (sport_id, scope, player_id, rank, rating,
                      matches_played, movement, computed_at)
SELECT $1, $2, ps.player_id,
       dense_rank() OVER (ORDER BY ps.rating DESC NULLS LAST),
       ps.rating, ps.matches_played,
       coalesce(prev.rank, 0) - dense_rank() OVER (ORDER BY ps.rating DESC NULLS LAST),
       now()
  FROM player_sports ps
  JOIN player_profiles pp ON pp.id = ps.player_id
  LEFT JOIN rankings prev
    ON prev.sport_id = $1 AND prev.scope = $2 AND prev.player_id = ps.player_id
 WHERE ps.sport_id = $1
   AND ps.matches_played >= 5        -- R9
   AND ps.is_provisional = false
   AND pp.city = $3
ON CONFLICT (sport_id, scope, player_id) DO UPDATE
   SET rank = EXCLUDED.rank, rating = EXCLUDED.rating,
       movement = EXCLUDED.movement, computed_at = EXCLUDED.computed_at;
```

The Rankings screen reads the `rankings` table directly (there is no Redis since migration 023; the
service still accepts an optional board cache), falling through to the read replica for deep pages.

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `RATING_UNAVAILABLE` | user | Fewer than five matches — R9 |
| `PERIOD_ALREADY_RUN` | system | Idempotency guard on `runPeriod` |
| `UNKNOWN_ALGO_VERSION` | system | Replay requested with an unregistered engine |

## Emits

| Event | Consumers |
|---|---|
| `rating.changed` | notifications |
| `ranking.moved` | notifications (threshold: 5 places) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `apply-provisional` | `result.confirmed` | 5 × exp | Alert; the period job corrects it |
| `run-period` | Weekly, Mon 03:00 IST | 3 × exp | **Page** — ratings frozen |
| `rebuild-rankings` | After period; on event completion | 3 × exp | Alert; cache serves stale |

---

## Done when

The seeded 32-entry tournament produces a ranked leaderboard with correct movement arrows — **and a
determinism test passes**: replaying the entire `rating_events` log under the same `algo_version`
reproduces every current rating to the last decimal.

Without that test, "swappable algorithm" is a claim rather than a property.

---

## Implementation checklist

- [ ] Migration `008_rating.sql`
- [ ] Glicko-2 engine as a **pure function** — no database access, fully unit-testable
- [ ] Validate the engine against the reference worked example from Glickman's paper
- [ ] Doubles split rule (R5) with its own unit tests, including equal-RD and extreme-RD cases
- [ ] 400-point damping (R6)
- [ ] `applyMatch` provisional path, skipping non-`played` outcomes (R7)
- [ ] `run-period` repeatable job with a `PERIOD_ALREADY_RUN` guard
- [ ] `rebuildRankings` with dense rank + stored movement (R11)
- [ ] ~~Redis top-200 cache per scope~~ — dropped with Redis (2026-09-29); add an in-process cache if reads demand it
- [ ] Writes go through `profile.applyRating()` only (R12)
- [ ] **Determinism replay test** — the Done when
- [ ] Tests naming R3, R5, R6, R7, R9, R12

---

## Additions 2026-10-04 (flow review F5, F26)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

- R7 gains a second door: a confirmed result is rated only when `ratable` — not when it confirmed itself on
  a player's own submission (`confirmed_via = auto` and `submitter_role = player`), and not from a draw with
  fewer than `MIN_RATED_DRAW_ENTRIES` (4) entries. Both the provisional preview and the weekly period apply it.
