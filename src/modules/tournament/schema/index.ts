/**
 * tournament — GraphQL surface (docs/modules/09-tournament.md).
 *
 * `Match` is one of the four Node types (conventions.md §4): it is what a
 * spectator deep-links into from a WhatsApp forward on a Saturday morning.
 * `Tournament` is not, and the module doc writes `implements Node` for it —
 * conventions.md §4 fixes the list at four, which makes the module doc the
 * thing that is wrong, exactly as it was for `EventCategory`.
 *
 * `Match.currentScore` and `Match.result` are added by `scoring`, which owns
 * them (modules/scoring/schema).
 */
import { builder } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import { isUserError, SystemError } from '../../../platform/errors/index.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { events } from '../../events/index.js';
import { EventCategoryRef, EventRef } from '../../events/schema/index.js';
import { registration } from '../../registration/index.js';
import { RegistrationRef } from '../../registration/schema/index.js';
import { venues } from '../../venues/index.js';
import { CourtRef } from '../../venues/schema/index.js';
import { tournament } from '../index.js';
import type {
  Bracket,
  BracketRound,
  MatchBracket,
  CourtAssignment,
  LeagueGroup,
  Match,
  MatchStatus,
  StandingRow,
  Tournament,
} from '../index.js';
import type { DrawPreview } from '../service/index.js';

// --- enums -------------------------------------------------------------------

const BracketTypeEnum = builder.enumType('BracketType', {
  description:
    'Every draw is a Championship and a Plate. A first-round loser is not out ' +
    'of the tournament — they are in the other half of it (tournament R5).',
  values: {
    CHAMPIONSHIP: { value: 'championship' as MatchBracket },
    PLATE: { value: 'plate' as MatchBracket },
    LEAGUE: { value: 'league' as MatchBracket, description: 'Everyone plays everyone; a table decides.' },
    GROUP: { value: 'group' as MatchBracket, description: 'A group-stage match; see Match.group.' },
    THIRD_PLACE: { value: 'third_place' as MatchBracket, description: 'F23 — the semi-final losers play for third.' },
  },
});

const MatchStatusEnum = builder.enumType('MatchStatus', {
  description:
    'WALKOVER is a result, not an absence: a bye is a real match row with one ' +
    'side (tournament R3). VOID is a Plate position nobody could ever reach.',
  values: {
    SCHEDULED: { value: 'scheduled' as MatchStatus },
    READY: { value: 'ready' as MatchStatus },
    LIVE: { value: 'live' as MatchStatus },
    AWAITING_CONFIRM: { value: 'awaiting_confirm' as MatchStatus },
    COMPLETED: { value: 'completed' as MatchStatus },
    WALKOVER: { value: 'walkover' as MatchStatus },
    VOID: { value: 'void' as MatchStatus },
  },
});

const AssignedByEnum = builder.enumType('CourtAssignedBy', {
  description:
    'tournament R13 — the schedule is advisory. SCHEDULER produced it; ' +
    'ORGANIZER means a human moved it, which happens all day.',
  values: { SCHEDULER: { value: 'scheduler' }, ORGANIZER: { value: 'organizer' } },
});

// --- types -------------------------------------------------------------------

const MatchRef = builder.objectRef<Match>('Match');

