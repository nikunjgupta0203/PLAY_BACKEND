# ADR 0001 — Neon for Postgres, not Supabase

**Status:** Accepted
**Date:** 2026-09-05
**Deciders:** Backend
**Supersedes:** the "managed Postgres, provider TBD" placeholder in the original architecture

---

## Context

The backend is Express + TypeScript + GraphQL (Apollo 4 + Pothos + Prisma), with Razorpay for
payments, Pusher for realtime, Resend for email OTP ([ADR 0002](./0002-email-otp-via-resend.md)),
and Cloudinary for media ([ADR 0003](./0003-cloudinary-for-media.md)). That stack was decided before
the database host was.

Supabase was one of three candidate stacks in the original architecture question. It was **not**
selected — the chosen path was a custom Express + GraphQL backend. Reopening Supabase now is
therefore not a database question but a platform question, and it needs to be answered as one.

## The decision

Use **Neon** as the managed PostgreSQL provider. Keep every other dependency as specified.

## Why Supabase's value is mostly unavailable to us

Supabase is Postgres plus an integrated platform. That platform is where its advantage lives —
and this architecture already declined each piece of it, deliberately:

| Supabase feature | Our design | Status |
|---|---|---|
| Supabase Auth | Resend email OTP + our own RS256 JWT with rotating refresh tokens | Unused |
| Row Level Security | Authorization in the service layer, so workers and webhooks get identical rules | Unused |
| Realtime | Pusher Channels — chosen so there is no WebSocket server to run, scale or drain | Unused |
| PostgREST / `pg_graphql` | Apollo Server 4 + Pothos, code-first, with complexity limits and trusted documents | Unused |
| Edge Functions | Express routes and BullMQ workers | Unused |
| Storage | Cloudinary, signed direct upload with named transformations | Unused |
| Studio (data browser) | — | **Genuinely useful** |

Six of seven are dead weight. Adopting Supabase would mean paying for an integrated platform to
use one part of it, while carrying the coupling of the rest.

A note on RLS specifically: it is not merely unused, it is the wrong tool here. Our permission
model is per-event grants (`event_staff`), and the same rules must apply when a BullMQ job or the
Razorpay webhook handler calls a service — neither of which has a user session for RLS to key off.
Splitting authorization between RLS policies and service-layer checks would mean two places to get
it right and one place to forget.

## Why Neon specifically

### 1. Branch-per-PR is already in the spec

`architecture.md § Environments` calls for preview environments with "an ephemeral database from
migrations + seed." Neon branches are copy-on-write off the parent, created in seconds, and cost
only the diff.

This matters more than usual here because our correctness lives in database constraints — the
unique partial index in `registration R1`, the `FOR UPDATE` capacity check in `registration R4`,
the advisory lock in `tournament R9`. Those cannot be tested against a mock, so every PR wants a
real Postgres. Neon turns that from an aspiration into a CI step.

### 2. The traffic shape is spiky in a way scale-to-zero suits

PL4Y's load is near-zero at 03:00 on a Tuesday and heavy on a Saturday morning. Neon suspends idle
compute and resumes on connection, and autoscales compute units within a configured range without
a restart. Preview and staging branches cost close to nothing between tournaments. A fixed RDS or
Supabase instance is sized in advance and billed regardless.

### 3. Branch-from-timestamp is a better incident tool than snapshot restore

If a bad migration corrupts `registrations` during a live tournament, we branch from ten minutes
ago and inspect it while production keeps serving — rather than restoring a snapshot into a fresh
instance and waiting. For a product whose worst hour is also its busiest hour, this is worth real
money.

### 4. It is only Postgres

No auth, storage or realtime coupling to unwind later. Migrating to RDS or Cloud SQL is a
connection-string change plus a dump/restore, not a re-platform. Given that this is a v1 with an
unproven load profile, keeping the exit cheap is worth something.

## What we give up

Stated plainly, because these are real:

- **Studio.** Supabase's data browser is materially better than Neon's console. Until the admin
  dashboard exists, support questions ("find this player's registration") are more awkward. Mitigation:
  ship a read-only internal admin view early, and use any standard Postgres client meanwhile.
- ~~**Storage with image transforms.**~~ **No longer a trade.** [ADR 0003](./0003-cloudinary-for-media.md)
  adopts Cloudinary, whose transformation pipeline is better than Supabase Storage's for our case —
  three avatar sizes and two cover sizes from one upload, with automatic format negotiation.
- **Pricing predictability.** Neon bills on usage; Supabase on flat tiers. If production compute never
  idles — which it will not, once traffic is real — Neon's bill tracks load rather than sitting flat.
  Set a spend alert in month one rather than discovering this in month four.
- **A single vendor.** Supabase would be one dashboard for database, auth, storage and realtime. We
  will have Neon, Pusher, Razorpay, Resend and Cloudinary. That is more accounts, more secrets and
  more status pages to watch.

## Consequences — three things to get right

These are not optional. Two of them fail confusingly rather than loudly.

### C1 — Verify PostGIS before Sprint 3 (blocking)

Radius search is load-bearing in three modules: `events` (Explore), `venues` (discovery) and
`games` (map view). Confirm `postgis` is available and enabled on the target Neon plan **before**
Sprint 3 starts. If it is not, either the extension gap or this ADR has to change — do not discover
this while building Explore.

Fallback if unavailable: a bounding-box prefilter on indexed `lat`/`lng` columns plus a haversine
distance filter. Workable, meaningfully slower, and a schema change to retrofit — hence: verify first.

### C2 — Pooled vs direct connection URLs

Neon's pooled endpoint runs PgBouncer in **transaction** pooling mode. Prisma needs both URLs:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")         // pooled  — the app
  directUrl = env("DIRECT_DATABASE_URL")  // direct  — migrations, introspection
}
```

Migrations run against the direct URL; the application runs against the pooled one. Getting this
wrong produces migration failures that look like permission or advisory-lock problems. Both variables
are in `.env.example` with comments, and `config.ts` fails at boot if either is missing.

### C3 — Transaction-scoped advisory locks only

Under transaction pooling, session-scoped state does not survive between statements. Our design
already uses the correct primitive:

```sql
SELECT pg_advisory_xact_lock(hashtext($1));   -- correct: released at COMMIT
SELECT pg_advisory_lock(hashtext($1));        -- WRONG under PgBouncer: leaks, or locks a
                                              -- pooled connection another request will reuse
```

`tournament R9` depends on this. Add a lint rule or a grep in CI for `pg_advisory_lock(` so nobody
"simplifies" it later. Same principle applies to `SET LOCAL` (fine) versus `SET` (not fine), and to
prepared statements — Prisma handles the latter correctly against Neon's pooler.

## Revisit this if

- PostGIS turns out to be unavailable (C1) — then reconsider, since three modules depend on it.
- Monthly database spend exceeds roughly 2× the equivalent fixed-size instance, which would mean
  compute never idles and we are paying serverless prices for a steady-state workload.
- We decide to drop the custom backend for a BaaS approach — at which point this ADR is moot and the
  original stack decision is the one being reopened.

## References

- `architecture.md` § Environments — the pooled/direct URL rule and full env list
- `modules/06-registration.md` R4 — the `FOR UPDATE` capacity check
- `modules/09-tournament.md` R9 — the advisory lock
- `modules/05-events.md` R6 — PostGIS radius search
