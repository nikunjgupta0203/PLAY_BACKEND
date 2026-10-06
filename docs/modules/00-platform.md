# 00 — platform

| | |
|---|---|
| **Sprint** | 1 |
| **Phase** | 1 |
| **Depends on** | nothing |
| **Owns** | `outbox` (the only table) |
| **Rule prefix** | `platform R*` |

Not a domain module. Everything under `src/platform/` is infrastructure that domain modules
consume: configuration, the database client, the job queue, the rate limiter, the outbox, auth primitives,
error types, logging, and thin adapters for Razorpay, Pusher, Resend and Cloudinary.

**No domain logic lives here.** Enforced by lint: `platform/` may not import from `modules/`.

---

## Contents

```
platform/
  config.ts        zod-parsed env; exits the process at boot if invalid
  db.ts            Prisma client, pooled URL
  queue.ts         Postgres job queue: add, workers, schedules, retention
  cron.ts          five-field UTC cron for job_schedules
  rateLimit.ts     Postgres sliding-window limiter
  outbox.ts        transactional outbox write + drain
  auth/            JWT sign/verify, Actor type, requireAuth middleware
  errors/          UserError, SystemError, error codes, GraphQL formatter
  logging/         pino instance, request-id propagation into jobs
  loaders/         DataLoader factory, built per request
  razorpay.ts      Orders, Refunds, Route (linked accounts, transfers, reversals), disputes, signatures
  pusher.ts        Channels publish + channel auth signature (Beams: Sprint 9)
  realtime/        POST /pusher/auth handler; registration.updated notifier
  email.ts         Resend adapter — OTP, receipts, invites
  cloudinary.ts    signed upload params; public_id → URL, named transforms only
```

---

## Rules

**R1** — `process.env` is read in exactly one file: `config.ts`. Everything else imports the parsed
config object. A grep for `process.env` outside `config.ts` fails CI.

**R2** — Config is validated by Zod at boot and the process **exits** on failure. A missing
`RAZORPAY_WEBHOOK_SECRET` must stop a deploy, not surface as a signature failure three hours into a
tournament.

**R3** — Prisma is configured with both URLs. `url` is Neon's pooled endpoint; `directUrl` is the
direct endpoint used for migrations and introspection. See
[ADR 0001 § C2](../decisions/0001-neon-over-supabase.md).

**R4** — Only transaction-scoped Postgres session state. `pg_advisory_xact_lock`, never
`pg_advisory_lock`; `SET LOCAL`, never bare `SET`. CI greps for both.

**R5** — The outbox write is a plain Prisma call taking the caller's transaction client, so a
domain module can write state and its side effects atomically:

```ts
await db.$transaction(async (tx) => {
  await tx.registration.update({ … });
  await outbox.write(tx, { topic: 'registration.confirmed', payload: { … } });
});
```

**R6** — `drain-outbox` runs every 250 ms on the worker, claims rows with
`FOR UPDATE SKIP LOCKED`, dispatches them, and marks them processed. Claimed-not-processed rows
older than 5 minutes are retried. Dispatch is at-least-once, so every consumer is idempotent.

**R7** — Adapters expose the narrowest useful surface and translate vendor errors into our error
types. No module imports the Razorpay, Pusher, Resend or Cloudinary SDK directly — swapping a vendor
must be one file.

**R10** — Every Cloudinary URL in the system is built by `cloudinary.url(publicId, transformName)`.
String-concatenating a Cloudinary URL anywhere else is a lint error: it is what makes a future
migration off Cloudinary a rewrite instead of a backfill ([ADR 0003](../decisions/0003-cloudinary-for-media.md) §C1).

**R8** — The logger propagates `requestId` into every job enqueued during a request, so a support
ticket traces from an HTTP call through to a push notification.

**R9** — DataLoaders are constructed in `buildContext` and die with the request. Never module-level;
a shared loader is a cross-user cache leak.

---

## The outbox table

```sql
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  request_id    text,
  claimed_at    timestamptz,
  processed_at  timestamptz,
  attempts      smallint NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (created_at)
  WHERE processed_at IS NULL;
```

---

