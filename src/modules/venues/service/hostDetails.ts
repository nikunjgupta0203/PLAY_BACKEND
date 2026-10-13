/**
 * venue hosts R7 — the partner profile that rides on an application: who to
 * talk to, the venue's facilities and hours, what it charges, how it takes
 * bookings today, and the consents PL4Y needs to list it.
 *
 * Kept as one JSON document on the application (`details`), not as thirty
 * columns: it is read whole, by a person, when the application is reviewed.
 * What a venue itself needs — amenities, opening hours, indoor or outdoor,
 * photos — is copied onto the venue when the application is approved (R6).
 * Prices and policies stay here as what the owner told us; the owner sets the
 * real booking prices from the venue desk.
 *
 * Pure: no database, no clock. `checkDetails` returns the document as it will
 * be stored, or throws the first thing wrong with it.
 */
import { UserError } from '../../../platform/errors/index.js';
import type { OpeningHours } from './index.js';

export const HostDetailsCode = {
  /** Contact person, role, WhatsApp number, email or number of venues. */
  INVALID_CONTACT: 'INVALID_CONTACT',
  INVALID_PINCODE: 'INVALID_PINCODE',
  /** The Google Maps link or the website / social link is not an http(s) link. */
  INVALID_LINK: 'INVALID_LINK',
  INVALID_PRICES: 'INVALID_PRICES',
  /** Anything else in the profile: amenities, capacity, minimum booking, policies. */
  INVALID_HOST_DETAILS: 'INVALID_HOST_DETAILS',
  /** R7 — all three: authorised to list, consent to display, partner terms. */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** R8 — not uploaded under a signature issued to this applicant, or too many. */
  INVALID_PHOTOS: 'INVALID_PHOTOS',
} as const;

export const VENUE_SETTINGS = ['indoor', 'outdoor', 'both'] as const;
export type VenueSetting = (typeof VENUE_SETTINGS)[number];

/** How the venue takes bookings today. */
export const BOOKING_METHODS = ['phone', 'whatsapp', 'walk_in', 'own_app', 'other_platform'] as const;
export type BookingMethod = (typeof BOOKING_METHODS)[number];

/** What the venue wants from PL4Y: to be found, to be booked, or to connect its own software. */
export const PARTNERSHIPS = ['listing', 'bookings', 'api'] as const;
export type Partnership = (typeof PARTNERSHIPS)[number];

export const MAX_PHOTOS = 10;
export const MAX_AMENITIES = 30;
const POLICY_MAX = 500;
const LINK_MAX = 300;
/** ₹1,00,000 an hour: beyond any court, and well inside a 32-bit GraphQL Int. */
const MAX_PRICE_PAISE = 10_000_000;

export interface HostPrice {
  sportId: string;
  pricePerHourPaise: number;
  /** Null when the venue charges one rate all day. */
  peakPricePerHourPaise: number | null;
}

export interface HostDetails {
  contactName: string;
  /** "Owner", "Manager" — the applicant's own word. */
  contactRole: string;
  /** Null when it is the same as the venue's phone number. */
  whatsappNumber: string | null;
  email: string;
  venuesManaged: number;
  mapsUrl: string | null;
  pincode: string;
  setting: VenueSetting;
  /** Website or a social page. */
  websiteUrl: string | null;
  amenities: string[];
  /** Players the venue holds at once. */
  playingCapacity: number | null;
  /** venues R12 — a day with no window is a weekly closing day. */
  openingHours: OpeningHours[];
  equipmentAvailable: boolean;
  coachingAvailable: boolean;
  prices: HostPrice[];
  /** When the peak rate applies, in the owner's words. */
  peakHours: string | null;
  minBookingMinutes: number | null;
  bookingMethod: BookingMethod | null;
  advancePolicy: string | null;
  cancellationPolicy: string | null;
  partnership: Partnership;
  /** A booking platform or software the venue already uses. */
  existingSoftware: string | null;
  authorised: boolean;
  consentDisplay: boolean;
  acceptedTerms: boolean;
}

/** What a client sends: the same document before it is trimmed and checked; anything that may be null may be left out. */
export type HostDetailsInput = { [K in keyof HostDetails as null extends HostDetails[K] ? never : K]: HostDetails[K] } & {
  [K in keyof HostDetails as null extends HostDetails[K] ? K : never]?: HostDetails[K];
};

const clean = (v: string): string => v.trim().replace(/\s+/g, ' ');
const orNull = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PINCODE = /^[1-9]\d{5}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The same rule the venue's own phone number passes (venue hosts R2). */
export function validPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13 && /^[+\d][\d\s-]*$/.test(raw.trim());
}

