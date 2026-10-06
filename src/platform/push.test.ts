import { describe, expect, it, vi } from 'vitest';
import { createExpoPush, type PushMessage } from './push.js';

const msg = (to: string): PushMessage => ({ to, title: 't', body: 'b', data: {} });

function ok(tickets: unknown[]) {
  return vi.fn(async () => new Response(JSON.stringify({ data: tickets }), { status: 200 }));
}

describe('expo push adapter', () => {
  it('notifications R6: a DeviceNotRegistered ticket reports the token as invalid', async () => {
    const fetch = ok([
      { status: 'ok', id: '1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    const push = createExpoPush({ fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await push.send([msg('ExponentPushToken[a]'), msg('ExponentPushToken[b]')]);
    expect(out).toEqual({
      sent: 1,
      invalidTokens: ['ExponentPushToken[b]'],
      tickets: [{ id: '1', token: 'ExponentPushToken[a]' }],
    });
  });

  it('notifications R6: a DeviceNotRegistered receipt reports its token as invalid', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            r1: { status: 'ok' },
            r2: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
            r3: { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } },
          },
        }),
      ),
    );
    const push = createExpoPush({ fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await push.checkReceipts([
      { id: 'r1', token: 'a' },
      { id: 'r2', token: 'b' },
      { id: 'r3', token: 'c' },
      { id: 'r4', token: 'd' }, // no receipt yet
    ]);
    expect(out).toEqual({ invalidTokens: ['b'] });
  });

  it('chunks at 100 messages a request', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const n = (JSON.parse(String(init?.body)) as unknown[]).length;
      return new Response(JSON.stringify({ data: Array.from({ length: n }, () => ({ status: 'ok' })) }));
    });
    const push = createExpoPush({ fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await push.send(Array.from({ length: 250 }, (_, i) => msg(`t${i}`)));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(out.sent).toBe(250);
  });

  it('throws on a service outage so the job retries', async () => {
    const fetch = vi.fn(async () => new Response('down', { status: 503 }));
    const push = createExpoPush({ fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(push.send([msg('x')])).rejects.toThrow(/503/);
  });

  it('sends the access token only when one is configured', async () => {
    const fetch = ok([{ status: 'ok' }]);
    await createExpoPush({ fetch: fetch as unknown as typeof globalThis.fetch, accessToken: 'tok' }).send([msg('x')]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
});
