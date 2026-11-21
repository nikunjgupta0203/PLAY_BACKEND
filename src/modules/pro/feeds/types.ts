/**
 * What every score feed is turned into before it touches a match (G1).
 * Each adapter converts its provider's JSON into these shapes; pro.updateMatch
 * still checks the JSON parts (pro R2), so a shape that doesn't fit is refused.
 */
import type { FeedHttp, FeedProvider } from '../../../platform/feeds.js';
import type { LivePatch, MomentKind, ProMatch } from '../service/index.js';

export interface FeedSide {
  /** The provider's id for the team or player. */
  ref: string;
  name: string;
  code: string;
  /** 065 — the provider's badge for the side, when it sends one (https only, see logoUrl). */
  logo?: string | null;
}

/**
 * 065 — a badge address worth showing: https, not too long, and not CricAPI's
 * generic placeholder (every team without a badge gets icon512.png). Pure.
 */
export function logoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!/^https:\/\/\S+$/i.test(v) || v.length > 500) return null;
  if (/\/icon512\.png$/i.test(v)) return null;
  return v;
}

export interface FeedMoment {
  /** Stable across polls, so a moment is written once. */
  ref: string;
  atLabel: string | null;
  kind: MomentKind;
  title: string;
  detail: string | null;
}

export interface FeedMatch {
  ref: string;
  startsAt: Date | null;
  league: string | null;
  stage: string | null;
  venueName: string | null;
  city: string | null;
  /** Needed to create the match; a live update for a known match may leave them out. */
  home: FeedSide | null;
  away: FeedSide | null;
  /** Only what the feed knows. Undefined keys leave the match as it is. */
  live: LivePatch;
  moments: FeedMoment[];
}

export interface FeedFollow {
  id: string;
  provider: FeedProvider;
  ref: string;
  sportId: string;
  name: string;
  season: string | null;
  enabled: boolean;
}

/** 2026-11-21 — today's calls so far against the daily limit (IST day), so a feed can pace itself. */
export interface FeedPace {
  used: number;
  limit: number;
}

/** A match being polled, with its sides' ids at the provider (F1 reads its two drivers' places). */
export type WatchedMatch = ProMatch & { homeRef: string | null; awayRef: string | null };

export interface ScoreAdapter {
  provider: FeedProvider;
  /** The sport this feed's matches belong to when a follow doesn't say. */
  sportSlug: string;
  /** How often a live match is refreshed (§4 call budgets). */
  pollMinutes: number;
  /**
   * 2026-11-20 — when given, decides if a live poll is due instead of the plain
   * `pollMinutes` gap (`last` is the previous poll, null if never).
   */
  due?(watch: ProMatch[], last: Date | null, now: Date, pace?: FeedPace): boolean;
  configured(): boolean;
  /**
   * One follow's fixtures for the next fortnight (and anything already under way).
   * `followed` = the refs this provider's other follows name (a catch-all follow skips them).
   */
  fixtures(follow: FeedFollow, http: FeedHttp, now: Date, followed?: ReadonlySet<string>): Promise<FeedMatch[]>;
  /** Fresh state for the watched matches. Returns only those it found. */
  live(watch: WatchedMatch[], http: FeedHttp, now: Date, pace?: FeedPace): Promise<FeedMatch[]>;
  /**
   * 2026-11-21 — after a full fixtures import: fresh state for matches the
   * polls missed (stuck at scheduled after their start, a result with no score
   * or a short scorecard). Gets pro.feedRecheckCandidates and picks from them.
   */
  recover?(candidates: ProMatch[], http: FeedHttp, now: Date): Promise<FeedMatch[]>;
}

/** A short code from a name: "Manchester City" → MCI, "FC Goa" → GOA, "India" → IND. */
export function codeFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(fc|afc|cf|sc|cfc|club|the)$/i.test(w));
  if (words.length === 0) return 'TBC';
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]!.slice(0, 2)).toUpperCase();
}

/** "2023-10-05T08:30:00" (no zone) is UTC on these feeds. */
export function utcDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const cut = (v: string | null, max: number): string | null => (v === null ? null : v.length > max ? `${v.slice(0, max - 1)}…` : v);

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}
