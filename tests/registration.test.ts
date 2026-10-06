/**
 * registration — service tests against a real Postgres (conventions.md §5).
 *
 * The module doc says: start by writing the two tests in "Done when", not the
 * resolvers. They are the first two `describe` blocks below, and they are the
 * reason a mocked database is banned here — both of them are assertions about
 * what Postgres does under `FOR UPDATE` and under a unique partial index.
 *
 * Every numbered rule has at least one test that names it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import {
  buildModules,
  TEST_CHECKIN_SECRET,
  webhookBody,
  type FakeEmail,
  type FakeGateway,
} from './helpers/modules.js';
import {
  checkinTokenHash,
  signCheckinToken,
} from '../src/modules/registration/service/checkinToken.js';
import type { EventService } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import { maskEmail, RegistrationCode } from '../src/modules/registration/service/index.js';
import { canTransition } from '../src/modules/registration/service/transitions.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { BASKETBALL, PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let registration: RegistrationService;
let payments: PaymentsService;
let events: EventService;
let profile: ProfileService;
let sport: SportService;
let email: FakeEmail;
let gateway: FakeGateway;
let pickleballId: string;

const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);

interface Player {
  userId: string;
  playerId: string;
  email: string;
  actor: { userId: string };
}

let organizer: Player;

async function makePlayer(name: string, band = '3.5'): Promise<Player> {
  const userId = newId();
  const address = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({
    data: { playerId, sportId: pickleballId, skillBand: band },
  });
  return { userId, playerId, email: address, actor: { userId } };
}

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? 'THREW';
  }
  return 'NO_ERROR';
};

/** A published event with one category. Returns the category id. */
async function publishedCategory(
  overrides: {
    capacity?: number;
    format?: string;
    sportId?: string;
    minEntries?: number;
    skillMin?: number | null;
    skillMax?: number | null;
    registrationClosesAt?: Date;
    cancellationCutoffAt?: Date | null;
    startsAt?: Date;
    entryFeePaise?: bigint;
    platformFeePaise?: bigint;
  } = {},
): Promise<{ eventId: string; categoryId: string }> {
  // Every window is derived from startsAt. Fixed defaults look harmless until a
  // test moves the start date forward and publish refuses the event for a
  // reason that has nothing to do with what the test is about (events R1).
  const startsAt = overrides.startsAt ?? soon(30);
  const event = await events.create(organizer.actor, {
    sportId: overrides.sportId ?? pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `Open ${newId().slice(0, 8)}`,
    city: 'Bengaluru',
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    // Publish refuses a deadline already past (gap #10); a test about a passed
    // deadline gets it set after publishing, below.
    registrationClosesAt:
      overrides.registrationClosesAt && overrides.registrationClosesAt > new Date()
        ? overrides.registrationClosesAt
        : new Date(startsAt.getTime() - DAY),
    cancellationCutoffAt:
      overrides.cancellationCutoffAt === undefined
        ? new Date(startsAt.getTime() - 2 * DAY)
        : overrides.cancellationCutoffAt,
  });
  const category = await events.addCategory(organizer.actor, event.id, {
    name: 'Test Draw',
    format: overrides.format ?? 'singles',
    capacity: Math.max(overrides.capacity ?? 16, 4),
    minEntries: 4,
    entryFeePaise: overrides.entryFeePaise ?? 50_000n,
    platformFeePaise: overrides.platformFeePaise ?? 5_000n,
    taxBps: 1800,
    skillMin: overrides.skillMin ?? null,
    skillMax: overrides.skillMax ?? null,
  });
  // This suite is about seats, holds and money, not about which draws events
  // accepts (events refuses a draw too small to be drawn, gap #8). Tiny draws
  // make "full" cheap to reach, so the numbers are set directly.
  await prisma.eventCategory.update({
    where: { id: category.id },
    data: { capacity: overrides.capacity ?? 16, minEntries: overrides.minEntries ?? 1 },
  });
  await events.publish(organizer.actor, event.id);
  if (overrides.registrationClosesAt && overrides.registrationClosesAt <= new Date()) {
    await prisma.event.update({
      where: { id: event.id },
      data: { registrationClosesAt: overrides.registrationClosesAt },
    });
  }
  return { eventId: event.id, categoryId: category.id };
}

/** Drives a registration all the way to confirmed, through the money path. */
async function payFor(player: Player, registrationId: string): Promise<string> {
  const order = await payments.createOrder(player.actor, registrationId);
  const entity = gateway.capture(order.gatewayOrderId);
  await payments.applyWebhook(
    await deliverWebhook('payment.captured', { payment: entity }),
  );
  return entity.id;
}

/** Writes a webhook envelope straight into the claim table, as ingest would. */
let webhookSeq = 0;
async function deliverWebhook(type: string, payload: Record<string, unknown>): Promise<string> {
  webhookSeq += 1;
  const id = `evt_TEST${webhookSeq}`;
  await prisma.paymentWebhookEvent.create({
    data: {
      gatewayEventId: id,
      eventType: type,
      payload: webhookBody({ id, type, ...payload }),
    },
  });
  return id;
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  registration = wired.registration;
  payments = wired.payments;
  events = wired.events;
  profile = wired.profile;
  sport = wired.sport;
  email = wired.email;
  gateway = wired.gateway;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  email.reset();
  gateway.reset();
  webhookSeq = 0;
  organizer = await makePlayer('Organizer');
});

// ─────────────────────────────────────────────────────────────────────────────
// Done when #1 — capacity holds under concurrency
// ─────────────────────────────────────────────────────────────────────────────

