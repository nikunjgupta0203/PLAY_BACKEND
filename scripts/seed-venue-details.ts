/**
 * `pnpm seed:venues` — local sample data for the venue page (venues R6–R8,
 * R10, R12): a description, opening hours and a phone for every venue, the
 * right playing-area kind on its courts, and a few reviews at the venue the
 * ladder nights were played at — written through the service, so R6
 * eligibility and the R7 rating are exercised rather than faked.
 *
 * Run `pnpm backfill:match-history` first: reviews need venue_visits.
 * Local-only and safe to re-run — every write is an update or an upsert.
 */
import { isProd } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { venues } from '../src/modules/venues/index.js';
import type { CourtKind, OpeningHours } from '../src/modules/venues/index.js';

if (isProd) throw new Error('seed:venues is local-only');

/** Mon–Fri two sessions, weekends all day. */
const WEEK: OpeningHours[] = [
  ...[0, 1, 2, 3, 4].flatMap((day) => [
    { day, opens: '06:00', closes: '10:00' },
    { day, opens: '16:00', closes: '22:30' },
  ]),
  { day: 5, opens: '06:00', closes: '23:00' },
  { day: 6, opens: '06:00', closes: '21:00' },
];

const kindFor = (venueName: string): CourtKind =>
  /turf/i.test(venueName) ? 'turf' : /table tennis/i.test(venueName) ? 'table' : 'court';

const describe = (name: string, city: string, courts: number, kind: CourtKind) => {
  const area = kind === 'turf' ? 'turfs' : kind === 'table' ? 'tables' : 'courts';
  return (
    `${name} has ${courts} ${area} in ${city}, floodlit for evening play. ` +
    'Changing rooms, drinking water and parking on site; equipment on hire at the desk.'
  );
};

const REVIEWS = [
  { stars: 5, body: 'Best-lit courts in the city. The surface was resurfaced this season and it shows.' },
  { stars: 4, body: 'Great for ladder nights. Parking fills up after 7pm, so come early.' },
  { stars: 4, body: 'Friendly staff and the nets are always tight. Water cooler could use a refill more often.' },
  { stars: 3, body: 'Good courts, but the Saturday crowd means you wait between matches.' },
];

const all = await db.venue.findMany({
  where: { deletedAt: null },
  select: { id: true, name: true, city: true, createdBy: true, courts: { select: { id: true } } },
});

for (const v of all) {
  const kind = kindFor(v.name);
  await venues.update({ userId: v.createdBy }, v.id, {
    description: describe(v.name, v.city, v.courts.length || 1, kind),
    openingHours: WEEK,
    contactPhone: '+91 79 4000 1234',
  });
  for (const c of v.courts) await venues.updateCourt({ userId: v.createdBy }, c.id, { kind });
}
console.log(`Details: ${all.length} venue(s) given a description, hours and court kinds.`);

// Reviews from players who played here — never the dev account, so it can write its own.
const devEmails = new Set((process.argv[2] ?? 'sakshamarya015@gmail.com').split(','));
const visited = await db.venueVisit.findMany({
  distinct: ['venueId', 'userId'],
  select: { venueId: true, userId: true, user: { select: { email: true } } },
  orderBy: [{ venueId: 'asc' }, { userId: 'asc' }],
});
let written = 0;
const perVenue = new Map<string, number>();
for (const v of visited) {
  if (devEmails.has(v.user.email)) continue;
  const n = perVenue.get(v.venueId) ?? 0;
  const text = REVIEWS[n];
  if (!text) continue;
  await venues.review({ userId: v.userId }, v.venueId, text);
  perVenue.set(v.venueId, n + 1);
  written += 1;
}
console.log(`Reviews: ${written} written across ${perVenue.size} venue(s).`);

await disconnectDb();
process.exit(0);
