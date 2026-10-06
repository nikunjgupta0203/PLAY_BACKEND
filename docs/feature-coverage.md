# Feature coverage

Maps every item in the product feature list,
[PL4Y — Complete Feature Set](https://docs.google.com/document/d/1GeflOGnoXtd22DebhOv7ydAQ6p3F5TU27k0p80y9Y1I/edit),
to the module and rule that specify it.

**Before this update** the module specs fully covered **37 of 79** features. **18** were partial and
**24** were not specified at all. **Now every feature has a spec.** Seven modules were added
(14–20), and ten existing modules gained rules. No existing rule was renumbered; `social R7` is
struck through and superseded by `social R8`.

| Status before | Meaning |
|---|---|
| ✅ | Already fully specified |
| ⚠️ | Partially specified — the gap is noted |
| ❌ | Not specified |

Phase: **P1** is the launch core loop, **P2** retention and community, **P3** specified but not
scheduled for launch.

---

## 👤 Player

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Profile | ✅ | profile R1–R9 | P1 · 2 |
| Sports & skill levels | ✅ | sport R2 · profile R3 | P1 · 2 |
| Player preferences | ❌ only notification preferences existed | **profile R11** | P2 · 11 |
| Player search | ✅ | profile `search` | P1 · 2 |
| Connect | ✅ | **profile R10** played with · **chat** (spec 2026-09-29) — follows removed | P1 |
| Chat | ✅ | chat R1–R9: shared play opens a chat, everyone else a request | P1 |
| Activity history | ⚠️ 90-day follower feed only | **social R8** | P2 · 11 |
| Achievements/badges | ⚠️ table only, no awarding rules | **profile R13** | P1 · 9 |
| Match history | ⚠️ last 5 results, blocked on `matches` | **profile R12, R14** · tournament R17 | P1 · 8 |
| Stats | ✅ | profile R8 | P1 · 2 |
| Rankings | ✅ | rating R9–R11 | P1 · 6 |
| Notifications | ✅ | notifications; **23 templates added** (R9–R11) | P1 · 9 |

## 🔎 Discover

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Discover games | ✅ | games `search`, R6 | P2 · 10 |
| Discover events | ✅ | events R6 | P1 · 3 |
| Discover tournaments | ✅ | events R6 · **events R11** (`kind` filter) | P1 · 3 |
| Discover leagues | ❌ | **leagues** · events R11 · discovery R1 | P3 · 13 |
| Discover players | ⚠️ name search only | **discovery R2, R7** (`nearbyPlayers`, `suggestPlayers`) | P2 · 11 |
| Discover communities | ❌ | **communities** · discovery R1 | P2 · 11 |
| Discover venues | ✅ | venues R1 | P1 · 3 |
| Search & filters | ⚠️ per entity only | **discovery R1** — unified search | P2 · 11 |
| Location-based discovery | ✅ | events R6 · venues R1 · games R6 · discovery R3 | P1 · 3 |
| Personalized recommendations | ⚠️ named in the `home` checklist, never specified | **discovery R4–R6, R9, R10** | P2 · 11 |

## 🎮 Play

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Join games | ✅ | games | P2 · 10 |
| Create games | ✅ | games R1 | P2 · 10 |
| Open play | ❌ | **games R8** | P2 · 11 |
| Find players | ⚠️ name search only | **discovery R7** | P2 · 11 |
| Player matching | ❌ | **discovery R7, R8** · profile R11 (opt-in) | P2 · 11 |
| Team formation | ⚠️ partner invite only | **registration R20** (partner requests) · discovery R8 · communities R5 | P2 · 11 |
| Game scheduling | ✅ | games | P2 · 10 |
| Recurring games | ❌ | **games R10, R11** | P2 · 11 |

## 🏆 Compete

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Tournaments | ✅ | tournament | P1 · 8 |
| Leagues | ❌ architecture §9 non-goal | **leagues** · tournament R14–R16 | P3 · 13 |
| Matches | ✅ | tournament · scoring | P1 · 8 |
| Teams | ⚠️ per-registration teams only | **communities R1, R5** (kind `team`) · registration R19 | P2 · 11 |
| Fixtures | ⚠️ same-day court schedule only | **tournament `fixturesFor`, R14** · leagues R5 | P1 · 8 / P3 · 13 |
| Brackets | ✅ | tournament R3–R5 | P1 · 8 |
| Live scores | ✅ | scoring | P1 · 8 |
| Results | ✅ | scoring R6–R8 | P1 · 8 |
| Leaderboards | ✅ | rating rankings · **tournament R15** (league standings) | P1 · 6 |
| Rankings | ✅ | rating | P1 · 6 |
| Challenges | ✅ | social R1–R6 | P2 · 10 |

## 🏟️ Venues

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Venue profiles | ✅ | venues (description and opening hours added in Sprint 11) | P1 · 3 |
| Courts/grounds/turfs | ⚠️ courts only | **venues R10** — playing-area `kind` | P2 · 11 |
| Availability | ❌ deferred to Phase 3, unspecified | **bookings R4** | P3 · 14 |
| Bookings | ❌ deferred to Phase 3, unspecified | **bookings R1–R3, R5, R6, R10** | P3 · 14 |
| Venue discovery | ✅ | venues R1 | P1 · 3 |
| Venue reviews | ❌ | **venues R6–R8** | P2 · 11 |
| Venue management dashboard | ❌ | **identity R17** · venues R9 · bookings R7, R8 | P2 · 11 / P3 · 14 |

## 🎟️ Events

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Event creation | ✅ | events | P1 · 3 |
| Registration | ✅ | registration | P1 · 4 |
| Ticketing | ❌ | **ticketing** | P3 · 15 |
| Payments | ✅ | payments | P1 · 4 |
| Check-in | ✅ | registration R10 | P1 · 4 |
| QR tickets | ❌ | **registration R13** (entrants) · **ticketing R4** (spectators) | P1 · 5 / P3 · 15 |
| Brackets | ✅ | tournament | P1 · 8 |
| Scheduling | ✅ | tournament R11–R13 | P1 · 8 |
| Live scoring | ✅ | scoring | P1 · 8 |
| Results | ✅ | scoring | P1 · 8 |
| Refunds | ✅ | payments R7, R8, refund policy | P1 · 4 |
| Event analytics | ❌ | **organizers R8–R10** | P1 · 7 |

## 🧑‍💼 Organizer

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Organizer profile | ❌ organizer was only an event grant | **organizers R1–R5** | P1 · 7 |
| Event management | ✅ | events · identity grants | P1 · 3 |
| Tournament management | ✅ | tournament | P1 · 8 |
| League management | ❌ | **leagues** | P3 · 13 |
| Player management | ⚠️ list and check-in only | **registration R14–R17** · organizers R11 | P1 · 5–7 |
| Team management | ⚠️ none beyond the invite | **registration R15** (substitution) · communities R5 | P1 · 7 / P2 · 11 |
| Payments | ⚠️ refunds only — **no way to pay organizers** | **payments R13–R19** (Route payouts) | P1 · 7 |
| Communication | ⚠️ `organizer.message` template with no sender | **organizers R6, R7** · notifications R11 | P1 · 7 |
| Analytics | ❌ | **organizers R8–R10** | P1 · 7 |

## 📊 Platform

| Feature | Before | Specified in | Phase · Sprint |
|---|---|---|---|
| Admin dashboard | ❌ | **admin R1–R5, R10** | P1 · 7 |
| User management | ⚠️ `suspend` only | **admin R3** · identity R15, R18 | P1 · 7 |
| Organizer management | ❌ | **admin** · organizers R5 | P1 · 7 |
| Venue management | ❌ manual only | **admin** · venues R9 | P2 · 11 |
| Event moderation | ❌ | **admin R5** · events R12 | P1 · 7 |
| Payments management | ⚠️ reconciliation job only | **admin** (refund override, payout holds) · payments R16 | P1 · 7 |
| Reports & analytics | ❌ | **admin R9** | P2 · 12 |
| Fraud prevention | ⚠️ disposable domains and OTP limits only | **admin R8** · payments R16, R19 | P2 · 12 |
| Notifications | ✅ | notifications | P1 · 9 |
| Support | ❌ | **admin R7** | P2 · 12 |

---

## Gaps found in the existing specs along the way

These were not in the feature list; they surfaced while tracing it, and each is now fixed.

| Gap | Fix |
|---|---|
| `registration` promised waitlist promotion but had no waitlist table or state | registration R17 — `waitlisted` status + `waitlist_entries` |
| `achievements` unique index allowed duplicate awards whenever `event_id` is null | profile — `UNIQUE NULLS NOT DISTINCT` fix-forward migration |
| Ten events were emitted to `notifications` with no template to render them | notifications — templates added |
| Organizers could take entry fees but nothing specified how they get paid | payments R13–R19 |
| Profile match history needed `matches`, which profile may not read | tournament R17 — full `match.completed` payload; profile R12 projection |
| Free events had no path that skipped a payment order | registration R18 |

## Decisions made in this update — review these

1. **`Node` grows from four types to six** (`Venue`, `Community`). The conventions called this a product decision; it is needed so venue, booking and community notifications can deep-link. See conventions §4 and notifications R9.
2. **Organizers and admin are Phase 1 (Sprint 7)**. Without payouts, verification and an audited admin surface, the first paid tournament cannot be operated.
3. **Payouts use Razorpay Route**, settled 72 hours after an event ends. The **GST treatment of entry fees needs a chartered accountant's answer before Sprint 7** (payments R14).
4. **Leagues reuse the core loop**: a season is an event, a division is a category. No second competition stack.
5. **Bookings and ticketing stay Phase 3**, now fully specified, including the concurrency tests they must start with.
6. **No follows or friends** (removed 2026-09-29): players connect through shared play and chat, with message requests for everyone else.
7. **Communities have announcements only** in Phase 2 — no chat — because of moderation cost.
