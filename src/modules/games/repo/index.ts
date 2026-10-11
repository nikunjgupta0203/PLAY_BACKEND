/**
 * games — Prisma queries and raw SQL (conventions.md §1).
 *
 * `geo` is geography(Point, 4326), which Prisma models as Unsupported: every
 * read and write of a pin goes through raw SQL (platform/geo.ts). ST_MakePoint
 * takes longitude first.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';
import { kmToMetres, type GeoPoint } from '../../../platform/geo.js';

export type StoredStatus = 'open' | 'full' | 'cancelled' | 'completed';

export interface GameRow {
  id: string;
  hostUserId: string;
  sportId: string;
  venueId: string | null;
  placeName: string | null;
  city: string;
  /** The pin, when the game is not at a listed venue. */
  location: GeoPoint | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  maxPlayers: number;
  minPlayers: number | null;
  skillBand: string | null;
  notes: string | null;
  status: StoredStatus;
  cancelReason: string | null;
  createdAt: Date;
  /** Joined players, the host first, then in the order they joined. */
  playerUserIds: string[];
  /** Set by a search with a map centre. */
  distanceKm: number | null;
}

export interface NewGame {
  id: string;
  hostUserId: string;
  sportId: string;
  venueId: string | null;
  placeName: string | null;
  city: string;
  location: GeoPoint | null;
  startsAt: Date;
  endsAt: Date;
  maxPlayers: number;
  minPlayers: number | null;
  skillBand: string | null;
  notes: string | null;
}

export interface SearchFilter {
  sportId?: string | null;
  from: Date;
  to?: Date | null;
  near?: GeoPoint | null;
  radiusKm?: number | null;
  /** Whoever is asking: games they were removed from never come back to them. */
  viewerUserId?: string | null;
  after?: { startsAt: Date; id: string } | null;
  limit: number;
}

const point = (p: GeoPoint) =>
  Prisma.sql`ST_SetSRID(ST_MakePoint(${p.lng}::double precision, ${p.lat}::double precision), 4326)::geography`;

type RawGame = Omit<GameRow, 'location' | 'playerUserIds' | 'distanceKm'> & { lat: number | null; lng: number | null };

const COLUMNS = Prisma.sql`
  g.id, g.host_user_id AS "hostUserId", g.sport_id AS "sportId", g.venue_id AS "venueId",
  g.place_name AS "placeName", g.city, g.starts_at AS "startsAt", g.ends_at AS "endsAt",
  g.timezone, g.max_players AS "maxPlayers", g.min_players AS "minPlayers",
  g.skill_band AS "skillBand", g.notes, g.status, g.cancel_reason AS "cancelReason",
  g.created_at AS "createdAt",
  ST_Y(g.geo::geometry) AS lat, ST_X(g.geo::geometry) AS lng`;

