/** The ONLY surface other modules may import (conventions.md §1). */
import { config } from '../../platform/config.js';
import { db } from '../../platform/db.js';
import { email } from '../../platform/email.js';
import { createVenuePayouts } from './service/payouts.js';
import { createVenuePayService } from './service/index.js';

export const venuePay = createVenuePayService({
  db,
  async roleAt(actor, venueId) {
    const { bookings } = await import('../bookings/index.js');
    return bookings.roleAt(actor, venueId);
  },
  async payoutStatusOf(userId) {
    const { payouts } = await import('../payments/index.js');
    return (await payouts.myAccount(userId))?.status ?? null;
  },
  users: {
    async contactsByIds(ids) {
      const { identity } = await import('../identity/index.js');
      return identity.contactsByIds(ids);
    },
  },
  email,
  async notify(userId, template, payload, target) {
    const { notifications } = await import('../notifications/index.js');
    // The player's tap opens their receipt; the venue's opens the desk.
    const to =
      template === 'payment.confirmed'
        ? ({ kind: 'route', route: 'venue_payment', id: target.venuePaymentId } as const)
        : ({ kind: 'route', route: 'venue_desk', id: target.venueId } as const);
    await notifications.emit(userId, template, payload as never, to);
  },
});

/** Monthly venue payouts, paid by hand like community payouts. */
export const venuePayouts = createVenuePayouts({
  db,
  async accountOf(userId) {
    const { payouts } = await import('../payments/index.js');
    const account = await payouts.myAccount(userId);
    return account ? { id: account.id, status: account.status, detailsChangedAt: account.detailsChangedAt } : null;
  },
  rates: { commissionGstBps: config.COMMISSION_GST_BPS, tdsBps: config.HOST_TDS_BPS },
  async notify(userId, payload, venueId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, 'venue.payout_paid', payload as never, { kind: 'route', route: 'venue_desk', id: venueId });
  },
  async alert(subject, text) {
    const { opsAlert } = await import('../payments/index.js');
    await opsAlert(subject, text);
  },
});

export {
  COMMISSION_BPS,
  MINUTES_MAX,
  MINUTES_MIN,
  MINUTES_STEP,
  VenuePayCode,
  commissionOf,
  priceFor,
} from './service/index.js';
export { VenuePayoutCode, venuePayoutQuote } from './service/payouts.js';
export type { Offer, Rate, VenuePayment, VenuePaymentStatus, VenuePayService } from './service/index.js';
export type { VenuePayout, VenuePayouts } from './service/payouts.js';
