# 09 — tournament

| | |
|---|---|
| **Sprint** | 8 |
| **Phase** | 1 |
| **Depends on** | events, registration |
| **Owns** | `tournaments`, `matches`, `court_assignments` |
| **Rule prefix** | `tournament R*` |
| **Risk** | **Concurrency** |

Draw generation with Championship **and** Plate, court scheduling, and advancement. Every match
knows where its winner and its loser go **before a single point is played**.

---

## Service interface

```ts
generateDraw(actor, { eventCategoryId })        => Tournament
regenerateDraw(actor, tournamentId)             => Tournament   // pre-first-match only
schedule(tournamentId)                          => CourtAssignment[]
assignCourt(actor, matchId, courtId, startsAt)  => Match         // manual override
advance(matchId, result: MatchResult)           => void          // scoring calls this
bracketFor(eventCategoryId)                     => Bracket
standingsFor(eventCategoryId)                   => StandingRow[]
liveMatches(eventId)                            => Match[]
fixturesFor({ eventId?, userId?, from?, to? }, page) => Page<Match>   // "Fixtures", every draw type
setFixtureTime(actor, matchId, startsAt)        => Match             // leagues calls this (R14)
resolveUnplayed(matchId, policy)                => void              // leagues calls this (R16)
withdrawEntry(registrationId)                   => void              // registration calls this (R18)
```

## GraphQL

```graphql
Mutation.generateDraw(input: GenerateDrawInput!): GenerateDrawPayload!
Mutation.assignCourt(input: AssignCourtInput!): MatchPayload!
Query.fixtures(eventId: ID!, from: DateTime, to: DateTime, first: Int = 50, after: String): MatchConnection!

type Viewer { upcomingMatches(first: Int = 10): [Match!]! }

type Tournament implements Node {
  id: ID!
  category: EventCategory!
  championship: [BracketRound!]!
  plate: [BracketRound!]!
  standings: [StandingRow!]!
  liveMatches: [Match!]!
}

type Match implements Node {
  id: ID!
  bracket: BracketType!       # CHAMPIONSHIP | PLATE | LEAGUE (R14)
  round: Int!
  slot: Int!
  sideA: Registration
  sideB: Registration
  court: Court
  scheduledAt: DateTime
  status: MatchStatus!
  currentScore: ScoreState
  result: MatchResult
}
```

---

## Draw generation

**R1** — Only `confirmed` and `checked_in` registrations enter a draw. A payment still pending at
draw time is not in the tournament.

**R2** — Seeding is by settled rating descending. Unrated entries sort last, tie-broken
deterministically by confirmation time, so a regenerated draw is reproducible.

**R3** — Bracket size is the next power of two. Byes go to the top seeds and are written as **real
match rows** with one side null and `status = 'walkover'` — a bye is a result, so advancement has
no special case.

**R4** — Seeds are placed by standard bracket positions (1 v 16, 8 v 9, …), so the top two seeds can
only meet in the final.

**R5** — The Plate is sized to the number of first-round losers, and Championship round-1 matches
carry `loser_match_id` pointing into Plate round 1. **Both brackets and all wiring are generated in
one pass.**

**R6** — The whole draw is written in **one transaction**. A partially generated draw is not a state
the system can be in.

**R7** — A draw requires at least four entries (`min_entries`). Below that the category is refunded
rather than played.

**R8** — Once any match has left `scheduled`, the draw is immutable. `regenerateDraw` throws
`DRAW_LOCKED`.

## Advancement & scheduling

**R9** — Advancement takes a per-tournament `pg_advisory_xact_lock`. Two courts finishing
simultaneously must not write the same next-match slot concurrently.

> **Transaction-scoped only.** `pg_advisory_lock` would leak onto a pooled Neon connection.
> See [ADR 0001 § C3](../decisions/0001-neon-over-supabase.md).

**R10** — Advancing an already-completed match is a **no-op, not an error**. The operation is
idempotent because it is reachable from a retried job.

**R11** — The scheduler is greedy, re-run whenever a match becomes ready, and respects a minimum
rest of **20 minutes** between a player's matches.

**R12** — Every round-*n* match is scheduled before any round-*n+1* match on the same court, so a
bracket cannot deadlock waiting on itself.

**R13** — The schedule is **advisory**. Organizers reassign courts by hand constantly and the API
allows it. The scheduler removes typing; it does not own the schedule.

## Round robin, fixtures & withdrawals

**R14** *(Sprint 13)* — Draw type `round_robin` generates every pairing in a category using the
circle method. Pairings are written as `bracket = 'league'` matches, with `round` as the matchday
and **no winner/loser wiring**. Fixtures are dated through `setFixtureTime`, which `leagues` calls;
the same-day greedy scheduler and its rest rule (R11, R12) do not apply. Advancement (R9, R10)
records the result and updates standings instead of placing sides.

