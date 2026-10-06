# Realtime `private-user-{id}` Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the player app a working `private-user-{id}` Pusher channel — an authorizer route, a publish on every registration state change — plus a dev-only script that fakes a signed Razorpay webhook so local payments can reach CONFIRMED.

**Architecture:** One vendor adapter (`src/platform/pusher.ts`, `fetch` + HMAC, no SDK) exposes `publish` and `authorize`. A pure route handler (`src/platform/realtime/auth.ts`) decides entitlement and is mounted in `app.ts`. A pure notifier (`src/platform/realtime/registrationUpdates.ts`) turns outbox topics into `registration.updated` publishes and is called from the existing worker handlers. The simulator's body builder is a pure function in `scripts/`.

**Tech Stack:** Node 22, TypeScript (NodeNext ESM, `.js` import suffixes), Express 5, Prisma, vitest, zod.

**Spec:** `docs/superpowers/specs/2026-09-17-realtime-user-channel-design.md`

## Global Constraints

- `process.env` is read only in `src/platform/config.ts` (platform R1, enforced by `npm run guard`). Scripts may use `config` too.
- `src/platform/**` must not import from `src/modules/**` (00-platform).
- ESM: every relative import ends in `.js`.
- No new runtime dependency. No Pusher SDK.
- Wire contract: event name `registration.updated`, payload exactly `{ registrationId: string, topic: string }`. No status, amount, QR or hold time.
- Only `private-user-{callerUserId}` is authorizable this round.
- Unconfigured Pusher (`PUSHER_APP_ID`, `PUSHER_KEY` or `PUSHER_SECRET` empty) is a no-op publisher, and `/pusher/auth` answers `503 { error: "realtime_disabled" }`.
- `payment.captured` / `payment.failed` do **not** publish.
- Payments: log ids only.
- The only GraphQL change is additive: `InvitePartnerInput.playerId: ID` (Task 5).
- Commands: `npm run typecheck`, `npm run lint`, `npm run guard`, `npx vitest run <file>`, full gate `npm run check`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Amendment to spec § Testing:** the auth route is tested through its pure handler with fake deps instead of `createApp()` + `fetch` — `createApp` imports the Redis/Prisma singletons, and the handler is where every decision lives. Task 6 records this in the spec.

---

## File map

| File | Responsibility |
|---|---|
| `src/platform/pusher.ts` (create) | Credentials → `Realtime` (`enabled`, `publish`, `authorize`); signing helpers; config singleton |
| `src/platform/pusher.test.ts` (create) | Signature vectors, publish request shape, no-op mode |
| `src/platform/realtime/auth.ts` (create) | `handlePusherAuth` (pure decision) + `pusherAuthRoute` (Express glue) |
| `src/platform/realtime/auth.test.ts` (create) | Every row of the spec's response table |
| `src/app.ts` (modify) | Mount `POST /pusher/auth` after `express.json()` |
| `src/platform/realtime/registrationUpdates.ts` (create) | Topic list, recipient resolution, `createRegistrationNotifier`, Prisma-backed singleton |
| `src/platform/realtime/registrationUpdates.test.ts` (create) | Recipients, topics, skip rules |
| `src/worker.ts` (modify) | Call the notifier from the nine topics |
| `scripts/simulatePaymentBody.ts` (create) | Pure webhook body + signature builder |
| `scripts/simulate-payment.ts` (create) | CLI: load order, build, POST |
| `tests/simulate-payment.test.ts` (create) | Body shape + signature verifies |
| `src/modules/registration/**`, `tests/helpers/modules.ts`, `schema.graphql` (modify) | `InvitePartnerInput.playerId` |
| `package.json`, `.env.example`, `docs/**` (modify) | Script, comments, contract docs |

---

### Task 1: Pusher adapter

**Files:**
- Create: `src/platform/pusher.ts`
- Test: `src/platform/pusher.test.ts`

**Interfaces:**
- Consumes: `config`, `isProd` from `./config.js`; `logger` from `./logging/index.js`.
- Produces:
  - `interface PusherCredentials { appId: string; key: string; secret: string; cluster: string }`
  - `interface RealtimePublisher { readonly enabled: boolean; publish(channels: string[], event: string, data: Record<string, unknown>): Promise<void> }`
  - `interface Realtime extends RealtimePublisher { authorize(socketId: string, channelName: string): { auth: string } }`
  - `class RealtimeInputError extends Error`
  - `function channelAuthSignature(creds: Pick<PusherCredentials, 'key' | 'secret'>, socketId: string, channelName: string): string`
  - `function signEventsUrl(creds: PusherCredentials, body: string, timestampSeconds: number): string`
  - `function createRealtime(creds: PusherCredentials | null, deps?: { fetch?: typeof fetch; now?: () => number }): Realtime`
  - `const realtime: Realtime` (singleton from config)

- [ ] **Step 1: Write the failing test**

