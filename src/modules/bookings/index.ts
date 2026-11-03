/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { email } from '../../platform/email.js';
import { defaultJobOptions, queue, QUEUES } from '../../platform/queue.js';
import { createBookingsRepo } from './repo/index.js';
import { createBookingsService } from './service/index.js';

export const bookings = createBookingsService({
  db,
  repo: createBookingsRepo(db),
  venues: {
    async byId(venueId) {
      const { venues } = await import('../venues/index.js');
      const v = await venues.byId(venueId);
      return { id: v.id, name: v.name, createdBy: v.createdBy };
    },
    async courtsFor(venueId) {
      const { venues } = await import('../venues/index.js');
      return venues.courtsFor(venueId);
    },
    async courtById(courtId) {
      const { venues } = await import('../venues/index.js');
      return venues.findCourtById(courtId);
    },
    // 058 — bookings has already checked the manager's role; venues' owner check is satisfied as staff.
    async addCourt(venueId, input) {
      const { venues } = await import('../venues/index.js');
      return venues.addCourt({ userId: 'bookings', platformStaff: true }, venueId, { name: input.name, sportIds: input.sportIds, kind: input.kind as never, indoor: true });
    },
    async updateCourt(courtId, patch) {
      const { venues } = await import('../venues/index.js');
      return venues.updateCourt({ userId: 'bookings', platformStaff: true }, courtId, patch);
    },
  },
  payments: {
    async refundForBooking(input) {
      const { payments } = await import('../payments/index.js');
      return payments.refundForBooking(input);
    },
  },
  pricing: {
    async priceBooking(input) {
      const { pricing } = await import('../pricing/index.js');
      return pricing.priceBooking(input);
    },
    async reserve(input) {
      const { pricing } = await import('../pricing/index.js');
      return pricing.reserve(input as never);
    },
    async redeem(bookingId) {
      const { pricing } = await import('../pricing/index.js');
      return pricing.redeem(bookingId);
    },
    async release(bookingId) {
      const { pricing } = await import('../pricing/index.js');
      return pricing.release(bookingId);
    },
    async releaseDead() {
      const { pricing } = await import('../pricing/index.js');
      return pricing.releaseDead();
    },
    async commissionFor(venueId, kind) {
      const { pricing } = await import('../pricing/index.js');
      return pricing.commissionFor(venueId, kind);
    },
    async ensureTerms(venueId) {
      const { pricing } = await import('../pricing/index.js');
      return pricing.ensureTerms(venueId);
    },
    async rewardsWithPromos() {
      const { pricing } = await import('../pricing/index.js');
      return (await pricing.settings()).rewardsWithPromos;
    },
    async offerTitles(ids) {
      if (ids.length === 0) return new Map();
      const rows = await db.offer.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
      return new Map(rows.map((r) => [r.id, r.title]));
    },
  },
  users: {
    async findByEmail(email) {
      const { identity } = await import('../identity/index.js');
      return identity.findByEmail(email);
    },
    async namesByIds(ids) {
      const { identity } = await import('../identity/index.js');
      return new Map((await identity.usersByIds(ids)).map((u) => [u.id, u.displayName]));
    },
    async contactsByIds(ids) {
      const { identity } = await import('../identity/index.js');
      return identity.contactsByIds(ids);
    },
  },
  email,
  queue: {
    // R2 — the hold's own release job; the minute sweep is the safety net.
    async releaseHold(bookingId, delayMs) {
      await queue(QUEUES.registration).add(
        'release-booking-hold',
        { bookingId },
        { ...defaultJobOptions, delay: delayMs, jobId: `release-booking-hold-${bookingId}` },
      );
    },
  },
  async notify(userId, template, payload, bookingId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, template as never, payload as never, { kind: 'route', route: 'court_booking', id: bookingId });
  },
  async notifyVenue(userId, template, payload, venueId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, template as never, payload as never, { kind: 'route', route: 'venue_desk', id: venueId });
  },
  async venuePayments(venueId, from, to) {
    const rows = await db.venuePayment.findMany({
      where: { venueId, status: { in: ['paid', 'refunded'] }, paidAt: { gte: from, lt: to } },
      orderBy: { paidAt: 'desc' },
      take: 1000,
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      label: r.label,
      minutes: r.minutes,
      amountPaise: r.amountPaise,
      commissionPaise: r.commissionPaise,
      status: r.status,
      paidAt: r.paidAt,
    }));
  },
});

export {
  AT_VENUE_NO_SHOW_LIMIT,
  BookingCode,
  HOLD_MINUTES,
  MAX_MINUTES_PER_DAY,
  MAX_OPEN_HOLDS,
  MAX_UNPAID_AT_VENUE,
  earnedPaise,
  makeBookingCode,
} from './service/index.js';
export type { Booking, BookingStatus, BookingsService, DeskMethod, PaymentStatus, Transaction, VenueRole } from './service/index.js';
export type { PaymentChoice, PaymentOptions, Policy, Rule, Slot } from './service/slots.js';
