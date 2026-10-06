/**
 * `npm run seed:dev` — throwaway local sample data: venues, published events
 * with categories, and player profiles across several sports (not just
 * pickleball), all in Ahmedabad so they show up under the dev account's
 * default city filter in Discover.
 *
 * It also plays six "Ahmedabad Ladder Night" pickleball draws, dates their
 * results into the previous two weeks and runs those rating periods, so the
 * leaderboards have settled ratings and real movement (rating R4, R9–R11).
 *
 * It also builds one live draw — "PL4Y Result Finality Test Cup" — with results
 * left in every confirmation state (scoring R11–R14), and puts the first
 * DEV_OTP_BYPASS_EMAILS account in it on the side that has to answer.
 *
 * Deliberately separate from `prisma/seed.ts`, which is version-controlled
 * reference data (sports, dev accounts) and runs on every deploy. This is
 * local-only and safe to re-run — venues/events are matched by name and
 * players by email, so reruns update in place instead of duplicating.
 */
import { config, isProd } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { LAUNCH_SPORTS, seedLaunchSports } from '../src/modules/sport/seed.js';
import { buildModules } from '../tests/helpers/modules.js';

if (isProd) {
  console.error('seed-dev-data refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

async function upsertUser(email: string, displayName: string): Promise<string> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing.id;
  const id = newId();
  await db.user.create({ data: { id, email, displayName } });
  return id;
}

async function main(): Promise<void> {
  await seedLaunchSports(db);
  const { sport, profile, venues, events, registration, tournament, scoring, identity } = buildModules(db);
  // The REAL rating module: the test builder's rating reads a results fixture,
  // not scoring, so it would settle nothing.
  const { rating } = await import('../src/modules/rating/index.js');
  sport.refresh();

  // seedLaunchSports doesn't hand back a slug->id map, so look each one up.
  const ids = new Map<string, string>();
  for (const s of LAUNCH_SPORTS) ids.set(s.slug, (await sport.bySlug(s.slug)).id);
  const idOf = (slug: string): string => {
    const id = ids.get(slug);
    if (!id) throw new Error(`sport ${slug} was not seeded`);
    return id;
  };

  // --- organizer + venues -----------------------------------------------
  const organizerId = await upsertUser('organizer.dev@pl4y.in', 'Ahmedabad Sports Club');
  const organizer = { userId: organizerId };

  const venueSeeds = [
    {
      name: 'SG Highway Pickleball Courts',
      address: 'SG Highway, near Iscon Cross Road',
      city: 'Ahmedabad',
      location: { lat: 23.0304, lng: 72.5066 },
      amenities: ['Floodlights', 'Parking', 'Drinking water'],
      courts: [
        { name: 'Court 1', surface: 'acrylic', indoor: false, sportIds: [idOf('pickleball')] },
        { name: 'Court 2', surface: 'acrylic', indoor: false, sportIds: [idOf('pickleball')] },
      ],
    },
    {
      name: 'Prahlad Nagar Sports Arena',
      address: 'Prahlad Nagar Garden Road',
      city: 'Ahmedabad',
      location: { lat: 23.0128, lng: 72.5054 },
      amenities: ['Indoor courts', 'Locker room'],
      courts: [{ name: 'Arena Court', surface: 'synthetic', indoor: true, sportIds: [idOf('pickleball')] }],
    },
    {
      name: 'Vastrapur Sports Complex',
      address: 'Vastrapur Lake Road',
      city: 'Ahmedabad',
      location: { lat: 23.0368, lng: 72.5294 },
      amenities: ['Cafe', 'Parking'],
      courts: [{ name: 'Court A', surface: 'acrylic', indoor: false, sportIds: [idOf('pickleball')] }],
    },
    {
      name: 'Bopal Turf Arena',
      address: 'Bopal-Ghuma Road',
      city: 'Ahmedabad',
      location: { lat: 23.0325, lng: 72.4695 },
      amenities: ['Floodlights', 'Changing rooms', 'Parking'],
      courts: [
        { name: 'Turf 1 (5-a-side)', surface: 'artificial turf', indoor: false, sportIds: [idOf('football')] },
        { name: 'Turf 2 (7-a-side)', surface: 'artificial turf', indoor: false, sportIds: [idOf('football')] },
      ],
    },
    {
      name: 'Thaltej Tennis Club',
      address: 'Thaltej Cross Road',
      city: 'Ahmedabad',
      location: { lat: 23.0569, lng: 72.5057 },
      amenities: ['Clay courts', 'Pro shop', 'Coaching'],
      courts: [
        { name: 'Court 1', surface: 'clay', indoor: false, sportIds: [idOf('tennis')] },
        { name: 'Court 2', surface: 'hard', indoor: false, sportIds: [idOf('tennis')] },
      ],
    },
    {
      name: 'Satellite Indoor Sports Hall',
      address: 'Satellite Road',
      city: 'Ahmedabad',
      location: { lat: 23.0293, lng: 72.5297 },
      amenities: ['Air conditioned', 'Equipment rental'],
      courts: [
        { name: 'Hall Court 1', surface: 'wooden', indoor: true, sportIds: [idOf('badminton'), idOf('basketball')] },
        { name: 'Hall Court 2', surface: 'wooden', indoor: true, sportIds: [idOf('table-tennis')] },
      ],
    },
    {
      name: 'Gandhinagar Sports Complex',
      address: 'Sector 21, Gandhinagar',
      city: 'Gandhinagar',
      location: { lat: 23.2237, lng: 72.6501 },
      amenities: ['Floodlights', 'Parking', 'Cafe'],
      courts: [
        { name: 'Court 1', surface: 'acrylic', indoor: false, sportIds: [idOf('pickleball')] },
        { name: 'Court 2', surface: 'acrylic', indoor: false, sportIds: [idOf('pickleball')] },
        { name: 'Shuttle Hall', surface: 'wooden', indoor: true, sportIds: [idOf('badminton')] },
      ],
    },
    {
      name: 'Navrangpura Table Tennis Academy',
      address: 'CG Road, Navrangpura',
      city: 'Ahmedabad',
      location: { lat: 23.0395, lng: 72.5603 },
      amenities: ['Air conditioned', 'Coaching', 'Equipment rental'],
      courts: [
        { name: 'Table 1', surface: 'wooden', indoor: true, sportIds: [idOf('table-tennis')] },
        { name: 'Table 2', surface: 'wooden', indoor: true, sportIds: [idOf('table-tennis')] },
      ],
    },
  ];

  const venueId: Record<string, string> = {};
  let venuesCreated = 0;
  for (const v of venueSeeds) {
    const existing = await db.venue.findFirst({ where: { name: v.name } });
    if (existing) {
      venueId[v.name] = existing.id;
      continue;
    }
    const created = await venues.create(organizer, v);
    venueId[v.name] = created.id;
    venuesCreated += 1;
  }
  console.log(`Venues: ${venuesCreated} created (${venueSeeds.length} total)`);

  // --- events + categories -----------------------------------------------
  const eventSeeds = [
    {
      title: 'Ahmedabad Open Pickleball 2026',
      sport: 'pickleball',
      venue: 'SG Highway Pickleball Courts',
      startsAt: inDays(14),
      endsAt: inDays(15),
      categories: [
        { name: "Men's Doubles 3.5", format: 'doubles', capacity: 16, entryFeePaise: 60_000n, skillMin: 3.5, skillMax: 3.99 },
        { name: "Women's Doubles Open", format: 'doubles', capacity: 16, entryFeePaise: 60_000n },
      ],
    },
    {
      title: 'Prahlad Nagar Weekend Slam',
      sport: 'pickleball',
      venue: 'Prahlad Nagar Sports Arena',
      startsAt: inDays(5),
      endsAt: new Date(inDays(5).getTime() + 8 * HOUR),
      categories: [
        { name: 'Mixed Doubles 4.0', format: 'mixed_doubles', capacity: 12, entryFeePaise: 45_000n, skillMin: 4.0, skillMax: 4.49 },
      ],
    },
    {
      title: 'Vastrapur Lake Cup',
      sport: 'pickleball',
      venue: 'Vastrapur Sports Complex',
      startsAt: inDays(21),
      endsAt: inDays(22),
      categories: [{ name: 'Singles Open', format: 'singles', capacity: 24, entryFeePaise: 35_000n }],
    },
    {
      title: 'Ahmedabad 5-a-side Football League',
      sport: 'football',
      venue: 'Bopal Turf Arena',
      startsAt: inDays(10),
      endsAt: new Date(inDays(10).getTime() + 10 * HOUR),
      categories: [{ name: 'Open Division', format: 'five_a_side', capacity: 80, entryFeePaise: 250_000n }],
    },
    {
      title: 'Thaltej Open Tennis Championship',
      sport: 'tennis',
      venue: 'Thaltej Tennis Club',
      startsAt: inDays(18),
      endsAt: inDays(19),
      categories: [
        { name: "Men's Singles Open", format: 'singles', capacity: 32, entryFeePaise: 80_000n },
        { name: "Women's Singles Open", format: 'singles', capacity: 32, entryFeePaise: 80_000n },
      ],
    },
    {
      title: 'Satellite Badminton Premier',
      sport: 'badminton',
      venue: 'Satellite Indoor Sports Hall',
      startsAt: inDays(7),
      endsAt: new Date(inDays(7).getTime() + 9 * HOUR),
      categories: [{ name: "Men's Doubles", format: 'doubles', capacity: 16, entryFeePaise: 40_000n }],
    },
    {
      title: 'Gandhinagar Pickleball Classic',
      sport: 'pickleball',
      venue: 'Gandhinagar Sports Complex',
      startsAt: inDays(12),
      endsAt: inDays(13),
      categories: [
        { name: 'Singles 3.0', format: 'singles', capacity: 16, entryFeePaise: 30_000n, skillMin: 3.0, skillMax: 3.49 },
        { name: 'Mixed Doubles Open', format: 'mixed_doubles', capacity: 16, entryFeePaise: 50_000n },
      ],
    },
    {
      title: 'Gandhinagar Shuttle Smash',
      sport: 'badminton',
      venue: 'Gandhinagar Sports Complex',
      startsAt: inDays(9),
      endsAt: new Date(inDays(9).getTime() + 8 * HOUR),
      categories: [
        { name: "Women's Singles", format: 'singles', capacity: 16, entryFeePaise: 35_000n },
        { name: 'Mixed Doubles', format: 'mixed_doubles', capacity: 12, entryFeePaise: 45_000n },
      ],
    },
    {
      title: 'Navrangpura TT Open',
      sport: 'table-tennis',
      venue: 'Navrangpura Table Tennis Academy',
      startsAt: inDays(6),
      endsAt: new Date(inDays(6).getTime() + 9 * HOUR),
      categories: [
        { name: 'Singles Open', format: 'singles', capacity: 32, entryFeePaise: 25_000n },
        { name: 'Doubles Open', format: 'doubles', capacity: 16, entryFeePaise: 40_000n },
      ],
    },
    {
      title: 'Satellite 3x3 Hoops',
      sport: 'basketball',
      venue: 'Satellite Indoor Sports Hall',
      startsAt: inDays(16),
      endsAt: new Date(inDays(16).getTime() + 10 * HOUR),
      categories: [{ name: '3x3 Open', format: 'three_on_three', capacity: 48, entryFeePaise: 150_000n }],
    },
    // Razorpay test-mode checkout: a spread of amounts (₹1 up), a single-seat
    // category for the sold-out path, and one whose registration closes tomorrow.
    {
      title: 'Payment Test — ₹1 Rally',
      sport: 'pickleball',
      venue: 'SG Highway Pickleball Courts',
      startsAt: inDays(8),
      endsAt: new Date(inDays(8).getTime() + 4 * HOUR),
      categories: [
        { name: '₹1 Singles', format: 'singles', capacity: 50, entryFeePaise: 100n },
        { name: '₹10 Singles', format: 'singles', capacity: 50, entryFeePaise: 1_000n },
      ],
    },
    {
      title: 'Payment Test — Budget Smash',
      sport: 'badminton',
      venue: 'Satellite Indoor Sports Hall',
      startsAt: inDays(11),
      endsAt: new Date(inDays(11).getTime() + 6 * HOUR),
      categories: [
        { name: '₹99 Singles', format: 'singles', capacity: 40, entryFeePaise: 9_900n },
        { name: '₹199 Doubles', format: 'doubles', capacity: 20, entryFeePaise: 19_900n },
      ],
    },
    {
      title: 'Payment Test — Premium Tennis Invitational',
      sport: 'tennis',
      venue: 'Thaltej Tennis Club',
      startsAt: inDays(20),
      endsAt: inDays(21),
      categories: [
        { name: '₹1,999 Singles', format: 'singles', capacity: 32, entryFeePaise: 199_900n },
        { name: '₹4,999 Pro Singles', format: 'singles', capacity: 16, entryFeePaise: 499_900n },
      ],
    },
    {
      title: 'Payment Test — Last Seat Challenge',
      sport: 'table-tennis',
      venue: 'Navrangpura Table Tennis Academy',
      startsAt: inDays(13),
      endsAt: new Date(inDays(13).getTime() + 5 * HOUR),
      categories: [
        { name: 'One Seat Only', format: 'singles', capacity: 1, entryFeePaise: 5_000n },
        { name: 'Two Seats', format: 'singles', capacity: 2, entryFeePaise: 5_000n },
      ],
    },
    {
      title: 'Payment Test — Closing Tomorrow Cup',
      sport: 'pickleball',
      venue: 'Prahlad Nagar Sports Arena',
      startsAt: inDays(3),
      endsAt: new Date(inDays(3).getTime() + 6 * HOUR),
      categories: [{ name: 'Singles Open', format: 'singles', capacity: 24, entryFeePaise: 29_900n }],
    },
    {
      title: 'Payment Test — Weeknight Ladder',
      sport: 'pickleball',
      venue: 'Vastrapur Sports Complex',
      startsAt: inDays(4),
      endsAt: new Date(inDays(4).getTime() + 3 * HOUR),
      categories: [
        { name: 'Singles Ladder', format: 'singles', capacity: 32, entryFeePaise: 49_900n },
        { name: 'Doubles Ladder', format: 'doubles', capacity: 16, entryFeePaise: 79_900n },
      ],
    },
  ];

  let eventsPublished = 0;
  for (const e of eventSeeds) {
    const existing = await db.event.findFirst({ where: { title: e.title } });
    if (existing) continue;

    const created = await events.create(organizer, {
      sportId: idOf(e.sport),
      contactPhone: '9876543210',
      acceptHostTerms: true,
      title: e.title,
      venueId: venueId[e.venue]!,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      registrationClosesAt: new Date(e.startsAt.getTime() - 2 * DAY),
    });
    for (const c of e.categories) {
      await events.addCategory(organizer, created.id, {
        name: c.name,
        format: c.format,
        capacity: c.capacity,
        entryFeePaise: c.entryFeePaise,
        skillMin: c.skillMin ?? null,
        skillMax: c.skillMax ?? null,
      });
    }
    await events.publish(organizer, created.id);
    eventsPublished += 1;
  }
  console.log(`Events: ${eventsPublished} published (${eventSeeds.length} total)`);

  // --- players across sports ----------------------------------------------
  const playerSeeds = [
    { email: 'aarav.mehta.dev@pl4y.in', name: 'Aarav Mehta', city: 'Ahmedabad', sport: 'pickleball', skillBand: '3.5', geo: { lat: 23.02, lng: 72.5 } },
    { email: 'diya.shah.dev@pl4y.in', name: 'Diya Shah', city: 'Ahmedabad', sport: 'pickleball', skillBand: '4.0', geo: { lat: 23.03, lng: 72.51 } },
    { email: 'kabir.patel.dev@pl4y.in', name: 'Kabir Patel', city: 'Ahmedabad', sport: 'pickleball', skillBand: '3.0', geo: { lat: 23.01, lng: 72.52 } },
    { email: 'ishaan.joshi.dev@pl4y.in', name: 'Ishaan Joshi', city: 'Gandhinagar', sport: 'pickleball', skillBand: '4.5', geo: { lat: 23.22, lng: 72.65 } },
    { email: 'meera.iyer.dev@pl4y.in', name: 'Meera Iyer', city: 'Ahmedabad', sport: 'tennis', skillBand: '3.5', geo: { lat: 23.057, lng: 72.506 } },
    { email: 'rohan.desai.dev@pl4y.in', name: 'Rohan Desai', city: 'Ahmedabad', sport: 'football', skillBand: '4.0', geo: { lat: 23.033, lng: 72.47 } },
    { email: 'ananya.rao.dev@pl4y.in', name: 'Ananya Rao', city: 'Ahmedabad', sport: 'badminton', skillBand: '3.5', geo: { lat: 23.029, lng: 72.53 } },
    { email: 'vivaan.nair.dev@pl4y.in', name: 'Vivaan Nair', city: 'Ahmedabad', sport: 'basketball', skillBand: '5.0+', geo: { lat: 23.029, lng: 72.53 } },
    { email: 'tara.kapoor.dev@pl4y.in', name: 'Tara Kapoor', city: 'Ahmedabad', sport: 'pickleball', skillBand: '3.5', geo: { lat: 23.045, lng: 72.53 } },
    { email: 'arjun.verma.dev@pl4y.in', name: 'Arjun Verma', city: 'Ahmedabad', sport: 'pickleball', skillBand: '4.0', geo: { lat: 23.02, lng: 72.57 } },
    { email: 'nisha.bhatt.dev@pl4y.in', name: 'Nisha Bhatt', city: 'Ahmedabad', sport: 'pickleball', skillBand: '3.0', geo: { lat: 23.07, lng: 72.52 } },
    { email: 'sara.khan.dev@pl4y.in', name: 'Sara Khan', city: 'Gandhinagar', sport: 'pickleball', skillBand: '3.5', geo: { lat: 23.21, lng: 72.64 } },
    { email: 'yash.pandya.dev@pl4y.in', name: 'Yash Pandya', city: 'Ahmedabad', sport: 'pickleball', skillBand: '4.5', geo: { lat: 23.0, lng: 72.6 } },
    { email: 'riya.soni.dev@pl4y.in', name: 'Riya Soni', city: 'Ahmedabad', sport: 'table-tennis', skillBand: '4.0', geo: { lat: 23.04, lng: 72.56 } },
    { email: 'karan.malhotra.dev@pl4y.in', name: 'Karan Malhotra', city: 'Ahmedabad', sport: 'table-tennis', skillBand: '3.5', geo: { lat: 23.035, lng: 72.55 } },
    { email: 'zoya.sheikh.dev@pl4y.in', name: 'Zoya Sheikh', city: 'Gandhinagar', sport: 'badminton', skillBand: '4.0', geo: { lat: 23.23, lng: 72.66 } },
    { email: 'aditya.rana.dev@pl4y.in', name: 'Aditya Rana', city: 'Ahmedabad', sport: 'basketball', skillBand: '3.5', geo: { lat: 23.03, lng: 72.52 } },
    { email: 'pooja.menon.dev@pl4y.in', name: 'Pooja Menon', city: 'Ahmedabad', sport: 'tennis', skillBand: '4.0', geo: { lat: 23.06, lng: 72.5 } },
    { email: 'meet.chauhan.dev@pl4y.in', name: 'Meet Chauhan', city: 'Ahmedabad', sport: 'pickleball', skillBand: '4.0', geo: { lat: 23.05, lng: 72.54 } },
    { email: 'aisha.qureshi.dev@pl4y.in', name: 'Aisha Qureshi', city: 'Ahmedabad', sport: 'pickleball', skillBand: '3.5', geo: { lat: 23.01, lng: 72.55 } },
    { email: 'rahul.saxena.dev@pl4y.in', name: 'Rahul Saxena', city: 'Gandhinagar', sport: 'pickleball', skillBand: '3.0', geo: { lat: 23.22, lng: 72.63 } },
    { email: 'neha.gupta.dev@pl4y.in', name: 'Neha Gupta', city: 'Ahmedabad', sport: 'pickleball', skillBand: '4.5', geo: { lat: 23.04, lng: 72.51 } },
    { email: 'om.thakkar.dev@pl4y.in', name: 'Om Thakkar', city: 'Ahmedabad', sport: 'pickleball', skillBand: '3.5', geo: { lat: 23.0, lng: 72.53 } },
    { email: 'kavya.reddy.dev@pl4y.in', name: 'Kavya Reddy', city: 'Gandhinagar', sport: 'pickleball', skillBand: '4.0', geo: { lat: 23.23, lng: 72.64 } },
  ];

  let playersSeeded = 0;
  for (const p of playerSeeds) {
    const existingUser = await db.user.findUnique({ where: { email: p.email } });
    if (existingUser) continue;

    const userId = await upsertUser(p.email, p.name);
    const actor = { userId };
    await db.$transaction((tx) => profile.createFor(tx, userId));
    await profile.updateSports(actor, [{ sportId: idOf(p.sport), skillBand: p.skillBand }]);
    await profile.updateLocation(actor, { city: p.city, geo: p.geo });
    playersSeeded += 1;
  }
  console.log(`Players: ${playersSeeded} created (${playerSeeds.length} total)`);

  // --- a ranked ladder: settled ratings and leaderboards (rating R4, R9–R11) ---
  const LADDER = 'Ahmedabad Ladder Night';
  if (await db.event.findFirst({ where: { title: { startsWith: LADDER } } })) {
    console.log('Ladder: already seeded');
  } else {
    await seedLadder();
  }
  await settleLadder();

  async function seedLadder(): Promise<void> {
    const pickleball = idOf('pickleball');
    // A seeded generator, so every fresh database gets the same ladder.
    let state = 2026;
    const rng = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Hidden playing strength from the self-rated band: who tends to win.
    const STRENGTH: Record<string, number> = { '2.5': 1300, '3.0': 1400, '3.5': 1500, '4.0': 1650, '4.5': 1800 };
    const ladderEmails = [
      ...[...config.DEV_OTP_BYPASS_EMAILS].slice(0, 1),
      'aarav.mehta.dev@pl4y.in', 'diya.shah.dev@pl4y.in', 'kabir.patel.dev@pl4y.in',
      'ishaan.joshi.dev@pl4y.in', 'tara.kapoor.dev@pl4y.in', 'arjun.verma.dev@pl4y.in',
      'nisha.bhatt.dev@pl4y.in', 'sara.khan.dev@pl4y.in', 'yash.pandya.dev@pl4y.in',
      'meet.chauhan.dev@pl4y.in', 'aisha.qureshi.dev@pl4y.in', 'rahul.saxena.dev@pl4y.in',
      'neha.gupta.dev@pl4y.in', 'om.thakkar.dev@pl4y.in', 'kavya.reddy.dev@pl4y.in',
    ];
    const strength = new Map<string, number>();
    for (const email of ladderEmails) {
      const u = await db.user.findUnique({ where: { email } });
      if (!u) continue;
      const player = await db.playerProfile.findUniqueOrThrow({ where: { userId: u.id } });
      const ps = await db.playerSport.findFirst({ where: { playerId: player.id, sportId: pickleball } });
      if (!ps) continue;
      strength.set(u.id, STRENGTH[ps.skillBand] ?? 1500);
    }
    const ladder = [...strength.keys()];

    const WEEK = 7 * DAY;
    const weeksAgo = (k: number) => new Date(Date.now() - k * WEEK);
    const played = new Map(ladder.map((id) => [id, 0]));
    const loser = () => 3 + Math.floor(rng() * 7); // 3–9: always a legal 11-point game

    for (let n = 1; n <= 6; n += 1) {
      // Everyone plays three nights: take the eight who have played least.
      const shuffled = [...ladder];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const entrants = shuffled.sort((x, y) => played.get(x)! - played.get(y)!).slice(0, 8);
      for (const id of entrants) played.set(id, played.get(id)! + 1);

      const startsAt = inDays(25 + n);
      const night = await events.create(organizer, {
        sportId: pickleball,
        contactPhone: '9876543210',
        acceptHostTerms: true,
        title: `${LADDER} #${n}`,
        venueId: venueId['SG Highway Pickleball Courts']!,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 4 * HOUR),
        registrationClosesAt: inDays(2),
      });
      const category = await events.addCategory(organizer, night.id, {
        name: 'Ladder Singles',
        format: 'singles',
        capacity: 8,
        minEntries: 2,
        entryFeePaise: 0n,
        platformFeePaise: 0n,
        skillMin: null,
        skillMax: null,
      });
      await events.publish(organizer, night.id);

      const userByEntry = new Map<string, string>();
      for (const userId of entrants) {
        const entry = await registration.begin({ userId }, { eventCategoryId: category.id });
        userByEntry.set(entry.id, userId);
      }
      const draw = await tournament.generateDraw(organizer, { eventCategoryId: category.id });

      // Play every match the bracket makes ready, main draw and plate, until none is left.
      const matchIds: string[] = [];
      for (let pass = 0; pass < 40; pass += 1) {
        const ready = (await tournament.matchesFor(draw.id)).filter(
          (m) => m.status === 'ready' && m.sideARegistrationId && m.sideBRegistrationId,
        );
        if (ready.length === 0) break;
        for (const m of ready) {
          const a = userByEntry.get(m.sideARegistrationId!)!;
          const b = userByEntry.get(m.sideBRegistrationId!)!;
          const aWins = rng() < 1 / (1 + 10 ** ((strength.get(b)! - strength.get(a)!) / 400));
          const games = aWins
            ? [{ a: 11, b: loser() }, { a: 11, b: loser() }]
            : [{ a: loser(), b: 11 }, { a: loser(), b: 11 }];
          await scoring.submitResult(organizer, { matchId: m.id, outcome: 'played', games });
          await scoring.confirmResult({ userId: a }, m.id);
          matchIds.push(m.id);
        }
      }

      // Nights 1–3 happened two weeks ago, 4–6 last week: two settled periods,
      // so the second rebuild has a previous rank to measure movement from.
      // Dev-only shortcut — nothing in the product can move a confirmation.
      const when = new Date(weeksAgo(n <= 3 ? 2 : 1).getTime() + n * HOUR);
      await db.$executeRaw`
        UPDATE match_results SET submitted_at = ${when}, confirmed_at = ${when}
         WHERE match_id = ANY(${matchIds}::uuid[])
      `;
      console.log(`Ladder: night #${n} — ${entrants.length} players, ${matchIds.length} matches`);
    }

  }

  /** Runs the two ladder weeks' rating periods; a week already settled is left alone. */
  async function settleLadder(): Promise<void> {
    const pickleball = idOf('pickleball');
    const weeksAgo = (k: number) => new Date(Date.now() - k * 7 * DAY);
    for (const k of [2, 1]) {
      const period = await rating.periodFor(pickleball, weeksAgo(k));
      try {
        const { playersUpdated } = await rating.runPeriod(period.id);
        const { boards } = await rating.rebuildAll(pickleball);
        console.log(`Ladder: settled the week of ${period.startsAt.toDateString()} — ${playersUpdated} players, ${boards} boards`);
      } catch (err) {
        const code = (err as { extensions?: { code?: string } }).extensions?.code;
        if (code !== 'PERIOD_ALREADY_RUN') throw err;
        console.log(`Ladder: the week of ${period.startsAt.toDateString()} was already settled`);
      }
    }

    const top = await db.$queryRaw<{ rank: number; name: string; rating: number; movement: number }[]>`
      SELECT r.rank, u.display_name AS name, r.rating::float AS rating, r.movement
        FROM rankings r
        JOIN player_profiles pp ON pp.id = r.player_id
        JOIN users u ON u.id = pp.user_id
       WHERE r.sport_id = ${pickleball}::uuid AND r.scope = 'national'
       ORDER BY r.rank LIMIT 5
    `;
    for (const t of top) {
      const move = t.movement > 0 ? `▲${t.movement}` : t.movement < 0 ? `▼${-t.movement}` : '–';
      console.log(`  #${t.rank} ${t.name} ${Math.round(t.rating)} ${move}`);
    }
  }

  // --- a live draw with results in every confirmation state (scoring R11–R14) --
  const LIVE_TITLE = 'PL4Y Result Finality Test Cup';
  if (await db.event.findFirst({ where: { title: LIVE_TITLE } })) {
    console.log(`Finality test draw: already seeded ("${LIVE_TITLE}")`);
    return;
  }

  const pickleballId = idOf('pickleball');
  const startsAt = inDays(4);
  const live = await events.create(organizer, {
    sportId: pickleballId,
    contactPhone: '9876543210',
    acceptHostTerms: true,
    title: LIVE_TITLE,
    venueId: venueId['SG Highway Pickleball Courts']!,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 10 * HOUR),
    registrationClosesAt: inDays(2),
  });
  const category = await events.addCategory(organizer, live.id, {
    name: 'Singles Open (free)',
    format: 'singles',
    capacity: 8,
    minEntries: 2,
    entryFeePaise: 0n,
    platformFeePaise: 0n,
    skillMin: null,
    skillMax: null,
  });
  await events.publish(organizer, live.id);

  // The dev account plays too, and manages the event so it can use the override.
  const devEmail = [...config.DEV_OTP_BYPASS_EMAILS][0] ?? null;
  const devUser = devEmail ? await db.user.findUnique({ where: { email: devEmail } }) : null;
  const pickleballers = [
    'aarav.mehta.dev@pl4y.in', 'diya.shah.dev@pl4y.in', 'kabir.patel.dev@pl4y.in',
    'ishaan.joshi.dev@pl4y.in', 'tara.kapoor.dev@pl4y.in', 'arjun.verma.dev@pl4y.in',
    'nisha.bhatt.dev@pl4y.in', 'sara.khan.dev@pl4y.in', 'yash.pandya.dev@pl4y.in',
  ];
  const entrantIds: string[] = [];
  if (devUser) entrantIds.push(devUser.id);
  for (const email of pickleballers) {
    if (entrantIds.length === 8) break;
    const u = await db.user.findUniqueOrThrow({ where: { email } });
    entrantIds.push(u.id);
  }

  const userByEntry = new Map<string, string>();
  for (const userId of entrantIds) {
    // Registering needs a skill in the sport. Added only when missing, so the
    // dev account's own choices are never overwritten.
    const player = await db.playerProfile.findUniqueOrThrow({ where: { userId } });
    const hasSport = await db.playerSport.findFirst({ where: { playerId: player.id, sportId: pickleballId } });
    if (!hasSport) {
      await db.playerSport.create({ data: { playerId: player.id, sportId: pickleballId, skillBand: '3.5' } });
    }
    const entry = await registration.begin({ userId }, { eventCategoryId: category.id });
    userByEntry.set(entry.id, userId);
  }
  if (devUser) await identity.addStaff(live.id, devUser.id, 'manager');

  const draw = await tournament.generateDraw(organizer, { eventCategoryId: category.id });
  const firstRound = (await tournament.matchesFor(draw.id)).filter(
    (m) => m.bracket === 'championship' && m.round === 1 && m.sideARegistrationId && m.sideBRegistrationId,
  );
  const actorOf = (entryId: string | null) => ({ userId: userByEntry.get(entryId!)! });

  /** Scores point after point for `side` until the rule says the match is over. */
  async function playOut(scorer: { userId: string }, matchId: string, side: 'a' | 'b'): Promise<void> {
    await scoring.start(scorer, matchId);
    let snap = await scoring.snapshot(matchId);
    for (let i = 0; i < 200 && !snap.state?.matchOver; i += 1) {
      snap = await scoring.recordPoint(scorer, { matchId, side, expectedSeq: snap.seq });
    }
  }

  const devEntry = devUser ? [...userByEntry].find(([, u]) => u === devUser.id)?.[0] : undefined;
  const devMatch = firstRound.find((m) => m.sideARegistrationId === devEntry || m.sideBRegistrationId === devEntry);
  const others = firstRound.filter((m) => m !== devMatch);
  const summary: string[] = [];

  // 1. The dev account must answer: the opponent live-scored their own win.
  //    Auto-confirms ~60 minutes after this seed runs (R11).
  const answering = devMatch ?? others.shift()!;
  const oppSide: 'a' | 'b' = answering.sideARegistrationId === devEntry ? 'b' : 'a';
  const oppEntry = oppSide === 'a' ? answering.sideARegistrationId : answering.sideBRegistrationId;
  await playOut(actorOf(oppEntry), answering.id, oppSide);
  summary.push(`${answering.id}  live, waiting on ${devMatch ? 'YOU' : 'side b'} — auto-confirms in ~60 min`);

  // 2. Live-scored and confirmed by the opponent: the winner has advanced.
  const confirmed = others.shift();
  if (confirmed) {
    await playOut(actorOf(confirmed.sideARegistrationId), confirmed.id, 'a');
    await scoring.confirmResult(actorOf(confirmed.sideBRegistrationId), confirmed.id);
    summary.push(`${confirmed.id}  live, confirmed by the opponent — winner advanced`);
  }

  // 3. Typed by a player: never confirms itself (R12); the opponent or an organizer must.
  const typed = others.shift();
  if (typed) {
    await scoring.submitResult(actorOf(typed.sideARegistrationId), {
      matchId: typed.id,
      outcome: 'played',
      games: [{ a: 11, b: 7 }, { a: 11, b: 9 }],
    });
    summary.push(`${typed.id}  typed by a player — no auto-confirm; organizer override after 15 min`);
  }

  // 4. Disputed: only an owner or manager settles it.
  const disputed = others.shift();
  if (disputed) {
    await playOut(actorOf(disputed.sideARegistrationId), disputed.id, 'a');
    await scoring.disputeResult(
      actorOf(disputed.sideBRegistrationId),
      disputed.id,
      'Second game was 11–9, not 11–0.',
    );
    summary.push(`${disputed.id}  disputed — waiting on the organizer`);
  }

  console.log(`Finality test draw: "${LIVE_TITLE}" (${entrantIds.length} entrants${devUser ? `, incl. ${devEmail} as player + manager` : ''})`);
  for (const line of summary) console.log(`  match ${line}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The real modules start the queue runtime; left open, its timers keep the
    // process alive after the work is done.
    const { closeQueues } = await import('../src/platform/queue.js');
    await closeQueues().catch(() => undefined);
    await disconnectDb();
  });
