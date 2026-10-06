/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { events } from '../events/index.js';
import { identity } from '../identity/index.js';
import { registration } from '../registration/index.js';
import { parseScoringRule, sport } from '../sport/index.js';
import { tournament } from '../tournament/index.js';
import { createScoringRepo } from './repo/index.js';
import { createFieldService } from './service/field.js';
import { createScoringService, type MatchesPort } from './service/index.js';

/**
 * `matches` belongs to `tournament`, apart from the two score columns. Status
 * transitions and advancement are asked for, never written (conventions.md §1).
 */
const matches: MatchesPort = {
  async byId(matchId) {
    const match = await tournament.matchById(matchId).catch(() => null);
    if (!match) return null;
    const draw = await tournament.byId(match.tournamentId);
    const event = await events.byId(draw.eventId);
    return {
      id: match.id,
      tournamentId: match.tournamentId,
      eventId: draw.eventId,
      eventCategoryId: match.eventCategoryId,
      sportId: match.sportId,
      status: match.status,
      bracket: match.bracket,
      eventEndsAt: event.endsAt,
      sideARegistrationId: match.sideARegistrationId,
      sideBRegistrationId: match.sideBRegistrationId,
      eventStatus: event.status,
      scheduledAt: match.scheduledAt,
      eventStartsAt: event.startsAt,
    };
  },
  markLive: (matchId, tx) => tournament.markLive(matchId, tx),
  markAwaitingConfirm: (matchId, tx) => tournament.markAwaitingConfirm(matchId, tx),
  reopen: (matchId, tx) => tournament.reopen(matchId, tx),
  advance: (matchId, outcome, tx) => tournament.advance(matchId, outcome, tx),
  correct: (matchId, outcome, tx) => tournament.correct(matchId, outcome, tx),
};

export const scoring = createScoringService({
  db,
  repo: createScoringRepo(db),
  matches,
  // R4 — the category's format picks the rule; the sport's default covers a
  // format with no rule of its own.
  async ruleFor(eventCategoryId) {
    const category = await events.categoryById(eventCategoryId);
    // F21, F22 — the rule frozen on the draw (the host's format, or the
    // sport's as it was at publish) beats whatever the sport says today.
    if (category.scoringRule) return parseScoringRule(category.scoringRule);
    const formats = await sport.formatsFor(category.sportId);
    const format = formats.find((f) => f.key === category.format);
    return sport.scoringRuleFor(category.sportId, format?.id);
  },
  async roleOn(userId, eventId) {
    return (await identity.grantsFor(userId, eventId))?.role ?? null;
  },
  async membersOf(registrationId) {
    const team = await registration.teamFor(registrationId);
    if (team.length > 0) return team.map((m) => m.userId);
    // Singles: the captain is the entry.
    const found = await registration.findById(registrationId);
    return found ? [found.captainUserId] : [];
  },
  // F6 — a walkover is not claimed against someone standing at the desk.
  async checkedIn(registrationId) {
    return (await registration.findById(registrationId))?.status === 'checked_in';
  },
  // F4 — who could settle a dispute without being in the match.
  staffOf: (eventId) => identity.staffFor(eventId),
});

/** Plans 7, 8 — heats: field contests with many entrants. */
export const field = createFieldService({
  db,
  async ruleFor(eventCategoryId) {
    const category = await events.categoryById(eventCategoryId);
    if (category.scoringRule) return parseScoringRule(category.scoringRule);
    const format = (await sport.formatsFor(category.sportId)).find((f) => f.key === category.format);
    return sport.scoringRuleFor(category.sportId, format?.id);
  },
  async eventOf(eventCategoryId) {
    return (await events.categoryById(eventCategoryId)).eventId;
  },
  async roleOn(userId, eventId) {
    return (await identity.grantsFor(userId, eventId))?.role ?? null;
  },
  async confirmedEntries(eventCategoryId) {
    return (await registration.confirmedForCategory(eventCategoryId)).map((r) => r.id);
  },
  async categoryStatus(eventCategoryId) {
    return (await events.categoryById(eventCategoryId)).status;
  },
  markCategoryCompleted: (eventCategoryId, tx) => events.markCategoryCompleted(eventCategoryId, tx),
});

export { FieldCode, type FieldService, type HeatView } from './service/field.js';
export type { FieldEvent, FieldRule, FieldState, Standing } from './field.js';
export { OVERRIDE_AFTER_MS, ScoringCode } from './service/index.js';
export { applyPoint, initialState, kicksNext, winnerOf } from './engine.js';
export type {
  Access,
  BoutState,
  Dismissal,
  GameScore,
  InningsRecord,
  InningsState,
  Outcome,
  ResultRow,
  ScoreEvent,
  ScoreEventRow,
  ScoreState,
  Shootout,
  ScoringService,
  Side,
  Snapshot,
  SweepReport,
} from './service/index.js';