function link(raw: string | null | undefined, what: string): string | null {
  const v = orNull(raw);
  if (!v) return null;
  // People paste "instagram.com/myvenue": that is a link, so it is made one.
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  let ok = withScheme.length <= LINK_MAX && !/\s/.test(withScheme);
  try {
    ok = ok && new URL(withScheme).hostname.includes('.');
  } catch {
    ok = false;
  }
  if (!ok) throw new UserError(HostDetailsCode.INVALID_LINK, `That ${what} doesn’t look like a link.`);
  return withScheme;
}

function text(raw: string | null | undefined, what: string): string | null {
  const v = orNull(raw);
  if (v && v.length > POLICY_MAX) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, `Keep the ${what} under ${POLICY_MAX} characters.`);
  }
  return v;
}

const wholeNumber = (n: number | null | undefined, min: number, max: number): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

/**
 * R7 — every field, in the order the form asks for it. `sportIds` are the
 * sports the application names: a price for any other sport is refused.
 */
export function checkDetails(input: HostDetailsInput, sportIds: string[]): HostDetails {
  const contactName = clean(input.contactName ?? '');
  if (contactName.length < 2 || contactName.length > 80) {
    throw new UserError(HostDetailsCode.INVALID_CONTACT, 'Enter the name of the person we should talk to.');
  }
  const contactRole = clean(input.contactRole ?? '');
  if (contactRole.length < 2 || contactRole.length > 60) {
    throw new UserError(HostDetailsCode.INVALID_CONTACT, 'Say what they do at the venue: owner, manager…');
  }
  const whatsappNumber = orNull(input.whatsappNumber);
  if (whatsappNumber && !validPhone(whatsappNumber)) {
    throw new UserError(HostDetailsCode.INVALID_CONTACT, 'That WhatsApp number doesn’t look right.');
  }
  const email = (input.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) {
    throw new UserError(HostDetailsCode.INVALID_CONTACT, 'Enter an email address we can write to.');
  }
  if (!wholeNumber(input.venuesManaged, 1, 500)) {
    throw new UserError(HostDetailsCode.INVALID_CONTACT, 'Say how many venues you manage: at least 1.');
  }

  const pincode = (input.pincode ?? '').replace(/\s/g, '');
  if (!PINCODE.test(pincode)) {
    throw new UserError(HostDetailsCode.INVALID_PINCODE, 'PIN codes are 6 digits.');
  }
  if (!(VENUE_SETTINGS as readonly string[]).includes(input.setting)) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, 'Say whether the venue is indoor, outdoor or both.');
  }
  const mapsUrl = link(input.mapsUrl, 'Google Maps link');
  const websiteUrl = link(input.websiteUrl, 'website or social link');

  const amenities = [...new Set((input.amenities ?? []).map(clean).filter(Boolean))];
  if (amenities.length > MAX_AMENITIES || amenities.some((a) => a.length > 40)) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, 'That is too many amenities, or one is too long.');
  }
  const playingCapacity = input.playingCapacity ?? null;
  if (playingCapacity !== null && !wholeNumber(playingCapacity, 1, 100_000)) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, 'Playing capacity is a number of players.');
  }

  const openingHours = (input.openingHours ?? []).map((h) => ({ day: h.day, opens: h.opens, closes: h.closes }));
  const hoursOk =
    openingHours.length > 0 &&
    openingHours.length <= 21 &&
    openingHours.every((h) => wholeNumber(h.day, 0, 6) && HHMM.test(h.opens) && HHMM.test(h.closes) && h.opens < h.closes);
  if (!hoursOk) {
    // The venue module's own code: it is the same rule (venues R12).
    throw new UserError(
      'INVALID_OPENING_HOURS',
      'Give the opening hours: at least one open day, each with an opening time before its closing time.',
    );
  }

  const allowed = new Set(sportIds);
  const seen = new Set<string>();
  const prices = (input.prices ?? []).map((p) => {
    const peak = p.peakPricePerHourPaise ?? null;
    const ok =
      allowed.has(p.sportId) &&
      !seen.has(p.sportId) &&
      wholeNumber(p.pricePerHourPaise, 0, MAX_PRICE_PAISE) &&
      (peak === null || wholeNumber(peak, 0, MAX_PRICE_PAISE));
    if (!ok) {
      throw new UserError(HostDetailsCode.INVALID_PRICES, 'Give one price per sport you offer, in whole rupees.');
    }
    seen.add(p.sportId);
    return { sportId: p.sportId, pricePerHourPaise: p.pricePerHourPaise, peakPricePerHourPaise: peak };
  });

  const minBookingMinutes = input.minBookingMinutes ?? null;
  if (minBookingMinutes !== null && (!wholeNumber(minBookingMinutes, 15, 600) || minBookingMinutes % 15 !== 0)) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, 'The minimum booking is in steps of 15 minutes.');
  }
  const bookingMethod = input.bookingMethod ?? null;
  if (bookingMethod !== null && !(BOOKING_METHODS as readonly string[]).includes(bookingMethod)) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, 'Say how you take bookings today.');
  }
  if (!(PARTNERSHIPS as readonly string[]).includes(input.partnership)) {
    throw new UserError(HostDetailsCode.INVALID_HOST_DETAILS, 'Say how you want to work with PL4Y.');
  }

  if (input.authorised !== true || input.consentDisplay !== true || input.acceptedTerms !== true) {
    throw new UserError(
      HostDetailsCode.CONSENT_REQUIRED,
      'Confirm that you may list this venue, that we may show its details, and that you accept the partner terms.',
    );
  }

  return {
    contactName,
    contactRole,
    whatsappNumber,
    email,
    venuesManaged: input.venuesManaged,
    mapsUrl,
    pincode,
    setting: input.setting,
    websiteUrl,
    amenities,
    playingCapacity,
    openingHours,
    equipmentAvailable: input.equipmentAvailable === true,
    coachingAvailable: input.coachingAvailable === true,
    prices,
    peakHours: text(input.peakHours, 'peak hours'),
    minBookingMinutes,
    bookingMethod,
    advancePolicy: text(input.advancePolicy, 'advance booking policy'),
    cancellationPolicy: text(input.cancellationPolicy, 'cancellation policy'),
    partnership: input.partnership,
    existingSoftware: text(input.existingSoftware, 'booking software'),
    authorised: true,
    consentDisplay: true,
    acceptedTerms: true,
  };
}

