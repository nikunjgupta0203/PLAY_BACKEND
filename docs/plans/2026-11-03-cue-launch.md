# Cue-sports launch — snooker, pool and billiards (2026-11-03)

PL4Y launches as a snooker, pool and billiards discovery, booking and payment platform.
This doc records what was built, the decisions behind it, and how to deploy it.
Migration **058** (`20261103100000_058_cue_launch`).

## §1 Sports focus

- `src/modules/sport/service/offered.ts` — `OFFERED_SPORT_SLUGS` lists `snooker`, `pool`,
  `billiards`; every other sport is **commented out**, not deleted. Uncomment a slug to bring it
  back. No migration or data change is needed.
- `sport.list()` (→ `Query.sports`, every picker and filter in the app) returns only offered sports.
  `sport.byId` still resolves every sport, so old matches, rankings and profiles keep rendering
  (sport R3).
- New things need an offered sport: events (`events.create`), onboarding sports, communities, games,
  venue-host applications (`sport.requireOffered`).
- Discovery lists only the offered sports: venues (venues with an active court/table for one of
  them), events, games and communities (`anyOfSportIds` in each repo search). Home's event shelf
  goes through `events.search` and follows.
- Tests run the full catalogue (`sportFocusOn()` is off under `NODE_ENV=test`); a test turns it on
  with `setSportFocusForTests(true)`.
- App: the persisted query cache version is bumped (6), so the cached sports list is dropped on the
  OTA. Host guide tips show only "Frames & games" (`OFFERED_TIP_KINDS`, others commented out).
- **Not done:** the marketing website still shows pickleball and other sports. It needs snooker, pool
  and billiards photos first.

## §2–4 Booking, payment options, pay at venue

- The court booking system (19-bookings) is the table booking system. A table is a court with
  `kind = 'table'`.
- **Owner preference** (`venue_booking_policies.payment_options`): `online` | `at_venue` | `both`.
  `Query.venueBookingOptions` and `courtBookingQuote.paymentChoices` give the app the choices.
  `holdCourtBooking(input.payment)` refuses a choice the venue does not allow
  (`PAYMENT_OPTION_UNAVAILABLE`).
- **Online**: unchanged. A 10-minute hold, then pay; only a verified capture confirms (R2).
- **Pay at venue booking**: confirmed at once, so it goes through the same exclusion constraint (no
  double booking). `payment_status = 'due'`. The desk marks it paid (`markCourtBookingPaid`: cash,
  UPI, card, other) or the player pays in the app (`createBookingPaymentOrder` accepts a `due`
  booking). The player gets a receipt either way (`booking.paid` + email). If the desk took the
  money and an app payment lands as well, the capture is refunded in full (ILLEGAL_TRANSITION →
  payments refunds).
- Anti-abuse: at most 2 unpaid pay-at-venue bookings ahead per player. With 2 no-shows in 60 days,
  the player pays online. An unpaid no-show is voided and its offer use is released.
- The existing **Pay at Venue** for time played without a booking (`venuepay`, migration 055) is
  shown again in the app (venue page button, desk payments, owner rates). It is still switched on
  per venue by PL4Y staff and needs a verified payout account.

## §5 Commission (0% for each venue's first 30 days)

- `pricing_settings` (one row, edited in the portal under **Commission & offers**):
  - default rates: booking 10%, pay-at-venue 10%;
  - introductory period: on, 30 days, 0%;
  - stacking rules (§7);
  - `launched_at`.
- `venue_commercial_terms` tracks each venue's introductory period. It starts the first time the
  venue switches bookings on, switches pay at venue on, or takes money (`pricing.ensureTerms`).
  Venues that were already bookable or pay-enabled at migration start today. Staff can move the
  dates or give a venue its own rate.
- The rate is **frozen on each booking** (`commission_bps`, `commission_paise`) and on each
  pay-at-venue payment, so a settings change never reprices old money. No app update is needed to
  change commission.
