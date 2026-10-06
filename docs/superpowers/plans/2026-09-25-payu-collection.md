# PayU Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players pay for paid entries in the PL4Y player app through PayU's hosted checkout, and entries confirm through the existing webhook and reconciliation paths.

**Architecture:** A PayU adapter (`src/platform/payu/`) implements the existing `PaymentGateway` port; the payments service is unchanged except that it asks the port for a signed `CheckoutForm` and learns refund outcomes by asking PayU (`refundStatus`) instead of trusting refund webhooks. The player app gets a `PayUGateway` behind its existing checkout seam: a modal WebView that auto-posts the signed form, hands UPI app links to the OS, and closes on our return URL.

**Tech Stack:** Node 22 + TypeScript + Express 5 + Prisma + BullMQ + vitest (backend, `PALY_BACKEND`); Expo 57 / React Native 0.86 + jest-expo + `react-native-webview` (app, `PLAY_FRONTEND/apps/player`).

**Spec:** `PALY_BACKEND/docs/superpowers/specs/2026-09-25-payu-collection-design.md`

**One deliberate deviation from the spec's port sketch:** the spec put `checkout` on `GatewayOrder`. The service reuses an open order on a double-tapped Pay (`repo.openOrderFor`) without calling `createOrder`, and a reused order still needs a freshly signed form. So the port gets a separate pure method `checkoutForm(...)` that the service calls for both new and reused orders. Behaviour is identical to the spec.

## Global Constraints

- The PayU salt is read only inside `src/platform/payu/`; it never appears in `fields`, logs, GraphQL or the app.
- `payments R5` holds: only a verified `payment.captured` webhook or reconciliation confirms a registration. The return route and the app's result change nothing in the database.
- `payments R3`: a duplicate webhook is a 200 with no work — event ids must be stable across PayU's retries.
- `payments R7`: refunds send `idempotencyKey` to PayU as `token`.
- Money is `bigint` paise everywhere except the adapter edge, where PayU wants rupees as a decimal string (`"590.00"`). No floating-point arithmetic on money.
- `PAYMENT_PROVIDER` unset ⇒ behaviour identical to today (`unconfiguredGateway`, `GATEWAY_UNAVAILABLE` on paid checkout).
- PayU endpoints — test: `https://test.payu.in/_payment`, `https://test.payu.in/merchant/postservice.php?form=2`; prod: `https://secure.payu.in/_payment`, `https://info.payu.in/merchant/postservice.php?form=2`.
- Request hash: `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)`.
- Response hash: `sha512([additionalCharges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`.
- Postservice hash: `sha512(key|command|var1|SALT)`.
- Return path the app watches for: `/payments/payu/done` (matched by **path**, not host).
- App client never computes or checks a hash.
- Backend commands run from `PALY_BACKEND`; app commands from `PLAY_FRONTEND/apps/player`. Backend integration tests (`tests/*.test.ts`) need Docker running (testcontainers).

## Review Focus

1. **A `|` or odd characters in a player's name, email or event title** — PayU's hashes are pipe-joined, so a `|` would make our hash disagree with PayU's and every payment by that player would fail. Expect: fields are sanitised before signing (Task 1 test `sanitises pipes and trims to PayU limits`).
2. **Amounts that are not whole rupees or arrive without decimals** (`5` paise, `"590"`, `"590.5"`) — expect exact paise both ways with no float drift (Task 1 tests `toRupees` / `toPaise`).
3. **Player taps Pay twice, or comes back to Pay after dismissing** — the reused open order must still get a valid, freshly signed form with the same `txnid` (Task 4 test `a reused open order gets a fresh signed form for the same txnid`).
4. **PayU retries the same webhook** — same event id each time so R3 dedupes (Task 3 test `event id is stable across PayU retries`).
5. **Dev/staging where the app's API host differs from `PUBLIC_API_URL`** — the app must still recognise the return URL by path (Task 8 test `recognises the done path on any host`).

---

## File Structure

Backend (`PALY_BACKEND`):
- Create `src/platform/payu/hash.ts` — pure: hashes, amount conversion, field sanitising.
- Create `src/platform/payu/adapter.ts` — `createPayU(opts)`: the `PaymentGateway` + `verifyResponse` for PayU, over `fetch`.
- Create `src/platform/payu/hash.test.ts`, `src/platform/payu/adapter.test.ts` — unit tests (no Docker).
- Create `src/platform/payu/fixtures.ts` — recorded/sample PayU responses used by adapter tests.
- Create `scripts/payu-probe.ts` — one-off sandbox probe that records real responses.
- Create `src/platform/webhooks/payuReturn.ts` (+ `payuReturn.test.ts`) — the return and done routes.
- Modify `src/platform/paymentGateway.ts` — port changes; provider selection.
- Modify `src/platform/config.ts` — PayU config.
- Modify `src/app.ts` — mount return routes.
- Modify `src/modules/payments/service/index.ts`, `src/modules/payments/index.ts`, `src/modules/payments/schema/index.ts` — checkout form, payer, refund check.
- Modify `src/modules/identity/service/index.ts` — `contactsByIds` returns `phone`.
- Modify `tests/helpers/modules.ts`, `tests/payments.test.ts` — fake gateway and tests.
- Modify `docs/modules/07-payments.md`, `.env.example` — R2 amendment, config.

App (`PLAY_FRONTEND/apps/player`):
- Modify `src/features/checkout/api.ts`, `gateway/PaymentGateway.ts`, `gateway/index.ts`, `gateway/MockGateway.tsx` (+ test), `screens/PayScreen.tsx` (+ test).
- Create `src/features/checkout/gateway/payuNavigation.ts` (+ test) — pure URL classification and auto-submit HTML.
- Create `src/features/checkout/gateway/PayUGateway.tsx` (+ test) — the modal WebView gateway and its host.
- Modify `src/features/checkout/index.ts`, `app/(app)/_layout.tsx`, `src/config/env.ts`, `src/core/copy.ts`, `app.json`, `package.json`.

---

### Task 0: Branches

- [ ] **Step 1: Create a feature branch in each repo**

The backend and frontend `main` branches also hold uncommitted notification work from earlier in this session. Ask the user whether to commit it first; do not mix it into these commits.

```bash
git -C PALY_BACKEND switch -c feat/payu-collection
git -C PLAY_FRONTEND switch -c feat/payu-collection
```

Every commit below stages **only the files that task names**.

---

### Task 1: PayU config and pure hashing

**Files:**
- Create: `PALY_BACKEND/src/platform/payu/hash.ts`
- Test: `PALY_BACKEND/src/platform/payu/hash.test.ts`
- Modify: `PALY_BACKEND/src/platform/config.ts` (schema object, near the `PUSH_TRANSPORT` lines ~112, and the `.refine` chain)
- Modify: `PALY_BACKEND/.env.example`

**Interfaces:**
- Produces:
  - `toRupees(paise: bigint): string`
  - `toPaise(rupees: string): bigint`
  - `clean(value: string, max: number): string`
  - `requestHash(f: PayURequestFields, salt: string): string`
  - `responseHash(f: PayUResponseFields, salt: string): string`
  - `postserviceHash(key: string, command: string, var1: string, salt: string): string`
  - `safeEqual(a: string, b: string): boolean`
  - `interface PayURequestFields { key; txnid; amount; productinfo; firstname; email; udf1?; udf2?; udf3?; udf4?; udf5? }` (all `string`)
  - `interface PayUResponseFields extends PayURequestFields { status: string; additionalCharges?: string }`
  - config keys `PAYMENT_PROVIDER: 'none' | 'payu'`, `PAYU_KEY`, `PAYU_SALT`, `PAYU_ENV: 'test' | 'prod'`, `PUBLIC_API_URL`

- [ ] **Step 1: Write the failing test**

`src/platform/payu/hash.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clean, postserviceHash, requestHash, responseHash, safeEqual, toPaise, toRupees } from './hash.js';

const sha = (s: string) => createHash('sha512').update(s).digest('hex');
const base = { key: 'k', txnid: 't', amount: '590.00', productinfo: 'Open', firstname: 'Asha', email: 'a@b.c' };

describe('payu hash', () => {
  it('request hash is key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||SALT', () => {
    expect(requestHash({ ...base, udf1: 'u1' }, 'SALT')).toBe(
      sha('k|t|590.00|Open|Asha|a@b.c|u1' + '|'.repeat(10) + 'SALT'),
    );
  });

  it('response hash is the reverse order, salt and status first', () => {
    expect(responseHash({ ...base, udf1: 'u1', status: 'success' }, 'SALT')).toBe(
      sha('SALT|success' + '|'.repeat(10) + 'u1|a@b.c|Asha|Open|590.00|t|k'),
    );
  });

  it('response hash is prefixed with additionalCharges when PayU sends them', () => {
    expect(responseHash({ ...base, status: 'success', additionalCharges: '10.00' }, 'SALT')).toBe(
      sha('10.00|SALT|success' + '|'.repeat(11) + 'a@b.c|Asha|Open|590.00|t|k'),
    );
  });

  it('postservice hash is key|command|var1|SALT', () => {
    expect(postserviceHash('k', 'verify_payment', 't', 'SALT')).toBe(sha('k|verify_payment|t|SALT'));
  });

  it('toRupees formats paise exactly', () => {
    expect(toRupees(59_000n)).toBe('590.00');
    expect(toRupees(5n)).toBe('0.05');
    expect(toRupees(100_000_00n)).toBe('100000.00');
  });

  it('toPaise parses PayU amounts without float drift', () => {
    expect(toPaise('590.00')).toBe(59_000n);
    expect(toPaise('590')).toBe(59_000n);
    expect(toPaise('590.5')).toBe(59_050n);
    expect(toPaise('0.05')).toBe(5n);
    expect(() => toPaise('abc')).toThrow();
  });

  it('sanitises pipes and trims to PayU limits', () => {
    expect(clean('  Asha | Rao  ', 60)).toBe('Asha Rao');
    expect(clean('x'.repeat(150), 100)).toHaveLength(100);
  });

  it('safeEqual compares in constant time and rejects length mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/platform/payu/hash.test.ts`
