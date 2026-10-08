/**
 * admin Phase 2 — reports, support tickets and fraud signals
 * (docs/modules/15-admin.md R6, R7, R8).
 *
 * Player fields: reportContent, openSupportTicket, replySupportTicket,
 * mySupportTickets, supportTicket. Staff fields (portal sessions only,
 * portal R2) take a reason and are audited (portal R3).
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { db } from '../../../platform/db.js';
import { identity } from '../../identity/index.js';
import { admin } from '../index.js';
import type {
  FraudCase,
  FraudSignal,
  ModerationCase,
  ModerationReport,
  ReportReason,
  ReportTarget,
  SupportMessage,
  SupportTicket,
  TicketLink,
  TicketStatus,
} from '../index.js';

// --- enums ---------------------------------------------------------------------------

const ReportTargetEnum = builder.enumType('ReportTarget', {
  values: {
    PLAYER: { value: 'player' as ReportTarget },
    VENUE_REVIEW: { value: 'venue_review' as ReportTarget },
    MESSAGE: { value: 'message' as ReportTarget },
  },
});

const ReportReasonEnum = builder.enumType('ReportReason', {
  values: {
    SPAM: { value: 'spam' as ReportReason },
    ABUSE: { value: 'abuse' as ReportReason },
    FAKE: { value: 'fake' as ReportReason },
    UNSAFE: { value: 'unsafe' as ReportReason },
    INACCURATE: { value: 'inaccurate' as ReportReason },
    OTHER: { value: 'other' as ReportReason },
  },
});

const ModerationStatusEnum = builder.enumType('ModerationStatus', {
  values: { OPEN: { value: 'open' }, ACTIONED: { value: 'actioned' }, DISMISSED: { value: 'dismissed' } } as const,
});

const TicketStatusEnum = builder.enumType('SupportTicketStatus', {
  values: {
    OPEN: { value: 'open' as TicketStatus },
    PENDING_USER: { value: 'pending_user' as TicketStatus },
    RESOLVED: { value: 'resolved' as TicketStatus },
    CLOSED: { value: 'closed' as TicketStatus },
  },
});

const TicketLinkEnum = builder.enumType('SupportTicketLink', {
  values: {
    EVENT: { value: 'event' as TicketLink },
    REGISTRATION: { value: 'registration' as TicketLink },
    PAYMENT: { value: 'payment' as TicketLink },
    BOOKING: { value: 'booking' as TicketLink },
    PAYOUT: { value: 'payout' as TicketLink },
  },
});

// --- moderation ---------------------------------------------------------------------------

interface TargetSummary {
  title: string;
  body: string | null;
  authorUserId: string | null;
  authorName: string | null;
  hidden: boolean;
  link: string | null;
}

/** What staff see of a reported thing: enough to decide, nothing more. */
async function summarise(targetType: ReportTarget, targetId: string): Promise<TargetSummary> {
  const missing: TargetSummary = { title: 'Removed', body: null, authorUserId: null, authorName: null, hidden: false, link: null };
  switch (targetType) {
    case 'player': {
      const p = await db.playerProfile.findUnique({
        where: { id: targetId },
        select: { userId: true, bio: true, user: { select: { displayName: true } } },
      });
      if (!p) return missing;
      return { title: p.user.displayName, body: p.bio ?? null, authorUserId: p.userId, authorName: p.user.displayName, hidden: false, link: `/users/${p.userId}` };
    }
    case 'venue_review': {
      const r = await db.venueReview.findUnique({
        where: { id: targetId },
        select: { stars: true, body: true, userId: true, hiddenAt: true, venue: { select: { name: true } }, author: { select: { displayName: true } } },
      });
      if (!r) return missing;
      return {
        title: `${r.stars}★ review of ${r.venue.name}`,
        body: r.body,
        authorUserId: r.userId,
        authorName: r.author.displayName,
        hidden: r.hiddenAt !== null,
        link: `/users/${r.userId}`,
      };
    }
    case 'message': {
      const m = await db.message.findUnique({
        where: { id: targetId },
        select: {
          body: true,
          deletedAt: true,
          sender: { select: { userId: true, user: { select: { displayName: true } } } },
        },
      });
      if (!m) return missing;
      return {
        title: `Chat message from ${m.sender.user.displayName}`,
        // chat R12 — a deleted message keeps its body for staff, and says so.
        body: m.body,
        authorUserId: m.sender.userId,
        authorName: m.sender.user.displayName,
        hidden: m.deletedAt !== null,
        link: `/users/${m.sender.userId}`,
      };
    }
  }
}

