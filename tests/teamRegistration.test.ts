/**
 * Team registration — pay first, invite after (docs/modules/06-registration.md
 * R21–R27), against a real Postgres.
 *
 * The rule the founder's brief calls the most important: ONE payment, ONE
 * team registration, two linked player accounts, the same entry and QR on
 * both logins. Every test below protects a piece of that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, webhookBody, type FakeGateway } from './helpers/modules.js';
import type { EventService, TeamSettingsInput } from '../src/modules/events/service/index.js';
import type { PaymentsService } from '../src/modules/payments/service/index.js';
import type { ProfileService } from '../src/modules/profile/service/index.js';
import type { RegistrationService } from '../src/modules/registration/service/index.js';
import { RegistrationCode } from '../src/modules/registration/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import { isUserError } from '../src/platform/errors/index.js';
import type { Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let registration: RegistrationService;
let payments: PaymentsService;
let events: EventService;
let profile: ProfileService;
let sport: SportService;
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

async function makePlayer(name: string): Promise<Player> {
  const userId = newId();
  const address = `${name.toLowerCase().replace(/\s+/g, '-')}-${userId.slice(0, 8)}@example.com`;
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email: address, displayName: name } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  await prisma.playerSport.create({ data: { playerId, sportId: pickleballId, skillBand: '3.5' } });
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

/** A published doubles draw. Pay-first unless the test says otherwise. */
async function doublesDraw(
  opts: { capacity?: number; team?: TeamSettingsInput; startsAt?: Date; format?: string } = {},
): Promise<{ eventId: string; categoryId: string }> {
  const startsAt = opts.startsAt ?? soon(30);
  const closes = startsAt.getTime() - DAY > Date.now() ? new Date(startsAt.getTime() - DAY) : new Date(Date.now() + 10 * 60_000);
  const event = await events.create(organizer.actor, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: `PL4Y Pickleball Championship ${newId().slice(0, 6)}`,
    city: 'Bengaluru',
    startsAt,
    endsAt: new Date(startsAt.getTime() + DAY),
    registrationClosesAt: closes,
    cancellationCutoffAt: new Date(Math.min(startsAt.getTime() - 2 * DAY, closes.getTime())),
  });
  const category = await events.addCategory(organizer.actor, event.id, {
    name: 'Open Doubles',
    format: opts.format ?? 'doubles',
    capacity: 4,
    minEntries: 4,
    entryFeePaise: 180_000n,
    platformFeePaise: 0n,
    taxBps: 0,
    team: { teammatesAfterPayment: true, ...opts.team },
  });
  await prisma.eventCategory.update({
    where: { id: category.id },
    data: { capacity: opts.capacity ?? 32, minEntries: 1 },
  });
  await events.publish(organizer.actor, event.id);
  return { eventId: event.id, categoryId: category.id };
}

let webhookSeq = 0;
async function deliverWebhook(type: string, payload: Record<string, unknown>): Promise<string> {
  webhookSeq += 1;
  const id = `evt_TEAM${webhookSeq}`;
  await prisma.paymentWebhookEvent.create({
    data: { gatewayEventId: id, eventType: type, payload: webhookBody({ id, type, ...payload }) },
  });
  return id;
}

async function payFor(player: Player, registrationId: string): Promise<void> {
  const order = await payments.createOrder(player.actor, registrationId);
  const entity = gateway.capture(order.gatewayOrderId);
  await payments.applyWebhook(await deliverWebhook('payment.captured', { payment: entity }));
}

/** Captain registers and pays for a pay-first doubles team. */
async function paidTeam(captainName = 'Nikunj', draw?: { categoryId: string }) {
  const { categoryId } = draw ?? (await doublesDraw());
  const captain = await makePlayer(captainName);
  const reg = await registration.begin(captain.actor, { eventCategoryId: categoryId });
  await payFor(captain, reg.id);
  return { categoryId, captain, registrationId: reg.id };
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
  gateway.reset();
  webhookSeq = 0;
  organizer = await makePlayer('Organizer');
});

