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
import { identity } from '../../identity/index.js';
import { payouts } from '../../payments/index.js';
import { PayoutAccountRef } from '../../payments/schema/payouts.js';
import { sport } from '../../sport/index.js';
import { SportRef } from '../../sport/schema/index.js';
import { venueHosts, venues } from '../index.js';
import type { HostApplication, HostApplicationStatus } from '../index.js';
import { VenueRef } from './index.js';

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
          bank: i.bank
            ? { legalName: i.bank.legalName, pan: i.bank.pan, accountNumber: i.bank.accountNumber, ifsc: i.bank.ifsc }
            : null,
        }),
      );
      return { application: data, userError };
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
