/**
 * Wires the module services against a test Postgres.
 *
 * The production singletons in each `index.ts` bind the real db and
 * Cloudinary. Tests build the same services with the same ports, so what is
 * under test is the module and not the composition root.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Db } from '../../src/platform/db.js';
import { createSportService } from '../../src/modules/sport/service/index.js';
import { createProfileService } from '../../src/modules/profile/service/index.js';
import { createVenueRepo } from '../../src/modules/venues/repo/index.js';
import { createVenueService } from '../../src/modules/venues/service/index.js';
import { createEventRepo } from '../../src/modules/events/repo/index.js';
import { createEventService } from '../../src/modules/events/service/index.js';
import { createRegistrationRepo } from '../../src/modules/registration/repo/index.js';
import { createRegistrationService } from '../../src/modules/registration/service/index.js';
import { createPaymentsRepo } from '../../src/modules/payments/repo/index.js';
import { createPaymentsService } from '../../src/modules/payments/service/index.js';
import { createPayoutsRepo } from '../../src/modules/payments/repo/payouts.js';
import { createPayoutsService } from '../../src/modules/payments/service/payouts.js';
import { createSecretBox } from '../../src/platform/crypto/secretBox.js';
import { createRateLimiter } from '../../src/platform/rateLimit.js';
import { FakePayouts } from './payouts.js';
import { createTournamentRepo } from '../../src/modules/tournament/repo/index.js';
import { createTournamentService } from '../../src/modules/tournament/service/index.js';
import { createRatingRepo } from '../../src/modules/rating/repo/index.js';
import {
  createRatingService,
  type ConfirmedResult,
  type RankingRow as RatingRankingRow,
} from '../../src/modules/rating/service/index.js';
import type {
  CheckoutForm,
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  GatewayWebhookEvent,
  PaymentGateway,
} from '../../src/platform/paymentGateway.js';
import { GatewayError } from '../../src/platform/paymentGateway.js';
import type { UploadSignature } from '../../src/platform/cloudinary.js';
import { createIdentityService, highestGrant } from '../../src/modules/identity/service/index.js';
import {
  createOrganisationService,
  type OrganisationService,
  type OrgRole,
} from '../../src/modules/organizers/service/index.js';
import { createScoringRepo } from '../../src/modules/scoring/repo/index.js';
import { createScoringService } from '../../src/modules/scoring/service/index.js';
import { createFieldService } from '../../src/modules/scoring/service/field.js';
import { parseScoringRule, tweakRule, type ScoringRule } from '../../src/modules/sport/service/scoringRule.js';

/** Cloudinary is never called from a test; this records what would have been. */
export class FakeMedia {
  signed: { publicId: string; folder: string }[] = [];
  destroyed: string[] = [];

  avatarFolder(playerId: string): string {
    return `pl4y/avatars/${playerId}`;
  }

  venueRoot(venueId: string): string {
    return `pl4y/venues/${venueId}`;
  }

  eventRoot(eventId: string): string {
    return `pl4y/events/${eventId}`;
  }

  photoFolder(venueId: string, n: number): string {
    return `pl4y/venues/${venueId}/${n}`;
  }

  signUpload(opts: { publicId: string; folder: string }): UploadSignature {
    this.signed.push(opts);
    const now = new Date();
    return {
      cloudName: 'test-cloud',
      apiKey: 'test-key',
      timestamp: Math.floor(now.getTime() / 1000),
      publicId: `${opts.folder}/${opts.publicId}`,
      folder: opts.folder,
      uploadPreset: 'test-preset',
      signature: 'test-signature',
      uploadUrl: 'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
      expiresAt: new Date(now.getTime() + 600_000),
    };
  }

  async destroy(publicId: string): Promise<void> {
    this.destroyed.push(publicId);
  }

  reset(): void {
    this.signed = [];
    this.destroyed = [];
  }
}

/**
 * The tournament module owns `court_assignments`. venues R4 has to be drivable
 * without a bracket — a court retired at 8am has no matches on it yet — so a
 * hand-set assignment still wins here, exactly as a stubbed number does in
 * FakeEntries. Anything nobody stubbed falls through to the real tournament
 * port, so a suite that generates a real draw sees real bookings.
 */
export class FakeSchedule {
  /** courtId -> tournamentIds it is already assigned within. */
  assignments = new Map<string, Set<string>>();
  scheduled = new Set<string>();

  real: {
    assignedCourtIds(input: {
      venueId: string;
      tournamentId: string;
      window: { from: Date; to: Date };
    }): Promise<string[]>;
    courtHasScheduledMatches(courtId: string): Promise<boolean>;
  } | null = null;

  assign(courtId: string, tournamentId: string): void {
    const set = this.assignments.get(courtId) ?? new Set<string>();
    set.add(tournamentId);
    this.assignments.set(courtId, set);
    this.scheduled.add(courtId);
  }

