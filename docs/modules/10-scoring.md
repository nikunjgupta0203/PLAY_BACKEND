# 10 — scoring

| | |
|---|---|
| **Sprint** | 8 |
| **Phase** | 1 |
| **Depends on** | tournament, sport |
| **Owns** | `match_score_events`, `match_results` |
| **Rule prefix** | `scoring R*` |
| **Risk** | **Concurrency + offline** |

Live score capture on a court-side device, an append-only event log, and result confirmation. The
scoring rules come from the `sport` module — **this module knows how to count, not what counting
means.**

---

## Service interface

```ts
start(actor, matchId)                              => MatchState
recordPoint(actor, { matchId, side, expectedSeq }) => MatchState
recordEvent(actor, { matchId, event, expectedSeq }) => MatchState
undo(actor, { matchId, expectedSeq })              => MatchState
correct(actor, { matchId, games, note })           => MatchState   // manager only
submitResult(actor, { matchId, games, outcome })   => MatchResult
confirmResult(actor, matchId)                      => MatchResult
disputeResult(actor, matchId, reason)              => MatchResult
timeline(matchId)                                  => ScoreEvent[]
stateOf(matchId)                                   => MatchState
```

## GraphQL

```graphql
Mutation.startMatch(matchId: ID!): MatchPayload!
Mutation.recordPoint(input: RecordPointInput!): MatchPayload!
Mutation.undoPoint(input: UndoPointInput!): MatchPayload!
Mutation.submitMatchResult(input: SubmitResultInput!): MatchResultPayload!
Mutation.confirmMatchResult(matchId: ID!): MatchResultPayload!
Mutation.disputeMatchResult(input: DisputeInput!): MatchResultPayload!

input RecordPointInput {
  matchId: ID!
  side: MatchSide!      # A | B
  expectedSeq: Int!     # optimistic concurrency — R1
}

type ScoreState {
  games: [GameScore!]!          # completed games
  current: GameScore!           # the game in progress
  serving: MatchSide!
  matchOver: Boolean!
  seq: Int!
}
```

---

## Rules

**R1** — Every write carries `expectedSeq`. If it does not match `matches.score_seq`, the write is
rejected with `SCORE_STALE` **carrying the server state**, and the caller re-reads. Two scorers on
two devices cannot both write sequence 41.

**R2** — `match_score_events` is **append-only**. An undo is a new event of kind `undo`, never a
delete. The timeline is evidence.

**R3** — Each event stores `state_after` as the **complete** score, not a delta. A client that missed
ten messages is correct on receiving the eleventh.

**R4** — Point validity — when a game ends, whether a hard cap applies, who serves — is decided
entirely by the `ScoringRule` fetched from `sport`. **No sport-specific branch exists in this
module.**

**R5** — Fan-out is never inline. The transaction writes an `outbox` row; a Pusher outage cannot
fail a scorer's tap.

**R6** — A completed match moves to `awaiting_confirm`, not `completed`. It is confirmed by the
opposing side; by a `scorer` who scored it (R12); by an owner or manager 15 minutes after
submission, or at once if disputed; or by itself at `auto_confirm_at` (R11). A disputed result is
settled only by an owner or manager.

**R7** — Correcting an already-confirmed result requires an `owner` or `manager` grant. A volunteer
`scorer` can mis-tap during a match; they must not be able to rewrite a finished one.

**R8** — A correction that changes the winner **reverses the advancement and the rating events**
before applying the new result. Both happen in one transaction under the tournament advisory lock.

**R9** — The scoring device works offline: points queue locally against `expectedSeq` and replay on
reconnect. A conflict surfaces the server state and asks the scorer to confirm — the one place in
this system where a human resolves a merge.

**R10** — Walkovers, retirements and forfeits are submitted as outcomes without a point log, and are
excluded from rating by `rating R7`.

**R11** — An auto-eligible result (R12) confirms itself at
`auto_confirm_at = max(submitted + 15 min, min(submitted + 60 min, event end))`, computed once at
submission. The `sweep-results` job runs every minute and confirms through the same path a person
does; everything is re-checked under the match lock, so a dispute or a person that got there first
wins. An automatic confirmation has `confirmed_by = NULL`, `confirmed_via = 'auto'`.

**R12** — A result records its `source` (`live` from the point log, `typed` by hand) and its
`submitter_role` at submission. Auto-eligible ⇔ live, or submitted by staff. A player-typed result
needs a person to confirm it. A `scorer` on neither side who recorded points in a live result may
confirm it at once.

**R13** — When a waiting, undisputed result passes its 15-minute override point, owners and managers
get one grouped notification per event. Each result is counted once (`staff_alerted_at`).

**R14** — The answering side is reminded once (`reminded_at`): at half the window for an
auto-eligible result, at 30 minutes otherwise. Never for a disputed result.

---

## Point ingest

