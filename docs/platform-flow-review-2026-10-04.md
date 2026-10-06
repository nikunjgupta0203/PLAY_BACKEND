# PL4Y platform flow review: hosting, host and scoring

*Written 2026-10-04 from a walk through the code in both repos (PALY_BACKEND, PLAY_FRONTEND/apps/player).*
*Read as a product engineer. Each step is checked from three seats: the **host**, the **player** and **PL4Y ops**.*

This picks up after [gap-fixes-2026-10-03.md](./gap-fixes-2026-10-03.md). Those 36 items are not repeated here.
Where one of them is still partly open, this doc says so. Everything below is either new or was left out last time.

Each gap has a severity:

| | Meaning |
|---|---|
| **P0** | A hosted event can't run end to end, or money ends up with the wrong person |
| **P1** | Fairness or trust breaks: a player or PL4Y can be cheated, or nobody can act on a problem |
| **P2** | The host has a real job to do that the product doesn't support |
| **P3** | Polish, format depth or business hygiene |

---

## Status — built 2026-10-04 (uncommitted, both repos)

Every finding below was worked the same day. The organizer section lives **in the player app**
(`PLAY_FRONTEND/docs/modules/23-organizer.md`), PL4Y's admin tools too (`24-ops.md`), and a plain-language
guide is `PLAY_FRONTEND/docs/organizer-guide.md`. Backend migration: `035_organizer`. Tests: backend
`tests/organizer.test.ts` (one describe per finding) plus updated suites; app `features/organizer/**` tests.

| # | What was built |
|---|---|
| F1 | `drawPreview` query; `generateDraw` / `regenerateDraw` take a `seedOrder`. App: *Draws & schedule* — preview, move seeds, make, redo. |
| F2 | `removeRegistration` always refunds an online-paid entry; the app has one *Remove* button. |
| F3 | `event_reports` + `reportEvent` / `resolveEventReport` / `eventReports`; payout holds `player_report` and `no_play_evidence` (no started match, heat or check-in), cleared by a staff release; a host's first payout waits 7 days; `OrganizerSummary.verified` / `eventsHosted`. App: report from the event page, trust line on the organizer row. |
| F4 | One rule: an owner or manager **in** the match is a player there — override, settle-by-resubmit and correct. A dispute with no neutral organizer escalates to PL4Y at once. |
| F5 | A player's result confirms itself after 2 h (≤ event end + 2 h, ≥ 30 min); such a result is not rated. App and guide say so; "final not played" shown on an unfinished draw. |
| F6 | A player's walkover needs the match 15 min late and the opponent not checked in. |
| F7 | A manager cannot demote another manager. |
| F8 | `registrationClosePreview`. App: a confirmation sheet per draw before closing. |
| F9 | `escalatedResults` / `settleEscalatedResult`; staff read any event by slug and any entry list; `Viewer.platformRole`; `Payout.event`. App: *Settings → PL4Y admin*. |
| F10 | App: *Message players*. |
| F11 | App: *Event details* for published events. |
| F12 | Notifications `host.new_entry`, `host.draw_short` (hourly job a day before close), `host.draw_cancelled`, `host.ready_to_draw`, `host.event_completed`; organizer notices open the organizer section. App: *Needs you*. |
| F13 | Check-in open from 2 h before the start until the end; self check-in needs the phone within 1 km when the event's place is known. App: QR scanning (`expo-camera`) and tap-to-check-in at the desk. |
| F14 | Event courts (`addEventCourt`, `removeEventCourt`, `Event.courts`); the scheduler uses them, or a venue's courts only for the venue's owner; per-draw `matchMinutes`; `setMatchTime` (a time with no court). |
| F15 | `eventPendingResults`. App: *Results* (keep / enter the right score) and *Correct the result*. |
| F16 | `minEntries` may go down after entries, until the draw closes. App: offered in the close sheet. |
| F17 | `Event.location`. App: a map pin (Leaflet in the existing WebView). |
| F18 | Dates and place may move after entries until a draw is made; entrants are told (`event.changed`) and may withdraw in full for 48 h. |
| F19 | `removeEventCategory`; the cancel reason reaches players. |
| F20 | Walk-ins by name (guest users, never emailed), doubles walk-ins, and walk-ins into a closed, undrawn draw. |
| F21, F22 | Per-draw match format (`tweaks`: points, games, sets, period minutes, overs) validated by the sport's schema; every draw's rule frozen on the category at publish. `Format.ruleKind`, `EventCategory.formatSummary`. |
| F23 | `single_elim` draw type and a third-place match; standings place 3 and 4. App: shown under the bracket. |
| F24 | `prizes`, `rulesNote` per draw. |
| F25 | `draw.finished` notification with the winner; podium and share on the results tab. |
| F26 | A result confirmed by silence, or from a draw under 4 entries, is not rated. Account-pair flagging is not built. |
| F27 | Refund policy `standard` / `flexible` (half back between cutoff and start); gateway fee kept from the capture payload; on a host-cancelled event the fees come out of the host's payout (`gatewayFeesPaise`). |

