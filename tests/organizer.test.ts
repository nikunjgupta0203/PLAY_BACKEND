/**
 * The in-app organizer section and the fixes from the 2026-10-04 flow review
 * (docs/platform-flow-review-2026-10-04.md, F1–F27), against a real Postgres
 * (conventions.md §5). One describe per finding; each test is the failure the
 * review described, now refused or handled.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, closeBeforeDrawing, webhookBody, type FakeGateway } from './helpers/modules.js';
import { FakePayouts, exists } from './helpers/payouts.js';
import type { EventService } from '../src/modules/events/service/index.js';
import { EventCode } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { PayoutsService, Staff } from '../src/modules/payments/service/payouts.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import { RegistrationCode } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { VenueService } from '../src/modules/venues/service/index.js';
import type { TournamentService } from '../src/modules/tournament/service/index.js';
import { ScoringCode, type ScoringService } from '../src/modules/scoring/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let events: EventService;
let registration: RegistrationService;
let payments: PaymentsService;
let payouts: PayoutsService;
let provider: FakePayouts;
let tournament: TournamentService;
let rawTournament: TournamentService;
let scoring: ScoringService;
let venues: VenueService;
let profile: ProfileService;
let sport: SportService;
let gateway: FakeGateway;
let clock: { offsetMs: number };
let pickleballId: string;

const DAY = 86_400_000;
const MINUTE = 60_000;
const soon = (days: number) => new Date(Date.now() + days * DAY);
const finance: Staff = { userId: '00000000-0000-7000-8000-000000000001', role: 'finance' };

interface Player {
  userId: string;
  actor: { userId: string };
}

let host: Player;

async function makePlayer(name: string): Promise<Player> {
  const userId = newId();
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: `${userId}@example.com`, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({ data: { playerId, sportId: pickleballId, skillBand: '3.5' } });
  return { userId, actor: { userId } };
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

let webhookSeq = 0;
/** Registers and pays, through the real gateway path. */
async function enter(categoryId: string, player: Player): Promise<string> {
  const entry = await registration.begin(player.actor, { eventCategoryId: categoryId });
  const order = await payments.createOrder(player.actor, entry.id);
  const entity = gateway.capture(order.gatewayOrderId);
  webhookSeq += 1;
  const id = `evt_ORG${webhookSeq}`;
  await prisma.paymentWebhookEvent.create({
    data: {
      gatewayEventId: id,
      eventType: 'payment.captured',
      payload: webhookBody({ id, type: 'payment.captured', payment: { ...entity, raw: { fee: 1180 } } }),
    },
  });
  await payments.applyWebhook(id);
  return entry.id;
}

/** A published paid singles event run by `host`, at the host's own venue unless `atVenue` is false. */
async function hostedEvent(opts: {
  entries?: number;
  drawType?: string;
  thirdPlace?: boolean;
  minEntries?: number;
  startsInDays?: number;
  atVenue?: boolean;
  refundPolicy?: 'standard' | 'flexible';
  tweaks?: { pointsToWin?: number; gamesToWin?: number };
} = {}) {
  const startsAt = soon(opts.startsInDays ?? 30);
  const venue =
    opts.atVenue === false
      ? null
      : await venues.create(host.actor, {
          name: `Club ${newId().slice(0, 8)}`,
          address: '100 Feet Road',
          city: 'Bengaluru',
          location: { lat: 12.9784, lng: 77.6408 },
          courts: [{ name: 'Court 1', sportIds: [pickleballId] }],
        });
  const event = await events.create(host.actor, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `Open ${newId().slice(0, 8)}`,
    ...(venue ? { venueId: venue.id } : { city: 'Bengaluru' }),
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    // An event a day away still closes registration in the future.
    registrationClosesAt: new Date(startsAt.getTime() - Math.min(DAY, (startsAt.getTime() - Date.now()) / 2)),
    cancellationCutoffAt: new Date(startsAt.getTime() - 2 * DAY),
    refundPolicy: opts.refundPolicy ?? 'standard',
  });
  const category = await events.addCategory(host.actor, event.id, {
    name: 'Open',
    format: 'singles',
    capacity: 16,
    minEntries: opts.minEntries ?? 4,
    entryFeePaise: 50_000n,
    drawType: opts.drawType,
    thirdPlace: opts.thirdPlace,
    tweaks: opts.tweaks,
  });
  await events.publish(host.actor, event.id);
  const players: Player[] = [];
  const regs: string[] = [];
  for (let i = 0; i < (opts.entries ?? 4); i += 1) {
    const p = await makePlayer(`Player ${i + 1}`);
    players.push(p);
    regs.push(await enter(category.id, p));
  }
  return { eventId: event.id, categoryId: category.id, venueId: venue?.id ?? null, players, regs };
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  events = wired.events;
  registration = wired.registration;
  payments = wired.payments;
  payouts = wired.payouts;
  provider = wired.payoutProvider;
  rawTournament = wired.tournament;
  tournament = closeBeforeDrawing(wired.tournament, prisma);
  scoring = wired.scoring;
  venues = wired.venues;
  profile = wired.profile;
  sport = wired.sport;
  gateway = wired.gateway;
  clock = wired.clock;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  gateway.reset();
  clock.offsetMs = 0;
  webhookSeq = 0;
  provider.checks = [];
  provider.transfers = [];
  host = await makePlayer('Host');
  await prisma.user.create({ data: { id: finance.userId, email: 'finance@pl4y.test', displayName: 'finance' } });
  await prisma.platformStaff.create({ data: { userId: finance.userId, role: 'finance' } });
});