```ts
export async function recordPoint(actor: Actor, input: RecordPointInput) {
  const match = await assertCanScore(actor, input.matchId);

  return db.$transaction(async (tx) => {
    // Optimistic concurrency. The loser retries against fresh state. (R1)
    if (input.expectedSeq !== match.scoreSeq) throw conflict('SCORE_STALE', match.currentScore);
    const next = match.scoreSeq + 1;

    const rule  = await sport.scoringRuleFor(match.sportId);   // R4
    const state = applyPoint(match.currentScore, input.side, rule);

    await tx.matchScoreEvent.create({ data: {                  // append-only (R2)
      matchId: match.id, seq: next, kind: 'point',
      scoringSide: input.side, stateAfter: state, recordedBy: actor.userId,
    }});
    await tx.match.update({ where: { id: match.id },
      data: { currentScore: state, scoreSeq: next,
              status: state.matchOver ? 'awaiting_confirm' : 'live' }});

    // Never publish inline. (R5)
    await outbox.write(tx, { topic: 'match.score', payload: {
      matchId: match.id, seq: next, state, eventId: match.eventId,
    }});

    return state;
  });
}
```

---

## Realtime contract

Pusher is a **cache-invalidation transport, never a source of truth.**

| Channel | Carries | Subscribers | Volume |
|---|---|---|---|
| `presence-event-{id}` | Match status transitions, standings, bracket advances | Everyone with the event open — hundreds | Low: tens per event |
| `private-match-{id}` | Point-by-point score | Only viewers who opened that match — usually single digits | High: ~50 per match |
| `private-user-{id}` | Registration confirmed, your match is on Court 3, ranking moved | One device set | Low |

**The split is a cost decision.** A 32-entry draw is ~2,300 point events per event day. Delivery is
metered per subscriber: broadcast every point to an event-wide channel with 200 viewers and that is
~460,000 delivered messages in one afternoon. Keeping point detail on `private-match-{id}` keeps the
same day in the low tens of thousands.

Fan-out coalesces per match on a **250 ms** window — only the latest state is sent, and since the
payload is the whole score (R3), nothing is lost. Match-status transitions bypass the window.

```
channel: private-match-9f2c…       event: "score"
{ "seq": 41, "state": { "games": [{"a":11,"b":7}], "current": {"a":4,"b":6},
                        "serving": "b", "matchOver": false },
  "at": "2026-09-05T11:42:08.221Z" }

channel: presence-event-3ab1…      event: "match.status"
{ "matchId": "9f2c…", "status": "live", "court": "Court 3", "seq": 12 }
```

**Client contract:** track the last `seq` per channel; on a gap or a reconnect, refetch `match(id)`
over GraphQL and resume. If Pusher is unreachable, a feature flag drops clients to polling
`match(id)` every five seconds — degraded, not broken.

---

## Schema

```sql
-- Append-only. Never updated, never deleted. This is what makes an undo,
-- a dispute, and a mid-match device failure all recoverable. (R2)
CREATE TABLE match_score_events (
  id            bigserial PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id),
  seq           integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN
                  ('start','point','undo','event')),   -- 'event' added in 026
  scoring_side  text CHECK (scoring_side IN ('a','b')),
  state_after   jsonb NOT NULL,            -- full score, not a delta (R3)
  event         jsonb,                     -- 026: the typed event when kind = 'event'
  recorded_by   uuid NOT NULL REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);

CREATE TABLE match_results (
  match_id      uuid PRIMARY KEY REFERENCES matches(id),
  winner_registration_id uuid NOT NULL REFERENCES registrations(id),
  loser_registration_id  uuid REFERENCES registrations(id),
  games         jsonb NOT NULL,            -- [{a:11,b:7},{a:9,b:11},{a:11,b:5}]
  outcome       text NOT NULL CHECK (outcome IN
                  ('played','walkover','retired','forfeit')),
  submitted_by  uuid NOT NULL REFERENCES users(id),
  confirmed_by  uuid REFERENCES users(id),
  confirmed_at  timestamptz,
  rating_applied boolean NOT NULL DEFAULT false,
  -- 019 — result finality (R11–R14)
  source          text NOT NULL CHECK (source IN ('live','typed')),
  submitter_role  text NOT NULL CHECK (submitter_role IN ('player','staff')),
  auto_confirm_at timestamptz,               -- NULL: a person must confirm (R12)
  confirmed_via   text CHECK (confirmed_via IN ('opponent','staff','auto')),
  reminded_at     timestamptz,               -- R14
  staff_alerted_at timestamptz               -- R13
);
-- confirmed_by is NULL exactly when confirmed_via = 'auto'.
CREATE INDEX match_results_pending_idx ON match_results (submitted_at)
  WHERE confirmed_at IS NULL AND disputed_at IS NULL;
```

---

## Errors

| Code | Channel | Client behaviour |
|---|---|---|
| `SCORE_STALE` | user | Adopt the returned server state, replay the queue |
| `MATCH_NOT_LIVE` | user | Refresh the match |
| `RESULT_ALREADY_CONFIRMED` | user | Show the result |
| `CORRECTION_REQUIRES_MANAGER` | system | Hide the correction control for scorers |