  assignedCourtIds = async (input: {
    venueId: string;
    tournamentId: string;
    window: { from: Date; to: Date };
  }): Promise<string[]> => {
    const stubbed = [...this.assignments.entries()]
      .filter(([, tournaments]) => tournaments.has(input.tournamentId))
      .map(([courtId]) => courtId);
    if (stubbed.length > 0) return stubbed;
    return this.real ? this.real.assignedCourtIds(input) : [];
  };

  courtHasScheduledMatches = async (courtId: string): Promise<boolean> => {
    if (this.scheduled.has(courtId)) return true;
    return this.real ? this.real.courtHasScheduledMatches(courtId) : false;
  };

  reset(): void {
    this.assignments.clear();
    this.scheduled.clear();
  }
}

/**
 * The registration module owns `registrations` and `seat_holds` and lands in
 * Sprint 4. events R2 and R5 are entirely about what these two numbers do to
 * capacity and to frozen fields, so the port is drivable from a test.
 */
export class FakeEntries {
  confirmed = new Map<string, number>();
  holds = new Map<string, number>();
  /** `${eventId}:${userId}` of everyone holding a seat (hosting — contact phone). */
  seated = new Set<string>();

  /**
   * The real counts, wired in by `buildModules` once registration exists.
   *
   * A stubbed number wins, so events tests keep driving capacity by hand; a
   * category nobody stubbed falls through to the database, so registration and
   * payments tests see capacity as production sees it. Overwriting the two
   * methods outright — which is the obvious thing to do once registration is
   * real — silently turns every `entries.confirmed.set()` in events.test.ts
   * into a no-op.
   */
  real: {
    confirmedCount(categoryId: string): Promise<number>;
    liveHoldCount(categoryId: string): Promise<number>;
    participated?(eventId: string, userId: string): Promise<boolean>;
    anyIn?(categoryId: string): Promise<boolean>;
  } | null = null;

  /** F3 — read for real: reports are about real entries. */
  participated = async (eventId: string, userId: string): Promise<boolean> =>
    this.seated.has(`${eventId}:${userId}`) || ((await this.real?.participated?.(eventId, userId)) ?? false);

  /** F19 — read for real. */
  anyIn = async (categoryId: string): Promise<boolean> => (await this.real?.anyIn?.(categoryId)) ?? false;

  confirmedCount = async (categoryId: string): Promise<number> => {
    const stubbed = this.confirmed.get(categoryId);
    if (stubbed !== undefined) return stubbed;
    return this.real ? this.real.confirmedCount(categoryId) : 0;
  };

  isSeatedEntrant = async (eventId: string, userId: string): Promise<boolean> =>
    this.seated.has(`${eventId}:${userId}`);

  liveHoldCount = async (categoryId: string): Promise<number> => {
    const stubbed = this.holds.get(categoryId);
    if (stubbed !== undefined) return stubbed;
    return this.real ? this.real.liveHoldCount(categoryId) : 0;
  };

  reset(): void {
    this.confirmed.clear();
    this.holds.clear();
    this.seated.clear();
  }
}

/** Records what would have been emailed. Nothing leaves the test process. */
export class FakeEmail {
  sent: { to: string; subject: string; text: string }[] = [];

  async send(msg: { to: string; subject: string; text: string }): Promise<{ messageId: null }> {
    this.sent.push(msg);
    return { messageId: null };
  }

  to(address: string): { to: string; subject: string; text: string }[] {
    return this.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase());
  }

  reset(): void {
    this.sent = [];
  }
}