`src/platform/pusher.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeInputError,
  channelAuthSignature,
  createRealtime,
  signEventsUrl,
} from './pusher.js';

// Pusher's own documented examples (Channels "Authenticating users" and the
// HTTP API reference). If these drift, every client auth fails.
const DOC = { appId: '3', key: '278d425bdf160c739803', secret: '7ad3773142a6692b25b8', cluster: 'mt1' };

describe('pusher adapter', () => {
  it('channel auth signature matches the documented example', () => {
    expect(channelAuthSignature(DOC, '1234.1234', 'private-foobar')).toBe(
      '278d425bdf160c739803:58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4',
    );
  });

  it('rejects a malformed socket id or channel name', () => {
    expect(() => channelAuthSignature(DOC, 'abc', 'private-foobar')).toThrow(RealtimeInputError);
    expect(() => channelAuthSignature(DOC, '1.2', 'private foo')).toThrow(RealtimeInputError);
  });

  it('events URL signature matches the documented HTTP API example', () => {
    const body = '{"name":"foo","channels":["project-3"],"data":"{\\"some\\":\\"data\\"}"}';
    const url = signEventsUrl(DOC, body, 1353088179);
    expect(url).toBe(
      'https://api-mt1.pusher.com/apps/3/events' +
        '?auth_key=278d425bdf160c739803&auth_timestamp=1353088179&auth_version=1.0' +
        '&body_md5=ec365a775a4cd0599faeb73354201b6f' +
        '&auth_signature=da454824c97ba181a32ccc17a72625ba02771f50b50e1e7430e47a1f3f457e6c',
    );
  });

  it('publish POSTs the event with data JSON-encoded as a string', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const rt = createRealtime(DOC, { fetch: fetchMock as unknown as typeof fetch, now: () => 1353088179_000 });
    await rt.publish(['private-user-u1'], 'registration.updated', { registrationId: 'r1', topic: 't' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://api-mt1.pusher.com/apps/3/events?auth_key=278d425bdf160c739803');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'registration.updated',
      channels: ['private-user-u1'],
      data: JSON.stringify({ registrationId: 'r1', topic: 't' }),
    });
  });

  it('publish throws on a non-2xx so the outbox row is retried', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    const rt = createRealtime(DOC, { fetch: fetchMock as unknown as typeof fetch });
    await expect(rt.publish(['private-user-u1'], 'e', {})).rejects.toThrow(/500/);
  });

  it('publish with no channels sends nothing', async () => {
    const fetchMock = vi.fn();
    const rt = createRealtime(DOC, { fetch: fetchMock as unknown as typeof fetch });
    await rt.publish([], 'e', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unconfigured: disabled, publish is a no-op, authorize throws', async () => {
    const fetchMock = vi.fn();
    const rt = createRealtime(null, { fetch: fetchMock as unknown as typeof fetch });
    expect(rt.enabled).toBe(false);
    await rt.publish(['private-user-u1'], 'e', {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => rt.authorize('1.1', 'private-user-u1')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/pusher.test.ts`
Expected: FAIL — cannot resolve `./pusher.js`.

- [ ] **Step 3: Write the implementation**

`src/platform/pusher.ts`:

```ts
/**
 * Pusher Channels adapter (00-platform). The ONLY place Pusher is spoken to and
 * the only place its secret is used.
 *
 * `fetch` against the HTTP API rather than the SDK, for the same reason as
 * razorpay.ts: two trivial signed calls do not justify a dependency.
 *
 * Pusher is a cache-invalidation transport, never a source of truth
 * (architecture.md). So an unconfigured Pusher is a no-op, not a boot failure:
 * clients poll, and polling is the correct path.
 */
import { createHash, createHmac } from 'node:crypto';
import { config, isProd } from './config.js';
import { logger } from './logging/index.js';

export interface PusherCredentials {
  appId: string;
  key: string;
  secret: string;
  cluster: string;
}

export interface RealtimePublisher {
  readonly enabled: boolean;
  publish(channels: string[], event: string, data: Record<string, unknown>): Promise<void>;
}

export interface Realtime extends RealtimePublisher {
  authorize(socketId: string, channelName: string): { auth: string };
}

/** Bad client input to the authorizer. The route maps it to a 400. */
export class RealtimeInputError extends Error {}

const SOCKET_ID = /^\d+\.\d+$/;
const CHANNEL_NAME = /^[A-Za-z0-9_\-=@,.;]{1,164}$/;
/** Pusher's per-call channel limit. */
const MAX_CHANNELS = 100;

export function channelAuthSignature(
  creds: Pick<PusherCredentials, 'key' | 'secret'>,
  socketId: string,
  channelName: string,
): string {
  if (!SOCKET_ID.test(socketId)) throw new RealtimeInputError('invalid socket_id');
  if (!CHANNEL_NAME.test(channelName)) throw new RealtimeInputError('invalid channel_name');
  const sig = createHmac('sha256', creds.secret).update(`${socketId}:${channelName}`).digest('hex');
  return `${creds.key}:${sig}`;
}

export function signEventsUrl(creds: PusherCredentials, body: string, timestampSeconds: number): string {
  const path = `/apps/${creds.appId}/events`;
  const params: [string, string][] = [
    ['auth_key', creds.key],
    ['auth_timestamp', String(timestampSeconds)],
    ['auth_version', '1.0'],
    ['body_md5', createHash('md5').update(body).digest('hex')],
  ];
  const query = params
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const signature = createHmac('sha256', creds.secret).update(`POST\n${path}\n${query}`).digest('hex');
  return `https://api-${creds.cluster}.pusher.com${path}?${query}&auth_signature=${signature}`;
}

export function createRealtime(
  creds: PusherCredentials | null,
  deps: { fetch?: typeof fetch; now?: () => number } = {},
): Realtime {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  if (!creds) {
    let logged = false;
    return {
      enabled: false,
      async publish() {
        if (!logged) {
          logged = true;
          logger.info('pusher not configured — realtime publishes are skipped');
        }
      },
      authorize() {
        throw new Error('realtime disabled');
      },
    };
  }

  return {
    enabled: true,
    async publish(channels, event, data) {
      if (channels.length === 0) return;
      if (channels.length > MAX_CHANNELS) {
        throw new Error(`pusher publish: ${channels.length} channels exceeds ${MAX_CHANNELS}`);
      }
      const body = JSON.stringify({ name: event, channels, data: JSON.stringify(data) });
      const url = signEventsUrl(creds, body, Math.floor(now() / 1000));
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(`pusher publish failed: HTTP ${res.status}`);
      }
    },
    authorize(socketId, channelName) {
      return { auth: channelAuthSignature(creds, socketId, channelName) };
    },
  };
}

function credentialsFromConfig(): PusherCredentials | null {
  if (!config.PUSHER_APP_ID || !config.PUSHER_KEY || !config.PUSHER_SECRET) return null;
  return {
    appId: config.PUSHER_APP_ID,
    key: config.PUSHER_KEY,
    secret: config.PUSHER_SECRET,
    cluster: config.PUSHER_CLUSTER,
  };
}

const creds = credentialsFromConfig();
if (!creds && isProd) {
  logger.warn('PUSHER_* not set in production — clients will fall back to polling');
}

export const realtime: Realtime = createRealtime(creds);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/pusher.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

