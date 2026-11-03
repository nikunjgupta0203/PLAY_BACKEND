/**
 * sport — which sports PL4Y offers right now (cue-sports launch, 2026-11-03).
 *
 * PL4Y launches with snooker, pool and billiards only. Every other sport stays
 * seeded, scored and resolvable (sport R3: a match played two years ago must
 * keep rendering its sport), but is hidden from every list, picker, filter and
 * discovery surface, and nothing new can be created for it.
 *
 * To bring a sport back, uncomment its slug below. Nothing else changes: no
 * migration, no data, and the app reads the list from `Query.sports`.
 */
import { isTest } from '../../../platform/config.js';

export const OFFERED_SPORT_SLUGS: readonly string[] = [
  'snooker',
  'pool',
  'billiards',
  // --- paused for the cue-sports launch — uncomment to re-enable ---
  // 'pickleball',
  // 'badminton',
  // 'table-tennis',
  // 'tennis',
  // 'football',
  // 'basketball',
  // 'volleyball',
  // 'squash',
  // 'padel',
  // 'kabaddi',
  // 'cricket',
  // 'carrom',
  // 'chess',
  // 'esports',
  // 'boxing',
  // 'mma',
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
