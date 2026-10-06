/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { events } from '../events/index.js';
import { profile } from '../profile/index.js';
import { rating } from '../rating/index.js';
import { registration } from '../registration/index.js';
import { venues } from '../venues/index.js';
import { createTournamentRepo } from './repo/index.js';
import {
  createTournamentService,
  type RatingsPort,
  type RegistrationsPort,
} from './service/index.js';

/**
 * `registrations` belongs to `registration`, including the `seed` column this
 * module fills in at draw time. Every edge below is a named service call rather
 * than a query (conventions.md §1 — table ownership is exclusive).
 */
const registrations: RegistrationsPort = {
  async confirmedForCategory(categoryId) {
    const rows = await registration.confirmedForCategory(categoryId);
    return rows.map((r) => ({
      id: r.id,
      captainUserId: r.captainUserId,
      confirmedAt: r.confirmedAt,
      createdAt: r.createdAt,
    }));
  },
  async membersOf(registrationId) {
    const team = await registration.teamFor(registrationId);
    if (team.length > 0) return team.map((m) => m.userId);
    // Singles: the captain is the entry.
    const found = await registration.findById(registrationId);
    return found ? [found.captainUserId] : [];
  },
  applySeeds: (tx, seeds) => registration.applySeeds(tx, seeds),
  seedOf: async (registrationId) => (await registration.findById(registrationId))?.seed ?? null,
};

/**
 * R2 — seeding reads the SETTLED rating, and a provisional one is deliberately
 * not a rating for this purpose: rating R9 says a number below five settled
 * matches is not fit to rank on, and a seeding is a ranking. An entry nobody
 * can rate seeds last, which is the honest place for a player nobody has seen.
 */
const ratings: RatingsPort = {
  async settledFor(userId, sportId) {
    const player = await profile.findByUserId(userId);
    if (!player) return null;
    const found = await rating.ratingFor(player.id, sportId);
    return found.provisional ? null : found.rating;
  },
};

export const tournament = createTournamentService({
  db,
  repo: createTournamentRepo(db),
  events: {
    byId: async (eventId) => {
      const event = await events.byId(eventId);
      return {
        id: event.id,
        sportId: event.sportId,
        venueId: event.venueId,
        startsAt: event.startsAt,
        status: event.status,
        organizerId: event.organizerId,
      };
    },
    categoryById: async (categoryId) => {
      const category = await events.categoryById(categoryId);
      return {
        id: category.id,
        eventId: category.eventId,
        sportId: category.sportId,
        name: category.name,
        drawType: category.drawType,
        minEntries: category.minEntries,
        status: category.status,
        thirdPlace: category.thirdPlace,
        matchMinutes: category.matchMinutes,
      };
    },
    assertStaff: (actor, eventId, roles) => events.assertStaff(actor, eventId, roles),
    markCategoryDrawn: (categoryId, tx) => events.markCategoryDrawn(categoryId, tx),
    markCategoryCompleted: (categoryId, tx) => events.markCategoryCompleted(categoryId, tx),
    heldSeats: async (categoryId) => (await events.capacityOf(categoryId)).held,
  },
  registrations,
  ratings,
  courts: {
    forVenue: async (venueId) => {
      const list = await venues.courtsFor(venueId);
      return list.map((c) => ({
        id: c.id,
        name: c.name,
        sportIds: c.sportIds,
        active: c.active,
      }));
    },
    // F14 — courts the host declared for this event.
    forEvent: async (eventId) =>
      (await venues.courtsForEvent(eventId)).map((c) => ({ id: c.id, name: c.name, sportIds: c.sportIds, active: c.active })),
    venueOwner: async (venueId) => (await venues.findById(venueId))?.createdBy ?? null,
  },
});

/**
 * venues R4 — `court_assignments` and `matches` belong to this module, so
 * venues asks rather than reads. `venues/index.ts` picks this up lazily, which
 * is what keeps the cycle between the two open at module scope.
 */
export const schedulePort = tournament.courts;

export {
  MATCH_MINUTES,
  MATCH_STATUSES,
  MIN_ENTRIES,
  MIN_REST_MINUTES,
  TournamentCode,
  roundName,
} from './service/index.js';
export type {
  Bracket,
  BracketRound,
  BracketType,
  MatchBracket,
  CourtAssignment,
  LeagueGroup,
  Match,
  MatchOutcome,
  MatchStatus,
  StandingRow,
  Tournament,
  TournamentService,
} from './service/index.js';
