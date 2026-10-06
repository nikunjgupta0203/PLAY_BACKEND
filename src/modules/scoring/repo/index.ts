/**
 * scoring — persistence (docs/modules/10-scoring.md).
 *
 * This module owns `match_score_events`, `match_results`, and two columns on
 * `matches`: `current_score` and `score_seq`, the denormalised head of the log.
 * Everything else on `matches` belongs to `tournament` and is changed by asking
 * it (conventions.md §1).
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import type { GameScore, ScoreEvent, ScoreState, Side } from '../engine.js';
import type { ConfirmedVia, ResultSource, SubmitterRole } from '../finality.js';

export interface MatchHead {
  id: string;
  status: string;
  scoreSeq: number;
  currentScore: ScoreState | null;
}

export type ScoreEventKind = 'start' | 'point' | 'undo' | 'event';

export interface ScoreEventRow {
  seq: number;
  kind: ScoreEventKind;
  scoringSide: Side | null;
  stateAfter: ScoreState;
  event: ScoreEvent | null;
  recordedBy: string;
  recordedAt: Date;
}

export interface ResultRow {
  matchId: string;
  /** Null for a draw: a league or group match that ended level. */
  winnerRegistrationId: string | null;
  loserRegistrationId: string | null;
  games: GameScore[];
  outcome: 'played' | 'walkover' | 'retired' | 'forfeit';
  /** Plan 3 — how it was won beyond the scoreline (shootout…). Null for normal play. */
  method: string | null;
  margin: string | null;
  submittedBy: string;
  submittedAt: Date;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  disputedBy: string | null;
  disputedAt: Date | null;
  disputeReason: string | null;
  source: ResultSource;
  submitterRole: SubmitterRole;
  autoConfirmAt: Date | null;
  confirmedVia: ConfirmedVia | null;
  remindedAt: Date | null;
  staffAlertedAt: Date | null;
  /** gap #20 — when the dispute went to PL4Y staff. */
  escalatedAt?: Date | null;
}

const toResult = (row: {
  matchId: string;
  winnerRegistrationId: string | null;
  loserRegistrationId: string | null;
  games: Prisma.JsonValue;
  outcome: string;
  method: string | null;
  margin: string | null;
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
  escalatedAt?: Date | null;
}): ResultRow => ({
  matchId: row.matchId,
  winnerRegistrationId: row.winnerRegistrationId,
  loserRegistrationId: row.loserRegistrationId,
  games: (row.games ?? []) as unknown as GameScore[],
  outcome: row.outcome as ResultRow['outcome'],
  method: row.method,
  margin: row.margin,
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
  escalatedAt: row.escalatedAt ?? null,
});

