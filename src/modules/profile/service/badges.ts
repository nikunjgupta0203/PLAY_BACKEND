/**
 * profile R11 — the badges a player's match history earns. Pure: the caller
 * reads the history and awards what comes back; `award` is idempotent, so the
 * same history can be run through as often as it changes.
 *
 * Each badge carries the sport of the match that earned it. Wins and streaks
 * count across every sport, in the order the matches finished.
 */
export interface BadgeHistoryRow {
  won: boolean;
  sportId: string;
  eventId: string | null;
}

export interface EarnedBadge {
  key: string;
  sportId: string;
}

const WIN_BADGES: Record<number, string> = { 1: 'first_win', 5: 'five_wins', 10: 'ten_wins' };
const STREAK_BADGES: Record<number, string> = { 3: 'streak_3', 5: 'streak_5' };

/** `rows` oldest first. */
export function badgesFromHistory(rows: BadgeHistoryRow[]): EarnedBadge[] {
  const earned = new Map<string, EarnedBadge>();
  const earn = (key: string | undefined, sportId: string) => {
    if (key && !earned.has(key)) earned.set(key, { key, sportId });
  };

  let wins = 0;
  let streak = 0;
  for (const r of rows) {
    if (r.eventId) earn('first_tournament', r.sportId);
    if (r.won) {
      wins += 1;
      streak += 1;
      earn(WIN_BADGES[wins], r.sportId);
      earn(STREAK_BADGES[streak], r.sportId);
    } else {
      streak = 0;
    }
  }
  return [...earned.values()];
}