Expected: FAIL — cannot resolve `./hash.js`.

- [ ] **Step 3: Implement `hash.ts`**

```ts
/**
 * PayU hashing (docs.payu.in — Generate Hash for PayU Hosted Checkout).
 * Pure: no config, no network. The salt is passed in by the adapter, which is
 * the only caller that holds it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface PayURequestFields {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

export interface PayUResponseFields extends PayURequestFields {
  status: string;
  additionalCharges?: string;
}

const sha512 = (s: string) => createHash('sha512').update(s, 'utf8').digest('hex');
const udfs = (f: PayURequestFields) => [f.udf1 ?? '', f.udf2 ?? '', f.udf3 ?? '', f.udf4 ?? '', f.udf5 ?? ''];

export function requestHash(f: PayURequestFields, salt: string): string {
  return sha512(
    [f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email, ...udfs(f), '', '', '', '', '', salt].join('|'),
  );
}

export function responseHash(f: PayUResponseFields, salt: string): string {
  const parts = [
    salt,
    f.status,
    '', '', '', '', '',
    ...udfs(f).reverse(),
    f.email,
    f.firstname,
    f.productinfo,
    f.amount,
    f.txnid,
    f.key,
  ];
  if (f.additionalCharges) parts.unshift(f.additionalCharges);
  return sha512(parts.join('|'));
}

export function postserviceHash(key: string, command: string, var1: string, salt: string): string {
  return sha512([key, command, var1, salt].join('|'));
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Paise → PayU's rupee string. Integer arithmetic only. */
export function toRupees(paise: bigint): string {
  const rupees = paise / 100n;
  const rest = (paise % 100n).toString().padStart(2, '0');
  return `${rupees}.${rest}`;
}

/** PayU's rupee string → paise. Throws on anything that is not a plain decimal. */
export function toPaise(rupees: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(rupees.trim());
  if (!m) throw new Error(`not a PayU amount: ${rupees}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/**
 * A `|` inside a field shifts every hash position after it, so PayU's hash and
 * ours disagree and the payment fails. Pipes go, whitespace collapses, and the
 * value is cut to PayU's field limit.
 */
export function clean(value: string, max: number): string {
  return value.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/platform/payu/hash.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Add config**

In `src/platform/config.ts`, replace the comment lines

```ts
  //    Payment gateway keys land here with the provider adapter
  //    (platform/paymentGateway.ts).
```

with:

```ts
  // payments — the provider behind platform/paymentGateway.ts. `none` keeps
  // the unconfigured gateway: free entries confirm, paid checkout is
  // GATEWAY_UNAVAILABLE.
  PAYMENT_PROVIDER: z.enum(['none', 'payu']).default('none'),
  PAYU_KEY: z.string().default(''),
  PAYU_SALT: z.string().default(''),
  PAYU_ENV: z.enum(['test', 'prod']).default('test'),
  // The backend's public origin. PayU posts the player back to
  // `${PUBLIC_API_URL}/payments/payu/return`, so it must be reachable from a phone.
  PUBLIC_API_URL: z.string().default(''),
```

Add to the `.refine` chain (after the existing refines, before the final `)` / `;` of the schema):

```ts
.refine(
  (c) => c.PAYMENT_PROVIDER !== 'payu' || (c.PAYU_KEY !== '' && c.PAYU_SALT !== '' && /^https?:\/\//.test(c.PUBLIC_API_URL)),
  { path: ['PAYMENT_PROVIDER'], message: 'payu needs PAYU_KEY, PAYU_SALT and PUBLIC_API_URL' },
)
```

Append to `.env.example`:

```
# payments — none | payu. With payu, all three below are required.
PAYMENT_PROVIDER=none
PAYU_KEY=
PAYU_SALT=
PAYU_ENV=test
# Public origin of this API (PayU posts the player back here). In dev, an ngrok URL.
PUBLIC_API_URL=
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no output.

```bash
git add src/platform/payu/hash.ts src/platform/payu/hash.test.ts src/platform/config.ts .env.example
git commit -m "feat(payments): PayU hashing and config"
```

---

### Task 2: Sandbox probe — confirm PayU's real shapes

The spec requires confirming the `txnid` length cap and the `postservice` response shapes against the test environment before the adapter depends on them. This task needs the team's PayU **test** key and salt in `.env`. If they are not available, skip to Task 3 and use the sample fixtures as written; mark the probe as outstanding in the final report.

**Files:**
- Create: `PALY_BACKEND/scripts/payu-probe.ts`
- Create: `PALY_BACKEND/src/platform/payu/fixtures.ts`

**Interfaces:**
- Consumes: `postserviceHash`, `toRupees` from Task 1.
- Produces: `fixtures.ts` exports `VERIFY_SUCCESS`, `VERIFY_NOT_FOUND`, `REFUND_QUEUED`, `REFUND_STATUS_SUCCESS` (plain JSON objects) used by Task 3 tests.

- [ ] **Step 1: Write the sample fixtures**

`src/platform/payu/fixtures.ts` — shapes as documented by PayU; Step 3 replaces values with recorded ones if they differ.

```ts
/**
 * PayU postservice responses. Recorded from the test environment by
 * scripts/payu-probe.ts where marked; otherwise PayU's documented shape.
 */
export const VERIFY_SUCCESS = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    txn_ABC123: {
      mihpayid: '403993715521',
      txnid: 'txn_ABC123',
      amt: '590.00',
      transaction_amount: '590.00',
      mode: 'UPI',
      status: 'success',
      unmappedstatus: 'captured',
      error_Message: 'No Error',
      udf1: 'order-1',
      addedon: '2026-09-25 10:00:00',
    },
  },
};

export const VERIFY_NOT_FOUND = {
  status: 0,
  msg: '0 out of 1 Transactions Fetched Successfully',
  transaction_details: { txn_NONE: { mihpayid: 'Not Found', status: 'Not Found' } },
};

export const REFUND_QUEUED = {
  status: 1,
  msg: 'Refund Request Queued',
  request_id: '133000001',
  bank_ref_num: null,
  mihpayid: 403993715521,
  error_code: 102,
};

export const REFUND_STATUS_SUCCESS = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    '133000001': {
      '133000001': { mihpayid: '403993715521', amt: '590.00', action: 'refund', status: 'success' },
    },
  },
};
```

- [ ] **Step 2: Write the probe script**

`scripts/payu-probe.ts`:

```ts
/**
 * One-off: talks to PayU's TEST environment and prints raw responses, so the
 * adapter's fixtures match reality. Needs PAYU_KEY/PAYU_SALT (test) in .env.
 *
 *   npx tsx --env-file=.env scripts/payu-probe.ts verify <txnid>
 *   npx tsx --env-file=.env scripts/payu-probe.ts refund <mihpayid> <token> <rupees>
 *   npx tsx --env-file=.env scripts/payu-probe.ts refund-status <request_id>
 */
import { postserviceHash } from '../src/platform/payu/hash.js';

const key = process.env.PAYU_KEY ?? '';
const salt = process.env.PAYU_SALT ?? '';
if (!key || !salt) throw new Error('PAYU_KEY and PAYU_SALT (test) are required');
const url = 'https://test.payu.in/merchant/postservice.php?form=2';

async function call(command: string, var1: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({ key, command, var1, hash: postserviceHash(key, command, var1, salt), ...extra });
  const res = await fetch(url, { method: 'POST', body });
  console.log(res.status, await res.text());
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'verify') await call('verify_payment', a!);
else if (cmd === 'refund') await call('cancel_refund_transaction', a!, { var2: b!, var3: c! });
else if (cmd === 'refund-status') await call('check_action_status', a!);
else throw new Error('usage: verify <txnid> | refund <mihpayid> <token> <rupees> | refund-status <request_id>');
```

- [ ] **Step 3: Probe and record (manual, needs test keys)**

1. Make one test payment on PayU's test hosted page with a txnid of **25** characters, then one with **26**. Record which is accepted — that is the cap. The adapter uses 20 characters; if the cap is below 20, change `TXNID_LENGTH` in Task 3.
2. Make one test payment with the `phone` field **omitted**. If PayU rejects it, stop and tell the user: players without a phone on file cannot pay, and the spec needs a decision (collect the phone on the Pay screen).
3. `verify <that txnid>`, `verify txn_does_not_exist`, `refund <mihpayid> probe-token-1 1.00`, the same refund again (records the duplicate-token behaviour), and `refund-status <request_id>`.
4. Replace the values in `fixtures.ts` with the recorded JSON (keep the export names), and change the header comment to "Recorded from the PayU test environment on <date>". If a **shape** differs from the samples (field names, nesting), update the matching normaliser in Task 3 to fit the recording.

- [ ] **Step 4: Commit**

```bash
git add scripts/payu-probe.ts src/platform/payu/fixtures.ts
git commit -m "chore(payments): PayU sandbox probe and response fixtures"
```

---

### Task 3: Port changes and the PayU adapter

**Files:**
- Modify: `PALY_BACKEND/src/platform/paymentGateway.ts`
- Create: `PALY_BACKEND/src/platform/payu/adapter.ts`
- Test: `PALY_BACKEND/src/platform/payu/adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 hash functions; Task 2 fixtures.
- Produces (in `paymentGateway.ts`):

```ts
export interface CheckoutForm { action: string; fields: Record<string, string> }
export interface Payer { name: string; email: string; phone: string | null }

// PaymentGateway, changed:
//   - `publicKey` REMOVED
//   - createOrder(input: { amountPaise; currency; receipt; notes? }): Promise<GatewayOrder>   (unchanged shape)
//   - NEW checkoutForm(input: { gatewayOrderId: string; amountPaise: bigint; receipt: string; payer: Payer; description: string }): CheckoutForm
//   - NEW refundStatus(gatewayRefundId: string): Promise<GatewayRefund>
// GatewayWebhookEvent gains: | { id: string; type: 'refund.check'; gatewayRefundId: string }
```

