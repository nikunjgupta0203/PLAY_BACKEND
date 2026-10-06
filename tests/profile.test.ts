/**
 * profile — service tests against a real Postgres (conventions.md §5).
 * Every numbered rule has at least one test that names it, so `grep 'R4:'`
 * finds the test for profile R4.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules, usersPortFor, type FakeMedia } from './helpers/modules.js';
import {
  createProfileService,
  type MatchFacts,
  type ProfileService,
} from '../src/modules/profile/service/index.js';
import type { SportService } from '../src/modules/sport/service/index.js';
import type { Db, Tx } from '../src/platform/db.js';
import { newId } from '../src/platform/ids.js';
import { PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';

let prisma: PrismaClient;
let profile: ProfileService;
let sport: SportService;
let media: FakeMedia;
let pickleballId: string;

interface Player {
  userId: string;
  playerId: string;
  actor: { userId: string };
}

/** profile R1 — user and profile in one transaction, as identity does it. */
async function makePlayer(displayName: string, email: string): Promise<Player> {
  const userId = newId();
  const playerId = await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, email, displayName } });
    return profile.createFor(tx as unknown as Tx, userId);
  });
  return { userId, playerId, actor: { userId } };
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  const wired = buildModules(prisma);
  profile = wired.profile;
  sport = wired.sport;
  media = wired.media;
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  sport.refresh();
  pickleballId = await seedSport(prisma, PICKLEBALL);
  sport.refresh();
  media.reset();
});

