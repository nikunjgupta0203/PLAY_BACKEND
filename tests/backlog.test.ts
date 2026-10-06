/**
 * The 2026-10-05 backlog (PLAY_FRONTEND/docs/backlog/remaining-work.md):
 * admin Phase 2 queues (15-admin R6, R7, R8, F26), the audit trail written
 * before the action (15-admin R2), a fresh email code before verified bank
 * details change (gap #25), and host analytics (14-organizers).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import { exists } from './helpers/payouts.js';
import type { Db, Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { isUserError } from '../src/platform/errors/index.js';
import { abandonAudit, beginAudit, settleAudit } from '../src/platform/audit.js';
import { AUTO_HIDE_REPORTERS, createAdminService, RATING_PAIR, type AdminService } from '../src/modules/admin/service/index.js';
import { createPayoutsRepo } from '../src/modules/payments/repo/payouts.js';
import { createPayoutsService, PayoutCode } from '../src/modules/payments/service/payouts.js';
import { createSecretBox } from '../src/platform/crypto/secretBox.js';
import { createRateLimiter } from '../src/platform/rateLimit.js';
import { createAnalyticsService } from '../src/modules/organizers/service/analytics.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let admin: AdminService;
let hidden: Map<string, boolean>;
let supportNotices: { userId: string; ticketId: string }[];
let sportId: string;

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? `THREW: ${String(e)}`;
  }
  return 'NO_ERROR';
};

async function person(name: string): Promise<{ userId: string; playerId: string; email: string }> {
  const userId = newId();
  const email = `${name.toLowerCase()}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email, displayName: name } });
    return modules.profile.createFor(tx as unknown as Tx, userId);
  });
  return { userId, playerId, email };
}

async function venueReview(author: { userId: string }): Promise<string> {
  const venue = await modules.venues.create(author, {
    name: `Court House ${newId().slice(0, 4)}`,
    address: '1 Road',
    city: 'Pune',
    location: { lat: 18.5, lng: 73.8 },
  });
  const id = newId();
  await prisma.venueReview.create({ data: { id, venueId: venue.id, userId: author.userId, stars: 1, body: 'Terrible, avoid' } });
  return id;
}

/** An event with one draw, for the analytics and rating-pair fixtures. */
async function eventWithDraw(organizerId: string, capacity = 8) {
  const eventId = newId();
  const at = new Date(Date.now() - 2 * 86_400_000);
  await prisma.event.create({
    data: {
      id: eventId,
      sportId,
      organizerId,
      slug: `ev-${eventId}`,
      title: 'Backlog Open',
      city: 'Pune',
      startsAt: at,
      endsAt: at,
      registrationClosesAt: at,
      status: 'completed',
    },
  });
  const categoryId = newId();
  await prisma.eventCategory.create({
    data: { id: categoryId, eventId, sportId, name: 'Open singles', format: 'singles', capacity, entryFeePaise: 50_000n, status: 'completed' },
  });
  return { eventId, categoryId };
}

async function entry(draw: { eventId: string; categoryId: string }, userId: string, status = 'confirmed', checkedIn = false) {
  const id = newId();
  await prisma.registration.create({
    data: {
      id,
      eventId: draw.eventId,
      eventCategoryId: draw.categoryId,
      sportId,
      captainUserId: userId,
      status,
      amountPaise: 50_000n,
      ...(checkedIn ? { checkedInAt: new Date() } : {}),
    },
  });
  return id;
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  modules = buildModules(prisma);
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  modules.sport.refresh();
  sportId = await seedSport(prisma, PICKLEBALL);
  modules.sport.refresh();
  hidden = new Map();
  supportNotices = [];
  admin = createAdminService({
    db: prisma as unknown as Db,
    setReviewHidden: async (reviewId, h) => {
      hidden.set(reviewId, h);
      await prisma.venueReview.update({ where: { id: reviewId }, data: { hiddenAt: h ? new Date() : null } });
      return true;
    },
    notifySupportReply: async (userId, ticketId) => {
      supportNotices.push({ userId, ticketId });
    },
  });
});