**Not done:** flagging account pairs that only play each other (F26); a desktop admin web app (the app is it
for now); venue court bookings (module 19). The 2026-10-03 leftovers still open: OTP on bank change (#25),
automatic settlement of old disputes (#20, now mostly covered by F5 and F9).

**Run on deploy:** migration `035_organizer`; a new APK build (expo-camera is a new native module).

---

## 1. Verdict

**A player can host and publish an event, take entries and get paid. But they can't run the event itself.**

The backend can make draws, schedule them, check players in, take scores and settle disputes. The app only covers the
part *before* the event: create, publish, close registration, manage entries and staff. The organizer web console
(module 17), which was meant to do the draw, schedule and check-in, **doesn't exist**. `PLAY_FRONTEND/apps` has only
`player` and `website`, and the website is a single marketing page. So the app tells a host that a category is
*"Registration closed — ready to draw"*, and nothing on any screen can make that draw.

So the product today can't take a hosted event from "registration closed" to "first match". After that:

- the backend's 24-hour completion sweep marks the event *completed*,
- the host's payout is scheduled 72 hours after the end,
- **the host is paid for an event that may never have been played,** and players have no way in the app to say so.

The five biggest:

1. **F1:** hosts can't make a draw, so a bracket event can't start (P0).
2. **F2:** a host can remove a player who paid and keep the money (P0).
3. **F3:** the payout goes out whether or not the event happened, and players can't report it (P1).
4. **F4:** a host who plays in their own event can confirm their own result (P1).
5. **F5:** results nobody confirms never become final, so brackets stall and the event "completes" with no winner (P1).

---

## 2. End-to-end flow map

✅ works in the product · ⚠️ partly works or has a hole · ❌ backend only or missing

| # | Step | Host | Player | Notes |
|---|---|---|---|---|
| 1 | Become a host | ✅ | — | Any player, from the Play tab |
| 2 | Create event (wizard) | ✅ | — | No map pin, no rules or prizes (F17, F24) |
| 3 | Set up paid entry (bank, PAN, verification) | ✅ | — | OTP on bank change still open (#25) |
| 4 | Publish | ✅ | — | |
| 5 | Edit after publishing | ❌ | — | API allows title, description and venue; the app can only edit drafts (F11) |
| 6 | Discover and see who's hosting | — | ⚠️ | Only the host's name and avatar; nothing to judge trust by (F3) |
| 7 | Register, pay, partner invite | — | ✅ | |
| 8 | Message entrants (rain, venue change) | ❌ | — | `messageEventPlayers` has no screen (F10) |
| 9 | Host notified of entries and shortfalls | ❌ | — | The host is told almost nothing before match day (F12) |
| 10 | Close registration | ⚠️ | — | One tap, no confirmation; can cancel draws on the spot (F8) |
| 11 | **Make the draw** | ❌ | — | No screen; no automatic draw (F1) |
| 12 | Schedule matches and courts | ❌ | — | Only automatic, only at venues with courts on PL4Y (F14) |
| 13 | Check-in at the venue | ⚠️ | ⚠️ | Players check themselves in from anywhere; staff can't scan QR codes (F13) |
| 14 | Live scoring | ✅ | ✅ | |
| 15 | Confirm or dispute a result | ⚠️ | ✅ | No queue for the host; a host who plays can self-confirm (F4, F15) |
| 16 | Correct a confirmed result | ❌ | — | API only (#18 left this open) |
| 17 | Heats sports | ✅ | ✅ | Unlike brackets, heats *can* be run from the app |
| 18 | Event finishes, winners shown | ⚠️ | ⚠️ | Completes after 24 h even with the bracket unfinished; nobody is told who won (F5, F25) |
| 19 | Host payout | ✅ | — | Paid whether or not the event was played (F3) |
| 20 | Ops: refunds, payout holds, disputes, fraud | ❌ | — | APIs and alert emails exist, but no admin screens (F9) |

---

## 3. P0: the flow breaks or money goes to the wrong person

### F1. Hosts can't make a draw, so a bracket event never starts

**What happens.** After registration closes, the manage screen says *"Registration closed — ready to draw"* and the hint
says *"Make the draws once registration is closed."* No screen calls `generateDraw`, `regenerateDraw`, `scheduleDraw`,
`assignCourt` or `addCourt`. The draw tab shows *"No draw yet"* to everyone, the host included. Nothing on the server
makes the draw by itself either: the `close-registration` job only closes or cancels categories.

**Who feels it.** Every host with a knockout, league or group category. Only heats sports work, because `HeatsPanel` can
call `createHeats` / `advanceHeats`.

**Evidence.**
- `PLAY_FRONTEND/apps/player/src/features/host/copy.ts:156-161`: the copy promises a draw step.
- `PLAY_FRONTEND/apps/player/src/features/bracket/screens/DrawScreen.tsx:105-112`: a "no draw" message, with no action for staff.
- `PALY_BACKEND/src/modules/tournament/service/index.ts:541`: `generateDraw` exists, but only the API reaches it.
- `PLAY_FRONTEND/docs/feature-coverage.md:109,123-124`: Scheduling and Tournament management are marked 🟢 against an `apps/organizer` that was never built.

**Fix.** Add a *Draws* section to Manage Event, shown per category once its status is `closed`:
- *Make draw* (`generateDraw`) shows a preview of seeds and first-round pairs, then asks to confirm.
- *Redo draw* (`regenerateDraw`) is offered until the first match starts.
- If `PLAYERS_STILL_PAYING` comes back, show "try again in a few minutes" with a retry timer.

Then consider making the draw automatically when registration closes, with a host setting *"make the draw for me"* that
is on by default for player-hosted events. Also fix the coverage doc: 17-organizer-web is ⚪, not 🟢.

### F2. A host can remove a player who paid and keep the money

**What happens.** `removeRegistration(registrationId, refund: false)` moves a confirmed, online-paid entry to `withdrawn`
without a refund. The payment stays `captured`, so the payout counts it as the host's money (minus 10%). A host could
fill a draw, remove players the day before it closes and keep their fees. The player loses their place *and* their money,
and PL4Y is the one they blame.

**Evidence.** `PALY_BACKEND/src/modules/registration/service/index.ts:1676-1678`:
```ts
const paidOnline = seated && row.paymentMode === 'online' && row.amountPaise > 0n;
const to = seated ? (paidOnline && opts.refund ? 'refunded' : 'withdrawn') : 'expired';
```
The quote counts every `charge` that hasn't been refunded (`payments/service/payoutQuote.ts`).

**Fix.** An entry paid online that the *host* removes is always refunded in full. Drop the `refund` argument for online
payments, or ignore it. `refund: false` should only apply to `offline` and `comp` entries. If a host has a real reason to
keep a fee (for example a no-show after the cutoff), that's a decision for PL4Y staff through `staffRefundRegistration`,
not for the host.

---

## 4. P1: trust and fairness

### F3. The host is paid whether or not the event happened, and players can't report it

**What happens.** `dueForCompletion` marks any published or live event *completed* 24 hours after `endsAt`, whether or
not anything was played. `event.completed` then schedules the payout for `endsAt + 72 h`. The automatic holds check the
bank account, pending refunds and cancellation, but **not whether there's any sign the event took place**. Meanwhile a
player can't get a refund after the start (gap #4), can't report the event (there's no `report*` mutation), and can't
review the host.

**Example.** A host publishes a ₹500 doubles event and 16 pairs pay. The host never turns up. Three days later PL4Y sends
the host ₹7,200, and the players' only option is to email support, if they can find an address.

**Evidence.** `events/service/index.ts:1358` (`dueForCompletion`) · `payments/service/payouts.ts:406` (`scheduleForEvent`)
and `:436` (`automaticHold`) · the schema has no report or complaint mutation · `OrganizerSummary` is only
`{ id, displayName, avatarUrl }` (`schema.graphql:1427`).

**Fix, in order of value.**
1. **Evidence-of-play hold.** When a paid event completes, hold its payout as `no_play_evidence` if it has
   0 started matches **and** 0 check-ins. Staff release it.
2. **"Report a problem with this event"** on the event page and in My Play, open from the start time until the payout
   is due. Any open report holds the payout (`player_report`) and emails ops.
3. **Signs a host can be trusted** on the event page: *Verified host* (payout account verified), events hosted so far,
   and later a host rating left after the event.
4. For a host's first paid event, consider a longer settlement delay (for example 7 days).

### F4. A host who plays in their own event can confirm their own result

**What happens.** "Any player can host", so hosts often enter their own draws. The scoring module refuses to let an
organizer who plays in a match *correct* it (`correctResult` checks `who.side`). It doesn't apply the same check to:
- **the 15-minute override** in `confirmResult`: the host submits their own score, waits 15 minutes and confirms it as
  "organizer", and the bracket advances;
- **disputes**: when the opponent disputes, the override opens straight away, so the host can confirm their own version
  at once;
- **settling by resubmission** in `submitResult`: an owner or manager can resubmit a disputed result even when it's
  their own match.

`resultAccess` shows the host the *Confirm* button in all three cases.

**Evidence.** `scoring/service/index.ts:631` (settling), `:699-704` (`resultAccess`), `:762-780` (manager override), and
for comparison `:940` (`correctResult` does check).

**Fix.** Use the same rule everywhere: *staff who play in this match are players here.* In `confirmResult`, `resultAccess`
and the settling branch of `submitResult`, treat `manager` as `role ∈ {owner, manager} && side === null`. If the only
organizer is a player, the match falls back to the opponent confirming it, or to F5's timeout. Then a dispute in a
host's own match escalates to PL4Y (the existing escalation path) instead of the host settling it.

### F5. Results nobody confirms never become final: brackets stall and the event "completes" with no winner

**What happens.** Since gap #17, only neutral staff results confirm themselves (`isAutoEligible` returns true only for
`staff`). A result submitted by a player waits for the opponent, or for an owner or manager after 15 minutes. In a
player-hosted event with no scorers, almost every result is submitted by a player. If the loser just doesn't answer and
the host is busy playing, the result stays `awaiting_confirm` forever:
- the winner's next match never becomes `ready`, so the bracket stops,
- 24 hours after the end, the event is marked *completed* anyway, with categories still `drawn`, no champion and no
  rating update,
- escalation only fires for **disputed** results. An undisputed result that nobody confirmed reaches nobody.

**Evidence.** `scoring/finality.ts` (`isAutoEligible`) · `scoring/service/index.ts:813-885` (`sweep`; escalation only
covers disputes) · `events/service/index.ts:1352-1368`.

**Fix.**
- A player's result that is **not disputed** confirms itself once the opponent has been told (submitted) and reminded
  (the R14 reminder), at `min(submitted + 2 h, event end + 2 h)`. Keep the gap #17 protection by **not counting results
  confirmed this way toward rating**, or by counting them only after 24 hours with no dispute. Either way, the bracket
  can move.
- When the event completes with matches still open, settle the category as *finished, not completed* and show
  "Final not played" on the results page instead of an empty winner.

### F6. A walkover can be claimed before the match starts, with no evidence

**What happens.** Either side can `submitResult(outcome: 'walkover', winner: <me>)` as soon as the match is `ready`.
Check-in isn't consulted, even though the opponent may have checked in. With F4 or a busy host's override, a claimed
walkover gets through.

**Evidence.** `scoring/service/index.ts:582-590` (any winner is accepted for a non-`played` outcome) · `:602-651` (no
check-in or time check).

**Fix.** A player can only claim a walkover if (a) the opponent hasn't checked in and (b) at least 15 minutes have passed
since the match's scheduled time, or since it became `ready` when it has no time. Otherwise a walkover can only be
entered by neutral staff. Show the opponent's check-in state on the claim screen.

### F7. Removing a manager is owner-only, but a manager can demote one

**What happens.** `addStaffMember` upserts the grant. A manager calling `addEventStaff(email: <another manager>, role:
SCORER)` overwrites that person's role, which `removeStaffMember` is meant to stop.

**Evidence.** `events/service/index.ts:1540-1544` · `identity/service/index.ts:552-557` (`upsert … update: { role }`).

**Fix.** In `addStaffMember`, if `theirs?.role === 'manager'` and the caller isn't the owner, return `FORBIDDEN`.

### F8. "Close registration now" is one tap and can't be undone

**What happens.** The button calls `closeEventRegistration` straight away. Any category below `minEntries` is
**cancelled and every entry in it refunded** in the same call. The hint mentions this, but there's no confirmation step,
no count of which categories would be cancelled, and no undo. A host who taps it by mistake, or who meant to "close
early so I can draw", can wipe out a category that was one entry short with a day still to go.

**Evidence.** `host/screens/ManageEventScreen.tsx:72-84` · `events/service/index.ts:1375-1451`.

**Fix.** Use a confirmation sheet listing each category: *"Men's Doubles: 12 entries, will be drawn"* /
*"Mixed: 3 of 4 minimum, will be **cancelled and 3 entries refunded**"*. Offer to **lower the minimum** right there
(see F16) before confirming.

### F9. PL4Y ops have no tools

**What happens.** The money and fairness safety nets end in an email to ops, or in an API with no screen:
- `result.escalated` and payout alerts go to `PAYOUT_ALERT_EMAIL`,
- `holdPayout`, `releasePayout`, `retryPayout`, `approve/reject/suspend/reinstatePayoutAccount`,
  `staffRefundRegistration` and `correctMatchResult` have **no screen in any app**.

Ops can only act through the GraphQL playground or SQL, which is slow and risky, and none of it is audited in the
product.

**Evidence.** A grep of `PLAY_FRONTEND/apps` finds no use of `holdPayout`, `staffRefundRegistration` or
`correctMatchResult` · `PLAY_FRONTEND/docs/feature-coverage.md:141` ("Admin dashboard … unspecified").

**Fix.** Before paid hosting launches, build a minimal internal admin with five screens: *Payout accounts to review*,
*Payouts held*, *Disputes escalated*, *Event reports* (F3), and *Refund an entry*. It can be a protected Next.js route
inside `apps/website` using the same GraphQL API.

---

## 5. P2: things a host needs to do that the product doesn't support

### F10. The host can't message their players

`messageEventPlayers` exists (rate-limited, with push and feed) but no screen calls it. Telling 32 players "Court 3 is
flooded, start moved to 9:30" is the most common thing a host does on match day.
**Fix.** Add a *Message players* sheet on Manage Event while the event is published or live, with the throttle shown.
**Evidence.** `events/service/index.ts:1104` · the frontend grep finds nothing.

### F11. A published event can't be edited from the app

The API allows title, description, contact phone, location note, cover and venue to change after publishing (and dates
until someone pays). The app only reopens **drafts** in the wizard. A typo in the title, a new phone number or a venue
change can't be fixed.
**Fix.** Add an *Edit details* sheet for published events, limited to fields that aren't frozen. **And see F18:**
changing the venue after people have paid should not be allowed silently.

### F12. The host isn't told anything until match day

The host gets notifications for results waiting, disputes and payouts. They aren't told:
- someone registered or paid (even a daily summary would do),
- a category is short of its minimum 24 hours before closing,
- a category was **cancelled under minimum** (`notify.categoryCancelled` only goes to entrants, `notify.ts:154`),
- registration has closed and the draw is ready to make,
- the event completed and the payout is scheduled.

The `results.waiting` notification opens the event page, not a list of results waiting.
**Fix.** Add the five notifications above for the owner and managers, plus a *Needs you* list on Manage Event: results
to confirm, disputes, players still paying.

### F13. Check-in doesn't work as check-in

- **Self check-in from anywhere.** A participant can check themselves in within ±2 hours of the event's start without
  being at the venue (`registration/service/index.ts:1396-1401`, `:1363`).
- **QR passes nobody can scan.** Players get a QR code, but no screen calls `checkInByToken`.
- **Multi-day events.** The window is around `event.startsAt`, so on day 2 nobody can check in.
- **It changes nothing.** The draw is made from confirmed entries, and walkovers don't look at check-in (F6).

**Fix.** Add *Scan players in* on Manage Event (camera → `checkInByToken`, plus the offline token list that already
exists). Allow self check-in only within N metres of the event location, or turn it off for paid events. Base the window
on each match's scheduled time (or each day's start), not only the event's start. Then use check-in in F6.

### F14. Most hosted events will have no match times, and venue courts get booked without asking

- The scheduler only runs when the event has a `venueId` **and** that venue has courts on PL4Y. Player-hosted events at
  "the park" or a venue that isn't listed get **no match times**. Then `match.scheduled` never fires, the 30-minute
  "you're on soon" push never goes out, and players can't plan their day.
- When there *is* a venue, the scheduler books **any active court at that venue**, even though the venue owner never
  agreed to host the event.
- Every match is planned as 45 minutes, whatever the sport or format (`tournament/service/index.ts:95`).

**Fix.** Let the host say *"I have N courts, named …, from 9:00"* for the event itself, and schedule onto those. Only use
the venue's own courts when there's a booking with the venue (module 19). Take the match length from the scoring rule,
or let the host set it.

### F15. Settling a dispute is hard to find and hard to do

The host learns about a dispute by notification and then has to find the match through Event → Draw → match card.
Settling means *resubmitting* a scoreline (`submitResult` by an owner or manager) or confirming the original; the app has
no "settle dispute" step that shows both sides' versions and the reason. Corrections (#18) have no screen at all.
**Fix.** Add a *Disputes* list on Manage Event. Each item shows both scorelines, the reason and the point log, with two
choices: *Keep submitted* or *Enter the correct score*. Reuse the same screen to correct results that are already
confirmed.

### F16. The host can't lower the minimum entries to save a draw

`minEntries` counts as a "term" and freezes once anyone has entered (`events/service/index.ts:1197-1211`). Lowering it
only helps the players already in (their draw goes ahead instead of being refunded), but the host can't do it. The
category is then cancelled automatically at close.
**Fix.** Allow `minEntries` to go **down** (never below the draw-type floor) after entries exist. Keep raising it frozen.

### F17. Events without a venue have no location

There's no map pin (no map library). An event that isn't at a listed venue has only a city: it can't be shown on the
Discover map, sorted by distance or given directions.
**Fix.** Add a pin picker, or at least place search via a geocoding API, in the *Where* step.

### F18. The venue can move after players have paid, and nobody is told

`FROZEN_AFTER_ENTRY` freezes the dates only. `venueId`, `city`, `location` and `locationNote` can change after people have
paid (`events/service/index.ts:910-997`), with no notification to entrants and no chance for them to withdraw with a
refund.
**Fix.** After the first entry, a venue or city change (a) notifies every entrant, (b) opens a 48-hour window where they
can withdraw with a full refund even after the cutoff, and (c) is logged. A change of date is the same "postpone" case:
today it's blocked completely and the host's only option is to cancel.

### F19. Draft hygiene

- A saved category can't be deleted (there's no mutation), so a draft carries mistakes until it's cancelled.
- Cancelling sends the fixed reason *"Cancelled by the host"* (`copy.ts:153`). Players never hear *why*.
**Fix.** Add `removeEventCategory` (drafts, or published with no entries). Add a reason field to the cancel sheet, shown
in the cancellation notification.

### F20. Walk-ins are hard

`addOfflineRegistration` needs the player to **already have a PL4Y account** (looked up by email), is **singles only**,
and only works while registration is **open**. But the draw can only be made once registration is **closed**. A host
with three doubles walk-ins on the morning can't add them.
**Fix.** Allow a name-only guest entry (no account; it can be claimed later by email or phone), allow doubles, and allow
adding walk-ins to a category that's `closed` but not yet `drawn`.

---

## 6. P3: format depth, scoring rules and business hygiene

### F21. Hosts can't choose the match format

The scoring rule comes from the sport and format (`scoring/index.ts:49-54`). A host can't say "one game to 21" instead of
best of three, "pickleball to 15", or "20-minute football halves". Formats are the main thing hosts adjust to fit an
event into a day.
**Fix.** Add a short per-category list of approved rule variants for each sport (seeded like formats), chosen in
`CategoryEditor`.

### F22. The rule is read live, not saved with the category

`ruleFor` reads the sport's current rule at every scoring call. If PL4Y edits a sport rule, matches in progress, and
results not yet confirmed (`judge` re-checks against the rule), switch rules part way through.
**Fix.** Save `scoringRuleId` (or the rule JSON) on the category when it publishes or is drawn.

### F23. Draw format options are thin

- A knockout **always** has a Plate (`DRAW_TYPES`, `tournament/service/index.ts:628-630`). There's no plain knockout and
  no third-place play-off.
- Seeding is by rating only. There's no manual seeding, no way to keep clubmates apart, and no preview before
  committing (see F1).
- A league has no size limit beyond capacity: 16 entries is 120 matches, with no check against the event's length or the
  number of courts.
- Group stage: always the top 2 go through; groups of about 4; points are fixed at 3/1/0.
**Fix.** Add `single_elim` (no plate) and a "3rd place match" switch. Allow manual seed edits before the draw is
confirmed. Warn when *matches × length ÷ courts* is longer than the event.

### F24. The event page doesn't say what you're playing for

There's no field for prizes, rules or format notes per category. Hosts put them in the description, where players can't
filter or compare them.
**Fix.** Add a `prizes` and a `rulesNote` field per category, shown on the category sheet.

### F25. Nobody is told who won

When the tournament completes, there's no notification to entrants, no winners card on the event page, and no
shareable result. This is the moment people share on WhatsApp and Instagram, which is free growth.
**Fix.** On `tournament.completed`, send *"🏆 X won Men's Doubles"* to everyone in that category. Show a podium on the
results tab, with a share image.

### F26. Ratings can be gamed in private hosted events

Any `played` result that has been confirmed is rated. Two friends (or one person with two accounts) can host a free event,
"play" a match and have the opponent confirm it, and so raise a rating. Seeding uses ratings, so this then affects
real events.
**Fix.** Only rate matches in events with at least N distinct confirmed entrants, or at least one neutral confirmation
(scorer or auto). Flag pairs of accounts that play only each other.

### F27. Refund terms and gateway costs

- A host can't set a refund policy (for example 100% until the cutoff, 50% after). It's all or nothing until the draw.
- On a refund, PL4Y gives back the full entry fee and loses its 10% commission (`payoutQuote.ts`). The gateway keeps its
  ~2% fee, so **every refund and every host cancellation costs PL4Y money**, and a host can cancel at no cost to themselves.
**Fix.** Track the gateway fee in the ledger. Decide who bears it on a host cancellation (suggestion: the host, taken from
a later payout as a receivable). Offer two or three preset refund policies.

---

## 7. Already covered by 2026-10-03 and still open

| Item | Status |
|---|---|
| #18 correct a confirmed result | API done, **no app screen** (folded into F15) |
| #20 automatic settlement of old disputes | Not done; F4 and F5 need it more now |
| #25 OTP on bank change | Not done |
| #33 staff refund | API done, **no admin screen** (F9) |
| "Also": check-in before playing | Not done (F6, F13) |

---

## 8. Suggested order

1. **Make the event runnable:** F1 (draws in the app) → F14 (host-declared courts and times) → F13 (scan check-in).
   Until F1 lands, **don't promote hosting for bracket sports.**
2. **Close the money holes:** F2 → F3 (evidence hold plus report) → F9 (minimal admin).
3. **Make scoring fair:** F4 → F5 → F6, as one scoring change with one set of rules about who can confirm what.
4. **Help the host on the day:** F10, F12, F15, F8, F16.
5. **Then the rest:** F11, F18–F27.

Before paid hosting goes public: **F1, F2, F3, F4, F5 and F9** must be in.

---

## 9. How each was checked

Every gap above was checked against the current code, not the specs. To re-check:

- **App never calls an operation:** `grep -rn "<mutationName>" PLAY_FRONTEND/apps --include=*.ts --include=*.tsx`
  returns nothing for `generateDraw`, `scheduleDraw`, `assignCourt`, `checkInByToken`, `messageEventPlayers`,
  `correctMatchResult`, `staffRefundRegistration`, `holdPayout`.
- **F2:** in a test, register and pay, then `removeRegistration(refund: false)`. Expect the registration `withdrawn`, the
  payment `captured`, and the payout quote to include the fee.
- **F4:** make the host an entrant, submit their own match result, move the clock forward 15 minutes and call
  `confirmResult` as the host. Expect `via: 'staff'` and the bracket to advance.
- **F5:** have a player submit a result and never confirm it. Run `sweep()` past the event's end + 24 h. Expect the
  result still unconfirmed and the event `completed`.
- **F7:** as a manager, call `addEventStaff(otherManagerEmail, SCORER)`. Expect the other person's role to become `scorer`.