describe('team registration — pay first, invite after (R21)', () => {
  it('the acceptance scenario: one payment, one entry, both players, one QR', async () => {
    const { categoryId } = await doublesDraw();
    const a = await makePlayer('User A');
    const b = await makePlayer('User B');

    // 1–3 — A selects doubles and is asked to pay for the team at once.
    const begun = await registration.begin(a.actor, { eventCategoryId: categoryId });
    expect(begun.status).toBe('payment_pending');
    expect(begun.amountPaise).toBe(180_000n);
    expect(begun.holdExpiresAt).not.toBeNull();

    // 4–5 — one confirmed team registration with a QR, teammate still to come.
    await payFor(a, begun.id);
    const paid = await registration.byId(begun.id);
    expect(paid.status).toBe('confirmed');
    const membersBefore = (await registration.membersFor([paid])).get(paid.id)!;
    expect(membersBefore.map((m) => m.userId)).toEqual([a.userId]);
    const qrA = await registration.checkInToken(a.actor, paid.id);
    expect(qrA).toEqual(expect.any(String));
    // B sees nothing before accepting.
    expect(await registration.listForUser(b.userId)).toHaveLength(0);

    // 6–8 — A shares a link; B opens it and accepts.
    const link = await registration.createInviteLink(a.actor, { registrationId: paid.id });
    expect(link.invitedEmail).toBeNull();
    const details = await registration.inviteDetails(b.actor, link.token);
    expect(details).toMatchObject({ canAccept: true, registrationStatus: 'confirmed', captainUserId: a.userId });
    const accepted = await registration.acceptInvite(b.actor, link.token);

    // 9–10 — the same entry on both logins, the same QR.
    expect(accepted.id).toBe(paid.id);
    expect(accepted.status).toBe('confirmed');
    expect((await registration.listForUser(b.userId)).map((r) => r.id)).toEqual([paid.id]);
    expect(await registration.checkInToken(b.actor, paid.id)).toBe(qrA);

    // One payment, one order, one registration.
    expect(await prisma.registration.count({ where: { eventCategoryId: categoryId } })).toBe(1);
    expect(await prisma.paymentOrder.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'invite.accepted' } })).toBe(1);
    expect(await prisma.outbox.count({ where: { topic: 'registration.confirmed' } })).toBe(1);
  });

  it('the captain can wait: a paid team with no teammate holds exactly one slot', async () => {
    const draw = await doublesDraw({ capacity: 1 });
    await paidTeam('Early', draw);
    const late = await makePlayer('Late');
    expect(await errorCode(() => registration.begin(late.actor, { eventCategoryId: draw.categoryId }))).toBe(
      RegistrationCode.CATEGORY_FULL,
    );
  });

  it('a duplicate capture webhook confirms once', async () => {
    const { categoryId } = await doublesDraw();
    const a = await makePlayer('Dup');
    const reg = await registration.begin(a.actor, { eventCategoryId: categoryId });
    const order = await payments.createOrder(a.actor, reg.id);
    const entity = gateway.capture(order.gatewayOrderId);
    for (let i = 0; i < 3; i += 1) {
      await payments.applyWebhook(await deliverWebhook('payment.captured', { payment: entity }));
    }
    expect((await registration.byId(reg.id)).status).toBe('confirmed');
    expect(await prisma.outbox.count({ where: { topic: 'registration.confirmed' } })).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('a failed payment confirms nothing, and a retry keeps the same entry', async () => {
    const { categoryId } = await doublesDraw();
    const a = await makePlayer('Fails');
    const reg = await registration.begin(a.actor, { eventCategoryId: categoryId });
    await registration.failFromPayment({ registrationId: reg.id, paymentId: 'pay_x', reason: 'declined' });
    expect((await registration.byId(reg.id)).status).toBe('payment_failed');
    expect(await registration.checkInToken(a.actor, reg.id)).toBeNull();
    const retry = await registration.begin(a.actor, { eventCategoryId: categoryId });
    expect(retry.id).toBe(reg.id);
    expect(retry.status).toBe('payment_pending');
  });

  it('two people who open the same link: exactly one joins', async () => {
    const { captain, registrationId } = await paidTeam();
    const x = await makePlayer('X');
    const y = await makePlayer('Y');
    const link = await registration.createInviteLink(captain.actor, { registrationId });

    const results = await Promise.allSettled([
      registration.acceptInvite(x.actor, link.token),
      registration.acceptInvite(y.actor, link.token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const members = await registration.teamFor(registrationId);
    expect(members).toHaveLength(2);
  });

  it('a used link says "already used", not "expired", and still reads as used', async () => {
    const { captain, registrationId } = await paidTeam();
    const x = await makePlayer('X');
    const y = await makePlayer('Y');
    const link = await registration.createInviteLink(captain.actor, { registrationId });
    await registration.acceptInvite(x.actor, link.token);

    expect(await errorCode(() => registration.acceptInvite(y.actor, link.token))).toBe(RegistrationCode.INVITE_USED);
    const seen = await registration.inviteDetails(y.actor, link.token);
    expect(seen?.status).toBe('accepted');
    expect(seen?.canAccept).toBe(false);
  });

  it('a player already on another team in the draw cannot accept', async () => {
    const draw = await doublesDraw();
    const first = await paidTeam('First', draw);
    const second = await paidTeam('Second', draw);
    const mate = await makePlayer('Mate');
    const l1 = await registration.createInviteLink(first.captain.actor, { registrationId: first.registrationId });
    await registration.acceptInvite(mate.actor, l1.token);
    const l2 = await registration.createInviteLink(second.captain.actor, { registrationId: second.registrationId });
    expect(await errorCode(() => registration.acceptInvite(mate.actor, l2.token))).toBe(
      RegistrationCode.PARTNER_ALREADY_ENTERED,
    );
    // The captain of the first team cannot join the second either.
    expect(await errorCode(() => registration.acceptInvite(first.captain.actor, l2.token))).toBe(
      RegistrationCode.PARTNER_ALREADY_ENTERED,
    );
  });

  it('a complete pair takes no more invites', async () => {
    const { captain, registrationId } = await paidTeam();
    const mate = await makePlayer('Mate');
    const l = await registration.createInviteLink(captain.actor, { registrationId });
    await registration.acceptInvite(mate.actor, l.token);
    expect(await errorCode(() => registration.createInviteLink(captain.actor, { registrationId }))).toBe(
      RegistrationCode.TEAM_COMPLETE,
    );
  });

  it('asking for a link twice returns the same open link', async () => {
    const { captain, registrationId } = await paidTeam();
    const one = await registration.createInviteLink(captain.actor, { registrationId });
    const two = await registration.createInviteLink(captain.actor, { registrationId });
    expect(two.token).toBe(one.token);
  });
});

describe('team registration — invites after payment (R22)', () => {
  it('a direct invite to a PL4Y player: they accept and the captain is told', async () => {
    const { captain, registrationId } = await paidTeam();
    const mate = await makePlayer('Mate');
    const invite = await registration.invitePartner(captain.actor, { registrationId, playerId: mate.playerId });
    expect(invite.invitedUserId).toBe(mate.userId);
    // It waits in the teammate's own list.
    expect((await registration.myPendingInvites(mate.actor)).map((d) => d.inviteId)).toEqual([invite.id]);
    // Only the invited account may accept it.
    const other = await makePlayer('Other');
    expect(await errorCode(() => registration.acceptInvite(other.actor, invite.token))).toBe('FORBIDDEN');
    expect(await registration.inviteDetails(other.actor, invite.token)).toBeNull();

    await registration.acceptInvite(mate.actor, invite.token);
    expect((await registration.byId(registrationId)).status).toBe('confirmed');
    const outbox = await prisma.outbox.findFirst({ where: { topic: 'invite.accepted' } });
    expect(outbox?.payload).toMatchObject({ teamComplete: true, seated: true, captainUserId: captain.userId });
  });

  it('a declined invite leaves the paid entry intact; the captain invites again', async () => {
    const { captain, registrationId } = await paidTeam();
    const no = await makePlayer('No');
    const yes = await makePlayer('Yes');
    const invite = await registration.invitePartner(captain.actor, { registrationId, playerId: no.playerId });
    await registration.declineInvite(no.actor, invite.token);

    expect((await registration.byId(registrationId)).status).toBe('confirmed');
    expect(await prisma.outbox.count({ where: { topic: 'invite.declined' } })).toBe(1);
    expect(await prisma.refund.count()).toBe(0);

    const again = await registration.invitePartner(captain.actor, { registrationId, playerId: yes.playerId });
    await registration.acceptInvite(yes.actor, again.token);
    expect((await registration.teamFor(registrationId)).map((m) => m.userId).sort()).toEqual(
      [captain.userId, yes.userId].sort(),
    );
  });

  it('an invite that expires tells the captain and keeps the entry', async () => {
    const { captain, registrationId } = await paidTeam();
    const mate = await makePlayer('Slow');
    const invite = await registration.invitePartner(captain.actor, { registrationId, playerId: mate.playerId });
    await prisma.registrationInvite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await registration.expireInvite(invite.id);

    expect((await registration.byId(registrationId)).status).toBe('confirmed');
    expect(await prisma.outbox.count({ where: { topic: 'invite.expired' } })).toBe(1);
    expect(await errorCode(() => registration.acceptInvite(mate.actor, invite.token))).toBe(RegistrationCode.INVITE_EXPIRED);
    // Resending a lapsed invite makes a fresh one.
    const fresh = await registration.resendInvite(captain.actor, invite.id);
    expect(fresh.id).not.toBe(invite.id);
    await registration.acceptInvite(mate.actor, fresh.token);
    expect(await registration.teamFor(registrationId)).toHaveLength(2);
  });

  it('a resend is limited to once a minute, and counted', async () => {
    const { captain, registrationId } = await paidTeam();
    const mate = await makePlayer('Mate');
    const invite = await registration.invitePartner(captain.actor, { registrationId, playerId: mate.playerId });
    expect(await errorCode(() => registration.resendInvite(captain.actor, invite.id))).toBe(RegistrationCode.RESEND_TOO_SOON);
    await prisma.registrationInvite.update({ where: { id: invite.id }, data: { lastSentAt: new Date(Date.now() - 120_000) } });
    const resent = await registration.resendInvite(captain.actor, invite.id);
    expect(resent.sentCount).toBe(2);
    expect(await prisma.outbox.count({ where: { topic: 'invite.resent' } })).toBe(1);
  });

  it('an invite opened after the invite deadline is refused', async () => {
    const { captain, registrationId, categoryId } = await paidTeam();
    const mate = await makePlayer('Late');
    const invite = await registration.invitePartner(captain.actor, { registrationId, playerId: mate.playerId });
    await prisma.eventCategory.update({ where: { id: categoryId }, data: { inviteDeadlineAt: new Date(Date.now() - 1000) } });
    expect(await errorCode(() => registration.acceptInvite(mate.actor, invite.token))).toBe(
      RegistrationCode.TEAM_CHANGES_CLOSED,
    );
    expect(await errorCode(() => registration.createInviteLink(captain.actor, { registrationId }))).toBe(
      RegistrationCode.TEAM_CHANGES_CLOSED,
    );
  });

  it('a cancelled entry closes its open invites', async () => {
    const { captain, registrationId } = await paidTeam();
    const mate = await makePlayer('Mate');
    const invite = await registration.invitePartner(captain.actor, { registrationId, playerId: mate.playerId });
    const cancelled = await registration.cancel(captain.actor, registrationId);
    expect(cancelled.status).toBe('refunded');
    expect((await prisma.registrationInvite.findUnique({ where: { id: invite.id } }))?.status).toBe('revoked');
    expect(await errorCode(() => registration.acceptInvite(mate.actor, invite.token))).toBe(RegistrationCode.INVITE_CLOSED);
  });

  it('a teammate cannot cancel the captain’s paid entry', async () => {
    const { captain, registrationId } = await paidTeam();
    const mate = await makePlayer('Mate');
    const l = await registration.createInviteLink(captain.actor, { registrationId });
    await registration.acceptInvite(mate.actor, l.token);
    expect(await errorCode(() => registration.cancel(mate.actor, registrationId))).toBe(RegistrationCode.CAPTAIN_ONLY);
  });
});

describe('team registration — team name and settings (R21)', () => {
  it('a host who asks for a team name gets one before payment', async () => {
    const { categoryId } = await doublesDraw({ team: { teamNameRule: 'required' } });
    const a = await makePlayer('Named');
    expect(await errorCode(() => registration.begin(a.actor, { eventCategoryId: categoryId }))).toBe(
      RegistrationCode.TEAM_NAME_REQUIRED,
    );
    const reg = await registration.begin(a.actor, { eventCategoryId: categoryId, teamName: '  Smash   Masters ' });
    expect(await registration.teamNameFor(reg.id)).toBe('Smash Masters');
    await registration.setTeamName(a.actor, reg.id, 'Net Ninjas');
    expect(await registration.teamNameFor(reg.id)).toBe('Net Ninjas');
    expect(await errorCode(() => registration.setTeamName(a.actor, reg.id, null))).toBe(RegistrationCode.TEAM_NAME_REQUIRED);
  });

  it('the old flow still holds when the host keeps it: no seat until the partner accepts', async () => {
    const { categoryId } = await doublesDraw({ team: { teammatesAfterPayment: false } });
    const a = await makePlayer('Old');
    const b = await makePlayer('Flow');
    const reg = await registration.begin(a.actor, { eventCategoryId: categoryId });
    expect(reg.status).toBe('draft');
    const invite = await registration.invitePartner(a.actor, { registrationId: reg.id, playerId: b.playerId });
    const accepted = await registration.acceptInvite(b.actor, invite.token);
    expect(accepted.status).toBe('payment_pending');
  });

  it('a host who turns the waitlist off gets a plain "full"', async () => {
    const draw = await doublesDraw({ capacity: 1, team: { waitlistEnabled: false } });
    await paidTeam('Seated', draw);
    const late = await makePlayer('Late');
    expect(await errorCode(() => registration.joinWaitlist(late.actor, { eventCategoryId: draw.categoryId }))).toBe(
      RegistrationCode.CATEGORY_FULL,
    );
  });

  it('per-player fees are labels: the entry is still charged once for the team', async () => {
    const { categoryId } = await doublesDraw({ team: { feeBasis: 'player' } });
    const category = await events.categoryById(categoryId);
    expect(category.feeBasis).toBe('player');
    expect(category.entryFeePaise).toBe(180_000n);
  });
});

describe('team registration — replacing a teammate (R25)', () => {
  it('Friend B takes Friend A’s place: same entry, payment and QR; history kept', async () => {
    const { captain, registrationId } = await paidTeam();
    const friendA = await makePlayer('Friend A');
    const friendB = await makePlayer('Friend B');
    const la = await registration.createInviteLink(captain.actor, { registrationId });
    await registration.acceptInvite(friendA.actor, la.token);
    const qr = await registration.checkInToken(captain.actor, registrationId);

    const swap = await registration.invitePartner(captain.actor, {
      registrationId,
      playerId: friendB.playerId,
      replacesUserId: friendA.userId,
    });
    // Until B accepts, A is still on the team.
    expect((await registration.teamFor(registrationId)).map((m) => m.userId)).toContain(friendA.userId);
    await registration.acceptInvite(friendB.actor, swap.token);

    const team = (await registration.teamFor(registrationId)).map((m) => m.userId).sort();
    expect(team).toEqual([captain.userId, friendB.userId].sort());
    expect(await registration.checkInToken(friendB.actor, registrationId)).toBe(qr);
    expect(await registration.checkInToken(friendA.actor, registrationId)).toBeNull();
    expect(await prisma.payment.count()).toBe(1);
    const history = await registration.historyOf(captain.actor, registrationId);
    expect(history.map((h) => h.kind)).toContain('member_replaced');
  });

  it('no replacement once that teammate is checked in, or when the host does not allow it', async () => {
    const draw = await doublesDraw({ startsAt: new Date(Date.now() + 30 * 60_000) });
    const { captain, registrationId } = await paidTeam('Cap', draw);
    const friendA = await makePlayer('Friend A');
    const friendB = await makePlayer('Friend B');
    const la = await registration.createInviteLink(captain.actor, { registrationId });
    await registration.acceptInvite(friendA.actor, la.token);
    await registration.checkInMembers(organizer.actor, registrationId, [friendA.userId]);
    expect(
      await errorCode(() =>
        registration.invitePartner(captain.actor, { registrationId, playerId: friendB.playerId, replacesUserId: friendA.userId }),
      ),
    ).toBe(RegistrationCode.MEMBER_CHECKED_IN);

    const other = await doublesDraw({ team: { allowReplacements: false } });
    const t2 = await paidTeam('Cap2', other);
    const c = await makePlayer('C');
    const l2 = await registration.createInviteLink(t2.captain.actor, { registrationId: t2.registrationId });
    await registration.acceptInvite(c.actor, l2.token);
    expect(
      await errorCode(() =>
        registration.createInviteLink(t2.captain.actor, { registrationId: t2.registrationId, replacesUserId: c.userId }),
      ),
    ).toBe(RegistrationCode.REPLACEMENTS_OFF);
  });

  it('staff add and remove teammates only with a reason, and it is in the history', async () => {
    const { captain, registrationId } = await paidTeam();
    const walkIn = await makePlayer('Walk In');
    expect(
      await errorCode(() =>
        registration.staffAddMember(organizer.actor, { registrationId, playerId: walkIn.playerId, reason: '' }),
      ),
    ).toBe(RegistrationCode.REASON_REQUIRED);
    await registration.staffAddMember(organizer.actor, { registrationId, playerId: walkIn.playerId, reason: 'Phone died at the desk' });
    expect((await registration.teamFor(registrationId)).map((m) => m.userId)).toContain(walkIn.userId);
    // The captain cannot do this.
    const someone = await makePlayer('Someone');
    expect(
      await errorCode(() => registration.staffAddMember(captain.actor, { registrationId, playerId: someone.playerId, reason: 'because' })),
    ).toBe('FORBIDDEN');

    await registration.staffRemoveMember(organizer.actor, { registrationId, userId: walkIn.userId, reason: 'Wrong player' });
    const history = await registration.historyOf(organizer.actor, registrationId);
    const added = history.find((h) => h.kind === 'member_added');
    expect(added).toMatchObject({ actorUserId: organizer.userId, subjectUserId: walkIn.userId, reason: 'Phone died at the desk' });
    expect(history.find((h) => h.kind === 'member_removed')?.reason).toBe('Wrong player');
  });
});

describe('team registration — per-player check-in (R24)', () => {
  async function completeTeamAtDesk() {
    const draw = await doublesDraw({ startsAt: new Date(Date.now() + 30 * 60_000) });
    const { captain, registrationId } = await paidTeam('Captain', draw);
    const mate = await makePlayer('Mate');
    const l = await registration.createInviteLink(captain.actor, { registrationId });
    await registration.acceptInvite(mate.actor, l.token);
    const token = (await registration.checkInToken(mate.actor, registrationId))!;
    return { captain, mate, registrationId, token };
  }

  it('one teammate arrives before the other; a re-scan never checks anyone in twice', async () => {
    const { captain, mate, registrationId, token } = await completeTeamAtDesk();

    // The scan only reads.
    const looked = await registration.checkInLookup(organizer.actor, token);
    expect(looked.id).toBe(registrationId);
    expect(looked.status).toBe('confirmed');

    const first = await registration.checkInMembers(organizer.actor, registrationId, [captain.userId], { method: 'qr' });
    expect(first.status).toBe('checked_in');
    let members = (await registration.membersFor([first])).get(registrationId)!;
    expect(registration.checkInStateOf(first, members)).toBe('partial');
    const captainAt = members.find((m) => m.userId === captain.userId)!.checkedInAt;

    // Scanning again for the same player changes nothing.
    await registration.checkInMembers(organizer.actor, registrationId, [captain.userId]);
    // The whole team at once now checks in only the one still missing.
    const after = await registration.checkInMembers(organizer.actor, registrationId, null);
    members = (await registration.membersFor([after])).get(registrationId)!;
    expect(registration.checkInStateOf(after, members)).toBe('all');
    expect(members.find((m) => m.userId === captain.userId)!.checkedInAt?.getTime()).toBe(captainAt?.getTime());
    expect(members.find((m) => m.userId === mate.userId)!.checkedInAt).not.toBeNull();
    expect(await prisma.registrationCheckin.count({ where: { registrationId } })).toBe(2);
    expect(await prisma.outbox.count({ where: { topic: 'registration.checked_in' } })).toBe(2);

    const roster = await registration.checkInRoster(organizer.actor, (await registration.byId(registrationId)).eventId);
    expect(roster[0]!.players.every((p) => p.checkedInAt)).toBe(true);
  });

  it('nobody but the event’s staff can look up or check in a team', async () => {
    const { captain, mate, registrationId, token } = await completeTeamAtDesk();
    const stranger = await makePlayer('Stranger');
    expect(await errorCode(() => registration.checkInLookup(stranger.actor, token))).toBe('FORBIDDEN');
    expect(await errorCode(() => registration.checkInMembers(captain.actor, registrationId, [mate.userId]))).toBe('FORBIDDEN');
    expect(await errorCode(() => registration.checkInMembers(organizer.actor, registrationId, [stranger.userId]))).toBe(
      RegistrationCode.NOT_ON_TEAM,
    );
  });

  it('the dashboard counts complete, waiting and partly checked-in teams', async () => {
    const { captain, registrationId } = await completeTeamAtDesk();
    const event = (await registration.byId(registrationId)).eventId;
    const waiting = await makePlayer('Waiting');
    const r2 = await registration.begin(waiting.actor, { eventCategoryId: (await registration.byId(registrationId)).eventCategoryId });
    await payFor(waiting, r2.id);
    await registration.checkInMembers(organizer.actor, registrationId, [captain.userId]);

    const stats = await registration.teamStats(organizer.actor, event);
    expect(stats).toMatchObject({
      paidEntries: 2,
      completeTeams: 1,
      awaitingTeammates: 1,
      participants: 3,
      partiallyCheckedInTeams: 1,
      checkedInTeams: 0,
      checkedInParticipants: 1,
    });
  });
});