```bash
git add src/platform/pusher.ts src/platform/pusher.test.ts
git commit -m "feat(platform): add Pusher Channels adapter (publish + channel auth)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `POST /pusher/auth`

**Files:**
- Create: `src/platform/realtime/auth.ts`
- Test: `src/platform/realtime/auth.test.ts`
- Modify: `src/app.ts` (imports; mount after `app.use(express.json(...))`)

**Interfaces:**
- Consumes: `Realtime`, `RealtimeInputError`, `realtime` from `../pusher.js`; `verifyAccessToken`, `AccessClaims` from `../auth/tokens.js`; `consume`, `LimitResult`, `Window` from `../rateLimit.js`.
- Produces:
  - `interface PusherAuthInput { authorization: string | undefined; socketId: unknown; channelName: unknown }`
  - `interface PusherAuthDeps { realtime: Pick<Realtime, 'enabled' | 'authorize'>; verify: (token: string) => Promise<{ sub: string }>; limit: (userId: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }> }`
  - `function handlePusherAuth(input: PusherAuthInput, deps: PusherAuthDeps): Promise<{ status: number; body: Record<string, unknown> }>`
  - `function pusherAuthRoute(req: express.Request, res: express.Response): Promise<void>`

- [ ] **Step 1: Write the failing test**

`src/platform/realtime/auth.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { RealtimeInputError } from '../pusher.js';
import { handlePusherAuth, type PusherAuthDeps } from './auth.js';

const USER = '0b6f2a4e-1111-4222-8333-944455556666';
const OTHER = '9c1d2e3f-aaaa-4bbb-8ccc-ddddeeeeffff';

function deps(overrides: Partial<PusherAuthDeps> = {}): PusherAuthDeps {
  return {
    realtime: {
      enabled: true,
      authorize: vi.fn((socketId: string, channel: string) => {
        if (!/^\d+\.\d+$/.test(socketId)) throw new RealtimeInputError('invalid socket_id');
        return { auth: `key:${socketId}:${channel}` };
      }),
    },
    verify: vi.fn(async (token: string) => {
      if (token !== 'good') throw new Error('bad token');
      return { sub: USER };
    }),
    limit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    ...overrides,
  };
}

const input = (channelName: unknown, extra: { authorization?: string; socketId?: unknown } = {}) => ({
  authorization: 'authorization' in extra ? extra.authorization : 'Bearer good',
  socketId: 'socketId' in extra ? extra.socketId : '123.456',
  channelName,
});

