/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { cloudinary } from '../../platform/cloudinary.js';
import { createVenueRepo } from './repo/index.js';
import { createVenueService, type SchedulePort, type VisitsPort } from './service/index.js';

/**
 * `court_assignments` and `matches` belong to `tournament`, so venues asks
 * rather than reads (conventions.md §1 — table ownership is exclusive).
 *
 * Resolved lazily on every call: `tournament` imports venues for its court
 * list, and reading the other singleton at module scope would close that ESM
 * cycle before either module finished being defined.
 */
const schedule: SchedulePort = {
  async assignedCourtIds(input) {
    const { schedulePort } = await import('../tournament/index.js');
    return schedulePort.assignedCourtIds(input);
  },
  async courtHasScheduledMatches(courtId) {
    const { schedulePort } = await import('../tournament/index.js');
    return schedulePort.courtHasScheduledMatches(courtId);
  },
};

const repo = createVenueRepo(db);

/**
 * R6 — where a finished match was played, and by whom. The court says where
 * when one was assigned; otherwise the event's venue does. Lazy for the same
 * cycle reason as `schedule`.
 */
const visits: VisitsPort = {
  async forMatch(matchId) {
    const [{ tournament }, { events }, { registration }] = await Promise.all([
      import('../tournament/index.js'),
      import('../events/index.js'),
      import('../registration/index.js'),
    ]);
    const match = await tournament.matchById(matchId);
    if (!match.completedAt) return null;
    // A walkover or a bye was not played anywhere.
    if (match.status !== 'completed') return null;
    const court = match.courtId ? await repo.courtById(match.courtId) : null;
    const venueId =
      court?.venueId ??
      (await events.byId((await tournament.byId(match.tournamentId)).eventId)).venueId;
    if (!venueId) return null;

    const sides = [match.sideARegistrationId, match.sideBRegistrationId].filter(
      (id): id is string => id !== null,
    );
    const members = await Promise.all(
      sides.map(async (registrationId) => {
        const team = await registration.teamFor(registrationId);
        if (team.length > 0) return team.map((m) => m.userId);
        const entry = await registration.findById(registrationId);
        return entry ? [entry.captainUserId] : [];
      }),
    );
    return { venueId, userIds: [...new Set(members.flat())], at: match.completedAt };
  },
};

export const venues = createVenueService({
  repo,
  schedule,
  visits,
  media: {
    signUpload: (opts) => cloudinary.signUpload(opts),
    venueRoot: (venueId) => cloudinary.folders.venueRoot(venueId),
    photoFolder: (venueId, n) => cloudinary.folders.venuePhoto(venueId, n),
  },
});

export {
  COURT_KINDS,
  MIN_REVIEWS_FOR_RATING,
  REVIEW_MAX_CHARS,
  VenueCode,
} from './service/index.js';
export type {
  Court,
  CourtKind,
  MediaPort,
  OpeningHours,
  Page,
  SchedulePort,
  TimeWindow,
  Venue,
  VenueReview,
  VenueService,
} from './service/index.js';
