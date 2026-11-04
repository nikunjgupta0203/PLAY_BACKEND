/**
 * `pnpm onboard:venues <sheet.xlsx|sheet.csv> [--apply]` — onboard venues from
 * the onboarding sheet (scripts/data/venue-onboarding-template.xlsx, Venues
 * tab, one row per venue) and give each its owner's account.
 *
 *   · Owner: found by email, or created (name, email, phone) the way the
 *     portal's "New user" does. Sign-in is the email code, so nothing else is
 *     needed, and nobody is emailed.
 *   · Venue: listed with the owner as its creator, which makes it theirs: the
 *     venue desk in the app, its tables, prices, bookings and staff. Tables or
 *     courts are "<Sport> 1…n"; a price gives every one of them weekly rules
 *     over the opening hours (with the peak band, if any); "Take bookings"
 *     switches bookings on. "Payment" At venue / Both (2026-11-04) switches
 *     on walk-in Pay at venue, with an hourly rate per sport from its prices
 *     (and a peak one); table bookings themselves are always paid online.
 *
 * Without --apply it only checks each row and says what it would do.
 *
 * Safe to re-run: a venue this owner already runs with the same name within
 * 300 m is updated, not listed again (blank optional cells leave it as it is;
 * missing tables are added, none removed). A venue with that name nearby from
 * the 2026-10-30 import is NOT reused — the row is listed new and the old one
 * named, so staff can remove it in the portal. One another owner runs is a
 * conflict and is left alone.
 *
 * Nothing is announced to nearby players: the owner's own account adds the
 * venue, as import-venues does, not platform staff.
 */
import { Prisma } from '@prisma/client';
import { db, disconnectDb } from '../src/platform/db.js';
import { GUEST_EMAIL_DOMAIN } from '../src/modules/identity/service/index.js';
import { identity } from '../src/modules/identity/index.js';
import { venues, COURT_KINDS } from '../src/modules/venues/index.js';
import type { CourtKind, OpeningHours } from '../src/modules/venues/index.js';
import { validPhone } from '../src/modules/venues/service/hostDetails.js';
import { bookings } from '../src/modules/bookings/index.js';
import { venuePay } from '../src/modules/venuepay/index.js';
import type { PaymentOptions } from '../src/modules/bookings/index.js';
import { readSheet, type SheetRow } from './lib/sheet.js';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file || file.startsWith('--')) throw new Error('usage: pnpm onboard:venues <sheet.xlsx|sheet.csv> [--apply]');

const SAME_VENUE_M = 300;
const MAX_TABLES = 60;
const MAX_PRICE_RUPEES = 100_000;
const SPORT_GROUPS = 4;
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TABLE_SPORTS = new Set(['snooker', 'pool', 'billiards', 'table-tennis', 'carrom']);
/** The Lists tab's standard names, so "wifi" and "Wi-Fi" are one amenity. */
const AMENITIES = [
  'Air conditioning', 'Drinking water', 'Washrooms', 'Parking', 'Seating', 'Cafe', 'Wi-Fi',
  'Equipment on rent', 'Coaching', 'Lockers', 'Changing rooms', 'Showers', 'First aid',
  'Floodlights', 'CCTV', 'Power backup', 'Pro shop', 'Warm-up area', 'Live streaming',
  'Artificial turf', 'Natural grass', 'Walking track', 'Ball boy', 'Non-marking shoes on rent',
];
const amenityKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const STANDARD_AMENITY = new Map(AMENITIES.map((a) => [amenityKey(a), a]));

interface Group {
  sportId: string;
  sportName: string;
  count: number;
  kind: CourtKind;
  pricePaise: bigint | null;
  peakPaise: bigint | null;
}

interface Plan {
  line: number;
  label: string;
  owner: { name: string; email: string; phone: string | null };
  name: string;
  address: string;
  city: string;
  location: { lat: number; lng: number };
  phone: string | null;
  indoor: boolean | null;
  amenities: string[] | null;
  description: string | null;
  hours: OpeningHours[];
  groups: Group[];
  peak: { from: number; to: number } | null;
  takeBookings: boolean | null;
  payment: PaymentOptions | null;
}

// --- reading a row ------------------------------------------------------------------

/**
 * "18:30", "6:30 PM", "18:30:00", or a day fraction from a number-formatted
 * cell → minutes. Midnight (24:00) is 23:59: a rule's `time` column has no 24:00.
 */
