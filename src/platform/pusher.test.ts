import { createHmac } from 'node:crypto';
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

  it('publish passes an abort signal so a hung Pusher call cannot stall the drain forever', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    const rt = createRealtime(DOC, { fetch: fetchMock as unknown as typeof fetch });
    await rt.publish(['private-user-u1'], 'e', {});

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

describe('presence channel auth', () => {
  it('signs socket:channel:channel_data and returns the member record', () => {
    const creds = { appId: '1', key: 'key', secret: 'secret', cluster: 'ap2' };
    const rt = createRealtime(creds, { fetch: vi.fn() as unknown as typeof fetch });
    const out = rt.authorize('1.2', 'presence-event-x', { userId: 'u1' });
    expect(out.channel_data).toBe('{"user_id":"u1"}');
    const expected = createHmac('sha256', 'secret')
      .update('1.2:presence-event-x:{"user_id":"u1"}')
      .digest('hex');
    expect(out.auth).toBe(`key:${expected}`);
  });
});

describe('presence signature — Pusher’s documented example', () => {
  it('matches the docs byte for byte', () => {
    const channelData = '{"user_id":10,"user_info":{"name":"Mr. Channels"}}';
    expect(channelAuthSignature(DOC, '1234.1234', 'presence-foobar', channelData)).toBe(
      '278d425bdf160c739803:31935e7d86dba64c2a90aed31fdc61869f9b22ba9d8863bba239c03ca481bc80',
    );
  });
});
