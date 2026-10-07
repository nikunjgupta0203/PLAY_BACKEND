/**
 * scoring — heats in GraphQL (plans 7, 8). A field contest's standings, each
 * entrant's record, and the one write: recordFieldEvent, which carries
 * expectedSeq like a point (scoring R1) and returns the heat on failure too.
 */
import { builder } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { UserError } from '../../../platform/errors/index.js';
import { registration } from '../../registration/index.js';
import { RegistrationRef } from '../../registration/schema/index.js';
import { field } from '../index.js';
import type { FieldEvent, HeatView, Standing } from '../index.js';

type EntryRecordOut = HeatView['state']['entries'][string];
type StandingOut = Standing & { record: EntryRecordOut };

const AttemptRef = builder.objectRef<EntryRecordOut['attempts'][number]>('FieldAttempt').implement({
  fields: (t) => ({
    lift: t.string({ nullable: true, resolve: (a) => a.lift }),
    value: t.float({ nullable: true, description: 'Null for a pass.', resolve: (a) => a.value }),
    valid: t.exposeBoolean('valid'),
  }),
});

const PlacementRef = builder.objectRef<EntryRecordOut['placements'][number]>('FieldPlacement').implement({
  fields: (t) => ({ place: t.exposeInt('place'), kills: t.exposeInt('kills') }),
});

const EntryRecordRef = builder.objectRef<EntryRecordOut>('FieldEntryRecord').implement({
  description: 'Everything recorded for one entrant in a heat.',
  fields: (t) => ({
    marks: t.field({ type: ['Float'], resolve: (r) => r.marks }),
    attempts: t.field({ type: [AttemptRef], resolve: (r) => r.attempts }),
    judgeScores: t.field({ type: ['Float'], nullable: true, resolve: (r) => r.judgeScores }),
    placements: t.field({ type: [PlacementRef], resolve: (r) => r.placements }),
    card: t.field({ type: ['Int'], description: 'Golf strokes per hole, bowling rolls, or arrows (X = 11).', resolve: (r) => r.card }),
  }),
});

const StandingRef = builder.objectRef<StandingOut>('HeatStanding').implement({
  fields: (t) => ({
    registration: t.field({
      type: RegistrationRef,
      nullable: true,
      resolve: (s) => registration.findById(s.entry),
    }),
    registrationId: t.id({ resolve: (s) => s.entry }),
    place: t.int({ nullable: true, description: 'Shared by entrants level on every criterion. Null: no result yet, or DNS/DNF/DQ.', resolve: (s) => s.place }),
    value: t.float({ nullable: true, resolve: (s) => s.value }),
    display: t.string({ nullable: true, description: 'How the value reads: "−1 thru 2", "220".', resolve: (s) => s.display }),
    status: t.string({ description: 'active | DNS | DNF | DQ', resolve: (s) => s.status }),
    record: t.field({ type: EntryRecordRef, resolve: (s) => s.record }),
  }),
});

export const HeatRef = builder.objectRef<HeatView>('Heat').implement({
  description: 'Plans 7, 8 — a field contest: many entrants, ranked by the sport’s rule.',
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    round: t.int({ description: '1 for the first heats; the last round is the final.', resolve: (h) => h.round }),
    status: t.string({ description: 'live | closed', resolve: (h) => h.status }),
    seq: t.int({ description: 'The expectedSeq the next write must carry (scoring R1).', resolve: (h) => h.seq }),
    ruleKind: t.string({ description: 'performance | scorecard', resolve: (h) => h.rule.kind }),
    entryOrder: t.field({ type: ['ID'], description: 'Registration ids in running order: lane, bib, flight or tee time.', resolve: (h) => h.entries }),
    viewerCanScore: t.boolean({
      description: 'Any staff grant on the event may record into a heat.',
      resolve: async (h, _args, ctx) => (await field.access(ctx.actor?.userId ?? null, h.eventCategoryId)).canScore,
    }),
    ruleDefinition: t.string({ description: 'The rule document as JSON.', resolve: (h) => JSON.stringify(h.rule) }),
    standings: t.field({
      type: [StandingRef],
      description: 'Best first; entrants with no result, then DNS/DNF/DQ, last.',
      resolve: (h) => h.standings.map((s) => ({ ...s, record: h.state.entries[s.entry]! })),
    }),
  }),
});

const FinishFieldCategoryPayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('FinishFieldCategoryPayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const HeatPayload = builder
  .objectRef<{ heat: HeatView | null; userError: UserErrorShape | null }>('HeatPayload')
  .implement({
    fields: (t) => ({
      heat: t.field({ type: HeatRef, nullable: true, description: 'The heat as the server now has it — on failure too.', resolve: (p) => p.heat }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const HeatsPayload = builder
  .objectRef<{ heats: HeatView[]; userError: UserErrorShape | null }>('HeatsPayload')
  .implement({
    fields: (t) => ({
      heats: t.field({ type: [HeatRef], resolve: (p) => p.heats }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const FieldEventTypeEnum = builder.enumType('FieldEventType', {
  values: {
    MARK: { value: 'mark' as const, description: '`value` — a time, a distance, a rep count.' },
    ATTEMPT: { value: 'attempt' as const, description: '`value` (null for a pass), `valid`, and `lift` where there are lifts.' },
    STATUS: { value: 'status' as const, description: '`code` — DNS, DNF or DQ.' },
    JUDGE_SCORES: { value: 'judge_scores' as const, description: '`scores` — one per judge.' },
    PLACEMENT: { value: 'placement' as const, description: '`place` and `kills` for one battle-royale match.' },
    CARD: { value: 'card' as const, description: '`values` — a golf hole, bowling rolls, or an end of arrows (X = 11).' },
    CLOSE: { value: 'close' as const, description: 'The standings are final.' },
  },
});

const RecordFieldEventInput = builder.inputType('RecordFieldEventInput', {
  fields: (t) => ({
    heatId: t.id({ required: true }),
    expectedSeq: t.int({ required: true }),
    type: t.field({ type: FieldEventTypeEnum, required: true }),
    entry: t.id({ required: false, description: 'The registration this is for. Every type but CLOSE.' }),
    value: t.float({ required: false }),
    lift: t.string({ required: false }),
    valid: t.boolean({ required: false }),
    code: t.string({ required: false }),
    scores: t.floatList({ required: false }),
    place: t.int({ required: false }),
    kills: t.int({ required: false }),
    values: t.intList({ required: false }),
  }),
});

type FieldInput = {
  type: FieldEvent['type'];
  entry?: string | number | null;
  value?: number | null;
  lift?: string | null;
  valid?: boolean | null;
  code?: string | null;
  scores?: number[] | null;
  place?: number | null;
  kills?: number | null;
  values?: number[] | null;
};

const invalid = (message: string) => new UserError('INVALID_EVENT', message);

function toFieldEvent(i: FieldInput): FieldEvent {
  if (i.type === 'close') return { type: 'close' };
  if (i.entry == null) throw invalid(`${i.type} needs an entry`);
  const entry = String(i.entry);
  switch (i.type) {
    case 'mark':
      if (i.value == null) throw invalid('a mark needs a value');
      return { type: 'mark', entry, value: i.value };
    case 'attempt':
      if (i.valid == null) throw invalid('an attempt needs valid: true or false');
      return { type: 'attempt', entry, lift: i.lift ?? null, value: i.value ?? null, valid: i.valid };
    case 'status':
      if (i.code !== 'DNS' && i.code !== 'DNF' && i.code !== 'DQ') throw invalid('a status is DNS, DNF or DQ');
      return { type: 'status', entry, code: i.code };
    case 'judge_scores':
      return { type: 'judge_scores', entry, scores: i.scores ?? [] };
    case 'placement':
      if (i.place == null) throw invalid('a placement needs a place');
      return { type: 'placement', entry, place: i.place, kills: i.kills ?? 0 };
    case 'card':
      return { type: 'card', entry, values: i.values ?? [] };
  }
}

const FieldCategoryRef = builder
  .objectRef<{ eventCategoryId: string; isField: boolean; canManage: boolean; canScore: boolean }>('FieldCategory')
  .implement({
    description: 'Plans 7, 8 — whether a category is run as heats, what the viewer may do, and its heats.',
    fields: (t) => ({
      isField: t.exposeBoolean('isField'),
      viewerCanManage: t.boolean({ description: 'May open a heat (owner or manager).', resolve: (c) => c.canManage }),
      viewerCanScore: t.boolean({ resolve: (c) => c.canScore }),
      heats: t.field({ type: [HeatRef], resolve: (c) => (c.isField ? field.forCategory(c.eventCategoryId) : []) }),
    }),
  });

builder.queryFields((t) => ({
  fieldCategory: t.field({
    type: FieldCategoryRef,
    args: { eventCategoryId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const eventCategoryId = String(args.eventCategoryId);
      return { eventCategoryId, ...(await field.access(ctx.actor?.userId ?? null, eventCategoryId)) };
    },
  }),
  heat: t.field({
    type: HeatRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args) => field.byId(String(args.id)),
  }),
  heats: t.field({
    type: [HeatRef],
    description: 'A field category’s heats, oldest first.',
    args: { eventCategoryId: t.arg.id({ required: true }) },
    resolve: (_root, args) => field.forCategory(String(args.eventCategoryId)),
  }),
}));

builder.mutationFields((t) => ({
  createHeat: t.field({
    type: HeatPayload,
    description: 'A heat of every confirmed entry in a field category. Owners and managers only.',
    args: {
      eventCategoryId: t.arg.id({ required: true }),
      name: t.arg.string({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        field.createHeat(actor, { eventCategoryId: String(args.eventCategoryId), name: args.name ?? '' }),
      );
      return { heat: data ?? null, userError };
    },
  }),

  createHeats: t.field({
    type: HeatsPayload,
    description: 'Round 1: the confirmed entries split serpentine into `count` heats. Owners and managers, once per category.',
    args: {
      eventCategoryId: t.arg.id({ required: true }),
      count: t.arg.int({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        field.createHeats(actor, { eventCategoryId: String(args.eventCategoryId), count: args.count }),
      );
      return { heats: data ?? [], userError };
    },
  }),

  finishFieldCategory: t.field({
    type: FinishFieldCategoryPayload,
    description:
      'gap #32 — owner or manager, once every heat is final: the category is over. That can ' +
      'complete the event, which schedules the host’s payout.',
    args: { eventCategoryId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => field.finishCategory(actor, String(args.eventCategoryId)));
      return { ok: userError === null, userError };
    },
  }),

  advanceHeats: t.field({
    type: HeatPayload,
    description:
      'The next round from a round whose heats are all final: the top `perHeat` of each heat, then the `best` of the rest across heats.',
    args: {
      eventCategoryId: t.arg.id({ required: true }),
      perHeat: t.arg.int({ required: true }),
      best: t.arg.int({ required: false }),
      name: t.arg.string({ required: false }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        field.advance(actor, {
          eventCategoryId: String(args.eventCategoryId),
          perHeat: args.perHeat,
          best: args.best ?? 0,
          name: args.name ?? undefined,
        }),
      );
      return { heat: data ?? null, userError };
    },
  }),

  recordFieldEvent: t.field({
    type: HeatPayload,
    description: 'Scoring R1–R5 for a heat. SCORE_STALE and INVALID_EVENT come back with the heat.',
    args: { input: t.arg({ type: RecordFieldEventInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const heatId = String(args.input.heatId);
      const { data, userError } = await attempt(() =>
        field.recordFieldEvent(actor, {
          heatId,
          expectedSeq: args.input.expectedSeq,
          event: toFieldEvent(args.input as FieldInput),
        }),
      );
      return { heat: data ?? (await field.byId(heatId)), userError };
    },
  }),

  undoFieldEvent: t.field({
    type: HeatPayload,
    description:
      'Takes back the heat’s last write — a mistyped mark, a wrong DNF, or a heat made final too soon. ' +
      'Carries expectedSeq like any write (scoring R1).',
    args: { heatId: t.arg.id({ required: true }), expectedSeq: t.arg.int({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const heatId = String(args.heatId);
      const { data, userError } = await attempt(() =>
        field.undoFieldEvent(actor, { heatId, expectedSeq: args.expectedSeq }),
      );
      return { heat: data ?? (await field.byId(heatId)), userError };
    },
  }),
}));
