/**
 * admin — Phase 2 queues (docs/modules/15-admin.md R6, R7, R8).
 *
 * The admin module owns three queues and nothing else: reports people make
 * about each other's content (R6), support tickets (R7) and fraud signals
 * (R8). Anything a decision changes in another module — hiding a venue
 * review, suspending a person, holding a payout — is that module's own method,
 * passed in as a port.
 *
 * Who may call what (the platform role, the reason, the audit row) is decided
 * in the schema layer, like every other staff action (graphql/staff.ts).
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const AdminServiceCode = {
  REPORT_ALREADY_OPEN: 'REPORT_ALREADY_OPEN',
  REPORT_TARGET_NOT_FOUND: 'REPORT_TARGET_NOT_FOUND',
  CANNOT_REPORT_SELF: 'CANNOT_REPORT_SELF',
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',
  REPORT_CLOSED: 'REPORT_CLOSED',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  TICKET_CLOSED: 'TICKET_CLOSED',
  INVALID_TICKET: 'INVALID_TICKET',
  NOTHING_TO_REVIEW: 'NOTHING_TO_REVIEW',
} as const;

// --- R6 — moderation ---------------------------------------------------------

export type ReportTarget = 'player' | 'venue_review' | 'message';
export type ReportReason = 'spam' | 'abuse' | 'fake' | 'unsafe' | 'inaccurate' | 'other';
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

/** R6 — user-generated content hides itself once this many different people report it. */
export const AUTO_HIDE_REPORTERS = 5;