function minutesOf(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^0?\.\d+$|^0$|^1$/.test(s)) return Math.min(Math.round(Number(s) * 1440), 1439);
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return Math.min(h * 60 + min, 1439);
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** "28.6415, 77.1209" inside a Maps link: the pin (!3d…!4d…) first, then @…, q=…, ll=…. */
function pointInLink(url: string): { lat: number; lng: number } | null {
  const u = decodeURIComponent(url);
  const pin = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(u);
  const any = pin ?? /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(u) ?? /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(u);
  return any ? { lat: Number(any[1]), lng: Number(any[2]) } : null;
}

/** Share links (maps.app.goo.gl) carry no point until followed. */
async function resolveLink(url: string): Promise<{ lat: number; lng: number } | null> {
  let at = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  for (let hop = 0; hop < 6; hop++) {
    const found = pointInLink(at);
    if (found) return found;
    const res = await fetch(at, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const next = res.headers.get('location');
    if (!next) {
      // Some pages put the point in the body instead of a redirect.
      return pointInLink(await res.text());
    }
    at = new URL(next, at).toString();
  }
  return null;
}

async function planOf(row: SheetRow, sports: Map<string, { id: string; name: string; slug: string }>): Promise<Plan | string[]> {
  const get = (h: string) => row.cells[h] ?? '';
  const errors: string[] = [];
  const need = (h: string, label: string) => {
    const v = get(h).replace(/\s+/g, ' ').trim();
    if (!v) errors.push(`${label} is required`);
    return v;
  };
  const max = (v: string, n: number, label: string) => {
    if (v.length > n) errors.push(`${label} is over ${n} characters`);
  };

  const ownerName = need('owner name', 'Owner name');
  if (ownerName && (ownerName.length < 2 || ownerName.length > 40)) errors.push('Owner name is 2 to 40 characters');
  const email = need('owner email', 'Owner email').toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push(`Owner email “${email}” is not an email address`);
  if (email.endsWith(`@${GUEST_EMAIL_DOMAIN}`)) errors.push('Owner email must be a real address');
  const ownerPhone = get('owner phone') || null;
  if (ownerPhone && !/^[+\d\s()-]+$/.test(ownerPhone)) errors.push(`Owner phone “${ownerPhone}” has letters in it (a number cell shown as 9.18E+11? format the column as text)`);
  else if (ownerPhone && !validPhone(ownerPhone)) errors.push(`Owner phone “${ownerPhone}” needs 10 to 13 digits`);

  const name = need('venue name', 'Venue name');
  max(name, 120, 'Venue name');
  const address = need('address', 'Address');
  max(address, 300, 'Address');
  const city = need('city', 'City');
  max(city, 80, 'City');

  let location: { lat: number; lng: number } | null = null;
  const lat = get('latitude');
  const lng = get('longitude');
  const link = get('google maps link');
  if (lat || lng) {
    const p = { lat: Number(lat), lng: Number(lng) };
    if (!lat || !lng || Number.isNaN(p.lat) || Number.isNaN(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      errors.push('Latitude and Longitude must both be numbers (e.g. 28.6415 and 77.1209)');
    } else location = p;
  } else if (link) {
    try {
      location = await resolveLink(link);
    } catch {
      location = null;
    }
    if (!location) errors.push('The Google Maps link has no map point in it: copy the latitude and longitude instead');
  } else errors.push('Latitude + Longitude, or a Google Maps link, is required');
  // India's bounding box — a swapped latitude and longitude lands in the sea.
  if (location && (location.lat < 6 || location.lat > 37 || location.lng < 68 || location.lng > 98)) {
    errors.push(`The point ${location.lat}, ${location.lng} is outside India (Latitude and Longitude swapped?)`);
  }

  const phone = get('venue phone') || null;
  if (phone && !validPhone(phone)) errors.push(`Venue phone “${phone}” needs 10 to 13 digits`);

  const setting = get('indoor / outdoor').toLowerCase();
  if (setting && !['indoor', 'outdoor', 'both'].includes(setting)) errors.push('Indoor / outdoor is Indoor, Outdoor or Both');

  let amenities: string[] | null = null;
  if (get('amenities')) {
    amenities = [
      ...new Set(
        get('amenities')
          .split(/[,;\n]/)
          .map((a) => a.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .map((a) => STANDARD_AMENITY.get(amenityKey(a)) ?? a),
      ),
    ];
    if (amenities.length > 30) errors.push('Up to 30 amenities');
    if (amenities.some((a) => a.length > 60)) errors.push('Each amenity is under 60 characters (separate them with commas)');
  }
  const description = get('description') || null;
  if (description) max(description, 2000, 'Description');

  // Opening hours: weekdays, the weekend (or the same), less the closing day.
  const time = (h: string, label: string, required: boolean): number | null => {
    const v = get(h);
    if (!v) {
      if (required) errors.push(`${label} is required`);
      return null;
    }
    const m = minutesOf(v);
    if (m === null) errors.push(`${label} “${v}” is not a time (use HH:MM, e.g. 18:30)`);
    return m;
  };
  const opens = time('opens', 'Opens', true);
  const closes = time('closes', 'Closes', true);
  const wkOpens = time('weekend opens', 'Weekend opens', false) ?? opens;
  const wkCloses = time('weekend closes', 'Weekend closes', false) ?? closes;
  const closedRaw = get('closed on').toLowerCase();
  const closedDay = closedRaw && closedRaw !== 'none' ? DAY_NAMES.indexOf(closedRaw) : -1;
  if (closedRaw && closedRaw !== 'none' && closedDay < 0) errors.push(`Closed on “${get('closed on')}” is not a day`);
  if (opens !== null && closes !== null && opens >= closes) errors.push('Opens must be before Closes (for midnight use 23:59)');
  if (wkOpens !== null && wkCloses !== null && wkOpens >= wkCloses) errors.push('Weekend opens must be before Weekend closes');
  const hours: OpeningHours[] = [];
  for (let day = 0; day < 7; day++) {
    const [o, c] = day >= 5 ? [wkOpens, wkCloses] : [opens, closes];
    if (day !== closedDay && o !== null && c !== null && o < c) hours.push({ day, opens: hhmm(o), closes: hhmm(c) });
  }

  const rupees = (h: string, label: string): bigint | null => {
    const v = get(h).replace(/[₹,\s]/g, '');
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_PRICE_RUPEES) {
      errors.push(`${label} “${get(h)}” is not whole rupees between 0 and 1,00,000`);
      return null;
    }
    return BigInt(n) * 100n;
  };

  const groups: Group[] = [];
  for (let n = 1; n <= SPORT_GROUPS; n++) {
    const sportRaw = get(`sport ${n}`);
    const countRaw = get(`tables / courts ${n}`);
    const kindRaw = get(`kind ${n}`).toLowerCase();
    const price = rupees(`price per hour ${n} (₹)`, `Price per hour ${n}`);
    const peak = rupees(`peak price per hour ${n} (₹)`, `Peak price per hour ${n}`);
    if (!sportRaw && !countRaw && !kindRaw && price === null && peak === null) {
      if (n === 1) errors.push('Sport 1 and Tables / courts 1 are required');
      continue;
    }
    const sport = sports.get(sportRaw.toLowerCase());
    if (!sportRaw) errors.push(`Sport ${n} is required when its other columns are filled`);
    else if (!sport) errors.push(`Sport ${n} “${sportRaw}” is not a PL4Y sport (pick one from the list)`);
    const count = Number(countRaw);
    if (!countRaw) errors.push(`Tables / courts ${n} is required`);
    else if (!Number.isInteger(count) || count < 1 || count > MAX_TABLES) errors.push(`Tables / courts ${n} is a whole number from 1 to ${MAX_TABLES}`);
    if (kindRaw && !(COURT_KINDS as readonly string[]).includes(kindRaw)) errors.push(`Kind ${n} is one of ${COURT_KINDS.join(', ')}`);
    if (peak !== null && price === null) errors.push(`Peak price per hour ${n} needs a Price per hour ${n}`);
    if (sport && groups.some((g) => g.sportId === sport.id)) errors.push(`${sport.name} is listed twice: put all its tables in one group`);
    if (sport && Number.isInteger(count)) {
      groups.push({
        sportId: sport.id,
        sportName: sport.name,
        count,
        kind: (kindRaw || (TABLE_SPORTS.has(sport.slug) ? 'table' : 'court')) as CourtKind,
        pricePaise: price,
        peakPaise: peak,
      });
    }
  }
  if (groups.reduce((s, g) => s + g.count, 0) > MAX_TABLES) errors.push(`A venue has up to ${MAX_TABLES} tables and courts in all`);

  const peakFrom = time('peak starts', 'Peak starts', false);
  const peakTo = time('peak ends', 'Peak ends', false);
  let peak: Plan['peak'] = null;
  if ((peakFrom === null) !== (peakTo === null)) errors.push('Give both Peak starts and Peak ends, or neither');
  else if (peakFrom !== null && peakTo !== null) {
    if (peakFrom >= peakTo) errors.push('Peak starts must be before Peak ends');
    else peak = { from: peakFrom, to: peakTo };
  }
  if (groups.some((g) => g.peakPaise !== null) && !peak) errors.push('A peak price needs Peak starts and Peak ends');

  const takeRaw = get('take bookings').toLowerCase();
  const takeBookings = takeRaw === '' ? null : takeRaw === 'yes' ? true : takeRaw === 'no' ? false : undefined;
  if (takeBookings === undefined) errors.push('Take bookings is Yes, No or blank');
  if (takeBookings === true && !groups.some((g) => g.pricePaise !== null)) errors.push('Take bookings = Yes needs a Price per hour');
  const payRaw = get('payment').toLowerCase().replace(/\s+/g, ' ');
  const payment = ({ '': null, online: 'online', 'at venue': 'at_venue', both: 'both' } as Record<string, PaymentOptions | null>)[payRaw];
  if (payment === undefined) errors.push('Payment is Online, At venue or Both');

  if (errors.length > 0) return errors;
  return {
    line: row.line,
    label: `row ${row.line}${get('ref') ? ` [${get('ref')}]` : ''} ${name}`,
    owner: { name: ownerName, email, phone: ownerPhone },
    name,
    address,
    city,
    location: location!,
    phone,
    indoor: setting === 'indoor' ? true : setting === 'outdoor' || setting === 'both' ? false : null,
    amenities,
    description,
    hours,
    groups,
    peak,
    takeBookings: takeBookings ?? null,
    payment: payment ?? null,
  };
}

/** One rule per price band per open window: off-peak, peak, off-peak. */
function rulesFor(hours: OpeningHours[], g: Group, peak: Plan['peak']) {
  const rules: { weekday: number; opensMin: number; closesMin: number; pricePerHourPaise: bigint }[] = [];
  for (const h of hours) {
    const o = minutesOf(h.opens)!;
    const c = minutesOf(h.closes)!;
    const bands =
      peak && g.peakPaise !== null
        ? [
            [o, Math.min(c, peak.from), g.pricePaise!],
            [Math.max(o, peak.from), Math.min(c, peak.to), g.peakPaise],
            [Math.max(o, peak.to), c, g.pricePaise!],
          ]
        : [[o, c, g.pricePaise!]];
    for (const [from, to, price] of bands as [number, number, bigint][]) {
      if (to > from) rules.push({ weekday: h.day, opensMin: from, closesMin: to, pricePerHourPaise: price });
    }
  }
  return rules;
}

// --- the run --------------------------------------------------------------------------

const sportRows = await db.sport.findMany({ select: { id: true, name: true, slug: true } });
const sports = new Map<string, { id: string; name: string; slug: string }>();
for (const s of sportRows) {
  sports.set(s.slug.toLowerCase(), s);
  sports.set(s.name.toLowerCase(), s);
}

const rows = readSheet(file, 'Venues').filter((r) => (r.cells['ref'] ?? '').toUpperCase() !== 'EXAMPLE');
console.log(`${rows.length} venue row(s) in ${file}${apply ? '' : ' — dry run, nothing is written'}\n`);

const invalid: string[] = [];
const plans: Plan[] = [];
for (const row of rows) {
  const p = await planOf(row, sports);
  if (Array.isArray(p)) invalid.push(`row ${row.line} ${row.cells['venue name'] ?? ''}:\n      · ${p.join('\n      · ')}`);
  else plans.push(p);
}
const seen = new Map<string, number>();
for (const p of plans) {
  const key = `${p.owner.email}|${p.name.toLowerCase()}`;
  if (seen.has(key)) invalid.push(`row ${p.line} ${p.name}:\n      · same owner and venue name as row ${seen.get(key)}`);
  else seen.set(key, p.line);
}
const dupLines = new Set(invalid.map((s) => Number(/^row (\d+)/.exec(s)![1])));

const accounts = new Map<string, { id: string; isNew: boolean }>();
const tally = { accountsNew: 0, accountsExisting: 0, listed: 0, updated: 0, conflicts: 0, failed: 0 };
const notes: string[] = [];

/** Live venues with this name within 300 m, and who runs each. */
async function sameVenue(p: Plan) {
  return db.$queryRaw<{ id: string; created_by: string; email: string; is_guest: boolean }[]>(Prisma.sql`
    SELECT v.id, v.created_by, u.email, u.is_guest
      FROM venues v JOIN users u ON u.id = v.created_by
     WHERE v.deleted_at IS NULL
       AND lower(v.name) = lower(${p.name})
       AND ST_DWithin(v.geo, ST_SetSRID(ST_MakePoint(${p.location.lng}, ${p.location.lat}), 4326)::geography, ${SAME_VENUE_M})
  `);
}

async function ownerFor(p: Plan): Promise<{ id: string; isNew: boolean }> {
  const known = accounts.get(p.owner.email);
  if (known) return known;
  const user = await db.user.findUnique({ where: { email: p.owner.email }, select: { id: true, status: true, isGuest: true } });
  if (user && (user.isGuest || user.status !== 'active')) {
    throw new Error(`the account ${p.owner.email} is ${user.isGuest ? 'a walk-in guest' : user.status}; sort it out in the portal first`);
  }
  let found: { id: string; isNew: boolean };
  if (user) found = { id: user.id, isNew: false };
  else if (apply) found = { id: (await identity.createByStaff({ email: p.owner.email, displayName: p.owner.name, phone: p.owner.phone })).id, isNew: true };
  else found = { id: `new:${p.owner.email}`, isNew: true };
  accounts.set(p.owner.email, found);
  if (found.isNew) tally.accountsNew += 1;
  else tally.accountsExisting += 1;
  return found;
}

async function one(p: Plan): Promise<void> {
  const owner = await ownerFor(p);
  const matches = await sameVenue(p);
  const mine = matches.find((m) => m.created_by === owner.id);
  const others = matches.filter((m) => m.created_by !== owner.id && !m.is_guest && !m.email.endsWith(`@${GUEST_EMAIL_DOMAIN}`));
  const imported = matches.filter((m) => m.email.endsWith(`@${GUEST_EMAIL_DOMAIN}`) || m.is_guest);
  if (!mine && others.length > 0) {
    tally.conflicts += 1;
    notes.push(`${p.label}: CONFLICT — ${others.map((o) => o.email).join(', ')} already runs a venue with this name within ${SAME_VENUE_M} m (${others.map((o) => o.id).join(', ')}). Skipped.`);
    return;
  }
  const tables = p.groups.map((g) => `${g.count} ${g.sportName}${g.pricePaise !== null ? ` @ ₹${g.pricePaise / 100n}${g.peakPaise !== null ? `/₹${g.peakPaise / 100n} peak` : ''}` : ''}`).join(', ');
  const walkIn = p.payment === 'at_venue' || p.payment === 'both';
  const what =
    `${mine ? 'update' : 'new venue'}; owner ${p.owner.email} (${owner.isNew ? 'new account' : 'existing account'}); ${tables}` +
    `${p.takeBookings ? '; bookings on (online)' : ''}${walkIn ? '; Pay at venue on' : ''}`;
  for (const m of imported) notes.push(`${p.label}: also listed by the Oct import as ${m.id} — remove that one in the portal if it is the same place.`);

  if (!apply) {
    console.log(`  ${p.label} — would ${what}`);
    if (mine) tally.updated += 1;
    else tally.listed += 1;
    return;
  }

  const actor = { userId: owner.id };
  let venueId: string;
  if (mine) {
    venueId = mine.id;
    await venues.update(actor, venueId, {
      address: p.address,
      city: p.city,
      location: p.location,
      ...(p.amenities ? { amenities: p.amenities } : {}),
    });
  } else {
    venueId = (
      await venues.create(actor, { name: p.name, address: p.address, city: p.city, location: p.location, amenities: p.amenities ?? [] })
    ).id;
  }
  await venues.update(actor, venueId, {
    openingHours: p.hours,
    ...(p.description ? { description: p.description } : {}),
    ...(p.phone ? { contactPhone: p.phone } : {}),
  });

  const existing = await venues.courtsFor(venueId);
  for (const g of p.groups) {
    const courtIds: string[] = [];
    for (let i = 1; i <= g.count; i++) {
      const courtName = `${g.sportName} ${i}`;
      const have = existing.find((c) => c.name.toLowerCase() === courtName.toLowerCase());
      courtIds.push(
        have?.id ??
          (
            await venues.addCourt(actor, venueId, {
              name: courtName,
              kind: g.kind,
              indoor: p.indoor ?? g.kind === 'table',
              sportIds: [g.sportId],
            })
          ).id,
      );
    }
    if (g.pricePaise !== null) {
      const rules = rulesFor(p.hours, g, p.peak);
      for (const courtId of courtIds) await bookings.setRules(actor, courtId, rules);
    }
  }
  if (p.takeBookings !== null || p.payment) {
    await bookings.setPolicy(actor, venueId, {
      ...(p.takeBookings !== null ? { bookable: p.takeBookings } : {}),
      ...(p.payment ? { paymentOptions: p.payment } : {}),
    });
  }
  if (walkIn) await payAtVenue(actor, venueId, p);
  console.log(`  ${p.label} — ${mine ? 'updated' : 'listed'} ${venueId}: ${what}`);
  if (mine) tally.updated += 1;
  else tally.listed += 1;
}

/**
 * Walk-in Pay at venue: one hourly rate per priced sport ("Snooker"), plus a peak one
 * ("Snooker (peak 18:00–22:00)") where the peak price differs. Re-runs update the rate with
 * the same name; rates the owner added in the app are left alone.
 */
async function payAtVenue(actor: { userId: string }, venueId: string, p: Plan): Promise<void> {
  const have = await venuePay.rates(venueId, { includeInactive: true });
  const wanted: { label: string; sportId: string; ratePerHourPaise: bigint }[] = [];
  for (const g of p.groups) {
    if (g.pricePaise === null) continue;
    wanted.push({ label: g.sportName, sportId: g.sportId, ratePerHourPaise: g.pricePaise });
    if (p.peak && g.peakPaise !== null && g.peakPaise !== g.pricePaise) {
      wanted.push({ label: `${g.sportName} (peak ${hhmm(p.peak.from)}–${hhmm(p.peak.to)})`, sportId: g.sportId, ratePerHourPaise: g.peakPaise });
    }
  }
  for (const [position, w] of wanted.entries()) {
    const same = have.find((r) => r.label.toLowerCase() === w.label.toLowerCase());
    await venuePay.saveRate(actor, venueId, { id: same?.id ?? null, label: w.label, sportId: w.sportId, ratePerHourPaise: w.ratePerHourPaise, active: true, position });
  }
  await venuePay.setEnabled(venueId, true);
}

const failed: string[] = [];
// One at a time: rows for the same owner must find the account the row before made.
for (const p of plans) {
  if (dupLines.has(p.line)) continue;
  try {
    await one(p);
  } catch (err) {
    tally.failed += 1;
    failed.push(`${p.label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (invalid.length > 0) {
  console.log(`\n${invalid.length} row(s) to fix in the sheet (not ${apply ? 'written' : 'checked further'}):`);
  for (const s of invalid) console.log(`  ${s}`);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} row(s) failed:`);
  for (const f of failed) console.log(`  ${f}`);
}
if (notes.length > 0) {
  console.log('\nFor PL4Y staff:');
  for (const n of notes) console.log(`  ${n}`);
}
console.log(
  `\n${apply ? '' : 'Would have: '}${tally.listed} venue(s) listed, ${tally.updated} updated, ${tally.conflicts} conflict(s); ` +
    `owner accounts: ${tally.accountsNew} new, ${tally.accountsExisting} existing; ${invalid.length} invalid, ${tally.failed} failed.` +
    (apply ? '' : '\nRe-run with --apply to write.'),
);
if (apply && tally.accountsNew > 0) {
  console.log('New owners sign in to the PL4Y app with their email: a 6-digit code is sent to it. Nobody has been emailed by this import.');
}

await disconnectDb();
process.exit(invalid.length + failed.length > 0 ? 1 : 0);