describe('registration — Done when: capacity under concurrency', () => {
  it('fifty concurrent registrations at a ten-entry draw seat exactly ten', async () => {
    const { categoryId } = await publishedCategory({ capacity: 10 });
    const players = await Promise.all(
      Array.from({ length: 50 }, (_, i) => makePlayer(`Player ${i}`)),
    );

    const results = await Promise.allSettled(
      players.map((p) => registration.begin(p.actor, { eventCategoryId: categoryId })),
    );

    // Kept paired with the player who made the attempt: `allSettled` preserves
    // input order, but filtering does not, and the captain is the only person
    // allowed to pay for an entry (R6).
    const seated = players
      .map((player, i) => ({ player, result: results[i]! }))
      .filter((a) => a.result.status === 'fulfilled')
      .map((a) => ({
        player: a.player,
        registration: (a.result as PromiseFulfilledResult<{ id: string }>).value,
      }));
    const rejected = results.filter((r) => r.status === 'rejected');

    // Never eleven, never nine. The FOR UPDATE in acquireHold is the only
    // reason this number is exact (registration R4).
    expect(seated).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason as unknown;
      expect(isUserError(reason) && reason.code).toBe(RegistrationCode.CATEGORY_FULL);
    }

    // Ten seats held, ten registrations pending, and no oversell in the table.
    expect(
      await prisma.seatHold.count({ where: { eventCategoryId: categoryId, releasedAt: null } }),
    ).toBe(10);
    expect(
      await prisma.registration.count({
        where: { eventCategoryId: categoryId, status: 'payment_pending' },
      }),
    ).toBe(10);

    // And all ten confirm — nine would mean we lost a paying player.
    for (const { player, registration: reg } of seated) {
      await payFor(player, reg.id);
    }
    expect(
      await prisma.registration.count({
        where: { eventCategoryId: categoryId, status: 'confirmed' },
      }),
    ).toBe(10);
  });

  it('R1: a player cannot hold two live entries in one category', async () => {
    const { categoryId } = await publishedCategory({ capacity: 10 });
    const player = await makePlayer('Eager');

    const first = await registration.begin(player.actor, { eventCategoryId: categoryId });
    // Idempotent rather than a second row: a double tap on a slow network is
    // the normal case, not the edge case.
    const second = await registration.begin(player.actor, { eventCategoryId: categoryId });
    expect(second.id).toBe(first.id);
    expect(await prisma.registration.count({ where: { captainUserId: player.userId } })).toBe(1);

    // And the constraint is in Postgres, not just in the service: inserting a
    // second live row directly is refused.
    await expect(
      prisma.registration.create({
        data: {
          id: newId(),
          eventId: first.eventId,
          eventCategoryId: categoryId,
          sportId: pickleballId,
          captainUserId: player.userId,
          status: 'payment_pending',
          amountPaise: 1n,
        },
      }),
    ).rejects.toThrow();
  });

  it('R1: a withdrawn entry does not block a fresh attempt', async () => {
    const { categoryId } = await publishedCategory({ capacity: 10 });
    const player = await makePlayer('Second Thoughts');

    const first = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await registration.cancel(player.actor, first.id);
    expect((await registration.byId(first.id)).status).toBe('withdrawn');

    const second = await registration.begin(player.actor, { eventCategoryId: categoryId });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('payment_pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Done when #2 — payment confirmation is idempotent
// ─────────────────────────────────────────────────────────────────────────────

describe('registration — Done when: payment confirmation is idempotent', () => {
  it('five duplicate payment.captured deliveries produce exactly one of everything', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Payer');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(player.actor, reg.id);
    const entity = gateway.capture(order.gatewayOrderId);

    // The same gateway event, delivered five times. Gateways do this whenever
    // our acknowledgement is slow, so it is the normal case rather than an edge.
    for (let i = 0; i < 5; i += 1) {
      const eventId = await deliverWebhook('payment.captured', { payment: entity });
      await payments.applyWebhook(eventId);
    }

    expect(
      await prisma.registration.count({
        where: { eventCategoryId: categoryId, status: 'confirmed' },
      }),
    ).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    // One charge, one platform_fee, one tax — not five of each.
    expect(await prisma.ledgerEntry.count({ where: { kind: 'charge' } })).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(3);
    // One push, because the outbox row is written once.
    expect(await prisma.outbox.count({ where: { topic: 'registration.confirmed' } })).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'payment.captured' } })).toBe(1);
    // One confirmation email, not five.
    expect(email.to(player.email).filter((m) => m.subject.startsWith('You’re in'))).toHaveLength(
      1,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

describe('registration', () => {
  it('R2: a doubles entry awaiting a partner takes NO seat hold', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    expect(reg.status).toBe('draft');
    expect(reg.holdExpiresAt).toBeNull();

    await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });

    // Still nothing held. A 48-hour hold would let one player park a slot in a
    // popular draw for two days.
    expect((await registration.byId(reg.id)).status).toBe('awaiting_partner');
    expect(await prisma.seatHold.count({ where: { eventCategoryId: categoryId } })).toBe(0);
    expect((await events.capacityOf(categoryId)).remaining).toBe(2);
  });

  it('R2: the seat is taken at accept, when the team becomes real', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });
    const accepted = await registration.acceptInvite(partner.actor, invite.token);

    expect(accepted.status).toBe('payment_pending');
    expect(accepted.holdExpiresAt).not.toBeNull();
    expect(accepted.teamId).not.toBeNull();
    expect((await registration.teamFor(reg.id)).map((m) => m.userId).sort()).toEqual(
      [captain.userId, partner.userId].sort(),
    );
    expect((await events.capacityOf(categoryId)).remaining).toBe(1);
  });

  it('chat R2: partners on a live entry are teammates; cancelling the entry ends it', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');
    const stranger = await makePlayer('Stranger');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });
    expect(await registration.areTeammates(captain.userId, partner.userId)).toBe(false);
    await registration.acceptInvite(partner.actor, invite.token);

    expect(await registration.areTeammates(captain.userId, partner.userId)).toBe(true);
    expect(await registration.areTeammates(partner.userId, captain.userId)).toBe(true);
    expect(await registration.areTeammates(captain.userId, stranger.userId)).toBe(false);

    await registration.cancel(captain.actor, reg.id);
    expect(await registration.areTeammates(captain.userId, partner.userId)).toBe(false);
  });

  it('R12: a partner can be invited by player profile id from search, with the returned email masked', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerId: partner.playerId,
    });

    expect(invite.invitedUserId).toBe(partner.userId);
    // I1(d) — resolved from an account id, so the captain never sees the real
    // address, though the real address is what was emailed and stored.
    expect(invite.invitedEmail).not.toBe(partner.email);
    expect(invite.invitedEmail).toMatch(/•••@/);
    expect((await registration.byId(reg.id)).status).toBe('awaiting_partner');
  });

  it('R12: an unknown player id is refused with NOT_FOUND, and inviting your own profile is CANNOT_INVITE_SELF', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });

    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, { registrationId: reg.id, playerId: newId() }),
      ),
    ).toBe(RegistrationCode.REGISTRATION_NOT_FOUND);
    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, { registrationId: reg.id, playerId: captain.playerId }),
      ),
    ).toBe(RegistrationCode.CANNOT_INVITE_SELF);
  });

  it('I1: a private partner profile is refused the same as an unknown one, and does not leak', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');
    await prisma.playerProfile.update({
      where: { id: partner.playerId },
      data: { visibility: 'private' },
    });

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, {
          registrationId: reg.id,
          playerId: partner.playerId,
        }),
      ),
    ).toBe(RegistrationCode.REGISTRATION_NOT_FOUND);
  });

  it('M2: a non-UUID playerId gives NOT_FOUND, not a 500 from a malformed Prisma query', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });

    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, {
          registrationId: reg.id,
          playerId: 'not-a-uuid',
        }),
      ),
    ).toBe(RegistrationCode.REGISTRATION_NOT_FOUND);
  });

  it('M3: playerId wins over playerUserId when both are given', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const byId = await makePlayer('By Id');
    const byUserId = await makePlayer('By User Id');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerId: byId.playerId,
      playerUserId: byUserId.userId,
    });

    expect(invite.invitedUserId).toBe(byId.userId);
  });

  it('R4: a hold is refused with zero rows, not an exception from the database', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1 });
    const first = await makePlayer('First');
    const second = await makePlayer('Second');

    await registration.begin(first.actor, { eventCategoryId: categoryId });
    expect(
      await errorCode(() => registration.begin(second.actor, { eventCategoryId: categoryId })),
    ).toBe(RegistrationCode.CATEGORY_FULL);
  });

  it('R4: a confirmed entry keeps occupying capacity after its hold is consumed', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1 });
    const first = await makePlayer('First');
    const second = await makePlayer('Second');

    const reg = await registration.begin(first.actor, { eventCategoryId: categoryId });
    await payFor(first, reg.id);

    // The hold is gone but the seat is not: `taken` counts confirmed entries.
    expect(
      await prisma.seatHold.count({ where: { eventCategoryId: categoryId, releasedAt: null } }),
    ).toBe(0);
    expect(
      await errorCode(() => registration.begin(second.actor, { eventCategoryId: categoryId })),
    ).toBe(RegistrationCode.CATEGORY_FULL);
  });

  it('R5: an expired hold stops blocking capacity before any job runs', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1 });
    const first = await makePlayer('First');
    const second = await makePlayer('Second');

    const reg = await registration.begin(first.actor, { eventCategoryId: categoryId });

    // Wind the hold into the past WITHOUT releasing it — exactly the state
    // between expiry and the release job firing.
    await prisma.seatHold.updateMany({
      where: { registrationId: reg.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // The count predicate is `expires_at > now()`, so the seat is already free.
    expect((await events.capacityOf(categoryId)).held).toBe(0);
    const other = await registration.begin(second.actor, { eventCategoryId: categoryId });
    expect(other.status).toBe('payment_pending');
  });

  it('R5: the release job flips released_at and expires the registration', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Slow');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const hold = await prisma.seatHold.findFirstOrThrow({ where: { registrationId: reg.id } });

    await prisma.seatHold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await registration.expireHold(hold.id);

    expect((await prisma.seatHold.findUniqueOrThrow({ where: { id: hold.id } })).releasedAt)
      .not.toBeNull();
    expect((await registration.byId(reg.id)).status).toBe('expired');
    expect(await prisma.outbox.count({ where: { topic: 'registration.expired' } })).toBe(1);

    // Idempotent: the sweep and the delayed job both fire in practice.
    await registration.expireHold(hold.id);
    expect(await prisma.outbox.count({ where: { topic: 'registration.expired' } })).toBe(1);
  });

  it('R5: a hold that has not expired yet is left alone', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Prompt');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const hold = await prisma.seatHold.findFirstOrThrow({ where: { registrationId: reg.id } });

    await registration.expireHold(hold.id);

    expect((await registration.byId(reg.id)).status).toBe('payment_pending');
    expect((await prisma.seatHold.findUniqueOrThrow({ where: { id: hold.id } })).releasedAt)
      .toBeNull();
  });

  it('R5: the sweep catches a hold whose delayed job never fired', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Forgotten');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await prisma.seatHold.updateMany({
      where: { registrationId: reg.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await registration.sweepStaleHolds()).toBe(1);
    expect((await registration.byId(reg.id)).status).toBe('expired');
  });

  it('R6: only the captain can pay for the team', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });
    await registration.acceptInvite(partner.actor, invite.token);

    expect(await errorCode(() => payments.createOrder(partner.actor, reg.id))).toBe('FORBIDDEN');
    await expect(payments.createOrder(captain.actor, reg.id)).resolves.toBeDefined();
  });

  it('R7: an out-of-band partner is rejected at accept, not at invite', async () => {
    const { categoryId } = await publishedCategory({
      capacity: 4,
      format: 'doubles',
      skillMin: 3.0,
      skillMax: 3.75,
    });
    const captain = await makePlayer('Captain', '3.5');
    const strong = await makePlayer('Ringer', '5.0');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    // The invite itself goes through: at invite time the partner may not even
    // have an account, so there may be nothing to check.
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: strong.userId,
    });
    expect(invite.status).toBe('pending');

    expect(await errorCode(() => registration.acceptInvite(strong.actor, invite.token))).toBe(
      RegistrationCode.PARTNER_INELIGIBLE,
    );
    // And no seat was taken on the way out.
    expect(await prisma.seatHold.count({ where: { eventCategoryId: categoryId } })).toBe(0);
  });

  it('R7: a partner inside the band is accepted', async () => {
    const { categoryId } = await publishedCategory({
      capacity: 4,
      format: 'doubles',
      skillMin: 3.0,
      skillMax: 4.0,
    });
    const captain = await makePlayer('Captain', '3.5');
    const partner = await makePlayer('Partner', '3.5');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });
    expect((await registration.acceptInvite(partner.actor, invite.token)).status).toBe(
      'payment_pending',
    );
  });

  it('R8: a failed payment leaves the hold alive so a retry keeps the slot', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1 });
    const player = await makePlayer('Unlucky');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const holdBefore = await prisma.seatHold.findFirstOrThrow({
      where: { registrationId: reg.id },
    });

    const order = await payments.createOrder(player.actor, reg.id);
    const entity = gateway.fail(order.gatewayOrderId);
    await payments.applyWebhook(
      await deliverWebhook('payment.failed', { payment: entity }),
    );

    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
    // The seat is still theirs.
    expect(
      (await prisma.seatHold.findUniqueOrThrow({ where: { id: holdBefore.id } })).releasedAt,
    ).toBeNull();
    expect((await events.capacityOf(categoryId)).remaining).toBe(0);

    // And the retry reuses that same hold rather than taking a second one.
    const retried = await registration.begin(player.actor, { eventCategoryId: categoryId });
    expect(retried.status).toBe('payment_pending');
    expect(await prisma.seatHold.count({ where: { registrationId: reg.id } })).toBe(1);
  });

  it('R9: cancelling after the cutoff refunds nothing but returns the slot', async () => {
    const { categoryId } = await publishedCategory({
      capacity: 1,
      // The cutoff is already in the past.
      cancellationCutoffAt: new Date(Date.now() - DAY),
    });
    const player = await makePlayer('Late');
    const other = await makePlayer('Waiting');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await payFor(player, reg.id);

    const cancelled = await registration.cancel(player.actor, reg.id);
    expect(cancelled.status).toBe('withdrawn');
    // No money moved…
    expect(await prisma.refund.count()).toBe(0);
    // …but the draw is open again. Punishing the player should not punish the draw.
    expect((await events.capacityOf(categoryId)).remaining).toBe(1);
    expect(
      (await registration.begin(other.actor, { eventCategoryId: categoryId })).status,
    ).toBe('payment_pending');
  });

  it('R9: cancelling before the cutoff refunds and returns the slot', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1 });
    const player = await makePlayer('Early');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await payFor(player, reg.id);

    const cancelled = await registration.cancel(player.actor, reg.id);
    expect(cancelled.status).toBe('refunded');
    expect(await prisma.refund.count()).toBe(1);
    expect((await events.capacityOf(categoryId)).remaining).toBe(1);
  });

  it('R10: check-in is closed outside the two-hour window', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, startsAt: soon(10) });
    const player = await makePlayer('Keen');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await payFor(player, reg.id);

    expect(await errorCode(() => registration.checkIn(player.actor, reg.id))).toBe(
      RegistrationCode.CHECKIN_WINDOW_CLOSED,
    );
  });

  it('R10: check-in works inside the window, and only for a confirmed entry', async () => {
    const { categoryId } = await publishedCategory({
      capacity: 4,
      startsAt: new Date(Date.now() + 30 * 60_000),
      registrationClosesAt: new Date(Date.now() + 10 * 60_000),
    });
    const player = await makePlayer('OnTime');
    const unpaid = await makePlayer('Unpaid');

    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const pending = await registration.begin(unpaid.actor, { eventCategoryId: categoryId });
    await payFor(player, reg.id);

    expect((await registration.checkIn(player.actor, reg.id)).status).toBe('checked_in');
    // A pending entry has not paid; ILLEGAL_TRANSITION, and loudly (R11).
    expect(await errorCode(() => registration.checkIn(unpaid.actor, pending.id))).toBe(
      'ILLEGAL_TRANSITION',
    );
  });

  it('R11: the guard rejects a move the table does not allow', async () => {
    // The table itself, asserted directly — this is the file every other rule
    // in this module leans on.
    expect(canTransition('draft', 'payment_pending')).toBe(true);
    expect(canTransition('awaiting_partner', 'payment_pending')).toBe(true);
    expect(canTransition('payment_failed', 'payment_pending')).toBe(true);
    // payments — a same-order capture after a failure (hold-gated in confirmFromPayment).
    expect(canTransition('payment_failed', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'checked_in')).toBe(true);

    expect(canTransition('draft', 'confirmed')).toBe(false);
    expect(canTransition('expired', 'payment_pending')).toBe(false);
    expect(canTransition('refunded', 'confirmed')).toBe(false);
    // gap #2 — only an organizer cancelling moves a checked-in entry, and it
    // refunds them; nothing the player does reaches these.
    expect(canTransition('checked_in', 'refunded')).toBe(true);
    expect(canTransition('checked_in', 'confirmed')).toBe(false);
  });

  it('R11: confirming an expired registration throws rather than silently no-opping', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Gone');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    const hold = await prisma.seatHold.findFirstOrThrow({ where: { registrationId: reg.id } });
    await prisma.seatHold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await registration.expireHold(hold.id);

    expect(
      await errorCode(() =>
        registration.confirmFromPayment({ registrationId: reg.id, paymentId: newId() }),
      ),
    ).toBe('ILLEGAL_TRANSITION');
  });

  it('R12: a partner can be invited by in-app player, and the invite binds to them', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Known Partner');

    const invite = await registration.invitePartner(captain.actor, {
      registrationId: (await registration.begin(captain.actor, { eventCategoryId: categoryId }))
        .id,
      playerUserId: partner.userId,
    });

    expect(invite.invitedUserId).toBe(partner.userId);
    // I1(d) — the captain typed no address, so they are not handed the real one;
    // the row still stores it and the invite still goes to it.
    expect(invite.invitedEmail).toBe(maskEmail(partner.email));
    expect(
      (await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).invitedEmail,
    ).toBe(partner.email);
    expect(email.to(partner.email)).toHaveLength(1);
  });

  it('R12: an email invite for a stranger binds on nothing and still sends', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });

    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      email: 'not-a-member@example.com',
    });

    expect(invite.invitedUserId).toBeNull();
    expect(email.to('not-a-member@example.com')).toHaveLength(1);
  });

  it('R12: an email invite binds to an existing account, so accepting is one tap', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });

    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      email: partner.email.toUpperCase(),
    });
    expect(invite.invitedUserId).toBe(partner.userId);
  });

  it('R12: the funnel metric counts entries stuck awaiting a partner', async () => {
    const { categoryId } = await publishedCategory({ capacity: 8, format: 'doubles' });
    const stuck = await makePlayer('Stuck');
    const done = await makePlayer('Done');
    const partner = await makePlayer('Partner');

    const stuckReg = await registration.begin(stuck.actor, { eventCategoryId: categoryId });
    await registration.invitePartner(stuck.actor, {
      registrationId: stuckReg.id,
      email: 'never-reads-email@example.com',
    });

    const doneReg = await registration.begin(done.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(done.actor, {
      registrationId: doneReg.id,
      playerUserId: partner.userId,
    });
    await registration.acceptInvite(partner.actor, invite.token);

    const funnel = await registration.partnerFunnel();
    expect(funnel.awaitingPartner).toBe(1);
    expect(funnel.reachedPayment).toBe(1);
  });

  it('an expired invite cannot be accepted, and expiry drops the registration', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });

    await prisma.registrationInvite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await errorCode(() => registration.acceptInvite(partner.actor, invite.token))).toBe(
      RegistrationCode.INVITE_EXPIRED,
    );

    await registration.expireInvite(invite.id);
    expect((await registration.byId(reg.id)).status).toBe('expired');
  });

  it('a partner already entered in the draw is rejected at invite time', async () => {
    const { categoryId } = await publishedCategory({ capacity: 8, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const busy = await makePlayer('Busy');
    const theirPartner = await makePlayer('Their Partner');

    const theirs = await registration.begin(busy.actor, { eventCategoryId: categoryId });
    const theirInvite = await registration.invitePartner(busy.actor, {
      registrationId: theirs.id,
      playerUserId: theirPartner.userId,
    });
    await registration.acceptInvite(theirPartner.actor, theirInvite.token);

    const mine = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, {
          registrationId: mine.id,
          playerUserId: busy.userId,
        }),
      ),
    ).toBe(RegistrationCode.PARTNER_ALREADY_ENTERED);
  });

  it('a player with no sport selected cannot register (profile R2, enforced here)', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const userId = newId();
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: userId, email: 'nosport@example.com', displayName: 'No Sport' },
      });
      await profile.createFor(tx as unknown as Tx, userId);
    });

    expect(
      await errorCode(() => registration.begin({ userId }, { eventCategoryId: categoryId })),
    ).toBe('NO_SPORT_SELECTED');
  });

  it('registering after the deadline is refused', async () => {
    const { categoryId } = await publishedCategory({
      capacity: 4,
      startsAt: soon(2),
      registrationClosesAt: new Date(Date.now() - 1000),
    });
    const player = await makePlayer('Late');
    expect(
      await errorCode(() => registration.begin(player.actor, { eventCategoryId: categoryId })),
    ).toBe('REGISTRATION_CLOSED');
  });

  it('the organizer entry list is gated on a staff grant', async () => {
    const { eventId, categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Entrant');
    await registration.begin(player.actor, { eventCategoryId: categoryId });

    const page = await registration.listForEvent(organizer.actor, eventId, {}, { first: 20 });
    expect(page.nodes).toHaveLength(1);

    expect(
      await errorCode(() => registration.listForEvent(player.actor, eventId, {}, { first: 20 })),
    ).toBe('FORBIDDEN');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprints 4–5 — free entries (R18), the waitlist (R17), QR check-in (R13)
// ─────────────────────────────────────────────────────────────────────────────

describe('registration — free entries, waitlist and QR check-in', () => {
  const free = { entryFeePaise: 0n, platformFeePaise: 0n };

  /** Starts in 30 minutes, so the R10 check-in window is already open. */
  const checkinOpen = () => ({
    startsAt: new Date(Date.now() + 30 * 60_000),
    registrationClosesAt: new Date(Date.now() + 10 * 60_000),
  });

  /** A singles draw with every seat confirmed through the money path. */
  async function fullSingles(capacity = 1) {
    const created = await publishedCategory({ capacity });
    const holders: { player: Player; registrationId: string }[] = [];
    for (let i = 0; i < capacity; i += 1) {
      const player = await makePlayer(`Seated ${i}`);
      const reg = await registration.begin(player.actor, { eventCategoryId: created.categoryId });
      await payFor(player, reg.id);
      holders.push({ player, registrationId: reg.id });
    }
    return { ...created, holders };
  }

  /** A confirmed singles entry in a draw whose check-in window is open. */
  async function confirmedAtDesk(name: string) {
    const created = await publishedCategory({ capacity: 4, ...checkinOpen() });
    const player = await makePlayer(name);
    const reg = await registration.begin(player.actor, { eventCategoryId: created.categoryId });
    await payFor(player, reg.id);
    return { ...created, player, registrationId: reg.id };
  }

  // --- R18 -------------------------------------------------------------------

  it('R18: a free entry is confirmed in the transaction that takes its seat', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, ...free });
    const player = await makePlayer('Free');

    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });

    expect(reg.status).toBe('confirmed');
    expect(reg.amountPaise).toBe(0n);
    expect(reg.holdExpiresAt).toBeNull();
    // No order exists, and nothing was left for a release job to tidy up.
    expect(await prisma.paymentOrder.count()).toBe(0);
    expect(await prisma.seatHold.count({ where: { registrationId: reg.id, releasedAt: null } })).toBe(0);
    expect(await prisma.outbox.count({ where: { topic: 'hold.created' } })).toBe(0);
    expect(await prisma.outbox.count({ where: { topic: 'registration.confirmed' } })).toBe(1);
    expect((await events.capacityOf(categoryId)).remaining).toBe(1);
  });

  it('R18: capacity in a free draw is still decided by the R4 query', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1, ...free });
    const first = await makePlayer('First');
    const second = await makePlayer('Second');

    expect((await registration.begin(first.actor, { eventCategoryId: categoryId })).status).toBe(
      'confirmed',
    );
    expect(
      await errorCode(() => registration.begin(second.actor, { eventCategoryId: categoryId })),
    ).toBe(RegistrationCode.CATEGORY_FULL);
  });

  it('R18: a free doubles team is confirmed when the partner accepts', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, format: 'doubles', ...free });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');

    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, {
      registrationId: reg.id,
      playerUserId: partner.userId,
    });
    const accepted = await registration.acceptInvite(partner.actor, invite.token);

    expect(accepted.status).toBe('confirmed');
    expect(accepted.teamId).not.toBeNull();
    expect(await prisma.paymentOrder.count()).toBe(0);
  });

  it('R18: cancelling a free entry withdraws it and moves no money', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2, ...free });
    const player = await makePlayer('Free');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });

    const cancelled = await registration.cancel(player.actor, reg.id);
    expect(cancelled.status).toBe('withdrawn');
    expect(await prisma.refund.count()).toBe(0);
    expect((await events.capacityOf(categoryId)).remaining).toBe(2);
  });

  // --- R17 -------------------------------------------------------------------

  it('R17: a full draw refuses begin, and the waitlist queues players with no hold', async () => {
    const { categoryId } = await fullSingles();
    const a = await makePlayer('Queued A');
    const b = await makePlayer('Queued B');

    expect(await errorCode(() => registration.begin(a.actor, { eventCategoryId: categoryId }))).toBe(
      RegistrationCode.CATEGORY_FULL,
    );

    const qa = await registration.joinWaitlist(a.actor, { eventCategoryId: categoryId });
    const qb = await registration.joinWaitlist(b.actor, { eventCategoryId: categoryId });
    expect(qa.status).toBe('waitlisted');
    expect(qa.holdExpiresAt).toBeNull();
    expect(qa.waitlistPosition).toBe(1);
    expect(qb.waitlistPosition).toBe(2);
    expect(await prisma.seatHold.count({ where: { registrationId: { in: [qa.id, qb.id] } } })).toBe(0);
    expect((await events.capacityOf(categoryId)).remaining).toBe(0);
  });

  it('R1, R17: a waitlisted entry is the player’s one live entry in the draw', async () => {
    const { categoryId } = await fullSingles();
    const player = await makePlayer('Queued');
    const queued = await registration.joinWaitlist(player.actor, { eventCategoryId: categoryId });

    // A re-tap on either button returns the same entry rather than a second one.
    expect((await registration.joinWaitlist(player.actor, { eventCategoryId: categoryId })).id).toBe(
      queued.id,
    );
    expect((await registration.begin(player.actor, { eventCategoryId: categoryId })).id).toBe(
      queued.id,
    );
    // And the unique partial index agrees with the service.
    await expect(
      prisma.registration.create({
        data: {
          id: newId(),
          eventId: queued.eventId,
          eventCategoryId: categoryId,
          sportId: pickleballId,
          captainUserId: player.userId,
          status: 'payment_pending',
          amountPaise: 0n,
        },
      }),
    ).rejects.toThrow();
  });

  it('R17: joining the waitlist of a draw with a free seat simply takes the seat', async () => {
    const { categoryId } = await publishedCategory({ capacity: 2 });
    const player = await makePlayer('Lucky');
    const reg = await registration.joinWaitlist(player.actor, { eventCategoryId: categoryId });
    expect(reg.status).toBe('payment_pending');
    expect(reg.holdExpiresAt).not.toBeNull();
  });

  it('R17: a released seat is offered to the head of the queue, not to the next tap', async () => {
    const { categoryId, holders } = await fullSingles();
    const first = await makePlayer('First in line');
    const second = await makePlayer('Second in line');
    const late = await makePlayer('Late');
    const q1 = await registration.joinWaitlist(first.actor, { eventCategoryId: categoryId });
    const q2 = await registration.joinWaitlist(second.actor, { eventCategoryId: categoryId });

    const holder = holders[0]!;
    await registration.cancel(holder.player.actor, holder.registrationId);

    // The seat is free, but while anybody is queued it is not up for grabs.
    expect(
      await errorCode(() => registration.begin(late.actor, { eventCategoryId: categoryId })),
    ).toBe(RegistrationCode.CATEGORY_FULL);

    const offered = await registration.promoteWaitlist(categoryId);
    expect(offered?.id).toBe(q1.id);
    expect(offered?.status).toBe('payment_pending');
    expect(offered?.holdExpiresAt).not.toBeNull();
    expect(await prisma.outbox.count({ where: { topic: 'waitlist.offered' } })).toBe(1);
    expect((await registration.byId(q2.id)).waitlistPosition).toBe(1);

    // One seat, one offer.
    expect(await registration.promoteWaitlist(categoryId)).toBeNull();

    // From here the offer is an ordinary checkout.
    await payFor(first, q1.id);
    expect((await registration.byId(q1.id)).status).toBe('confirmed');
  });

  it('R17: a lapsed offer expires the entry and the next in line is promoted', async () => {
    const { categoryId, holders } = await fullSingles();
    const first = await makePlayer('Asleep');
    const second = await makePlayer('Awake');
    const q1 = await registration.joinWaitlist(first.actor, { eventCategoryId: categoryId });
    const q2 = await registration.joinWaitlist(second.actor, { eventCategoryId: categoryId });

    const holder = holders[0]!;
    await registration.cancel(holder.player.actor, holder.registrationId);
    await registration.promoteWaitlist(categoryId);

    const hold = await prisma.seatHold.findFirstOrThrow({
      where: { registrationId: q1.id, releasedAt: null },
    });
    await prisma.seatHold.update({
      where: { id: hold.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await registration.expireHold(hold.id);

    expect((await registration.byId(q1.id)).status).toBe('expired');
    const expired = await prisma.outbox.findFirstOrThrow({
      where: { topic: 'registration.expired' },
    });
    expect((expired.payload as { reason: string }).reason).toBe('waitlist_offer_expired');

    expect((await registration.promoteWaitlist(categoryId))?.id).toBe(q2.id);

    // The player whose offer lapsed is told so, and may queue again.
    expect(
      await errorCode(() => registration.begin(first.actor, { eventCategoryId: categoryId })),
    ).toBe(RegistrationCode.WAITLIST_OFFER_EXPIRED);
    expect((await registration.joinWaitlist(first.actor, { eventCategoryId: categoryId })).status).toBe(
      'waitlisted',
    );
  });

  it('R17: a doubles team that accepts into a full draw is queued with its team intact', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1, format: 'doubles' });

    const c1 = await makePlayer('Captain One');
    const p1 = await makePlayer('Partner One');
    const reg1 = await registration.begin(c1.actor, { eventCategoryId: categoryId });
    const invite1 = await registration.invitePartner(c1.actor, {
      registrationId: reg1.id,
      playerUserId: p1.userId,
    });
    await registration.acceptInvite(p1.actor, invite1.token);
    await payFor(c1, reg1.id);

    const c2 = await makePlayer('Captain Two');
    const p2 = await makePlayer('Partner Two');
    // No queue before the partner has accepted: this is an ordinary draft.
    const reg2 = await registration.joinWaitlist(c2.actor, { eventCategoryId: categoryId });
    expect(reg2.status).toBe('draft');

    const invite2 = await registration.invitePartner(c2.actor, {
      registrationId: reg2.id,
      playerUserId: p2.userId,
    });
    const accepted = await registration.acceptInvite(p2.actor, invite2.token);

    expect(accepted.status).toBe('waitlisted');
    expect(accepted.teamId).not.toBeNull();
    expect(accepted.waitlistPosition).toBe(1);
    expect(await prisma.seatHold.count({ where: { registrationId: reg2.id } })).toBe(0);
  });

  it('R17: leaving the waitlist withdraws the entry and releases the position', async () => {
    const { categoryId } = await fullSingles();
    const a = await makePlayer('Leaver');
    const b = await makePlayer('Stayer');
    const qa = await registration.joinWaitlist(a.actor, { eventCategoryId: categoryId });
    const qb = await registration.joinWaitlist(b.actor, { eventCategoryId: categoryId });

    expect((await registration.leaveWaitlist(a.actor, qa.id)).status).toBe('withdrawn');
    expect((await registration.byId(qb.id)).waitlistPosition).toBe(1);
    expect(await prisma.waitlistEntry.count({ where: { registrationId: qa.id } })).toBe(0);
    expect(await errorCode(() => registration.leaveWaitlist(b.actor, qa.id))).toBe('FORBIDDEN');
  });

  it('R11, R17: the guard knows the waitlist transitions and nothing more', () => {
    expect(canTransition('draft', 'waitlisted')).toBe(true);
    expect(canTransition('awaiting_partner', 'waitlisted')).toBe(true);
    expect(canTransition('waitlisted', 'payment_pending')).toBe(true);
    expect(canTransition('waitlisted', 'withdrawn')).toBe(true);

    // A queued entry never skips payment, and a paid one never re-queues.
    expect(canTransition('waitlisted', 'confirmed')).toBe(false);
    expect(canTransition('confirmed', 'waitlisted')).toBe(false);
  });

  // --- R13 -------------------------------------------------------------------

  it('R13: staff scan the QR into check-in, and a re-scan keeps the original time', async () => {
    const { player, registrationId } = await confirmedAtDesk('Scanned');
    const token = await registration.checkInToken(player.actor, registrationId);
    expect(token).not.toBeNull();

    const first = await registration.checkInByToken(organizer.actor, token!);
    expect(first.status).toBe('checked_in');
    expect(first.checkedInBy).toBe(organizer.userId);
    expect(first.checkedInAt).not.toBeNull();

    const again = await registration.checkInByToken(organizer.actor, token!);
    expect(again.checkedInAt?.getTime()).toBe(first.checkedInAt?.getTime());
    expect(await prisma.outbox.count({ where: { topic: 'registration.checked_in' } })).toBe(1);
  });

  it('R13: the QR exists only for the team, and only once the entry is confirmed', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Owner');
    const stranger = await makePlayer('Stranger');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });

    expect(await registration.checkInToken(player.actor, reg.id)).toBeNull();
    await payFor(player, reg.id);
    expect(await registration.checkInToken(player.actor, reg.id)).toEqual(expect.any(String));
    expect(await registration.checkInToken(stranger.actor, reg.id)).toBeNull();
  });

  it('R13: a forged, garbled or unknown token is CHECKIN_TOKEN_INVALID', async () => {
    const { registrationId } = await confirmedAtDesk('Target');

    const forged = signCheckinToken({ currentKeyId: 'k1', secrets: { k1: 'not-the-secret' } }, registrationId);
    const unknown = signCheckinToken(
      { currentKeyId: 'k1', secrets: { k1: TEST_CHECKIN_SECRET } },
      newId(),
    );

    for (const token of [forged, 'garbage', unknown]) {
      expect(await errorCode(() => registration.checkInByToken(organizer.actor, token))).toBe(
        RegistrationCode.CHECKIN_TOKEN_INVALID,
      );
    }
    expect((await registration.byId(registrationId)).status).toBe('confirmed');
  });

  it('R13: only staff on the event can scan, and the entrant cannot scan themselves', async () => {
    const { player, registrationId } = await confirmedAtDesk('Self Scanner');
    const stranger = await makePlayer('Stranger');
    const token = (await registration.checkInToken(player.actor, registrationId))!;

    expect(await errorCode(() => registration.checkInByToken(stranger.actor, token))).toBe('FORBIDDEN');
    expect(await errorCode(() => registration.checkInByToken(player.actor, token))).toBe('FORBIDDEN');
  });

  it('R13: a cancelled entry’s saved QR no longer checks in', async () => {
    const { player, registrationId } = await confirmedAtDesk('Cancelled');
    const token = (await registration.checkInToken(player.actor, registrationId))!;
    await registration.cancel(player.actor, registrationId);

    expect(await errorCode(() => registration.checkInByToken(organizer.actor, token))).toBe(
      RegistrationCode.CHECKIN_TOKEN_INVALID,
    );
  });

  it('R13: the offline roster carries token hashes and names, never tokens', async () => {
    const { eventId, player, registrationId } = await confirmedAtDesk('Roster Player');
    const token = (await registration.checkInToken(player.actor, registrationId))!;

    const roster = await registration.checkInRoster(organizer.actor, eventId);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.tokenHash).toBe(checkinTokenHash(token));
    expect(roster[0]!.players.map((p) => p.displayName)).toEqual(['Roster Player']);
    expect(JSON.stringify(roster)).not.toContain(token);

    expect(await errorCode(() => registration.checkInRoster(player.actor, eventId))).toBe('FORBIDDEN');
  });

  it('R10: staff can check an entrant in from the entry list, through the same guard', async () => {
    const { registrationId } = await confirmedAtDesk('Listed');
    const checked = await registration.checkIn(organizer.actor, registrationId);
    expect(checked.status).toBe('checked_in');
    expect(checked.checkedInBy).toBe(organizer.userId);
  });
});