const TargetSummaryRef = builder.objectRef<TargetSummary>('ModerationTargetSummary').implement({
  fields: (t) => ({
    title: t.exposeString('title'),
    body: t.string({ nullable: true, resolve: (s) => s.body }),
    authorUserId: t.id({ nullable: true, resolve: (s) => s.authorUserId }),
    authorName: t.string({ nullable: true, resolve: (s) => s.authorName }),
    hidden: t.exposeBoolean('hidden', { description: 'R6 — hidden by reports or a moderator.' }),
    portalPath: t.string({ nullable: true, resolve: (s) => s.link }),
  }),
});

const ModerationReportRef = builder.objectRef<ModerationReport>('ModerationReport').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    targetType: t.field({ type: ReportTargetEnum, resolve: (r) => r.targetType }),
    targetId: t.exposeID('targetId'),
    reason: t.field({ type: ReportReasonEnum, resolve: (r) => r.reason }),
    note: t.string({ nullable: true, resolve: (r) => r.note }),
    status: t.field({ type: ModerationStatusEnum, resolve: (r) => r.status }),
    resolution: t.string({ nullable: true, resolve: (r) => r.resolution }),
    resolvedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.resolvedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    reporterName: t.string({
      resolve: async (r) => (await identity.usersByIds([r.reporterId]))[0]?.displayName ?? 'Unknown',
    }),
  }),
});

const ModerationCaseRef = builder.objectRef<ModerationCase>('ModerationCase').implement({
  fields: (t) => ({
    targetType: t.field({ type: ReportTargetEnum, resolve: (c) => c.targetType }),
    targetId: t.exposeID('targetId'),
    reporterCount: t.exposeInt('reporterCount'),
    firstReportedAt: t.field({ type: 'DateTime', resolve: (c) => c.firstReportedAt }),
    reports: t.field({ type: [ModerationReportRef], resolve: (c) => c.reports }),
    target: t.field({ type: TargetSummaryRef, resolve: (c) => summarise(c.targetType, c.targetId) }),
  }),
});

const ModerationPage = builder
  .objectRef<{ nodes: ModerationCase[]; hasNextPage: boolean }>('ModerationPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [ModerationCaseRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
    }),
  });

