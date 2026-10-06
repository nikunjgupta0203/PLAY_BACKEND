/**
 * Razorpay behind the PaymentGateway port (payments R2, R7, R9). `fetch`, no
 * SDK. The ONLY file that holds the key secret and the webhook secret.
 *
 * Razorpay signs what we act on, so nothing has to be asked back before it is
 * believed:
 *  - Webhooks carry `X-Razorpay-Signature`, an HMAC-SHA256 of the raw body
 *    under the webhook secret. It covers the whole payload, payment id
 *    included, so a verified `payment.captured` / `payment.failed` /
 *    `refund.*` is applied as it stands. The event id is Razorpay's own
 *    `x-razorpay-event-id`, the same on every retry of one event — exactly
 *    what the R3 claim needs.
 *  - The checkout's return post carries `razorpay_signature`, an HMAC-SHA256
 *    of `order_id|payment_id` under the key secret. Only a UI hint (R5), but
 *    verified so a forged success cannot even steer the UI.
 *
 * Checkout is Standard Checkout (checkout.js) on a page served from our own
 * origin (`checkoutPage`), not Hosted Checkout: Hosted Checkout does not
 * support UPI intent, which is how most of India pays. `redirect: true`
 * because the app runs checkout in a WebView, where checkout's popups (bank
 * pages, 3-D Secure) would never find their way back.
 *
 * Test and live mode are the key, not a host: `rzp_test_…` keys never move
 * money. config.ts refuses a test key in production.
 */
import { GatewayError } from '../gatewayError.js';
import type {
  CheckoutForm,
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  GatewayWebhookEvent,
  PaymentGateway,
} from '../paymentGateway.js';
import { clean, header, hmacHex, shortToken, signatureMatches, toInt, toPaise } from './signature.js';

/** The browser leg of a payment. The app matches DONE_PATH by path. */
export const CHECKOUT_PATH = '/payments/razorpay/checkout';
export const RETURN_PATH = '/payments/razorpay/return';
export const DONE_PATH = '/payments/razorpay/done';

const API = 'https://api.razorpay.com/v1';
const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';
/** What the player sees at the top of checkout. */
const BUSINESS_NAME = 'PL4Y';
/** A call gives up after 5 s so the job retries rather than hangs. */
const TIMEOUT_MS = 5_000;

const ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/;
const CONTACT = /^\+?\d{8,15}$/;

export interface RazorpayGateway extends PaymentGateway {
  /** payments R5 — does `razorpay_signature` cover this order and payment? */
  verifyCheckout(fields: Record<string, string>): boolean;
  /**
   * The checkout page for a form `checkoutForm` built, or null when the
   * fields are not one (wrong key, malformed order id). Every value is
   * JSON-escaped into the page; nothing posted is ever markup.
   */
  checkoutPage(fields: Record<string, string>): string | null;
}

/** The parts of Razorpay's payment entity we read. */
interface RzpPayment {
  id?: unknown;
  order_id?: unknown;
  amount?: unknown;
  status?: unknown;
  captured?: unknown;
  method?: unknown;
  error_description?: unknown;
  error_reason?: unknown;
}

