# 07 — payments

| | |
|---|---|
| **Sprint** | 4 |
| **Phase** | 1 |
| **Depends on** | nothing (calls `events.priceQuote`, `registration.confirmFromPayment`) |
| **Owns** | `payment_orders`, `payments`, `refunds`, `payment_webhook_events`, `ledger_entries`, `payout_accounts`, `payouts`, `payment_disputes` |
| **Rule prefix** | `payments R*` |
| **Risk** | **Highest in the system** |

Gateway orders, webhook ingest, refunds, a ledger, and payouts to organizers and venues. Knows
nothing about tournaments. It moves money against a **subject** (a registration; from Phase 3 also
a court booking or a ticket order, R20) and tells the subject's module what happened.

**The webhook is the truth.** The provider's client-side return (the hosted page redirecting back to
the app) is a UI hint and confirms nothing.

> **Provider:** Razorpay (Standard Checkout in the app's WebView), `src/platform/razorpay/`.
> Selected by `PAYMENT_PROVIDER=razorpay`; unset keeps the unconfigured gateway. Replaced PayU on
> 2026-10-03 (the PayU design, `docs/superpowers/specs/2026-09-25-payu-collection-design.md`, is
> history). Webhook to configure in the Razorpay dashboard: `${PUBLIC_API_URL}/webhooks/payments`
> with `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed`, and its secret
> in `RAZORPAY_WEBHOOK_SECRET`. Payments must be **captured automatically** (Dashboard → Payment
> Capture): an authorised payment that is never captured is auto-refunded and never confirms.
>
> The browser leg: the app POSTs the checkout form to `/payments/razorpay/checkout`, our page that
> runs checkout.js with `redirect: true` (popups cannot return to a WebView) and `webview_intent`
> (UPI apps open by intent on Android — the reason it is not Hosted Checkout, which has no UPI
> intent). Razorpay posts the player back to `/payments/razorpay/return`, which verifies
> `razorpay_signature` and redirects to `/payments/razorpay/done`, the URL the app closes on.

---

## Service interface

```ts
createOrder(actor, registrationId)                 => { orderId, gatewayOrderId, checkout, amountPaise, quote }
ingestWebhook(rawBody: Buffer, headers)            => { accepted, duplicate, status }
applyWebhook(gatewayEventId: string)               => void    // job, not request
refund(actor, paymentId, amountPaise, reason)      => Refund
bulkRefund(eventId, reason)                        => { queued: number }
reconcilePending()                                 => { resolved: number }
ledgerFor(registrationId)                          => LedgerEntry[]
receipt(actor, paymentId)                          => Receipt      // rendered, not stored (R11)

// Sprint 7 — payouts and disputes
ledgerSummary(eventId)                             => { grossPaise, refundedPaise, feesPaise, netPaise, asOf }
createPayoutAccount(actor, { ownerType, ownerId, businessDetails }) => PayoutAccount   // R13
payoutAccountFor(ownerType, ownerId)               => PayoutAccount | null
payoutQuote(eventId)                               => PayoutQuote  // pure, over the ledger (R14)
settleEvent(eventId)                               => Payout       // job (R14, R15)
holdPayout(actor, payoutId, reason)                => Payout       // admin (R16)
releasePayout(actor, payoutId, reason)             => Payout
payoutsFor(ownerType, ownerId, page)               => Page<Payout>
```

## GraphQL

```graphql
Mutation.createPaymentOrder(registrationId: ID!): CreatePaymentOrderPayload!
Query.paymentHistory(first: Int = 20, after: String): PaymentConnection!
Query.receipt(paymentId: ID!): Receipt!    # rendered from the ledger — R11
Query.payoutAccount(ownerType: PayoutOwnerType!, ownerId: ID!): PayoutAccount   # R13
Query.payouts(ownerType: PayoutOwnerType!, ownerId: ID!, first: Int = 20, after: String): PayoutConnection!
Mutation.createPayoutAccount(input: CreatePayoutAccountInput!): PayoutAccountPayload!

type CreatePaymentOrderPayload {
  gatewayOrderId: String        # Razorpay: order_…
  checkoutForm: CheckoutForm    # { action, fields[] } — POSTed unchanged to open checkout
  amountPaise: Int
  quote: PriceQuote
  userError: CreatePaymentOrderError
}
```

The webhook is **not** GraphQL. It is `POST /webhooks/payments` (provider-neutral; the adapter
behind `platform/paymentGateway.ts` parses it), mounted with `express.raw` before `express.json()`. See [architecture.md § 2](../architecture.md#middleware-order-is-load-bearing).

---

## Rules

**R1** — The order amount is recomputed server-side from `events.priceQuote()` at order creation. An
amount arriving from a client is **ignored**, not validated.

**R2** — The webhook route receives the raw body, and the provider adapter verifies the provider's
signature over the received bytes with a **timing-safe** comparison (Razorpay:
`X-Razorpay-Signature`, HMAC-SHA256 of the raw body under the webhook secret). A bad signature is a
400 and nothing is written. Razorpay's signature covers the whole payload, payment id included, so
a verified `payment.*` / `refund.*` event is applied as it stands. The port still carries
`payment.check` and `refund.check` — "ask the provider" notices for a provider whose notices can't
be trusted for their facts; Razorpay never emits them, and both settle through the same functions
reconciliation uses.

**R3** — Ingest claims `gateway_event_id` as a primary key **before doing anything else**. A
duplicate delivery inserts nothing and returns 200 immediately, so the provider stops retrying.
(Razorpay's event id is its `x-razorpay-event-id` header, the same on every retry of one event. A
`refund.check` for a refund we never sent is answered 200 with **no** claim row and no job, so
unsigned traffic cannot amplify into writes.)

**R4** — Ingest acknowledges in **under one second** and does the state change in a job. Gateways
time out within seconds and will retry a slow success, which is how you get double-processing.

**R5** — A registration confirms only on a payment the gateway itself reports as captured — via a
verified notice (`payment.captured`, or a `payment.check` followed by `paymentsForOrder`) or via
reconciliation. Nothing else confirms a registration. A capture on an entry already
`payment_failed` (Razorpay's checkout retries on the same order) confirms while the seat hold lives; a
capture that can no longer be confirmed (hold lapsed, expired, withdrawn) is refunded in full with
reason `late_capture`, idempotently, instead of failing forever. A signed success/failure notice
the gateway cannot yet back up makes the job retry rather than be marked processed.

**R6** — Every money movement writes a `ledger_entries` row — charge, platform fee, tax, refund,
reversal, and for host payouts `host_commission`, `commission_tax`, `tds_withheld`, `host_payout`,
`host_receivable`, `receivable_recovered` (linked by `payout_id`). The **ledger**, not the payments
table, is what reconciles against the provider's settlement report.

**R7** — Refunds are idempotent on `(payment_id, reason, amount_paise)` unless an explicit
idempotency key is supplied. Retrying a refund must never send money twice.

**R8** — A refund may never exceed `captured − already_refunded`, enforced against the sum inside
the transaction.

**R9** — `reconcile-pending` runs every 15 minutes over every open (`created`/`attempted`) order
created between 48 hours and 30 minutes ago, queries the gateway for truth, and drives the state
machine from the answer; sent-but-unsettled refunds are asked about for 7 days. Older rows age out so
abandoned checkouts cannot starve the batch (a capture older than 48 h with a lost webhook needs
manual recovery). An open order is reused only for a double-tap on Pay (under 10 seconds old):
every later return to Pay mints a new order, so each checkout session has its own, and the old one
stays reconcilable. One order can still carry several attempts (checkout retries in place), and a
failed attempt's notice may arrive after the captured one: it is recorded and changes nothing — a
`paid` order is never moved back to `failed`. **This is
Phase 1 work**, not later hardening — it turns a lost webhook from a support ticket into a
30-minute delay.

**R10** — Raw gateway payloads are stored on the payment row. When a player disputes a charge in
four months, that payload is the evidence.

**R11** — **Receipts are rendered on demand, never stored as files.** `receipt()` builds the
document from `ledger_entries` and returns structured data; the app renders it and the confirmation
email embeds it inline. There is no PDF, no bucket and no signed file URL.

This is deliberate. Cloudinary is the only media store in the stack and it is for images — pushing a
PDF through an image CDN is the mistake [ADR 0003](../decisions/0003-cloudinary-for-media.md)
explicitly warns against. Since the ledger is already the source of truth, a stored file would only
be a second copy that can disagree with it.

> **When this changes:** if GST rules require a numbered tax invoice retained as a document, that is
> the point to add object storage for non-image artefacts — not to reach for Cloudinary. Add an
> `invoices` table with a sequential invoice number at the same time; a receipt you can re-render is
> not the same thing as an invoice you must be able to reproduce byte-for-byte.

**R12** — Payment emails — confirmation, failure, refund processed — are sent through the Resend
adapter by this module, not by `notifications`. That module owns the in-app feed and push;
transactional email belongs to the module that owns the action
([ADR 0002](../decisions/0002-email-otp-via-resend.md)). A payment email is still accompanied by a
`notifications.emit()` so the in-app feed stays complete.

**R13** — *Superseded 2026-10-02* — hosts are paid through RazorpayX payouts (PayU Payouts until
2026-10-03) from the platform's balance, not Split Settlements. See `docs/superpowers/specs/2026-10-02-host-payouts-design.md` (payouts
R1–R16). Migration 032 drops the unused sub-merchant `payout_accounts` table and replaces it.

**R14** *(Sprint 7)* — **Settlement.** Each event's payout is computed once, at
`events.ends_at + 72 h`, by `payoutQuote()`, a pure function over `ledger_entries`: entry-fee
charges, minus entry-fee refunds, minus the gateway fee share (`GATEWAY_FEE_BEARER` config), minus
any `organizer_receivable` (R17). Platform fees and their tax stay with the platform. Venue
payouts (`bookings R9`) settle weekly with the same function. The 72-hour delay lets result
disputes and post-event withdrawals land first.

> **Before Sprint 7:** confirm the GST treatment of entry fees (who is the supplier) with a
> chartered accountant. `payoutQuote` takes the treatment as config, so the answer is data, not a
> refactor.

**R15** — A transfer is idempotent on `payouts.id`, and a unique index allows **one payout per
subject per payout account**. A retried `settle-event-payouts` job can never pay twice. A failed
transfer pages, because someone is owed money.

**R16** — A payout is **held**, with the reason stored, when the owner is unverified or suspended,
when an admin opens a fraud case (`admin R8`), when a payment for the event has an open dispute
(R19), or while refunds for the event are still `pending`. `finance` or `admin` releases a hold, or
it releases automatically once the condition clears.

**R17** — **Refunds after payout.** The player is refunded from the platform balance at once; a
player never waits on an organizer. The refunded entry fee, less the commission already taken on
it, is written as a `host_receivable` ledger entry (payouts R15) and netted against the host's next
payout.

**R18** — Every payout, reversal, gateway fee and receivable writes `ledger_entries` rows (extends
R6), so the settlement report still reconciles from the ledger alone.

**R19** *(Sprint 7)* — **Disputes and chargebacks.** The provider's dispute webhooks create
`payment_disputes` rows, hold the related payout (R16), and emit `dispute.opened` for `admin`. A
lost dispute writes a `dispute_debit` ledger entry. The evidence is the raw payload stored under
R10, plus the registration timeline.

**R20** *(Sprint 14)* — **Order subjects.** A `payment_orders` row carries exactly one subject —
`registration_id`, `booking_id` or `ticket_order_id` — enforced by a CHECK. Each subject module
exposes `confirmFromPayment` / `failFromPayment`, and `apply-webhook` dispatches on the subject
type. Payments still knows nothing about the domain. R1 and R5 apply to every subject, with the
amount recomputed from that module's `quote()`.

---

## Webhook handler

`src/platform/webhooks/payments.ts` → `payments.ingestWebhook(raw, headers)`:

1. `gateway.parseWebhook(raw, headers)` verifies and normalises (R2). `null` → 400, nothing written.
2. A `refund.check` for a refund we never sent → 200, nothing written, no job (R3).
3. Claim `gateway_event_id` in `payment_webhook_events`; a duplicate → 200 immediately (R3).
4. Enqueue `apply-webhook` and return 200 (R4).

### Events handled

| Normalised event | Action |
|---|---|
| `payment.check` (no current provider) | Ask `paymentsForOrder`; apply the capture/failure below. Signed success/failure with nothing final yet → throw, retried |
| `refund.check` (no current provider) | Ask `refundStatus` for a refund we sent; apply below |
| `payment.captured` | `registration.confirmFromPayment()`; ledger charge + fee + tax; `late_capture` refund if unconfirmable |
| `payment.failed` | `registration.failFromPayment()`; hold left alive (registration R8). On an order already `paid`: recorded only |
| `refund.processed` | Mark refund processed (conditional update — applied once); ledger reversal |
| `refund.failed` | Alert; refund stays `pending` for manual retry |
| `order.paid` | Treated as `payment.captured` (it carries the same payment); applying both is idempotent |
| Payout-provider account status events *(part 3)* | Update `payout_accounts.status` (R13) |
| Transfer processed / failed / reversed | Update `payouts`; ledger (R15, R17, R18) |
| Dispute created / won / lost / closed | `payment_disputes`; payout hold; ledger on loss (R19) |

The exact event names for payout accounts, transfers and disputes are taken from the payout
provider's current webhook reference (Razorpay Route / RazorpayX, part 3) when that adapter is built,
and recorded fixtures pin them (conventions §5).

---

## Refund policy

| Situation | Refund | Path |
|---|---|---|
| Player cancels before `cancellation_cutoff_at` | Entry fee, full | Platform fee retained — **disclosed in the quote at checkout** |
| Player cancels after cutoff | None | Slot still returns to the pool (registration R9) |
| Organizer cancels the event | Total, full | Bulk refund; platform fee absorbed |
| Category misses `min_entries` | Total, full | Automatic at `registration_closes_at` |
| Player withdraws after the draw | Organizer discretion | Manual partial; opponent gets a walkover, ratings unaffected |
| Organizer withdraws an entry | Organizer discretion | `registration R16` |
| Refund after the organizer was paid | As above | Player refunded at once; recovered by transfer reversal (R17) |
| Court booking cancelled by player | Per venue policy | `bookings R6` — Phase 3 |
| Court booking cancelled by venue | Total, full | `bookings R6` — Phase 3 |
| Ticket order | Refundable types only, before sales close | `ticketing R6` — Phase 3 |

---

## Schema

```sql
CREATE TABLE payment_orders (
  id                 uuid PRIMARY KEY,
  registration_id    uuid NOT NULL REFERENCES registrations(id),
  gateway_order_id   text UNIQUE NOT NULL,   -- Razorpay: order_…
  entry_fee_paise    bigint NOT NULL,
  platform_fee_paise bigint NOT NULL,
  tax_paise          bigint NOT NULL,
  amount_paise       bigint NOT NULL,
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','attempted','paid','failed','expired')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payment_orders (registration_id);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  payment_order_id    uuid NOT NULL REFERENCES payment_orders(id),
  gateway_payment_id text UNIQUE NOT NULL,   -- Razorpay: pay_…
  method              text,                  -- upi | card | netbanking | wallet
  amount_paise        bigint NOT NULL,
  status              text NOT NULL CHECK (status IN
                        ('authorized','captured','failed','refunded','partially_refunded')),
  failure_reason      text,
  captured_at         timestamptz,
  raw                 jsonb NOT NULL         -- evidence (R10)
);

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY,
  payment_id         uuid NOT NULL REFERENCES payments(id),
  gateway_refund_id  text UNIQUE,           -- Razorpay: rfnd_…
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  reason             text NOT NULL,
  idempotency_key    text UNIQUE NOT NULL,   -- R7
  status             text NOT NULL CHECK (status IN ('pending','processed','failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);

-- Idempotency. Gateways retry; this table is why that is harmless. (R3)
CREATE TABLE payment_webhook_events (
  gateway_event_id   text PRIMARY KEY,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  attempts           smallint NOT NULL DEFAULT 0,
  last_error         text
);

-- What actually reconciles against a settlement report. (R6)
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  registration_id uuid REFERENCES registrations(id),
  payment_id      uuid REFERENCES payments(id),
  refund_id       uuid REFERENCES refunds(id),
  kind            text NOT NULL CHECK (kind IN
                    ('charge','platform_fee','tax','refund','fee_reversal','tax_reversal')),
  amount_paise    bigint NOT NULL,           -- signed: credits positive, debits negative
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (registration_id);

-- Sprint 7: payouts and disputes (R13–R19)
CREATE TABLE payout_accounts (
  id                  uuid PRIMARY KEY,
  owner_type          text NOT NULL CHECK (owner_type IN ('organizer','venue')),
  owner_id            uuid NOT NULL,
  provider_account_id text UNIQUE,         -- payout provider (part 3)
  status              text NOT NULL DEFAULT 'created' CHECK (status IN
                        ('created','under_review','needs_clarification','active','suspended')),
  raw                 jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE payouts (
  id                   uuid PRIMARY KEY,
  payout_account_id    uuid NOT NULL REFERENCES payout_accounts(id),
  subject_type         text NOT NULL CHECK (subject_type IN ('event','venue_week')),
  subject_key          text NOT NULL,             -- event id, or 'venue:<id>:2027-W14'
  amount_paise         bigint NOT NULL CHECK (amount_paise >= 0),
  quote                jsonb NOT NULL,            -- payoutQuote() output, frozen (R14)
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                         ('scheduled','held','processing','processed','failed','reversed')),
  hold_reason          text,                      -- R16
  provider_transfer_id text UNIQUE,
  scheduled_for        timestamptz NOT NULL,
  processed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_key, payout_account_id)       -- R15
);

CREATE TABLE payment_disputes (
  id                  uuid PRIMARY KEY,
  payment_id          uuid NOT NULL REFERENCES payments(id),
  provider_dispute_id text UNIQUE NOT NULL,
  amount_paise        bigint NOT NULL,
  reason_code         text,
  status              text NOT NULL CHECK (status IN ('open','under_review','won','lost','closed')),
  respond_by          timestamptz,
  raw                 jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ledger_entries
  ADD COLUMN payout_id uuid REFERENCES payouts(id),
  DROP CONSTRAINT ledger_entries_kind_check,
  ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN
    ('charge','platform_fee','tax','refund','fee_reversal','tax_reversal',
     'gateway_fee','payout','payout_reversal','organizer_receivable','dispute_debit'));  -- R18

-- Sprint 14: order subjects (R20)
ALTER TABLE payment_orders
  ALTER COLUMN registration_id DROP NOT NULL,
  ADD COLUMN booking_id uuid,                     -- FK in 019_bookings
  ADD COLUMN ticket_order_id uuid,                -- FK in 020_ticketing
  ADD CONSTRAINT payment_orders_one_subject CHECK (
    num_nonnulls(registration_id, booking_id, ticket_order_id) = 1);
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `PAYMENT_FAILED` | user | Payment-failed screen; retry reuses the hold if alive |
| `ORDER_ALREADY_PAID` | user | Route to the confirmed registration |
| `REFUND_WINDOW_CLOSED` | user | Explain the policy |
| `REFUND_EXCEEDS_CAPTURED` | system | Bug — R8 |
| `BAD_SIGNATURE` | system | HTTP 400, never 500 |
| `GATEWAY_UNAVAILABLE` | system | Retry with backoff |
| `PAYOUT_ACCOUNT_NOT_ACTIVE` | user | Show payout-account onboarding status — R13 |
| `PAYOUT_ON_HOLD` | user | Show the hold reason — R16 |
| `TRANSFER_FAILED` | system | Page — R15 |

## Emits

| Event | Consumers |
|---|---|
| `payment.captured` | registration, notifications |
| `payment.failed` | registration, notifications |
| `refund.processed` | notifications, organizers (analytics), admin (fraud), realtime |
| `payout.processed` / `payout.failed` / `payout.held` | notifications, organizers |
| `payout_account.updated` | organizers, notifications |
| `dispute.opened` | admin, notifications |

## Jobs

| Job | Trigger | Retry | Final failure |
|---|---|---|---|
| `apply-webhook` | Webhook ingest | 5 × exp | **Page** — money unreconciled |
| `reconcile-pending` | Every 15 min | 3 × exp | Alert |
| `process-refund` | Cancellation | 5 × exp | **Page** — a player is owed money |
| `bulk-refund` | Event cancellation | 5 × exp | **Page** |
| `settle-event-payouts` | Hourly — events past `ends_at + 72 h` | 5 × exp | **Page** — an organizer is owed money |
| `settle-venue-payouts` | Weekly | 5 × exp | **Page** |
| `reverse-transfer` | Refund after payout | 5 × exp | Alert; receivable written (R17) |

---

## Done when

- A test-mode UPI payment confirms an entry end to end.
- Five duplicate webhook deliveries produce exactly **one** payment, **one** ledger entry, **one**
  push.
- A deliberately dropped webhook is resolved by `reconcile-pending` within 30 minutes, with no human
  involved.
- The count of `payment_pending` older than 30 minutes sits at **zero** on the operations dashboard.

---

## Implementation checklist

- [ ] Migration `007_payments.sql`
- [x] Provider adapter behind `platform/paymentGateway.ts`; Razorpay in `platform/razorpay/` (no SDK)
- [ ] `createOrder` recomputing the amount from `events.priceQuote()` (R1)
- [ ] Webhook route with `express.raw`, timing-safe HMAC (R2)
- [x] Claim-first idempotency on `gateway_event_id` (R3); ack under 1 s (R4)
- [ ] `apply-webhook` job handling captured / failed / refund.processed / refund.failed
- [ ] Ledger rows for every movement (R6) + a reconciliation report query
- [ ] `receipt()` rendered from `ledger_entries`; no file is written anywhere (R11)
- [ ] Payment / failure / refund emails via the Resend adapter, each paired with `notifications.emit()` (R12)
- [ ] Refund idempotency key + the `captured − refunded` guard (R7, R8)
- [ ] `reconcile-pending` repeatable job (R9)
- [ ] Contract tests against recorded fixtures, **including** duplicate delivery and
      webhook-before-callback ordering
- [ ] Dashboard metric: `payment_pending` older than 30 min
- [ ] Tests naming R1, R2, R3, R5, R6, R7, R8, R9, R11
- [ ] *(Sprint 7)* **Confirm the GST treatment of entry fees with a CA** — an input to `payoutQuote` (R14)
- [ ] *(Sprint 7)* Payout-provider linked accounts (part 3); `payout_accounts` + webhooks (R13)
- [ ] *(Sprint 7)* `payoutQuote` pure function; `settle-event-payouts`; one-payout unique index (R14, R15)
- [ ] *(Sprint 7)* Holds, refund-after-payout reversal and receivables, ledger kinds (R16, R17, R18)
- [ ] *(Sprint 7)* Dispute webhooks + payout hold (R19)
- [ ] *(Sprint 14)* Order subjects with dispatch by type (R20)
- [ ] Tests naming R13, R14, R15, R16, R17, R19, R20

---

## Additions 2026-10-04 (flow review F3, F9, F27)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

- **F3** — automatic payout holds `player_report` (an open report newer than the last staff release) and
  `no_play_evidence` (no started match, scored heat or check-in), for events not cancelled. `releasePayout`
  stamps `payouts.review_cleared_at`, which lifts both until a newer report. A host's first paid payout is due
  7 days after the end (`FIRST_PAYOUT_DELAY_MS`), later ones 72 h.
- **F27** — the capture writes `payments.fee_paise` and a `gateway_fee` ledger row from the gateway payload
  (`fee`). On an event the host cancelled, those fees come out of the host's payout (`gatewayFeesPaise`; a
  shortfall is a receivable as before). `refundForRegistration` takes `fractionBps` for partial refunds.
- **F9** — `Payout.event`.
