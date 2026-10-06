/**
 * bookings — GraphQL (docs/modules/19-bookings.md).
 *
 * Players: courtAvailability, holdCourtBooking, cancelCourtBooking,
 * myCourtBookings. The desk (venue staff, R7): venueSchedule, walk-ins,
 * check-in, no-shows. Managers: the booking set-up and the dashboard.
 *
 * The slot grid answers available or not, never why (app R2): a reason would
 * leak another player's booking or the venue's operations.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { db } from '../../../platform/db.js';
import { forbidden } from '../../../platform/errors/index.js';
import { CourtRef, VenueRef } from '../../venues/schema/index.js';
import { venues } from '../../venues/index.js';
import { bookings } from '../index.js';
import type { Booking, Policy, Rule, Slot, VenueRole } from '../index.js';
import { localDate } from '../service/slots.js';

const paise = (v: bigint): number => Number(v);

async function actorOf(ctx: Ctx) {
  const actor = requireActor(ctx);
  const platformStaff = actor.client === 'portal' && (await ctx.loaders.platformRole.load(actor.userId)) !== null;
  return { userId: actor.userId, platformStaff };
}

// --- enums ------------------------------------------------------------------------------

const BookingStatusEnum = builder.enumType('CourtBookingStatus', {
  values: {
    HELD: { value: 'held' },
    CONFIRMED: { value: 'confirmed' },
    CHECKED_IN: { value: 'checked_in' },
    COMPLETED: { value: 'completed' },
    CANCELLED: { value: 'cancelled' },
    EXPIRED: { value: 'expired' },
    NO_SHOW: { value: 'no_show' },
    PAYMENT_FAILED: { value: 'payment_failed' },
  } as const,
});

const VenueRoleEnum = builder.enumType('VenueRole', {
  values: { OWNER: { value: 'owner' as VenueRole }, MANAGER: { value: 'manager' as VenueRole }, DESK: { value: 'desk' as VenueRole } },
});

const BlackoutKindEnum = builder.enumType('CourtBlackoutKind', {
  values: { MAINTENANCE: { value: 'maintenance' }, EVENT: { value: 'event' }, PRIVATE: { value: 'private' }, HOLIDAY: { value: 'holiday' } } as const,
});

const WalkInPaymentEnum = builder.enumType('WalkInPayment', {
  values: { OFFLINE: { value: 'offline' }, COMP: { value: 'comp' } } as const,
});

// --- types --------------------------------------------------------------------------------

const CourtSlotRef = builder.objectRef<Slot>('CourtSlot').implement({
  description: 'bookings R4 — derived on the server. Available or not; never why (app R2).',
  fields: (t) => ({
    court: t.field({ type: CourtRef, resolve: async (s) => (await venues.findCourtById(s.courtId))! }),
    courtId: t.exposeID('courtId'),
    startsAt: t.field({ type: 'DateTime', resolve: (s) => s.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (s) => s.endsAt }),
    pricePaise: t.int({ description: 'R5 — the court price for this slot.', resolve: (s) => paise(s.pricePaise) }),
    available: t.exposeBoolean('available'),
  }),
});

const CourtBookingRef = builder.objectRef<Booking & { bookedBy?: string }>('CourtBooking').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    venue: t.field({ type: VenueRef, resolve: (b) => venues.byId(b.venueId) }),
    court: t.field({ type: CourtRef, resolve: async (b) => (await venues.findCourtById(b.courtId))! }),
    startsAt: t.field({ type: 'DateTime', resolve: (b) => b.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (b) => b.endsAt }),
    status: t.field({ type: BookingStatusEnum, resolve: (b) => b.status as never }),
    paymentMode: t.exposeString('paymentMode', { description: 'online | offline | comp' }),
    courtPaise: t.int({ resolve: (b) => paise(b.courtPaise) }),
    platformFeePaise: t.int({ resolve: (b) => paise(b.platformFeePaise) }),
    taxPaise: t.int({ resolve: (b) => paise(b.taxPaise) }),
    amountPaise: t.int({ description: 'R5 — the frozen total.', resolve: (b) => paise(b.amountPaise) }),
    holdExpiresAt: t.field({ type: 'DateTime', nullable: true, resolve: (b) => b.holdExpiresAt }),
    cancelledAt: t.field({ type: 'DateTime', nullable: true, resolve: (b) => b.cancelledAt }),
    checkedInAt: t.field({ type: 'DateTime', nullable: true, resolve: (b) => b.checkedInAt }),
    walkIn: t.boolean({ resolve: (b) => b.userId === null }),
    bookedBy: t.string({ nullable: true, description: 'Desk only: who the court is booked under.', resolve: (b) => b.bookedBy ?? null }),
    walkInPhone: t.string({ nullable: true, resolve: (b) => (b.bookedBy !== undefined ? b.walkInPhone : null) }),
    qrPayload: t.string({
      description: 'app R11 — what the desk scans: the booking id, prefixed.',
      resolve: (b) => `pl4y-booking:${b.id}`,
    }),
  }),
});

const PolicyRef = builder.objectRef<Policy>('VenueBookingPolicy').implement({
  fields: (t) => ({
    bookable: t.exposeBoolean('bookable'),
    advanceDays: t.exposeInt('advanceDays'),
    minSlotMinutes: t.exposeInt('minSlotMinutes'),
    fullRefundHours: t.exposeInt('fullRefundHours'),
    partialRefundHours: t.exposeInt('partialRefundHours'),
    partialRefundBps: t.exposeInt('partialRefundBps'),
    platformFeePaise: t.int({ resolve: (p) => paise(p.platformFeePaise) }),
    taxBps: t.exposeInt('taxBps'),
  }),
});

const RuleRef = builder.objectRef<Rule>('CourtAvailabilityRule').implement({
  fields: (t) => ({
    courtId: t.exposeID('courtId'),
    weekday: t.exposeInt('weekday', { description: '0 = Monday … 6 = Sunday.' }),
    opensMinute: t.int({ description: 'Minutes after local midnight.', resolve: (r) => r.opensMin }),
    closesMinute: t.int({ resolve: (r) => r.closesMin }),
    pricePerHourPaise: t.int({ resolve: (r) => paise(r.pricePerHourPaise) }),
  }),
});

interface BlackoutRow {
  id: string;
  courtId: string | null;
  kind: string;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
}

const BlackoutRef = builder.objectRef<BlackoutRow>('CourtBlackout').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    courtId: t.id({ nullable: true, description: 'Null: the whole venue.', resolve: (b) => b.courtId }),
    kind: t.exposeString('kind'),
    startsAt: t.field({ type: 'DateTime', resolve: (b) => b.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (b) => b.endsAt }),
    note: t.string({ nullable: true, resolve: (b) => b.note }),
  }),
});

const VenueStaffRef = builder
  .objectRef<{ userId: string; role: VenueRole; name: string; createdAt: Date }>('VenueStaffMember')
  .implement({
    fields: (t) => ({
      userId: t.exposeID('userId'),
      name: t.exposeString('name'),
      role: t.field({ type: VenueRoleEnum, resolve: (s) => s.role }),
      since: t.field({ type: 'DateTime', resolve: (s) => s.createdAt }),
    }),
  });

type Schedule = Awaited<ReturnType<typeof bookings.schedule>>;

const ScheduleRef = builder.objectRef<Schedule>('VenueSchedule').implement({
  description: 'bookings R7 — the desk’s day.',
  fields: (t) => ({
    date: t.exposeString('date'),
    courts: t.field({ type: [CourtRef], resolve: async (s) => Promise.all(s.courts.map(async (c) => (await venues.findCourtById(c.id))!)) }),
    bookings: t.field({ type: [CourtBookingRef], resolve: (s) => s.bookings }),
    blackouts: t.field({ type: [BlackoutRef], resolve: (s) => s.blackouts }),
    rules: t.field({ type: [RuleRef], resolve: (s) => s.rules }),
  }),
});

type Dashboard = Awaited<ReturnType<typeof bookings.dashboard>>;

const DashboardRef = builder.objectRef<Dashboard>('VenueDashboard').implement({
  description: 'bookings R7, R8 — occupancy and money. Offline money never enters the ledger and is shown apart.',
  fields: (t) => ({
    from: t.exposeString('from'),
    to: t.exposeString('to'),
    bookings: t.exposeInt('bookings'),
    cancelled: t.exposeInt('cancelled'),
    noShows: t.exposeInt('noShows'),
    bookedHours: t.exposeFloat('bookedHours'),
    openHours: t.exposeFloat('openHours'),
    occupancy: t.exposeFloat('occupancy', { description: '0 to 1.' }),
    onlinePaise: t.int({ resolve: (d) => paise(d.onlinePaise) }),
    offlinePaise: t.int({ resolve: (d) => paise(d.offlinePaise) }),
  }),
});

interface Setup {
  venueId: string;
  role: VenueRole;
  policy: Policy;
  rules: Rule[];
  blackouts: BlackoutRow[];
}

const SetupRef = builder.objectRef<Setup>('VenueBookingSetup').implement({
  fields: (t) => ({
    venue: t.field({ type: VenueRef, resolve: (s) => venues.byId(s.venueId) }),
    myRole: t.field({ type: VenueRoleEnum, resolve: (s) => s.role }),
    policy: t.field({ type: PolicyRef, resolve: (s) => s.policy }),
    rules: t.field({ type: [RuleRef], resolve: (s) => s.rules }),
    upcomingBlackouts: t.field({ type: [BlackoutRef], resolve: (s) => s.blackouts }),
  }),
});

const ManagedVenueRef = builder.objectRef<{ venueId: string; role: VenueRole }>('ManagedVenue').implement({
  fields: (t) => ({
    venue: t.field({ type: VenueRef, resolve: (m) => venues.byId(m.venueId) }),
    role: t.field({ type: VenueRoleEnum, resolve: (m) => m.role }),
  }),
});

// --- Venue.bookable ---------------------------------------------------------------------------

builder.objectField(VenueRef, 'bookable', (t) =>
  t.boolean({
    description: 'bookings — Gap G15. True when the venue takes court bookings; the app shows "Book a court" only then.',
    resolve: async (v) => (await bookings.policyFor(v.id)).bookable,
  }),
);

// --- payloads --------------------------------------------------------------------------------------

const BookingPayload = builder
  .objectRef<{ booking: Booking | null; userError: UserErrorShape | null }>('CourtBookingPayload')
  .implement({
    fields: (t) => ({
      booking: t.field({ type: CourtBookingRef, nullable: true, resolve: (p) => p.booking }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const CancelPayload = builder
  .objectRef<{ booking: Booking | null; refundPaise: bigint | null; userError: UserErrorShape | null }>('CancelCourtBookingPayload')
  .implement({
    fields: (t) => ({
      booking: t.field({ type: CourtBookingRef, nullable: true, resolve: (p) => p.booking }),
      refundPaise: t.int({ nullable: true, resolve: (p) => (p.refundPaise === null ? null : paise(p.refundPaise)) }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const CancelPreviewRef = builder
  .objectRef<{ refundPaise: bigint; shareBps: number }>('CourtBookingCancelPreview')
  .implement({
    description: 'app R10 — what cancelling now gives back, computed on the server, before the player confirms.',
    fields: (t) => ({
      refundPaise: t.int({ resolve: (p) => paise(p.refundPaise) }),
      shareBps: t.exposeInt('shareBps'),
    }),
  });

const SetupPayload = builder
  .objectRef<{ setup: Setup | null; userError: UserErrorShape | null }>('VenueBookingSetupPayload')
  .implement({
    fields: (t) => ({
      setup: t.field({ type: SetupRef, nullable: true, resolve: (p) => p.setup }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const StaffPayload = builder
  .objectRef<{ staff: { userId: string; role: VenueRole; name: string; createdAt: Date }[] | null; userError: UserErrorShape | null }>(
    'VenueStaffPayload',
  )
  .implement({
    fields: (t) => ({
      staff: t.field({ type: [VenueStaffRef], nullable: true, resolve: (p) => p.staff }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs -----------------------------------------------------------------------------------------

const HoldInput = builder.inputType('HoldCourtBookingInput', {
  fields: (t) => ({
    courtId: t.id({ required: true }),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', required: true }),
  }),
});

const RuleInput = builder.inputType('CourtRuleInput', {
  fields: (t) => ({
    weekday: t.int({ required: true }),
    opensMinute: t.int({ required: true }),
    closesMinute: t.int({ required: true }),
    pricePerHourPaise: t.int({ required: true }),
  }),
});

const PolicyInput = builder.inputType('VenueBookingPolicyInput', {
  fields: (t) => ({
    bookable: t.boolean(),
    advanceDays: t.int(),
    minSlotMinutes: t.int(),
    fullRefundHours: t.int(),
    partialRefundHours: t.int(),
    partialRefundBps: t.int(),
    platformFeePaise: t.int(),
    taxBps: t.int(),
  }),
});

const WalkInInput = builder.inputType('WalkInBookingInput', {
  fields: (t) => ({
    courtId: t.id({ required: true }),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', required: true }),
    name: t.string({ required: true }),
    phone: t.string(),
    payment: t.field({ type: WalkInPaymentEnum, required: true }),
  }),
});

const BlackoutInput = builder.inputType('CourtBlackoutInput', {
  fields: (t) => ({
    venueId: t.id({ required: true }),
    courtId: t.id(),
    kind: t.field({ type: BlackoutKindEnum, required: true }),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', required: true }),
    note: t.string(),
  }),
});

async function setupFor(actor: { userId: string; platformStaff: boolean }, venueId: string): Promise<Setup> {
  const role = await bookings.roleAt(actor, venueId);
  if (!role || role === 'desk') throw forbidden();
  const [policy, rules, blackouts] = await Promise.all([
    bookings.policyFor(venueId),
    bookings.rulesForVenue(venueId),
    db.courtBlackout.findMany({ where: { venueId, endsAt: { gt: new Date() } }, orderBy: { startsAt: 'asc' }, take: 100 }),
  ]);
  return { venueId, role, policy, rules, blackouts };
}

// --- queries -------------------------------------------------------------------------------------------

builder.queryFields((t) => ({
  courtAvailability: t.field({
    type: [CourtSlotRef],
    description: 'bookings R4 — the slot grid for one local date (YYYY-MM-DD).',
    args: {
      venueId: t.arg.id({ required: true }),
      date: t.arg.string({ required: true }),
      durationMinutes: t.arg.int(),
      sportId: t.arg.id(),
    },
    resolve: (_root, args) =>
      bookings.availability(String(args.venueId), args.date, {
        durationMinutes: args.durationMinutes ?? undefined,
        sportId: args.sportId ? String(args.sportId) : null,
      }),
  }),

  nextAvailableBookingDate: t.field({
    type: 'String',
    nullable: true,
    description: 'app States — "no availability that day" offers the next date that has some.',
    args: { venueId: t.arg.id({ required: true }), from: t.arg.string(), durationMinutes: t.arg.int() },
    resolve: (_root, args) =>
      bookings.nextAvailableDate(String(args.venueId), args.from ?? localDate(new Date()), args.durationMinutes ?? undefined),
  }),

  myCourtBookings: t.field({
    type: [CourtBookingRef],
    args: { first: t.arg.int(), offset: t.arg.int() },
    resolve: (_root, args, ctx) =>
      bookings.listForUser(requireActor(ctx).userId, { first: clampFirst(args.first, 20), offset: Math.max(args.offset ?? 0, 0) }),
  }),

  courtBooking: t.field({
    type: CourtBookingRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const row = await bookings.byId(String(args.id));
      if (!row) return null;
      if (row.userId === actor.userId) return row;
      // The desk reads any booking at its venue (scanning a QR).
      return (await bookings.roleAt(actor, row.venueId)) ? { ...row, bookedBy: row.walkInName ?? 'Player' } : null;
    },
  }),

  courtBookingCancelPreview: t.field({
    type: CancelPreviewRef,
    args: { bookingId: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => bookings.cancelPreview(requireActor(ctx), String(args.bookingId)),
  }),

  myManagedVenues: t.field({
    type: [ManagedVenueRef],
    description: 'bookings R7 — venues this person runs: the desk entry in the Hosting tab.',
    resolve: (_root, _args, ctx) => bookings.myVenues(requireActor(ctx).userId),
  }),

  venueSchedule: t.field({
    type: ScheduleRef,
    args: { venueId: t.arg.id({ required: true }), date: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => bookings.schedule(await actorOf(ctx), String(args.venueId), args.date),
  }),

  venueDashboard: t.field({
    type: DashboardRef,
    args: { venueId: t.arg.id({ required: true }), from: t.arg.string({ required: true }), to: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => bookings.dashboard(await actorOf(ctx), String(args.venueId), args.from, args.to),
  }),

  venueBookingSetup: t.field({
    type: SetupRef,
    description: 'bookings R7 — the policy, opening rules and blackouts. Managers and owners.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => setupFor(await actorOf(ctx), String(args.venueId)),
  }),

  venueStaff: t.field({
    type: [VenueStaffRef],
    args: { venueId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => bookings.staffOf(await actorOf(ctx), String(args.venueId)),
  }),
}));

// --- mutations ----------------------------------------------------------------------------------------

builder.mutationFields((t) => ({
  holdCourtBooking: t.field({
    type: BookingPayload,
    description: 'bookings R1, R2 — holds the court for 10 minutes. Then createBookingPaymentOrder. A free court is booked at once.',
    args: { input: t.arg({ type: HoldInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        bookings.hold(actor, { courtId: String(args.input.courtId), startsAt: args.input.startsAt, endsAt: args.input.endsAt }),
      );
      return { booking: data, userError };
    },
  }),

  cancelCourtBooking: t.field({
    type: CancelPayload,
    description: 'bookings R6 — the player cancels; the refund follows the venue’s policy.',
    args: { bookingId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => bookings.cancel(actor, String(args.bookingId)));
      return { booking: data?.booking ?? null, refundPaise: data?.refundPaise ?? null, userError };
    },
  }),

  venueCancelCourtBooking: t.field({
    type: BookingPayload,
    description: 'bookings R6 — the venue cancels; everything is refunded, the platform fee too. Managers.',
    args: { bookingId: t.arg.id({ required: true }), reason: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const { data, userError } = await attempt(() => bookings.venueCancel(actor, String(args.bookingId), args.reason));
      return { booking: data, userError };
    },
  }),

  createWalkInBooking: t.field({
    type: BookingPayload,
    description: 'bookings R8 — the desk books a court for someone in person or on the phone. Same constraint, no bypass.',
    args: { input: t.arg({ type: WalkInInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        bookings.walkIn(actor, {
          courtId: String(i.courtId),
          startsAt: i.startsAt,
          endsAt: i.endsAt,
          name: i.name,
          phone: i.phone,
          paymentMode: i.payment === 'comp' ? 'comp' : 'offline',
        }),
      );
      return { booking: data, userError };
    },
  }),

  checkInCourtBooking: t.field({
    type: BookingPayload,
    args: { bookingId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const { data, userError } = await attempt(() => bookings.checkIn(actor, String(args.bookingId)));
      return { booking: data, userError };
    },
  }),

  markCourtBookingNoShow: t.field({
    type: BookingPayload,
    args: { bookingId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const { data, userError } = await attempt(() => bookings.markNoShow(actor, String(args.bookingId)));
      return { booking: data, userError };
    },
  }),

  setVenueBookingPolicy: t.field({
    type: SetupPayload,
    args: { venueId: t.arg.id({ required: true }), input: t.arg({ type: PolicyInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const venueId = String(args.venueId);
      const i = args.input;
      const { data, userError } = await attempt(async () => {
        await bookings.setPolicy(actor, venueId, {
          bookable: i.bookable ?? undefined,
          advanceDays: i.advanceDays ?? undefined,
          minSlotMinutes: i.minSlotMinutes ?? undefined,
          fullRefundHours: i.fullRefundHours ?? undefined,
          partialRefundHours: i.partialRefundHours ?? undefined,
          partialRefundBps: i.partialRefundBps ?? undefined,
          platformFeePaise: i.platformFeePaise == null ? undefined : BigInt(i.platformFeePaise),
          taxBps: i.taxBps ?? undefined,
        });
        return setupFor(actor, venueId);
      });
      return { setup: data, userError };
    },
  }),

  setCourtAvailability: t.field({
    type: SetupPayload,
    description: 'bookings R4 — replaces a court’s weekly opening rules.',
    args: { courtId: t.arg.id({ required: true }), rules: t.arg({ type: [RuleInput], required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const courtId = String(args.courtId);
      const { data, userError } = await attempt(async () => {
        await bookings.setRules(
          actor,
          courtId,
          args.rules.map((r) => ({
            weekday: r.weekday,
            opensMin: r.opensMinute,
            closesMin: r.closesMinute,
            pricePerHourPaise: BigInt(r.pricePerHourPaise),
          })),
        );
        const court = await venues.findCourtById(courtId);
        return setupFor(actor, court!.venueId!);
      });
      return { setup: data, userError };
    },
  }),

  addCourtBlackout: t.field({
    type: SetupPayload,
    args: { input: t.arg({ type: BlackoutInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const i = args.input;
      const venueId = String(i.venueId);
      const { data, userError } = await attempt(async () => {
        await bookings.addBlackout(actor, {
          venueId,
          courtId: i.courtId ? String(i.courtId) : null,
          kind: i.kind,
          startsAt: i.startsAt,
          endsAt: i.endsAt,
          note: i.note,
        });
        return setupFor(actor, venueId);
      });
      return { setup: data, userError };
    },
  }),

  removeCourtBlackout: t.field({
    type: 'Boolean',
    args: { blackoutId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await bookings.removeBlackout(await actorOf(ctx), String(args.blackoutId));
      return true;
    },
  }),

  setVenueStaff: t.field({
    type: StaffPayload,
    description: 'bookings R7 — owners add desk or manager staff by email, or (role null) remove them.',
    args: { venueId: t.arg.id({ required: true }), email: t.arg.string({ required: true }), role: t.arg({ type: VenueRoleEnum }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const { data, userError } = await attempt(() => bookings.setStaff(actor, String(args.venueId), args.email, args.role ?? null));
      return { staff: data, userError };
    },
  }),
}));

