# PayU collection — design

**Date:** 2026-09-25
**Status:** Draft — awaiting review
**Part 1 of 4** in the hosting programme: (1) PayU collection → (2) organizers + hosting in the
player app → (3) host payouts via PayU Split Settlements → (4) pickup games.

---

## Why

No payment gateway is wired. `src/platform/paymentGateway.ts` runs `unconfiguredGateway`, so free
entries confirm and every paid checkout fails with `GATEWAY_UNAVAILABLE`. Hosts will charge entry
fees (part 3), which needs players to be able to pay at all. The provider is **PayU** — the team has a
PayU merchant account with test keys. Its Split Settlements product is the payout path for part 3.

## Goal

A player pays for a paid entry in the player app through PayU (card, UPI, netbanking), and the entry
confirms through the existing webhook and reconciliation paths. Refunds go through PayU. Nothing
changes when PayU is not configured.

## Non-goals

- Host payouts, splits, child-merchant onboarding — part 3. This design only keeps room for them.
- PayU's native CheckoutPro SDK. The seam allows swapping it in later.
- Organizer-facing money screens.

---

## Existing contracts this keeps

- `payments R5` — a registration confirms **only** on a verified `payment.captured` webhook or on
  reconciliation. The return from PayU's page is a UI hint.
- `payments R3` — duplicate webhook deliveries are a 200 with no work.
- `payments R7` — refunds are idempotent; the idempotency key is sent to the provider.
- `payments R9` — `reconcile-pending` asks the gateway what actually happened.
- `checkout R1` — the client never moves an entry to confirmed. `checkout R10` — backing out is not
  an error.

**Amended:** `payments R2` says HMAC-SHA256. PayU signs with a SHA-512 "reverse hash" over the
payment fields and the salt. R2 becomes "verify the provider's signature over the received fields,
timing-safe; a bad signature is a 400 and no write". The raw-body rule stays — the adapter parses the
form body itself.

---

## PayU facts relied on

Sources: docs.payu.in — *Generate Hash for PayU Hosted Checkout*, *Webhook Events and Sample
Payloads*, *Webhooks for Refunds*, *Release Settlement API*.

| Fact | Use |
|---|---|
| Request hash `sha512(key\|txnid\|amount\|productinfo\|firstname\|email\|udf1\|…\|udf5\|\|\|\|\|\|SALT)` | Signing `createOrder` |
| Response hash `sha512(SALT\|status\|\|\|\|\|\|udf5\|…\|udf1\|email\|firstname\|productinfo\|amount\|txnid\|key)` | Verifying the return POST and payment webhooks |
| Payment webhooks are `application/x-www-form-urlencoded` POSTs with `mihpayid`, `txnid`, `status`, `amount`, `hash`, `udf*`; PayU retries 3 times without a 200 | `parseWebhook` |
| Refund webhooks are JSON; the docs do not specify their signature | Treated as a trigger only (below) |
| `postservice` commands `verify_payment` (by txnid), `cancel_refund_transaction` (mihpayid, token, amount), `check_action_status` (refund status) | Reconciliation, refunds |
| `txnid` has a length cap shorter than a UUID | Short generated txnid |
| `amount` is rupees as a decimal string | Convert from paise at the edge only |

The adapter's tests pin each hash against a worked example taken from PayU's docs, and the exact
`txnid` cap and `postservice` field names are confirmed against the test environment in the first
plan task.

---

## Backend

### 1. Port changes — `src/platform/paymentGateway.ts`

```ts
export interface CheckoutForm {
  /** The URL the client POSTs to (PayU's hosted page). */
  action: string;
  /** Signed fields, posted unchanged. Never contains a secret. */
  fields: Record<string, string>;
}

export interface GatewayOrder {
  id: string;            // PayU: our generated txnid
  amountPaise: bigint;
  currency: string;
  status: string;
  checkout: CheckoutForm;
}

createOrder(input: {
  amountPaise: bigint;
  currency: string;
  receipt: string;                 // payment_orders.id
  payer: { name: string; email: string; phone: string | null };
  description: string;             // PayU productinfo
  notes?: Record<string, string>;
}): Promise<GatewayOrder>;

/** Refund status from the provider, for providers whose refund webhooks are unsigned. */
refundStatus(gatewayRefundId: string): Promise<GatewayRefund>;
```

- `publicKey` is removed — it was a Razorpay-ism; PayU's merchant key travels inside `fields`.
- `GatewayWebhookEvent` gains `{ id; type: 'refund.check'; gatewayRefundId }` — "ask the provider".
- `paymentGateway` is chosen from config: `PAYMENT_PROVIDER=payu` → `createPayU(config)`; unset →
  `unconfiguredGateway` (unchanged behaviour).

### 2. Adapter — `src/platform/payu.ts`

`fetch`, no SDK (same stance as `push.ts`). All hashing is here; the salt is read only here.

- **`createOrder`** — txnid = a short random id (base32, fits the cap), stored as
  `payment_orders.gateway_order_id`. Builds `fields`: `key, txnid, amount, productinfo, firstname,
  email, phone, surl, furl, udf1 = payment_orders.id, hash`. `surl` and `furl` are both
  `${PUBLIC_API_URL}/payments/payu/return`. No network call.
- **`paymentsForOrder(txnid)`** — `verify_payment`; normalises each transaction to `GatewayPayment`
  (`success → captured`, `failure → failed`, else in flight). `id = mihpayid`.
- **`refund`** — `cancel_refund_transaction` with `token = idempotencyKey`. Returns PayU's request id
  as `GatewayRefund.id`, status `pending`.
