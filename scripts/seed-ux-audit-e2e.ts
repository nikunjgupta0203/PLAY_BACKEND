/**
 * Local e2e data for the UX-audit fixes (docs/ux-audit-2026-10-07.md §7–8).
 * Dev database only:
 *
 *   npx tsx --env-file-if-exists=.env scripts/seed-ux-audit-e2e.ts
 *
 * One host (e2e.uxhost@pl4y.test) running five events:
 *   - UX Live Badminton Cup   — today, drawn, one match live, no courts
 *   - UX Weekend Smash        — in 3 days, drawn (start window, "to be decided")
 *   - UX T20 Knockout         — today, 4 teams drawn (runs, super over)
 *   - UX Fight Night          — today, 4 fighters drawn (won by KO)
 *   - UX 10K Run              — today, 10 runners in one heat (undo, confirm, search)
 *   - UX Draft Open           — a draft, to publish from Manage (share card)
 */
import { PrismaClient } from '@prisma/client';
import type { Db } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { seedLaunchSports } from '../src/modules/sport/seed.js';
import { buildModules } from '../tests/helpers/modules.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SILENCED = new Set(['hold.created', 'registration.confirmed', 'capacity.changed']);

const db = new PrismaClient({ transactionOptions: { maxWait: 20_000, timeout: 60_000 } }) as unknown as Db;
const quiet = db.$extends({
  query: {
    outbox: {
      async create({ args, query }) {
        if (SILENCED.has(args.data.topic)) args.data.processedAt = new Date();
        return query(args);
      },
    },
  },
}) as unknown as typeof db;

const NAMES = [
  'Asha Rao', 'Ravi Kumar', 'Meera Iyer', 'Kabir Shah', 'Tara Kapoor', 'Arjun Verma',
  'Diya Patel', 'Rohan Desai', 'Nisha Bhatt', 'Yash Pandya', 'Zoya Sheikh', 'Karan Malhotra',
];

async function upsertUser(email: string, displayName: string): Promise<{ id: string; created: boolean }> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { id: existing.id, created: false };
  const id = newId();
  await db.user.create({ data: { id, email, displayName } });
  return { id, created: true };
}

