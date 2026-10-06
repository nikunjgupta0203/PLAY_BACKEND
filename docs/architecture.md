# Architecture

One deployable API process, one worker process running the same image, and a small set of managed
dependencies. Nothing here is a microservice, and nothing here needs to be.

---

## 1. System shape

The product loop — discover → play → compete → track → rank — is a single transactional story per
player. Splitting it across services buys distributed transactions and buys nothing else at this
scale. So: a **modular monolith**. Hard internal boundaries between twenty modules, one process,
one database. The boundaries make a later split cheap; the split itself waits until something
forces it.

```
  PL4Y Mobile (Expo/RN)          Organizer Web (Next.js)
           │                              │
           └──────────────┬───────────────┘
                          │  HTTPS · CDN · WAF · per-IP rate limit
                          ▼
  ┌─────────────────────────────────────────────────────┐
  │  API PROCESS — Express 5 · TypeScript               │
  │                                                     │
  │   POST /graphql              Apollo 4 + Pothos      │
  │   POST /webhooks/razorpay    raw body · HMAC        │
  │   POST /webhooks/resend      email delivery events  │
  │   POST /pusher/auth          channel entitlement    │
  │   GET  /healthz /readyz      liveness · readiness   │
  │                                                     │
  │   20 domain modules                                 │
  │   resolvers → services → repositories               │
  └─────────────────────────────────────────────────────┘
                          │
  ┌─────────────────────────────────────────────────────┐
  │  WORKER PROCESS — Postgres job queue (same image)   │
  │  seat-hold expiry · outbox drain · rating periods   │
  │  ranking rebuild · reconciliation · push delivery   │
  └─────────────────────────────────────────────────────┘
           │                                   │
    Neon Postgres 16                     Cloudinary
    (data + jobs + rate limits)   (media + CDN + transforms)

  Third party:  Razorpay · Pusher Channels · Pusher Beams · Resend · Cloudinary
```

Two processes from one image. The worker exists because seat-hold expiry, rating periods and score
fan-out must not compete with request latency — not because the domain is distributed.

### The decisions that shape everything downstream

| Area | Decision | Consequence |
|---|---|---|
| API style | GraphQL, one endpoint | The Home screen needs six unrelated collections; one typed round trip beats six REST calls on Indian mobile networks. Cost: complexity limits mandatory from day one |
| Schema | Pothos, code-first | Strongest TS inference without decorators or DI. Prisma plugin resolves relations without hand-written loaders |
| Realtime | Pusher, not GraphQL subscriptions | No WebSocket server to run, scale or drain on deploy. Cost: Pusher is a cache-invalidation transport, never a source of truth |
| Money | The webhook is the truth | Razorpay's client callback is a UI hint. A registration confirms only on a signature-verified `payment.captured`, or on reconciliation |
| Rating | Glicko-2, versioned | Amateur players compete in bursts; rating deviation models inactivity, Elo cannot. Stored append-only with `algo_version` |
| Multi-sport | `sport_id NOT NULL` | On every event, match, rating and ranking. Pickleball is a row in `sports`, never a branch in code |
| Database | Neon | Branch-per-PR, scale-to-zero between tournaments, branch-from-timestamp during incidents. See [ADR 0001](./decisions/0001-neon-over-supabase.md) |
| Identity | Email OTP via Resend | One provider instead of DLT-registered SMS, and deliverability you can actually diagnose. Cost: slower codes, and partner invites by email. See [ADR 0002](./decisions/0002-email-otp-via-resend.md) |
| Media | Cloudinary | Every image is displayed at three sizes; transforms on demand beat a bucket plus a resizer. Store `public_id`, never a URL. See [ADR 0003](./decisions/0003-cloudinary-for-media.md) |

---

## 2. Runtime & composition

Express hosts five things: the GraphQL endpoint, two signed webhooks (Razorpay and Resend), the
Pusher channel authorizer, and health checks. **That list is closed** — new features arrive as
GraphQL fields.

