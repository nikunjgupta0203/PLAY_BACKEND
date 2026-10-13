/**
 * venue hosts — applications to list a venue (docs/modules/04-venues.md, "Venue hosts").
 *
 * A player asks from Home; the row waits in the portal; PL4Y staff approve or
 * reject it. Approving creates the venue with the applicant as its owner, so
 * the venue desk in the app is theirs from that moment.
 *
 * The bank details are NOT kept here. They are the applicant's payout account
 * (payouts R1, R2): one sealed copy of the PAN and account number, one review
 * of it, wherever it was typed.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { isValidPoint, type GeoPoint } from '../../../platform/geo.js';
import { newId } from '../../../platform/ids.js';
import { DESCRIPTION_MAX_CHARS, VenueCode, type Venue, type VenueService } from './index.js';

export const HostApplicationCode = {
  INVALID_VENUE_NAME: 'INVALID_VENUE_NAME',
  INVALID_ADDRESS: 'INVALID_ADDRESS',
  INVALID_CITY: 'INVALID_CITY',
  /** R2 — at least one sport, and each one a sport PL4Y has. */
  INVALID_SPORTS: 'INVALID_SPORTS',
  /** R2 — 1 to 50. */
  INVALID_COURT_COUNT: 'INVALID_COURT_COUNT',
  INVALID_PHONE: 'INVALID_PHONE',
  /** R3 — no payout account yet, or the saved one was rejected, and no details were sent. */
  BANK_DETAILS_REQUIRED: 'BANK_DETAILS_REQUIRED',
  /** R4 — one open application per person. */
  HOST_APPLICATION_PENDING: 'HOST_APPLICATION_PENDING',
  HOST_APPLICATION_NOT_FOUND: 'HOST_APPLICATION_NOT_FOUND',
  /** R5 — already approved or rejected. */
  HOST_APPLICATION_DECIDED: 'HOST_APPLICATION_DECIDED',
  /** R6 — a venue needs a map point: the applicant gave none, and neither did staff. */
  VENUE_LOCATION_REQUIRED: 'VENUE_LOCATION_REQUIRED',
} as const;

export const HOST_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type HostApplicationStatus = (typeof HOST_APPLICATION_STATUSES)[number];

export const MAX_COURTS = 50;
const NAME_MAX = 120;
const ADDRESS_MAX = 300;
const CITY_MAX = 80;
/** What the portal lists at once. Pending ones are few; the rest is history. */
const LIST_MAX = 200;

export interface HostApplication {
  id: string;
  userId: string;
  venueName: string;
  address: string;
  city: string;
  /** Null when the applicant gave no map point. Staff give one when approving (R6). */
  location: GeoPoint | null;
  sportIds: string[];
  courtCount: number;
  contactPhone: string;
  description: string | null;
  status: HostApplicationStatus;
  /** The sentence the applicant reads when rejected. */
  statusReason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  /** The venue an approved application became. */
  venueId: string | null;
  createdAt: Date;
}

export interface HostBankDetails {
  legalName: string;
  pan: string;
  accountNumber: string;
  ifsc: string;
}

export interface HostApplicationInput {
  venueName: string;
  address: string;
  city: string;
  /** Optional: only someone standing at the venue can give it from the app. */
  location?: GeoPoint | null;
  sportIds: string[];
  courtCount: number;
  contactPhone: string;
  description?: string | null;
  /** Left out by someone who already has a payout account: that account is the one reviewed. */
  bank?: HostBankDetails | null;
}

/** `payout_accounts` belongs to payments, so venues asks rather than writes (conventions.md §1). */
export interface HostBankPort {
  /** The applicant's own payout account, or null when they never saved one. */
  accountFor(userId: string): Promise<{ id: string; status: string } | null>;
  /** payouts R1 — seals the details and starts their check. Throws the payout module's own user errors. */
  save(userId: string, details: HostBankDetails): Promise<void>;
}

export interface HostApplicationDeps {
  db: Db;
  venues: Pick<VenueService, 'create' | 'update'>;
  bank: HostBankPort;
  /** True for a sport PL4Y has, active or not. */
  sportExists(sportId: string): Promise<boolean>;
  /** Tells the applicant what was decided. Best effort: a failed push never undoes a decision. */
  notify(
    userId: string,
    payload: { status: 'approved' | 'rejected'; venueName: string; reason: string | null },
    venueId: string | null,
  ): Promise<void>;
  now?: () => Date;
}

type Row = Prisma.VenueHostApplicationGetPayload<object>;

