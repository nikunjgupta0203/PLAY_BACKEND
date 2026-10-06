# 16 — discovery

| | |
|---|---|
| **Sprint** | 11 |
| **Phase** | **2** |
| **Depends on** | profile, events, games, venues, communities, leagues (read-only, via `index.ts` and outbox topics) |
| **Owns** | `search_documents`, `recommendation_dismissals` |
| **Rule prefix** | `discovery R*` |

One search box across everything, personalised recommendations, and player matching. It covers
"find players", "discover communities", "personalized recommendations" and the partner finder for
doubles.

It sits at the **top of the dependency graph**: it reads every other module and nothing depends on
it. Other modules' GraphQL types are extended *from here* — `Game.suggestedPlayers`,
`EventCategory.suggestedPartners`, `HomeFeed.recommended` — so `games` and `registration` never
import `discovery`.

> **2026-09-29:** follows were removed ([chat spec](../superpowers/specs/2026-09-29-chat-design.md)). Wherever this doc says *follows*,
> *followers* or *friends*, read **played with** (profile R10) until this module is re-specified.

---

## Service interface

```ts
search(viewer, { query, kinds[], near?, radiusKm?, sportId?, city? }, page) => Page<SearchHit>
recommendations(viewer, { sportId, kinds[], limit })                       => Recommendation[]
suggestPlayers(viewer, { sportId, format?, near?, startsAt?, skillBand? }, page) => Page<PlayerSuggestion>
suggestPartners(viewer, eventCategoryId, page)                              => Page<PlayerSuggestion>
nearbyPlayers(viewer, { sportId, near, radiusKm }, page)                    => Page<PlayerSuggestion>
dismiss(viewer, { subjectType, subjectId })                                 => void
upsertDocument(doc: SearchDocument)                                         => void   // projection job
```

## GraphQL

```graphql
Query.search(query: String!, kinds: [SearchKind!], near: GeoPointInput, radiusKm: Float = 10,
             sportId: ID, first: Int = 20, after: String): SearchConnection!
Query.recommendations(sportId: ID!, kinds: [SearchKind!], first: Int = 10): [Recommendation!]!
Query.suggestedPlayers(input: SuggestPlayersInput!, first: Int = 20, after: String): PlayerSuggestionConnection!
Mutation.dismissRecommendation(input: DismissInput!): DismissPayload!

extend type HomeFeed      { recommended: [Recommendation!]! }
extend type Game          { suggestedPlayers(first: Int = 10): [PlayerSuggestion!]! }   # creator only
extend type EventCategory { suggestedPartners(first: Int = 10): [PlayerSuggestion!]! }

enum SearchKind { EVENT LEAGUE GAME VENUE PLAYER COMMUNITY }

type Recommendation {
  kind: SearchKind!
  subject: SearchSubject!        # union of Event | Game | Venue | PlayerProfile | Community
  reasons: [RecommendationReason!]!   # never empty — R4
}

type PlayerSuggestion {
  player: PlayerProfile!
  distanceKm: Float
  skillFit: SkillFit!            # SAME_BAND | NEAR_BAND
  reasons: [RecommendationReason!]!
}
```

---

## Rules

**R1** — Unified search reads **only `search_documents`**, a projection upserted from the outbox
topics of the owning modules (`event.published`, `event.hidden`, `game.created`,
`venue.updated`, `profile.visibility_changed`, `community.updated`, `league.season_published`, …).
It never joins another module's tables at read time. A document carries kind, sport, city, geo,
start time, visibility, a `tsvector` and a trigram name.

**R2** — Players appear in player discovery and matching **only if they opted in**
(`profile R11: open_to_matching = true`) **and** their profile is not `private`. Visibility is
checked again at read time through `profile.publicView`, so a profile made private disappears
immediately, even before its search document is updated.

**R3** — Radius is capped at **50 km**, as in `events R6`. Without an explicit location, the
viewer's profile city is used.

**R4** — Every recommendation carries at least one **reason code**: `near_you`,
`your_skill_band`, `friends_going`, `followed_organizer`, `played_here`, `popular_in_city`,
`fits_your_schedule`. A candidate with no reason is not shown. An explainable recommendation is
debuggable; an opaque one cannot be tuned.