builder.node(MatchRef, {
  id: { resolve: (m) => m.id },
  loadOne: async (id) => {
    const found = await tournament.matchById(id).catch(() => null);
    return found;
  },
  fields: (t) => ({
    id: t.exposeID('id'),
    bracket: t.field({ type: BracketTypeEnum, resolve: (m) => m.bracket }),
    round: t.exposeInt('round', { description: 'A knockout round, or a league or group matchday.' }),
    slot: t.exposeInt('slot', { description: '0-based, top of the bracket first.' }),
    group: t.int({
      nullable: true,
      description: 'Which group, from 1 — group-stage matches only.',
      resolve: (m) => m.groupNo,
    }),
    tallyA: t.int({
      nullable: true,
      description: 'Side A’s total on the scoreline (goals, runs, points) once a result is confirmed; what a table counts.',
      resolve: (m) => m.tallyA,
    }),
    tallyB: t.int({ nullable: true, resolve: (m) => m.tallyB }),
    sideA: t.field({
      type: RegistrationRef,
      nullable: true,
      description: 'Null while the feeding match is still being played — or forever, on a bye.',
      resolve: (m) =>
        m.sideARegistrationId ? registration.findById(m.sideARegistrationId) : null,
    }),
    sideB: t.field({
      type: RegistrationRef,
      nullable: true,
      resolve: (m) =>
        m.sideBRegistrationId ? registration.findById(m.sideBRegistrationId) : null,
    }),
    winner: t.field({
      type: RegistrationRef,
      nullable: true,
      description:
        'Who came out of this match. `scoring` records how it was won; this is ' +
        'the bracket’s own record that it was, because a final advances nobody.',
      resolve: (m) =>
        m.winnerRegistrationId ? registration.findById(m.winnerRegistrationId) : null,
    }),
    court: t.field({
      type: CourtRef,
      nullable: true,
      resolve: (m) => (m.courtId ? venues.findCourtById(m.courtId) : null),
    }),
    scheduledAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'Advisory (tournament R13). Organizers move matches by hand.',
      resolve: (m) => m.scheduledAt,
    }),
    status: t.field({ type: MatchStatusEnum, resolve: (m) => m.status }),
    scoreSeq: t.int({
      description:
        'Optimistic-concurrency handle for live scoring (scoring R1). Clients ' +
        'send it back with every point.',
      resolve: (m) => m.scoreSeq,
    }),
    completedAt: t.field({ type: 'DateTime', nullable: true, resolve: (m) => m.completedAt }),
    category: t.field({
      type: EventCategoryRef,
      nullable: true,
      resolve: (m) => events.categoryById(m.eventCategoryId).catch(() => null),
    }),
    event: t.field({
      type: EventRef,
      nullable: true,
      description:
        'The event this match belongs to — a match opened from a notification ' +
        'needs its timezone and a way back to the draw.',
      resolve: async (m) => {
        const category = await events.categoryById(m.eventCategoryId).catch(() => null);
        return category ? events.byId(category.eventId).catch(() => null) : null;
      },
    }),
  }),
});

const BracketRoundRef = builder.objectRef<BracketRound>('BracketRound').implement({
  description: 'One column of the bracket. `name` is derived on read, never stored.',
  fields: (t) => ({
    bracket: t.field({ type: BracketTypeEnum, resolve: (r) => r.bracket }),
    round: t.exposeInt('round'),
    name: t.exposeString('name', { description: '"Final", "Semi-final", "Round of 16".' }),
    matches: t.field({ type: [MatchRef], resolve: (r) => r.matches }),
  }),
});

const StandingRowRef = builder.objectRef<StandingRow>('StandingRow').implement({
  description:
    'Standard competition ranking across both brackets: an entry that went ' +
    'further in the Championship finishes above one that did not, and the ' +
    'first-round losers are separated by how far they went in the Plate.',
  fields: (t) => ({
    registration: t.field({
      type: RegistrationRef,
      nullable: true,
      resolve: (row) => registration.findById(row.registrationId),
    }),
    seed: t.exposeInt('seed'),
    bracket: t.field({ type: BracketTypeEnum, resolve: (row) => row.bracket }),
    wins: t.exposeInt('wins'),
    losses: t.exposeInt('losses'),
    eliminatedInRound: t.int({ nullable: true, resolve: (row) => row.eliminatedInRound }),
    place: t.exposeInt('place', { description: 'Joint places share a number.' }),
  }),
});

const CourtAssignmentRef = builder
  .objectRef<CourtAssignment>('CourtAssignment')
  .implement({
    fields: (t) => ({
      match: t.field({ type: MatchRef, resolve: (a) => tournament.matchById(a.matchId) }),
      court: t.field({
        type: CourtRef,
        nullable: true,
        resolve: (a) => venues.findCourtById(a.courtId),
      }),
      startsAt: t.field({ type: 'DateTime', resolve: (a) => a.startsAt }),
      endsAt: t.field({ type: 'DateTime', nullable: true, resolve: (a) => a.endsAt }),
      assignedBy: t.field({ type: AssignedByEnum, resolve: (a) => a.assignedBy }),
    }),
  });

const LeagueRowRef = builder.objectRef<LeagueGroup['table'][number]>('LeagueRow').implement({
  description: 'One line of a league or group table: 3 points a win, 1 a draw.',
  fields: (t) => ({
    registration: t.field({
      type: RegistrationRef,
      nullable: true,
      resolve: (r) => registration.findById(r.registrationId),
    }),
    registrationId: t.exposeID('registrationId'),
    place: t.exposeInt('place'),
    played: t.exposeInt('played'),
    won: t.exposeInt('won'),
    drawn: t.exposeInt('drawn'),
    lost: t.exposeInt('lost'),
    scoreFor: t.exposeInt('scoreFor', { description: 'Goals, runs, points — whatever the scoreline counts.' }),
    scoreAgainst: t.exposeInt('scoreAgainst'),
    points: t.exposeInt('points'),
  }),
});

