# Conventions

Rules that apply to every module. If a module doc contradicts this file, the module doc is wrong.

---

## 1. The module contract

Every module is a directory under `src/modules/` with the same shape:

```
modules/<name>/
  schema/       Pothos object types, inputs, resolvers
  service/      business rules — the part worth testing
  repo/         Prisma queries and raw SQL
  events.ts     domain events this module emits
  index.ts      the ONLY surface other modules may import
```

Three rules, enforced by `eslint no-restricted-imports` rather than by code review:

1. **Resolvers never touch Prisma.** They call a service and shape the result.
2. **Services never import GraphQL types.** They take and return plain domain objects, which is
   what makes them callable from workers and webhook handlers too.
3. **Cross-module calls go through the other module's `index.ts`**, never its repo. `registration`
   may ask `payments` to create an order; it may not read the payments tables.

### Table ownership is exclusive

Exactly one module writes to any given table. Where a module needs to change another's data it
calls a named service method — which is why `rating` writes a player's rating through
`profile.applyRating()` rather than through an `UPDATE`.

### Domain events go through the outbox

Modules talk to each other synchronously through service calls. Side effects that can fail
independently — a push, a ranking rebuild, a Pusher publish — are written to `outbox` **inside the
same transaction as the state change**, then drained into the Postgres job queue by the worker.

No in-process event emitter. It looks decoupled and quietly loses work whenever the process dies
mid-request.

---

## 2. Database

| Convention | Rule | Reason |
|---|---|---|
| Primary keys | UUIDv7 | Time-sortable for index locality, without exposing a sequential count of your registrations to a competitor |
| Money | `bigint`, column suffix `_paise` | Integer minor units. No float touches money anywhere, including in GraphQL |
| Time | `timestamptz`, stored UTC | Events also carry `timezone` so "Saturday 9am" survives a multi-zone future |
| Sport | `sport_id NOT NULL` | On every competitive row. The single constraint that keeps multi-sport real |
| Status | `text` + `CHECK` | Postgres enums need a migration to extend; a CHECK constraint does not, and states will change |
| Deletion | Soft only where audited | Registrations, payments and matches are never hard-deleted. Games and follows are |
| Media | Store `public_id`, never a URL | Cloudinary public ids; URLs are built at render from named transformations ([ADR 0003](./decisions/0003-cloudinary-for-media.md)) |
| Naming | `snake_case` tables and columns, plural tables | — |
| Indexes | Partial where the query is partial | Discovery only reads published events, so the index only holds published events |

