/**
 * Payment gateway port (payments R2, R9). The ONLY place a gateway is spoken to
 * and the ONLY place its secrets are used — no module imports an SDK, so
 * plugging in a provider is one adapter that implements `PaymentGateway`.
 *
 * Everything the payments service sees is normalised here: amounts in paise as
 * bigint (conventions.md §2), gateway ids as opaque strings, webhook deliveries
 * as `GatewayWebhookEvent`. A provider's own payload shapes never leave its
 * adapter.
 *
 * The provider is Razorpay (`razorpay/adapter.ts`, PAYMENT_PROVIDER=razorpay).
 * Until it is configured `unconfiguredGateway` runs: free entries confirm
 * without it (registration R18), and a paid checkout gets GATEWAY_UNAVAILABLE
 * instead of an order that nothing could ever capture.
 */
import { config } from './config.js';
import { GatewayError } from './gatewayError.js';
import { createMockGateway } from './mockGateway.js';
import { createRazorpay, type RazorpayGateway } from './razorpay/adapter.js';

// Its own module so an adapter can throw it without importing this file,
// which imports the adapter (an import cycle that breaks under Vitest).
export { GatewayError };

export interface GatewayOrder {
  id: string;
  amountPaise: bigint;
  currency: string;
  status: string;
}

export interface GatewayPayment {
  id: string;
  orderId: string | null;
  amountPaise: bigint;
  /** Normalised: 'captured' and 'failed' drive the state machine; anything else is in flight. */
  status: string;
  method: string | null;
  failureReason: string | null;
  capturedAt: Date | null;
  /** payments R10 — the provider's own payload, kept as dispute evidence. */
  raw: unknown;
}

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amountPaise: bigint;
  /** pending | processed | failed */
  status: string;
}

/** What the client POSTs to open checkout (Razorpay: our page that hosts it). Never contains a secret. */
export interface CheckoutForm {
  action: string;
  fields: Record<string, string>;
}

export interface Payer {
  name: string;
  email: string;
  phone: string | null;
}

/**
 * One webhook delivery, verified and normalised. `type` is ours, not the
 * provider's: an adapter maps its event names onto these four and reports
 * anything else as `ignored`.
 */
export type GatewayWebhookEvent =
  | { id: string; type: 'payment.captured' | 'payment.failed'; payment: GatewayPayment }
  | { id: string; type: 'refund.processed' | 'refund.failed'; refund: GatewayRefund }
  /** A payment notice: ask the provider (`paymentsForOrder`), never trust the body beyond its signed txnid. */
  | {
      id: string;
      type: 'payment.check';
      gatewayOrderId: string;
      /**
       * The notice's own (signed) status, normalised. A `success`/`failure`
       * the provider does not yet report as final makes the job retry.
       */
      status: 'success' | 'failure' | 'other';
    }
  /** An unsigned refund notice: ask the provider (`refundStatus`), never trust the body. */
  | { id: string; type: 'refund.check'; gatewayRefundId: string }
  | { id: string; type: 'ignored'; providerType: string };

export interface PaymentGateway {
  /** Shown in logs, e.g. 'none', 'razorpay'. */
  readonly name: string;
  createOrder(input: {
    amountPaise: bigint;
    currency: string;
    /** Our payment_orders.id, so an order is traceable from either side. */
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder>;
  /**
   * The form the client posts to open checkout. Pure — no network — so a
   * reused open order gets a fresh form for the same order id.
   */
  checkoutForm(input: {
    gatewayOrderId: string;
    amountPaise: bigint;
    /** Our payment_orders.id, for providers that echo a reference back. */
    receipt: string;
    payer: Payer;
    description: string;
  }): CheckoutForm;
  /** payments R9 — reconciliation asks the gateway what actually happened. */
  paymentsForOrder(orderId: string): Promise<GatewayPayment[]>;
  refund(input: {
    paymentId: string;
    amountPaise: bigint;
    /** Sent to the provider so a retried request never refunds twice (R7). */
    idempotencyKey: string;
  }): Promise<GatewayRefund>;
  /** The provider's current view of a refund we sent. */
  refundStatus(gatewayRefundId: string): Promise<GatewayRefund>;
  /**
   * payments R2 — verify the signature over the EXACT bytes received and
   * normalise the delivery. Returns null when the signature (or the body) is
   * bad, which the route answers with a 400 and no write.
   */
  parseWebhook(
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): GatewayWebhookEvent | null;
}

const notConfigured = (): never => {
  throw new GatewayError(503, 'No payment gateway is configured');
};

/** What runs until a provider adapter is written and wired in below. */
export const unconfiguredGateway: PaymentGateway = {
  name: 'none',
  createOrder: async () => notConfigured(),
  checkoutForm: () => notConfigured(),
  paymentsForOrder: async () => notConfigured(),
  refund: async () => notConfigured(),
  refundStatus: async () => notConfigured(),
  parseWebhook: () => null,
};

/** Set when PAYMENT_PROVIDER=razorpay: the checkout routes need its page and verifier. */
export const razorpay: RazorpayGateway | null =
  config.PAYMENT_PROVIDER === 'razorpay'
    ? createRazorpay({
        keyId: config.RAZORPAY_KEY_ID,
        keySecret: config.RAZORPAY_KEY_SECRET,
        webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
        publicApiUrl: config.PUBLIC_API_URL,
      })
    : null;

/** The gateway the app runs against. */
export const paymentGateway: PaymentGateway =
  razorpay ??
  (config.PAYMENT_PROVIDER === 'mock' ? createMockGateway(config.PUBLIC_API_URL) : unconfiguredGateway);

/** False until a provider is wired — the webhook route answers 503 meanwhile. */
export const gatewayConfigured = (): boolean => paymentGateway !== unconfiguredGateway;