describe('15-admin R6 — reports', () => {
  it('R6: five distinct reporters hide a venue review until a moderator acts', async () => {
    const author = await person('Author');
    const reviewId = await venueReview(author);
    for (let i = 0; i < AUTO_HIDE_REPORTERS - 1; i++) {
      await admin.report(await person(`R${i}`), { targetType: 'venue_review', targetId: reviewId, reason: 'abuse' });
    }
    expect(hidden.get(reviewId)).toBeUndefined();
    await admin.report(await person('R5'), { targetType: 'venue_review', targetId: reviewId, reason: 'abuse' });
    expect(hidden.get(reviewId)).toBe(true);

    const queue = await admin.moderationQueue('open', { first: 10, offset: 0 });
    expect(queue.nodes).toHaveLength(1);
    expect(queue.nodes[0]!.reporterCount).toBe(AUTO_HIDE_REPORTERS);

    // Dismissing shows it again and closes every report on it.
    const moderator = await person('Mod');
    expect((await admin.resolveReports(moderator, { targetType: 'venue_review', targetId: reviewId, outcome: 'dismissed', resolution: 'Fair review' })).closed).toBe(5);
    expect(hidden.get(reviewId)).toBe(false);
    expect((await admin.moderationQueue('open', { first: 10, offset: 0 })).nodes).toHaveLength(0);
  });

  it('R6: one open report per reporter per target, and nobody reports themselves', async () => {
    const author = await person('Author');
    const reporter = await person('Reporter');
    await admin.report(reporter, { targetType: 'player', targetId: author.playerId, reason: 'fake' });
    expect(await codeOf(() => admin.report(reporter, { targetType: 'player', targetId: author.playerId, reason: 'spam' }))).toBe('REPORT_ALREADY_OPEN');
    expect(await codeOf(() => admin.report(author, { targetType: 'player', targetId: author.playerId, reason: 'spam' }))).toBe('CANNOT_REPORT_SELF');
    expect(await codeOf(() => admin.report(reporter, { targetType: 'player', targetId: newId(), reason: 'spam' }))).toBe('REPORT_TARGET_NOT_FOUND');
  });
});

describe('15-admin R7 — support tickets', () => {
  it('R7: a staff reply reaches the person; internal notes never appear on their side', async () => {
    const player = await person('Player');
    const staff = await person('Support');
    const ticket = await admin.openTicket(player, {
      subject: 'Refund not received',
      body: 'I cancelled on Monday and have not got my money back.',
      linkedType: 'registration',
      linkedId: newId(),
      requestId: 'req-123',
    });
    await admin.staffReply(staff, ticket.id, { body: 'Checked the gateway: refund sent on Tuesday.', internal: true });
    expect(supportNotices).toHaveLength(0);
    const replied = await admin.staffReply(staff, ticket.id, { body: 'Your refund was sent on Tuesday; banks take 5–7 days.', internal: false });
    expect(replied.status).toBe('pending_user');
    expect(replied.firstResponseAt).not.toBeNull();
    expect(supportNotices).toEqual([{ userId: player.userId, ticketId: ticket.id }]);

    const theirs = await admin.messages(ticket.id, { includeInternal: false });
    expect(theirs.map((m) => m.body)).not.toContain('Checked the gateway: refund sent on Tuesday.');
    expect(theirs).toHaveLength(2);
    expect(await admin.messages(ticket.id, { includeInternal: true })).toHaveLength(3);

    // Their reply sends it back to support's queue.
    expect((await admin.replyAsUser(player, ticket.id, 'Thanks, got it.')).status).toBe('open');
    // A stranger cannot read or answer it.
    const stranger = await person('Stranger');
    expect(await admin.ticketForUser(stranger.userId, ticket.id)).toBeNull();
    expect(await codeOf(() => admin.replyAsUser(stranger, ticket.id, 'hi'))).toBe('TICKET_NOT_FOUND');
  });

  it('R7: a closed ticket takes no more replies from the person', async () => {
    const player = await person('Player');
    const ticket = await admin.openTicket(player, { subject: 'App crash', body: 'It crashed.' });
    await admin.setTicketStatus(ticket.id, 'closed');
    expect(await codeOf(() => admin.replyAsUser(player, ticket.id, 'Still crashing'))).toBe('TICKET_CLOSED');
  });
});