interface RzpRefund {
  id?: unknown;
  payment_id?: unknown;
  amount?: unknown;
  status?: unknown;
  receipt?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Normalised: 'captured' and 'failed' drive the state machine. A refunded
 * payment that WAS captured is still a capture as far as an order goes;
 * authorised-but-never-captured payments that Razorpay auto-refunds are not.
 */
function paymentStatus(e: RzpPayment): string {
  if (e.status === 'captured' || (e.status === 'refunded' && e.captured === true)) return 'captured';
  if (e.status === 'failed') return 'failed';
  return str(e.status) ?? 'unknown';
}

function toPayment(e: RzpPayment, capturedAt: Date | null): GatewayPayment {
  const status = paymentStatus(e);
  return {
    id: str(e.id) ?? '',
    orderId: str(e.order_id),
    amountPaise: toPaise(e.amount),
    status,
    method: str(e.method),
    failureReason: status === 'failed' ? (str(e.error_description) ?? str(e.error_reason) ?? 'failed') : null,
    capturedAt: status === 'captured' ? capturedAt : null,
    raw: e,
  };
}

function toRefund(e: RzpRefund): GatewayRefund {
  return {
    id: str(e.id) ?? '',
    paymentId: str(e.payment_id) ?? '',
    amountPaise: toPaise(e.amount),
    status: e.status === 'processed' ? 'processed' : e.status === 'failed' ? 'failed' : 'pending',
  };
}

/** JSON that is safe inside a <script>: nothing in it can close the tag or start markup. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** A refund's receipt: our idempotency key, cut to a length Razorpay takes. */
export const refundReceipt = (idempotencyKey: string): string => `rf_${shortToken(idempotencyKey, 37)}`;

export function createRazorpay(opts: {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  publicApiUrl: string;
  fetch?: typeof fetch;
}): RazorpayGateway {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.publicApiUrl.replace(/\/$/, '');
  const authorization = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`;

  async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${API}${path}`, {
        method,
        headers: body === undefined ? { authorization } : { authorization, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayError(503, `razorpay ${method} ${path} unreachable: ${(err as Error).message}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new GatewayError(502, `razorpay ${method} ${path} returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const description = (json as { error?: { description?: unknown } } | null)?.error?.description;
      throw new GatewayError(
        res.status >= 500 ? 503 : 502,
        `razorpay ${method} ${path} refused (HTTP ${res.status}): ${String(description ?? 'no description')}`,
        res.status,
      );
    }
    return json as T;
  }

  function verifyCheckout(fields: Record<string, string>): boolean {
    const orderId = fields['razorpay_order_id'];
    const paymentId = fields['razorpay_payment_id'];
    if (!orderId || !paymentId) return false;
    return signatureMatches(hmacHex(opts.keySecret, `${orderId}|${paymentId}`), fields['razorpay_signature']);
  }

  function checkoutPage(fields: Record<string, string>): string | null {
    const f = (k: string) => (typeof fields[k] === 'string' ? fields[k] : '');
    if (f('key') !== opts.keyId || !ORDER_ID.test(f('order_id'))) return null;
    if (!/^[1-9]\d{0,14}$/.test(f('amount')) || !/^[A-Z]{3}$/.test(f('currency'))) return null;
    const options = {
      key: opts.keyId,
      order_id: f('order_id'),
      amount: Number(f('amount')),
      currency: f('currency'),
      name: BUSINESS_NAME,
      description: clean(f('description'), 255),
      prefill: {
        name: clean(f('prefill_name'), 60),
        email: clean(f('prefill_email'), 100),
        contact: CONTACT.test(f('prefill_contact')) ? f('prefill_contact') : '',
      },
      callback_url: `${base}${RETURN_PATH}`,
      redirect: true,
    };
    return (
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${BUSINESS_NAME} — Pay</title></head><body>` +
      `<script src="${CHECKOUT_JS}"></script>` +
      '<script>(function () {' +
      `var done = ${scriptJson(DONE_PATH)};` +
      // checkout.js did not load (no network, blocked): say so rather than sit on a blank page.
      "if (typeof Razorpay !== 'function') { location.replace(done + '?status=failure&reason=unavailable'); return; }" +
      `var options = ${scriptJson(options)};` +
      // Android WebView: UPI apps open by intent, which the app hands to the OS.
      'options.webview_intent = /Android/i.test(navigator.userAgent);' +
      "options.modal = { ondismiss: function () { location.replace(done + '?status=dismissed'); } };" +
      'new Razorpay(options).open();' +
      '})();</script></body></html>'
    );
  }

  return {
    name: 'razorpay',

    async createOrder(input): Promise<GatewayOrder> {
      const o = await api<{ id?: unknown; amount?: unknown; currency?: unknown; status?: unknown }>('POST', '/orders', {
        amount: toInt(input.amountPaise),
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        notes: input.notes ?? {},
      });
      const id = str(o.id);
      if (!id) throw new GatewayError(502, 'razorpay order has no id');
      return {
        id,
        amountPaise: toPaise(o.amount),
        currency: str(o.currency) ?? input.currency,
        status: str(o.status) ?? 'created',
      };
    },

    checkoutForm(input): CheckoutForm {
      const contact = input.payer.phone && CONTACT.test(input.payer.phone) ? input.payer.phone : null;
      return {
        action: `${base}${CHECKOUT_PATH}`,
        fields: {
          key: opts.keyId,
          order_id: input.gatewayOrderId,
          amount: input.amountPaise.toString(),
          // Orders are INR (the service's CURRENCY); the order fixes it either way.
          currency: 'INR',
          description: clean(input.description, 255) || `${BUSINESS_NAME} entry`,
          prefill_name: clean(input.payer.name, 60),
          prefill_email: clean(input.payer.email, 100),
          ...(contact ? { prefill_contact: contact } : {}),
        },
      };
    },

    async paymentsForOrder(orderId) {
      const body = await api<{ items?: RzpPayment[] }>('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
      return (body.items ?? [])
        .map((e) => toPayment(e, null))
        .filter((p) => p.status === 'captured' || p.status === 'failed');
    },

    /**
     * R7 — Razorpay has no idempotency header for refunds, so the key travels
     * as the refund's `receipt` and a retry looks for it first: a timeout
     * after Razorpay took the refund must never send a second one.
     */
    async refund(input): Promise<GatewayRefund> {
      const path = `/payments/${encodeURIComponent(input.paymentId)}`;
      const receipt = refundReceipt(input.idempotencyKey);
      const prior = await api<{ items?: RzpRefund[] }>('GET', `${path}/refunds?count=100`);
      const sent = prior.items?.find((r) => r.receipt === receipt);
      if (sent) return toRefund(sent);
      return toRefund(
        await api<RzpRefund>('POST', `${path}/refund`, {
          amount: toInt(input.amountPaise),
          speed: 'normal',
          receipt,
        }),
      );
    },

    async refundStatus(gatewayRefundId): Promise<GatewayRefund> {
      return toRefund(await api<RzpRefund>('GET', `/refunds/${encodeURIComponent(gatewayRefundId)}`));
    },

    parseWebhook(raw, headers): GatewayWebhookEvent | null {
      if (!signatureMatches(hmacHex(opts.webhookSecret, raw), header(headers, 'x-razorpay-signature'))) return null;
      let body: {
        event?: unknown;
        created_at?: unknown;
        payload?: { payment?: { entity?: RzpPayment }; refund?: { entity?: RzpRefund } };
      };
      try {
        body = JSON.parse(raw.toString('utf8')) as typeof body;
      } catch {
        return null;
      }
      if (typeof body !== 'object' || body === null) return null;
      const event = str(body.event) ?? 'unknown';
      const payment = body.payload?.payment?.entity;
      const refund = body.payload?.refund?.entity;
      const entityId = str(refund?.id) ?? str(payment?.id) ?? 'none';
      // Razorpay's own id is the same on every retry. The fallback is only for
      // a delivery without it, and is just as stable for one event.
      const id = header(headers, 'x-razorpay-event-id') || `${event}:${entityId}`;
      const at = typeof body.created_at === 'number' ? new Date(body.created_at * 1000) : null;

      try {
        switch (event) {
          // order.paid carries the same captured payment; applying both is idempotent.
          case 'payment.captured':
          case 'order.paid':
            if (!payment) break;
            return { id, type: 'payment.captured', payment: toPayment(payment, at) };
          case 'payment.failed':
            if (!payment) break;
            return { id, type: 'payment.failed', payment: toPayment(payment, null) };
          case 'refund.processed':
          case 'refund.failed':
            if (!refund) break;
            return { id, type: event, refund: toRefund(refund) };
        }
      } catch {
        // Signed but not the shape we know (an amount that is not an integer).
        // Recorded as ignored rather than a 400 Razorpay would retry forever.
      }
      return { id, type: 'ignored', providerType: event };
    },

    verifyCheckout,
    checkoutPage,
  };
}
