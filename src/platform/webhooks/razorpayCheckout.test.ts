import express from 'express';
import helmet from 'helmet';
import { describe, expect, it, vi } from 'vitest';
import { createRazorpayCheckoutRouter } from './razorpayCheckout.js';

type Gw = Parameters<typeof createRazorpayCheckoutRouter>[0];

async function call(gw: Gw, path: string, body?: Record<string, string>) {
  const app = express();
  app.use(helmet());
  app.use(createRazorpayCheckoutRouter(gw));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      body: body ? new URLSearchParams(body) : undefined,
      redirect: 'manual',
    });
  } finally {
    server.close();
  }
}

const gw = (over: Partial<NonNullable<Gw>> = {}): NonNullable<Gw> => ({
  checkoutPage: vi.fn(() => '<!doctype html><p>checkout</p>'),
  verifyCheckout: vi.fn(() => true),
  ...over,
});

describe('razorpay checkout routes', () => {
  it('serves the checkout page without a CSP and uncached', async () => {
    const res = await call(gw(), '/payments/razorpay/checkout', { key: 'rzp_test_1', order_id: 'order_1' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('checkout');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('fields that are not a checkout form go straight to done as a failure', async () => {
    const res = await call(gw({ checkoutPage: vi.fn(() => null) }), '/payments/razorpay/checkout', { key: 'x' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/payments/razorpay/done?status=failure&reason=checkout');
  });

  it('a verified return redirects to done?status=success with the payment id', async () => {
    const res = await call(gw(), '/payments/razorpay/return', {
      razorpay_payment_id: 'pay_1',
      razorpay_order_id: 'order_1',
      razorpay_signature: 'sig',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/payments/razorpay/done?status=success&payment_id=pay_1');
  });

  it('a tampered return is a failure, never a success', async () => {
    const res = await call(gw({ verifyCheckout: vi.fn(() => false) }), '/payments/razorpay/return', {
      razorpay_payment_id: 'pay_1',
      razorpay_order_id: 'order_1',
      razorpay_signature: 'bad',
    });
    expect(res.headers.get('location')).toBe('/payments/razorpay/done?status=failure&reason=signature');
  });

  it("Razorpay's failure post (no signature) is a failure", async () => {
    const res = await call(gw({ verifyCheckout: vi.fn(() => false) }), '/payments/razorpay/return', {
      'error[code]': 'BAD_REQUEST_ERROR',
      'error[description]': 'Payment failed',
    });
    expect(res.headers.get('location')).toBe('/payments/razorpay/done?status=failure&reason=payment_failed');
  });

  it('done serves a plain page', async () => {
    const res = await call(null, '/payments/razorpay/done?status=success');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('close this');
  });

  it('with Razorpay not configured, checkout and return are 503s', async () => {
    expect((await call(null, '/payments/razorpay/checkout', {})).status).toBe(503);
    expect((await call(null, '/payments/razorpay/return', {})).status).toBe(503);
  });
});
