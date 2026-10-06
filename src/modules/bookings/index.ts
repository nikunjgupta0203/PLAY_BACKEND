/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
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
  },
  payments: {
    async refundForBooking(input) {
      const { payments } = await import('../payments/index.js');
      return payments.refundForBooking(input);
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
  },
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
    await notifications.emit(userId, template, payload as never, { kind: 'route', route: 'court_booking', id: bookingId });
  },
});

export { BookingCode, HOLD_MINUTES, MAX_MINUTES_PER_DAY, MAX_OPEN_HOLDS } from './service/index.js';
export type { Booking, BookingStatus, BookingsService, VenueRole } from './service/index.js';
export type { Policy, Rule, Slot } from './service/slots.js';