async function main(): Promise<void> {
  await seedLaunchSports(db);
  const { sport, profile, venues, events, registration, tournament, scoring, field } = buildModules(quiet);
  sport.refresh();
  const sportOf = async (slug: string) => (await sport.bySlug(slug)).id;
  const badminton = await sportOf('badminton');
  const cricket = await sportOf('cricket');
  const mma = await sportOf('mma');
  const running = await sportOf('running');

  const host = await upsertUser('e2e.uxhost@pl4y.test', 'UX Host Club');
  const organizer = { userId: host.id };
  if (host.created) {
    await db.$transaction((tx) => profile.createFor(tx, host.id));
    await profile.updateSports(organizer, [{ sportId: badminton, skillBand: '3.5' }]);
    await profile.updateLocation(organizer, { city: 'Bengaluru', geo: { lat: 12.97, lng: 77.64 } });
  }

  const players: string[] = [];
  for (const [i, name] of NAMES.entries()) {
    const u = await upsertUser(`ux.player${i + 1}@pl4y.test`, name);
    players.push(u.id);
    if (!u.created) continue;
    await db.$transaction((tx) => profile.createFor(tx, u.id));
    await profile.updateSports({ userId: u.id }, [badminton, mma, running].map((s) => ({ sportId: s, skillBand: '3.5' })));
    await profile.updateLocation({ userId: u.id }, { city: 'Bengaluru', geo: { lat: 12.97, lng: 77.64 } });
  }

  const VENUE = 'UX Audit Arena';
  const venueId =
    (await db.venue.findFirst({ where: { name: VENUE } }))?.id ??
    (
      await venues.create(organizer, {
        name: VENUE,
        address: '100 Feet Road, Indiranagar',
        city: 'Bengaluru',
        location: { lat: 12.9784, lng: 77.6408 },
        courts: [{ name: 'Court 1', sportIds: [badminton] }],
      })
    ).id;

  /** Creates (or finds) the event; returns its id and its one category. */
  async function eventOf(title: string, sportId: string, format: string, daysOut: number, publish = true) {
    const found = await db.event.findFirst({ where: { title } });
    if (found) {
      const cat = await db.eventCategory.findFirstOrThrow({ where: { eventId: found.id } });
      return { eventId: found.id, categoryId: cat.id, fresh: false };
    }
    const startsAt = new Date(Date.now() + Math.max(daysOut, 3) * DAY);
    const created = await events.create(organizer, {
      sportId,
      contactPhone: '9876543210',
      acceptHostTerms: true,
      title,
      venueId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 8 * HOUR),
      registrationClosesAt: new Date(startsAt.getTime() - DAY),
    });
    const category = await events.addCategory(organizer, created.id, {
      name: format === 't20' ? 'T20 Teams' : format === 'bout' ? 'Lightweight' : format === '10k' ? '10K Open' : 'Open Singles',
      format,
      capacity: 16,
      minEntries: format === '10k' ? 2 : 4,
      entryFeePaise: 1_000n,
      skillMin: null,
      skillMax: null,
    });
    if (publish) await events.publish(organizer, created.id);
    return { eventId: created.id, categoryId: category.id, fresh: true };
  }

  /** Re-runnable: a step is done once its draw (or heat) exists. */
  async function drawn(categoryId: string) {
    const [t, h] = await Promise.all([
      db.tournament.findFirst({ where: { eventCategoryId: categoryId } }),
      db.heat.findFirst({ where: { eventCategoryId: categoryId } }),
    ]);
    return !!(t || h);
  }

  /** gap #6 — a draw is made from a closed category; "close registration now" without the minimum check. */
  async function close(categoryId: string) {
    await db.eventCategory.updateMany({ where: { id: categoryId, status: { in: ['open', 'full'] } }, data: { status: 'closed' } });
  }

  async function enterSingles(categoryId: string, userIds: string[]) {
    for (const userId of userIds) {
      const has = await db.registration.findFirst({ where: { eventCategoryId: categoryId, captainUserId: userId, status: 'confirmed' } });
      if (has) continue;
      const entry = await registration.begin({ userId }, { eventCategoryId: categoryId });
      await registration.confirmFromPayment({ registrationId: entry.id, paymentId: newId() });
    }
  }

  async function enterTeams(eventId: string, categoryId: string, sportId: string, captains: string[]) {
    for (const captainUserId of captains) {
      if (await db.registration.findFirst({ where: { eventCategoryId: categoryId, captainUserId } })) continue;
      await db.registration.create({
        data: {
          id: newId(),
          eventId,
          eventCategoryId: categoryId,
          sportId,
          captainUserId,
          status: 'confirmed',
          confirmedAt: new Date(),
          amountPaise: 0n,
        },
      });
    }
  }

  /** Moves an event onto today: started an hour ago, registration long closed. */
  async function today(eventId: string) {
    const now = Date.now();
    await db.event.update({
      where: { id: eventId },
      data: {
        startsAt: new Date(now - HOUR),
        endsAt: new Date(now + 8 * HOUR),
        registrationClosesAt: new Date(now - 3 * HOUR),
        cancellationCutoffAt: new Date(now - 4 * HOUR),
      },
    });
  }

  // 1. Live badminton: drawn, one first-round match live → the event goes LIVE.
  const live = await eventOf('UX Live Badminton Cup', badminton, 'singles', 0);
  if (!(await drawn(live.categoryId))) {
    await enterSingles(live.categoryId, players.slice(0, 4));
    await close(live.categoryId);
    const draw = await tournament.generateDraw(organizer, { eventCategoryId: live.categoryId });
    await today(live.eventId);
    const first = (await tournament.matchesFor(draw.id)).find((m) => m.bracket === 'championship' && m.round === 1)!;
    await scoring.start(organizer, first.id);
  }

  // 2. Weekend: drawn three days out — Start is refused, the final is "to be decided".
  const weekend = await eventOf('UX Weekend Smash', badminton, 'singles', 3);
  if (!(await drawn(weekend.categoryId))) {
    await enterSingles(weekend.categoryId, players.slice(4, 8));
    await close(weekend.categoryId);
    await tournament.generateDraw(organizer, { eventCategoryId: weekend.categoryId });
  }

  // 3. Cricket: four teams, today.
  const t20 = await eventOf('UX T20 Knockout', cricket, 't20', 0);
  if (!(await drawn(t20.categoryId))) {
    await enterTeams(t20.eventId, t20.categoryId, cricket, players.slice(0, 4));
    await close(t20.categoryId);
    await tournament.generateDraw(organizer, { eventCategoryId: t20.categoryId });
    await today(t20.eventId);
  }

  // 4. MMA: four fighters, today.
  const fights = await eventOf('UX Fight Night', mma, 'bout', 0);
  if (!(await drawn(fights.categoryId))) {
    await enterSingles(fights.categoryId, players.slice(4, 8));
    await close(fights.categoryId);
    await tournament.generateDraw(organizer, { eventCategoryId: fights.categoryId });
    await today(fights.eventId);
  }

  // 5. A 10K: ten runners, one heat, today.
  const run = await eventOf('UX 10K Run', running, '10k', 0);
  if (!(await drawn(run.categoryId))) {
    await enterSingles(run.categoryId, players.slice(0, 10));
    await close(run.categoryId);
    await field.createHeats(organizer, { eventCategoryId: run.categoryId, count: 1 });
    await today(run.eventId);
  }

  // 6. A draft, published from Manage in the app.
  await eventOf('UX Draft Open', badminton, 'singles', 10, false);

  console.log('Seeded. Host: e2e.uxhost@pl4y.test');
  for (const e of await db.event.findMany({ where: { title: { startsWith: 'UX ' } }, select: { slug: true, status: true } })) {
    console.log(`  ${e.slug} (${e.status})`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeQueues } = await import('../src/platform/queue.js');
    await closeQueues().catch(() => undefined);
    await db.$disconnect();
  });
