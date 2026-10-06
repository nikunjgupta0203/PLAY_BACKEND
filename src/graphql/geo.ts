/**
 * The shared geography types. `venues`, `events` and `games` all take a map
 * centre and all return a point, and three copies of the same two-field type
 * would show up in the committed SDL as GeoPoint, GeoPoint2 and GeoPoint3.
 *
 * Defined here rather than in a module's schema/ because no single module owns
 * them — the same reason `UserError` lives beside this file.
 */
import { builder } from './builder.js';
import type { GeoPoint } from '../platform/geo.js';

export const GeoPointRef = builder.objectRef<GeoPoint>('GeoPoint').implement({
  description: 'WGS-84 latitude and longitude.',
  fields: (t) => ({
    lat: t.exposeFloat('lat'),
    lng: t.exposeFloat('lng'),
  }),
});

export const GeoPointInput = builder.inputType('GeoPointInput', {
  description: 'A map centre. Paired with `radiusKm`, which is capped at 50.',
  fields: (t) => ({
    lat: t.float({ required: true }),
    lng: t.float({ required: true }),
  }),
});