## Realtime

`pusher.ts` is the only file that speaks Pusher: `fetch` + HMAC, no SDK. With any of
`PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET` empty it is a **no-op publisher** — realtime is an
optimisation and clients poll, so it never fails a boot.

### `POST /pusher/auth`

Form body `socket_id`, `channel_name`; `Authorization: Bearer <access token>`. Entitlement is
re-checked on every call. 30 per user per minute.

| Case | Response |
|---|---|
| Pusher unconfigured | `503 { error: "realtime_disabled" }` |
| Missing or invalid token | `401` |
| Malformed `socket_id` / `channel_name` | `400` |
| Over the rate limit | `429 { error: "rate_limited", retryAfterSeconds }` |
| Channel not on the allowlist, or `private-user-{id}` for someone else | `403` |
| `private-user-{own id}` | `200 { auth }` |

The allowlist currently holds only `private-user-{id}`. `private-match-{id}` and
`private-event-{id}` join it with live scoring.

### `registration.updated`

```
channel  private-user-{userId}     captain + every team member of the entry
event    registration.updated
data     { registrationId, topic }
```

**Invalidation only** — clients refetch `registration(id)`. Published from the worker for
`hold.created`, `invite.created`, `invite.declined`, `registration.confirmed`,
`registration.payment_failed`, `registration.expired`, `registration.cancelled`,
`registration.checked_in`, `refund.processed`. Not for `payment.captured` / `payment.failed`: the
`registration.*` row written by the same webhook job is the one clients need.

**Publishing is best-effort.** A failure loading the recipients, or a failed Pusher publish, is
logged at `warn` (ids only) and dropped — never retried. Clients already poll (frontend `checkout
R2`), so there is nothing a retry buys; a retry would instead pin the oldest outbox rows in place,
since `claimBatch` claims in `id` order and `markFailed` only clears the claim rather than moving
the row back. A Pusher outage or bad credentials therefore cannot stall the outbox.

### Local payments

`npm run simulate:payment -- <registrationId> [captured|failed]` sends a signed webhook to the local
`/webhooks/razorpay` for the registration's latest order. Refuses to run in production. The worker
must be running.

## Done when

`pnpm dev` boots with a complete `.env` and refuses to boot with an incomplete one, naming the
missing variable. A row written to `outbox` inside a transaction is dispatched by the worker
within one second, and is dispatched exactly once even when two workers are running.

---

## Implementation checklist

- [ ] `pnpm init`, TypeScript strict + ESM, Vitest, ESLint with `no-restricted-imports`
- [ ] `config.ts` with the full Zod schema from [architecture.md § 8](../architecture.md#8-environments)
- [ ] Prisma datasource with `url` + `directUrl`; first migration creates `outbox`
- [ ] `db.ts` singleton with graceful shutdown on SIGTERM
- [x] Postgres job queue (migration 023); `worker.ts` entrypoint separate from `app.ts`
- [ ] `outbox.write(tx, …)` + `drain-outbox` job with `FOR UPDATE SKIP LOCKED`
- [ ] JWT sign/verify, `Actor` type, `requireAuth` Express middleware
- [ ] `UserError` / `SystemError` + Apollo error formatter mapping to `extensions.code`
- [ ] Pino with request-id propagation into job data
- [ ] Adapter stubs for Razorpay, Pusher, Resend, Cloudinary — real calls behind an interface
- [ ] `express.raw` webhook routes (Razorpay, Resend) mounted **before** `express.json()`
- [ ] `/healthz` and `/readyz` (readyz checks Postgres)
- [ ] Testcontainers harness: spin Postgres, run migrations, truncate between suites
- [ ] CI: typecheck, lint, test, plus greps for `process.env`, `pg_advisory_lock(`, bare `SET `
- [ ] GitHub Action creating a Neon branch per PR and deleting it on merge
- [ ] *(Sprint 5)* `CHECKIN_TOKEN_SECRET` in the config schema (registration R13)
- [ ] *(Sprint 7)* Razorpay Route + dispute calls in the adapter (payments R13–R19);
      `GATEWAY_FEE_BEARER` in config (payments R14)
