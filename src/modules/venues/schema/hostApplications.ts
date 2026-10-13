/**
 * venue hosts — GraphQL surface (docs/modules/04-venues.md, "Venue hosts").
 *
 * The app sends one application: the venue and where its money goes. The
 * portal lists them and decides. Registered after payments in src/schema.ts,
 * because an application shows the applicant's payout account beside it.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { GeoPointInput, GeoPointRef } from '../../../graphql/geo.js';
import { audited, requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { identity } from '../../identity/index.js';
import { payouts } from '../../payments/index.js';
import { PayoutAccountRef } from '../../payments/schema/payouts.js';
import { sport } from '../../sport/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { venueHosts, venues } from '../index.js';
import type {
  BookingMethod,
  HostApplication,
  HostApplicationStatus,
  HostDetails,
  HostPrice,
  Partnership,
  VenueSetting,
} from '../index.js';
import { MediaUploadPayload, OpeningHoursInput, OpeningHoursRef, VenueRef } from './index.js';

/** Staff who may read applications: anyone in the portal. Deciding is admin and support (as for venues). */
const isPortalStaff = async (ctx: Ctx): Promise<boolean> =>
  ctx.actor?.client === 'portal' && (await ctx.loaders.platformRole.load(ctx.actor.userId)) !== null;

const StatusEnum = builder.enumType('VenueHostApplicationStatus', {
  values: {
    PENDING: { value: 'pending' as HostApplicationStatus },
    APPROVED: { value: 'approved' as HostApplicationStatus },
    REJECTED: { value: 'rejected' as HostApplicationStatus },
  },
});

const SettingEnum = builder.enumType('VenueSetting', {
  values: {
    INDOOR: { value: 'indoor' as VenueSetting },
    OUTDOOR: { value: 'outdoor' as VenueSetting },
    BOTH: { value: 'both' as VenueSetting },
  },
});

const BookingMethodEnum = builder.enumType('VenueBookingMethod', {
  description: 'venue hosts R7 — how the venue takes bookings today.',
  values: {
    PHONE: { value: 'phone' as BookingMethod },
    WHATSAPP: { value: 'whatsapp' as BookingMethod },
    WALK_IN: { value: 'walk_in' as BookingMethod },
    OWN_APP: { value: 'own_app' as BookingMethod, description: 'Its own website or app.' },
    OTHER_PLATFORM: { value: 'other_platform' as BookingMethod, description: 'Another booking app.' },
  },
});

const PartnershipEnum = builder.enumType('VenuePartnership', {
  description: 'venue hosts R7 — what the venue wants from PL4Y.',
  values: {
    LISTING: { value: 'listing' as Partnership, description: 'Be found on PL4Y; bookings stay as they are.' },
    BOOKINGS: { value: 'bookings' as Partnership, description: 'Take court bookings through PL4Y.' },
    API: { value: 'api' as Partnership, description: 'Connect the venue’s own booking software.' },
  },
});

const HostPriceRef = builder.objectRef<HostPrice>('VenueHostPrice').implement({
  description: 'What the owner said they charge for one sport, per hour. Not a booking price: those are set on the venue.',
  fields: (t) => ({
    sport: t.field({ type: SportRef, resolve: (p) => sport.byId(p.sportId) }),
    pricePerHourPaise: t.exposeInt('pricePerHourPaise'),
    peakPricePerHourPaise: t.int({ nullable: true, resolve: (p) => p.peakPricePerHourPaise }),
  }),
});

