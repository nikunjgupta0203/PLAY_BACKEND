/**
 * The ONLY surface other modules may import (conventions.md §1).
 *
 * competitions reads two things it does not own: a pro match (its sport,
 * teams and start, for questions tied to a match) and upcoming feed matches
 * (the bulk "Who wins?" tool). Both are read-only lookups done here at the
 * composition edge, so the service stays testable with plain functions.
 */
import { db } from '../../platform/db.js';
import { createCompetitionsService, type MatchInfo } from './service/index.js';

const matchInclude = { homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } as const;

async function slugsOf(sportIds: string[]): Promise<Map<string, string>> {
  const rows = await db.sport.findMany({ where: { id: { in: [...new Set(sportIds)] } }, select: { id: true, slug: true } });
  return new Map(rows.map((r) => [r.id, r.slug]));
}

type MatchRow = Awaited<ReturnType<typeof db.proMatch.findFirstOrThrow<{ include: typeof matchInclude }>>>;
const toInfo = (m: MatchRow, slug: string): MatchInfo => ({
  id: m.id,
  sportId: m.sportId,
  sportSlug: slug,
  league: m.league,
  stage: m.stage,
  home: m.homeTeam.name,
  away: m.awayTeam.name,
  startsAt: m.startsAt,
  status: m.status,
});

export const competitions = createCompetitionsService({
  db,
  async match(matchId) {
    const m = await db.proMatch.findUnique({ where: { id: matchId }, include: matchInclude });
    if (!m) return null;
    return toInfo(m, (await slugsOf([m.sportId])).get(m.sportId) ?? '');
  },
  async upcomingMatches({ sportId, league, from, to }) {
    const rows = await db.proMatch.findMany({
      where: {
        status: 'scheduled',
        startsAt: { gte: from, lte: to },
        ...(sportId ? { sportId } : {}),
        ...(league ? { league: { contains: league, mode: 'insensitive' } } : {}),
      },
      include: matchInclude,
      orderBy: { startsAt: 'asc' },
      take: 200,
    });
    const slugs = await slugsOf(rows.map((r) => r.sportId));
    return rows.map((m) => toInfo(m, slugs.get(m.sportId) ?? ''));
  },
  async notify(r) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emitBulk(r.userIds, r.template, r.payload as never, { kind: 'route', route: 'competition', id: r.slug });
  },
});

export {
  CompetitionCode,
  MAX_OPTIONS as COMPETITION_MAX_OPTIONS,
  OUTCOMES as COMPETITION_OUTCOMES,
  SEGMENTS,
  denseRanks,
  crowdPoints,
  crowdShare,
  earnable,
  prizeRanks,
  groupScore,
  istMonthStart,
  normaliseCode,
  scorePick as scoreCompetitionPick,
  shortName,
  specialistTitle,
  suggestAnswer as suggestCompetitionAnswer,
  winnerQuestionFor,
} from './service/index.js';
export type {
  Board as CompetitionBoard,
  BoardKind as CompetitionBoardKind,
  BoardPeriod as CompetitionBoardPeriod,
  BoardRow as CompetitionBoardRow,
  Competition,
  CompetitionInput,
  CompetitionStatus,
  CompetitionsService,
  Group as CompetitionGroup,
  GroupInput as CompetitionGroupInput,
  GroupStanding as CompetitionGroupStanding,
  JoinCode as CompetitionJoinCode,
  Member as CompetitionMember,
  Moment as CompetitionMoment,
  MomentInput as CompetitionMomentInput,
  Option as CompetitionOption,
  Outcome as CompetitionOutcome,
  Pick as CompetitionPick,
  Prize as CompetitionPrize,
  QuestionInput as CompetitionQuestionInput,
  QuestionKind as CompetitionQuestionKind,
  Question as CompetitionQuestion,
  QuestionStatus as CompetitionQuestionStatus,
  ScoringLine as CompetitionScoringLine,
  Segment as CompetitionSegment,
  Split as CompetitionSplit,
  Standing as CompetitionStanding,
} from './service/index.js';
