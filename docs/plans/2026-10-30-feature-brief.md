# PL4Y Developer Feature Brief — build plan (2026-10-30)

Source: `PL4Y_Developer_Feature_Brief.pdf` — three updates: Pay at Venue, PL4Y Rewards
(first-payment + referral discount), Notifications system.

## Decisions (asked 2026-10-30)

| Question | Answer |
|---|---|
| How venue money reaches the venue | 10% PL4Y commission (no GST, like host payouts); one manual payout per venue per month, marked paid with a UTR in the portal (copy of community payouts, 049) |
| Who turns Pay at Venue on | The owner adds hourly rates in venue setup; it shows on the listing only once PL4Y staff enable it in the portal **and** the owner's payout account is verified |
| Where reward rules live | A Rewards settings page in the admin portal (one settings row). Defaults: 10%, ₹100 cap, ₹100 minimum payment, 90-day expiry, 20 referral rewards per referrer per month, no stacking |
| When a referral code can be entered | A `getpl4y.com/r/CODE` link pre-fills it at sign-up; otherwise typed in Rewards within 7 days of joining and before the first payment |

## Money rules that follow from the brief

- **PL4Y funds every discount.** Hosts, venues and community owners are paid on the
  undiscounted price. On an event, a `reward_discount` ledger row credits the host side of
  `payoutQuote`; community and venue payouts already work from frozen prices.
- **One discount per payment** (no stacking unless the settings switch is on — then the
  first-payment and one referral reward may combine, still capped at the payment).
- **First payment** = the user's first captured payment as payer, of any kind. Eligible users
  are computed, not pre-issued: a `first_payment` reward row is created on first use.
- The reward is **reserved** when an order is created, **used** on capture, **released** on
  failure/abandonment, and **restored** if that payment is later refunded in full.
- Refund maths caps at what the player actually paid: the discount comes off the entry-fee
  share first, so no refund can exceed the capture.
- A referral converts on the referred user's first capture. Fraud checks before the
  referrer's reward is issued: self-referral, shared phone, shared push device, monthly cap,
  referred account created more than 7 days before the code. A failed check records a
  `fraud_signals` row and holds the referral for staff review in the portal.

## Phases

### Phase 1 — Rewards core (backend)
- Migration 054: `reward_settings` (one row), `users.referral_code`, `referrals`, `rewards`,
  `payment_orders.payer_user_id / gross_paise / discount_paise / reward_ids` (+ backfill of
  payer from the order's subject).
- `rewards` module: settings (staff read/update), my rewards + referrals, my code, apply a code,
  quote a discount for an amount, reserve / use / release / restore, referral conversion +
  fraud checks, expiry job.
- Tests: tests/rewards.test.ts.

### Phase 2 — Discount at checkout (backend + app)
- `payments` asks `rewards` for a discount in `createOrder`, `createBookingOrder`,
  `createCommunityOrder` (and Pay at Venue in phase 3); the order stores gross, discount, net.
- Ledger `reward_discount` / `reward_reversal`; `payoutQuote` credits the host; refund maths
  subtracts the discount; capture uses the reward and converts referrals; full refund restores.
- GraphQL: order quote carries `discountPaise` + `rewardLabel`; a `checkoutPreview` query shows
  the discount before paying.
- App: event pay, court pay and community pay screens show the discount line.

### Phase 3 — Pay at Venue
- Migration 055: `venue_pay_rates` (label, optional sport, ₹/hour, active), `venues.pay_at_venue_enabled`,
  `venue_payments` (user, venue, rate, minutes, rate frozen, amount, discount, status, payment,
  payout), `venue_payouts` (monthly, 10% commission), `payment_orders.venue_payment_id` in the
  one-subject CHECK.
- Amount = round-half-up(rate × minutes ÷ 60), minutes 10–600 in steps of 5.
- Capture → confirmation email to the player and to the venue owner + managers; payment row in the
  operator's dashboard.
- App: "Pay at venue" on the venue page → activity, duration, breakdown (duration, rate, discount,
  total) → checkout → receipt. Venue desk: Payments section (status, reference, player, duration,
  amount) and hourly rates in setup.
- Portal: per-venue enable switch, venue payments list, Payouts › Venues monthly payouts.

### Phase 4 — Rewards in the app, website and portal
- App: Rewards screen (welcome offer status, my code + share link, referral list, rewards with
  expiry, enter a code), Home welcome-offer banner (hidden once the first payment is made),
  referral code at sign-up pre-filled from the link.
- Website: `/r/[code]` landing that opens the app / store and carries the code.
- Portal: Rewards settings page, referrals list with held-for-review actions.

### Phase 5 — Notifications
- New templates: `payment.confirmed`, `checkin.done`, `venue.new_nearby`, `event.new_nearby`,
  `referral.converted`, `reward.available`, `match.completed` wording check.
- Discovery fan-out for a new venue / published event: players whose profile city matches or
  whose home point is within 25 km, and who play one of its sports. At most 3 discovery pushes per
  player per week (the feed row is always written), quiet hours respected.
- Preferences: grouped switches (Matches & events, Payments & rewards, Discovery, Games, Chat,
  Communities) on top of the existing per-template mute list.

### Release order
Backend first (migrations 054–055 must run on deploy), then portal, then app (OTA unless a
native dependency is added — none planned), then website.

## Status (2026-10-30) — all five phases built, UNCOMMITTED

| Phase | Backend | App | Portal / website |
|---|---|---|---|
| 1 Rewards core | `src/modules/rewards`, migration 054, `tests/rewards.test.ts` (18) | — | — |
| 2 Discount at checkout | payments: gross/discount/reward_ids on orders, `reward_discount`/`reward_reversal` ledger, refund maths, payoutQuote | discount line on event, court and community pay screens (`rewardPreview`) | — |
| 3 Pay at Venue | `src/modules/venuepay` (service, monthly payouts, emails), migration 055, 4th payment subject, `tests/venuePay.test.ts` (11) | venue page button, `/venue/[id]/pay`, `/venue-payment/[id]` receipt, desk payments list, rates in venue settings | `/pay-at-venue` (payouts + payments + refund), switch on the venue page |
| 4 Rewards UI | — | `/rewards`, Home welcome banner, Settings row, `pl4y://r/{code}` held across sign-up | `/rewards` (rules, stats, held referrals); website `/r/[code]` |
| 5 Notifications | `checkin.done`, `venue.new_nearby`, `event.new_nearby`, `payment.confirmed`, `venue.payment_received`, `venue.payout_paid`, `referral.converted`, `reward.available`; discovery fan-out in `src/notify.ts` | routes REWARDS / VENUE_PAYMENT / VENUE_DESK, new kinds in notification settings | — |

Deviation from the plan: a throttled or muted discovery notice writes no feed row at all (it is
promotional), rather than a row without a push.

### Deploy
1. Backend first: `prisma migrate deploy` runs 054 then 055. 054 backfills `payer_user_id` and
   `gross_paise` on every existing order (existing payers therefore never get a welcome offer).
2. Portal (CLI deploy, see admin-vercel-url memory), then website (`/r/[code]`).
3. App by OTA (no native change). Persisted query cache bumped to v4 for `Venue.payAtVenue`.
4. Turn Pay at Venue on per venue from the portal venue page once the owner has rates and a
   verified payout account.