const DetailsRef = builder.objectRef<HostDetails>('VenueHostDetails').implement({
  description: 'venue hosts R7 — the partner profile sent with an application.',
  fields: (t) => ({
    contactName: t.exposeString('contactName'),
    contactRole: t.exposeString('contactRole'),
    whatsappNumber: t.string({
      nullable: true,
      description: 'Null when it is the venue’s phone number.',
      resolve: (d) => d.whatsappNumber,
    }),
    email: t.exposeString('email'),
    venuesManaged: t.exposeInt('venuesManaged'),
    mapsUrl: t.string({ nullable: true, resolve: (d) => d.mapsUrl }),
    pincode: t.exposeString('pincode'),
    setting: t.field({ type: SettingEnum, resolve: (d) => d.setting }),
    websiteUrl: t.string({ nullable: true, resolve: (d) => d.websiteUrl }),
    amenities: t.stringList({ resolve: (d) => d.amenities }),
    playingCapacity: t.int({ nullable: true, resolve: (d) => d.playingCapacity }),
    openingHours: t.field({
      type: [OpeningHoursRef],
      description: 'A day with no window is a weekly closing day.',
      resolve: (d) => d.openingHours,
    }),
    equipmentAvailable: t.exposeBoolean('equipmentAvailable'),
    coachingAvailable: t.exposeBoolean('coachingAvailable'),
    prices: t.field({ type: [HostPriceRef], resolve: (d) => d.prices }),
    peakHours: t.string({ nullable: true, resolve: (d) => d.peakHours }),
    minBookingMinutes: t.int({ nullable: true, resolve: (d) => d.minBookingMinutes }),
    bookingMethod: t.field({ type: BookingMethodEnum, nullable: true, resolve: (d) => d.bookingMethod }),
    advancePolicy: t.string({ nullable: true, resolve: (d) => d.advancePolicy }),
    cancellationPolicy: t.string({ nullable: true, resolve: (d) => d.cancellationPolicy }),
    partnership: t.field({ type: PartnershipEnum, resolve: (d) => d.partnership }),
    existingSoftware: t.string({ nullable: true, resolve: (d) => d.existingSoftware }),
    authorised: t.exposeBoolean('authorised'),
    consentDisplay: t.exposeBoolean('consentDisplay'),
    acceptedTerms: t.exposeBoolean('acceptedTerms'),
  }),
});

const HostPhotoRef = builder.objectRef<{ publicId: string; url: string }>('VenueHostPhoto').implement({
  fields: (t) => ({
    publicId: t.exposeString('publicId'),
    url: t.exposeString('url'),
  }),
});

const ApplicantRef = builder.objectRef<{ id: string; displayName: string }>('VenueHostApplicant').implement({
  description: 'portal — who applied. Their contact details are on their user record, masked (15-admin R4).',
  fields: (t) => ({
    id: t.exposeID('id'),
    displayName: t.exposeString('displayName'),
  }),
});

const ApplicationRef = builder.objectRef<HostApplication>('VenueHostApplication').implement({
  description: 'venue hosts R1 — a request to list a venue, waiting for or decided by PL4Y staff.',
  fields: (t) => ({
    id: t.exposeID('id'),
    venueName: t.exposeString('venueName'),
    address: t.exposeString('address'),
    city: t.exposeString('city'),
    location: t.field({
      type: GeoPointRef,
      nullable: true,
      description: 'Null when the applicant gave no map point; staff give one when approving.',
      resolve: (a) => a.location,
    }),
    sports: t.field({
      type: [SportRef],
      resolve: (a) => Promise.all(a.sportIds.map((id) => sport.byId(id))),
    }),
    courtCount: t.exposeInt('courtCount'),
    contactPhone: t.exposeString('contactPhone'),
    description: t.string({ nullable: true, resolve: (a) => a.description }),
    details: t.field({
      type: DetailsRef,
      nullable: true,
      description: 'R7 — null for an application sent by the first version of the form.',
      resolve: (a) => a.details,
    }),
    photos: t.field({
      type: [HostPhotoRef],
      description: 'R8 — the venue photos the applicant uploaded, in order. They become the venue’s on approval.',
      resolve: (a) =>
        a.photoPublicIds
          .map((publicId) => ({ publicId, url: cloudinary.url(publicId, TRANSFORMS.venuePhoto) }))
          .filter((p): p is { publicId: string; url: string } => p.url !== null),
    }),
    status: t.field({ type: StatusEnum, resolve: (a) => a.status }),
    statusReason: t.string({
      nullable: true,
      description: 'When rejected: why, in staff’s words, for the applicant to read.',
      resolve: (a) => a.statusReason,
    }),
    createdAt: t.field({ type: 'DateTime', resolve: (a) => a.createdAt }),
    reviewedAt: t.field({ type: 'DateTime', nullable: true, resolve: (a) => a.reviewedAt }),
    venue: t.field({
      type: VenueRef,
      nullable: true,
      description: 'R6 — the venue an approved application became.',
      resolve: (a) => (a.venueId ? venues.findById(a.venueId) : null),
    }),
    payoutAccount: t.field({
      type: PayoutAccountRef,
      nullable: true,
      description: 'R3 — where the venue’s earnings go, masked. The applicant’s own, and staff’s to review; null to anyone else.',
      resolve: async (a, _args, ctx) =>
        ctx.actor?.userId === a.userId || (await isPortalStaff(ctx)) ? payouts.myAccount(a.userId) : null,
    }),
    applicant: t.field({
      type: ApplicantRef,
      nullable: true,
      description: 'portal — null outside it.',
      resolve: async (a, _args, ctx) =>
        (await isPortalStaff(ctx)) ? ((await identity.usersByIds([a.userId]))[0] ?? null) : null,
    }),
  }),
});