**R15** *(Sprint 13)* — Round-robin standings are a table owned by this module, updated **in the
advancement transaction** under the same advisory lock: played, won, lost, games for/against,
points for/against, league points. Order follows the season's configured tiebreakers, with
confirmation time as the final deterministic tiebreak (as in R2). A correction that changes a
winner (`scoring R8`) recomputes the affected rows in the same transaction.

**R16** *(Sprint 13)* — A fixture still unplayed at its deadline is resolved by the league's policy:
a walkover to the side that was ready, or a double forfeit that awards neither side points. Both
are results with `outcome != 'played'`, so `rating R7` excludes them.

**R17** *(Sprint 8)* — The `match.completed` outbox payload is a **complete summary**: match,
tournament, event, sport, venue, bracket, both sides' registration and player ids, winner, outcome,
games and `completedAt`. Consumers — profile match history (`profile R12`), venue visits
(`venues R6`), the feed and achievements — never read `matches`. Changing the payload shape means a
new versioned topic (`match.completed.v2`).

**R18** *(Sprint 7)* — When `registration` withdraws an entry after the draw (`registration R16`),
`withdrawEntry` turns every unplayed match of that entry into a walkover to the opponent through
`advance`. Wiring, Plate drops and idempotency therefore stay on the single write path. Ratings are
unaffected (`rating R7`).

---

## Advancement

Because the wiring is precomputed, confirming a result is a single write with no traversal:

```ts
await db.$transaction(async (tx) => {
  // Serialize advancement per tournament. (R9)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tournamentId}))`;

  const m = await tx.match.findUniqueOrThrow({ where: { id: matchId } });
  if (m.status === 'completed') return;          // idempotent by design (R10)

  await tx.matchResult.create({ data: result });
  await tx.match.update({ where: { id: matchId }, data: { status: 'completed' } });

  // Winner up the championship; loser across to the plate, if wired.
  if (m.winnerMatchId) await placeSide(tx, m.winnerMatchId, m.winnerSlot, winnerId);
  if (m.loserMatchId)  await placeSide(tx, m.loserMatchId,  m.loserSlot,  loserId);

  await outbox.write(tx, { topic: 'match.completed', payload: { matchId, tournamentId } });
});
```

---

## Schema

> **The applied form is `prisma/migrations/…_009_tournament`**, and it differs from the sketch
> below in three places that were discovered while building it. Each is explained in the migration:
>
> 1. **`tournaments.plate_size`** — the Plate is sized to the number of first-round losers, which is
>    the number of round-1 matches that are a real contest. Sizing it off the bracket instead
>    creates Plate positions nothing can ever fill.
> 2. **`matches.winner_registration_id`** — `match_results` (scoring) records *how* a match was won;
>    a final advances nobody, so the bracket needs its own record *that* it was.
> 3. **The court exclusion constraint** calls an `IMMUTABLE` helper, `court_booking_window()`.
>    Postgres refuses `starts_at + interval` directly in an index expression: `timestamptz +
>    interval` is only `STABLE`.

```sql
CREATE TABLE tournaments (
  id                uuid PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES events(id),
  event_category_id uuid UNIQUE NOT NULL REFERENCES event_categories(id),
  draw_type         text NOT NULL DEFAULT 'single_elim_with_plate',
  bracket_size      smallint NOT NULL,
  drawn_at          timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE TABLE matches (
  id                uuid PRIMARY KEY,
  tournament_id     uuid NOT NULL REFERENCES tournaments(id),
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  sport_id          uuid NOT NULL REFERENCES sports(id),
  bracket           text NOT NULL CHECK (bracket IN ('championship','plate')),
  round             smallint NOT NULL,
  slot              smallint NOT NULL,
  side_a_registration_id uuid REFERENCES registrations(id),
  side_b_registration_id uuid REFERENCES registrations(id),
  -- Wiring generated at draw time, both directions. (R5)
  winner_match_id   uuid REFERENCES matches(id),
  winner_slot       smallint CHECK (winner_slot IN (0,1)),
  loser_match_id    uuid REFERENCES matches(id),
  loser_slot        smallint CHECK (loser_slot IN (0,1)),
  court_id          uuid REFERENCES venue_courts(id),
  scheduled_at      timestamptz,
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                      ('scheduled','ready','live','awaiting_confirm',
                       'completed','walkover','void')),
  current_score     jsonb,                     -- denormalized; owned by scoring
  score_seq         integer NOT NULL DEFAULT 0,
  UNIQUE (tournament_id, bracket, round, slot)
);
CREATE INDEX matches_live_idx ON matches (event_category_id, status, scheduled_at);
CREATE INDEX matches_court_idx ON matches (court_id, scheduled_at)
  WHERE court_id IS NOT NULL;

