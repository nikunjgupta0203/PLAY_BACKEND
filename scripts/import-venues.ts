/**
 * `pnpm import:venues <file.json> [--apply]` — list venues from a prepared data
 * file (scripts/data/*.json): name, address, city, point, amenities, one playing
 * area per sport, description, opening hours and phone.
 *
 * The venues belong to a guest account nobody can sign in to, so they show on
 * Discover and the map but on no one's venue desk, and PL4Y staff edit them in
 * the portal. Written through the service without platform staff, so none of
 * them is announced as news.
 *
 * Without --apply it only reports what it would do. Safe to re-run: a venue
 * already listed with the same name within 300 m is skipped.
 */
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { db, disconnectDb } from '../src/platform/db.js';
import { GUEST_EMAIL_DOMAIN } from '../src/modules/identity/service/index.js';
import { venues } from '../src/modules/venues/index.js';
import type { CourtKind, OpeningHours } from '../src/modules/venues/index.js';

interface Row {
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  amenities: string[];
  courts: { name: string; kind: CourtKind; sport: string }[];
  description: string | null;
  openingHours: OpeningHours[];
  contactPhone: string | null;
}

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) throw new Error('usage: pnpm import:venues <file.json> [--apply]');
const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];

const sports = new Map((await db.sport.findMany({ select: { id: true, slug: true } })).map((s) => [s.slug, s.id]));
const missing = [...new Set(rows.flatMap((r) => r.courts.map((c) => c.sport)))].filter((s) => !sports.has(s));
if (missing.length > 0) throw new Error(`Unknown sport(s): ${missing.join(', ')}`);

const LISTINGS_EMAIL = `venue-listings@${GUEST_EMAIL_DOMAIN}`;
const owner =
  (await db.user.findUnique({ where: { email: LISTINGS_EMAIL }, select: { id: true } })) ??
  (apply
    ? await db.user.create({
        data: { id: crypto.randomUUID(), email: LISTINGS_EMAIL, displayName: 'PL4Y', isGuest: true },
        select: { id: true },
      })
    : { id: '00000000-0000-0000-0000-000000000000' });

async function alreadyListed(r: Row): Promise<boolean> {
  const hit = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM venues
     WHERE deleted_at IS NULL
       AND lower(name) = lower(${r.name})
       AND ST_DWithin(geo, ST_SetSRID(ST_MakePoint(${r.lng}, ${r.lat}), 4326)::geography, 300)
     LIMIT 1
  `);
  return hit.length > 0;
}

let created = 0;
let skipped = 0;
const failed: string[] = [];

async function one(r: Row): Promise<void> {
  if (await alreadyListed(r)) {
    skipped += 1;
    return;
  }
  if (!apply) {
    created += 1;
    return;
  }
  const actor = { userId: owner.id };
  try {
    const v = await venues.create(actor, {
      name: r.name,
      address: r.address,
      city: r.city,
      location: { lat: r.lat, lng: r.lng },
      amenities: r.amenities,
      courts: r.courts.map((c) => ({ name: c.name, kind: c.kind, sportIds: [sports.get(c.sport)!] })),
    });
    await venues.update(actor, v.id, {
      description: r.description,
      openingHours: r.openingHours,
      contactPhone: r.contactPhone,
    });
    created += 1;
  } catch (err) {
    failed.push(`${r.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// A few at a time: the production database is a long round trip away.
const queue = [...rows];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      await one(r);
      const done = created + skipped + failed.length;
      if (done % 100 === 0) console.log(`  ${done}/${rows.length}`);
    }
  }),
);

console.log(
  `${apply ? 'Listed' : 'Would list'} ${created} venue(s); ${skipped} already listed; ${failed.length} failed.` +
    (apply ? '' : ' Re-run with --apply to write.'),
);
for (const f of failed) console.log(`  failed — ${f}`);

await disconnectDb();
process.exit(failed.length > 0 ? 1 : 0);