describe('F1 — the host makes the draw from the app', () => {
  it('previews the draw, takes a manual seeding, and makes it with that seeding', async () => {
    const { categoryId, regs } = await hostedEvent();
    const order = [...regs].reverse();
    const preview = await rawTournament.drawPreview(host.actor, { eventCategoryId: categoryId, seedOrder: order });
    expect(preview.seeds.map((s) => s.registrationId)).toEqual(order);
    expect(preview.firstRound).toHaveLength(2);
    // Seed 1 meets seed 4 in a bracket of four.
    expect(preview.firstRound[0]).toEqual({ sideA: order[0], sideB: order[3] });
    expect(await prisma.tournament.count()).toBe(0);

    const draw = await tournament.generateDraw(host.actor, { eventCategoryId: categoryId, seedOrder: order });
    const seeds = await prisma.registration.findMany({ where: { id: { in: regs } }, select: { id: true, seed: true } });
    expect(Object.fromEntries(seeds.map((s) => [s.id, s.seed]))).toEqual(
      Object.fromEntries(order.map((id, i) => [id, i + 1])),
    );
    expect(draw.drawType).toBe('single_elim_with_plate');
  });

  it('refuses a seeding that is not every entry exactly once', async () => {
    const { categoryId, regs } = await hostedEvent();
    expect(
      await errorCode(() => rawTournament.drawPreview(host.actor, { eventCategoryId: categoryId, seedOrder: regs.slice(1) })),
    ).toBe('INVALID_SEEDING');
  });
});

describe('F2 — a host cannot keep a removed player’s fee', () => {
  it('refunds an online-paid entry even when asked not to', async () => {
    const { regs } = await hostedEvent({ entries: 1 });
    const removed = await registration.removeEntry(host.actor, regs[0]!, { refund: false });
    expect(removed.status).toBe('refunded');
    expect(await prisma.refund.count()).toBe(1);
  });
});

