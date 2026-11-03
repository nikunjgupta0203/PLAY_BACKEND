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
import { auditedWhenStaff } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { db } from '../../../platform/db.js';
import { forbidden } from '../../../platform/errors/index.js';
import { CourtRef, VenueRef } from '../../venues/schema/index.js';
import { venues } from '../../venues/index.js';
import { bookings, earnedPaise } from '../index.js';
import type { Booking, Policy, Rule, Slot, Transaction, VenueRole } from '../index.js';
import { allowedDurations, localDate } from '../service/slots.js';

const paise = (v: bigint): number => Number(v);

async function actorOf(ctx: Ctx) {
  const actor = requireActor(ctx);
  const platformStaff = actor.client === 'portal' && (await ctx.loaders.platformRole.load(actor.userId)) !== null;
  return { userId: actor.userId, platformStaff };
}

/** On the fields a venue's desk and portal staff share: staff must say why (portal R3). */
const STAFF_REASON = 'PL4Y staff in the portal must give one (5 characters or more); it goes in the audit log. Ignored for anyone else.';

const bookingTarget = (bookingId: string, action: string) => ({ action, targetType: 'court_booking', targetId: bookingId }) as const;

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

const PaymentStatusEnum = builder.enumType('BookingPaymentStatus', {
  description:
    '058 — PENDING: online, not paid yet (held). PAID. DUE: pay at the venue. FAILED: the last attempt failed. ' +
    'VOID: nothing owed (lapsed or cancelled unpaid). WAIVED: free. REFUNDED / PARTIALLY_REFUNDED.',
  values: {
    PENDING: { value: 'pending' },
    PAID: { value: 'paid' },
    DUE: { value: 'due' },
    FAILED: { value: 'failed' },
    VOID: { value: 'void' },
    WAIVED: { value: 'waived' },
    REFUNDED: { value: 'refunded' },
    PARTIALLY_REFUNDED: { value: 'partially_refunded' },
  } as const,
});

const PaymentChoiceEnum = builder.enumType('BookingPaymentChoice', {
  description: '058 — how the player pays for a booking: ONLINE now, or AT_VENUE (at the desk, or in the app later).',
  values: { ONLINE: { value: 'online' }, AT_VENUE: { value: 'at_venue' } } as const,
});

const PaymentOptionsEnum = builder.enumType('VenuePaymentOptions', {
  description: '058 — the venue owner’s choice: online bookings and payments, pay at venue, or both.',
  values: { ONLINE: { value: 'online' }, AT_VENUE: { value: 'at_venue' }, BOTH: { value: 'both' } } as const,
});

const DeskMethodEnum = builder.enumType('DeskPaymentMethod', {
  values: { CASH: { value: 'cash' }, UPI: { value: 'upi' }, CARD: { value: 'card' }, OTHER: { value: 'other' } } as const,
});

const BookingListEnum = builder.enumType('BookingListFilter', {
  values: { UPCOMING: { value: 'upcoming' }, PAST: { value: 'past' }, CANCELLED: { value: 'cancelled' } } as const,
});

const VenueBookingFilterEnum = builder.enumType('VenueBookingFilter', {
  values: { UPCOMING: { value: 'upcoming' }, UNPAID: { value: 'unpaid' }, CANCELLED: { value: 'cancelled' } } as const,
});

/** 058 — the title of an offer on a booking's discount line. */
async function offerTitle(id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await db.offer.findUnique({ where: { id }, select: { title: true } }))?.title ?? null;
}

