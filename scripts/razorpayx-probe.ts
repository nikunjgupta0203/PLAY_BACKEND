/**
 * Probes RazorpayX in TEST mode through the adapter, the way
 * scripts/razorpay-probe.ts does for collection. Run by hand; never in CI.
 * Prints every raw response so the adapter's assumptions (the balance list,
 * validation result fields, payout status spellings, lookup by reference_id)
 * are checked against the real thing, not the docs.
 *
 *   RAZORPAYX_KEY_ID=rzp_test_… RAZORPAYX_KEY_SECRET=… RAZORPAYX_ACCOUNT_NUMBER=… \
 *     pnpm tsx scripts/razorpayx-probe.ts
 *
 * Not yet run: waiting on RazorpayX test credentials. When it runs, pin each
 * response in src/platform/payouts/razorpayx.test.ts.
 */
import { createRazorpayXPayouts } from '../src/platform/payouts/razorpayx.js';

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const keyId = env('RAZORPAYX_KEY_ID');
if (!keyId.startsWith('rzp_test_')) throw new Error('the probe only runs with a test key (rzp_test_…)');

const rawFetch: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.clone().text();
  console.log(`\n${init?.method ?? 'GET'} ${String(url)} → ${res.status}\n${text.slice(0, 4000)}`);
  return res;
};

const provider = createRazorpayXPayouts({
  keyId,
  keySecret: env('RAZORPAYX_KEY_SECRET'),
  accountNumber: env('RAZORPAYX_ACCOUNT_NUMBER'),
  webhookSecret: 'unused-by-the-probe',
  fetch: rawFetch,
});

const ref = `probe-${Date.now()}`;
// Razorpay's documented test beneficiary.
const bank = { accountNumber: '765432123456789', ifsc: 'HDFC0000053', name: 'Gaurav Kumar' };

console.log('balance', await provider.availablePaise());
console.log('verify', await provider.verifyAccount({ ...bank, ref: `v-${ref}` }));
console.log('transfer', await provider.transfer({ ...bank, ref, amountPaise: 100n, mode: 'IMPS', purpose: 'PL4Y probe' }));
console.log('status', await provider.transferStatus(ref));