describe('F3 — payouts wait for signs the event happened, and for reports', () => {
  async function verifiedHost() {
    const account = await payouts.saveAccount(host, {
      legalName: 'Host Player',
      pan: 'ABCPP1234K',
      accountNumber: '51234567890',
      ifsc: 'HDFC0001098',
    });
    provider.checks.push(exists(96));
    await payouts.verifyAccount(account.id);
  }

  async function due(eventId: string) {
    await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date(Date.now() - 8 * DAY) } });
    return payouts.scheduleForEvent(eventId);
  }

  it('a host’s first payout waits a week after the end', async () => {
    await verifiedHost();
    const { eventId } = await hostedEvent({ entries: 1 });
    await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date('2026-10-10T10:00:00Z') } });
    const p = await payouts.scheduleForEvent(eventId);
    expect(p?.dueAt.toISOString()).toBe('2026-10-17T10:00:00.000Z');
  });

  it('holds an event nobody played or checked into, until staff release it', async () => {
    await verifiedHost();
    const { eventId } = await hostedEvent({ entries: 1 });
    const p = await due(eventId);
    expect(await payouts.settleDue()).toMatchObject({ held: 1 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ holdReason: 'no_play_evidence' });

    await payouts.releasePayout(finance, p!.id);
    expect(await payouts.settleDue()).toMatchObject({ sent: 1 });
  });

  it('a check-in is enough evidence; an open report holds it anyway', async () => {
    await verifiedHost();
    const { eventId, regs, players } = await hostedEvent({ entries: 1 });
    await prisma.registration.update({ where: { id: regs[0] }, data: { status: 'checked_in', checkedInAt: new Date() } });
    const p = await due(eventId);
    // The player says it did not happen as promised.
    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - 9 * DAY) } });
    const report = await events.report(players[0]!.actor, eventId, { reason: 'different_from_listing', details: 'Wrong venue' });
    expect(report.status).toBe('open');
    expect(await payouts.settleDue()).toMatchObject({ held: 1 });
    expect(await prisma.payout.findUniqueOrThrow({ where: { id: p!.id } })).toMatchObject({ holdReason: 'player_report' });

    await events.resolveReport(finance.userId, report.id, 'dismissed', 'Venue moved one street; players were told.');
    expect(await payouts.settleDue()).toMatchObject({ sent: 1 });
  });

  it('only someone who entered may report, and only once the event has started', async () => {
    const { eventId, players } = await hostedEvent({ entries: 1 });
    const stranger = await makePlayer('Stranger');
    expect(await errorCode(() => events.report(players[0]!.actor, eventId, { reason: 'did_not_happen' }))).toBe(
      EventCode.REPORT_WINDOW_CLOSED,
    );
    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - DAY) } });
    expect(await errorCode(() => events.report(stranger.actor, eventId, { reason: 'did_not_happen' }))).toBe(
      EventCode.NOT_A_PARTICIPANT,
    );
  });
});

describe('F4 — a host who plays does not judge their own match', () => {
  it('cannot override-confirm their own result, and a dispute in it escalates at once', async () => {
    const { categoryId, players, regs } = await hostedEvent({ entries: 3 });
    // The host enters their own draw.
    const hostReg = await enter(categoryId, host);
    await tournament.generateDraw(host.actor, { eventCategoryId: categoryId, seedOrder: [hostReg, ...regs] });
    const match = (await prisma.match.findMany({ where: { eventCategoryId: categoryId, bracket: 'championship', round: 1 } }))
      .find((m) => m.sideARegistrationId === hostReg || m.sideBRegistrationId === hostReg)!;
    const hostSide = match.sideARegistrationId === hostReg ? 'a' : 'b';
    const opponent = players[regs.indexOf((hostSide === 'a' ? match.sideBRegistrationId : match.sideARegistrationId)!)]!;

    await scoring.submitResult(host.actor, {
      matchId: match.id,
      outcome: 'played',
      games: hostSide === 'a' ? [{ a: 11, b: 2 }, { a: 11, b: 2 }] : [{ a: 2, b: 11 }, { a: 2, b: 11 }],
    });
    clock.offsetMs = 20 * MINUTE;
    expect(await errorCode(() => scoring.confirmResult(host.actor, match.id))).toBe('FORBIDDEN');

    await scoring.disputeResult(opponent.actor, match.id, 'We never played');
    const row = await prisma.matchResult.findUniqueOrThrow({ where: { matchId: match.id } });
    expect(row.escalatedAt).not.toBeNull();
  });
});

describe('F5 — a player’s result nobody answers confirms itself (and is not rated)', () => {
  it('sets a two-hour window and the sweep confirms it', async () => {
    const { categoryId, players, regs } = await hostedEvent();
    await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    const match = (await prisma.match.findMany({ where: { eventCategoryId: categoryId, bracket: 'championship', round: 1 } }))[0]!;
    const a = players[regs.indexOf(match.sideARegistrationId!)]!;
    const row = await scoring.submitResult(a.actor, { matchId: match.id, outcome: 'played', games: [{ a: 11, b: 4 }, { a: 11, b: 4 }] });
    expect(row.autoConfirmAt!.getTime() - row.submittedAt.getTime()).toBe(120 * MINUTE);

    clock.offsetMs = 121 * MINUTE;
    const report = await scoring.sweep();
    expect(report.confirmed).toBe(1);
    expect(await prisma.matchResult.findUniqueOrThrow({ where: { matchId: match.id } })).toMatchObject({ confirmedVia: 'auto' });
  });
});

