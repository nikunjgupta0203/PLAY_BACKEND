# Result finality — Phase 1 design

| | |
|---|---|
| **Date** | 2026-09-27 |
| **Modules** | scoring (owner), notifications, tournament (read only), player app `features/scoring` |
| **Amends** | `docs/modules/10-scoring.md` R6; adds scoring R11–R14 |
| **Out of scope** | Corrections (scoring R7/R8), rating changes (starting rating, limits, retirement abuse), unsettled-dispute closure, rankings screen — Phases 2–4 |

## Problem

A submitted result becomes final only when the opposing side confirms it, or when an owner or
manager confirms for them after 15 minutes (scoring R6). Nothing else moves it. At an amateur event
the organizer is often absent, and the losing side often walks off. The result then sits in
`awaiting_confirm` indefinitely: the bracket cannot advance and no rating is applied.

Three further gaps make this worse:

- The volunteer `scorer` — the one person who watched the match — cannot confirm it.
- Owners and managers are never told a result is waiting; they hear only about disputes.
- A result typed on the result screen is treated exactly like one scored point by point, although
  nobody watched a typed `21–0, 21–0` happen.

## Goal

**Every undisputed result reaches `confirmed` on its own, within about an hour, without an
organizer — unless nobody neutral witnessed it, in which case a human must confirm it.** Organizers
handle exceptions; they are no longer the only path to a final result.

Success: at the seeded tournament, with no organizer online and the losing side never opening the
app, every live-scored match is confirmed and the bracket fully advances.

## Decisions

Agreed in discussion (2026-09-27):

1. Auto-confirm undisputed results after a window (A1).
2. A `scorer` may confirm a result they scored live (A2).
3. Owners and managers are told when the override opens (A3).
4. Results carry how they were entered; typed results are held to a higher bar (A4).
5. Notification gaps are closed (D).

**Assumptions — not answered explicitly, taken from the proposal; flag if wrong:**

- The window is **60 minutes, shortened to the event's end, never shorter than 15 minutes**.
- Players **may still type a result**; a player-typed result simply never auto-confirms.

---

## 1. Data

Migration `019_result_finality` adds five columns to `match_results`. All status-like columns are
`text + CHECK` (conventions.md §2).

| Column | Type | Meaning |
|---|---|---|
| `source` | `text NOT NULL` — `'live' \| 'typed'` | `live`: produced by the final point of the point log. `typed`: entered on the result screen. |
| `submitter_role` | `text NOT NULL` — `'player' \| 'staff'` | Whether the submitter held a staff grant on the event **at submission time**. |
| `auto_confirm_at` | `timestamptz NULL` | When the sweep confirms it. `NULL` = never auto-confirms (R12). Computed once at submission. |
| `confirmed_via` | `text NULL` — `'opponent' \| 'staff' \| 'auto'` | How it became final. `CHECK ((confirmed_at IS NULL) = (confirmed_via IS NULL))`. |
| `reminded_at` | `timestamptz NULL` | Idempotency for the opponent reminder (R14). |
| `staff_alerted_at` | `timestamptz NULL` | Idempotency for the organizer alert (R13). |

`confirmed_by` stays nullable; an auto-confirmation writes `confirmed_by = NULL, confirmed_via = 'auto'`.

Partial index for the sweep:

```sql
CREATE INDEX match_results_pending_idx ON match_results (submitted_at)
  WHERE confirmed_at IS NULL AND disputed_at IS NULL;
```

**Backfill** (pre-launch data only): `source = 'live'` where `outcome = 'played'` and the match's
`current_score->>'matchOver' = 'true'`, else `'typed'`; `submitter_role = 'player'`;
`confirmed_via = 'opponent'` for already-confirmed rows; `auto_confirm_at = NULL` (existing pending
rows are left to the existing paths).

A re-submission (`putResult` upsert — an organizer settling a dispute, or a fresh submission after
an undo) recomputes `source`, `submitter_role`, `auto_confirm_at` and clears `reminded_at` and
`staff_alerted_at`, exactly as it already clears the dispute columns.

---

## 2. Rules

### R6 (amended) — how a result becomes final

A result in `awaiting_confirm` is confirmed by exactly one of:

