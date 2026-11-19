/**
 * sport — which sports PL4Y offers right now (cue-sports launch, 2026-11-03).
 *
 * PL4Y launched with snooker, pool and billiards only. On 2026-11-19 the
 * founder opened venues and events for the sports below the cue sports.
 * Every other sport stays seeded, scored and resolvable (sport R3: a match
 * played two years ago must keep rendering its sport), but is hidden from
 * every list, picker, filter and discovery surface, and nothing new can be
 * created for it.
 *
 * To bring a sport back, uncomment its slug below. Nothing else changes: no
 * migration, no data, and the app reads the list from `Query.sports`. (The
 * five watch sports got their play settings in migration 063.)
 */
import { isTest } from '../../../platform/config.js';

export const OFFERED_SPORT_SLUGS: readonly string[] = [
  'snooker',
  'pool',
  'billiards',
  // --- opened 2026-11-19 ---
  'cricket',
  'football',
  'american-football',
  'basketball',
  'baseball',
  'ice-hockey',
  'formula-1',
  'rugby',
  'mma',
  'chess',
  'esports',
  // --- paused — uncomment to re-enable ---
  // 'pickleball',
  // 'badminton',
  // 'table-tennis',
  // 'tennis',
  // 'volleyball',
  // 'squash',
  // 'padel',
  // 'kabaddi',
  // 'carrom',
  // 'boxing',
  // 'wrestling',
  // 'karate',
  // 'taekwondo',
  // 'running',
  // 'cycling',
  // 'swimming',
  // 'athletics',
  // 'powerlifting',
  // 'weightlifting',
  // 'calisthenics',
  // 'gym',
  // 'golf',
  // 'bowling',
  // 'archery',
];

/**
 * Tests run the whole multi-sport catalogue (pickleball fixtures everywhere),
 * so the focus applies outside tests only, or when a test asks for it.
 */
let focusOverride: boolean | null = null;

export function setSportFocusForTests(on: boolean | null): void {
  focusOverride = on;
}

export function sportFocusOn(): boolean {
  if (focusOverride !== null) return focusOverride;
  return !isTest;
}

/** True when PL4Y offers this sport now. Inactive sports (sport R3) never are. */
export function isOfferedSlug(slug: string): boolean {
  return !sportFocusOn() || OFFERED_SPORT_SLUGS.includes(slug);
}