describe('F6 — a walkover is not claimed against someone who is there', () => {
  it('refuses a claim before the match is 15 minutes late, and against a checked-in opponent', async () => {
    const { eventId, categoryId, players, regs } = await hostedEvent({ startsInDays: 1 });
    await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    const match = (await prisma.match.findMany({ where: { eventCategoryId: categoryId, bracket: 'championship', round: 1 } }))[0]!;
    const a = players[regs.indexOf(match.sideARegistrationId!)]!;
    const claim = () => scoring.submitResult(a.actor, { matchId: match.id, outcome: 'walkover', games: [], winner: 'a' });

    expect(await errorCode(claim)).toBe(ScoringCode.WALKOVER_TOO_EARLY);

    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() - 30 * MINUTE) } });
    await prisma.registration.update({ where: { id: match.sideBRegistrationId! }, data: { status: 'checked_in', checkedInAt: new Date() } });
    expect(await errorCode(claim)).toBe(ScoringCode.WALKOVER_OPPONENT_PRESENT);

    await prisma.registration.update({ where: { id: match.sideBRegistrationId! }, data: { status: 'confirmed', checkedInAt: null } });
    expect(await errorCode(claim)).toBe('NO_ERROR');
  });
});

describe('F7 — only the owner demotes a manager', () => {
  it('a manager re-adding another manager as a scorer is refused', async () => {
    const { eventId } = await hostedEvent({ entries: 0 });
    const m1 = await makePlayer('Manager One');
    const m2 = await makePlayer('Manager Two');
    const email = async (p: Player) => (await prisma.user.findUniqueOrThrow({ where: { id: p.userId } })).email;
    await events.addStaffMember(host.actor, eventId, { email: await email(m1), role: 'manager' });
    await events.addStaffMember(host.actor, eventId, { email: await email(m2), role: 'manager' });
    expect(await errorCode(() => events.addStaffMember(m1.actor, eventId, { email: '', role: 'scorer' }))).not.toBe('NO_ERROR');
    expect(await errorCode(async () => events.addStaffMember(m1.actor, eventId, { email: await email(m2), role: 'scorer' }))).toBe('FORBIDDEN');
  });
});

describe('F8, F16 — closing registration says what it will do, and the minimum can come down', () => {
  it('previews a cancellation, and lowering the minimum saves the draw', async () => {
    const { eventId, categoryId } = await hostedEvent({ entries: 3 });
    expect(await events.closePreview(host.actor, eventId)).toMatchObject([
      { categoryId, confirmed: 3, minEntries: 4, willCancel: true },
    ]);
    // F16 — players are in, and the host lowers the minimum anyway (to the floor of 4 for a knockout, so: league).
    expect(await errorCode(() => events.updateCategory(host.actor, categoryId, { minEntries: 5 }))).toBe(EventCode.EVENT_HAS_ENTRIES);
    expect(await errorCode(() => events.updateCategory(host.actor, categoryId, { minEntries: 3 }))).toBe(EventCode.INVALID_CATEGORY);
  });

  it('lowers the minimum of a league after entries', async () => {
    const { eventId, categoryId } = await hostedEvent({ entries: 3, drawType: 'league', minEntries: 4 });
    await events.updateCategory(host.actor, categoryId, { minEntries: 3 });
    expect(await events.closePreview(host.actor, eventId)).toMatchObject([{ willCancel: false }]);
  });
});

describe('F14 — the scheduler uses the host’s own courts, never a venue it does not run', () => {
  it('schedules onto declared courts at the draw’s match length', async () => {
    const { eventId, categoryId } = await hostedEvent({ atVenue: false });
    await events.updateCategory(host.actor, categoryId, { matchMinutes: 30 });
    await events.addCourt(host.actor, eventId, 'Court A');
    await events.addCourt(host.actor, eventId, 'Court B');
    const draw = await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    const placed = await rawTournament.schedule(draw.id);
    expect(placed).toHaveLength(2);
    expect(placed.every((p) => p.endsAt!.getTime() - p.startsAt.getTime() === 30 * MINUTE)).toBe(true);
  });

  it('does not book a venue’s courts for someone else’s event', async () => {
    const owner = await makePlayer('Venue Owner');
    const venue = await venues.create(owner.actor, {
      name: 'Somebody Else’s Club',
      address: '1 Road',
      city: 'Bengaluru',
      location: { lat: 12.97, lng: 77.64 },
      courts: [{ name: 'Court 1', sportIds: [pickleballId] }],
    });
    const { eventId, categoryId } = await hostedEvent({ atVenue: false });
    await prisma.event.update({ where: { id: eventId }, data: { venueId: venue.id } });
    const draw = await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    expect(await rawTournament.schedule(draw.id)).toHaveLength(0);
  });

  it('a match can have a time with no court', async () => {
    const { categoryId } = await hostedEvent({ atVenue: false });
    const draw = await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    const match = (await rawTournament.matchesFor(draw.id)).find((m) => m.round === 1 && m.bracket === 'championship')!;
    const at = soon(30);
    const updated = await rawTournament.setMatchTime(host.actor, match.id, at);
    expect(updated.scheduledAt?.getTime()).toBe(at.getTime());
  });
});

