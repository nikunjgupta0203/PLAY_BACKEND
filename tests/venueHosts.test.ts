/**
 * venue hosts — service tests against a real Postgres (conventions.md §5).
 *
 * The one-open-application rule is a partial unique index, and an approval is
 * a claim on a row two staff can race for: a mock would agree with whatever
 * the test hoped.
 *
 * Every numbered rule has a test that names it, so `grep 'venue hosts R4'`
 * finds it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { VenueService } from '../src/modules/venues/service/index.js';
import {
  HostApplicationCode,
  createHostApplicationService,
  type HostApplicationInput,
  type HostApplicationService,
  type HostBankDetails,
  type HostMediaPort,
} from '../src/modules/venues/service/hostApplications.js';
import { HostDetailsCode, type HostDetailsInput } from '../src/modules/venues/service/hostDetails.js';
import type { Db } from '../src/platform/db.js';
import { isUserError, UserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let venues: VenueService;
let sport: SportService;
let hosts: HostApplicationService;
let pickleballId: string;

/** The payout module, as far as an application can tell: what was saved, and what it answers. */
const bank = {
  accounts: new Map<string, { id: string; status: string }>(),
  saved: [] as { userId: string; details: HostBankDetails }[],
  refuse: null as UserError | null,
  reset() {
    this.accounts.clear();
    this.saved = [];
    this.refuse = null;
  },
};
let notified: { userId: string; status: string; reason: string | null; venueId: string | null }[] = [];

/** Signs nothing real: an upload is named, and the folder is the applicant's own. */
const media: HostMediaPort = {
  hostRoot: (userId) => `pl4y/venue-hosts/${userId}`,
  signUpload: ({ publicId, folder }) => ({
    cloudName: 'test',
    apiKey: 'key',
    timestamp: 1,
    publicId,
    folder,
    uploadPreset: 'preset',
    signature: 'sig',
    uploadUrl: 'https://upload.test',
    expiresAt: new Date(0),
  }),
};

let applicant: { userId: string };
let staff: { userId: string };

const BANK: HostBankDetails = { legalName: 'Rahul Sharma', pan: 'ABCPS1234K', accountNumber: '123456789012', ifsc: 'HDFC0001234' };

const application = (over: Partial<HostApplicationInput> = {}): HostApplicationInput => ({
  venueName: '  Smash   Arena ',
  address: '12, 100 Feet Road, Indiranagar',
  city: 'Bengaluru',
  location: { lat: 12.9784, lng: 77.6408 },
  sportIds: [pickleballId],
  courtCount: 3,
  contactPhone: '+91 98765 43210',
  description: 'Four covered courts and parking.',
  bank: BANK,
  ...over,
});

const WEEKDAYS = [0, 1, 2, 3, 4, 5].map((day) => ({ day, opens: '06:00', closes: '22:00' }));

/** The partner profile, as the longer form sends it. Sunday (6) is the weekly closing day. */
const profile = (over: Partial<HostDetailsInput> = {}): HostDetailsInput => ({
  contactName: '  Rahul   Sharma ',
  contactRole: 'Owner',
  whatsappNumber: null,
  email: ' Rahul@SmashArena.in ',
  venuesManaged: 2,
  mapsUrl: 'https://maps.app.goo.gl/abc123',
  pincode: '560038',
  setting: 'indoor',
  websiteUrl: 'instagram.com/smasharena',
  amenities: ['Parking', 'Washrooms', 'Parking'],
  playingCapacity: 24,
  openingHours: WEEKDAYS,
  equipmentAvailable: true,
  coachingAvailable: false,
  prices: [{ sportId: pickleballId, pricePerHourPaise: 60_000, peakPricePerHourPaise: 80_000 }],
  peakHours: '6 pm to 10 pm, and weekends',
  minBookingMinutes: 60,
  bookingMethod: 'whatsapp',
  advancePolicy: 'Up to 7 days ahead, paid in full.',
  cancellationPolicy: 'Free until 12 hours before.',
  partnership: 'bookings',
  existingSoftware: null,
  authorised: true,
  consentDisplay: true,
  acceptedTerms: true,
  ...over,
});

