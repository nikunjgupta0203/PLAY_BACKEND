/**
 * `pnpm import:screenings <file.json> [--org <slug> | --owner <email>] [--phone +91…] [--capacity 50] [--apply]`
 * `pnpm import:screenings rollback [--apply]`
 *
 * Lists PL4Y screenings (match watch-alongs) in PL4Y Experiences from a
 * prepared data file (scripts/data/screenings-*.json, picked from the
 * founder's sheet). Each one is a published event with experience kind
 * `screening`, BY PL4Y, location TBD (no venue, city "Location TBD"), and one
 * free ticket category for one person.
 *
 * Hosted by the organisation `--org` (default: the one named "PL4Y"), or by
 * the user `--owner` when PL4Y has no organisation. The contact phone is
 * `--phone`, else the organisation's, else the owner's.
 *
 * Silent by construction: rows are written directly, not through publish, so
 * no "new event near you" notice goes out for each one, and the short-draw
 * warning is marked as sent. The registration-close sweep still closes the
 * tickets at kick-off.
 *
 * The seed tag is the id: every event and category starts SEED_PREFIX, made
 * from the sheet's ref. A ref already imported is skipped, so a re-run only
 * adds new rows. `rollback` removes every imported screening nobody has a
 * ticket for.
 *
 * Without --apply it only reports what it would do.
 */
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { db, disconnectDb } from '../src/platform/db.js';
import { slugify } from '../src/modules/events/index.js';
import { sport } from '../src/modules/sport/index.js';
import { organisations } from '../src/modules/organizers/index.js';

export const SEED_PREFIX = '5c4ee41d-2026-4000-8000-';
const LOCATION_TBD = 'Location TBD';
const LIKE_SEED = `${SEED_PREFIX}%`;

