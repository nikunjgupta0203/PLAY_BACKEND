# 21 — home

| | |
|---|---|
| **Sprint** | 3 *(landed after Sprint 8, closing frontend gap G5)* |
| **Phase** | 1 · `recommended` P2 · Sprint 11 (discovery) |
| **Depends on** | events, registration, profile |
| **Owns** | nothing — a read-only composition. No tables, no jobs, no events emitted |
| **Rule prefix** | `home R*` |

The one query behind the Home screen. [architecture.md §1](../architecture.md) chose GraphQL
because "the Home screen needs six unrelated collections; one typed round trip beats six REST calls
on Indian mobile networks". This module is that round trip.

It was first planned as a `profile` checklist item. It lives on its own because it reads `events`
and `registration`, and profile sits below both in the build order (L1 vs L2/L3). As a leaf that
nothing imports, home can depend on all three without adding an edge to the module graph.

---

## Service interface

```ts
feed(viewer: { userId } | null, { city?, sportId? })  => HomeFeed
```

Built from three ports, each a thin adapter over another module's `index.ts`:

| Port | Backed by |
|---|---|
| `events.discoverable(filter, first)` | `events.search` — events R6, published and live only |
| `events.byId(id)` | `events.byId` |
| `registrations.listForUser(userId)` | `registration.listForUser` |
| `profile.findByUserId` · `profile.statsSnapshot` | profile, with `statsSnapshot` reading the materialised document (profile R8) |

## GraphQL

```graphql
Query.home(city: String, sportId: ID): HomeFeed!

type HomeFeed {
  hero: HomeHero                 # R3
  liveNow: [Event!]!             # R5
  upcoming: [HomeEntry!]!        # R4
  featured: [Event!]!
  stats: StatsSnapshot           # R7 — defined by profile
  firstRun: Boolean!             # R6
  city: String                   # R2 — the city the feed was built for
}

type HomeHero  { event: Event!, registration: Registration }   # registration null ⇒ headline
type HomeEntry { event: Event!, registration: Registration! }

# discovery, Sprint 11:
extend type HomeFeed { recommended: [Recommendation!]! }
```

`hero` is an object rather than the bare `Event` the frontend's first sketch assumed: the client
renders an entry ("Your next match", with its category and status) differently from a headline
event ("from ₹X"), and cannot tell them apart from an `Event` alone.

`recommended` is **absent, not empty**. An empty list says "nothing for you"; absence says "not
built yet", which is true. discovery adds it with `extend type` (discovery R4).

---

## Rules

**R1** — One query fills every region of the Home screen. A region that needs a field `HomeFeed`
lacks is a schema change here, not a second client request.

**R2** — `city` defaults to the viewer's profile city. An explicit `city` browses another city **without
editing the profile**; the feed echoes back the city it used. `sportId` filters featured events and
entries to one sport, and selects which sport's stats are shown.

**R3** — The hero is the viewer's **next committed entry** that is not live. When there is none, it
is the city's soonest discoverable event, which is then not repeated in `featured`. `featured` never
lists an event the viewer has already entered.

**R4** — Only **committed** entries — `confirmed` and `checked_in` — reach the hero or `upcoming`. A
`payment_pending`, waitlisted or awaiting-partner entry is not a commitment. Events that are
cancelled, still draft, or already ended leave every region.

**R5** — `liveNow` is the `live` events the viewer holds a committed entry in, each once. A live
event appears there and nowhere else.

**R6** — `firstRun` is true when the viewer has **never** created a registration in any state. It is
the client's cue for the designed first-run screen (frontend `home R9`).

**R7** — `stats` is the materialised snapshot for `sportId`, else the player's first sport. It is
**null until `matchesPlayed > 0`**: a region of zeroes reads as broken. It is also null when the
viewer does not play the requested sport. Nothing is aggregated per request (profile R8).

**R8** — A signed-out viewer gets the city shelf only (`hero` as a headline, `featured`) and
`firstRun: true`. `home` never raises `UNAUTHENTICATED`.

### Limits

`featured` and `upcoming` are each capped at **10**, what fits on a phone. Featured is a shelf, not
a search result: the Discover tab is where browsing continues.

### Caching

[architecture.md §6](../architecture.md) lists `home:{userId}:{city}` at 60 s. It is **not
implemented yet**, deliberately: `upcoming` carries registration status, which the frontend treats as
money-adjacent (frontend `home R8`), and a cached whole feed would serve a stale "Payment pending"
after the webhook confirmed it. When p95 on `home` warrants a cache, cache only the `featured` leg,
keyed by city and sport.

---

## Errors

None of its own. `home` issues no mutations. A missing event behind a registration is a data bug
and surfaces as `NOT_FOUND` from `events.byId`.

## Emits

Nothing.

## Jobs

None.

---

## Done when

One `home` query returns hero, live now, upcoming, featured and stats for a real player against a
real Postgres, with each exclusion in R3–R5 tested by name, and a signed-out request returns the
city shelf. `tests/home.test.ts`.

---

## Implementation checklist

- [x] `service/` composition over events, registration and profile ports — no Prisma, no tables
- [x] `index.ts` wiring through each module's public surface only (conventions.md §1)
- [x] `StatsSnapshot` GraphQL type on profile's schema (profile R8)
- [x] `Query.home`, `HomeFeed`, `HomeHero`, `HomeEntry`; SDL regenerated
- [x] Tests naming R1–R8
- [ ] `featured`-leg cache, if p95 on `home` warrants it (see Caching)
- [ ] *(Sprint 11)* `recommended` via `extend type HomeFeed` — discovery R4
