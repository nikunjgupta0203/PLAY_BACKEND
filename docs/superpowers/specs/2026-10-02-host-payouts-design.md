# Host verification and payouts — design

| | |
|---|---|
| **Date** | 2026-10-02 |
| **Status** | Draft — awaiting review |
| **Modules** | `payments` (owner), `events` (publish gate), `notifications`, `identity` (staff roles) |
| **Unblocks** | Paid player-hosted events (`events R10`, app `host R6`) |
| **Supersedes** | `payments R13` (Split Settlements sub-merchants) and the reversal half of `payments R17` |

## Goal

A player who hosts an event can publish **paid** categories once we know where to send their money,
and they receive their share automatically after the event. The platform keeps 10% of each entry fee
(`HOST_COMMISSION_BPS`, already shipped), taken from the host's share.

Success looks like: a host adds their bank account in the app, is verified within a minute in the
common case, publishes a paid event, and three days after it ends sees the money land by IMPS, with
a payout row that reconciles to the ledger to the paisa.

## Decisions (made in chat, 2026-10-02)

1. **Platform payouts, not Split Settlements.** We keep collecting every rupee through PayU
   collection as today, then pay the host's share from **PayU Payouts** by IMPS. Hosts are casual
   players; onboarding each one as a PayU sub-merchant is too heavy.
2. **Verification is automatic with a staff fallback.** A strong bank name match verifies at once; an
   ambiguous result goes to a review queue instead of a rejection.
3. **Staff actions are backend only for now.** Staff-only GraphQL operations; the admin web app will
   call them later. No staff UI in the player app.
4. **The payout account belongs to the user.** There is no organizer entity yet; `events.organizer_id`
   is a user id, so the account is keyed on `user_id`.

## What PayU actually offers (checked against docs.payu.in, 2026-10-02)

