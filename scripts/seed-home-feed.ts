/**
 * `pnpm seed:home` — local sample data that fills every region of the Home
 * screen (docs/modules/21-home.md) for the dev sign-in account, with real
 * Cloudinary cover images.
 *
 *   · uploads the app's bundled sport photos to Cloudinary as
 *     `pl4y/seed/sports/<slug>` (licences: PLAY_FRONTEND/apps/player/assets/sports/ATTRIBUTION.md)
 *   · gives every event without a cover the photo for its sport
 *   · publishes a multi-sport set of events in the dev account's city
 *   · enters the dev account in three of them, and marks one LIVE
 *   · writes a stats snapshot, which `scoring` will own once it exists
 *
 * Run `pnpm cloudinary:setup` once first, or the cover URLs 404.
 * Local-only and safe to re-run: events match by title, entries by event.
 * Photos come from PL4Y_SEED_IMAGES, else the sibling PLAY_FRONTEND checkout.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config, isProd } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { LAUNCH_SPORTS, seedLaunchSports } from '../src/modules/sport/seed.js';
import { buildModules } from '../tests/helpers/modules.js';

if (isProd) {
  console.error('seed-home-feed refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.now() + ms);

const IMAGES =
  process.env.PL4Y_SEED_IMAGES ??
  fileURLToPath(new URL('../../PLAY_FRONTEND/apps/player/assets/sports/', import.meta.url));
const coverId = (slug: string) => `pl4y/seed/sports/${slug}`;

// --- Cloudinary --------------------------------------------------------------

/** A signed server-side upload. `overwrite` makes a re-run replace, not duplicate. */
async function uploadCover(slug: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    overwrite: 'true',
    public_id: coverId(slug),
    timestamp: String(timestamp),
  };
  const canonical = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = createHash('sha1').update(canonical + config.CLOUDINARY_API_SECRET).digest('hex');

  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append('api_key', config.CLOUDINARY_API_KEY);
  form.append('signature', signature);
  form.append('file', new Blob([await readFile(`${IMAGES}${slug}.jpg`)], { type: 'image/jpeg' }), `${slug}.jpg`);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${config.CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: 'POST', body: form },
  );
  if (!res.ok) throw new Error(`upload ${slug}: ${res.status} ${await res.text()}`);
}

// --- data --------------------------------------------------------------------

interface CategorySeed {
  name: string;
  format: string;
  capacity: number;
  entryFeePaise: bigint;
}

interface EventSeed {
  title: string;
  sport: string;
  venue: string;
  startsAt: Date;
  endsAt: Date;
  categories: CategorySeed[];
  /** Enter the dev account in the first category. It must be free singles. */
  enter?: boolean;
  live?: boolean;
}

const free = (name: string): CategorySeed => ({ name, format: 'singles', capacity: 24, entryFeePaise: 0n });

