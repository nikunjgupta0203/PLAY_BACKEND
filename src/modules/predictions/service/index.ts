/**
 * predictions — free prediction questions on pro matches (Floodlight §4.4).
 *
 * predictions R1 — free to play. No entry fee, no buying points, no cash
 *   prizes, and points are never redeemed for anything. They are separate
 *   from Rewards. Nothing in this module touches payments or rewards.
 * predictions R2 — one pick per player per question, changeable until the
 *   question locks (`locks_at`) or is settled or voided.
 * predictions R3 — settling marks every pick and writes points once, in one
 *   transaction under FOR UPDATE: a double tap settles once.
 *   · choice / player_pick: the right option earns the question's points.
 *   · exact_score: the exact score earns them all; the right result (home
 *     win, draw, away win) with the wrong score earns a third, rounded down.
 *     Only the exact score counts as "correct" for streaks and accuracy.
 * predictions R4 — a void question awards nothing and leaves its picks
 *   unmarked; it never counts for streaks or accuracy.
 * predictions R5 — points live in `prediction_points`, unique on
 *   (user, reason, ref): totals and leaderboards are sums, a retry never
 *   double-counts.
 * predictions R6 — the daily challenge (IST day): three picks, one live
 *   question, one exact score. Completing all three adds the bonus once.
 * predictions R7 — leaderboards rank by total points, ties share a rank.
 *   Scopes: global, friends (players you chat with), a sport, a community
 *   (or all of yours), your city. Pick points never touch player rating.
 * predictions R8 (060) — when a match finishes, the final score suggests the
 *   answer to its open questions: an exact score from whole-number scores, a
 *   winner question from options tagged home / draw / away. Staff confirm
 *   ("Settle as suggested"); nothing settles on its own, because points can
 *   never be taken back and feeds sometimes correct results late.
 * predictions R9 (060) — an abandoned match voids its open questions.
 */
import { Prisma } from '@prisma/client';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const PredictionCode = {
  NOT_FOUND: 'QUESTION_NOT_FOUND',
  LOCKED: 'QUESTION_LOCKED',
  INVALID_PICK: 'INVALID_PICK',
  INVALID_QUESTION: 'INVALID_QUESTION',
  ALREADY_SETTLED: 'QUESTION_ALREADY_SETTLED',
} as const;

export type QuestionKind = 'choice' | 'exact_score' | 'player_pick';
export type QuestionStatus = 'open' | 'settled' | 'void';
export type BoardScope = 'global' | 'friends' | 'sport' | 'community' | 'city';
export type Outcome = 'home' | 'draw' | 'away';
export const OUTCOMES: readonly Outcome[] = ['home', 'draw', 'away'];

export const DAILY_BONUS = 50;
export const MAX_OPTIONS = 6;
const IST_OFFSET_MS = 330 * 60_000;

export interface Option {
  id: string;
  label: string;
  detail: string | null;
  position: number;
  /** predictions R8 — what picking it means for the result. */
  outcome: Outcome | null;
}

export interface Question {
  id: string;
  matchId: string | null;
  sportId: string;
  kind: QuestionKind;
  prompt: string;
  points: number;
  live: boolean;
  locksAt: Date;
  status: QuestionStatus;
  correctOptionId: string | null;
  correctHome: number | null;
  correctAway: number | null;
  settledAt: Date | null;
  createdAt: Date;
  options: Option[];
  /** predictions R8 — the answer the final score points to, for staff to confirm. */
  suggestedOptionId: string | null;
  suggestedHome: number | null;
  suggestedAway: number | null;
  suggestedAt: Date | null;
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
  /** option id → picks. */
  byOption: Map<string, number>;
}

export interface Stats {
  points: number;
  picks: number;
  settled: number;
  correct: number;
  /** 0–100, rounded. Null before anything settles. */
  accuracy: number | null;
  streak: number;
  bestStreak: number;
  livePicks: number;
  dailyWins: number;
  exactHits: number;
}

export interface ChallengeTask {
  key: 'picks' | 'live' | 'exact';
  label: string;
  progress: number;
  target: number;
  done: boolean;
}

export interface Challenge {
  /** IST date, YYYY-MM-DD. */
  date: string;
  bonus: number;
  tasks: ChallengeTask[];
  completed: boolean;
}

export interface Badge {
  key: string;
  name: string;
  description: string;
  earned: boolean;
}

export interface BoardEntry {
  rank: number;
  userId: string;
  points: number;
}