/**
 * The stored document, read back. An application sent by the first version of
 * the form has none (`{}`), and reads as null rather than as a half-empty profile.
 */
export function detailsFrom(raw: unknown): HostDetails | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Partial<HostDetails>;
  if (typeof d.contactName !== 'string' || typeof d.email !== 'string') return null;
  return {
    contactName: d.contactName,
    contactRole: d.contactRole ?? '',
    whatsappNumber: d.whatsappNumber ?? null,
    email: d.email,
    venuesManaged: d.venuesManaged ?? 1,
    mapsUrl: d.mapsUrl ?? null,
    pincode: d.pincode ?? '',
    setting: (VENUE_SETTINGS as readonly string[]).includes(d.setting ?? '') ? (d.setting as VenueSetting) : 'both',
    websiteUrl: d.websiteUrl ?? null,
    amenities: Array.isArray(d.amenities) ? d.amenities : [],
    playingCapacity: d.playingCapacity ?? null,
    openingHours: Array.isArray(d.openingHours) ? d.openingHours : [],
    equipmentAvailable: d.equipmentAvailable === true,
    coachingAvailable: d.coachingAvailable === true,
    prices: Array.isArray(d.prices) ? d.prices : [],
    peakHours: d.peakHours ?? null,
    minBookingMinutes: d.minBookingMinutes ?? null,
    bookingMethod: d.bookingMethod ?? null,
    advancePolicy: d.advancePolicy ?? null,
    cancellationPolicy: d.cancellationPolicy ?? null,
    partnership: (PARTNERSHIPS as readonly string[]).includes(d.partnership ?? '') ? (d.partnership as Partnership) : 'listing',
    existingSoftware: d.existingSoftware ?? null,
    authorised: d.authorised === true,
    consentDisplay: d.consentDisplay === true,
    acceptedTerms: d.acceptedTerms === true,
  };
}

/** R8 — where an applicant's venue photos are uploaded before there is a venue to own them. */
export const photoPrefix = (root: string): string => `${root}/`;

/** R8 — only photos uploaded under this applicant's own signature, each once, ten at most. */
export function checkPhotos(publicIds: string[] | null | undefined, root: string): string[] {
  const ids = [...new Set(publicIds ?? [])];
  const prefix = photoPrefix(root);
  if (ids.length > MAX_PHOTOS) {
    throw new UserError(HostDetailsCode.INVALID_PHOTOS, `Add up to ${MAX_PHOTOS} photos.`);
  }
  if (ids.some((id) => !id.startsWith(prefix) || id.length === prefix.length || /[\s?#]|\.\./.test(id))) {
    throw new UserError(HostDetailsCode.INVALID_PHOTOS, 'One of those photos was not uploaded by you. Add it again.');
  }
  return ids;
}
