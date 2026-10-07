/**
 * venues — repository (conventions.md §1). Prisma queries and raw SQL; no
 * business rules.
 *
 * `venues.geo` is `geography(Point,4326) NOT NULL`, which Prisma models as
 * Unsupported and omits from the typed client. Both the write and the read of
 * that column therefore have to be raw — there is no Prisma path to a required
 * geography column, and pretending otherwise produces a create that compiles
 * and then fails at the constraint.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import type { GeoPoint } from '../../../platform/geo.js';
import { kmToMetres } from '../../../platform/geo.js';
import { cityVariants } from '../../../platform/city.js';

export interface VenueRow {
  id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  amenities: string[];
  photoPublicIds: string[];
  description: string | null;
  openingHours: unknown;
  contactPhone: string | null;
  /** venues R7 — over visible reviews; the service withholds it below three. */
  ratingAvg: number | null;
  ratingCount: number;
  createdBy: string;
  createdAt: Date;
  /** Metres from the search centre. Null when the search had no centre. */
  distanceM: number | null;
}

export interface CourtRow {
  id: string;
  /** Null for a court a host declared for one event (F14). */
  venueId: string | null;
  eventId: string | null;
  name: string;
  surface: string | null;
  indoor: boolean;
  kind: string;
  sportIds: string[];
  active: boolean;
}