| Need | PayU | Consequence |
|---|---|---|
| Bank account check | **Verify Account / Penny Test** (`POST /payout/payment/verifyAccount`): returns `accountExists` (`YES` / `No` / `VERIFICATION_PENDING`), the bank's `beneficiaryName` and a `nameMatch` score 0–100 | This is the verification. Poll when pending. |
| PAN check | **None in Payouts.** PAN APIs exist only inside PayU's own merchant-onboarding KYC | PAN is captured and format-checked, not verified by an API (see R4) |
| Transfer | **Initiate Transfer** (`/payout/v2/payment`), IMPS/NEFT/UPI, `merchantRefId` ≤ 40 chars, accepted asynchronously | `merchantRefId` = our payout id (idempotency). Final status comes later. |
| Status | Webhooks plus **Check Transfer Status API**. Lifecycle: `QUEUED → IN PROGRESS → PENDING → SUCCESS \| FAILURE \| REVERSED`, also `WAITING FOR RETRY`, `CANCELLED` | Webhook is a hint; the status API is the truth (same stance as `payments R2`'s `payment.check`) |
| Funding | Payouts draw from a separate **Payouts virtual account** topped up by bank transfer. Collections do **not** flow into it. Low balance leaves transfers `QUEUED` | Finance must keep it funded; we check balance before sending (R12) |
| Auth | Separate `payoutMerchantId`, OAuth token from a private client id/secret, with TTL and refresh. Optional IP allow-listing by email to PayU | New config; token cached in process |
| Beneficiary | Transfer takes account number + IFSC each call; saved beneficiaries need enabling by the PayU account manager | We must keep the account number, encrypted (R2) |
| Reversal | No pull-back of a completed IMPS | A refund after payout becomes a receivable (R15) |

## Prerequisites outside the code (owner: business)

- PayU Payouts activated on the merchant account; `payoutMerchantId`, client id and secret issued for
  test and prod.
- Payouts webhook URL registered with PayU; production server IPs sent to `payoutqueries@payu.in` if
  IP check is enabled.
- A process for topping up the Payouts virtual account.
- A chartered accountant confirms: GST on the commission, TDS under section 194-O on payouts to
  hosts, and that holding hosts' money for up to 72 h after an event is acceptable under our PayU
  arrangement. All three are **config**, not code (R9).

## Scope

**In:** payout accounts, bank verification, the review queue, the paid-publish gate, settlement and
transfer jobs, payout webhooks, holds, receivables, host-facing GraphQL and app screens, staff
GraphQL.

**Out:** the admin web app, venue/booking payouts, a third-party PAN verification vendor, UPI
payouts, GST invoices to hosts, disputes/chargebacks (`payments R19` stays as specified, unbuilt).

---

## Data model (migration `032_host_payouts`)

### `payout_accounts`

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `user_id` uuid UNIQUE → users | One account per user |
| `legal_name` text | As the host typed it |
| `pan_cipher` bytea, `pan_last4` text | AES-256-GCM; screens show `XXXXX1234X`-style masks built from `pan_last4` |
| `account_cipher` bytea, `account_last4` text | Same scheme |
| `ifsc` text | |
| `bank_name_returned` text NULL | `beneficiaryName` from the penny test |
| `name_match` smallint NULL | PayU's score, rounded |
| `status` text | `checking \| verified \| needs_review \| rejected \| suspended`, CHECK |
| `status_reason` text NULL | Shown to the host when `rejected` or `suspended` |
| `verify_ref` text NULL | `merchantRefId` of the last penny test |
| `check_attempts` smallint default 0 | |
| `reviewed_by` uuid NULL, `reviewed_at` timestamptz NULL | Staff decision trail |
| `verified_at`, `created_at`, `updated_at` timestamptz | |

### `payouts`

| Column | Notes |
|---|---|
| `id` uuid PK | Also the PayU `merchantRefId` (36 chars, fits 40) |
| `payout_account_id` uuid → payout_accounts | |
| `event_id` uuid → events | UNIQUE (`event_id`, `payout_account_id`) — one payout per event per account |
| `entry_fees_paise`, `refunds_paise`, `commission_paise`, `commission_tax_paise`, `tds_paise`, `receivables_paise`, `amount_paise` bigint | The quote, frozen at settlement (R9) |
| `status` text | `scheduled \| held \| awaiting_funds \| sending \| paid \| failed`, CHECK |
| `hold_reason` text NULL | |
| `provider_status` text NULL, `provider_ref` text NULL | PayU's status and transfer id |
| `attempts` smallint default 0, `last_error` text NULL | |
| `due_at` timestamptz | `events.ends_at + 72 h` |
| `created_at`, `sent_at`, `paid_at`, `updated_at` timestamptz | |

### `ledger_entries.kind` — new values

`host_commission` (+, platform revenue), `commission_tax` (+), `tds_withheld` (+, held for the
government), `host_payout` (−), `host_receivable` (+, owed back by a host), `receivable_recovered`
(−). The CHECK constraint is replaced to allow them. A new nullable `payout_id` column links these
rows to their payout, so the settlement report still reconciles from the ledger alone (`payments R18`).

---

## Rules

**R1 — Adding a payout account.** `Mutation.savePayoutAccount(legalName, pan, accountNumber, ifsc)`
validates: PAN matches `^[A-Z]{5}[0-9]{4}[A-Z]$`; IFSC matches `^[A-Z]{4}0[A-Z0-9]{6}$`; the account
number is 9–18 digits. The row is written as `checking` and a `verify-payout-account` job is
enqueued. Saving again replaces the details and restarts the check (R7). Rate limit: 5 saves per user
per day — each penny test costs money.

**R2 — Secrets at rest.** PAN and account number are encrypted with AES-256-GCM under
`PAYOUT_DATA_KEY` (32 bytes, base64; required when `PAYOUT_PROVIDER=payu`). They are decrypted only
inside `payments` to call PayU or to file TDS, and never returned by GraphQL or written to logs. The
logger's redaction list gains `pan`, `accountNumber`, `beneficiaryAccountNumber`.

**R3 — The bank check.** The job calls Verify Account with `nameMatching=true` and
`beneName=legal_name`:

| PayU says | We set |
|---|---|
| `YES` and `nameMatch ≥ PAYOUT_NAME_MATCH_AUTO` (default 80) and the PAN surname check passed (R4) | `verified` |
| `YES` and a lower score, or the PAN surname check failed | `needs_review` |
| `VERIFICATION_PENDING` | stay `checking`; job retries at 5 min, 30 min, 2 h, then `needs_review` |
| `No` (account missing or closed) | `rejected`, reason from PayU's `error`, mapped to plain words |
| Provider error or timeout | job retries with backoff; after the last attempt, `needs_review` |

The host is notified on every terminal status (`payout_account.verified`, `.needs_review`,
`.rejected`).

**R4 — PAN is checked offline, not verified by an API.** No PayU API verifies a PAN for a third
party, so `savePayoutAccount` runs three free structural checks before anything is saved or any
penny test is paid for:

| Check | Fails → |
|---|---|
| Format `^[A-Z]{5}[0-9]{4}[A-Z]$` | `INVALID_PAN`, inline, nothing saved |
| 4th character is `P` (an individual; `C` company, `F` firm, `H` HUF and others are refused) | `PAN_NOT_INDIVIDUAL`, inline, nothing saved |
| 5th character equals the first letter of **any word** of `legal_name` | Saved, but the account can never auto-verify: it goes to `needs_review` with `status_reason = pan_surname_mismatch`, even on a perfect bank match |

The third check is a flag, not a refusal, and any word's initial counts: South Indian and
single-word names often put the surname elsewhere ("S. Ramesh Kumar"). Staff see the PAN's 5th letter next to the typed name and
the bank's name, and decide.

So R3's `verified` row requires **both** a bank `nameMatch ≥ PAYOUT_NAME_MATCH_AUTO` **and** a passing
surname check. Worked examples:

| Typed name | PAN | Bank says | Result |
|---|---|---|---|
| Rahul Sharma | ABCP**S**1234K | RAHUL SHARMA, 96 | `verified` |
| Rahul Sharma | ABCPS12345 | — | `INVALID_PAN`, no penny test |
| Rahul Sharma | ABC**C**S1234K | — | `PAN_NOT_INDIVIDUAL`, no penny test |
| Rahul Sharma | ABCP**K**1234K | RAHUL SHARMA, 95 | `needs_review` (surname letter) |
| Rahul Sharma | ABCPS1234K | PRIYA VERMA, 22 | `needs_review` (bank name) |
| Rahul Sharma | ABCPS1234K | `accountExists: No` | `rejected` |

**Residual risk, accepted:** a host can enter another person's real PAN that shares their surname
initial. Money is not at risk (it only goes to a bank account verified in the host's name); TDS is
credited to the wrong PAN, which the quarterly TDS return flags, and staff then suspend the account
(payouts held, R10). When the CA requires upfront verification or a filing flags bad PANs, a PAN API
(e.g. Cashfree Verification Suite) is added behind a `KycProvider` port in the same
`verify-payout-account` job, with three new columns: `pan_name_returned`, `pan_status`,
`pan_verified_at`. Nothing else changes.

**R5 — The publish gate.** `canPublishPaid(userId)` is ok when the user is platform staff (unchanged)
or their payout account is `verified`. Otherwise it returns what is missing, which the app turns
into a link to *Get paid*: `no account`, `checking`, `needs review`, `rejected`, `suspended`.
Already-published paid events are not unpublished by a later status change; their payouts are held
instead (R10).

**R6 — Staff review.** Staff with `admin` or `finance`:
`Query.payoutAccountsForReview`, `Mutation.approvePayoutAccount(id)`,
`rejectPayoutAccount(id, reason)`, `suspendPayoutAccount(id, reason)`,
`reinstatePayoutAccount(id)`. Each decision records `reviewed_by`/`reviewed_at` and notifies the
host. `support` can read the queue but not decide.

**R7 — Changing bank details.** Saving new details sets the account back to `checking`. While it is
not `verified`, payouts that are `scheduled` or `awaiting_funds` are held with reason
`account_changed`, and release automatically once it is `verified` again.

**R8 — When an event settles.** When an event with any paid category moves to `completed` (or
`cancelled` with captured payments), a `payouts` row is created as `scheduled` with
`due_at = ends_at + 72 h`. A one-minute sweep (`settle-due-payouts`, on the existing Postgres job
scheduler) picks up rows whose `due_at` has passed and quotes them (R9). The 72 hours let result
disputes and late withdrawals land first (`payments R14`).

**R9 — The quote.** `payoutQuote(eventId)` is pure over `ledger_entries` for the event's
registrations:

Per registration (every ledger row is signed; `refund`, `fee_reversal` and `tax_reversal` are
already negative):

```
entry fee     = charge − platform_fee − tax
refunded fee  = −refund + fee_reversal + tax_reversal        ≥ 0
                (a full ₹649 refund: 64,900 − 5,000 − 9,900 = 50,000 paise of entry fee)
entry fee net = entry fee − refunded fee                      floored at 0
commission    = round_half_up(entry fee net × category.commission_bps)
```

For the payout:

```
entry fees     = Σ entry fee
refunds        = Σ refunded fee
commission     = Σ commission
commission_tax = round_half_up(commission × COMMISSION_GST_BPS)
tds            = round_half_up((entry fees − refunds) × HOST_TDS_BPS)
receivables    = open host_receivable for this account (R15)
amount         = entry fees − refunds − commission − commission_tax − tds − receivables
```

A full refund reverses fee and tax too (`payments R6`), so it nets the entry fee to 0. A **partial**
refund writes no fee or tax reversal, so all of it comes out of the entry fee: the host bears a
partial refund, never the platform fee or the government's tax.

`COMMISSION_GST_BPS` and `HOST_TDS_BPS` are config with no default in production: the server refuses
to start with `PAYOUT_PROVIDER=payu` and either unset, so the chartered accountant's answer is
entered on purpose. Development defaults are 0. An amount ≤ 0 marks the payout `paid` with no
transfer and carries any shortfall forward as a receivable.

**R10 — Holds.** A payout is `held`, with the reason stored, when: the account is not `verified`
(`account_changed`, `account_suspended`); any refund for the event is still `pending`; or staff hold
it (`Mutation.holdPayout(id, reason)`). Automatic holds release themselves when the condition clears
on the next sweep; staff holds need `Mutation.releasePayout(id)`.

**R11 — Sending.** Within one transaction: write the ledger rows (`host_commission`,
`commission_tax`, `tds_withheld`, `host_payout`, `receivable_recovered`) and set the payout to
`sending`. Then call Initiate Transfer with `merchantRefId = payouts.id`, `paymentType = IMPS`
(`NEFT` above `PAYOUT_IMPS_MAX_PAISE`, default ₹5,00,000), `retry = true`. The unique index and the
`merchantRefId` make a retried job unable to pay twice (`payments R15`): before sending again after
an unknown outcome, the job asks Check Transfer Status for that `merchantRefId` first.

**R12 — Funding.** Before sending, the job reads the Payouts balance (Get Account Details). If it is
below the payout amount, the payout is set to `awaiting_funds` instead, finance gets one email per
hour at most (`PAYOUT_ALERT_EMAIL`), and the sweep tries again. Nothing is sent into PayU's `QUEUED`
state on purpose.

**R13 — Final status.** `POST /webhooks/payouts` (raw body, PayU's IPs allowed in prod) records the
event in `payment_webhook_events` and enqueues `check-payout`. That job — and a 15-minute sweep over
payouts `sending` for over 30 minutes — calls Check Transfer Status and applies it:

| PayU final status | We do |
|---|---|
| `SUCCESS` | `paid`, `paid_at`, notify host "₹X sent to your bank" |
| `FAILURE`, `REJECTED`, `CANCELLED` | `failed`; reverse this payout's ledger rows; notify host and alert finance |
| `REVERSED` (after success) | same as failure; the account goes to `needs_review` (the bank bounced it) |

A `failed` payout is retried by staff (`Mutation.retryPayout(id)`), which creates a fresh attempt
under a new `merchantRefId` (`<payout id>-r<n>`); the old attempt's ledger rows were already reversed.

**R14 — Host visibility.** `Query.myPayoutAccount` (masked fields and status) and
`Query.myPayouts(first, after)`. `HostedEvent` gains `payout { status, amountPaise, dueAt, paidAt,
holdReason }` and its breakdown, so the manage screen can say what the host will get and when.

**R15 — Refunds after payout.** The player is still refunded at once from the platform's collection
balance (`payments R17`, unchanged for the player). PayU cannot pull back an IMPS, so the entry-fee
part of the refund, less the commission already taken on it, is written as a `host_receivable` and
netted against that host's next payout (R9). Receivables older than 90 days are listed for finance in
`Query.openReceivables`; collecting them is a manual process for now.

**R16 — Account deletion.** `identity`'s deletion check already refuses while "an organizer is still
owed a payout"; it now also refuses while the user has an open `host_receivable`.

---

## Components

| Unit | Responsibility |
|---|---|
| `src/platform/payouts/` | `PayoutProvider` port + PayU adapter: token cache and refresh, `verifyAccount`, `balance`, `transfer`, `transferStatus`, webhook parsing. A `mock` provider for dev and tests, like `paymentGateway.ts`. |
| `src/platform/crypto/secretBox.ts` | AES-256-GCM seal/open with key versioning (`v1:` prefix) so the key can rotate. |
| `payments/service/payoutAccounts.ts` | R1–R7 |
| `payments/service/payoutQuote.ts` | R9, pure, unit-tested against ledger fixtures |
| `payments/service/payouts.ts` | R8, R10–R13, R15 |
| `payments/schema/payouts.ts` | GraphQL for host (R14) and staff (R6, R10, R13, R15) |
| `events` composition root | Registers the real `PublishGate` (R5) |
| Jobs | `verify-payout-account`, `settle-due-payouts` (1 min), `send-payout`, `check-payout`, `sweep-sending-payouts` (15 min) |

## App (PLAY_FRONTEND, `22-host`)

- **Get paid** screen under *Hosting*: legal name, PAN, account number (typed twice, masked), IFSC
  with the bank and branch looked up as you type (PayU Get IFSC Details via a backend query). Status
  card for `checking`, `needs review`, `rejected` (with reason and *Fix details*), `verified`.
- Publishing a paid category with no verified account shows the reason and a *Get paid* button
  instead of a dead end (`host R6`).
- The manage screen shows each event's payout: expected amount with its breakdown, due date, status,
  hold reason in plain words.
- New push kinds route to `organizer_payouts` (the deep-link route already exists).

## Errors

| Code | Kind | App does |
|---|---|---|
| `PAYOUT_ACCOUNT_REQUIRED` | user | Route to *Get paid* |
| `PAYOUT_ACCOUNT_NOT_VERIFIED` | user | Show status and reason |
| `INVALID_PAN` / `PAN_NOT_INDIVIDUAL` / `INVALID_IFSC` / `INVALID_ACCOUNT_NUMBER` | user | Inline on the field |
| `PAYOUT_DETAILS_RATE_LIMITED` | user | "Try again tomorrow" |
| `PAYOUT_NOT_HELD` / `PAYOUT_NOT_FAILED` | staff | State conflict on a staff action |

## Testing

- `payoutQuote` — table tests over ledger fixtures: no refunds, partial refunds, full refund, mixed
  fees, receivable netting, amount ≤ 0, rounding at half a paisa.
- Verification state machine — every PayU response row in R3 and every example row in R4, using
  the mock provider.
- PAN checks — format, non-individual holder types, surname initial with multi-word, single-word
  and initial-first names, lower-case input normalised to upper case.
- Idempotency — a `send-payout` job run twice, and run after a timeout with the transfer actually
  succeeded, sends once.
- Funding — low balance gives `awaiting_funds`, then `sending` once topped up.
- Webhook — forged or unknown `merchantRefId` changes nothing; status always comes from the status
  API.
- Secrets — a GraphQL snapshot and a log capture prove no PAN or account number leaves `payments`.
- Sandbox probe script (`scripts/payu-payouts-probe.ts`), like the collection probe, recorded as
  fixtures before the adapter is written.

## Open questions (do not block the build)

- CA answers for `COMMISSION_GST_BPS`, `HOST_TDS_BPS` and the 72 h holding period (config only).
- Whether PayU enables saved beneficiaries for us; if so, the adapter can stop sending the account
  number on each transfer. No schema change.
- A PAN verification vendor, if staff review volume shows we need one.

## Manual payouts (added 2026-10-05)

RazorpayX does not onboard individuals or unregistered businesses, which is what PL4Y is today. So
`PAYOUT_PROVIDER=manual` runs the same payout rules with a person in place of the bank API. It is
allowed in production and needs only `PAYOUT_DATA_KEY` (and `PAYOUT_ALERT_EMAIL` for the "ready to
pay" email). No RazorpayX keys.

- **Bank details.** A save goes straight to `needs_review` (`manual_review`), with no bank check. A
  check queued before the switch does the same. Staff approve or reject in the portal. "Full
  details" shows the clear account number to admin and finance, with a reason, and every look is
  audited (`payout_account.reveal`).
- **Ready to pay.** When a payout falls due and passes every hold (R10, F3, gap #23 and #25), it is
  committed exactly like a transfer RazorpayX accepted. The quote is frozen, the ledger is written,
  and the status is `sending` with `provider_status = 'manual'`. The portal lists these as "Ready to
  pay". Nobody asks a provider about them; the stale-sending sweep and `checkPayout` skip them. The
  marker is on the row, so they survive a switch of provider.
- **Mark paid** (`markPayoutPaid`). Staff send the money from PL4Y's bank, then record the UTR and
  the amount they sent. The amount must equal the frozen amount. The UTR is normalised (no spaces,
  upper case) and may not repeat across payouts. The payout becomes `paid`, `provider_ref` holds the
  UTR, and the host is notified with it. The audit action is `payout.mark_paid`. It happens once:
  the row lock refuses a second mark.
- **Hold from Ready to pay.** Nothing has been sent, so a staff hold reverses what committing wrote:
  the ledger rows, and any receivables refunds wrote against it meanwhile (`reverseCommitted`).
  Release quotes it again with those refunds in. `failPayout` uses the same reversal, which fixes a
  double count: before this, a refund during a failed transfer was taken off twice on retry.
- **A refund after Ready to pay** is owed back (R15), just like after a transfer. The amount staff
  send never changes.
- **Repayments (gap #16).** A host who owes PL4Y cannot publish paid events, and before this nothing
  could clear the debt except a later payout they could not earn. Now the portal lists "Owed by
  hosts", and `recordHostRepayment` records a bank transfer from the host, part or full, up to what
  is owed. It is written as a `receivable_recovered` row on their latest payout and audited as
  `payout_account.repayment`. The publish error now tells such a host they owe PL4Y, instead of
  "add it under Get paid".
- **Reads.** `payoutsToPay`, `payoutsNeedingAttention` and `openReceivables` are readable by any staff
  role, because the portal shows support the lists. Acting, and full bank details, stay with admin
  and finance. `payoutsNeedingAttention` shows the live quote for held payouts, since their stored
  amounts are zero until they are sent.
- **App.** `Payout.utr` and `Payout.toPayByHand`. A payout PL4Y pays by hand reads "Expected ₹X ·
  PL4Y is sending this to your bank" until it is paid, then "Paid <date> · UTR …".

Tested in `tests/payouts.test.ts` (the "manual payouts" and "gap #16" blocks) and end to end on the
emulator and portal. Screenshots are in `e2e/manual-payouts/` at the repo root.