| Path | Who | When | `confirmed_via` |
|---|---|---|---|
| Opponent | Anyone on the side that did not submit it (both sides, if staff submitted) | Any time, if undisputed | `opponent` |
| Organizer | `owner` / `manager` | 15 min after submission, or at once if disputed | `staff` |
| Witness | `scorer` who recorded ≥ 1 point of this match, and plays on neither side (R12) | Any time, if undisputed and `source = 'live'` | `staff` |
| Sweep | the system (R11) | At `auto_confirm_at`, if undisputed | `auto` |

A disputed result can only be settled by an owner or manager — unchanged.

### R11 — auto-confirmation

A result is **auto-eligible** when `source = 'live'` **or** `submitter_role = 'staff'`. For an
eligible result, at submission:

```
auto_confirm_at = max(submitted_at + 15 min,
                      min(submitted_at + 60 min, event.ends_at))
```

The 15-minute floor keeps the opponent's chance to object even for a match finishing after the
event's advertised end. Ineligible results get `auto_confirm_at = NULL`.

A repeatable job `sweep-results` (tournament queue, **every minute**) confirms every row with
`auto_confirm_at <= now()`, `confirmed_at IS NULL`, `disputed_at IS NULL`. Each confirmation:

- runs `scoring.autoConfirm(matchId)` — its own transaction, under the match row lock
- **re-checks** all three conditions after taking the lock, so a dispute or manual confirmation that
  lands between the sweep's read and its write wins
- then does exactly what a manual confirmation does: `matches.advance(...)` and the
  `result.confirmed` outbox row (now carrying `via`)

One failing match is logged and skipped; it never stops the batch. The sweep is idempotent — a
second run finds nothing.

### R12 — who witnessed it

- A **typed `played`** result by a player is not auto-eligible: nobody watched it. The opponent or an
  organizer must confirm it.
- A typed **walkover / retired / forfeit** by a player is likewise not auto-eligible.
- Anything submitted by staff (live or typed) is auto-eligible: the organizer has delegated trust to
  their staff.
- The scorer witness path requires `source = 'live'`, at least one `point` event in this match's log
  recorded by that scorer, and that the scorer is on **neither** side of the match.

### R13 — the organizer is told

When a pending, undisputed result passes its 15-minute override point, the same sweep sends **one
notification per event** to the event's `owner` and `manager` grants:
*"3 results are waiting for confirmation"*, targeting the event. It marks `staff_alerted_at` on
every row it counted, so each result is counted once. Rows that are auto-eligible are still
included — the organizer may want to confirm early — but results already past `auto_confirm_at` are
not (the same sweep confirms them).

### R14 — the opponent is reminded

Once per result, the answering side is reminded when half of the window has passed:

- Auto-eligible: at `submitted_at + (auto_confirm_at − submitted_at) / 2`, body *"Confirm or dispute
  — it confirms automatically in N minutes."*
- Not eligible: at `submitted_at + 30 min`, body *"Confirm or dispute your result."*

`reminded_at` makes it once-only. No reminder for a disputed result.

---

## 3. Components

### Backend — scoring

| Unit | Change |
|---|---|
| `repo` | Map the new columns in `ResultRow`. `putResult` takes `source`, `submitterRole`, `autoConfirmAt`. `confirm(tx, matchId, userId \| null, via, at)`. New: `pendingForSweep(now)` (due confirmations, due reminders, due staff alerts), `markReminded`, `markStaffAlerted`, `hasRecordedPoints(tx, matchId, userId)`. |
| `service` | Extract the body of `confirmResult` after its permission check into `confirmIn(tx, match, result, { by, via })`. `confirmResult` gains the witness path (R12). New `autoConfirm(matchId)`. `submitIn` receives `source` (`recordPoint` → `live`, `submitResult` → `typed`) and computes `submitterRole` and `autoConfirmAt`. `resultAccess.canConfirm` reflects the witness path. |
| `MatchesPort` | Needs the event's `endsAt` for R11 — add to `MatchInfo` (tournament already joins the event). |
| Errors | No new codes. The witness path fails with the existing `forbidden()`. |

A pure function `autoConfirmAt({ submittedAt, eventEndsAt, eligible })` holds the R11 arithmetic so
it is unit-tested without a database.

### Backend — worker and notifications