export interface Board {
  entries: BoardEntry[];
  me: BoardEntry | null;
  /** How many players the scope ranks. */
  size: number;
}

export interface QuestionInput {
  matchId?: string | null;
  sportId?: string | null;
  kind: QuestionKind;
  prompt: string;
  points?: number | null;
  live?: boolean | null;
  locksAt: Date;
  options?: { label: string; detail?: string | null; outcome?: Outcome | null }[];
}

export interface PredictionsDeps {
  db: Db;
  /** The pro match a question hangs off: its sport, and that it exists. */
  matchSport(matchId: string): Promise<string | null>;
  /** predictions R7 — the scopes' people. Each returns user ids. */
  friendsOf(userId: string): Promise<string[]>;
  communityMembers(userId: string, communityId: string | null): Promise<string[]>;
  cityPeers(userId: string): Promise<{ city: string | null; userIds: string[] }>;
  notify?(userIds: string[], payload: { prompt: string; correct: boolean; points: number }): Promise<void>;
  now?: () => Date;
}

type QuestionRow = Awaited<ReturnType<Db['predictionQuestion']['findFirstOrThrow']>> & {
  options: Awaited<ReturnType<Db['predictionOption']['findFirstOrThrow']>>[];
};

const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  matchId: r.matchId,
  sportId: r.sportId,
  kind: r.kind as QuestionKind,
  prompt: r.prompt,
  points: r.points,
  live: r.live,
  locksAt: r.locksAt,
  status: r.status as QuestionStatus,
  correctOptionId: r.correctOptionId,
  correctHome: r.correctHome,
  correctAway: r.correctAway,
  settledAt: r.settledAt,
  createdAt: r.createdAt,
  options: [...r.options]
    .sort((a, b) => a.position - b.position)
    .map((o) => ({ id: o.id, label: o.label, detail: o.detail, position: o.position, outcome: (OUTCOMES as readonly string[]).includes(o.outcome ?? '') ? (o.outcome as Outcome) : null })),
  suggestedOptionId: r.suggestedOptionId,
  suggestedHome: r.suggestedHome,
  suggestedAway: r.suggestedAway,
  suggestedAt: r.suggestedAt,
});

