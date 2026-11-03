/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { createPricingService } from './service/index.js';

export const pricing = createPricingService({
  db,
  async roleAt(actor, venueId) {
    const { bookings } = await import('../bookings/index.js');
    return bookings.roleAt(actor, venueId);
  },
  async notifyMany(userIds, template, payload, venueId) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(userIds, template, payload as never, venueId ? { kind: 'venue', id: venueId } : { kind: 'route', route: 'my_bookings' });
  },
});

export { MAX_ACTIVE_VENUE_OFFERS, PricingCode, localParts, validateOffer } from './service/index.js';
export {
  MIN_CHARGE_PAISE,
  commissionBpsFor,
  ineligibility,
  offerDiscount,
  offerSummary,
  priceWithOffers,
  roundBps,
  settlementFor,
} from './service/engine.js';
export type { BookingFacts, FundedBy, OfferKind, OfferRule, Priced, StackingSettings, VenueTerms } from './service/engine.js';
export type { Actor, IntroStatus, Offer, OfferInput, OfferStats, PricingService, PricingSettings, PricingSettingsPatch } from './service/index.js';
