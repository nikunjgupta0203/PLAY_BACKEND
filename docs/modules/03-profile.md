# 03 — profile

| | |
|---|---|
| **Sprint** | 2 |
| **Phase** | 1 |
| **Depends on** | identity, sport |
| **Owns** | `player_profiles`, `player_sports`, `achievements`, `player_preferences`, `player_match_history` |
| **Rule prefix** | `profile R*` |

The player as other players see them: sports, skill, location, results, achievements, and who they have
played with. Also the read model behind the Home screen's stats snapshot.

**Follows were removed on 2026-09-29** (migration 024, [chat spec](../superpowers/specs/2026-09-29-chat-design.md)). Players connect through
shared play — R10 — and the `chat` module, not a follower count. R7 is retired.

---

## Service interface

```ts
createFor(tx, userId, displayName)                => PlayerProfile   // identity calls this (R1)
byUserId(userId: string)                          => PlayerProfile
byId(playerId: string)                            => PlayerProfile
publicView(viewerId: string | null, playerId)     => PublicProfile
updateSports(actor, [{ sportId, skillBand }])     => PlayerProfile
selectOnboardingSports(actor, sportIds: string[])  => PlayerProfile
updateLocation(actor, { city, geo })              => PlayerProfile
setVisibility(actor, visibility)                  => PlayerProfile
avatarUploadSignature(actor)                      => CloudinarySignature
setAvatar(actor, publicId: string)                => PlayerProfile
statsSnapshot(playerId, sportId)                  => StatsSnapshot
search(query: string, sportId?, page)             => Page<PublicProfile>

// Called by the rating module. The ONLY way rating columns change. (R9)
applyRating(playerId, sportId, { rating, rd, volatility, matchesPlayed })

playedWith(playerId, { viewerUserId, first })         => PlayedWith[]           // R10
havePlayedTogether(playerId, otherId)                 => boolean                // chat R2
preferences(actor) / setPreferences(actor, prefs)     => PlayerPreferences      // R11
matchingProfile(playerId)                             => MatchingProfile | null // discovery calls this (R11)
matchHistory(viewerId, playerId, { sportId? }, page)  => Page<MatchHistoryRow>  // R12
recordMatchResult(payload: MatchCompletedPayload)     => void                   // projection job (R12)
evaluateAchievements(playerId, trigger)               => Achievement[]          // job (R13)
scrub(userId)                                         => void                   // identity R18
```

## GraphQL

```graphql
Query.playerProfile(id: ID!): PlayerProfile
Query.players(query: String!, sportId: ID, first: Int = 20): PlayerConnection!

type PlayerProfile implements Node {
  id: ID!
  displayName: String!
  avatarUrl: String
  city: String
  sports: [PlayerSport!]!
  recentResults(first: Int = 5): [MatchResultSummary!]!
  achievements: [Achievement!]!
  playedWith(first: Int = 20): [PlayedWith!]!          # R10
  viewerMessaging: Messaging                           # chat module
  matchHistory(sportId: ID, first: Int = 20, after: String): MatchHistoryConnection!   # R12
  visibility: ProfileVisibility!
  onboardingPendingSportIds: [ID!]!   # owner-only, [] otherwise
}

type PlayerSport {
  sport: Sport!
  skillBand: String!        # self-declared
  rating: Float             # derived, null until 5 matches
  ratingProvisional: Boolean!
  rank: Int                 # null when unranked
  matchesPlayed: Int!
}

Mutation.updateProfileSports(input: UpdateProfileSportsInput!): ProfilePayload!
Mutation.selectOnboardingSports(input: SelectOnboardingSportsInput!): ProfilePayload!
Mutation.updateProfileLocation(input: UpdateProfileLocationInput!): ProfilePayload!
Mutation.setProfileVisibility(visibility: ProfileVisibility!): ProfilePayload!
Mutation.requestAvatarUpload: AvatarUploadPayload!
Mutation.setAvatar(publicId: String!): ProfilePayload!
Mutation.setPlayerPreferences(input: PlayerPreferencesInput!): PlayerPreferencesPayload!   # R11

type Viewer { preferences: PlayerPreferences! }
```

---

## Rules

**R1** — A profile is created in the same transaction as its user, by `identity` calling
`createFor(tx, …)`. This module never creates one on its own, and a user without a profile is not a
reachable state.

**R2** — At least one sport must be selected before a player can register for an event. Onboarding
enforces it; `registration` enforces it again on the server.

**R3** — `skill_band` is self-declared and stays editable. `rating` is derived and read-only to the
player. Never conflate them — not in the schema, not in the UI, not in a filter.

**R15** — `onboarding_pending_sport_ids` is written only by `selectOnboardingSports` and shrunk only
by `updateSports`. It is resolved as `[]` for any viewer but the profile's own owner, the same
null-for-privacy convention R4 uses for `city`/`bio`.

**R4** — Visibility is `public`, `players_only` or `private`. `publicView` returns **null for hidden
fields rather than erroring**: a private profile must not be distinguishable from a missing one.