| Layer | Choice | Why this one |
|---|---|---|
| Runtime | Node 22 LTS, ESM, TS `strict` | Native fetch, stable test runner, long support window |
| HTTP | Express 5 | Async errors propagate to error middleware without a wrapper |
| GraphQL | Apollo Server 4 via `expressMiddleware` | Mounts as ordinary middleware, so webhook and auth routes stay plain Express |
| Schema | Pothos + Prisma/Relay/DataLoader plugins | Code-first with real inference; SDL generated and committed for client codegen |
| Data | Prisma 6 | Migrations and a typed client, with `$queryRaw` for the few queries needing `FOR UPDATE` |
| Jobs | Postgres `jobs` table, claimed `FOR UPDATE SKIP LOCKED` | Delayed jobs (seat-hold expiry), cron schedules (`job_schedules`, rating periods), retries — persistent, no second datastore ([spec](./superpowers/specs/2026-09-29-drop-redis-design.md)) |
| Validation | Zod | One library for env vars, webhook payloads and GraphQL inputs |
| Logging | Pino + OpenTelemetry | Structured JSON with a request ID that survives into enqueued jobs |
| Tests | Vitest + Testcontainers | A real Postgres per suite; a mocked database hides the constraint bugs this schema leans on |

### Middleware order is load-bearing

Razorpay signs the exact bytes it transmitted. If any JSON parser touches the webhook request
first, the signature will never verify — and the failure presents as a credentials problem, which
is how teams lose a day to it.

```ts
// Order matters. Read the comments before reordering anything.
const app = express();
app.set('trust proxy', 1);                // behind the platform load balancer
app.use(helmet());
app.use(pinoHttp({ genReqId: () => randomUUID() }));

// Razorpay signs the RAW request body. This route must be mounted
// before express.json(), or HMAC verification fails silently forever.
app.post('/webhooks/razorpay',
  express.raw({ type: 'application/json' }),
  razorpayWebhook);

app.use(express.json({ limit: '256kb' }));

// Pusher hands the client a socket_id; we decide what it may subscribe to.
app.post('/pusher/auth', requireAuth, pusherChannelAuth);

app.get('/healthz', () => ok());          // process is alive
app.get('/readyz',  readiness);           // pg reachable

await apollo.start();
app.use('/graphql',
  cors(corsPolicy),
  expressMiddleware(apollo, { context: buildContext }));

app.use(errorMiddleware);                 // last, always
```

### Layout

```
src/
  app.ts                    composition root, above
  worker.ts                 same image, job-queue entrypoint
  platform/                 no domain logic lives here
    config.ts               zod-parsed env; process exits at boot if invalid
    db.ts  queue.ts  cron.ts  outbox.ts  rateLimit.ts
    pusher.ts  razorpay.ts  email.ts  cloudinary.ts
    auth/  errors/  logging/  loaders/
  modules/
    <name>/  schema/ service/ repo/ events.ts index.ts
  schema.ts                 merges module schemas into one executable schema
```

