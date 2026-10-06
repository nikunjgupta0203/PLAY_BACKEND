import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from '../gatewayError.js';
import { createRazorpay, refundReceipt } from './adapter.js';

const KEY_ID = 'rzp_test_key';
const KEY_SECRET = 'key-secret';
const WEBHOOK_SECRET = 'webhook-secret';

type FetchMock = ReturnType<typeof vi.fn>;

function razorpay(fetchImpl?: FetchMock) {
  return createRazorpay({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    publicApiUrl: 'https://api.example.test/',
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

/** Answers each call with the next body in turn. */
function replies(...bodies: { status?: number; body: unknown }[]): FetchMock {
  const queue = [...bodies];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected call');
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  });
}

const callOf = (f: FetchMock, i = 0) => {
  const [url, init] = f.mock.calls[i] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  };
};

/** Razorpay's documented payment entity, trimmed to what the adapter reads. */
const PAYMENT = {
  id: 'pay_DESlfW9H8K9uqM',
  entity: 'payment',
  amount: 64900,
  currency: 'INR',
  status: 'captured',
  order_id: 'order_DESlLckIVRkHWj',
  method: 'upi',
  captured: true,
  error_description: null,
  error_reason: null,
  notes: [],
  created_at: 1567674599,
};

const FAILED = {
  ...PAYMENT,
  id: 'pay_DEAU825sJlCbGa',
  status: 'failed',
  captured: false,
  error_code: 'BAD_REQUEST_ERROR',
  error_description: 'Payment failed',
  error_reason: 'payment_failed',
};

const REFUND = {
  id: 'rfnd_FP8QHiV938haTz',
  entity: 'refund',
  amount: 50000,
  payment_id: 'pay_DESlfW9H8K9uqM',
  receipt: null,
  status: 'pending',
};

/** A webhook exactly as Razorpay posts it: JSON, HMAC over the raw bytes. */
function webhook(event: string, payload: object, eventId: string | null = 'evt_1') {
  const raw = Buffer.from(JSON.stringify({ entity: 'event', event, contains: [], payload, created_at: 1567674606 }));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
  };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  return { raw, headers };
}

