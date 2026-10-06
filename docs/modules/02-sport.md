# 02 — sport

| | |
|---|---|
| **Sprint** | 2 |
| **Phase** | 1 |
| **Depends on** | nothing |
| **Owns** | `sports`, `formats`, `skill_bands`, `scoring_rules` |
| **Rule prefix** | `sport R*` |

The registry that makes multi-sport real rather than aspirational. **Scoring rules live here as
data**, which is what keeps `if (sport === 'pickleball')` out of the scoring module.

Read-mostly, seeded from version control, cached for the process lifetime.

---

## Service interface

```ts
list()                                    => Sport[]
bySlug(slug: string)                      => Sport
byId(sportId: string)                     => Sport
formatsFor(sportId: string)               => Format[]
skillBandsFor(sportId: string)            => SkillBand[]
scoringRuleFor(sportId: string, formatId?) => ScoringRule
```

## GraphQL

```graphql
Query.sports: [Sport!]!
Query.sport(slug: String!): Sport

type Sport implements Node {
  id: ID!
  slug: String!
  name: String!
  formats: [Format!]!
  skillBands: [SkillBand!]!
}
```

---

## The shape that matters

`ScoringRule` is the contract between this module and `scoring`. Get it right and a second sport is
a row; get it wrong and it is a refactor.

```ts
type ScoringRule = {
  pointsToWin: number;             // pickleball: 11
  winBy: number;                   // 2
  hardCap: number | null;          // 15 — or null for unlimited deuce
  gamesToWin: number;              // 2, i.e. best of 3
  serveModel: 'rally' | 'side_out';
  decidingGame?: {                 // the third game is often shorter
    pointsToWin: number;           // 15
    hardCap: number | null;        // 21
  };
  switchEndsAt?: number;           // 6, in the deciding game
};
```

### Launch seed

```ts
{
  slug: 'pickleball',
  name: 'Pickleball',
  formats: ['singles', 'doubles', 'mixed_doubles'],
  skillBands: ['2.5', '3.0', '3.5', '4.0', '4.5', '5.0+'],
  scoringRule: {
    pointsToWin: 11, winBy: 2, hardCap: 15, gamesToWin: 2,
    serveModel: 'rally',
    decidingGame: { pointsToWin: 15, hardCap: 21 },
    switchEndsAt: 6,
  },
}
```

A second sport is an `INSERT`, not a code change.

---

## Rules

**R1** — Every sport, format, skill band and scoring rule is seed data under version control. No
runtime writes in Phase 1; admin editing is a later concern.

**R2** — Skill bands are per sport. Pickleball uses the DUPR-style 2.5–5.0+ ladder; another sport
will not, and nothing outside this module may assume that scale.

**R3** — Sports are soft-disabled with an `active` flag, never deleted. Historical matches must keep
resolving their sport.

**R4** — Results are cached in-process for the process lifetime. This table changes on deploy, not
at runtime.

**R5** — `scoringRuleFor` is the **only** source of scoring semantics. If `scoring` needs a new
concept — a let, a tiebreak variant — it is added to `ScoringRule`, not branched on in `scoring`.

---

## Schema

```sql
CREATE TABLE sports (
  id            uuid PRIMARY KEY,
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  sort_order    smallint NOT NULL DEFAULT 0
);

CREATE TABLE formats (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  key           text NOT NULL,            -- singles | doubles | mixed_doubles | team
  name          text NOT NULL,
  team_size     smallint NOT NULL,
  UNIQUE (sport_id, key)
);

CREATE TABLE skill_bands (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  key           text NOT NULL,            -- '3.5'
  label         text NOT NULL,
  lower_bound   numeric(4,2),
  upper_bound   numeric(4,2),
  sort_order    smallint NOT NULL,
  UNIQUE (sport_id, key)
);

CREATE TABLE scoring_rules (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  format_id     uuid REFERENCES formats(id),   -- null = default for the sport
  rule          jsonb NOT NULL,                -- the ScoringRule shape above
  UNIQUE (sport_id, format_id)
);
```

---

## Errors

| Code | Channel | Notes |
|---|---|---|
| `SPORT_NOT_FOUND` | user | Unknown slug |
| `NO_SCORING_RULE` | system | Seed data is incomplete — a deploy problem |

---

## Done when

**The multi-sport acceptance test passes.** Insert a second sport row with its formats, bands and
scoring rule, and confirm it appears in Explore filters, ranking tabs, profile sport selection and
event creation — **with zero code changes**.

Run this once in Sprint 2 with a throwaway sport (badminton is a good foil: different scoring, same
doubles structure) rather than discovering the problem in year two. Delete the throwaway row
afterwards; keep the test.

---

## Implementation checklist

- [x] Migration `002_sport.sql`
- [x] `ScoringRule` TypeScript type + Zod schema; the JSONB column is validated on seed
- [x] Seed script with the pickleball row above
- [x] In-process cache, populated on first read, no TTL
- [x] Pothos `Sport`, `Format`, `SkillBand` types
- [x] Multi-sport acceptance test with a throwaway second sport (the **Done when**)
- [x] Tests naming R2, R5

`Sport` does **not** implement `Node`. The GraphQL sketch above says it does;
conventions.md §4 limits `Node` to the deep-link targets (`Event`, `Match`,
`PlayerProfile`, `Game`, `Venue`, `Community`), and conventions.md wins.
