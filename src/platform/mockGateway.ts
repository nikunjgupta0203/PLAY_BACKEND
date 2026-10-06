/**
 * PAYMENT_PROVIDER=mock — development only (config refuses it in production).
 *
 * Every order is paid the moment anyone asks the gateway about it, every refund
 * is processed, and nothing leaves the machine. It exists so a whole paid flow
 * (enter, pay, refund, payout) can be run end to end locally — by a person in
 * the app, or a script — without a Razorpay test account. The app pairs it with
 * EXPO_PUBLIC_MOCK_GATEWAY=1, whose checkout reports success; the server then
 * settles through the normal reconciliation path (`refreshPayment`).
 *
 * Stateless on purpose: the order id carries its amount, so the API and worker
 * processes (and a restart) agree without sharing memory.
 */
import { randomBytes } from 'node:crypto';
import type { GatewayPayment, GatewayRefund, PaymentGateway } from './paymentGateway.js';

/** What the mock gateway "keeps" on a payment: 2% plus 18% GST on it, like Razorpay's standard rate. */
export const MOCK_FEE_BPS = 236;

const amountOf = (gatewayOrderId: string): bigint => {
  const m = /^order_MOCK_(\d+)_/.exec(gatewayOrderId);
  return m ? BigInt(m[1]!) : 0n;
};

export function createMockGateway(publicApiUrl: string): PaymentGateway {
  return {
    name: 'mock',
    async createOrder(input) {
      return {
        id: `order_MOCK_${input.amountPaise}_${randomBytes(6).toString('hex')}`,
        amountPaise: input.amountPaise,
        currency: input.currency,
        status: 'created',
      } as Awaited<ReturnType<PaymentGateway['createOrder']>>;
    },
    checkoutForm(input) {
      return {
        action: `${publicApiUrl}/mock-checkout`,
        fields: { order_id: input.gatewayOrderId, amount: String(input.amountPaise) },
      } as ReturnType<PaymentGateway['checkoutForm']>;
    },
    async paymentsForOrder(orderId): Promise<GatewayPayment[]> {
      const amountPaise = amountOf(orderId);
      const id = `pay_MOCK_${orderId.slice(-12)}`;
      const fee = Number((amountPaise * BigInt(MOCK_FEE_BPS)) / 10_000n);
      return [
        {
          id,
          orderId,
          amountPaise,
          status: 'captured',
          method: 'upi',
          failureReason: null,
          capturedAt: new Date(),
          raw: { id, order_id: orderId, status: 'captured', method: 'upi', fee, mock: true },
        },
      ];
    },
    async refund(input): Promise<GatewayRefund> {
      return {
        id: `rfnd_MOCK_${input.idempotencyKey.slice(-12)}_${randomBytes(3).toString('hex')}`,
        paymentId: input.paymentId,
        amountPaise: input.amountPaise,
        status: 'processed',
      };
    },
    async refundStatus(gatewayRefundId): Promise<GatewayRefund> {
      return { id: gatewayRefundId, paymentId: '', amountPaise: 0n, status: 'processed' };
    },
    parseWebhook: () => null,
  };
}