/**
 * The payment gateway, as a fixture. Contract tests drive this rather than the
 * network. Its webhook wire format is the normalised event itself, serialised
 * with bigints as strings and signed with an HMAC over the raw bytes, which is
 * enough to keep R2 (verify the exact bytes) under test.
 */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake';
  orders = new Map<string, GatewayOrder>();
  paymentsByOrder = new Map<string, GatewayPayment[]>();
  refunds: GatewayRefund[] = [];
  statuses = new Map<string, GatewayRefund['status']>();
  /** Set to make the next call throw, so GATEWAY_UNAVAILABLE is reachable. */
  failNext = false;
  /** Set to make the next checkoutForm throw a GatewayError (a provider misconfig). */
  failCheckoutNext = false;
  /** How many times refundStatus was asked — an unknown refund must never reach it. */
  refundStatusCalls = 0;
  private seq = 0;

  checkoutForm(input: {
    gatewayOrderId: string;
    amountPaise: bigint;
    receipt: string;
    payer: { name: string; email: string; phone: string | null };
    description: string;
  }): CheckoutForm {
    if (this.failCheckoutNext) {
      this.failCheckoutNext = false;
      throw new GatewayError(503, 'checkout form unavailable');
    }
    return {
      action: 'https://gateway.test/checkout',
      fields: {
        order_id: input.gatewayOrderId,
        amount: input.amountPaise.toString(),
        receipt: input.receipt,
        prefill_name: input.payer.name,
        prefill_email: input.payer.email,
        description: input.description,
      },
    };
  }

  async refundStatus(gatewayRefundId: string): Promise<GatewayRefund> {
    this.refundStatusCalls += 1;
    const r = this.refunds.find((x) => x.id === gatewayRefundId);
    if (!r) return { id: gatewayRefundId, paymentId: '', amountPaise: 0n, status: 'pending' };
    return { ...r, status: this.statuses.get(gatewayRefundId) ?? r.status };
  }

  async createOrder(input: { amountPaise: bigint; currency: string }): Promise<GatewayOrder> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('gateway is down');
    }
    this.seq += 1;
    const order: GatewayOrder = {
      id: `order_TEST${this.seq}`,
      amountPaise: input.amountPaise,
      currency: input.currency,
      status: 'created',
    };
    this.orders.set(order.id, order);
    return order;
  }

  async paymentsForOrder(orderId: string): Promise<GatewayPayment[]> {
    return this.paymentsByOrder.get(orderId) ?? [];
  }

  async refund(input: {
    paymentId: string;
    amountPaise: bigint;
    idempotencyKey: string;
  }): Promise<GatewayRefund> {
    // Real gateways dedupe on the idempotency key; so does this.
    const id = `rfnd_${input.idempotencyKey.slice(0, 8)}`;
    const existing = this.refunds.find((r) => r.id === id);
    if (existing) return existing;
    const refund: GatewayRefund = {
      id,
      paymentId: input.paymentId,
      amountPaise: input.amountPaise,
      status: 'processed',
    };
    this.refunds.push(refund);
    return refund;
  }

  parseWebhook(
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): GatewayWebhookEvent | null {
    const signature = headers[TEST_SIGNATURE_HEADER];
    if (typeof signature !== 'string' || !signature) return null;
    const expected = Buffer.from(signWebhook(raw), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

    let body: { id?: unknown; type?: unknown };
    try {
      body = JSON.parse(raw.toString('utf8')) as { id?: unknown; type?: unknown };
    } catch {
      return null;
    }
    if (typeof body.id !== 'string' || typeof body.type !== 'string') return null;
    if (!KNOWN_TYPES.has(body.type)) {
      return { id: body.id, type: 'ignored', providerType: body.type };
    }
    // Amounts arrive as strings; the service's stored form is the same shape.
    return body as unknown as GatewayWebhookEvent;
  }

  /** Builds the payment the gateway would report as captured. */
  capture(orderId: string, overrides: Partial<GatewayPayment> = {}): GatewayPayment {
    const order = this.orders.get(orderId);
    const id = overrides.id ?? `pay_TEST${this.paymentsByOrder.size + 1}`;
    const payment: GatewayPayment = {
      id,
      orderId,
      amountPaise: order?.amountPaise ?? 0n,
      status: 'captured',
      method: 'upi',
      failureReason: null,
      capturedAt: new Date(),
      raw: { id, order_id: orderId, status: 'captured', method: overrides.method ?? 'upi' },
      ...overrides,
    };
    this.paymentsByOrder.set(orderId, [payment]);
    return payment;
  }

  fail(orderId: string, reason = 'insufficient funds'): GatewayPayment {
    const order = this.orders.get(orderId);
    const id = `pay_FAIL${this.paymentsByOrder.size + 1}`;
    const payment: GatewayPayment = {
      id,
      orderId,
      amountPaise: order?.amountPaise ?? 0n,
      status: 'failed',
      method: 'upi',
      failureReason: reason,
      capturedAt: null,
      raw: { id, order_id: orderId, status: 'failed', error_description: reason },
    };
    this.paymentsByOrder.set(orderId, [payment]);
    return payment;
  }

  reset(): void {
    this.orders.clear();
    this.paymentsByOrder.clear();
    this.refunds = [];
    this.statuses.clear();
    this.failNext = false;
    this.failCheckoutNext = false;
    this.refundStatusCalls = 0;
    this.seq = 0;
  }
}

const KNOWN_TYPES = new Set([
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
  'refund.check',
  'payment.check',
]);

/** The header FakeGateway reads its signature from. */
export const TEST_SIGNATURE_HEADER = 'x-test-signature';

export function signWebhook(raw: Buffer): string {
  return createHmac('sha256', TEST_WEBHOOK_SECRET).update(raw).digest('hex');
}

/**
 * A webhook event in the JSON form it travels and is stored in: bigints as
 * strings. Use it for a wire body, or to write a claim row by hand.
 */