describe('razorpay adapter — orders and checkout', () => {
  it('createOrder posts paise, receipt and notes with basic auth', async () => {
    const f = replies({ body: { id: 'order_ABC', amount: 64900, currency: 'INR', status: 'created' } });
    const order = await razorpay(f).createOrder({
      amountPaise: 64_900n,
      currency: 'INR',
      receipt: 'a'.repeat(50),
      notes: { registrationId: 'r1' },
    });
    expect(order).toEqual({ id: 'order_ABC', amountPaise: 64_900n, currency: 'INR', status: 'created' });
    const call = callOf(f);
    expect(call.url).toBe('https://api.razorpay.com/v1/orders');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`);
    expect(call.body).toEqual({ amount: 64900, currency: 'INR', receipt: 'a'.repeat(40), notes: { registrationId: 'r1' } });
  });

  it("a refused order is a GatewayError carrying Razorpay's description", async () => {
    const f = replies({
      status: 400,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Order amount less than minimum amount allowed' } },
    });
    const err = await razorpay(f).createOrder({ amountPaise: 50n, currency: 'INR', receipt: 'r' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(502);
    expect((err as GatewayError).message).toContain('minimum amount');
  });

  it('an unreachable API is a 503 GatewayError, so the job retries', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const err = await razorpay(f).paymentsForOrder('order_1').catch((e: unknown) => e);
    expect((err as GatewayError).status).toBe(503);
  });

  it('checkoutForm opens our checkout page with public fields only', () => {
    const form = razorpay().checkoutForm({
      gatewayOrderId: 'order_ABC',
      amountPaise: 64_900n,
      receipt: 'o1',
      payer: { name: '  Asha   Rao ', email: 'asha@example.com', phone: '+919812345678' },
      description: 'Bengaluru Open',
    });
    expect(form).toEqual({
      action: 'https://api.example.test/payments/razorpay/checkout',
      fields: {
        key: KEY_ID,
        order_id: 'order_ABC',
        amount: '64900',
        currency: 'INR',
        description: 'Bengaluru Open',
        prefill_name: 'Asha Rao',
        prefill_email: 'asha@example.com',
        prefill_contact: '+919812345678',
      },
    });
    expect(JSON.stringify(form)).not.toContain(KEY_SECRET);
  });

  it('checkoutForm leaves the phone out when the player has none', () => {
    const form = razorpay().checkoutForm({
      gatewayOrderId: 'order_ABC',
      amountPaise: 100n,
      receipt: 'o',
      description: 'd',
      payer: { name: 'A', email: 'a@example.com', phone: null },
    });
    expect(form.fields).not.toHaveProperty('prefill_contact');
  });
});

describe('razorpay adapter — checkout page', () => {
  const fields = () => ({ ...razorpay().checkoutForm({
    gatewayOrderId: 'order_ABC',
    amountPaise: 64_900n,
    receipt: 'o1',
    payer: { name: 'Asha', email: 'asha@example.com', phone: '+919812345678' },
    description: 'Bengaluru Open',
  }).fields });

  it('runs checkout.js with redirect to our return route', () => {
    const page = razorpay().checkoutPage(fields())!;
    expect(page).toContain('<script src="https://checkout.razorpay.com/v1/checkout.js"></script>');
    expect(page).toContain('"order_id":"order_ABC"');
    expect(page).toContain('"callback_url":"https://api.example.test/payments/razorpay/return"');
    expect(page).toContain('"redirect":true');
    expect(page).toContain('webview_intent');
    expect(page).toContain('status=dismissed');
    expect(page).not.toContain(KEY_SECRET);
  });

  it('refuses another merchant key or a malformed order id', () => {
    expect(razorpay().checkoutPage({ ...fields(), key: 'rzp_test_other' })).toBeNull();
    expect(razorpay().checkoutPage({ ...fields(), order_id: 'order_"x' })).toBeNull();
    expect(razorpay().checkoutPage({ ...fields(), amount: '-1' })).toBeNull();
  });

  it('no posted value can close the script or start markup', () => {
    const page = razorpay().checkoutPage({
      ...fields(),
      description: '</script><script>alert(1)</script>',
      prefill_name: '<img src=x onerror=alert(1)>',
    })!;
    expect(page).not.toContain('</script><script>alert');
    expect(page).not.toContain('<img');
    expect(page).toContain('\\u003c/script\\u003e');
  });

  it('drops a contact that is not a phone number', () => {
    const page = razorpay().checkoutPage({ ...fields(), prefill_contact: 'javascript:alert(1)' })!;
    expect(page).toContain('"contact":""');
  });
});

describe('razorpay adapter — return signature', () => {
  const sign = (order: string, payment: string, secret = KEY_SECRET) =>
    createHmac('sha256', secret).update(`${order}|${payment}`).digest('hex');

  it('accepts the HMAC of order_id|payment_id under the key secret', () => {
    expect(
      razorpay().verifyCheckout({
        razorpay_order_id: 'order_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: sign('order_1', 'pay_1'),
      }),
    ).toBe(true);
  });

  it('refuses a signature for another payment, another secret, or none', () => {
    const gw = razorpay();
    expect(
      gw.verifyCheckout({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_2', razorpay_signature: sign('order_1', 'pay_1') }),
    ).toBe(false);
    expect(
      gw.verifyCheckout({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: sign('order_1', 'pay_1', 'other') }),
    ).toBe(false);
    expect(gw.verifyCheckout({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1' })).toBe(false);
  });
});

describe('razorpay adapter — reconciliation and refunds', () => {
  it('paymentsForOrder reports final payments only, normalised', async () => {
    const f = replies({
      body: {
        entity: 'collection',
        count: 4,
        items: [
          FAILED,
          PAYMENT,
          { ...PAYMENT, id: 'pay_auth', status: 'authorized', captured: false },
          { ...PAYMENT, id: 'pay_refunded', status: 'refunded', captured: true },
        ],
      },
    });
    const payments = await razorpay(f).paymentsForOrder('order_DESlLckIVRkHWj');
    expect(callOf(f).url).toBe('https://api.razorpay.com/v1/orders/order_DESlLckIVRkHWj/payments');
    expect(payments.map((p) => [p.id, p.status])).toEqual([
      ['pay_DEAU825sJlCbGa', 'failed'],
      ['pay_DESlfW9H8K9uqM', 'captured'],
      ['pay_refunded', 'captured'],
    ]);
    expect(payments[0]).toMatchObject({ failureReason: 'Payment failed', amountPaise: 64_900n, method: 'upi' });
    expect(payments[1]).toMatchObject({ orderId: 'order_DESlLckIVRkHWj', failureReason: null });
  });

  it('refund sends the idempotency key as the receipt', async () => {
    const f = replies({ body: { entity: 'collection', count: 0, items: [] } }, { body: REFUND });
    const refund = await razorpay(f).refund({ paymentId: 'pay_DESlfW9H8K9uqM', amountPaise: 50_000n, idempotencyKey: 'k1' });
    expect(refund).toEqual({ id: 'rfnd_FP8QHiV938haTz', paymentId: 'pay_DESlfW9H8K9uqM', amountPaise: 50_000n, status: 'pending' });
    expect(callOf(f, 0).url).toBe('https://api.razorpay.com/v1/payments/pay_DESlfW9H8K9uqM/refunds?count=100');
    const post = callOf(f, 1);
    expect(post.url).toBe('https://api.razorpay.com/v1/payments/pay_DESlfW9H8K9uqM/refund');
    expect(post.body).toEqual({ amount: 50000, speed: 'normal', receipt: refundReceipt('k1') });
    expect(refundReceipt('k1').length).toBeLessThanOrEqual(40);
  });

  it('a retried refund finds the one already sent and never sends a second', async () => {
    const f = replies({
      body: { entity: 'collection', count: 1, items: [{ ...REFUND, receipt: refundReceipt('k1'), status: 'processed' }] },
    });
    const refund = await razorpay(f).refund({ paymentId: 'pay_DESlfW9H8K9uqM', amountPaise: 50_000n, idempotencyKey: 'k1' });
    expect(refund.status).toBe('processed');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pending', 'pending'],
    ['processed', 'processed'],
    ['failed', 'failed'],
  ])('refundStatus maps %s to %s', async (given, want) => {
    const f = replies({ body: { ...REFUND, status: given } });
    const refund = await razorpay(f).refundStatus('rfnd_FP8QHiV938haTz');
    expect(callOf(f).url).toBe('https://api.razorpay.com/v1/refunds/rfnd_FP8QHiV938haTz');
    expect(refund.status).toBe(want);
  });
});

describe('razorpay adapter — webhooks', () => {
  it('a bad or missing signature is null', () => {
    const { raw, headers } = webhook('payment.captured', { payment: { entity: PAYMENT } });
    expect(razorpay().parseWebhook(raw, { ...headers, 'x-razorpay-signature': 'f'.repeat(64) })).toBeNull();
    expect(razorpay().parseWebhook(raw, { 'content-type': 'application/json' })).toBeNull();
    // One byte changed after signing.
    const tampered = Buffer.from(raw.toString().replace('64900', '64901'));
    expect(razorpay().parseWebhook(tampered, headers)).toBeNull();
  });

  it("payment.captured is applied as it stands, keyed on Razorpay's event id", () => {
    const { raw, headers } = webhook('payment.captured', { payment: { entity: PAYMENT } });
    const event = razorpay().parseWebhook(raw, headers);
    expect(event).toMatchObject({
      id: 'evt_1',
      type: 'payment.captured',
      payment: {
        id: 'pay_DESlfW9H8K9uqM',
        orderId: 'order_DESlLckIVRkHWj',
        amountPaise: 64_900n,
        status: 'captured',
        method: 'upi',
        capturedAt: new Date(1567674606 * 1000),
      },
    });
  });

  it('order.paid carries the same capture', () => {
    const { raw, headers } = webhook('order.paid', { payment: { entity: PAYMENT }, order: { entity: { id: 'order_DESlLckIVRkHWj' } } }, 'evt_2');
    expect(razorpay().parseWebhook(raw, headers)).toMatchObject({ id: 'evt_2', type: 'payment.captured' });
  });

  it('payment.failed carries the failure reason', () => {
    const { raw, headers } = webhook('payment.failed', { payment: { entity: FAILED } });
    expect(razorpay().parseWebhook(raw, headers)).toMatchObject({
      type: 'payment.failed',
      payment: { id: 'pay_DEAU825sJlCbGa', status: 'failed', failureReason: 'Payment failed', capturedAt: null },
    });
  });

  it('refund.processed and refund.failed carry the refund', () => {
    const processed = webhook('refund.processed', { refund: { entity: { ...REFUND, status: 'processed' } }, payment: { entity: PAYMENT } });
    expect(razorpay().parseWebhook(processed.raw, processed.headers)).toEqual({
      id: 'evt_1',
      type: 'refund.processed',
      refund: { id: 'rfnd_FP8QHiV938haTz', paymentId: 'pay_DESlfW9H8K9uqM', amountPaise: 50_000n, status: 'processed' },
    });
    const failed = webhook('refund.failed', { refund: { entity: { ...REFUND, status: 'failed' } } });
    expect(razorpay().parseWebhook(failed.raw, failed.headers)).toMatchObject({ type: 'refund.failed' });
  });

  it('anything else is ignored, not refused', () => {
    const { raw, headers } = webhook('payment.authorized', { payment: { entity: { ...PAYMENT, status: 'authorized' } } });
    expect(razorpay().parseWebhook(raw, headers)).toEqual({ id: 'evt_1', type: 'ignored', providerType: 'payment.authorized' });
  });

  it('a signed payload of an unknown shape is ignored, not refused', () => {
    const { raw, headers } = webhook('payment.captured', { payment: { entity: { ...PAYMENT, amount: 'lots' } } });
    expect(razorpay().parseWebhook(raw, headers)).toMatchObject({ type: 'ignored', providerType: 'payment.captured' });
  });

  it('without an event id header, the id is still stable for one event', () => {
    const { raw, headers } = webhook('payment.captured', { payment: { entity: PAYMENT } }, null);
    expect(razorpay().parseWebhook(raw, headers)?.id).toBe('payment.captured:pay_DESlfW9H8K9uqM');
  });
});