describe('registration — guards other modules rely on', () => {
  it('identity R18: only a confirmed place in an upcoming event blocks account deletion', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Committed');
    expect(await registration.hasUpcomingConfirmedEntry(player.userId)).toBe(false);

    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    // A pending entry simply lapses; it does not hold the account hostage.
    expect(await registration.hasUpcomingConfirmedEntry(player.userId)).toBe(false);

    await payFor(player, reg.id);
    expect(await registration.hasUpcomingConfirmedEntry(player.userId)).toBe(true);
  });
});

describe('teams bigger than a pair (plan 3b)', () => {
  /** A basketball 3x3 draw: team size 3, so a captain needs two teammates. */
  async function threeOnThree(capacity = 4) {
    const basketballId = await seedSport(prisma, BASKETBALL);
    sport.refresh();
    return publishedCategory({ capacity, format: 'three_on_three', sportId: basketballId });
  }

  it('R2: a team of three takes its seat only when every teammate has accepted', async () => {
    const { categoryId } = await threeOnThree();
    const [captain, p1, p2] = [await makePlayer('Captain'), await makePlayer('One'), await makePlayer('Two')];
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const i1 = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p1.userId });
    const i2 = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p2.userId });
    expect(i1.status).toBe('pending'); // a second invite does not supersede the first for a bigger team
    expect((await registration.invitesFor(captain.actor, reg.id)).filter((i) => i.status === 'pending')).toHaveLength(2);

    const afterFirst = await registration.acceptInvite(p1.actor, i1.token);
    expect(afterFirst.status).toBe('awaiting_partner');
    expect(afterFirst.holdExpiresAt).toBeNull();
    expect((await events.capacityOf(categoryId)).remaining).toBe(4);

    const afterSecond = await registration.acceptInvite(p2.actor, i2.token);
    expect(afterSecond.status).toBe('payment_pending');
    expect((await registration.teamFor(reg.id)).map((m) => m.userId).sort()).toEqual(
      [captain.userId, p1.userId, p2.userId].sort(),
    );
    expect((await events.capacityOf(categoryId)).remaining).toBe(3);
  });

  it('invites beyond the roster are refused', async () => {
    const { categoryId } = await threeOnThree();
    const [captain, p1, p2, p3] = [
      await makePlayer('Captain'), await makePlayer('One'), await makePlayer('Two'), await makePlayer('Three'),
    ];
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p1.userId });
    await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p2.userId });
    expect(
      await errorCode(() => registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p3.userId })),
    ).toBe(RegistrationCode.TEAM_COMPLETE);
  });

  it('R3: one expired invite does not end the entry while another is still open', async () => {
    const { categoryId } = await threeOnThree();
    const [captain, p1, p2] = [await makePlayer('Captain'), await makePlayer('One'), await makePlayer('Two')];
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const i1 = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p1.userId });
    const i2 = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p2.userId });
    await prisma.registrationInvite.update({ where: { id: i1.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await registration.expireInvite(i1.id);
    expect((await registration.byId(reg.id)).status).toBe('awaiting_partner');

    // The freed spot can be offered again.
    const p3 = await makePlayer('Three');
    await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: p3.userId });
    await prisma.registrationInvite.update({ where: { id: i2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await registration.expireInvite(i2.id);
    expect((await registration.byId(reg.id)).status).toBe('awaiting_partner');
  });
});