const LeagueGroupRef = builder.objectRef<LeagueGroup>('LeagueGroup').implement({
  description:
    'A league table, or one group of a group stage. Ties: points, then score difference, then score ' +
    'for, then the matches between those still level, then the seeding.',
  fields: (t) => ({
    group: t.int({ nullable: true, description: 'Null for a league; 1, 2, … for a group.', resolve: (g) => g.group }),
    qualify: t.exposeInt('qualify', { description: 'Places 1 to this go through to the knockout. 0 in a league.' }),
    table: t.field({ type: [LeagueRowRef], resolve: (g) => g.table }),
  }),
});

const TournamentRef = builder.objectRef<Tournament>('Tournament').implement({
  description:
    'A generated draw. One per event category, and the unique constraint behind ' +
    'that is what makes two simultaneous generations collide rather than ' +
    'interleave two half-brackets.',
  fields: (t) => ({
    id: t.exposeID('id'),
    category: t.field({
      type: EventCategoryRef,
      resolve: (tr) => events.categoryById(tr.eventCategoryId),
    }),
    drawType: t.string({
      description: 'single_elim_with_plate | single_elim | league | groups_knockout',
      resolve: (tr) => tr.drawType,
    }),
    bracketSize: t.exposeInt('bracketSize', { description: 'For a league or group stage: the number of entries.' }),
    plateSize: t.exposeInt('plateSize', {
      description: 'Sized to the number of first-round losers, not to half the draw (R5).',
    }),
    drawnAt: t.field({ type: 'DateTime', resolve: (tr) => tr.drawnAt }),
    completedAt: t.field({ type: 'DateTime', nullable: true, resolve: (tr) => tr.completedAt }),
    championship: t.field({
      type: [BracketRoundRef],
      resolve: async (tr) => (await bracketOf(tr)).championship,
    }),
    plate: t.field({
      type: [BracketRoundRef],
      resolve: async (tr) => (await bracketOf(tr)).plate,
    }),
    thirdPlace: t.field({
      type: MatchRef,
      nullable: true,
      description: 'F23 — the match for third, when this knockout has one.',
      resolve: async (tr) => (await tournament.bracketFor(tr.eventCategoryId))?.thirdPlace ?? null,
    }),
    league: t.field({
      type: [LeagueGroupRef],
      description: 'The league table, or one table per group. Empty for a knockout draw.',
      resolve: (tr) => tournament.leagueTableFor(tr.eventCategoryId),
    }),
    fixtures: t.field({
      type: [MatchRef],
      description: 'League and group matches, by matchday.',
      resolve: async (tr) =>
        (await tournament.matchesFor(tr.id)).filter((m) => m.bracket === 'league' || m.bracket === 'group'),
    }),
    standings: t.field({
      type: [StandingRowRef],
      resolve: (tr) => tournament.standingsFor(tr.eventCategoryId),
    }),
    liveMatches: t.field({
      type: [MatchRef],
      resolve: async (tr) => {
        const live = await tournament.liveMatches(tr.eventId);
        return live.filter((m) => m.tournamentId === tr.id);
      },
    }),
    courtAssignments: t.field({
      type: [CourtAssignmentRef],
      resolve: (tr) => tournament.assignmentsFor(tr.id),
    }),
  }),
});

const EMPTY: Pick<Bracket, 'championship' | 'plate'> = { championship: [], plate: [] };

const DrawPairRef = builder
  .objectRef<{ sideA: string | null; sideB: string | null }>('DrawPreviewPair')
  .implement({
    fields: (t) => ({
      sideA: t.field({
        type: RegistrationRef,
        nullable: true,
        description: 'Null is a bye.',
        resolve: (p) => (p.sideA ? registration.findById(p.sideA) : null),
      }),
      sideB: t.field({
        type: RegistrationRef,
        nullable: true,
        resolve: (p) => (p.sideB ? registration.findById(p.sideB) : null),
      }),
    }),
  });