describe('POST /pusher/auth', () => {
  it('authorizes the caller’s own private-user channel', async () => {
    const res = await handlePusherAuth(input(`private-user-${USER}`), deps());
    expect(res).toEqual({ status: 200, body: { auth: `key:123.456:private-user-${USER}` } });
  });

  it('403 for another user’s channel — entitlement, not just authentication', async () => {
    const d = deps();
    const res = await handlePusherAuth(input(`private-user-${OTHER}`), d);
    expect(res.status).toBe(403);
    expect(d.realtime.authorize).not.toHaveBeenCalled();
  });

  it('403 for a channel not on the allowlist', async () => {
    expect((await handlePusherAuth(input('private-match-abc'), deps())).status).toBe(403);
    expect((await handlePusherAuth(input(`presence-user-${USER}`), deps())).status).toBe(403);
  });

  it('401 with no token or an invalid token', async () => {
    expect((await handlePusherAuth(input(`private-user-${USER}`, { authorization: undefined }), deps())).status).toBe(401);
    expect((await handlePusherAuth(input(`private-user-${USER}`, { authorization: 'Bearer bad' }), deps())).status).toBe(401);
    expect((await handlePusherAuth(input(`private-user-${USER}`, { authorization: 'Basic good' }), deps())).status).toBe(401);
  });

  it('400 for a malformed socket id or a missing channel', async () => {
    expect((await handlePusherAuth(input(`private-user-${USER}`, { socketId: 'nope' }), deps())).status).toBe(400);
    expect((await handlePusherAuth(input(undefined), deps())).status).toBe(400);
  });

  it('429 when the caller exceeds the reconnect budget', async () => {
    const d = deps({ limit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 12 })) });
    const res = await handlePusherAuth(input(`private-user-${USER}`), d);
    expect(res).toEqual({ status: 429, body: { error: 'rate_limited', retryAfterSeconds: 12 } });
  });

  it('503 when Pusher is not configured, before touching the token', async () => {
    const d = deps({ realtime: { enabled: false, authorize: vi.fn() } });
    const res = await handlePusherAuth(input(`private-user-${USER}`), d);
    expect(res).toEqual({ status: 503, body: { error: 'realtime_disabled' } });
    expect(d.verify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/realtime/auth.test.ts`
Expected: FAIL — cannot resolve `./auth.js`.

- [ ] **Step 3: Write the implementation**

`src/platform/realtime/auth.ts`:

```ts
/**
 * POST /pusher/auth — the channel authorizer (architecture.md §2, the closed
 * route list).
 *
 * Pusher hands the client a socket_id; we decide what it may subscribe to, and
 * re-check that on every call (architecture.md § Security). The decision is a
 * pure function so every branch is testable without Redis or Express.
 */
import express from 'express';
import { verifyAccessToken } from '../auth/tokens.js';
import { logger } from '../logging/index.js';
import { consume } from '../rateLimit.js';
import { RealtimeInputError, realtime, type Realtime } from '../pusher.js';

export interface PusherAuthInput {
  authorization: string | undefined;
  socketId: unknown;
  channelName: unknown;
}

export interface PusherAuthDeps {
  realtime: Pick<Realtime, 'enabled' | 'authorize'>;
  verify: (token: string) => Promise<{ sub: string }>;
  limit: (userId: string) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

interface ChannelRule {
  pattern: RegExp;
  entitled: (userId: string, match: RegExpExecArray) => boolean;
}

/**
 * The allowlist. private-match-{id} and private-event-{id} join this list with
 * live scoring (Sprint 8); anything not matched here is refused.
 */
const CHANNELS: ChannelRule[] = [
  {
    pattern: /^private-user-([0-9a-f-]{36})$/,
    entitled: (userId, match) => match[1] === userId,
  },
];

type Result = { status: number; body: Record<string, unknown> };

export async function handlePusherAuth(input: PusherAuthInput, deps: PusherAuthDeps): Promise<Result> {
  if (!deps.realtime.enabled) return { status: 503, body: { error: 'realtime_disabled' } };

  const header = input.authorization ?? '';
  if (!header.startsWith('Bearer ')) return { status: 401, body: { error: 'unauthenticated' } };
  let userId: string;
  try {
    userId = (await deps.verify(header.slice(7))).sub;
  } catch {
    return { status: 401, body: { error: 'unauthenticated' } };
  }

  if (typeof input.socketId !== 'string' || typeof input.channelName !== 'string') {
    return { status: 400, body: { error: 'bad_request' } };
  }

  const limited = await deps.limit(userId);
  if (!limited.allowed) {
    return { status: 429, body: { error: 'rate_limited', retryAfterSeconds: limited.retryAfterSeconds } };
  }

  const channelName = input.channelName;
  const allowed = CHANNELS.some((rule) => {
    const match = rule.pattern.exec(channelName);
    return match !== null && rule.entitled(userId, match);
  });
  if (!allowed) return { status: 403, body: { error: 'forbidden' } };

  try {
    return { status: 200, body: deps.realtime.authorize(input.socketId, channelName) };
  } catch (err) {
    if (err instanceof RealtimeInputError) return { status: 400, body: { error: 'bad_request' } };
    throw err;
  }
}

/** 30 authorizations a minute per user — a reconnect storm, not normal use. */
const WINDOW = { seconds: 60, max: 30 };

const liveDeps: PusherAuthDeps = {
  realtime,
  verify: verifyAccessToken,
  limit: (userId) => consume(`pusher-auth:${userId}`, WINDOW),
};

export async function pusherAuthRoute(req: express.Request, res: express.Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = await handlePusherAuth(
    { authorization: req.get('authorization'), socketId: body['socket_id'], channelName: body['channel_name'] },
    liveDeps,
  );
  if (result.status === 403) logger.warn({ channel: body['channel_name'] }, 'pusher auth refused');
  res.status(result.status).json(result.body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/realtime/auth.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mount the route in `src/app.ts`**

Add the import next to the webhook imports:

```ts
import { pusherAuthRoute } from './platform/realtime/auth.js';
```

Immediately after `app.use(express.json({ limit: '256kb' }));` add:

```ts
  // ── Pusher channel authorizer ────────────────────────────────────────────
  // pusher-js posts form-encoded socket_id/channel_name. Entitlement is
  // re-checked on every call; see platform/realtime/auth.ts.
  app.post(
    '/pusher/auth',
    express.urlencoded({ extended: false, limit: '4kb' }),
    (req, res, next) => {
      pusherAuthRoute(req, res).catch(next);
    },
  );
```

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run guard`
Expected: clean.

```bash
git add src/platform/realtime/auth.ts src/platform/realtime/auth.test.ts src/app.ts
git commit -m "feat(platform): add POST /pusher/auth for private-user channels

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Publish `registration.updated` from the worker

**Files:**
- Create: `src/platform/realtime/registrationUpdates.ts`
- Test: `src/platform/realtime/registrationUpdates.test.ts`
- Modify: `src/worker.ts` — the handlers for `hold.created`, `invite.created`, `invite.declined`, `registration.confirmed`, `registration.expired`, `registration.payment_failed`, `registration.cancelled`, `registration.checked_in`, `refund.processed`

**Interfaces:**
- Consumes: `RealtimePublisher`, `realtime` from `../pusher.js`; `db` from `../db.js`.
- Produces:
  - `const REGISTRATION_UPDATE_TOPICS: readonly string[]`
  - `interface RegistrationEntry { captainUserId: string; team: { members: { userId: string }[] } | null }`
  - `function recipientsOf(entry: RegistrationEntry): string[]`
  - `function createRegistrationNotifier(deps: { publisher: RealtimePublisher; loadEntry: (registrationId: string) => Promise<RegistrationEntry | null> }): { notify(topic: string, payload: Record<string, unknown>): Promise<void> }`
  - `const registrationNotifier` (singleton wired to `realtime` + Prisma)

- [ ] **Step 1: Write the failing test**

`src/platform/realtime/registrationUpdates.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { RealtimePublisher } from '../pusher.js';
import {
  REGISTRATION_UPDATE_TOPICS,
  createRegistrationNotifier,
  recipientsOf,
  type RegistrationEntry,
} from './registrationUpdates.js';

function fakePublisher() {
  const publish = vi.fn(async () => {});
  const publisher: RealtimePublisher = { enabled: true, publish };
  return { publisher, publish };
}

const doubles: RegistrationEntry = {
  captainUserId: 'captain',
  team: { members: [{ userId: 'captain' }, { userId: 'partner' }] },
};
const singles: RegistrationEntry = { captainUserId: 'solo', team: null };

describe('registration realtime notifier', () => {
  it('recipients: captain plus every team member, de-duplicated', () => {
    expect(recipientsOf(doubles)).toEqual(['captain', 'partner']);
    expect(recipientsOf(singles)).toEqual(['solo']);
  });

  it('publishes an invalidation to each entrant’s private-user channel', async () => {
    const { publisher, publish } = fakePublisher();
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => doubles });
    await notifier.notify('registration.confirmed', { registrationId: 'r1', paymentId: 'p1' });
    expect(publish).toHaveBeenCalledWith(
      ['private-user-captain', 'private-user-partner'],
      'registration.updated',
      { registrationId: 'r1', topic: 'registration.confirmed' },
    );
  });

  it('carries no status, money or QR — invalidation only', async () => {
    const { publisher, publish } = fakePublisher();
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => singles });
    await notifier.notify('hold.created', {
      holdId: 'h', registrationId: 'r2', eventCategoryId: 'c', expiresAt: '2026-01-01T00:00:00Z',
    });
    const data = (publish.mock.calls[0] as unknown[])[2];
    expect(Object.keys(data as object).sort()).toEqual(['registrationId', 'topic']);
  });

  it('payment.captured and payment.failed publish nothing (registration.* follows)', async () => {
    const { publisher, publish } = fakePublisher();
    const loadEntry = vi.fn(async () => singles);
    const notifier = createRegistrationNotifier({ publisher, loadEntry });
    await notifier.notify('payment.captured', { registrationId: 'r3' });
    await notifier.notify('payment.failed', { registrationId: 'r3' });
    expect(publish).not.toHaveBeenCalled();
    expect(loadEntry).not.toHaveBeenCalled();
    expect(REGISTRATION_UPDATE_TOPICS).not.toContain('payment.captured');
  });

  it('a missing or null registration id, or an unknown registration, publishes nothing', async () => {
    const { publisher, publish } = fakePublisher();
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => null });
    await notifier.notify('refund.processed', { refundId: 'x', registrationId: null });
    await notifier.notify('invite.declined', { inviteId: 'i' });
    await notifier.notify('registration.expired', { registrationId: 'gone' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('a publish failure propagates so the outbox row is retried', async () => {
    const publisher: RealtimePublisher = {
      enabled: true,
      publish: vi.fn(async () => {
        throw new Error('HTTP 500');
      }),
    };
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => singles });
    await expect(notifier.notify('registration.cancelled', { registrationId: 'r4' })).rejects.toThrow('HTTP 500');
  });

  it('covers exactly the nine topics in the spec', () => {
    expect([...REGISTRATION_UPDATE_TOPICS].sort()).toEqual([
      'hold.created',
      'invite.created',
      'invite.declined',
      'refund.processed',
      'registration.cancelled',
      'registration.checked_in',
      'registration.confirmed',
      'registration.expired',
      'registration.payment_failed',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/realtime/registrationUpdates.test.ts`
Expected: FAIL — cannot resolve `./registrationUpdates.js`.

- [ ] **Step 3: Write the implementation**

`src/platform/realtime/registrationUpdates.ts`:

```ts
/**
 * Registration state → `registration.updated` on every entrant's
 * private-user-{id} channel.
 *
 * Invalidation only: the payload names the registration and the topic, and the
 * client refetches `registration(id)` over GraphQL. A missed or reordered
 * message cannot put a client in a wrong state (architecture.md: Pusher is a
 * cache-invalidation transport).
 *
 * Lives in platform/ and reads tables through `db` directly rather than calling
 * the registration module, because platform/ may not import modules/.
 */
import { db } from '../db.js';
import { realtime, type RealtimePublisher } from '../pusher.js';

export const REGISTRATION_UPDATE_TOPICS: readonly string[] = [
  'hold.created',
  'invite.created',
  'invite.declined',
  'registration.confirmed',
  'registration.payment_failed',
  'registration.expired',
  'registration.cancelled',
  'registration.checked_in',
  'refund.processed',
];

export const REGISTRATION_UPDATED_EVENT = 'registration.updated';

export interface RegistrationEntry {
  captainUserId: string;
  team: { members: { userId: string }[] } | null;
}

export function recipientsOf(entry: RegistrationEntry): string[] {
  const ids = [entry.captainUserId, ...(entry.team?.members.map((m) => m.userId) ?? [])];
  return [...new Set(ids)];
}

export function createRegistrationNotifier(deps: {
  publisher: RealtimePublisher;
  loadEntry: (registrationId: string) => Promise<RegistrationEntry | null>;
}) {
  return {
    async notify(topic: string, payload: Record<string, unknown>): Promise<void> {
      if (!REGISTRATION_UPDATE_TOPICS.includes(topic)) return;
      const registrationId = payload['registrationId'];
      if (typeof registrationId !== 'string' || registrationId === '') return;

      const entry = await deps.loadEntry(registrationId);
      if (!entry) return;

      await deps.publisher.publish(
        recipientsOf(entry).map((userId) => `private-user-${userId}`),
        REGISTRATION_UPDATED_EVENT,
        { registrationId, topic },
      );
    },
  };
}

export const registrationNotifier = createRegistrationNotifier({
  publisher: realtime,
  loadEntry: (registrationId) =>
    db.registration.findUnique({
      where: { id: registrationId },
      select: { captainUserId: true, team: { select: { members: { select: { userId: true } } } } },
    }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/realtime/registrationUpdates.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire into `src/worker.ts`**

Add the import after the `outbox.js` import:

```ts
import { registrationNotifier } from './platform/realtime/registrationUpdates.js';
```

Change each of the nine handlers so the existing work runs first and the notify runs last. Exactly:

```ts
  'hold.created': async (payload) => {
    const holdId = String(payload['holdId'] ?? '');
    const expiresAt = new Date(String(payload['expiresAt'] ?? ''));
    if (holdId && !Number.isNaN(expiresAt.getTime())) {
      await queue(QUEUES.registration).add(
        'release-hold',
        { holdId },
        {
          ...defaultJobOptions,
          delay: Math.max(expiresAt.getTime() - Date.now(), 0),
          jobId: `release-hold:${holdId}`,
        },
      );
    }
    // registration R10 over in the app — the captain's screen leads with the countdown.
    await registrationNotifier.notify('hold.created', payload);
  },

  'invite.created': async (payload) => {
    const inviteId = String(payload['inviteId'] ?? '');
    const expiresAt = new Date(String(payload['expiresAt'] ?? ''));
    if (inviteId && !Number.isNaN(expiresAt.getTime())) {
      await queue(QUEUES.registration).add(
        'expire-invite',
        { inviteId },
        {
          ...defaultJobOptions,
          delay: Math.max(expiresAt.getTime() - Date.now(), 0),
          jobId: `expire-invite:${inviteId}`,
        },
      );
    }
    await registrationNotifier.notify('invite.created', payload);
  },

  'invite.declined': async (payload) => {
    logger.info({ payload }, 'outbox: invite.declined');
    await registrationNotifier.notify('invite.declined', payload);
  },

  'registration.confirmed': async (payload) => {
    logger.info({ payload }, 'outbox: registration.confirmed');
    await registrationNotifier.notify('registration.confirmed', payload);
  },

  'registration.expired': async (payload) => {
    logger.info({ payload }, 'outbox: registration.expired');
    await registrationNotifier.notify('registration.expired', payload);
  },

  'registration.payment_failed': async (payload) => {
    logger.info({ payload }, 'outbox: registration.payment_failed');
    await registrationNotifier.notify('registration.payment_failed', payload);
  },

  'registration.cancelled': async (payload) => {
    logger.info({ payload }, 'outbox: registration.cancelled');
    await registrationNotifier.notify('registration.cancelled', payload);
  },

  'registration.checked_in': async (payload) => {
    logger.info({ payload }, 'outbox: registration.checked_in');
    await registrationNotifier.notify('registration.checked_in', payload);
  },
```

and

```ts
  'refund.processed': async (payload) => {
    logger.info({ payload }, 'outbox: refund.processed');
    await registrationNotifier.notify('refund.processed', payload);
  },
```

Note the behaviour change in `hold.created` / `invite.created`: the old early `return` on a malformed payload is now an `if` block, so a malformed hold still notifies (harmless — the notifier itself skips a missing `registrationId`).

- [ ] **Step 6: Confirm every published topic carries `registrationId`**

Run: `grep -n "topic: 'invite.created'\|topic: 'invite.declined'\|topic: 'registration\." -A7 src/modules/registration/service/index.ts | grep registrationId`
Expected: one `registrationId` line per topic occurrence (verified while writing this plan: all present;
`refund.processed` carries `order?.registrationId ?? null`, which the notifier skips when null).

- [ ] **Step 7: Full gate and commit**

Run: `npm run check`
Expected: typecheck, lint, guard and all tests pass (DB suites need Docker running).

```bash
git add src/platform/realtime/registrationUpdates.ts src/platform/realtime/registrationUpdates.test.ts src/worker.ts
git commit -m "feat(realtime): publish registration.updated to private-user channels from the outbox

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `simulate-payment` dev script

**Files:**
- Create: `scripts/simulatePaymentBody.ts`
- Create: `scripts/simulate-payment.ts`
- Test: `tests/simulate-payment.test.ts`
- Modify: `package.json` (`scripts`)

**Interfaces:**
- Consumes: `verifyWebhookSignature` from `src/platform/razorpay.ts`; `config`, `isProd` from `src/platform/config.ts`; `db`, `disconnectDb` from `src/platform/db.ts`.
- Produces: `function buildSimulatedWebhook(input: { kind: 'captured' | 'failed'; razorpayOrderId: string; amountPaise: number; secret: string; nowSeconds: number; nonce: string }): { body: string; signature: string }`

- [ ] **Step 1: Write the failing test**

`tests/simulate-payment.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildSimulatedWebhook } from '../scripts/simulatePaymentBody.js';
import { verifyWebhookSignature } from '../src/platform/razorpay.js';

const base = { razorpayOrderId: 'order_ABC', amountPaise: 59_000, secret: 'whsec', nowSeconds: 1_800_000_000, nonce: 'n1' };

describe('simulate-payment body', () => {
  it('builds a captured envelope applyCapture can read, signed with the webhook secret', () => {
    const { body, signature } = buildSimulatedWebhook({ ...base, kind: 'captured' });
    expect(verifyWebhookSignature(Buffer.from(body), signature, 'whsec')).toBe(true);

    const parsed = JSON.parse(body);
    expect(parsed.id).toBe('evt_sim_n1');
    expect(parsed.event).toBe('payment.captured');
    expect(parsed.payload.payment.entity).toEqual({
      id: 'pay_sim_n1',
      order_id: 'order_ABC',
      amount: 59_000,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      captured: true,
      created_at: 1_800_000_000,
    });
  });

  it('builds a failed envelope with a failure reason', () => {
    const { body } = buildSimulatedWebhook({ ...base, kind: 'failed' });
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe('payment.failed');
    expect(parsed.payload.payment.entity.status).toBe('failed');
    expect(parsed.payload.payment.entity.captured).toBe(false);
    expect(parsed.payload.payment.entity.error_description).toBe('Simulated failure');
  });

  it('a different secret does not verify', () => {
    const { body, signature } = buildSimulatedWebhook({ ...base, kind: 'captured' });
    expect(verifyWebhookSignature(Buffer.from(body), signature, 'other')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/simulate-payment.test.ts`
Expected: FAIL — cannot resolve `../scripts/simulatePaymentBody.js`.

- [ ] **Step 3: Write the body builder**

`scripts/simulatePaymentBody.ts`:

```ts
/**
 * The Razorpay webhook envelope `payments.applyWebhook` reads, built for local
 * development only. Fields mirror what applyCapture / applyFailure consume
 * (src/modules/payments/service/index.ts) and what tests/helpers FakeRazorpay
 * produces — nothing more.
 */
import { createHmac } from 'node:crypto';

export function buildSimulatedWebhook(input: {
  kind: 'captured' | 'failed';
  razorpayOrderId: string;
  amountPaise: number;
  secret: string;
  nowSeconds: number;
  nonce: string;
}): { body: string; signature: string } {
  const captured = input.kind === 'captured';
  const entity = {
    id: `pay_sim_${input.nonce}`,
    order_id: input.razorpayOrderId,
    amount: input.amountPaise,
    currency: 'INR',
    status: captured ? 'captured' : 'failed',
    method: 'upi',
    captured,
    created_at: input.nowSeconds,
    ...(captured ? {} : { error_description: 'Simulated failure', error_reason: 'simulated' }),
  };
  const body = JSON.stringify({
    id: `evt_sim_${input.nonce}`,
    event: captured ? 'payment.captured' : 'payment.failed',
    payload: { payment: { entity } },
  });
  const signature = createHmac('sha256', input.secret).update(body).digest('hex');
  return { body, signature };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/simulate-payment.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the CLI**

`scripts/simulate-payment.ts`:

```ts
/**
 * `npm run simulate:payment -- <registrationId> [captured|failed]`
 *
 * Local development only. Razorpay cannot reach localhost, and a registration
 * confirms ONLY on a signature-verified webhook (payments R5). This sends one
 * through the real route, so ingest → applyWebhook → registration → outbox →
 * realtime all run exactly as in production. The worker must be running.
 */
import { randomBytes } from 'node:crypto';
import { config, isProd } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { buildSimulatedWebhook } from './simulatePaymentBody.js';

async function main(): Promise<number> {
  if (isProd) {
    console.error('simulate-payment refuses to run with NODE_ENV=production.');
    return 1;
  }
  if (!config.RAZORPAY_WEBHOOK_SECRET) {
    console.error('RAZORPAY_WEBHOOK_SECRET is empty — the webhook route would refuse the call.');
    return 1;
  }

  const [registrationId, kindArg = 'captured'] = process.argv.slice(2);
  if (!registrationId || (kindArg !== 'captured' && kindArg !== 'failed')) {
    console.error('usage: npm run simulate:payment -- <registrationId> [captured|failed]');
    return 1;
  }

  const order = await db.paymentOrder.findFirst({
    where: { registrationId },
    orderBy: { createdAt: 'desc' },
  });
  if (!order) {
    console.error(`No payment order for registration ${registrationId}. Tap Pay in the app first.`);
    return 1;
  }

  const { body, signature } = buildSimulatedWebhook({
    kind: kindArg,
    razorpayOrderId: order.razorpayOrderId,
    amountPaise: Number(order.amountPaise),
    secret: config.RAZORPAY_WEBHOOK_SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
    nonce: randomBytes(6).toString('hex'),
  });

  const res = await fetch(`http://localhost:${config.PORT}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    body,
  });
  console.log(`POST /webhooks/razorpay → ${res.status} ${await res.text()}`);
  console.log(`order ${order.razorpayOrderId} · ${kindArg}. The worker applies it on its next job.`);
  return res.ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await disconnectDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await disconnectDb();
    process.exit(1);
  });
```

- [ ] **Step 6: Add the npm script**

In `package.json` `scripts`, after `"seed:dev"`:

```json
    "simulate:payment": "tsx --env-file-if-exists=.env scripts/simulate-payment.ts",
```

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run guard`
Expected: clean.

```bash
git add scripts/simulatePaymentBody.ts scripts/simulate-payment.ts tests/simulate-payment.test.ts package.json
git commit -m "chore(dev): add simulate:payment to send a signed Razorpay webhook locally

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `invitePartner` accepts a player profile id

Player search (`players(query:)`) returns `PlayerProfile.id`; `invitePartner` only took `playerUserId`
or `email`, so the app's search-first invite (frontend `registration R7`) could not produce a valid
call. Additive fix, decided in brainstorming: `InvitePartnerInput.playerId`, resolved to the owning
user on the server. User ids stay off searchable profiles.

**Files:**
- Modify: `src/modules/registration/service/index.ts` (`ProfilePort`, `invitePartner` input + resolution)
- Modify: `src/modules/registration/index.ts` (profile port wiring)
- Modify: `tests/helpers/modules.ts` (registration's profile port wiring, ~line 491)
- Modify: `src/modules/registration/schema/index.ts` (`InvitePartnerInput`, resolver)
- Modify: `schema.graphql` (regenerated)
- Test: `tests/registration.test.ts`

**Interfaces:**
- Consumes: `profile.findById(playerId): Promise<PlayerProfile | null>` (profile service, already exported; `PlayerProfile.userId: string`).
- Produces:
  - `ProfilePort.userIdForPlayer(playerId: string): Promise<string | null>`
  - `registration.invitePartner(actor, { registrationId; playerId?: string | null; playerUserId?: string | null; email?: string | null })`
  - GraphQL `input InvitePartnerInput { registrationId: ID!, playerId: ID, playerUserId: ID, email: String }`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('registration', ...)` in `tests/registration.test.ts`, after the two `R2:` tests:

```ts
  it('R12: a partner can be invited by player profile id from search', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerId: partner.playerId,
    });

    expect(invite.invitedUserId).toBe(partner.userId);
    expect(invite.invitedEmail).toBe(partner.email);
    expect((await registration.byId(reg.id)).status).toBe('awaiting_partner');
  });

  it('R12: an unknown player id is refused, and inviting your own profile is CANNOT_INVITE_SELF', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });

    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, { registrationId: reg.id, playerId: newId() }),
      ),
    ).not.toBe('NO_ERROR');
    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, { registrationId: reg.id, playerId: captain.playerId }),
      ),
    ).toBe(RegistrationCode.CANNOT_INVITE_SELF);
  });