describe('registration — gap review fixes (2026-10-03)', () => {
  it('gap #4: with no cutoff set, refunds stop when the event starts; after the draw nobody withdraws', async () => {
    const { categoryId, eventId } = await publishedCategory({ capacity: 4, cancellationCutoffAt: null });
    const player = await makePlayer('Loser');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await payFor(player, reg.id);
    await prisma.eventCategory.update({ where: { id: categoryId }, data: { status: 'drawn' } });

    expect(await errorCode(() => registration.cancel(player.actor, reg.id))).toBe('CANCELLATION_CLOSED');
    expect(await prisma.refund.count()).toBe(0);

    // Back to open, but the event has started: a withdrawal, not a refund.
    await prisma.eventCategory.update({ where: { id: categoryId }, data: { status: 'open' } });
    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - 60_000) } });
    expect((await registration.cancel(player.actor, reg.id)).status).toBe('withdrawn');
    expect(await prisma.refund.count()).toBe(0);
  });

  it('gap #27: a partner in a draw cannot start a second entry in it', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: partner.userId });
    await registration.acceptInvite(partner.actor, invite.token);

    expect(await errorCode(() => registration.begin(partner.actor, { eventCategoryId: categoryId }))).toBe(
      'ALREADY_REGISTERED',
    );
  });

  it('gap #28: only the captain can withdraw the team', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const partner = await makePlayer('Partner');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: partner.userId });
    await registration.acceptInvite(partner.actor, invite.token);

    expect(await errorCode(() => registration.cancel(partner.actor, reg.id))).toBe('CAPTAIN_ONLY');
    expect((await registration.cancel(captain.actor, reg.id)).status).toBe('withdrawn');
  });

  it('gap #29: an invite sent to an account can only be accepted by that account', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4, format: 'doubles' });
    const captain = await makePlayer('Captain');
    const invited = await makePlayer('Invited');
    const forwardedTo = await makePlayer('Forwarded');
    const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
    const invite = await registration.invitePartner(captain.actor, { registrationId: reg.id, playerUserId: invited.userId });

    expect(await errorCode(() => registration.acceptInvite(forwardedTo.actor, invite.token))).toBe('FORBIDDEN');
    expect((await registration.acceptInvite(invited.actor, invite.token)).status).toBe('payment_pending');
  });

  it('gap #33: an organizer removes an entry before the draw, refunding everything', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const player = await makePlayer('Injured');
    const reg = await registration.begin(player.actor, { eventCategoryId: categoryId });
    await payFor(player, reg.id);

    expect(await errorCode(() => registration.removeEntry(player.actor, reg.id, { refund: true }))).toBe('FORBIDDEN');
    expect((await registration.removeEntry(organizer.actor, reg.id, { refund: true })).status).toBe('refunded');
    const refund = await prisma.refund.findFirstOrThrow();
    expect(refund.amountPaise).toBe(reg.amountPaise);
    expect((await events.capacityOf(categoryId)).taken).toBe(0);
  });

  it('gap #33: a walk-in who paid cash takes a seat with no money through PL4Y', async () => {
    const { categoryId } = await publishedCategory({ capacity: 4 });
    const walkIn = await makePlayer('Walk In');
    const entry = await registration.addOfflineEntry(organizer.actor, {
      eventCategoryId: categoryId,
      email: walkIn.email,
      mode: 'offline',
    });
    expect(entry).toMatchObject({ status: 'confirmed', paymentMode: 'offline', captainUserId: walkIn.userId });
    expect((await events.capacityOf(categoryId)).taken).toBe(1);
    expect(await prisma.paymentOrder.count()).toBe(0);
    // Seated once only.
    expect(
      await errorCode(() =>
        registration.addOfflineEntry(organizer.actor, { eventCategoryId: categoryId, email: walkIn.email, mode: 'comp' }),
      ),
    ).toBe('ALREADY_REGISTERED');
  });

  it('gap #3: closing registration expires everyone still queued', async () => {
    const { categoryId } = await publishedCategory({ capacity: 1 });
    const seated = await makePlayer('Seated');
    const queued = await makePlayer('Queued');
    const reg = await registration.begin(seated.actor, { eventCategoryId: categoryId });
    await payFor(seated, reg.id);
    const waiting = await registration.joinWaitlist(queued.actor, { eventCategoryId: categoryId });
    expect(waiting.status).toBe('waitlisted');

    await prisma.eventCategory.update({ where: { id: categoryId }, data: { status: 'closed' } });
    expect(await registration.closeOutClosed(categoryId)).toBe(1);
    expect((await registration.byId(waiting.id)).status).toBe('expired');
  });
});