const ReportPayload = builder
  .objectRef<{ report: ModerationReport | null; userError: UserErrorShape | null }>('ReportContentPayload')
  .implement({
    fields: (t) => ({
      report: t.field({ type: ModerationReportRef, nullable: true, resolve: (p) => p.report }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ClosedPayload = builder
  .objectRef<{ closed: number | null; userError: UserErrorShape | null }>('AdminClosedPayload')
  .implement({
    fields: (t) => ({
      closed: t.int({ nullable: true, resolve: (p) => p.closed }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- support ---------------------------------------------------------------------------------

const SupportMessageRef = builder.objectRef<SupportMessage>('SupportMessage').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    createdAt: t.field({ type: 'DateTime', resolve: (m) => m.createdAt }),
    fromSupport: t.boolean({
      description: 'True for PL4Y staff; the app shows them as "PL4Y support", never by name.',
      resolve: async (m, _a, ctx) => (await ctx.loaders.platformRole.load(m.authorId)) !== null,
    }),
  }),
});

/** Staff see who wrote it, and internal notes (R7). */
const StaffSupportMessageRef = builder.objectRef<SupportMessage>('StaffSupportMessage').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.exposeString('body'),
    internal: t.exposeBoolean('internal'),
    createdAt: t.field({ type: 'DateTime', resolve: (m) => m.createdAt }),
    authorName: t.string({ resolve: async (m) => (await identity.usersByIds([m.authorId]))[0]?.displayName ?? 'Unknown' }),
    fromSupport: t.boolean({ resolve: async (m, _a, ctx) => (await ctx.loaders.platformRole.load(m.authorId)) !== null }),
  }),
});

const SupportTicketRef = builder.objectRef<SupportTicket>('SupportTicket').implement({
  description: 'admin R7 — a person’s ticket, as they see it. Internal notes are never here.',
  fields: (t) => ({
    id: t.exposeID('id'),
    subject: t.exposeString('subject'),
    status: t.field({ type: TicketStatusEnum, resolve: (k) => k.status }),
    linkedType: t.field({ type: TicketLinkEnum, nullable: true, resolve: (k) => k.linkedType }),
    linkedId: t.id({ nullable: true, resolve: (k) => k.linkedId }),
    createdAt: t.field({ type: 'DateTime', resolve: (k) => k.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (k) => k.updatedAt }),
    messages: t.field({
      type: [SupportMessageRef],
      // R7 — the field-level check: the user-facing thread never includes internal notes.
      resolve: (k) => admin.messages(k.id, { includeInternal: false }),
    }),
  }),
});

const StaffTicketRef = builder.objectRef<SupportTicket>('StaffSupportTicket').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    subject: t.exposeString('subject'),
    status: t.field({ type: TicketStatusEnum, resolve: (k) => k.status }),
    linkedType: t.field({ type: TicketLinkEnum, nullable: true, resolve: (k) => k.linkedType }),
    linkedId: t.id({ nullable: true, resolve: (k) => k.linkedId }),
    requestId: t.string({ nullable: true, resolve: (k) => k.requestId }),
    userId: t.exposeID('userId'),
    userName: t.string({ resolve: async (k) => (await identity.usersByIds([k.userId]))[0]?.displayName ?? 'Unknown' }),
    assignedToName: t.string({
      nullable: true,
      resolve: async (k) => (k.assignedTo ? ((await identity.usersByIds([k.assignedTo]))[0]?.displayName ?? null) : null),
    }),
    firstResponseAt: t.field({ type: 'DateTime', nullable: true, resolve: (k) => k.firstResponseAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (k) => k.createdAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (k) => k.updatedAt }),
    messages: t.field({ type: [StaffSupportMessageRef], resolve: (k) => admin.messages(k.id, { includeInternal: true }) }),
  }),
});

const TicketPage = builder
  .objectRef<{ nodes: SupportTicket[]; hasNextPage: boolean }>('SupportTicketPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [SupportTicketRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
    }),
  });

const StaffTicketPage = builder
  .objectRef<{ nodes: SupportTicket[]; hasNextPage: boolean }>('StaffSupportTicketPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [StaffTicketRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
    }),
  });

