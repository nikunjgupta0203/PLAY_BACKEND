/**
 * Geography shared by the three modules that search by radius — venues, events
 * and games.
 *
 * Coordinates are stored as `geography(Point,4326)`, which Prisma models as
 * Unsupported: every read and write of one goes through raw SQL. ST_MakePoint
 * takes (x, y), so LONGITUDE COMES FIRST. Getting that backwards puts Bengaluru
 * in the Indian Ocean and the query still returns rows, which is why it is
 * stated here once rather than remembered at each call site.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * venues R1, events R6 — an uncapped radius query is a table scan wearing a
 * filter. 50 km is further than anybody will travel for a Saturday draw.
 */
export const MAX_RADIUS_KM = 50;

export const DEFAULT_RADIUS_KM = 10;

export const kmToMetres = (km: number): number => km * 1000;

export const isValidPoint = (p: GeoPoint): boolean =>
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  p.lat >= -90 &&
  p.lat <= 90 &&
  p.lng >= -180 &&
  p.lng <= 180;

/** True when the radius exceeds the cap. The caller raises its own user error. */
export const radiusTooLarge = (km: number): boolean => !(km > 0) || km > MAX_RADIUS_KM;
