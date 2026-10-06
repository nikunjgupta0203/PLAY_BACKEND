# Realtime — `private-user-{id}` channel — design

| | |
|---|---|
| **Date** | 2026-09-17 |
| **Touches** | `PALY_BACKEND` — `src/platform/pusher.ts` (new) · `src/platform/realtime/auth.ts` (new) · `src/app.ts` · `src/worker.ts` · `scripts/simulate-payment.ts` (new) |
| **Consumed by** | `PLAY_FRONTEND` 06-registration R10 · 07-checkout R2 · app-shell R8 (see `PLAY_FRONTEND/docs/superpowers/specs/2026-09-17-registration-checkout-design.md`) |
| **Amends** | `docs/modules/00-platform.md` (adapter + route) · `docs/modules/06-registration.md` and `07-payments.md` (§ Emits consumers) |

## Why

`docs/architecture.md` has specified `POST /pusher/auth` and "Worker → Pusher publish to
`private-user-{id}`" since Sprint 1, and `config.ts` already parses `PUSHER_*`. Neither exists:
`app.ts` mounts only the two webhooks and health checks, and every registration/payment outbox handler
in `worker.ts` only logs. The player app's registration and checkout flows (frontend Sprint 4) need
the push to resolve a partner acceptance (frontend `registration R10`) and a confirmed payment
(frontend `checkout R2`) without waiting on a poll.

Separately, local development has no way to move a registration to `CONFIRMED`: confirmation happens
only on a signature-verified `payment.captured` webhook (`payments R5`), and Razorpay cannot reach
`localhost`. The frontend is shipping a mock gateway this round, so a dev-only webhook simulator
closes the loop through the real code path.

## Scope

In:

- A Pusher Channels adapter (publish + channel auth signature).
- `POST /pusher/auth`, entitling **only** `private-user-{callerId}`.
- Worker handlers that publish one invalidation event per registration/payment state change.
- `scripts/simulate-payment.ts`, dev only.

Out:

- `private-match-{id}` / `private-event-{id}` (live scoring, Sprint 8). The auth route has an explicit
  channel allowlist so they are one entry each later.
- Pusher Beams / push notifications (notifications module, Sprint 9).
- Any migration. The one GraphQL change is additive — `InvitePartnerInput.playerId`, added during planning because player search returns profile ids.

## Design

### 1. `src/platform/pusher.ts` — the adapter

The only file that speaks Pusher (`00-platform`: vendors are one file). No SDK — `fetch` against the
Channels HTTP API with HMAC-SHA256 signing, the same choice and reasoning as `razorpay.ts`.

```ts
export interface RealtimePublisher {
  publish(channels: string[], event: string, data: Record<string, unknown>): Promise<void>;
}
export function authorizeChannel(socketId: string, channelName: string): { auth: string };
export const pusher: RealtimePublisher;   // configured, or the no-op below
export const pusherEnabled: boolean;
```

