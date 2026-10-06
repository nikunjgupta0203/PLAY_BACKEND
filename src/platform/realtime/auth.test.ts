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

describe('POST /pusher/auth — score channels (scoring § Realtime contract)', () => {
  const MATCH = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  it('scoring R5: any signed-in user may spectate a match channel', async () => {
    const res = await handlePusherAuth(input(`private-match-${MATCH}`), deps());
    expect(res.status).toBe(200);
  });

  it('signs a presence-event channel with the caller as the member, and nothing else', async () => {
    const d = deps();
    const res = await handlePusherAuth(input(`presence-event-${MATCH}`), d);
    expect(res.status).toBe(200);
    expect(d.realtime.authorize).toHaveBeenCalledWith('123.456', `presence-event-${MATCH}`, {
      userId: USER,
    });
  });

  it('401 for a signed-out spectator — the per-subscriber bill is why', async () => {
    const res = await handlePusherAuth(
      input(`private-match-${MATCH}`, { authorization: undefined }),
      deps(),
    );
    expect(res.status).toBe(401);
  });
});