/** 058 — the player's checkout: PL4Y's reward and the gateway's reference. */
async function paidFacts(bookingId: string) {
  return (await bookings.paymentFacts([bookingId])).get(bookingId) ?? { rewardDiscountPaise: 0n, reference: null, method: null };
}

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
    bookingCode: t.exposeString('bookingCode', { description: '058 — "BK-7K3Q9XA2": what the player quotes at the desk.' }),
    durationMinutes: t.int({ resolve: (b) => Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000) }),
    basePaise: t.int({ description: '058 — the price before any discount.', resolve: (b) => paise(b.basePaise) }),
    venueDiscountPaise: t.int({ description: '058 — the venue’s own offer (the venue pays for it).', resolve: (b) => paise(b.venueDiscountPaise) }),
    venueOfferTitle: t.string({ nullable: true, resolve: (b) => offerTitle(b.venueOfferId) }),
    platformDiscountPaise: t.int({ description: '058 — PL4Y’s offer (PL4Y pays for it).', resolve: (b) => paise(b.platformDiscountPaise) }),
    platformOfferTitle: t.string({ nullable: true, resolve: (b) => offerTitle(b.platformOfferId) }),
    rewardDiscountPaise: t.int({
      description: '058 — PL4Y’s welcome or referral reward taken at checkout (PL4Y pays for it).',
      resolve: async (b) => paise((await paidFacts(b.id)).rewardDiscountPaise),
    }),
    payablePaise: t.int({
      description: '058 — what the player pays or paid: the total less any reward taken at checkout.',
      resolve: async (b) => paise(b.amountPaise - (await paidFacts(b.id)).rewardDiscountPaise),
    }),
    paymentStatus: t.field({ type: PaymentStatusEnum, resolve: (b) => b.paymentStatus as never }),
    paymentMethod: t.string({ nullable: true, resolve: async (b) => b.paymentMethod ?? (await paidFacts(b.id)).method }),
    paymentReference: t.string({ nullable: true, description: 'The gateway’s reference, for support.', resolve: async (b) => (await paidFacts(b.id)).reference }),
    collectedBy: t.string({ nullable: true, description: 'pl4y | venue', resolve: (b) => b.collectedBy }),
    paidAt: t.field({ type: 'DateTime', nullable: true, resolve: (b) => b.paidAt }),
    refundedPaise: t.int({ resolve: (b) => paise(b.refundedPaise) }),
    canPayInApp: t.boolean({
      description: '058 — a pay-at-venue booking that is still due: the player may pay it in the app.',
      resolve: (b) => b.paymentMode === 'at_venue' && ['due', 'failed'].includes(b.paymentStatus) && ['confirmed', 'checked_in'].includes(b.status),
    }),
    commissionPaise: t.int({
      nullable: true,
      description: 'Desk only: PL4Y’s commission on this booking (0 in the venue’s first 30 days).',
      resolve: (b) => (b.bookedBy !== undefined ? paise(b.commissionPaise) : null),
    }),
    venueEarningsPaise: t.int({
      nullable: true,
      description: 'Desk only: what the venue keeps from this booking after commission.',
      resolve: (b) => {
        if (b.bookedBy === undefined) return null;
        const earned = earnedPaise(b);
        return paise(earned > b.commissionPaise ? earned - b.commissionPaise : 0n);
      },
    }),
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
    slotStepMinutes: t.exposeInt('slotStepMinutes', { description: '058 — start times every this many minutes.' }),
    durationOptions: t.intList({ description: '058 — the durations the owner offers. Empty: any multiple of the step.', resolve: (p) => p.durationOptions }),
    durations: t.intList({ description: '058 — what players can actually pick.', resolve: (p) => allowedDurations(p) }),
    paymentOptions: t.field({ type: PaymentOptionsEnum, resolve: (p) => p.paymentOptions }),
  }),
});

type Options = Awaited<ReturnType<typeof bookings.bookingOptions>>;

const BookingOptionsRef = builder.objectRef<Options>('VenueBookingOptions').implement({
  description: '058 — what the booking screen needs before the grid.',
  fields: (t) => ({
    bookable: t.exposeBoolean('bookable'),
    durations: t.intList({ resolve: (o) => o.durations }),
    slotStepMinutes: t.exposeInt('slotStepMinutes'),
    paymentChoices: t.field({ type: [PaymentChoiceEnum], resolve: (o) => o.paymentChoices }),
    advanceDays: t.exposeInt('advanceDays'),
    fullRefundHours: t.exposeInt('fullRefundHours'),
    partialRefundHours: t.exposeInt('partialRefundHours'),
    partialRefundBps: t.exposeInt('partialRefundBps'),
  }),
});

type QuoteShape = Awaited<ReturnType<typeof bookings.quoteForPlayer>>;

const QuoteRef = builder.objectRef<QuoteShape>('CourtBookingQuote').implement({
  description:
    '058 — the price before booking, from the server: the original price, the venue’s discount, PL4Y’s discount, the fee, tax and total. ' +
    'Signed in, the player’s own eligibility applies (first-time offers, limits). A reward at checkout may take more off.',
  fields: (t) => ({
    courtId: t.exposeID('courtId'),
    startsAt: t.field({ type: 'DateTime', resolve: (q) => q.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (q) => q.endsAt }),
    minutes: t.exposeInt('minutes'),
    basePaise: t.int({ resolve: (q) => paise(q.basePaise) }),
    venueDiscountPaise: t.int({ resolve: (q) => paise(q.venueDiscountPaise) }),
    venueOfferTitle: t.string({ nullable: true, resolve: (q) => q.venueOfferTitle }),
    platformDiscountPaise: t.int({ resolve: (q) => paise(q.platformDiscountPaise) }),
    platformOfferTitle: t.string({ nullable: true, resolve: (q) => q.platformOfferTitle }),
    courtPaise: t.int({ resolve: (q) => paise(q.courtPaise) }),
    platformFeePaise: t.int({ resolve: (q) => paise(q.platformFeePaise) }),
    taxPaise: t.int({ resolve: (q) => paise(q.taxPaise) }),
    totalPaise: t.int({ resolve: (q) => paise(q.totalPaise) }),
    paymentChoices: t.field({ type: [PaymentChoiceEnum], resolve: (q) => q.paymentChoices }),
  }),
});

