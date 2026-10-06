/**
 * Probes Razorpay's API in TEST mode through the adapter and prints every raw
 * response, so the adapter's assumptions (field names, status spellings, the
 * refund receipt lookup) are checked against the real thing, not the docs.
 * Run by hand; never in CI. Needs an rzp_test_ key pair.
 *
 *   RAZORPAY_KEY_ID=rzp_test_… RAZORPAY_KEY_SECRET=… pnpm tsx scripts/razorpay-probe.ts order 64900
 *   … razorpay-probe.ts payments <order_id>
 *   … razorpay-probe.ts refund <payment_id> <paise> <idempotency-key>
 *   … razorpay-probe.ts refund-status <refund_id>
 *
 * To get a payment to refund: run `order`, pay it in test mode (card
 * 4111 1111 1111 1111, or success@razorpay for UPI) by opening the app against
 * a backend with these keys, then `payments` shows the payment id.
 */
import { createRazorpay } from '../src/platform/razorpay/adapter.js';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const keyId = env('RAZORPAY_KEY_ID');
if (!keyId.startsWith('rzp_test_')) throw new Error('the probe only runs with a test key (rzp_test_…)');

const rawFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.clone().text();
  console.log(`\n${init?.method ?? 'GET'} ${String(url)} → ${res.status}\n${text.slice(0, 4000)}`);
  return res;
};

const gw = createRazorpay({
  keyId,
  keySecret: env('RAZORPAY_KEY_SECRET'),
  webhookSecret: 'unused-by-the-probe',
  publicApiUrl: 'https://probe.invalid',
  fetch: rawFetch,
});

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'order') {
  console.log(await gw.createOrder({ amountPaise: BigInt(a ?? '100'), currency: 'INR', receipt: `probe${Date.now()}` }));
} else if (cmd === 'payments') {
  console.log(await gw.paymentsForOrder(a!));
} else if (cmd === 'refund') {
  console.log(await gw.refund({ paymentId: a!, amountPaise: BigInt(b!), idempotencyKey: c! }));
} else if (cmd === 'refund-status') {
  console.log(await gw.refundStatus(a!));
} else {
  throw new Error('usage: order <paise> | payments <order_id> | refund <payment_id> <paise> <key> | refund-status <refund_id>');
}
