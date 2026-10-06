/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { config } from '../../platform/config.js';
import { email } from '../../platform/email.js';
import { events, placeOf } from '../events/index.js';
import { profile } from '../profile/index.js';
import { sport } from '../sport/index.js';
import { createRegistrationRepo } from './repo/index.js';
import { createRegistrationService, type PaymentsPort, type UsersPort } from './service/index.js';
import { checkinKeysFrom } from './service/checkinToken.js';

/**
 * payments and identity are reached lazily: payments imports registration back
 * (it calls confirmFromPayment), and identity already imports profile. Resolving
 * on first call keeps both ESM cycles open at module scope.
 */
const payments: PaymentsPort = {
  async refundForRegistration(input) {
    const { payments: svc } = await import('../payments/index.js');
    await svc.refundForRegistration(input);
  },
};

const users: UsersPort = {
  async byIds(ids) {
    const { identity } = await import('../identity/index.js');
    return identity.contactsByIds(ids);
  },
  async findByEmail(address) {
    const { identity } = await import('../identity/index.js');
    return identity.findByEmail(address);
  },
  async createGuest(displayName) {
    const { identity } = await import('../identity/index.js');
    return identity.createGuest(displayName);
  },
};

export const registration = createRegistrationService({
  db,
  repo: createRegistrationRepo(db),
  events: {
    byId: async (eventId) => {
      const event = await events.byId(eventId);
      return {
        id: event.id,
        startsAt: event.startsAt,
        cancellationCutoffAt: event.cancellationCutoffAt,
        status: event.status,
        endsAt: event.endsAt,
        termsChangedAt: event.termsChangedAt,
        refundPolicy: event.refundPolicy,
      };
    },
    locationOf: (eventId) => events.locationOf(eventId),
    forEmail: async (eventId) => {
      const event = await events.byId(eventId);
      return { title: event.title, startsAt: event.startsAt, timezone: event.timezone, place: await placeOf(event) };
    },
    categoryById: (categoryId) => events.categoryById(categoryId),
    priceQuote: (categoryId) => events.priceQuote(categoryId),
    assertRegistrationOpen: (categoryId) => events.assertRegistrationOpen(categoryId),
    refreshCategoryFullness: (categoryId) => events.refreshCategoryFullness(categoryId),
    assertStaff: (actor, eventId, roles) => events.assertStaff(actor, eventId, roles),
  },
  profile: {
    assertHasSport: (playerId) => profile.assertHasSport(playerId),
    findByUserId: async (userId) => {
      const found = await profile.findByUserId(userId);
      return found
        ? {
            id: found.id,
            sports: found.sports.map((s) => ({ sportId: s.sportId, skillBand: s.skillBand })),
          }
        : null;
    },
    userIdForPlayer: async (playerId) => {
      // I1 — a private profile must not be distinguishable from a missing one
      // (profile R4); this is the invite path's version of that rule.
      const p = await profile.findById(playerId);
      return p && p.visibility !== 'private' ? p.userId : null;
    },
  },
  sport: {
    skillBandsFor: (sportId) => sport.skillBandsFor(sportId),
  },
  users,
  payments,
  email,
  // registration R3 — TTLs are config, not literals.
  holdTtlSeconds: config.HOLD_TTL_MINUTES * 60,
  inviteTtlSeconds: config.INVITE_TTL_HOURS * 3600,
  checkinWindowMs: config.CHECKIN_WINDOW_HOURS * 3_600_000,
  // R17 — an offer made during quiet hours runs to 08:00 IST instead.
  waitlistOfferTtlSeconds: config.WAITLIST_OFFER_TTL_MINUTES * 60,
  // R13 — signing throws until CHECKIN_TOKEN_SECRET is set, so a deploy
  // without it fails on the first QR rather than printing unverifiable ones.
  checkinKeys: checkinKeysFrom({
    secret: config.CHECKIN_TOKEN_SECRET,
    keyId: config.CHECKIN_TOKEN_KEY_ID,
    previous: config.CHECKIN_TOKEN_PREVIOUS,
  }),
});

/**
 * events R5 — the numbers `events.capacityOf` subtracts. Registration owns
 * `registrations` and `seat_holds`, so events asks rather than reads.
 * `events/index.ts` picks this up lazily.
 */
export const entriesPort = registration.entries;

export {
  LIVE_STATUSES,
  SEATED_STATUSES,
  REGISTRATION_STATUSES,
  RegistrationCode,
  canTransition,
} from './service/index.js';
export type {
  Invite,
  Page,
  PaymentMode,
  Registration,
  RosterEntry,
  RegistrationService,
  RegistrationStatus,
} from './service/index.js';
