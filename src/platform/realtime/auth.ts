/**
 * POST /pusher/auth — the channel authorizer (architecture.md §2, the closed
 * route list).
 *
 * Pusher hands the client a socket_id; we decide what it may subscribe to, and
 * re-check that on every call (architecture.md § Security). The decision is a
 * pure function so every branch is testable without a database or Express.
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
 * The allowlist; anything not matched here is refused.
 *
 * Score channels carry what the event page already shows anybody (a draw only
 * exists for a published event), so any signed-in user may spectate. The
 * signed-in requirement is the cost control: point-level traffic is metered
 * per subscriber (scoring § Realtime contract), and an anonymous socket per
 * WhatsApp forward is the bill that contract exists to avoid.
 */
const CHANNELS: ChannelRule[] = [
  {
    pattern: /^private-user-([0-9a-f-]{36})$/,
    entitled: (userId, match) => match[1] === userId,
  },
  // Point-by-point score, for whoever opened that one match (scoring R5).
  { pattern: /^private-match-[0-9a-f-]{36}$/, entitled: () => true },
  // Match status transitions for everyone with the event open.
  { pattern: /^presence-event-[0-9a-f-]{36}$/, entitled: () => true },
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
    const presence = channelName.startsWith('presence-') ? { userId } : undefined;
    return { status: 200, body: deps.realtime.authorize(input.socketId, channelName, presence) };
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
