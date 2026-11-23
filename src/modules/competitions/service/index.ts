/**
 * competitions — prediction competitions played for a group (Campus
 * Prediction Cup, 2026-11-23). Migration 066.
 *
 * competitions R1 — a separate space. Its own questions, picks and points
 *   ledger; nothing here reads or writes Floodlight predictions, PL4Y points
 *   or Rankings. Free to enter: no fee, no bought points, prizes are rewards
 *   and vouchers handed out by PL4Y, never cash, and Cup points are never
 *   redeemed for anything.
 * competitions R2 — one structure for every segment. A competition names
 *   its groups (`groupNoun`: college, company, gym); the rules never ask
 *   what a group is. Campus Cup Season 1 is one row; a corporate league is
 *   another.
 * competitions R3 — membership is set once from a join code (or from the
 *   list when the competition does not need a code) and is locked for the
 *   season: one group per player per competition.
 * competitions R4 — rolling questions. Each opens `open_hours` before its
 *   event and locks when the event starts. One pick per member per question,
 *   changeable until it locks. No limit on how many questions a member
 *   answers.
 * competitions R5 — scoring. A right choice earns the question's points; an
 *   exact score earns them all, the right result with the wrong score a
 *   third (rounded down). Then × the question's multiplier (a bonus moment's
 *   ×1.5 / ×2), rounded. Settling marks every pick and writes points once,
 *   under FOR UPDATE; the ledger is unique on (competition, user, reason,
 *   ref), so a retry never double-counts.
 * competitions R6 — a question tied to a pro match settles itself from the
 *   feed's final result when its options are tagged home / draw / away (or
 *   it asks for the exact score and the score is whole numbers). Anything
 *   else waits for staff. An abandoned match voids its open questions.
 * competitions R7 — boards. Players: every member by Cup points (ties share
 *   a rank). A group: the average of its top `team_size` players, a missing
 *   slot counting 0, so a small group is ranked from day one but needs
 *   `team_size` active players (a pick in the last `active_days` days) to
 *   qualify for prizes. Specialists: the top member of each group in each
 *   sport. Movement compares against the same board a week ago.
 * competitions R8 — reminders, once each: when a sport's questions open
 *   (members who played that sport in the Cup or list it on their profile;
 *   every member for a bonus moment), and an hour before a question locks
 *   (active members who have not picked it). One push per member per run.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const CompetitionCode = {
  NOT_FOUND: 'COMPETITION_NOT_FOUND',
  CLOSED: 'COMPETITION_CLOSED',
  CODE_INVALID: 'COMPETITION_CODE_INVALID',
  CODE_REQUIRED: 'COMPETITION_CODE_REQUIRED',
  ALREADY_IN_GROUP: 'COMPETITION_ALREADY_IN_GROUP',
  NOT_MEMBER: 'COMPETITION_NOT_MEMBER',
  QUESTION_NOT_FOUND: 'COMPETITION_QUESTION_NOT_FOUND',
  NOT_OPEN: 'COMPETITION_QUESTION_NOT_OPEN',
  LOCKED: 'COMPETITION_QUESTION_LOCKED',
  INVALID_PICK: 'COMPETITION_INVALID_PICK',
  INVALID: 'COMPETITION_INVALID',
  ALREADY_SETTLED: 'COMPETITION_QUESTION_ALREADY_SETTLED',
} as const;

export const SEGMENTS = ['campus', 'corporate', 'gym', 'community', 'other'] as const;
export type Segment = (typeof SEGMENTS)[number];
export type CompetitionStatus = 'draft' | 'live' | 'ended';
export type QuestionKind = 'choice' | 'exact_score';
export type QuestionStatus = 'open' | 'settled' | 'void';
export type Outcome = 'home' | 'draw' | 'away';
export const OUTCOMES: readonly Outcome[] = ['home', 'draw', 'away'];
export type BoardKind = 'groups' | 'players' | 'my_group' | 'specialists';
export type BoardPeriod = 'season' | 'month' | 'week';
export const MAX_OPTIONS = 6;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IST_OFFSET_MS = 330 * 60_000;

export interface Prize {
  title: string;
  detail: string;
}
export interface ScoringLine {
  label: string;
  value: string;
}

export interface Competition {
  id: string;
  slug: string;
  segment: Segment;
  name: string;
  seasonLabel: string;
  tagline: string | null;
  groupNoun: string;
  groupNounPlural: string;
  startsAt: Date;
  endsAt: Date;
  status: CompetitionStatus;
  teamSize: number;
  activeDays: number;
  openHours: number;
  codeRequired: boolean;
  onHome: boolean;
  homeOrder: number;
  prizes: Prize[];
  scoring: ScoringLine[];
  finePrint: string | null;
  createdAt: Date;
}

export interface Group {
  id: string;
  competitionId: string;
  name: string;
  fullName: string | null;
  city: string | null;
  leadName: string | null;
  leadUserId: string | null;
  status: 'active' | 'hidden';
}

export interface JoinCode {
  code: string;
  competitionId: string;
  groupId: string;
  ambassadorName: string | null;
  ambassadorUserId: string | null;
  active: boolean;
}

export interface Member {
  competitionId: string;
  userId: string;
  groupId: string;
  code: string | null;
  joinedAt: Date;
}

export interface Moment {
  id: string;
  competitionId: string;
  sportId: string;
  title: string;
  subtitle: string | null;
  multiplier: number;
  startsAt: Date;
}

export interface Option {
  id: string;
  label: string;
  position: number;
  outcome: Outcome | null;
}

export interface Question {
  id: string;
  competitionId: string;
  momentId: string | null;
  sportId: string;
  matchId: string | null;
  eventLabel: string;
  kind: QuestionKind;
  prompt: string;
  points: number;
  multiplier: number;
  startsAt: Date;
  opensAt: Date;
  locksAt: Date;
  status: QuestionStatus;
  correctOptionId: string | null;
  correctHome: number | null;
  correctAway: number | null;
  suggestedOptionId: string | null;
  suggestedHome: number | null;
  suggestedAway: number | null;
  settledAt: Date | null;
  createdAt: Date;
  options: Option[];
}

export interface Pick {
  id: string;
  questionId: string;
  userId: string;
  optionId: string | null;
  home: number | null;
  away: number | null;
  correct: boolean | null;
  pointsAwarded: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Split {
  questionId: string;
  total: number;
  byOption: Map<string, number>;
}

/** One row of any board. `move`: places gained since a week ago (null: new this week, or no movement shown). */
export interface BoardRow {
  rank: number | null;
  /** A group's id, or a player's user id. */
  key: string;
  title: string;
  subtitle: string;
  score: number;
  move: number | null;
  isNew: boolean;
  isMe: boolean;
}

export interface Board {
  kind: BoardKind;
  rows: BoardRow[];
  /** Your own row when it is not in `rows` (a long players board). */
  me: BoardRow | null;
  size: number;
}

export interface GroupStanding {
  groupId: string;
  name: string;
  rank: number;
  score: number;
  /** Members with a pick in the last `active_days` days. */
  active: number;
  members: number;
  qualified: boolean;
  /** Places gained since a week ago; null when it was not on the board then. */
  move: number | null;
}

export interface Standing {
  member: Member;
  group: GroupStanding;
  /** How many groups the board ranks. */
  groups: number;
  /** The group one place up, and how far ahead it is. Null at the top. */
  ahead: { name: string; by: number } | null;
  rank: number;
  move: number | null;
  players: number;
  rankInGroup: number;
  groupPlayers: number;
  points: number;
  picks: number;
  settled: number;
  correct: number;
  /** 0–100; null before anything settles. */
  accuracy: number | null;
  sportsPlayed: number;
  /** The code to share: the one they joined with, else their group's first active code. */
  shareCode: string | null;
}

export interface CompetitionInput {
  slug: string;
  segment: Segment;
  name: string;
  seasonLabel: string;
  tagline?: string | null;
  groupNoun?: string | null;
  groupNounPlural?: string | null;
  startsAt: Date;
  endsAt: Date;
  status?: CompetitionStatus | null;
  teamSize?: number | null;
  activeDays?: number | null;
  openHours?: number | null;
  codeRequired?: boolean | null;
  onHome?: boolean | null;
  homeOrder?: number | null;
  prizes?: Prize[] | null;
  scoring?: ScoringLine[] | null;
  finePrint?: string | null;
}

export interface GroupInput {
  name: string;
  fullName?: string | null;
  city?: string | null;
  leadName?: string | null;
  leadUserId?: string | null;
  status?: 'active' | 'hidden' | null;
}

export interface MomentInput {
  sportId: string;
  title: string;
  subtitle?: string | null;
  multiplier?: number | null;
  startsAt: Date;
}

export interface QuestionInput {
  competitionId: string;
  momentId?: string | null;
  matchId?: string | null;
  sportId?: string | null;
  eventLabel?: string | null;
  kind: QuestionKind;
  prompt?: string | null;
  points?: number | null;
  multiplier?: number | null;
  startsAt?: Date | null;
  opensAt?: Date | null;
  locksAt?: Date | null;
  /** None on a choice question with a match: "Who wins?" with the two sides (and a draw where the sport has one). */
  options?: { label: string; outcome?: Outcome | null }[];
}