- **Publish:** `POST https://api-{cluster}.pusher.com/apps/{appId}/events` with body
  `{ name, channels, data: JSON.stringify(data) }`. Query string carries `auth_key`,
  `auth_timestamp`, `auth_version=1.0`, `body_md5`, and `auth_signature` =
  `HMAC_SHA256(secret, "POST\n/apps/{appId}/events\n" + sortedQuery)`. At most 100 channels per call
  (Pusher's limit) — callers here pass ≤ 2. Non-2xx throws, so the outbox row is marked failed and
  retried (`platform R6`).
- **Auth signature:** `auth = "{key}:" + HMAC_SHA256(secret, "{socketId}:{channelName}")`.
- **Unconfigured** (`PUSHER_APP_ID`, `PUSHER_KEY` or `PUSHER_SECRET` empty): `pusher` is a no-op that
  logs once at `info`, `pusherEnabled = false`. Local dev and tests need no Pusher account. In
  production an unconfigured Pusher logs at `warn` on boot — realtime is an optimisation, polling is
  the correct path (frontend `checkout R2`), so it does not fail the deploy.
- `socketId` is validated against `^\d+\.\d+$` and the channel name against
  `^[A-Za-z0-9_\-=@,.;]+$` before signing; invalid input throws a typed error the route maps to 400.

### 2. `POST /pusher/auth`

Mounted in `app.ts` after `express.json()` plus `express.urlencoded({ extended: false })` scoped to
this route (pusher-js posts `application/x-www-form-urlencoded`), before Apollo. Handler lives in
`src/platform/realtime/auth.ts`.

```
Authorization: Bearer <access token>
body: socket_id=123.456&channel_name=private-user-<uuid>
```

| Case | Response |
|---|---|
| Pusher unconfigured | `503 { error: "realtime_disabled" }` |
| Missing / invalid / expired token (`verifyAccessToken` throws) | `401` |
| Malformed `socket_id` or `channel_name` | `400` |
| Channel not on the allowlist | `403` |
| `private-user-{id}` with `id !== claims.sub` | `403` |
| `private-user-{claims.sub}` | `200 { auth }` |

**Entitlement is re-checked on every call** (architecture.md § Security: "issued after re-checking
entitlement"). The allowlist is a list of `{ pattern, entitled(claims, match) }` entries; this round
it has one. Token verification is `verifyAccessToken` — the same call `graphql/context.ts` makes, not
a copy — so the route accepts exactly the tokens the API accepts.

The route is rate limited with the existing `rateLimit.consume` helper, keyed by user id, 30/min — a
reconnect storm on a flaky network is the realistic abuse case.

### 3. Worker — publishing registration state

One event name, one payload shape, for every registration-affecting topic:

```
channel: private-user-{userId}        for every user on the entry
event:   registration.updated
data:    { registrationId: string, topic: string }
```

**Invalidation only.** No status, amount, QR or hold time on the wire: the client refetches
`registration(id)` over GraphQL, which is the source of truth and applies authorization. A missed or
reordered message therefore cannot put a client in a wrong state — the next fetch corrects it
(architecture.md: "Pusher is a cache-invalidation transport").

Topics that publish (existing outbox topics, existing handlers extended — their current behaviour,
such as scheduling `release-hold`, is kept and runs first):

| Topic | Why the client cares |
|---|---|
| `hold.created` | Partner accepted → captain's screen leads with the countdown (frontend `registration R10`) |
| `invite.created` | Captain's entry moved DRAFT → AWAITING_PARTNER |
| `invite.declined` | Captain must re-invite |
| `registration.confirmed` | Pending → Confirmed (frontend `checkout R2`) |
| `registration.payment_failed` | Pending → Failed |
| `registration.expired` | Hold or invite lapsed |
| `registration.cancelled` | Entry withdrawn/refunded |
| `registration.checked_in` | My PL4Y ticket state |
| `refund.processed` | Receipt now shows a refund |

`payment.captured` / `payment.failed` are **not** published: `applyCapture` / `applyFailure` call
into registration (`confirmFromPayment` etc.) in the same `applyWebhook` job, which writes the
`registration.*` row the client actually needs — publishing both doubles every refetch. If that
registration step fails, the job retries; if a capture lands on an expired hold and no
`registration.*` row is ever written, the client's poll (frontend `checkout R2`) is the path, which is
exactly the case polling exists for.

**Recipients** — a helper `registrationRecipients(registrationId)` in the worker (uses `db`, not a
module import — the worker is already the composition root): the registration's `captainUserId` plus
every `TeamMember.userId` of its team, de-duplicated. A partner who has not yet accepted is not on the
team and receives nothing, which is correct: they have no entry to refresh. A registration id that no
longer resolves publishes nothing and succeeds.

`refund.processed` carries `registrationId` possibly `null`; null publishes nothing.

**Publishing is best-effort (C1).** `createRegistrationNotifier.notify` wraps `loadEntry` and
`publisher.publish` in a try/catch: a failure is logged at `warn` with `{ topic, registrationId, err }`
and the call returns normally. The outbox row this runs inside of must never fail because Pusher is
down or misconfigured, and it is never retried — clients already poll (frontend `checkout R2`), and a
retry would pin the oldest outbox rows in place (`claimBatch` orders by `id`; `markFailed` only clears
the claim, it does not move the row to the back). `createRealtime().publish` itself still throws on a
non-2xx or network error — the adapter stays honest about what happened; the notifier is what decides
that realtime is optional. This also means a throwing publisher no longer re-enqueues `release-hold` /
`expire-invite` jobs on retry (both are idempotent regardless, but the retries themselves stop).

### 4. `scripts/simulate-payment.ts` (dev only)

```
pnpm simulate:payment <registrationId> [captured|failed]      default: captured
```

1. Refuses to run if `NODE_ENV === 'production'` or `RAZORPAY_WEBHOOK_SECRET` is empty.
2. Loads the most recent payment order for the registration (created by `createPaymentOrder`); exits
   non-zero with a readable message if there is none.
3. Builds a Razorpay-shaped webhook body — `event: "payment.captured" | "payment.failed"`, a fresh
   `evt_sim_*` event id and `pay_sim_*` payment id, `order_id`, `amount` equal to the order amount,
   `method: "upi"`.
4. Signs the exact bytes with `HMAC_SHA256(RAZORPAY_WEBHOOK_SECRET)` and POSTs to
   `http://localhost:{PORT}/webhooks/razorpay` with `x-razorpay-signature`.
5. Prints the HTTP status. The worker (`pnpm dev:worker`) must be running: it runs the `applyWebhook` job and then drains the resulting outbox rows (including the realtime publish).

It goes through `ingestWebhook` → `applyWebhook` job → `applyCapture` / `applyFailure` exactly as production does. No production
code path gains a bypass. The body shape is taken from what `applyCapture`/`applyFailure` read, not
invented; the implementation plan pins the field list against `payments/service/index.ts`.

## Error handling

- Publish failure → **best-effort**: `createRegistrationNotifier.notify` catches the error, logs it at
  `warn` with ids only (`{ topic, registrationId, err }`), and returns normally. The outbox row is
  marked processed like any other; it is never retried. A permanently failing or misconfigured Pusher
  therefore cannot stop the outbox — not for realtime topics and not for anything behind them in the
  claim order — because there is nothing left to retry. `createRealtime().publish` still throws on a
  non-2xx so the adapter itself stays honest; it is the notifier around it that decides realtime is
  optional.
- Auth route never 500s on bad input; unexpected errors go through the existing express error handler.
- Nothing about payments is logged beyond ids (`payments R15` equivalent on this side).

## Testing (vitest)

- `pusher.test.ts` — auth signature matches Pusher's documented example
  (`key=278d425bdf160c739803`, `secret=7ad3773142a6692b25b8`, `socket_id=1234.1234`,
  `channel=private-foobar` → `278d425bdf160c739803:58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4`);
  publish request URL/body/signature built correctly with a stubbed `fetch`; no-op when unconfigured.
- `src/platform/realtime/auth.test.ts` — the pure `handlePusherAuth` with fake deps covers every row
  of the response table (own channel 200; other user 403; unknown prefix 403; no/bad token 401;
  malformed socket id 400; rate limited 429; unconfigured 503). `createApp()` is not started: it
  imports the Prisma/Redis singletons and adds nothing to what the handler decides.
- Worker handler test with a fake `RealtimePublisher` — a doubles registration publishes to captain and
  partner; singles to captain only; `payment.captured` publishes nothing; missing registration publishes
  nothing and resolves.
- `simulate-payment` is exercised manually (it needs the running server); its body builder is a pure
  function with one unit test asserting its signature passes `verifyWebhookSignature` from `platform/razorpay.ts`.

## Docs to update

- `docs/modules/00-platform.md` — `pusher.ts` adapter contract, `POST /pusher/auth` entitlement table,
  no-op-when-unconfigured behaviour.
- `docs/modules/06-registration.md` and `07-payments.md` § Emits — add "realtime (`registration.updated`)"
  as a consumer on the topics above.
- `.env.example` — comment on `PUSHER_*` saying they are optional locally.
- `package.json` — `simulate:payment` script.
