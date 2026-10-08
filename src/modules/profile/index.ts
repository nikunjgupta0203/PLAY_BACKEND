/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { cloudinary } from '../../platform/cloudinary.js';
import { sport } from '../sport/index.js';
import { createProfileService, type MatchesPort, type UsersPort } from './service/index.js';

/**
 * identity/index.ts imports THIS module, because identity R9 needs createFor()
 * inside its own transaction. Importing identity back at module scope would
 * close an ESM cycle and read `identity` while it is still in its temporal dead
 * zone, so the port resolves on first call instead — by which time both module
 * singletons exist.
 */
const users: UsersPort = {
  async byIds(ids) {
    const { identity } = await import('../identity/index.js');
    return identity.usersByIds(ids);
  },
  async setAvatar(userId, publicId) {
    const { identity } = await import('../identity/index.js');
    return identity.setAvatar(userId, publicId);
  },
  async setDisplayName(userId, displayName) {
    const { identity } = await import('../identity/index.js');
    return identity.setDisplayName(userId, displayName);
  },
};

/**
 * R12 — the projection's view of a finished match. `matches` are tournament's,
 * results are scoring's and entries are registration's; all three import this
 * module, so they resolve lazily for the same reason `users` does.
 */
const matches: MatchesPort = {
  async factsFor(matchId) {
    const [{ tournament }, { scoring }, { registration }] = await Promise.all([
      import('../tournament/index.js'),
      import('../scoring/index.js'),
      import('../registration/index.js'),
    ]);
    const match = await tournament.matchById(matchId);
    const { sideARegistrationId: a, sideBRegistrationId: b, winnerRegistrationId: winner } = match;
    // A bye has one side and is not a match anybody played.
    if (!match.completedAt || !winner || !a || !b) return null;

    const membersOf = async (registrationId: string) => {
      const team = await registration.teamFor(registrationId);
      if (team.length > 0) return team.map((m) => m.userId);
      const entry = await registration.findById(registrationId);
      return entry ? [entry.captainUserId] : [];
    };
    const [owner, result, sideA, sideB] = await Promise.all([
      tournament.byId(match.tournamentId),
      scoring.confirmedResult(matchId),
      membersOf(a),
      membersOf(b),
    ]);
    return {
      matchId,
      sportId: match.sportId,
      eventId: owner.eventId,
      completedAt: match.completedAt,
      outcome: result?.outcome ?? (match.status === 'walkover' ? 'walkover' : 'played'),
      winnerRegistrationId: winner,
      sides: [
        { registrationId: a, userIds: sideA },
        { registrationId: b, userIds: sideB },
      ],
      games: result?.games ?? [],
    };
  },
};

export const profile = createProfileService({
  db,
  sport,
  users,
  matches,
  media: {
    signUpload: (opts) => cloudinary.signUpload(opts),
    destroy: (publicId) => cloudinary.destroy(publicId),
    avatarFolder: (playerId) => cloudinary.folders.avatar(playerId),
  },
});

export { ProfileCode, PROVISIONAL_MATCHES, VISIBILITIES } from './service/index.js';
export type {
  Achievement,
  MatchHistoryRow,
  Page,
  PlayedWith,
  PlayerProfile,
  PlayerSport,
  ProfileBrief,
  ProfileService,
  PublicProfile,
  StatsSnapshot,
  Visibility,
} from './service/index.js';