export function webhookBody(event: { id: string; type: string; [k: string]: unknown }): object {
  return JSON.parse(
    JSON.stringify(event, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as object;
}

/**
 * The job queue, as a list. Tests run the job bodies themselves, which is the only way
 * to assert that ingest did NOT do the work on the request path (payments R4).
 */
export class FakeQueue {
  applyWebhookCalls: string[] = [];
  processRefundCalls: string[] = [];

  async applyWebhook(gatewayEventId: string): Promise<void> {
    this.applyWebhookCalls.push(gatewayEventId);
  }

  async processRefund(refundId: string): Promise<void> {
    this.processRefundCalls.push(refundId);
  }

  /** Generic jobs recorded by the payouts port. */
  added: { name: string; id: string; delayMs: number }[] = [];
  async verifyAccount(accountId: string, delayMs: number): Promise<void> {
    this.added.push({ name: 'verify-payout-account', id: accountId, delayMs });
  }
  async checkPayout(payoutId: string, delayMs: number): Promise<void> {
    this.added.push({ name: 'check-payout', id: payoutId, delayMs });
  }

  reset(): void {
    this.applyWebhookCalls = [];
    this.processRefundCalls = [];
    this.added = [];
  }
}

/**
 * `scoring` lands in Sprint 8, and `rating` is built in Sprint 6 on purpose.
 * The doc says to develop it against confirmed match results produced without
 * the live-scoring path, and this is that fixture: tests hand it results
 * directly, exactly as scoring will once it exists.
 */
export class FakeMatches {
  results: ConfirmedResult[] = [];

  add(result: ConfirmedResult): ConfirmedResult {
    this.results.push(result);
    return result;
  }

  async confirmedResult(matchId: string): Promise<ConfirmedResult | null> {
    return this.results.find((r) => r.matchId === matchId) ?? null;
  }

  async confirmedBetween(sportId: string, from: Date, to: Date): Promise<ConfirmedResult[]> {
    return this.results
      .filter(
        (r) => r.sportId === sportId && r.confirmedAt >= from && r.confirmedAt < to,
      )
      .sort((a, b) => a.confirmedAt.getTime() - b.confirmedAt.getTime());
  }

  reset(): void {
    this.results = [];
  }
}

/** The leaderboard's optional board cache, in a Map. */
export class FakeBoardCache {
  entries = new Map<string, RatingRankingRow[]>();

  async put(key: string, rows: RatingRankingRow[]): Promise<void> {
    this.entries.set(key, rows);
  }

  async get(key: string): Promise<RatingRankingRow[] | null> {
    return this.entries.get(key) ?? null;
  }

  async drop(key: string): Promise<void> {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }
}

/** registration R13 — the key the test check-in QRs are signed with. */
export const TEST_CHECKIN_SECRET = 'checkin_test_secret';

/** The webhook secret the fixtures below are signed with. */
export const TEST_WEBHOOK_SECRET = 'whsec_test_gateway';

/**
 * The real UsersPort reads `users`, which identity owns. Wiring the actual
 * queries here rather than a stub keeps profile's cross-module edge honest:
 * if identity renames a column, this breaks.
 */
export function usersPortFor(prisma: PrismaClient) {
  return {
    async byIds(ids: string[]) {
      if (ids.length === 0) return [];
      return prisma.user.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, displayName: true, avatarPublicId: true },
      });
    },
    async setAvatar(userId: string, publicId: string | null) {
      await prisma.user.update({ where: { id: userId }, data: { avatarPublicId: publicId } });
    },
    async setDisplayName(userId: string, displayName: string) {
      await prisma.user.update({ where: { id: userId }, data: { displayName } });
    },
  };
}

/**
 * The contact port registration and payments use to send mail. Wired against
 * the real `users` table rather than a stub: if identity renames a column, this
 * breaks, which is the point.
 */
export function contactsPortFor(prisma: PrismaClient) {
  return {
    async byIds(ids: string[]) {
      if (ids.length === 0) return [];
      const rows = await prisma.user.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, displayName: true, email: true, phoneE164: true },
      });
      return rows.map(({ phoneE164, ...r }) => ({ ...r, phone: phoneE164 }));
    },
    async findByEmail(address: string) {
      return prisma.user.findUnique({
        where: { email: address.trim().toLowerCase() },
        select: { id: true, displayName: true },
      });
    },
  };
}