export interface ReviewRow {
  id: string;
  venueId: string;
  userId: string;
  stars: number;
  body: string | null;
  replyBody: string | null;
  repliedBy: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** ST_MakePoint is (x, y) — longitude first. See platform/geo.ts. */
const point = (p: GeoPoint) =>
  Prisma.sql`ST_SetSRID(ST_MakePoint(${p.lng}::double precision, ${p.lat}::double precision), 4326)::geography`;

/**
 * ST_Y/ST_X read the geometry cast, not the geography: geography has no direct
 * accessor, and for a point the cast is free.
 */
const COLUMNS = Prisma.sql`
  v.id,
  v.name,
  v.address,
  v.city,
  ST_Y(v.geo::geometry) AS lat,
  ST_X(v.geo::geometry) AS lng,
  v.amenities,
  v.photo_public_ids AS "photoPublicIds",
  v.description,
  v.opening_hours AS "openingHours",
  v.contact_phone AS "contactPhone",
  v.rating_avg::double precision AS "ratingAvg",
  v.rating_count AS "ratingCount",
  v.created_by AS "createdBy",
  v.created_at AS "createdAt"
`;

export function createVenueRepo(db: Db) {
  /** Raw because `geo` is required and Unsupported. */
  async function insert(input: {
    id: string;
    name: string;
    address: string;
    city: string;
    location: GeoPoint;
    amenities: string[];
    photoPublicIds: string[];
    createdBy: string;
  }): Promise<void> {
    await db.$executeRaw`
      INSERT INTO venues (id, name, address, city, geo, amenities, photo_public_ids, created_by)
      VALUES (
        ${input.id}::uuid,
        ${input.name},
        ${input.address},
        ${input.city},
        ${point(input.location)},
        ${input.amenities},
        ${input.photoPublicIds},
        ${input.createdBy}::uuid
      )
    `;
  }

  /** Only the columns actually present in the patch are written. */
  async function update(
    venueId: string,
    patch: {
      name?: string;
      address?: string;
      city?: string;
      location?: GeoPoint;
      amenities?: string[];
      photoPublicIds?: string[];
      description?: string | null;
      openingHours?: unknown;
      contactPhone?: string | null;
    },
  ): Promise<void> {
    const sets: Prisma.Sql[] = [];
    if (patch.description !== undefined) sets.push(Prisma.sql`description = ${patch.description}`);
    if (patch.openingHours !== undefined) {
      sets.push(Prisma.sql`opening_hours = ${JSON.stringify(patch.openingHours)}::jsonb`);
    }
    if (patch.contactPhone !== undefined) sets.push(Prisma.sql`contact_phone = ${patch.contactPhone}`);
    if (patch.name !== undefined) sets.push(Prisma.sql`name = ${patch.name}`);
    if (patch.address !== undefined) sets.push(Prisma.sql`address = ${patch.address}`);
    if (patch.city !== undefined) sets.push(Prisma.sql`city = ${patch.city}`);
    if (patch.location !== undefined) sets.push(Prisma.sql`geo = ${point(patch.location)}`);
    if (patch.amenities !== undefined) sets.push(Prisma.sql`amenities = ${patch.amenities}`);
    if (patch.photoPublicIds !== undefined) {
      sets.push(Prisma.sql`photo_public_ids = ${patch.photoPublicIds}`);
    }
    if (sets.length === 0) return;

    await db.$executeRaw`
      UPDATE venues SET ${Prisma.join(sets, ', ')} WHERE id = ${venueId}::uuid
    `;
  }

  /** venues R5 — soft delete, honoured by every read path below. */
  async function softDelete(venueId: string): Promise<void> {
    await db.$executeRaw`
      UPDATE venues SET deleted_at = now() WHERE id = ${venueId}::uuid AND deleted_at IS NULL
    `;
  }

  async function byId(venueId: string): Promise<VenueRow | null> {
    const rows = await db.$queryRaw<VenueRow[]>`
      SELECT ${COLUMNS}, NULL::double precision AS "distanceM"
        FROM venues v
       WHERE v.id = ${venueId}::uuid AND v.deleted_at IS NULL
    `;
    return rows[0] ?? null;
  }

  async function byIds(venueIds: string[]): Promise<VenueRow[]> {
    if (venueIds.length === 0) return [];
    return db.$queryRaw<VenueRow[]>`
      SELECT ${COLUMNS}, NULL::double precision AS "distanceM"
        FROM venues v
       WHERE v.id = ANY(${venueIds}::uuid[]) AND v.deleted_at IS NULL
    `;
  }

  /**
   * venues R1 — the radius search. Ordered by distance when a centre is given
   * and by name otherwise, paged on (sort key, id) so the cursor stays stable
   * when two venues tie (conventions.md §4).
   *
   * The 50 km cap is the service's job; by the time we are here the radius has
   * already been checked.
   */
  async function search(opts: {
    near?: GeoPoint | null;
    radiusKm?: number | null;
    city?: string | null;
    sportId?: string | null;
    /** discovery R1 — an ILIKE pattern, already escaped (platform/search.ts). */
    textPattern?: string | null;
    /** Distance in metres, or the name, plus the id that broke the tie. */
    after?: { sortKey: string; id: string } | null;
    limit: number;
  }): Promise<VenueRow[]> {
    const where: Prisma.Sql[] = [Prisma.sql`v.deleted_at IS NULL`];

    if (opts.near) {
      // ST_DWithin is the only form that uses the gist index. A ST_Distance
      // predicate computes every row's distance and then filters.
      where.push(
        Prisma.sql`ST_DWithin(v.geo, ${point(opts.near)}, ${kmToMetres(
          opts.radiusKm ?? 0,
        )}::double precision)`,
      );
    }
    if (opts.city) where.push(Prisma.sql`lower(btrim(v.city)) IN (${Prisma.join(cityVariants(opts.city))})`);
    if (opts.textPattern) {
      where.push(Prisma.sql`(v.name ILIKE ${opts.textPattern} OR v.address ILIKE ${opts.textPattern})`);
    }
    if (opts.sportId) {
      where.push(Prisma.sql`
        EXISTS (
          SELECT 1 FROM venue_courts c
           WHERE c.venue_id = v.id AND c.active
             AND ${opts.sportId}::uuid = ANY(c.sport_ids)
        )
      `);
    }

    const distance = opts.near
      ? Prisma.sql`ST_Distance(v.geo, ${point(opts.near)})`
      : Prisma.sql`NULL::double precision`;

    if (opts.after) {
      const { sortKey, id } = opts.after;
      where.push(
        opts.near
          ? Prisma.sql`(${distance}, v.id) > (${Number(sortKey)}::double precision, ${id}::uuid)`
          : Prisma.sql`(v.name, v.id) > (${sortKey}, ${id}::uuid)`,
      );
    }

    const order = opts.near
      ? Prisma.sql`ORDER BY ${distance} ASC, v.id ASC`
      : Prisma.sql`ORDER BY v.name ASC, v.id ASC`;

    return db.$queryRaw<VenueRow[]>`
      SELECT ${COLUMNS}, ${distance} AS "distanceM"
        FROM venues v
       WHERE ${Prisma.join(where, ' AND ')}
       ${order}
       LIMIT ${opts.limit}
    `;
  }

  const toCourt = (r: {
    id: string;
    venueId: string | null;
    eventId: string | null;
    name: string;
    surface: string | null;
    indoor: boolean;
    kind: string;
    sportIds: string[];
    active: boolean;
  }): CourtRow => ({
    id: r.id,
    venueId: r.venueId,
    eventId: r.eventId,
    name: r.name,
    surface: r.surface,
    indoor: r.indoor,
    kind: r.kind,
    sportIds: r.sportIds,
    active: r.active,
  });

  async function courtsFor(venueIds: string[]): Promise<CourtRow[]> {
    if (venueIds.length === 0) return [];
    const rows = await db.venueCourt.findMany({
      where: { venueId: { in: venueIds } },
      orderBy: [{ venueId: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toCourt);
  }

  /** F14 — the courts a host declared for one event, oldest first. */
  async function courtsForEvent(eventId: string): Promise<CourtRow[]> {
    const rows = await db.venueCourt.findMany({ where: { eventId }, orderBy: [{ name: 'asc' }] });
    return rows.map(toCourt);
  }

  async function insertEventCourt(input: { id: string; eventId: string; name: string; sportIds: string[] }): Promise<CourtRow> {
    const row = await db.venueCourt.create({
      data: { id: input.id, eventId: input.eventId, name: input.name, sportIds: input.sportIds },
    });
    return toCourt(row);
  }

  async function courtById(courtId: string): Promise<CourtRow | null> {
    const row = await db.venueCourt.findUnique({ where: { id: courtId } });
    return row ? toCourt(row) : null;
  }

  async function insertCourt(input: {
    id: string;
    venueId: string;
    name: string;
    surface: string | null;
    indoor: boolean;
    kind: string;
    sportIds: string[];
  }): Promise<CourtRow> {
    const row = await db.venueCourt.create({ data: input });
    return toCourt(row);
  }

  async function updateCourt(
    courtId: string,
    patch: {
      name?: string;
      surface?: string | null;
      indoor?: boolean;
      kind?: string;
      sportIds?: string[];
      active?: boolean;
    },
  ): Promise<CourtRow> {
    const row = await db.venueCourt.update({ where: { id: courtId }, data: patch });
    return toCourt(row);
  }

  // --- visits and reviews (R6–R8) --------------------------------------------

  /** Idempotent: the key is (source, source_id, user_id), so a retried job writes nothing. */
  async function recordVisits(
    rows: { venueId: string; userId: string; source: string; sourceId: string; visitedAt: Date }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await db.venueVisit.createMany({ data: rows, skipDuplicates: true });
  }

  async function visitedSince(venueId: string, userId: string, since: Date): Promise<boolean> {
    const found = await db.venueVisit.findFirst({
      where: { venueId, userId, visitedAt: { gte: since } },
      select: { venueId: true },
    });
    return found !== null;
  }

  const REVIEW_COLUMNS = {
    id: true,
    venueId: true,
    userId: true,
    stars: true,
    body: true,
    replyBody: true,
    repliedBy: true,
    repliedAt: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  async function reviewById(reviewId: string): Promise<ReviewRow | null> {
    return db.venueReview.findFirst({
      where: { id: reviewId, hiddenAt: null },
      select: REVIEW_COLUMNS,
    });
  }

  async function reviewByUser(venueId: string, userId: string): Promise<ReviewRow | null> {
    return db.venueReview.findFirst({
      where: { venueId, userId, hiddenAt: null },
      select: REVIEW_COLUMNS,
    });
  }

  /**
   * venues R7 — the review and the venue's rating move in ONE transaction, and
   * the rating is recomputed over visible reviews rather than nudged, so it can
   * never drift from the rows it summarises.
   */
  async function upsertReview(input: {
    id: string;
    venueId: string;
    userId: string;
    stars: number;
    body: string | null;
  }): Promise<ReviewRow> {
    return db.$transaction(async (tx) => {
      const row = await tx.venueReview.upsert({
        where: { venueId_userId: { venueId: input.venueId, userId: input.userId } },
        create: input,
        update: { stars: input.stars, body: input.body },
        select: REVIEW_COLUMNS,
      });
      await tx.$executeRaw`
        UPDATE venues v
           SET rating_avg = s.avg, rating_count = s.n
          FROM (SELECT avg(stars)::numeric(3,2) AS avg, count(*)::int AS n
                  FROM venue_reviews
                 WHERE venue_id = ${input.venueId}::uuid AND hidden_at IS NULL) s
         WHERE v.id = ${input.venueId}::uuid
      `;
      return row;
    });
  }

  /**
   * admin R6 — hide or show a review. The venue's rating is recomputed in the
   * same transaction (venues R7). Returns the venue, or null for no such review.
   */
  async function setReviewHidden(reviewId: string, hidden: boolean): Promise<{ venueId: string } | null> {
    return db.$transaction(async (tx) => {
      const row = await tx.venueReview.findUnique({ where: { id: reviewId }, select: { venueId: true } });
      if (!row) return null;
      await tx.venueReview.update({ where: { id: reviewId }, data: { hiddenAt: hidden ? new Date() : null } });
      await tx.$executeRaw`
        UPDATE venues v
           SET rating_avg = s.avg, rating_count = s.n
          FROM (SELECT avg(stars)::numeric(3,2) AS avg, count(*)::int AS n
                  FROM venue_reviews
                 WHERE venue_id = ${row.venueId}::uuid AND hidden_at IS NULL) s
         WHERE v.id = ${row.venueId}::uuid
      `;
      return { venueId: row.venueId };
    });
  }

  async function setReply(reviewId: string, body: string, repliedBy: string): Promise<ReviewRow> {
    return db.venueReview.update({
      where: { id: reviewId },
      data: { replyBody: body, repliedBy, repliedAt: new Date() },
      select: REVIEW_COLUMNS,
    });
  }

  /** Newest first, keyset on (created_at, id). Hidden reviews never appear. */
  async function reviewsFor(
    venueId: string,
    after: { at: Date; id: string } | null,
    limit: number,
  ): Promise<ReviewRow[]> {
    return db.venueReview.findMany({
      where: {
        venueId,
        hiddenAt: null,
        ...(after
          ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { gt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      select: REVIEW_COLUMNS,
    });
  }

  return {
    setReviewHidden,
    recordVisits,
    visitedSince,
    reviewById,
    reviewByUser,
    upsertReview,
    setReply,
    reviewsFor,
    insert,
    update,
    softDelete,
    byId,
    byIds,
    search,
    courtsFor,
    courtsForEvent,
    insertEventCourt,
    courtById,
    insertCourt,
    updateCourt,
  };
}

export type VenueRepo = ReturnType<typeof createVenueRepo>;
