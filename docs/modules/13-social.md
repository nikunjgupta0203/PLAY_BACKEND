# 13 — social

| | |
|---|---|
| **Sprint** | 10 |
| **Phase** | **2** |
| **Depends on** | profile, games |
| **Owns** | `challenges`, `feed_entries` |
| **Rule prefix** | `social R*` |

Challenges between players, and the activity feed that follows generate.

**Following itself lives in `profile`**, not here — it is read on every profile screen in Phase 1,
and this module does not exist until Sprint 10. Filing them together would have made a Phase 1
screen depend on a Phase 2 module.

> **2026-09-29:** follows were removed ([chat spec](../superpowers/specs/2026-09-29-chat-design.md)). Wherever this doc says *follows*,
> *followers* or *friends*, read **played with** (profile R10) until this module is re-specified.

---

## Service interface

```ts
challenge(actor, { opponentId, sportId, proposedAt, venueId? }) => Challenge
respond(actor, challengeId, 'accept' | 'decline')               => Challenge
withdraw(actor, challengeId)                                    => Challenge
listForUser(userId, direction: 'sent' | 'received')             => Challenge[]
feedFor(actor, page)                                            => Page<FeedEntry>
activityFor(viewer, playerId, page)                             => Page<FeedEntry>   // R8
```

## GraphQL

```graphql
Query.challenges(direction: ChallengeDirection!): [Challenge!]!
Query.activityFeed(first: Int = 20, after: String): FeedConnection!

type Challenge implements Node {
  id: ID!
  challenger: PlayerProfile!
  opponent: PlayerProfile!
  sport: Sport!
  proposedAt: DateTime!
  venue: Venue
  status: ChallengeStatus!   # PENDING | ACCEPTED | DECLINED | WITHDRAWN | EXPIRED
  game: Game                 # non-null once accepted — R2
  expiresAt: DateTime!
}

type FeedEntry {
  id: ID!
  kind: FeedEntryKind!       # MATCH_WON | TOURNAMENT_ENTERED | RANK_CHANGED |
                             # ACHIEVEMENT | GAME_CREATED |
                             # GAME_JOINED | COMMUNITY_JOINED | LEAGUE_ENTERED (R9)
  actor: PlayerProfile!
  subject: Node              # Event, Match, Game — whatever the entry is about
  createdAt: DateTime!
}

Mutation.challengePlayer(input: ChallengeInput!): ChallengePayload!
Mutation.respondToChallenge(input: RespondInput!): ChallengePayload!
Mutation.withdrawChallenge(challengeId: ID!): ChallengePayload!

extend type PlayerProfile { activity(first: Int = 20, after: String): FeedConnection! }   # R8
```

---

## Rules

**R1** — A challenge expires after **72 hours** without a response, and cannot be re-sent to the same
opponent for **24 hours** after that. Challenge spam is the obvious failure mode of this feature,
and rate limiting it is not optional.

**R2** — Accepting a challenge **creates a `game`** with both players joined. Challenges do not carry
their own match machinery — that would be a second, worse copy of `games`.

**R3** — Feed entries are **projections written on domain events**, never computed by querying every
followed player at read time. A fan-out-on-write feed is the only shape that stays fast.

**R4** — The feed shows only what the actor is permitted to see. A private profile's activity never
appears, **including to people who followed them before the profile went private**. Visibility is
evaluated at read time, not baked into the projection.

**R5** — Challenge results follow whatever the resulting game does — which in Phase 2 is nothing.
Rated challenges are a Phase 3 conversation, gated behind `rating R8`.

**R6** — A player may have at most **five pending outgoing challenges** at once.

**R7** — ~~Feed entries are pruned after 90 days. This is a "what happened recently" surface, not an
archive; a player's competitive history lives on their profile.~~ Superseded by R8.