export interface ModerationReport {
  id: string;
  reporterId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: ReportReason;
  note: string | null;
  status: ReportStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/** One target in the moderation queue: every open report on it, grouped. */
export interface ModerationCase {
  targetType: ReportTarget;
  targetId: string;
  reports: ModerationReport[];
  reporterCount: number;
  firstReportedAt: Date;
}

// --- R7 — support ------------------------------------------------------------

export type TicketStatus = 'open' | 'pending_user' | 'resolved' | 'closed';
export type TicketLink = 'event' | 'registration' | 'payment' | 'booking' | 'payout';

export interface SupportTicket {
  id: string;
  userId: string;
  subject: string;
  linkedType: TicketLink | null;
  linkedId: string | null;
  requestId: string | null;
  status: TicketStatus;
  assignedTo: string | null;
  firstResponseAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupportMessage {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  internal: boolean;
  createdAt: Date;
}

/** R7 — a resolved ticket nobody reopens closes itself after this long. */
export const TICKET_CLOSE_AFTER_MS = 7 * 86_400_000;

// --- R8 — fraud ----------------------------------------------------------------

export type FraudSubject = 'user' | 'organisation' | 'venue' | 'device';

export interface FraudSignal {
  id: string;
  subjectType: FraudSubject;
  subjectId: string;
  detector: string;
  score: number;
  evidence: Record<string, unknown>;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  outcome: 'confirmed' | 'dismissed' | null;
  createdAt: Date;
}

/** R8 — open signals on one subject, summed. At the threshold it is a case for a person. */
export interface FraudCase {
  subjectType: FraudSubject;
  subjectId: string;
  score: number;
  isCase: boolean;
  signals: FraudSignal[];
  latestAt: Date;
}

/** R8 — the summed score of a subject's open signals that makes it a review case. */
export const FRAUD_CASE_THRESHOLD = 60;

/**
 * F26 — two accounts that mostly play each other. Over the window, each of
 * them played at least `minMatches` confirmed matches against the other, and
 * those were at least `minShare` of everything each of them played.
 */
export const RATING_PAIR = { windowDays: 60, minMatches: 4, minShare: 0.75, score: 40 } as const;
/** bookings R12 — three no-shows in 60 days. */
export const BOOKING_NO_SHOWS = { windowDays: 60, min: 3, score: 30 } as const;
/** R8 — a host who cancels this many events in 90 days. */
export const HOST_CANCELLATIONS = { windowDays: 90, min: 3, score: 30 } as const;

// --- ports -----------------------------------------------------------------------

export interface AdminDeps {
  db: Db;
  now?: () => Date;
  /** venues — hide or show a review (venues R7 keeps the rating right). */
  setReviewHidden(reviewId: string, hidden: boolean): Promise<boolean>;
  /** notifications — R7: a staff reply reaches the person's feed. */
  notifySupportReply(userId: string, ticketId: string, subject: string): Promise<void>;
  /** R7 — and their inbox. Best effort. */
  emailSupportReply?(userId: string, subject: string, body: string): Promise<void>;
}

const MAX_NOTE = 1000;
const MAX_BODY = 4000;

export function createAdminService(deps: AdminDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // ===========================================================================
  // R6 — reports
  // ===========================================================================

  /** Who wrote the target, so nobody reports themselves; null when it does not exist. */
  async function authorOf(targetType: ReportTarget, targetId: string): Promise<string | null> {
    switch (targetType) {
      case 'player': {
        const row = await db.playerProfile.findUnique({ where: { id: targetId }, select: { userId: true } });
        return row?.userId ?? null;
      }
      case 'venue_review': {
        const row = await db.venueReview.findUnique({ where: { id: targetId }, select: { userId: true } });
        return row?.userId ?? null;
      }
      case 'message': {
        const row = await db.message.findUnique({
          where: { id: targetId },
          select: { sender: { select: { userId: true } } },
        });
        return row?.sender.userId ?? null;
      }
    }
  }

  async function report(
    actor: { userId: string },
    input: { targetType: ReportTarget; targetId: string; reason: ReportReason; note?: string | null },
  ): Promise<ModerationReport> {
    const author = /^[0-9a-f-]{36}$/i.test(input.targetId) ? await authorOf(input.targetType, input.targetId) : null;
    if (!author) throw new UserError(AdminServiceCode.REPORT_TARGET_NOT_FOUND, 'That could not be found. It may have been removed.');
    if (author === actor.userId) throw new UserError(AdminServiceCode.CANNOT_REPORT_SELF, 'You cannot report yourself.');
    const note = input.note?.trim() || null;
    if (note && note.length > MAX_NOTE) {
      throw new UserError(AdminServiceCode.REPORT_TARGET_NOT_FOUND, `Keep it under ${MAX_NOTE} characters.`);
    }

    let row;
    try {
      row = await db.moderationReport.create({
        data: {
          id: newId(),
          reporterId: actor.userId,
          targetType: input.targetType,
          targetId: input.targetId,
          reason: input.reason,
          note,
        },
      });
    } catch (err) {
      // R6 — the partial unique index: one open report per reporter per target.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new UserError(AdminServiceCode.REPORT_ALREADY_OPEN, 'You already reported this. PL4Y is looking at it.');
      }
      throw err;
    }

    // R6 — content hides itself at five different reporters, until a person decides.
    if (input.targetType === 'venue_review') {
      const reporters = await openReporterCount(input.targetType, input.targetId);
      if (reporters >= AUTO_HIDE_REPORTERS) await deps.setReviewHidden(input.targetId, true);
    }
    return toReport(row);
  }

  async function openReporterCount(targetType: ReportTarget, targetId: string): Promise<number> {
    const rows = await db.moderationReport.findMany({
      where: { targetType, targetId, status: 'open' },
      select: { reporterId: true },
      distinct: ['reporterId'],
    });
    return rows.length;
  }