See [conventions.md § 1](./conventions.md#1-the-module-contract) for the module contract.

---

## 3. Request flows

### A registration, end to end

```
1. Client  → beginRegistration(eventCategoryId)
2. Service → events.priceQuote()            freeze amount onto the registration
           → acquire seat hold              FOR UPDATE on the category (registration R4)
           → schedule release-hold job       delayed +10 min
3. Client  → createPaymentOrder(registrationId)
4. Service → events.priceQuote() again      recompute server-side, never trust the client
           → Razorpay Orders API            store razorpay_order_id
5. Client  → Razorpay Checkout (UPI/card/netbanking)
6. Razorpay→ POST /webhooks/razorpay        raw body, HMAC verified
7. Service → claim razorpay_event_id         duplicate ⇒ 200, no work (payments R3)
           → 200 in <1s                     Razorpay times out at 5s
           → enqueue apply-webhook
8. Worker  → registration.confirmFromPayment()
           → status CONFIRMED, hold consumed, ledger written
           → outbox: registration.confirmed
9. Worker  → notifications.emit() + Pusher publish to private-user-{id}
```

Step 6 is the source of truth. Step 5's client callback confirms nothing. If step 6 never
arrives, `reconcile-pending` resolves it within 30 minutes.

### A point scored, end to end

```
1. Scorer  → recordPoint(matchId, side, expectedSeq)
2. Service → reject if expectedSeq ≠ match.score_seq   (scoring R1)
           → append match_score_events row             append-only (scoring R2)
           → update matches.current_score, score_seq
           → outbox: match.score                       never publish inline (scoring R5)
3. Worker  → drain outbox, coalesce 250 ms per match
           → Pusher publish to private-match-{id}
4. Client  → patch Apollo cache from the payload
           → on a seq gap or reconnect, refetch match(id) over GraphQL
```

Pusher is a cache-invalidation transport. Every payload carries the **complete** score, not a
delta, so a client that missed ten messages is correct on receiving the eleventh.

---

## 4. GraphQL surface

Rules and conventions live in [conventions.md § 4](./conventions.md#4-graphql). The shape:

```graphql
interface Node { id: ID! }
# The six deep-link targets, and only these (conventions §4).
type Event implements Node { … }
type Match implements Node { … }
type PlayerProfile implements Node { … }
type Game implements Node { … }
type Venue implements Node { … }
type Community implements Node { … }

type Query {
  me: Viewer
  node(id: ID!): Node
  home(city: String, sportId: ID): HomeFeed!      # fills the entire Home screen — modules/21-home.md
  events(filter: EventFilter, first: Int = 20, after: String): EventConnection!
  event(slug: String!): Event
  rankings(sportId: ID!, scope: RankingScope!, first: Int = 50, after: String): RankingConnection!
  players(query: String!, sportId: ID, first: Int = 20): PlayerConnection!
  venues(near: GeoPointInput, radiusKm: Float = 10): VenueConnection!
}
```

`Event.status = LIVE` is what flips the Event Detail screen into Live Mode. Live Mode is a state,
not a separate route.

---

## 5. Identity & authorization

**Email-first**, verified by a six-digit code delivered through Resend. There is no SMS provider;
`phone_e164` is optional, unverified contact information. See
[ADR 0002](./decisions/0002-email-otp-via-resend.md) for the reasoning and the risks, and
[modules/01-identity.md](./modules/01-identity.md) for the full spec.

| Token | Form | Lifetime | Notes |
|---|---|---|---|
| Access | JWT, RS256 | 15 min | Claims: `sub`, `sid`, `ver`. **No role claim** |
| Refresh | Opaque 256-bit, hashed | 60 days | Rotates on use; reuse revokes the whole family |
| Pusher auth | Short-lived signature | Per socket | Issued after re-checking entitlement |

**Why no roles in the JWT:** an organizer's permission is per-event and revocable. Baked into a
15-minute token, a revoked grant stays live for up to 15 minutes — on a screen that can rewrite
match results. Grants are read from `event_staff` per request and memoised in a request-scoped
loader. One indexed lookup; revocation is immediate.

**Authorization lives in the service layer**, not the resolver. Pothos `authScopes` is a cheap
first gate. The check that matters is a policy function called by the service, so the same rule
applies when a queued job or the webhook handler calls it.

---

## 6. Jobs & caching

| Queue | Job | Trigger | Retry | Final failure |
|---|---|---|---|---|
| registration | `release-hold` | Delayed +10 min | 3 × exp | **Alert** — capacity stuck |
| registration | `expire-invite` | Delayed +48 h | 3 × exp | Log; nightly sweep |
| registration | `sweep-stale-holds` | Every 5 min | 3 × exp | Alert |
| payments | `apply-webhook` | Webhook ingest | 5 × exp | **Page** — money unreconciled |
| payments | `reconcile-pending` | Every 15 min | 3 × exp | Alert |
| payments | `process-refund` | Cancellation | 5 × exp | **Page** — a player is owed money |
| realtime | `drain-outbox` | Every 250 ms | 3 × fixed | Drop — clients refetch on seq gap |
| tournament | `schedule-courts` | Match becomes ready | 3 × exp | Alert; organizer assigns manually |
| rating | `apply-provisional` | Result confirmed | 5 × exp | Alert; period job corrects |
| rating | `run-period` | Weekly, Mon 03:00 IST | 3 × exp | **Page** — ratings frozen |
| rating | `rebuild-rankings` | After period; event completion | 3 × exp | Alert; cache serves stale |
| notify | `send-push` | Outbox | 3 × exp | Drop; in-app feed row persists |
| payments | `settle-event-payouts` | Hourly — events past end + 72 h | 5 × exp | **Page** — an organizer is owed money |
| payments | `reverse-transfer` | Refund after payout | 5 × exp | Alert; receivable written |
| profile | `project-match-history` | `match.completed` | 5 × exp | Alert; history lags |
| organizers | `project-event-stats` | Outbox | 3 × exp | Alert; dashboard serves stale |
| discovery | `project-search-document` | Outbox | 5 × exp | Alert; search serves stale |
| bookings | `release-booking-hold` | Delayed +10 min | 3 × exp | Alert |
| ticketing | `release-ticket-hold` | Delayed +10 min | 3 × exp | Alert |

Every module doc lists its full job table; this is the subset the on-call rotation should know.

### Where the fast state lives

There is no Redis ([spec](./superpowers/specs/2026-09-29-drop-redis-design.md)). Everything below is
Postgres:

| State | Table | Kept for |
|---|---|---|
| Jobs (delayed, retried, deduped by `jobId`) | `jobs` | Completed 7 days, failed 30 days (`prune-jobs`) |
| Repeatables | `job_schedules` | Rewritten at every worker boot |
| Rate limits (`otp:*`, `event-message:*`, `pusher-auth:*`) | `rate_limit_hits` | 24 h, the longest window (`prune-rate-limits`) |
| Leaderboards | `rankings`, read directly | — the service still accepts an optional board cache |

Caches that were planned for Redis (`event:{slug}`, `home:*`, `apq:*`, `reco:*`, `views:*`) are not
built. If one is ever needed, start in-process; correctness state — seat holds, court bookings,
ticket inventory, payment state, match scores — never lives in a cache.

---

## 7. Observability

Structured logs carry `requestId`, `userId` and `eventId`, and the request ID rides into every job
enqueued during the request. The dashboards that matter on a tournament Saturday:

- **Registration funnel** — begun → hold acquired → order created → confirmed, with drop-off at
  each step. A spike between order and confirm means Razorpay, not you.
- **Webhook lag** — p95 from Razorpay's timestamp to `processed_at`. Alert above 60 s.
- **Unreconciled money** — count of `payment_pending` older than 30 minutes. Steady state is zero.
- **Score fan-out lag** — outbox row written → Pusher acknowledged. Alert above 2 s; spectators notice.
- **GraphQL p95 by operation name**, with `home` and `events` watched separately — they are the two
  the whole app waits on.

---

## 8. Environments

| Environment | Database | Razorpay | Pusher |
|---|---|---|---|
| local | Docker Postgres; `pnpm seed:tournament` | test keys | sandbox app |
| preview (per PR) | **Neon branch** off `main`, migrated + seeded, deleted on merge | test keys | sandbox app |
| staging | Neon branch, refreshed weekly from an anonymised production copy | test keys | staging app |
| production | Neon primary + read replica for ranking reads, PITR enabled | live keys | production app |

### Environment variables

```bash
# Database — BOTH are required. See ADR 0001 § C2.
DATABASE_URL=           # pooled endpoint (PgBouncer, transaction mode) — the app
DIRECT_DATABASE_URL=    # direct endpoint — migrations and introspection only

# Auth
JWT_PRIVATE_KEY=        # RS256 PEM
JWT_PUBLIC_KEY=

# Email — Resend. Verify the sending domain and publish SPF/DKIM/DMARC first.
RESEND_API_KEY=
RESEND_FROM=            # "PL4Y <support@getpl4y.com>"
RESEND_WEBHOOK_SECRET=  # delivery / bounce / complaint events

# Payments
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# Realtime
PUSHER_APP_ID=
PUSHER_KEY=
PUSHER_SECRET=
PUSHER_CLUSTER=
PUSHER_BEAMS_INSTANCE_ID=
PUSHER_BEAMS_SECRET_KEY=

# Media — Cloudinary. Never expose the API secret to a client.
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_UPLOAD_PRESET=   # signed preset: allowed formats, size and dimension caps

# Check-in QR tokens — registration R13. The token carries a key id, so this can rotate.
CHECKIN_TOKEN_SECRET=

# Payouts — payments R14. Who bears the gateway fee: 'platform' | 'organizer'
GATEWAY_FEE_BEARER=
```

All parsed by Zod in `platform/config.ts` at boot. A missing variable exits the process.

### Deployment

Containers on a managed platform — **Railway or Render through Sprint 6, AWS ECS Fargate at
launch**. Two services from one image: `node dist/app.js` and `node dist/worker.js`. Nothing above
the managed-data line changes if you pick a different host.

Migrations run as a release step against `DIRECT_DATABASE_URL`, before the new image takes traffic.
Every migration must be backward-compatible with the currently deployed code — expand, deploy,
contract.

---

## 9. Non-goals & seams

| Deferred | Why now is wrong | Seam already in place |
|---|---|---|
| Court booking | Inventory, availability and cancellation are a second commerce domain | **Specified for Phase 3** in [19-bookings.md](./modules/19-bookings.md): its own tables, reusing the hold-then-pay pattern |
| Split payment for doubles | A second payment state machine, and a partner who can strand a confirmed entry | `payment_orders` is per registration; a second order against one registration is additive |
| Leagues & seasons | Needs standings over time, promotion and relegation | **Specified for Phase 3** in [18-leagues.md](./modules/18-leagues.md): a season is an event and a division a category |
| Advanced rating | You need thousands of real matches to tell a better model from a worse one | `algo_version` on every rating event; a new model replays the log |
| Sponsorship marketplace | Nothing to sell until events have consistent attendance | Events carry media keys and an organizer relationship |
| PL4Y+ subscription | No entitlement to gate yet | Payments is a general order/ledger domain, not registration-only |
| GraphQL federation | One team, one schema — federation solves an org problem you don't have | Module boundaries with no cross-module table reads |

### Known risks

- **Pusher message volume** is the cost line most likely to surprise the team. A 32-entry draw is
  ~2,300 point events per event day; delivery is metered per subscriber, so an event-wide broadcast
  to 200 viewers would be ~460,000 delivered messages in one afternoon. Point-level detail stays on
  `private-match-{id}`. Instrument this from Sprint 8 and check it against the plan before the first
  public tournament.
- **The doubles rating rule** is a defensible v1, not a settled answer. Expect to revise it after a
  season of real results — which is what `algo_version` is for.
- **PostGIS on Neon** must be verified before Sprint 3. Three modules depend on it. See
  [ADR 0001 § C1](./decisions/0001-neon-over-supabase.md).
- **Email OTP deliverability** is the biggest risk to signup conversion, and it is invisible without
  the requested → delivered → verified funnel from [ADR 0002 § C2](./decisions/0002-email-otp-via-resend.md).
  Domain authentication (SPF/DKIM/DMARC) must be done before Sprint 1 identity work.
- **Doubles registrations** may suffer from email-based partner invites (`registration R12`). Watch
  the `awaiting_partner` → `payment_pending` conversion against singles.