const toView = (r: Row): HostApplication => ({
  id: r.id,
  userId: r.userId,
  venueName: r.venueName,
  address: r.address,
  city: r.city,
  location: r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
  sportIds: r.sportIds,
  courtCount: r.courtCount,
  contactPhone: r.contactPhone,
  description: r.description,
  status: r.status as HostApplicationStatus,
  statusReason: r.statusReason,
  reviewedBy: r.reviewedBy,
  reviewedAt: r.reviewedAt,
  venueId: r.venueId,
  createdAt: r.createdAt,
});

const clean = (v: string): string => v.trim().replace(/\s+/g, ' ');

export function createHostApplicationService(deps: HostApplicationDeps) {
  const { db, bank } = deps;
  const now = deps.now ?? (() => new Date());

  const pending = () =>
    new UserError(
      HostApplicationCode.HOST_APPLICATION_PENDING,
      'We already have your application and are reviewing it. You’ll hear from us soon.',
    );

  /** R2 — the venue fields, as they will be stored. Throws on the first thing wrong. */
  async function checked(input: HostApplicationInput) {
    const venueName = clean(input.venueName);
    if (venueName.length < 2 || venueName.length > NAME_MAX) {
      throw new UserError(HostApplicationCode.INVALID_VENUE_NAME, 'Enter the venue’s name.');
    }
    const address = clean(input.address);
    if (address.length < 5 || address.length > ADDRESS_MAX) {
      throw new UserError(HostApplicationCode.INVALID_ADDRESS, 'Enter the full address, so players can find it.');
    }
    const city = clean(input.city);
    if (city.length < 2 || city.length > CITY_MAX) {
      throw new UserError(HostApplicationCode.INVALID_CITY, 'Enter the city.');
    }
    const location = input.location ?? null;
    if (location && !isValidPoint(location)) {
      throw new UserError(VenueCode.INVALID_LOCATION, 'That is not a point on Earth.');
    }
    const sportIds = [...new Set(input.sportIds)];
    if (sportIds.length === 0) {
      throw new UserError(HostApplicationCode.INVALID_SPORTS, 'Pick at least one sport played at the venue.');
    }
    for (const id of sportIds) {
      if (!(await deps.sportExists(id))) {
        throw new UserError(HostApplicationCode.INVALID_SPORTS, 'One of those sports is not available.');
      }
    }
    if (!Number.isInteger(input.courtCount) || input.courtCount < 1 || input.courtCount > MAX_COURTS) {
      throw new UserError(HostApplicationCode.INVALID_COURT_COUNT, `Enter how many courts, from 1 to ${MAX_COURTS}.`);
    }
    const contactPhone = input.contactPhone.trim();
    const digits = contactPhone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13 || !/^[+\d][\d\s-]*$/.test(contactPhone)) {
      throw new UserError(HostApplicationCode.INVALID_PHONE, 'Enter a phone number we can reach the venue on.');
    }
    const description = input.description?.trim() || null;
    if ((description?.length ?? 0) > DESCRIPTION_MAX_CHARS) {
      throw new UserError(VenueCode.INVALID_DESCRIPTION, `Keep the description under ${DESCRIPTION_MAX_CHARS} characters.`);
    }
    return {
      venueName,
      address,
      city,
      lat: location?.lat ?? null,
      lng: location?.lng ?? null,
      sportIds,
      courtCount: input.courtCount,
      contactPhone,
      description,
    };
  }

  /**
   * R1–R4 — the venue's details and where its money goes, sent together. The
   * venue fields are checked before the bank details are saved, so a typo in
   * the address never burns one of the day's bank-detail changes.
   */
  async function submit(actor: { userId: string }, input: HostApplicationInput): Promise<HostApplication> {
    const fields = await checked(input);
    if (await db.venueHostApplication.findFirst({ where: { userId: actor.userId, status: 'pending' }, select: { id: true } })) {
      throw pending();
    }

    if (input.bank) {
      await bank.save(actor.userId, input.bank);
    } else {
      const account = await bank.accountFor(actor.userId);
      if (!account) {
        throw new UserError(HostApplicationCode.BANK_DETAILS_REQUIRED, 'Add the bank account your earnings should go to.');
      }
      if (account.status === 'rejected') {
        throw new UserError(
          HostApplicationCode.BANK_DETAILS_REQUIRED,
          'We couldn’t verify your saved bank account. Enter the details again.',
        );
      }
    }

    try {
      const row = await db.venueHostApplication.create({ data: { id: newId(), userId: actor.userId, ...fields } });
      return toView(row);
    } catch (err) {
      // The partial unique index: a second submit raced the first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw pending();
      throw err;
    }
  }

  /** The applicant's latest application, whatever was decided. Null when they never applied. */
  async function mine(userId: string): Promise<HostApplication | null> {
    const row = await db.venueHostApplication.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return row ? toView(row) : null;
  }

  /** portal — waiting ones oldest first (first come, first reviewed); decided ones newest first. */
  async function list(status: HostApplicationStatus | null): Promise<HostApplication[]> {
    const rows = await db.venueHostApplication.findMany({
      where: status ? { status } : {},
      orderBy: status === 'pending' ? { createdAt: 'asc' } : { createdAt: 'desc' },
      take: LIST_MAX,
    });
    return rows.map(toView);
  }

  async function pendingCount(): Promise<number> {
    return db.venueHostApplication.count({ where: { status: 'pending' } });
  }

  /** R5 — takes the application out of `pending`, or says why it could not. One decision wins a race. */
  async function decide(
    staff: { userId: string },
    id: string,
    to: 'approved' | 'rejected',
    reason: string | null,
  ): Promise<Row> {
    const claimed = await db.venueHostApplication.updateMany({
      where: { id, status: 'pending' },
      data: { status: to, statusReason: reason, reviewedBy: staff.userId, reviewedAt: now() },
    });
    const row = await db.venueHostApplication.findUnique({ where: { id } });
    if (!row) throw new UserError(HostApplicationCode.HOST_APPLICATION_NOT_FOUND, 'That application could not be found.');
    if (claimed.count === 0) {
      throw new UserError(HostApplicationCode.HOST_APPLICATION_DECIDED, `That application was already ${row.status}.`);
    }
    return row;
  }

  /**
   * R5, R6 — the venue is created as the applicant's own, with the courts they
   * counted ("Court 1" … "Court N", each for every sport they named). They
   * rename and price them from the venue desk. If the venue cannot be made the
   * application goes back to `pending`, so nothing is approved into thin air.
   *
   * A venue needs a map point. `opts.location` is staff's, and wins over the
   * applicant's own; with neither, nothing is decided.
   */
  async function approve(
    staff: { userId: string },
    id: string,
    opts: { location?: GeoPoint | null } = {},
  ): Promise<{ application: HostApplication; venue: Venue }> {
    const before = await db.venueHostApplication.findUnique({ where: { id }, select: { lat: true, lng: true } });
    const location =
      opts.location ?? (before && before.lat !== null && before.lng !== null ? { lat: before.lat, lng: before.lng } : null);
    if (before && !location) {
      throw new UserError(
        HostApplicationCode.VENUE_LOCATION_REQUIRED,
        'This application has no map point. Add the venue’s location to approve it.',
      );
    }
    if (location && !isValidPoint(location)) {
      throw new UserError(VenueCode.INVALID_LOCATION, 'That is not a point on Earth.');
    }
    const row = await decide(staff, id, 'approved', null);
    const asStaff = { userId: staff.userId, platformStaff: true };
    let venue: Venue;
    try {
      const created = await deps.venues.create(
        asStaff,
        {
          name: row.venueName,
          address: row.address,
          city: row.city,
          // Present whenever `decide` found the row: checked above.
          location: location!,
          courts: Array.from({ length: row.courtCount }, (_, i) => ({ name: `Court ${i + 1}`, sportIds: row.sportIds })),
        },
        { ownerId: row.userId },
      );
      venue = await deps.venues.update(asStaff, created.id, { contactPhone: row.contactPhone, description: row.description });
    } catch (err) {
      await db.venueHostApplication.update({
        where: { id },
        data: { status: 'pending', reviewedBy: null, reviewedAt: null },
      });
      throw err;
    }
    // The point the venue was listed at, so the application reads as what was approved.
    const done = await db.venueHostApplication.update({
      where: { id },
      data: { venueId: venue.id, lat: venue.location.lat, lng: venue.location.lng },
    });
    await deps.notify(row.userId, { status: 'approved', venueName: row.venueName, reason: null }, venue.id);
    return { application: toView(done), venue };
  }

  /** R5 — `reason` is the sentence the applicant reads. They may apply again. */
  async function reject(staff: { userId: string }, id: string, reason: string): Promise<HostApplication> {
    const row = await decide(staff, id, 'rejected', reason.trim());
    await deps.notify(row.userId, { status: 'rejected', venueName: row.venueName, reason: row.statusReason }, null);
    return toView(row);
  }

  return { submit, mine, list, pendingCount, approve, reject };
}

export type HostApplicationService = ReturnType<typeof createHostApplicationService>;