  /** R6 — the queue, one case per target, oldest first; or closed reports, newest first. */
  async function moderationQueue(status: ReportStatus, page: { first: number; offset: number }): Promise<{
    nodes: ModerationCase[];
    hasNextPage: boolean;
  }> {
    if (status !== 'open') {
      const rows = await db.moderationReport.findMany({
        where: { status },
        orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
        skip: page.offset,
        take: page.first + 1,
      });
      return {
        nodes: rows.slice(0, page.first).map((r) => {
          const rep = toReport(r);
          return { targetType: rep.targetType, targetId: rep.targetId, reports: [rep], reporterCount: 1, firstReportedAt: rep.createdAt };
        }),
        hasNextPage: rows.length > page.first,
      };
    }
    const groups = await db.$queryRaw<{ target_type: string; target_id: string; first_at: Date; reporters: bigint }[]>`
      SELECT target_type, target_id, min(created_at) AS first_at, count(DISTINCT reporter_id)::bigint AS reporters
        FROM moderation_reports
       WHERE status = 'open'
       GROUP BY target_type, target_id
       ORDER BY count(DISTINCT reporter_id) >= ${AUTO_HIDE_REPORTERS} DESC, min(created_at)
       OFFSET ${page.offset} LIMIT ${page.first + 1}
    `;
    const nodes = await Promise.all(
      groups.slice(0, page.first).map(async (g) => ({
        targetType: g.target_type as ReportTarget,
        targetId: g.target_id,
        reporterCount: Number(g.reporters),
        firstReportedAt: g.first_at,
        reports: (
          await db.moderationReport.findMany({
            where: { targetType: g.target_type, targetId: g.target_id, status: 'open' },
            orderBy: { createdAt: 'asc' },
          })
        ).map(toReport),
      })),
    );
    return { nodes, hasNextPage: groups.length > page.first };
  }

  /**
   * R6 — a moderator decides a target: every open report on it closes with
   * the same outcome. Acting on a venue review keeps it hidden; dismissing
   * shows it again if the reports had hidden it.
   */
  async function resolveReports(
    staff: { userId: string },
    input: { targetType: ReportTarget; targetId: string; outcome: 'actioned' | 'dismissed'; resolution: string },
  ): Promise<{ closed: number }> {
    const at = now();
    const { count } = await db.moderationReport.updateMany({
      where: { targetType: input.targetType, targetId: input.targetId, status: 'open' },
      data: { status: input.outcome, resolution: input.resolution, resolvedBy: staff.userId, resolvedAt: at },
    });
    if (count === 0) throw new UserError(AdminServiceCode.REPORT_CLOSED, 'There is nothing open on this any more.');
    if (input.targetType === 'venue_review') {
      await deps.setReviewHidden(input.targetId, input.outcome === 'actioned');
    }
    return { closed: count };
  }