describe('F18 — moving the event after people paid', () => {
  it('stamps the change, and lets entrants leave in full for 48 hours past the cutoff', async () => {
    const { eventId, regs, players } = await hostedEvent({ entries: 1, startsInDays: 1 });
    // The cutoff (start − 2 days) has passed; normally that is no refund.
    await events.update(host.actor, eventId, { city: 'Mysuru', venueId: null });
    expect((await events.byId(eventId)).termsChangedAt).not.toBeNull();
    const left = await registration.cancel(players[0]!.actor, regs[0]!);
    expect(left.status).toBe('refunded');
  });

  it('refuses a date change once a draw is made', async () => {
    const { eventId, categoryId } = await hostedEvent();
    await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    expect(await errorCode(() => events.update(host.actor, eventId, { startsAt: soon(40), endsAt: soon(41) }))).toBe(
      EventCode.EVENT_UNDER_WAY,
    );
  });
});

describe('F19 — deleting a draw nobody entered', () => {
  it('deletes an empty one and keeps one with entries', async () => {
    const { eventId, categoryId } = await hostedEvent({ entries: 1 });
    const empty = await events.addCategory(host.actor, eventId, { name: 'Second', format: 'singles', capacity: 8, entryFeePaise: 0n });
    await events.removeCategory(host.actor, empty.id);
    expect(await prisma.eventCategory.count({ where: { eventId } })).toBe(1);
    expect(await errorCode(() => events.removeCategory(host.actor, categoryId))).toBe(EventCode.CATEGORY_HAS_ENTRIES);
  });
});

describe('F20 — walk-ins by name, in doubles, after registration closes', () => {
  it('seats a guest with no account into a closed draw', async () => {
    const { categoryId } = await hostedEvent({ entries: 4 });
    await prisma.eventCategory.update({ where: { id: categoryId }, data: { status: 'closed' } });
    const entry = await registration.addOfflineEntry(host.actor, { eventCategoryId: categoryId, guestName: 'Walk-in Wanda', mode: 'offline' });
    expect(entry.status).toBe('confirmed');
    const guest = await prisma.user.findUniqueOrThrow({ where: { id: entry.captainUserId } });
    expect(guest).toMatchObject({ isGuest: true, displayName: 'Walk-in Wanda' });
  });

  it('a doubles walk-in needs both players', async () => {
    const { eventId } = await hostedEvent({ entries: 0 });
    const doubles = await events.addCategory(host.actor, eventId, { name: 'Doubles', format: 'doubles', capacity: 8, entryFeePaise: 0n });
    expect(
      await errorCode(() => registration.addOfflineEntry(host.actor, { eventCategoryId: doubles.id, guestName: 'One', mode: 'comp' })),
    ).toBe(RegistrationCode.WALK_IN_INCOMPLETE);
    const entry = await registration.addOfflineEntry(host.actor, {
      eventCategoryId: doubles.id,
      guestName: 'One',
      partnerName: 'Two',
      mode: 'comp',
    });
    expect(await registration.teamFor(entry.id)).toHaveLength(2);
  });
});

describe('F21, F22 — the host’s match format, frozen on the draw', () => {
  it('plays one game to 15 when the host says so', async () => {
    const { categoryId } = await hostedEvent({ tweaks: { pointsToWin: 15, gamesToWin: 1 } });
    const row = await prisma.eventCategory.findUniqueOrThrow({ where: { id: categoryId } });
    expect(row.scoringRule).toMatchObject({ kind: 'rally', pointsToWin: 15, gamesToWin: 1 });
  });

  it('freezes the sport’s rule at publish when the host changes nothing', async () => {
    const { categoryId } = await hostedEvent();
    const row = await prisma.eventCategory.findUniqueOrThrow({ where: { id: categoryId } });
    expect(row.scoringRule).toMatchObject({ kind: 'rally', pointsToWin: 11 });
  });

  it('refuses a knob the sport does not have', async () => {
    const { eventId } = await hostedEvent({ entries: 0 });
    expect(
      await errorCode(() =>
        events.addCategory(host.actor, eventId, { name: 'X', format: 'singles', capacity: 8, entryFeePaise: 0n, tweaks: { periodMinutes: 20 } }),
      ),
    ).toBe(EventCode.INVALID_SCORING_FORMAT);
  });
});