- Produces (in `adapter.ts`):

```ts
export interface PayUGateway extends PaymentGateway {
  /** Verifies PayU's response hash over posted fields (return route, webhook). */
  verifyResponse(fields: Record<string, string>): boolean;
}
export function createPayU(opts: {
  key: string; salt: string; env: 'test' | 'prod'; publicApiUrl: string;
  fetch?: typeof fetch; newTxnId?: () => string;
}): PayUGateway;
```

- [ ] **Step 1: Change the port**

In `src/platform/paymentGateway.ts`:

1. Add after `GatewayRefund`:

```ts
/** What the client POSTs to the provider's hosted page. Never contains a secret. */
export interface CheckoutForm {
  action: string;
  fields: Record<string, string>;
}

export interface Payer {
  name: string;
  email: string;
  phone: string | null;
}
```

2. Extend `GatewayWebhookEvent`:

```ts
export type GatewayWebhookEvent =
  | { id: string; type: 'payment.captured' | 'payment.failed'; payment: GatewayPayment }
  | { id: string; type: 'refund.processed' | 'refund.failed'; refund: GatewayRefund }
  /** An unsigned refund notice: ask the provider (`refundStatus`), never trust the body. */
  | { id: string; type: 'refund.check'; gatewayRefundId: string }
  | { id: string; type: 'ignored'; providerType: string };
```

3. In `PaymentGateway`: delete `publicKey` (and its doc comment); add after `createOrder`:

```ts
  /**
   * The signed form the client posts to the provider's hosted page. Pure — no
   * network — so a reused open order gets a fresh form for the same order id.
   */
  checkoutForm(input: {
    gatewayOrderId: string;
    amountPaise: bigint;
    /** Our payment_orders.id — PayU echoes it back as udf1. */
    receipt: string;
    payer: Payer;
    description: string;
  }): CheckoutForm;
```

and after `refund`:

```ts
  /** The provider's current view of a refund we sent. */
  refundStatus(gatewayRefundId: string): Promise<GatewayRefund>;
```

4. `unconfiguredGateway`: remove `publicKey: ''`, add `checkoutForm: () => notConfigured(),` and `refundStatus: async () => notConfigured(),`.

Leave the `paymentGateway` export as is for now (Task 5 wires selection).

- [ ] **Step 2: Write the failing adapter tests**

`src/platform/payu/adapter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPayU } from './adapter.js';
import { REFUND_QUEUED, REFUND_STATUS_SUCCESS, VERIFY_NOT_FOUND, VERIFY_SUCCESS } from './fixtures.js';
import { responseHash } from './hash.js';

const KEY = 'testkey';
const SALT = 'testsalt';

function payu(fetchImpl?: ReturnType<typeof vi.fn>) {
  return createPayU({
    key: KEY,
    salt: SALT,
    env: 'test',
    publicApiUrl: 'https://api.example.test',
    fetch: fetchImpl as unknown as typeof fetch,
    newTxnId: () => 'TXN0000000000000001',
  });
}

const json = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

/** A payment webhook exactly as PayU posts it: form-encoded, reverse-hashed. */
function webhookBody(overrides: Record<string, string> = {}): Buffer {
  const f: Record<string, string> = {
    key: KEY,
    txnid: 'txn_ABC123',
    amount: '590.00',
    productinfo: 'Bengaluru Open',
    firstname: 'Asha',
    email: 'asha@example.com',
    udf1: 'order-1',
    status: 'success',
    mihpayid: '403993715521',
    mode: 'UPI',
    addedon: '2026-09-25 10:00:00',
    ...overrides,
  };
  f.hash ??= responseHash({ ...f, status: f.status! } as never, SALT);
  return Buffer.from(new URLSearchParams(f).toString());
}
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('payu adapter', () => {
  it('createOrder issues a short txnid and makes no network call', async () => {
    const fetch = vi.fn();
    const order = await payu(fetch).createOrder({ amountPaise: 59_000n, currency: 'INR', receipt: 'r1' });
    expect(order).toEqual({ id: 'TXN0000000000000001', amountPaise: 59_000n, currency: 'INR', status: 'created' });
    expect(order.id.length).toBeLessThanOrEqual(25);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checkoutForm posts to the hosted page with signed fields and no salt', () => {
    const form = payu().checkoutForm({
      gatewayOrderId: 'TXN1',
      amountPaise: 59_000n,
      receipt: 'order-1',
      payer: { name: 'Asha | Rao', email: 'asha@example.com', phone: '+919812345678' },
      description: 'Bengaluru Open',
    });
    expect(form.action).toBe('https://test.payu.in/_payment');
    expect(form.fields).toMatchObject({
      key: KEY,
      txnid: 'TXN1',
      amount: '590.00',
      productinfo: 'Bengaluru Open',
      firstname: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9812345678',
      udf1: 'order-1',
      surl: 'https://api.example.test/payments/payu/return',
      furl: 'https://api.example.test/payments/payu/return',
    });
    expect(form.fields.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(JSON.stringify(form)).not.toContain(SALT);
  });

  it('checkoutForm omits phone when the player has none', () => {
    const form = payu().checkoutForm({
      gatewayOrderId: 'TXN1', amountPaise: 100n, receipt: 'o', description: 'd',
      payer: { name: 'A', email: 'a@b.c', phone: null },
    });
    expect(form.fields).not.toHaveProperty('phone');
  });

  it('verifyResponse accepts PayU-signed fields and rejects tampering', () => {
    const fields = Object.fromEntries(new URLSearchParams(webhookBody().toString()));
    const gw = payu();
    expect(gw.verifyResponse(fields)).toBe(true);
    expect(gw.verifyResponse({ ...fields, amount: '1.00' })).toBe(false);
    expect(gw.verifyResponse({ ...fields, hash: '' })).toBe(false);
  });

  it('parseWebhook maps a signed success to payment.captured', () => {
    const event = payu().parseWebhook(webhookBody(), FORM);
    expect(event).toMatchObject({
      type: 'payment.captured',
      payment: { id: '403993715521', orderId: 'txn_ABC123', amountPaise: 59_000n, status: 'captured', method: 'UPI' },
    });
  });

  it('parseWebhook maps a signed failure to payment.failed with the reason', () => {
    const event = payu().parseWebhook(webhookBody({ status: 'failure', error_Message: 'Bank declined' }), FORM);
    expect(event).toMatchObject({ type: 'payment.failed', payment: { status: 'failed', failureReason: 'Bank declined' } });
  });

  it('parseWebhook rejects a bad hash', () => {
    expect(payu().parseWebhook(webhookBody({ hash: 'f'.repeat(128) }), FORM)).toBeNull();
  });

  it('event id is stable across PayU retries', () => {
    const a = payu().parseWebhook(webhookBody(), FORM);
    const b = payu().parseWebhook(webhookBody(), FORM);
    expect(a?.id).toBe('403993715521:success');
    expect(b?.id).toBe(a?.id);
  });

  it('parseWebhook turns a refund JSON notice into refund.check, trusting nothing else in it', () => {
    const raw = Buffer.from(JSON.stringify({ request_id: '133000001', status: 'success', amount: '99999.00' }));
    expect(payu().parseWebhook(raw, { 'content-type': 'application/json' })).toEqual({
      id: 'refund:133000001:success',
      type: 'refund.check',
      gatewayRefundId: '133000001',
    });
  });

  it('parseWebhook ignores JSON with no refund id, and garbage', () => {
    expect(payu().parseWebhook(Buffer.from('{"x":1}'), { 'content-type': 'application/json' })).toBeNull();
    expect(payu().parseWebhook(Buffer.from('not a form'), FORM)).toBeNull();
  });

  it('paymentsForOrder normalises verify_payment', async () => {
    const fetch = json(VERIFY_SUCCESS);
    const [p] = await payu(fetch).paymentsForOrder('txn_ABC123');
    expect(p).toMatchObject({ id: '403993715521', orderId: 'txn_ABC123', amountPaise: 59_000n, status: 'captured' });
    const body = String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(body).toContain('command=verify_payment');
    expect(body).toContain('var1=txn_ABC123');
  });

  it('paymentsForOrder returns nothing for an unknown txnid', async () => {
    expect(await payu(json(VERIFY_NOT_FOUND)).paymentsForOrder('txn_NONE')).toEqual([]);
  });

  it('refund sends the idempotency key as the token and returns the request id', async () => {
    const fetch = json(REFUND_QUEUED);
    const r = await payu(fetch).refund({ paymentId: '403993715521', amountPaise: 59_000n, idempotencyKey: 'idem-1' });
    expect(r).toEqual({ id: '133000001', paymentId: '403993715521', amountPaise: 59_000n, status: 'pending' });
    const body = new URLSearchParams(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.get('command')).toBe('cancel_refund_transaction');
    expect(body.get('var2')).toBe('idem-1');
    expect(body.get('var3')).toBe('590.00');
  });

  it('refundStatus maps success to processed', async () => {
    expect(await payu(json(REFUND_STATUS_SUCCESS)).refundStatus('133000001')).toEqual({
      id: '133000001', paymentId: '403993715521', amountPaise: 59_000n, status: 'processed',
    });
  });

  it('a PayU outage throws so the job retries', async () => {
    await expect(payu(json({}, 503)).paymentsForOrder('t')).rejects.toThrow(/503/);
  });

  it('a refund PayU refuses throws', async () => {
    await expect(
      payu(json({ status: 0, msg: 'Invalid amount' })).refund({ paymentId: 'p', amountPaise: 1n, idempotencyKey: 'k' }),
    ).rejects.toThrow(/Invalid amount/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/platform/payu/adapter.test.ts`
Expected: FAIL — cannot resolve `./adapter.js`.