- The venue's earnings on a booking are `base − venue's own discount`. PL4Y's offers and rewards
  never reduce what the venue is paid, and commission is charged on the venue's earnings only.
- The dashboard banner reads `Enjoy {intro}% Commission on PL4Y for Your First {days} Days.`, which
  with the defaults is exactly *"Enjoy 0% Commission on PL4Y for Your First 30 Days."*
  (`Query.venueCommission`).

## §6–7 Offers and stacking

- `offers` has `funded_by` `venue` | `platform`:
  - percentage or flat, with an optional cap;
  - minimum value, minimum minutes;
  - weekdays (weekday and weekend offers), a time-slot window;
  - first-time customers only;
  - start and end dates, total and per-player limits, on/off.
- The venue makes its own offers from the app dashboard (`saveVenueOffer`). PL4Y offers are made in
  the portal (`savePlatformOffer`), for every venue or one.
- **Engine** (`src/modules/pricing/service/engine.ts`, pure and unit-tested):
  1. The venue's best eligible offer comes off the original price.
  2. PL4Y's best eligible offer comes off the price after the venue's discount, or off the original
     (setting).
  3. Without stacking, only the larger discount applies.
  4. Both together never exceed `max_discount_bps` of the original, and a paid booking never drops
     below ₹1. Any trimming comes out of PL4Y's discount first.
  5. PL4Y's welcome/referral reward applies at checkout on top, unless `rewards_with_promos` is off.
- **Redemptions** (`offer_redemptions`) are reserved when a booking is made, redeemed when it is
  paid, and released when it lapses, is cancelled, or is an unpaid no-show. The offer row is locked
  while its uses are counted, so the last use goes to one player (`OFFER_UNAVAILABLE` to the rest).
  The owner sees redeemed, reserved, players and total discount per offer.
- Every booking stores `base_paise`, `venue_discount_paise` + `venue_offer_id`,
  `platform_discount_paise` + `platform_offer_id`. A CHECK enforces
  `court_paise = base − venue − platform`. The app shows each line, named, with "You save".

## §8 Venue dashboard (app: Hosting → venue)

- **Desk**: the day's schedule, walk-ins, check-in, no-show, cancel, and **Collect / Mark paid**.
  Each booking shows its ID, how it is paid and what the venue earns. Pay-at-venue payments are
  listed here too.
- **Revenue** (`venueDashboard`, `venueBookings`, `venueTransactions`):
  - today, this week, this month, and the last 30 days per day, per table and per start hour;
  - customers and repeat customers;
  - your discounts versus PL4Y's (PL4Y-paid), commission and refunds;
  - booking management (upcoming, unpaid, cancelled);
  - the payment and transaction history.
- **Offers**: create, edit, switch on or off, redemption counts.
- **Settings**:
  - the commission banner;
  - take bookings; online / pay at venue / both;
  - booking lengths (30, 40, 45, 60, 90…), the start interval (10–60 min), how far ahead;
  - tables (add, sport, in or out of service);
  - hours and off-peak/peak/weekend prices per table or all tables;
  - blocking a table or the venue for part of a day;
  - pay-at-venue rates; staff.

## §9 Tables and scheduling

- Durations come from `duration_options`. Start times step every `slot_step_minutes` from midnight.
  The shortest booking is `min_slot_minutes` (now 10–360, any multiple of 5).
  Existing venues keep their old grid: the step is set from their minimum slot.
- Peak and off-peak: a table's day can have several price bands. A booking may run across them and
  is priced minute by minute (`priceAcross`). The app's form builds the bands (`rulesFromForm`).
- No double bookings: Postgres's exclusion constraint (R1), unchanged, for online, pay-at-venue and
  walk-in bookings alike.
- A table taken out of service is refused while it has upcoming bookings.

## §10 Notifications and the player's bookings

New notification kinds, all mutable in notification settings:

- `booking.confirmed` — now with the booking ID and what is due at the venue;
- `booking.paid` — the receipt;
- `booking.payment_failed` — the table is still held, so the player can retry;
- `booking.reminder` — 2 hours before, sent once, from the minute sweep;
- `venue.booking_received` and `venue.booking_cancelled` — to the venue's owner and managers;
- `offer.new` and `offer.expiring` — to the venue's customers (or recent bookers, for a PL4Y offer
  at every venue), once each, from the hourly `sweep-offers` job.

Emails: the player's confirmation or receipt, and the venue's new-booking notice
(`bookings/service/emails.ts`).

App: **My bookings** (`/booking`) with Upcoming / Past / Cancelled, each showing the booking ID,
payment status and savings. The booking screen shows the breakdown, the receipt and reference, and
"Pay now in the app" for pay-at-venue bookings.

## §11 Money and safeguards

- Booking codes are `BK-XXXXXXXX`: 8 characters, no 0/O/1/I/L, unique.
- `payment_status`: `pending` | `paid` | `due` | `failed` | `void` | `waived` | `refunded` |
  `partially_refunded`. Other fields: `collected_by` (`pl4y` | `venue`), `payment_method`, `paid_at`,
  `refunded_paise`.
- Cancellations: an unpaid booking is released and voided. A booking paid through PL4Y is refunded
  by the venue's policy (R6, unchanged), and the venue keeps its share of what was not refunded. A
  booking paid at the desk is the venue's to refund: the player is told to ask them. A venue
  cancellation refunds in full.
- Failed payments: the hold lives on, the booking says `failed`, and the player is told.
- Duplicate payments: payments' keeper-capture refunds a second capture. A capture after the desk
  took cash is refunded in full.
- **Venue payouts** (monthly, by hand, with pay-at-venue payments) now settle table bookings too.
  - Paid through PL4Y: the venue is owed its earnings less commission.
  - Paid at the desk: PL4Y owes only its own offer's discount, less commission.
  - Anything unsettled carries into the next month. A month netting to zero or less waits.
  - Bookings made before `launched_at` are never settled.

## Tests

- `src/modules/pricing/service/engine.test.ts` — 16 tests on the engine.
- `tests/cueLaunch.test.ts` — 19 tests against Postgres covering the whole flow (discover → table →
  duration → price → both discounts → pay or pay at venue → confirmation → owner dashboard →
  revenue → payout). Also the edges: failed payment, lapsed hold, cancellations, blocked and
  out-of-service tables, concurrent duplicate bookings, offer races, discount combinations, rewards
  stacking, commission after 30 days, reminders, notifications, and permissions.
- App: `bookings.test.tsx` (lengths, named discounts, pay-at-venue choice, pricing form).

## Deploy

1. **Backend first.** Push; Render's `preDeployCommand` runs migration 058. Check that
   `{ venueBookingOptions(venueId: "…") { durations } }` answers on api.getpl4y.com.
2. **Portal** (CLI deploy, see admin-vercel-url): the **Commission & offers** page.
3. **App by OTA.** The query cache version is bumped, so the sports list refreshes. No native
   change.
4. Website: unchanged for now (§1).
