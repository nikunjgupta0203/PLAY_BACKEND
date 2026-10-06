/**
 * Pusher Channels adapter (00-platform). The ONLY place Pusher is spoken to and
 * the only place its secret is used.
 *
 * `fetch` against the HTTP API rather than the SDK: two trivial signed calls
 * do not justify a dependency.
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
  /**
   * A presence channel also signs the member record Pusher shows the other
   * subscribers; only the user id goes in it, never a name or an email.
   */
  authorize(
    socketId: string,
    channelName: string,
    presence?: { userId: string },
  ): { auth: string; channel_data?: string };
}

/** Bad client input to the authorizer. The route maps it to a 400. */
export class RealtimeInputError extends Error {}

const SOCKET_ID = /^\d+\.\d+$/;
const CHANNEL_NAME = /^[A-Za-z0-9_\-=@,.;]{1,164}$/;
/** Pusher's per-call channel limit. */
const MAX_CHANNELS = 100;
/** I2 — one hung connection must not stall the outbox drain forever. */
const PUBLISH_TIMEOUT_MS = 3_000;

export function channelAuthSignature(
  creds: Pick<PusherCredentials, 'key' | 'secret'>,
  socketId: string,
  channelName: string,
  channelData?: string,
): string {
  if (!SOCKET_ID.test(socketId)) throw new RealtimeInputError('invalid socket_id');
  if (!CHANNEL_NAME.test(channelName)) throw new RealtimeInputError('invalid channel_name');
  const signed =
    channelData === undefined ? `${socketId}:${channelName}` : `${socketId}:${channelName}:${channelData}`;
  const sig = createHmac('sha256', creds.secret).update(signed).digest('hex');
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
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`pusher publish failed: HTTP ${res.status}`);
      }
    },
    authorize(socketId, channelName, presence) {
      if (!presence) return { auth: channelAuthSignature(creds, socketId, channelName) };
      const channelData = JSON.stringify({ user_id: presence.userId });
      return {
        auth: channelAuthSignature(creds, socketId, channelName, channelData),
        channel_data: channelData,
      };
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
