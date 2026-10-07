/**
 * Ten published ₹10 singles events, each with ten confirmed players.
 *
 * Unlike `seed:dev`, this is meant to be pointed at a hosted database:
 *
 *   DATABASE_URL="postgres://…" npx tsx --env-file-if-exists=.env scripts/seed-singles-events.ts
 *
 * (`--env-file` never overrides a variable already set in the shell.)
 *
 * Players are entered through the real registration service and confirmed the
 * way a captured payment would confirm them, but no payment row is written, so
 * none of this reaches payouts. The registration outbox rows (hold, confirmed,
 * capacity) are written already processed: the live worker would otherwise
 * mail every seeded address and the host twenty times over. `event.published`
 * still flows, so each event gets its close-registration job.
 *
 * Safe to re-run: users are matched by email and events by title.
 */
import { PrismaClient } from '@prisma/client';
import type { Db } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { seedLaunchSports } from '../src/modules/sport/seed.js';
import { buildModules } from '../tests/helpers/modules.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

const SILENCED = new Set(['hold.created', 'registration.confirmed', 'capacity.changed']);

// A hosted database far from here needs longer than Prisma's 5s per transaction.
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

const PLAYERS = [
  ['Aarav Mehta', '3.5'], ['Diya Shah', '4.0'], ['Kabir Patel', '3.0'], ['Ishaan Joshi', '4.5'],
  ['Meera Iyer', '3.5'], ['Rohan Desai', '4.0'], ['Ananya Rao', '3.5'], ['Vivaan Nair', '5.0+'],
  ['Tara Kapoor', '3.5'], ['Arjun Verma', '4.0'], ['Nisha Bhatt', '3.0'], ['Sara Khan', '3.5'],
  ['Yash Pandya', '4.5'], ['Riya Soni', '4.0'], ['Karan Malhotra', '3.5'], ['Zoya Sheikh', '4.0'],
  ['Aditya Rana', '3.5'], ['Pooja Menon', '4.0'], ['Meet Chauhan', '4.0'], ['Aisha Qureshi', '3.5'],
] as const;

const SPORTS = ['pickleball', 'badminton', 'tennis', 'table-tennis'] as const;

const EVENTS = [
  'SG Highway Singles Showdown', 'Prahlad Nagar Singles Night', 'Vastrapur Singles Sprint',
  'Bodakdev Singles Bash', 'Thaltej Singles Shootout', 'Satellite Singles Smash',
  'Navrangpura Singles Open', 'Bopal Singles Challenge', 'Maninagar Singles Cup',
  'Gota Singles Rally',
];

const slugOf = (name: string) => name.toLowerCase().replace(/\s+/g, '.');

async function upsertUser(email: string, displayName: string): Promise<{ id: string; created: boolean }> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { id: existing.id, created: false };
  const id = newId();
  await db.user.create({ data: { id, email, displayName } });
  return { id, created: true };
}

async function main(): Promise<void> {
  await seedLaunchSports(db);
  const { sport, profile, venues, events, registration } = buildModules(quiet);
  sport.refresh();
  const sportId = new Map<string, string>();
  for (const s of SPORTS) sportId.set(s, (await sport.bySlug(s)).id);

  // --- host + venue -------------------------------------------------------------
  const host = await upsertUser('host.seed@pl4y.test', 'Ahmedabad Singles Club');
  const organizer = { userId: host.id };
  if (host.created) await db.$transaction((tx) => profile.createFor(tx, host.id));

  const VENUE = 'PL4Y Singles Arena';
  const venueId =
    (await db.venue.findFirst({ where: { name: VENUE } }))?.id ??
    (
      await venues.create(organizer, {
        name: VENUE,
        address: 'Sindhu Bhavan Road, Bodakdev',
        city: 'Ahmedabad',
        location: { lat: 23.0395, lng: 72.5066 },
        amenities: ['Floodlights', 'Parking', 'Drinking water'],
        courts: SPORTS.map((s, i) => ({
          name: `Court ${i + 1}`,
          surface: s === 'tennis' ? 'hard' : s === 'pickleball' ? 'acrylic' : 'wooden',
          indoor: s !== 'tennis' && s !== 'pickleball',
          sportIds: [sportId.get(s)!],
        })),
      })
    ).id;

  // --- players: every sport, so any of them can enter any event -----------------
  const players: string[] = [];
  for (const [name, band] of PLAYERS) {
    const u = await upsertUser(`${slugOf(name)}.seed@pl4y.test`, name);
    players.push(u.id);
    if (!u.created) continue;
    const actor = { userId: u.id };
    await db.$transaction((tx) => profile.createFor(tx, u.id));
    await profile.updateSports(actor, SPORTS.map((s) => ({ sportId: sportId.get(s)!, skillBand: band })));
    await profile.updateLocation(actor, {
      city: 'Ahmedabad',
      geo: { lat: 23.0 + Math.random() * 0.07, lng: 72.47 + Math.random() * 0.1 },
    });
  }
  console.log(`Players: ${players.length}`);

  // --- events -------------------------------------------------------------------
  for (const [i, title] of EVENTS.entries()) {
    const s = SPORTS[i % SPORTS.length]!;
    const startsAt = new Date(inDays(5 + i * 2).setHours(18, 0, 0, 0));
    const categoryId = (await existingCategory(title)) ?? (await createEvent(title, s, startsAt));

    // Ten of the twenty, a different window each time.
    const entrants = Array.from({ length: 10 }, (_, k) => players[(i * 3 + k) % players.length]!);
    for (const userId of entrants) {
      const done = await db.registration.findFirst({
        where: { eventCategoryId: categoryId, captainUserId: userId, status: 'confirmed' },
      });
      if (done) continue;
      const entry = await registration.begin({ userId }, { eventCategoryId: categoryId });
      await registration.confirmFromPayment({ registrationId: entry.id, paymentId: newId() });
    }
    console.log(`  ${title} (${s}, ${startsAt.toDateString()}): ${entrants.length} confirmed`);
  }

  async function existingCategory(title: string): Promise<string | null> {
    const event = await db.event.findFirst({ where: { title } });
    if (!event) return null;
    if (event.status === 'draft') await events.publish(organizer, event.id);
    const category = await db.eventCategory.findFirstOrThrow({ where: { eventId: event.id } });
    return category.id;
  }

  async function createEvent(title: string, s: string, startsAt: Date): Promise<string> {
    const created = await events.create(organizer, {
      sportId: sportId.get(s)!,
      contactPhone: '9876543210',
      acceptHostTerms: true,
      title,
      venueId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 4 * HOUR),
      registrationClosesAt: new Date(startsAt.getTime() - DAY),
    });
    const category = await events.addCategory(organizer, created.id, {
      name: '₹10 Singles',
      format: 'singles',
      capacity: 16,
      entryFeePaise: 1_000n,
      skillMin: null,
      skillMax: null,
    });
    await events.publish(organizer, created.id);
    return category.id;
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