const DrawSeedRef = builder
  .objectRef<{ registrationId: string; seed: number }>('DrawPreviewSeed')
  .implement({
    fields: (t) => ({
      seed: t.exposeInt('seed'),
      registrationId: t.exposeID('registrationId'),
      registration: t.field({
        type: RegistrationRef,
        nullable: true,
        resolve: (x) => registration.findById(x.registrationId),
      }),
    }),
  });

const DrawGroupRef = builder.objectRef<{ ids: string[] }>('DrawPreviewGroup').implement({
  fields: (t) => ({
    entries: t.field({
      type: [RegistrationRef],
      resolve: async (g) =>
        (await Promise.all(g.ids.map((id) => registration.findById(id)))).filter(
          (r): r is NonNullable<typeof r> => r !== null,
        ),
    }),
  }),
});

const DrawPreviewRef = builder.objectRef<DrawPreview>('DrawPreview').implement({
  description: 'F1 — the draw as it would be made now. Nothing is written.',
  fields: (t) => ({
    drawType: t.exposeString('drawType'),
    bracketSize: t.exposeInt('bracketSize'),
    plateSize: t.exposeInt('plateSize'),
    matchCount: t.exposeInt('matchCount', { description: 'Matches in the whole draw, byes excluded.' }),
    seeds: t.field({ type: [DrawSeedRef], resolve: (p) => p.seeds }),
    firstRound: t.field({ type: [DrawPairRef], resolve: (p) => p.firstRound }),
    groups: t.field({
      type: [DrawGroupRef],
      description: 'A league is one group; a group stage one per group.',
      resolve: (p) => p.groups.map((ids) => ({ ids })),
    }),
  }),
});

async function bracketOf(tr: Tournament): Promise<Pick<Bracket, 'championship' | 'plate'>> {
  return (await tournament.bracketFor(tr.eventCategoryId)) ?? EMPTY;
}

// --- fields on other modules' types ------------------------------------------

/**
 * The draw hangs off the category rather than the event, for the same reason
 * capacity and price do: one tournament sells eight draws.
 *
 * Added from here rather than from `events/schema` so that the dependency
 * points one way — events does not know this module exists.
 */
builder.objectField(EventCategoryRef, 'tournament', (t) =>
  t.field({
    type: TournamentRef,
    nullable: true,
    description: 'Null until an organizer generates the draw.',
    resolve: (category) => tournament.findByCategory(category.id),
  }),
);

builder.objectField(EventRef, 'liveMatches', (t) =>
  t.field({
    type: [MatchRef],
    description:
      'What is on court right now, across every draw in this event. This is ' +
      'the Live Mode screen.',
    resolve: (event) => tournament.liveMatches(event.id),
  }),
);

builder.objectField(EventRef, 'scheduleCourtCount', (t) =>
  t.int({
    description:
      'Courts the scheduler can put this event’s matches on: its own, else its host’s venue’s. ' +
      'Zero — no match gets a time, and nobody gets the 30-minute reminder.',
    resolve: (event) => tournament.scheduleCourtCount(event.id),
  }),
);

// --- payloads ----------------------------------------------------------------