- **`refundStatus`** — `check_action_status` by request id.
- **`parseWebhook(raw, headers)`**
  - form-encoded body → verify reverse hash (timing-safe) → `payment.captured` / `payment.failed`,
    event id = `${mihpayid}:${status}` (stable across PayU's retries, so R3 dedupe holds).
  - JSON body with a refund request id → `refund.check` (no trust in its status field).
  - anything else, or a bad hash → `null` → 400.
- Timeouts 5 s; a 5xx or network error throws so jobs retry.

### 3. Payments service

- `createOrder(actor, registrationId)` passes `payer` (from identity: display name, email, phone)
  and `description` (event title · category). It returns `checkoutForm` in place of `gatewayKey`.
- `refund.check` → enqueue `check-refund` job → `gateway.refundStatus` → existing
  `applyRefundProcessed` / `applyRefundFailed`. `reconcile-pending` also sweeps refunds still
  `pending` after 30 minutes the same way, so a missed refund webhook costs a delay, not money.

### 4. Return route — `src/platform/webhooks/payuReturn.ts`

`POST /payments/payu/return` (form body; mounted before `express.json()` like the webhook).

1. Verify the reverse hash. Bad → redirect to `/payments/payu/done?status=failure&reason=signature`.
2. Redirect `303` to `/payments/payu/done?status=success|failure&txnid=…`.
3. **No state change.** Confirmation stays with the webhook and reconciliation (R5).

`GET /payments/payu/done` returns a tiny "You can close this" HTML page — the app intercepts the
navigation before it loads; a desktop browser just sees the page.

### 5. GraphQL

`createPaymentOrder` payload: `razorpayOrderId`, `razorpayKeyId` → `gatewayOrderId: String`,
`checkoutForm: CheckoutForm` (`action: String!`, `fields: [CheckoutField!]!` as key/value pairs —
GraphQL has no map type). `schema.graphql` regenerated.

### 6. Config — `src/platform/config.ts`

`PAYMENT_PROVIDER` (`none` | `payu`, default `none`), `PAYU_KEY`, `PAYU_SALT`, `PAYU_ENV`
(`test` | `prod`), `PUBLIC_API_URL`. `payu` without key/salt fails startup — a half-configured
gateway is worse than none.

---

## Player app

### 7. Gateway — `src/features/checkout/gateway/PayUGateway.tsx`

Implements the existing `PaymentGateway` seam; `PayScreen` changes only in the fields it passes.

- `open(request)` renders a full-screen modal with `react-native-webview` (new native dependency →
  new EAS build).
- The WebView loads an inline HTML page that auto-submits `checkoutForm` to `action` (values
  HTML-escaped). The client posts exactly what the server signed.
- `onShouldStartLoadWithRequest`:
  - `upi:`, `intent:`, `tez:`, `phonepe:`, `paytmmp:`, `gpay:` → `Linking.openURL`, return `false`.
    The PayU page keeps polling and continues when the player comes back.
  - URL starting with `${API_URL}/payments/payu/done` → parse `status`, resolve
    `success` (`paymentId = txnid`) or `failed`, close, return `false`.
  - everything else loads.
- Close button, Android back, or a load error → `dismissed` (`checkout R10`). A payment completed in
  a UPI app after dismissal still confirms via webhook/reconciliation; Pending polling picks it up.

### 8. Wiring

- `api.ts`: request `gatewayOrderId` and `checkoutForm { action fields { key value } }`.
- `GatewayRequest`: `{ orderId, amountPaise, description, checkoutForm }` (drops `keyId`).
- `getGateway()`: PayU when the order carries a `checkoutForm`; the mock remains in `__DEV__` when
  `EXPO_PUBLIC_MOCK_GATEWAY=1`.
- `app.json`: `ios.infoPlist.LSApplicationQueriesSchemes` = the UPI schemes above.

---

## Error handling

| Case | Result |
|---|---|
| PayU unreachable on `verify_payment` / refund | Job throws, retries (3 × exp); reconciliation catches up |
| Tampered webhook | 400, nothing written (R2) |
| Duplicate webhook | 200, no work (R3) |
| Tampered return POST | Redirect to `failure`; the entry is unaffected, webhook decides |
| Player closes the page mid-UPI | `dismissed`; webhook/reconciliation confirm if money moved |
| `PAYMENT_PROVIDER` unset | Identical to today: `GATEWAY_UNAVAILABLE` for paid checkout |

## Testing

Backend (vitest):
- Request and response hashes against PayU's worked examples.
- `parseWebhook`: valid capture, valid failure, bad hash → null, refund JSON → `refund.check`,
  stable event id across retries.
- Adapter against a faked `fetch`: `verify_payment` normalisation, refund with idempotency token,
  5xx throws.
- Return route: good hash → success redirect, bad hash → failure redirect, no DB writes either way.
- Payments integration (Postgres): capture via PayU-shaped webhook confirms the registration;
  `refund.check` → processed.

App (jest, WebView mocked):
- Navigation to `/payments/payu/done?status=success` resolves `success`; `failure` → `failed`.
- A `upi://` navigation goes to `Linking.openURL` and is not loaded.
- Close → `dismissed`.
- The posted form equals `checkoutForm` exactly.

## Done when

On PayU's test environment, a player pays for a paid entry in the app with a test card and with test
UPI, and the entry confirms via webhook. An event cancellation's refund reaches PayU and is recorded
as processed. A tampered webhook is rejected with a 400. With `PAYMENT_PROVIDER` unset, behaviour is
unchanged.

## Room left for part 3

The signed request is built in one place (`createOrder`), so part 3 adds PayU's split parameters
(child merchant id, host share, `aggregatorCharges` = platform fee) there, and a release-settlement
call as a new job. No part-1 contract changes for it.