async function makeUser(email: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({ data: { id: userId, email, displayName: email.split('@')[0]! } });
  return { userId };
}

const errorCode = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return isUserError(e) ? e.code : 'THREW';
  }
  return 'NO_ERROR';
};

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  venues = wired.venues;
  sport = wired.sport;
  hosts = createHostApplicationService({
    db: prisma as unknown as Db,
    venues,
    media,
    bank: {
      accountFor: async (userId) => bank.accounts.get(userId) ?? null,
      save: async (userId, details) => {
        if (bank.refuse) throw bank.refuse;
        bank.saved.push({ userId, details });
        bank.accounts.set(userId, { id: newId(), status: 'needs_review' });
      },
    },
    sportExists: (id) =>
      sport.byId(id).then(
        () => true,
        () => false,
      ),
    notify: async (userId, payload, venueId) => {
      notified.push({ userId, status: payload.status, reason: payload.reason, venueId });
    },
  });
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  bank.reset();
  notified = [];
  applicant = await makeUser('owner@example.com');
  staff = await makeUser('staff@example.com');
});

describe('venue hosts', () => {
  it('venue hosts R1: an application is stored as pending, trimmed, with the bank details saved once', async () => {
    const a = await hosts.submit(applicant, application());

    expect(a.status).toBe('pending');
    expect(a.venueName).toBe('Smash Arena');
    expect(a.courtCount).toBe(3);
    expect(a.sportIds).toEqual([pickleballId]);
    expect(a.venueId).toBeNull();
    expect(bank.saved).toEqual([{ userId: applicant.userId, details: BANK }]);
    expect((await hosts.mine(applicant.userId))?.id).toBe(a.id);
    expect(await hosts.pendingCount()).toBe(1);
    // Nothing is listed until staff say so.
    expect(await prisma.venue.count()).toBe(0);
  });

  it('venue hosts R2: each venue field is checked, and a bad one saves no bank details', async () => {
    const cases: [Partial<HostApplicationInput>, string][] = [
      [{ venueName: ' ' }, HostApplicationCode.INVALID_VENUE_NAME],
      [{ address: 'x' }, HostApplicationCode.INVALID_ADDRESS],
      [{ city: '' }, HostApplicationCode.INVALID_CITY],
      [{ location: { lat: 120, lng: 77 } }, 'INVALID_LOCATION'],
      [{ sportIds: [] }, HostApplicationCode.INVALID_SPORTS],
      [{ sportIds: [newId()] }, HostApplicationCode.INVALID_SPORTS],
      [{ courtCount: 0 }, HostApplicationCode.INVALID_COURT_COUNT],
      [{ courtCount: 51 }, HostApplicationCode.INVALID_COURT_COUNT],
      [{ courtCount: 2.5 }, HostApplicationCode.INVALID_COURT_COUNT],
      [{ contactPhone: '12345' }, HostApplicationCode.INVALID_PHONE],
      [{ contactPhone: 'call me maybe 9876543210' }, HostApplicationCode.INVALID_PHONE],
      [{ description: 'x'.repeat(2_001) }, 'INVALID_DESCRIPTION'],
    ];
    for (const [over, code] of cases) {
      expect(await errorCode(() => hosts.submit(applicant, application(over))), JSON.stringify(over)).toBe(code);
    }
    expect(bank.saved).toEqual([]);
    expect(await hosts.mine(applicant.userId)).toBeNull();
  });

  it('venue hosts R3: bank details are required unless a usable payout account exists', async () => {
    expect(await errorCode(() => hosts.submit(applicant, application({ bank: null })))).toBe(
      HostApplicationCode.BANK_DETAILS_REQUIRED,
    );

    // A rejected account is not somewhere to send money.
    bank.accounts.set(applicant.userId, { id: newId(), status: 'rejected' });
    expect(await errorCode(() => hosts.submit(applicant, application({ bank: null })))).toBe(
      HostApplicationCode.BANK_DETAILS_REQUIRED,
    );

    // Someone who already hosts events has one: it is reused, not asked for again.
    bank.accounts.set(applicant.userId, { id: newId(), status: 'verified' });
    const a = await hosts.submit(applicant, application({ bank: null }));
    expect(a.status).toBe('pending');
    expect(bank.saved).toEqual([]);
  });

  it('venue hosts R3: a bank detail the payout module refuses stops the application', async () => {
    bank.refuse = new UserError('INVALID_IFSC', "That IFSC doesn't look right.");
    expect(await errorCode(() => hosts.submit(applicant, application()))).toBe('INVALID_IFSC');
    expect(await hosts.mine(applicant.userId)).toBeNull();
  });

  it('venue hosts R4: one open application per person, also when two submits race', async () => {
    await hosts.submit(applicant, application());
    expect(await errorCode(() => hosts.submit(applicant, application({ venueName: 'Second Place' })))).toBe(
      HostApplicationCode.HOST_APPLICATION_PENDING,
    );
    // Refused before the bank details were touched a second time.
    expect(bank.saved).toHaveLength(1);

    const other = await makeUser('racer@example.com');
    const results = await Promise.allSettled([
      hosts.submit(other, application({ venueName: 'Race A' })),
      hosts.submit(other, application({ venueName: 'Race B' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.venueHostApplication.count({ where: { userId: other.userId } })).toBe(1);
  });

  it('venue hosts R5, R6: approving lists the venue as the applicant’s own, with the courts they counted', async () => {
    const a = await hosts.submit(applicant, application());
    const { application: approved, venue } = await hosts.approve(staff, a.id);

    expect(approved.status).toBe('approved');
    expect(approved.venueId).toBe(venue.id);
    expect(venue.name).toBe('Smash Arena');
    expect(venue.createdBy).toBe(applicant.userId);
    expect(venue.contactPhone).toBe('+91 98765 43210');
    expect(venue.description).toBe('Four covered courts and parking.');
    const courts = await venues.courtsFor(venue.id);
    expect(courts.map((c) => c.name)).toEqual(['Court 1', 'Court 2', 'Court 3']);
    expect(courts.every((c) => c.sportIds.includes(pickleballId))).toBe(true);
    // The owner edits it from the app; staff's id is only on the review.
    await expect(venues.update(applicant, venue.id, { description: 'Now with a café.' })).resolves.toBeTruthy();
    expect(notified).toEqual([{ userId: applicant.userId, status: 'approved', reason: null, venueId: venue.id }]);
    expect(await hosts.pendingCount()).toBe(0);
  });

  it('venue hosts R6: an application without a map point is approved only once staff give one', async () => {
    const a = await hosts.submit(applicant, application({ location: null }));
    expect(a.location).toBeNull();

    expect(await errorCode(() => hosts.approve(staff, a.id))).toBe(HostApplicationCode.VENUE_LOCATION_REQUIRED);
    expect(await errorCode(() => hosts.approve(staff, a.id, { location: { lat: 95, lng: 77 } }))).toBe('INVALID_LOCATION');
    // Refused, not decided: it is still waiting.
    expect((await hosts.mine(applicant.userId))?.status).toBe('pending');

    const point = { lat: 12.9352, lng: 77.6245 };
    const { application: approved, venue } = await hosts.approve(staff, a.id, { location: point });
    expect(venue.location.lat).toBeCloseTo(point.lat, 5);
    expect(approved.location?.lng).toBeCloseTo(point.lng, 5);
  });

  it('venue hosts R6: staff’s map point replaces the applicant’s', async () => {
    const a = await hosts.submit(applicant, application());
    const { venue } = await hosts.approve(staff, a.id, { location: { lat: 12.2958, lng: 76.6394 } });
    expect(venue.location.lat).toBeCloseTo(12.2958, 5);
  });

  it('venue hosts R5: a decision is made once, whoever races for it', async () => {
    const a = await hosts.submit(applicant, application());
    const second = await makeUser('staff2@example.com');
    const results = await Promise.allSettled([hosts.approve(staff, a.id), hosts.approve(second, a.id)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.venue.count()).toBe(1);
    expect(await errorCode(() => hosts.reject(staff, a.id, 'Changed our mind'))).toBe(
      HostApplicationCode.HOST_APPLICATION_DECIDED,
    );
    expect(await errorCode(() => hosts.approve(staff, newId()))).toBe(HostApplicationCode.HOST_APPLICATION_NOT_FOUND);
  });

  it('venue hosts R5: a rejection carries the reason to the applicant, who may apply again', async () => {
    const a = await hosts.submit(applicant, application());
    const rejected = await hosts.reject(staff, a.id, '  We could not find this address.  ');

    expect(rejected.status).toBe('rejected');
    expect(rejected.statusReason).toBe('We could not find this address.');
    expect(await prisma.venue.count()).toBe(0);
    expect(notified).toEqual([
      { userId: applicant.userId, status: 'rejected', reason: 'We could not find this address.', venueId: null },
    ]);

    const again = await hosts.submit(applicant, application({ address: '14, 100 Feet Road, Indiranagar', bank: null }));
    expect(again.status).toBe('pending');
    expect((await hosts.mine(applicant.userId))?.id).toBe(again.id);
  });

  it('venue hosts R5: an approval that cannot make the venue leaves the application pending', async () => {
    const a = await hosts.submit(applicant, application());
    const broken = createHostApplicationService({
      db: prisma as unknown as Db,
      venues: {
        create: async () => {
          throw new Error('database went away');
        },
        update: venues.update,
      },
      bank: { accountFor: async () => null, save: async () => undefined },
      media,
      sportExists: async () => true,
      notify: async () => undefined,
    });

    await expect(broken.approve(staff, a.id)).rejects.toThrow('database went away');
    const row = await hosts.mine(applicant.userId);
    expect(row?.status).toBe('pending');
    expect(row?.reviewedAt).toBeNull();
    // And it can still be approved for real.
    expect((await hosts.approve(staff, a.id)).application.status).toBe('approved');
  });

  it('venue hosts R7: the partner profile is stored as it was checked, and an application without one still reads', async () => {
    const a = await hosts.submit(applicant, application({ details: profile() }));

    expect(a.details).toMatchObject({
      contactName: 'Rahul Sharma',
      email: 'rahul@smasharena.in',
      venuesManaged: 2,
      pincode: '560038',
      setting: 'indoor',
      // A pasted handle is made a link; a duplicate amenity is said once.
      websiteUrl: 'https://instagram.com/smasharena',
      amenities: ['Parking', 'Washrooms'],
      prices: [{ sportId: pickleballId, pricePerHourPaise: 60_000, peakPricePerHourPaise: 80_000 }],
      partnership: 'bookings',
      acceptedTerms: true,
    });
    expect(a.details?.openingHours).toHaveLength(6);
    // Read back from the row, not from what was handed in.
    expect((await hosts.mine(applicant.userId))?.details?.contactName).toBe('Rahul Sharma');

    const other = await makeUser('first-form@example.com');
    expect((await hosts.submit(other, application())).details).toBeNull();
  });

  it('venue hosts R7: each part of the profile is checked, and all three consents are needed', async () => {
    const cases: [Partial<HostDetailsInput>, string][] = [
      [{ contactName: ' ' }, HostDetailsCode.INVALID_CONTACT],
      [{ contactRole: '' }, HostDetailsCode.INVALID_CONTACT],
      [{ whatsappNumber: '12345' }, HostDetailsCode.INVALID_CONTACT],
      [{ email: 'not-an-email' }, HostDetailsCode.INVALID_CONTACT],
      [{ venuesManaged: 0 }, HostDetailsCode.INVALID_CONTACT],
      [{ pincode: '5600' }, HostDetailsCode.INVALID_PINCODE],
      [{ mapsUrl: 'not a link' }, HostDetailsCode.INVALID_LINK],
      [{ setting: 'underwater' as never }, HostDetailsCode.INVALID_HOST_DETAILS],
      [{ playingCapacity: 0 }, HostDetailsCode.INVALID_HOST_DETAILS],
      [{ openingHours: [] }, 'INVALID_OPENING_HOURS'],
      [{ openingHours: [{ day: 0, opens: '22:00', closes: '06:00' }] }, 'INVALID_OPENING_HOURS'],
      [{ openingHours: [{ day: 7, opens: '06:00', closes: '22:00' }] }, 'INVALID_OPENING_HOURS'],
      [{ prices: [{ sportId: newId(), pricePerHourPaise: 50_000, peakPricePerHourPaise: null }] }, HostDetailsCode.INVALID_PRICES],
      [{ prices: [{ sportId: 'PICKLEBALL', pricePerHourPaise: -1, peakPricePerHourPaise: null }] }, HostDetailsCode.INVALID_PRICES],
      [{ minBookingMinutes: 50 }, HostDetailsCode.INVALID_HOST_DETAILS],
      [{ cancellationPolicy: 'x'.repeat(501) }, HostDetailsCode.INVALID_HOST_DETAILS],
      [{ partnership: 'franchise' as never }, HostDetailsCode.INVALID_HOST_DETAILS],
      [{ authorised: false }, HostDetailsCode.CONSENT_REQUIRED],
      [{ consentDisplay: false }, HostDetailsCode.CONSENT_REQUIRED],
      [{ acceptedTerms: false }, HostDetailsCode.CONSENT_REQUIRED],
    ];
    for (const [over, code] of cases) {
      const details = profile(over);
      // The placeholder stands for "the sport the application names".
      details.prices = details.prices.map((p) => (p.sportId === 'PICKLEBALL' ? { ...p, sportId: pickleballId } : p));
      expect(await errorCode(() => hosts.submit(applicant, application({ details }))), JSON.stringify(over)).toBe(code);
    }
    expect(bank.saved).toEqual([]);
    expect(await hosts.mine(applicant.userId)).toBeNull();
  });

  it('venue hosts R8: photos are signed into the applicant’s own folder, and only those are accepted', async () => {
    const upload = hosts.photoUploadSignature(applicant);
    expect(upload.folder).toBe(`pl4y/venue-hosts/${applicant.userId}`);
    const mine = `${upload.folder}/${upload.publicId}`;

    expect(await errorCode(() => hosts.submit(applicant, application({ photoPublicIds: [`pl4y/venue-hosts/${staff.userId}/x`] })))).toBe(
      HostDetailsCode.INVALID_PHOTOS,
    );
    expect(await errorCode(() => hosts.submit(applicant, application({ photoPublicIds: [`${upload.folder}/`] })))).toBe(
      HostDetailsCode.INVALID_PHOTOS,
    );
    const eleven = Array.from({ length: 11 }, (_, i) => `${upload.folder}/p${i}`);
    expect(await errorCode(() => hosts.submit(applicant, application({ photoPublicIds: eleven })))).toBe(HostDetailsCode.INVALID_PHOTOS);

    const a = await hosts.submit(applicant, application({ photoPublicIds: [mine, mine] }));
    expect(a.photoPublicIds).toEqual([mine]);
  });

  it('venue hosts R6: approving carries the profile onto the venue — amenities, hours, photos, indoor courts', async () => {
    const photo = `pl4y/venue-hosts/${applicant.userId}/front`;
    const a = await hosts.submit(applicant, application({ details: profile(), photoPublicIds: [photo] }));
    const { venue } = await hosts.approve(staff, a.id);

    expect(venue.amenities).toEqual(['Parking', 'Washrooms']);
    expect(venue.photoPublicIds).toEqual([photo]);
    expect(venue.openingHours).toHaveLength(6);
    expect(venue.openingHours.some((h) => h.day === 6)).toBe(false);
    expect((await venues.courtsFor(venue.id)).every((c) => c.indoor)).toBe(true);
  });

  it('venue hosts: the portal lists waiting applications oldest first', async () => {
    const first = await hosts.submit(applicant, application());
    const other = await makeUser('later@example.com');
    const second = await hosts.submit(other, application({ venueName: 'Later Courts' }));
    await prisma.venueHostApplication.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 60_000) } });

    expect((await hosts.list('pending')).map((a) => a.id)).toEqual([first.id, second.id]);
    await hosts.reject(staff, first.id, 'Duplicate of an existing venue');
    expect((await hosts.list('pending')).map((a) => a.id)).toEqual([second.id]);
    expect((await hosts.list('rejected')).map((a) => a.id)).toEqual([first.id]);
    expect(await hosts.list(null)).toHaveLength(2);
  });
});
