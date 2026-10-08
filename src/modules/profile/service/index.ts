/**
 * profile — service layer (docs/modules/03-profile.md).
 *
 * The player as other players see them: sports, skill, location, results,
 * achievements, who they have played with. Also the read model behind the Home screen's stats
 * snapshot.
 *
 * Services never import GraphQL types (conventions.md §1). Everything this
 * module needs from `identity` and `sport` arrives as a narrow port, so the
 * cross-module edge is one interface rather than a table read.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import { newId } from '../../../platform/ids.js';
import { UserError } from '../../../platform/errors/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import type { UploadSignature } from '../../../platform/cloudinary.js';
import { cityVariants } from '../../../platform/city.js';
import { memo, remember } from '../../../platform/requestCache.js';
import { badgesFromHistory } from './badges.js';

export const ProfileCode = {
  /** Also what a private profile returns: R4 — not distinguishable from missing. */
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  NO_SPORT_SELECTED: 'NO_SPORT_SELECTED',
  INVALID_SKILL_BAND: 'INVALID_SKILL_BAND',
  /** R15 — 2 to 40 characters once trimmed. */
  INVALID_DISPLAY_NAME: 'INVALID_DISPLAY_NAME',
  /** R15 — at most 160 characters. */
  INVALID_BIO: 'INVALID_BIO',
} as const;

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 40;
export const BIO_MAX = 160;

