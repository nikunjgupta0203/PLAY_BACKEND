/**
 * scoring — heats (plans 7, 8). A field contest has many entrants: a race, a
 * lifting flight, a long jump, a judged routine, a battle-royale lobby, a
 * group of golfers, bowlers or archers. It is scored as a heat, with the same
 * guarantees a match has:
 *
 *   R1 — every write carries expectedSeq; the loser of a race gets SCORE_STALE
 *        with the server's state.
 *   R2 — heat_score_events is append-only.
 *   R3 — every event stores the whole field state.
 *   R4 — what an event means comes from the rule (field.ts), never the sport.
 *   R5 — the outbox carries the update; nothing is published inline.
 *
 * Heats are run by staff: an owner or manager splits the category's confirmed
 * entries into heats, then advances the top of each closed heat (and the best
 * of the rest) into the next round, up to the final. Any staff grant (scorer
 * included) records into a heat.
 */
import type { Db, Tx } from '../../../platform/db.js';
import { forbidden, UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import type { ScoringRule } from '../../sport/index.js';
import {
  applyFieldEvent,
  FieldInputError,
  initialFieldState,
  qualifiers,
  splitIntoHeats,
  standings,
  type FieldEvent,
  type FieldRule,
  type FieldState,
  type Standing,
} from '../field.js';
import { ScoringCode, type Actor, type StaffRole } from './index.js';

export const FieldCode = {
  /** The category's sport is a two-sided sport: it is played as matches, not heats. */
  NOT_A_FIELD_SPORT: 'NOT_A_FIELD_SPORT',
  HEAT_NOT_FOUND: 'HEAT_NOT_FOUND',
  /** A heat needs at least one confirmed entry. */
  NO_ENTRIES: 'NO_ENTRIES',
  /** The category's first round is already drawn. */
  HEATS_EXIST: 'HEATS_EXIST',
  /** A round still has a live heat, or there is no round to advance from. */
  ROUND_NOT_CLOSED: 'ROUND_NOT_CLOSED',
  /** Nobody in the round has a result to go through on. */
  NO_QUALIFIERS: 'NO_QUALIFIERS',
  /** gap #32 — heats are drawn from the entries that exist once registration closes. */
  REGISTRATION_STILL_OPEN: 'REGISTRATION_STILL_OPEN',
  /** gap #32 — the category is already finished (or cancelled). */
  CATEGORY_FINISHED: 'CATEGORY_FINISHED',
} as const;

export interface HeatView {
  id: string;
  eventCategoryId: string;
  eventId: string;
  name: string;
  round: number;
  status: 'live' | 'closed';
  seq: number;
  rule: FieldRule;
  state: FieldState;
  /** Registration ids in running order. */
  entries: string[];
  standings: Standing[];
}

export interface FieldDeps {
  db: Db;
  ruleFor(eventCategoryId: string): Promise<ScoringRule>;
  eventOf(eventCategoryId: string): Promise<string>;
  roleOn(userId: string, eventId: string): Promise<StaffRole | null>;
  confirmedEntries(eventCategoryId: string): Promise<string[]>;
  /** open | full | closed | drawn | completed | cancelled. Absent in tests that never check it. */
  categoryStatus?(eventCategoryId: string): Promise<string>;
  /** gap #32 — marks the category completed in the caller's transaction (events owns the row). */
  markCategoryCompleted?(eventCategoryId: string, tx: Tx): Promise<unknown>;
}

const isField = (rule: ScoringRule): rule is ScoringRule & FieldRule => rule.kind === 'performance' || rule.kind === 'scorecard';

const notFound = () => new UserError(FieldCode.HEAT_NOT_FOUND, 'That heat could not be found.');

export function createFieldService(deps: FieldDeps) {
  const { db } = deps;

  async function fieldRule(eventCategoryId: string): Promise<FieldRule> {
    const rule = await deps.ruleFor(eventCategoryId);
    if (!isField(rule)) {
      throw new UserError(FieldCode.NOT_A_FIELD_SPORT, 'This sport is played as matches, not heats.');
    }
    return rule;
  }

  async function view(row: {
    id: string;
    eventCategoryId: string;
    name: string;
    round: number;
    status: string;
    scoreSeq: number;
    currentState: unknown;
  }): Promise<HeatView> {
    const rule = await fieldRule(row.eventCategoryId);
    const entries = await db.heatEntry.findMany({ where: { heatId: row.id }, orderBy: { position: 'asc' } });
    const state = row.currentState as FieldState;
    return {
      id: row.id,
      eventCategoryId: row.eventCategoryId,
      eventId: await deps.eventOf(row.eventCategoryId),
      name: row.name,
      round: row.round,
      status: row.status as HeatView['status'],
      seq: row.scoreSeq,
      rule,
      state,
      entries: entries.map((e) => e.registrationId),
      standings: standings(state, rule),
    };
  }

  /** Owners and managers run the event's heats. */
  async function assertOrganizer(actor: Actor, eventCategoryId: string): Promise<void> {
    const role = await deps.roleOn(actor.userId, await deps.eventOf(eventCategoryId));
    if (role !== 'owner' && role !== 'manager') throw forbidden();
  }

  async function insertHeat(
    tx: Tx,
    rule: FieldRule,
    heat: { eventCategoryId: string; name: string; round: number; entries: string[] },
  ): Promise<string> {
    const id = newId();
    const state = initialFieldState(rule, heat.entries);
    await tx.heat.create({
      data: { id, eventCategoryId: heat.eventCategoryId, name: heat.name, round: heat.round, currentState: state as object },
    });
    await tx.heatEntry.createMany({
      data: heat.entries.map((registrationId, i) => ({ heatId: id, registrationId, position: i + 1 })),
    });
    return id;
  }

  /** Serialises two organizers drawing or advancing the same category at once. */
  async function lockCategory(tx: Tx, eventCategoryId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM event_categories WHERE id = ${eventCategoryId}::uuid FOR UPDATE`;
  }

  /**
   * Round 1: the category's confirmed entries split serpentine into `count`
   * heats. Once only — later rounds come from advance().
   */
  async function createHeats(
    actor: Actor,
    input: { eventCategoryId: string; count: number; name?: string },
  ): Promise<HeatView[]> {
    await assertOrganizer(actor, input.eventCategoryId);
    const rule = await fieldRule(input.eventCategoryId);
    // gap #32 — like a bracket (gap #6): a heat drawn while registration is
    // open leaves out everyone who enters afterwards.
    if (deps.categoryStatus) {
      const status = await deps.categoryStatus(input.eventCategoryId);
      if (status === 'open' || status === 'full') {
        throw new UserError(FieldCode.REGISTRATION_STILL_OPEN, 'Close registration for this event before drawing the heats.');
      }
      if (status === 'completed' || status === 'cancelled') {
        throw new UserError(FieldCode.CATEGORY_FINISHED, 'This category is already finished.');
      }
    }
    const entries = await deps.confirmedEntries(input.eventCategoryId);
    if (entries.length === 0) throw new UserError(FieldCode.NO_ENTRIES, 'There are no confirmed entries to put in a heat.');
    const groups = splitIntoHeats(entries, Math.max(1, Math.floor(input.count)));
    const ids = await db.$transaction(async (tx: Tx) => {
      await lockCategory(tx, input.eventCategoryId);
      if ((await tx.heat.count({ where: { eventCategoryId: input.eventCategoryId } })) > 0) {
        throw new UserError(FieldCode.HEATS_EXIST, 'The heats for this category are already drawn.');
      }
      const single = groups.length === 1 ? (input.name?.trim() ?? '') : '';
      const out: string[] = [];
      for (const [i, group] of groups.entries()) {
        out.push(
          await insertHeat(tx, rule, {
            eventCategoryId: input.eventCategoryId,
            name: single || `Heat ${i + 1}`,
            round: 1,
            entries: group,
          }),
        );
      }
      return out;
    });
    return Promise.all(ids.map((id) => byId(id) as Promise<HeatView>));
  }

  /** One heat of every confirmed entry — createHeats with a count of one. */
  async function createHeat(actor: Actor, input: { eventCategoryId: string; name: string }): Promise<HeatView> {
    const [heat] = await createHeats(actor, { eventCategoryId: input.eventCategoryId, count: 1, name: input.name });
    return heat!;
  }

  /**
   * The next round, from a round whose heats are all closed: the top
   * `perHeat` of each heat (Q) and the `best` of the rest (q), in one heat,
   * best performance first.
   */
  async function advance(
    actor: Actor,
    input: { eventCategoryId: string; perHeat: number; best: number; name?: string },
  ): Promise<HeatView> {
    await assertOrganizer(actor, input.eventCategoryId);
    const rule = await fieldRule(input.eventCategoryId);
    const id = await db.$transaction(async (tx: Tx) => {
      await lockCategory(tx, input.eventCategoryId);
      const last = await tx.heat.findFirst({ where: { eventCategoryId: input.eventCategoryId }, orderBy: { round: 'desc' } });
      const round = last
        ? await tx.heat.findMany({ where: { eventCategoryId: input.eventCategoryId, round: last.round } })
        : [];
      if (!last || round.some((h) => h.status !== 'closed')) {
        throw new UserError(FieldCode.ROUND_NOT_CLOSED, 'Make every heat in the round final before advancing.');
      }
      const through = qualifiers(
        round.map((h) => h.currentState as unknown as FieldState),
        rule,
        { perHeat: Math.max(0, Math.floor(input.perHeat)), best: Math.max(0, Math.floor(input.best)) },
      );
      if (through.length === 0) {
        throw new UserError(FieldCode.NO_QUALIFIERS, 'Nobody in this round has a result to go through on.');
      }
      return insertHeat(tx, rule, {
        eventCategoryId: input.eventCategoryId,
        name: input.name?.trim() || 'Final',
        round: last.round + 1,
        entries: through,
      });
    });
    return byId(id) as Promise<HeatView>;
  }

  /** F3 — heats in these categories that have any score in them. */
  async function scoredHeatCount(eventCategoryIds: string[]): Promise<number> {
    if (eventCategoryIds.length === 0) return 0;
    return db.heat.count({ where: { eventCategoryId: { in: eventCategoryIds }, scoreSeq: { gt: 0 } } });
  }

  async function byId(heatId: string): Promise<HeatView | null> {
    const row = await db.heat.findUnique({ where: { id: heatId } });
    return row ? view(row) : null;
  }

  async function forCategory(eventCategoryId: string): Promise<HeatView[]> {
    const rows = await db.heat.findMany({
      where: { eventCategoryId },
      orderBy: [{ round: 'asc' }, { createdAt: 'asc' }, { name: 'asc' }],
    });
    return Promise.all(rows.map(view));
  }

  /** R1–R5 for a heat. */
  async function recordFieldEvent(
    actor: Actor,
    input: { heatId: string; event: FieldEvent; expectedSeq: number },
  ): Promise<HeatView> {
    const found = await db.heat.findUnique({ where: { id: input.heatId } });
    if (!found) throw notFound();
    const eventId = await deps.eventOf(found.eventCategoryId);
    if (!(await deps.roleOn(actor.userId, eventId))) throw forbidden();
    const rule = await fieldRule(found.eventCategoryId);

    await db.$transaction(async (tx: Tx) => {
      const rows = await tx.$queryRaw<{ score_seq: number; current_state: unknown; status: string }[]>`
        SELECT score_seq, current_state, status FROM heats WHERE id = ${input.heatId}::uuid FOR UPDATE
      `;
      const head = rows[0];
      if (!head) throw notFound();
      if (input.expectedSeq !== head.score_seq) {
        throw new UserError(ScoringCode.SCORE_STALE, 'Somebody else scored this heat first. Check the standings.', {
          details: { seq: head.score_seq, state: head.current_state },
        });
      }
      let state: FieldState;
      try {
        state = applyFieldEvent(head.current_state as FieldState, input.event, rule);
      } catch (err) {
        if (err instanceof FieldInputError) throw new UserError(ScoringCode.INVALID_EVENT, err.message);
        throw err;
      }
      const seq = head.score_seq + 1;
      await tx.heatScoreEvent.create({
        data: { heatId: input.heatId, seq, event: input.event as object, stateAfter: state as object, recordedBy: actor.userId },
      });
      await tx.heat.update({
        where: { id: input.heatId },
        data: { scoreSeq: seq, currentState: state as object, status: state.closed ? 'closed' : 'live' },
      });
      await outboxWrite(tx, { topic: 'heat.score', payload: { heatId: input.heatId, eventId, seq } });
    });
    return byId(input.heatId) as Promise<HeatView>;
  }

  /** What a viewer may do with a category's heats: is it a field sport, may they open heats, may they score. */
  async function access(
    userId: string | null,
    eventCategoryId: string,
  ): Promise<{ isField: boolean; canManage: boolean; canScore: boolean }> {
    const isFieldSport = isField(await deps.ruleFor(eventCategoryId));
    if (!userId || !isFieldSport) return { isField: isFieldSport, canManage: false, canScore: false };
    const role = await deps.roleOn(userId, await deps.eventOf(eventCategoryId));
    return { isField: true, canManage: role === 'owner' || role === 'manager', canScore: role !== null };
  }

  /**
   * gap #32 — a contest run in heats has no bracket to say when it is over, so
   * the organizer says so, once every heat is closed. It completes the
   * category, which can complete the event, which schedules the host's payout.
   */
  async function finishCategory(actor: Actor, eventCategoryId: string): Promise<void> {
    await assertOrganizer(actor, eventCategoryId);
    await fieldRule(eventCategoryId);
    if (!deps.markCategoryCompleted) throw new Error('scoring: no category completion wired');
    const eventId = await deps.eventOf(eventCategoryId);
    if (deps.categoryStatus) {
      const status = await deps.categoryStatus(eventCategoryId);
      if (status === 'completed') return;
      if (status === 'cancelled') throw new UserError(FieldCode.CATEGORY_FINISHED, 'This category was cancelled.');
    }
    await db.$transaction(async (tx: Tx) => {
      await lockCategory(tx, eventCategoryId);
      const heats = await tx.heat.findMany({ where: { eventCategoryId } });
      if (heats.length === 0 || heats.some((h) => h.status !== 'closed')) {
        throw new UserError(FieldCode.ROUND_NOT_CLOSED, 'Make every heat final before finishing the category.');
      }
      await deps.markCategoryCompleted!(eventCategoryId, tx);
      await outboxWrite(tx, { topic: 'category.completed', payload: { eventId, eventCategoryId } });
    });
  }

  return {
    scoredHeatCount, createHeat, createHeats, advance, byId, forCategory, recordFieldEvent, access, finishCategory };
}

export type FieldService = ReturnType<typeof createFieldService>;