CREATE TABLE court_assignments (
  match_id      uuid PRIMARY KEY REFERENCES matches(id),
  court_id      uuid NOT NULL REFERENCES venue_courts(id),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  assigned_by   text NOT NULL CHECK (assigned_by IN ('scheduler','organizer')),
  EXCLUDE USING gist (                          -- no double-booking a court
    court_id WITH =,
    tstzrange(starts_at, coalesce(ends_at, starts_at + interval '45 minutes')) WITH &&
  )
);

-- Sprint 13 additions (R14, R15)
ALTER TABLE matches DROP CONSTRAINT matches_bracket_check;
ALTER TABLE matches ADD CONSTRAINT matches_bracket_check
  CHECK (bracket IN ('championship','plate','league'));

CREATE TABLE tournament_standings (
  tournament_id     uuid NOT NULL REFERENCES tournaments(id),
  registration_id   uuid NOT NULL REFERENCES registrations(id),
  played            smallint NOT NULL DEFAULT 0,
  won               smallint NOT NULL DEFAULT 0,
  lost              smallint NOT NULL DEFAULT 0,
  games_for         smallint NOT NULL DEFAULT 0,
  games_against     smallint NOT NULL DEFAULT 0,
  points_for        integer  NOT NULL DEFAULT 0,
  points_against    integer  NOT NULL DEFAULT 0,
  league_points     smallint NOT NULL DEFAULT 0,
  position          smallint,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, registration_id)
);
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `INSUFFICIENT_ENTRIES` | user | Fewer than `min_entries` — R7 |
| `DRAW_ALREADY_GENERATED` | user | Use `regenerateDraw` |
| `DRAW_LOCKED` | user | A match has already started — R8 |
| `COURT_DOUBLE_BOOKED` | user | The exclusion constraint fired |
| `MATCH_NOT_READY` | system | Both sides not yet filled |
| `FIXTURE_ALREADY_PLAYED` | user | Cannot reschedule a played fixture — R14 |

## Emits

| Event | Consumers |
|---|---|
| `draw.generated` | notifications |
| `match.ready` | notifications, realtime |
| `match.completed` | rating, realtime, profile, venues, social, organizers — full summary (R17) |
| `standings.updated` | realtime, leagues |
| `tournament.completed` | rating, events |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `schedule-courts` | Match becomes ready | 3 × exp | Alert; organizer assigns manually |
| `notify-starting-soon` | 30 min before `scheduled_at` | 3 × exp | Drop |

---

## Done when

A 32-entry draw generates **31 Championship matches and 15 Plate matches** with complete winner and
loser wiring. Scoring every match to completion leaves exactly one Championship winner, one Plate
winner, and **zero unfilled slots**. Two matches confirmed in the same millisecond both advance
correctly.

---

## Implementation checklist

- [ ] Migration `009_tournament.sql` including the `EXCLUDE USING gist` court constraint
      (needs `btree_gist`)
- [ ] Seeding + standard bracket position placement as a **pure function**, unit-tested for
      sizes 4, 8, 16, 32 and non-powers-of-two with byes
- [ ] Plate sizing and cross-wiring in the same pass (R5)
- [ ] Whole draw in one transaction (R6)
- [ ] `advance()` under `pg_advisory_xact_lock`, idempotent (R9, R10)
- [ ] Greedy scheduler with min-rest and round ordering (R11, R12)
- [ ] Manual `assignCourt` override (R13)
- [ ] Concurrency test: two simultaneous `advance()` calls on sibling matches
- [ ] Full-tournament test: score all 46 matches, assert zero unfilled slots
- [ ] Tests naming R1, R3, R5, R6, R7, R8, R9, R10, R11
- [ ] *(Sprint 7)* `withdrawEntry` → walkovers through `advance` (R18)
- [ ] *(Sprint 8)* Full `match.completed` payload contract (R17)
- [ ] *(Sprint 13)* `round_robin` generation (circle method), `setFixtureTime`, standings in the
      advancement transaction, unplayed-fixture resolution (R14, R15, R16)
- [ ] Tests naming R14, R15, R16, R17, R18

---

## Additions 2026-10-04 (flow review F1, F14, F23)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

- **F1** — `drawPreview(input)` plans the draw without writing it. `GenerateDrawInput.seedOrder` and
  `regenerateDraw(seedOrder)` replace the rating order with the host's; it must list every confirmed entry once
  (`INVALID_SEEDING`).
- **F23** — `single_elim`: the knockout without the Plate. With `third_place`, the two semi-finals' losers are
  wired (`loser_match_id`) into a `third_place` match; standings place its winner 3 and loser 4.
  `Tournament.thirdPlace`, `BracketType.THIRD_PLACE`.
- **F14** — the scheduler places matches on the event's own courts; failing that, on the venue's courts only
  when the event's organizer created the venue. The slot is the draw's `match_minutes` (default 45).
  `assignCourt` accepts event and venue courts. `setMatchTime(matchId, startsAt)` sets a time with no court and
  emits `match.scheduled` (the 30-minute reminder).
- `startedMatchCount(eventId)` for payouts (F3).