/** Grants live in `event_staff`, which identity owns. Read them for real. */
export function identityPortFor(prisma: PrismaClient) {
  return {
    async grantsFor(userId: string, eventId: string) {
      // identity R16 — direct and organizer rows resolve to the higher role.
      return highestGrant(await prisma.eventStaff.findMany({ where: { eventId, userId } }));
    },
    async grantsForUser(userId: string) {
      const rows = await prisma.eventStaff.findMany({ where: { userId } });
      const byEvent = new Map<string, typeof rows>();
      for (const row of rows) byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row]);
      return [...byEvent.values()].map((r) => highestGrant(r)!);
    },
    async addStaff(eventId: string, userId: string, role: string) {
      return prisma.eventStaff.upsert({
        where: { eventId_userId_source: { eventId, userId, source: 'direct' } },
        create: { eventId, userId, role, source: 'direct' },
        update: { role },
      });
    },
    async removeStaff(eventId: string, userId: string) {
      await prisma.eventStaff.deleteMany({ where: { eventId, userId, source: 'direct' } });
    },
    async staffFor(eventId: string) {
      const rows = await prisma.eventStaff.findMany({ where: { eventId } });
      const byUser = new Map<string, typeof rows>();
      for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
      return [...byUser.values()].map((r) => {
        const best = highestGrant(r)!;
        return { userId: best.userId, role: best.role };
      });
    },
    async findByEmail(address: string) {
      return prisma.user.findUnique({
        where: { email: address.trim().toLowerCase() },
        select: { id: true, displayName: true },
      });
    },
  };
}