```

(If `Invite` — the return type of `invitePartner` — names the fields differently than
`invitedUserId` / `invitedEmail`, check with `grep -n "export interface Invite" -A10 src/modules/registration/service/index.ts`
and use its names.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/registration.test.ts -t "R12: a partner can be invited by player profile id"`
Expected: FAIL — `invitedUserId` is null (the unknown `playerId` property is ignored at runtime) or a type error.

- [ ] **Step 3: Extend the port and the service**

In `src/modules/registration/service/index.ts`, add to `ProfilePort`:

```ts
  /** R12 — search hands the app a profile id; invites are addressed to users. */
  userIdForPlayer(playerId: string): Promise<string | null>;
```

Change the `invitePartner` input type to:

```ts
    input: {
      registrationId: string;
      email?: string | null;
      playerUserId?: string | null;
      playerId?: string | null;
    },
```

Replace

```ts
    let invitedUserId: string | null = input.playerUserId ?? null;
```

with

```ts
    let invitedUserId: string | null = input.playerUserId ?? null;
    if (!invitedUserId && input.playerId) {
      invitedUserId = await profile.userIdForPlayer(input.playerId);
      if (!invitedUserId) throw notFound();
    }
```

Use whatever name the service already uses for the `ProfilePort` dependency: check with
`grep -n "assertHasSport(" src/modules/registration/service/index.ts | head -2` and match it
(for example `deps.profile.userIdForPlayer` if calls there read `deps.profile.assertHasSport`).