const GenerateDrawPayload = builder
  .objectRef<{ tournament: Tournament | null; userError: UserErrorShape | null }>(
    'GenerateDrawPayload',
  )
  .implement({
    fields: (t) => ({
      tournament: t.field({ type: TournamentRef, nullable: true, resolve: (p) => p.tournament }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const MatchPayload = builder
  .objectRef<{ match: Match | null; userError: UserErrorShape | null }>('MatchPayload')
  .implement({
    fields: (t) => ({
      match: t.field({ type: MatchRef, nullable: true, resolve: (p) => p.match }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ScheduleDrawPayload = builder
  .objectRef<{ assignments: CourtAssignment[]; userError: UserErrorShape | null }>(
    'ScheduleDrawPayload',
  )
  .implement({
    description:
      'What the scheduler placed on this run. It is advisory and idempotent: ' +
      'running it again places only what is newly ready (R11, R13).',
    fields: (t) => ({
      assignments: t.field({ type: [CourtAssignmentRef], resolve: (p) => p.assignments }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ------------------------------------------------------------------

const GenerateDrawInput = builder.inputType('GenerateDrawInput', {
  fields: (t) => ({
    eventCategoryId: t.id({ required: true }),
    seedOrder: t.idList({
      description:
        'F1 — the host seeding: every confirmed entry registration id, once, seed 1 first. ' +
        'Absent: seeded by rating.',
    }),
  }),
});

const AssignCourtInput = builder.inputType('AssignCourtInput', {
  description:
    'R13 — the manual override. The exclusion constraint on `court_assignments` ' +
    'is what keeps two matches off one court, not this input.',
  fields: (t) => ({
    matchId: t.id({ required: true }),
    courtId: t.id({ required: true }),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', description: 'Defaults to 45 minutes.' }),
  }),
});

// --- queries -----------------------------------------------------------------

builder.queryFields((t) => ({
  tournament: t.field({
    type: TournamentRef,
    nullable: true,
    description: 'The draw for one event category, if it has been generated.',
    args: { eventCategoryId: t.arg.id({ required: true }) },
    resolve: (_root, args) => tournament.findByCategory(args.eventCategoryId.toString()),
  }),

  match: t.field({
    type: MatchRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args) => tournament.matchById(args.id.toString()).catch(() => null),
  }),

  drawPreview: t.field({
    type: DrawPreviewRef,
    description: 'F1 — event staff: the draw as it would be made now, with an optional seeding. Nothing is written.',
    args: { input: t.arg({ type: GenerateDrawInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      try {
        return await tournament.drawPreview(requireActor(ctx), {
          eventCategoryId: String(args.input.eventCategoryId),
          seedOrder: args.input.seedOrder?.map(String) ?? null,
        });
      } catch (err) {
        // A query has no userError field: a rule the host broke (too few
        // entries, a bad seeding) travels as the error's code, which the app
        // reads, rather than as an internal error.
        if (isUserError(err)) throw new SystemError(err.code, err.message);
        throw err;
      }
    },
  }),
}));

// --- mutations ---------------------------------------------------------------

builder.mutationFields((t) => ({
  generateDraw: t.field({
    type: GenerateDrawPayload,
    description:
      'R1, R6, R7 — confirmed entries only, the whole bracket in one ' +
      'transaction, and never below the category’s minimum.',
    args: { input: t.arg({ type: GenerateDrawInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        tournament.generateDraw(actor, {
          eventCategoryId: args.input.eventCategoryId.toString(),
          seedOrder: args.input.seedOrder?.map(String) ?? null,
        }),
      );
      return { tournament: data, userError };
    },
  }),

  regenerateDraw: t.field({
    type: GenerateDrawPayload,
    description: 'R8 — allowed until the first match leaves `scheduled`, then DRAW_LOCKED.',
    args: { tournamentId: t.arg.id({ required: true }), seedOrder: t.arg.idList() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        tournament.regenerateDraw(actor, args.tournamentId.toString(), args.seedOrder?.map(String) ?? null),
      );
      return { tournament: data, userError };
    },
  }),

  scheduleDraw: t.field({
    type: ScheduleDrawPayload,
    description:
      'Runs the greedy scheduler over everything that is ready and unplaced ' +
      '(R11, R12). Also runs from a job whenever a match becomes ready.',
    args: { tournamentId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        tournament.scheduleAs(actor, args.tournamentId.toString()),
      );
      return { assignments: data ?? [], userError };
    },
  }),

  assignCourt: t.field({
    type: MatchPayload,
    description: 'R13 — an organizer moving a match by hand. This is the normal case.',
    args: { input: t.arg({ type: AssignCourtInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        tournament.assignCourt(actor, {
          matchId: args.input.matchId.toString(),
          courtId: args.input.courtId.toString(),
          startsAt: args.input.startsAt,
          endsAt: args.input.endsAt ?? null,
        }),
      );
      return { match: data, userError };
    },
  }),

  setMatchTime: t.field({
    type: MatchPayload,
    description:
      'F14 — when a match is played, with or without a court. Players get the 30-minute ' +
      'reminder. Null takes the time (and any court) off.',
    args: { matchId: t.arg.id({ required: true }), startsAt: t.arg({ type: 'DateTime' }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        tournament.setMatchTime(actor, String(args.matchId), args.startsAt ?? null),
      );
      return { match: data, userError };
    },
  }),

  unassignCourt: t.field({
    type: MatchPayload,
    description: 'Takes a match off its court and back into the scheduler’s queue.',
    args: { matchId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        tournament.unassignCourt(actor, args.matchId.toString()),
      );
      return { match: data, userError };
    },
  }),
}));

export { BracketRoundRef, BracketTypeEnum, MatchPayload, MatchRef, MatchStatusEnum, TournamentRef };
