/**
 * Push adapter (notifications). The ONLY place a push service is spoken to.
 *
 * The module doc names Pusher Beams. The player app is Expo, and Beams has no
 * Expo-compatible client; Expo's push service is what `expo-notifications`
 * issues tokens for, and it fronts FCM and APNs itself. The contract the
 * module depends on is `PushGateway` — swapping the service is this file.
 *
 * `fetch` rather than an SDK, as with pusher.ts: one signed
 * POST does not justify a dependency.
 */
import { config } from './config.js';
import { logger } from './logging/index.js';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Opaque to the service; the app reads it to route the tap. */
  data: Record<string, unknown>;
  /** iOS app-icon badge: the recipient's unread count. */
  badge?: number;
}

/** A message the service accepted. Whether it reached the phone is known later, from its receipt. */
export interface PushTicket {
  id: string;
  token: string;
}

export interface PushResult {
  /** notifications R6 — tokens the service says are dead. Delete, never retry. */
  invalidTokens: string[];
  sent: number;
  /** Accepted messages, to be checked against their receipts later. */
  tickets: PushTicket[];
}

export interface PushGateway {
  send(messages: PushMessage[]): Promise<PushResult>;
  /**
   * Receipts are where APNs/FCM rejections surface — most dead tokens show up
   * here, not on the ticket. Returns the tokens to delete (R6).
   */
  checkReceipts(tickets: PushTicket[]): Promise<{ invalidTokens: string[] }>;
}

const ENDPOINT = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo's per-request limits. */
const CHUNK = 100;
const RECEIPT_CHUNK = 1_000;
const TIMEOUT_MS = 5_000;

interface Ticket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export function createExpoPush(deps: { fetch?: typeof fetch; accessToken?: string } = {}): PushGateway {
  const doFetch = deps.fetch ?? fetch;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(deps.accessToken ? { Authorization: `Bearer ${deps.accessToken}` } : {}),
  };
  return {
    async send(messages) {
      const invalidTokens: string[] = [];
      const tickets: PushTicket[] = [];
      let sent = 0;
      for (let i = 0; i < messages.length; i += CHUNK) {
        const chunk = messages.slice(i, i + CHUNK);
        const res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers,
          // channelId matches the Android channel the app creates (player push.ts).
          body: JSON.stringify(chunk.map((m) => ({ ...m, sound: 'default', channelId: 'default' }))),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // A 5xx is the service's outage, not ours: throw so the job retries.
        if (!res.ok) throw new Error(`expo push failed: HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Ticket[] };
        for (const [j, ticket] of (body.data ?? []).entries()) {
          if (ticket.status === 'ok') {
            sent += 1;
            if (ticket.id) tickets.push({ id: ticket.id, token: chunk[j]!.to });
          } else if (ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(chunk[j]!.to);
          else logger.warn({ error: ticket.details?.error, message: ticket.message }, 'push ticket error');
        }
      }
      return { invalidTokens, sent, tickets };
    },

    async checkReceipts(tickets) {
      const invalidTokens: string[] = [];
      for (let i = 0; i < tickets.length; i += RECEIPT_CHUNK) {
        const chunk = tickets.slice(i, i + RECEIPT_CHUNK);
        const res = await doFetch(RECEIPTS_ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ids: chunk.map((t) => t.id) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`expo receipts failed: HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Record<string, Ticket> };
        for (const t of chunk) {
          const receipt = body.data?.[t.id];
          // No receipt yet (or already expired) is not a failure.
          if (!receipt || receipt.status === 'ok') continue;
          if (receipt.details?.error === 'DeviceNotRegistered') invalidTokens.push(t.token);
          else logger.warn({ error: receipt.details?.error, message: receipt.message }, 'push receipt error');
        }
      }
      return { invalidTokens };
    },
  };
}

/** Dev and CI: say what would have been sent. */
export const consolePush: PushGateway = {
  async send(messages) {
    for (const m of messages) logger.info({ title: m.title, data: m.data }, 'push (console transport)');
    return { invalidTokens: [], sent: messages.length, tickets: [] };
  },
  async checkReceipts() {
    return { invalidTokens: [] };
  },
};

export const push: PushGateway =
  config.PUSH_TRANSPORT === 'expo'
    ? createExpoPush({ accessToken: config.EXPO_ACCESS_TOKEN || undefined })
    : consolePush;
