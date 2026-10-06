/**
 * RazorpayX payouts webhook (payouts R13). A hint, never the truth: once the
 * signature verifies, the body names a reference_id and nothing else is
 * believed. The status always comes from RazorpayX's payouts API in the
 * `check-payout` job. Answers 200 fast either way, so RazorpayX does not
 * retry what we have already queued.
 */
import type { Request, Response } from 'express';
import { logger } from '../logging/index.js';
import { payoutProvider, payoutsConfigured } from '../payouts/index.js';
import { payouts } from '../../modules/payments/index.js';

export async function payoutsWebhook(req: Request, res: Response): Promise<void> {
  if (!payoutsConfigured()) {
    res.status(503).send('not configured');
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const ref = payoutProvider.refFromWebhook(raw, req.headers);
  if (!ref) {
    // A bad signature, or an event that is not about one of our payouts
    // (payout.downtime.*). Nothing to do, and nothing worth a retry.
    logger.warn('payouts webhook without a verified reference_id');
    res.status(200).send('ignored');
    return;
  }
  await payouts.checkByRef(ref);
  res.status(200).send('ok');
}