/** The pro match a question hangs off. */
export interface MatchInfo {
  id: string;
  sportId: string;
  sportSlug: string;
  league: string;
  stage: string | null;
  home: string;
  away: string;
  startsAt: Date;
  status: string;
}

export interface FinalResult {
  homeScore: string | null;
  awayScore: string | null;
  winner: Outcome | null;
}

export interface Reminder {
  template: 'cup.questions_open' | 'cup.locking_soon';
  userIds: string[];
  payload: Record<string, unknown>;
  slug: string;
}

export interface CompetitionsDeps {
  db: Db;
  match(matchId: string): Promise<MatchInfo | null>;
  /** Upcoming feed matches for the bulk "Who wins?" tool. */
  upcomingMatches(filter: { sportId: string | null; league: string | null; from: Date; to: Date }): Promise<MatchInfo[]>;
  notify?(r: Reminder): Promise<void>;
  now?: () => Date;
}

// --- pure helpers ----------------------------------------------------------------------

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

/** competitions R5 — what one pick earns. Pure. */
export function scorePick(
  q: Pick_<Question, 'kind' | 'points' | 'multiplier' | 'correctOptionId' | 'correctHome' | 'correctAway'>,
  p: Pick_<Pick, 'optionId' | 'home' | 'away'>,
): { correct: boolean; points: number } {
  const times = (base: number) => Math.round(base * q.multiplier);
  if (q.kind === 'exact_score') {
    if (q.correctHome === null || q.correctAway === null || p.home === null || p.away === null) return { correct: false, points: 0 };
    if (p.home === q.correctHome && p.away === q.correctAway) return { correct: true, points: times(q.points) };
    const sameResult = sign(p.home - p.away) === sign(q.correctHome - q.correctAway);
    return { correct: false, points: sameResult ? times(Math.floor(q.points / 3)) : 0 };
  }
  const correct = p.optionId !== null && p.optionId === q.correctOptionId;
  return { correct, points: correct ? times(q.points) : 0 };
}

/** What the question pays for a right answer, multiplier included. */
export const earnable = (q: Pick_<Question, 'points' | 'multiplier'>): number => Math.round(q.points * q.multiplier);

/** Dense ranks, highest first: equal scores share a rank and the next rank skips. Pure. */
export function denseRanks<T extends { key: string; score: number }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  let rank = 0;
  let last: number | null = null;
  return sorted.map((r, i) => {
    if (r.score !== last) {
      rank = i + 1;
      last = r.score;
    }
    return { ...r, rank };
  });
}

/** competitions R7 — a group's score: the sum of its top `teamSize` totals over `teamSize`, rounded. Pure. */
export function groupScore(totals: number[], teamSize: number): number {
  const top = [...totals].sort((a, b) => b - a).slice(0, teamSize);
  return Math.round(top.reduce((s, n) => s + n, 0) / Math.max(1, teamSize));
}

/** "Aarav Mehta" → "Aarav M." — boards show first names and an initial. Pure. */
export function shortName(full: string | null | undefined): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Player';
  const first = parts[0]!.slice(0, 18);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : first;
}

/** Specialist titles by sport slug; any other sport is "<Sport> Specialist". */
const SPECIALIST_TITLES: Record<string, string> = {
  cricket: 'Cricket Guru',
  football: 'Football Oracle',
  'formula-1': 'F1 Strategist',
  tennis: 'Tennis Ace',
  badminton: 'Shuttle Boss',
  basketball: 'Hoops Head',
  'american-football': 'Gridiron Brain',
  kabaddi: 'Raid Master',
  chess: 'Chess Brain',
  mma: 'Fight IQ',
  boxing: 'Fight IQ',
  golf: 'Fairway Sage',
  'ice-hockey': 'Puck Prophet',
  esports: 'Esports Insider',
};
export function specialistTitle(slug: string, name: string): string {
  return SPECIALIST_TITLES[slug] ?? `${name} Specialist`;
}

/** Sports where a level result is a real outcome. */
const DRAW_SPORTS = new Set(['football', 'chess', 'rugby', 'ice-hockey']);

/** "Who wins?" for one match: the prompt and its outcome-tagged options. Pure. */
export function winnerQuestionFor(m: Pick_<MatchInfo, 'sportSlug' | 'league' | 'stage' | 'home' | 'away'>): {
  prompt: string;
  options: { label: string; outcome: Outcome }[];
} {
  const test = m.sportSlug === 'cricket' && /\btest\b/i.test(`${m.league} ${m.stage ?? ''}`);
  const draws = DRAW_SPORTS.has(m.sportSlug) || test;
  const label = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
  return {
    prompt: m.sportSlug === 'cricket' && test ? 'What is the result?' : m.sportSlug === 'mma' || m.sportSlug === 'boxing' ? 'Who wins the fight?' : 'Who wins?',
    options: [
      { label: label(m.home), outcome: 'home' },
      ...(draws ? [{ label: 'Draw', outcome: 'draw' as Outcome }] : []),
      { label: label(m.away), outcome: 'away' },
    ],
  };
}

function wholeScore(raw: string | null): number | null {
  const v = raw?.trim() ?? '';
  return /^\d{1,3}$/.test(v) ? Number(v) : null;
}

/** competitions R6 — the answer the final result points to, or null when it can't tell. Pure. */
export function suggestAnswer(q: Pick_<Question, 'kind' | 'options'>, result: FinalResult): { optionId: string | null; home: number | null; away: number | null } | null {
  const home = wholeScore(result.homeScore);
  const away = wholeScore(result.awayScore);
  if (q.kind === 'exact_score') return home !== null && away !== null ? { optionId: null, home, away } : null;
  const winner: Outcome | null = result.winner ?? (home !== null && away !== null ? (home > away ? 'home' : home < away ? 'away' : 'draw') : null);
  if (!winner) return null;
  const match = q.options.filter((o) => o.outcome === winner);
  return match.length === 1 ? { optionId: match[0]!.id, home: null, away: null } : null;
}

/** Start of the IST calendar month an instant falls in, as a UTC instant. Pure. */
export function istMonthStart(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/** college → colleges, company → companies, branch → branches. Pure. */
export function pluralOf(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

/** A join code as typed: upper case, no spaces. Pure. */
export const normaliseCode = (raw: string): string => raw.trim().toUpperCase().replace(/\s+/g, '');

// --- row mapping ---------------------------------------------------------------------

const asPrizes = (v: Prisma.JsonValue): Prize[] =>
  Array.isArray(v)
    ? v
        .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { title: String(x.title ?? ''), detail: String(x.detail ?? '') } : null))
        .filter((x): x is Prize => !!x && x.title.length > 0)
    : [];
const asScoring = (v: Prisma.JsonValue): ScoringLine[] =>
  Array.isArray(v)
    ? v
        .map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { label: String(x.label ?? ''), value: String(x.value ?? '') } : null))
        .filter((x): x is ScoringLine => !!x && x.label.length > 0)
    : [];

type CompetitionRow = Awaited<ReturnType<Db['competition']['findFirstOrThrow']>>;
const toCompetition = (r: CompetitionRow): Competition => ({
  id: r.id,
  slug: r.slug,
  segment: r.segment as Segment,
  name: r.name,
  seasonLabel: r.seasonLabel,
  tagline: r.tagline,
  groupNoun: r.groupNoun,
  groupNounPlural: r.groupNounPlural,
  startsAt: r.startsAt,
  endsAt: r.endsAt,
  status: r.status as CompetitionStatus,
  teamSize: r.teamSize,
  activeDays: r.activeDays,
  openHours: r.openHours,
  codeRequired: r.codeRequired,
  onHome: r.onHome,
  homeOrder: r.homeOrder,
  prizes: asPrizes(r.prizes),
  scoring: asScoring(r.scoring),
  finePrint: r.finePrint,
  createdAt: r.createdAt,
});

type GroupRow = Awaited<ReturnType<Db['competitionGroup']['findFirstOrThrow']>>;
const toGroup = (r: GroupRow): Group => ({
  id: r.id,
  competitionId: r.competitionId,
  name: r.name,
  fullName: r.fullName,
  city: r.city,
  leadName: r.leadName,
  leadUserId: r.leadUserId,
  status: r.status as Group['status'],
});

type CodeRow = Awaited<ReturnType<Db['competitionCode']['findFirstOrThrow']>>;
const toCode = (r: CodeRow): JoinCode => ({
  code: r.code,
  competitionId: r.competitionId,
  groupId: r.groupId,
  ambassadorName: r.ambassadorName,
  ambassadorUserId: r.ambassadorUserId,
  active: r.active,
});

type MemberRow = Awaited<ReturnType<Db['competitionMember']['findFirstOrThrow']>>;
const toMember = (r: MemberRow): Member => ({ competitionId: r.competitionId, userId: r.userId, groupId: r.groupId, code: r.code, joinedAt: r.joinedAt });

type MomentRow = Awaited<ReturnType<Db['competitionMoment']['findFirstOrThrow']>>;
const toMoment = (r: MomentRow): Moment => ({
  id: r.id,
  competitionId: r.competitionId,
  sportId: r.sportId,
  title: r.title,
  subtitle: r.subtitle,
  multiplier: Number(r.multiplier),
  startsAt: r.startsAt,
});

