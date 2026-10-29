/**
 * profile R16 — a player's analytics for one sport, worked out from
 * `player_match_history`. Pure: the service reads the rows and hands them in,
 * so every number here is testable without a database.
 *
 * Days, weeks and months are IST, the only offset the app's players live in
 * (the same reasoning as rating's weekStart).
 */
export interface AnalyticsRow {
  matchId: string;
  eventId: string | null;
  partnerIds: string[];
  opponentIds: string[];
  won: boolean;
  /** A casual match that ended level. `won` is false. Absent = false. */
  drawn?: boolean;
  outcome: 'played' | 'walkover' | 'retired' | 'forfeit';
  games: { for: number; against: number }[];
  completedAt: Date;
}

export interface Tally {
  played: number;
  wins: number;
}

export interface PersonTally extends Tally {
  playerId: string;
}

export interface Analytics {
  /** Null for all time. */
  days: number | null;
  /** Start of the period; null for all time. */
  since: Date | null;
  played: number;
  wins: number;
  losses: number;
  /** Casual matches that ended level. Neither a win nor a loss. */
  draws: number;
  /** Every point (or game, or goal) scored and conceded in the period, summed over each game of each match. */
  pointsFor: number;
  pointsAgainst: number;
  /** 0-1; null when nothing in the period. */
  winRate: number | null;
  /** The same-length period before this one; null for all time or when empty. */
  previousWinRate: number | null;
  /** Positive for a run of wins, negative for losses, from the newest match back. */
  currentStreak: number;
  /** Longest run of wins ever, in this sport. */
  bestWinStreak: number;
  /** Distinct events played in the period. */
  events: number;
  /** Every match ever, in this sport — for milestones. */
  allTimeMatches: number;
  /** The last ten results ever, oldest first. True is a win. */
  form: boolean[];
  /** The same ten, as won / lost / drawn: a draw is not a loss. */
  recent: ('won' | 'lost' | 'drawn')[];
  /** The last six calendar months, oldest first, whatever the period. */
  months: (Tally & { month: string })[];
  /** Monday first; in the period. */
  weekdays: (Tally & { weekday: number })[];
  /** Matches per day over the last 13 weeks, oldest first, days with none left out. */
  activity: { date: string; matches: number }[];
  outcomes: { played: number; walkover: number; retired: number; forfeit: number };
  singles: Tally;
  doubles: Tally;
  /** Matches that went to a deciding game or set. */
  deciders: Tally;
  /** Single games won or lost by two points or fewer. */
  closeGames: Tally;
  /**
   * Games by margin, 16 buckets: lost by 8+, lost by 7 … lost by 1, won by 1 …
   * won by 7, won by 8+. A drawn game (none in any sport we score) is left out.
   */
  margins: number[];
  /** Most matches first, ties by most wins. */
  partners: PersonTally[];
  opponents: PersonTally[];
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
export const ACTIVITY_DAYS = 91;
const FORM_LENGTH = 10;
const MONTHS = 6;
const MARGIN_CAP = 8;

const ist = (at: Date) => new Date(at.getTime() + IST_OFFSET_MS);
export const istDate = (at: Date): string => ist(at).toISOString().slice(0, 10);
const istMonth = (at: Date): string => ist(at).toISOString().slice(0, 7);
/** 1 = Monday … 7 = Sunday. */
const istWeekday = (at: Date): number => ((ist(at).getUTCDay() + 6) % 7) + 1;

const rate = (wins: number, played: number): number | null => (played === 0 ? null : wins / played);

function bump(map: Map<string, PersonTally>, playerId: string, won: boolean) {
  const t = map.get(playerId) ?? { playerId, played: 0, wins: 0 };
  t.played += 1;
  if (won) t.wins += 1;
  map.set(playerId, t);
}

const ranked = (map: Map<string, PersonTally>) =>
  [...map.values()].sort((a, b) => b.played - a.played || b.wins - a.wins || a.playerId.localeCompare(b.playerId));

/** `rows` in any order; `days` null for all time. */
export function analyticsFrom(rows: AnalyticsRow[], opts: { now: Date; days: number | null }): Analytics {
  const all = [...rows].sort(
    (a, b) => a.completedAt.getTime() - b.completedAt.getTime() || a.matchId.localeCompare(b.matchId),
  );
  const nowMs = opts.now.getTime();
  const since = opts.days === null ? null : new Date(nowMs - opts.days * DAY_MS);
  const inPeriod = since ? all.filter((r) => r.completedAt >= since) : all;

  let previousWinRate: number | null = null;
  if (since && opts.days !== null) {
    const before = new Date(since.getTime() - opts.days * DAY_MS);
    const prev = all.filter((r) => r.completedAt >= before && r.completedAt < since);
    previousWinRate = rate(prev.filter((r) => r.won).length, prev.length);
  }

  let currentStreak = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i]!.drawn) break;
    const won = all[i]!.won;
    if (currentStreak === 0) currentStreak = won ? 1 : -1;
    else if (won === currentStreak > 0) currentStreak += won ? 1 : -1;
    else break;
  }

  let bestWinStreak = 0;
  let run = 0;
  for (const r of all) {
    run = r.won ? run + 1 : 0;
    bestWinStreak = Math.max(bestWinStreak, run);
  }

  // Six calendar months ending with this one.
  const thisMonth = ist(opts.now);
  const months: Analytics['months'] = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - i, 1));
    months.push({ month: d.toISOString().slice(0, 7), played: 0, wins: 0 });
  }
  const monthIndex = new Map(months.map((m, i) => [m.month, i]));
  for (const r of all) {
    const m = monthIndex.get(istMonth(r.completedAt));
    if (m === undefined) continue;
    months[m]!.played += 1;
    if (r.won) months[m]!.wins += 1;
  }

  const activityFrom = istDate(new Date(nowMs - (ACTIVITY_DAYS - 1) * DAY_MS));
  const perDay = new Map<string, number>();
  for (const r of all) {
    const day = istDate(r.completedAt);
    if (day >= activityFrom) perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const weekdays = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, played: 0, wins: 0 }));
  const outcomes = { played: 0, walkover: 0, retired: 0, forfeit: 0 };
  const singles: Tally = { played: 0, wins: 0 };
  const doubles: Tally = { played: 0, wins: 0 };
  const deciders: Tally = { played: 0, wins: 0 };
  const closeGames: Tally = { played: 0, wins: 0 };
  const margins = Array.from({ length: 2 * MARGIN_CAP }, () => 0);
  const partners = new Map<string, PersonTally>();
  const opponents = new Map<string, PersonTally>();
  const events = new Set<string>();
  let pointsFor = 0;
  let pointsAgainst = 0;

  for (const r of inPeriod) {
    const wd = weekdays[istWeekday(r.completedAt) - 1]!;
    wd.played += 1;
    if (r.won) wd.wins += 1;
    outcomes[r.outcome] += 1;
    const format = r.partnerIds.length > 0 ? doubles : singles;
    format.played += 1;
    if (r.won) format.wins += 1;
    if (r.eventId) events.add(r.eventId);

    let gamesFor = 0;
    let gamesAgainst = 0;
    for (const g of r.games) {
      pointsFor += g.for;
      pointsAgainst += g.against;
      const margin = g.for - g.against;
      if (margin === 0) continue;
      if (margin > 0) gamesFor += 1;
      else gamesAgainst += 1;
      if (Math.abs(margin) <= 2) {
        closeGames.played += 1;
        if (margin > 0) closeGames.wins += 1;
      }
      const capped = Math.min(Math.abs(margin), MARGIN_CAP);
      const bucket = margin > 0 ? MARGIN_CAP - 1 + capped : MARGIN_CAP - capped;
      margins[bucket] = (margins[bucket] ?? 0) + 1;
    }
    if (gamesFor > 0 && gamesAgainst > 0 && Math.abs(gamesFor - gamesAgainst) === 1) {
      deciders.played += 1;
      if (r.won) deciders.wins += 1;
    }

    for (const id of r.partnerIds) bump(partners, id, r.won);
    for (const id of r.opponentIds) bump(opponents, id, r.won);
  }

  const wins = inPeriod.filter((r) => r.won).length;
  const draws = inPeriod.filter((r) => r.drawn).length;
  return {
    days: opts.days,
    since,
    played: inPeriod.length,
    wins,
    losses: inPeriod.length - wins - draws,
    draws,
    pointsFor,
    pointsAgainst,
    winRate: rate(wins, inPeriod.length),
    previousWinRate,
    currentStreak,
    bestWinStreak,
    events: events.size,
    allTimeMatches: all.length,
    form: all.slice(-FORM_LENGTH).map((r) => r.won),
    recent: all.slice(-FORM_LENGTH).map((r) => (r.won ? 'won' : r.drawn ? 'drawn' : 'lost')),
    months,
    weekdays,
    activity: [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, matches]) => ({ date, matches })),
    outcomes,
    singles,
    doubles,
    deciders,
    closeGames,
    margins,
    partners: ranked(partners),
    opponents: ranked(opponents),
  };
}