const TransactionRef = builder.objectRef<Transaction>('VenueTransaction').implement({
  description: '058 — one money line at a venue: a booking or a pay-at-venue payment, with each discount and who paid for it.',
  fields: (t) => ({
    kind: t.exposeString('kind', { description: 'booking | venue_payment' }),
    id: t.exposeID('id'),
    reference: t.exposeString('reference'),
    at: t.field({ type: 'DateTime', resolve: (x) => x.at }),
    playerName: t.exposeString('playerName'),
    description: t.exposeString('description'),
    grossPaise: t.int({ resolve: (x) => paise(x.grossPaise) }),
    venueDiscountPaise: t.int({ resolve: (x) => paise(x.venueDiscountPaise) }),
    platformDiscountPaise: t.int({ resolve: (x) => paise(x.platformDiscountPaise) }),
    playerPaise: t.int({ resolve: (x) => paise(x.playerPaise) }),
    commissionPaise: t.int({ resolve: (x) => paise(x.commissionPaise) }),
    venueEarningsPaise: t.int({ resolve: (x) => paise(x.venueEarningsPaise) }),
    refundedPaise: t.int({ resolve: (x) => paise(x.refundedPaise) }),
    paymentStatus: t.exposeString('paymentStatus'),
    paymentMode: t.exposeString('paymentMode'),
    collectedBy: t.string({ nullable: true, resolve: (x) => x.collectedBy }),
    method: t.string({ nullable: true, resolve: (x) => x.method }),
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

const DailyRef = builder.objectRef<Dashboard['daily'][number]>('VenueDailyRevenue').implement({
  fields: (t) => ({
    date: t.exposeString('date'),
    bookings: t.exposeInt('bookings'),
    revenuePaise: t.int({ resolve: (d) => paise(d.revenuePaise) }),
  }),
});
const HourRef = builder.objectRef<Dashboard['byHour'][number]>('VenueHourStat').implement({
  fields: (t) => ({ hour: t.exposeInt('hour'), bookings: t.exposeInt('bookings') }),
});
const TableStatRef = builder.objectRef<Dashboard['byTable'][number]>('VenueTableStat').implement({
  fields: (t) => ({
    courtId: t.exposeID('courtId'),
    name: t.exposeString('name'),
    bookings: t.exposeInt('bookings'),
    hours: t.exposeFloat('hours'),
    revenuePaise: t.int({ resolve: (d) => paise(d.revenuePaise) }),
  }),
});

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
    revenuePaise: t.int({ description: '058 — what the venue earned in the range, before commission.', resolve: (d) => paise(d.revenuePaise) }),
    duePaise: t.int({ description: '058 — pay-at-venue money still to collect.', resolve: (d) => paise(d.duePaise) }),
    venueDiscountPaise: t.int({ resolve: (d) => paise(d.venueDiscountPaise) }),
    platformDiscountPaise: t.int({ description: 'PL4Y’s offers — paid for by PL4Y, not taken from the venue.', resolve: (d) => paise(d.platformDiscountPaise) }),
    commissionPaise: t.int({ resolve: (d) => paise(d.commissionPaise) }),
    refundedPaise: t.int({ resolve: (d) => paise(d.refundedPaise) }),
    customers: t.exposeInt('customers'),
    repeatCustomers: t.exposeInt('repeatCustomers'),
    todayPaise: t.int({ resolve: (d) => paise(d.todayPaise) }),
    weekPaise: t.int({ description: 'This week, Monday to today.', resolve: (d) => paise(d.weekPaise) }),
    monthPaise: t.int({ description: 'This calendar month to today.', resolve: (d) => paise(d.monthPaise) }),
    onlineBookings: t.exposeInt('onlineBookings'),
    atVenueBookings: t.exposeInt('atVenueBookings'),
    walkIns: t.exposeInt('walkIns'),
    daily: t.field({ type: [DailyRef], resolve: (d) => d.daily }),
    byHour: t.field({ type: [HourRef], resolve: (d) => d.byHour }),
    byTable: t.field({ type: [TableStatRef], resolve: (d) => d.byTable }),
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
    tables: t.field({
      type: [CourtRef],
      description: '058 — every table, in service or not.',
      resolve: async (s) => (await venues.courtsFor(s.venueId)).filter((c) => c.venueId === s.venueId),
    }),
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
    payment: t.field({ type: PaymentChoiceEnum, description: '058 — absent: the venue’s first option (online when it takes both).' }),
  }),
});