const TicketPayload = builder
  .objectRef<{ ticket: SupportTicket | null; userError: UserErrorShape | null }>('SupportTicketPayload')
  .implement({
    fields: (t) => ({
      ticket: t.field({ type: SupportTicketRef, nullable: true, resolve: (p) => p.ticket }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const StaffTicketPayload = builder
  .objectRef<{ ticket: SupportTicket | null; userError: UserErrorShape | null }>('StaffSupportTicketPayload')
  .implement({
    fields: (t) => ({
      ticket: t.field({ type: StaffTicketRef, nullable: true, resolve: (p) => p.ticket }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const SupportTicketInput = builder.inputType('SupportTicketInput', {
  fields: (t) => ({
    subject: t.string({ required: true }),
    body: t.string({ required: true }),
    linkedType: t.field({ type: TicketLinkEnum }),
    linkedId: t.id(),
    requestId: t.string({ description: 'R7 — the last requestId the app saw, so support can trace the call.' }),
  }),
});

// --- fraud -------------------------------------------------------------------------------------

const FraudSubjectEnum = builder.enumType('FraudSubject', {
  values: { USER: { value: 'user' }, ORGANISATION: { value: 'organisation' }, VENUE: { value: 'venue' }, DEVICE: { value: 'device' } } as const,
});

const FraudSignalRef = builder.objectRef<FraudSignal>('FraudSignal').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    detector: t.exposeString('detector'),
    score: t.exposeInt('score'),
    evidence: t.string({ description: 'JSON.', resolve: (s) => JSON.stringify(s.evidence) }),
    outcome: t.string({ nullable: true, resolve: (s) => s.outcome }),
    reviewedAt: t.field({ type: 'DateTime', nullable: true, resolve: (s) => s.reviewedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (s) => s.createdAt }),
  }),
});

const FraudCaseRef = builder.objectRef<FraudCase>('FraudCase').implement({
  description: 'admin R8 — open signals on one subject. Nothing here is a punishment; a person decides.',
  fields: (t) => ({
    subjectType: t.field({ type: FraudSubjectEnum, resolve: (c) => c.subjectType }),
    subjectId: t.exposeID('subjectId'),
    subjectName: t.string({
      nullable: true,
      resolve: async (c) => (c.subjectType === 'user' ? ((await identity.usersByIds([c.subjectId]))[0]?.displayName ?? null) : null),
    }),
    score: t.exposeInt('score'),
    isCase: t.exposeBoolean('isCase', { description: 'At or over the review threshold.' }),
    latestAt: t.field({ type: 'DateTime', resolve: (c) => c.latestAt }),
    signals: t.field({ type: [FraudSignalRef], resolve: (c) => c.signals }),
  }),
});

const FraudPage = builder
  .objectRef<{ nodes: FraudCase[]; hasNextPage: boolean }>('FraudCasePage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [FraudCaseRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
    }),
  });

// --- queries -------------------------------------------------------------------------------------

builder.queryFields((t) => ({
  mySupportTickets: t.field({
    type: TicketPage,
    args: { first: t.arg.int(), offset: t.arg.int() },
    resolve: (_root, args, ctx) =>
      admin.myTickets(requireActor(ctx).userId, { first: clampFirst(args.first, 20), offset: Math.max(args.offset ?? 0, 0) }),
  }),

  supportTicket: t.field({
    type: SupportTicketRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => admin.ticketForUser(requireActor(ctx).userId, String(args.id)),
  }),

  adminModerationQueue: t.field({
    type: ModerationPage,
    args: { status: t.arg({ type: ModerationStatusEnum }), first: t.arg.int(), offset: t.arg.int() },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, ['admin', 'support']);
      return admin.moderationQueue(args.status ?? 'open', {
        first: clampFirst(args.first, 25),
        offset: Math.max(args.offset ?? 0, 0),
      });
    },
  }),

  adminSupportTickets: t.field({
    type: StaffTicketPage,
    args: { status: t.arg({ type: TicketStatusEnum }), search: t.arg.string(), first: t.arg.int(), offset: t.arg.int() },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return admin.ticketQueue(args.status ?? null, {
        first: clampFirst(args.first, 25),
        offset: Math.max(args.offset ?? 0, 0),
        search: args.search,
      });
    },
  }),

  adminSupportTicket: t.field({
    type: StaffTicketRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return admin.ticketById(String(args.id));
    },
  }),

  adminFraudQueue: t.field({
    type: FraudPage,
    args: { reviewed: t.arg.boolean(), first: t.arg.int(), offset: t.arg.int() },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, ['admin', 'finance']);
      return admin.fraudQueue({
        first: clampFirst(args.first, 25),
        offset: Math.max(args.offset ?? 0, 0),
        reviewed: args.reviewed ?? false,
      });
    },
  }),

  adminFraudSignalsFor: t.field({
    type: [FraudSignalRef],
    description: 'Every signal on one person, for their page in the portal.',
    args: { userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return admin.signalsFor('user', String(args.userId));
    },
  }),
}));

// --- mutations -------------------------------------------------------------------------------------