- [ ] **Step 4: Wire the port in both composition roots**

In `src/modules/registration/index.ts`, inside `profile: { ... }` after `findByUserId`:

```ts
    userIdForPlayer: async (playerId) => (await profile.findById(playerId))?.userId ?? null,
```

In `tests/helpers/modules.ts`, inside the registration service's `profile: { ... }` after `findByUserId`:

```ts
      userIdForPlayer: async (playerId: string) => (await profile.findById(playerId))?.userId ?? null,
```

- [ ] **Step 5: Expose it in GraphQL**

In `src/modules/registration/schema/index.ts`, replace `InvitePartnerInput` with:

```ts
const InvitePartnerInput = builder.inputType('InvitePartnerInput', {
  description:
    'registration R12 — prefer `playerId` (a PlayerProfile id, straight from in-app search). ' +
    '`playerUserId` is kept for callers that already hold a user id. `email` is the fallback ' +
    'for a partner with no account, and it is the friction most likely to cost a doubles entry.',
  fields: (t) => ({
    registrationId: t.id({ required: true }),
    playerId: t.id(),
    playerUserId: t.id(),
    email: t.string(),
  }),
});
```

and in the `invitePartner` resolver:

```ts
        registration.invitePartner(actor, {
          registrationId: args.input.registrationId,
          playerId: args.input.playerId ?? null,
          playerUserId: args.input.playerUserId ?? null,
          email: args.input.email ?? null,
        }),
```

