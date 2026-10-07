/**
 * How a field contest is split into heats, by sport — what the app does on
 * its own when registration closes, so a host never has to.
 *
 * A number is the most a heat holds (lanes in a pool or on a track, a lifting
 * flight); the field is split into as few even heats as fit. Null is a mass
 * start or one leaderboard: everyone in one heat (a road race, a golf round).
 */
const HEAT_SIZE: Record<string, number | null> = {
  swimming: 8,
  athletics: 8,
  powerlifting: 14,
  weightlifting: 14,
  running: null,
  cycling: null,
  calisthenics: null,
  gym: null,
  golf: null,
  bowling: null,
  archery: null,
  esports: null,
};

export function heatSizeFor(sportSlug: string): number | null {
  return HEAT_SIZE[sportSlug] ?? null;
}

/** How many heats `entries` people make in this sport. Never fewer than one. */
export function heatCountFor(sportSlug: string, entries: number): number {
  const size = heatSizeFor(sportSlug);
  return size ? Math.max(1, Math.ceil(entries / size)) : 1;
}
