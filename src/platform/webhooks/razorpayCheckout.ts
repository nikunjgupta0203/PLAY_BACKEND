/**
 * The browser leg of a Razorpay payment, inside the app's WebView:
 *
 *   app ──POST form──▶ /checkout   our page running Razorpay's checkout.js
 *   Razorpay ──POST──▶ /return     razorpay_payment_id, _order_id, _signature
 *   ──303──▶           /done       the app intercepts this URL and closes
 *
 * payments R5 — none of it changes the database. The return verifies the
 * signature so a forged "success" can't even steer the UI, then redirects to
 * /done; the webhook and reconciliation are still the only things that confirm
 * an entry. /done is a GET because a WebView reports a redirect's GET to the
 * app reliably and a POST not at all on some Android versions.
 */
import express, { Router } from 'express';
import { CHECKOUT_PATH, DONE_PATH, RETURN_PATH, type RazorpayGateway } from '../razorpay/adapter.js';

const form = express.urlencoded({ extended: false, limit: '32kb' });

export function createRazorpayCheckoutRouter(
  gw: Pick<RazorpayGateway, 'checkoutPage' | 'verifyCheckout'> | null,
): Router {
  const router = Router();

  router.post(CHECKOUT_PATH, form, (req, res) => {
    if (!gw) {
      res.status(503).send('not configured');
      return;
    }
    const page = gw.checkoutPage((req.body ?? {}) as Record<string, string>);
    if (!page) {
      res.redirect(303, `${DONE_PATH}?status=failure&reason=checkout`);
      return;
    }
    // checkout.js loads scripts and frames from several Razorpay hosts that
    // change without notice; a CSP we cannot test against them would break
    // payments silently. This one page goes without: it carries no posted
    // markup (checkoutPage JSON-escapes every value). And checkout must keep
    // its window relationships, which same-origin COOP would sever.
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(page);
  });

  router.post(RETURN_PATH, form, (req, res) => {
    if (!gw) {
      res.status(503).send('not configured');
      return;
    }
    const fields = (req.body ?? {}) as Record<string, string>;
    if (gw.verifyCheckout(fields)) {
      const paymentId = encodeURIComponent(fields['razorpay_payment_id'] ?? '');
      res.redirect(303, `${DONE_PATH}?status=success&payment_id=${paymentId}`);
      return;
    }
    // A signature that does not verify is a forgery or a misconfigured secret;
    // no signature at all is Razorpay reporting a failed payment (error[…] fields).
    const reason = fields['razorpay_signature'] ? 'signature' : 'payment_failed';
    res.redirect(303, `${DONE_PATH}?status=failure&reason=${reason}`);
  });

  router.get(DONE_PATH, (_req, res) => {
    res
      .type('html')
      .send('<!doctype html><meta name="viewport" content="width=device-width"><p>Payment finished. You can close this page.</p>');
  });

  return router;
}