- [ ] **Step 4: Implement the adapter**

`src/platform/payu/adapter.ts`:

```ts
/**
 * PayU behind the PaymentGateway port (payments R2, R7, R9). `fetch`, no SDK.
 * The ONLY file that holds the salt.
 *
 * Refund webhooks are JSON and PayU does not document their signature, so
 * they are never trusted: they become `refund.check`, and the service asks
 * `check_action_status` what actually happened.
 */
import { randomBytes } from 'node:crypto';
import { GatewayError } from '../paymentGateway.js';
import type {
  CheckoutForm,
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  GatewayWebhookEvent,
  PaymentGateway,
} from '../paymentGateway.js';
import { clean, postserviceHash, requestHash, responseHash, safeEqual, toPaise, toRupees } from './hash.js';

export interface PayUGateway extends PaymentGateway {
  verifyResponse(fields: Record<string, string>): boolean;
}

const HOSTS = {
  test: { pay: 'https://test.payu.in/_payment', api: 'https://test.payu.in/merchant/postservice.php?form=2' },
  prod: { pay: 'https://secure.payu.in/_payment', api: 'https://info.payu.in/merchant/postservice.php?form=2' },
} as const;

/** Under PayU's txnid cap (confirmed by scripts/payu-probe.ts). */
const TXNID_LENGTH = 20;
const TIMEOUT_MS = 10_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomTxnId(): string {
  const bytes = randomBytes(TXNID_LENGTH);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** PayU's `addedon` is IST wall-clock time: "YYYY-MM-DD HH:mm:ss". */
function istDate(addedon: string | undefined): Date | null {
  if (!addedon) return null;
  const d = new Date(`${addedon.replace(' ', 'T')}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function paymentStatus(s: string | undefined): string {
  if (s === 'success') return 'captured';
  if (s === 'failure' || s === 'failed') return 'failed';
  return s ?? 'unknown';
}

function refundStatusOf(s: string | undefined): GatewayRefund['status'] {
  if (s === 'success') return 'processed';
  if (s === 'failure' || s === 'failed') return 'failed';
  return 'pending';
}

function toPayment(f: Record<string, unknown>): GatewayPayment {
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : f[k] == null ? undefined : String(f[k]));
  const status = paymentStatus(s('status'));
  return {
    id: s('mihpayid') ?? '',
    orderId: s('txnid') ?? null,
    amountPaise: toPaise(s('amount') ?? s('transaction_amount') ?? s('amt') ?? '0'),
    status,
    method: s('mode') ?? null,
    failureReason: status === 'failed' ? (s('error_Message') ?? s('field9') ?? 'failed') : null,
    capturedAt: status === 'captured' ? istDate(s('addedon')) : null,
    raw: f,
  };
}