const toPick = (r: Awaited<ReturnType<Db['predictionPick']['findFirstOrThrow']>>): Pick => ({
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

/** The IST calendar day an instant falls in. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of an IST day, as UTC instants. */
export function istDayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(new Date(`${day}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** predictions R3 — what one pick earns. Pure. */
export function scorePick(
  q: Pick_<Question, 'kind' | 'points' | 'correctOptionId' | 'correctHome' | 'correctAway'>,
  p: Pick_<Pick, 'optionId' | 'home' | 'away'>,
): { correct: boolean; points: number } {
  if (q.kind === 'exact_score') {
    if (q.correctHome === null || q.correctAway === null || p.home === null || p.away === null) return { correct: false, points: 0 };
    if (p.home === q.correctHome && p.away === q.correctAway) return { correct: true, points: q.points };
    const sameResult = sign(p.home - p.away) === sign(q.correctHome - q.correctAway);
    return { correct: false, points: sameResult ? Math.floor(q.points / 3) : 0 };
  }
  const correct = p.optionId !== null && p.optionId === q.correctOptionId;
  return { correct, points: correct ? q.points : 0 };
}
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

/** predictions R3, R4 — current and best run of correct picks, oldest first in. Pure. */
export function streaks(correctInOrder: boolean[]): { streak: number; best: number } {
  let run = 0;
  let best = 0;
  for (const c of correctInOrder) {
    run = c ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { streak: run, best };
}

/** predictions R7 — dense ties: equal points share a rank, the next rank skips. Pure. */
export function rankRows(rows: { userId: string; points: number }[]): BoardEntry[] {
  const sorted = [...rows].sort((a, b) => b.points - a.points || (a.userId < b.userId ? -1 : 1));
  let rank = 0;
  let last: number | null = null;
  return sorted.map((r, i) => {
    if (r.points !== last) {
      rank = i + 1;
      last = r.points;
    }
    return { rank, userId: r.userId, points: r.points };
  });
}

/** A whole-number score ("2", " 3 "), or null for anything else ("182/4", "21-17"). */
function wholeScore(raw: string | null): number | null {
  const v = raw?.trim() ?? '';
  return /^\d{1,3}$/.test(v) ? Number(v) : null;
}

/** Sports where a level result is a real outcome players should be able to pick. */
const DRAW_SPORTS = new Set(['football', 'chess', 'rugby']);

/** The system's question for one match: the prompt and its options, tied to the result. Pure. */
export function autoQuestionFor(m: { sport: string; league: string; stage: string | null; home: string; away: string }): {
  prompt: string;
  options: { label: string; outcome: Outcome }[];
} {
  const test = m.sport === 'cricket' && /\btest\b/i.test(`${m.league} ${m.stage ?? ''}`);
  const draws = DRAW_SPORTS.has(m.sport) || test;
  const label = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s);
  const options: { label: string; outcome: Outcome }[] = [
    { label: label(m.home), outcome: 'home' },
    ...(draws ? [{ label: 'Draw', outcome: 'draw' as Outcome }] : []),
    { label: label(m.away), outcome: 'away' },
  ];
  const prompt =
    m.sport === 'formula-1'
      ? `Who finishes ahead: ${m.home} or ${m.away}?`
      : m.sport === 'chess'
        ? 'Who wins this game?'
        : m.sport === 'mma'
          ? 'Who wins the fight?'
          : 'Who wins?';
  return { prompt: prompt.slice(0, 200), options };
}

/** The match side of a suggestion: its final score and, when known, who won. */
export interface FinalResult {
  homeScore: string | null;
  awayScore: string | null;
  winner: Outcome | null;
}

/**
 * predictions R8 — what the result says the answer is, or null when it can't
 * tell (a player pick, untagged options, a score that isn't whole numbers). Pure.
 */
export function suggestAnswer(
  q: Pick_<Question, 'kind' | 'options'>,
  result: FinalResult,
): { optionId: string | null; home: number | null; away: number | null } | null {
  const home = wholeScore(result.homeScore);
  const away = wholeScore(result.awayScore);
  if (q.kind === 'exact_score') return home !== null && away !== null ? { optionId: null, home, away } : null;
  if (q.kind !== 'choice') return null;
  const winner: Outcome | null = result.winner ?? (home !== null && away !== null ? (home > away ? 'home' : home < away ? 'away' : 'draw') : null);
  if (!winner) return null;
  const match = q.options.filter((o) => o.outcome === winner);
  return match.length === 1 ? { optionId: match[0]!.id, home: null, away: null } : null;
}

export const BADGES: { key: string; name: string; description: string; earned(s: Stats): boolean }[] = [
  { key: 'first_pick', name: 'First call', description: 'Make your first pick', earned: (s) => s.picks >= 1 },
  { key: 'picks_10', name: 'Regular', description: 'Make 10 picks', earned: (s) => s.picks >= 10 },
  { key: 'picks_50', name: 'Season ticket', description: 'Make 50 picks', earned: (s) => s.picks >= 50 },
  { key: 'picks_100', name: 'Centurion', description: 'Make 100 picks', earned: (s) => s.picks >= 100 },
  { key: 'streak_3', name: 'Hat-trick', description: '3 right in a row', earned: (s) => s.bestStreak >= 3 },
  { key: 'streak_5', name: 'Hot hand', description: '5 right in a row', earned: (s) => s.bestStreak >= 5 },
  { key: 'streak_10', name: 'Oracle', description: '10 right in a row', earned: (s) => s.bestStreak >= 10 },
  { key: 'exact_hit', name: 'Bang on', description: 'Call an exact score', earned: (s) => s.exactHits >= 1 },
  { key: 'live_10', name: 'Live wire', description: 'Answer 10 live questions', earned: (s) => s.livePicks >= 10 },
  { key: 'daily_1', name: 'Daily done', description: 'Finish a daily challenge', earned: (s) => s.dailyWins >= 1 },
  { key: 'daily_7', name: 'Week strong', description: 'Finish 7 daily challenges', earned: (s) => s.dailyWins >= 7 },
  { key: 'sharp', name: 'Sharp', description: '60% right over 20 settled picks', earned: (s) => s.settled >= 20 && (s.accuracy ?? 0) >= 60 },
];

export function createPredictionsService(deps: PredictionsDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  const include = { options: true } as const;

  async function question(id: string): Promise<Question | null> {
    const row = await db.predictionQuestion.findUnique({ where: { id }, include });
    return row ? toQuestion(row) : null;
  }

  async function requireQuestion(id: string): Promise<Question> {
    const q = await question(id);
    if (!q) throw new UserError(PredictionCode.NOT_FOUND, 'That question is no longer there.');
    return q;
  }

  /** Open questions, soonest to lock first. Locked-but-unsettled ones are kept when asked for. */
  async function openQuestions(filter: { matchId?: string | null; sportId?: string | null; live?: boolean | null; includeLocked?: boolean; first?: number }): Promise<Question[]> {
    const t = now();
    const rows = await db.predictionQuestion.findMany({
      where: {
        status: 'open',
        ...(filter.includeLocked ? {} : { locksAt: { gt: t } }),
        ...(filter.matchId ? { matchId: filter.matchId } : {}),
        ...(filter.sportId ? { sportId: filter.sportId } : {}),
        ...(filter.live === true || filter.live === false ? { live: filter.live } : {}),
      },
      include,
      orderBy: [{ locksAt: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(filter.first ?? 20, 1), 50),
    });
    return rows.map(toQuestion);
  }

  /** Every question on a match, newest first: the Match Centre's Predict tab. */
  async function forMatch(matchId: string): Promise<Question[]> {
    const rows = await db.predictionQuestion.findMany({ where: { matchId, status: { not: 'void' } }, include, orderBy: [{ createdAt: 'desc' }] });
    return rows.map(toQuestion);
  }

  async function staffList(first = 100): Promise<Question[]> {
    const rows = await db.predictionQuestion.findMany({ include, orderBy: [{ createdAt: 'desc' }], take: Math.min(Math.max(first, 1), 300) });
    return rows.map(toQuestion);
  }

  async function splits(questionIds: readonly string[]): Promise<Map<string, Split>> {
    const out = new Map<string, Split>(questionIds.map((id) => [id, { questionId: id, total: 0, byOption: new Map() }]));
    if (questionIds.length === 0) return out;
    const rows = await db.predictionPick.groupBy({
      by: ['questionId', 'optionId'],
      where: { questionId: { in: [...questionIds] } },
      _count: { _all: true },
    });
    for (const r of rows) {
      const split = out.get(r.questionId);
      if (!split) continue;
      split.total += r._count._all;
      if (r.optionId) split.byOption.set(r.optionId, r._count._all);
    }
    return out;
  }

  async function picksFor(userId: string, questionIds: readonly string[]): Promise<Map<string, Pick>> {
    if (questionIds.length === 0) return new Map();
    const rows = await db.predictionPick.findMany({ where: { userId, questionId: { in: [...questionIds] } } });
    return new Map(rows.map((r) => [r.questionId, toPick(r)]));
  }

  // --- predictions R2: picking ----------------------------------------------------

  async function pick(userId: string, questionId: string, answer: { optionId?: string | null; home?: number | null; away?: number | null }): Promise<Pick> {
    const q = await requireQuestion(questionId);
    if (q.status !== 'open' || q.locksAt.getTime() <= now().getTime()) {
      throw new UserError(PredictionCode.LOCKED, 'Picks are locked for this question.');
    }
    let data: { optionId: string | null; home: number | null; away: number | null };
    if (q.kind === 'exact_score') {
      const ok = (n: number | null | undefined): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 999;
      if (!ok(answer.home) || !ok(answer.away)) throw new UserError(PredictionCode.INVALID_PICK, 'Give a score for both sides.');
      data = { optionId: null, home: answer.home, away: answer.away };
    } else {
      if (!answer.optionId || !q.options.some((o) => o.id === answer.optionId)) {
        throw new UserError(PredictionCode.INVALID_PICK, 'Pick one of the options.');
      }
      data = { optionId: answer.optionId, home: null, away: null };
    }
    // FOR SHARE waits for a settle in flight (it holds FOR UPDATE), then re-checks:
    // a pick never lands on a question after it is marked.
    const row = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string; locks_at: Date }[]>`
        SELECT status, locks_at FROM prediction_questions WHERE id = ${questionId}::uuid FOR SHARE`;
      const current = locked[0];
      if (!current) throw new UserError(PredictionCode.NOT_FOUND, 'That question is no longer there.');
      if (current.status !== 'open' || current.locks_at.getTime() <= now().getTime()) {
        throw new UserError(PredictionCode.LOCKED, 'Picks are locked for this question.');
      }
      return tx.predictionPick.upsert({
        where: { questionId_userId: { questionId, userId } },
        // Stamped from the service clock: the daily challenge counts picks by createdAt.
        create: { id: newId(), questionId, userId, ...data, createdAt: now(), updatedAt: now() },
        update: { ...data, updatedAt: now() },
      });
    });
    await maybeAwardDaily(userId);
    return toPick(row);
  }

  // --- predictions R6: the daily challenge ---------------------------------------

  async function challenge(userId: string, at: Date = now()): Promise<Challenge> {
    const date = istDay(at);
    const { start, end } = istDayBounds(date);
    const picks = await db.predictionPick.findMany({
      where: { userId, createdAt: { gte: start, lt: end } },
      select: { question: { select: { live: true, kind: true } } },
    });
    const live = picks.filter((p) => p.question.live).length;
    const exact = picks.filter((p) => p.question.kind === 'exact_score').length;
    const task = (key: ChallengeTask['key'], label: string, progress: number, target: number): ChallengeTask => ({
      key,
      label,
      progress: Math.min(progress, target),
      target,
      done: progress >= target,
    });
    const tasks = [task('picks', 'Make 3 picks', picks.length, 3), task('live', 'Answer a live question', live, 1), task('exact', 'Call an exact score', exact, 1)];
    return { date, bonus: DAILY_BONUS, tasks, completed: tasks.every((t) => t.done) };
  }

  async function maybeAwardDaily(userId: string): Promise<void> {
    const c = await challenge(userId);
    if (!c.completed) return;
    await db.predictionPoint.createMany({
      data: [{ id: newId(), userId, sportId: null, points: c.bonus, reason: 'daily', ref: c.date }],
      skipDuplicates: true,
    });
  }

  // --- predictions R3, R4: settling -------------------------------------------------

  async function settle(staffUserId: string | null, questionId: string, answer: { optionId?: string | null; home?: number | null; away?: number | null }): Promise<Question> {
    const result = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM prediction_questions WHERE id = ${questionId}::uuid FOR UPDATE`;
      if (!locked[0]) throw new UserError(PredictionCode.NOT_FOUND, 'That question is no longer there.');
      if (locked[0].status !== 'open') throw new UserError(PredictionCode.ALREADY_SETTLED, 'That question is already settled or void.');
      const q = toQuestion(await tx.predictionQuestion.findUniqueOrThrow({ where: { id: questionId }, include }));

      const correct: { optionId: string | null; home: number | null; away: number | null } =
        q.kind === 'exact_score'
          ? { optionId: null, home: answer.home ?? null, away: answer.away ?? null }
          : { optionId: answer.optionId ?? null, home: null, away: null };
      if (q.kind === 'exact_score') {
        const ok = (n: number | null) => n !== null && Number.isInteger(n) && n >= 0 && n <= 999;
        if (!ok(correct.home) || !ok(correct.away)) throw new UserError(PredictionCode.INVALID_QUESTION, 'Give the final score for both sides.');
      } else if (!correct.optionId || !q.options.some((o) => o.id === correct.optionId)) {
        throw new UserError(PredictionCode.INVALID_QUESTION, 'Pick the right option.');
      }

      const settledAt = now();
      const final = { ...q, correctOptionId: correct.optionId, correctHome: correct.home, correctAway: correct.away };
      const picks = await tx.predictionPick.findMany({ where: { questionId } });
      // Grouped by outcome for the push: right, right result only (a third), or wrong.
      const outcomes = new Map<string, { correct: boolean; points: number; userIds: string[] }>();
      const points: Prisma.PredictionPointCreateManyInput[] = [];
      for (const p of picks) {
        const s = scorePick(final, p);
        await tx.predictionPick.update({ where: { id: p.id }, data: { correct: s.correct, pointsAwarded: s.points, updatedAt: settledAt } });
        if (s.points > 0) points.push({ id: newId(), userId: p.userId, sportId: q.sportId, points: s.points, reason: 'pick', ref: p.id, createdAt: settledAt });
        const key = `${s.correct}:${s.points}`;
        const group = outcomes.get(key) ?? { correct: s.correct, points: s.points, userIds: [] };
        group.userIds.push(p.userId);
        outcomes.set(key, group);
      }
      if (points.length) await tx.predictionPoint.createMany({ data: points, skipDuplicates: true });
      const row = await tx.predictionQuestion.update({
        where: { id: questionId },
        data: {
          status: 'settled',
          correctOptionId: correct.optionId,
          correctHome: correct.home,
          correctAway: correct.away,
          settledAt,
          settledBy: staffUserId,
          updatedAt: settledAt,
        },
        include,
      });
      return { question: toQuestion(row), outcomes: [...outcomes.values()] };
    });
    if (deps.notify) {
      try {
        for (const o of result.outcomes) {
          await deps.notify(o.userIds, { prompt: result.question.prompt, correct: o.correct, points: o.points });
        }
      } catch {
        // A failed push never unsettles a question.
      }
    }
    return result.question;
  }

  async function voidQuestion(questionId: string): Promise<Question> {
    const q = await requireQuestion(questionId);
    if (q.status !== 'open') throw new UserError(PredictionCode.ALREADY_SETTLED, 'That question is already settled or void.');
    const row = await db.predictionQuestion.update({ where: { id: questionId }, data: { status: 'void', updatedAt: now() }, include });
    return toQuestion(row);
  }

  // --- predictions R8, R9: from the match result -------------------------------------

  /** Writes (or clears) the suggestion on every open question of a finished match. */
  async function suggestForMatch(matchId: string, result: FinalResult): Promise<number> {
    const open = await db.predictionQuestion.findMany({ where: { matchId, status: 'open' }, include });
    let suggested = 0;
    for (const row of open) {
      const answer = suggestAnswer(toQuestion(row), result);
      if (answer) suggested += 1;
      await db.predictionQuestion.update({
        where: { id: row.id },
        data: {
          suggestedOptionId: answer?.optionId ?? null,
          suggestedHome: answer?.home ?? null,
          suggestedAway: answer?.away ?? null,
          suggestedAt: answer ? now() : null,
        },
      });
    }
    return suggested;
  }

  /** predictions R9 — nobody earns anything on a match that never finished. */
  async function voidOpenForMatch(matchId: string): Promise<number> {
    const { count } = await db.predictionQuestion.updateMany({ where: { matchId, status: 'open' }, data: { status: 'void', updatedAt: now() } });
    return count;
  }

  /**
   * predictions R10 (2026-11-17) — every upcoming feed match gets one "Who
   * wins?" question, so Home's "Make your call" is never empty. Made by the
   * system (no staff author); a match that already has a question is left
   * alone, so staff questions are never doubled. Locks at the start.
   */
  async function autoWinnerQuestions(opts: { horizonHours?: number; max?: number } = {}): Promise<number> {
    const t = now().getTime();
    const matches = await db.proMatch.findMany({
      where: {
        provider: { not: 'manual' },
        status: 'scheduled',
        startsAt: { gte: new Date(t + 10 * 60_000), lte: new Date(t + (opts.horizonHours ?? 72) * 3_600_000) },
        questions: { none: {} },
      },
      include: { homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
      orderBy: [{ startsAt: 'asc' }],
      take: opts.max ?? 60,
    });
    const slugs = new Map((await db.sport.findMany({ where: { id: { in: [...new Set(matches.map((m) => m.sportId))] } }, select: { id: true, slug: true } })).map((s) => [s.id, s.slug]));
    let made = 0;
    for (const m of matches) {
      const q = autoQuestionFor({ sport: slugs.get(m.sportId) ?? '', league: m.league, stage: m.stage, home: m.homeTeam.name, away: m.awayTeam.name });
      try {
        await createQuestion(null, { matchId: m.id, kind: 'choice', prompt: q.prompt, points: 10, locksAt: m.startsAt, options: q.options });
        made += 1;
      } catch {
        // A match that changed under us (started, deleted): the next run looks again.
      }
    }
    return made;
  }

  /**
   * predictions R10 — a system question settles itself from the feed's final
   * result (the suggestion of R8). Staff questions still wait for staff: their
   * prompts can ask anything, and points cannot be taken back.
   */
  async function autoSettleMatch(matchId: string): Promise<number> {
    const rows = await db.predictionQuestion.findMany({ where: { matchId, status: 'open', createdBy: null, kind: 'choice', suggestedOptionId: { not: null } }, select: { id: true, suggestedOptionId: true } });
    let settled = 0;
    for (const r of rows) {
      try {
        await settle(null, r.id, { optionId: r.suggestedOptionId });
        settled += 1;
      } catch {
        // Settled or voided a moment ago by someone else.
      }
    }
    return settled;
  }

  // --- staff: questions ----------------------------------------------------------

  async function createQuestion(staffUserId: string | null, input: QuestionInput): Promise<Question> {
    const prompt = input.prompt.trim();
    if (prompt.length < 3 || prompt.length > 200) throw new UserError(PredictionCode.INVALID_QUESTION, 'A question is 3 to 200 characters.');
    const points = input.points ?? (input.live ? 30 : 10);
    if (!Number.isInteger(points) || points < 1 || points > 500) throw new UserError(PredictionCode.INVALID_QUESTION, 'Points are 1 to 500.');
    if (Number.isNaN(input.locksAt.getTime())) throw new UserError(PredictionCode.INVALID_QUESTION, 'Give a lock time.');
    let sportId = input.sportId ?? null;
    if (input.matchId) {
      sportId = await deps.matchSport(input.matchId);
      if (!sportId) throw new UserError(PredictionCode.INVALID_QUESTION, 'That match is no longer there.');
    }
    if (!sportId) throw new UserError(PredictionCode.INVALID_QUESTION, 'Pick a sport or a match.');
    const options = (input.options ?? [])
      .map((o) => ({ label: o.label.trim(), detail: o.detail?.trim() || null, outcome: o.outcome ?? null }))
      .filter((o) => o.label.length > 0);
    if (options.some((o) => o.outcome !== null && !OUTCOMES.includes(o.outcome))) {
      throw new UserError(PredictionCode.INVALID_QUESTION, 'An option’s result is home, draw or away.');
    }
    if (options.some((o) => o.outcome !== null) && (input.kind !== 'choice' || !input.matchId)) {
      throw new UserError(PredictionCode.INVALID_QUESTION, 'Only a choice question on a match can tie options to the result.');
    }
    const tagged = options.map((o) => o.outcome).filter((x): x is Outcome => x !== null);
    if (new Set(tagged).size !== tagged.length) {
      throw new UserError(PredictionCode.INVALID_QUESTION, 'Each result (home, draw, away) goes on one option at most.');
    }
    if (input.kind === 'exact_score') {
      if (options.length) throw new UserError(PredictionCode.INVALID_QUESTION, 'An exact-score question has no options.');
    } else if (options.length < 2 || options.length > MAX_OPTIONS) {
      throw new UserError(PredictionCode.INVALID_QUESTION, `Give 2 to ${MAX_OPTIONS} options.`);
    } else if (options.some((o) => o.label.length > 60)) {
      throw new UserError(PredictionCode.INVALID_QUESTION, 'An option is at most 60 characters.');
    }
    const id = newId();
    const row = await db.predictionQuestion.create({
      data: {
        id,
        matchId: input.matchId ?? null,
        sportId,
        kind: input.kind,
        prompt,
        points,
        live: input.live ?? false,
        locksAt: input.locksAt,
        createdBy: staffUserId,
        options: { create: options.map((o, i) => ({ id: newId(), label: o.label, detail: o.detail, outcome: o.outcome, position: i })) },
      },
      include,
    });
    return toQuestion(row);
  }

  /** Only while open: the prompt, the lock time, the points. */
  async function updateQuestion(questionId: string, patch: { prompt?: string; locksAt?: Date; points?: number }): Promise<Question> {
    const q = await requireQuestion(questionId);
    if (q.status !== 'open') throw new UserError(PredictionCode.ALREADY_SETTLED, 'A settled or void question cannot change.');
    const data: Prisma.PredictionQuestionUpdateInput = { updatedAt: now() };
    if (patch.prompt !== undefined) {
      const prompt = patch.prompt.trim();
      if (prompt.length < 3 || prompt.length > 200) throw new UserError(PredictionCode.INVALID_QUESTION, 'A question is 3 to 200 characters.');
      data.prompt = prompt;
    }
    if (patch.locksAt !== undefined) data.locksAt = patch.locksAt;
    if (patch.points !== undefined) {
      if (!Number.isInteger(patch.points) || patch.points < 1 || patch.points > 500) throw new UserError(PredictionCode.INVALID_QUESTION, 'Points are 1 to 500.');
      data.points = patch.points;
    }
    return toQuestion(await db.predictionQuestion.update({ where: { id: questionId }, data, include }));
  }

  // --- the player's record --------------------------------------------------------

  async function stats(userId: string): Promise<Stats> {
    const [sum, picks, settled, live, daily] = await Promise.all([
      db.predictionPoint.aggregate({ where: { userId }, _sum: { points: true } }),
      db.predictionPick.count({ where: { userId } }),
      db.predictionPick.findMany({
        where: { userId, correct: { not: null }, question: { status: 'settled' } },
        select: { correct: true, question: { select: { settledAt: true, kind: true } } },
        orderBy: { question: { settledAt: 'asc' } },
      }),
      db.predictionPick.count({ where: { userId, question: { live: true } } }),
      db.predictionPoint.count({ where: { userId, reason: 'daily' } }),
    ]);
    const correct = settled.filter((s) => s.correct).length;
    const run = streaks(settled.map((s) => s.correct === true));
    return {
      points: sum._sum.points ?? 0,
      picks,
      settled: settled.length,
      correct,
      accuracy: settled.length ? Math.round((correct / settled.length) * 100) : null,
      streak: run.streak,
      bestStreak: run.best,
      livePicks: live,
      dailyWins: daily,
      exactHits: settled.filter((s) => s.correct && s.question.kind === 'exact_score').length,
    };
  }

  /** My PL4Y's "this week": picks made in the last 7 days, settled or not. */
  async function picksThisWeek(userId: string): Promise<number> {
    return db.predictionPick.count({ where: { userId, createdAt: { gte: new Date(now().getTime() - 7 * 86_400_000) } } });
  }

  async function badges(userId: string): Promise<Badge[]> {
    const s = await stats(userId);
    return BADGES.map((b) => ({ key: b.key, name: b.name, description: b.description, earned: b.earned(s) }));
  }

  /** Settled and void picks, newest first: "Recent results". */
  async function results(userId: string, first = 10): Promise<{ pick: Pick; question: Question }[]> {
    const rows = await db.predictionPick.findMany({
      where: { userId, question: { status: { in: ['settled', 'void'] } } },
      include: { question: { include } },
      orderBy: [{ updatedAt: 'desc' }],
      take: Math.min(Math.max(first, 1), 50),
    });
    return rows.map((r) => ({ pick: toPick(r), question: toQuestion(r.question) }));
  }

  // --- predictions R7: leaderboards -------------------------------------------------

  async function scopeUsers(userId: string | null, scope: BoardScope, opts: { communityId?: string | null }): Promise<string[] | null> {
    if (scope === 'global' || scope === 'sport') return null;
    if (!userId) return [];
    if (scope === 'friends') return [...new Set([userId, ...(await deps.friendsOf(userId))])];
    if (scope === 'community') return [...new Set([userId, ...(await deps.communityMembers(userId, opts.communityId ?? null))])];
    const peers = await deps.cityPeers(userId);
    return peers.city ? [...new Set([userId, ...peers.userIds])] : [userId];
  }

  async function leaderboard(userId: string | null, scope: BoardScope, opts: { sportId?: string | null; communityId?: string | null; first?: number } = {}): Promise<Board> {
    const first = Math.min(Math.max(opts.first ?? 50, 1), 100);
    const users = await scopeUsers(userId, scope, opts);
    if (users && users.length === 0) return { entries: [], me: null, size: 0 };
    const sport = scope === 'sport' && opts.sportId ? Prisma.sql`AND sport_id = ${opts.sportId}::uuid` : Prisma.empty;
    const people = users ? Prisma.sql`AND user_id IN (${Prisma.join(users.map((u) => Prisma.sql`${u}::uuid`))})` : Prisma.empty;
    const rows = await db.$queryRaw<{ user_id: string; points: bigint }[]>`
      SELECT user_id, SUM(points)::bigint AS points
        FROM prediction_points
       WHERE true ${sport} ${people}
       GROUP BY user_id`;
    const ranked = rankRows(rows.map((r) => ({ userId: r.user_id, points: Number(r.points) })));
    const me = userId ? (ranked.find((r) => r.userId === userId) ?? null) : null;
    return { entries: ranked.slice(0, first), me, size: ranked.length };
  }

  /** "#4 in Gurugram" — the Predict hero's city rank. Null without a city or points. */
  async function cityRank(userId: string): Promise<{ rank: number; city: string } | null> {
    const peers = await deps.cityPeers(userId);
    if (!peers.city) return null;
    const board = await leaderboard(userId, 'city', { first: 1 });
    return board.me ? { rank: board.me.rank, city: peers.city } : null;
  }

  return {
    question,
    requireQuestion,
    openQuestions,
    forMatch,
    staffList,
    splits,
    picksFor,
    pick,
    challenge,
    settle,
    voidQuestion,
    suggestForMatch,
    autoWinnerQuestions,
    autoSettleMatch,
    voidOpenForMatch,
    createQuestion,
    updateQuestion,
    stats,
    picksThisWeek,
    badges,
    results,
    leaderboard,
    cityRank,
  };
}

export type PredictionsService = ReturnType<typeof createPredictionsService>;
