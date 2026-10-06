/** The ONLY surface other modules may import (conventions.md §1). */
import { cloudinary } from '../../platform/cloudinary.js';
import { config } from '../../platform/config.js';
import { consume } from '../../platform/rateLimit.js';
import { db } from '../../platform/db.js';
import { sport, tweakRule, type ScoringRule } from '../sport/index.js';
import { venues } from '../venues/index.js';
import { createEventRepo } from './repo/index.js';
import {
  createEventService,
  type EntriesPort,
  type IdentityPort,
  type OrganisationsPort,
  type PublishGate,
} from './service/index.js';

/**
 * identity is reached lazily for the same reason profile reaches users lazily:
 * identity/index.ts already imports profile, and a module-scope import here
 * would put a second edge into that graph for no benefit. Resolving on first
 * call means both singletons exist by the time either is read.
 */
const identity: IdentityPort = {
  async grantsFor(userId, eventId) {
    const { identity: svc } = await import('../identity/index.js');
    return svc.grantsFor(userId, eventId);
  },
  async grantsForUser(userId) {
    const { identity: svc } = await import('../identity/index.js');
    return svc.grantsForUser(userId);
  },
  async addStaff(eventId, userId, role) {
    const { identity: svc } = await import('../identity/index.js');
    return svc.addStaff(eventId, userId, role);
  },
  async removeStaff(eventId, userId) {
    const { identity: svc } = await import('../identity/index.js');
    await svc.removeStaff(eventId, userId);
  },
  async staffFor(eventId) {
    const { identity: svc } = await import('../identity/index.js');
    return svc.staffFor(eventId);
  },
  async findByEmail(address) {
    const { identity: svc } = await import('../identity/index.js');
    return svc.findByEmail(address);
  },
};

/**
 * events R5 — `registrations` and `seat_holds` belong to `registration`, so
 * events asks rather than reads (conventions.md §1 — table ownership is
 * exclusive).
 *
 * Lazily, because registration imports events for the price quote and the
 * capacity check: resolving on first call keeps that cycle open at module
 * scope.
 */
const entries: EntriesPort = {
  async confirmedCount(categoryId) {
    const { registration } = await import('../registration/index.js');
    return registration.entries.confirmedCount(categoryId);
  },
  async liveHoldCount(categoryId) {
    const { registration } = await import('../registration/index.js');
    return registration.entries.liveHoldCount(categoryId);
  },
  async isSeatedEntrant(eventId, userId) {
    const { registration } = await import('../registration/index.js');
    return registration.entries.isSeatedEntrant(eventId, userId);
  },
  async participated(eventId, userId) {
    const { registration } = await import('../registration/index.js');
    return registration.entries.participated(eventId, userId);
  },
  async anyIn(categoryId) {
    const { registration } = await import('../registration/index.js');
    return registration.entries.anyIn(categoryId);
  },
};

/**
 * events R10 — paid publishing needs a verified host with a payout account.
 * Neither exists yet (organizers + payouts, Phase 2), so only platform staff
 * may publish a paid category for now; everyone else is told what is missing.
 */
const publishGate: PublishGate = {
  async canPublishPaid(userId, organisationId) {
    const { payouts } = await import('../payments/index.js');
    return payouts.canPublishPaid(userId, organisationId ?? null);
  },
};

/** org R3, R5, R7 — reached lazily: organizers imports identity, which events also reaches lazily. */
const organisationsPort: OrganisationsPort = {
  async forHosting(organisationId, userId) {
    const { organisations } = await import('../organizers/index.js');
    return organisations.forHosting(organisationId, userId);
  },
  async syncEventGrants(tx, organisationId, eventId) {
    const { organisations } = await import('../organizers/index.js');
    await organisations.syncEventGrants(tx, organisationId, eventId);
  },
  async isSuspended(organisationId) {
    const { organisations } = await import('../organizers/index.js');
    return (await organisations.findById(organisationId))?.verification === 'suspended';
  },
};

export const events = createEventService({
  db,
  repo: createEventRepo(db),
  sport,
  identity,
  entries,
  limiter: { consume },
  publishGate,
  organisations: organisationsPort,
  pricing: { platformFeePaise: config.PLATFORM_FEE_PAISE, taxBps: config.ENTRY_TAX_BPS },
  media: {
    signUpload: (opts) => cloudinary.signUpload(opts),
    eventRoot: (eventId) => cloudinary.folders.eventRoot(eventId),
  },
  venues: {
    async findById(venueId) {
      const venue = await venues.findById(venueId);
      return venue ? { id: venue.id, city: venue.city, location: venue.location } : null;
    },
    courtsForEvent: (eventId) => venues.courtsForEvent(eventId),
    addEventCourt: (eventId, input) => venues.addEventCourt(eventId, input),
    retireEventCourt: (eventId, courtId) => venues.retireEventCourt(eventId, courtId),
  },
  // F21, F22 — the sport's rule for a format, and a host's adjustment of it.
  rules: {
    async defaultFor(sportId, formatKey) {
      const format = (await sport.formatsFor(sportId)).find((f) => f.key === formatKey);
      return sport.scoringRuleFor(sportId, format?.id);
    },
    tweak: (rule, tweaks) => tweakRule(rule as ScoringRule, tweaks),
  },
});

/**
 * Where an event happens, as one line for email: "Venue, City", or the city
 * alone when the event has no venue yet. Never throws — a missing venue only
 * costs the email a detail.
 */
export async function placeOf(event: { venueId: string | null; city: string }): Promise<string> {
  const venue = event.venueId ? await venues.findById(event.venueId).catch(() => null) : null;
  return venue ? `${venue.name}, ${venue.city}` : event.city;
}

export {
  CATEGORY_STATUSES,
  CURRENCY,
  EVENT_STATUSES,
  EventCode,
  MESSAGE_MAX,
  computePriceQuote,
  encodeEventCursor,
  slugify,
} from './service/index.js';
export type {
  EventKind,
  Availability,
  Capacity,
  CategoryStatus,
  EntriesPort,
  Event,
  EventCategory,
  EventFilter,
  EventMedia,
  EventService,
  EventStatus,
  Page,
  PriceQuote,
} from './service/index.js';
export { EVENT_KINDS } from './service/index.js';
