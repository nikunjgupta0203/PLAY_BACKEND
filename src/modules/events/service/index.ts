/**
 * events — service layer (docs/modules/05-events.md).
 *
 * The thing a player discovers, and the categories they actually register for.
 * Owns capacity and the single price-quote function that both `registration`
 * and `payments` call, so what the player agreed to and what the gateway charges
 * cannot drift.
 *
 * An EVENT is a tournament a player finds. An EVENT CATEGORY is what they
 * register for. Capacity, fee and format live on the CATEGORY, never the event,
 * because one tournament sells eight draws at eight prices.
 */
import type { Prisma } from '@prisma/client';
import { containsPattern } from '../../../platform/search.js';
import type { UploadSignature } from '../../../platform/cloudinary.js';
import type { Db, Tx } from '../../../platform/db.js';
import { forbidden, UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import {
  DEFAULT_RADIUS_KM,
  MAX_RADIUS_KM,
  isValidPoint,
  radiusTooLarge,
  type GeoPoint,
} from '../../../platform/geo.js';
import type { CategoryRow, EventRepo, EventRow } from '../repo/index.js';
import { HOST_COMMISSION_BPS, priceQuote as computeQuote, type PriceQuote } from './priceQuote.js';

export { CURRENCY, priceQuote as computePriceQuote } from './priceQuote.js';
export type { PriceQuote } from './priceQuote.js';

export const EventCode = {
  /** Also what a draft or cancelled event returns to a non-organizer. */
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  /** Past registration_closes_at. */
  REGISTRATION_CLOSED: 'REGISTRATION_CLOSED',
  /** Publish validation — R1. */
  INVALID_EVENT_WINDOW: 'INVALID_EVENT_WINDOW',
  /** Frozen-field edit attempt — R2. */
  EVENT_HAS_ENTRIES: 'EVENT_HAS_ENTRIES',
  RADIUS_TOO_LARGE: 'RADIUS_TOO_LARGE',
  INVALID_LOCATION: 'INVALID_LOCATION',
  INVALID_FORMAT: 'INVALID_FORMAT',
  /** Not one of DRAW_TYPES. */
  INVALID_DRAW_TYPE: 'INVALID_DRAW_TYPE',
  CATEGORY_FULL: 'CATEGORY_FULL',
  /** Empty, or longer than MESSAGE_MAX. */
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  /** More than MESSAGE_WINDOW.max messages to one event's players an hour. */
  MESSAGE_THROTTLED: 'MESSAGE_THROTTLED',
  /** Not a ten-digit Indian mobile. */
  INVALID_CONTACT_PHONE: 'INVALID_CONTACT_PHONE',
  /** A text field over its length limit. */
  INVALID_EVENT_FIELD: 'INVALID_EVENT_FIELD',
  /** events R10 — a paid category needs a verified host with a payout account. */
  ORGANIZER_NOT_VERIFIED: 'ORGANIZER_NOT_VERIFIED',
  /** A category's numbers do not make a draw that can happen (fee, size, minimum, ranges). */
  INVALID_CATEGORY: 'INVALID_CATEGORY',
  /** Not an IANA time zone this runtime knows. */
  INVALID_TIMEZONE: 'INVALID_TIMEZONE',
  /** Staff management — nobody with that email, or a role the caller may not grant. */
  STAFF_USER_NOT_FOUND: 'STAFF_USER_NOT_FOUND',
  CANNOT_CHANGE_OWNER: 'CANNOT_CHANGE_OWNER',
  /** F18 — a draw is made or play has started, so the dates and place are fixed. */
  EVENT_UNDER_WAY: 'EVENT_UNDER_WAY',
  /** F19 — somebody has entered this draw, so it cannot be deleted. */
  CATEGORY_HAS_ENTRIES: 'CATEGORY_HAS_ENTRIES',
  /** F3 — only someone who entered the event may report it. */
  NOT_A_PARTICIPANT: 'NOT_A_PARTICIPANT',
  /** F3 — reports open at the start and close two weeks after the end. */
  REPORT_WINDOW_CLOSED: 'REPORT_WINDOW_CLOSED',
  /** F21 — a match format this sport cannot be played in. */
  INVALID_SCORING_FORMAT: 'INVALID_SCORING_FORMAT',
  /** F14 — a court name that is empty, too long or taken. */
  INVALID_COURT: 'INVALID_COURT',
} as const;

/**
 * The fewest confirmed entries each draw type can be generated from. The
 * tournament module refuses a draw below these (tournament R7: MIN_ENTRIES,
 * MIN_LEAGUE_ENTRIES, MIN_GROUP_ENTRIES), so a category whose capacity or
 * minimum sits below them is a draw that can never happen. Kept equal to the
 * tournament constants by a test.
 */
export const DRAW_MIN_ENTRIES: Record<string, number> = {
  single_elim_with_plate: 4,
  single_elim: 4,
  league: 3,
  groups_knockout: 6,
};

/**
 * How a category is played: a knockout with a Plate, a league (everyone plays
 * everyone, a table decides, draws count), or groups then a knockout. The
 * tournament module generates each; a CHECK in migration 030 holds the list.
 */
export const DRAW_TYPES = ['single_elim_with_plate', 'single_elim', 'league', 'groups_knockout'] as const;

/**
 * N11 — a race, a lift or a scorecard is run as heats (scoring field), never
 * as a draw of matches, so a draw's minimum means nothing for it: two
 * entrants make a race.
 */
export const FIELD_MIN_ENTRIES = 2;
const isFieldRule = (rule: unknown): boolean => {
  const kind = (rule as { kind?: unknown } | null)?.kind;
  return kind === 'performance' || kind === 'scorecard';
};

function assertDrawType(drawType: string | undefined | null): void {
  if (drawType != null && !(DRAW_TYPES as readonly string[]).includes(drawType)) {
    throw new UserError(EventCode.INVALID_DRAW_TYPE, `Draw type is one of ${DRAW_TYPES.join(', ')}.`);
  }
}

/** Hosting — text limits the app enforces too. */
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 2_000;
export const LOCATION_NOTE_MAX = 200;

/** F24 — prizes and format notes on a category. */
export const PRIZES_MAX = 300;
export const RULES_NOTE_MAX = 600;
/** F3 — what a report may say, and how long after the end it may be made. */
export const REPORT_DETAILS_MAX = 1_000;
export const REPORT_WINDOW_AFTER_END_MS = 14 * 24 * 3_600_000;
export const REPORT_REASONS = ['did_not_happen', 'different_from_listing', 'unfair_results', 'host_conduct', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
/** F27 — standard: full refund until the cutoff. flexible: full until the cutoff, half until the start. */
export const REFUND_POLICIES = ['standard', 'flexible'] as const;
export type RefundPolicy = (typeof REFUND_POLICIES)[number];
/** F18 — entrants may withdraw with a full refund this long after the place or dates change. */
export const TERMS_CHANGE_WINDOW_MS = 48 * 3_600_000;
/** F12 — how far ahead of the close a host is warned that a draw is short. */
export const SHORT_WARNING_AHEAD_MS = 24 * 3_600_000;

/** An organizer's message to everyone entered: short enough for a notification. */
export const MESSAGE_MAX = 500;
/** Every message buzzes every entrant's phone; five an hour is already a lot. */
export const MESSAGE_WINDOW = { seconds: 3_600, max: 5 };

export const EVENT_STATUSES = [
  'draft',
  'published',
  'live',
  'completed',
  'cancelled',
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const CATEGORY_STATUSES = [
  'open',
  'full',
  'closed',
  'drawn',
  'completed',
  'cancelled',
] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

/** R4 — derived on read, never stored. */
export type Availability = 'OPEN' | 'ALMOST_FULL' | 'FULL' | 'CLOSED';

export interface Actor {
  userId: string;
}

export interface Event {
  id: string;
  sportId: string;
  /** The person who owns the event: its host, or the owner of the organisation it is hosted as. */
  organizerId: string;
  /** org R3 — the organisation the event is hosted as, if any (014's personal profiles included). */
  organizerProfileId: string | null;
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
  status: EventStatus;
  /** events R11 */
  kind: EventKind;
  coverPublicId: string | null;
  /** Shown to staff and seated entrants only (the schema decides who sees it). */
  contactPhone: string | null;
  locationNote: string | null;
  hostTermsAcceptedAt: Date | null;
  /** F18 — the place or dates changed after people entered. */
  termsChangedAt: Date | null;
  /** F27 */
  refundPolicy: RefundPolicy;
  createdAt: Date;
  updatedAt: Date;
}

export const EVENT_KINDS = ['tournament', 'league_season'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventCategory {
  id: string;
  eventId: string;
  sportId: string;
  name: string;
  format: string;
  teamSize: number;
  drawType: string;
  skillMin: number | null;
  skillMax: number | null;
  ageMin: number | null;
  ageMax: number | null;
  capacity: number;
  minEntries: number;
  entryFeePaise: bigint;
  platformFeePaise: bigint;
  taxBps: number;
  /** The platform's share of the entry fee, server-set (hosting). */
  commissionBps: number;
  status: CategoryStatus;
  /** F14 — the scheduler's slot for one match. Null = 45 minutes. */
  matchMinutes: number | null;
  /** F23 — a knockout without a Plate plays for third place. */
  thirdPlace: boolean;
  /** F24 */
  prizes: string | null;
  rulesNote: string | null;
  /** F21, F22 — the rule this draw is played under, frozen. Null = the sport's current one. */
  scoringRule: unknown;
}

/** F3 — a player's report about an event. */
export interface EventReport {
  id: string;
  eventId: string;
  reporterUserId: string;
  reason: ReportReason;
  details: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/** F8 — what "close registration now" would do to each draw. */
export interface ClosePreviewRow {
  categoryId: string;
  name: string;
  confirmed: number;
  minEntries: number;
  /** Players still paying for a seat; they are let finish. */
  paying: number;
  willCancel: boolean;
}

/** F14 — a court a host declared for this event. */
export interface EventCourt {
  id: string;
  name: string;
  active: boolean;
}

/** R5 — holds count against capacity exactly as confirmed entries do. */
export interface Capacity {
  capacity: number;
  taken: number;
  held: number;
  remaining: number;
}

export interface EventMedia {
  id: string;
  publicId: string;
  kind: string;
  sortOrder: number;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface EventFilter {
  sportId?: string | null;
  city?: string | null;
  near?: GeoPoint | null;
  radiusKm?: number | null;
  from?: Date | null;
  to?: Date | null;
  skillBand?: string | null;
  format?: string | null;
  maxPricePaise?: bigint | null;
  /** discovery R1 — free text over title and venue name. */
  query?: string | null;
  kind?: EventKind | null;
}

// --- ports -------------------------------------------------------------------

export interface SportPort {
  byId(sportId: string): Promise<{ id: string }>;
  formatsFor(sportId: string): Promise<{ key: string; teamSize: number }[]>;
  skillBandsFor(
    sportId: string,
  ): Promise<{ key: string; lowerBound: number | null; upperBound: number | null }[]>;
}

/**
 * Grants are read per request and never cached across one (identity R10): an
 * organizer's permission is revocable and sits on a screen that can rewrite
 * match results.
 */
export interface IdentityPort {
  grantsFor(userId: string, eventId: string): Promise<{ role: string } | null>;
  /** Every event this user holds a grant on, highest role per event. */
  grantsForUser(userId: string): Promise<{ eventId: string; role: string }[]>;
  addStaff(eventId: string, userId: string, role: 'owner' | 'manager' | 'scorer'): Promise<unknown>;
  /** Removes a direct grant. Absent in tests that never manage staff. */
  removeStaff?(eventId: string, userId: string): Promise<void>;
  /** Everyone with a grant on the event, highest role each. */
  staffFor?(eventId: string): Promise<{ userId: string; role: string }[]>;
  findByEmail?(email: string): Promise<{ id: string; displayName: string } | null>;
}

/**
 * `registrations` and `seat_holds` belong to `registration`, which lands in
 * Sprint 4. events asks rather than reads (conventions.md §1 — table ownership
 * is exclusive).
 *
 * R5 exists because of what happens when this port lies low: if the card says
 * two spots left while two people are in checkout, the third player pays and is
 * then told the draw is full. Counting holds makes the badge, the button and
 * the database agree.
 */
export interface EntriesPort {
  /** Confirmed entries in this category. */
  confirmedCount(categoryId: string): Promise<number>;
  /** Unexpired seat holds in this category. */
  liveHoldCount(categoryId: string): Promise<number>;
  /** Whether this user holds a confirmed or checked-in seat at the event. */
  isSeatedEntrant(eventId: string, userId: string): Promise<boolean>;
  /** F3 — whether this user entered the event at all (refunded and withdrawn count). */
  participated?(eventId: string, userId: string): Promise<boolean>;
  /** F19 — any registration row in this category, whatever its state. */
  anyIn?(categoryId: string): Promise<boolean>;
}

/** Direct-to-Cloudinary uploads (ADR 0003 §C2). Absent in tests that never upload. */
export interface MediaPort {
  signUpload(opts: { publicId: string; folder: string }): UploadSignature;
  eventRoot(eventId: string): string;
}

export interface VenuePort {
  findById(venueId: string): Promise<{ id: string; city: string; location: GeoPoint } | null>;
  /** F14 — courts a host declares for one event. Absent in tests that never schedule. */
  courtsForEvent?(eventId: string): Promise<EventCourt[]>;
  addEventCourt?(eventId: string, input: { name: string; sportIds: string[] }): Promise<EventCourt>;
  retireEventCourt?(eventId: string, courtId: string): Promise<void>;
}

/**
 * F21, F22 — the sport's rule, and a host's adjustment of it. Injected so
 * `events` never imports `sport`. Absent: categories keep no frozen rule and
 * hosts cannot adjust it.
 */
export interface RulesPort {
  defaultFor(sportId: string, formatKey: string): Promise<unknown>;
  /** Throws RuleTweakError-like errors (any Error) with a message for the host. */
  tweak(rule: unknown, tweaks: RuleTweaks): unknown;
}

export interface RuleTweaks {
  pointsToWin?: number | null;
  gamesToWin?: number | null;
  setsToWin?: number | null;
  periodMinutes?: number | null;
  oversPerInnings?: number | null;
}

/**
 * events R10 — whether this user may publish a paid category. Injected at the
 * composition root so `events` never imports whoever answers it. Absent means
 * no check (tests that are not about it).
 */
export interface PublishGate {
  /** org R6 — an organisation's event needs the organisation verified and paid into its own account. */
  canPublishPaid(userId: string, organisationId?: string | null): Promise<{ ok: boolean; missing: string[] }>;
}

/**
 * org R3, R5, R7 — hosting as an organisation. Injected so `events` never
 * imports `organizers`. Absent: nobody can host as an organisation.
 */
export interface OrganisationsPort {
  /** Throws a UserError when the person may not host as it. */
  forHosting(organisationId: string, userId: string): Promise<{ ownerId: string; role: 'owner' | 'admin' | 'member' }>;
  /** The organisation's owner and admins get their grants on a new event, in its transaction. */
  syncEventGrants(tx: Tx, organisationId: string, eventId: string): Promise<void>;
  /** R7 — a suspended organisation publishes nothing and takes no entries. */
  isSuspended(organisationId: string): Promise<boolean>;
}

export interface EventDeps {
  db: Db;
  repo: EventRepo;
  sport: SportPort;
  identity: IdentityPort;
  entries: EntriesPort;
  venues: VenuePort;
  publishGate?: PublishGate;
  organisations?: OrganisationsPort;
  media?: MediaPort;
  rules?: RulesPort;
  /**
   * The platform fee and the tax rate on a paid entry. Business and legal
   * decisions, so they come from config and never from the host's form.
   * Absent means ₹0 and no tax: PL4Y is unregistered for GST.
   */
  pricing?: { platformFeePaise: bigint; taxBps: number };
  /** Throttles organizer messages. Absent in tests that do not exercise it. */
  limiter?: {
    consume(
      key: string,
      window: { seconds: number; max: number },
    ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  };
  now?: () => Date;
}

// --- inputs ------------------------------------------------------------------

export interface CreateEventInput {
  sportId: string;
  title: string;
  description?: string | null;
  city?: string | null;
  venueId?: string | null;
  location?: GeoPoint | null;
  timezone?: string;
  startsAt: Date;
  endsAt: Date;
  registrationClosesAt: Date;
  cancellationCutoffAt?: Date | null;
  coverPublicId?: string | null;
  contactPhone?: string | null;
  locationNote?: string | null;
  /** True stamps the acceptance time; false or absent leaves it unaccepted. */
  acceptHostTerms?: boolean;
  refundPolicy?: RefundPolicy;
  /** org R3 — host as this organisation instead of as yourself. */
  organisationId?: string | null;
}

export interface UpdateEventInput {
  title?: string;
  description?: string | null;
  city?: string;
  venueId?: string | null;
  location?: GeoPoint | null;
  timezone?: string;
  startsAt?: Date;
  endsAt?: Date;
  registrationClosesAt?: Date;
  cancellationCutoffAt?: Date | null;
  coverPublicId?: string | null;
  contactPhone?: string | null;
  locationNote?: string | null;
  acceptHostTerms?: boolean;
  refundPolicy?: RefundPolicy;
}

export interface CategoryInput {
  name: string;
  format: string;
  drawType?: string;
  skillMin?: number | null;
  skillMax?: number | null;
  ageMin?: number | null;
  ageMax?: number | null;
  capacity: number;
  minEntries?: number;
  entryFeePaise: bigint;
  /**
   * Trusted callers only (tests, staff tooling). The GraphQL inputs do not
   * carry these: the platform fee and the tax rate are PL4Y's to set
   * (`EventDeps.pricing`), never the host's.
   */
  platformFeePaise?: bigint;
  taxBps?: number;
  /** F14 */
  matchMinutes?: number | null;
  /** F23 */
  thirdPlace?: boolean;
  /** F24 */
  prizes?: string | null;
  rulesNote?: string | null;
  /** F21 — the host's adjustment of the sport's match format. */
  tweaks?: RuleTweaks | null;
}

// --- helpers -----------------------------------------------------------------

const notFound = () =>
  new UserError(EventCode.EVENT_NOT_FOUND, 'That event could not be found.');

const categoryNotFound = () =>
  new UserError(EventCode.CATEGORY_NOT_FOUND, 'That category could not be found.');

const num = (v: Prisma.Decimal | null): number | null => (v === null ? null : v.toNumber());

const toEvent = (r: EventRow): Event => ({
  ...r,
  status: r.status as EventStatus,
  kind: r.kind === 'league_season' ? 'league_season' : 'tournament',
  termsChangedAt: r.termsChangedAt ?? null,
  refundPolicy: r.refundPolicy === 'flexible' ? 'flexible' : 'standard',
  organizerProfileId: r.organizerProfileId ?? null,
});

const toCategory = (r: CategoryRow): EventCategory => ({
  id: r.id,
  eventId: r.eventId,
  sportId: r.sportId,
  name: r.name,
  format: r.format,
  teamSize: r.teamSize,
  drawType: r.drawType,
  skillMin: num(r.skillMin),
  skillMax: num(r.skillMax),
  ageMin: r.ageMin,
  ageMax: r.ageMax,
  capacity: r.capacity,
  minEntries: r.minEntries,
  entryFeePaise: r.entryFeePaise,
  platformFeePaise: r.platformFeePaise,
  taxBps: r.taxBps,
  commissionBps: r.commissionBps,
  status: r.status as CategoryStatus,
  matchMinutes: r.matchMinutes ?? null,
  thirdPlace: r.thirdPlace ?? false,
  prizes: r.prizes ?? null,
  rulesNote: r.rulesNote ?? null,
  scoringRule: r.scoringRule ?? null,
});

const toReport = (r: {
  id: string;
  eventId: string;
  reporterUserId: string;
  reason: string;
  details: string | null;
  status: string;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}): EventReport => ({
  ...r,
  reason: (REPORT_REASONS as readonly string[]).includes(r.reason) ? (r.reason as ReportReason) : 'other',
  status: r.status === 'resolved' || r.status === 'dismissed' ? r.status : 'open',
});

function assertRefundPolicy(policy: string | undefined): void {
  if (policy !== undefined && !(REFUND_POLICIES as readonly string[]).includes(policy)) {
    throw new UserError(EventCode.INVALID_EVENT_FIELD, `Refund policy is one of ${REFUND_POLICIES.join(', ')}.`);
  }
}

/** F14 — 5 minutes to 8 hours, or null for the default. */
function assertMatchMinutes(minutes: number | null | undefined): void {
  if (minutes === null || minutes === undefined) return;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) {
    throw new UserError(EventCode.INVALID_CATEGORY, 'A match takes 5 to 480 minutes.');
  }
}

/** The commission follows the fee: a free entry has nothing to take a share of. */
const commissionFor = (entryFeePaise: bigint): number =>
  entryFeePaise > 0n ? HOST_COMMISSION_BPS : 0;

/**
 * An Indian mobile: ten digits starting 6–9, optionally written with +91, 91 or
 * 0 in front and spaces or dashes inside. Stored as the bare ten digits.
 */
export function normalizeIndianMobile(raw: string): string | null {
  let digits = raw.replace(/[\s-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function contactPhoneOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const phone = normalizeIndianMobile(raw);
  if (!phone) {
    throw new UserError(EventCode.INVALID_CONTACT_PHONE, 'Enter a 10-digit Indian mobile number.');
  }
  return phone;
}

function assertMaxLength(value: string | null | undefined, max: number, what: string): void {
  if (value && value.length > max) {
    throw new UserError(EventCode.INVALID_EVENT_FIELD, `The ${what} can be at most ${max} characters.`);
  }
}

const trimmedOrNull = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? '';
  return t.length > 0 ? t : null;
};

/** A time zone the runtime can format in; a bad one would break every email for the event. */
function assertTimezone(tz: string | undefined): void {
  if (tz === undefined) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new UserError(EventCode.INVALID_TIMEZONE, `${tz} is not a time zone.`);
  }
}

const invalidCategory = (message: string) => new UserError(EventCode.INVALID_CATEGORY, message);

/**
 * The numbers that decide whether a category can ever become a draw. A draw
 * the tournament module will refuse to generate is a category that takes
 * money and then cannot run (gap #8, #30).
 */
function assertCategoryShape(c: {
  name: string;
  drawType: string;
  /** N11 — run as heats; the draw's floor does not apply. */
  field?: boolean;
  capacity: number;
  minEntries: number;
  entryFeePaise: bigint;
  platformFeePaise: bigint;
  taxBps: number;
  skillMin: number | null;
  skillMax: number | null;
  ageMin: number | null;
  ageMax: number | null;
}): void {
  if (c.name.trim().length === 0) throw invalidCategory('Give the category a name.');
  if (!Number.isInteger(c.capacity) || c.capacity <= 0) {
    throw new UserError(EventCode.INVALID_EVENT_WINDOW, 'Capacity must be at least one.');
  }
  const floor = c.field ? FIELD_MIN_ENTRIES : (DRAW_MIN_ENTRIES[c.drawType] ?? 1);
  if (c.capacity < floor) throw invalidCategory(`This draw needs room for at least ${floor} entries.`);
  if (!Number.isInteger(c.minEntries) || c.minEntries < floor) {
    throw invalidCategory(`The minimum number of entries for this draw is ${floor}.`);
  }
  if (c.minEntries > c.capacity) throw invalidCategory('The minimum entries cannot be more than the capacity.');
  if (c.entryFeePaise < 0n || c.platformFeePaise < 0n) throw invalidCategory('Fees cannot be negative.');
  if (!Number.isInteger(c.taxBps) || c.taxBps < 0 || c.taxBps > 10_000) throw invalidCategory('That tax rate is not valid.');
  if (c.skillMin !== null && c.skillMax !== null && c.skillMin > c.skillMax) {
    throw invalidCategory('The lowest skill level must not be above the highest.');
  }
  if (c.ageMin !== null && c.ageMax !== null && c.ageMin > c.ageMax) {
    throw invalidCategory('The youngest age must not be above the oldest.');
  }
}

/** Cursor on (starts_at, id) — conventions.md §4. Opaque to the client. */
export const encodeEventCursor = (startsAt: Date, id: string): string =>
  Buffer.from(`${startsAt.toISOString()}|${id}`, 'utf8').toString('base64url');

function decodeEventCursor(cursor: string): { startsAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const at = raw.lastIndexOf('|');
    if (at < 0) return null;
    const startsAt = new Date(raw.slice(0, at));
    if (Number.isNaN(startsAt.getTime())) return null;
    return { startsAt, id: raw.slice(at + 1) };
  } catch {
    // A malformed cursor is a client bug, not a reason to 500. Start over.
    return null;
  }
}

/**
 * R8 — the slug is a deep link that will exist in someone's WhatsApp forever,
 * so it is derived once and then frozen at publish.
 */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : 'event';
}

/**
 * gap #16 — the publish gate's "money owed to PL4Y": a player was refunded
 * after the host was paid. The account is verified, so "add it under Get paid"
 * would send the host the wrong way; they pay PL4Y back and staff record it.
 */
const owesPl4y = (missing: string[]): boolean => missing.includes('money owed to PL4Y');
const OWES_PL4Y =
  'You owe PL4Y money: a player was refunded after you were paid for an event. Contact PL4Y support to pay it back.';

export function createEventService(deps: EventDeps) {
  const { db, repo, sport, identity, entries, venues } = deps;
  const now = deps.now ?? (() => new Date());

  // --- authorization ---------------------------------------------------------

  /**
   * Organizer permission is a per-event grant read fresh from `event_staff`,
   * never a role claim in the JWT (architecture.md §5). A revoked grant stops
   * working on the next request rather than in fifteen minutes.
   */
  async function assertStaff(
    actor: Actor,
    eventId: string,
    roles: string[] = ['owner', 'manager'],
  ): Promise<EventRow> {
    const row = await repo.byId(eventId);
    if (!row) throw notFound();
    const grant = await identity.grantsFor(actor.userId, eventId);
    // FORBIDDEN never leaks whether the resource exists (conventions.md §3),
    // and by this point we already know it does.
    if (!grant || !roles.includes(grant.role)) throw forbidden();
    return row;
  }

  /**
   * ADR 0003 §C2 — a cover must be an upload made under this event's own
   * signature. The same rule addMedia enforces, for the create/update path.
   */
  function assertOwnUpload(eventId: string, publicId: string | null | undefined): void {
    if (!publicId || !deps.media) return;
    const prefix = `${deps.media.eventRoot(eventId)}/`;
    if (!publicId.startsWith(prefix) || publicId.length === prefix.length) {
      throw new UserError(EventCode.INVALID_EVENT_FIELD, 'That upload does not belong to this event.');
    }
  }

  /**
   * events R10 at every door, not only publish (gap #5): a paid category added
   * to a live event, or a free one made paid, needs the same verified host.
   * A draft is checked at publish.
   */
  async function assertCanCharge(
    actor: Actor,
    event: { status: string; organizerProfileId?: string | null },
    feePaise: bigint,
  ): Promise<void> {
    if (event.status === 'draft' || feePaise <= 0n || !deps.publishGate) return;
    const verdict = await deps.publishGate.canPublishPaid(actor.userId, event.organizerProfileId ?? null);
    if (!verdict.ok) {
      throw new UserError(
        EventCode.ORGANIZER_NOT_VERIFIED,
        owesPl4y(verdict.missing)
          ? `${OWES_PL4Y} Settle it before adding paid draws.`
          : `Paid draws need a verified payout account (${verdict.missing.join(', ')}). Add it under Get paid.`,
      );
    }
  }

  /** F21 — the sport's rule for this format, with the host's numbers in. */
  async function tweakedRule(sportId: string, formatKey: string, tweaks: RuleTweaks): Promise<unknown> {
    if (!deps.rules) {
      throw new UserError(EventCode.INVALID_SCORING_FORMAT, 'Match formats cannot be changed for this sport yet.');
    }
    const base = await deps.rules.defaultFor(sportId, formatKey);
    try {
      return deps.rules.tweak(base, tweaks);
    } catch (err) {
      throw new UserError(
        EventCode.INVALID_SCORING_FORMAT,
        err instanceof Error ? err.message : 'Those numbers do not make a playable match.',
      );
    }
  }

  function assertCategoryExtras(c: {
    matchMinutes?: number | null;
    prizes?: string | null;
    rulesNote?: string | null;
    thirdPlace?: boolean;
    drawType?: string;
  }): void {
    assertMatchMinutes(c.matchMinutes);
    assertMaxLength(c.prizes, PRIZES_MAX, 'prizes');
    assertMaxLength(c.rulesNote, RULES_NOTE_MAX, 'format notes');
  }

  /** Somebody is confirmed, or holding a seat while they pay (gap #11). */
  async function hasPlayersIn(categoryId: string): Promise<boolean> {
    const [confirmed, held] = await Promise.all([
      entries.confirmedCount(categoryId),
      entries.liveHoldCount(categoryId),
    ]);
    return confirmed > 0 || held > 0;
  }

  // --- reads -----------------------------------------------------------------

  async function findById(eventId: string): Promise<Event | null> {
    const row = await repo.byId(eventId);
    return row ? toEvent(row) : null;
  }

  async function byId(eventId: string): Promise<Event> {
    const found = await findById(eventId);
    if (!found) throw notFound();
    return found;
  }

  /**
   * R6 — a draft or cancelled event is not discoverable, so it reads as missing
   * to anybody but its own staff.
   */
  async function findBySlug(slug: string, viewerUserId?: string | null): Promise<Event | null> {
    const row = await repo.bySlug(slug);
    if (!row) return null;
    if (row.status === 'draft' || row.status === 'cancelled') {
      if (!viewerUserId) return null;
      const grant = await identity.grantsFor(viewerUserId, row.id);
      if (!grant) return null;
    }
    return toEvent(row);
  }

  /** F9 — PL4Y staff, whatever the status. The caller has checked the platform role. */
  async function findBySlugForStaff(slug: string): Promise<Event | null> {
    const row = await repo.bySlug(slug);
    return row ? toEvent(row) : null;
  }

  async function bySlug(slug: string, viewerUserId?: string | null): Promise<Event> {
    const found = await findBySlug(slug, viewerUserId);
    if (!found) throw notFound();
    return found;
  }

  /** Hosting — the events a user runs (owner or manager), newest start first. */
  async function hostedBy(userId: string): Promise<Event[]> {
    const grants = await identity.grantsForUser(userId);
    // The organizer section lists every event the user helps run; scorers see
    // the parts their role allows (match day), owners and managers all of it.
    const ids = grants.map((g) => g.eventId);
    if (ids.length === 0) return [];
    const rows = await repo.byIds(ids);
    return rows
      .map(toEvent)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || a.id.localeCompare(b.id));
  }

  /**
   * Hosting — a host's phone number is for the people who have to reach them:
   * the event's staff and anyone holding a seat. Not for every browser.
   */
  async function canSeeContact(viewerUserId: string | null, eventId: string): Promise<boolean> {
    if (!viewerUserId) return false;
    if (await identity.grantsFor(viewerUserId, eventId)) return true;
    return entries.isSeatedEntrant(eventId, viewerUserId);
  }

  async function categoriesFor(eventId: string): Promise<EventCategory[]> {
    return (await repo.categoriesFor([eventId])).map(toCategory);
  }

  async function categoryById(categoryId: string): Promise<EventCategory> {
    const row = await repo.categoryById(categoryId);
    if (!row) throw categoryNotFound();
    return toCategory(row);
  }

  async function mediaFor(eventId: string): Promise<EventMedia[]> {
    return repo.mediaFor(eventId);
  }

  async function search(
    filter: EventFilter,
    page: { first: number; after?: string | null },
  ): Promise<Page<Event>> {
    const first = Math.min(Math.max(page.first, 1), 50);

    let radiusKm: number | null = null;
    if (filter.near) {
      if (!isValidPoint(filter.near)) {
        throw new UserError(EventCode.INVALID_LOCATION, 'That is not a point on Earth.');
      }
      radiusKm = filter.radiusKm ?? DEFAULT_RADIUS_KM;
      if (radiusTooLarge(radiusKm)) {
        throw new UserError(
          EventCode.RADIUS_TOO_LARGE,
          `Search within ${MAX_RADIUS_KM} km or less.`,
        );
      }
    }

    // A skill band is a per-sport key (sport R2); the numeric bounds behind it
    // are the sport module's to know, not this one's.
    let skill: { lower: number | null; upper: number | null } | null = null;
    if (filter.skillBand && filter.sportId) {
      const bands = await sport.skillBandsFor(filter.sportId);
      const band = bands.find((b) => b.key === filter.skillBand);
      if (band) skill = { lower: band.lowerBound, upper: band.upperBound };
    }

    const ids = await repo.searchIds(
      {
        sportId: filter.sportId ?? null,
        city: filter.city ?? null,
        near: filter.near ?? null,
        radiusKm,
        from: filter.from ?? null,
        to: filter.to ?? null,
        skill,
        format: filter.format ?? null,
        maxPricePaise: filter.maxPricePaise ?? null,
        textPattern: containsPattern(filter.query),
        kind: filter.kind ?? null,
      },
      {
        after: page.after ? decodeEventCursor(page.after) : null,
        // One extra row answers hasNextPage without a second count query.
        limit: first + 1,
      },
    );

    const window = ids.slice(0, first);
    const rows = await repo.byIds(window.map((r) => r.id));
    const byIdMap = new Map(rows.map((r) => [r.id, r]));
    // The raw query decided the order; the hydrate must not undo it.
    const nodes = window
      .map((r) => byIdMap.get(r.id))
      .filter((r): r is EventRow => r !== undefined)
      .map(toEvent);
    const last = nodes.at(-1);

    return {
      nodes,
      hasNextPage: ids.length > first,
      endCursor: last ? encodeEventCursor(last.startsAt, last.id) : null,
    };
  }

  // --- capacity and price ----------------------------------------------------

  /**
   * R5 — subtracts live seat holds as well as confirmed entries. Worst case
   * becomes "shows full briefly, then reopens" instead of "took money, then
   * refunded".
   */
  async function capacityOf(categoryId: string, loaded?: EventCategory): Promise<Capacity> {
    // Speed — a caller that already read the category passes it, saving a query per category.
    const category = loaded ?? (await categoryById(categoryId));
    const [taken, held] = await Promise.all([
      entries.confirmedCount(categoryId),
      entries.liveHoldCount(categoryId),
    ]);
    return {
      capacity: category.capacity,
      taken,
      held,
      remaining: Math.max(category.capacity - taken - held, 0),
    };
  }

  /**
   * R4 — derived, never stored. Order matters: a closed registration is CLOSED
   * even when seats remain, because the seats are no longer for sale.
   */
  async function availabilityOf(
    categoryId: string,
  ): Promise<{ availability: Availability; capacity: Capacity }> {
    const category = await categoryById(categoryId);
    // Speed — the event and the counts are independent reads; the category is already in hand.
    const [event, capacity] = await Promise.all([byId(category.eventId), capacityOf(categoryId, category)]);

    const closed =
      event.status === 'cancelled' ||
      category.status === 'cancelled' ||
      category.status === 'closed' ||
      now() >= event.registrationClosesAt;

    if (closed) return { availability: 'CLOSED', capacity };
    if (capacity.remaining <= 0) return { availability: 'FULL', capacity };
    if (capacity.remaining <= Math.ceil(capacity.capacity * 0.1)) {
      return { availability: 'ALMOST_FULL', capacity };
    }
    return { availability: 'OPEN', capacity };
  }

  /**
   * R3 — the only place money is computed, for everyone. `payments` calls this
   * same function when creating an order, which is what stops the confirm
   * screen and the gateway charge from drifting.
   */
  async function priceQuote(categoryId: string): Promise<PriceQuote> {
    const category = await categoryById(categoryId);
    return computeQuote(category);
  }

  /** Registration calls this before taking a seat hold. */
  async function assertRegistrationOpen(categoryId: string): Promise<void> {
    const { availability } = await availabilityOf(categoryId);
    if (availability === 'CLOSED') {
      throw new UserError(
        EventCode.REGISTRATION_CLOSED,
        'Registration for this event has closed.',
      );
    }
    if (availability === 'FULL') {
      throw new UserError(EventCode.CATEGORY_FULL, 'This draw is full.');
    }
    // org R7 — a suspended organisation takes no entries.
    if (deps.organisations) {
      const category = await categoryById(categoryId);
      const event = await repo.byId(category.eventId);
      if (event?.organizerProfileId && (await deps.organisations.isSuspended(event.organizerProfileId))) {
        throw new UserError(EventCode.REGISTRATION_CLOSED, 'This event is not taking entries right now.');
      }
    }
  }

  // --- writes ----------------------------------------------------------------

  async function uniqueSlug(title: string): Promise<string> {
    const base = slugify(title);
    if (!(await repo.slugExists(base))) return base;
    // A four-hex-digit suffix, not a counter: a counter tells a competitor how
    // many events with this title already exist.
    for (let i = 0; i < 5; i += 1) {
      const candidate = `${base}-${Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, '0')}`;
      if (!(await repo.slugExists(candidate))) return candidate;
    }
    return `${base}-${newId().slice(0, 8)}`;
  }

  /**
   * A draft may be incomplete: publish is the validation gate (R1). Only the
   * things that cannot be fixed later are checked here.
   */
  async function create(actor: Actor, input: CreateEventInput): Promise<Event> {
    await sport.byId(input.sportId);
    const title = input.title.trim();
    const locationNote = trimmedOrNull(input.locationNote);
    assertMaxLength(title, TITLE_MAX, 'title');
    assertMaxLength(input.description, DESCRIPTION_MAX, 'description');
    assertMaxLength(locationNote, LOCATION_NOTE_MAX, 'location note');
    const contactPhone = contactPhoneOf(input.contactPhone);

    let city = input.city?.trim() ?? '';
    let location = input.location ?? null;
    if (input.venueId) {
      const venue = await venues.findById(input.venueId);
      if (!venue) {
        throw new UserError(EventCode.EVENT_NOT_FOUND, 'That venue could not be found.');
      }
      // The venue is the authority on where the event is. An organizer typing a
      // different city into the form is a data-entry error, not an override.
      city = venue.city;
      location ??= venue.location;
    }
    if (location && !isValidPoint(location)) {
      throw new UserError(EventCode.INVALID_LOCATION, 'That is not a point on Earth.');
    }
    assertTimezone(input.timezone);
    assertRefundPolicy(input.refundPolicy);

    // org R3, R5 — hosted as an organisation, the event is the organisation's:
    // its owner owns it and is paid for it, and its admins help run it.
    const organisationId = input.organisationId ?? null;
    if (organisationId && !deps.organisations) {
      throw new UserError(EventCode.INVALID_EVENT_FIELD, 'Hosting as an organisation is not available.');
    }
    const host = organisationId ? await deps.organisations!.forHosting(organisationId, actor.userId) : null;

    const id = newId();
    // Nothing can have been uploaded under an event that does not exist yet.
    assertOwnUpload(id, input.coverPublicId);
    const slug = await uniqueSlug(input.title);

    await db.$transaction(async (tx) => {
      await repo.insert(tx, {
        id,
        sportId: input.sportId,
        organizerId: host?.ownerId ?? actor.userId,
        organizerProfileId: organisationId,
        venueId: input.venueId ?? null,
        slug,
        title,
        description: input.description ?? null,
        city,
        timezone: input.timezone ?? 'Asia/Kolkata',
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        registrationClosesAt: input.registrationClosesAt,
        cancellationCutoffAt: input.cancellationCutoffAt ?? null,
        status: 'draft',
        coverPublicId: input.coverPublicId ?? null,
        contactPhone,
        locationNote,
        hostTermsAcceptedAt: input.acceptHostTerms ? now() : null,
        refundPolicy: input.refundPolicy ?? 'standard',
        location,
      });
      // The creator is staff on their own event from the first instant, or the
      // very next call to update() would be FORBIDDEN.
      if (!host || !organisationId) {
        await tx.eventStaff.create({
          data: { eventId: id, userId: actor.userId, role: 'owner' },
        });
        return;
      }
      // An organisation's owner and admins hold organizer grants (org R5); a
      // plain member who creates the event runs it as a manager.
      await deps.organisations!.syncEventGrants(tx, organisationId, id);
      if (host.role === 'member') {
        await tx.eventStaff.create({ data: { eventId: id, userId: actor.userId, role: 'manager' } });
      }
    });

    return byId(id);
  }

  /**
   * R2 — once published, `starts_at`, fees and capacity may only change while
   * every category has zero confirmed registrations. After that they are
   * frozen: players agreed to specific terms. A player holding a seat while
   * they pay has agreed to them too (gap #11).
   */
  async function assertNoConfirmedEntries(eventId: string): Promise<void> {
    const categories = await repo.categoriesFor([eventId]);
    const taken = await Promise.all(categories.map((c) => hasPlayersIn(c.id)));
    if (taken.some(Boolean)) {
      throw new UserError(
        EventCode.EVENT_HAS_ENTRIES,
        'Players have already paid for this event. These details are now fixed.',
      );
    }
  }

  /**
   * R1's date rules, shared by publish and every later edit (gap #10): an
   * edit after publishing must not be able to make a window publish refused.
   */
  function windowProblems(w: {
    startsAt: Date;
    endsAt: Date;
    registrationClosesAt: Date;
    cancellationCutoffAt: Date | null;
  }): string[] {
    const problems: string[] = [];
    if (!(w.registrationClosesAt <= w.startsAt)) {
      problems.push('registration must close before the event starts');
    }
    if (!(w.startsAt < w.endsAt)) problems.push('the event must end after it starts');
    if (w.cancellationCutoffAt && w.cancellationCutoffAt > w.startsAt) {
      problems.push('the cancellation cutoff must be before the event starts');
    }
    return problems;
  }

  /** A patch field that repeats what is stored is not a change (dates compare by instant). */
  const sameValue = (a: unknown, b: unknown): boolean =>
    a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

  const FROZEN_AFTER_ENTRY: (keyof UpdateEventInput)[] = [
    'startsAt',
    'endsAt',
    'registrationClosesAt',
    'cancellationCutoffAt',
  ];

  async function update(
    actor: Actor,
    eventId: string,
    patch: UpdateEventInput,
  ): Promise<Event> {
    const row = await assertStaff(actor, eventId);
    if (row.status === 'cancelled' || row.status === 'completed') {
      throw new UserError(
        EventCode.EVENT_NOT_FOUND,
        'This event is finished and can no longer be edited.',
      );
    }

    // F18 — once people have entered, the dates and the place may still move
    // (rain, a venue that cancels), but never silently: entrants are told and
    // may withdraw with a full refund for 48 hours. Once a draw is made or
    // play has started, they are fixed.
    const touchesFrozen = FROZEN_AFTER_ENTRY.some(
      (k) => patch[k] !== undefined && !sameValue(patch[k], row[k as keyof EventRow]),
    );
    const movesPlace =
      (patch.venueId !== undefined && patch.venueId !== row.venueId) ||
      (patch.city !== undefined && patch.city.trim() !== row.city) ||
      patch.location !== undefined;
    let termsChange = false;
    if (row.status !== 'draft' && (touchesFrozen || movesPlace)) {
      const categories = await repo.categoriesFor([eventId]);
      if (row.status === 'live' || categories.some((c) => c.status === 'drawn' || c.status === 'completed')) {
        throw new UserError(
          EventCode.EVENT_UNDER_WAY,
          'A draw is made or play has started, so the dates and place are fixed now. Message your players instead.',
        );
      }
      termsChange = (await Promise.all(categories.map((c) => hasPlayersIn(c.id)))).some(Boolean);
    }
    if (patch.refundPolicy !== undefined) {
      assertRefundPolicy(patch.refundPolicy);
      // F27 — after people have paid, a policy may only get kinder.
      if (row.status !== 'draft' && patch.refundPolicy === 'standard' && row.refundPolicy === 'flexible') {
        await assertNoConfirmedEntries(eventId);
      }
    }

    const data: Prisma.EventUpdateInput = {};
    if (patch.title !== undefined) {
      assertMaxLength(patch.title.trim(), TITLE_MAX, 'title');
      data.title = patch.title.trim();
    }
    if (patch.description !== undefined) {
      assertMaxLength(patch.description, DESCRIPTION_MAX, 'description');
      data.description = patch.description;
    }
    if (patch.contactPhone !== undefined) data.contactPhone = contactPhoneOf(patch.contactPhone);
    if (patch.locationNote !== undefined) {
      const note = trimmedOrNull(patch.locationNote);
      assertMaxLength(note, LOCATION_NOTE_MAX, 'location note');
      data.locationNote = note;
    }
    // Acceptance is a fact with a time; un-ticking does not un-accept it.
    if (patch.acceptHostTerms && !row.hostTermsAcceptedAt) data.hostTermsAcceptedAt = now();
    if (patch.timezone !== undefined) {
      assertTimezone(patch.timezone);
      data.timezone = patch.timezone;
    }
    assertOwnUpload(eventId, patch.coverPublicId);
    // Checked before anything is written, so a bad pin never leaves half an edit saved.
    if (patch.location && !isValidPoint(patch.location)) {
      throw new UserError(EventCode.INVALID_LOCATION, 'That is not a point on Earth.');
    }

    // gap #10 — a published event keeps the window publish insisted on.
    if (row.status !== 'draft' && touchesFrozen) {
      const problems = windowProblems({
        startsAt: patch.startsAt ?? row.startsAt,
        endsAt: patch.endsAt ?? row.endsAt,
        registrationClosesAt: patch.registrationClosesAt ?? row.registrationClosesAt,
        cancellationCutoffAt:
          patch.cancellationCutoffAt === undefined ? row.cancellationCutoffAt : patch.cancellationCutoffAt,
      });
      if (problems.length > 0) {
        throw new UserError(EventCode.INVALID_EVENT_WINDOW, `That change does not work: ${problems.join('; ')}.`);
      }
    }
    if (patch.startsAt !== undefined) data.startsAt = patch.startsAt;
    if (patch.endsAt !== undefined) data.endsAt = patch.endsAt;
    if (patch.registrationClosesAt !== undefined) {
      data.registrationClosesAt = patch.registrationClosesAt;
    }
    if (patch.cancellationCutoffAt !== undefined) {
      data.cancellationCutoffAt = patch.cancellationCutoffAt;
    }
    if (patch.coverPublicId !== undefined) data.coverPublicId = patch.coverPublicId;
    if (patch.city !== undefined) data.city = patch.city.trim();
    if (patch.refundPolicy !== undefined) data.refundPolicy = patch.refundPolicy;
    if (termsChange) data.termsChangedAt = now();

    if (patch.venueId !== undefined) {
      if (patch.venueId === null) {
        data.venue = { disconnect: true };
      } else {
        const venue = await venues.findById(patch.venueId);
        if (!venue) {
          throw new UserError(EventCode.EVENT_NOT_FOUND, 'That venue could not be found.');
        }
        data.venue = { connect: { id: patch.venueId } };
        if (patch.city === undefined) data.city = venue.city;
      }
    }

    const movesDeadline =
      row.status !== 'draft' &&
      patch.registrationClosesAt !== undefined &&
      patch.registrationClosesAt.getTime() !== row.registrationClosesAt.getTime();

    await repo.update(eventId, data);
    if (patch.location !== undefined) {
      await repo.setLocation(db, eventId, patch.location);
    }
    if (movesDeadline) {
      // gap #9 — the close job scheduled at publish still fires at the old
      // time (closeRegistration now ignores it); this schedules the new one.
      await db.$transaction(async (tx) => {
        await outboxWrite(tx, {
          topic: 'event.registration_rescheduled',
          payload: { eventId, registrationClosesAt: patch.registrationClosesAt!.toISOString() },
        });
      });
    }
    if (termsChange) {
      // F18 — every entrant hears what moved, and that they may withdraw.
      await db.$transaction(async (tx) => {
        await outboxWrite(tx, {
          topic: 'event.terms_changed',
          payload: {
            eventId,
            datesChanged: touchesFrozen,
            placeChanged: movesPlace,
            withdrawUntil: new Date(now().getTime() + TERMS_CHANGE_WINDOW_MS).toISOString(),
          },
        });
      });
    }
    return byId(eventId);
  }

  /**
   * R1 — publish is the validation gate. A draft may be missing anything; a
   * published event may not be missing a category, a place or a coherent
   * registration window.
   */
  async function publish(actor: Actor, eventId: string): Promise<Event> {
    const row = await assertStaff(actor, eventId, ['owner']);
    if (row.status !== 'draft') return toEvent(row);

    const problems: string[] = [];
    const categories = await repo.categoriesFor([eventId]);
    if (categories.length === 0) problems.push('add at least one category');
    if (!row.city && !row.venueId) problems.push('set a city or a venue');
    problems.push(...windowProblems(row));
    if (!(row.startsAt > now())) problems.push('the event must start in the future');
    if (!(row.registrationClosesAt > now())) problems.push('registration must close in the future');
    if (!row.contactPhone) problems.push('add a contact phone');
    if (!row.hostTermsAcceptedAt) problems.push('accept the hosting terms');

    if (problems.length > 0) {
      throw new UserError(
        EventCode.INVALID_EVENT_WINDOW,
        `Before publishing: ${problems.join('; ')}.`,
      );
    }

    // org R7 — a suspended organisation publishes nothing.
    if (row.organizerProfileId && (await deps.organisations?.isSuspended(row.organizerProfileId))) {
      throw new UserError(
        EventCode.ORGANIZER_NOT_VERIFIED,
        'This organisation is suspended, so it cannot publish events. Contact PL4Y support.',
      );
    }

    // events R10 — free categories need nothing; a paid one needs the gate.
    if (deps.publishGate && categories.some((c) => c.entryFeePaise > 0n)) {
      const verdict = await deps.publishGate.canPublishPaid(actor.userId, row.organizerProfileId ?? null);
      if (!verdict.ok) {
        throw new UserError(
          EventCode.ORGANIZER_NOT_VERIFIED,
          owesPl4y(verdict.missing)
            ? `${OWES_PL4Y} Settle it to publish paid events, or make every category free, or keep this as a draft.`
            : // payouts R5 — `missing` is the account's state ("no account", "checking"…), not a noun list.
              `Paid events need a verified payout account (${verdict.missing.join(', ')}). ` +
              'Add it under Get paid, make every category free, or keep this as a draft.',
        );
      }
    }

    // F22 — every draw is played under the rule as it stands today, whatever
    // PL4Y changes later. A host's own format (F21) is already frozen.
    const frozen: { id: string; rule: unknown }[] = [];
    if (deps.rules) {
      for (const c of categories) {
        if (c.scoringRule == null) frozen.push({ id: c.id, rule: await deps.rules.defaultFor(c.sportId, c.format) });
      }
    }

    await db.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { status: 'published' } });
      for (const f of frozen) {
        await tx.eventCategory.update({ where: { id: f.id }, data: { scoringRule: f.rule as Prisma.InputJsonValue } });
      }
      await outboxWrite(tx, {
        topic: 'event.published',
        payload: { eventId, sportId: row.sportId, slug: row.slug, city: row.city },
      });
    });

    return byId(eventId);
  }

  /**
   * R7 — irreversible, and it enqueues a FULL refund including the platform fee
   * for every confirmed registration. The refunds themselves are `payments`'
   * work; this writes the fact into the outbox in the same transaction as the
   * status change, so a crash between the two is not possible.
   */
  async function cancel(actor: Actor, eventId: string, reason: string): Promise<Event> {
    const row = await assertStaff(actor, eventId, ['owner']);
    if (row.status === 'cancelled') return toEvent(row);
    if (row.status === 'completed') {
      throw new UserError(
        EventCode.EVENT_NOT_FOUND,
        'This event has finished and cannot be cancelled.',
      );
    }

    await db.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { status: 'cancelled' } });
      await repo.setCategoryStatuses(tx, eventId, 'cancelled');
      await outboxWrite(tx, {
        topic: 'event.cancelled',
        payload: { eventId, reason, refundPlatformFee: true },
      });
    });

    return byId(eventId);
  }

  /**
   * An organizer's message to every confirmed entrant, as a notification
   * (feed row + push). Written to the outbox with nothing else: the fan-out
   * needs registration, and the worker already holds it.
   */
  async function messagePlayers(actor: Actor, eventId: string, rawMessage: string): Promise<void> {
    const row = await assertStaff(actor, eventId);
    if (row.status !== 'published' && row.status !== 'live') {
      throw new UserError(EventCode.EVENT_NOT_FOUND, 'Only a published or live event can message its players.');
    }
    const message = rawMessage.trim();
    if (message.length === 0 || message.length > MESSAGE_MAX) {
      throw new UserError(EventCode.INVALID_MESSAGE, `A message is 1 to ${MESSAGE_MAX} characters.`);
    }
    if (deps.limiter) {
      const limit = await deps.limiter.consume(`event-message:${eventId}`, MESSAGE_WINDOW);
      if (!limit.allowed) {
        throw new UserError(EventCode.MESSAGE_THROTTLED, 'Too many messages to this event’s players. Try later.', {
          retryAfterSeconds: limit.retryAfterSeconds,
        });
      }
    }
    await db.$transaction(async (tx) => {
      await outboxWrite(tx, {
        topic: 'event.message',
        payload: { eventId, message, sentBy: actor.userId },
      });
    });
  }

  async function addCategory(
    actor: Actor,
    eventId: string,
    input: CategoryInput,
  ): Promise<EventCategory> {
    const row = await assertStaff(actor, eventId);
    if (row.status === 'cancelled' || row.status === 'completed') throw notFound();

    // The format list belongs to `sport` (sport R5's sibling): team size is not
    // a number the organizer gets to invent, or a doubles draw ends up with
    // one-player teams.
    const formats = await sport.formatsFor(row.sportId);
    const format = formats.find((f) => f.key === input.format);
    if (!format) {
      throw new UserError(
        EventCode.INVALID_FORMAT,
        `${input.format} is not a format for this sport.`,
      );
    }
    assertDrawType(input.drawType);
    const drawType = input.drawType ?? 'single_elim_with_plate';
    const field = deps.rules ? isFieldRule(await deps.rules.defaultFor(row.sportId, format.key)) : false;
    const floor = field ? FIELD_MIN_ENTRIES : (DRAW_MIN_ENTRIES[drawType] ?? 1);
    const shape = {
      name: input.name.trim(),
      drawType,
      capacity: input.capacity,
      // The default never asks for more entries than the draw has room for.
      minEntries: input.minEntries ?? Math.min(input.capacity, field ? floor : Math.max(4, floor)),
      entryFeePaise: input.entryFeePaise,
      // gap #7 — PL4Y's numbers, not the host's.
      platformFeePaise:
        input.platformFeePaise ?? (input.entryFeePaise > 0n ? (deps.pricing?.platformFeePaise ?? 0n) : 0n),
      taxBps: input.taxBps ?? deps.pricing?.taxBps ?? 0,
      skillMin: input.skillMin ?? null,
      skillMax: input.skillMax ?? null,
      ageMin: input.ageMin ?? null,
      ageMax: input.ageMax ?? null,
    };
    assertCategoryShape({ ...shape, field });
    assertCategoryExtras(input);
    await assertCanCharge(actor, row, shape.entryFeePaise);
    // F21 — the host's format, frozen now; otherwise frozen at publish (F22),
    // or now for a draw added to an event already taking entries.
    const scoringRule =
      input.tweaks && Object.values(input.tweaks).some((v) => v != null)
        ? await tweakedRule(row.sportId, format.key, input.tweaks)
        : row.status !== 'draft' && deps.rules
          ? await deps.rules.defaultFor(row.sportId, format.key)
          : null;

    const created = await repo.insertCategory({
      id: newId(),
      eventId,
      sportId: row.sportId,
      format: format.key,
      teamSize: format.teamSize,
      ...shape,
      commissionBps: commissionFor(input.entryFeePaise),
      status: 'open',
      matchMinutes: input.matchMinutes ?? null,
      thirdPlace: input.thirdPlace ?? false,
      prizes: trimmedOrNull(input.prizes),
      rulesNote: trimmedOrNull(input.rulesNote),
      scoringRule: scoringRule == null ? undefined : (scoringRule as Prisma.InputJsonValue),
    });
    return toCategory(created);
  }

  /**
   * R2 again, at category grain: fee and capacity are frozen once anybody has
   * paid for THIS category. Renaming it stays allowed — a typo in "Men's Doubls
   * 3.5" is not a change of terms.
   */
  async function updateCategory(
    actor: Actor,
    categoryId: string,
    patch: Partial<Omit<CategoryInput, 'format'>> & { status?: CategoryStatus },
  ): Promise<EventCategory> {
    const existing = await categoryById(categoryId);
    const row = await assertStaff(actor, existing.eventId);
    if (row.status === 'cancelled' || row.status === 'completed') throw categoryNotFound();

    const hasTweaks = !!patch.tweaks && Object.values(patch.tweaks).some((v) => v != null);
    const touchesTerms =
      patch.capacity !== undefined ||
      patch.entryFeePaise !== undefined ||
      patch.platformFeePaise !== undefined ||
      patch.taxBps !== undefined ||
      // F16 — lowering the minimum only helps the players already in (their
      // draw goes ahead instead of being refunded). Raising it is a change of terms.
      (patch.minEntries !== undefined && patch.minEntries > existing.minEntries) ||
      // gap #11 — a knockout someone paid for must not become a league.
      (patch.drawType !== undefined && patch.drawType !== existing.drawType) ||
      // F21 — how a match is played is part of what they entered.
      hasTweaks ||
      (patch.thirdPlace !== undefined && patch.thirdPlace !== existing.thirdPlace);

    if (row.status !== 'draft' && touchesTerms && (await hasPlayersIn(categoryId))) {
      throw new UserError(
        EventCode.EVENT_HAS_ENTRIES,
        'Players have already paid for this draw. Its price, size and format are now fixed.',
      );
    }

    assertDrawType(patch.drawType);
    // gap #8 — the merged category must still be a draw that can happen.
    assertCategoryShape({
      name: patch.name ?? existing.name,
      drawType: patch.drawType ?? existing.drawType,
      field: isFieldRule(
        existing.scoringRule ?? (deps.rules ? await deps.rules.defaultFor(existing.sportId, existing.format) : null),
      ),
      capacity: patch.capacity ?? existing.capacity,
      minEntries: patch.minEntries ?? existing.minEntries,
      entryFeePaise: patch.entryFeePaise ?? existing.entryFeePaise,
      platformFeePaise: patch.platformFeePaise ?? existing.platformFeePaise,
      taxBps: patch.taxBps ?? existing.taxBps,
      skillMin: patch.skillMin === undefined ? existing.skillMin : patch.skillMin,
      skillMax: patch.skillMax === undefined ? existing.skillMax : patch.skillMax,
      ageMin: patch.ageMin === undefined ? existing.ageMin : patch.ageMin,
      ageMax: patch.ageMax === undefined ? existing.ageMax : patch.ageMax,
    });
    assertCategoryExtras(patch);
    // F16 — the minimum moves only while the draw still takes entries.
    if (patch.minEntries !== undefined && !['open', 'full'].includes(existing.status) && row.status !== 'draft') {
      throw invalidCategory('Registration for this draw has closed, so its minimum is settled.');
    }
    // gap #5 — making a free draw paid needs the same verified host publish asks for.
    if (patch.entryFeePaise !== undefined && existing.entryFeePaise === 0n) {
      await assertCanCharge(actor, row, patch.entryFeePaise);
    }
    // A free draw made paid picks up the platform fee too, as addCategory would give it.
    const platformFeeForNewFee =
      patch.entryFeePaise !== undefined && patch.platformFeePaise === undefined
        ? patch.entryFeePaise > 0n
          ? existing.entryFeePaise > 0n
            ? existing.platformFeePaise
            : (deps.pricing?.platformFeePaise ?? 0n)
          : 0n
        : undefined;
    const data: Prisma.EventCategoryUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name.trim();
    if (patch.drawType !== undefined) data.drawType = patch.drawType;
    if (patch.skillMin !== undefined) data.skillMin = patch.skillMin;
    if (patch.skillMax !== undefined) data.skillMax = patch.skillMax;
    if (patch.ageMin !== undefined) data.ageMin = patch.ageMin;
    if (patch.ageMax !== undefined) data.ageMax = patch.ageMax;
    if (patch.capacity !== undefined) data.capacity = patch.capacity;
    if (patch.minEntries !== undefined) data.minEntries = patch.minEntries;
    if (patch.entryFeePaise !== undefined) {
      data.entryFeePaise = patch.entryFeePaise;
      data.commissionBps = commissionFor(patch.entryFeePaise);
    }
    if (patch.platformFeePaise !== undefined) data.platformFeePaise = patch.platformFeePaise;
    else if (platformFeeForNewFee !== undefined) data.platformFeePaise = platformFeeForNewFee;
    if (patch.taxBps !== undefined) data.taxBps = patch.taxBps;
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.matchMinutes !== undefined) data.matchMinutes = patch.matchMinutes;
    if (patch.thirdPlace !== undefined) data.thirdPlace = patch.thirdPlace;
    if (patch.prizes !== undefined) data.prizes = trimmedOrNull(patch.prizes);
    if (patch.rulesNote !== undefined) data.rulesNote = trimmedOrNull(patch.rulesNote);
    if (hasTweaks) {
      data.scoringRule = (await tweakedRule(existing.sportId, existing.format, patch.tweaks!)) as Prisma.InputJsonValue;
    }

    return toCategory(await repo.updateCategory(categoryId, data));
  }

  // --- lifecycle transitions, called by jobs ---------------------------------

  /**
   * Emits `category.full` so notifications can work a waitlist. Called by
   * registration when a hold is confirmed; idempotent, because every job is.
   */
  async function refreshCategoryFullness(categoryId: string): Promise<CategoryStatus> {
    const category = await categoryById(categoryId);
    if (category.status !== 'open' && category.status !== 'full') return category.status;

    const capacity = await capacityOf(categoryId);
    const next: CategoryStatus = capacity.remaining <= 0 ? 'full' : 'open';
    if (next === category.status) return next;

    await db.$transaction(async (tx) => {
      await tx.eventCategory.update({ where: { id: categoryId }, data: { status: next } });
      if (next === 'full') {
        await outboxWrite(tx, {
          topic: 'category.full',
          payload: { categoryId, eventId: category.eventId },
        });
      }
    });
    return next;
  }

  /**
   * `event_categories` belongs to this module, so `tournament` asks rather than
   * writes (conventions.md §1 — table ownership is exclusive).
   *
   * Both of these take the CALLER'S transaction, which is the whole point:
   * tournament R6 writes a draw in one transaction, and a category that says
   * `drawn` while the bracket rolled back is worse than either outcome on its
   * own.
   */
  async function markCategoryDrawn(categoryId: string, tx: Tx): Promise<CategoryStatus> {
    await tx.eventCategory.update({ where: { id: categoryId }, data: { status: 'drawn' } });
    return 'drawn';
  }

  async function markCategoryCompleted(categoryId: string, tx: Tx): Promise<CategoryStatus> {
    await tx.eventCategory.update({ where: { id: categoryId }, data: { status: 'completed' } });
    return 'completed';
  }

  /** `promote-to-live` (R: architecture.md §6). Idempotent. */
  async function markLive(eventId: string): Promise<Event> {
    const row = await repo.byId(eventId);
    if (!row) throw notFound();
    if (row.status === 'live') return toEvent(row);
    if (row.status !== 'published') {
      // Not an illegal transition to shout about: a cancelled event whose first
      // match job fires anyway is an ordering artefact, not a bug.
      return toEvent(row);
    }
    await db.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { status: 'live' } });
      await outboxWrite(tx, { topic: 'event.live', payload: { eventId } });
    });
    return byId(eventId);
  }

  async function markCompleted(eventId: string): Promise<Event> {
    const row = await repo.byId(eventId);
    if (!row) throw notFound();
    if (row.status === 'completed' || row.status === 'cancelled') return toEvent(row);
    await db.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { status: 'completed' } });
      await outboxWrite(tx, { topic: 'event.completed', payload: { eventId } });
    });
    return byId(eventId);
  }

  /**
   * gap #1 — the event is over when every draw is: each category completed
   * (its bracket, league or heats finished) or cancelled. Called whenever a
   * draw finishes. `event.completed` is what schedules the host's payout.
   */
  async function completeIfFinished(eventId: string): Promise<boolean> {
    const row = await repo.byId(eventId);
    if (!row || (row.status !== 'published' && row.status !== 'live')) return false;
    const categories = await repo.categoriesFor([eventId]);
    if (categories.length === 0) return false;
    const done = categories.every((c) => c.status === 'completed' || c.status === 'cancelled');
    if (!done) return false;
    await markCompleted(eventId);
    return true;
  }

  /** How long after its end an event is completed whether or not every result was entered. */
  const COMPLETE_AFTER_END_MS = 24 * 3_600_000;

  /**
   * gap #1's backstop: an event whose host never scored a match (or ran it on
   * paper) still has to finish, or its payout is never scheduled.
   */
  async function dueForCompletion(limit = 100): Promise<string[]> {
    const rows = await db.event.findMany({
      where: {
        status: { in: ['published', 'live'] },
        endsAt: { lte: new Date(now().getTime() - COMPLETE_AFTER_END_MS) },
      },
      select: { id: true },
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  /**
   * gap #6 — the host closes registration early (a full draw, or a walk-in
   * day), so the draw can be made. Brings the deadline forward to now and runs
   * the ordinary close, minimum-entry cancellations included.
   */
  async function closeRegistrationNow(
    actor: Actor,
    eventId: string,
  ): Promise<{ closed: string[]; cancelled: string[] }> {
    const row = await assertStaff(actor, eventId);
    if (row.status !== 'published' && row.status !== 'live') {
      throw new UserError(EventCode.EVENT_NOT_FOUND, 'Only a published event takes registrations.');
    }
    const at = now();
    if (row.registrationClosesAt > at) {
      await repo.update(eventId, { registrationClosesAt: at });
    }
    return closeRegistration(eventId);
  }

  /**
   * `close-registration`, then R9: any category below `min_entries` is
   * auto-cancelled and fully refunded. The refund itself is `payments`' work,
   * reached through the outbox in the same transaction as the status change.
   *
   * Idempotent — a category already closed or cancelled is left alone.
   *
   * gap #9 — the job is scheduled at publish for the deadline as it was then.
   * A host who extends the deadline leaves that job behind, so the deadline is
   * read again here and an early run does nothing.
   */
  async function closeRegistration(
    eventId: string,
  ): Promise<{ closed: string[]; cancelled: string[] }> {
    const row = await repo.byId(eventId);
    if (!row) throw notFound();
    if (row.status === 'cancelled' || row.status === 'completed') {
      return { closed: [], cancelled: [] };
    }
    if (now() < row.registrationClosesAt) return { closed: [], cancelled: [] };

    const categories = await repo.categoriesFor([eventId]);
    const closed: string[] = [];
    const cancelled: string[] = [];

    for (const category of categories) {
      if (category.status !== 'open' && category.status !== 'full') continue;
      const confirmed = await entries.confirmedCount(category.id);
      const underMinimum = confirmed < category.minEntries;

      await db.$transaction(async (tx) => {
        await tx.eventCategory.update({
          where: { id: category.id },
          data: { status: underMinimum ? 'cancelled' : 'closed' },
        });
        if (underMinimum) {
          await outboxWrite(tx, {
            topic: 'category.cancelled',
            payload: {
              eventId,
              categoryId: category.id,
              reason: 'under_minimum',
              confirmed,
              minEntries: category.minEntries,
              refundPlatformFee: true,
            },
          });
        } else {
          // Registration is over for this draw: whoever is still queued for a
          // seat will never get one (registration expires them).
          await outboxWrite(tx, {
            topic: 'category.closed',
            payload: { eventId, categoryId: category.id },
          });
        }
      });

      (underMinimum ? cancelled : closed).push(category.id);
    }

    return { closed, cancelled };
  }

  /** Events whose registration window has passed but are still taking entries. */
  async function dueForClose(limit = 100): Promise<string[]> {
    const rows = await db.event.findMany({
      where: {
        status: { in: ['published', 'live'] },
        registrationClosesAt: { lte: now() },
        categories: { some: { status: { in: ['open', 'full'] } } },
      },
      select: { id: true },
      take: limit,
    });
    return rows.map((r) => r.id);
  }

  /** The upload a host's phone makes before calling addMedia (ADR 0003 §C2). */
  async function coverUploadSignature(actor: Actor, eventId: string): Promise<UploadSignature> {
    await assertStaff(actor, eventId);
    if (!deps.media) throw new Error('events: no media port wired');
    return deps.media.signUpload({ publicId: newId(), folder: deps.media.eventRoot(eventId) });
  }

  /** Media rows are additive; the cover also lives on the event for one read. */
  async function addMedia(
    actor: Actor,
    eventId: string,
    media: { publicId: string; kind: 'cover' | 'gallery' | 'sponsor'; sortOrder?: number },
  ): Promise<EventMedia> {
    await assertStaff(actor, eventId);
    // Without this a client could upload under a signature we issued and then
    // report a DIFFERENT public_id (ADR 0003 §C2) — the venue rule, here.
    if (deps.media) {
      const prefix = `${deps.media.eventRoot(eventId)}/`;
      if (!media.publicId.startsWith(prefix) || media.publicId.length === prefix.length) {
        throw new UserError(EventCode.INVALID_EVENT_FIELD, 'That upload does not belong to this event.');
      }
    }
    const row = await db.eventMedia.create({
      data: {
        id: newId(),
        eventId,
        publicId: media.publicId,
        kind: media.kind,
        sortOrder: media.sortOrder ?? 0,
      },
    });
    if (media.kind === 'cover') {
      await repo.update(eventId, { coverPublicId: media.publicId });
    }
    return {
      id: row.id,
      publicId: row.publicId,
      kind: row.kind,
      sortOrder: row.sortOrder,
    };
  }

  // --- the organizer section (2026-10-04 flow review) --------------------------

  /**
   * F19 — a draw nobody has entered can go. Once anyone has (paid, pending or
   * since refunded), it stays, so their history keeps pointing somewhere.
   */
  async function removeCategory(actor: Actor, categoryId: string): Promise<void> {
    const existing = await categoryById(categoryId);
    const row = await assertStaff(actor, existing.eventId);
    if (row.status === 'cancelled' || row.status === 'completed') throw categoryNotFound();
    const taken = entries.anyIn ? await entries.anyIn(categoryId) : await hasPlayersIn(categoryId);
    if (taken) {
      throw new UserError(
        EventCode.CATEGORY_HAS_ENTRIES,
        'Players have entered this draw, so it cannot be deleted. Cancel the event, or keep the draw.',
      );
    }
    const categories = await repo.categoriesFor([existing.eventId]);
    if (row.status !== 'draft' && categories.length <= 1) {
      throw new UserError(EventCode.INVALID_CATEGORY, 'A published event needs at least one draw. Cancel the event instead.');
    }
    await db.eventCategory.delete({ where: { id: categoryId } });
  }

  /**
   * F8 — what "close registration now" would do, draw by draw, before the
   * host taps it: which go ahead and which are cancelled and refunded.
   */
  async function closePreview(actor: Actor, eventId: string): Promise<ClosePreviewRow[]> {
    await assertStaff(actor, eventId);
    const categories = await repo.categoriesFor([eventId]);
    const out: ClosePreviewRow[] = [];
    for (const c of categories) {
      if (c.status !== 'open' && c.status !== 'full') continue;
      const [confirmed, paying] = await Promise.all([
        entries.confirmedCount(c.id),
        entries.liveHoldCount(c.id),
      ]);
      out.push({
        categoryId: c.id,
        name: c.name,
        confirmed,
        minEntries: c.minEntries,
        paying,
        willCancel: confirmed < c.minEntries,
      });
    }
    return out;
  }

  // F14 — courts the host declares, for an event that is not at a listed venue
  // (or is, but the host has not booked the venue's courts through PL4Y).

  async function courtsOf(eventId: string): Promise<EventCourt[]> {
    if (!venues.courtsForEvent) return [];
    return (await venues.courtsForEvent(eventId)).filter((c) => c.active);
  }

  async function addCourt(actor: Actor, eventId: string, name: string): Promise<EventCourt> {
    const row = await assertStaff(actor, eventId);
    if (row.status === 'cancelled' || row.status === 'completed') throw notFound();
    if (!venues.addEventCourt) throw new Error('events: no court port wired');
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 40) {
      throw new UserError(EventCode.INVALID_COURT, 'A court name is 1 to 40 characters.');
    }
    try {
      return await venues.addEventCourt(eventId, { name: trimmed, sportIds: [row.sportId] });
    } catch (err) {
      if (err instanceof UserError) throw new UserError(EventCode.INVALID_COURT, err.message);
      throw err;
    }
  }

  async function retireCourt(actor: Actor, eventId: string, courtId: string): Promise<void> {
    await assertStaff(actor, eventId);
    if (!venues.retireEventCourt) throw new Error('events: no court port wired');
    await venues.retireEventCourt(eventId, courtId);
  }

  // F3 — reports.

  /**
   * A player who entered says the event did not happen as promised. Open from
   * the start until two weeks after the end; one open report per player.
   * PL4Y staff are alerted and the host's payout waits (payouts reads
   * `openReportCount`).
   */
  async function report(
    actor: Actor,
    eventId: string,
    input: { reason: string; details?: string | null },
  ): Promise<EventReport> {
    const row = await repo.byId(eventId);
    if (!row || row.status === 'draft') throw notFound();
    const participated = entries.participated
      ? await entries.participated(eventId, actor.userId)
      : await entries.isSeatedEntrant(eventId, actor.userId);
    if (!participated) {
      throw new UserError(EventCode.NOT_A_PARTICIPANT, 'Only players who entered this event can report it.');
    }
    const at = now();
    if (at < row.startsAt || at.getTime() > row.endsAt.getTime() + REPORT_WINDOW_AFTER_END_MS) {
      throw new UserError(
        EventCode.REPORT_WINDOW_CLOSED,
        'Reports open when the event starts and close two weeks after it ends. Contact support.',
      );
    }
    if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) {
      throw new UserError(EventCode.INVALID_EVENT_FIELD, 'Pick what went wrong.');
    }
    const details = trimmedOrNull(input.details);
    assertMaxLength(details, REPORT_DETAILS_MAX, 'report');

    const open = await db.eventReport.findFirst({ where: { eventId, reporterUserId: actor.userId, status: 'open' } });
    if (open) return toReport(open);
    const created = await db.$transaction(async (tx) => {
      const r = await tx.eventReport.create({
        data: { id: newId(), eventId, reporterUserId: actor.userId, reason: input.reason, details },
      });
      await outboxWrite(tx, { topic: 'event.reported', payload: { eventId, reportId: r.id, reason: input.reason } });
      return r;
    });
    return toReport(created);
  }

  /** What a player has reported about this event, if anything is still open. */
  async function myReport(userId: string, eventId: string): Promise<EventReport | null> {
    const r = await db.eventReport.findFirst({
      where: { eventId, reporterUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return r ? toReport(r) : null;
  }

  /** PL4Y staff — the caller has already checked the platform role. */
  async function reports(status: 'open' | 'resolved' | 'dismissed' = 'open', limit = 100): Promise<EventReport[]> {
    const rows = await db.eventReport.findMany({ where: { status }, orderBy: { createdAt: 'asc' }, take: limit });
    return rows.map(toReport);
  }

  async function resolveReport(
    staffUserId: string,
    reportId: string,
    outcome: 'resolved' | 'dismissed',
    note: string,
  ): Promise<EventReport> {
    const trimmed = note.trim();
    if (trimmed.length === 0) throw new UserError(EventCode.INVALID_EVENT_FIELD, 'Say what was decided.');
    const updated = await db.eventReport.updateMany({
      where: { id: reportId, status: 'open' },
      data: { status: outcome, resolutionNote: trimmed, resolvedBy: staffUserId, resolvedAt: now() },
    });
    const row = await db.eventReport.findUnique({ where: { id: reportId } });
    if (!row) throw notFound();
    if (updated.count === 1) {
      await db.$transaction(async (tx) => {
        await outboxWrite(tx, { topic: 'event.report_resolved', payload: { eventId: row.eventId, reportId, outcome } });
      });
    }
    return toReport(row);
  }

  /** payouts — open reports, and when the newest arrived (a release before it does not clear it). */
  async function openReports(eventId: string): Promise<{ count: number; latestAt: Date | null }> {
    const rows = await db.eventReport.findMany({
      where: { eventId, status: 'open' },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return { count: rows.length, latestAt: rows[0]?.createdAt ?? null };
  }

  /** F13, F17 — where the event is: its own pin, else its venue's. */
  async function locationOf(eventId: string): Promise<GeoPoint | null> {
    const own = await repo.locationOf(eventId);
    if (own) return own;
    const row = await repo.byId(eventId);
    if (!row?.venueId) return null;
    return (await venues.findById(row.venueId))?.location ?? null;
  }

  /** F3 — signs a host can be trusted: events they ran to the end. */
  async function hostedCount(userId: string): Promise<number> {
    return db.event.count({ where: { organizerId: userId, status: 'completed' } });
  }

  /**
   * F12 — a day before registration closes, the host hears about every draw
   * still short of its minimum, while there is time to share it or lower the
   * minimum (F16). Once per draw.
   */
  async function warnShortCategories(limit = 200): Promise<number> {
    const at = now();
    const rows = await db.eventCategory.findMany({
      where: {
        status: { in: ['open', 'full'] },
        shortWarnedAt: null,
        event: {
          status: 'published',
          registrationClosesAt: { gt: at, lte: new Date(at.getTime() + SHORT_WARNING_AHEAD_MS) },
        },
      },
      select: { id: true, eventId: true, minEntries: true },
      take: limit,
    });
    let warned = 0;
    for (const c of rows) {
      const confirmed = await entries.confirmedCount(c.id);
      await db.$transaction(async (tx) => {
        const { count } = await tx.eventCategory.updateMany({
          where: { id: c.id, shortWarnedAt: null },
          data: { shortWarnedAt: at },
        });
        if (count !== 1 || confirmed >= c.minEntries) return;
        await outboxWrite(tx, {
          topic: 'category.short',
          payload: { eventId: c.eventId, categoryId: c.id, confirmed, minEntries: c.minEntries },
        });
        warned += 1;
      });
    }
    return warned;
  }

  // --- staff (gap #26) ---------------------------------------------------------

  /** Everyone who helps run the event. Owners and managers see the list. */
  async function staffOf(actor: Actor, eventId: string): Promise<{ userId: string; role: string }[]> {
    await assertStaff(actor, eventId);
    if (!identity.staffFor) return [];
    return identity.staffFor(eventId);
  }

  /**
   * An owner adds managers and scorers; a manager adds scorers. Nobody adds
   * an owner: the owner is who created the event and who gets paid for it.
   * Grants are read fresh on every request, so a removal bites at once.
   */
  async function addStaffMember(
    actor: Actor,
    eventId: string,
    input: { email: string; role: 'manager' | 'scorer' },
  ): Promise<{ userId: string; role: string }> {
    const row = await assertStaff(actor, eventId);
    if (row.status === 'cancelled' || row.status === 'completed') throw notFound();
    const mine = await identity.grantsFor(actor.userId, eventId);
    if (input.role === 'manager' && mine?.role !== 'owner') throw forbidden();
    if (!identity.findByEmail) throw new Error('events: no user lookup wired');
    const user = await identity.findByEmail(input.email.trim().toLowerCase());
    if (!user) {
      throw new UserError(
        EventCode.STAFF_USER_NOT_FOUND,
        'Nobody has a PL4Y account with that email. Ask them to sign up first.',
      );
    }
    const theirs = await identity.grantsFor(user.id, eventId);
    if (theirs?.role === 'owner') {
      throw new UserError(EventCode.CANNOT_CHANGE_OWNER, 'That person owns this event.');
    }
    // F7 — re-adding a manager as a scorer demotes them, which is the owner's
    // call, exactly as removing them is.
    if (theirs?.role === 'manager' && mine?.role !== 'owner') throw forbidden();
    await identity.addStaff(eventId, user.id, input.role);
    return { userId: user.id, role: input.role };
  }

  async function removeStaffMember(actor: Actor, eventId: string, userId: string): Promise<void> {
    await assertStaff(actor, eventId);
    const mine = await identity.grantsFor(actor.userId, eventId);
    const theirs = await identity.grantsFor(userId, eventId);
    if (!theirs) return;
    if (theirs.role === 'owner') {
      throw new UserError(EventCode.CANNOT_CHANGE_OWNER, 'The owner cannot be removed.');
    }
    // A manager may remove scorers; only the owner removes a manager.
    if (theirs.role === 'manager' && mine?.role !== 'owner') throw forbidden();
    if (!identity.removeStaff) throw new Error('events: no staff removal wired');
    await identity.removeStaff(eventId, userId);
  }

  return {
    removeCategory,
    closePreview,
    courtsOf,
    addCourt,
    retireCourt,
    report,
    myReport,
    reports,
    resolveReport,
    openReports,
    hostedCount,
    warnShortCategories,
    locationOf,
    staffOf,
    addStaffMember,
    removeStaffMember,
    completeIfFinished,
    dueForCompletion,
    closeRegistrationNow,
    search,
    byId,
    findById,
    bySlug,
    findBySlug,
    findBySlugForStaff,
    categoriesFor,
    hostedBy,
    canSeeContact,
    coverUploadSignature,
    categoryById,
    mediaFor,
    capacityOf,
    availabilityOf,
    priceQuote,
    assertRegistrationOpen,
    create,
    update,
    publish,
    cancel,
    messagePlayers,
    addCategory,
    updateCategory,
    addMedia,
    refreshCategoryFullness,
    markCategoryDrawn,
    markCategoryCompleted,
    markLive,
    markCompleted,
    closeRegistration,
    dueForClose,
    assertStaff,
  };
}

export type EventService = ReturnType<typeof createEventService>;
export type { CategoryRow, EventRepo, EventRow, Tx };