builder.mutationFields((t) => ({
  reportContent: t.field({
    type: ReportPayload,
    description: 'admin R6 — report a player, a venue review or a chat message.',
    args: {
      targetType: t.arg({ type: ReportTargetEnum, required: true }),
      targetId: t.arg.id({ required: true }),
      reason: t.arg({ type: ReportReasonEnum, required: true }),
      note: t.arg.string(),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        admin.report(actor, { targetType: args.targetType, targetId: String(args.targetId), reason: args.reason, note: args.note }),
      );
      return { report: data, userError };
    },
  }),

  openSupportTicket: t.field({
    type: TicketPayload,
    args: { input: t.arg({ type: SupportTicketInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        admin.openTicket(actor, {
          subject: args.input.subject,
          body: args.input.body,
          linkedType: args.input.linkedType ?? null,
          linkedId: args.input.linkedId ? String(args.input.linkedId) : null,
          requestId: args.input.requestId ?? null,
        }),
      );
      return { ticket: data, userError };
    },
  }),

  replySupportTicket: t.field({
    type: TicketPayload,
    args: { ticketId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => admin.replyAsUser(actor, String(args.ticketId), args.body));
      return { ticket: data, userError };
    },
  }),

  adminResolveModeration: t.field({
    type: ClosedPayload,
    description: 'admin R6 — close every open report on a target. Acting on a review keeps it hidden; dismissing shows it.',
    args: {
      targetType: t.arg({ type: ReportTargetEnum, required: true }),
      targetId: t.arg.id({ required: true }),
      outcome: t.arg({ type: ModerationStatusEnum, required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const targetId = String(args.targetId);
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: `moderation.${args.outcome}`, targetType: 'moderation_report', targetId, details: { targetType: args.targetType } },
          args.reason,
          (reason) =>
            admin.resolveReports(staff, {
              targetType: args.targetType,
              targetId,
              outcome: args.outcome === 'actioned' ? 'actioned' : 'dismissed',
              resolution: reason,
            }),
        ),
      );
      return { closed: data?.closed ?? null, userError };
    },
  }),

  adminReplySupportTicket: t.field({
    type: StaffTicketPayload,
    description: 'admin R7 — answer a ticket (the person is told), or add an internal note (nobody is).',
    args: { ticketId: t.arg.id({ required: true }), body: t.arg.string({ required: true }), internal: t.arg.boolean({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx);
      const { data, userError } = await attempt(() =>
        admin.staffReply(staff, String(args.ticketId), { body: args.body, internal: args.internal }),
      );
      return { ticket: data, userError };
    },
  }),

  adminSetSupportTicketStatus: t.field({
    type: StaffTicketPayload,
    args: { ticketId: t.arg.id({ required: true }), status: t.arg({ type: TicketStatusEnum, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const { data, userError } = await attempt(() => admin.setTicketStatus(String(args.ticketId), args.status));
      return { ticket: data, userError };
    },
  }),

  adminAssignSupportTicket: t.field({
    type: StaffTicketPayload,
    description: 'Take a ticket (assign it to yourself), or let it go (toMe false).',
    args: { ticketId: t.arg.id({ required: true }), toMe: t.arg.boolean({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx);
      const { data, userError } = await attempt(() => admin.assignTicket(String(args.ticketId), args.toMe ? staff.userId : null));
      return { ticket: data, userError };
    },
  }),

  adminReviewFraudCase: t.field({
    type: ClosedPayload,
    description: 'admin R8 — mark every open signal on a subject confirmed or dismissed. Suspending is a separate step.',
    args: {
      subjectType: t.arg({ type: FraudSubjectEnum, required: true }),
      subjectId: t.arg.id({ required: true }),
      confirmed: t.arg.boolean({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'finance']);
      const subjectId = String(args.subjectId);
      const outcome = args.confirmed ? 'confirmed' : 'dismissed';
      const { data, userError } = await attempt(() =>
        audited(
          staff,
          { action: `fraud.${outcome}`, targetType: 'fraud_signal', targetId: subjectId, details: { subjectType: args.subjectType } },
          args.reason,
          () => admin.reviewFraudSubject(staff, { subjectType: args.subjectType, subjectId, outcome }),
        ),
      );
      return { closed: data?.reviewed ?? null, userError };
    },
  }),
}));