**R5** — Results are always visible on a profile that appears in a public draw. You cannot enter a
public tournament and hide the outcome. Visibility hides contact details and activity, never
competitive record.

**R6** — Avatars upload **directly to Cloudinary** under a server-issued signature; only the
`public_id` is stored. The server validates that the returned `public_id` matches the one it signed
(ADR 0003 §C2). Display URLs are built from named transformations — `t_avatar_sm`, `t_avatar_md`,
`t_avatar_lg` — never persisted, and never string-built in a resolver. Replacing an avatar destroys
the old asset.

**R7** — *Retired 2026-09-29.* Following was removed; see R10 and the chat module.

**R8** — `statsSnapshot` is materialised on match completion, not computed per request. The Home
screen must not run six aggregates.

**R9** — Rating columns on `player_sports` change **only** through `applyRating()`, called by the
`rating` module. No other write path exists.

**R10** — **Played with** replaces friends: everyone this player shared a completed match with, as
partner or opponent, most recent first, with a match count — derived from `player_match_history`,
no table of its own. R4 applies twice: nothing is listed when the profile's details are withheld
from the viewer, and a private player appears only in their own view of anyone's list.

**R11** *(Sprint 11)* — Player preferences hold preferred formats, weekly availability windows,
travel radius (1–50 km), preferred venues, what the player is `looking_for` (`partner`, `games`,
`tournaments`, `leagues`, `community`) and `open_to_matching`. Preferences are **private** and are
never returned by `publicView`. `matchingProfile` exposes them to `discovery` only when
`open_to_matching = true`, which defaults to false.

**R12** *(Sprint 8)* — Match history is permanent and paginated (keyset on `completed_at, match_id`).
It reads `player_match_history`, a projection written from the `match.completed` payload
(`tournament R17`) and corrected from `result.corrected`. Profile never reads `matches`.
Visibility follows R4 and R5: a result from a public draw is always visible.

**R13** *(Sprint 9)* — Achievements are awarded from a **versioned catalog in code** (key, optional
sport, criteria function, optional tier) by `evaluate-achievements`. Triggers are
`match.completed`, `tournament.completed`, `registration.confirmed`, `game.joined`,
`ranking.moved` and `league.season_closed`. Awarding is idempotent through the unique index. A
correction that changes a winner (`scoring R8`) triggers re-evaluation, which revokes any
achievement whose criteria no longer hold.

**R14** *(Sprint 8)* — `PlayerProfile.recentResults` reads the R12 projection. This unblocks the
checklist item that waited on `matches`.

**R15** — A player sets their own **display name** (2–40 characters, whitespace collapsed) and an
optional **bio** (at most 160; blank clears it) through `updateProfileDetails`. The name is what
other players see in draws, lists and results, so it is never blank. It lives on `users`, so profile
validates it and changes it through identity's `setDisplayName`, never with an UPDATE of its own.

---

## Schema

