/**
 * venues — service layer (docs/modules/04-venues.md).
 *
 * Where play happens. Deliberately thin: courts exist so a tournament can be
 * scheduled onto them, and so a player can find a place to play.
 *
 * NO BOOKING, NO INVENTORY, NO AVAILABILITY CALENDAR. `freeCourts` takes a
 * `tournamentId` precisely so nobody mistakes it for a booking API (R4).
 */
import { forbidden, UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import {
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
  isValidPoint,
  radiusTooLarge,
  type GeoPoint,
} from '../../../platform/geo.js';
import type { UploadSignature } from '../../../platform/cloudinary.js';
import { containsPattern } from '../../../platform/search.js';
import { createVenueRepo, type VenueRepo } from '../repo/index.js';

export const VenueCode = {
  /** Includes soft-deleted: a removed venue is not distinguishable from a typo. */
  VENUE_NOT_FOUND: 'VENUE_NOT_FOUND',
  /** Over 50 km — R1. */
  RADIUS_TOO_LARGE: 'RADIUS_TOO_LARGE',
  /** Cannot deactivate a court with scheduled matches. */
  COURT_IN_USE: 'COURT_IN_USE',
  INVALID_LOCATION: 'INVALID_LOCATION',
  DUPLICATE_COURT_NAME: 'DUPLICATE_COURT_NAME',
  /** R6 — no match, game or booking here in the last 12 months. */
  REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  INVALID_REVIEW: 'INVALID_REVIEW',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  /** R8 — one public reply per review. */
  ALREADY_REPLIED: 'ALREADY_REPLIED',
  INVALID_OPENING_HOURS: 'INVALID_OPENING_HOURS',
  /** R11 — over 2,000 characters. */
  INVALID_DESCRIPTION: 'INVALID_DESCRIPTION',
} as const;

/** R10 — what a playing area is called depends on the sport. */
export const COURT_KINDS = ['court', 'turf', 'ground', 'pitch', 'table'] as const;
export type CourtKind = (typeof COURT_KINDS)[number];

/** R6 — how recently a player must have played here to review it. */
export const REVIEW_WINDOW_MS = 365 * 86_400_000;
/** R7 — one furious review is not a rating. */
export const MIN_REVIEWS_FOR_RATING = 3;
export const REVIEW_MAX_CHARS = 1_000;
export const DESCRIPTION_MAX_CHARS = 2_000;

/** R12 — one window per row; a day with two sessions has two rows. `day` 0 is Monday. */
export interface OpeningHours {
  day: number;
  opens: string;
  closes: string;
}

export interface VenueReview {
  id: string;
  venueId: string;
  userId: string;
  stars: number;
  body: string | null;
  replyBody: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Actor {
  userId: string;
  /** PL4Y staff in the portal manage any venue as its owner would — set by the schema, never by a client. */
  platformStaff?: boolean;
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  city: string;
  location: GeoPoint;
  amenities: string[];
  /** Cloudinary public_ids. URLs are built at render (ADR 0003 §C3). */
  photoPublicIds: string[];
  description: string | null;
  openingHours: OpeningHours[];
  contactPhone: string | null;
  /** R7 — null until the venue has MIN_REVIEWS_FOR_RATING visible reviews. */
  rating: number | null;
  reviewCount: number;
  createdBy: string;
  createdAt: Date;
  /** Metres from the search centre, when the search had one. */
  distanceM: number | null;
}

export interface Court {
  id: string;
  /** Null for a court a host declared for one event (F14). */
  venueId: string | null;
  eventId: string | null;
  name: string;
  surface: string | null;
  indoor: boolean;
  kind: CourtKind;
  /** R2 — one physical court often serves several sports. */
  sportIds: string[];
  active: boolean;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * Court assignments live in `court_assignments`, which `tournament` owns
 * exclusively (conventions.md §1 — table ownership is exclusive). venues asks
 * rather than reads.
 *
 * Until Sprint 8 the wired implementation answers "nothing is assigned", which
 * is the truth: there are no matches yet.
 */
export interface SchedulePort {
  /** Court ids already taken inside THIS tournament during this window (R4). */
  assignedCourtIds(input: {
    venueId: string;
    tournamentId: string;
    window: TimeWindow;
  }): Promise<string[]>;
  /** True when any match anywhere is scheduled onto this court. */
  courtHasScheduledMatches(courtId: string): Promise<boolean>;
}

/**
 * ADR 0003 §C2 — the client uploads DIRECTLY to Cloudinary under a signature we
 * issue, and we only ever store the public_id.
 */
export interface MediaPort {
  signUpload(opts: { publicId: string; folder: string }): UploadSignature;
  /** The prefix every asset for this venue shares, used to validate the reply. */
  venueRoot(venueId: string): string;
  photoFolder(venueId: string, n: number): string;
}

/**
 * R6 — where a finished match was played and by whom. `matches` belong to
 * tournament and entries to registration, so this arrives as a port.
 */
export interface VisitsPort {
  forMatch(matchId: string): Promise<{ venueId: string; userIds: string[]; at: Date } | null>;
}

export interface VenueDeps {
  repo: VenueRepo;
  schedule: SchedulePort;
  media: MediaPort;
  visits?: VisitsPort;
  now?: () => Date;
}

export interface CreateVenueInput {
  name: string;
  address: string;
  city: string;
  location: GeoPoint;
  amenities?: string[];
  photoPublicIds?: string[];
  courts?: CourtInput[];
}

export interface CourtInput {
  name: string;
  surface?: string | null;
  indoor?: boolean;
  kind?: CourtKind;
  sportIds?: string[];
}

export interface UpdateVenueInput {
  name?: string;
  address?: string;
  city?: string;
  location?: GeoPoint;
  amenities?: string[];
  photoPublicIds?: string[];
  description?: string | null;
  openingHours?: OpeningHours[];
  contactPhone?: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** R12 — a window is a day 0-6 and an opening before its closing, both HH:MM. */
function validOpeningHours(rows: OpeningHours[]): boolean {
  return rows.every(
    (r) =>
      Number.isInteger(r.day) &&
      r.day >= 0 &&
      r.day <= 6 &&
      HHMM.test(r.opens) &&
      HHMM.test(r.closes) &&
      r.opens < r.closes,
  );
}

const toOpeningHours = (raw: unknown): OpeningHours[] =>
  Array.isArray(raw) ? (raw as OpeningHours[]).filter((r) => r && typeof r === 'object') : [];

const reviewNotFound = () =>
  new UserError(VenueCode.REVIEW_NOT_FOUND, 'That review could not be found.');

const notFound = () =>
  new UserError(VenueCode.VENUE_NOT_FOUND, 'That venue could not be found.');

/** Cursor on (sort key, id) — conventions.md §4. Opaque to the client. */
const encodeCursor = (sortKey: string, id: string): string =>
  Buffer.from(`${sortKey}|${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // The id is a UUID and carries no '|', so split from the right: a venue
    // name containing the separator must not corrupt the cursor.
    const at = raw.lastIndexOf('|');
    if (at < 0) return null;
    return { sortKey: raw.slice(0, at), id: raw.slice(at + 1) };
  } catch {
    return null;
  }
}

export function createVenueService(deps: VenueDeps) {
  const { repo, schedule, media } = deps;
  const now = deps.now ?? (() => new Date());

  const toVenue = (r: Awaited<ReturnType<VenueRepo['byId']>> & object): Venue => ({
    id: r.id,
    name: r.name,
    address: r.address,
    city: r.city,
    location: { lat: r.lat, lng: r.lng },
    amenities: r.amenities,
    photoPublicIds: r.photoPublicIds,
    description: r.description,
    openingHours: toOpeningHours(r.openingHours),
    contactPhone: r.contactPhone,
    rating:
      r.ratingCount >= MIN_REVIEWS_FOR_RATING && r.ratingAvg !== null ? Number(r.ratingAvg) : null,
    reviewCount: r.ratingCount,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    distanceM: r.distanceM === null ? null : Number(r.distanceM),
  });

  const toCourt = (c: Awaited<ReturnType<VenueRepo['courtsFor']>>[number]): Court => ({
    ...c,
    kind: (COURT_KINDS as readonly string[]).includes(c.kind) ? (c.kind as CourtKind) : 'court',
  });

  // --- reads -----------------------------------------------------------------

  async function findById(venueId: string): Promise<Venue | null> {
    const row = await repo.byId(venueId);
    return row ? toVenue(row) : null;
  }

  /** R5 — a soft-deleted venue reads as missing, not as an error of its own. */
  async function byId(venueId: string): Promise<Venue> {
    const found = await findById(venueId);
    if (!found) throw notFound();
    return found;
  }

  async function byIds(venueIds: string[]): Promise<Venue[]> {
    const rows = await repo.byIds([...new Set(venueIds)]);
    return rows.map(toVenue);
  }

  async function courtsFor(venueId: string): Promise<Court[]> {
    return (await repo.courtsFor([venueId])).map(toCourt);
  }

  /** The sports a venue can host: the union over its active courts (R2). */
  async function sportsAt(venueId: string): Promise<string[]> {
    const courts = await repo.courtsFor([venueId]);
    const ids = new Set<string>();
    for (const c of courts) {
      if (!c.active) continue;
      for (const s of c.sportIds) ids.add(s);
    }
    return [...ids];
  }

  /**
   * R1 — radius search rides the gist index and is capped at 50 km. An uncapped
   * radius query is a table scan wearing a filter.
   */
  async function search(
    filter: {
      near?: GeoPoint | null;
      radiusKm?: number | null;
      city?: string | null;
      sportId?: string | null;
      /** discovery R1 — free text over name and address. */
      query?: string | null;
    },
    page: { first: number; after?: string | null },
  ): Promise<Page<Venue>> {
    const first = Math.min(Math.max(page.first, 1), 50);

    let radiusKm: number | null = null;
    if (filter.near) {
      if (!isValidPoint(filter.near)) {
        throw new UserError(VenueCode.INVALID_LOCATION, 'That is not a point on Earth.');
      }
      radiusKm = filter.radiusKm ?? DEFAULT_RADIUS_KM;
      if (radiusTooLarge(radiusKm)) {
        throw new UserError(
          VenueCode.RADIUS_TOO_LARGE,
          `Search within ${MAX_RADIUS_KM} km or less.`,
        );
      }
    }

    const rows = await repo.search({
      near: filter.near ?? null,
      radiusKm,
      city: filter.city ?? null,
      sportId: filter.sportId ?? null,
      textPattern: containsPattern(filter.query),
      after: page.after ? decodeCursor(page.after) : null,
      // One extra row answers hasNextPage without a second count query.
      limit: first + 1,
    });

    const nodes = rows.slice(0, first).map(toVenue);
    const last = nodes.at(-1);
    const sortKey = last
      ? filter.near
        ? String(last.distanceM ?? 0)
        : last.name
      : null;

    return {
      nodes,
      hasNextPage: rows.length > first,
      endCursor: last && sortKey !== null ? encodeCursor(sortKey, last.id) : null,
    };
  }

  // --- writes ----------------------------------------------------------------

  /**
   * R3 — venues are created by organizers and visible to everyone. There is no
   * global organizer role (identity R10: a grant is per event), so any signed-in
   * player may add one and moderation is manual in Phase 1. That is acceptable
   * at this volume and should be revisited before it is not.
   *
   * `ownerId`: staff add a venue for the person who runs it, who then owns it
   * (edits it, runs its desk) as if they had added it themselves.
   */
  async function create(actor: Actor, input: CreateVenueInput, opts: { ownerId?: string } = {}): Promise<Venue> {
    if (!isValidPoint(input.location)) {
      throw new UserError(VenueCode.INVALID_LOCATION, 'That is not a point on Earth.');
    }

    const id = newId();
    await repo.insert({
      id,
      name: input.name.trim(),
      address: input.address.trim(),
      city: input.city.trim(),
      location: input.location,
      amenities: input.amenities ?? [],
      photoPublicIds: input.photoPublicIds ?? [],
      createdBy: opts.ownerId ?? actor.userId,
    });

    for (const court of input.courts ?? []) {
      await addCourt(actor, id, court);
    }
    return byId(id);
  }

  /**
   * Only the venue's creator may edit it, and PL4Y staff in the portal. Anything
   * richer needs a venue-owner grant, and inventing a second grant table for
   * Phase 1 buys nothing.
   */
  async function assertOwner(actor: Actor, venueId: string): Promise<Venue> {
    const venue = await byId(venueId);
    if (venue.createdBy !== actor.userId && !actor.platformStaff) throw forbidden();
    return venue;
  }

  async function update(
    actor: Actor,
    venueId: string,
    patch: UpdateVenueInput,
  ): Promise<Venue> {
    await assertOwner(actor, venueId);
    if (patch.location && !isValidPoint(patch.location)) {
      throw new UserError(VenueCode.INVALID_LOCATION, 'That is not a point on Earth.');
    }
    if ((patch.description?.trim().length ?? 0) > DESCRIPTION_MAX_CHARS) {
      throw new UserError(
        VenueCode.INVALID_DESCRIPTION,
        `Keep the description under ${DESCRIPTION_MAX_CHARS} characters.`,
      );
    }
    if (patch.openingHours && !validOpeningHours(patch.openingHours)) {
      throw new UserError(
        VenueCode.INVALID_OPENING_HOURS,
        'Each window needs a day and an opening time before its closing time (HH:MM).',
      );
    }
    await repo.update(venueId, {
      ...patch,
      description: patch.description === undefined ? undefined : patch.description?.trim() || null,
      contactPhone:
        patch.contactPhone === undefined ? undefined : patch.contactPhone?.trim() || null,
    });
    return byId(venueId);
  }

  /** R5 — soft delete. A completed tournament must keep resolving where it was played. */
  async function remove(actor: Actor, venueId: string): Promise<void> {
    await assertOwner(actor, venueId);
    await repo.softDelete(venueId);
  }

  async function addCourt(
    actor: Actor,
    venueId: string,
    input: CourtInput,
  ): Promise<Court> {
    await assertOwner(actor, venueId);
    const name = input.name.trim();
    const existing = await repo.courtsFor([venueId]);
    if (existing.some((c) => c.name === name)) {
      throw new UserError(
        VenueCode.DUPLICATE_COURT_NAME,
        `This venue already has a court called ${name}.`,
      );
    }
    return repo.insertCourt({
      id: newId(),
      venueId,
      name,
      surface: input.surface ?? null,
      indoor: input.indoor ?? false,
      kind: input.kind ?? 'court',
      sportIds: input.sportIds ?? [],
    }).then(toCourt);
  }

  async function courtOr404(courtId: string): Promise<Court> {
    const court = await repo.courtById(courtId);
    if (!court) throw notFound();
    return toCourt(court);
  }

  // --- F14: courts a host declares for their own event ----------------------
  // No grant check here: `events` owns who may run an event, and calls these
  // only after asserting it.

  async function courtsForEvent(eventId: string): Promise<Court[]> {
    return (await repo.courtsForEvent(eventId)).map(toCourt);
  }

  async function addEventCourt(eventId: string, input: { name: string; sportIds: string[] }): Promise<Court> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 40) {
      throw new UserError(VenueCode.DUPLICATE_COURT_NAME, 'A court name is 1 to 40 characters.');
    }
    const existing = await repo.courtsForEvent(eventId);
    const same = existing.find((c) => c.name === name);
    if (same) {
      // Re-adding a retired court brings it back rather than failing.
      if (!same.active) return repo.updateCourt(same.id, { active: true }).then(toCourt);
      throw new UserError(VenueCode.DUPLICATE_COURT_NAME, `This event already has a court called ${name}.`);
    }
    return repo.insertEventCourt({ id: newId(), eventId, name, sportIds: input.sportIds }).then(toCourt);
  }

  /** Retired, not deleted: a match already played on it keeps saying where. */
  async function retireEventCourt(eventId: string, courtId: string): Promise<void> {
    const court = await repo.courtById(courtId);
    if (!court || court.eventId !== eventId) throw notFound();
    await repo.updateCourt(courtId, { active: false });
  }

  /** `tournament` resolves `Match.court` through this. Courts are public. */
  async function findCourtById(courtId: string): Promise<Court | null> {
    const court = await repo.courtById(courtId);
    return court ? toCourt(court) : null;
  }

  async function updateCourt(
    actor: Actor,
    courtId: string,
    patch: {
      name?: string;
      surface?: string | null;
      indoor?: boolean;
      kind?: CourtKind;
      sportIds?: string[];
      active?: boolean;
    },
  ): Promise<Court> {
    const court = await courtOr404(courtId);
    // An event's own court is edited through the event (F14), never here.
    if (!court.venueId) throw notFound();
    await assertOwner(actor, court.venueId);

    // COURT_IN_USE — a court with matches on it cannot be retired out from
    // under the scheduler. Reactivating one is always fine.
    if (patch.active === false && (await schedule.courtHasScheduledMatches(courtId))) {
      throw new UserError(
        VenueCode.COURT_IN_USE,
        'This court has scheduled matches. Move them before retiring it.',
      );
    }
    return toCourt(await repo.updateCourt(courtId, patch));
  }

  // --- photos (ADR 0003) -----------------------------------------------------

  /**
   * Issues a short-lived signature for one venue photo. The public_id is
   * namespaced to the venue and carries a server-generated suffix, so
   * addPhoto's validation is structural rather than a second piece of expiring
   * state: a client cannot hand back an id pointing at another venue's asset.
   */
  async function photoUploadSignature(
    actor: Actor,
    venueId: string,
  ): Promise<UploadSignature> {
    const venue = await assertOwner(actor, venueId);
    return media.signUpload({
      publicId: newId(),
      folder: media.photoFolder(venue.id, venue.photoPublicIds.length),
    });
  }

  /** Appends an uploaded photo. Ordering is the array order (ADR 0003 §C3). */
  async function addPhoto(actor: Actor, venueId: string, publicId: string): Promise<Venue> {
    const venue = await assertOwner(actor, venueId);
    const prefix = `${media.venueRoot(venueId)}/`;
    // Without this check a client can upload under a signature we issued and
    // then report a DIFFERENT public_id (ADR 0003 §C2).
    if (!publicId.startsWith(prefix) || publicId.length === prefix.length) {
      throw new UserError(
        VenueCode.VENUE_NOT_FOUND,
        'That upload does not belong to this venue.',
      );
    }
    if (venue.photoPublicIds.includes(publicId)) return venue;
    await repo.update(venueId, { photoPublicIds: [...venue.photoPublicIds, publicId] });
    return byId(venueId);
  }

  /**
   * R4 — "available" means ONLY "not already assigned within this tournament".
   * It is a scheduling concept, not a booking one: two different tournaments at
   * the same venue on the same afternoon are the organizers' problem, and this
   * function will happily hand both of them the same court.
   */
  async function freeCourts(
    venueId: string,
    window: TimeWindow,
    tournamentId: string,
  ): Promise<Court[]> {
    const courts = (await repo.courtsFor([venueId])).filter((c) => c.active).map(toCourt);
    if (courts.length === 0) return [];
    const taken = new Set(
      await schedule.assignedCourtIds({ venueId, tournamentId, window }),
    );
    return courts.filter((c) => !taken.has(c.id));
  }

  // --- visits and reviews (R6–R8) --------------------------------------------

  /** R6 — the projection writer. Idempotent, so the worker may retry it. */
  async function recordMatchVisit(matchId: string): Promise<void> {
    if (!deps.visits) throw new Error('venues.recordMatchVisit needs a VisitsPort');
    const found = await deps.visits.forMatch(matchId);
    if (!found) return;
    await repo.recordVisits(
      found.userIds.map((userId) => ({
        venueId: found.venueId,
        userId,
        source: 'match',
        sourceId: matchId,
        visitedAt: found.at,
      })),
    );
  }

  /** R6 — played here (match, game or booking) within the last 12 months. */
  async function canReview(userId: string, venueId: string): Promise<boolean> {
    return repo.visitedSince(venueId, userId, new Date(now().getTime() - REVIEW_WINDOW_MS));
  }

  /** R6, R7 — one review per user per venue; a second call edits it. */
  async function review(
    actor: Actor,
    venueId: string,
    input: { stars: number; body?: string | null },
  ): Promise<VenueReview> {
    await byId(venueId);
    const body = input.body?.trim() || null;
    if (!Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5) {
      throw new UserError(VenueCode.INVALID_REVIEW, 'Choose between 1 and 5 stars.');
    }
    if (body && body.length > REVIEW_MAX_CHARS) {
      throw new UserError(
        VenueCode.INVALID_REVIEW,
        `Keep your review under ${REVIEW_MAX_CHARS} characters.`,
      );
    }
    if (!(await canReview(actor.userId, venueId))) {
      throw new UserError(
        VenueCode.REVIEW_NOT_ELIGIBLE,
        'You can review a venue once you have played there in the last 12 months.',
      );
    }
    return repo.upsertReview({
      id: newId(),
      venueId,
      userId: actor.userId,
      stars: input.stars,
      body,
    });
  }

  /**
   * R8 — one public reply per review. Until venue claims land (R9), the person
   * who may edit a venue (R3) is the person who may answer for it.
   */
  async function replyToReview(actor: Actor, reviewId: string, body: string): Promise<VenueReview> {
    const found = await repo.reviewById(reviewId);
    if (!found) throw reviewNotFound();
    await assertOwner(actor, found.venueId);
    if (found.replyBody !== null) {
      throw new UserError(VenueCode.ALREADY_REPLIED, 'This review already has a reply.');
    }
    const text = body.trim();
    if (text.length === 0 || text.length > REVIEW_MAX_CHARS) {
      throw new UserError(
        VenueCode.INVALID_REVIEW,
        `A reply needs between 1 and ${REVIEW_MAX_CHARS} characters.`,
      );
    }
    return repo.setReply(reviewId, text, actor.userId);
  }

  const encodeReviewCursor = (r: { createdAt: Date; id: string }) =>
    encodeCursor(r.createdAt.toISOString(), r.id);

  /** Newest first. Hidden reviews never appear. */
  async function reviews(
    venueId: string,
    page: { first: number; after?: string | null },
  ): Promise<Page<VenueReview> & { cursors: string[] }> {
    const first = Math.min(Math.max(page.first, 1), 50);
    const cursor = page.after ? decodeCursor(page.after) : null;
    const at = cursor ? new Date(cursor.sortKey) : null;
    const rows = await repo.reviewsFor(
      venueId,
      cursor && at && !Number.isNaN(at.getTime()) ? { at, id: cursor.id } : null,
      first + 1,
    );
    const nodes = rows.slice(0, first);
    const last = nodes.at(-1);
    return {
      nodes,
      cursors: nodes.map(encodeReviewCursor),
      hasNextPage: rows.length > first,
      endCursor: last ? encodeReviewCursor(last) : null,
    };
  }

  /** The viewer's own review of a venue, for editing. */
  /** admin R6 — moderation hides a review (and shows it again). Rating follows (R7). */
  async function setReviewHidden(reviewId: string, hidden: boolean): Promise<boolean> {
    return (await repo.setReviewHidden(reviewId, hidden)) !== null;
  }

  async function reviewBy(userId: string, venueId: string): Promise<VenueReview | null> {
    return repo.reviewByUser(venueId, userId);
  }

  return {
    setReviewHidden,
    recordMatchVisit,
    canReview,
    review,
    replyToReview,
    reviews,
    reviewBy,
    search,
    byId,
    findById,
    byIds,
    courtsFor,
    courtsForEvent,
    addEventCourt,
    retireEventCourt,
    findCourtById,
    sportsAt,
    create,
    update,
    remove,
    addCourt,
    updateCourt,
    freeCourts,
    photoUploadSignature,
    addPhoto,
  };
}

export { createVenueRepo };
export type VenueService = ReturnType<typeof createVenueService>;