/** Indian mobile numbers as PayU wants them: 10 digits, no country code. */
function payuPhone(e164: string | null): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function createPayU(opts: {
  key: string;
  salt: string;
  env: 'test' | 'prod';
  publicApiUrl: string;
  fetch?: typeof fetch;
  newTxnId?: () => string;
}): PayUGateway {
  const doFetch = opts.fetch ?? fetch;
  const hosts = HOSTS[opts.env];
  const returnUrl = `${opts.publicApiUrl.replace(/\/$/, '')}/payments/payu/return`;
  const newTxnId = opts.newTxnId ?? randomTxnId;

  async function postservice(command: string, var1: string, extra: Record<string, string> = {}) {
    const body = new URLSearchParams({
      key: opts.key,
      command,
      var1,
      hash: postserviceHash(opts.key, command, var1, opts.salt),
      ...extra,
    });
    const res = await doFetch(hosts.api, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new GatewayError(res.status, `payu ${command} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  function verifyResponse(fields: Record<string, string>): boolean {
    const given = fields['hash'] ?? '';
    if (!given || !fields['status'] || fields['key'] !== opts.key) return false;
    const expected = responseHash(
      {
        key: fields['key'] ?? '',
        txnid: fields['txnid'] ?? '',
        amount: fields['amount'] ?? '',
        productinfo: fields['productinfo'] ?? '',
        firstname: fields['firstname'] ?? '',
        email: fields['email'] ?? '',
        udf1: fields['udf1'],
        udf2: fields['udf2'],
        udf3: fields['udf3'],
        udf4: fields['udf4'],
        udf5: fields['udf5'],
        status: fields['status'],
        additionalCharges: fields['additionalCharges'],
      },
      opts.salt,
    );
    return safeEqual(expected, given.toLowerCase());
  }

  return {
    name: 'payu',

    async createOrder(input): Promise<GatewayOrder> {
      return { id: newTxnId(), amountPaise: input.amountPaise, currency: input.currency, status: 'created' };
    },

    checkoutForm(input): CheckoutForm {
      const base = {
        key: opts.key,
        txnid: input.gatewayOrderId,
        amount: toRupees(input.amountPaise),
        productinfo: clean(input.description, 100) || 'PL4Y entry',
        firstname: clean(input.payer.name, 60) || 'Player',
        email: clean(input.payer.email, 100),
        udf1: input.receipt,
      };
      const phone = payuPhone(input.payer.phone);
      return {
        action: hosts.pay,
        fields: {
          ...base,
          ...(phone ? { phone } : {}),
          surl: returnUrl,
          furl: returnUrl,
          hash: requestHash(base, opts.salt),
        },
      };
    },

    async paymentsForOrder(orderId) {
      const body = await postservice('verify_payment', orderId);
      const details = (body['transaction_details'] ?? {}) as Record<string, Record<string, unknown>>;
      const txn = details[orderId];
      if (!txn || typeof txn['mihpayid'] !== 'string' || txn['mihpayid'] === 'Not Found') return [];
      const payment = toPayment(txn);
      return payment.status === 'captured' || payment.status === 'failed' ? [payment] : [];
    },

    async refund(input): Promise<GatewayRefund> {
      const body = await postservice('cancel_refund_transaction', input.paymentId, {
        var2: input.idempotencyKey,
        var3: toRupees(input.amountPaise),
      });
      const requestId = body['request_id'];
      if (body['status'] !== 1 || requestId == null) {
        throw new GatewayError(502, `payu refund refused: ${String(body['msg'] ?? 'unknown')}`);
      }
      return { id: String(requestId), paymentId: input.paymentId, amountPaise: input.amountPaise, status: 'pending' };
    },

    async refundStatus(gatewayRefundId): Promise<GatewayRefund> {
      const body = await postservice('check_action_status', gatewayRefundId);
      const outer = ((body['transaction_details'] ?? {}) as Record<string, Record<string, Record<string, unknown>>>)[
        gatewayRefundId
      ];
      const r = outer?.[gatewayRefundId] ?? (outer as unknown as Record<string, unknown> | undefined);
      if (!r) return { id: gatewayRefundId, paymentId: '', amountPaise: 0n, status: 'pending' };
      return {
        id: gatewayRefundId,
        paymentId: String(r['mihpayid'] ?? ''),
        amountPaise: toPaise(String(r['amt'] ?? r['amount'] ?? '0')),
        status: refundStatusOf(typeof r['status'] === 'string' ? r['status'] : undefined),
      };
    },

    parseWebhook(raw, headers): GatewayWebhookEvent | null {
      const text = raw.toString('utf8');
      const type = String(headers['content-type'] ?? '');
      if (type.includes('json') || text.trimStart().startsWith('{')) {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return null;
        }
        const requestId = body['request_id'] ?? body['requestId'];
        if (requestId == null || requestId === '') return null;
        return {
          id: `refund:${String(requestId)}:${String(body['status'] ?? '')}`,
          type: 'refund.check',
          gatewayRefundId: String(requestId),
        };
      }
      const fields = Object.fromEntries(new URLSearchParams(text));
      if (!fields['mihpayid'] || !verifyResponse(fields)) return null;
      let payment: GatewayPayment;
      try {
        payment = toPayment(fields);
      } catch {
        return null;
      }
      const id = `${fields['mihpayid']}:${fields['status']}`;
      if (payment.status === 'captured') return { id, type: 'payment.captured', payment };
      if (payment.status === 'failed') return { id, type: 'payment.failed', payment };
      return { id, type: 'ignored', providerType: `payment.${fields['status']}` };
    },

    verifyResponse,
  };
}
```

- [ ] **Step 5: Run adapter tests**

Run: `npx vitest run src/platform/payu`
Expected: PASS (hash + adapter). If a fixture recorded in Task 2 has a different shape, adjust the normaliser (not the test's expected values) until it passes.

- [ ] **Step 6: Commit** (typecheck is expected to fail until Task 4 updates the payments service — commit anyway on the branch)

```bash
git add src/platform/paymentGateway.ts src/platform/payu/adapter.ts src/platform/payu/adapter.test.ts
git commit -m "feat(payments): PayU adapter behind the gateway port"
```

---

### Task 4: Payments service — checkout form, payer, refund check

**Files:**
- Modify: `PALY_BACKEND/src/modules/payments/service/index.ts` (`OrderHandle` ~45, `UsersPort` ~122, `createOrder`/`handle` ~174–235, `applyWebhook` ~276, `processRefund` ~532, `reconcilePending` ~702, `loadEvent` ~916, returned object ~888)
- Modify: `PALY_BACKEND/src/modules/payments/schema/index.ts:73-93`
- Modify: `PALY_BACKEND/src/modules/identity/service/index.ts:677-685`
- Modify: `PALY_BACKEND/tests/helpers/modules.ts` (`FakeGateway` ~201, `KNOWN_TYPES` ~319, `contactsPortFor` ~442)
- Test: `PALY_BACKEND/tests/payments.test.ts`

**Interfaces:**
- Consumes: port from Task 3 (`checkoutForm`, `refundStatus`, `refund.check`, `CheckoutForm`, `Payer`).
- Produces:
  - `OrderHandle` = `{ orderId; gatewayOrderId; checkout: CheckoutForm; amountPaise; currency; quote }` (`gatewayKey` removed)
  - `UsersPort.byIds` returns `{ id; displayName; email; phone: string | null }[]`
  - service method `checkRefund(gatewayRefundId: string): Promise<void>`
  - GraphQL `CreatePaymentOrderPayload { gatewayOrderId, checkoutForm { action, fields { key value } }, amountPaise, quote, userError }`

- [ ] **Step 1: Update the fake gateway and contacts port**

In `tests/helpers/modules.ts`:
- `FakeGateway`: delete `readonly publicKey = 'pk_test_key';`. Add:

```ts
  statuses = new Map<string, GatewayRefund['status']>();

  checkoutForm(input: {
    gatewayOrderId: string;
    amountPaise: bigint;
    receipt: string;
    payer: { name: string; email: string; phone: string | null };
    description: string;
  }): CheckoutForm {
    return {
      action: 'https://gateway.test/pay',
      fields: {
        txnid: input.gatewayOrderId,
        amount: input.amountPaise.toString(),
        udf1: input.receipt,
        firstname: input.payer.name,
        email: input.payer.email,
        productinfo: input.description,
      },
    };
  }

  async refundStatus(gatewayRefundId: string): Promise<GatewayRefund> {
    const r = this.refunds.find((x) => x.id === gatewayRefundId);
    if (!r) return { id: gatewayRefundId, paymentId: '', amountPaise: 0n, status: 'pending' };
    return { ...r, status: this.statuses.get(gatewayRefundId) ?? r.status };
  }
```

  and import `CheckoutForm` alongside the other gateway types at the top of the file.
- `FakeGateway.reset()`: add `this.statuses.clear();`.
- `KNOWN_TYPES`: add `'refund.check'`.
- `contactsPortFor(...).byIds`: select `phoneE164: true` and map to `phone`:

```ts
      const rows = await prisma.user.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, displayName: true, email: true, phoneE164: true },
      });
      return rows.map(({ phoneE164, ...r }) => ({ ...r, phone: phoneE164 }));
```

- [ ] **Step 2: Write the failing integration tests**

In `tests/payments.test.ts`, replace the line `expect(order.gatewayKey).toBe('pk_test_key');` with:

```ts
    expect(order.checkout.action).toBe('https://gateway.test/pay');
    expect(order.checkout.fields['txnid']).toBe(order.gatewayOrderId);
    expect(order.checkout.fields['udf1']).toBe(order.orderId);
```

Add a new `describe` block at the end of the file. It uses the file's existing helpers: `publishedCategory()` (a published paid category), `makePlayer(name)` (returns `{ actor, ... }`), `payFor(player, categoryId)` (registration → order → capture → confirmed; returns `{ registrationId, paymentId, gatewayPaymentId }`), and `deliver(type, payload)` (signs a webhook body `{ id, type, ...payload }`, ingests it, runs the job):

```ts
describe('payments — PayU-shaped checkout and refund checks', () => {
  it('a reused open order gets a fresh signed form for the same txnid', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const first = await payments.createOrder(player.actor, reg.id);
    const again = await payments.createOrder(player.actor, reg.id);
    expect(again.gatewayOrderId).toBe(first.gatewayOrderId);
    expect(again.checkout.fields['txnid']).toBe(first.gatewayOrderId);
    expect(again.checkout.fields['udf1']).toBe(first.orderId);
  });

  it('the checkout form carries the payer from identity and the event title', async () => {
    const { categoryId } = await publishedCategory();
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: player.actor.userId } });
    expect(order.checkout.fields['email']).toBe(user.email);
    expect(order.checkout.fields['firstname']).toBe(user.displayName);
    expect(order.checkout.fields['productinfo']).toBeTruthy();
  });

  it('a refund.check notice settles the refund from the provider, not the notice', async () => {
    const { categoryId } = await publishedCategory();
    const { paymentId } = await payFor(await makePlayer('Payer'), categoryId);
    const refund = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });

    gateway.statuses.set(sent.gatewayRefundId!, 'pending');
    await deliver('refund.check', { gatewayRefundId: sent.gatewayRefundId });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('pending');

    gateway.statuses.set(sent.gatewayRefundId!, 'processed');
    await deliver('refund.check', { gatewayRefundId: sent.gatewayRefundId });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('processed');
  });

  it('payments R9: reconciliation settles a refund whose notice never came', async () => {
    const { categoryId } = await publishedCategory();
    const { paymentId } = await payFor(await makePlayer('Payer'), categoryId);
    const refund = await payments.refund(null, { paymentId, amountPaise: 1_000n, reason: 'organizer cancelled' });
    await payments.processRefund(refund.id);
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    gateway.statuses.set(sent.gatewayRefundId!, 'processed');
    await prisma.refund.update({
      where: { id: refund.id },
      data: { createdAt: new Date(Date.now() - RECONCILE_AFTER_MS - 60_000) },
    });
    await payments.reconcilePending();
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('processed');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run (Docker must be running): `npx vitest run tests/payments.test.ts`
Expected: FAIL — type errors on `order.checkout` / `gatewayKey`, then assertion failures.

- [ ] **Step 4: Implement the service changes**

In `src/modules/payments/service/index.ts`:

1. Imports: add `CheckoutForm` to the `paymentGateway.js` type import.
2. `OrderHandle`: replace the `gatewayKey` field and its comment with

```ts
  /** The signed form the client posts to the provider's hosted page. */
  checkout: CheckoutForm;
```

3. `UsersPort`:

```ts
export interface UsersPort {
  byIds(ids: string[]): Promise<{ id: string; displayName: string; email: string; phone: string | null }[]>;
}
```

4. In `createOrder`, change both `return handle(open, quote);` and `return handle(row, quote);` to `return handle(open, quote, reg);` / `return handle(row, quote, reg);`, and replace the `handle` arrow with:

```ts
  async function handle(
    row: Awaited<ReturnType<PaymentsRepo['insertOrder']>>,
    quote: Awaited<ReturnType<EventsPort['priceQuote']>>,
    reg: Awaited<ReturnType<RegistrationPort['byId']>>,
  ): Promise<OrderHandle> {
    const [[payer], event] = await Promise.all([users.byIds([reg.captainUserId]), events.byId(reg.eventId)]);
    if (!payer) throw new SystemError('FORBIDDEN', 'The payer could not be found.');
    const checkout = gateway.checkoutForm({
      gatewayOrderId: row.gatewayOrderId,
      amountPaise: row.amountPaise,
      receipt: row.id,
      payer: { name: payer.displayName, email: payer.email, phone: payer.phone },
      description: event.title,
    });
    return {
      orderId: row.id,
      gatewayOrderId: row.gatewayOrderId,
      checkout,
      amountPaise: row.amountPaise,
      currency: row.currency,
      quote,
    };
  }
```

(`handle` becomes a function declaration inside `createPaymentsService`, so `return handle(...)` in the async `createOrder` returns the promise — fine.)

5. `applyWebhook` switch: add before `default:`

```ts
        case 'refund.check':
          await checkRefund(event.gatewayRefundId);
          break;
```

6. After `processRefund`, add:

```ts
  /**
   * For providers whose refund notices are unsigned (PayU): ask, then apply
   * through the same two functions a signed webhook would use. Still pending
   * is not an error — reconciliation asks again.
   */
  async function checkRefund(gatewayRefundId: string): Promise<void> {
    const status = await gateway.refundStatus(gatewayRefundId);
    if (status.status === 'processed') {
      const row = await repo.refundByGatewayId(gatewayRefundId);
      const payment = row ? await repo.paymentById(row.paymentId) : null;
      if (!payment) {
        logger.warn({ gatewayRefundId }, 'refund status for an unknown refund');
        return;
      }
      await applyRefundProcessed(gatewayRefundId, payment.gatewayPaymentId);
    } else if (status.status === 'failed') {
      await applyRefundFailed(gatewayRefundId);
    }
  }
```

7. In `reconcilePending`, before `return { checked: stale.length, resolved };`, add:

```ts
    // Refunds sent but never settled: a missed or unsigned notice costs a
    // delay, not money.
    const unsettled = await db.refund.findMany({
      where: { status: 'pending', gatewayRefundId: { not: null }, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    for (const r of unsettled) {
      try {
        await checkRefund(r.gatewayRefundId!);
      } catch (err) {
        logger.error({ err, refundId: r.id }, 'refund reconciliation failed');
      }
    }
```

8. `loadEvent`: before the final `return`, add

```ts
  if (e.type === 'refund.check') {
    return { id: e.id, type: 'refund.check', gatewayRefundId: (payload as { gatewayRefundId: string }).gatewayRefundId };
  }
```

9. Add `checkRefund,` to the returned service object (next to `processRefund`).

In `src/modules/identity/service/index.ts`, `contactsByIds`:

```ts
  async function contactsByIds(
    ids: string[],
  ): Promise<{ id: string; displayName: string; email: string; phone: string | null }[]> {
    if (ids.length === 0) return [];
    const rows = await db.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, displayName: true, email: true, phoneE164: true },
    });
    return rows.map(({ phoneE164, ...r }) => ({ ...r, phone: phoneE164 }));
  }
```

In `src/modules/payments/schema/index.ts`, above `CreatePaymentOrderPayload` add:

```ts
const CheckoutFieldRef = builder
  .objectRef<{ key: string; value: string }>('CheckoutField')
  .implement({ fields: (t) => ({ key: t.exposeString('key'), value: t.exposeString('value') }) });

const CheckoutFormRef = builder.objectRef<CheckoutForm>('CheckoutForm').implement({
  description:
    'POST these fields, unchanged, to `action`. Signed by the server; the client never computes or checks a hash.',
  fields: (t) => ({
    action: t.exposeString('action'),
    fields: t.field({
      type: [CheckoutFieldRef],
      resolve: (f) => Object.entries(f.fields).map(([key, value]) => ({ key, value })),
    }),
  }),
});
```

(import `type CheckoutForm` from `../../../platform/paymentGateway.js`), and in `CreatePaymentOrderPayload` replace the `gatewayKey` field with:

```ts
      checkoutForm: t.field({ type: CheckoutFormRef, nullable: true, resolve: (p) => p.order?.checkout ?? null }),
```

- [ ] **Step 5: Run tests**

Run: `npx tsc --noEmit && npx vitest run tests/payments.test.ts src/platform/payu`
Expected: typecheck clean; all payments tests PASS, including the four new ones.

- [ ] **Step 6: Commit**

```bash
git add src/modules/payments src/modules/identity/service/index.ts tests/helpers/modules.ts tests/payments.test.ts
git commit -m "feat(payments): signed checkout form, payer details, refund status check"
```

---

### Task 5: Provider selection and the return routes

**Files:**
- Modify: `PALY_BACKEND/src/platform/paymentGateway.ts` (bottom: `paymentGateway`, `gatewayConfigured`)
- Create: `PALY_BACKEND/src/platform/webhooks/payuReturn.ts`
- Test: `PALY_BACKEND/src/platform/webhooks/payuReturn.test.ts`
- Modify: `PALY_BACKEND/src/app.ts:57-63`

**Interfaces:**
- Consumes: `createPayU`, `PayUGateway.verifyResponse` (Task 3); config keys (Task 1).
- Produces: `export const payu: PayUGateway | null` from `paymentGateway.ts`; `createPayuReturnRouter(gw: Pick<PayUGateway, 'verifyResponse'> | null): express.Router` mounting `POST /payments/payu/return` and `GET /payments/payu/done`.

- [ ] **Step 1: Wire provider selection**

At the bottom of `src/platform/paymentGateway.ts`, replace the `paymentGateway` export and its comment with:

```ts
/** Set when PAYMENT_PROVIDER=payu: the return route needs its verifier. */
export const payu: PayUGateway | null =
  config.PAYMENT_PROVIDER === 'payu'
    ? createPayU({
        key: config.PAYU_KEY,
        salt: config.PAYU_SALT,
        env: config.PAYU_ENV,
        publicApiUrl: config.PUBLIC_API_URL,
      })
    : null;

/** The gateway the app runs against. */
export const paymentGateway: PaymentGateway = payu ?? unconfiguredGateway;
```

and add imports at the top of the file:

```ts
import { config } from './config.js';
import { createPayU, type PayUGateway } from './payu/adapter.js';
```

`adapter.ts` imports `GatewayError` from `paymentGateway.js` — an ESM cycle. `GatewayError` is only used inside functions, so it resolves at call time; if vitest reports `GatewayError is not a constructor`, move the `GatewayError` class into `src/platform/gatewayError.ts`, re-export it from `paymentGateway.ts`, and import it from there in the adapter.

- [ ] **Step 2: Write the failing route tests**

`src/platform/webhooks/payuReturn.test.ts`:

```ts
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createPayuReturnRouter } from './payuReturn.js';

async function post(verify: boolean, body: Record<string, string>) {
  const app = express();
  app.use(createPayuReturnRouter({ verifyResponse: vi.fn(() => verify) }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/payments/payu/return`, {
      method: 'POST',
      body: new URLSearchParams(body),
      redirect: 'manual',
    });
  } finally {
    server.close();
  }
}

describe('payu return route', () => {
  it('a verified success redirects to done?status=success with the txnid', async () => {
    const res = await post(true, { status: 'success', txnid: 'TXN1', hash: 'h' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/payments/payu/done?status=success&txnid=TXN1');
  });

  it('a verified failure redirects to done?status=failure', async () => {
    const res = await post(true, { status: 'failure', txnid: 'TXN1', hash: 'h' });
    expect(res.headers.get('location')).toBe('/payments/payu/done?status=failure&txnid=TXN1');
  });

  it('a tampered post is a failure, never a success', async () => {
    const res = await post(false, { status: 'success', txnid: 'TXN1', hash: 'bad' });
    expect(res.headers.get('location')).toBe('/payments/payu/done?status=failure&reason=signature');
  });

  it('done serves a plain page', async () => {
    const app = express();
    app.use(createPayuReturnRouter(null));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/payments/payu/done?status=success`);
    server.close();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('close this');
  });

  it('with PayU not configured the return route is a 503', async () => {
    const app = express();
    app.use(createPayuReturnRouter(null));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/payments/payu/return`, { method: 'POST' });
    server.close();
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/platform/webhooks/payuReturn.test.ts`
Expected: FAIL — cannot resolve `./payuReturn.js`.

- [ ] **Step 4: Implement the router**

`src/platform/webhooks/payuReturn.ts`:

```ts
/**
 * PayU posts the player's browser here when checkout ends (surl/furl).
 *
 * payments R5 — this changes NOTHING in the database. It verifies the hash so
 * a forged "success" can't even steer the UI, then redirects to /done, which
 * the app intercepts to close its WebView. The webhook and reconciliation are
 * still the only things that confirm an entry.
 */
import express, { Router } from 'express';
import type { PayUGateway } from '../payu/adapter.js';

const DONE = '/payments/payu/done';

export function createPayuReturnRouter(gw: Pick<PayUGateway, 'verifyResponse'> | null): Router {
  const router = Router();

  router.post('/payments/payu/return', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
    if (!gw) {
      res.status(503).send('not configured');
      return;
    }
    const fields = (req.body ?? {}) as Record<string, string>;
    if (!gw.verifyResponse(fields)) {
      res.redirect(303, `${DONE}?status=failure&reason=signature`);
      return;
    }
    const status = fields['status'] === 'success' ? 'success' : 'failure';
    res.redirect(303, `${DONE}?status=${status}&txnid=${encodeURIComponent(fields['txnid'] ?? '')}`);
  });

  router.get(DONE, (_req, res) => {
    res
      .type('html')
      .send('<!doctype html><meta name="viewport" content="width=device-width"><p>Payment finished. You can close this page.</p>');
  });

  return router;
}
```

- [ ] **Step 5: Mount it**

In `src/app.ts`, after the `/webhooks/payments` route block and before `app.use(express.json(...))`:

```ts
  // PayU returns the player's browser here (form POST). No state change —
  // payments R5 — so it needs no raw body, only the verifier.
  app.use(createPayuReturnRouter(payu));
```

with imports:

```ts
import { payu } from './platform/paymentGateway.js';
import { createPayuReturnRouter } from './platform/webhooks/payuReturn.js';
```

- [ ] **Step 6: Run the checks**

Run: `npx tsc --noEmit && npx eslint src && npm run guard && npx vitest run src/`
Expected: all clean; route tests PASS.

- [ ] **Step 7: Regenerate the schema and commit**

Run: `npm run schema:generate`
Expected: `Wrote schema.graphql`; `git diff schema.graphql` shows `CheckoutForm`, `CheckoutField`, `checkoutForm` and no `gatewayKey`.

```bash
git add src/platform/paymentGateway.ts src/platform/webhooks/payuReturn.ts src/platform/webhooks/payuReturn.test.ts src/app.ts schema.graphql
git commit -m "feat(payments): select PayU from config; return and done routes"
```

---

### Task 6: Backend docs

**Files:**
- Modify: `PALY_BACKEND/docs/modules/07-payments.md` (R2 at ~line 73; add a provider note)

- [ ] **Step 1: Amend R2 and record the provider**

Replace the **R2** paragraph's first sentence ("The webhook route receives the raw body. HMAC-SHA256 with a **timing-safe** comparison; …") with:

```markdown
**R2** — The webhook route receives the raw body, and the provider adapter verifies the provider's
signature over the received fields with a **timing-safe** comparison (PayU: SHA-512 reverse hash
over the payment fields and the salt). A bad signature is a 400 and nothing is written. A provider
notice that carries no documented signature (PayU refund notices) is never trusted: it only
triggers a status query to the provider.
```

(keep the rest of the paragraph that follows the first sentence, if any.)

Add under the module's introduction:

```markdown
> **Provider:** PayU (hosted checkout), `src/platform/payu/`. Selected by `PAYMENT_PROVIDER=payu`;
> unset keeps the unconfigured gateway. Design: `docs/superpowers/specs/2026-09-25-payu-collection-design.md`.
> Webhook URL to configure in the PayU dashboard: `${PUBLIC_API_URL}/webhooks/payments` for payment
> success, payment failure and refund events.
```

- [ ] **Step 2: Commit**

```bash
git add docs/modules/07-payments.md
git commit -m "docs(payments): PayU provider and R2 amendment"
```

---

### Task 7: App — API and seam rename (`PLAY_FRONTEND/apps/player`)

The app currently queries `razorpayOrderId` / `razorpayKeyId`, which the server does not expose (it had `gatewayOrderId` / `gatewayKey`). This task moves both sides onto the new contract.

**Files:**
- Modify: `src/features/checkout/api.ts`
- Modify: `src/features/checkout/gateway/PaymentGateway.ts`
- Modify: `src/features/checkout/gateway/MockGateway.test.tsx:4` (the `request` literal)
- Modify: `src/features/checkout/screens/PayScreen.tsx:88-99`
- Modify: `src/features/checkout/screens/PayScreen.test.tsx:58,162` and any other `razorpay*` literal in that file

**Interfaces:**
- Produces:
  - `interface CheckoutForm { action: string; fields: Record<string, string> }` exported from `gateway/PaymentGateway.ts`
  - `interface GatewayRequest { orderId: string; amountPaise: number; description: string; checkoutForm: CheckoutForm | null }`
  - `PaymentOrderPayload = { gatewayOrderId: string | null; checkoutForm: CheckoutForm | null; amountPaise; quote; userError }`

- [ ] **Step 1: Update the PayScreen test first**

In `PayScreen.test.tsx`, change the `order` fixture (line 58) to:

```ts
const checkoutForm = { action: 'https://test.payu.in/_payment', fields: { txnid: 'TXN1', hash: 'h' } };
const order = { gatewayOrderId: 'TXN1', checkoutForm, amountPaise: 59_000, quote: null, userError: null };
```

change the null-order literal near line 162 from `razorpayOrderId: null,` (and `razorpayKeyId`) to `gatewayOrderId: null, checkoutForm: null,`; in the `checkout R10: dismissing the gateway…` test change

```ts
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ keyId: 'rzp_test_1', orderId: 'order_1', amountPaise: 59_000 }));
```

to

```ts
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'TXN1', amountPaise: 59_000 }));
```

and add this test inside `describe('PayScreen')`:

```ts
  test('passes the server-signed checkout form to the gateway unchanged', async () => {
    createOrderMock.mockResolvedValue(order);
    const open = jest.fn(async () => ({ kind: 'dismissed' }));
    getGatewayMock.mockReturnValue({ open });
    await renderPay();
    await fireEvent.press(screen.getByText(/^Pay /));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(open.mock.calls[0][0]).toMatchObject({ orderId: 'TXN1', checkoutForm });
  });
```


- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/features/checkout/screens/PayScreen.test.tsx`
Expected: FAIL — PayScreen reads `razorpayOrderId`, so it errors out before calling `open`.

- [ ] **Step 3: Implement**

`gateway/PaymentGateway.ts` — replace `GatewayRequest` and the header comment's first sentence:

```ts
/**
 * The seam between checkout and a payment provider. PayU's hosted page (in a
 * WebView) implements it; a dev-only mock stands in when EXPO_PUBLIC_MOCK_GATEWAY=1.
 *
 * A result is a UI hint (payments R5): `success` means "go and wait", never
 * "confirmed" — see model/payResult.ts.
 */
export interface CheckoutForm {
  action: string;
  fields: Record<string, string>;
}

export interface GatewayRequest {
  orderId: string;
  amountPaise: number;
  description: string;
  /** Server-signed. Posted unchanged; the client never computes a hash. */
  checkoutForm: CheckoutForm | null;
}
```

`api.ts`:

```ts
import type { CheckoutForm } from './gateway/PaymentGateway';

export interface PaymentOrderPayload {
  gatewayOrderId: string | null;
  checkoutForm: CheckoutForm | null;
  amountPaise: number | null;
  quote: PriceQuote | null;
  userError: UserError | null;
}

const CREATE_PAYMENT_ORDER = /* GraphQL */ `
  mutation CreatePaymentOrder($registrationId: ID!) {
    createPaymentOrder(registrationId: $registrationId) {
      gatewayOrderId
      checkoutForm { action fields { key value } }
      amountPaise
      quote { currency entryFeePaise platformFeePaise taxPaise totalPaise }
      userError { code message retryAfterSeconds }
    }
  }
`;

type Wire = Omit<PaymentOrderPayload, 'checkoutForm'> & {
  checkoutForm: { action: string; fields: { key: string; value: string }[] } | null;
};

export async function createPaymentOrder(registrationId: string): Promise<PaymentOrderPayload> {
  const data = await gqlRequest<{ createPaymentOrder: Wire }, { registrationId: string }>(CREATE_PAYMENT_ORDER, {
    registrationId,
  });
  const { checkoutForm, ...rest } = data.createPaymentOrder;
  return {
    ...rest,
    checkoutForm: checkoutForm
      ? { action: checkoutForm.action, fields: Object.fromEntries(checkoutForm.fields.map((f) => [f.key, f.value])) }
      : null,
  };
}
```

`PayScreen.tsx` lines 88–99:

```tsx
        if (!order.gatewayOrderId || order.amountPaise === null) {
          setError(copy.common.genericError);
          return;
        }
        setOrderAmount(order.amountPaise);
        setOrderQuote(order.quote);

        const result = await getGateway().open({
          orderId: order.gatewayOrderId,
          amountPaise: order.amountPaise,
          description: registration.event.title,
          checkoutForm: order.checkoutForm,
        });
```

`MockGateway.test.tsx` line 4:

```ts
const request = { orderId: 'order_1', amountPaise: 59_000, description: 'Ahmedabad Open', checkoutForm: null };
```

Also replace "Razorpay Checkout" in `MockGateway.tsx`'s header comment with "the PayU gateway".

- [ ] **Step 4: Run checkout tests and typecheck**

Run: `npx jest src/features/checkout && npx tsc --noEmit`
Expected: PASS; no type errors. `grep -rn "razorpay" src` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add src/features/checkout
git commit -m "feat(checkout): move to the provider-neutral checkout form contract"
```

---

### Task 8: App — PayU WebView gateway

**Files:**
- Create: `src/features/checkout/gateway/payuNavigation.ts`, `payuNavigation.test.ts`
- Create: `src/features/checkout/gateway/PayUGateway.tsx`, `PayUGateway.test.tsx`
- Modify: `src/features/checkout/gateway/index.ts`, `src/features/checkout/index.ts`, `app/(app)/_layout.tsx:6,59`
- Modify: `src/config/env.ts`, `src/core/copy.ts` (`checkout` section), `app.json`, `package.json`

**Interfaces:**
- Consumes: `GatewayRequest`, `GatewayResult`, `PaymentGateway`, `CheckoutForm` (Task 7).
- Produces:
  - `type NavDecision = { kind: 'load' } | { kind: 'external' } | { kind: 'done'; status: 'success' | 'failure'; txnid: string | null }`
  - `classifyNavigation(url: string): NavDecision`
  - `autoSubmitHtml(form: CheckoutForm): string`
  - `payuGateway: PaymentGateway`, `PayUGatewayHost(): JSX.Element | null`
  - `config.mockGateway: boolean`

- [ ] **Step 1: Install the WebView**

Run: `npx expo install react-native-webview`
Expected: `package.json` gains `react-native-webview` at the version Expo 57 pins.

- [ ] **Step 2: Write the failing pure tests**

`payuNavigation.test.ts`:

```ts
import { autoSubmitHtml, classifyNavigation } from './payuNavigation';

describe('payu navigation', () => {
  test('recognises the done path on any host', () => {
    expect(classifyNavigation('https://api.pl4y.in/payments/payu/done?status=success&txnid=T1')).toEqual({
      kind: 'done', status: 'success', txnid: 'T1',
    });
    expect(classifyNavigation('http://192.168.1.5:4000/payments/payu/done?status=failure')).toEqual({
      kind: 'done', status: 'failure', txnid: null,
    });
  });

  test('anything but an explicit success on done is a failure', () => {
    expect(classifyNavigation('https://x/payments/payu/done?status=weird')).toMatchObject({ status: 'failure' });
  });

  test('UPI and app intents leave the WebView', () => {
    for (const url of [
      'upi://pay?pa=x@y',
      'intent://pay#Intent;scheme=upi;end',
      'tez://upi/pay?pa=x',
      'phonepe://pay?pa=x',
      'paytmmp://pay?pa=x',
      'gpay://upi/pay?pa=x',
    ]) {
      expect(classifyNavigation(url)).toEqual({ kind: 'external' });
    }
  });

  test('ordinary pages load', () => {
    expect(classifyNavigation('https://test.payu.in/_payment')).toEqual({ kind: 'load' });
    expect(classifyNavigation('about:blank')).toEqual({ kind: 'load' });
  });

  test('the auto-submit page posts every field, HTML-escaped', () => {
    const html = autoSubmitHtml({ action: 'https://test.payu.in/_payment', fields: { firstname: 'A"<b>', hash: 'h' } });
    expect(html).toContain('action="https://test.payu.in/_payment"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="firstname" value="A&quot;&lt;b&gt;"');
    expect(html).toContain('name="hash" value="h"');
    expect(html).toContain('.submit()');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/features/checkout/gateway/payuNavigation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `payuNavigation.ts`**

```ts
import type { CheckoutForm } from './PaymentGateway';

export type NavDecision =
  | { kind: 'load' }
  | { kind: 'external' }
  | { kind: 'done'; status: 'success' | 'failure'; txnid: string | null };

/** Payment apps the hosted page hands off to. Opened by the OS, never loaded here. */
const EXTERNAL = /^(upi|intent|tez|phonepe|paytmmp|gpay|credpay):/i;
/** Matched by path: in dev the API host the phone sees differs from PUBLIC_API_URL. */
const DONE_PATH = '/payments/payu/done';

export function classifyNavigation(url: string): NavDecision {
  if (EXTERNAL.test(url)) return { kind: 'external' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'load' };
  }
  if (parsed.pathname !== DONE_PATH) return { kind: 'load' };
  return {
    kind: 'done',
    status: parsed.searchParams.get('status') === 'success' ? 'success' : 'failure',
    txnid: parsed.searchParams.get('txnid'),
  };
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A page that posts the server-signed form to PayU the moment it loads. */
export function autoSubmitHtml(form: CheckoutForm): string {
  const inputs = Object.entries(form.fields)
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join('');
  return (
    '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>' +
    `<form id="f" action="${escape(form.action)}" method="post">${inputs}</form>` +
    '<script>document.getElementById("f").submit()</script></body></html>'
  );
}
```

- [ ] **Step 5: Run pure tests**

Run: `npx jest src/features/checkout/gateway/payuNavigation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing gateway tests**

`PayUGateway.test.tsx`:

```tsx
import { Linking } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PayUGatewayHost, payuGateway } from './PayUGateway';

// jest.mock factories may only reference variables prefixed `mock`, and no JSX (hoisting).
let mockLastProps: Record<string, unknown> = {};
jest.mock('react-native-webview', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return {
    WebView: (props: Record<string, unknown>) => {
      mockLastProps = props;
      return React.createElement(View, { testID: 'payu-webview' });
    },
  };
});

const form = { action: 'https://test.payu.in/_payment', fields: { txnid: 'T1', hash: 'h' } };
const request = { orderId: 'T1', amountPaise: 59_000, description: 'Open', checkoutForm: form };
const decide = (url: string) =>
  (mockLastProps.onShouldStartLoadWithRequest as (r: { url: string }) => boolean)({ url });

async function openGateway() {
  await render(<PayUGatewayHost />);
  let result: unknown;
  await act(async () => {
    void payuGateway.open(request).then((r) => (result = r));
  });
  return () => result;
}

describe('PayU gateway', () => {
  test('loads the auto-submit page for the signed form', async () => {
    await openGateway();
    expect(screen.getByTestId('payu-webview')).toBeTruthy();
    expect((mockLastProps.source as { html: string }).html).toContain('name="hash" value="h"');
  });

  test('the done URL resolves success and closes', async () => {
    const result = await openGateway();
    let allowed = true;
    await act(async () => {
      allowed = decide('https://api.pl4y.in/payments/payu/done?status=success&txnid=T1');
    });
    expect(allowed).toBe(false);
    expect(result()).toEqual({ kind: 'success', paymentId: 'T1' });
    expect(screen.queryByTestId('payu-webview')).toBeNull();
  });

  test('a failure on done resolves failed', async () => {
    const result = await openGateway();
    await act(async () => {
      decide('https://api.pl4y.in/payments/payu/done?status=failure');
    });
    expect(result()).toMatchObject({ kind: 'failed' });
  });

  test('a UPI link goes to the OS and is not loaded', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await openGateway();
    let allowed = true;
    await act(async () => {
      allowed = decide('upi://pay?pa=x@y');
    });
    expect(allowed).toBe(false);
    expect(spy).toHaveBeenCalledWith('upi://pay?pa=x@y');
  });

  test('closing resolves dismissed', async () => {
    const result = await openGateway();
    await fireEvent.press(screen.getByLabelText('Close payment'));
    await act(async () => {});
    expect(result()).toEqual({ kind: 'dismissed' });
  });

  test('a load error resolves dismissed', async () => {
    const result = await openGateway();
    await act(async () => {
      (mockLastProps.onError as () => void)();
    });
    expect(result()).toEqual({ kind: 'dismissed' });
  });

  test('a request with no checkout form fails without opening', async () => {
    await render(<PayUGatewayHost />);
    let result: unknown;
    await act(async () => {
      result = await payuGateway.open({ ...request, checkoutForm: null });
    });
    expect(result).toMatchObject({ kind: 'failed' });
    expect(screen.queryByTestId('payu-webview')).toBeNull();
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx jest src/features/checkout/gateway/PayUGateway.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `PayUGateway.tsx`**

Follow `MockGateway.tsx`'s pattern (module-level pending request + a host mounted once in the app layout).

```tsx
/**
 * PayU's hosted checkout in a WebView (07-checkout; spec 2026-09-25-payu-collection).
 *
 * The page posts the server-signed form; UPI app links go to the OS; our
 * /payments/payu/done URL closes it. Every result is a UI hint (checkout R1):
 * the entry confirms only when the server says so.
 */
import { useSyncExternalStore } from 'react';
import { Linking, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Text } from '../../../shared/components';
import { copy } from '../../../core/copy';
import { color, space } from '../../../theme';
import type { GatewayRequest, GatewayResult, PaymentGateway } from './PaymentGateway';
import { autoSubmitHtml, classifyNavigation } from './payuNavigation';

interface Pending {
  request: GatewayRequest;
  resolve: (result: GatewayResult) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function finish(result: GatewayResult): void {
  const pending = current;
  current = null;
  emit();
  pending?.resolve(result);
}

export const payuGateway: PaymentGateway = {
  open(request) {
    if (!request.checkoutForm) return Promise.resolve({ kind: 'failed', reason: 'no_checkout_form' });
    // A second open supersedes the first, which resolves dismissed.
    if (current) finish({ kind: 'dismissed' });
    return new Promise((resolve) => {
      current = { request, resolve };
      emit();
    });
  },
};

export function PayUGatewayHost() {
  const pending = useSyncExternalStore(subscribe, () => current);
  const form = pending?.request.checkoutForm;
  if (!pending || !form) return null;

  const onShouldStart = ({ url }: { url: string }): boolean => {
    const decision = classifyNavigation(url);
    if (decision.kind === 'external') {
      Linking.openURL(url).catch(() => undefined);
      return false;
    }
    if (decision.kind === 'done') {
      finish(
        decision.status === 'success'
          ? { kind: 'success', paymentId: decision.txnid ?? pending.request.orderId }
          : { kind: 'failed', reason: 'payment_failed' },
      );
      return false;
    }
    return true;
  };

  return (
    <Modal visible animationType="slide" onRequestClose={() => finish({ kind: 'dismissed' })}>
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <View style={styles.bar}>
          <Text variant="label">{copy.checkout.payu.title}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.checkout.payu.close}
            onPress={() => finish({ kind: 'dismissed' })}
            hitSlop={12}
          >
            <Text variant="label">{copy.checkout.payu.closeShort}</Text>
          </Pressable>
        </View>
        <WebView
          originWhitelist={['*']}
          source={{ html: autoSubmitHtml(form) }}
          onShouldStartLoadWithRequest={onShouldStart}
          onError={() => finish({ kind: 'dismissed' })}
          setSupportMultipleWindows={false}
          javaScriptEnabled
          style={styles.web}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.ground },
  bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: space[5] },
  web: { flex: 1 },
});
```

The imports, `color.ground`, `space[5]` and `<Text variant="label">` are the same ones `MockGateway.tsx` uses; `react-native-safe-area-context` is already a dependency (`~5.7.0`).

Copy — in `src/core/copy.ts`, inside the `checkout` object, add:

```ts
    payu: {
      title: 'Secure payment',
      close: 'Close payment',
      closeShort: 'Close',
    },
```

- [ ] **Step 9: Choose the gateway**

`src/config/env.ts` — add to the schema `EXPO_PUBLIC_MOCK_GATEWAY: z.enum(['0', '1']).default('0'),`, to the `safeParse` input `EXPO_PUBLIC_MOCK_GATEWAY: process.env.EXPO_PUBLIC_MOCK_GATEWAY,`, and to the exported `config` object (after `pusherCluster`) `mockGateway: parsed.data.EXPO_PUBLIC_MOCK_GATEWAY === '1',`.

`gateway/index.ts`:

```ts
import { config } from '../../../config/env';
import { mockGateway } from './MockGateway';
import { payuGateway } from './PayUGateway';
import type { PaymentGateway } from './PaymentGateway';

export type { CheckoutForm, GatewayRequest, GatewayResult, PaymentGateway } from './PaymentGateway';

export class GatewayNotConfiguredError extends Error {}

/** The one place a gateway is chosen. The mock is dev-only and opt-in. */
export function getGateway(): PaymentGateway {
  if (__DEV__ && config.mockGateway) return mockGateway;
  return payuGateway;
}
```

`GatewayNotConfiguredError` stays exported (PayScreen still catches it); the server's `GATEWAY_UNAVAILABLE` now covers "no provider".

`src/features/checkout/index.ts`: add `export { PayUGatewayHost } from './gateway/PayUGateway';` next to the `MockGatewayHost` export.

`app/(app)/_layout.tsx`: import `PayUGatewayHost` with `MockGatewayHost`, and next to line 59 render it unconditionally:

```tsx
      <PayUGatewayHost />
      {__DEV__ ? <MockGatewayHost /> : null}
```

`app.json` — inside `expo.ios` add:

```json
      "infoPlist": {
        "LSApplicationQueriesSchemes": ["upi", "tez", "phonepe", "paytmmp", "gpay", "credpay"]
      },
```

- [ ] **Step 10: Run the app checks**

Run: `npx jest src/features/checkout && npx tsc --noEmit`
Expected: all checkout tests PASS (navigation 5, gateway 7, PayScreen, mock); no type errors.

- [ ] **Step 11: Commit**

```bash
git add src/features/checkout src/config/env.ts src/core/copy.ts app.json package.json package-lock.json "app/(app)/_layout.tsx"
git commit -m "feat(checkout): PayU hosted checkout in a WebView"
```

---

### Task 9: End-to-end on PayU test (manual)

Needs: PayU test key/salt, a public URL for the backend (ngrok in dev), a new dev build of the app (native dependency).

- [ ] **Step 1: Configure**

Backend `.env`: `PAYMENT_PROVIDER=payu`, `PAYU_KEY`, `PAYU_SALT`, `PAYU_ENV=test`, `PUBLIC_API_URL=https://<ngrok-host>`. In the PayU test dashboard → Developers → Webhooks, create webhooks for payment success, payment failure and refund pointing at `https://<ngrok-host>/webhooks/payments`.

- [ ] **Step 2: Build and run**

Run in `PLAY_FRONTEND/apps/player`: `npx eas build --profile development --platform android` (or the team's usual dev-build command), install, and start the backend (`npm run dev:all` in `PALY_BACKEND`).

- [ ] **Step 3: Walk the Done-when list and record results in the PR**

1. Enter a paid category → Pay → PayU page opens in-app → pay with a PayU test card → app shows Pending → entry turns Confirmed (webhook).
2. Repeat with test UPI → the UPI hand-off opens (or PayU's test UPI flow completes) → Confirmed.
3. Close the PayU page mid-payment → back on Pay with no error.
4. Cancel the event as its organizer → refund appears in PayU test dashboard → refund row becomes `processed` (via refund notice or the 15-minute reconciliation).
5. `curl -X POST https://<ngrok-host>/webhooks/payments -d 'mihpayid=1&status=success&hash=bad'` → HTTP 400, nothing written.
6. Unset `PAYMENT_PROVIDER`, restart → Pay shows "Payments are briefly unavailable" exactly as before.

- [ ] **Step 4: Final checks**

Run in `PALY_BACKEND`: `npm run check` (typecheck, lint, guard, all tests — Docker running).
Run in `PLAY_FRONTEND/apps/player`: `npx tsc --noEmit && npx jest`.
Expected: all green. Report anything not run and why.