describe('F23 — a plain knockout with a match for third', () => {
  it('wires the semi-final losers into it and places them 3 and 4', async () => {
    const { categoryId, players, regs } = await hostedEvent({ drawType: 'single_elim', thirdPlace: true });
    const draw = await tournament.generateDraw(host.actor, { eventCategoryId: categoryId });
    expect(draw.plateSize).toBe(0);
    const all = await rawTournament.matchesFor(draw.id);
    expect(all.filter((m) => m.bracket === 'plate')).toHaveLength(0);
    const third = all.find((m) => m.bracket === 'third_place')!;
    expect(third).toBeDefined();

    const playOut = async (matchId: string) => {
      const m = await rawTournament.matchById(matchId);
      const a = players[regs.indexOf(m.sideARegistrationId!)]!;
      const b = players[regs.indexOf(m.sideBRegistrationId!)]!;
      await scoring.submitResult(a.actor, { matchId, outcome: 'played', games: [{ a: 11, b: 3 }, { a: 11, b: 3 }] });
      await scoring.confirmResult(b.actor, matchId);
    };
    for (const semi of all.filter((m) => m.bracket === 'championship' && m.round === 1)) await playOut(semi.id);
    const ready = await rawTournament.matchById(third.id);
    expect(ready.status).toBe('ready');
    await playOut(third.id);
    const final = all.find((m) => m.bracket === 'championship' && m.round === 2)!;
    await playOut(final.id);

    const standings = await rawTournament.standingsFor(categoryId);
    expect(standings.map((r) => r.place).sort()).toEqual([1, 2, 3, 4]);
    expect(standings.find((r) => r.place === 3)?.registrationId).toBe(ready.sideARegistrationId);
    expect((await rawTournament.byId(draw.id)).completedAt).not.toBeNull();
  });
});

describe('F13 — checking yourself in means being there', () => {
  it('needs the phone’s location near the venue', async () => {
    const { eventId, regs, players } = await hostedEvent({ entries: 1 });
    await prisma.event.update({ where: { id: eventId }, data: { startsAt: new Date(Date.now() + 30 * MINUTE) } });
    const me = players[0]!.actor;
    expect(await errorCode(() => registration.checkIn(me, regs[0]!))).toBe(RegistrationCode.CHECKIN_LOCATION_REQUIRED);
    expect(await errorCode(() => registration.checkIn(me, regs[0]!, { lat: 19.07, lng: 72.87 }))).toBe(
      RegistrationCode.CHECKIN_TOO_FAR,
    );
    const done = await registration.checkIn(me, regs[0]!, { lat: 12.9786, lng: 77.6409 });
    expect(done.status).toBe('checked_in');
  });

  it('stays open until a multi-day event ends', async () => {
    const { eventId, regs } = await hostedEvent({ entries: 1 });
    await prisma.event.update({
      where: { id: eventId },
      data: { startsAt: new Date(Date.now() - 26 * 3_600_000), endsAt: new Date(Date.now() + 20 * 3_600_000) },
    });
    // Staff at the desk, on day two.
    expect((await registration.checkIn(host.actor, regs[0]!)).status).toBe('checked_in');
  });
});

describe('F27 — refund policies and the gateway’s fees', () => {
  it('the flexible policy gives half back between the cutoff and the start', async () => {
    const { regs, players } = await hostedEvent({ entries: 1, startsInDays: 1, refundPolicy: 'flexible' });
    const left = await registration.cancel(players[0]!.actor, regs[0]!);
    expect(left.status).toBe('withdrawn');
    const refund = await prisma.refund.findFirstOrThrow();
    expect(refund.amountPaise).toBe(25_000n);
  });

  it('records the gateway fee on capture', async () => {
    await hostedEvent({ entries: 1 });
    expect(await prisma.ledgerEntry.findFirstOrThrow({ where: { kind: 'gateway_fee' } })).toMatchObject({ amountPaise: 1180n });
  });
});