## Emits

| Event | Consumers | Timing |
|---|---|---|
| `match.score` | realtime | Throttled 250 ms |
| `match.live` | realtime, notifications | Immediate |
| `result.submitted` | notifications (carries `autoConfirmAt`) | Immediate |
| `result.confirmed` | tournament, rating, notifications (carries `via`) | Immediate |
| `result.reminder` | notifications — R14 | `sweep-results`, once per result |
| `results.waiting` | notifications — R13, `{ eventId, count }` | `sweep-results`, grouped per event |

## Jobs

| Job | Trigger | Final failure |
|---|---|---|
| `sweep-results` | Every minute (tournament queue) | Alert; the next pass picks up what this one missed |

---

## Done when

- Two devices score the same match and the second is **rejected with the server state** rather than
  overwriting it.
- A device scores five points offline and replays them cleanly on reconnect.
- A spectator on another network sees a point land within **500 ms**.

---

## Implementation checklist

- [x] Migration `016_scoring` — the log is append-only in the database too: a trigger refuses UPDATE
- [x] `applyPoint(state, side, rule)` as a **pure function** (`scoring/engine.ts`), unit-tested
      against the seeded pickleball rule: win-by-2, hard cap at 15, the deciding game to 15, and
      against badminton, a sets rule and a goals rule to prove R4
- [x] Optimistic concurrency on `score_seq` under a row lock, returning server state (R1). Tested
      with two devices racing for one seq
- [x] Append-only writes; undo as an event (R2)
- [x] Outbox fan-out with 250 ms per-match coalescing (R5) — the drain keeps only the newest
      `match.score` per match in each batch (`platform/realtime/matchUpdates.ts`)
- [x] `POST /pusher/auth` — `private-match-{id}` and `presence-event-{id}` open to any signed-in
      user: they carry what the event page already shows. Signed-in is the cost control
- [x] `awaiting_confirm` flow + 15-minute organizer override (R6); a dispute hands the result to an
      owner or manager at once
- [ ] Correction path with grant check and advancement/rating reversal (R7, R8) — **not built**.
      An organizer settles a dispute by re-submitting before confirmation instead
- [x] Offline queue contract documented for the mobile team (R9) — frontend `11-live-scoring`
- [ ] Instrument delivered Pusher messages per event day — check against the plan
- [x] Tests naming R1, R2, R3, R4, R6, R10 (`tests/scoring.test.ts`, `scoring/engine.test.ts`)
- [x] Result finality (R11–R14): migration `019_result_finality`, `finality.ts`, `sweep-results`
      job, witness path — spec `docs/superpowers/specs/2026-09-27-result-finality-design.md`
- [x] Typed score events (plan 2026-09-29-all-sports-scoring-1): actions, periods, extra time, shootout, match tiebreak

**Decisions made while building:**

- **Who may score:** any staff grant on the event, or a player on either side. Amateur draws are
  mostly self-scored, which is why R6 needs the other side to confirm.
- **The last point submits the result.** The log already says who won; asking the scorer to type
  it again only invites a second, different answer. Undoing that point, before anyone confirms,
  takes the result back.
- **`Match.scoringRule { kind, definition }`** carries the rule to the client as the JSON document,
  so the app counts with the same engine and never branches on a sport.
- **Point mutations return the match on failure too.** `UserError` has no room for a score, so
  SCORE_STALE's server state travels in the payload's `match`.

---

## Additions 2026-10-04 (flow review F4, F5, F6, F9, F12, F15)

See `docs/platform-flow-review-2026-10-04.md` (Status) for why; the app side is `PLAY_FRONTEND/docs/modules/23-organizer.md`.

- **F4** — an owner or manager who plays in the match is a player there for **every** organizer power:
  the 15-minute override, settling a dispute by resubmitting, and correcting. A dispute in a match where no
  owner or manager is neutral is escalated (`result.escalated`, reason `no_neutral_organizer`) at once.
- **F5** — a player's own result is auto-confirmed at `max(submitted + 30 min, min(submitted + 2 h, event end
  + 2 h))` unless disputed; staff keep R11's window. Reminders fall half-way, as before.
- **F6** — a player claiming a walkover: the opponent must not have checked in (`WALKOVER_OPPONENT_PRESENT`)
  and the match must be 15 min past its time, else the event start (`WALKOVER_TOO_EARLY`). Neutral staff are
  not held to this.
- **F12, F15** — `eventPendingResults(eventId)`: any staff grant; unconfirmed results, disputes first.
- **F9** — `escalatedResults` and `settleEscalatedResult(matchId, keep, input)` for PL4Y staff (admin,
  support): keep the result or replace it, and confirm as staff.
- The rule a match is scored under is the draw's frozen `scoring_rule` when set (events F22).