  async function openReportCount(): Promise<number> {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(DISTINCT (target_type, target_id))::bigint AS n FROM moderation_reports WHERE status = 'open'`;
    return Number(rows[0]?.n ?? 0n);
  }

  // ===========================================================================
  // R7 — support
  // ===========================================================================

  function checkBody(body: string): string {
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_BODY) {
      throw new UserError(AdminServiceCode.INVALID_TICKET, `Write a message of up to ${MAX_BODY} characters.`);
    }
    return trimmed;
  }

  async function openTicket(
    actor: { userId: string },
    input: { subject: string; body: string; linkedType?: TicketLink | null; linkedId?: string | null; requestId?: string | null },
  ): Promise<SupportTicket> {
    const subject = input.subject.trim();
    if (subject.length < 3 || subject.length > 140) {
      throw new UserError(AdminServiceCode.INVALID_TICKET, 'Give it a short subject (3 to 140 characters).');
    }
    const body = checkBody(input.body);
    const linkedId = input.linkedId && /^[0-9a-f-]{36}$/i.test(input.linkedId) ? input.linkedId : null;
    const id = newId();
    const row = await db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          id,
          userId: actor.userId,
          subject,
          linkedType: linkedId ? (input.linkedType ?? null) : null,
          linkedId,
          requestId: input.requestId?.slice(0, 100) ?? null,
        },
      });
      await tx.supportMessage.create({ data: { id: newId(), ticketId: id, authorId: actor.userId, body } });
      return ticket;
    });
    return toTicket(row);
  }

  async function ticketForUser(userId: string, ticketId: string): Promise<SupportTicket | null> {
    const row = await db.supportTicket.findFirst({ where: { id: ticketId, userId } });
    return row ? toTicket(row) : null;
  }

  async function ticketById(ticketId: string): Promise<SupportTicket | null> {
    const row = await db.supportTicket.findUnique({ where: { id: ticketId } });
    return row ? toTicket(row) : null;
  }

  /**
   * R7 — the thread. `includeInternal` is for staff only; the user-facing
   * resolver never passes it, which is what keeps internal notes internal.
   */
  async function messages(ticketId: string, opts: { includeInternal: boolean }): Promise<SupportMessage[]> {
    const rows = await db.supportMessage.findMany({
      where: { ticketId, ...(opts.includeInternal ? {} : { internal: false }) },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({ ...m }));
  }

  async function myTickets(userId: string, page: { first: number; offset: number }) {
    const rows = await db.supportTicket.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: page.offset,
      take: page.first + 1,
    });
    return { nodes: rows.slice(0, page.first).map(toTicket), hasNextPage: rows.length > page.first };
  }

  /** The person writes back. A ticket waiting on them goes back to support's queue. */
  async function replyAsUser(actor: { userId: string }, ticketId: string, rawBody: string): Promise<SupportTicket> {
    const ticket = await ticketForUser(actor.userId, ticketId);
    if (!ticket) throw new UserError(AdminServiceCode.TICKET_NOT_FOUND, 'That ticket could not be found.');
    if (ticket.status === 'closed') {
      throw new UserError(AdminServiceCode.TICKET_CLOSED, 'This ticket is closed. Open a new one and we will pick it up.');
    }
    const body = checkBody(rawBody);
    const row = await db.$transaction(async (tx) => {
      await tx.supportMessage.create({ data: { id: newId(), ticketId, authorId: actor.userId, body } });
      return tx.supportTicket.update({ where: { id: ticketId }, data: { status: 'open', updatedAt: now() } });
    });
    return toTicket(row);
  }

  /**
   * R7 — staff answer. A public reply waits on the person and tells them, in
   * the feed and by email. An internal note tells nobody and changes nothing
   * they can see.
   */
  async function staffReply(
    staff: { userId: string },
    ticketId: string,
    input: { body: string; internal: boolean },
  ): Promise<SupportTicket> {
    const ticket = await ticketById(ticketId);
    if (!ticket) throw new UserError(AdminServiceCode.TICKET_NOT_FOUND, 'That ticket could not be found.');
    if (ticket.status === 'closed' && !input.internal) {
      throw new UserError(AdminServiceCode.TICKET_CLOSED, 'This ticket is closed. Reopen it first.');
    }
    const body = checkBody(input.body);
    const at = now();
    const row = await db.$transaction(async (tx) => {
      await tx.supportMessage.create({
        data: { id: newId(), ticketId, authorId: staff.userId, body, internal: input.internal },
      });
      return tx.supportTicket.update({
        where: { id: ticketId },
        data: input.internal
          ? { updatedAt: at, assignedTo: ticket.assignedTo ?? staff.userId }
          : {
              status: 'pending_user',
              updatedAt: at,
              assignedTo: ticket.assignedTo ?? staff.userId,
              ...(ticket.firstResponseAt ? {} : { firstResponseAt: at }),
            },
      });
    });
    if (!input.internal) {
      await deps.notifySupportReply(ticket.userId, ticketId, ticket.subject);
      await deps.emailSupportReply?.(ticket.userId, ticket.subject, body).catch(() => undefined);
    }
    return toTicket(row);
  }

  async function setTicketStatus(ticketId: string, status: TicketStatus): Promise<SupportTicket> {
    const ticket = await ticketById(ticketId);
    if (!ticket) throw new UserError(AdminServiceCode.TICKET_NOT_FOUND, 'That ticket could not be found.');
    const row = await db.supportTicket.update({ where: { id: ticketId }, data: { status, updatedAt: now() } });
    return toTicket(row);
  }

  async function assignTicket(ticketId: string, userId: string | null): Promise<SupportTicket> {
    const row = await db.supportTicket.update({ where: { id: ticketId }, data: { assignedTo: userId, updatedAt: now() } });
    return toTicket(row);
  }

  /** Staff queue: oldest waiting first, so nobody's ticket sinks. */
  async function ticketQueue(status: TicketStatus | null, page: { first: number; offset: number; search?: string | null }) {
    const q = page.search?.trim();
    const rows = await db.supportTicket.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(q ? { subject: { contains: q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: status === 'open' || status === 'pending_user' ? [{ updatedAt: 'asc' }] : [{ updatedAt: 'desc' }],
      skip: page.offset,
      take: page.first + 1,
    });
    return { nodes: rows.slice(0, page.first).map(toTicket), hasNextPage: rows.length > page.first };
  }

  async function openTicketCount(): Promise<number> {
    return db.supportTicket.count({ where: { status: 'open' } });
  }

  /** R7 — the sweep: resolved tickets nobody reopened for a week close. */
  async function closeStaleTickets(): Promise<number> {
    const { count } = await db.supportTicket.updateMany({
      where: { status: 'resolved', updatedAt: { lt: new Date(now().getTime() - TICKET_CLOSE_AFTER_MS) } },
      data: { status: 'closed' },
    });
    return count;
  }

  // ===========================================================================
  // R8 — fraud signals
  // ===========================================================================

  /** Idempotent on `dedupeKey`: detectors run again and again over the same facts. */
  async function recordSignal(input: {
    subjectType: FraudSubject;
    subjectId: string;
    detector: string;
    score: number;
    dedupeKey: string;
    evidence?: Record<string, unknown>;
  }): Promise<boolean> {
    const score = Math.min(100, Math.max(1, Math.round(input.score)));
    const { count } = await db.fraudSignal.createMany({
      data: [
        {
          id: newId(),
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          detector: input.detector,
          score,
          dedupeKey: input.dedupeKey,
          evidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  /** The ISO-ish week a detector run belongs to, so a pattern is flagged once a week at most. */
  const weekKey = (at: Date) => `${at.getUTCFullYear()}w${Math.floor((at.getTime() / 86_400_000 + 3) / 7)}`;

  /**
   * F26 — accounts that only play each other. Read over confirmed singles
   * results (a team's captain stands for the side), within the window.
   */
  async function detectRatingPairs(): Promise<number> {
    const at = now();
    const since = new Date(at.getTime() - RATING_PAIR.windowDays * 86_400_000);
    const rows = await db.$queryRaw<{ a: string; b: string; together: bigint; total_a: bigint; total_b: bigint }[]>`
      WITH played AS (
        SELECT ra.captain_user_id AS u1, rb.captain_user_id AS u2
          FROM match_results r
          JOIN matches m ON m.id = r.match_id
          JOIN registrations ra ON ra.id = m.side_a_registration_id
          JOIN registrations rb ON rb.id = m.side_b_registration_id
         WHERE r.confirmed_at >= ${since}
           AND r.outcome = 'played'
           AND ra.captain_user_id <> rb.captain_user_id
      ),
      pairs AS (
        SELECT least(u1, u2) AS a, greatest(u1, u2) AS b, count(*) AS together
          FROM played GROUP BY 1, 2
      ),
      totals AS (
        SELECT u, count(*) AS total FROM (SELECT u1 AS u FROM played UNION ALL SELECT u2 FROM played) x GROUP BY u
      )
      SELECT p.a::text AS a, p.b::text AS b, p.together::bigint AS together,
             ta.total::bigint AS total_a, tb.total::bigint AS total_b
        FROM pairs p
        JOIN totals ta ON ta.u = p.a
        JOIN totals tb ON tb.u = p.b
       WHERE p.together >= ${RATING_PAIR.minMatches}
         AND p.together::float / ta.total >= ${RATING_PAIR.minShare}
         AND p.together::float / tb.total >= ${RATING_PAIR.minShare}
    `;
    let flagged = 0;
    for (const r of rows) {
      const together = Number(r.together);
      for (const [self, other, total] of [
        [r.a, r.b, Number(r.total_a)],
        [r.b, r.a, Number(r.total_b)],
      ] as const) {
        const recorded = await recordSignal({
          subjectType: 'user',
          subjectId: self,
          detector: 'rating_pair',
          score: RATING_PAIR.score,
          dedupeKey: `rating_pair:${r.a}:${r.b}:${self}:${weekKey(at)}`,
          evidence: { otherUserId: other, matchesTogether: together, matchesTotal: total, windowDays: RATING_PAIR.windowDays },
        });
        if (recorded) flagged += 1;
      }
    }
    return flagged;
  }

  /** bookings R12 — repeated no-shows. */
  async function detectBookingNoShows(): Promise<number> {
    const at = now();
    const since = new Date(at.getTime() - BOOKING_NO_SHOWS.windowDays * 86_400_000);
    const rows = await db.$queryRaw<{ user_id: string; n: bigint }[]>`
      SELECT user_id::text AS user_id, count(*)::bigint AS n
        FROM court_bookings
       WHERE status = 'no_show' AND user_id IS NOT NULL AND starts_at >= ${since}
       GROUP BY user_id
      HAVING count(*) >= ${BOOKING_NO_SHOWS.min}
    `;
    let flagged = 0;
    for (const r of rows) {
      if (
        await recordSignal({
          subjectType: 'user',
          subjectId: r.user_id,
          detector: 'booking_no_show',
          score: BOOKING_NO_SHOWS.score,
          dedupeKey: `booking_no_show:${r.user_id}:${weekKey(at)}`,
          evidence: { noShows: Number(r.n), windowDays: BOOKING_NO_SHOWS.windowDays },
        })
      ) {
        flagged += 1;
      }
    }
    return flagged;
  }

  /** R8 — a host who keeps cancelling events people paid for. */
  async function detectHostCancellations(): Promise<number> {
    const at = now();
    const since = new Date(at.getTime() - HOST_CANCELLATIONS.windowDays * 86_400_000);
    const rows = await db.$queryRaw<{ organizer_id: string; n: bigint }[]>`
      SELECT organizer_id::text AS organizer_id, count(*)::bigint AS n
        FROM events
       WHERE status = 'cancelled' AND starts_at >= ${since}
       GROUP BY organizer_id
      HAVING count(*) >= ${HOST_CANCELLATIONS.min}
    `;
    let flagged = 0;
    for (const r of rows) {
      if (
        await recordSignal({
          subjectType: 'user',
          subjectId: r.organizer_id,
          detector: 'host_cancellations',
          score: HOST_CANCELLATIONS.score,
          dedupeKey: `host_cancellations:${r.organizer_id}:${weekKey(at)}`,
          evidence: { cancelledEvents: Number(r.n), windowDays: HOST_CANCELLATIONS.windowDays },
        })
      ) {
        flagged += 1;
      }
    }
    return flagged;
  }

  /** The `detect-fraud-signals` job. Each detector is independent; one failing never stops the rest. */
  async function runDetectors(): Promise<Record<string, number | string>> {
    const out: Record<string, number | string> = {};
    for (const [name, fn] of [
      ['rating_pair', detectRatingPairs],
      ['booking_no_show', detectBookingNoShows],
      ['host_cancellations', detectHostCancellations],
    ] as const) {
      try {
        out[name] = await fn();
      } catch (err) {
        out[name] = err instanceof Error ? err.message : String(err);
      }
    }
    return out;
  }

  /** R8 — open signals grouped per subject, highest score first. */
  async function fraudQueue(page: { first: number; offset: number; reviewed?: boolean }): Promise<{
    nodes: FraudCase[];
    hasNextPage: boolean;
  }> {
    const reviewed = page.reviewed ?? false;
    const groups = await db.$queryRaw<{ subject_type: string; subject_id: string; score: bigint; latest: Date }[]>`
      SELECT subject_type, subject_id, sum(score)::bigint AS score, max(created_at) AS latest
        FROM fraud_signals
       WHERE (reviewed_at IS NOT NULL) = ${reviewed}
       GROUP BY subject_type, subject_id
       ORDER BY ${reviewed ? Prisma.sql`max(reviewed_at) DESC` : Prisma.sql`sum(score) DESC, max(created_at) DESC`}
       OFFSET ${page.offset} LIMIT ${page.first + 1}
    `;
    const nodes = await Promise.all(
      groups.slice(0, page.first).map(async (g) => {
        const signals = (
          await db.fraudSignal.findMany({
            where: { subjectType: g.subject_type, subjectId: g.subject_id, reviewedAt: reviewed ? { not: null } : null },
            orderBy: { createdAt: 'desc' },
          })
        ).map(toSignal);
        const score = Number(g.score);
        return {
          subjectType: g.subject_type as FraudSubject,
          subjectId: g.subject_id,
          score,
          isCase: score >= FRAUD_CASE_THRESHOLD,
          signals,
          latestAt: g.latest,
        };
      }),
    );
    return { nodes, hasNextPage: groups.length > page.first };
  }

  /**
   * R8 — a person reviews a subject: every open signal on it closes with the
   * outcome. Suspending someone is a separate, deliberate step.
   */
  async function reviewFraudSubject(
    staff: { userId: string },
    input: { subjectType: FraudSubject; subjectId: string; outcome: 'confirmed' | 'dismissed' },
  ): Promise<{ reviewed: number }> {
    const { count } = await db.fraudSignal.updateMany({
      where: { subjectType: input.subjectType, subjectId: input.subjectId, reviewedAt: null },
      data: { reviewedAt: now(), reviewedBy: staff.userId, outcome: input.outcome },
    });
    if (count === 0) throw new UserError(AdminServiceCode.NOTHING_TO_REVIEW, 'There is nothing open on this any more.');
    return { reviewed: count };
  }

  async function openFraudCaseCount(): Promise<number> {
    const rows = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (
        SELECT 1 FROM fraud_signals WHERE reviewed_at IS NULL
         GROUP BY subject_type, subject_id HAVING sum(score) >= ${FRAUD_CASE_THRESHOLD}) x`;
    return Number(rows[0]?.n ?? 0n);
  }