/** A uuid column has no startsWith filter: the seed tag is matched as text. */
async function seededEventIds(): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text AS id FROM events WHERE id::text LIKE ${LIKE_SEED}`);
  return rows.map((r) => r.id);
}

interface Row {
  ref: string;
  sport: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timeKnown: boolean;
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const target = args[0];
if (!target || target.startsWith('--')) {
  throw new Error('usage: pnpm import:screenings <file.json|rollback> [--org <slug> | --owner <email>] [--phone +91…] [--capacity 50] [--apply]');
}

/** SCR-058-2 → event 5c4ee41d-…-100000058002, its ticket …-200000058002. */
function seedId(ref: string, what: 'event' | 'category'): string {
  const m = /^SCR-(\d{3})(?:-(\d))?$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  return `${SEED_PREFIX}${what === 'event' ? '1' : '2'}00000${m[1]}${(m[2] ?? '0').padStart(3, '0')}`;
}

async function rollback(): Promise<void> {
  const seeded = await db.event.findMany({
    where: { id: { in: await seededEventIds() } },
    select: { id: true, title: true, _count: { select: { registrations: true } } },
  });
  const sold = seeded.filter((e) => e._count.registrations > 0);
  const free = seeded.filter((e) => e._count.registrations === 0);
  for (const e of sold) console.log(`  keep  ${e.title} — ${e._count.registrations} ticket(s); cancel it in the portal instead`);
  console.log(`${free.length} screening(s) ${apply ? 'removed' : 'would be removed'}, ${sold.length} kept.`);
  if (!apply || free.length === 0) return;
  const ids = free.map((e) => e.id);
  await db.$transaction(async (tx) => {
    await tx.eventStaff.deleteMany({ where: { eventId: { in: ids } } });
    await tx.eventCategory.deleteMany({ where: { eventId: { in: ids } } });
    await tx.event.deleteMany({ where: { id: { in: ids } } });
  });
}

async function host(): Promise<{ ownerId: string; organisationId: string | null; phone: string }> {
  const ownerEmail = flag('owner');
  if (ownerEmail) {
    const user = await db.user.findFirst({ where: { email: ownerEmail }, select: { id: true, phoneE164: true } });
    if (!user) throw new Error(`No user with the email ${ownerEmail}.`);
    const phone = flag('phone') ?? user.phoneE164;
    if (!phone) throw new Error(`${ownerEmail} has no phone number; events need a contact phone (pass --phone).`);
    console.log(`Host: ${ownerEmail}, contact ${phone}.`);
    return { ownerId: user.id, organisationId: null, phone };
  }
  const slug = flag('org');
  const orgs = await db.organizerProfile.findMany({
    where: slug ? { slug } : { name: { equals: 'PL4Y', mode: 'insensitive' } },
  });
  if (orgs.length !== 1) {
    const like = await db.organizerProfile.findMany({
      where: { name: { contains: 'pl4y', mode: 'insensitive' } },
      select: { slug: true, name: true },
    });
    throw new Error(
      `${orgs.length === 0 ? 'No' : 'More than one'} organisation ${slug ? `with slug ${slug}` : 'named PL4Y'}. ` +
        `Pass --org <slug> or --owner <email>. Organisations with PL4Y in the name: ${like.map((o) => `${o.slug} (${o.name})`).join(', ') || 'none'}.`,
    );
  }
  const org = orgs[0]!;
  const member = await db.organizerMember.findFirst({ where: { organizerProfileId: org.id, role: 'owner' } });
  const owner = member && (await db.user.findUnique({ where: { id: member.userId }, select: { id: true, email: true, phoneE164: true } }));
  if (!owner) throw new Error(`Organisation ${org.slug} has no owner.`);
  const phone = flag('phone') ?? org.contactPhone ?? owner.phoneE164;
  if (!phone) throw new Error(`Neither ${org.slug} nor its owner ${owner.email} has a phone; events need a contact phone (pass --phone).`);
  console.log(`Host: organisation ${org.name} (${org.slug}), owner ${owner.email}, contact ${phone}.`);
  return { ownerId: owner.id, organisationId: org.id, phone };
}

async function importFile(file: string): Promise<void> {
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Row[];
  const capacity = Number(flag('capacity') ?? 50);
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('--capacity is a whole number of at least 1.');

  const sports = new Map((await db.sport.findMany({ select: { id: true, slug: true } })).map((s) => [s.slug, s.id]));
  const missing = [...new Set(rows.map((r) => r.sport))].filter((s) => !sports.has(s));
  if (missing.length) throw new Error(`Sports not in this database: ${missing.join(', ')}.`);
  const formatOf = new Map<string, string>();
  for (const slug of new Set(rows.map((r) => r.sport))) {
    const formats = await sport.formatsFor(sports.get(slug)!);
    if (!formats[0]) throw new Error(`${slug} has no formats.`);
    // A ticket is for one person whatever the sport's own formats are (teamSize 1 below).
    formatOf.set(slug, formats[0].key);
  }

  const who = await host();
  const now = new Date();
  const taken = new Set(await seededEventIds());
  let added = 0;
  let skipped = 0;

  for (const r of rows) {
    const id = seedId(r.ref, 'event');
    const startsAt = new Date(r.startsAt);
    const endsAt = new Date(r.endsAt);
    if (taken.has(id)) {
      skipped += 1;
      continue;
    }
    if (!(startsAt > now)) {
      console.log(`  past  ${r.ref} ${r.title}`);
      skipped += 1;
      continue;
    }
    if (!(endsAt > startsAt)) throw new Error(`${r.ref} ends before it starts.`);
    const base = slugify(r.title);
    const slug = (await db.event.findUnique({ where: { slug: base }, select: { id: true } }))
      ? `${base}-${r.ref.toLowerCase().replace(/[^a-z0-9]+/g, '')}`
      : base;
    console.log(`  ${apply ? 'add ' : 'new '}  ${r.ref} ${startsAt.toISOString().slice(0, 16)}Z ${r.sport.padEnd(9)} ${r.title}${r.timeKnown ? '' : ' (time TBC)'}`);
    added += 1;
    if (!apply) continue;

    await db.$transaction(async (tx) => {
      await tx.event.create({
        data: {
          id,
          sportId: sports.get(r.sport)!,
          organizerId: who.ownerId,
          organizerProfileId: who.organisationId,
          venueId: null,
          slug,
          title: r.title,
          description: r.description,
          city: LOCATION_TBD,
          timezone: 'Asia/Kolkata',
          startsAt,
          endsAt,
          // Tickets stay on sale until kick-off.
          registrationClosesAt: startsAt,
          cancellationCutoffAt: null,
          status: 'published',
          kind: 'tournament',
          experienceKind: 'screening',
          byPl4y: true,
          contactPhone: who.phone,
          locationNote: 'Screening location to be announced.',
          hostTermsAcceptedAt: now,
          refundPolicy: 'standard',
        },
      });
      await tx.eventCategory.create({
        data: {
          id: seedId(r.ref, 'category'),
          eventId: id,
          sportId: sports.get(r.sport)!,
          name: 'Screening ticket',
          format: formatOf.get(r.sport)!,
          teamSize: 1,
          drawType: 'single_elim',
          capacity,
          minEntries: 1,
          entryFeePaise: 0n,
          platformFeePaise: 0n,
          taxBps: 0,
          commissionBps: 0,
          status: 'open',
          // Silent: no "your draw is short" notice to the host a day out.
          shortWarnedAt: now,
        },
      });
      if (who.organisationId) await organisations.syncEventGrants(tx, who.organisationId, id);
      else await tx.eventStaff.create({ data: { eventId: id, userId: who.ownerId, role: 'owner' } });
    });
  }
  console.log(`${added} screening(s) ${apply ? 'added' : 'to add'}, ${skipped} already there or past.${apply ? '' : ' Run again with --apply to write them.'}`);
}

(target === 'rollback' ? rollback() : importFile(target))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