describe('15-admin R8 — fraud signals', () => {
  /** One confirmed match between `a` and `b`, in a draw of its own (one entry per person per draw). */
  async function playedMatch(organizerId: string, slot: number, a: string, b: string) {
    const draw = await eventWithDraw(organizerId, 64);
    const tournamentId = newId();
    await prisma.tournament.create({ data: { id: tournamentId, eventId: draw.eventId, eventCategoryId: draw.categoryId, bracketSize: 64 } });
    const ra = await entry(draw, a);
    const rb = await entry(draw, b);
    const matchId = newId();
    await prisma.match.create({
      data: {
        id: matchId,
        tournamentId,
        eventCategoryId: draw.categoryId,
        sportId,
        bracket: 'championship',
        round: 1,
        slot,
        status: 'completed',
        sideARegistrationId: ra,
        sideBRegistrationId: rb,
        winnerRegistrationId: ra,
      },
    });
    await prisma.matchResult.create({
      data: {
        matchId,
        winnerRegistrationId: ra,
        loserRegistrationId: rb,
        games: [{ a: 11, b: 2 }],
        outcome: 'played',
        submittedBy: a,
        submittedAt: new Date(),
        confirmedBy: b,
        confirmedAt: new Date(),
        confirmedVia: 'opponent',
        source: 'typed',
        submitterRole: 'player',
      },
    });
  }

  it('F26: two accounts that only play each other are flagged — once a week, never punished', async () => {
    const host = await person('Host');
    const [x, y, z] = [await person('X'), await person('Y'), await person('Z')];
    for (let i = 0; i < RATING_PAIR.minMatches; i++) await playedMatch(host.userId, i + 1, x.userId, y.userId);
    // Z played X once: not a pair.
    await playedMatch(host.userId, 50, z.userId, x.userId);

    expect(await admin.detectRatingPairs()).toBe(2);
    expect(await admin.detectRatingPairs()).toBe(0);
    const queue = await admin.fraudQueue({ first: 10, offset: 0 });
    expect(queue.nodes.map((c) => c.subjectId).sort()).toEqual([x.userId, y.userId].sort());
    expect(queue.nodes[0]!.signals[0]!.detector).toBe('rating_pair');
    // Nobody was suspended.
    expect((await prisma.user.findUnique({ where: { id: x.userId } }))!.status).toBe('active');

    const staff = await person('Finance');
    await admin.reviewFraudSubject(staff, { subjectType: 'user', subjectId: x.userId, outcome: 'dismissed' });
    expect((await admin.fraudQueue({ first: 10, offset: 0 })).nodes.map((c) => c.subjectId)).toEqual([y.userId]);
    expect(await codeOf(() => admin.reviewFraudSubject(staff, { subjectType: 'user', subjectId: x.userId, outcome: 'dismissed' }))).toBe('NOTHING_TO_REVIEW');
  });
});

describe('15-admin R2 — the audit row is written before the action', () => {
  it('R2: a refused action leaves no row; a crash leaves a pending one; a success is marked', async () => {
    const staff = await person('Admin');
    const conn = prisma as unknown as Db;
    const entry = { actorUserId: staff.userId, action: 'user.suspend', targetType: 'user' as const, targetId: newId(), reason: 'testing' };

    const refused = await beginAudit(conn, entry);
    await abandonAudit(conn, refused);
    expect(await prisma.auditLog.count()).toBe(0);

    const crashed = await beginAudit(conn, entry);
    expect((await prisma.auditLog.findUnique({ where: { id: crashed } }))!.outcome).toBe('pending');

    const done = await beginAudit(conn, entry);
    await settleAudit(conn, done);
    expect((await prisma.auditLog.findUnique({ where: { id: done } }))!.outcome).toBe('succeeded');
    // A settled row is never deleted by a late abandon.
    await abandonAudit(conn, done);
    expect(await prisma.auditLog.count()).toBe(2);
  });
});

