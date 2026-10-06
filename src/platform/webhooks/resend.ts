/**
 * Resend delivery webhook (identity R13).
 *
 * Resend signs with Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}` using
 * the base64 secret that follows the `whsec_` prefix. The route receives the
 * RAW body, mounted before express.json() — the same rule the payments webhook
 * lives by (architecture.md §2).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logging/index.js';
import { identity } from '../../modules/identity/index.js';

const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  raw: Buffer,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  now = Date.now(),
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  // Reject replays of an old, validly-signed delivery.
  if (Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${headers.id}.${headers.timestamp}.${raw.toString('utf8')}`)
    .digest('base64');

  // The header carries space-separated `v1,<sig>` entries.
  for (const part of headers.signature.split(' ')) {
    const sig = part.split(',')[1];
    if (!sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

const HANDLED: Record<string, 'delivered' | 'bounced' | 'complained'> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

export async function resendWebhook(req: Request, res: Response): Promise<void> {
  if (!config.RESEND_WEBHOOK_SECRET) {
    // Not configured yet. Refuse rather than accept unsigned traffic.
    res.status(503).send('not configured');
    return;
  }

  const raw = req.body as Buffer;
  const ok = verifySvixSignature(
    raw,
    {
      id: req.get('svix-id') ?? undefined,
      timestamp: req.get('svix-timestamp') ?? undefined,
      signature: req.get('svix-signature') ?? undefined,
    },
    config.RESEND_WEBHOOK_SECRET,
  );
  if (!ok) {
    res.status(400).send('bad signature');
    return;
  }

  const event = JSON.parse(raw.toString('utf8')) as {
    type?: string;
    data?: { to?: string[] | string };
  };

  const kind = event.type ? HANDLED[event.type] : undefined;
  const rawTo = event.data?.to;
  const to = Array.isArray(rawTo) ? rawTo[0] : rawTo;

  if (kind && to) {
    await identity.recordDeliveryEvent(to, kind);
    logger.info({ type: event.type }, 'resend delivery event');
  }

  res.status(200).send('ok');
}