export function buildModules(prisma: PrismaClient) {
  const db = prisma as unknown as Db;
  const sport = createSportService({ db });
  const media = new FakeMedia();
  const profile = createProfileService({
    db,
    sport,
    users: usersPortFor(prisma),
    media,
  });

  const schedule = new FakeSchedule();
  const venues = createVenueService({ repo: createVenueRepo(db), schedule, media });

  const entries = new FakeEntries();
  // org — built after payouts (below); events reaches it through this binding.
  const late: { organisations?: OrganisationService } = {};
  const eventDeps = {
    db,
    repo: createEventRepo(db),
    sport,
    identity: identityPortFor(prisma),
    entries,
    media,
    organisations: {
      forHosting: (organisationId: string, userId: string, opts?: { staff?: boolean }) =>
        late.organisations!.forHosting(organisationId, userId, opts),
      syncEventGrants: (tx: Parameters<OrganisationService['syncEventGrants']>[0], organisationId: string, eventId: string) =>
        late.organisations!.syncEventGrants(tx, organisationId, eventId),
      isSuspended: async (organisationId: string) =>
        (await late.organisations!.findById(organisationId))?.verification === 'suspended',
    },
    venues: {
      async findById(venueId: string) {
        const venue = await venues.findById(venueId);
        return venue ? { id: venue.id, city: venue.city, location: venue.location } : null;
      },
      courtsForEvent: (eventId: string) => venues.courtsForEvent(eventId),
      addEventCourt: (eventId: string, input: { name: string; sportIds: string[] }) => venues.addEventCourt(eventId, input),
      retireEventCourt: (eventId: string, courtId: string) => venues.retireEventCourt(eventId, courtId),
    },
    rules: {
      async defaultFor(sportId: string, formatKey: string) {
        const format = (await sport.formatsFor(sportId)).find((f) => f.key === formatKey);
        return sport.scoringRuleFor(sportId, format?.id);
      },
      tweak: (rule: unknown, tweaks: Parameters<typeof tweakRule>[1]) => tweakRule(rule as ScoringRule, tweaks),
    },
  };
  const events = createEventService(eventDeps);

  const email = new FakeEmail();
  const gateway = new FakeGateway();
  const jobs = new FakeQueue();
  const paymentAlerts: string[] = [];

  // registration and payments call each other. In production both edges resolve
  // lazily through index.ts; here the services are built in order and the two
  // late bindings are patched in below, which keeps the wiring visible rather
  // than hidden behind a dynamic import.
  const registration = createRegistrationService({
    db,
    repo: createRegistrationRepo(db),
    events: {
      byId: async (eventId: string) => {
        const e = await events.byId(eventId);
        return {
          id: e.id,
          startsAt: e.startsAt,
          cancellationCutoffAt: e.cancellationCutoffAt,
          status: e.status,
          endsAt: e.endsAt,
          termsChangedAt: e.termsChangedAt,
          refundPolicy: e.refundPolicy,
        };
      },
      locationOf: (eventId: string) => events.locationOf(eventId),
      forEmail: async (eventId: string) => {
        const e = await events.byId(eventId);
        return { title: e.title, startsAt: e.startsAt, timezone: e.timezone, place: e.city };
      },
      categoryById: (categoryId: string) => events.categoryById(categoryId),
      priceQuote: (categoryId: string) => events.priceQuote(categoryId),
      assertRegistrationOpen: (categoryId: string) =>
        events.assertRegistrationOpen(categoryId),
      refreshCategoryFullness: (categoryId: string) =>
        events.refreshCategoryFullness(categoryId),
      assertStaff: (actor, eventId, roles) => events.assertStaff(actor, eventId, roles),
    },
    profile: {
      assertHasSport: (playerId: string) => profile.assertHasSport(playerId),
      findByUserId: async (userId: string) => {
        const found = await profile.findByUserId(userId);
        return found
          ? {
              id: found.id,
              sports: found.sports.map((sp) => ({
                sportId: sp.sportId,
                skillBand: sp.skillBand,
              })),
            }
          : null;
      },
      userIdForPlayer: async (playerId: string) => {
        // I1 — a private profile must not be distinguishable from a missing
        // one (profile R4).
        const p = await profile.findById(playerId);
        return p && p.visibility !== 'private' ? p.userId : null;
      },
    },
    sport: { skillBandsFor: (sportId: string) => sport.skillBandsFor(sportId) },
    users: {
      ...contactsPortFor(prisma),
      async createGuest(displayName: string) {
        const id = crypto.randomUUID();
        await prisma.user.create({
          data: { id, email: `guest-${id}@guest.pl4y.invalid`, displayName, isGuest: true },
        });
        return { id };
      },
    },
    payments: {
      async refundForRegistration(input) {
        await paymentsService.refundForRegistration(input);
      },
    },
    email,
    holdTtlSeconds: 600,
    inviteTtlSeconds: 48 * 3600,
    checkinWindowMs: 2 * 3_600_000,
    waitlistOfferTtlSeconds: 30 * 60,
    checkinKeys: { currentKeyId: 'k1', secrets: { k1: TEST_CHECKIN_SECRET } },
  });

  const paymentsService = createPaymentsService({
    db,
    repo: createPaymentsRepo(db),
    gateway,
    events: {
      priceQuote: (categoryId: string) => events.priceQuote(categoryId),
      byId: async (eventId: string) => {
        const e = await events.byId(eventId);
        return { id: e.id, title: e.title };
      },
      forEmail: async (eventId: string) => {
        const e = await events.byId(eventId);
        return { title: e.title, startsAt: e.startsAt, timezone: e.timezone, place: e.city };
      },
    },
    registration: {
      byId: async (registrationId: string) => {
        const r = await registration.byId(registrationId);
        return {
          id: r.id,
          eventId: r.eventId,
          eventCategoryId: r.eventCategoryId,
          captainUserId: r.captainUserId,
          status: r.status,
          amountPaise: r.amountPaise,
          holdExpiresAt: r.holdExpiresAt,
        };
      },
      extendHold: (registrationId: string, minutes: number) =>
        registration.extendHold(registrationId, minutes),
      confirmFromPayment: (input) => registration.confirmFromPayment(input),
      failFromPayment: (input) => registration.failFromPayment(input),
    },
    users: contactsPortFor(prisma),
    email,
    queue: jobs,
    alert: async (subject: string) => {
      paymentAlerts.push(subject);
    },
  });

  const payoutProvider = new FakePayouts();
  const payoutNotices: { userId: string; key: string; payload: Record<string, string | null> }[] = [];
  const payoutAlerts: string[] = [];
  const payoutsService = createPayoutsService({
    db,
    repo: createPayoutsRepo(db),
    provider: payoutProvider,
    box: createSecretBox(Buffer.alloc(32, 9).toString('base64')),
    limiter: createRateLimiter(db),
    jobs,
    notify: async (userId, key, payload) => {
      payoutNotices.push({ userId, key, payload });
    },
    alert: async (subject) => {
      payoutAlerts.push(subject);
    },
    isStaff: async (userId) => (await prisma.platformStaff.findUnique({ where: { userId } })) !== null,
    config: { autoThreshold: 80, commissionGstBps: 0, tdsBps: 0, impsMaxPaise: 50_000_000n },
    // F3 — the same signals production reads, from the same tables.
    async reviewSignals(eventId: string) {
      const [startedMatches, checkIns, reports] = await Promise.all([
        prisma.match.count({
          where: {
            tournament: { eventId },
            OR: [{ status: { in: ['live', 'awaiting_confirm', 'completed'] } }, { scoreSeq: { gt: 0 } }],
          },
        }),
        prisma.registration.count({ where: { eventId, status: 'checked_in' } }),
        events.openReports(eventId),
      ]);
      return { startedMatches, checkIns, openReports: reports.count, latestReportAt: reports.latestAt };
    },
  });

  // org — the real identity service writes organizer grants (identity R16).
  const identityService = createIdentityService({
    db,
    email,
    limiter: { consumeAll: async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }) },
    profile,
  });
  const organisationNotices: { userId: string; organisationId: string; change: string; role: OrgRole | null }[] = [];
  const organisationInvites: { to: string; organisationId: string; role: OrgRole }[] = [];
  const organisations = createOrganisationService({
    db,
    identity: {
      findByEmail: (address) => identityService.findByEmail(address),
      syncOrganizerGrants: (tx, input) => identityService.syncOrganizerGrants(tx, input),
    },
    notify: async (userId, organisation, change, role) => {
      organisationNotices.push({ userId, organisationId: organisation.id, change, role });
    },
    sendInvite: async (to, organisation, role) => {
      organisationInvites.push({ to, organisationId: organisation.id, role });
    },
    payouts: payoutsService,
  });
  late.organisations = organisations;
  identityService.registerSignInHook((user) => organisations.claimInvites(user).then(() => undefined));

  // events R5 — the real counts, so capacity in a suite that drives real
  // registrations means what it means in production. A suite that stubs a
  // category's numbers still wins; see FakeEntries.
  entries.real = registration.entries;

  const results = new FakeMatches();
  const boardCache = new FakeBoardCache();
  const rating = createRatingService({
    db,
    repo: createRatingRepo(db),
    matches: results,
    profile: {
      applyRating: (playerId, sportId, values) =>
        profile.applyRating(playerId, sportId, values),
      async cityOf(playerId: string) {
        const found = await profile.findById(playerId);
        return found?.city ?? null;
      },
    },
    cache: boardCache,
  });

  const tournament = createTournamentService({
    db,
    repo: createTournamentRepo(db),
    events: {
      byId: async (eventId: string) => {
        const e = await events.byId(eventId);
        return {
          id: e.id,
          sportId: e.sportId,
          venueId: e.venueId,
          startsAt: e.startsAt,
          status: e.status,
          organizerId: e.organizerId,
        };
      },
      categoryById: async (categoryId: string) => {
        const c = await events.categoryById(categoryId);
        return {
          id: c.id,
          eventId: c.eventId,
          sportId: c.sportId,
          name: c.name,
          drawType: c.drawType,
          minEntries: c.minEntries,
          status: c.status,
          thirdPlace: c.thirdPlace,
          matchMinutes: c.matchMinutes,
        };
      },
      assertStaff: (actor, eventId, roles) => events.assertStaff(actor, eventId, roles),
      markCategoryDrawn: (categoryId, tx) => events.markCategoryDrawn(categoryId, tx),
      markCategoryCompleted: (categoryId, tx) => events.markCategoryCompleted(categoryId, tx),
      heldSeats: async (categoryId: string) => (await events.capacityOf(categoryId)).held,
    },
    registrations: {
      confirmedForCategory: async (categoryId: string) =>
        (await registration.confirmedForCategory(categoryId)).map((r) => ({
          id: r.id,
          captainUserId: r.captainUserId,
          confirmedAt: r.confirmedAt,
          createdAt: r.createdAt,
        })),
      membersOf: async (registrationId: string) => {
        const team = await registration.teamFor(registrationId);
        if (team.length > 0) return team.map((m) => m.userId);
        const found = await registration.findById(registrationId);
        return found ? [found.captainUserId] : [];
      },
      applySeeds: (tx, seeds) => registration.applySeeds(tx, seeds),
      seedOf: async (registrationId) => (await registration.findById(registrationId))?.seed ?? null,
    },
    ratings: {
      async settledFor(userId: string, sportId: string) {
        const player = await profile.findByUserId(userId);
        if (!player) return null;
        const found = await rating.ratingFor(player.id, sportId);
        return found.provisional ? null : found.rating;
      },
    },
    courts: {
      forVenue: (venueId: string) => venues.courtsFor(venueId),
      forEvent: (eventId: string) => venues.courtsForEvent(eventId),
      venueOwner: async (venueId: string) => (await venues.findById(venueId))?.createdBy ?? null,
    },
  });

  // venues R4 — the real bookings, so a suite that generates a draw sees what
  // production sees. A hand-set assignment still wins; see FakeSchedule.
  schedule.real = tournament.courts;

  const identity = identityPortFor(prisma);
  // scoring's `now` is a handle the suite can move, so the 15-minute override
  // (scoring R6) is tested without sleeping.
  const clock = { offsetMs: 0 };
  const scoring = createScoringService({
    db,
    repo: createScoringRepo(db),
    // Fixture events start weeks out; scoring them is the point of these tests.
    startOpensBeforeMs: Number.POSITIVE_INFINITY,
    matches: {
      async byId(matchId) {
        const match = await tournament.matchById(matchId).catch(() => null);
        if (!match) return null;
        const draw = await tournament.byId(match.tournamentId);
        const event = await events.byId(draw.eventId);
        return {
          id: match.id,
          tournamentId: match.tournamentId,
          eventId: draw.eventId,
          eventCategoryId: match.eventCategoryId,
          sportId: match.sportId,
          status: match.status,
          bracket: match.bracket,
          eventEndsAt: event.endsAt,
          sideARegistrationId: match.sideARegistrationId,
          sideBRegistrationId: match.sideBRegistrationId,
          eventStatus: event.status,
          scheduledAt: match.scheduledAt,
          eventStartsAt: event.startsAt,
        };
      },
      markLive: (matchId, tx) => tournament.markLive(matchId, tx),
      markAwaitingConfirm: (matchId, tx) => tournament.markAwaitingConfirm(matchId, tx),
      reopen: (matchId, tx) => tournament.reopen(matchId, tx),
      advance: (matchId, outcome, tx) => tournament.advance(matchId, outcome, tx),
      correct: (matchId, outcome, tx) => tournament.correct(matchId, outcome, tx),
    },
    async ruleFor(eventCategoryId) {
      const category = await events.categoryById(eventCategoryId);
      if (category.scoringRule) return parseScoringRule(category.scoringRule);
      const format = (await sport.formatsFor(category.sportId)).find(
        (f) => f.key === category.format,
      );
      return sport.scoringRuleFor(category.sportId, format?.id);
    },
    async roleOn(userId, eventId) {
      const grant = await identity.grantsFor(userId, eventId);
      return (grant?.role ?? null) as 'owner' | 'manager' | 'scorer' | null;
    },
    async membersOf(registrationId) {
      const team = await registration.teamFor(registrationId);
      if (team.length > 0) return team.map((m) => m.userId);
      const found = await registration.findById(registrationId);
      return found ? [found.captainUserId] : [];
    },
    async checkedIn(registrationId) {
      return (await registration.findById(registrationId))?.status === 'checked_in';
    },
    staffOf: (eventId) => identity.staffFor(eventId),
    now: () => new Date(Date.now() + clock.offsetMs),
  });

  const field = createFieldService({
    db,
    async ruleFor(eventCategoryId) {
      const category = await events.categoryById(eventCategoryId);
      const format = (await sport.formatsFor(category.sportId)).find((f) => f.key === category.format);
      return sport.scoringRuleFor(category.sportId, format?.id);
    },
    async eventOf(eventCategoryId) {
      return (await events.categoryById(eventCategoryId)).eventId;
    },
    async roleOn(userId, eventId) {
      const grant = await identity.grantsFor(userId, eventId);
      return (grant?.role ?? null) as 'owner' | 'manager' | 'scorer' | null;
    },
    async confirmedEntries(eventCategoryId) {
      return (await registration.confirmedForCategory(eventCategoryId)).map((r) => r.id);
    },
    async categoryStatus(eventCategoryId) {
      return (await events.categoryById(eventCategoryId)).status;
    },
    markCategoryCompleted: (eventCategoryId, tx) => events.markCategoryCompleted(eventCategoryId, tx),
  });

  return {
    scoring,
    field,
    clock,
    identity,
    db,
    sport,
    profile,
    media,
    venues,
    schedule,
    events,
    /** The same ports, for a test that needs a differently-gated events service. */
    eventDeps,
    entries,
    registration,
    payments: paymentsService,
    payouts: payoutsService,
    organisations,
    identityService,
    organisationNotices,
    organisationInvites,
    payoutProvider,
    payoutNotices,
    payoutAlerts,
    paymentAlerts,
    rating,
    tournament,
    results,
    boardCache,
    email,
    gateway,
    jobs,
  };
}