describe('gap #25 — a fresh email code before verified bank details change', () => {
  it('gap #25: replacing verified details needs the code emailed to the account owner', async () => {
    const host = await person('Host');
    const provider = modules.payoutProvider;
    const db = prisma as unknown as Db;
    const payouts = createPayoutsService({
      db,
      repo: createPayoutsRepo(db),
      provider,
      box: createSecretBox(Buffer.alloc(32, 9).toString('base64')),
      limiter: createRateLimiter(db),
      jobs: modules.jobs,
      notify: async () => undefined,
      alert: async () => undefined,
      isStaff: async () => false,
      config: { autoThreshold: 80, commissionGstBps: 0, tdsBps: 0, impsMaxPaise: 50_000_000n },
      stepUp: { verify: (userId, code) => modules.identityService.verifyStepUpCode(userId, 'payout_change', code) },
    });
    const RAHUL = { legalName: 'Rahul Sharma', pan: 'ABCPS1234K', accountNumber: '51234567890', ifsc: 'HDFC0001098' };
    const account = await payouts.saveAccount(host, RAHUL);
    provider.checks.push(exists(96));
    await payouts.verifyAccount(account.id);
    expect((await prisma.payoutAccount.findUnique({ where: { id: account.id } }))!.status).toBe('verified');

    const change = { ...RAHUL, accountNumber: '99887766554' };
    expect(await codeOf(() => payouts.saveAccount(host, change))).toBe(PayoutCode.EMAIL_CODE_REQUIRED);
    expect(await codeOf(() => payouts.saveAccount(host, { ...change, emailCode: '000000' }))).toBe(PayoutCode.EMAIL_CODE_INVALID);

    modules.email.reset();
    const { sentTo } = await modules.identityService.requestStepUpCode(host.userId, 'payout_change');
    expect(sentTo).toMatch(/\*\*\*@example\.com$/);
    const mail = modules.email.to(host.email).at(-1)!;
    const code = /\b(\d{6})\b/.exec(mail.text)![1]!;
    const saved = await payouts.saveAccount(host, { ...change, emailCode: code });
    expect(saved.status).toBe('checking');
    // Used once.
    expect(await codeOf(() => payouts.saveAccount(host, { ...change, accountNumber: '11223344556', emailCode: code }))).toBe(
      PayoutCode.EMAIL_CODE_INVALID,
    );
  });

  it('gap #25: a step-up code never signs anyone in', async () => {
    const host = await person('Host');
    modules.email.reset();
    await modules.identityService.requestStepUpCode(host.userId, 'payout_change');
    const code = /\b(\d{6})\b/.exec(modules.email.to(host.email).at(-1)!.text)![1]!;
    expect(await codeOf(() => modules.identityService.verifyOtp(host.email, code))).toBe('OTP_INVALID');
  });
});

describe('14-organizers — host analytics', () => {
  it('counts entries, check-ins and no-shows per draw, and money from the ledger', async () => {
    const host = await person('Host');
    const draw = await eventWithDraw(host.userId, 8);
    const [a, b, c, d] = [await person('A'), await person('B'), await person('C'), await person('D')];
    const ra = await entry(draw, a.userId, 'checked_in', true);
    await entry(draw, b.userId, 'confirmed');
    await entry(draw, c.userId, 'withdrawn');
    await entry(draw, d.userId, 'expired');
    await prisma.ledgerEntry.createMany({
      data: [
        { registrationId: ra, kind: 'charge', amountPaise: 50_000n },
        { registrationId: ra, kind: 'platform_fee', amountPaise: 0n },
        { registrationId: ra, kind: 'refund', amountPaise: -20_000n },
      ],
    });
    const analytics = createAnalyticsService({
      events: {
        byIds: async (ids) =>
          (await prisma.event.findMany({ where: { id: { in: ids } } })).map((e) => ({ id: e.id, title: e.title, slug: e.slug, startsAt: e.startsAt, status: e.status })),
        categoriesFor: async (eventId) => prisma.eventCategory.findMany({ where: { eventId }, select: { id: true, name: true, capacity: true } }),
      },
      registration: { statsForEvents: (ids) => modules.registration.statsForEvents(ids) },
      payments: { ledgerSummary: (ids) => modules.payments.ledgerSummary(ids) },
      eventIdsOfOrganisation: async () => [draw.eventId],
    });
    const e = (await analytics.eventAnalytics(draw.eventId))!;
    expect(e).toMatchObject({ begun: 4, confirmed: 2, capacity: 8, checkedIn: 1, noShows: 1, withdrawn: 1, refunds: 1 });
    expect(e.fillRate).toBeCloseTo(0.25);
    expect(e.grossPaise).toBe(50_000n);
    expect(e.refundedPaise).toBe(20_000n);
    expect(e.netPaise).toBe(30_000n);
    expect(e.byCategory[0]).toMatchObject({ abandoned: 1 });

    const org = await analytics.organisationAnalytics('any', { from: new Date(Date.now() - 30 * 86_400_000), to: new Date() });
    expect(org.totals).toMatchObject({ eventCount: 1, confirmed: 2, netPaise: 30_000n });
  });
});
