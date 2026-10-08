/**
 * events — repository (conventions.md §1). Prisma queries and raw SQL; no
 * business rules.
 *
 * Discovery is ONE raw query that selects ids in order, followed by a typed
 * Prisma read to hydrate them. Two round trips rather than one, deliberately:
 * the id query is the thing that has to ride the partial index
 * `events (sport_id, city, starts_at) WHERE status IN ('published','live')`
 * (events R6), and it is far easier to keep that true when the query it must
 * match is written out rather than assembled by an ORM.
 *
 * `events.geo` is Unsupported in Prisma, so anything touching it is raw.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import type { GeoPoint } from '../../../platform/geo.js';
import { kmToMetres } from '../../../platform/geo.js';
import { cityVariants } from '../../../platform/city.js';

/** The statuses discovery reads. Matches the partial index exactly (R6). */
export const DISCOVERABLE = ['published', 'live'] as const;

export interface EventRow {
  id: string;
  sportId: string;
  organizerId: string;
  venueId: string | null;
  slug: string;
  title: string;
  description: string | null;
  city: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  registrationClosesAt: Date;
  cancellationCutoffAt: Date | null;
  status: string;
  kind: string;
  coverPublicId: string | null;
  contactPhone: string | null;
  locationNote: string | null;
  hostTermsAcceptedAt: Date | null;
  termsChangedAt?: Date | null;
  refundPolicy?: string;
  /** org R3 — the organisation it is hosted as. */
  organizerProfileId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategoryRow {
  id: string;
  eventId: string;
  sportId: string;
  name: string;
  format: string;
  teamSize: number;
  drawType: string;
  skillMin: Prisma.Decimal | null;
  skillMax: Prisma.Decimal | null;
  ageMin: number | null;
  ageMax: number | null;
  capacity: number;
  minEntries: number;
  entryFeePaise: bigint;
  platformFeePaise: bigint;
  taxBps: number;
  commissionBps: number;
  status: string;
  matchMinutes?: number | null;
  thirdPlace?: boolean;
  prizes?: string | null;
  rulesNote?: string | null;
  scoringRule?: Prisma.JsonValue | null;
}

export interface SearchFilter {
  sportId?: string | null;
  city?: string | null;
  near?: GeoPoint | null;
  radiusKm?: number | null;
  from?: Date | null;
  to?: Date | null;
  /** Numeric bounds of a skill band, resolved by the service through `sport`. */
  skill?: { lower: number | null; upper: number | null } | null;
  format?: string | null;
  maxPricePaise?: bigint | null;
  /** discovery R1 — an ILIKE pattern, already escaped (platform/search.ts). */
  textPattern?: string | null;
  /** events R11 */
  kind?: string | null;
}

export function createEventRepo(db: Db) {
  // --- discovery -------------------------------------------------------------

  /**
   * events R6 — returns ids ordered by (starts_at, id), which is also the
   * cursor key. Only published and live events are visible here; draft and
   * cancelled ones are not in the index and are never listed.
   */
  async function searchIds(
    filter: SearchFilter,
    page: { after?: { startsAt: Date; id: string } | null; limit: number },
  ): Promise<{ id: string; startsAt: Date }[]> {
    const where: Prisma.Sql[] = [
      Prisma.sql`e.status IN (${Prisma.join(DISCOVERABLE.map((s) => Prisma.sql`${s}`))})`,
    ];

    if (filter.sportId) where.push(Prisma.sql`e.sport_id = ${filter.sportId}::uuid`);
    // One city under any of its spellings (platform/city.ts).
    if (filter.city) where.push(Prisma.sql`lower(btrim(e.city)) IN (${Prisma.join(cityVariants(filter.city))})`);
    if (filter.from) where.push(Prisma.sql`e.starts_at >= ${filter.from}`);
    // gap #31 — with no date asked for, an event that has already ended is not
    // something to discover; oldest-first ordering would put it at the top.
    else where.push(Prisma.sql`e.ends_at >= now()`);
    if (filter.to) where.push(Prisma.sql`e.starts_at <= ${filter.to}`);
    if (filter.kind) where.push(Prisma.sql`e.kind = ${filter.kind}`);
    if (filter.textPattern) {
      // Title first; the venue name too, because "SG Highway" is how players
      // remember where a tournament was.
      where.push(Prisma.sql`(
        e.title ILIKE ${filter.textPattern}
        OR EXISTS (SELECT 1 FROM venues v WHERE v.id = e.venue_id AND v.name ILIKE ${filter.textPattern})
      )`);
    }

    if (filter.near) {
      // ST_DWithin is the only form that uses the gist index.
      where.push(Prisma.sql`
        e.geo IS NOT NULL
        AND ST_DWithin(
              e.geo,
              ST_SetSRID(ST_MakePoint(${filter.near.lng}::double precision,
                                      ${filter.near.lat}::double precision), 4326)::geography,
              ${kmToMetres(filter.radiusKm ?? 0)}::double precision)
      `);
    }

    // The category filters are ONE existence test rather than three, so that
    // "a Men's Doubles 3.5 draw under ₹500" means one draw meeting all three —
    // not three different draws that each meet one.
    const cat: Prisma.Sql[] = [];
    if (filter.format) cat.push(Prisma.sql`c.format = ${filter.format}`);
    if (filter.maxPricePaise !== null && filter.maxPricePaise !== undefined) {
      cat.push(Prisma.sql`c.entry_fee_paise <= ${filter.maxPricePaise}`);
    }
    if (filter.skill) {
      // An open category (NULL bounds) admits every band; otherwise the two
      // ranges must overlap.
      if (filter.skill.upper !== null) {
        cat.push(Prisma.sql`(c.skill_min IS NULL OR c.skill_min <= ${filter.skill.upper})`);
      }
      if (filter.skill.lower !== null) {
        cat.push(Prisma.sql`(c.skill_max IS NULL OR c.skill_max >= ${filter.skill.lower})`);
      }
    }
    if (cat.length > 0) {
      where.push(Prisma.sql`
        EXISTS (
          SELECT 1 FROM event_categories c
           WHERE c.event_id = e.id
             AND c.status IN ('open', 'full')
             AND ${Prisma.join(cat, ' AND ')}
        )
      `);
    }

    if (page.after) {
      where.push(
        Prisma.sql`(e.starts_at, e.id) > (${page.after.startsAt}, ${page.after.id}::uuid)`,
      );
    }

    return db.$queryRaw<{ id: string; startsAt: Date }[]>`
      SELECT e.id, e.starts_at AS "startsAt"
        FROM events e
       WHERE ${Prisma.join(where, ' AND ')}
       ORDER BY e.starts_at ASC, e.id ASC
       LIMIT ${page.limit}
    `;
  }

  // --- typed reads -----------------------------------------------------------

  async function byIds(ids: string[]): Promise<EventRow[]> {
    if (ids.length === 0) return [];
    return db.event.findMany({ where: { id: { in: ids } } });
  }

  async function byId(eventId: string): Promise<EventRow | null> {
    return db.event.findUnique({ where: { id: eventId } });
  }

  async function bySlug(slug: string): Promise<EventRow | null> {
    return db.event.findUnique({ where: { slug } });
  }

  async function slugExists(slug: string): Promise<boolean> {
    return (await db.event.count({ where: { slug } })) > 0;
  }

  async function categoriesFor(eventIds: string[]): Promise<CategoryRow[]> {
    if (eventIds.length === 0) return [];
    return db.eventCategory.findMany({
      where: { eventId: { in: eventIds } },
      orderBy: [{ eventId: 'asc' }, { name: 'asc' }],
    });
  }

  async function categoryById(categoryId: string): Promise<CategoryRow | null> {
    return db.eventCategory.findUnique({ where: { id: categoryId } });
  }

  async function categoriesByIds(categoryIds: string[]): Promise<CategoryRow[]> {
    if (categoryIds.length === 0) return [];
    return db.eventCategory.findMany({ where: { id: { in: categoryIds } } });
  }

  async function mediaFor(eventId: string): Promise<
    { id: string; publicId: string; kind: string; sortOrder: number }[]
  > {
    return db.eventMedia.findMany({
      where: { eventId },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
      select: { id: true, publicId: true, kind: true, sortOrder: true },
    });
  }

  // --- writes ----------------------------------------------------------------

  async function insert(
    tx: Tx,
    // events R11 — `kind` defaults to tournament; only leagues will set league_season.
    input: Omit<EventRow, 'createdAt' | 'updatedAt' | 'kind'> & {
      kind?: string;
      location?: GeoPoint | null;
    },
  ): Promise<void> {
    const { location, ...row } = input;
    await tx.event.create({ data: row });
    if (location) await setLocation(tx, row.id, location);
  }

  /** F13 — the event's own pin, if it has one. */
  async function locationOf(eventId: string): Promise<GeoPoint | null> {
    const rows = await db.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT ST_Y(geo::geometry) AS lat, ST_X(geo::geometry) AS lng
        FROM events WHERE id = ${eventId}::uuid AND geo IS NOT NULL
    `;
    return rows[0] ?? null;
  }

  /** Speed — `locationOf` for a page of events in one query. Events with no pin are absent. */
  async function locationsOf(eventIds: string[]): Promise<Map<string, GeoPoint>> {
    if (eventIds.length === 0) return new Map();
    const rows = await db.$queryRaw<{ id: string; lat: number; lng: number }[]>`
      SELECT id::text AS id, ST_Y(geo::geometry) AS lat, ST_X(geo::geometry) AS lng
        FROM events WHERE id = ANY(${eventIds}::uuid[]) AND geo IS NOT NULL
    `;
    return new Map(rows.map((r) => [r.id, { lat: r.lat, lng: r.lng }]));
  }

  /** Raw: `geo` is Unsupported. Longitude first — see platform/geo.ts. */
  async function setLocation(
    tx: Tx | Db,
    eventId: string,
    location: GeoPoint | null,
  ): Promise<void> {
    if (location) {
      await tx.$executeRaw`
        UPDATE events
           SET geo = ST_SetSRID(ST_MakePoint(${location.lng}::double precision,
                                             ${location.lat}::double precision), 4326)::geography
         WHERE id = ${eventId}::uuid
      `;
    } else {
      await tx.$executeRaw`UPDATE events SET geo = NULL WHERE id = ${eventId}::uuid`;
    }
  }

  async function update(
    eventId: string,
    patch: Prisma.EventUpdateInput,
  ): Promise<EventRow> {
    return db.event.update({ where: { id: eventId }, data: patch });
  }

  /**
   * Takes plain numbers for the skill bounds; Prisma widens them to Decimal on
   * the way in. The row type reads them back as Decimal, which is why this is
   * its own input shape rather than CategoryRow.
   */
  async function insertCategory(
    data: Omit<CategoryRow, "skillMin" | "skillMax" | "scoringRule"> & {
      skillMin: number | null;
      skillMax: number | null;
      scoringRule?: Prisma.InputJsonValue;
    },
  ): Promise<CategoryRow> {
    return db.eventCategory.create({ data });
  }

  async function updateCategory(
    categoryId: string,
    patch: Prisma.EventCategoryUpdateInput,
  ): Promise<CategoryRow> {
    return db.eventCategory.update({ where: { id: categoryId }, data: patch });
  }

  async function setCategoryStatuses(
    tx: Tx,
    eventId: string,
    status: string,
  ): Promise<void> {
    await tx.eventCategory.updateMany({ where: { eventId }, data: { status } });
  }

  return {
    searchIds,
    byId,
    byIds,
    bySlug,
    slugExists,
    categoriesFor,
    categoryById,
    categoriesByIds,
    mediaFor,
    insert,
    setLocation,
    locationOf,
    locationsOf,
    update,
    insertCategory,
    updateCategory,
    setCategoryStatuses,
  };
}

export type EventRepo = ReturnType<typeof createEventRepo>;