const ApplicationPayload = builder
  .objectRef<{ application: HostApplication | null; userError: UserErrorShape | null }>('VenueHostApplicationPayload')
  .implement({
    fields: (t) => ({
      application: t.field({ type: ApplicationRef, nullable: true, resolve: (p) => p.application }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const HostBankDetailsInput = builder.inputType('HostBankDetailsInput', {
  description: 'payouts R1 — the same four fields savePayoutAccount takes. They are sealed; reads return masks only.',
  fields: (t) => ({
    legalName: t.string({ required: true }),
    pan: t.string({ required: true }),
    accountNumber: t.string({ required: true }),
    ifsc: t.string({ required: true }),
  }),
});

const HostPriceInput = builder.inputType('VenueHostPriceInput', {
  fields: (t) => ({
    sportId: t.id({ required: true, description: 'One of the application’s sportIds.' }),
    pricePerHourPaise: t.int({ required: true }),
    peakPricePerHourPaise: t.int({ description: 'Left out when there is one rate all day.' }),
  }),
});

const HostDetailsInput = builder.inputType('VenueHostDetailsInput', {
  description:
    'venue hosts R7 — the partner profile. All three consents must be true (CONSENT_REQUIRED). ' +
    'Days missing from openingHours are weekly closing days.',
  fields: (t) => ({
    contactName: t.string({ required: true }),
    contactRole: t.string({ required: true, description: '"Owner", "Manager" — free text.' }),
    whatsappNumber: t.string({ description: 'Left out when it is the same as contactPhone.' }),
    email: t.string({ required: true }),
    venuesManaged: t.int({ required: true }),
    mapsUrl: t.string(),
    pincode: t.string({ required: true, description: '6 digits.' }),
    setting: t.field({ type: SettingEnum, required: true }),
    websiteUrl: t.string({ description: 'Website or a social page.' }),
    amenities: t.stringList({ required: true }),
    playingCapacity: t.int({ description: 'Players the venue holds at once.' }),
    openingHours: t.field({ type: [OpeningHoursInput], required: true }),
    equipmentAvailable: t.boolean({ required: true }),
    coachingAvailable: t.boolean({ required: true }),
    prices: t.field({ type: [HostPriceInput], required: true }),
    peakHours: t.string({ description: 'When the peak rate applies, in the owner’s words.' }),
    minBookingMinutes: t.int({ description: 'In steps of 15.' }),
    bookingMethod: t.field({ type: BookingMethodEnum }),
    advancePolicy: t.string(),
    cancellationPolicy: t.string(),
    partnership: t.field({ type: PartnershipEnum, required: true }),
    existingSoftware: t.string(),
    authorised: t.boolean({ required: true }),
    consentDisplay: t.boolean({ required: true }),
    acceptedTerms: t.boolean({ required: true }),
  }),
});

const ApplyToHostVenueInput = builder.inputType('ApplyToHostVenueInput', {
  fields: (t) => ({
    venueName: t.string({ required: true }),
    address: t.string({ required: true }),
    city: t.string({ required: true }),
    location: t.field({
      type: GeoPointInput,
      description: 'Optional — the phone’s position when the applicant is at the venue. Staff set the point otherwise.',
    }),
    sportIds: t.idList({ required: true, description: 'At least one.' }),
    courtCount: t.int({ required: true, description: '1 to 50.' }),
    contactPhone: t.string({ required: true }),
    description: t.string({ description: 'At most 2,000 characters.' }),
    details: t.field({
      type: HostDetailsInput,
      description: 'R7 — the partner profile. Optional only so the first version of the form keeps working.',
    }),
    photoPublicIds: t.stringList({
      description: 'R8 — public_ids from venueHostPhotoUploadSignature uploads, never URLs. Ten at most.',
    }),
    bank: t.field({
      type: HostBankDetailsInput,
      description:
        'Required for someone with no payout account (BANK_DETAILS_REQUIRED). Leave it out when ' +
        'myPayoutAccount already has one: that account is the one reviewed.',
    }),
  }),
});

builder.queryFields((t) => ({
  myVenueHostApplication: t.field({
    type: ApplicationRef,
    nullable: true,
    description: 'venue hosts — your latest application to list a venue, whatever was decided. Null if you never applied.',
    resolve: (_root, _args, ctx) => venueHosts.mine(requireActor(ctx).userId),
  }),

  venueHostApplications: t.field({
    type: [ApplicationRef],
    description:
      'portal — applications to list a venue. PENDING is oldest first (first come, first reviewed); ' +
      'the others, and no status, newest first. At most 200.',
    args: { status: t.arg({ type: StatusEnum }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return venueHosts.list(args.status ?? null);
    },
  }),
}));

builder.mutationFields((t) => ({
  applyToHostVenue: t.field({
    type: ApplicationPayload,
    description:
      'venue hosts R1–R4 — asks PL4Y to list your venue. Saves the bank details as your payout account ' +
      '(the errors of savePayoutAccount apply), then queues the application for review. One open ' +
      'application at a time (HOST_APPLICATION_PENDING).',
    args: { input: t.arg({ type: ApplyToHostVenueInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        venueHosts.submit(actor, {
          venueName: i.venueName,
          address: i.address,
          city: i.city,
          location: i.location ? { lat: i.location.lat, lng: i.location.lng } : null,
          sportIds: i.sportIds.map(String),
          courtCount: i.courtCount,
          contactPhone: i.contactPhone,
          description: i.description ?? null,
          details: i.details
            ? {
                contactName: i.details.contactName,
                contactRole: i.details.contactRole,
                whatsappNumber: i.details.whatsappNumber ?? null,
                email: i.details.email,
                venuesManaged: i.details.venuesManaged,
                mapsUrl: i.details.mapsUrl ?? null,
                pincode: i.details.pincode,
                setting: i.details.setting,
                websiteUrl: i.details.websiteUrl ?? null,
                amenities: i.details.amenities,
                playingCapacity: i.details.playingCapacity ?? null,
                openingHours: i.details.openingHours,
                equipmentAvailable: i.details.equipmentAvailable,
                coachingAvailable: i.details.coachingAvailable,
                prices: i.details.prices.map((p) => ({
                  sportId: String(p.sportId),
                  pricePerHourPaise: p.pricePerHourPaise,
                  peakPricePerHourPaise: p.peakPricePerHourPaise ?? null,
                })),
                peakHours: i.details.peakHours ?? null,
                minBookingMinutes: i.details.minBookingMinutes ?? null,
                bookingMethod: i.details.bookingMethod ?? null,
                advancePolicy: i.details.advancePolicy ?? null,
                cancellationPolicy: i.details.cancellationPolicy ?? null,
                partnership: i.details.partnership,
                existingSoftware: i.details.existingSoftware ?? null,
                authorised: i.details.authorised,
                consentDisplay: i.details.consentDisplay,
                acceptedTerms: i.details.acceptedTerms,
              }
            : null,
          photoPublicIds: i.photoPublicIds ?? null,
          bank: i.bank
            ? { legalName: i.bank.legalName, pan: i.bank.pan, accountNumber: i.bank.accountNumber, ifsc: i.bank.ifsc }
            : null,
        }),
      );
      return { application: data, userError };
    },
  }),

  venueHostPhotoUploadSignature: t.field({
    type: MediaUploadPayload,
    description:
      'venue hosts R8 — a signature for ONE venue photo, uploaded straight to Cloudinary (ADR 0003 §C2). ' +
      'Send `folder/publicId` back in applyToHostVenue(photoPublicIds). Ask once per photo.',
    resolve: async (_root, _args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () => venueHosts.photoUploadSignature(actor));
      return { upload: data, userError };
    },
  }),

  // portal R3 — both take a reason and are audited.
  approveVenueHostApplication: t.field({
    type: ApplicationPayload,
    description:
      'portal — lists the venue: creates it with the applicant as its owner and the courts they counted. ' +
      'Their bank account is reviewed separately (approvePayoutAccount). `location` is the venue’s map point: ' +
      'required when the application has none (VENUE_LOCATION_REQUIRED), and it replaces the applicant’s when given.',
    args: {
      id: t.arg.id({ required: true }),
      reason: t.arg.string({ required: true }),
      location: t.arg({ type: GeoPointInput }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const id = String(args.id);
      const location = args.location ? { lat: args.location.lat, lng: args.location.lng } : null;
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'venue_host.approve', targetType: 'venue_host_application', targetId: id }, args.reason, () =>
          venueHosts.approve(staff, id, { location }),
        ),
      );
      return { application: data?.application ?? null, userError };
    },
  }),

  rejectVenueHostApplication: t.field({
    type: ApplicationPayload,
    description: 'portal — turns the application down. The applicant reads `reason`, and may apply again.',
    args: { id: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const id = String(args.id);
      const { data, userError } = await attempt(() =>
        audited(staff, { action: 'venue_host.reject', targetType: 'venue_host_application', targetId: id }, args.reason, (reason) =>
          venueHosts.reject(staff, id, reason),
        ),
      );
      return { application: data, userError };
    },
  }),
}));
