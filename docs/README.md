# PL4Y Backend — Documentation

Amateur sports discovery + tournament platform. Launch sport: **Pickleball**.
Architecture is sport-agnostic from day one.

**Stack:** Node 22 · TypeScript (strict, ESM) · Express 5 · Apollo Server 4 · Pothos ·
Prisma 6 · PostgreSQL 16 on **Neon** (data, job queue, rate limits) · Razorpay · Pusher Channels + Beams ·
Resend (email OTP) · Cloudinary (media)

---

## How to use these docs

Each module in [`modules/`](./modules) is a self-contained, buildable unit. Pick one, read it
top to bottom, work the **Implementation checklist** at the bottom, and stop when the
**Done when** check passes. Do not start a module before its dependencies are green.

Every rule has a stable ID — `R1`, `R2`, … scoped to its module. Cite them in test names,
commit messages and PR descriptions:

```
test('registration R4: capacity is decided under FOR UPDATE', ...)
fix(scoring): correct undo sequencing — scoring R2
```

Rule IDs never get renumbered. If a rule is removed it is struck through, not deleted.

---

## Read in this order

| # | Document | What it settles |
|---|----------|-----------------|
| 1 | [architecture.md](./architecture.md) | System shape, processes, request flow, deployment |
| 2 | [conventions.md](./conventions.md) | Module contract, naming, errors, testing, git |
| 3 | [decisions/](./decisions) | Why the load-bearing choices were made — [0001 Neon](./decisions/0001-neon-over-supabase.md) · [0002 Resend](./decisions/0002-email-otp-via-resend.md) · [0003 Cloudinary](./decisions/0003-cloudinary-for-media.md) |
| 4 | [reference/schema.sql](./reference/schema.sql) | Full DDL in one file |
| 5 | [modules/](./modules) | One buildable spec per module |
| 6 | [feature-coverage.md](./feature-coverage.md) | Every item in the product feature list → the module and rule that specifies it |

---

## Build order

Dependencies point downward. A layer cannot be finished before the one above it.

```
L0  sport ─────────── identity                    no domain dependencies
              │
L1  profile ──┴────── venues
              │
L2  events ───┘ ──── home                         read-only composition of events,
              │                                  registration and profile; nothing reads it
L3  registration ──── payments                    money + capacity
              │
L4  tournament ────── scoring                     concurrency
              │
L5  rating                                        derived from everything above
              │
L6  organizers ────── admin                       operating the platform (Sprint 7)

    notifications                                 cross-cutting, consumes all

Phase 2   games · social · communities · discovery    discovery reads everything; nothing reads it
Phase 3   leagues · bookings · ticketing              reuse events, registration and payments
```

| Sprint | Modules | Doc |
|--------|---------|-----|
| 1 | platform, identity | [00-platform.md](./modules/00-platform.md) · [01-identity.md](./modules/01-identity.md) |
| 2 | sport, profile | [02-sport.md](./modules/02-sport.md) · [03-profile.md](./modules/03-profile.md) |
| 3 | venues, events, home *(home landed later, closing frontend G5)* | [04-venues.md](./modules/04-venues.md) · [05-events.md](./modules/05-events.md) · [21-home.md](./modules/21-home.md) |
| 4 | registration, payments | [06-registration.md](./modules/06-registration.md) · [07-payments.md](./modules/07-payments.md) |
| 5 | *(My PL4Y queries, refunds, waitlist, QR check-in — no new module)* | [06-registration.md](./modules/06-registration.md) R13, R17 |
| 6 | rating | [08-rating.md](./modules/08-rating.md) |
| 7 | organizers, admin (core) — organizer surface, payouts, audited operations | [14-organizers.md](./modules/14-organizers.md) · [15-admin.md](./modules/15-admin.md) |
| 8 | tournament, scoring | [09-tournament.md](./modules/09-tournament.md) · [10-scoring.md](./modules/10-scoring.md) |
| 9 | notifications | [11-notifications.md](./modules/11-notifications.md) |
| 10 | games, social | [12-games.md](./modules/12-games.md) · [13-social.md](./modules/13-social.md) |
| 11 | communities, discovery — plus the Phase 2 rules in profile, venues, games, social, registration | [16-discovery.md](./modules/16-discovery.md) · [17-communities.md](./modules/17-communities.md) |
| 12 | admin — moderation, support, fraud, reports | [15-admin.md](./modules/15-admin.md) |
| 13 | leagues *(Phase 3)* | [18-leagues.md](./modules/18-leagues.md) |
| 14 | bookings *(Phase 3)* | [19-bookings.md](./modules/19-bookings.md) |
| 15 | ticketing *(Phase 3)* | [20-ticketing.md](./modules/20-ticketing.md) |

**Sprints 4 and 8 carry the risk.** Registration/payments is where money and capacity meet;
tournament/scoring is where concurrency does. Everything else is CRUD with good types. If the
schedule slips, protect those two — and start Sprint 4 with the two invariant tests in
[06-registration.md](./modules/06-registration.md), not with resolvers.

Sprint 7 (payouts) and Sprints 14–15 (bookings, ticketing) carry money risk of the same kind.
Bookings and ticketing each open with a concurrency test, exactly like registration.

---

## Definition of done, per module

A module is done when **all** of these are true:

- [ ] Migrations applied and reversible
- [ ] Service interface implemented, exported only from `index.ts`
- [ ] Every numbered rule has at least one test that names it
- [ ] GraphQL surface wired, SDL regenerated and committed
- [ ] Errors raised with the documented codes
- [ ] Jobs registered on the worker with the documented retry policy
- [ ] The module's **Done when** check passes against a real Postgres
- [ ] `pnpm check` clean (typecheck + lint + test)

---

## Cross-module acceptance

Individually green modules do not make a working product. One integration test walks the
acceptance script from the product brief, against a real database, in CI:

```
sign up (email OTP) → select sport + skill + city → discover a published event
  → begin registration → invite partner → partner accepts → seat held
  → create order → deliver payment.captured webhook → CONFIRMED
  → organizer generates draw → match scheduled onto a court
  → scorer records points → result submitted → opponent confirms
  → winner advances, loser drops to Plate → rating event written
  → weekly period runs → rankings rebuilt → profile shows the new rating
  → notification feed contains: registration.confirmed, match.starting_soon,
    match.result, ranking.changed
```

`pnpm seed:tournament` produces this scenario from an empty database in one command. It is the
fixture for the bracket, live-scoring and rankings work, and it is the test that fails loudly
when a module boundary is quietly violated.

---

## Quick start

```bash
pnpm install
cp .env.example .env                 # Neon, Razorpay, Pusher, Resend, Cloudinary
pnpm db:migrate                      # uses DIRECT_DATABASE_URL
pnpm seed                            # sports, skill bands, scoring rules, demo city
pnpm cloudinary:setup                # once per Cloudinary account — named transformations (ADR 0003 §C1)
pnpm seed:home                       # optional: fills every Home region for the dev account, with covers
pnpm dev                             # API on :4000, GraphQL at /graphql
pnpm dev:worker                      # job-queue worker, separate process
pnpm test                            # Vitest + Testcontainers
```

See [architecture.md § Environments](./architecture.md#environments) for the full env var list
and the Neon pooled-vs-direct URL rule, which is the most common setup mistake.
