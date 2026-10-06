# 12 — games

| | |
|---|---|
| **Sprint** | 10 · 11 (open play, waitlist, recurring games, community games) |
| **Phase** | **2** |
| **Depends on** | sport, venues, profile, communities (Sprint 11) |
| **Owns** | `games`, `game_participants`, `game_series`, `game_series_members` |
| **Rule prefix** | `games R*` |

Informal pickup games: someone needs a fourth on Saturday morning. **No payment, no bracket, no
rating impact** — which is exactly why it ships in a single sprint.

This is the retention module. The core loop gives a player something to do on tournament weekends;
this gives them something to do in the six weeks between.

> **2026-09-29:** follows were removed ([chat spec](../superpowers/specs/2026-09-29-chat-design.md)). Wherever this doc says *follows*,
> *followers* or *friends*, read **played with** (profile R10) until this module is re-specified.

---

## Service interface

```ts
search({ near, radiusKm, sportId, date, skillBand }, page) => Page<Game>
byId(gameId: string)                                       => Game
create(actor, input)                                       => Game
join(actor, gameId)                                        => Game
leave(actor, gameId)                                       => Game
cancel(actor, gameId, reason)                              => Game
invite(actor, gameId, playerIds[])                         => Invite[]
listForUser(userId)                                        => Game[]
// Sprint 11
createSeries(actor, input)                                 => GameSeries   // R10
updateSeries(actor, seriesId, patch)                       => GameSeries
cancelSeries(actor, seriesId, reason)                      => GameSeries
joinSeries(actor, seriesId) / leaveSeries(actor, seriesId) => GameSeries   // regulars (R11)
materializeSeries(seriesId, horizonDays)                   => Game[]       // job
```

## GraphQL

```graphql
Query.games(near: GeoPointInput, radiusKm: Float = 10, sportId: ID,
            from: DateTime, to: DateTime, skillBand: String,
            first: Int = 20, after: String): GameConnection!
Query.game(id: ID!): Game

type Game implements Node {
  id: ID!
  sport: Sport!
  venue: Venue
  locationNote: String        # when there is no venue row — "the courts near X"
  location: GeoPoint!
  startsAt: DateTime!
  durationMinutes: Int!
  skillBand: String
  capacity: Int!
  participants: [PlayerProfile!]!
  spotsRemaining: Int!
  kind: GameKind!              # PICKUP | OPEN_PLAY — R8
  courtsCount: Int             # open play only
  visibility: GameVisibility!  # PUBLIC | FOLLOWERS | COMMUNITY — R12
  community: Community
  series: GameSeries           # R10
  waitlistCount: Int!          # R9
  viewerWaitlistPosition: Int
  createdBy: PlayerProfile!
  viewerHasJoined: Boolean!
  status: GameStatus!          # OPEN | FULL | CANCELLED | PAST
}

Mutation.createGame(input: CreateGameInput!): GamePayload!
Mutation.joinGame(gameId: ID!): GamePayload!
Mutation.leaveGame(gameId: ID!): GamePayload!
Mutation.cancelGame(input: CancelGameInput!): GamePayload!
Mutation.inviteToGame(input: InviteToGameInput!): InviteToGamePayload!
Mutation.createGameSeries(input: CreateGameSeriesInput!): GameSeriesPayload!
Mutation.updateGameSeries(input: UpdateGameSeriesInput!): GameSeriesPayload!
Mutation.cancelGameSeries(input: CancelGameSeriesInput!): GameSeriesPayload!
Mutation.joinGameSeries(seriesId: ID!): GameSeriesPayload!
Mutation.leaveGameSeries(seriesId: ID!): GameSeriesPayload!

extend type Community { games(from: DateTime, first: Int = 20, after: String): GameConnection! }
```

---

## Rules

**R1** — The creator is a participant automatically. A game with zero participants cannot exist.

**R2** — Capacity is a plain count with **no holds and no TTL**. Nothing is being paid for, so a
unique constraint on `(game_id, user_id)` plus a capacity check inside the transaction is enough.
Do not import the seat-hold machinery from `registration` — it exists to protect money, and there is
none here.

**R3** — A game is `public`, or visible only to people the creator follows. There is no third option
in Phase 2.

**R4** — Games **never affect rating**. If informal results should count later, that is a new
`algo_version` conversation, not a schema change.

**R5** — Cancelling notifies every participant. A game whose start time has passed is archived by a
nightly job, never deleted.

**R6** — Map search reuses the same PostGIS index pattern as `events`, capped at the same **50 km**.

**R7** — The creator leaving cancels the game. There is no ownership transfer in Phase 2.

**R8** *(Sprint 11)* — **Open play.** A game with `kind = 'open_play'` is a drop-in session with
`courts_count` and a capacity of 4–64; pickup games keep 2–32. Only venue staff (`identity R17`) or
a community `owner`/`admin` may host one. Phase 2 has no fixed teams and no rotation engine. At a
bookable venue, venue staff reserve the courts through `bookings R11`; a game never books courts
itself.

**R9** *(Sprint 11)* — **Waitlist.** Joining a full game puts the player on a FIFO waitlist
(`game_participants.status = 'waitlisted'`). When a participant leaves, the head of the waitlist is
promoted **in the same transaction** and notified. There are no holds and no TTL; R2 still applies,
because nothing is paid for.

**R10** *(Sprint 11)* — **Recurring games.** A series stores a restricted recurrence: weekly, on
chosen weekdays, every 1–4 weeks, for at most 26 weeks. `materialize-series` creates the actual
`games` rows **21 days ahead**, so each instance is an ordinary game that search, join and cancel
already handle. Editing a series changes only instances that have not started, and keeps their
participants. Cancelling one instance never touches the series.