- [ ] **Step 6: Regenerate the SDL and run the tests**

Run: `npm run schema:generate && git diff schema.graphql`
Expected: `playerId: ID` added inside `input InvitePartnerInput`, plus the description change. Nothing else.

Run: `npx vitest run tests/registration.test.ts`
Expected: PASS, including both new `R12:` tests.

- [ ] **Step 7: Commit**

```bash
git add src/modules/registration tests/helpers/modules.ts tests/registration.test.ts schema.graphql
git commit -m "feat(registration): invitePartner accepts a player profile id from search — registration R12

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Docs + final gate

**Files:**
- Modify: `docs/modules/00-platform.md` (contents block line `pusher.ts`, new section before `## Done when`)
- Modify: `docs/modules/06-registration.md` (§ Emits table)
- Modify: `docs/modules/07-payments.md` (§ Emits table, `refund.processed` row)
- Modify: `.env.example` (Pusher block)
- Modify: `docs/superpowers/specs/2026-09-17-realtime-user-channel-design.md` (§ Testing)

- [ ] **Step 1: `00-platform.md`**

Replace the contents line

```
  pusher.ts        Channels publish, Beams push, channel auth
```

with

```
  pusher.ts        Channels publish + channel auth signature (Beams: Sprint 9)
  realtime/        POST /pusher/auth handler; registration.updated notifier
```

