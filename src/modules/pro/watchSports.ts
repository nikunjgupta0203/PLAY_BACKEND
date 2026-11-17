/**
 * The sports PL4Y follows for matches, news and predictions (Floodlight,
 * founder list 2026-11-17), in the order players see them.
 *
 * Separate from the sports offered for play and booking (sport/service/
 * offered.ts, cue sports only since 2026-11-03): a watch sport shows on Home,
 * Explore, Matches, Predict and in the portal's feed, team, match and content
 * pickers, whether or not anyone can book or start a game in it.
 *
 * To add or drop a watch sport, edit this list. A new slug needs its sport row
 * first (sport/seed.ts plus a migration: production never runs the seed).
 */
export const WATCH_SPORT_SLUGS: readonly string[] = [
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
];
