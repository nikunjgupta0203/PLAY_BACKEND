# Result Finality (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every undisputed match result becomes final on its own within about an hour, without an organizer — unless nobody neutral witnessed it.

**Architecture:** `match_results` gains provenance (`source`, `submitter_role`), a precomputed `auto_confirm_at`, how it was confirmed (`confirmed_via`) and two idempotency stamps. A pure `finality.ts` holds the timing arithmetic. `scoring.sweep()` — run every minute by a new repeatable job — auto-confirms due results through the same `confirmIn` path a person uses, and writes outbox rows for reminders and organizer alerts; `notify.ts` turns those into pushes. The player app shows the auto-confirm countdown and provenance.

**Tech Stack:** Node 22, TypeScript, Prisma + Postgres (raw SQL migrations), Pothos GraphQL, BullMQ, Vitest (backend, real Postgres). Expo / React Native, Jest + Testing Library (player app).

**Spec:** `PALY_BACKEND/docs/superpowers/specs/2026-09-27-result-finality-design.md`

**Repos:** Two separate git repos.
- Backend: `C:\Coding\Project\PLAY\PALY_BACKEND` — already on branch `feat/result-finality`. Tasks 1–5, 7.
- Player app: `C:\Coding\Project\PLAY\PLAY_FRONTEND` — on `main`; Task 6 creates `feat/result-finality` there first.

## Global Constraints

- Window: `auto_confirm_at = max(submitted_at + 15 min, min(submitted_at + 60 min, event.ends_at))` for auto-eligible results; `NULL` otherwise.
- Auto-eligible ⇔ `source = 'live'` OR `submitter_role = 'staff'`.
- Reminder once, at half the window (auto-eligible) or at `submitted_at + 30 min` (not eligible). Never for a disputed result.
- Organizer alert: one per event per sweep, to `owner` + `manager` grants, for pending undisputed rows past `submitted_at + 15 min` and not yet past `auto_confirm_at`; each row counted once.
- Witness path: `scorer` role, on neither side, `source = 'live'`, undisputed, ≥ 1 `point` event recorded by them in this match.
- Auto-confirmation writes `confirmed_by = NULL`, `confirmed_via = 'auto'`.
- Status-like columns are `text + CHECK` (conventions.md §2); CHECKs and partial indexes live only in the SQL migration.
- Modules never write another module's tables (conventions.md §1). `scoring` never imports `notify` — it writes outbox rows.
- `rating.changed` is pushed for **settled** changes only (`isProvisional === false`), skipped when `|delta| < 1`.
- Backend test commands run from `PALY_BACKEND` with the test Postgres up (`pnpm db:up`).

## Review Focus

1. **Dispute racing the sweep** — a dispute committed between the sweep's read and its write must win. Pinned in Task 2 (`autoConfirm` re-checks under the lock).
2. **Opponent confirms at the same moment the sweep runs** — exactly one confirmation, one `result.confirmed` row. Pinned in Task 2 (autoConfirm after a manual confirm returns null, no second outbox row).
3. **Re-submission after a dispute** — the organizer's corrected result must get fresh `auto_confirm_at`, cleared reminder/alert stamps, and `source = 'typed'`, `submitter_role = 'staff'`. Pinned in Task 1.
4. **Match submitted after the event's advertised end** — must still give the opponent 15 minutes, never confirm instantly. Pinned in Task 1.
5. **Old notification feed rows** without the new payload fields must still render. Pinned in Task 4 (render with the old payload).

---

## File map

**Backend**
| File | Change |
|---|---|
| `prisma/migrations/20260927120000_019_result_finality/migration.sql` | Create — columns, backfill, CHECKs, partial index |
| `prisma/schema.prisma` | Modify `MatchResult` model |
| `src/modules/scoring/finality.ts` | Create — pure timing rules |
| `src/modules/scoring/finality.test.ts` | Create |
| `src/modules/scoring/repo/index.ts` | Modify — new columns, `confirm` signature, sweep queries, stamps |
| `src/modules/scoring/service/index.ts` | Modify — provenance on submit, `confirmIn`, witness path, `autoConfirm`, `sweep` |
| `src/modules/scoring/index.ts`, `tests/helpers/modules.ts` | Modify — `MatchInfo.eventEndsAt` |
| `src/modules/scoring/schema/index.ts`, `schema.graphql` | Modify — new fields/enums |
| `src/modules/identity/service/index.ts` | Modify — `staffFor(eventId)` |
| `src/modules/notifications/templates.ts` (+ test) | Modify — new/changed templates |
| `src/notify.ts` | Modify — reminder, waiting, auto flag, rating changed |
| `src/worker.ts` | Modify — `sweep-results` job, new topic handlers |
| `tests/scoring.test.ts`, `tests/identity.test.ts` | Modify — new tests |
| `docs/modules/10-scoring.md`, `docs/modules/11-notifications.md` | Modify |

**Player app** (`PLAY_FRONTEND/apps/player`)
| File | Change |
|---|---|
| `src/features/scoring/api.ts` | Modify — select + type new fields |
| `src/features/scoring/components/ResultPanel.tsx` | Modify — countdown, typed label, auto state |
| `src/features/scoring/components/ResultPanel.test.tsx` | Create |
| `src/core/copy.ts` | Modify — strings |
| `docs/modules/11-live-scoring.md` | Modify |

---

### Task 1: Provenance and the auto-confirm deadline

**Files:**
- Create: `prisma/migrations/20260927120000_019_result_finality/migration.sql`
- Modify: `prisma/schema.prisma` (model `MatchResult`, ~line 1007)
- Create: `src/modules/scoring/finality.ts`, `src/modules/scoring/finality.test.ts`
- Modify: `src/modules/scoring/repo/index.ts` (`ResultRow`, `toResult`, `putResult`)
- Modify: `src/modules/scoring/service/index.ts` (`MatchInfo`, `submitIn`, `recordPoint`, `submitResult`)
- Modify: `src/modules/scoring/index.ts` and `tests/helpers/modules.ts` (`matches.byId`)
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Produces:
  - `finality.ts`: `AUTO_CONFIRM_AFTER_MS`, `AUTO_CONFIRM_FLOOR_MS`, `REMINDER_AFTER_MS`, `type ResultSource = 'live' | 'typed'`, `type SubmitterRole = 'player' | 'staff'`, `type ConfirmedVia = 'opponent' | 'staff' | 'auto'`, `isAutoEligible(source, role): boolean`, `autoConfirmAt({ submittedAt, eventEndsAt, eligible }): Date | null`, `reminderDueAt({ submittedAt, autoConfirmAt }): Date`
  - `ResultRow` gains `source`, `submitterRole`, `autoConfirmAt`, `confirmedVia`, `remindedAt`, `staffAlertedAt`
  - `MatchInfo.eventEndsAt: Date`
  - `result.submitted` outbox payload gains `autoConfirmAt: string | null` (ISO)

- [ ] **Step 1: Write the failing unit test for the pure rules**

Create `src/modules/scoring/finality.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { autoConfirmAt, isAutoEligible, reminderDueAt } from './finality.js';

const MIN = 60_000;
const t0 = new Date('2026-10-03T10:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

describe('scoring — finality rules', () => {
  it('scoring R12: live or staff-submitted results are auto-eligible; player-typed are not', () => {
    expect(isAutoEligible('live', 'player')).toBe(true);
    expect(isAutoEligible('typed', 'staff')).toBe(true);
    expect(isAutoEligible('live', 'staff')).toBe(true);
    expect(isAutoEligible('typed', 'player')).toBe(false);
  });

  it('scoring R11: 60 minutes when the event runs on', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(600 * MIN), eligible: true })).toEqual(plus(60 * MIN));
  });

  it('scoring R11: shortened to the event end', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(30 * MIN), eligible: true })).toEqual(plus(30 * MIN));
  });

  it('scoring R11: never shorter than 15 minutes, even after the event ended', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(5 * MIN), eligible: true })).toEqual(plus(15 * MIN));
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(-120 * MIN), eligible: true })).toEqual(plus(15 * MIN));
  });

  it('scoring R11: an ineligible result never auto-confirms', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(600 * MIN), eligible: false })).toBeNull();
  });

  it('scoring R14: the reminder is due at half the window, or at 30 minutes without one', () => {
    expect(reminderDueAt({ submittedAt: t0, autoConfirmAt: plus(60 * MIN) })).toEqual(plus(30 * MIN));
    expect(reminderDueAt({ submittedAt: t0, autoConfirmAt: plus(16 * MIN) })).toEqual(plus(8 * MIN));
    expect(reminderDueAt({ submittedAt: t0, autoConfirmAt: null })).toEqual(plus(30 * MIN));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/modules/scoring/finality.test.ts`
Expected: FAIL — cannot resolve `./finality.js`.

- [ ] **Step 3: Implement `finality.ts`**

Create `src/modules/scoring/finality.ts`:

```ts
/**
 * scoring R11–R14 — when a result becomes final on its own.
 *
 * Pure: no database, no clock. The service computes `auto_confirm_at` once, at
 * submission, from these rules and stores it, so the sweep is a plain indexed
 * comparison and the client can show the same countdown the server will honour.
 */

export type ResultSource = 'live' | 'typed';
export type SubmitterRole = 'player' | 'staff';
export type ConfirmedVia = 'opponent' | 'staff' | 'auto';

/** R11 — how long the other side has, at most. */
export const AUTO_CONFIRM_AFTER_MS = 60 * 60_000;
/** R11 — how long the other side has, at least: the organizer override's own window (R6). */
export const AUTO_CONFIRM_FLOOR_MS = 15 * 60_000;
/** R14 — reminder for a result that will not confirm itself. */
export const REMINDER_AFTER_MS = 30 * 60_000;

/**
 * R12 — somebody neutral saw it: a point log, or the organizer's own staff.
 * A score a player typed has neither, so a person must confirm it.
 */
export function isAutoEligible(source: ResultSource, role: SubmitterRole): boolean {
  return source === 'live' || role === 'staff';
}

/** R11 — max(submitted + 15 min, min(submitted + 60 min, event end)), or null. */
export function autoConfirmAt(input: {
  submittedAt: Date;
  eventEndsAt: Date;
  eligible: boolean;
}): Date | null {
  if (!input.eligible) return null;
  const submitted = input.submittedAt.getTime();
  const capped = Math.min(submitted + AUTO_CONFIRM_AFTER_MS, input.eventEndsAt.getTime());
  return new Date(Math.max(submitted + AUTO_CONFIRM_FLOOR_MS, capped));
}

/** R14 — half the window, so the reminder always leaves time to act on it. */
export function reminderDueAt(input: { submittedAt: Date; autoConfirmAt: Date | null }): Date {
  const submitted = input.submittedAt.getTime();
  if (!input.autoConfirmAt) return new Date(submitted + REMINDER_AFTER_MS);
  return new Date(submitted + (input.autoConfirmAt.getTime() - submitted) / 2);
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm vitest run src/modules/scoring/finality.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the migration**

Create `prisma/migrations/20260927120000_019_result_finality/migration.sql`:

```sql
-- 019 — result finality (docs/superpowers/specs/2026-09-27-result-finality-design.md).
--
-- scoring R11–R14: how a result was entered, when it confirms itself, how it was
-- confirmed, and the stamps that keep the sweep's reminders and alerts once-only.

ALTER TABLE "match_results"
    ADD COLUMN "source" TEXT,
    ADD COLUMN "submitter_role" TEXT,
    ADD COLUMN "auto_confirm_at" TIMESTAMPTZ(6),
    ADD COLUMN "confirmed_via" TEXT,
    ADD COLUMN "reminded_at" TIMESTAMPTZ(6),
    ADD COLUMN "staff_alerted_at" TIMESTAMPTZ(6);

-- Backfill (pre-launch rows only). A played result on a match whose point log
-- ended the match came from the log; anything else was typed. Nobody knows who
-- submitted as what, so every existing row is a player's, and every existing
-- confirmation the opponent's. Existing pending rows keep auto_confirm_at NULL:
-- they stay on the paths they were submitted under.
UPDATE "match_results" r
   SET "source" = CASE
         WHEN r."outcome" = 'played' AND m."current_score"->>'matchOver' = 'true' THEN 'live'
         ELSE 'typed'
       END
  FROM "matches" m
 WHERE m."id" = r."match_id";
UPDATE "match_results" SET "submitter_role" = 'player';
UPDATE "match_results" SET "confirmed_via" = 'opponent' WHERE "confirmed_at" IS NOT NULL;

ALTER TABLE "match_results"
    ALTER COLUMN "source" SET NOT NULL,
    ALTER COLUMN "submitter_role" SET NOT NULL;