**R11** *(Sprint 11)* — **Regulars.** Series members are auto-joined to each new instance, in the
order they joined the series, up to capacity; the rest are waitlisted (R9). A regular can leave any
single instance without leaving the series.

**R12** *(Sprint 11)* — **Community games.** A game may belong to a community. With
`visibility = 'community'`, only members can see it, checked through `communities.isMember`. A
public game hosted by a community is listed normally and also shown on the community page.

---

## Schema

```sql
CREATE TABLE games (
  id                uuid PRIMARY KEY,
  sport_id          uuid NOT NULL REFERENCES sports(id),
  created_by        uuid NOT NULL REFERENCES player_profiles(id),
  venue_id          uuid REFERENCES venues(id),
  location_note     text,
  geo               geography(Point,4326) NOT NULL,
  city              text NOT NULL,
  starts_at         timestamptz NOT NULL,
  duration_minutes  smallint NOT NULL DEFAULT 90,
  skill_band        text,
  capacity          smallint NOT NULL CHECK (capacity BETWEEN 2 AND 32),
  visibility        text NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public','followers')),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','full','cancelled','past')),
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (venue_id IS NOT NULL OR location_note IS NOT NULL)
);
CREATE INDEX games_geo_idx ON games USING gist (geo)
  WHERE status IN ('open','full');
CREATE INDEX games_discovery_idx ON games (sport_id, city, starts_at)
  WHERE status IN ('open','full');

CREATE TABLE game_participants (
  game_id       uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES player_profiles(id),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, player_id)      -- R2
);
CREATE INDEX ON game_participants (player_id);

-- Sprint 11 additions (R8–R12)
CREATE TABLE game_series (
  id                 uuid PRIMARY KEY,
  created_by         uuid NOT NULL REFERENCES player_profiles(id),
  template           jsonb NOT NULL,           -- sport, venue, location, duration, capacity, kind…
  weekdays           smallint[] NOT NULL CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7),
  start_time         time NOT NULL,
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata',
  interval_weeks     smallint NOT NULL DEFAULT 1 CHECK (interval_weeks BETWEEN 1 AND 4),
  starts_on          date NOT NULL,
  ends_on            date NOT NULL CHECK (ends_on <= starts_on + 182),   -- 26 weeks (R10)
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','ended')),
  materialized_until date,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_series_members (
  series_id       uuid NOT NULL REFERENCES game_series(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES player_profiles(id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, player_id)
);

ALTER TABLE games
  ADD COLUMN kind text NOT NULL DEFAULT 'pickup' CHECK (kind IN ('pickup','open_play')),
  ADD COLUMN courts_count smallint,
  ADD COLUMN series_id uuid REFERENCES game_series(id),
  ADD COLUMN community_id uuid REFERENCES communities(id),
  DROP CONSTRAINT games_capacity_check,
  ADD CONSTRAINT games_capacity_check CHECK (
    (kind = 'pickup'    AND capacity BETWEEN 2 AND 32) OR
    (kind = 'open_play' AND capacity BETWEEN 4 AND 64)),
  DROP CONSTRAINT games_visibility_check,
  ADD CONSTRAINT games_visibility_check CHECK (visibility IN ('public','followers','community')),
  ADD CONSTRAINT games_community_visibility CHECK (visibility <> 'community' OR community_id IS NOT NULL);
CREATE UNIQUE INDEX games_series_instance ON games (series_id, starts_at) WHERE series_id IS NOT NULL;

ALTER TABLE game_participants
  ADD COLUMN status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','waitlisted'));  -- R9
CREATE INDEX ON game_participants (game_id, joined_at) WHERE status = 'waitlisted';
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `GAME_FULL` | user | Show the full state; offer similar games nearby |
| `ALREADY_JOINED` | user | Route to the game |
| `GAME_CANCELLED` | user | Show the cancelled state |
| `GAME_IN_PAST` | user | Cannot join a game that has started |
| `NOT_VISIBLE` | user | Followers-only and the viewer does not follow the creator |
| `HOST_NOT_ALLOWED` | user | Open play needs venue staff or a community admin — R8 |
| `NOT_A_MEMBER` | user | Community-only game — R12 |
| `SERIES_NOT_FOUND` | user | Not found state |

## Emits

| Event | Consumers |
|---|---|
| `game.invite` | notifications |
| `game.joined` | notifications (to the creator) |
| `game.cancelled` | notifications (to all participants) |
| `game.created` | discovery, social (feed) |
| `game.waitlist_promoted` | notifications |
| `game.past` | venues (visits projection) |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `archive-past-games` | Nightly | 3 × exp | Drop |
| `materialize-series` | Nightly, 21-day horizon | 3 × exp | Alert; instances missing from search |

---

## Done when

A game is created, appears on the map query within its radius, fills to capacity, rejects the next
joiner cleanly, and notifies everyone when the creator cancels.

---

## Implementation checklist

- [ ] Migration `012_games.sql`
- [ ] Create / join / leave / cancel with a capacity check in-transaction (R2)
- [ ] Followers-only visibility filter reusing `profile.follows` (R3)
- [ ] Map + list search with the 50 km cap (R6)
- [ ] Creator-leaves-cancels behaviour (R7)
- [ ] `archive-past-games` nightly job (R5)
- [ ] `game.invite` template wired in `notifications`
- [ ] Tests naming R1, R2, R3, R4, R7
- [ ] *(Sprint 11)* Open play kind + host check (R8); waitlist with in-transaction promotion (R9)
- [ ] *(Sprint 11)* `game_series`, `materialize-series`, regulars (R10, R11)
- [ ] *(Sprint 11)* Community games via `communities.isMember` (R12)
- [ ] Tests naming R8, R9, R10, R11, R12
