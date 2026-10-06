import { describe, expect, it } from 'vitest';
import { createMockGateway, MOCK_FEE_BPS } from './mockGateway.js';

describe('mock payment gateway (development only)', () => {
  const gw = createMockGateway('http://localhost:4000');

  it('pays an order the moment it is asked about, for the order’s amount, with a fee', async () => {
    const order = await gw.createOrder({ amountPaise: 50_000n, currency: 'INR', receipt: 'r1' });
    const [payment] = await gw.paymentsForOrder(order.id);
    expect(payment).toMatchObject({ orderId: order.id, amountPaise: 50_000n, status: 'captured' });
    expect((payment!.raw as { fee: number }).fee).toBe(Number((50_000n * BigInt(MOCK_FEE_BPS)) / 10_000n));
  });

  it('processes every refund and ignores webhooks', async () => {
    const r = await gw.refund({ paymentId: 'pay_x', amountPaise: 100n, idempotencyKey: 'k1' });
    expect(r.status).toBe('processed');
    expect((await gw.refundStatus(r.id)).status).toBe('processed');
    expect(gw.parseWebhook(Buffer.from('{}'), {})).toBeNull();
  });
});