ALTER TABLE "match_results" ADD CONSTRAINT "match_results_source_check"
    CHECK ("source" IN ('live', 'typed'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_submitter_role_check"
    CHECK ("submitter_role" IN ('player', 'staff'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_via_check"
    CHECK ("confirmed_via" IS NULL OR "confirmed_via" IN ('opponent', 'staff', 'auto'));
ALTER TABLE "match_results" ADD CONSTRAINT "match_results_confirmed_via_pair_check"
    CHECK (("confirmed_at" IS NULL) = ("confirmed_via" IS NULL));

-- The sweep reads only what is still waiting (R11, R13, R14).
CREATE INDEX "match_results_pending_idx" ON "match_results" ("submitted_at")
    WHERE "confirmed_at" IS NULL AND "disputed_at" IS NULL;
```

- [ ] **Step 6: Update the Prisma model**

In `prisma/schema.prisma`, model `MatchResult`, after the `ratingApplied` line add:

```prisma
  /// live | typed — scoring R12. CHECK in the migration.
  source               String
  /// player | staff, at the moment of submission — scoring R12. CHECK in the migration.
  submitterRole        String    @map("submitter_role")
  /// scoring R11 — null means a person must confirm it.
  autoConfirmAt        DateTime? @map("auto_confirm_at") @db.Timestamptz(6)
  /// opponent | staff | auto — set with confirmed_at. CHECK in the migration.
  confirmedVia         String?   @map("confirmed_via")
  /// scoring R14 — the reminder went out.
  remindedAt           DateTime? @map("reminded_at") @db.Timestamptz(6)
  /// scoring R13 — counted in an organizer alert.
  staffAlertedAt       DateTime? @map("staff_alerted_at") @db.Timestamptz(6)
```

Run: `pnpm db:generate`
Expected: "Generated Prisma Client".

- [ ] **Step 7: Map the columns in the repo**

In `src/modules/scoring/repo/index.ts`:

Add the import at the top:

```ts
import type { ConfirmedVia, ResultSource, SubmitterRole } from '../finality.js';
```

Add to `interface ResultRow` (after `disputeReason`):

```ts
  source: ResultSource;
  submitterRole: SubmitterRole;
  autoConfirmAt: Date | null;
  confirmedVia: ConfirmedVia | null;
  remindedAt: Date | null;
  staffAlertedAt: Date | null;
```

Replace `toResult` with:

```ts
const toResult = (row: {
  matchId: string;
  winnerRegistrationId: string;
  loserRegistrationId: string | null;
  games: Prisma.JsonValue;
  outcome: string;
  submittedBy: string;
  submittedAt: Date;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  disputedBy: string | null;
  disputedAt: Date | null;
  disputeReason: string | null;
  source: string;
  submitterRole: string;
  autoConfirmAt: Date | null;
  confirmedVia: string | null;
  remindedAt: Date | null;
  staffAlertedAt: Date | null;
}): ResultRow => ({
  matchId: row.matchId,
  winnerRegistrationId: row.winnerRegistrationId,
  loserRegistrationId: row.loserRegistrationId,
  games: (row.games ?? []) as unknown as GameScore[],
  outcome: row.outcome as ResultRow['outcome'],
  submittedBy: row.submittedBy,
  submittedAt: row.submittedAt,
  confirmedBy: row.confirmedBy,
  confirmedAt: row.confirmedAt,
  disputedBy: row.disputedBy,
  disputedAt: row.disputedAt,
  disputeReason: row.disputeReason,
  source: row.source as ResultSource,
  submitterRole: row.submitterRole as SubmitterRole,
  autoConfirmAt: row.autoConfirmAt,
  confirmedVia: row.confirmedVia as ConfirmedVia | null,
  remindedAt: row.remindedAt,
  staffAlertedAt: row.staffAlertedAt,
});
```

(Listing fields explicitly also stops `confirmedBetween`'s `include: { match }` leaking into the row.)

Replace `putResult` with:

```ts
  /**
   * A submission replaces an unconfirmed one; a confirmed row is never rewritten here.
   * A re-submission starts the clock again: fresh deadline, no reminder or alert sent (R11, R13, R14).
   */
  async function putResult(
    tx: Tx,
    input: Pick<
      ResultRow,
      | 'matchId'
      | 'winnerRegistrationId'
      | 'loserRegistrationId'
      | 'games'
      | 'outcome'
      | 'submittedBy'
      | 'source'
      | 'submitterRole'
      | 'autoConfirmAt'
    > & { submittedAt: Date },
  ): Promise<ResultRow> {
    const data = {
      winnerRegistrationId: input.winnerRegistrationId,
      loserRegistrationId: input.loserRegistrationId,
      games: input.games as unknown as Prisma.InputJsonValue,
      outcome: input.outcome,
      submittedBy: input.submittedBy,
      submittedAt: input.submittedAt,
      source: input.source,
      submitterRole: input.submitterRole,
      autoConfirmAt: input.autoConfirmAt,
      disputedBy: null,
      disputedAt: null,
      disputeReason: null,
      remindedAt: null,
      staffAlertedAt: null,
    };
    const row = await tx.matchResult.upsert({
      where: { matchId: input.matchId },
      create: { matchId: input.matchId, ...data },
      update: data,
    });
    return toResult(row);
  }
```

Replace `confirm` with (Task 2 relies on this signature; `via` is required by the new CHECK):

```ts
  async function confirm(
    tx: Tx,
    matchId: string,
    userId: string | null,
    via: ConfirmedVia,
    at: Date,
  ): Promise<ResultRow> {
    const row = await tx.matchResult.update({
      where: { matchId },
      data: { confirmedBy: userId, confirmedAt: at, confirmedVia: via },
    });
    return toResult(row);
  }
```

- [ ] **Step 8: Carry the event's end on `MatchInfo`**

In `src/modules/scoring/service/index.ts`, add to `interface MatchInfo` after `status`:

```ts
  /** R11 — the auto-confirm window never runs past the event's end (bar the 15-minute floor). */
  eventEndsAt: Date;
```

In `src/modules/scoring/index.ts`, in `matches.byId`, replace the `const draw = …` line and the return with:

```ts
    const draw = await tournament.byId(match.tournamentId);
    const event = await events.byId(draw.eventId);
    return {
      id: match.id,
      tournamentId: match.tournamentId,
      eventId: draw.eventId,
      eventCategoryId: match.eventCategoryId,
      sportId: match.sportId,
      status: match.status,
      eventEndsAt: event.endsAt,
      sideARegistrationId: match.sideARegistrationId,
      sideBRegistrationId: match.sideBRegistrationId,
    };
```

Make the identical change in `tests/helpers/modules.ts` inside `createScoringService({ matches: { async byId … } })` (~line 750).

- [ ] **Step 9: Write the failing integration tests**

In `tests/scoring.test.ts`, add `let identity: ReturnType<typeof buildModules>['identity'];` with the other `let`s, and `identity = wired.identity;` in `beforeAll`. Then append:

```ts
describe('result finality — provenance and deadline (R11, R12)', () => {
  const window = (r: { submittedAt: Date; autoConfirmAt: Date | null } | null) =>
    r?.autoConfirmAt ? r.autoConfirmAt.getTime() - r.submittedAt.getTime() : null;

  it('scoring R12: a live result by a player confirms itself in 60 minutes', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    const r = await scoring.resultFor(match.id);
    expect(r).toMatchObject({ source: 'live', submitterRole: 'player', confirmedVia: null });
    expect(window(r)).toBe(60 * MINUTE);
  });

  it('scoring R12: a played score typed by a player never confirms itself', async () => {
    const { match, side } = await drawOfFour();
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    expect(await scoring.resultFor(match.id)).toMatchObject({
      source: 'typed',
      submitterRole: 'player',
      autoConfirmAt: null,
    });
  });

  it('scoring R12: a walkover typed by a player never confirms itself; by the organizer it does', async () => {
    const first = await drawOfFour();
    await scoring.submitResult(first.side.a.actor, {
      matchId: first.match.id, outcome: 'walkover', games: [], winner: 'a',
    });
    expect((await scoring.resultFor(first.match.id))?.autoConfirmAt).toBeNull();

    const second = await drawOfFour();
    await scoring.submitResult(organizer.actor, {
      matchId: second.match.id, outcome: 'walkover', games: [], winner: 'a',
    });
    const r = await scoring.resultFor(second.match.id);
    expect(r).toMatchObject({ source: 'typed', submitterRole: 'staff' });
    expect(window(r)).toBe(60 * MINUTE);
  });

  // drawOfFour's event starts in 30 days and ends a day later. Moving the
  // clock, not the event, keeps every events-table CHECK satisfied.
  it('scoring R11: the window is shortened to the event end', async () => {
    const { match, side } = await drawOfFour();
    clock.offsetMs = 31 * DAY - 30 * MINUTE;
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    const w = window(await scoring.resultFor(match.id))!;
    expect(w).toBeGreaterThan(29 * MINUTE);
    expect(w).toBeLessThanOrEqual(30 * MINUTE);
  });

  it('scoring R11: a match finished after the event ended still gets 15 minutes', async () => {
    const { match, side } = await drawOfFour();
    clock.offsetMs = 31 * DAY + 2 * 60 * MINUTE;
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(window(await scoring.resultFor(match.id))).toBe(15 * MINUTE);
  });

  it('a re-submission after a dispute starts the clock again', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await prisma.matchResult.update({
      where: { matchId: match.id },
      data: { remindedAt: new Date(), staffAlertedAt: new Date() },
    });
    await scoring.disputeResult(side.b.actor, match.id, 'Second game was 11–9');
    clock.offsetMs = 5 * MINUTE;
    await scoring.submitResult(organizer.actor, {
      matchId: match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    const r = await scoring.resultFor(match.id);
    expect(r).toMatchObject({
      source: 'typed',
      submitterRole: 'staff',
      remindedAt: null,
      staffAlertedAt: null,
      disputedAt: null,
    });
    expect(window(r)).toBe(60 * MINUTE);
  });
});
```

- [ ] **Step 10: Run them to verify they fail**

Run: `pnpm vitest run tests/scoring.test.ts -t "result finality"`
Expected: FAIL — typecheck/DB errors on `source` (not yet written by `submitIn`; the NOT NULL column rejects the insert).

- [ ] **Step 11: Write provenance at submission**

In `src/modules/scoring/service/index.ts`:

Add the import:

```ts
import { autoConfirmAt, isAutoEligible, type ResultSource } from '../finality.js';
```

(Task 2 adds `type ConfirmedVia` to this import; Task 3 adds `REMINDER_AFTER_MS`.)

Replace `submitIn` with:

```ts
  async function submitIn(
    tx: Tx,
    match: MatchInfo,
    actor: Actor,
    input: { outcome: Outcome; winner: Side; games: GameScore[]; source: ResultSource },
  ): Promise<ResultRow> {
    const winnerId = input.winner === 'a' ? match.sideARegistrationId : match.sideBRegistrationId;
    const loserId = input.winner === 'a' ? match.sideBRegistrationId : match.sideARegistrationId;
    if (!winnerId) throw new UserError(ScoringCode.MATCH_NOT_READY, 'That side is empty.');

    // R12 — the role held at the moment of submission, not whatever it is later.
    const submitterRole = (await deps.roleOn(actor.userId, match.eventId)) ? 'staff' : 'player';
    const submittedAt = now();
    const row = await repo.putResult(tx, {
      matchId: match.id,
      winnerRegistrationId: winnerId,
      loserRegistrationId: loserId,
      games: input.games,
      outcome: input.outcome,
      submittedBy: actor.userId,
      submittedAt,
      source: input.source,
      submitterRole,
      // R11 — computed once, here; the sweep and the client both read it.
      autoConfirmAt: autoConfirmAt({
        submittedAt,
        eventEndsAt: match.eventEndsAt,
        eligible: isAutoEligible(input.source, submitterRole),
      }),
    });
    await matches.markAwaitingConfirm(match.id, tx);
    await outboxWrite(tx, {
      topic: 'result.submitted',
      payload: {
        matchId: match.id,
        eventId: match.eventId,
        outcome: input.outcome,
        submittedBy: actor.userId,
        autoConfirmAt: row.autoConfirmAt?.toISOString() ?? null,
      },
    });
    return row;
  }
```

In `recordPoint`, change the `submitIn` call's input to add `source: 'live'`:

```ts
        await submitIn(tx, match, actor, {
          outcome: 'played',
          winner: state.winner,
          games: state.games,
          source: 'live',
        });
```

In `submitResult`, change its final call to:

```ts
      return submitIn(tx, match, actor, {
        outcome: input.outcome,
        winner,
        games: input.games,
        source: 'typed',
      });
```

In `confirmResult`, change `repo.confirm(tx, matchId, actor.userId, now())` to `repo.confirm(tx, matchId, actor.userId, 'opponent', now())` for now (Task 2 replaces this body).

- [ ] **Step 12: Run the tests to verify they pass**

Run: `pnpm vitest run tests/scoring.test.ts src/modules/scoring`
Expected: PASS — all existing scoring tests and the 6 new ones.

Run: `pnpm typecheck`
Expected: no errors. (If another module builds `MatchInfo` or calls `repo.confirm`, the compiler names it — fix it the same way.)

- [ ] **Step 13: Commit**

```bash
git add prisma/migrations/20260927120000_019_result_finality prisma/schema.prisma \
  src/modules/scoring/finality.ts src/modules/scoring/finality.test.ts \
  src/modules/scoring/repo/index.ts src/modules/scoring/service/index.ts \
  src/modules/scoring/index.ts tests/helpers/modules.ts tests/scoring.test.ts
git commit -m "feat(scoring): record how a result was entered and when it confirms itself

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One confirmation path — opponent, organizer, witness, auto

**Files:**
- Modify: `src/modules/scoring/repo/index.ts` (add `hasRecordedPoints`)
- Modify: `src/modules/scoring/service/index.ts` (`confirmIn`, `isWitness`, `resultAccess`, `confirmResult`, `autoConfirm`)
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Consumes: `repo.confirm(tx, matchId, userId | null, via, at)`, `ResultRow.source/autoConfirmAt`, `ConfirmedVia` (Task 1)
- Produces:
  - `scoring.autoConfirm(matchId: string): Promise<ResultRow | null>` — null when nothing was due
  - `result.confirmed` outbox payload gains `via: ConfirmedVia`
  - `repo.hasRecordedPoints(client: Db | Tx, matchId: string, userId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/scoring.test.ts`:

```ts
describe('result finality — who confirms (R6, R11, R12)', () => {
  it('scoring R6: the opponent’s confirmation is recorded as such', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await scoring.confirmResult(side.b.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'opponent' });
    const [row] = await prisma.outbox.findMany({ where: { topic: 'result.confirmed' } });
    expect(row?.payload).toMatchObject({ via: 'opponent' });
  });

  it('scoring R6: the organizer override is recorded as staff', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    clock.offsetMs = 16 * MINUTE;
    await scoring.confirmResult(organizer.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'staff' });
  });

  it('scoring R12: a scorer who scored the match confirms it at once', async () => {
    const { eventId, match } = await drawOfFour();
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(volunteer.actor, match.id);
    await tap(volunteer, match.id, 'a'.repeat(22));

    const r = (await scoring.resultFor(match.id))!;
    const info = (await scoring.matchInfo(match.id))!;
    expect((await scoring.resultAccess(volunteer.actor, info, r)).canConfirm).toBe(true);
    await scoring.confirmResult(volunteer.actor, match.id);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'staff' });
    expect((await tournament.matchById(match.id)).status).toBe('completed');
  });

  it('scoring R12: a scorer who recorded no points may not confirm', async () => {
    const { eventId, match, side } = await drawOfFour();
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(await errorCode(() => scoring.confirmResult(volunteer.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R12: a scorer who plays in the match is not a witness', async () => {
    const { eventId, match, side } = await drawOfFour();
    await identity.addStaff(eventId, side.a.userId, 'scorer');
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    expect(await errorCode(() => scoring.confirmResult(side.a.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R12: a scorer cannot confirm a typed result, even one they started scoring', async () => {
    const { eventId, match, side } = await drawOfFour();
    const volunteer = await makePlayer('Volunteer');
    await identity.addStaff(eventId, volunteer.userId, 'scorer');
    await scoring.start(volunteer.actor, match.id);
    await tap(volunteer, match.id, 'aaa');
    await scoring.submitResult(side.a.actor, {
      matchId: match.id,
      outcome: 'retired',
      games: [{ a: 3, b: 0 }],
      winner: 'a',
    });
    expect(await errorCode(() => scoring.confirmResult(volunteer.actor, match.id))).toBe('FORBIDDEN');
  });

  it('scoring R11: autoConfirm does nothing before the deadline and confirms after it', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));

    clock.offsetMs = 59 * MINUTE;
    expect(await scoring.autoConfirm(match.id)).toBeNull();

    clock.offsetMs = 60 * MINUTE + 1000;
    const confirmed = await scoring.autoConfirm(match.id);
    expect(confirmed).toMatchObject({ confirmedVia: 'auto', confirmedBy: null });
    expect((await tournament.matchById(match.id)).status).toBe('completed');
    const rows = await prisma.outbox.findMany({ where: { topic: 'result.confirmed' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ via: 'auto' });
  });

  it('scoring R11: a disputed result is never auto-confirmed', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    await scoring.disputeResult(side.b.actor, match.id, 'Wrong score');
    clock.offsetMs = 3 * 60 * MINUTE;
    expect(await scoring.autoConfirm(match.id)).toBeNull();
    expect((await scoring.resultFor(match.id))?.confirmedAt).toBeNull();
  });

  it('scoring R11: a person who confirmed first wins; the sweep adds nothing', async () => {
    const { match, side } = await drawOfFour();
    await scoring.start(side.a.actor, match.id);
    await tap(side.a, match.id, 'a'.repeat(22));
    clock.offsetMs = 61 * MINUTE;
    await scoring.confirmResult(side.b.actor, match.id);
    expect(await scoring.autoConfirm(match.id)).toBeNull();
    expect(await prisma.outbox.count({ where: { topic: 'result.confirmed' } })).toBe(1);
    expect(await scoring.resultFor(match.id)).toMatchObject({ confirmedVia: 'opponent' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/scoring.test.ts -t "who confirms"`
Expected: FAIL — `scoring.autoConfirm is not a function`; the witness test gets FORBIDDEN; `via` missing from the outbox payload.

- [ ] **Step 3: Add `hasRecordedPoints` to the repo**

In `src/modules/scoring/repo/index.ts`, add inside `createScoringRepo` and to its returned object:

```ts
  /** R12 — the witness test: did this user tap points into this match's log? */
  async function hasRecordedPoints(client: Db | Tx, matchId: string, userId: string): Promise<boolean> {
    const count = await client.matchScoreEvent.count({
      where: { matchId, recordedBy: userId, kind: 'point' },
    });
    return count > 0;
  }
```

- [ ] **Step 4: Replace the confirmation logic in the service**

In `src/modules/scoring/service/index.ts`, replace `resultAccess` and `confirmResult` with the following, and add `autoConfirm` to the returned object:

```ts
  /**
   * R12 — the volunteer who watched it: a scorer, on neither side, who tapped
   * points into this match's own log. A typed result has no such witness.
   */
  async function isWitness(
    client: Db | Tx,
    match: MatchInfo,
    result: ResultRow,
    who: Access,
    userId: string,
  ): Promise<boolean> {
    return (
      who.role === 'scorer' &&
      who.side === null &&
      result.source === 'live' &&
      result.disputedAt === null &&
      (await repo.hasRecordedPoints(client, match.id, userId))
    );
  }

  /**
   * What the viewer may do with a pending result. Read by the client to decide
   * which buttons exist, and re-checked by `confirmResult` itself.
   */
  async function resultAccess(
    actor: Actor | null,
    match: MatchInfo,
    result: ResultRow,
  ): Promise<{ canConfirm: boolean; canDispute: boolean }> {
    if (!actor || result.confirmedAt) return { canConfirm: false, canDispute: false };
    const who = await accessFor(actor, match);
    const answering = await mayAnswer(match, result, who);
    const manager = who.role === 'owner' || who.role === 'manager';
    const overrideOpen = result.disputedAt !== null || now() >= overrideOpensAt(result);
    const witness = await isWitness(db, match, result, who, actor.userId);
    return {
      canConfirm: (answering && result.disputedAt === null) || (manager && overrideOpen) || witness,
      canDispute: answering && result.disputedAt === null,
    };
  }

  /**
   * The one way a result becomes final, whoever asked for it: advance the
   * bracket in the same transaction and tell rating (rating R3).
   */
  async function confirmIn(
    tx: Tx,
    match: MatchInfo,
    by: string | null,
    via: ConfirmedVia,
  ): Promise<ResultRow> {
    const confirmed = await repo.confirm(tx, match.id, by, via, now());
    await matches.advance(
      match.id,
      {
        winnerRegistrationId: confirmed.winnerRegistrationId,
        loserRegistrationId: confirmed.loserRegistrationId,
        outcome: confirmed.outcome,
      },
      tx,
    );
    await outboxWrite(tx, {
      topic: 'result.confirmed',
      payload: { matchId: match.id, eventId: match.eventId, outcome: confirmed.outcome, via },
    });
    return confirmed;
  }

  /**
   * R6, R12 — the opposing side confirms; a scorer who scored it may confirm at
   * once; an owner or manager may confirm 15 minutes after submission, or at
   * once when the result is disputed.
   */
  async function confirmResult(actor: Actor, matchId: string): Promise<ResultRow> {
    const match = await matchOrThrow(matchId);
    const who = await accessFor(actor, match);

    return db.$transaction(async (tx) => {
      const head = await repo.lockHead(tx, matchId);
      if (!head) throw notFound();
      const result = await repo.result(tx, matchId);
      if (!result) {
        throw new UserError(ScoringCode.RESULT_NOT_SUBMITTED, 'No result has been submitted yet.');
      }
      if (result.confirmedAt) {
        throw new UserError(ScoringCode.RESULT_ALREADY_CONFIRMED, 'This result is already confirmed.');
      }

      const answering = await mayAnswer(match, result, who);
      if (answering && result.disputedAt === null) return confirmIn(tx, match, actor.userId, 'opponent');
      if (await isWitness(tx, match, result, who, actor.userId)) {
        return confirmIn(tx, match, actor.userId, 'staff');
      }

      const manager = who.role === 'owner' || who.role === 'manager';
      if (!manager) {
        if (result.disputedAt !== null && answering) {
          throw new UserError(
            ScoringCode.RESULT_DISPUTED,
            'This result is disputed. The organizer will settle it.',
          );
        }
        throw forbidden();
      }
      const opensAt = overrideOpensAt(result);
      if (result.disputedAt === null && now() < opensAt) {
        throw new UserError(
          ScoringCode.OVERRIDE_TOO_EARLY,
          'The other side has 15 minutes to confirm before an organizer can.',
          { retryAfterSeconds: Math.ceil((opensAt.getTime() - now().getTime()) / 1000) },
        );
      }
      return confirmIn(tx, match, actor.userId, 'staff');
    });
  }

  /**
   * R11 — the sweep's confirmation. Everything is re-checked under the match
   * lock: a dispute or a person's confirmation that landed first wins, and the
   * sweep does nothing.
   */
  async function autoConfirm(matchId: string): Promise<ResultRow | null> {
    const match = await matchOrThrow(matchId);
    return db.$transaction(async (tx) => {
      await repo.lockHead(tx, matchId);
      const result = await repo.result(tx, matchId);
      if (
        !result ||
        result.confirmedAt ||
        result.disputedAt ||
        !result.autoConfirmAt ||
        result.autoConfirmAt > now()
      ) {
        return null;
      }
      return confirmIn(tx, match, null, 'auto');
    });
  }
```

Add `type ConfirmedVia` to the `../finality.js` import. `Db` is already imported as a type at the top (`import type { Db, Tx } from '../../../platform/db.js';`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/scoring.test.ts`
Expected: PASS — every scoring test, old and new.

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/scoring tests/scoring.test.ts
git commit -m "feat(scoring): scorer witness confirmation and auto-confirmation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The sweep — confirm, alert the organizer, remind the opponent

**Files:**
- Modify: `src/modules/scoring/repo/index.ts` (sweep queries, stamps)
- Modify: `src/modules/scoring/service/index.ts` (`sweep`)
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Consumes: `scoring.autoConfirm` (Task 2), `OVERRIDE_AFTER_MS` (existing), `REMINDER_AFTER_MS` (Task 1)
- Produces:
  - `scoring.sweep(): Promise<SweepReport>` where `interface SweepReport { confirmed: number; alerts: number; reminders: number; failed: { matchId: string; error: string }[] }`
  - Outbox topic `results.waiting`, payload `{ eventId: string; count: number }`
  - Outbox topic `result.reminder`, payload `{ matchId: string; eventId: string; submittedBy: string; autoConfirmAt: string | null }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/scoring.test.ts`:

```ts
describe('result finality — the sweep (R11, R13, R14)', () => {
  const outbox = (topic: string) => prisma.outbox.findMany({ where: { topic } });

  async function liveResult() {
    const draw = await drawOfFour();
    await scoring.start(draw.side.a.actor, draw.match.id);
    await tap(draw.side.a, draw.match.id, 'a'.repeat(22));
    return draw;
  }

  it('scoring R11: confirms what is due, once', async () => {
    const { match } = await liveResult();
    clock.offsetMs = 30 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(0);

    clock.offsetMs = 61 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(1);
    expect((await tournament.matchById(match.id)).status).toBe('completed');
    expect((await scoring.sweep()).confirmed).toBe(0);
    expect(await outbox('result.confirmed')).toHaveLength(1);
  });

  it('scoring R11: never confirms a disputed or a player-typed result', async () => {
    const disputed = await liveResult();
    await scoring.disputeResult(disputed.side.b.actor, disputed.match.id, 'Wrong score');

    const typed = await drawOfFour();
    await scoring.submitResult(typed.side.a.actor, {
      matchId: typed.match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });

    clock.offsetMs = 5 * 60 * MINUTE;
    expect((await scoring.sweep()).confirmed).toBe(0);
    expect((await scoring.resultFor(disputed.match.id))?.confirmedAt).toBeNull();
    expect((await scoring.resultFor(typed.match.id))?.confirmedAt).toBeNull();
  });

  it('scoring R13: one alert per event once the override opens, each result counted once', async () => {
    const { eventId, match, players } = await liveResult();
    const other = (await tournament.matchesFor(match.tournamentId)).find(
      (m) => m.bracket === 'championship' && m.round === 1 && m.id !== match.id,
    )!;
    const otherA = players.get(other.sideARegistrationId!)!;
    await scoring.start(otherA.actor, other.id);
    await tap(otherA, other.id, 'a'.repeat(22));

    clock.offsetMs = 10 * MINUTE;
    expect((await scoring.sweep()).alerts).toBe(0);

    clock.offsetMs = 16 * MINUTE;
    expect((await scoring.sweep()).alerts).toBe(1);
    const alerts = await outbox('results.waiting');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toEqual({ eventId, count: 2 });

    clock.offsetMs = 20 * MINUTE;
    expect((await scoring.sweep()).alerts).toBe(0);
  });

  it('scoring R14: the opponent is reminded once, at half the window', async () => {
    const { match } = await liveResult();
    clock.offsetMs = 29 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(0);

    clock.offsetMs = 31 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(1);
    const [row] = await outbox('result.reminder');
    expect(row?.payload).toMatchObject({ matchId: match.id });
    expect(typeof (row?.payload as { autoConfirmAt: unknown }).autoConfirmAt).toBe('string');

    clock.offsetMs = 40 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(0);
  });

  it('scoring R14: a result that cannot confirm itself is reminded at 30 minutes; a disputed one never', async () => {
    const typed = await drawOfFour();
    await scoring.submitResult(typed.side.a.actor, {
      matchId: typed.match.id,
      outcome: 'played',
      games: [{ a: 11, b: 0 }, { a: 11, b: 9 }],
    });
    const disputed = await liveResult();
    await scoring.disputeResult(disputed.side.b.actor, disputed.match.id, 'Wrong score');

    clock.offsetMs = 31 * MINUTE;
    expect((await scoring.sweep()).reminders).toBe(1);
    const [row] = await outbox('result.reminder');
    expect(row?.payload).toMatchObject({ matchId: typed.match.id, autoConfirmAt: null });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/scoring.test.ts -t "the sweep"`
Expected: FAIL — `scoring.sweep is not a function`.

- [ ] **Step 3: Add the sweep queries and stamps to the repo**

In `src/modules/scoring/repo/index.ts`, add inside `createScoringRepo` and to its returned object:

```ts
  // --- the sweep (R11, R13, R14). All three read only rows still waiting,
  // which is exactly what match_results_pending_idx covers. ------------------

  async function dueForAutoConfirm(at: Date): Promise<string[]> {
    const rows = await db.$queryRaw<{ match_id: string }[]>`
      SELECT match_id
        FROM match_results
       WHERE confirmed_at IS NULL AND disputed_at IS NULL
         AND auto_confirm_at <= ${at}
       ORDER BY auto_confirm_at
       LIMIT 200
    `;
    return rows.map((r) => r.match_id);
  }

  /** R13 — past the override point, not yet counted, and not about to confirm itself this pass. */
  async function dueForStaffAlert(
    at: Date,
    overrideAfterMs: number,
  ): Promise<{ matchId: string; eventId: string }[]> {
    const cutoff = new Date(at.getTime() - overrideAfterMs);
    const rows = await db.$queryRaw<{ match_id: string; event_id: string }[]>`
      SELECT r.match_id, t.event_id
        FROM match_results r
        JOIN matches m ON m.id = r.match_id
        JOIN tournaments t ON t.id = m.tournament_id
       WHERE r.confirmed_at IS NULL AND r.disputed_at IS NULL
         AND r.staff_alerted_at IS NULL
         AND r.submitted_at <= ${cutoff}
         AND (r.auto_confirm_at IS NULL OR r.auto_confirm_at > ${at})
    `;
    return rows.map((r) => ({ matchId: r.match_id, eventId: r.event_id }));
  }

  /** R14 — half the window, or a fixed delay for a result with no window. */
  async function dueForReminder(
    at: Date,
    reminderAfterMs: number,
  ): Promise<{ matchId: string; eventId: string; submittedBy: string; autoConfirmAt: Date | null }[]> {
    const fixedCutoff = new Date(at.getTime() - reminderAfterMs);
    const rows = await db.$queryRaw<
      { match_id: string; event_id: string; submitted_by: string; auto_confirm_at: Date | null }[]
    >`
      SELECT r.match_id, t.event_id, r.submitted_by, r.auto_confirm_at
        FROM match_results r
        JOIN matches m ON m.id = r.match_id
        JOIN tournaments t ON t.id = m.tournament_id
       WHERE r.confirmed_at IS NULL AND r.disputed_at IS NULL
         AND r.reminded_at IS NULL
         AND (
               (r.auto_confirm_at IS NULL AND r.submitted_at <= ${fixedCutoff})
            OR (r.auto_confirm_at IS NOT NULL
                AND r.submitted_at + (r.auto_confirm_at - r.submitted_at) / 2 <= ${at})
         )
    `;
    return rows.map((r) => ({
      matchId: r.match_id,
      eventId: r.event_id,
      submittedBy: r.submitted_by,
      autoConfirmAt: r.auto_confirm_at,
    }));
  }

  /** Stamps only rows still waiting and not yet stamped; returns how many it stamped. */
  async function markStaffAlerted(tx: Tx, matchIds: string[], at: Date): Promise<number> {
    const { count } = await tx.matchResult.updateMany({
      where: { matchId: { in: matchIds }, staffAlertedAt: null, confirmedAt: null, disputedAt: null },
      data: { staffAlertedAt: at },
    });
    return count;
  }

  async function markReminded(tx: Tx, matchId: string, at: Date): Promise<boolean> {
    const { count } = await tx.matchResult.updateMany({
      where: { matchId, remindedAt: null, confirmedAt: null, disputedAt: null },
      data: { remindedAt: at },
    });
    return count === 1;
  }
```

- [ ] **Step 4: Add `sweep` to the service**

In `src/modules/scoring/service/index.ts`, add `REMINDER_AFTER_MS` to the `../finality.js` import, add this near the other exported types:

```ts
export interface SweepReport {
  confirmed: number;
  alerts: number;
  reminders: number;
  /** One match's failure never stops the pass; the worker logs these. */
  failed: { matchId: string; error: string }[];
}
```

and inside `createScoringService` (add `sweep` to the returned object):

```ts
  /**
   * R11, R13, R14 — one pass, run every minute by the worker. Confirmations go
   * first, so a result that is due is confirmed rather than reminded about.
   * Every step is safe to repeat: the stamps and the post-lock re-check make a
   * second pass a no-op.
   */
  async function sweep(): Promise<SweepReport> {
    const at = now();
    const report: SweepReport = { confirmed: 0, alerts: 0, reminders: 0, failed: [] };

    for (const matchId of await repo.dueForAutoConfirm(at)) {
      try {
        if (await autoConfirm(matchId)) report.confirmed += 1;
      } catch (err) {
        report.failed.push({ matchId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const byEvent = new Map<string, string[]>();
    for (const row of await repo.dueForStaffAlert(at, OVERRIDE_AFTER_MS)) {
      byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row.matchId]);
    }
    for (const [eventId, matchIds] of byEvent) {
      const sent = await db.$transaction(async (tx) => {
        const count = await repo.markStaffAlerted(tx, matchIds, at);
        if (count === 0) return false;
        await outboxWrite(tx, { topic: 'results.waiting', payload: { eventId, count } });
        return true;
      });
      if (sent) report.alerts += 1;
    }

    for (const row of await repo.dueForReminder(at, REMINDER_AFTER_MS)) {
      const sent = await db.$transaction(async (tx) => {
        if (!(await repo.markReminded(tx, row.matchId, at))) return false;
        await outboxWrite(tx, {
          topic: 'result.reminder',
          payload: {
            matchId: row.matchId,
            eventId: row.eventId,
            submittedBy: row.submittedBy,
            autoConfirmAt: row.autoConfirmAt?.toISOString() ?? null,
          },
        });
        return true;
      });
      if (sent) report.reminders += 1;
    }

    return report;
  }
```

Export the type from `src/modules/scoring/index.ts` by adding `SweepReport` to the `export type { … } from './service/index.js'` list.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/scoring.test.ts`
Expected: PASS.

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/scoring tests/scoring.test.ts
git commit -m "feat(scoring): minute sweep for auto-confirmation, organizer alerts and reminders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Notifications and the worker

**Files:**
- Modify: `src/modules/identity/service/index.ts` (add `staffFor`, export it in the returned object ~line 730)
- Modify: `src/modules/notifications/templates.ts`, `src/modules/notifications/templates.test.ts`
- Modify: `src/notify.ts`
- Modify: `src/worker.ts`
- Test: `tests/identity.test.ts`, `src/modules/notifications/templates.test.ts`

**Interfaces:**
- Consumes: outbox topics `result.submitted` (`autoConfirmAt`), `result.confirmed` (`via`), `result.reminder`, `results.waiting` (Tasks 1–3); `rating.changed` (existing: `playerId, sportId, ratingBefore, ratingAfter, isProvisional`); `scoring.sweep()` (Task 3)
- Produces: `identity.staffFor(eventId: string): Promise<Grant[]>`; templates `match.result_reminder`, `match.results_waiting`, `rating.changed`; changed payloads for `match.result_pending` and `match.result`

- [ ] **Step 1: Write the failing tests**

In `tests/identity.test.ts`, inside the `describe` that holds the R10 grants test, add:

```ts
  it('staffFor: every user with a grant on the event, once, at their highest role', async () => {
    await signUp('owner@example.com');
    const owner = await prisma.user.findFirstOrThrow({ where: { email: 'owner@example.com' } });
    const eventId = await eventOwnedBy(owner.id);
    await signUp('helper@example.com');
    const helper = await prisma.user.findFirstOrThrow({ where: { email: 'helper@example.com' } });

    await identity.addStaff(eventId, owner.id, 'owner');
    await identity.addStaff(eventId, helper.id, 'scorer');
    await prisma.eventStaff.create({
      data: { eventId, userId: helper.id, role: 'manager', source: 'organizer' },
    });

    const staff = await identity.staffFor(eventId);
    expect(staff.map((g) => [g.userId, g.role]).sort()).toEqual(
      [[owner.id, 'owner'], [helper.id, 'manager']].sort(),
    );
  });
```

(If `eventOwnedBy` already grants the owner a row, the `addStaff(…'owner')` is harmless — it upserts the direct row.)

In `src/modules/notifications/templates.test.ts`, append inside the `describe`:

```ts
  it('scoring R11: the confirm request says when it confirms itself, and old rows still render', () => {
    expect(render('match.result_pending', { eventTitle: 'Open', autoConfirmMinutes: 60 })?.body).toBe(
      'Open. The other side entered a score — confirm or dispute it. It confirms automatically in 60 minutes.',
    );
    expect(render('match.result_pending', { eventTitle: 'Open', autoConfirmMinutes: null })?.body).toBe(
      'Open. The other side entered a score — check it and confirm.',
    );
    // A feed row written before this change has no autoConfirmMinutes.
    expect(render('match.result_pending', { eventTitle: 'Open' })?.body).toBe(
      'Open. The other side entered a score — check it and confirm.',
    );
  });

  it('scoring R14: the reminder', () => {
    expect(render('match.result_reminder', { eventTitle: 'Open', autoConfirmMinutes: 30 })).toEqual({
      title: 'Your result is waiting',
      body: 'Open. Confirm or dispute — it confirms automatically in 30 minutes.',
    });
    expect(render('match.result_reminder', { eventTitle: 'Open', autoConfirmMinutes: null })?.body).toBe(
      'Open. Confirm or dispute your result.',
    );
  });

  it('scoring R13: the organizer alert counts results', () => {
    expect(render('match.results_waiting', { eventTitle: 'Open', count: 1 })?.title).toBe('1 result is waiting');
    expect(render('match.results_waiting', { eventTitle: 'Open', count: 3 })).toEqual({
      title: '3 results are waiting',
      body: 'Open. Nobody has confirmed them yet — you can confirm them now.',
    });
  });

  it('a result confirmed automatically says so; an old row without the flag does not', () => {
    expect(render('match.result', { eventTitle: 'Open', won: true, auto: true })?.body).toBe(
      'Open. On to the next round. Confirmed automatically.',
    );
    expect(render('match.result', { eventTitle: 'Open', won: false })?.body).toBe('Open. Good game.');
  });

  it('a settled rating change', () => {
    expect(render('rating.changed', { sportName: 'Pickleball', rating: 1612.4, delta: 23.6 })).toEqual({
      title: 'Rating up 24 in Pickleball',
      body: 'Your PL4Y rating is now 1612.',
    });
    expect(render('rating.changed', { sportName: 'Pickleball', rating: 1480, delta: -12.2 })?.title).toBe(
      'Rating down 12 in Pickleball',
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run tests/identity.test.ts -t staffFor src/modules/notifications/templates.test.ts`
Expected: FAIL — `identity.staffFor is not a function`; `render` returns null for the new keys; the `match.result_pending` body differs.

- [ ] **Step 3: Add `staffFor` to identity**

In `src/modules/identity/service/index.ts`, after `grantsForUser`:

```ts
  /** Everyone with a grant on the event, once each, at their highest role (R16). */
  async function staffFor(eventId: string): Promise<Grant[]> {
    const rows = await db.eventStaff.findMany({ where: { eventId } });
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    return [...byUser.values()].map((userRows) => {
      const best = highestGrant(userRows)!;
      return { eventId: best.eventId, userId: best.userId, role: best.role as StaffRole };
    });
  }
```

Add `staffFor,` to the returned object next to `grantsForUser`.

- [ ] **Step 4: Update the templates**

In `src/modules/notifications/templates.ts`, in `TemplatePayloads` replace the `match.result_pending`, `match.result` and `ranking.changed` lines' neighbourhood so these entries read:

```ts
  /** The other side is asked to confirm (scoring R6). Null minutes: a person must confirm (R12). */
  'match.result_pending': { eventTitle: string; autoConfirmMinutes?: number | null };
  /** scoring R14 — sent once, half-way through the window. */
  'match.result_reminder': { eventTitle: string; autoConfirmMinutes: number | null };
  /** scoring R13 — to owners and managers, once per result. */
  'match.results_waiting': { eventTitle: string; count: number };
  'match.result': { eventTitle: string; won: boolean; auto?: boolean };
  /** Settled ratings only (rating R2). */
  'rating.changed': { sportName: string; rating: number; delta: number };
```

(`autoConfirmMinutes` and `auto` are optional so feed rows written before this change still type-check and render.)

In `TEMPLATES`, replace `match.result_pending` and `match.result` and add the three new entries:

```ts
  'match.result_pending': {
    render: (p) => ({
      title: 'Confirm your result',
      body: p.autoConfirmMinutes
        ? `${p.eventTitle}. The other side entered a score — confirm or dispute it. It confirms automatically in ${p.autoConfirmMinutes} minutes.`
        : `${p.eventTitle}. The other side entered a score — check it and confirm.`,
    }),
  },
  'match.result_reminder': {
    render: (p) => ({
      title: 'Your result is waiting',
      body: p.autoConfirmMinutes
        ? `${p.eventTitle}. Confirm or dispute — it confirms automatically in ${p.autoConfirmMinutes} minutes.`
        : `${p.eventTitle}. Confirm or dispute your result.`,
    }),
  },
  'match.results_waiting': {
    render: (p) => ({
      title: p.count === 1 ? '1 result is waiting' : `${p.count} results are waiting`,
      body: `${p.eventTitle}. Nobody has confirmed them yet — you can confirm them now.`,
    }),
  },
  'match.result': {
    render: (p) => ({
      title: p.won ? 'You won' : 'Result confirmed',
      body:
        (p.won ? `${p.eventTitle}. On to the next round.` : `${p.eventTitle}. Good game.`) +
        (p.auto ? ' Confirmed automatically.' : ''),
    }),
  },
  'rating.changed': {
    render: (p) => ({
      title:
        p.delta > 0
          ? `Rating up ${Math.round(p.delta)} in ${p.sportName}`
          : `Rating down ${Math.round(-p.delta)} in ${p.sportName}`,
      body: `Your PL4Y rating is now ${Math.round(p.rating)}.`,
    }),
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/identity.test.ts src/modules/notifications`
Expected: PASS (including the existing "only a match starting soon overrides quiet hours" test — none of the new templates set `overridesQuietHours`).

- [ ] **Step 6: Route the new topics in `notify.ts`**

In `src/notify.ts`, add the import:

```ts
import { identity } from './modules/identity/index.js';
```

Add a helper under `entryContext`:

```ts
/** Minutes until an ISO instant, never below 1; null when there is none. */
function minutesUntil(iso: unknown): number | null {
  const at = str(iso);
  if (!at) return null;
  return Math.max(1, Math.round((Date.parse(at) - Date.now()) / 60_000));
}

/** scoring R6 — who answers a result: the side that did not submit it, or both if staff did. */
async function answeringSide(
  match: { sideARegistrationId: string; sideBRegistrationId: string },
  submittedBy: string,
): Promise<string[]> {
  const [a, b] = await Promise.all([
    membersOf(match.sideARegistrationId),
    membersOf(match.sideBRegistrationId),
  ]);
  return a.includes(submittedBy) ? b : b.includes(submittedBy) ? a : [...a, ...b];
}
```

Replace `resultSubmitted` and `resultConfirmed`, and add `resultReminder`, `resultsWaiting`, `ratingChanged` to the `notify` object:

```ts
  /** scoring R6, R11 — the side that did NOT submit is asked to confirm, and told when it confirms itself. */
  async resultSubmitted(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    const submittedBy = str(payload['submittedBy']);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId || !submittedBy) return;
    const recipients = await answeringSide(
      { sideARegistrationId: match.sideARegistrationId, sideBRegistrationId: match.sideBRegistrationId },
      submittedBy,
    );
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    await notifications.emitBulk(
      recipients,
      'match.result_pending',
      { eventTitle: event.title, autoConfirmMinutes: minutesUntil(payload['autoConfirmAt']) },
      { kind: 'match', id: match.id },
    );
  },

  /** scoring R14 — once, half-way through the window. */
  async resultReminder(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    const submittedBy = str(payload['submittedBy']);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId || !submittedBy) return;
    if (match.status !== 'awaiting_confirm') return;
    const recipients = await answeringSide(
      { sideARegistrationId: match.sideARegistrationId, sideBRegistrationId: match.sideBRegistrationId },
      submittedBy,
    );
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    await notifications.emitBulk(
      recipients,
      'match.result_reminder',
      { eventTitle: event.title, autoConfirmMinutes: minutesUntil(payload['autoConfirmAt']) },
      { kind: 'match', id: match.id },
    );
  },

  /** scoring R13 — owners and managers, one message per event per sweep. */
  async resultsWaiting(payload: Record<string, unknown>): Promise<void> {
    const eventId = str(payload['eventId']);
    const count = Number(payload['count'] ?? 0);
    if (!eventId || !Number.isFinite(count) || count < 1) return;
    const event = await events.byId(eventId);
    const recipients = (await identity.staffFor(eventId))
      .filter((g) => g.role === 'owner' || g.role === 'manager')
      .map((g) => g.userId);
    if (recipients.length === 0) return;
    await notifications.emitBulk(
      recipients,
      'match.results_waiting',
      { eventTitle: event.title, count },
      { kind: 'event', id: event.id, slug: event.slug },
    );
  },

  async resultConfirmed(payload: Record<string, unknown>): Promise<void> {
    const match = await tournament.matchById(str(payload['matchId']) ?? '').catch(() => null);
    if (!match?.sideARegistrationId || !match.sideBRegistrationId) return;
    const event = await events.byId((await tournament.byId(match.tournamentId)).eventId);
    const auto = payload['via'] === 'auto';
    for (const side of [match.sideARegistrationId, match.sideBRegistrationId]) {
      await notifications.emitBulk(
        await membersOf(side),
        'match.result',
        { eventTitle: event.title, won: match.winnerRegistrationId === side, auto },
        { kind: 'match', id: match.id },
      );
    }
  },

  /** rating R2 — the settled number only; the provisional one already arrives with the result. */
  async ratingChanged(payload: Record<string, unknown>): Promise<void> {
    if (payload['isProvisional'] !== false) return;
    const before = Number(payload['ratingBefore']);
    const after = Number(payload['ratingAfter']);
    const delta = after - before;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;
    const player = await profile.findById(str(payload['playerId']) ?? '');
    const sportId = str(payload['sportId']);
    if (!player || !sportId) return;
    const sportName = (await sport.list()).find((s) => s.id === sportId)?.name ?? 'your sport';
    await notifications.emit(
      player.userId,
      'rating.changed',
      { sportName, rating: after, delta },
      { kind: 'player', id: player.id },
    );
  },
```

Check `match.status` exists on `tournament.matchById`'s return (`Match.status` — yes) and that `events.byId` returns `slug` (the `event` Target kind requires it; `EventScreen` links by slug, so it does). If `ratingBefore`/`ratingAfter` arrive as Prisma `Decimal` strings, `Number()` handles them.

- [ ] **Step 7: Wire the worker**

In `src/worker.ts`:

Add the import next to the other modules:

```ts
import { scoring } from './modules/scoring/index.js';
```

In the outbox handler map, replace the `rating.changed` handler and add the two new topics next to `result.disputed`:

```ts
  // scoring R14 — the one reminder, half-way through the window.
  'result.reminder': async (payload) => {
    await notify.resultReminder(payload);
  },
  // scoring R13 — owners and managers, grouped per event.
  'results.waiting': async (payload) => {
    await notify.resultsWaiting(payload);
  },
```

```ts
  'rating.changed': async (payload) => {
    await notify.ratingChanged(payload);
  },
```

In `registerRepeatables`, after the `reconcile-pending` block:

```ts
  // scoring R11, R13, R14 — results confirm themselves, organizers hear about
  // waiting results, opponents are reminded. Every minute: auto_confirm_at is a
  // floor, and a minute late is the most anyone waits past it.
  await queue(QUEUES.tournament).add(
    'sweep-results',
    {},
    { ...defaultJobOptions, repeat: { pattern: '* * * * *' }, jobId: 'sweep-results' },
  );
```

In the `QUEUES.tournament` worker's `switch`, before `default:`:

```ts
        case 'sweep-results': {
          // A final failure ALERTS: the next minute's pass picks up whatever this one missed.
          const report = await scoring.sweep();
          if (report.confirmed + report.alerts + report.reminders > 0) {
            logger.info(
              { confirmed: report.confirmed, alerts: report.alerts, reminders: report.reminders },
              'results swept',
            );
          }
          for (const f of report.failed) {
            logger.error({ matchId: f.matchId, error: f.error }, 'auto-confirm failed; retried next pass');
          }
          return;
        }
```

- [ ] **Step 8: Verify the whole backend**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/modules/identity src/modules/notifications src/notify.ts src/worker.ts tests/identity.test.ts
git commit -m "feat(notifications): result reminders, organizer alerts, auto-confirm and rating pushes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: GraphQL fields

**Files:**
- Modify: `src/modules/scoring/schema/index.ts`
- Regenerate: `schema.graphql`
- Test: `tests/scoring.test.ts` is service-level; the schema is checked by `schema:generate` + typecheck, and by a query test if the repo has a GraphQL test helper (look in `tests/helpers/` for one; if there is none, the generated SDL diff is the check).

**Interfaces:**
- Consumes: `ResultRow.source/autoConfirmAt/confirmedVia` (Task 1)
- Produces: GraphQL `MatchResult.source: ResultSource!`, `MatchResult.autoConfirmAt: DateTime`, `MatchResult.confirmedVia: ResultConfirmation`; enums `ResultSource { LIVE TYPED }`, `ResultConfirmation { OPPONENT STAFF AUTO }`

- [ ] **Step 1: Add the enums and fields**

In `src/modules/scoring/schema/index.ts`, add the import:

```ts
import type { ConfirmedVia, ResultSource } from '../finality.js';
```

After `MatchOutcomeEnum`:

```ts
const ResultSourceEnum = builder.enumType('ResultSource', {
  description:
    'scoring R12 — LIVE came from the point log; TYPED was entered on the result ' +
    'screen. A result a player typed never confirms itself.',
  values: {
    LIVE: { value: 'live' as ResultSource },
    TYPED: { value: 'typed' as ResultSource },
  },
});

const ResultConfirmationEnum = builder.enumType('ResultConfirmation', {
  description: 'How a result became final (scoring R6, R11).',
  values: {
    OPPONENT: { value: 'opponent' as ConfirmedVia },
    STAFF: { value: 'staff' as ConfirmedVia },
    AUTO: { value: 'auto' as ConfirmedVia },
  },
});
```

In `MatchResultRef`'s `fields`, after `disputeReason`:

```ts
    source: t.field({ type: ResultSourceEnum, resolve: (r) => r.source }),
    autoConfirmAt: t.field({
      type: 'DateTime',
      nullable: true,
      description:
        'When it confirms itself if nobody disputes it (R11). Null: a person must confirm it.',
      resolve: (r) => r.autoConfirmAt,
    }),
    confirmedVia: t.field({
      type: ResultConfirmationEnum,
      nullable: true,
      resolve: (r) => r.confirmedVia,
    }),
```

Update the `MatchResultRef` description to:

```ts
  description:
    'HOW a match was won. It advances the bracket only once confirmed — by the ' +
    'other side, by a scorer who scored it, by an organizer 15 minutes later, or ' +
    'by itself at autoConfirmAt (scoring R6, R11, R12).',
```

- [ ] **Step 2: Regenerate the SDL and verify**

Run: `pnpm schema:generate && git diff --stat schema.graphql`
Expected: "Wrote schema.graphql"; the diff adds `ResultSource`, `ResultConfirmation`, and the three `MatchResult` fields.

Run: `pnpm typecheck && pnpm lint && pnpm vitest run tests/scoring.test.ts`
Expected: clean, PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/scoring/schema/index.ts schema.graphql
git commit -m "feat(scoring): expose result source, auto-confirm time and confirmation path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Player app — show the countdown and provenance

**Files** (all under `C:\Coding\Project\PLAY\PLAY_FRONTEND`):
- Modify: `apps/player/src/features/scoring/api.ts` (`MatchResult` type ~line 28, `SCORING_MATCH_FIELDS` ~line 115)
- Modify: `apps/player/src/features/scoring/components/ResultPanel.tsx`
- Modify: `apps/player/src/core/copy.ts` (`scoring.confirm`, ~line 497)
- Create: `apps/player/src/features/scoring/components/ResultPanel.test.tsx`

**Interfaces:**
- Consumes: GraphQL fields from Task 5
- Produces: `MatchResult.source: 'LIVE' | 'TYPED'`, `MatchResult.autoConfirmAt: string | null`, `MatchResult.confirmedVia: 'OPPONENT' | 'STAFF' | 'AUTO' | null`

- [ ] **Step 1: Branch the player-app repo**

```bash
cd /c/Coding/Project/PLAY/PLAY_FRONTEND && git switch -c feat/result-finality
```

- [ ] **Step 2: Write the failing test**

Create `apps/player/src/features/scoring/components/ResultPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MatchResult, ScoringMatch } from '../api';
import { ResultPanel } from './ResultPanel';

jest.mock('../../../shared/hooks', () => ({
  ...jest.requireActual('../../../shared/hooks'),
  useOnline: () => true,
}));

const MIN = 60_000;

function result(over: Partial<MatchResult> = {}): MatchResult {
  const submitted = Date.now() - 5 * MIN;
  return {
    outcome: 'PLAYED',
    games: [{ a: 11, b: 4 }, { a: 11, b: 7 }],
    winner: { id: 'r1' },
    submittedAt: new Date(submitted).toISOString(),
    confirmedAt: null,
    disputedAt: null,
    disputeReason: null,
    overrideOpensAt: new Date(submitted + 15 * MIN).toISOString(),
    viewerCanConfirm: false,
    viewerCanDispute: false,
    source: 'LIVE',
    autoConfirmAt: new Date(submitted + 60 * MIN).toISOString(),
    confirmedVia: null,
    ...over,
  };
}

function mount(r: MatchResult) {
  const match = {
    id: 'm1',
    status: 'AWAITING_CONFIRM',
    sideA: { id: 'r1', seed: 1 },
    sideB: { id: 'r2', seed: 4 },
    result: r,
  } as unknown as ScoringMatch;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ResultPanel match={match} labels={{ a: 'Asha', b: 'Ben' }} />
    </QueryClientProvider>,
  );
}

describe('ResultPanel — result finality', () => {
  it('scoring R11: counts down to automatic confirmation instead of the organizer override', () => {
    mount(result());
    expect(screen.getByText(/Confirms automatically in 5\d:\d\d/)).toBeTruthy();
    expect(screen.queryByText(/an organizer can confirm/i)).toBeNull();
  });

  it('scoring R12: a result with no auto-confirm keeps the organizer countdown', () => {
    mount(result({ source: 'TYPED', autoConfirmAt: null }));
    expect(screen.getByText(/an organizer can confirm in/i)).toBeTruthy();
  });

  it('scoring R12: a typed result is labelled', () => {
    mount(result({ source: 'TYPED', autoConfirmAt: null }));
    expect(screen.getByText('Typed result')).toBeTruthy();
  });

  it('scoring R11: an automatic confirmation says so', () => {
    mount(result({ confirmedAt: new Date().toISOString(), confirmedVia: 'AUTO' }));
    expect(screen.getByText('Confirmed automatically.')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/player && npx jest src/features/scoring/components/ResultPanel.test.tsx`
Expected: FAIL — type errors on `source`/`autoConfirmAt`/`confirmedVia`, and the new texts are absent.

- [ ] **Step 4: Extend the API type and query**

In `apps/player/src/features/scoring/api.ts`, add to `interface MatchResult` after `viewerCanDispute`:

```ts
  /** scoring R12 — LIVE came from the point log; TYPED was entered by hand. */
  source: 'LIVE' | 'TYPED';
  /** scoring R11 — when it confirms itself; null means a person must confirm it. */
  autoConfirmAt: string | null;
  confirmedVia: 'OPPONENT' | 'STAFF' | 'AUTO' | null;
```

In `SCORING_MATCH_FIELDS`, change the `result { … }` selection to:

```ts
  result {
    outcome games { a b } winner { id } submittedAt confirmedAt disputedAt disputeReason
    overrideOpensAt viewerCanConfirm viewerCanDispute
    source autoConfirmAt confirmedVia
  }
```

Search the file for any other `result {` selection (e.g. in the submit/confirm mutation payloads) and add `source autoConfirmAt confirmedVia` there too:

Run: `grep -n "overrideOpensAt" apps/player/src/features/scoring/api.ts`
Expected: every selection that lists `overrideOpensAt` now also lists the three new fields.

- [ ] **Step 5: Add the copy**

In `apps/player/src/core/copy.ts`, inside `scoring.confirm`, after `overrideOpen`:

```ts
      // R11 — the server's own deadline, so the countdown and the sweep agree.
      autoIn: (time: string) => `Confirms automatically in ${time} unless disputed.`,
      typed: 'Typed result',
      confirmedAuto: 'Confirmed automatically.',
```

- [ ] **Step 6: Update `ResultPanel`**

In `apps/player/src/features/scoring/components/ResultPanel.tsx`:

After the `overrideIn` line add:

```tsx
  const autoIn = useCountdown(result?.autoConfirmAt ? Date.parse(result.autoConfirmAt) : null);
```

Replace the header `Text` (the `monoLabel` one) with:

```tsx
      <Text variant="monoLabel" color="ink2">
        {result.confirmedAt
          ? result.confirmedVia === 'AUTO'
            ? copy.scoring.confirm.confirmedAuto
            : copy.scoring.confirm.confirmed
          : copy.scoring.confirm.title}
      </Text>
      {result.source === 'TYPED' ? (
        <Text variant="meta" color="ink2">
          {copy.scoring.confirm.typed}
        </Text>
      ) : null}
```

Replace the waiting block's countdown `Text` with:

```tsx
          <Text variant="meta" color="ink2" tabular accessibilityLiveRegion="polite">
            {result.autoConfirmAt
              ? copy.scoring.confirm.autoIn(mmss(autoIn))
              : overrideIn > 0
                ? copy.scoring.confirm.overrideIn(mmss(overrideIn))
                : copy.scoring.confirm.overrideOpen}
          </Text>
```

`mmss` shows minutes past 59 as e.g. `55:00`, which the test's `5\d:\d\d` matches.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/player && npx jest src/features/scoring && npx tsc --noEmit`
Expected: PASS; no type errors. (The existing `ScoreScreen.test.tsx` builds `ScoringMatch` with `result: null`, so it is unaffected.)

- [ ] **Step 8: Update the player-app doc and commit**

In `PLAY_FRONTEND/docs/modules/11-live-scoring.md`, in the R14 section, add after the existing countdown sentence:

```markdown
When the server sends `autoConfirmAt`, the panel counts down to automatic confirmation instead of the
organizer override (backend scoring R11). A `TYPED` result is labelled "Typed result" (R12), and a
result confirmed by the sweep reads "Confirmed automatically."
```

```bash
cd /c/Coding/Project/PLAY/PLAY_FRONTEND
git add apps/player/src/features/scoring apps/player/src/core/copy.ts docs/modules/11-live-scoring.md
git commit -m "feat(scoring): show auto-confirm countdown and typed results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Backend docs

**Files:**
- Modify: `PALY_BACKEND/docs/modules/10-scoring.md`
- Modify: `PALY_BACKEND/docs/modules/11-notifications.md`

- [ ] **Step 1: Amend the scoring module doc**

In `docs/modules/10-scoring.md`:

Replace R6 with:

```markdown
**R6** — A completed match moves to `awaiting_confirm`, not `completed`. It is confirmed by the
opposing side; by a `scorer` who scored it (R12); by an owner or manager 15 minutes after
submission, or at once if disputed; or by itself at `auto_confirm_at` (R11). A disputed result is
settled only by an owner or manager.
```

After R10 add:

```markdown
**R11** — An auto-eligible result (R12) confirms itself at
`auto_confirm_at = max(submitted + 15 min, min(submitted + 60 min, event end))`, computed once at
submission. The `sweep-results` job runs every minute and confirms through the same path a person
does; everything is re-checked under the match lock, so a dispute or a person that got there first
wins.

**R12** — A result records its `source` (`live` from the point log, `typed` by hand) and its
`submitter_role` at submission. Auto-eligible ⇔ live, or submitted by staff. A player-typed result
needs a person to confirm it. A `scorer` on neither side who recorded points in a live result may
confirm it at once.

**R13** — When a waiting, undisputed result passes its 15-minute override point, owners and managers
get one grouped notification per event. Each result is counted once (`staff_alerted_at`).

**R14** — The answering side is reminded once (`reminded_at`): at half the window for an
auto-eligible result, at 30 minutes otherwise. Never for a disputed result.
```

In the `match_results` schema block, add the six columns from migration 019; in **Emits**, add `result.reminder` and `results.waiting` (consumer: notifications) and note `result.confirmed` carries `via`; in the implementation checklist add a checked item:

```markdown
- [x] Result finality (R11–R14): migration `019_result_finality`, `finality.ts`, `sweep-results`
      job, witness path — spec `docs/superpowers/specs/2026-09-27-result-finality-design.md`
```

- [ ] **Step 2: Amend the notifications doc**

In `docs/modules/11-notifications.md`, in the template list, add `match.result_reminder`,
`match.results_waiting`, `rating.changed` (settled only), and note `match.result_pending`
carries `autoConfirmMinutes` and `match.result` carries `auto`.

- [ ] **Step 3: Commit**

```bash
cd /c/Coding/Project/PLAY/PALY_BACKEND
git add docs/modules/10-scoring.md docs/modules/11-notifications.md
git commit -m "docs(scoring): result finality rules R11–R14

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Final verification**

Run (backend): `pnpm check`
Expected: typecheck, lint, guard and tests all pass.

Run (player app): `cd /c/Coding/Project/PLAY/PLAY_FRONTEND/apps/player && npx jest && npx tsc --noEmit`
Expected: all pass.