| Unit | Change |
|---|---|
| `worker.ts` | Register `sweep-results` (`* * * * *`, tournament queue); its handler calls one `scoring.sweep(now)` that does R11, R13, R14 in that order. |
| `notify.ts` | `resultSubmitted` passes `autoConfirmMinutes` (or null). New `resultReminder`, `resultsWaiting`. `resultConfirmed` passes `auto`. |
| `templates.ts` | `match.result_pending` gains `autoConfirmMinutes: number \| null`. New `match.result_reminder { eventTitle, autoConfirmMinutes \| null }`, `match.results_waiting { eventTitle, count }`. `match.result` gains `auto: boolean` ("…confirmed automatically"). New `rating.changed { sportName, rating, delta }`. |
| Staff list | R13 needs the event's owner/manager user ids. Use identity's event-staff read if one exists; otherwise add `staffOf(eventId, roles)` to identity's public interface. |
| `rating.changed` | Deliver to the player — **settled period changes only**, skipped when `|delta| < 1`. The provisional change already arrives as the `match.result` push; a second push per match is noise. |

### GraphQL

```graphql
enum ResultSource { LIVE TYPED }
enum ResultConfirmation { OPPONENT STAFF AUTO }

type MatchResult {
  # …existing fields
  source: ResultSource!
  autoConfirmAt: DateTime        # null = a person must confirm
  confirmedVia: ResultConfirmation
}
```

`viewerCanConfirm` needs no schema change — it already comes from `resultAccess`.

### Player app — `features/scoring`

| Unit | Change |
|---|---|
| `api.ts` | Select `source`, `autoConfirmAt`, `confirmedVia`. |
| `ResultPanel` | While waiting: if `autoConfirmAt`, show *"Confirms automatically in mm:ss"* (reusing `useCountdown`) instead of the override countdown. `source = TYPED` shows a *"Typed result"* label. Confirmed with `confirmedVia = AUTO` reads *"Confirmed automatically"*. |
| `core/copy.ts` | Strings for the above. |

The confirm-notification target stays `{ kind: 'match' }` → `/match/[id]`: that screen already
carries `ResultPanel` with Confirm and Dispute, so pointing it at `/match/[id]/confirm` adds nothing.

---

## 4. Failure handling

| Case | Behaviour |
|---|---|
| Opponent confirms while the sweep is confirming | Row lock serialises them; the second sees `confirmed_at` set and does nothing (sweep) or gets `RESULT_ALREADY_CONFIRMED` (user). |
| Opponent disputes a second before `auto_confirm_at` | The sweep's post-lock re-check sees `disputed_at` and skips. |
| Undo after submission | Unchanged: an undo drops the unconfirmed result, so it leaves the sweep. |
| `advance()` throws for one match | That match's transaction rolls back; logged; retried next minute. Other matches proceed. |
| Worker down for an hour | On restart the sweep confirms everything overdue. `auto_confirm_at` is a floor, not an exact time. |
| Event ended before the match was submitted | The 15-minute floor applies. |

---

## 5. Testing

Service tests against real Postgres in `tests/scoring.test.ts`, using the existing clock offset:

- R11: a live result is not confirmed at 59 min and is at 60; bracket advances; `result.confirmed`
  written with `via = 'auto'`; `confirmed_by` null.
- R11: `auto_confirm_at` is shortened by the event's end, and never below 15 minutes.
- R11: a disputed result is never auto-confirmed; a dispute landing between read and write wins.
- R11: running the sweep twice confirms once.
- R12: a player-typed `played` result and a player-typed walkover have `auto_confirm_at = NULL`; a
  staff-typed one does not.
- R12: a scorer who recorded points confirms a live result; a scorer who recorded none, a scorer who
  plays in the match, and any scorer on a typed result are refused.
- R13: one grouped alert per event for owners and managers; a second sweep sends nothing.
- R14: one reminder at half the window; none after a dispute.
- Re-submission recomputes `auto_confirm_at` and clears `reminded_at` / `staff_alerted_at`.

Unit tests: `autoConfirmAt()` arithmetic; new templates render (`templates.test.ts`).

Player app: `ResultPanel` shows the auto-confirm countdown, the typed label and the "confirmed
automatically" state.

---

## 6. Docs to update with the change

- `docs/modules/10-scoring.md`: amend R6, add R11–R14, the schema columns, the `sweep-results` job,
  and the new events payloads.
- `docs/modules/11-notifications.md`: the new and changed templates.
- Player app `docs/modules/11-live-scoring.md`: the panel states.