```sql
CREATE TABLE player_profiles (
  id              uuid PRIMARY KEY,
  user_id         uuid UNIQUE NOT NULL REFERENCES users(id),
  city            text,
  geo             geography(Point,4326),
  bio             text,
  visibility      text NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public','players_only','private')),
  stats           jsonb NOT NULL DEFAULT '{}',     -- materialised snapshot (R8)
  onboarding_pending_sport_ids uuid[] NOT NULL DEFAULT '{}',  -- onboarding R6
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_profiles (city);

CREATE TABLE player_sports (
  player_id       uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  sport_id        uuid NOT NULL REFERENCES sports(id),
  skill_band      text NOT NULL,                   -- self-declared (R3)
  rating          numeric(7,2),                    -- derived, via applyRating only (R9)
  rating_dev      numeric(7,2),
  volatility      numeric(7,5),
  is_provisional  boolean NOT NULL DEFAULT true,
  matches_played  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, sport_id)
);
CREATE INDEX ON player_sports (sport_id, rating DESC NULLS LAST);

CREATE TABLE achievements (
  id              uuid PRIMARY KEY,
  player_id       uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  sport_id        uuid REFERENCES sports(id),
  key             text NOT NULL,          -- 'first_win' | 'tournament_winner' | …
  event_id        uuid,
  earned_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, key, event_id)
);

-- R13 fix-forward: event_id is often null, and a plain UNIQUE treats NULLs as distinct,
-- so the same 'first_win' could be awarded twice. Needs Postgres 15+.
-- Use the constraint name the applied migration actually created.
ALTER TABLE achievements DROP CONSTRAINT achievements_player_id_key_event_id_key;
ALTER TABLE achievements ADD CONSTRAINT achievements_award_uniq
  UNIQUE NULLS NOT DISTINCT (player_id, key, event_id);
ALTER TABLE achievements ADD COLUMN tier smallint;

-- R11 (Sprint 11)
CREATE TABLE player_preferences (
  player_id           uuid PRIMARY KEY REFERENCES player_profiles(id) ON DELETE CASCADE,
  preferred_formats   text[] NOT NULL DEFAULT '{}',
  availability        jsonb NOT NULL DEFAULT '[]',   -- [{ weekday, from: '07:00', to: '10:00' }]
  travel_radius_km    smallint NOT NULL DEFAULT 10 CHECK (travel_radius_km BETWEEN 1 AND 50),
  preferred_venue_ids uuid[] NOT NULL DEFAULT '{}',
  looking_for         text[] NOT NULL DEFAULT '{}',
  open_to_matching    boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- R12 (Sprint 8). Projection: one row per player per match.
CREATE TABLE player_match_history (
  player_id       uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  match_id        uuid NOT NULL,                  -- no FK: matches belong to tournament
  sport_id        uuid NOT NULL REFERENCES sports(id),
  event_id        uuid,
  partner_ids     uuid[] NOT NULL DEFAULT '{}',
  opponent_ids    uuid[] NOT NULL DEFAULT '{}',
  won             boolean NOT NULL,
  outcome         text NOT NULL,                  -- played | walkover | retired | forfeit
  games           jsonb NOT NULL,
  completed_at    timestamptz NOT NULL,
  PRIMARY KEY (player_id, match_id)
);
CREATE INDEX ON player_match_history (player_id, completed_at DESC, match_id);
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `PROFILE_NOT_FOUND` | user | Also returned for a private profile — R4 |
| `NO_SPORT_SELECTED` | user | Blocks registration |
| `INVALID_SKILL_BAND` | user | Band not valid for that sport |
| `INVALID_PREFERENCES` | user | Radius outside 1–50 km or unknown format — R11 |

## Emits

| Event | Consumers |
|---|---|
| `profile.sports_changed` | rating |
| `achievement.earned` | notifications, social (feed) |
| `profile.visibility_changed` | discovery, social |
| `profile.preferences_changed` | discovery |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `refresh-stats-snapshot` | `match.completed` | 3 × exp | Alert; snapshot serves stale |
| `project-match-history` | `match.completed`, `result.corrected` | 5 × exp | Alert; history lags |
| `evaluate-achievements` | Topics in R13 | 3 × exp | Alert; the next trigger catches up |

---

## Done when

The same `playerProfile(id:)` query returns full fields to the owner and null-filled fields to a
stranger on a private profile. One `home` query fills every region of the Home screen without a
second round trip.

---

## Implementation checklist

- [x] Migration `003_profile.sql` (needs PostGIS — see [ADR 0001 § C1](../decisions/0001-neon-over-supabase.md))
- [x] `createFor(tx, …)` called from `identity.verifyOtp` inside one transaction
- [x] `publicView` visibility filter with null-fill, not errors (R4)
- [x] Signed Cloudinary upload + `setAvatar`; validate the returned `public_id` against the signed one
- [x] `avatarUrl` built from named transformations via `platform/cloudinary.ts` only (ADR 0003 §C1)
- [x] Destroy the previous asset on replace (ADR 0003 §C4)
- [x] `applyRating` as the only rating write path; make the repo method private
- [ ] `refresh-stats-snapshot` job on `match.completed` — **blocked on `scoring`** (Sprint 8).
      `statsSnapshot` reads the materialised document and `recordStatsSnapshot` writes it;
      nothing emits `match.completed` yet, so no job is registered.
- [x] `home` query assembling hero, upcoming, featured, stats, liveNow — **moved to its own
      module**, [21-home.md](./21-home.md), because it reads events and registration, which sit
      above profile. Profile contributes the `StatsSnapshot` type. `recommended` follows with
      discovery (Sprint 11).
- [ ] `PlayerProfile.recentResults` — needs `matches` (see the Sprint 8 item below).
- [x] Player search with trigram index on `display_name`
- [x] Tests naming R1, R3, R4, R5, R7, R9
- [ ] *(Sprint 7)* Fix-forward migration: `achievements` unique `NULLS NOT DISTINCT` (R13)
- [x] *(Sprint 8)* `player_match_history` projection + `matchHistory`; `recentResults` reads it (R12, R14). Stats re-materialised from it on every projection (R8). Backfill: `pnpm backfill:match-history`
- [ ] *(Sprint 9)* Achievement catalog + `evaluate-achievements`, including revocation on correction (R13)
- [x] Played with (R10), withheld per R4 — replaced follows and friends on 2026-09-29 (migration 024)
- [ ] *(Sprint 11)* `player_preferences` + `matchingProfile` (R11)
- [ ] Tests naming R10, R11, R12, R13

Two deliberate readings of the spec:

- `createFor` takes `(tx, userId)`, not `(tx, userId, displayName)`. `display_name`
  lives on `users`, which identity owns and has already written by that point;
  a second copy here would only drift.
- `PlayerSport.rank` is in the schema and returns `null`, which is its documented
  meaning ("null when unranked") until `rating` fills the rankings board.

---

## Frontend

The player app's profile module (`PLAY_FRONTEND/apps/player/src/features/profile/`) is wired to
this backend. It implements R1–R8, R11–R14 on the client, with sections 3 (Stats) and 4 (Results)
omitted per R2 while G13 is open. See [`PLAY_FRONTEND/docs/modules/09-profile.md`](../../PLAY_FRONTEND/docs/modules/09-profile.md)
for the client-side rules and checklist.