  async function signalsFor(subjectType: FraudSubject, subjectId: string): Promise<FraudSignal[]> {
    return (
      await db.fraudSignal.findMany({ where: { subjectType, subjectId }, orderBy: { createdAt: 'desc' }, take: 50 })
    ).map(toSignal);
  }

  return {
    // R6
    report,
    moderationQueue,
    resolveReports,
    openReportCount,
    openReporterCount,
    // R7
    openTicket,
    ticketForUser,
    ticketById,
    messages,
    myTickets,
    replyAsUser,
    staffReply,
    setTicketStatus,
    assignTicket,
    ticketQueue,
    openTicketCount,
    closeStaleTickets,
    // R8
    recordSignal,
    detectRatingPairs,
    detectBookingNoShows,
    detectHostCancellations,
    runDetectors,
    fraudQueue,
    reviewFraudSubject,
    openFraudCaseCount,
    signalsFor,
  };
}

export type AdminService = ReturnType<typeof createAdminService>;

const toReport = (r: {
  id: string;
  reporterId: string;
  targetType: string;
  targetId: string;
  reason: string;
  note: string | null;
  status: string;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}): ModerationReport => ({
  ...r,
  targetType: r.targetType as ReportTarget,
  reason: r.reason as ReportReason,
  status: r.status as ReportStatus,
});

const toTicket = (t: {
  id: string;
  userId: string;
  subject: string;
  linkedType: string | null;
  linkedId: string | null;
  requestId: string | null;
  status: string;
  assignedTo: string | null;
  firstResponseAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SupportTicket => ({ ...t, linkedType: t.linkedType as TicketLink | null, status: t.status as TicketStatus });

const toSignal = (s: {
  id: string;
  subjectType: string;
  subjectId: string;
  detector: string;
  score: number;
  evidence: Prisma.JsonValue;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  outcome: string | null;
  createdAt: Date;
}): FraudSignal => ({
  ...s,
  subjectType: s.subjectType as FraudSubject,
  evidence: (s.evidence ?? {}) as Record<string, unknown>,
  outcome: s.outcome as FraudSignal['outcome'],
});