Insert before `## Done when`:

````markdown
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

### Local payments

`npm run simulate:payment -- <registrationId> [captured|failed]` sends a signed webhook to the local
`/webhooks/razorpay` for the registration's latest order. Refuses to run in production. The worker
must be running.
````

- [ ] **Step 2: `06-registration.md` § Emits**

Replace the table rows:

```
| `registration.confirmed` | notifications |
| `registration.expired` | notifications |
| `invite.created` | notifications |
```

with

```
| `registration.confirmed` | notifications, realtime |
| `registration.expired` | notifications, realtime |
| `registration.payment_failed` | realtime |
| `registration.cancelled` | realtime |
| `hold.created` | registration (`release-hold`), realtime |
| `invite.created` | notifications, realtime |
| `invite.declined` | realtime |
```

and change `| \`registration.checked_in\` | organizers (analytics) |` to `| \`registration.checked_in\` | organizers (analytics), realtime |`. Add below the table:

```markdown
`realtime` = `registration.updated` on `private-user-{id}` for every entrant — see
[00-platform § Realtime](./00-platform.md#realtime).
```

- [ ] **Step 3: `07-payments.md` § Emits**

Change `| \`refund.processed\` | notifications, organizers (analytics), admin (fraud) |` to
`| \`refund.processed\` | notifications, organizers (analytics), admin (fraud), realtime |`.

- [ ] **Step 4: `.env.example`**

Replace `# ─── Realtime — Pusher (Sprint 8) ──…` header line with:

```
# ─── Realtime — Pusher ─────────────────────────────────────────────────────
# Optional locally: empty means no publishes and /pusher/auth answers 503; the
# app falls back to polling. Beams keys are unused until notifications (Sprint 9).
```

- [ ] **Step 4b: `06-registration.md` R12**

Append to the **R12** paragraph:

```markdown
`invitePartner` takes `playerId` (the `PlayerProfile.id` search returns), `playerUserId`, or
`email` — in that order of preference.
```

- [ ] **Step 5: Spec amendment**

In `docs/superpowers/specs/2026-09-17-realtime-user-channel-design.md` § Scope "Out", replace
`- Any schema, migration or GraphQL change.` with
`- Any migration. The one GraphQL change is additive — \`InvitePartnerInput.playerId\`, added during planning because player search returns profile ids.`


In `docs/superpowers/specs/2026-09-17-realtime-user-channel-design.md` § Testing, replace the
`tests/realtime-auth.test.ts` bullet with:

```markdown
- `src/platform/realtime/auth.test.ts` — the pure `handlePusherAuth` with fake deps covers every row
  of the response table (own channel 200; other user 403; unknown prefix 403; no/bad token 401;
  malformed socket id 400; rate limited 429; unconfigured 503). `createApp()` is not started: it
  imports the Prisma/Redis singletons and adds nothing to what the handler decides.
```

- [ ] **Step 6: Final gate**

Run: `npm run check`
Expected: typecheck, lint, guard and every test suite pass.

Run: `npm run schema:generate && git diff --stat schema.graphql`
Expected: no change beyond what Task 5 committed.

- [ ] **Step 7: Commit**

```bash
git add docs .env.example
git commit -m "docs(platform): document /pusher/auth, registration.updated and simulate:payment

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Manual smoke (report the result, do not skip silently)**

With Postgres/Redis up (`npm run db:up`), `npm run dev` and `npm run dev:worker` running:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4000/pusher/auth -d "socket_id=1.1&channel_name=private-user-x"
```

Expected: `503` when `PUSHER_*` are empty, otherwise `401` (no token).