**R8** *(Sprint 11)* — **Activity history.** Feed entries are retained for **24 months**. The
follower feed (`feedFor`) still reads only the **last 90 days**, so it remains a "what happened
recently" surface. `activityFor` returns one player's own entries across the full retention
period, with R4 visibility evaluated at read time. Competitive record stays on the profile
(`profile R12`).

**R9** *(Sprint 11)* — Feed kinds extend to `game_joined`, `community_joined` and
`league_entered`, projected from `game.joined`, `community.member_joined`, and a registration
confirmed into a `league_season` event. Activity in a private community never enters any feed.

---

## Schema

```sql
CREATE TABLE challenges (
  id              uuid PRIMARY KEY,
  challenger_id   uuid NOT NULL REFERENCES player_profiles(id),
  opponent_id     uuid NOT NULL REFERENCES player_profiles(id),
  sport_id        uuid NOT NULL REFERENCES sports(id),
  venue_id        uuid REFERENCES venues(id),
  proposed_at     timestamptz NOT NULL,
  message         text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','accepted','declined','withdrawn','expired')),
  game_id         uuid REFERENCES games(id),      -- set on accept (R2)
  expires_at      timestamptz NOT NULL,           -- +72h (R1)
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  CHECK (challenger_id <> opponent_id)
);
-- R1: one live challenge per pair at a time.
CREATE UNIQUE INDEX challenges_one_pending
  ON challenges (challenger_id, opponent_id)
  WHERE status = 'pending';
CREATE INDEX ON challenges (opponent_id, status);

CREATE TABLE feed_entries (
  id            bigserial PRIMARY KEY,
  actor_id      uuid NOT NULL REFERENCES player_profiles(id),
  kind          text NOT NULL CHECK (kind IN
                  ('match_won','tournament_entered','rank_changed',
                   'achievement','game_created',
                   'game_joined','community_joined','league_entered')),   -- R9
  subject_type  text,                             -- 'event' | 'match' | 'game' | 'community'
  subject_id    uuid,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_actor_idx ON feed_entries (actor_id, created_at DESC);
```

The feed read joins `feed_entries` against `profile.follows` for the viewer, filtered by the
followee's visibility (R4).

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `CHALLENGE_ALREADY_PENDING` | user | Show the existing challenge |
| `CHALLENGE_COOLDOWN` | user | Explain the 24-hour wait — R1 |
| `TOO_MANY_PENDING` | user | Five outgoing maximum — R6 |
| `CHALLENGE_EXPIRED` | user | Offer to re-send |
| `CANNOT_CHALLENGE_SELF` | user | Also a DB check constraint |

## Emits

| Event | Consumers |
|---|---|
| `challenge.created` | notifications |
| `challenge.accepted` | notifications, games |
| `challenge.declined` | notifications |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `expire-challenges` | Every 15 min | 3 × exp | Alert |
| `prune-feed` | Nightly, 24-month retention (R8) | 3 × exp | Drop |

---

## Done when

A challenge is sent, accepted, and produces a joined game. An unanswered challenge expires at 72
hours. A player who switches their profile to private **disappears from the feeds of people already
following them**.

---

## Implementation checklist

- [ ] Migration `013_social.sql` including the unique partial index on pending challenges
- [ ] Challenge lifecycle with the 72h expiry and the 24h cooldown (R1)
- [ ] Five-pending cap (R6)
- [ ] `accept` creating a game through `games.create()` (R2) — no direct table write
- [ ] Feed projections written on domain events from profile, tournament, rating, games (R3)
- [ ] Visibility filter evaluated at read time (R4) — test the "went private after being followed" case
- [ ] `expire-challenges` and `prune-feed` jobs
- [ ] Tests naming R1, R2, R3, R4, R6
- [ ] *(Sprint 11)* 24-month retention with the 90-day follower-feed window; `activityFor` (R8)
- [ ] *(Sprint 11)* New feed kinds (R9)
- [ ] Tests naming R8, R9
