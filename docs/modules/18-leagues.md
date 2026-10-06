# 18 — leagues

| | |
|---|---|
| **Sprint** | 13 |
| **Phase** | **3** |
| **Depends on** | organizers, events, registration, tournament, communities |
| **Owns** | `leagues`, `league_seasons`, `league_divisions`, `league_movements`, `league_final_standings`, `fixture_reschedule_requests` |
| **Rule prefix** | `leagues R*` |

Recurring competition over weeks: seasons, divisions, fixtures, standings, and promotion and
relegation. Architecture §9 left a seam for this ("`tournaments` already sits between event and
match"). This module uses that seam instead of building a second competition stack.

**The whole design in one line:** a **season is an event** (`events.kind = 'league_season'`), a
**division is an event category** (`draw_type = 'round_robin'`), and its **fixtures are ordinary
matches**. Registration, payments, scoring, live scores, results and rating work unchanged. This
module owns only what is actually new: the league brand, season configuration, fixture
rescheduling, and movement between divisions.

---

## Service interface

```ts
createLeague(actor, organizerProfileId, input)          => League
updateLeague(actor, leagueId, patch)                    => League
bySlug(slug) / byId(leagueId)                           => League
createSeason(actor, leagueId, SeasonInput)              => Season    // creates the event + categories
publishSeason(actor, seasonId)                          => Season    // → events.publish
generateFixtures(actor, seasonId)                       => Fixture[] // → tournament.generateDraw(round_robin)
proposeReschedule(actor, matchId, proposedAt, note?)    => RescheduleRequest
respondReschedule(actor, requestId, 'accept' | 'decline') => RescheduleRequest
standings(divisionId)                                   => StandingRow[]   // → tournament.standingsFor
closeSeason(actor, seasonId)                            => SeasonClose     // R3, R9
priorityListFor(eventCategoryId)                        => { userIds, until } // events calls this
```

```ts
type SeasonInput = {
  name: string;                       // "Spring 2027"
  startsOn: Date; endsOn: Date;
  matchday: { weekday: 0-6, time: 'HH:mm', venueId?: string };
  fixtureDeadline: 'matchday' | 'end_of_week' | 'end_of_season';
  divisions: { name: string; level: number; capacity: number; entryFeePaise: number }[];
  pointsForWin: number;               // default 2
  tiebreakers: ('points' | 'head_to_head' | 'game_diff' | 'point_diff')[];
  promote: number; relegate: number;  // per adjacent division boundary
  forfeitPolicy: 'walkover_to_opponent' | 'double_forfeit';
  priorityWindowHours: number;        // default 72 (R4)
};
```

## GraphQL

```graphql
Query.league(slug: String!): League
Query.leagues(sportId: ID, city: String, near: GeoPointInput, first: Int = 20, after: String): LeagueConnection!

type League {
  id: ID!
  slug: String!
  name: String!
  sport: Sport!
  city: String!
  organizer: OrganizerProfile!
  currentSeason: LeagueSeason
  seasons(first: Int = 10, after: String): LeagueSeasonConnection!
  pastChampions: [DivisionChampion!]!
}

type LeagueSeason {
  id: ID!
  event: Event!                       # the season IS an event — R1
  status: SeasonStatus!               # DRAFT | REGISTRATION | IN_PROGRESS | COMPLETED | CANCELLED
  divisions: [Division!]!
}

type Division {
  id: ID!
  level: Int!
  name: String!
  category: EventCategory!            # the division IS a category — R1
  standings: [StandingRow!]!
  fixtures(matchday: Int, first: Int = 50, after: String): MatchConnection!
}

Mutation.createLeague / updateLeague / createLeagueSeason / publishLeagueSeason
Mutation.generateLeagueFixtures(seasonId: ID!): GenerateFixturesPayload!
Mutation.proposeFixtureReschedule(input: ProposeRescheduleInput!): ReschedulePayload!
Mutation.respondFixtureReschedule(input: RespondRescheduleInput!): ReschedulePayload!
Mutation.closeLeagueSeason(seasonId: ID!): CloseSeasonPayload!
```

"Discover leagues" is `Query.leagues`, together with `events(filter: { kind: LEAGUE_SEASON })`
(events R11) and `search(kinds: [LEAGUE])` (discovery).

---

## Rules

**R1** — A season is an event and a division is a category. This module **never duplicates**
registration, payment, match, scoring or rating machinery. If a league needs something those
modules lack, the missing concept is added to them.

**R2** — Season configuration (points, tiebreakers, promotion/relegation counts, fixture deadline,
forfeit policy) is **frozen once the first fixture is played**. The principle is `events R2`:
players agreed to specific terms.

**R3** — Divisions are ordered, with level 1 highest. At `closeSeason`, the top `promote` entries
move up and the bottom `relegate` entries move down across each adjacent boundary. Movements are
written to `league_movements`. The top division cannot promote and the bottom cannot relegate.

**R4** — Movement grants **priority, not a place**. For the next season, each returning entrant gets
an exclusive window (`priorityWindowHours`, default 72) to register into their assigned division
before open registration. It is exposed to `events` as an allow-list (`events R14`). Entrants still
register and pay each season, so an abandoned slot returns to the pool when the window closes.

**R5** — Fixtures are a single round-robin per division (`tournament R14`), one matchday per
week on the season's slot. Before the fixture deadline, a fixture can be rescheduled by **mutual
agreement**: one captain proposes, the other accepts. A `manager` can also reschedule directly.
One pending proposal per fixture.

**R6** — A fixture unplayed at its deadline is resolved by `forfeitPolicy` through
`tournament R16`. Walkovers never touch rating (`rating R7`).

**R7** — In team-format leagues, entries come from `communities` teams (`registration R19`). Once
the season is `in_progress`, a team may add at most **2 roster players**, and a player may appear
for **one team per division**. The registration snapshot stays authoritative for who may play.

**R8** — A division below `min_entries` at registration close is merged into the adjacent division
if the organizer chose "merge", or cancelled and fully refunded (`events R9`).

**R9** — Final standings are **snapshotted at close** into `league_final_standings`. A result
correction after close requires `admin`, and then an explicit re-close that rewrites the snapshot
and the movements in one transaction. History must not shift silently.

**R10** — League standings and fixtures are public for any published season. Standings are
competitive record, and `profile R5` applies.

---

## Schema

```sql
CREATE TABLE leagues (
  id                   uuid PRIMARY KEY,
  organizer_profile_id uuid NOT NULL REFERENCES organizer_profiles(id),
  sport_id             uuid NOT NULL REFERENCES sports(id),
  slug                 text UNIQUE NOT NULL,
  name                 text NOT NULL,
  city                 text NOT NULL,
  description          text,
  logo_public_id       text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE league_seasons (
  id            uuid PRIMARY KEY,
  league_id     uuid NOT NULL REFERENCES leagues(id),
  event_id      uuid UNIQUE NOT NULL REFERENCES events(id),    -- R1
  name          text NOT NULL,
  config        jsonb NOT NULL,                  -- SeasonInput minus divisions; frozen (R2)
  config_frozen_at timestamptz,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN
                  ('draft','registration','in_progress','completed','cancelled')),
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE league_divisions (
  id                uuid PRIMARY KEY,
  season_id         uuid NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
  event_category_id uuid UNIQUE NOT NULL REFERENCES event_categories(id),   -- R1
  level             smallint NOT NULL CHECK (level >= 1),
  name              text NOT NULL,
  UNIQUE (season_id, level)
);

CREATE TABLE league_movements (
  season_id        uuid NOT NULL REFERENCES league_seasons(id),
  division_id      uuid NOT NULL REFERENCES league_divisions(id),
  registration_id  uuid NOT NULL REFERENCES registrations(id),
  movement         text NOT NULL CHECK (movement IN ('promoted','relegated','stayed')),
  next_level       smallint NOT NULL,
  PRIMARY KEY (season_id, registration_id)
);

-- Immutable snapshot at close (R9).
CREATE TABLE league_final_standings (
  season_id        uuid NOT NULL REFERENCES league_seasons(id),
  division_id      uuid NOT NULL REFERENCES league_divisions(id),
  registration_id  uuid NOT NULL REFERENCES registrations(id),
  position         smallint NOT NULL,
  row              jsonb NOT NULL,               -- played, won, lost, points, diffs
  PRIMARY KEY (season_id, division_id, registration_id)
);

CREATE TABLE fixture_reschedule_requests (
  id            uuid PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id),
  proposed_by   uuid NOT NULL REFERENCES users(id),
  proposed_at   timestamptz NOT NULL,
  note          text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','expired')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reschedule_one_pending
  ON fixture_reschedule_requests (match_id) WHERE status = 'pending';   -- R5
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `LEAGUE_NOT_FOUND` | user | Not found state |
| `SEASON_CONFIG_FROZEN` | user | R2 |
| `FIXTURES_ALREADY_GENERATED` | user | Show fixtures |
| `FIXTURE_DEADLINE_PASSED` | user | R5 |
| `RESCHEDULE_PENDING` | user | Show the pending proposal |
| `SEASON_NOT_COMPLETE` | user | Unplayed fixtures remain |
| `ROSTER_LOCKED` | user | R7 |

## Emits

| Event | Consumers |
|---|---|
| `league.season_published` | discovery, notifications (previous entrants) |
| `league.fixtures_generated` | notifications |
| `league.fixture_rescheduled` | notifications, realtime |
| `league.season_closed` | notifications, social (feed), profile (achievements) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `fixture-deadline-sweep` | Daily | 3 × exp | Alert |
| `matchday-reminder` | Day before each matchday | 3 × exp | Drop |
| `expire-reschedule-requests` | Hourly | 3 × exp | Drop |
| `open-priority-window` | At season publish | 3 × exp | Alert |

---

## Done when

A three-division season with 8 entries per division generates **28 fixtures per division**.
Standings update on every confirmed result, with tiebreakers applied in configured order. A
fixture past its deadline resolves by the forfeit policy without touching rating. Closing the
season promotes the top 2 and relegates the bottom 2, and next season's priority window lets
exactly those players register into their new divisions before public registration opens.

---

## Implementation checklist

- [ ] Migration `018_leagues.sql`
- [ ] `createSeason` writing the event (`kind = 'league_season'`) and one category per division in
      one transaction through `events` (R1)
- [ ] `tournament` round-robin draw type and standings (tournament R14, R15) — prerequisite
- [ ] Config freeze on first played fixture (R2)
- [ ] Mutual-agreement reschedule flow (R5); deadline sweep with forfeit policy (R6)
- [ ] Close: snapshot + movements in one transaction (R3, R9)
- [ ] Priority allow-list exposed to events (R4, events R14)
- [ ] Team roster lock during a live season (R7)
- [ ] Tests naming R1, R2, R3, R4, R5, R6, R7, R9