### Neon: pooled vs direct

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")         // pooled (PgBouncer, transaction mode) — the app
  directUrl = env("DIRECT_DATABASE_URL")  // direct — migrations and introspection
}
```

Under transaction pooling, **session-scoped state does not survive between statements**:

```sql
SELECT pg_advisory_xact_lock(hashtext($1));   -- ✅ released at COMMIT
SELECT pg_advisory_lock(hashtext($1));        -- ❌ leaks onto a pooled connection
SET LOCAL statement_timeout = '5s';           -- ✅ transaction-scoped
SET statement_timeout = '5s';                 -- ❌ leaks onto a pooled connection
```

CI greps for `pg_advisory_lock(` and bare `SET ` in `.sql` files. See
[ADR 0001 § C2, C3](./decisions/0001-neon-over-supabase.md).

---

## 3. Errors

Two channels, and the client never parses an error message string.

**User errors** are typed fields in a mutation payload. Anything the player can act on:
"this draw is full", "that code is wrong". They are data, not exceptions.

```graphql
type RegisterForEventPayload {
  registration: Registration
  userError: RegisterForEventError   # null on success
}
```

**System errors** are GraphQL errors with a machine-readable `extensions.code`. Anything the
player cannot act on: not authenticated, forbidden, rate limited, internal.

```ts
throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
```

### Shared codes

| Code | Channel | Client behaviour |
|---|---|---|
| `UNAUTHENTICATED` | system | Refresh the token once, replay, then route to login |
| `FORBIDDEN` | system | Generic error state. Never leak whether the resource exists |
| `RATE_LIMITED` | system | Back off using `retryAfterSeconds` |
| `INTERNAL` | system | Generic error state plus the trace ID, which support can search |
| `ILLEGAL_TRANSITION` | system | Bug. Log loudly |

Module-specific codes are listed in each module doc. Codes are stable — renaming one is a
breaking API change.

---

## 4. GraphQL

- **One endpoint**, `POST /graphql`. New features are fields, never new REST routes.
- **Relay connections** for every list, cursor on `(sort_key, id)`, `first` capped at 50.
- **`Node` is implemented by exactly six types** — `Event`, `Match`, `PlayerProfile`, `Game`,
  `Venue` and `Community`. Those are the deep-link targets. `Venue` and `Community` were added with
  the feature-coverage update (notifications R9). Adding a seventh is a product decision, not a
  schema one.
- **DataLoaders are built in `buildContext`** and die with the request. No cross-request cache,
  so no cross-user leak is possible.
- **Complexity limit 1000, depth limit 10.** A public mobile graph without a cost limit is a
  denial-of-service endpoint you shipped on purpose.
- **Trusted documents in production.** The app sends a hash from client codegen, not a query
  string. Arbitrary queries are rejected, and the hash cuts request size on 3G.
- **Introspection off in production.** The committed SDL is the contract.
- **Mutations are verb-first and return a payload type**: `registerForEvent(input:) : RegisterForEventPayload!`

Regenerate and commit the SDL on every schema change: `pnpm schema:generate`.

---

## 5. Testing

- **Vitest.** Unit tests for pure logic, service tests against a real Postgres via Testcontainers.
- **A mocked database is banned for service tests.** Our correctness lives in constraints — unique
  partial indexes, `FOR UPDATE`, advisory locks. A mock hides exactly the bugs that matter.
- **Every numbered rule has at least one test that names it:**

  ```ts
  test('registration R4: capacity is decided under FOR UPDATE', async () => { … });
  test('scoring R1: a stale expectedSeq is rejected', async () => { … });
  ```

  Grepping for `R4:` should find the test. This is the whole point of stable rule IDs.
- **Contract tests** for Razorpay and Pusher run against recorded fixtures, including the failure
  payloads: `payment.failed`, a duplicate delivery, a webhook arriving before the client callback.
- **Concurrency tests are not optional** in `registration`, `payments`, `tournament` and `scoring`.
  Each of those modules names one in its **Done when**.

---

## 6. Jobs

Every job is idempotent, because every job can be retried.

```ts
queue.registration.add('release-hold', { holdId }, {
  delay: 10 * 60_000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: 1_000,
  removeOnFail: false,          // failures stay for inspection
});
```

Retry policy and final-failure behaviour are documented per job in each module doc. "Final
failure" is one of: **drop** (safe to lose), **alert** (someone should look today), or
**page** (someone looks now — money or capacity is wrong).

---

## 7. Configuration

All env vars are parsed by Zod in `platform/config.ts` at boot. A missing or malformed variable
**exits the process**. A missing `RAZORPAY_WEBHOOK_SECRET` must stop a deploy, not surface as a
signature failure three hours into a tournament.

Never read `process.env` outside `config.ts`.

---

## 8. Logging

Pino, structured JSON. Every log line carries `requestId`; domain lines add `userId` and
`eventId` where known. The request ID rides into every job enqueued during that request, so a
support ticket about one registration traces end to end.

**Never log:** OTP codes (including in an email subject line), tokens, full Razorpay payloads at
info level, or email addresses in plaintext outside the identity module.

---

## 9. Git

- Branch per module task: `feat/registration-seat-holds`
- Conventional commits, with rule IDs where they apply:
  `fix(scoring): reject stale expectedSeq — scoring R1`
- A PR is not reviewable until `pnpm check` is clean and the module's **Done when** check runs.
- Migrations are never edited after merge. Fix forward with a new migration.