type QuestionRow = Awaited<ReturnType<Db['competitionQuestion']['findFirstOrThrow']>> & {
  options: Awaited<ReturnType<Db['competitionOption']['findFirstOrThrow']>>[];
};
const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  competitionId: r.competitionId,
  momentId: r.momentId,
  sportId: r.sportId,
  matchId: r.matchId,
  eventLabel: r.eventLabel,
  kind: r.kind as QuestionKind,
  prompt: r.prompt,
  points: r.points,
  multiplier: Number(r.multiplier),
  startsAt: r.startsAt,
  opensAt: r.opensAt,
  locksAt: r.locksAt,
  status: r.status as QuestionStatus,
  correctOptionId: r.correctOptionId,
  correctHome: r.correctHome,
  correctAway: r.correctAway,
  suggestedOptionId: r.suggestedOptionId,
  suggestedHome: r.suggestedHome,
  suggestedAway: r.suggestedAway,
  settledAt: r.settledAt,
  createdAt: r.createdAt,
  options: [...r.options]
    .sort((a, b) => a.position - b.position)
    .map((o) => ({ id: o.id, label: o.label, position: o.position, outcome: (OUTCOMES as readonly string[]).includes(o.outcome ?? '') ? (o.outcome as Outcome) : null })),
});

type PickRow = Awaited<ReturnType<Db['competitionPick']['findFirstOrThrow']>>;
const toPick = (r: PickRow): Pick => ({
  id: r.id,
  questionId: r.questionId,
  userId: r.userId,
  optionId: r.optionId,
  home: r.home,
  away: r.away,
  correct: r.correct,
  pointsAwarded: r.pointsAwarded,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const invalid = (message: string) => new UserError(CompetitionCode.INVALID, message);
const trimOrNull = (s: string | null | undefined): string | null => {
  const v = s?.trim() ?? '';
  return v.length ? v : null;
};

// --- the service -----------------------------------------------------------------------

export function createCompetitionsService(deps: CompetitionsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const include = { options: true } as const;

  // --- competitions ---

  async function byId(id: string): Promise<Competition | null> {
    const r = await db.competition.findUnique({ where: { id } });
    return r ? toCompetition(r) : null;
  }

  async function bySlug(slug: string): Promise<Competition | null> {
    const r = await db.competition.findUnique({ where: { slug: slug.trim().toLowerCase() } });
    return r ? toCompetition(r) : null;
  }

  async function requireCompetition(id: string): Promise<Competition> {
    const c = await byId(id);
    if (!c) throw new UserError(CompetitionCode.NOT_FOUND, 'That competition is no longer there.');
    return c;
  }

  /** Live and still running: joinable and playable. */
  const isPlayable = (c: Competition) => c.status === 'live' && c.endsAt.getTime() > now().getTime();

  /** What Home shows at the top: live competitions on Home, joined ones first. */
  async function forHome(userId: string | null): Promise<Competition[]> {
    const rows = await db.competition.findMany({
      where: { status: 'live', onHome: true, endsAt: { gt: now() } },
      orderBy: [{ homeOrder: 'asc' }, { startsAt: 'asc' }],
    });
    const list = rows.map(toCompetition);
    if (!userId || list.length < 2) return list;
    const mine = new Set(
      (await db.competitionMember.findMany({ where: { userId, competitionId: { in: list.map((c) => c.id) } }, select: { competitionId: true } })).map((m) => m.competitionId),
    );
    return [...list.filter((c) => mine.has(c.id)), ...list.filter((c) => !mine.has(c.id))];
  }

  async function mine(userId: string): Promise<Competition[]> {
    const rows = await db.competitionMember.findMany({ where: { userId }, include: { competition: true }, orderBy: { joinedAt: 'desc' } });
    return rows.map((r) => toCompetition(r.competition));
  }

  async function staffList(): Promise<Competition[]> {
    return (await db.competition.findMany({ orderBy: [{ startsAt: 'desc' }] })).map(toCompetition);
  }

  function validateCompetition(input: CompetitionInput) {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 60) throw invalid('A slug is lower-case letters, numbers and dashes, up to 60.');
    if (!SEGMENTS.includes(input.segment)) throw invalid('Pick a segment.');
    const name = input.name.trim();
    if (name.length < 3 || name.length > 60) throw invalid('A name is 3 to 60 characters.');
    const seasonLabel = input.seasonLabel.trim();
    if (!seasonLabel || seasonLabel.length > 40) throw invalid('Give a season label, up to 40 characters.');
    if (!(input.endsAt.getTime() > input.startsAt.getTime())) throw invalid('The season ends after it starts.');
    const int = (v: number | null | undefined, lo: number, hi: number, label: string, fallback: number) => {
      const n = v ?? fallback;
      if (!Number.isInteger(n) || n < lo || n > hi) throw invalid(`${label} is ${lo} to ${hi}.`);
      return n;
    };
    const prizes = (input.prizes ?? []).map((p) => ({ title: p.title.trim(), detail: p.detail.trim() })).filter((p) => p.title);
    const scoring = (input.scoring ?? []).map((s) => ({ label: s.label.trim(), value: s.value.trim() })).filter((s) => s.label);
    if (prizes.length > 12 || scoring.length > 12) throw invalid('Up to 12 prize and 12 scoring lines.');
    return {
      slug,
      segment: input.segment,
      name,
      seasonLabel,
      tagline: trimOrNull(input.tagline),
      groupNoun: trimOrNull(input.groupNoun)?.toLowerCase() ?? 'college',
      groupNounPlural: trimOrNull(input.groupNounPlural)?.toLowerCase() ?? pluralOf(trimOrNull(input.groupNoun)?.toLowerCase() ?? 'college'),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: input.status ?? 'draft',
      teamSize: int(input.teamSize, 1, 500, 'Team size', 20),
      activeDays: int(input.activeDays, 1, 90, 'Active days', 14),
      openHours: int(input.openHours, 1, 336, 'Open hours', 24),
      codeRequired: input.codeRequired ?? true,
      onHome: input.onHome ?? true,
      homeOrder: int(input.homeOrder, -1000, 1000, 'Home order', 0),
      prizes,
      scoring,
      finePrint: trimOrNull(input.finePrint),
    };
  }

  async function saveCompetition(staffUserId: string | null, id: string | null, input: CompetitionInput): Promise<Competition> {
    const data = validateCompetition(input);
    const clash = await db.competition.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (clash && clash.id !== id) throw invalid('Another competition already uses that slug.');
    if (id) {
      await requireCompetition(id);
      return toCompetition(await db.competition.update({ where: { id }, data: { ...data, updatedAt: now() } }));
    }
    return toCompetition(await db.competition.create({ data: { id: newId(), ...data, createdBy: staffUserId } }));
  }

  // --- groups, codes, members ---

  async function group(id: string): Promise<Group | null> {
    const r = await db.competitionGroup.findUnique({ where: { id } });
    return r ? toGroup(r) : null;
  }

  /** The list behind "No code? Find your college": active groups, by name. */
  async function groups(competitionId: string, search: string | null = null, includeHidden = false): Promise<Group[]> {
    const q = search?.trim();
    const rows = await db.competitionGroup.findMany({
      where: {
        competitionId,
        ...(includeHidden ? {} : { status: 'active' }),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { fullName: { contains: q, mode: 'insensitive' } }, { city: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return rows.map(toGroup);
  }

  async function saveGroup(competitionId: string, id: string | null, input: GroupInput): Promise<Group> {
    await requireCompetition(competitionId);
    const name = input.name.trim();
    if (!name || name.length > 40) throw invalid('A short name is 1 to 40 characters.');
    const data = {
      name,
      fullName: trimOrNull(input.fullName),
      city: trimOrNull(input.city),
      leadName: trimOrNull(input.leadName),
      leadUserId: input.leadUserId ?? null,
      status: input.status ?? 'active',
    };
    const clash = await db.competitionGroup.findFirst({ where: { competitionId, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
    if (clash && clash.id !== id) throw invalid(`There is already a group called ${name}.`);
    if (id) {
      const g = await group(id);
      if (!g || g.competitionId !== competitionId) throw invalid('That group is no longer there.');
      return toGroup(await db.competitionGroup.update({ where: { id }, data }));
    }
    return toGroup(await db.competitionGroup.create({ data: { id: newId(), competitionId, ...data } }));
  }

  async function codesFor(groupId: string): Promise<JoinCode[]> {
    return (await db.competitionCode.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } })).map(toCode);
  }

  async function saveCode(input: { code: string; groupId: string; ambassadorName?: string | null; ambassadorUserId?: string | null; active?: boolean | null }): Promise<JoinCode> {
    const code = normaliseCode(input.code);
    if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/.test(code)) throw invalid('A code is 3 to 24 letters, numbers and dashes.');
    const g = await group(input.groupId);
    if (!g) throw invalid('That group is no longer there.');
    const existing = await db.competitionCode.findUnique({ where: { code } });
    if (existing && existing.groupId !== g.id) throw invalid('That code belongs to another group.');
    const data = { ambassadorName: trimOrNull(input.ambassadorName), ambassadorUserId: input.ambassadorUserId ?? null, active: input.active ?? true };
    const row = existing
      ? await db.competitionCode.update({ where: { code }, data })
      : await db.competitionCode.create({ data: { code, competitionId: g.competitionId, groupId: g.id, ...data } });
    return toCode(row);
  }

  /** What Join shows for a typed code: the group it joins. Null for an unknown or switched-off code. */
  async function previewCode(raw: string): Promise<{ code: JoinCode; group: Group; competition: Competition } | null> {
    const code = normaliseCode(raw);
    if (!code) return null;
    const row = await db.competitionCode.findUnique({ where: { code }, include: { group: true, competition: true } });
    if (!row || !row.active || row.group.status !== 'active') return null;
    return { code: toCode(row), group: toGroup(row.group), competition: toCompetition(row.competition) };
  }

  async function membership(competitionId: string, userId: string): Promise<Member | null> {
    const r = await db.competitionMember.findUnique({ where: { competitionId_userId: { competitionId, userId } } });
    return r ? toMember(r) : null;
  }

  async function memberCounts(groupIds: readonly string[]): Promise<Map<string, number>> {
    if (!groupIds.length) return new Map();
    const rows = await db.competitionMember.groupBy({ by: ['groupId'], where: { groupId: { in: [...groupIds] } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.groupId, r._count._all]));
  }

  /**
   * competitions R3 — join a group: with a code, or (when the competition does
   * not need one) a group id. Once in, the group never changes this season;
   * joining the same group again is a no-op.
   */
  async function join(userId: string, by: { code?: string | null; groupId?: string | null }): Promise<Member> {
    let competition: Competition;
    let groupId: string;
    let code: string | null = null;
    if (by.code?.trim()) {
      const found = await previewCode(by.code);
      if (!found) throw new UserError(CompetitionCode.CODE_INVALID, 'That code didn’t work. Check it with your Campus Lead.');
      competition = found.competition;
      groupId = found.group.id;
      code = found.code.code;
    } else if (by.groupId) {
      const g = await group(by.groupId);
      if (!g || g.status !== 'active') throw new UserError(CompetitionCode.NOT_FOUND, 'That group is no longer there.');
      competition = await requireCompetition(g.competitionId);
      if (competition.codeRequired) throw new UserError(CompetitionCode.CODE_REQUIRED, `Ask your ${competition.groupNoun}’s lead for the code to join.`);
      groupId = g.id;
    } else {
      throw new UserError(CompetitionCode.CODE_INVALID, 'Type your code.');
    }
    if (!isPlayable(competition)) throw new UserError(CompetitionCode.CLOSED, `${competition.name} isn’t open to join right now.`);
    const existing = await membership(competition.id, userId);
    if (existing) {
      if (existing.groupId === groupId) return existing;
      throw new UserError(CompetitionCode.ALREADY_IN_GROUP, `You already play for another ${competition.groupNoun} this season.`);
    }
    try {
      const row = await db.competitionMember.create({ data: { competitionId: competition.id, userId, groupId, code, joinedAt: now() } });
      return toMember(row);
    } catch (e) {
      // A double tap: the first join won.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await membership(competition.id, userId);
        if (won?.groupId === groupId) return won;
        throw new UserError(CompetitionCode.ALREADY_IN_GROUP, `You already play for another ${competition.groupNoun} this season.`);
      }
      throw e;
    }
  }

  async function staffMembers(competitionId: string, opts: { groupId?: string | null; first?: number } = {}) {
    const rows = await db.competitionMember.findMany({
      where: { competitionId, ...(opts.groupId ? { groupId: opts.groupId } : {}) },
      orderBy: { joinedAt: 'desc' },
      take: Math.min(opts.first ?? 200, 1000),
    });
    return rows.map(toMember);
  }

  // --- moments ---

  async function moments(competitionId: string, opts: { upcomingOnly?: boolean } = {}): Promise<Moment[]> {
    const rows = await db.competitionMoment.findMany({
      where: { competitionId, ...(opts.upcomingOnly ? { startsAt: { gt: new Date(now().getTime() - 6 * HOUR) } } : {}) },
      orderBy: { startsAt: 'asc' },
      take: 100,
    });
    return rows.map(toMoment);
  }

  async function moment(id: string): Promise<Moment | null> {
    const r = await db.competitionMoment.findUnique({ where: { id } });
    return r ? toMoment(r) : null;
  }

  function validMultiplier(m: number | null | undefined, fallback: number): number {
    const v = m ?? fallback;
    if (!Number.isFinite(v) || v < 1 || v > 5 || Math.round(v * 10) !== v * 10) throw invalid('A multiplier is 1 to 5, in steps of 0.1.');
    return v;
  }

  async function saveMoment(competitionId: string, id: string | null, input: MomentInput): Promise<Moment> {
    await requireCompetition(competitionId);
    const title = input.title.trim();
    if (title.length < 2 || title.length > 60) throw invalid('A title is 2 to 60 characters.');
    if (Number.isNaN(input.startsAt.getTime())) throw invalid('Give a start time.');
    const data = { sportId: input.sportId, title, subtitle: trimOrNull(input.subtitle), multiplier: validMultiplier(input.multiplier, 1.5), startsAt: input.startsAt };
    if (id) {
      const m = await moment(id);
      if (!m || m.competitionId !== competitionId) throw invalid('That moment is no longer there.');
      const row = await db.$transaction(async (tx) => {
        const updated = await tx.competitionMoment.update({ where: { id }, data });
        // Open questions follow their moment's multiplier; settled ones keep what they paid.
        await tx.competitionQuestion.updateMany({ where: { momentId: id, status: 'open' }, data: { multiplier: data.multiplier, updatedAt: now() } });
        return updated;
      });
      return toMoment(row);
    }
    return toMoment(await db.competitionMoment.create({ data: { id: newId(), competitionId, ...data } }));
  }

  async function deleteMoment(id: string): Promise<boolean> {
    const m = await moment(id);
    if (!m) return false;
    await db.$transaction(async (tx) => {
      await tx.competitionQuestion.updateMany({ where: { momentId: id, status: 'open' }, data: { multiplier: 1, momentId: null, updatedAt: now() } });
      await tx.competitionQuestion.updateMany({ where: { momentId: id }, data: { momentId: null } });
      await tx.competitionMoment.delete({ where: { id } });
    });
    return true;
  }

  // --- questions ---

  async function question(id: string): Promise<Question | null> {
    const r = await db.competitionQuestion.findUnique({ where: { id }, include });
    return r ? toQuestion(r) : null;
  }

  async function questionsByIds(ids: readonly string[]): Promise<Map<string, Question>> {
    if (!ids.length) return new Map();
    const rows = await db.competitionQuestion.findMany({ where: { id: { in: [...ids] } }, include });
    return new Map(rows.map((r) => [r.id, toQuestion(r)]));
  }

  /** competitions R4 — open now: past `opens_at`, before `locks_at`. Soonest to lock first. */
  async function openQuestions(competitionId: string, opts: { sportId?: string | null; first?: number } = {}): Promise<Question[]> {
    const t = now();
    const rows = await db.competitionQuestion.findMany({
      where: { competitionId, status: 'open', opensAt: { lte: t }, locksAt: { gt: t }, ...(opts.sportId ? { sportId: opts.sportId } : {}) },
      include,
      orderBy: [{ locksAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(opts.first ?? 50, 200),
    });
    return rows.map(toQuestion);
  }

  /** Not open yet: the "Opening soon" list, soonest first. */
  async function upcomingQuestions(competitionId: string, opts: { withinDays?: number; first?: number } = {}): Promise<Question[]> {
    const t = now();
    const rows = await db.competitionQuestion.findMany({
      where: { competitionId, status: 'open', opensAt: { gt: t, lte: new Date(t.getTime() + (opts.withinDays ?? 14) * DAY) } },
      include,
      orderBy: [{ opensAt: 'asc' }],
      take: Math.min(opts.first ?? 60, 200),
    });
    return rows.map(toQuestion);
  }

  async function openSummary(competitionId: string): Promise<{ questions: number; sports: number; next: Question | null }> {
    const t = now();
    const where = { competitionId, status: 'open', opensAt: { lte: t }, locksAt: { gt: t } };
    const [count, sports, next] = await Promise.all([
      db.competitionQuestion.count({ where }),
      db.competitionQuestion.findMany({ where, distinct: ['sportId'], select: { sportId: true } }),
      db.competitionQuestion.findFirst({ where, include, orderBy: [{ locksAt: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    return { questions: count, sports: sports.length, next: next ? toQuestion(next) : null };
  }

  /** The sports with open or upcoming questions: the Cup's sport chips. */
  async function sportsInPlay(competitionId: string): Promise<string[]> {
    const t = now();
    const rows = await db.competitionQuestion.findMany({
      where: { competitionId, status: 'open', locksAt: { gt: t } },
      distinct: ['sportId'],
      select: { sportId: true },
    });
    return rows.map((r) => r.sportId);
  }

  async function staffQuestions(competitionId: string, opts: { status?: QuestionStatus | null; first?: number } = {}): Promise<Question[]> {
    const rows = await db.competitionQuestion.findMany({
      where: { competitionId, ...(opts.status ? { status: opts.status } : {}) },
      include,
      orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(opts.first ?? 200, 500),
    });
    return rows.map(toQuestion);
  }

  async function splits(questionIds: readonly string[]): Promise<Map<string, Split>> {
    const out = new Map<string, Split>();
    if (!questionIds.length) return out;
    const rows = await db.competitionPick.groupBy({ by: ['questionId', 'optionId'], where: { questionId: { in: [...questionIds] } }, _count: { _all: true } });
    for (const r of rows) {
      const s = out.get(r.questionId) ?? { questionId: r.questionId, total: 0, byOption: new Map() };
      s.total += r._count._all;
      if (r.optionId) s.byOption.set(r.optionId, (s.byOption.get(r.optionId) ?? 0) + r._count._all);
      out.set(r.questionId, s);
    }
    return out;
  }

  async function picksFor(userId: string, questionIds: readonly string[]): Promise<Map<string, Pick>> {
    if (!questionIds.length) return new Map();
    const rows = await db.competitionPick.findMany({ where: { userId, questionId: { in: [...questionIds] } } });
    return new Map(rows.map((r) => [r.questionId, toPick(r)]));
  }

  async function createQuestion(staffUserId: string | null, input: QuestionInput): Promise<Question> {
    const c = await requireCompetition(input.competitionId);
    let match: MatchInfo | null = null;
    if (input.matchId) {
      match = await deps.match(input.matchId);
      if (!match) throw invalid('That match is no longer there.');
    }
    const sportId = match?.sportId ?? input.sportId ?? null;
    if (!sportId) throw invalid('Pick a sport or a match.');
    if (input.kind !== 'choice' && input.kind !== 'exact_score') throw invalid('A question is a choice or an exact score.');
    let m: Moment | null = null;
    if (input.momentId) {
      m = await moment(input.momentId);
      if (!m || m.competitionId !== c.id) throw invalid('That bonus moment is no longer there.');
    }
    const startsAt = input.startsAt ?? match?.startsAt ?? m?.startsAt ?? null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) throw invalid('Give the event’s start time.');
    const locksAt = input.locksAt ?? startsAt;
    const opensAt = input.opensAt ?? new Date(startsAt.getTime() - c.openHours * HOUR);
    if (!(opensAt.getTime() < locksAt.getTime())) throw invalid('A question opens before it locks.');
    if (locksAt.getTime() <= now().getTime()) throw invalid('That event has already started.');
    const eventLabel = trimOrNull(input.eventLabel) ?? (match ? `${match.league} · ${match.home} v ${match.away}` : m?.title ?? null);
    if (!eventLabel || eventLabel.length > 120) throw invalid('Name the event, up to 120 characters.');

    let options = (input.options ?? []).map((o) => ({ label: o.label.trim(), outcome: o.outcome ?? null })).filter((o) => o.label.length > 0);
    let prompt = trimOrNull(input.prompt);
    if (input.kind === 'choice' && !options.length && match) {
      const auto = winnerQuestionFor(match);
      options = auto.options;
      prompt = prompt ?? auto.prompt;
    }
    if (input.kind === 'exact_score') {
      options = [];
      prompt = prompt ?? 'Call the exact score';
    }
    if (!prompt || prompt.length < 3 || prompt.length > 200) throw invalid('A question is 3 to 200 characters.');
    if (input.kind === 'choice') {
      if (options.length < 2 || options.length > MAX_OPTIONS) throw invalid(`A choice question has 2 to ${MAX_OPTIONS} options.`);
      if (options.some((o) => o.label.length > 60)) throw invalid('An option is up to 60 characters.');
      if (options.some((o) => o.outcome !== null && !OUTCOMES.includes(o.outcome))) throw invalid('An option’s result is home, draw or away.');
      if (options.some((o) => o.outcome !== null) && !match) throw invalid('Only a question on a match can tie options to the result.');
    }
    const points = input.points ?? (input.kind === 'exact_score' ? 25 : 10);
    if (!Number.isInteger(points) || points < 1 || points > 500) throw invalid('Points are 1 to 500.');
    const multiplier = validMultiplier(input.multiplier, m?.multiplier ?? 1);

    const id = newId();
    await db.competitionQuestion.create({
      data: {
        id,
        competitionId: c.id,
        momentId: m?.id ?? null,
        sportId,
        matchId: match?.id ?? null,
        eventLabel,
        kind: input.kind,
        prompt,
        points,
        multiplier,
        startsAt,
        opensAt,
        locksAt,
        createdBy: staffUserId,
        options: { create: options.map((o, i) => ({ id: newId(), label: o.label, position: i, outcome: o.outcome })) },
      },
    });
    return (await question(id))!;
  }

  async function requireQuestion(id: string): Promise<Question> {
    const q = await question(id);
    if (!q) throw new UserError(CompetitionCode.QUESTION_NOT_FOUND, 'That question is no longer there.');
    return q;
  }

  async function updateQuestion(id: string, patch: { prompt?: string; eventLabel?: string; points?: number; opensAt?: Date; locksAt?: Date; multiplier?: number }): Promise<Question> {
    const q = await requireQuestion(id);
    if (q.status !== 'open') throw new UserError(CompetitionCode.ALREADY_SETTLED, 'Only an open question can change.');
    const data: Prisma.CompetitionQuestionUpdateInput = { updatedAt: now() };
    if (patch.prompt !== undefined) {
      const p = patch.prompt.trim();
      if (p.length < 3 || p.length > 200) throw invalid('A question is 3 to 200 characters.');
      data.prompt = p;
    }
    if (patch.eventLabel !== undefined) {
      const e = patch.eventLabel.trim();
      if (!e || e.length > 120) throw invalid('Name the event, up to 120 characters.');
      data.eventLabel = e;
    }
    if (patch.points !== undefined) {
      if (!Number.isInteger(patch.points) || patch.points < 1 || patch.points > 500) throw invalid('Points are 1 to 500.');
      data.points = patch.points;
    }
    if (patch.multiplier !== undefined) data.multiplier = validMultiplier(patch.multiplier, 1);
    const opensAt = patch.opensAt ?? q.opensAt;
    const locksAt = patch.locksAt ?? q.locksAt;
    if (!(opensAt.getTime() < locksAt.getTime())) throw invalid('A question opens before it locks.');
    if (patch.opensAt) data.opensAt = patch.opensAt;
    if (patch.locksAt) data.locksAt = patch.locksAt;
    await db.competitionQuestion.update({ where: { id }, data });
    return (await question(id))!;
  }

  /**
   * The question-writers' bulk tool: a "Who wins?" on every upcoming feed
   * match in a window (a sport, optionally one league), skipping matches the
   * competition already has a question on.
   */
  async function addWinnerQuestions(staffUserId: string | null, competitionId: string, opts: { sportId: string | null; league: string | null; days: number; points?: number | null; momentId?: string | null }): Promise<number> {
    const c = await requireCompetition(competitionId);
    const days = Math.min(Math.max(1, Math.round(opts.days)), 14);
    const from = new Date(now().getTime() + 10 * 60_000);
    const matches = await deps.upcomingMatches({ sportId: opts.sportId, league: trimOrNull(opts.league), from, to: new Date(from.getTime() + days * DAY) });
    if (!matches.length) return 0;
    const taken = new Set(
      (await db.competitionQuestion.findMany({ where: { competitionId: c.id, matchId: { in: matches.map((m) => m.id) } }, select: { matchId: true } })).map((r) => r.matchId),
    );
    let made = 0;
    for (const m of matches) {
      if (taken.has(m.id)) continue;
      try {
        await createQuestion(staffUserId, { competitionId: c.id, matchId: m.id, kind: 'choice', points: opts.points ?? 10, momentId: opts.momentId ?? null });
        made += 1;
      } catch {
        // A match that changed under us: skip it, the next run looks again.
      }
    }
    return made;
  }

  // --- picks ---

  async function pick(userId: string, questionId: string, answer: { optionId?: string | null; home?: number | null; away?: number | null }): Promise<Pick> {
    const q = await requireQuestion(questionId);
    const c = await requireCompetition(q.competitionId);
    const member = await membership(c.id, userId);
    if (!member) throw new UserError(CompetitionCode.NOT_MEMBER, `Join ${c.name} to answer its questions.`);
    if (!isPlayable(c)) throw new UserError(CompetitionCode.CLOSED, `${c.name} has finished.`);
    const t = now().getTime();
    if (q.opensAt.getTime() > t) throw new UserError(CompetitionCode.NOT_OPEN, 'This question isn’t open yet.');
    if (q.status !== 'open' || q.locksAt.getTime() <= t) throw new UserError(CompetitionCode.LOCKED, 'Picks are locked for this question.');
    let data: { optionId: string | null; home: number | null; away: number | null };
    if (q.kind === 'exact_score') {
      const ok = (n: number | null | undefined): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 999;
      if (!ok(answer.home) || !ok(answer.away)) throw new UserError(CompetitionCode.INVALID_PICK, 'Give a score for both sides.');
      data = { optionId: null, home: answer.home, away: answer.away };
    } else {
      if (!answer.optionId || !q.options.some((o) => o.id === answer.optionId)) throw new UserError(CompetitionCode.INVALID_PICK, 'Pick one of the options.');
      data = { optionId: answer.optionId, home: null, away: null };
    }
    // FOR SHARE waits for a settle in flight, then re-checks: a pick never lands after marking.
    const row = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; locks_at: Date }[]>`
        SELECT status, locks_at FROM competition_questions WHERE id = ${questionId}::uuid FOR SHARE`;
      const current = locked[0];
      if (!current) throw new UserError(CompetitionCode.QUESTION_NOT_FOUND, 'That question is no longer there.');
      if (current.status !== 'open' || current.locks_at.getTime() <= now().getTime()) throw new UserError(CompetitionCode.LOCKED, 'Picks are locked for this question.');
      return tx.competitionPick.upsert({
        where: { questionId_userId: { questionId, userId } },
        create: { id: newId(), questionId, competitionId: c.id, userId, ...data, createdAt: now(), updatedAt: now() },
        update: { ...data, updatedAt: now() },
      });
    });
    return toPick(row);
  }

  // --- settling (competitions R5, R6) ---

  async function settle(staffUserId: string | null, questionId: string, answer: { optionId?: string | null; home?: number | null; away?: number | null }): Promise<Question> {
    await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM competition_questions WHERE id = ${questionId}::uuid FOR UPDATE`;
      if (!locked[0]) throw new UserError(CompetitionCode.QUESTION_NOT_FOUND, 'That question is no longer there.');
      if (locked[0].status !== 'open') throw new UserError(CompetitionCode.ALREADY_SETTLED, 'That question is already settled or void.');
      const q = toQuestion(await tx.competitionQuestion.findUniqueOrThrow({ where: { id: questionId }, include }));
      const correct =
        q.kind === 'exact_score' ? { optionId: null, home: answer.home ?? null, away: answer.away ?? null } : { optionId: answer.optionId ?? null, home: null, away: null };
      if (q.kind === 'exact_score') {
        const ok = (n: number | null) => n !== null && Number.isInteger(n) && n >= 0 && n <= 999;
        if (!ok(correct.home) || !ok(correct.away)) throw invalid('Give the final score for both sides.');
      } else if (!correct.optionId || !q.options.some((o) => o.id === correct.optionId)) {
        throw invalid('Pick the right option.');
      }
      const settledAt = now();
      const final = { ...q, correctOptionId: correct.optionId, correctHome: correct.home, correctAway: correct.away };
      const picks = await tx.competitionPick.findMany({ where: { questionId } });
      const groups = new Map(
        (await tx.competitionMember.findMany({ where: { competitionId: q.competitionId, userId: { in: picks.map((p) => p.userId) } }, select: { userId: true, groupId: true } })).map((m) => [
          m.userId,
          m.groupId,
        ]),
      );
      const points: Prisma.CompetitionPointCreateManyInput[] = [];
      for (const p of picks) {
        const s = scorePick(final, p);
        await tx.competitionPick.update({ where: { id: p.id }, data: { correct: s.correct, pointsAwarded: s.points, updatedAt: settledAt } });
        const groupId = groups.get(p.userId);
        if (s.points > 0 && groupId) {
          points.push({ id: newId(), competitionId: q.competitionId, userId: p.userId, groupId, sportId: q.sportId, points: s.points, reason: 'pick', ref: p.id, createdAt: settledAt });
        }
      }
      if (points.length) await tx.competitionPoint.createMany({ data: points, skipDuplicates: true });
      await tx.competitionQuestion.update({
        where: { id: questionId },
        data: { status: 'settled', correctOptionId: correct.optionId, correctHome: correct.home, correctAway: correct.away, settledAt, settledBy: staffUserId, updatedAt: settledAt },
      });
    });
    return (await question(questionId))!;
  }

  async function voidQuestion(questionId: string): Promise<Question> {
    const q = await requireQuestion(questionId);
    if (q.status !== 'open') throw new UserError(CompetitionCode.ALREADY_SETTLED, 'That question is already settled or void.');
    await db.competitionQuestion.update({ where: { id: questionId }, data: { status: 'void', updatedAt: now() } });
    return (await question(questionId))!;
  }

  /** competitions R6 — on a finished match: suggest every open question's answer and settle those it can tell. */
  async function settleFromMatch(matchId: string, result: FinalResult): Promise<{ suggested: number; settled: number }> {
    const open = await db.competitionQuestion.findMany({ where: { matchId, status: 'open' }, include });
    let suggested = 0;
    let settled = 0;
    for (const row of open) {
      const q = toQuestion(row);
      const answer = suggestAnswer(q, result);
      await db.competitionQuestion.update({
        where: { id: q.id },
        data: { suggestedOptionId: answer?.optionId ?? null, suggestedHome: answer?.home ?? null, suggestedAway: answer?.away ?? null },
      });
      if (!answer) continue;
      suggested += 1;
      try {
        await settle(null, q.id, answer);
        settled += 1;
      } catch {
        // Settled or voided by staff a moment ago.
      }
    }
    return { suggested, settled };
  }

  async function voidOpenForMatch(matchId: string): Promise<number> {
    const { count } = await db.competitionQuestion.updateMany({ where: { matchId, status: 'open' }, data: { status: 'void', updatedAt: now() } });
    return count;
  }

  // --- boards (competitions R7) ---

  function periodStart(c: Competition, period: BoardPeriod): Date {
    if (period === 'month') return istMonthStart(now());
    if (period === 'week') return new Date(now().getTime() - 7 * DAY);
    return new Date(0);
  }

  /** Every member's total in [since, until], with their group. Members with nothing count 0. */
  async function memberTotals(competitionId: string, since: Date, until: Date): Promise<{ userId: string; groupId: string; points: number; joinedAt: Date }[]> {
    const rows = await db.$queryRaw<{ user_id: string; group_id: string; points: number; joined_at: Date }[]>`
      SELECT m.user_id, m.group_id, m.joined_at,
             COALESCE(SUM(p.points) FILTER (WHERE p.created_at >= ${since} AND p.created_at <= ${until}), 0)::int AS points
        FROM competition_members m
        JOIN competition_groups g ON g.id = m.group_id AND g.status = 'active'
        LEFT JOIN competition_points p ON p.competition_id = m.competition_id AND p.user_id = m.user_id
       WHERE m.competition_id = ${competitionId}::uuid AND m.joined_at <= ${until}
       GROUP BY m.user_id, m.group_id, m.joined_at`;
    return rows.map((r) => ({ userId: r.user_id, groupId: r.group_id, points: r.points, joinedAt: r.joined_at }));
  }

  async function activeCounts(c: Competition): Promise<Map<string, number>> {
    const since = new Date(now().getTime() - c.activeDays * DAY);
    const rows = await db.$queryRaw<{ group_id: string; active: number }[]>`
      SELECT m.group_id, COUNT(DISTINCT m.user_id)::int AS active
        FROM competition_members m
        JOIN competition_picks pk ON pk.competition_id = m.competition_id AND pk.user_id = m.user_id AND pk.created_at >= ${since}
       WHERE m.competition_id = ${c.id}::uuid
       GROUP BY m.group_id`;
    return new Map(rows.map((r) => [r.group_id, r.active]));
  }

  function rankGroups(c: Competition, totals: { groupId: string; points: number }[]): Map<string, { score: number; rank: number; members: number }> {
    const byGroup = new Map<string, number[]>();
    for (const t of totals) byGroup.set(t.groupId, [...(byGroup.get(t.groupId) ?? []), t.points]);
    const ranked = denseRanks([...byGroup.entries()].map(([key, pts]) => ({ key, score: groupScore(pts, c.teamSize), members: pts.length })));
    return new Map(ranked.map((r) => [r.key, { score: r.score, rank: r.rank, members: r.members }]));
  }

  async function groupStandings(c: Competition, period: BoardPeriod = 'season'): Promise<GroupStanding[]> {
    const t = now();
    const weekAgo = new Date(t.getTime() - 7 * DAY);
    const since = periodStart(c, period);
    const [current, before, active, names] = await Promise.all([
      memberTotals(c.id, since, t),
      period === 'season' ? memberTotals(c.id, since, weekAgo) : Promise.resolve(null),
      activeCounts(c),
      db.competitionGroup.findMany({ where: { competitionId: c.id, status: 'active' }, select: { id: true, name: true } }),
    ]);
    const nameOf = new Map(names.map((g) => [g.id, g.name]));
    const now_ = rankGroups(c, current);
    const then = before ? rankGroups(c, before) : null;
    return [...now_.entries()]
      .map(([groupId, g]) => {
        const was = then?.get(groupId);
        const a = active.get(groupId) ?? 0;
        return {
          groupId,
          name: nameOf.get(groupId) ?? '',
          rank: g.rank,
          score: g.score,
          active: a,
          members: g.members,
          qualified: a >= c.teamSize,
          move: was ? was.rank - g.rank : null,
        };
      })
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  async function namesOf(userIds: readonly string[]): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const rows = await db.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true } });
    return new Map(rows.map((r) => [r.id, shortName(r.displayName)]));
  }

  /** Per group and sport, the top two members by Cup points in that sport. */
  async function sportLeaders(competitionId: string, groupId: string | null): Promise<{ groupId: string; sportId: string; userId: string; points: number; place: number }[]> {
    const rows = await db.$queryRaw<{ group_id: string; sport_id: string; user_id: string; points: number; place: number }[]>`
      WITH s AS (
        SELECT m.group_id, p.sport_id, p.user_id, SUM(p.points)::int AS points
          FROM competition_points p
          JOIN competition_members m ON m.competition_id = p.competition_id AND m.user_id = p.user_id
         WHERE p.competition_id = ${competitionId}::uuid AND p.sport_id IS NOT NULL
           AND (${groupId}::uuid IS NULL OR m.group_id = ${groupId}::uuid)
         GROUP BY m.group_id, p.sport_id, p.user_id
      )
      SELECT group_id, sport_id, user_id, points, place::int FROM (
        SELECT s.*, row_number() OVER (PARTITION BY group_id, sport_id ORDER BY points DESC, user_id) AS place FROM s
      ) x WHERE place <= 2`;
    return rows.map((r) => ({ groupId: r.group_id, sportId: r.sport_id, userId: r.user_id, points: r.points, place: r.place }));
  }

  async function sportsById(ids: readonly string[]): Promise<Map<string, { slug: string; name: string }>> {
    if (!ids.length) return new Map();
    const rows = await db.sport.findMany({ where: { id: { in: [...ids] } }, select: { id: true, slug: true, name: true } });
    return new Map(rows.map((r) => [r.id, { slug: r.slug, name: r.name }]));
  }

  /** userId → the specialist titles they hold in their group. */
  async function titlesOf(competitionId: string): Promise<Map<string, string>> {
    const leaders = (await sportLeaders(competitionId, null)).filter((l) => l.place === 1);
    const sports = await sportsById([...new Set(leaders.map((l) => l.sportId))]);
    const out = new Map<string, string>();
    for (const l of leaders.sort((a, b) => b.points - a.points)) {
      if (out.has(l.userId)) continue;
      const s = sports.get(l.sportId);
      if (s) out.set(l.userId, specialistTitle(s.slug, s.name));
    }
    return out;
  }

  async function board(competitionId: string, userId: string | null, kind: BoardKind, opts: { period?: BoardPeriod; first?: number } = {}): Promise<Board> {
    const c = await requireCompetition(competitionId);
    const period = opts.period ?? 'season';
    const first = Math.min(Math.max(1, opts.first ?? 50), 200);
    const me = userId ? await membership(c.id, userId) : null;

    if (kind === 'groups') {
      const standings = await groupStandings(c, period);
      const cities = new Map((await db.competitionGroup.findMany({ where: { id: { in: standings.map((s) => s.groupId) } }, select: { id: true, city: true } })).map((g) => [g.id, g.city]));
      const rows: BoardRow[] = standings.map((s) => ({
        rank: s.rank,
        key: s.groupId,
        title: s.name,
        subtitle: s.qualified ? `${s.active} active${cities.get(s.groupId) ? ` · ${cities.get(s.groupId)}` : ''}` : `${s.active} active · needs ${c.teamSize - s.active} more`,
        score: s.score,
        move: s.move,
        isNew: s.move === null && period === 'season',
        isMe: me?.groupId === s.groupId,
      }));
      return { kind, rows: rows.slice(0, first), me: rows.slice(first).find((r) => r.isMe) ?? null, size: rows.length };
    }

    if (kind === 'specialists') {
      if (!me) return { kind, rows: [], me: null, size: 0 };
      const [leaders, sportIds] = await Promise.all([sportLeaders(c.id, me.groupId), db.competitionQuestion.findMany({ where: { competitionId: c.id }, distinct: ['sportId'], select: { sportId: true } })]);
      const ids = [...new Set([...sportIds.map((s) => s.sportId), ...leaders.map((l) => l.sportId)])];
      const [sports, names] = await Promise.all([sportsById(ids), namesOf([...new Set(leaders.map((l) => l.userId))])]);
      const groupName = (await group(me.groupId))?.name ?? '';
      // My own place in each sport, when I'm not its holder.
      const myPlaces = userId
        ? await db.$queryRaw<{ sport_id: string; place: number }[]>`
            WITH s AS (
              SELECT p.sport_id, p.user_id, SUM(p.points)::int AS points
                FROM competition_points p
                JOIN competition_members m ON m.competition_id = p.competition_id AND m.user_id = p.user_id
               WHERE p.competition_id = ${c.id}::uuid AND m.group_id = ${me.groupId}::uuid AND p.sport_id IS NOT NULL
               GROUP BY p.sport_id, p.user_id
            )
            SELECT sport_id, place::int FROM (SELECT s.*, rank() OVER (PARTITION BY sport_id ORDER BY points DESC) AS place FROM s) x WHERE user_id = ${userId}::uuid`
        : [];
      const placeOf = new Map(myPlaces.map((p) => [p.sport_id, p.place]));
      const rows: BoardRow[] = ids
        .map((sportId) => {
          const s = sports.get(sportId);
          const holder = leaders.find((l) => l.sportId === sportId && l.place === 1);
          const mine = holder?.userId === userId;
          const myPlace = placeOf.get(sportId);
          const title = s ? specialistTitle(s.slug, s.name) : 'Specialist';
          return {
            rank: null,
            key: sportId,
            title,
            subtitle: holder ? `${mine ? 'You' : names.get(holder.userId) ?? 'Player'} · ${groupName}${!mine && myPlace ? ` (you are #${myPlace})` : ''}` : 'No points yet: up for grabs',
            score: holder?.points ?? 0,
            move: null,
            isNew: false,
            isMe: mine || myPlace === 2,
          };
        })
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
      return { kind, rows, me: null, size: rows.length };
    }

    // players, or my group's players
    if (kind === 'my_group' && !me) return { kind, rows: [], me: null, size: 0 };
    const t = now();
    const since = periodStart(c, period);
    const weekAgo = new Date(t.getTime() - 7 * DAY);
    const scope = (xs: { userId: string; groupId: string; points: number; joinedAt: Date }[]) => (kind === 'my_group' ? xs.filter((x) => x.groupId === me!.groupId) : xs);
    const [current, before] = await Promise.all([memberTotals(c.id, since, t), period === 'season' ? memberTotals(c.id, since, weekAgo) : Promise.resolve(null)]);
    const ranked = denseRanks(scope(current).map((x) => ({ key: x.userId, score: x.points, groupId: x.groupId, joinedAt: x.joinedAt })));
    const was = before ? new Map(denseRanks(scope(before).map((x) => ({ key: x.userId, score: x.points }))).map((r) => [r.key, r.rank])) : null;
    const shown = ranked.slice(0, first);
    const myRow = userId ? ranked.find((r) => r.key === userId) : undefined;
    const extra = myRow && !shown.includes(myRow) ? [myRow] : [];
    const [names, titles, groupNames] = await Promise.all([
      namesOf([...shown, ...extra].map((r) => r.key)),
      titlesOf(c.id),
      db.competitionGroup.findMany({ where: { competitionId: c.id }, select: { id: true, name: true } }).then((gs) => new Map(gs.map((g) => [g.id, g.name]))),
    ]);
    const toRow = (r: (typeof ranked)[number]): BoardRow => {
      const prev = was?.get(r.key);
      const isNew = r.joinedAt.getTime() > weekAgo.getTime();
      const title = titles.get(r.key);
      const subtitle = kind === 'my_group' ? title ?? (isNew ? 'Joined this week' : `${r.score} Cup points`) : [groupNames.get(r.groupId), title].filter(Boolean).join(' · ');
      return {
        rank: r.rank,
        key: r.key,
        title: r.key === userId ? `You · ${names.get(r.key) ?? 'Player'}` : names.get(r.key) ?? 'Player',
        subtitle,
        score: r.score,
        move: prev !== undefined && !isNew ? prev - r.rank : null,
        isNew: isNew && period === 'season',
        isMe: r.key === userId,
      };
    };
    return { kind, rows: shown.map(toRow), me: extra[0] ? toRow(extra[0]) : null, size: ranked.length };
  }

  /** Everything the Home card and the Cup's header show for one member. Null when not a member. */
  async function standing(competitionId: string, userId: string): Promise<Standing | null> {
    const c = await requireCompetition(competitionId);
    const member = await membership(c.id, userId);
    if (!member) return null;
    const t = now();
    const weekAgo = new Date(t.getTime() - 7 * DAY);
    const [standings, current, before, picks, sportsPlayed, codes] = await Promise.all([
      groupStandings(c),
      memberTotals(c.id, new Date(0), t),
      memberTotals(c.id, new Date(0), weekAgo),
      db.competitionPick.findMany({ where: { competitionId: c.id, userId }, select: { correct: true } }),
      db.$queryRaw<{ n: number }[]>`
        SELECT COUNT(DISTINCT q.sport_id)::int AS n FROM competition_picks pk JOIN competition_questions q ON q.id = pk.question_id
         WHERE pk.competition_id = ${c.id}::uuid AND pk.user_id = ${userId}::uuid`,
      member.code ? Promise.resolve([]) : codesFor(member.groupId),
    ]);
    const mineIdx = standings.findIndex((s) => s.groupId === member.groupId);
    const mine: GroupStanding = standings[mineIdx] ?? { groupId: member.groupId, name: (await group(member.groupId))?.name ?? '', rank: standings.length + 1, score: 0, active: 0, members: 1, qualified: false, move: null };
    const above = mineIdx > 0 ? standings.slice(0, mineIdx).reverse().find((s) => s.rank < mine.rank) : undefined;
    const all = denseRanks(current.map((x) => ({ key: x.userId, score: x.points, groupId: x.groupId })));
    const meRow = all.find((r) => r.key === userId);
    const inGroup = denseRanks(current.filter((x) => x.groupId === member.groupId).map((x) => ({ key: x.userId, score: x.points })));
    const prev = denseRanks(before.map((x) => ({ key: x.userId, score: x.points }))).find((r) => r.key === userId);
    const settled = picks.filter((p) => p.correct !== null);
    const correct = settled.filter((p) => p.correct).length;
    return {
      member,
      group: mine,
      groups: standings.length,
      ahead: above ? { name: above.name, by: above.score - mine.score } : null,
      rank: meRow?.rank ?? all.length,
      move: prev && meRow ? prev.rank - meRow.rank : null,
      players: all.length,
      rankInGroup: inGroup.find((r) => r.key === userId)?.rank ?? inGroup.length,
      groupPlayers: inGroup.length,
      points: meRow?.score ?? 0,
      picks: picks.length,
      settled: settled.length,
      correct,
      accuracy: settled.length ? Math.round((correct / settled.length) * 100) : null,
      sportsPlayed: sportsPlayed[0]?.n ?? 0,
      shareCode: member.code ?? codes.find((x) => x.active)?.code ?? null,
    };
  }

  async function counts(competitionId: string): Promise<{ groupsPlaying: number; players: number }> {
    const [players, groupsPlaying] = await Promise.all([
      db.competitionMember.count({ where: { competitionId } }),
      db.competitionMember.findMany({ where: { competitionId }, distinct: ['groupId'], select: { groupId: true } }),
    ]);
    return { groupsPlaying: groupsPlaying.length, players };
  }

  /** The share card's week: picks, sports, accuracy and the best call, over the last 7 days. */
  async function week(competitionId: string, userId: string) {
    const since = new Date(now().getTime() - 7 * DAY);
    const rows = await db.competitionPick.findMany({
      where: { competitionId, userId, createdAt: { gte: since } },
      include: { question: { select: { sportId: true, kind: true, prompt: true, eventLabel: true } } },
    });
    const bySport = new Map<string, { picks: number; settled: number; correct: number }>();
    for (const r of rows) {
      const s = bySport.get(r.question.sportId) ?? { picks: 0, settled: 0, correct: 0 };
      s.picks += 1;
      if (r.correct !== null) s.settled += 1;
      if (r.correct) s.correct += 1;
      bySport.set(r.question.sportId, s);
    }
    const settled = rows.filter((r) => r.correct !== null);
    const best = [...rows].filter((r) => (r.pointsAwarded ?? 0) > 0).sort((a, b) => (b.pointsAwarded ?? 0) - (a.pointsAwarded ?? 0))[0];
    return {
      picks: rows.length,
      sports: [...bySport.entries()].map(([sportId, s]) => ({ sportId, ...s })).sort((a, b) => b.picks - a.picks),
      accuracy: settled.length ? Math.round((settled.filter((r) => r.correct).length / settled.length) * 100) : null,
      best: best
        ? {
            label: best.question.kind === 'exact_score' && best.correct ? `Exact score ${best.home}–${best.away}` : best.question.prompt,
            points: best.pointsAwarded ?? 0,
          }
        : null,
    };
  }

  // --- reminders (competitions R8) ---

  async function sendReminders(): Promise<{ opened: number; locking: number }> {
    const t = now();
    const reminders: Reminder[] = [];

    // 1 — questions that opened since the last run. Claimed first, so a second worker sends nothing.
    const opened = await db.$queryRaw<{ id: string; competition_id: string; sport_id: string; multiplier: Prisma.Decimal }[]>`
      UPDATE competition_questions q SET open_notified_at = ${t}
        FROM competitions c
       WHERE c.id = q.competition_id AND c.status = 'live' AND c.ends_at > ${t}
         AND q.status = 'open' AND q.open_notified_at IS NULL AND q.opens_at <= ${t} AND q.locks_at > ${t}
      RETURNING q.id, q.competition_id, q.sport_id, q.multiplier`;
    const openedBy = new Map<string, typeof opened>();
    for (const q of opened) openedBy.set(q.competition_id, [...(openedBy.get(q.competition_id) ?? []), q]);
    for (const [competitionId, qs] of openedBy) {
      const c = await byId(competitionId);
      if (!c) continue;
      const sportIds = [...new Set(qs.map((q) => q.sport_id))];
      const sports = await sportsById(sportIds);
      const bonusSports = new Set(qs.filter((q) => Number(q.multiplier) > 1).map((q) => q.sport_id));
      // Who follows each sport: played it in this Cup, or lists it on their profile.
      const follows = await db.$queryRaw<{ user_id: string; sport_id: string }[]>`
        SELECT DISTINCT m.user_id, s.sport_id FROM competition_members m
          CROSS JOIN unnest(${sportIds}::uuid[]) AS s(sport_id)
         WHERE m.competition_id = ${competitionId}::uuid
           AND (
             EXISTS (SELECT 1 FROM competition_picks pk JOIN competition_questions q ON q.id = pk.question_id
                      WHERE pk.competition_id = m.competition_id AND pk.user_id = m.user_id AND q.sport_id = s.sport_id)
             OR EXISTS (SELECT 1 FROM player_profiles pp JOIN player_sports ps ON ps.player_id = pp.id
                         WHERE pp.user_id = m.user_id AND ps.sport_id = s.sport_id)
           )`;
      const everyone = bonusSports.size ? (await db.competitionMember.findMany({ where: { competitionId }, select: { userId: true } })).map((m) => m.userId) : [];
      const perUser = new Map<string, Set<string>>();
      for (const f of follows) perUser.set(f.user_id, (perUser.get(f.user_id) ?? new Set()).add(f.sport_id));
      for (const u of everyone) for (const s of bonusSports) perUser.set(u, (perUser.get(u) ?? new Set()).add(s));
      // One push per member: the same sports → the same payload → one bulk send.
      const byPayload = new Map<string, { userIds: string[]; payload: Record<string, unknown> }>();
      for (const [u, set] of perUser) {
        const names = [...set].map((id) => sports.get(id)?.name).filter((n): n is string => !!n).sort();
        if (!names.length) continue;
        const bonus = [...set].some((s) => bonusSports.has(s));
        const count = qs.filter((q) => set.has(q.sport_id)).length;
        const key = `${names.join('|')}:${bonus}:${count}`;
        const entry = byPayload.get(key) ?? { userIds: [], payload: { competitionName: c.name, sports: names, count, bonus } };
        entry.userIds.push(u);
        byPayload.set(key, entry);
      }
      for (const e of byPayload.values()) reminders.push({ template: 'cup.questions_open', userIds: e.userIds, payload: e.payload, slug: c.slug });
    }

    // 2 — questions locking within the hour: active members who haven't picked them.
    const locking = await db.$queryRaw<{ id: string; competition_id: string }[]>`
      UPDATE competition_questions q SET lock_notified_at = ${t}
        FROM competitions c
       WHERE c.id = q.competition_id AND c.status = 'live'
         AND q.status = 'open' AND q.lock_notified_at IS NULL AND q.opens_at <= ${t}
         AND q.locks_at > ${t} AND q.locks_at <= ${new Date(t.getTime() + HOUR)}
      RETURNING q.id, q.competition_id`;
    const lockingBy = new Map<string, string[]>();
    for (const q of locking) lockingBy.set(q.competition_id, [...(lockingBy.get(q.competition_id) ?? []), q.id]);
    for (const [competitionId, ids] of lockingBy) {
      const c = await byId(competitionId);
      if (!c) continue;
      const since = new Date(t.getTime() - c.activeDays * DAY);
      const rows = await db.$queryRaw<{ user_id: string; missing: number }[]>`
        SELECT m.user_id, COUNT(q.id)::int AS missing
          FROM competition_members m
          CROSS JOIN unnest(${ids}::uuid[]) AS q(id)
         WHERE m.competition_id = ${competitionId}::uuid
           AND EXISTS (SELECT 1 FROM competition_picks a WHERE a.competition_id = m.competition_id AND a.user_id = m.user_id AND a.created_at >= ${since})
           AND NOT EXISTS (SELECT 1 FROM competition_picks pk WHERE pk.question_id = q.id AND pk.user_id = m.user_id)
         GROUP BY m.user_id`;
      const byCount = new Map<number, string[]>();
      for (const r of rows) byCount.set(r.missing, [...(byCount.get(r.missing) ?? []), r.user_id]);
      for (const [count, userIds] of byCount) reminders.push({ template: 'cup.locking_soon', userIds, payload: { competitionName: c.name, count }, slug: c.slug });
    }

    if (deps.notify) {
      for (const r of reminders) {
        try {
          await deps.notify(r);
        } catch {
          // A failed push is not retried: the reminder was claimed, and a late one is worse than none.
        }
      }
    }
    return { opened: opened.length, locking: locking.length };
  }

  return {
    byId,
    bySlug,
    forHome,
    mine,
    staffList,
    saveCompetition,
    isPlayable,
    group,
    groups,
    saveGroup,
    codesFor,
    saveCode,
    previewCode,
    membership,
    memberCounts,
    join,
    staffMembers,
    moments,
    moment,
    saveMoment,
    deleteMoment,
    question,
    questionsByIds,
    openQuestions,
    upcomingQuestions,
    openSummary,
    sportsInPlay,
    staffQuestions,
    splits,
    picksFor,
    createQuestion,
    updateQuestion,
    addWinnerQuestions,
    pick,
    settle,
    voidQuestion,
    settleFromMatch,
    voidOpenForMatch,
    board,
    groupStandings,
    standing,
    counts,
    week,
    sendReminders,
  };
}

export type CompetitionsService = ReturnType<typeof createCompetitionsService>;