**R5** — Ranking is a **pure function with versioned weights** (`reco_version`), unit-tested and
deterministic for fixed inputs. Its inputs are distance, skill fit, time fit against the viewer's
availability preferences (profile R11), social proof, freshness, remaining capacity, and
dismissals. Skill fit uses the settled rating when the player has one and the self-declared band
otherwise. It never blends the two, per `profile R3`.

**R6** — Cold start is never empty. A player with no history gets `popular_in_city` and
`your_skill_band` results for their selected sport.

**R7** — `suggestPlayers` ranks opted-in players by skill proximity (same or adjacent band, or
within ±150 settled rating), distance within **both** players' travel radius, and availability
overlap. It excludes the viewer, players who dismissed the viewer, and suspended users. At most 50
results. Rate-limited to **30 calls per user per hour**, because a player directory is a scraping
target.

**R8** — `suggestPartners` for a doubles category pre-filters on the category's eligibility
constraints (`registration R7`), so everyone suggested can actually be invited. Order: players with
an open partner request in that category (`registration R20`), then friends (`profile R10`), then
other opted-in players.

**R9** — Dismissals hide the subject from that viewer's recommendations for **90 days**. They
never affect search.

**R10** — Computed recommendation lists are cached for 15 minutes per `{userId}:{sportId}`
(in-process — there is no Redis since migration 023). Losing the cache costs a recomputation and nothing else.

---

## Schema

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Projection (R1). One row per discoverable subject, upserted from outbox topics.
CREATE TABLE search_documents (
  kind          text NOT NULL CHECK (kind IN
                  ('event','league','game','venue','player','community')),
  subject_id    uuid NOT NULL,
  sport_id      uuid REFERENCES sports(id),        -- null for multi-sport venues/communities
  title         text NOT NULL,
  city          text,
  geo           geography(Point,4326),
  starts_at     timestamptz,                       -- events, games
  visibility    text NOT NULL,                     -- 'public' | 'players_only' | 'private' | …
  listed        boolean NOT NULL DEFAULT true,     -- false = hidden, cancelled, past, opted out
  attrs         jsonb NOT NULL DEFAULT '{}',       -- skill band, format, price, capacity left
  tsv           tsvector NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject_id)
);
CREATE INDEX search_tsv_idx   ON search_documents USING gin (tsv) WHERE listed;
CREATE INDEX search_title_trgm ON search_documents USING gin (title gin_trgm_ops) WHERE listed;
CREATE INDEX search_geo_idx   ON search_documents USING gist (geo) WHERE listed;
CREATE INDEX search_facet_idx ON search_documents (kind, sport_id, city, starts_at) WHERE listed;

CREATE TABLE recommendation_dismissals (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),   -- honoured 90 days (R9)
  PRIMARY KEY (user_id, subject_type, subject_id)
);
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `RADIUS_TOO_LARGE` | user | Over 50 km — R3 |
| `MATCHING_OPT_IN_REQUIRED` | user | Viewer has not opted in; offer the toggle (you cannot find players while hidden yourself) |
| `RATE_LIMITED` | system | R7 |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `project-search-document` | Outbox topics in R1 | 5 × exp | Alert; search serves stale |
| `rebuild-search-index` | Manual / backfill | 3 × exp | Alert |
| `prune-dismissals` | Nightly | 3 × exp | Drop |

---

## Done when

Searching "pickle" near a map point returns events, leagues, games, venues, communities and
opted-in public players, each correctly filtered. A player who switches to private disappears on
the next query. Every recommendation shows at least one reason, and a brand-new player gets a
non-empty list. `suggestPartners` for a 3.5 doubles category returns only players eligible for it,
with open partner requests ranked first. The ranking function reproduces identical output for a
fixed input fixture.

---

## Implementation checklist

- [ ] Migration `016_discovery.sql` (needs `pg_trgm`)
- [ ] Projection handlers for every topic in R1; `rebuild-search-index` backfill
- [ ] Read-time visibility re-check through `profile.publicView` (R2)
- [ ] Ranking pure function + `reco_version` + fixture tests (R5)
- [ ] Reason codes on every recommendation (R4); cold-start path (R6)
- [ ] `suggestPlayers` with rate limit (R7); `suggestPartners` pre-filtered on eligibility (R8)
- [ ] GraphQL type extensions on `HomeFeed`, `Game`, `EventCategory`
- [ ] Tests naming R1, R2, R4, R5, R6, R7, R8, R9