/**
 * gap #6, #32 — a draw (or heats) is made once registration has closed. Most
 * suites are about the bracket, not the deadline, so this closes the
 * category first, the way an organizer's "close registration now" would,
 * without the minimum-entry cancellation that is tested on its own.
 */
export function closeBeforeDrawing<
  T extends { generateDraw(actor: { userId: string }, input: { eventCategoryId: string }): Promise<unknown> },
>(service: T, prisma: PrismaClient): T {
  const close = (categoryId: string) =>
    prisma.eventCategory.updateMany({
      where: { id: categoryId, status: { in: ['open', 'full'] } },
      data: { status: 'closed' },
    });
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop === 'generateDraw') {
        return async (actor: { userId: string }, input: { eventCategoryId: string }) => {
          await close(input.eventCategoryId);
          return target.generateDraw(actor, input);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

export function closeBeforeHeats<
  T extends {
    createHeat(actor: { userId: string }, input: { eventCategoryId: string; name: string }): Promise<unknown>;
    createHeats(actor: { userId: string }, input: { eventCategoryId: string; count: number }): Promise<unknown>;
  },
>(service: T, prisma: PrismaClient): T {
  const close = (categoryId: string) =>
    prisma.eventCategory.updateMany({
      where: { id: categoryId, status: { in: ['open', 'full'] } },
      data: { status: 'closed' },
    });
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop === 'createHeat' || prop === 'createHeats') {
        return async (actor: { userId: string }, input: { eventCategoryId: string }) => {
          await close(input.eventCategoryId);
          return (target[prop] as (a: unknown, i: unknown) => Promise<unknown>)(actor, input);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