const TableInput = builder.inputType('VenueTableInput', {
  fields: (t) => ({
    id: t.id({ description: 'Absent: a new table.' }),
    name: t.string(),
    sportIds: t.idList(),
    active: t.boolean({ description: 'false: out of service (bookings on it must be moved first).' }),
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
    slotStepMinutes: t.int(),
    durationOptions: t.intList(),
    paymentOptions: t.field({ type: PaymentOptionsEnum }),
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
    args: { first: t.arg.int(), offset: t.arg.int(), filter: t.arg({ type: BookingListEnum, description: '058 — UPCOMING, PAST or CANCELLED. Absent: all.' }) },
    resolve: (_root, args, ctx) =>
      bookings.listForUser(
        requireActor(ctx).userId,
        { first: clampFirst(args.first, 20), offset: Math.max(args.offset ?? 0, 0) },
        args.filter ?? null,
      ),
  }),

  venueBookingOptions: t.field({
    type: BookingOptionsRef,
    description: '058 — durations, start interval and payment choices for a venue’s booking screen.',
    args: { venueId: t.arg.id({ required: true }) },
    resolve: (_root, args) => bookings.bookingOptions(String(args.venueId)),
  }),

  courtBookingQuote: t.field({
    type: QuoteRef,
    description: '058 — the price breakdown for a slot before booking it, with the venue’s and PL4Y’s offers.',
    args: {
      courtId: t.arg.id({ required: true }),
      startsAt: t.arg({ type: 'DateTime', required: true }),
      endsAt: t.arg({ type: 'DateTime', required: true }),
    },
    resolve: (_root, args, ctx) =>
      bookings.quoteForPlayer(ctx.actor ? { userId: ctx.actor.userId } : null, { courtId: String(args.courtId), startsAt: args.startsAt, endsAt: args.endsAt }),
  }),

  venueBookings: t.field({
    type: [CourtBookingRef],
    description: '058 — the venue’s bookings over a date range, for booking management. Desk and up.',
    args: {
      venueId: t.arg.id({ required: true }),
      from: t.arg.string({ required: true }),
      to: t.arg.string({ required: true }),
      filter: t.arg({ type: VenueBookingFilterEnum }),
      first: t.arg.int(),
    },
    resolve: async (_root, args, ctx) =>
      bookings.venueBookings(await actorOf(ctx), String(args.venueId), { from: args.from, to: args.to, status: args.filter ?? null, first: args.first ?? undefined }),
  }),

  venueTransactions: t.field({
    type: [TransactionRef],
    description: '058 — payment and transaction history at a venue. Managers and owners.',
    args: { venueId: t.arg.id({ required: true }), from: t.arg.string({ required: true }), to: t.arg.string({ required: true }), first: t.arg.int() },
    resolve: async (_root, args, ctx) =>
      bookings.transactions(await actorOf(ctx), String(args.venueId), { from: args.from, to: args.to, first: args.first ?? undefined }),
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
        bookings.hold(actor, {
          courtId: String(args.input.courtId),
          startsAt: args.input.startsAt,
          endsAt: args.input.endsAt,
          payment: args.input.payment ?? null,
        }),
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
      const bookingId = String(args.bookingId);
      const { data, userError } = await attempt(() =>
        auditedWhenStaff(actor, bookingTarget(bookingId, 'court_booking.cancel'), args.reason, () =>
          bookings.venueCancel(actor, bookingId, args.reason),
        ),
      );
      return { booking: data, userError };
    },
  }),

  createWalkInBooking: t.field({
    type: BookingPayload,
    description: 'bookings R8 — the desk books a court for someone in person or on the phone. Same constraint, no bypass.',
    args: { input: t.arg({ type: WalkInInput, required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const i = args.input;
      const courtId = String(i.courtId);
      const { data, userError } = await attempt(async () => {
        // The booking has no id yet, so the trail is kept on its venue.
        const venueId = actor.platformStaff ? ((await venues.findCourtById(courtId))?.venueId ?? '') : '';
        const what = {
          action: 'court_booking.walk_in',
          targetType: 'venue',
          targetId: venueId,
          details: { courtId, startsAt: i.startsAt.toISOString(), endsAt: i.endsAt.toISOString(), payment: i.payment },
        } as const;
        return auditedWhenStaff(actor, what, args.reason, () =>
          bookings.walkIn(actor, {
            courtId,
            startsAt: i.startsAt,
            endsAt: i.endsAt,
            name: i.name,
            phone: i.phone,
            paymentMode: i.payment === 'comp' ? 'comp' : 'offline',
          }),
        );
      });
      return { booking: data, userError };
    },
  }),

  checkInCourtBooking: t.field({
    type: BookingPayload,
    args: { bookingId: t.arg.id({ required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const bookingId = String(args.bookingId);
      const { data, userError } = await attempt(() =>
        auditedWhenStaff(actor, bookingTarget(bookingId, 'court_booking.check_in'), args.reason, () => bookings.checkIn(actor, bookingId)),
      );
      return { booking: data, userError };
    },
  }),

  markCourtBookingNoShow: t.field({
    type: BookingPayload,
    args: { bookingId: t.arg.id({ required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const bookingId = String(args.bookingId);
      const { data, userError } = await attempt(() =>
        auditedWhenStaff(actor, bookingTarget(bookingId, 'court_booking.no_show'), args.reason, () => bookings.markNoShow(actor, bookingId)),
      );
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
          slotStepMinutes: i.slotStepMinutes ?? undefined,
          durationOptions: i.durationOptions ?? undefined,
          paymentOptions: i.paymentOptions ?? undefined,
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
    args: { input: t.arg({ type: BlackoutInput, required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const i = args.input;
      const venueId = String(i.venueId);
      const courtId = i.courtId ? String(i.courtId) : null;
      const what = {
        action: 'venue.blackout_add',
        targetType: 'venue',
        targetId: venueId,
        details: { courtId, kind: i.kind, startsAt: i.startsAt.toISOString(), endsAt: i.endsAt.toISOString() },
      } as const;
      const { data, userError } = await attempt(async () => {
        await auditedWhenStaff(actor, what, args.reason, () =>
          bookings.addBlackout(actor, { venueId, courtId, kind: i.kind, startsAt: i.startsAt, endsAt: i.endsAt, note: i.note }),
        );
        return setupFor(actor, venueId);
      });
      return { setup: data, userError };
    },
  }),

  removeCourtBlackout: t.field({
    type: 'Boolean',
    args: { blackoutId: t.arg.id({ required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const blackoutId = String(args.blackoutId);
      if (!actor.platformStaff) {
        await bookings.removeBlackout(actor, blackoutId);
        return true;
      }
      // Already gone: nothing to do, and nothing to record.
      const row = await db.courtBlackout.findUnique({ where: { id: blackoutId } });
      if (!row) return true;
      const what = {
        action: 'venue.blackout_remove',
        targetType: 'venue',
        targetId: row.venueId,
        details: { blackoutId, courtId: row.courtId, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() },
      } as const;
      await auditedWhenStaff(actor, what, args.reason, () => bookings.removeBlackout(actor, blackoutId));
      return true;
    },
  }),

  markCourtBookingPaid: t.field({
    type: BookingPayload,
    description: '058 — the desk took the money for a pay-at-venue booking. The player gets a receipt.',
    args: { bookingId: t.arg.id({ required: true }), method: t.arg({ type: DeskMethodEnum, required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const bookingId = String(args.bookingId);
      const { data, userError } = await attempt(() =>
        auditedWhenStaff(actor, bookingTarget(bookingId, 'court_booking.mark_paid'), args.reason, () => bookings.markPaidAtDesk(actor, bookingId, args.method)),
      );
      return { booking: data, userError };
    },
  }),

  saveVenueTable: t.field({
    type: SetupPayload,
    description: '058 — add a table, rename it, set its sport, or take it out of service. Managers and owners.',
    args: { venueId: t.arg.id({ required: true }), input: t.arg({ type: TableInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await actorOf(ctx);
      const venueId = String(args.venueId);
      const i = args.input;
      const { data, userError } = await attempt(async () => {
        await bookings.saveTable(actor, venueId, {
          id: i.id ? String(i.id) : null,
          name: i.name ?? null,
          sportIds: i.sportIds ? i.sportIds.map(String) : null,
          active: i.active ?? null,
        });
        return setupFor(actor, venueId);
      });
      return { setup: data, userError };
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