function eventSeeds(city: string): EventSeed[] {
  return [
    {
      title: `${city} Pickleball Night Series`,
      sport: 'pickleball',
      venue: `${city} Pickleball Hub`,
      // Registration closes at +1 h and the event starts at +2 h. The seed
      // enters first and then marks the event LIVE, so it lands in liveNow.
      startsAt: at(2 * HOUR),
      endsAt: at(8 * HOUR),
      categories: [free('Singles Ladder')],
      enter: true,
      live: true,
    },
    {
      title: `${city} Badminton Smash`,
      sport: 'badminton',
      venue: `${city} Indoor Arena`,
      startsAt: at(3 * DAY),
      endsAt: at(3 * DAY + 9 * HOUR),
      categories: [free("Men's Singles Intermediate")],
      enter: true,
    },
    {
      title: `${city} Tennis Classic`,
      sport: 'tennis',
      venue: `${city} Tennis Club`,
      startsAt: at(5 * DAY),
      endsAt: at(6 * DAY),
      categories: [{ name: "Men's Singles Open", format: 'singles', capacity: 32, entryFeePaise: 80_000n }],
    },
    {
      title: `${city} 5-a-side Cup`,
      sport: 'football',
      venue: `${city} Turf Park`,
      startsAt: at(6 * DAY),
      endsAt: at(6 * DAY + 10 * HOUR),
      categories: [{ name: 'Open Division', format: 'five_a_side', capacity: 40, entryFeePaise: 250_000n }],
    },
    {
      title: `${city} Pickleball Open`,
      sport: 'pickleball',
      venue: `${city} Pickleball Hub`,
      startsAt: at(8 * DAY),
      endsAt: at(9 * DAY),
      categories: [free('Singles 2.5–3.0 Social')],
      enter: true,
    },
    {
      title: `${city} Table Tennis Masters`,
      sport: 'table-tennis',
      venue: `${city} Indoor Arena`,
      startsAt: at(10 * DAY),
      endsAt: at(10 * DAY + 8 * HOUR),
      categories: [{ name: 'Singles Open', format: 'singles', capacity: 32, entryFeePaise: 30_000n }],
    },
    {
      title: `${city} 3x3 Hoops`,
      sport: 'basketball',
      venue: `${city} Indoor Arena`,
      startsAt: at(12 * DAY),
      endsAt: at(12 * DAY + 8 * HOUR),
      categories: [{ name: '3x3 Open', format: 'three_on_three', capacity: 16, entryFeePaise: 120_000n }],
    },
    {
      title: `${city} Doubles Bash`,
      sport: 'pickleball',
      venue: `${city} Pickleball Hub`,
      startsAt: at(14 * DAY),
      endsAt: at(15 * DAY),
      categories: [{ name: 'Mixed Doubles 3.5', format: 'mixed_doubles', capacity: 16, entryFeePaise: 60_000n }],
    },
  ];
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  await seedLaunchSports(db);
  const { sport, profile, venues, events, registration } = buildModules(db);
  sport.refresh();
  const sportId = new Map<string, string>();
  for (const s of LAUNCH_SPORTS) sportId.set(s.slug, (await sport.bySlug(s.slug)).id);
  const idOf = (slug: string) => sportId.get(slug)!;

  // 1. Covers — upload once, then point every uncovered event at its sport's photo.
  for (const s of LAUNCH_SPORTS) {
    await uploadCover(s.slug);
    console.log(`Cloudinary: uploaded ${coverId(s.slug)}`);
  }

  // 2. The dev account and its city.
  const email = [...config.DEV_OTP_BYPASS_EMAILS][0];
  if (!email) throw new Error('DEV_OTP_BYPASS_EMAILS is empty — there is no dev account to seed for.');
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error(`Run \`pnpm seed\` first: ${email} has no user.`);
  const me = await profile.findByUserId(user.id);
  if (!me) throw new Error('The dev account has no profile yet: finish onboarding in the app, then re-run.');
  const city = me.city ?? 'Bengaluru';
  const actor = { userId: user.id };
  // Entries need the sport on the profile (registration asserts it). Adding a
  // sport keeps the player's existing ones and their skill bands.
  const mine = new Set(me.sports.map((s) => s.sportId));
  const wanted = ['pickleball', 'badminton'].filter((slug) => !mine.has(idOf(slug)));
  if (wanted.length > 0) {
    await profile.updateSports(actor, [
      ...me.sports.map((s) => ({ sportId: s.sportId, skillBand: s.skillBand })),
      ...wanted.map((slug) => ({ sportId: idOf(slug), skillBand: '3.0' })),
    ]);
  }

  // 3. Venues and events in that city, under a dev organizer.
  const organizerEmail = 'organizer.dev@pl4y.in';
  const organizerUser =
    (await db.user.findUnique({ where: { email: organizerEmail } })) ??
    (await db.user.create({ data: { id: newId(), email: organizerEmail, displayName: 'PL4Y Dev Organizer' } }));
  const organizer = { userId: organizerUser.id };

  const venueGeo = { lat: 12.9716, lng: 77.5946 };
  const venueId = new Map<string, string>();
  for (const seed of eventSeeds(city)) {
    if (venueId.has(seed.venue)) continue;
    const existing = await db.venue.findFirst({ where: { name: seed.venue } });
    const venue = existing ?? (await venues.create(organizer, {
      name: seed.venue,
      address: `${seed.venue}, ${city}`,
      city,
      location: venueGeo,
      amenities: ['Floodlights', 'Parking'],
    }));
    venueId.set(seed.venue, venue.id);
  }

  let created = 0;
  let entered = 0;
  for (const seed of eventSeeds(city)) {
    let event = await db.event.findFirst({ where: { title: seed.title, status: { in: ['published', 'live'] } } });
    if (!event) {
      const draft = await events.create(organizer, {
        sportId: idOf(seed.sport),
        contactPhone: '9876543210',
        acceptHostTerms: true,
        venueId: venueId.get(seed.venue)!,
        title: seed.title,
        city,
        startsAt: seed.startsAt,
        endsAt: seed.endsAt,
        registrationClosesAt: new Date(seed.startsAt.getTime() - HOUR),
      });
      for (const c of seed.categories) {
        await events.addCategory(organizer, draft.id, { ...c, skillMin: null, skillMax: null });
      }
      await events.publish(organizer, draft.id);
      event = await db.event.findUniqueOrThrow({ where: { id: draft.id } });
      created += 1;
    }

    if (seed.enter) {
      const already = (await registration.listForUser(user.id)).some((r) => r.eventId === event.id);
      if (!already && event.status === 'published') {
        const [category] = await events.categoriesFor(event.id);
        await registration.begin(actor, { eventCategoryId: category!.id });
        entered += 1;
      }
    }
    if (seed.live && event.status === 'published') await events.markLive(event.id);
  }
  console.log(`Events in ${city}: ${created} created, dev account entered in ${entered}`);

  // 4. Every event without a cover gets its sport's photo.
  let covered = 0;
  for (const s of LAUNCH_SPORTS) {
    const res = await db.event.updateMany({
      where: { sportId: idOf(s.slug), coverPublicId: null },
      data: { coverPublicId: coverId(s.slug) },
    });
    covered += res.count;
  }
  console.log(`Covers: set on ${covered} events`);

  // 5. Stats — materialised by `scoring` once it exists (profile R8). Seeded here
  //    so region 6 has something to show.
  await profile.recordStatsSnapshot(me.id, {
    sportId: idOf('pickleball'),
    matchesPlayed: 12,
    wins: 8,
    losses: 4,
    winRate: 8 / 12,
    currentStreak: 3,
    tournamentsPlayed: 3,
    bestFinish: 'Runner-up',
  });
  console.log(`Stats: pickleball snapshot written for ${email.replace(/^(..).*@/, '$1***@')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
