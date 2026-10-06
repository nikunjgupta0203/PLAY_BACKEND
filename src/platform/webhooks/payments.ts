/**
 * Payment gateway webhook (payments R2, R3, R4).
 *
 * THIS ROUTE MUST BE MOUNTED BEFORE `express.json()`, with `express.raw`.
 * Gateways sign the exact bytes they transmitted; if any parser touches the
 * body first, signature verification can never succeed — and the failure
 * presents as a credentials problem, which is how teams lose a day to it
 * (architecture.md §2).
 *
 * The handler does three things and nothing else: verify, claim, enqueue.
 * Gateways time out within seconds and RETRY A SLOW SUCCESS, so doing the state
 * change here is how a busy Saturday turns into double-processing.
 */
import type { Request, Response } from 'express';
import { logger } from '../logging/index.js';
import { gatewayConfigured } from '../paymentGateway.js';
import { payments } from '../../modules/payments/index.js';

export async function paymentsWebhook(req: Request, res: Response): Promise<void> {
  if (!gatewayConfigured()) {
    // Refuse rather than accept unsigned traffic. A 503 makes the gateway
    // retry, which is what we want while it is being configured.
    res.status(503).send('not configured');
    return;
  }

  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw)) {
    // Something upstream parsed the body. Fail loudly: the signature is now
    // unverifiable and every payment on this deploy is about to go unconfirmed.
    logger.fatal('payments webhook body is not raw — check the middleware order');
    res.status(500).send('misconfigured');
    return;
  }

  const result = await payments.ingestWebhook(raw, req.headers);

  if (result.status === 400) {
    // R2 — a bad signature is a 400 and nothing is written. Never a 500: a 500
    // makes the gateway retry a request that will never succeed.
    logger.warn('payments webhook signature rejected');
    res.status(400).send('bad signature');
    return;
  }

  // R3 — a duplicate delivery is a 200 with no work, so the gateway stops
  // retrying immediately rather than backing off over the next day.
  res.status(200).send(result.duplicate ? 'duplicate' : 'ok');
}