export function createGamesRepo(db: Db) {
  async function insert(tx: Tx, g: NewGame): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO games (id, host_user_id, sport_id, venue_id, geo, place_name, city, starts_at, ends_at,
                         max_players, min_players, skill_band, notes)
      VALUES (${g.id}::uuid, ${g.hostUserId}::uuid, ${g.sportId}::uuid, ${g.venueId}::uuid,
              ${g.location ? point(g.location) : Prisma.sql`NULL`}, ${g.placeName}, ${g.city},
              ${g.startsAt}, ${g.endsAt}, ${g.maxPlayers}::smallint, ${g.minPlayers}::smallint,
              ${g.skillBand}, ${g.notes})`;
    // games R1 — the host is a player from the first moment.
    await tx.gameParticipant.create({ data: { gameId: g.id, userId: g.hostUserId } });
  }

  /** Where the game is. Null venue and null pin are both written as given: the caller decides. */
  async function setPlace(
    tx: Tx,
    gameId: string,
    place: { venueId: string | null; placeName: string | null; city: string; location: GeoPoint | null },
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE games
         SET venue_id = ${place.venueId}::uuid,
             geo = ${place.location ? point(place.location) : Prisma.sql`NULL`},
             place_name = ${place.placeName},
             city = ${place.city},
             updated_at = now()
       WHERE id = ${gameId}::uuid`;
  }

  async function hydrate(rows: RawGame[], distances?: Map<string, number>): Promise<GameRow[]> {
    if (rows.length === 0) return [];
    const players = await db.gameParticipant.findMany({
      where: { gameId: { in: rows.map((r) => r.id) }, status: 'joined' },
      orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
      select: { gameId: true, userId: true },
    });
    const byGame = new Map<string, string[]>();
    for (const p of players) byGame.set(p.gameId, [...(byGame.get(p.gameId) ?? []), p.userId]);
    return rows.map(({ lat, lng, ...g }) => {
      const joined = byGame.get(g.id) ?? [];
      return {
        ...g,
        location: lat !== null && lng !== null ? { lat, lng } : null,
        // The host leads the list whatever the join timestamps say.
        playerUserIds: [...joined.filter((u) => u === g.hostUserId), ...joined.filter((u) => u !== g.hostUserId)],
        distanceKm: distances?.get(g.id) ?? null,
      };
    });
  }

  async function byIds(ids: string[]): Promise<GameRow[]> {
    if (ids.length === 0) return [];
    const rows = await db.$queryRaw<RawGame[]>`
      SELECT ${COLUMNS} FROM games g WHERE g.id = ANY(${ids}::uuid[])`;
    const found = new Map((await hydrate(rows)).map((g) => [g.id, g]));
    return ids.flatMap((id) => found.get(id) ?? []);
  }

  async function findById(id: string): Promise<GameRow | null> {
    return (await byIds([id]))[0] ?? null;
  }

  /**
   * games R2 — capacity is decided with the game row locked. Nothing is paid
   * for, so there are no holds: the lock and the count are the whole rule.
   */
  async function lock(tx: Tx, id: string): Promise<{ status: StoredStatus; maxPlayers: number; hostUserId: string; startsAt: Date; endsAt: Date } | null> {
    const rows = await tx.$queryRaw<{ status: StoredStatus; maxPlayers: number; hostUserId: string; startsAt: Date; endsAt: Date }[]>`
      SELECT status, max_players AS "maxPlayers", host_user_id AS "hostUserId", starts_at AS "startsAt", ends_at AS "endsAt"
        FROM games WHERE id = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** Discover: games nobody has cancelled that have not ended, soonest first. */
  async function search(f: SearchFilter): Promise<GameRow[]> {
    // A pin's own point, else the venue's.
    const place = Prisma.sql`COALESCE(g.geo, v.geo)`;
    const where: Prisma.Sql[] = [Prisma.sql`g.status IN ('open', 'full')`, Prisma.sql`g.ends_at > ${f.from}`];
    if (f.to) where.push(Prisma.sql`g.starts_at < ${f.to}`);
    if (f.sportId) where.push(Prisma.sql`g.sport_id = ${f.sportId}::uuid`);
    if (f.near && f.radiusKm) {
      where.push(Prisma.sql`ST_DWithin(${place}, ${point(f.near)}, ${kmToMetres(f.radiusKm)}::double precision)`);
    }
    if (f.viewerUserId) {
      where.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM game_participants x
         WHERE x.game_id = g.id AND x.user_id = ${f.viewerUserId}::uuid AND x.status = 'removed')`);
    }
    if (f.after) {
      where.push(Prisma.sql`(g.starts_at, g.id) > (${f.after.startsAt}, ${f.after.id}::uuid)`);
    }
    const distance = f.near ? Prisma.sql`ST_Distance(${place}, ${point(f.near)}) / 1000.0` : Prisma.sql`NULL::double precision`;
    const rows = await db.$queryRaw<(RawGame & { distanceKm: number | null })[]>`
      SELECT ${COLUMNS}, ${distance} AS "distanceKm"
        FROM games g
        LEFT JOIN venues v ON v.id = g.venue_id
       WHERE ${Prisma.join(where, ' AND ')}
       ORDER BY g.starts_at, g.id
       LIMIT ${f.limit}`;
    const distances = new Map(rows.flatMap((r) => (r.distanceKm === null ? [] : [[r.id, r.distanceKm] as const])));
    return hydrate(
      rows.map(({ distanceKm: _d, ...r }) => r),
      distances,
    );
  }

  /** Every game this person hosts, plays in or is invited to; newest start first. */
  async function idsForUser(userId: string, since: Date): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT g.id
        FROM games g
       WHERE g.starts_at >= ${since}
         AND (EXISTS (SELECT 1 FROM game_participants p
                       WHERE p.game_id = g.id AND p.user_id = ${userId}::uuid AND p.status = 'joined')
           OR (g.status IN ('open', 'full') AND g.ends_at > now()
               AND EXISTS (SELECT 1 FROM game_invites i WHERE i.game_id = g.id AND i.user_id = ${userId}::uuid)))
       ORDER BY g.starts_at DESC, g.id
       LIMIT 100`;
    return rows.map((r) => r.id);
  }

  return { insert, setPlace, byIds, findById, lock, search, idsForUser };
}

export type GamesRepo = ReturnType<typeof createGamesRepo>;