describe('profile', () => {
  it('R1: a profile is created in the same transaction as its user', async () => {
    const player = await makePlayer('Ravi', 'ravi@example.com');
    const row = await prisma.playerProfile.findUnique({ where: { userId: player.userId } });
    expect(row?.id).toBe(player.playerId);
  });

  it('R1: rolling the transaction back leaves neither a user nor a profile', async () => {
    const userId = newId();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: userId, email: 'ghost@example.com', displayName: 'Ghost' },
        });
        await profile.createFor(tx as unknown as Tx, userId);
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await prisma.user.count()).toBe(0);
    // A user without a profile is not a reachable state — and neither is the
    // reverse.
    expect(await prisma.playerProfile.count()).toBe(0);
  });

  it('R2: registering without a sport is blocked with NO_SPORT_SELECTED', async () => {
    const player = await makePlayer('Ravi', 'ravi@example.com');

    await expect(profile.assertHasSport(player.playerId)).rejects.toMatchObject({
      code: 'NO_SPORT_SELECTED',
    });

    await profile.updateSports(player.actor, [
      { sportId: pickleballId, skillBand: '3.5' },
    ]);
    await expect(profile.assertHasSport(player.playerId)).resolves.toBeUndefined();
  });

  it('R3: skill_band is self-declared and editable, and never touches rating', async () => {
    const player = await makePlayer('Ravi', 'ravi@example.com');
    await profile.updateSports(player.actor, [
      { sportId: pickleballId, skillBand: '3.5' },
    ]);
    await profile.applyRating(player.playerId, pickleballId, {
      rating: 1520.5,
      rd: 60,
      volatility: 0.06,
      matchesPlayed: 12,
    });

    // The player edits their own band...
    const after = await profile.updateSports(player.actor, [
      { sportId: pickleballId, skillBand: '4.0' },
    ]);
    const entry = after.sports.find((s) => s.sportId === pickleballId);

    expect(entry?.skillBand).toBe('4.0');
    // ...and the derived rating is untouched. The two are never conflated.
    expect(entry?.rating).toBe(1520.5);
    expect(entry?.matchesPlayed).toBe(12);
  });

  it('R3: a band that is not defined for that sport is INVALID_SKILL_BAND', async () => {
    const player = await makePlayer('Ravi', 'ravi@example.com');
    await expect(
      profile.updateSports(player.actor, [
        { sportId: pickleballId, skillBand: 'intermediate' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL_BAND' });
  });

  it('R6: selectOnboardingSports records the pending list, empty for a stranger', async () => {
    const badmintonId = await seedSport(prisma, {
      slug: 'badminton',
      name: 'Badminton',
      sortOrder: 1,
      formats: [{ key: 'singles', name: 'Singles', teamSize: 1 }],
      skillBands: [{ key: 'beginner', label: 'Beginner', lowerBound: null, upperBound: null }],
      scoringRule: {
        kind: 'rally', pointsToWin: 21, winBy: 2, hardCap: 30, gamesToWin: 2, serveModel: 'rally',
      },
    });
    sport.refresh();

    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    const stranger = await makePlayer('Meera', 'meera@example.com');

    await profile.selectOnboardingSports(ravi.actor, [pickleballId, badmintonId]);

    const own = await profile.publicView(ravi.userId, ravi.playerId);
    expect(own?.onboardingPendingSportIds.sort()).toEqual([badmintonId, pickleballId].sort());

    const asStranger = await profile.publicView(stranger.userId, ravi.playerId);
    expect(asStranger?.onboardingPendingSportIds).toEqual([]);
  });

  it('R6: selectOnboardingSports rejects an empty list', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await expect(profile.selectOnboardingSports(ravi.actor, [])).rejects.toMatchObject({
      code: 'NO_SPORT_SELECTED',
    });
  });

  it('R6: updateSports shrinks the pending list by exactly the sports it saves', async () => {
    const badmintonId = await seedSport(prisma, {
      slug: 'badminton',
      name: 'Badminton',
      sortOrder: 1,
      formats: [{ key: 'singles', name: 'Singles', teamSize: 1 }],
      skillBands: [{ key: 'beginner', label: 'Beginner', lowerBound: null, upperBound: null }],
      scoringRule: {
        kind: 'rally', pointsToWin: 21, winBy: 2, hardCap: 30, gamesToWin: 2, serveModel: 'rally',
      },
    });
    sport.refresh();

    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await profile.selectOnboardingSports(ravi.actor, [pickleballId, badmintonId]);

    await profile.updateSports(ravi.actor, [{ sportId: pickleballId, skillBand: '3.5' }]);
    let own = await profile.publicView(ravi.userId, ravi.playerId);
    expect(own?.onboardingPendingSportIds).toEqual([badmintonId]);

    await profile.updateSports(ravi.actor, [
      { sportId: pickleballId, skillBand: '3.5' },
      { sportId: badmintonId, skillBand: 'beginner' },
    ]);
    own = await profile.publicView(ravi.userId, ravi.playerId);
    expect(own?.onboardingPendingSportIds).toEqual([]);
  });

  it('R4: a private profile null-fills hidden fields rather than erroring', async () => {
    const owner = await makePlayer('Ravi', 'ravi@example.com');
    const stranger = await makePlayer('Meera', 'meera@example.com');

    await profile.updateLocation(owner.actor, { city: 'Bengaluru' });
    await prisma.playerProfile.update({
      where: { id: owner.playerId },
      data: { bio: 'Weekend doubles.' },
    });
    await profile.setVisibility(owner.actor, 'private');

    const asOwner = await profile.publicView(owner.userId, owner.playerId);
    const asStranger = await profile.publicView(stranger.userId, owner.playerId);

    expect(asOwner).toMatchObject({ city: 'Bengaluru', bio: 'Weekend doubles.' });
    expect(asOwner?.detailsVisible).toBe(true);

    // Not an error, not a null profile — the same shape with the details gone.
    expect(asStranger).not.toBeNull();
    expect(asStranger?.city).toBeNull();
    expect(asStranger?.bio).toBeNull();
    expect(asStranger?.detailsVisible).toBe(false);
  });

  it('R4: players_only hides details from a signed-out viewer only', async () => {
    const owner = await makePlayer('Ravi', 'ravi@example.com');
    const viewer = await makePlayer('Meera', 'meera@example.com');
    await profile.updateLocation(owner.actor, { city: 'Bengaluru' });
    await profile.setVisibility(owner.actor, 'players_only');

    expect((await profile.publicView(viewer.userId, owner.playerId))?.city).toBe('Bengaluru');
    expect((await profile.publicView(null, owner.playerId))?.city).toBeNull();
  });

  it('R4: a missing profile is null, which is what a private one also looks like', async () => {
    expect(await profile.publicView(null, newId())).toBeNull();
  });

  it('R5: a private profile still shows its competitive record', async () => {
    const owner = await makePlayer('Ravi', 'ravi@example.com');
    const stranger = await makePlayer('Meera', 'meera@example.com');

    await profile.updateSports(owner.actor, [
      { sportId: pickleballId, skillBand: '4.0' },
    ]);
    await profile.applyRating(owner.playerId, pickleballId, {
      rating: 1610,
      rd: 55,
      volatility: 0.06,
      matchesPlayed: 20,
    });
    await profile.award(owner.playerId, { key: 'tournament_winner', sportId: pickleballId });
    await profile.setVisibility(owner.actor, 'private');

    const view = await profile.publicView(stranger.userId, owner.playerId);

    // You cannot enter a public draw and hide the outcome.
    expect(view?.displayName).toBe('Ravi');
    expect(view?.sports[0]).toMatchObject({ skillBand: '4.0', rating: 1610 });
    expect(view?.achievements.map((a) => a.key)).toEqual(['tournament_winner']);
    // Visibility hides contact details, never the record.
    expect(view?.city).toBeNull();
  });

  it('R6: setAvatar rejects a public_id that was not signed for this player', async () => {
    const owner = await makePlayer('Ravi', 'ravi@example.com');
    const other = await makePlayer('Meera', 'meera@example.com');

    const signature = await profile.avatarUploadSignature(owner.actor);
    expect(signature.folder).toBe(`pl4y/avatars/${owner.playerId}`);

    // The step teams skip (ADR 0003 §C2): a client uploads under a signature we
    // issued, then reports somebody else's asset.
    await expect(
      profile.setAvatar(owner.actor, `pl4y/avatars/${other.playerId}/stolen`),
    ).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });

    const updated = await profile.setAvatar(owner.actor, signature.publicId);
    expect(updated.avatarPublicId).toBe(signature.publicId);
  });

  it('R6: replacing an avatar destroys the previous asset', async () => {
    const owner = await makePlayer('Ravi', 'ravi@example.com');

    const first = await profile.avatarUploadSignature(owner.actor);
    await profile.setAvatar(owner.actor, first.publicId);
    const second = await profile.avatarUploadSignature(owner.actor);
    await profile.setAvatar(owner.actor, second.publicId);

    // An orphan is storage we are billed for and nothing references.
    expect(media.destroyed).toEqual([first.publicId]);
  });

  it('R8: statsSnapshot reads a materialised document and never aggregates', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');

    // Nothing materialised yet: zeroes, not an error and not a computation.
    expect(await profile.statsSnapshot(ravi.playerId, pickleballId)).toMatchObject({
      matchesPlayed: 0,
      winRate: 0,
      updatedAt: null,
    });

    await profile.recordStatsSnapshot(ravi.playerId, {
      sportId: pickleballId,
      matchesPlayed: 10,
      wins: 7,
      losses: 3,
      winRate: 0.7,
      currentStreak: 2,
      tournamentsPlayed: 1,
      bestFinish: 'semi_final',
    });

    const snapshot = await profile.statsSnapshot(ravi.playerId, pickleballId);
    expect(snapshot).toMatchObject({ matchesPlayed: 10, wins: 7, winRate: 0.7 });
    expect(snapshot.updatedAt).toBeInstanceOf(Date);
  });

  it('R9: rating columns change only through applyRating', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await profile.updateSports(ravi.actor, [{ sportId: pickleballId, skillBand: '3.5' }]);

    const fresh = (await profile.byId(ravi.playerId)).sports[0];
    expect(fresh?.rating).toBeNull();
    expect(fresh?.isProvisional).toBe(true);

    const applied = await profile.applyRating(ravi.playerId, pickleballId, {
      rating: 1480.25,
      rd: 72.5,
      volatility: 0.059,
      matchesPlayed: 6,
    });

    expect(applied).toMatchObject({
      rating: 1480.25,
      ratingDev: 72.5,
      matchesPlayed: 6,
      // Six rated matches clears the provisional threshold of five.
      isProvisional: false,
      // The self-declared band is untouched by a rating write.
      skillBand: '3.5',
    });

    // The public surface exposes no other way in: every method that writes
    // player_sports writes skill_band alone.
    const writers = Object.keys(profile).filter((k) => k !== 'applyRating');
    expect(writers).not.toContain('setRating');
    expect(writers).not.toContain('updateRating');
  });

  it('R9: a rating below the provisional threshold stays provisional', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await profile.updateSports(ravi.actor, [{ sportId: pickleballId, skillBand: '3.5' }]);

    const applied = await profile.applyRating(ravi.playerId, pickleballId, {
      rating: 1500,
      rd: 90,
      volatility: 0.06,
      matchesPlayed: 4,
    });
    expect(applied.isProvisional).toBe(true);
  });

  it('emits profile.sports_changed to the outbox, inside the same transaction', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await profile.updateSports(ravi.actor, [{ sportId: pickleballId, skillBand: '3.5' }]);

    const messages = await prisma.outbox.findMany({ where: { topic: 'profile.sports_changed' } });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toMatchObject({ playerId: ravi.playerId });
  });

  it('emits achievement.earned to the outbox, once per standing achievement', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');

    await profile.award(ravi.playerId, { key: 'first_win', sportId: pickleballId });
    // Awarding the same standing achievement twice must not emit twice.
    expect(await profile.award(ravi.playerId, { key: 'first_win', sportId: pickleballId }))
      .toBeNull();

    const topics = (await prisma.outbox.findMany()).map((m) => m.topic).sort();
    expect(topics).toEqual(['achievement.earned']);
  });

  it('updateSports replaces the selection rather than merging into it', async () => {
    const badmintonId = await seedSport(prisma, {
      slug: 'badminton',
      name: 'Badminton',
      sortOrder: 1,
      formats: [{ key: 'singles', name: 'Singles', teamSize: 1 }],
      skillBands: [{ key: 'advanced', label: 'Advanced', lowerBound: null, upperBound: null }],
      scoringRule: {
        kind: 'rally',
        pointsToWin: 21,
        winBy: 2,
        hardCap: 30,
        gamesToWin: 2,
        serveModel: 'rally',
      },
    });
    sport.refresh();

    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await profile.updateSports(ravi.actor, [
      { sportId: pickleballId, skillBand: '3.5' },
      { sportId: badmintonId, skillBand: 'advanced' },
    ]);
    const narrowed = await profile.updateSports(ravi.actor, [
      { sportId: badmintonId, skillBand: 'advanced' },
    ]);

    expect(narrowed.sports.map((s) => s.sportId)).toEqual([badmintonId]);
  });

  it('updateLocation stores a point that PostGIS can read back', async () => {
    const ravi = await makePlayer('Ravi', 'ravi@example.com');
    await profile.updateLocation(ravi.actor, {
      city: 'Bengaluru',
      geo: { lat: 12.9716, lng: 77.5946 },
    });

    const [row] = await prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT ST_Y(geo::geometry) AS lat, ST_X(geo::geometry) AS lng
        FROM player_profiles WHERE id = ${ravi.playerId}::uuid
    `;
    expect(row?.lat).toBeCloseTo(12.9716, 4);
    expect(row?.lng).toBeCloseTo(77.5946, 4);
  });

  describe('search', () => {
    it('excludes private profiles, and players_only from signed-out viewers', async () => {
      const open = await makePlayer('Ravi Kumar', 'ravi@example.com');
      const gated = await makePlayer('Ravi Sharma', 'sharma@example.com');
      const hidden = await makePlayer('Ravi Nair', 'nair@example.com');
      const viewer = await makePlayer('Meera', 'meera@example.com');

      await profile.setVisibility(gated.actor, 'players_only');
      await profile.setVisibility(hidden.actor, 'private');

      const anonymous = await profile.search({ query: 'Ravi', first: 10 });
      expect(anonymous.nodes.map((n) => n.id)).toEqual([open.playerId]);

      const signedIn = await profile.search({
        query: 'Ravi',
        first: 10,
        viewerUserId: viewer.userId,
      });
      expect(signedIn.nodes.map((n) => n.id).sort()).toEqual(
        [open.playerId, gated.playerId].sort(),
      );
    });

    it('pages on (display_name, id) without repeating or skipping a row', async () => {
      const made: string[] = [];
      for (const name of ['Anita', 'Bhavna', 'Chirag', 'Deepa', 'Esha']) {
        made.push((await makePlayer(name, `${name.toLowerCase()}@example.com`)).playerId);
      }

      const first = await profile.search({ query: 'a', first: 2 });
      const second = await profile.search({ query: 'a', first: 2, after: first.endCursor });
      const third = await profile.search({ query: 'a', first: 2, after: second.endCursor });

      const seen = [...first.nodes, ...second.nodes, ...third.nodes].map((n) => n.id);
      expect(first.hasNextPage).toBe(true);
      expect(third.hasNextPage).toBe(false);
      expect(new Set(seen).size).toBe(seen.length);
      // Every name in the fixture contains an 'a'.
      expect(seen.sort()).toEqual([...made].sort());
    });

    it('filters by sport when one is given', async () => {
      const player = await makePlayer('Ravi', 'ravi@example.com');
      await makePlayer('Ravi Two', 'ravi2@example.com');
      await profile.updateSports(player.actor, [
        { sportId: pickleballId, skillBand: '3.5' },
      ]);

      const filtered = await profile.search({ query: 'Ravi', sportId: pickleballId, first: 10 });
      expect(filtered.nodes.map((n) => n.id)).toEqual([player.playerId]);
    });
  });

  describe('match history (R12, R14) and stats (R8)', () => {
    const facts = new Map<string, MatchFacts>();
    const history = () =>
      createProfileService({
        db: prisma as unknown as Db,
        sport,
        users: usersPortFor(prisma),
        media,
        matches: { factsFor: async (matchId) => facts.get(matchId) ?? null },
      });

    const singles = (
      a: Player,
      b: Player,
      opts: { winner: 'a' | 'b'; at: string; games?: { a: number; b: number }[]; eventId?: string },
    ): MatchFacts => {
      const matchId = newId();
      const f: MatchFacts = {
        matchId,
        sportId: pickleballId,
        eventId: opts.eventId ?? null,
        completedAt: new Date(opts.at),
        outcome: 'played',
        winnerRegistrationId: opts.winner === 'a' ? `reg-${a.userId}` : `reg-${b.userId}`,
        sides: [
          { registrationId: `reg-${a.userId}`, userIds: [a.userId] },
          { registrationId: `reg-${b.userId}`, userIds: [b.userId] },
        ],
        games: opts.games ?? [{ a: 11, b: 7 }],
      };
      facts.set(matchId, f);
      return f;
    };

    beforeEach(() => facts.clear());

    it('R12: a completed match writes one row per player, games from their own side', async () => {
      const svc = history();
      const ravi = await makePlayer('Ravi', 'ravi@example.com');
      const asha = await makePlayer('Asha', 'asha@example.com');
      const m = singles(ravi, asha, { winner: 'b', at: '2026-09-20T10:00:00Z', games: [{ a: 9, b: 11 }, { a: 11, b: 13 }] });

      await svc.projectMatch(m.matchId);

      const [r] = await svc.recentResults(ravi.playerId, 5);
      expect(r).toMatchObject({ won: false, opponentIds: [asha.playerId], partnerIds: [] });
      expect(r?.games).toEqual([{ for: 9, against: 11 }, { for: 11, against: 13 }]);
      const [a] = await svc.recentResults(asha.playerId, 5);
      expect(a).toMatchObject({ won: true, opponentIds: [ravi.playerId] });
      expect(a?.games).toEqual([{ for: 11, against: 9 }, { for: 13, against: 11 }]);
    });

    it('R12: projecting twice, or after a correction, converges on one set of rows', async () => {
      const svc = history();
      const ravi = await makePlayer('Ravi', 'ravi@example.com');
      const asha = await makePlayer('Asha', 'asha@example.com');
      const m = singles(ravi, asha, { winner: 'a', at: '2026-09-20T10:00:00Z' });
      await svc.projectMatch(m.matchId);
      await svc.projectMatch(m.matchId);
      expect(await prisma.playerMatchHistory.count()).toBe(2);

      // scoring R8 — the winner flips on a correction.
      facts.set(m.matchId, { ...m, winnerRegistrationId: `reg-${asha.userId}` });
      await svc.projectMatch(m.matchId);
      expect((await svc.recentResults(ravi.playerId, 5))[0]?.won).toBe(false);
      expect((await svc.statsSnapshot(ravi.playerId, pickleballId)).wins).toBe(0);
    });

    it('R8: stats are materialised from the projection — record, streak, tournaments', async () => {
      const svc = history();
      const ravi = await makePlayer('Ravi', 'ravi@example.com');
      const asha = await makePlayer('Asha', 'asha@example.com');
      const e1 = newId();
      const e2 = newId();
      for (const m of [
        singles(ravi, asha, { winner: 'b', at: '2026-09-01T10:00:00Z', eventId: e1 }),
        singles(ravi, asha, { winner: 'a', at: '2026-09-02T10:00:00Z', eventId: e1 }),
        singles(ravi, asha, { winner: 'a', at: '2026-09-03T10:00:00Z', eventId: e2 }),
      ]) {
        await svc.projectMatch(m.matchId);
      }

      const stats = await svc.statsSnapshot(ravi.playerId, pickleballId);
      expect(stats).toMatchObject({
        matchesPlayed: 3,
        wins: 2,
        losses: 1,
        currentStreak: 2,
        tournamentsPlayed: 2,
      });
      expect(stats.winRate).toBeCloseTo(2 / 3);
      expect((await svc.statsSnapshot(asha.playerId, pickleballId)).currentStreak).toBe(0);
    });

    it('R12: history is newest first and pages on a stable keyset', async () => {
      const svc = history();
      const ravi = await makePlayer('Ravi', 'ravi@example.com');
      const asha = await makePlayer('Asha', 'asha@example.com');
      const days = ['01', '02', '03', '04', '05'];
      for (const d of days) {
        await svc.projectMatch(singles(ravi, asha, { winner: 'a', at: `2026-09-${d}T10:00:00Z` }).matchId);
      }

      const seen: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page = await svc.matchHistory(ravi.playerId, { first: 2, after });
        seen.push(...page.nodes.map((n) => n.completedAt.toISOString().slice(8, 10)));
        if (!page.hasNextPage) break;
        after = page.endCursor;
      }
      expect(seen).toEqual([...days].reverse());
    });

    it('R12: a bye is not a match anybody played — it writes nothing', async () => {
      const svc = history();
      await makePlayer('Ravi', 'ravi@example.com');
      await svc.projectMatch(newId());
      expect(await prisma.playerMatchHistory.count()).toBe(0);
    });

    describe('played with (R10)', () => {
      it('R10: partners and opponents, most recent first, with how often', async () => {
        const svc = history();
        const ravi = await makePlayer('Ravi', 'ravi@example.com');
        const asha = await makePlayer('Asha', 'asha@example.com');
        const meera = await makePlayer('Meera', 'meera@example.com');
        const kiran = await makePlayer('Kiran', 'kiran@example.com');
        await svc.projectMatch(singles(ravi, asha, { winner: 'a', at: '2026-09-20T10:00:00Z' }).matchId);
        await svc.projectMatch(singles(ravi, meera, { winner: 'a', at: '2026-09-21T10:00:00Z' }).matchId);
        await svc.projectMatch(singles(ravi, asha, { winner: 'b', at: '2026-09-22T10:00:00Z' }).matchId);
        // Doubles: Kiran is a partner, not an opponent — still someone Ravi played with.
        const doubles: MatchFacts = {
          matchId: newId(),
          sportId: pickleballId,
          eventId: null,
          completedAt: new Date('2026-09-19T10:00:00Z'),
          outcome: 'played',
          winnerRegistrationId: 'reg-rk',
          sides: [
            { registrationId: 'reg-rk', userIds: [ravi.userId, kiran.userId] },
            { registrationId: 'reg-am', userIds: [asha.userId, meera.userId] },
          ],
          games: [{ a: 11, b: 4 }],
        };
        facts.set(doubles.matchId, doubles);
        await svc.projectMatch(doubles.matchId);

        const list = await svc.playedWith(ravi.playerId, { viewerUserId: ravi.userId, first: 10 });
        expect(list.map((r) => [r.player.displayName, r.matches])).toEqual([
          ['Asha', 3],
          ['Meera', 2],
          ['Kiran', 1],
        ]);
        expect(list[0]!.lastPlayedAt).toEqual(new Date('2026-09-22T10:00:00Z'));
        expect(await svc.havePlayedTogether(ravi.playerId, kiran.playerId)).toBe(true);
        expect(await svc.havePlayedTogether(kiran.playerId, asha.playerId)).toBe(true);
        expect(await svc.havePlayedTogether(asha.playerId, newId())).toBe(false);
      });

      it('R4: a private player lists nobody to strangers and appears in no one else’s list', async () => {
        const svc = history();
        const ravi = await makePlayer('Ravi', 'ravi@example.com');
        const asha = await makePlayer('Asha', 'asha@example.com');
        const stranger = await makePlayer('Stranger', 'stranger@example.com');
        await svc.projectMatch(singles(ravi, asha, { winner: 'a', at: '2026-09-20T10:00:00Z' }).matchId);

        await profile.setVisibility(ravi.actor, 'private');
        expect(await svc.playedWith(ravi.playerId, { viewerUserId: stranger.userId, first: 10 })).toEqual([]);
        // The owner still sees their own list.
        expect(await svc.playedWith(ravi.playerId, { viewerUserId: ravi.userId, first: 10 })).toHaveLength(1);
        // Asha's list does not show a private Ravi to a stranger, but shows him to himself.
        expect(await svc.playedWith(asha.playerId, { viewerUserId: stranger.userId, first: 10 })).toEqual([]);
        expect(await svc.playedWith(asha.playerId, { viewerUserId: ravi.userId, first: 10 })).toHaveLength(1);
      });
    });
  });

  describe('name and bio (R15)', () => {
    it('R15: a player sets their own name and bio; blank bio clears it', async () => {
      const ravi = await makePlayer('ravi', 'ravi@example.com');
      const updated = await profile.updateDetails(ravi.actor, { displayName: '  Ravi   Kumar ', bio: ' Weekend pickleballer ' });
      expect(updated).toMatchObject({ displayName: 'Ravi Kumar', bio: 'Weekend pickleballer' });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ravi.userId } })).displayName).toBe('Ravi Kumar');

      const cleared = await profile.updateDetails(ravi.actor, { bio: '   ' });
      expect(cleared).toMatchObject({ displayName: 'Ravi Kumar', bio: null });
    });

    it('R15: a name is 2-40 characters and a bio at most 160', async () => {
      const ravi = await makePlayer('ravi', 'ravi@example.com');
      await expect(profile.updateDetails(ravi.actor, { displayName: ' R ' })).rejects.toMatchObject({
        code: 'INVALID_DISPLAY_NAME',
      });
      await expect(profile.updateDetails(ravi.actor, { displayName: 'x'.repeat(41) })).rejects.toMatchObject({
        code: 'INVALID_DISPLAY_NAME',
      });
      await expect(profile.updateDetails(ravi.actor, { bio: 'x'.repeat(161) })).rejects.toMatchObject({
        code: 'INVALID_BIO',
      });
    });
  });
});