export function createScoringRepo(db: Db) {
  /**
   * R1 — the row lock that serialises every writer on one match. The
   * `expectedSeq` comparison happens after this returns, inside the same
   * transaction, so the check and the write cannot be interleaved by a second
   * device. The unique (match_id, seq) index is the backstop if they ever were.
   */
  async function lockHead(tx: Tx, matchId: string): Promise<MatchHead | null> {
    const rows = await tx.$queryRaw<
      { id: string; status: string; score_seq: number; current_score: unknown }[]
    >`
      SELECT id, status, score_seq, current_score
        FROM matches
       WHERE id = ${matchId}::uuid
         FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      scoreSeq: row.score_seq,
      currentScore: (row.current_score ?? null) as ScoreState | null,
    };
  }

  async function head(matchId: string): Promise<MatchHead | null> {
    const row = await db.match.findUnique({
      where: { id: matchId },
      select: { id: true, status: true, scoreSeq: true, currentScore: true },
    });
    if (!row) return null;
    return { ...row, currentScore: (row.currentScore ?? null) as ScoreState | null };
  }

  /** R2, R3 — append the event and move the head, in the caller's transaction. */
  async function append(
    tx: Tx,
    input: {
      matchId: string;
      seq: number;
      kind: ScoreEventKind;
      scoringSide: Side | null;
      stateAfter: ScoreState;
      event: ScoreEvent | null;
      recordedBy: string;
    },
  ): Promise<void> {
    await tx.matchScoreEvent.create({
      data: {
        matchId: input.matchId,
        seq: input.seq,
        kind: input.kind,
        scoringSide: input.scoringSide,
        stateAfter: input.stateAfter as unknown as Prisma.InputJsonValue,
        event: input.event === null ? Prisma.DbNull : (input.event as unknown as Prisma.InputJsonValue),
        recordedBy: input.recordedBy,
      },
    });
    await tx.match.update({
      where: { id: input.matchId },
      data: {
        scoreSeq: input.seq,
        currentScore: input.stateAfter as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async function events(client: Db | Tx, matchId: string): Promise<ScoreEventRow[]> {
    const rows = await client.matchScoreEvent.findMany({
      where: { matchId },
      orderBy: { seq: 'asc' },
    });
    return rows.map((r) => ({
      seq: r.seq,
      kind: r.kind as ScoreEventKind,
      scoringSide: (r.scoringSide ?? null) as Side | null,
      stateAfter: r.stateAfter as unknown as ScoreState,
      event: (r.event ?? null) as ScoreEvent | null,
      recordedBy: r.recordedBy,
      recordedAt: r.recordedAt,
    }));
  }

  async function result(client: Db | Tx, matchId: string): Promise<ResultRow | null> {
    const row = await client.matchResult.findUnique({ where: { matchId } });
    return row ? toResult(row) : null;
  }

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
      | 'method'
      | 'margin'
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
      method: input.method,
      margin: input.margin,
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

  async function dropUnconfirmedResult(tx: Tx, matchId: string): Promise<void> {
    await tx.matchResult.deleteMany({ where: { matchId, confirmedAt: null } });
  }

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

  /** R12 — the witness test: did this user tap points into this match's log? */
  async function hasRecordedPoints(client: Db | Tx, matchId: string, userId: string): Promise<boolean> {
    const count = await client.matchScoreEvent.count({
      where: { matchId, recordedBy: userId, kind: { in: ['point', 'event'] } },
    });
    return count > 0;
  }

  async function dispute(
    tx: Tx,
    matchId: string,
    userId: string,
    reason: string,
    at: Date,
  ): Promise<ResultRow> {
    const row = await tx.matchResult.update({
      where: { matchId },
      data: { disputedBy: userId, disputedAt: at, disputeReason: reason },
    });
    return toResult(row);
  }

  // --- the sweep (R11, R13, R14). All three read only rows still waiting,
  // which is exactly what match_results_pending_idx covers. ------------------

  /** F9 — disputes handed to PL4Y staff and still open, oldest first. */
  async function escalatedOpen(): Promise<string[]> {
    const rows = await db.matchResult.findMany({
      where: { escalatedAt: { not: null }, confirmedAt: null },
      orderBy: { escalatedAt: 'asc' },
      select: { matchId: true },
      take: 200,
    });
    return rows.map((r) => r.matchId);
  }

  /** F12, F15 — this event's results nobody has confirmed: disputes first, then oldest. */
  async function openForEvent(eventId: string): Promise<string[]> {
    const rows = await db.$queryRaw<{ match_id: string }[]>`
      SELECT r.match_id
        FROM match_results r
        JOIN matches m ON m.id = r.match_id
        JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.event_id = ${eventId}::uuid AND r.confirmed_at IS NULL
       ORDER BY (r.disputed_at IS NULL), r.submitted_at
       LIMIT 200
    `;
    return rows.map((r) => r.match_id);
  }

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

  /**
   * gap #20 — disputes still open, last brought to the organizer longer ago
   * than `everyMs` (or never). Grouped by event by the caller.
   */
  async function dueForDisputeReminder(
    at: Date,
    everyMs: number,
  ): Promise<{ matchId: string; eventId: string }[]> {
    const cutoff = new Date(at.getTime() - everyMs);
    const rows = await db.$queryRaw<{ match_id: string; event_id: string }[]>`
      SELECT r.match_id, t.event_id
        FROM match_results r
        JOIN matches m ON m.id = r.match_id
        JOIN tournaments t ON t.id = m.tournament_id
       WHERE r.confirmed_at IS NULL AND r.disputed_at IS NOT NULL
         AND r.disputed_at <= ${cutoff}
         AND (r.dispute_alerted_at IS NULL OR r.dispute_alerted_at <= ${cutoff})
    `;
    return rows.map((r) => ({ matchId: r.match_id, eventId: r.event_id }));
  }

  async function markDisputeAlerted(tx: Tx, matchIds: string[], at: Date): Promise<number> {
    const { count } = await tx.matchResult.updateMany({
      where: { matchId: { in: matchIds }, confirmedAt: null, disputedAt: { not: null } },
      data: { disputeAlertedAt: at },
    });
    return count;
  }

  /** gap #20 — open disputes on events that ended more than `afterEndMs` ago, not yet escalated. */
  async function dueForEscalation(
    at: Date,
    afterEndMs: number,
  ): Promise<{ matchId: string; eventId: string }[]> {
    const cutoff = new Date(at.getTime() - afterEndMs);
    const rows = await db.$queryRaw<{ match_id: string; event_id: string }[]>`
      SELECT r.match_id, t.event_id
        FROM match_results r
        JOIN matches m ON m.id = r.match_id
        JOIN tournaments t ON t.id = m.tournament_id
        JOIN events e ON e.id = t.event_id
       WHERE r.confirmed_at IS NULL AND r.disputed_at IS NOT NULL
         AND r.escalated_at IS NULL
         AND e.ends_at <= ${cutoff}
    `;
    return rows.map((r) => ({ matchId: r.match_id, eventId: r.event_id }));
  }

  /** gap #20 — escalated disputes PL4Y has not settled `afterMs` after they arrived. */
  async function dueForDefault(at: Date, afterMs: number): Promise<string[]> {
    const rows = await db.matchResult.findMany({
      where: {
        confirmedAt: null,
        disputedAt: { not: null },
        escalatedAt: { not: null, lte: new Date(at.getTime() - afterMs) },
      },
      select: { matchId: true },
      orderBy: { escalatedAt: 'asc' },
      take: 200,
    });
    return rows.map((r) => r.matchId);
  }

  async function markEscalated(tx: Tx, matchId: string, at: Date): Promise<boolean> {
    const { count } = await tx.matchResult.updateMany({
      where: { matchId, escalatedAt: null, confirmedAt: null },
      data: { escalatedAt: at },
    });
    return count === 1;
  }

  /** scoring R7 (gap #18) — an organizer's correction of a confirmed result. */
  async function correct(
    tx: Tx,
    matchId: string,
    input: Pick<ResultRow, 'winnerRegistrationId' | 'loserRegistrationId' | 'games' | 'outcome' | 'method' | 'margin'> & {
      correctedBy: string;
    },
  ): Promise<ResultRow> {
    const row = await tx.matchResult.update({
      where: { matchId },
      data: {
        winnerRegistrationId: input.winnerRegistrationId,
        loserRegistrationId: input.loserRegistrationId,
        games: input.games as unknown as Prisma.InputJsonValue,
        outcome: input.outcome,
        method: input.method,
        margin: input.margin,
        confirmedBy: input.correctedBy,
        confirmedVia: 'staff',
      },
    });
    return toResult(row);
  }

  /** rating R4 — played or not, rating decides what counts (rating R7). */
  async function confirmedBetween(
    sportId: string,
    from: Date,
    to: Date,
  ): Promise<(ResultRow & { sportId: string })[]> {
    const rows = await db.matchResult.findMany({
      where: {
        confirmedAt: { gte: from, lt: to },
        match: { sportId },
      },
      include: { match: { select: { sportId: true } } },
      orderBy: { confirmedAt: 'asc' },
    });
    return rows.map((r) => ({ ...toResult(r), sportId: r.match.sportId }));
  }

  return {
    lockHead,
    head,
    append,
    events,
    result,
    putResult,
    dropUnconfirmedResult,
    confirm,
    dispute,
    hasRecordedPoints,
    openForEvent,
    escalatedOpen,
    dueForAutoConfirm,
    dueForStaffAlert,
    dueForReminder,
    markStaffAlerted,
    markReminded,
    dueForDisputeReminder,
    markDisputeAlerted,
    dueForEscalation,
    dueForDefault,
    markEscalated,
    correct,
    confirmedBetween,
  };
}

export type ScoringRepo = ReturnType<typeof createScoringRepo>;