export const VISIBILITIES = ['public', 'players_only', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** A rating stays provisional until the player has this many rated matches. */
export const PROVISIONAL_MATCHES = 5;

export interface Actor {
  userId: string;
}

export interface PlayerSport {
  sportId: string;
  /** profile R3 — self-declared, editable, and never conflated with `rating`. */
  skillBand: string;
  /** profile R9 — derived. Null until the rating module has enough matches. */
  rating: number | null;
  ratingDev: number | null;
  volatility: number | null;
  isProvisional: boolean;
  matchesPlayed: number;
}

export interface Achievement {
  id: string;
  key: string;
  sportId: string | null;
  eventId: string | null;
  earnedAt: Date;
}

export interface PlayerProfile {
  id: string;
  userId: string;
  displayName: string;
  /** ADR 0003 §C3 — the public_id. The URL is built at render, never stored. */
  avatarPublicId: string | null;
  city: string | null;
  bio: string | null;
  visibility: Visibility;
  sports: PlayerSport[];
  createdAt: Date;
  /** onboarding R6 — sports selected but not yet skill-rated. */
  onboardingPendingSportIds: string[];
}

/**
 * What a viewer is allowed to see (R4, R5).
 *
 * `city` and `bio` are null-filled rather than absent, and the call never
 * throws: a private profile must not be distinguishable from a missing one.
 * Competitive record — name, avatar, sports, ratings, achievements — is always
 * present, because you cannot enter a public draw and hide the outcome (R5).
 */
export interface PublicProfile {
  id: string;
  displayName: string;
  avatarPublicId: string | null;
  city: string | null;
  bio: string | null;
  visibility: Visibility;
  sports: PlayerSport[];
  achievements: Achievement[];
  /** False when city/bio were withheld, so a client can render "private". */
  detailsVisible: boolean;
  /** Owner-only, like city/bio under R4 — [] for every other viewer. */
  onboardingPendingSportIds: string[];
}

/** R10 — someone this player shared a completed match with, as partner or opponent. */
export interface PlayedWith {
  player: PublicProfile;
  matches: number;
  lastPlayedAt: Date;
}

/** profile R8 — materialised on match completion, never computed per request. */
export interface StatsSnapshot {
  sportId: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
  /** 0-1. Zero when nothing has been played, never NaN. */
  winRate: number;
  currentStreak: number;
  tournamentsPlayed: number;
  bestFinish: string | null;
  updatedAt: Date | null;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export type MatchHistoryOutcome = 'played' | 'walkover' | 'retired' | 'forfeit';

/** profile R12 — one completed match from one player's side. Ids are profile ids. */
export interface MatchHistoryRow {
  playerId: string;
  matchId: string;
  sportId: string;
  eventId: string | null;
  partnerIds: string[];
  opponentIds: string[];
  won: boolean;
  outcome: MatchHistoryOutcome;
  /** Games (rally) or sets, as `for` this player and `against`. Empty for a walkover. */
  games: { for: number; against: number }[];
  completedAt: Date;
}

// --- ports -------------------------------------------------------------------

export interface SportPort {
  byId(sportId: string): Promise<{ id: string }>;
  hasSkillBand(sportId: string, key: string): Promise<boolean>;
}

/**
 * `display_name` and `avatar_public_id` live on `users`, which identity owns
 * exclusively (conventions.md §1). Profile reads them through here and changes
 * them through here — never with an UPDATE of its own.
 */
export interface UsersPort {
  byIds(
    ids: string[],
  ): Promise<{ id: string; displayName: string; avatarPublicId: string | null }[]>;
  setAvatar(userId: string, publicId: string | null): Promise<void>;
  setDisplayName(userId: string, displayName: string): Promise<void>;
}

export interface MediaPort {
  signUpload(opts: { publicId: string; folder: string }): UploadSignature;
  destroy(publicId: string): Promise<void>;
  avatarFolder(playerId: string): string;
}

/**
 * profile R12 — what the projection needs to know about a finished match.
 * `matches` belong to tournament and results to scoring, so this arrives as a
 * port rather than a table read. `games` are oriented side A / side B, in the
 * same order as `sides`.
 */
export interface MatchFacts {
  matchId: string;
  sportId: string;
  eventId: string | null;
  completedAt: Date;
  outcome: MatchHistoryOutcome;
  winnerRegistrationId: string;
  sides: [{ registrationId: string; userIds: string[] }, { registrationId: string; userIds: string[] }];
  games: { a: number; b: number }[];
}

export interface MatchesPort {
  /** Null for a match that is not finished, or that was a bye (only one side). */
  factsFor(matchId: string): Promise<MatchFacts | null>;
}

export interface ProfileDeps {
  db: Db;
  sport: SportPort;
  users: UsersPort;
  media: MediaPort;
  /** Only the match-history projection needs it; everything else works without. */
  matches?: MatchesPort;
  now?: () => Date;
}

// --- helpers -----------------------------------------------------------------

const num = (v: Prisma.Decimal | null): number | null => (v === null ? null : v.toNumber());

interface PlayerSportRow {
  sportId: string;
  skillBand: string;
  rating: Prisma.Decimal | null;
  ratingDev: Prisma.Decimal | null;
  volatility: Prisma.Decimal | null;
  isProvisional: boolean;
  matchesPlayed: number;
}

const toPlayerSport = (r: PlayerSportRow): PlayerSport => ({
  sportId: r.sportId,
  skillBand: r.skillBand,
  rating: num(r.rating),
  ratingDev: num(r.ratingDev),
  volatility: num(r.volatility),
  isProvisional: r.isProvisional,
  matchesPlayed: r.matchesPlayed,
});

interface AchievementRow {
  id: string;
  playerId: string;
  key: string;
  sportId: string | null;
  eventId: string | null;
  earnedAt: Date;
}

/** Who a profile belongs to and who may see it — all chat reads about a player. */
export interface ProfileBrief {
  id: string;
  userId: string;
  visibility: Visibility;
}

const BRIEF = { id: true, userId: true, visibility: true } as const;

const notFound = () =>
  new UserError(ProfileCode.PROFILE_NOT_FOUND, 'That player could not be found.');

/** Cursor on (display_name, id) — conventions.md §4. Opaque to the client. */
const encodeCursor = (displayName: string, id: string): string =>
  Buffer.from(`${displayName}|${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): { displayName: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // The id is a UUID and carries no '|', so split from the right: a display
    // name containing the separator must not corrupt the cursor.
    const at = raw.lastIndexOf('|');
    if (at < 0) return null;
    return { displayName: raw.slice(0, at), id: raw.slice(at + 1) };
  } catch {
    // A malformed cursor is a client bug, not a reason to 500. Start over.
    return null;
  }
}

const emptyStats = (sportId: string): StatsSnapshot => ({
  sportId,
  matchesPlayed: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  currentStreak: 0,
  tournamentsPlayed: 0,
  bestFinish: null,
  updatedAt: null,
});

export function createProfileService(deps: ProfileDeps) {
  const { db, sport, users, media } = deps;
  const now = deps.now ?? (() => new Date());

  // --- creation (R1) ---------------------------------------------------------

  /**
   * profile R1 — a profile is created in the same transaction as its user, by
   * identity calling this. This module never creates one on its own, and a user
   * without a profile is not a reachable state.
   *
   * The module doc writes `createFor(tx, userId, displayName)`. The display name
   * lives on `users`, which identity owns and has already written by this point,
   * so taking it here would only invite a second copy to drift.
   */
  async function createFor(tx: Tx, userId: string): Promise<string> {
    const row = await tx.playerProfile.create({ data: { id: newId(), userId } });
    return row.id;
  }

  // --- reads -----------------------------------------------------------------

  interface ProfileRow {
    id: string;
    userId: string;
    city: string | null;
    bio: string | null;
    visibility: string;
    createdAt: Date;
    sports: PlayerSportRow[];
    onboardingPendingSportIds: string[];
  }

  async function hydrate(rows: ProfileRow[]): Promise<PlayerProfile[]> {
    if (rows.length === 0) return [];
    const owners = await users.byIds(rows.map((r) => r.userId));
    const byUser = new Map(owners.map((u) => [u.id, u]));
    return rows.map((r) => {
      const owner = byUser.get(r.userId);
      return {
        id: r.id,
        userId: r.userId,
        displayName: owner?.displayName ?? '',
        avatarPublicId: owner?.avatarPublicId ?? null,
        city: r.city,
        bio: r.bio,
        visibility: r.visibility as Visibility,
        sports: r.sports.map(toPlayerSport),
        createdAt: r.createdAt,
        onboardingPendingSportIds: r.onboardingPendingSportIds,
      };
    });
  }

  // Speed — a profile is read once per query, however many fields ask (platform/requestCache.ts).
  function findById(playerId: string): Promise<PlayerProfile | null> {
    return memo(`profile:id:${playerId}`, async () => {
      const row = await db.playerProfile.findUnique({
        where: { id: playerId },
        include: { sports: true },
      });
      if (!row) return null;
      return (await hydrate([row]))[0] ?? null;
    });
  }

  async function byId(playerId: string): Promise<PlayerProfile> {
    const found = await findById(playerId);
    if (!found) throw notFound();
    return found;
  }

  function findByUserId(userId: string): Promise<PlayerProfile | null> {
    return memo(`profile:user:${userId}`, async () => {
      const row = await db.playerProfile.findUnique({
        where: { userId },
        include: { sports: true },
      });
      if (!row) return null;
      const found = (await hydrate([row]))[0] ?? null;
      if (found) remember(`profile:id:${found.id}`, found);
      return found;
    });
  }

  async function byUserId(userId: string): Promise<PlayerProfile> {
    const found = await findByUserId(userId);
    if (!found) throw notFound();
    return found;
  }

  /** The profile the actor owns. Every mutation below starts here. */
  async function ownProfile(actor: Actor): Promise<PlayerProfile> {
    return byUserId(actor.userId);
  }

  /**
   * profile R4, R5 — null-fills what the viewer may not see instead of erroring.
   * Returns null only when the profile genuinely does not exist.
   */
  async function publicView(
    viewerUserId: string | null,
    playerId: string,
  ): Promise<PublicProfile | null> {
    // Speed — the target and the viewer are independent reads.
    const [target, viewer] = await Promise.all([
      findById(playerId),
      viewerUserId ? findByUserId(viewerUserId) : null,
    ]);
    if (!target) return null;
    return viewOf(target, viewer);
  }

  /**
   * Speed — `publicView` for many players in a fixed number of queries
   * (a chat inbox shows one per row). Missing players are absent from the map.
   */
  async function publicViews(
    viewerUserId: string | null,
    playerIds: readonly string[],
  ): Promise<Map<string, PublicProfile>> {
    const ids = [...new Set(playerIds)];
    if (ids.length === 0) return new Map();
    const [rows, viewer, achievements] = await Promise.all([
      db.playerProfile.findMany({ where: { id: { in: ids } }, include: { sports: true } }),
      // Only the viewer's id matters below, so the one-query lookup does.
      viewerUserId ? briefByUserId(viewerUserId) : null,
      db.achievement.findMany({ where: { playerId: { in: ids } }, orderBy: { earnedAt: 'desc' } }),
    ]);
    const byPlayer = new Map<string, AchievementRow[]>();
    for (const a of achievements) byPlayer.set(a.playerId, [...(byPlayer.get(a.playerId) ?? []), a]);
    const targets = await hydrate(rows);
    return new Map(targets.map((t) => [t.id, toPublic(t, viewer, byPlayer.get(t.id) ?? [])]));
  }

  /** Speed — the three columns chat needs, in one query instead of three. */
  function briefByUserId(userId: string): Promise<ProfileBrief | null> {
    return memo(`profile:brief:user:${userId}`, () =>
      db.playerProfile.findUnique({ where: { userId }, select: BRIEF }) as Promise<ProfileBrief | null>,
    );
  }

  function briefById(playerId: string): Promise<ProfileBrief | null> {
    return memo(`profile:brief:id:${playerId}`, () =>
      db.playerProfile.findUnique({ where: { id: playerId }, select: BRIEF }) as Promise<ProfileBrief | null>,
    );
  }

  async function viewOf(
    target: PlayerProfile,
    viewer: PlayerProfile | null,
  ): Promise<PublicProfile> {
    const achievements = await memo(`profile:achievements:${target.id}`, () =>
      db.achievement.findMany({
        where: { playerId: target.id },
        orderBy: { earnedAt: 'desc' },
      }),
    );
    return toPublic(target, viewer, achievements);
  }

  /** Speed — `viewOf` for a list: every row's achievements in one query, not one each. */
  async function viewsOf(targets: PlayerProfile[], viewer: PlayerProfile | null): Promise<PublicProfile[]> {
    if (targets.length === 0) return [];
    const achievements = await db.achievement.findMany({
      where: { playerId: { in: targets.map((t) => t.id) } },
      orderBy: { earnedAt: 'desc' },
    });
    const byPlayer = new Map<string, AchievementRow[]>();
    for (const a of achievements) byPlayer.set(a.playerId, [...(byPlayer.get(a.playerId) ?? []), a]);
    return targets.map((t) => toPublic(t, viewer, byPlayer.get(t.id) ?? []));
  }

  function toPublic(
    target: PlayerProfile,
    viewer: { id: string } | null,
    achievements: AchievementRow[],
  ): PublicProfile {
    const isOwner = viewer?.id === target.id;

    const detailsVisible =
      isOwner ||
      target.visibility === 'public' ||
      (target.visibility === 'players_only' && viewer !== null);

    return {
      id: target.id,
      // R5 — identity and competitive record are never hidden. A player who
      // enters a public draw appears in it.
      displayName: target.displayName,
      avatarPublicId: target.avatarPublicId,
      city: detailsVisible ? target.city : null,
      bio: detailsVisible ? target.bio : null,
      visibility: target.visibility,
      sports: target.sports,
      achievements: achievements.map((a) => ({
        id: a.id,
        key: a.key,
        sportId: a.sportId,
        eventId: a.eventId,
        earnedAt: a.earnedAt,
      })),
      detailsVisible,
      onboardingPendingSportIds: isOwner ? target.onboardingPendingSportIds : [],
    };
  }

  /**
   * profile R2 — at least one sport before registering. Onboarding enforces it;
   * `registration` calls this to enforce it again on the server.
   */
  async function assertHasSport(playerId: string): Promise<void> {
    const count = await db.playerSport.count({ where: { playerId } });
    if (count === 0) {
      throw new UserError(
        ProfileCode.NO_SPORT_SELECTED,
        'Choose a sport and skill level before registering.',
      );
    }
  }

  // --- mutations -------------------------------------------------------------

  /**
   * Replaces the player's sport selection. profile R3 — this writes
   * `skill_band` and nothing else; the rating columns are untouched here and
   * reachable only through applyRating (R9).
   */
  async function updateSports(
    actor: Actor,
    entries: { sportId: string; skillBand: string }[],
  ): Promise<PlayerProfile> {
    const me = await ownProfile(actor);

    for (const e of entries) {
      // Throws SPORT_NOT_FOUND for an unknown sport.
      await sport.byId(e.sportId);
      if (!(await sport.hasSkillBand(e.sportId, e.skillBand))) {
        throw new UserError(
          ProfileCode.INVALID_SKILL_BAND,
          `${e.skillBand} is not a skill level for that sport.`,
        );
      }
    }

    const keep = [...new Set(entries.map((e) => e.sportId))];

    await db.$transaction(async (tx) => {
      await tx.playerSport.deleteMany({
        where: { playerId: me.id, sportId: { notIn: keep } },
      });
      for (const e of entries) {
        await tx.playerSport.upsert({
          where: { playerId_sportId: { playerId: me.id, sportId: e.sportId } },
          create: { playerId: me.id, sportId: e.sportId, skillBand: e.skillBand },
          update: { skillBand: e.skillBand },
        });
      }
      // onboarding R6 — the sports just saved are no longer "pending an answer".
      const stillPending = me.onboardingPendingSportIds.filter((id) => !keep.includes(id));
      if (stillPending.length !== me.onboardingPendingSportIds.length) {
        await tx.playerProfile.update({
          where: { id: me.id },
          data: { onboardingPendingSportIds: stillPending },
        });
      }
      await outboxWrite(tx, {
        topic: 'profile.sports_changed',
        payload: { playerId: me.id, sportIds: keep },
      });
    });

    return byId(me.id);
  }

  /**
   * onboarding R6/R7 — records the player's multi-select before any skill is
   * known. Full replace: the Sport screen's "Continue" always submits the
   * complete current selection, and doesn't need to be called again except to
   * change that selection outright.
   */
  async function selectOnboardingSports(actor: Actor, sportIds: string[]): Promise<PlayerProfile> {
    const me = await ownProfile(actor);
    const unique = [...new Set(sportIds)];
    if (unique.length === 0) {
      throw new UserError(ProfileCode.NO_SPORT_SELECTED, 'Choose at least one sport.');
    }
    for (const id of unique) {
      await sport.byId(id); // throws SPORT_NOT_FOUND for an unknown sport
    }
    await db.playerProfile.update({
      where: { id: me.id },
      data: { onboardingPendingSportIds: unique },
    });
    return byId(me.id);
  }

  /**
   * `geo` is `geography(Point,4326)`, which Prisma models as Unsupported, so
   * the write is raw. Longitude first — ST_MakePoint takes (x, y).
   */
  async function updateLocation(
    actor: Actor,
    location: { city: string | null; geo?: { lat: number; lng: number } | null },
  ): Promise<PlayerProfile> {
    const me = await ownProfile(actor);
    const geo = location.geo ?? null;

    if (geo) {
      await db.$executeRaw`
        UPDATE player_profiles
           SET city = ${location.city},
               geo = ST_SetSRID(ST_MakePoint(${geo.lng}::double precision,
                                             ${geo.lat}::double precision), 4326)::geography,
               updated_at = now()
         WHERE id = ${me.id}::uuid
      `;
    } else {
      await db.$executeRaw`
        UPDATE player_profiles
           SET city = ${location.city}, geo = NULL, updated_at = now()
         WHERE id = ${me.id}::uuid
      `;
    }

    return byId(me.id);
  }

  /**
   * R15 — the player's own name and bio. A name is what other players see in
   * draws and lists, so it is never blank; a bio is optional and short. The
   * name lives on `users`, which only identity writes (conventions.md §1).
   */
  async function updateDetails(
    actor: Actor,
    input: { displayName?: string | null; bio?: string | null },
  ): Promise<PlayerProfile> {
    const me = await ownProfile(actor);
    const name = input.displayName == null ? null : input.displayName.trim().replace(/\s+/g, ' ');
    if (name !== null && (name.length < DISPLAY_NAME_MIN || name.length > DISPLAY_NAME_MAX)) {
      throw new UserError(
        ProfileCode.INVALID_DISPLAY_NAME,
        `Use ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters for your name.`,
      );
    }
    const bio = input.bio === undefined ? undefined : input.bio?.trim() || null;
    if (bio && bio.length > BIO_MAX) {
      throw new UserError(ProfileCode.INVALID_BIO, `Keep your bio under ${BIO_MAX} characters.`);
    }
    if (name !== null && name !== me.displayName) await users.setDisplayName(me.userId, name);
    if (bio !== undefined) await db.playerProfile.update({ where: { id: me.id }, data: { bio } });
    return byId(me.id);
  }

  async function setVisibility(actor: Actor, visibility: Visibility): Promise<PlayerProfile> {
    const me = await ownProfile(actor);
    await db.playerProfile.update({ where: { id: me.id }, data: { visibility } });
    return byId(me.id);
  }

  // --- avatar (R6, ADR 0003) -------------------------------------------------

  /**
   * profile R6 — the client uploads DIRECTLY to Cloudinary under a signature we
   * issue, and we only ever store the public_id.
   *
   * The id is namespaced to the player and carries a server-generated suffix, so
   * setAvatar's validation is structural rather than a second piece of expiring
   * state: a client cannot hand back an id pointing at somebody else's asset,
   * which is the property ADR 0003 §C2 is protecting.
   */
  async function avatarUploadSignature(actor: Actor): Promise<UploadSignature> {
    const me = await ownProfile(actor);
    return media.signUpload({ publicId: newId(), folder: media.avatarFolder(me.id) });
  }

  async function setAvatar(actor: Actor, publicId: string): Promise<PlayerProfile> {
    const me = await ownProfile(actor);
    const prefix = `${media.avatarFolder(me.id)}/`;
    const suffix = publicId.startsWith(prefix) ? publicId.slice(prefix.length) : null;

    // Without this check a client can upload under a signature we issued and
    // then report a DIFFERENT public_id (ADR 0003 §C2 — the step teams skip).
    if (suffix === null || suffix.length === 0 || suffix.includes('/')) {
      throw new UserError(
        ProfileCode.PROFILE_NOT_FOUND,
        'That upload does not belong to this profile.',
      );
    }

    const previous = me.avatarPublicId;
    await users.setAvatar(me.userId, publicId);

    // ADR 0003 §C4 — an orphaned asset is storage we are billed for and nothing
    // references. Best effort: the avatar is already switched, and a failed
    // destroy is the nightly prune job's problem, not the player's.
    if (previous && previous !== publicId) {
      await media.destroy(previous).catch(() => undefined);
    }

    return byId(me.id);
  }

  // --- played with (R10) ----------------------------------------------------

  /**
   * R10 — everyone this player shared a completed match with, most recent
   * first, from `player_match_history` (no table of its own). Like results,
   * it is activity rather than record, so R4 applies twice: nothing is listed
   * when the profile's details are withheld from the viewer, and a player the
   * viewer could not find in search is not listed either.
   */
  async function playedWith(
    playerId: string,
    opts: { viewerUserId: string | null; first: number },
  ): Promise<PlayedWith[]> {
    const first = Math.min(Math.max(opts.first, 1), 50);
    const [target, viewer] = await Promise.all([
      findById(playerId),
      opts.viewerUserId ? findByUserId(opts.viewerUserId) : null,
    ]);
    if (!target) return [];
    // Visibility needs no achievements — skip reading them.
    if (!toPublic(target, viewer, []).detailsVisible) return [];

    const visible: Visibility[] = viewer ? ['public', 'players_only'] : ['public'];
    const rows = await db.$queryRaw<{ otherId: string; matches: number; lastPlayedAt: Date }[]>`
      SELECT o.other_id AS "otherId", count(*)::int AS matches, max(h.completed_at) AS "lastPlayedAt"
        FROM player_match_history h
       CROSS JOIN LATERAL unnest(h.partner_ids || h.opponent_ids) AS o(other_id)
        JOIN player_profiles p ON p.id = o.other_id
       WHERE h.player_id = ${playerId}::uuid
         AND (p.visibility = ANY(${visible}::text[]) OR p.id = ${viewer?.id ?? null}::uuid)
       GROUP BY o.other_id
       ORDER BY "lastPlayedAt" DESC, o.other_id
       LIMIT ${first}`;

    const profiles = await db.playerProfile.findMany({
      where: { id: { in: rows.map((r) => r.otherId) } },
      include: { sports: true },
    });
    // Speed — every player's view in one batch, not one read after another.
    const views = new Map((await viewsOf(await hydrate(profiles), viewer)).map((p) => [p.id, p]));
    const out: PlayedWith[] = [];
    for (const r of rows) {
      const player = views.get(r.otherId);
      if (player) out.push({ player, matches: r.matches, lastPlayedAt: r.lastPlayedAt });
    }
    return out;
  }

  /** chat R2 — the two have played a completed match together, on either side. */
  async function havePlayedTogether(playerId: string, otherId: string): Promise<boolean> {
    const found = await db.$queryRaw<{ one: number }[]>`
      SELECT 1 AS one FROM player_match_history
       WHERE player_id = ${playerId}::uuid
         AND ${otherId}::uuid = ANY(partner_ids || opponent_ids)
       LIMIT 1`;
    return found.length > 0;
  }

  // --- achievements ----------------------------------------------------------

  /**
   * Idempotent: the unique index is (player_id, key, event_id) NULLS NOT DISTINCT.
   * `quiet` skips the push, for backfills of badges earned long ago.
   */
  async function award(
    playerId: string,
    achievement: { key: string; sportId?: string | null; eventId?: string | null },
    opts: { quiet?: boolean } = {},
  ): Promise<Achievement | null> {
    const existing = await db.achievement.findFirst({
      where: { playerId, key: achievement.key, eventId: achievement.eventId ?? null },
    });
    if (existing) return null;

    let row;
    try {
      row = await db.$transaction(async (tx) => {
        const created = await tx.achievement.create({
          data: {
            id: newId(),
            playerId,
            key: achievement.key,
            sportId: achievement.sportId ?? null,
            eventId: achievement.eventId ?? null,
          },
        });
        if (!opts.quiet) {
          await outboxWrite(tx, {
            topic: 'achievement.earned',
            payload: { playerId, key: achievement.key, achievementId: created.id },
          });
        }
        return created;
      });
    } catch (e) {
      // R13 — two triggers racing to award the same achievement. The
      // constraint decided; the loser awards nothing and emits nothing.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }

    return {
      id: row.id,
      key: row.key,
      sportId: row.sportId,
      eventId: row.eventId,
      earnedAt: row.earnedAt,
    };
  }

  /**
   * R11 — awards whatever badges this player's match history has earned and
   * they do not hold yet. Runs after every projected match; a result that is
   * later corrected does not take a badge back.
   */
  async function awardMatchBadges(playerId: string, opts: { quiet?: boolean } = {}): Promise<number> {
    const [rows, held] = await Promise.all([
      db.playerMatchHistory.findMany({
        where: { playerId },
        orderBy: [{ completedAt: 'asc' }, { matchId: 'asc' }],
        select: { won: true, sportId: true, eventId: true },
      }),
      db.achievement.findMany({ where: { playerId, eventId: null }, select: { key: true } }),
    ]);
    const have = new Set(held.map((a) => a.key));
    let awarded = 0;
    for (const badge of badgesFromHistory(rows)) {
      if (have.has(badge.key)) continue;
      if (await award(playerId, { key: badge.key, sportId: badge.sportId }, opts)) awarded += 1;
    }
    return awarded;
  }

  async function achievementsFor(playerId: string): Promise<Achievement[]> {
    const rows = await db.achievement.findMany({
      where: { playerId },
      orderBy: { earnedAt: 'desc' },
    });
    return rows.map((a) => ({
      id: a.id,
      key: a.key,
      sportId: a.sportId,
      eventId: a.eventId,
      earnedAt: a.earnedAt,
    }));
  }

  // --- stats (R8) ------------------------------------------------------------

  /**
   * profile R8 — a read of a materialised snapshot. The Home screen must not run
   * six aggregates, so nothing is computed here.
   *
   * The writer is `recordStatsSnapshot`, driven by match completion. Until
   * `scoring` lands there is nothing to materialise and this returns zeroes.
   */
  async function statsSnapshot(playerId: string, sportId: string): Promise<StatsSnapshot> {
    const row = await db.playerProfile.findUnique({
      where: { id: playerId },
      select: { stats: true },
    });
    if (!row) throw notFound();
    const doc = (row.stats ?? {}) as Record<string, unknown>;
    const bySport = (doc['bySport'] ?? {}) as Record<string, unknown>;
    const found = bySport[sportId];
    if (!found || typeof found !== 'object') return emptyStats(sportId);
    const s = found as Partial<StatsSnapshot> & { updatedAt?: string };
    return {
      ...emptyStats(sportId),
      ...s,
      updatedAt: s.updatedAt ? new Date(s.updatedAt) : null,
    };
  }

  /** Merges one sport's snapshot into the player's stats document. */
  async function recordStatsSnapshot(
    playerId: string,
    snapshot: Omit<StatsSnapshot, 'updatedAt'>,
  ): Promise<void> {
    const row = await db.playerProfile.findUnique({
      where: { id: playerId },
      select: { stats: true },
    });
    if (!row) throw notFound();
    const doc = (row.stats ?? {}) as Record<string, unknown>;
    const bySport = { ...((doc['bySport'] ?? {}) as Record<string, unknown>) };
    bySport[snapshot.sportId] = { ...snapshot, updatedAt: now().toISOString() };
    await db.playerProfile.update({
      where: { id: playerId },
      data: { stats: { ...doc, bySport } as Prisma.InputJsonValue },
    });
  }

  /** One snapshot per sport the player has selected, in selection order. */
  async function statsFor(playerId: string): Promise<StatsSnapshot[]> {
    const sports = await db.playerSport.findMany({ where: { playerId }, select: { sportId: true } });
    return Promise.all(sports.map((s) => statsSnapshot(playerId, s.sportId)));
  }

  /**
   * R8 — re-materialises one sport's snapshot from the R12 projection. Runs on
   * match completion, so a read never aggregates. `bestFinish` is not derivable
   * from match rows and is carried over from the previous snapshot.
   */
  async function refreshStats(playerId: string, sportId: string): Promise<void> {
    const rows = await db.playerMatchHistory.findMany({
      where: { playerId, sportId },
      orderBy: [{ completedAt: 'desc' }, { matchId: 'asc' }],
      select: { won: true, eventId: true },
    });
    const wins = rows.filter((r) => r.won).length;
    let currentStreak = 0;
    for (const r of rows) {
      if (!r.won) break;
      currentStreak += 1;
    }
    const previous = await statsSnapshot(playerId, sportId);
    await recordStatsSnapshot(playerId, {
      sportId,
      matchesPlayed: rows.length,
      wins,
      losses: rows.length - wins,
      winRate: rows.length === 0 ? 0 : wins / rows.length,
      currentStreak,
      tournamentsPlayed: new Set(rows.map((r) => r.eventId).filter((id) => id !== null)).size,
      bestFinish: previous.bestFinish,
    });
  }

  // --- match history (R12, R14) ----------------------------------------------

  /**
   * R12 — writes this match's rows from scratch. Idempotent, so a retried job,
   * a re-confirmed result or a correction (scoring R8) all converge on the same
   * rows. Every player who had a row or now has one gets their stats refreshed.
   */
  async function projectMatch(matchId: string): Promise<void> {
    if (!deps.matches) throw new Error('profile.projectMatch needs a MatchesPort');
    const facts = await deps.matches.factsFor(matchId);

    const before = await db.playerMatchHistory.findMany({
      where: { matchId },
      select: { playerId: true, sportId: true },
    });

    let rows: MatchHistoryRow[] = [];
    if (facts) {
      const userIds = facts.sides.flatMap((s) => s.userIds);
      const profiles = await db.playerProfile.findMany({
        where: { userId: { in: userIds } },
        select: { id: true, userId: true },
      });
      const profileOf = new Map(profiles.map((p) => [p.userId, p.id]));
      const idsOf = (side: { userIds: string[] }) =>
        side.userIds.map((u) => profileOf.get(u)).filter((id): id is string => id !== undefined);

      rows = facts.sides.flatMap((side, index) => {
        const mine = idsOf(side);
        const theirs = idsOf(facts.sides[index === 0 ? 1 : 0]);
        const won = side.registrationId === facts.winnerRegistrationId;
        const games = facts.games.map((g) =>
          index === 0 ? { for: g.a, against: g.b } : { for: g.b, against: g.a },
        );
        return mine.map((playerId) => ({
          playerId,
          matchId,
          sportId: facts.sportId,
          eventId: facts.eventId,
          partnerIds: mine.filter((id) => id !== playerId),
          opponentIds: theirs,
          won,
          outcome: facts.outcome,
          games,
          completedAt: facts.completedAt,
        }));
      });
    }

    await db.$transaction(async (tx) => {
      await tx.playerMatchHistory.deleteMany({ where: { matchId } });
      if (rows.length > 0) {
        await tx.playerMatchHistory.createMany({
          data: rows.map((r) => ({ ...r, games: r.games as Prisma.InputJsonValue })),
        });
      }
    });

    const touched = new Map<string, { playerId: string; sportId: string }>();
    for (const r of [...before, ...rows]) touched.set(`${r.playerId}|${r.sportId}`, r);
    for (const t of touched.values()) await refreshStats(t.playerId, t.sportId);
    for (const playerId of new Set(rows.map((r) => r.playerId))) await awardMatchBadges(playerId);
  }

  const encodeHistoryCursor = (r: { completedAt: Date; matchId: string }): string =>
    Buffer.from(`${r.completedAt.toISOString()}|${r.matchId}`, 'utf8').toString('base64url');

  function decodeHistoryCursor(cursor: string): { completedAt: Date; matchId: string } | null {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [at, matchId] = raw.split('|');
    const completedAt = at ? new Date(at) : null;
    if (!completedAt || Number.isNaN(completedAt.getTime()) || !matchId) return null;
    return { completedAt, matchId };
  }

  const toHistoryRow = (r: {
    playerId: string;
    matchId: string;
    sportId: string;
    eventId: string | null;
    partnerIds: string[];
    opponentIds: string[];
    won: boolean;
    outcome: string;
    games: Prisma.JsonValue;
    completedAt: Date;
  }): MatchHistoryRow => ({
    ...r,
    outcome: r.outcome as MatchHistoryOutcome,
    games: (r.games ?? []) as MatchHistoryRow['games'],
  });

  /**
   * R12 — newest first, keyset on (completed_at, match_id). Results are part of
   * the competitive record, so R5 applies: visible to every viewer, including
   * on a private profile.
   */
  async function matchHistory(
    playerId: string,
    opts: { sportId?: string | null; first: number; after?: string | null },
  ): Promise<Page<MatchHistoryRow>> {
    const cursor = opts.after ? decodeHistoryCursor(opts.after) : null;
    const found = await db.playerMatchHistory.findMany({
      where: {
        playerId,
        ...(opts.sportId ? { sportId: opts.sportId } : {}),
        ...(cursor
          ? {
              OR: [
                { completedAt: { lt: cursor.completedAt } },
                { completedAt: cursor.completedAt, matchId: { gt: cursor.matchId } },
              ],
            }
          : {}),
      },
      orderBy: [{ completedAt: 'desc' }, { matchId: 'asc' }],
      take: opts.first + 1,
    });
    const nodes = found.slice(0, opts.first).map(toHistoryRow);
    const last = nodes[nodes.length - 1];
    return {
      nodes,
      hasNextPage: found.length > opts.first,
      endCursor: last ? encodeHistoryCursor(last) : null,
    };
  }

  /** R14 — the profile's "Recent results": the first page of R12. */
  async function recentResults(playerId: string, first: number): Promise<MatchHistoryRow[]> {
    return (await matchHistory(playerId, { first })).nodes;
  }

  // --- search ----------------------------------------------------------------

  /**
   * Player search. Private profiles never appear, and players_only profiles
   * appear only to a signed-in viewer: R4's "not distinguishable from missing"
   * applies to discovery as much as to a direct read.
   *
   * Ordered and paged on (display_name, id) so the cursor stays stable when two
   * players share a name (conventions.md §4).
   */
  async function search(opts: {
    query: string;
    sportId?: string | null;
    viewerUserId?: string | null;
    first: number;
    after?: string | null;
  }): Promise<Page<PublicProfile>> {
    const first = Math.min(Math.max(opts.first, 1), 50);
    // A blank query browses every visible player, A–Z (issue log 2026-10-06 #8).
    const term = opts.query.trim();

    const visible: Visibility[] = opts.viewerUserId ? ['public', 'players_only'] : ['public'];
    const cursor = opts.after ? decodeCursor(opts.after) : null;

    const rows = await db.playerProfile.findMany({
      where: {
        visibility: { in: visible },
        ...(term ? { user: { displayName: { contains: term, mode: 'insensitive' } } } : {}),
        ...(opts.sportId ? { sports: { some: { sportId: opts.sportId } } } : {}),
        ...(cursor
          ? {
              OR: [
                { user: { displayName: { gt: cursor.displayName } } },
                { user: { displayName: cursor.displayName }, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { sports: true },
      orderBy: [{ user: { displayName: 'asc' } }, { id: 'asc' }],
      // One extra row answers hasNextPage without a second count query.
      take: first + 1,
    });

    const [hydrated, viewer] = await Promise.all([
      hydrate(rows.slice(0, first)),
      opts.viewerUserId ? findByUserId(opts.viewerUserId) : null,
    ]);
    const nodes = await viewsOf(hydrated, viewer);
    const last = hydrated.at(-1);

    return {
      nodes,
      hasNextPage: rows.length > first,
      endCursor: last ? encodeCursor(last.displayName, last.id) : null,
    };
  }

  /**
   * home R — "Players near you". No query term: same city (when known) and,
   * optionally, a shared sport. Newest profiles first, so a new signup has a
   * chance to be seen rather than the same players resurfacing forever.
   * Private profiles never appear, same as `search` (R4).
   */
  async function recommended(opts: {
    city?: string | null;
    sportId?: string | null;
    viewerUserId?: string | null;
    first: number;
  }): Promise<PublicProfile[]> {
    const first = Math.min(Math.max(opts.first, 1), 50);
    const viewer = opts.viewerUserId ? await findByUserId(opts.viewerUserId) : null;
    const visible: Visibility[] = viewer ? ['public', 'players_only'] : ['public'];

    const rows = await db.playerProfile.findMany({
      where: {
        visibility: { in: visible },
        ...(viewer ? { id: { not: viewer.id } } : {}),
        ...(opts.city ? { city: { in: cityVariants(opts.city), mode: 'insensitive' as const } } : {}),
        ...(opts.sportId ? { sports: { some: { sportId: opts.sportId } } } : {}),
      },
      include: { sports: true },
      orderBy: { createdAt: 'desc' },
      take: first,
    });

    return viewsOf(await hydrate(rows), viewer);
  }

  // --- rating (R9) -----------------------------------------------------------

  /**
   * profile R9 — the ONLY way rating columns change, called by the `rating`
   * module. There is deliberately no other write path: `updateSports` writes
   * skill_band and nothing else, and no repo method exposes these columns.
   */
  async function applyRating(
    playerId: string,
    sportId: string,
    values: { rating: number; rd: number; volatility: number; matchesPlayed: number },
  ): Promise<PlayerSport> {
    const row = await db.playerSport.update({
      where: { playerId_sportId: { playerId, sportId } },
      data: {
        rating: values.rating,
        ratingDev: values.rd,
        volatility: values.volatility,
        matchesPlayed: values.matchesPlayed,
        isProvisional: values.matchesPlayed < PROVISIONAL_MATCHES,
      },
    });
    return toPlayerSport(row);
  }

  return {
    createFor,
    byId,
    findById,
    byUserId,
    findByUserId,
    publicView,
    publicViews,
    briefById,
    briefByUserId,
    assertHasSport,
    updateSports,
    selectOnboardingSports,
    updateLocation,
    setVisibility,
    updateDetails,
    avatarUploadSignature,
    setAvatar,
    award,
    awardMatchBadges,
    achievementsFor,
    statsSnapshot,
    statsFor,
    playedWith,
    havePlayedTogether,
    projectMatch,
    matchHistory,
    historyCursor: encodeHistoryCursor,
    recentResults,
    recordStatsSnapshot,
    search,
    recommended,
    applyRating,
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
