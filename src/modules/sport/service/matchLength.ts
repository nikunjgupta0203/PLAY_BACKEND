/**
 * N12 — how long one match of a format usually takes, for the scheduler when
 * the host left "minutes per match" blank. One number for every sport (45)
 * booked a T20 into a 45-minute slot and a football match into half its
 * length; this reads the format's own rule instead.
 *
 * Estimates, not promises: a match runs to its expected length (a best of 3
 * averages two and a half games), plus a changeover. The host's own number
 * always wins (F14). The app mirrors this (host/model/matchLength.ts) to show
 * the default in the wizard, so change both together.
 */

/** Used when a rule says nothing about length (a race, a scorecard) — never booked as a match anyway. */
export const FALLBACK_MATCH_MINUTES = 45;

type Rule = { kind?: unknown } & Record<string, unknown>;

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** A best-of-n to `toWin` runs, on average, about 1.5 × toWin units (exactly 1 when one unit decides it). */
const expectedUnits = (toWin: number, max: number | null = null): number => {
  if (max === 1 || toWin <= 1) return 1;
  return toWin * 1.5;
};

/** Minutes for one unit of a series, by what the unit is called. */
const UNIT_MINUTES: Record<string, number> = { frame: 25, rack: 8, map: 40, game: 25 };

function rawMinutes(rule: Rule): number | null {
  switch (rule.kind) {
    case 'rally': {
      const points = num(rule['pointsToWin'], 11);
      // ~0.8 min a point, never under 8 min a game.
      return expectedUnits(num(rule['gamesToWin'], 2)) * Math.max(8, points * 0.8) + 5;
    }
    case 'sets':
      return expectedUnits(num(rule['setsToWin'], 2)) * 35 + 5;
    case 'goals': {
      const periods = num(rule['periods'], 2);
      const minutes = num(rule['periodMinutes'], 20);
      // Breaks grow with the game: 5 min between short periods, 15 at half-time of a full match.
      const breaks = (periods - 1) * (minutes >= 30 ? 15 : 5);
      return periods * minutes + breaks + 10;
    }
    case 'innings':
      // ~4 min an over, two innings, a 20-minute break.
      return 2 * num(rule['oversPerInnings'], 20) * 4 + 20;
    case 'series': {
      const unitName = typeof rule['unitName'] === 'string' ? rule['unitName'] : 'game';
      const maxUnits = typeof rule['maxUnits'] === 'number' ? rule['maxUnits'] : null;
      return expectedUnits(num(rule['unitsToWin'], 1), maxUnits) * (UNIT_MINUTES[unitName] ?? 25) + 5;
    }
    case 'bouts':
      // Each round plus a minute's rest, and the walk-in and decision.
      return num(rule['rounds'], 3) * (num(rule['roundSeconds'], 180) / 60 + 1) + 10;
    default:
      return null;
  }
}

/** Rounded up to five minutes, between 10 minutes and 8 hours. */
export function typicalMatchMinutes(rule: unknown): number {
  const raw = rule && typeof rule === 'object' ? rawMinutes(rule as Rule) : null;
  if (raw === null) return FALLBACK_MATCH_MINUTES;
  return Math.min(480, Math.max(10, Math.ceil(raw / 5) * 5));
}
