/**
 * tournament — service layer (docs/modules/09-tournament.md).
 *
 * The whole module rests on one decision: EVERY MATCH KNOWS WHERE ITS WINNER
 * AND ITS LOSER GO BEFORE A SINGLE POINT IS PLAYED (R5). Draw generation is one
 * pass that writes both brackets and all of the wiring in one transaction (R6);
 * advancement is then a single write per side with no traversal of anything,
 * which is what makes it cheap enough to serialise under one advisory lock (R9)
 * and safe to run twice (R10).
 *
 * The second decision is that a BYE IS A RESULT (R3). Byes are real match rows
 * with one side null and `status = 'walkover'`, resolved at draw time by the
 * same code path a played match uses. There is no `if (bye)` anywhere below.
 *
 * A slot nothing is wired into is a slot nothing will ever fill — that is the
 * definition of a bye, and it is why byes need no column: `repo.feedsSlot`
 * asks the wiring instead.
 */
import type { Db, Tx } from '../../../platform/db.js';
import { SystemError, UserError, illegalTransition } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { logger } from '../../../platform/logging/index.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import {
  MIN_ENTRIES,
  planDraw,
  seedEntries,
  seedPositions,
  type BracketType,
  type DrawEntry,
  type PlannedMatch,
  type Wire,
} from '../draw.js';
import {
  DRAW_TYPES,
  groupCountFor,
  knockoutSeeding,
  leagueTable,
  MIN_GROUP_ENTRIES,
  MIN_LEAGUE_ENTRIES,
  planGroups,
  QUALIFY_PER_GROUP,
  roundRobin,
  type DrawType,
  type TableRow,
} from '../league.js';
import type { MatchRow, TournamentRepo } from '../repo/index.js';
import { isCourtOverlap } from '../repo/index.js';
import { memo } from '../../../platform/requestCache.js';

export { MIN_ENTRIES } from '../draw.js';
export type { BracketType } from '../draw.js';

export const TournamentCode = {
  /** R7 — fewer than `min_entries`. The category is refunded, not played. */
  INSUFFICIENT_ENTRIES: 'INSUFFICIENT_ENTRIES',
  DRAW_ALREADY_GENERATED: 'DRAW_ALREADY_GENERATED',
  /** R8 — a match has already started. */
  DRAW_LOCKED: 'DRAW_LOCKED',
  COURT_DOUBLE_BOOKED: 'COURT_DOUBLE_BOOKED',
  TOURNAMENT_NOT_FOUND: 'TOURNAMENT_NOT_FOUND',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
  COURT_NOT_FOUND: 'COURT_NOT_FOUND',
  /** System — both sides are not yet filled. */
  MATCH_NOT_READY: 'MATCH_NOT_READY',
  NOT_A_SIDE: 'NOT_A_SIDE',
  /** gap #6 — registration is still open, so players could still enter. */
  REGISTRATION_STILL_OPEN: 'REGISTRATION_STILL_OPEN',
  /** gap #6 — someone is mid-payment for a seat in this draw. */
  PLAYERS_STILL_PAYING: 'PLAYERS_STILL_PAYING',
  /** The category was cancelled or has finished. */
  CATEGORY_NOT_DRAWABLE: 'CATEGORY_NOT_DRAWABLE',
  /** F1 — a manual seeding that is not exactly the draw's entries, once each. */
  INVALID_SEEDING: 'INVALID_SEEDING',
} as const;

export const MATCH_STATUSES = [
  'scheduled',
  'ready',
  'live',
  'awaiting_confirm',
  'completed',
  'walkover',
  'void',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Resolved for good: nothing advances out of one of these a second time. */
const RESOLVED: ReadonlySet<string> = new Set(['completed', 'walkover', 'void']);

/**
 * R11 — the scheduler's two numbers.
 *
 * 45 minutes is also what the `court_assignments` exclusion constraint assumes
 * for a booking with no recorded end, and the two must agree: a scheduler that
 * planned 30-minute slots would propose times the database then rejects.
 */
export const MATCH_MINUTES = 45;
export const MIN_REST_MINUTES = 20;

const MINUTE = 60_000;

/** F14, N12 — the host's match length, else the format's typical one, else 45. */
export const minutesOf = (c: { matchMinutes?: number | null; typicalMatchMinutes?: number }): number =>
  c.matchMinutes ?? c.typicalMatchMinutes ?? MATCH_MINUTES;

// --- domain ------------------------------------------------------------------

export interface Actor {
  userId: string;
}

export interface Tournament {
  id: string;
  eventId: string;
  eventCategoryId: string;
  drawType: string;
  bracketSize: number;
  plateSize: number;
  drawnAt: Date;
  completedAt: Date | null;
}

/** Where a match sits: a knockout bracket, a league, a group stage, or the match for third (F23). */
export type MatchBracket = BracketType | 'league' | 'group' | 'third_place';

export interface Match {
  id: string;
  tournamentId: string;
  eventCategoryId: string;
  sportId: string;
  bracket: MatchBracket;
  round: number;
  slot: number;
  /** Which group, from 1 — group-stage matches only. */
  groupNo: number | null;
  /** The scoreline's totals once a result is in; null before, and for a walkover. */
  tallyA: number | null;
  tallyB: number | null;
  sideARegistrationId: string | null;
  sideBRegistrationId: string | null;
  /** Set when the match resolves — including for a bye. Null after a draw. */
  winnerRegistrationId: string | null;
  winnerMatchId: string | null;
  winnerSlot: number | null;
  loserMatchId: string | null;
  loserSlot: number | null;
  courtId: string | null;
  scheduledAt: Date | null;
  status: MatchStatus;
  scoreSeq: number;
  completedAt: Date | null;
}

export interface BracketRound {
  bracket: BracketType;
  round: number;
  /** "Final", "Semi-final", "Round of 16" — derived, never stored. */
  name: string;
  matches: Match[];
}

export interface Bracket {
  tournament: Tournament;
  championship: BracketRound[];
  plate: BracketRound[];
  /** F23 — the semi-final losers' match, when the draw has one. */
  thirdPlace: Match | null;
}

/** F1 — a draw as it would be made, shown to the host before it is. */
export interface DrawPreview {
  drawType: string;
  bracketSize: number;
  plateSize: number;
  /** Seed 1 first. */
  seeds: { registrationId: string; seed: number }[];
  /** Knockout round 1 in bracket order; a null side is a bye. Empty for a league or groups. */
  firstRound: { sideA: string | null; sideB: string | null }[];
  /** League: one list; groups: one list per group. Empty for a knockout. */
  groups: string[][];
  /** How many matches the whole draw holds (byes excluded). */
  matchCount: number;
}

export interface StandingRow {
  registrationId: string;
  seed: number;
  /** The bracket this entry last played in; `league` when a table decided it. */
  bracket: BracketType | 'league';
  wins: number;
  losses: number;
  /** Null while they are still alive. */
  eliminatedInRound: number | null;
  /** Standard competition ranking: joint places share a number. */
  place: number;
}

/** A league, or one group of a group stage, as its table. */
export interface LeagueGroup {
  /** Null for a league; 1, 2, … for a group. */
  group: number | null;
  table: TableRow[];
  /** Places 1 … this go through to the knockout. 0 in a league. */
  qualify: number;
}

export interface CourtAssignment {
  matchId: string;
  courtId: string;
  startsAt: Date;
  endsAt: Date | null;
  assignedBy: 'scheduler' | 'organizer';
}

/** What `scoring` hands over when a result is confirmed. */
export interface MatchOutcome {
  /** Null for a draw — a league or group match that ended level. */
  winnerRegistrationId: string | null;
  /** Null for a walkover (nobody on the other side), and for a draw. */
  loserRegistrationId: string | null;
  outcome: 'played' | 'walkover' | 'retired' | 'forfeit';
  /** The scoreline's totals, for a league table. Null for a walkover. */
  tallyA?: number | null;
  tallyB?: number | null;
}

// --- ports -------------------------------------------------------------------

export interface EventsPort {
  byId(eventId: string): Promise<{
    id: string;
    sportId: string;
    venueId: string | null;
    startsAt: Date;
    status: string;
    /** F14 — whose event it is: the scheduler books a venue's courts only for its owner. */
    organizerId?: string;
  }>;
  categoryById(categoryId: string): Promise<{
    id: string;
    eventId: string;
    sportId: string;
    name: string;
    drawType: string;
    minEntries: number;
    status: string;
    /** F23 */
    thirdPlace?: boolean;
    /** F14 — null means the format's typical length (N12), else MATCH_MINUTES. */
    matchMinutes?: number | null;
    /** N12 — how long this format's match usually runs, from its scoring rule. */
    typicalMatchMinutes?: number;
    /** N11 — how the draw is scored; a race or a scorecard is run as heats, never drawn. */
    ruleKind?: string;
  }>;
  assertStaff(actor: Actor, eventId: string, roles?: string[]): Promise<unknown>;
  /** R6 — the draw and the category's status are one write, or neither. */
  markCategoryDrawn(categoryId: string, tx: Tx): Promise<unknown>;
  markCategoryCompleted(categoryId: string, tx: Tx): Promise<unknown>;
  /** gap #6 — seats held by players still paying. Absent in tests that never pay. */
  heldSeats?(categoryId: string): Promise<number>;
}

export interface DrawRegistration {
  id: string;
  captainUserId: string;
  confirmedAt: Date | null;
  createdAt: Date;
}

/**
 * `registrations` belongs to `registration` (conventions.md §1 — table
 * ownership is exclusive), including the `seed` column this module fills in.
 * tournament asks; it does not UPDATE.
 */
export interface RegistrationsPort {
  /** R1 — confirmed and checked_in only. A pending payment is not in the draw. */
  confirmedForCategory(categoryId: string): Promise<DrawRegistration[]>;
  /** Every player on the entry. One body cannot be on two courts (R11). */
  membersOf(registrationId: string): Promise<string[]>;
  applySeeds(tx: Tx, seeds: { registrationId: string; seed: number }[]): Promise<unknown>;
  /** The seed written at draw time — a league table's last tie-break. */
  seedOf(registrationId: string): Promise<number | null>;
}

/** R2 — seeding is by SETTLED rating. A provisional one is not fit to rank on. */
export interface RatingsPort {
  settledFor(userId: string, sportId: string): Promise<number | null>;
}

export interface CourtsPort {
  forVenue(venueId: string): Promise<
    { id: string; name: string; sportIds: string[]; active: boolean }[]
  >;
  /** F14 — the courts a host declared for this event. */
  forEvent?(eventId: string): Promise<{ id: string; name: string; sportIds: string[]; active: boolean }[]>;
  /** F14 — who runs the venue. Absent: a venue's courts are never booked automatically. */
  venueOwner?(venueId: string): Promise<string | null>;
}

export interface TournamentDeps {
  db: Db;
  repo: TournamentRepo;
  events: EventsPort;
  registrations: RegistrationsPort;
  ratings: RatingsPort;
  courts: CourtsPort;
  now?: () => Date;
}

// --- helpers -----------------------------------------------------------------

const notFound = () =>
  new UserError(TournamentCode.TOURNAMENT_NOT_FOUND, 'That draw could not be found.');

const matchNotFound = () =>
  new UserError(TournamentCode.MATCH_NOT_FOUND, 'That match could not be found.');

const toTournament = (row: {
  id: string;
  eventId: string;
  eventCategoryId: string;
  drawType: string;
  bracketSize: number;
  plateSize: number;
  drawnAt: Date;
  completedAt: Date | null;
}): Tournament => ({ ...row });

const toMatch = (row: MatchRow): Match => ({
  id: row.id,
  tournamentId: row.tournamentId,
  eventCategoryId: row.eventCategoryId,
  sportId: row.sportId,
  bracket: row.bracket as MatchBracket,
  round: row.round,
  slot: row.slot,
  groupNo: row.groupNo,
  tallyA: row.tallyA,
  tallyB: row.tallyB,
  sideARegistrationId: row.sideARegistrationId,
  sideBRegistrationId: row.sideBRegistrationId,
  winnerRegistrationId: row.winnerRegistrationId,
  winnerMatchId: row.winnerMatchId,
  winnerSlot: row.winnerSlot,
  loserMatchId: row.loserMatchId,
  loserSlot: row.loserSlot,
  courtId: row.courtId,
  scheduledAt: row.scheduledAt,
  status: row.status as MatchStatus,
  scoreSeq: row.scoreSeq,
  completedAt: row.completedAt,
});

/** "Final", "Semi-final", "Quarter-final", "Round of 32" — derived on read. */
export function roundName(round: number, roundsInBracket: number): string {
  const remaining = roundsInBracket - round;
  if (remaining === 0) return 'Final';
  if (remaining === 1) return 'Semi-final';
  if (remaining === 2) return 'Quarter-final';
  return `Round of ${2 ** (remaining + 1)}`;
}

const positionKey = (m: { bracket: string; round: number; slot: number }): string =>
  `${m.bracket}:${m.round}:${m.slot}`;

const wireKey = (w: Wire): string => `${w.bracket}:${w.round}:${w.slot}`;

interface Interval {
  from: number;
  to: number;
}

/**
 * The first instant at or after `notBefore` where `duration` fits between the
 * bookings already on this court. Greedy and gap-aware: a court freed by a
 * walkover should not sit idle until the end of the day.
 */
export function earliestFit(busy: Interval[], notBefore: number, duration: number): number {
  const sorted = [...busy].sort((a, b) => a.from - b.from);
  let start = notBefore;
  for (const slot of sorted) {
    if (slot.to <= start) continue;
    if (slot.from >= start + duration) break;
    start = slot.to;
  }
  return start;
}

// --- service -----------------------------------------------------------------

export function createTournamentService(deps: TournamentDeps) {
  const { db, repo, events, registrations, ratings, courts } = deps;
  const now = deps.now ?? (() => new Date());

  // --- reads -----------------------------------------------------------------

  async function findById(tournamentId: string): Promise<Tournament | null> {
    const row = await repo.byId(db, tournamentId);
    return row ? toTournament(row) : null;
  }

  async function byId(tournamentId: string): Promise<Tournament> {
    const found = await findById(tournamentId);
    if (!found) throw notFound();
    return found;
  }

  // Speed — the category's tournament and its standings both ask; one read per query.
  function findByCategory(eventCategoryId: string): Promise<Tournament | null> {
    return memo(`tournament:category:${eventCategoryId}`, async () => {
      const row = await repo.byCategory(db, eventCategoryId);
      return row ? toTournament(row) : null;
    });
  }

  async function matchById(matchId: string): Promise<Match> {
    const row = await repo.matchById(db, matchId);
    if (!row) throw matchNotFound();
    return toMatch(row);
  }

  async function matchesFor(tournamentId: string): Promise<Match[]> {
    return (await repo.matchesFor(db, tournamentId)).map(toMatch);
  }

  async function bracketFor(eventCategoryId: string): Promise<Bracket | null> {
    const tournament = await findByCategory(eventCategoryId);
    if (!tournament) return null;
    const matches = (await repo.matchesForCategory(db, eventCategoryId)).map(toMatch);
    return {
      tournament,
      championship: groupRounds(matches, 'championship', tournament.bracketSize),
      plate: groupRounds(matches, 'plate', tournament.plateSize),
      thirdPlace: matches.find((m) => m.bracket === 'third_place') ?? null,
    };
  }

  function groupRounds(matches: Match[], bracket: BracketType, size: number): BracketRound[] {
    const rounds = size > 1 ? Math.log2(size) : 0;
    const inBracket = matches.filter((m) => m.bracket === bracket);
    const byRound = new Map<number, Match[]>();
    for (const match of inBracket) {
      const list = byRound.get(match.round) ?? [];
      list.push(match);
      byRound.set(match.round, list);
    }
    return [...byRound.entries()]
      .sort(([a], [b]) => a - b)
      .map(([round, list]) => ({
        bracket,
        round,
        name: roundName(round, rounds),
        matches: list.sort((a, b) => a.slot - b.slot),
      }));
  }

  /** Live Mode across a whole event, not one draw: an event runs eight draws. */
  async function liveMatches(eventId: string): Promise<Match[]> {
    return (await repo.liveForEvent(db, eventId)).map(toMatch);
  }

  /**
   * Standard competition ranking over both brackets. An entry that went further
   * in the Championship finishes above one that did not; the Championship's
   * first-round losers are separated by how far they went in the Plate, which
   * is the entire reason a Plate exists.
   */
  async function standingsFor(eventCategoryId: string): Promise<StandingRow[]> {
    const tournament = await findByCategory(eventCategoryId);
    if (!tournament) return [];
    // A league has no bracket: its table is its final order. Read as places
    // like a knockout's, so "where did I finish" has one answer everywhere.
    if (tournament.drawType === 'league') {
      const [table] = await leagueTableFor(eventCategoryId);
      return (table?.table ?? []).map((r) => ({
        registrationId: r.registrationId,
        seed: 0,
        bracket: 'league',
        wins: r.won,
        losses: r.lost,
        eliminatedInRound: null,
        place: r.place,
      }));
    }
    const matches = (await repo.matchesForCategory(db, eventCategoryId)).map(toMatch);

    interface Tally {
      registrationId: string;
      seed: number;
      wins: number;
      losses: number;
      championshipReached: number;
      plateReached: number;
      eliminatedInRound: number | null;
      bracket: BracketType;
    }
    const tally = new Map<string, Tally>();
    const seedOf = new Map<string, number>();

    // Seeds are recoverable from the draw itself, because the draw IS the
    // seeding: position i of a bracket of this size holds seed
    // `seedPositions(size)[i]` (R4), and Championship round 1 was written in
    // that order. Reading them back here keeps standings a function of the
    // bracket rather than a second copy of `registrations.seed`.
    const order = seedPositions(tournament.bracketSize);
    for (const m of matches) {
      if (m.bracket !== 'championship' || m.round !== 1) continue;
      if (m.sideARegistrationId) seedOf.set(m.sideARegistrationId, order[m.slot * 2] ?? 0);
      if (m.sideBRegistrationId) seedOf.set(m.sideBRegistrationId, order[m.slot * 2 + 1] ?? 0);
    }

    const of = (registrationId: string, bracket: BracketType): Tally => {
      let found = tally.get(registrationId);
      if (!found) {
        found = {
          registrationId,
          seed: seedOf.get(registrationId) ?? 0,
          wins: 0,
          losses: 0,
          championshipReached: 1,
          plateReached: 0,
          eliminatedInRound: null,
          bracket,
        };
        tally.set(registrationId, found);
      }
      return found;
    };

    for (const match of matches) {
      // A knockout's standings; a league or group stage has its table (leagueTable).
      if (match.bracket !== 'championship' && match.bracket !== 'plate') continue;
      const sides = [match.sideARegistrationId, match.sideBRegistrationId].filter(
        (id): id is string => id !== null,
      );
      for (const id of sides) {
        const row = of(id, match.bracket);
        if (match.bracket === 'championship') {
          row.championshipReached = Math.max(row.championshipReached, match.round);
        } else {
          row.plateReached = Math.max(row.plateReached, match.round);
          row.bracket = 'plate';
        }
      }
      const winner = match.winnerRegistrationId;
      if (!winner || !RESOLVED.has(match.status)) continue;
      const loser = sides.find((id) => id !== winner) ?? null;

      const winnerRow = of(winner, match.bracket);
      winnerRow.wins += 1;
      if (match.bracket === 'championship') {
        winnerRow.championshipReached = Math.max(winnerRow.championshipReached, match.round + 1);
      } else {
        winnerRow.plateReached = Math.max(winnerRow.plateReached, match.round + 1);
      }

      if (loser) {
        const loserRow = of(loser, match.bracket);
        loserRow.losses += 1;
        loserRow.eliminatedInRound = match.round;
        // A Championship first-round loser is not out — they are in the Plate.
        if (match.bracket === 'championship' && match.loserMatchId) {
          loserRow.eliminatedInRound = null;
        }
      }
    }

    // F23 — the match for third separates the two semi-final losers.
    const third = matches.find((m) => m.bracket === 'third_place' && m.winnerRegistrationId && RESOLVED.has(m.status));
    const thirdWinner = third?.winnerRegistrationId ?? null;
    if (third) {
      for (const id of [third.sideARegistrationId, third.sideBRegistrationId]) {
        if (!id) continue;
        const row = tally.get(id);
        if (!row) continue;
        if (id === thirdWinner) row.wins += 1;
        else row.losses += 1;
      }
    }

    const rows = [...tally.values()];
    const betterThan = (a: Tally, b: Tally): boolean =>
      a.championshipReached > b.championshipReached ||
      (a.championshipReached === b.championshipReached && a.plateReached > b.plateReached) ||
      (a.championshipReached === b.championshipReached &&
        a.plateReached === b.plateReached &&
        thirdWinner !== null &&
        a.registrationId === thirdWinner &&
        b.registrationId !== thirdWinner &&
        third !== undefined &&
        (b.registrationId === third.sideARegistrationId || b.registrationId === third.sideBRegistrationId));

    return rows
      .map((row) => ({
        registrationId: row.registrationId,
        seed: row.seed,
        bracket: row.bracket,
        wins: row.wins,
        losses: row.losses,
        eliminatedInRound: row.eliminatedInRound,
        place: 1 + rows.filter((other) => betterThan(other, row)).length,
      }))
      .sort((a, b) => a.place - b.place || a.seed - b.seed);
  }

  // --- draw generation -------------------------------------------------------

  /**
   * R1, R2, R6, R7 — the whole draw, in one transaction.
   *
   * A partially generated draw is not a state this system can be in: half a
   * bracket looks exactly like a full one on a phone, and the first person to
   * notice is a player standing on a court that has no match.
   */
  async function generateDraw(
    actor: Actor,
    input: { eventCategoryId: string; seedOrder?: string[] | null },
  ): Promise<Tournament> {
    const category = await events.categoryById(input.eventCategoryId);
    await events.assertStaff(actor, category.eventId);

    const existing = await repo.byCategory(db, input.eventCategoryId);
    if (existing) {
      throw new UserError(
        TournamentCode.DRAW_ALREADY_GENERATED,
        'This draw has already been generated. Regenerate it instead.',
      );
    }
    await assertDrawable(category);
    return writeDraw(category, undefined, input.seedOrder ?? null);
  }

  /**
   * The app makes the draw itself when registration closes: same rules as a
   * host's (closed, nobody still paying), seeded by settled rating, no staff
   * check because nobody is acting. Null when the draw already exists — a
   * host who drew by hand first, or a retried job.
   */
  async function autoDraw(eventCategoryId: string): Promise<Tournament | null> {
    const category = await events.categoryById(eventCategoryId);
    if (await repo.byCategory(db, eventCategoryId)) return null;
    await assertDrawable(category);
    return writeDraw(category, undefined, null);
  }

  /**
   * F1 — the draw as it would be made right now, written nowhere. The host
   * sees the seeds and who plays whom, may reorder the seeds, and then makes
   * it with the same order.
   */
  async function drawPreview(
    actor: Actor,
    input: { eventCategoryId: string; seedOrder?: string[] | null },
  ): Promise<DrawPreview> {
    const category = await events.categoryById(input.eventCategoryId);
    await events.assertStaff(actor, category.eventId);
    const plan = await planFor(category, newId(), input.seedOrder ?? null);
    const firstRound = plan.rows
      .filter((r) => r.bracket === 'championship' && r.round === 1)
      .sort((a, b) => a.slot - b.slot)
      .map((r) => ({ sideA: r.sideARegistrationId, sideB: r.sideBRegistrationId }));
    const groups = new Map<number, Set<string>>();
    for (const r of plan.rows) {
      if (r.bracket !== 'league' && r.bracket !== 'group') continue;
      const g = r.groupNo ?? 0;
      const set = groups.get(g) ?? new Set<string>();
      for (const id of [r.sideARegistrationId, r.sideBRegistrationId]) if (id) set.add(id);
      groups.set(g, set);
    }
    const seedOf = new Map(plan.seeds.map((x) => [x.registrationId, x.seed]));
    return {
      drawType: plan.drawType,
      bracketSize: plan.bracketSize,
      plateSize: plan.plateSize,
      seeds: [...plan.seeds].sort((a, b) => a.seed - b.seed),
      firstRound,
      groups: [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, ids]) => [...ids].sort((a, b) => (seedOf.get(a) ?? 0) - (seedOf.get(b) ?? 0))),
      matchCount: plan.rows.filter((r) => !(r.round === 1 && r.bracket === 'championship' && (r.sideARegistrationId === null) !== (r.sideBRegistrationId === null))).length,
    };
  }

  /**
   * gap #6 — a bracket is made from the entries that exist once registration
   * is over. Made earlier, anyone who pays afterwards is confirmed into a
   * draw that has no match for them.
   */
  async function assertDrawable(category: { id: string; status: string; ruleKind?: string }): Promise<void> {
    // N11 — a race, a lift or a scorecard has no opponents to draw: it is run as heats.
    if (category.ruleKind === 'performance' || category.ruleKind === 'scorecard') {
      throw new UserError(
        TournamentCode.CATEGORY_NOT_DRAWABLE,
        'This category is a race or a scored round, so it has no draw. Run it as heats from its category.',
      );
    }
    if (category.status === 'open' || category.status === 'full') {
      throw new UserError(
        TournamentCode.REGISTRATION_STILL_OPEN,
        'Close registration for this event before making the draw.',
      );
    }
    if (category.status !== 'closed' && category.status !== 'drawn') {
      throw new UserError(TournamentCode.CATEGORY_NOT_DRAWABLE, 'This category can no longer be drawn.');
    }
    if (events.heldSeats && (await events.heldSeats(category.id)) > 0) {
      throw new UserError(
        TournamentCode.PLAYERS_STILL_PAYING,
        'Some players are still paying for their place. Try again in a few minutes.',
      );
    }
  }

  /**
   * R8 — regeneration is a pre-first-match operation. Once a match has left
   * `scheduled` the bracket is somebody's afternoon, and rewriting it would
   * silently discard a played result.
   */
  async function regenerateDraw(actor: Actor, tournamentId: string, seedOrder: string[] | null = null): Promise<Tournament> {
    const existing = await repo.byId(db, tournamentId);
    if (!existing) throw notFound();
    const category = await events.categoryById(existing.eventCategoryId);
    await events.assertStaff(actor, category.eventId);

    if (await repo.hasStartedMatch(db, tournamentId)) {
      throw new UserError(
        TournamentCode.DRAW_LOCKED,
        'A match in this draw has already started. The draw can no longer change.',
      );
    }
    await assertDrawable(category);

    // gap #35 — the old draw goes in the same transaction the new one is
    // written in. If the new one cannot be made (too few entries left), the
    // old one is still there rather than a category marked drawn with no
    // bracket at all.
    return writeDraw(
      category,
      async (tx) => {
        await repo.lockTournament(tx, tournamentId);
        if (await repo.hasStartedMatch(tx, tournamentId)) {
          throw new UserError(
            TournamentCode.DRAW_LOCKED,
            'A match in this draw has already started. The draw can no longer change.',
          );
        }
        await repo.deleteDraw(tx, tournamentId);
      },
      seedOrder,
    );
  }

  type DrawCategory = {
    id: string;
    eventId: string;
    sportId: string;
    drawType: string;
    minEntries: number;
    thirdPlace?: boolean;
  };

  /**
   * The draw for this category's confirmed entries, as rows not yet written.
   * `seedOrder` (F1) replaces the rating order with the host's: every entry,
   * once, seed 1 first.
   */
  async function planFor(
    category: DrawCategory,
    tournamentId: string,
    seedOrder: string[] | null,
  ): Promise<{
    drawType: DrawType;
    rows: MatchRow[];
    seeds: { registrationId: string; seed: number }[];
    bracketSize: number;
    plateSize: number;
    entries: number;
  }> {
    const drawType = (DRAW_TYPES as readonly string[]).includes(category.drawType)
      ? (category.drawType as DrawType)
      : 'single_elim_with_plate';
    const entries = await registrations.confirmedForCategory(category.id);

    // R7 — `min_entries` is the organizer's floor; the system's is four for a
    // bracket, three for a league, and two groups of three for a group stage.
    const systemFloor =
      drawType === 'league' ? MIN_LEAGUE_ENTRIES : drawType === 'groups_knockout' ? MIN_GROUP_ENTRIES : MIN_ENTRIES;
    const floor = Math.max(category.minEntries, systemFloor);
    if (entries.length < floor) {
      throw new UserError(
        TournamentCode.INSUFFICIENT_ENTRIES,
        `This draw needs ${floor} entries and has ${entries.length}.`,
      );
    }

    let rated: DrawEntry[];
    if (seedOrder && seedOrder.length > 0) {
      const ids = new Set(entries.map((e) => e.id));
      if (seedOrder.length !== ids.size || new Set(seedOrder).size !== seedOrder.length || seedOrder.some((id) => !ids.has(id))) {
        throw new UserError(
          TournamentCode.INVALID_SEEDING,
          'The seeding must list every entry in this draw exactly once. Refresh and try again.',
        );
      }
      // The host's order as a rating, highest first: seedEntries keeps it.
      rated = seedOrder.map((registrationId, i) => ({ registrationId, rating: seedOrder.length - i, confirmedAt: new Date(0) }));
    } else {
      rated = await withRatings(entries, category.sportId);
    }
    let rows: MatchRow[];
    let seeds: { registrationId: string; seed: number }[];
    let bracketSize: number;
    let plateSize: number;
    if (drawType === 'single_elim_with_plate' || drawType === 'single_elim') {
      const plate = drawType === 'single_elim_with_plate';
      const plan = planDraw(rated);
      const at = { tournamentId, eventCategoryId: category.id, sportId: category.sportId };
      rows = knockoutRows(plan.matches, at, plate);
      // F23 — a plain knockout may play for third: the semi-final losers.
      if (!plate && category.thirdPlace && plan.bracketSize >= 4) rows = withThirdPlace(rows, plan.bracketSize, at);
      seeds = plan.seeds;
      bracketSize = plan.bracketSize;
      plateSize = plate ? plan.plateSize : 0;
    } else {
      seeds = seedEntries(rated);
      const ids = seeds.map((e) => e.registrationId);
      const groups = drawType === 'league' ? [ids] : planGroups(ids, groupCountFor(ids.length));
      rows = roundRobinRows(groups, drawType === 'league' ? 'league' : 'group', {
        tournamentId,
        eventCategoryId: category.id,
        sportId: category.sportId,
      });
      bracketSize = ids.length;
      plateSize = 0;
    }
    return { drawType, rows, seeds, bracketSize, plateSize, entries: entries.length };
  }

  async function writeDraw(
    category: DrawCategory,
    /** Runs first inside the draw's transaction (regeneration deletes the old draw here). */
    before?: (tx: Tx) => Promise<void>,
    seedOrder: string[] | null = null,
  ): Promise<Tournament> {
    const tournamentId = newId();
    const { drawType, rows, seeds, bracketSize, plateSize, entries } = await planFor(category, tournamentId, seedOrder);

    await db.$transaction(async (tx) => {
      if (before) await before(tx);
      await repo.createTournament(tx, {
        id: tournamentId,
        eventId: category.eventId,
        eventCategoryId: category.id,
        drawType,
        bracketSize,
        plateSize,
        drawnAt: now(),
        completedAt: null,
      });
      await repo.createMatches(tx, rows);
      await registrations.applySeeds(
        tx,
        seeds.map((s) => ({ registrationId: s.registrationId, seed: s.seed })),
      );
      await events.markCategoryDrawn(category.id, tx);

      // R3 — byes resolve here, through the same path a played result takes.
      // Every first-round position is settled in slot order, so a bye advances
      // its top seed into round 2 before anything else looks at round 2. A
      // league or group match has both sides from the start: it is ready now.
      for (const row of rows) {
        const first = row.round === 1 && row.bracket === 'championship';
        if (first || row.bracket === 'league' || row.bracket === 'group') await settle(tx, row.id);
      }

      await outboxWrite(tx, {
        topic: 'draw.generated',
        payload: {
          tournamentId,
          eventId: category.eventId,
          eventCategoryId: category.id,
          bracketSize,
          plateSize,
          entries,
        },
      });
    });

    return byId(tournamentId);
  }

  /**
   * F23 — one more match, fed by the two semi-finals' losers. Wired like a
   * Plate drop (loser_match_id), so a semi-final decided by walkover cuts its
   * wire and the match for third resolves the same way any bye does.
   */
  function withThirdPlace(
    rows: MatchRow[],
    bracketSize: number,
    at: { tournamentId: string; eventCategoryId: string; sportId: string },
  ): MatchRow[] {
    const semiRound = Math.log2(bracketSize) - 1;
    const semis = rows.filter((r) => r.bracket === 'championship' && r.round === semiRound);
    if (semis.length !== 2) return rows;
    const id = newId();
    const third: MatchRow = {
      ...semis[0]!,
      id,
      ...at,
      bracket: 'third_place',
      round: 1,
      slot: 0,
      groupNo: null,
      sideARegistrationId: null,
      sideBRegistrationId: null,
      winnerMatchId: null,
      winnerSlot: null,
      loserMatchId: null,
      loserSlot: null,
    };
    return [
      ...rows.map((r) =>
        r.bracket === 'championship' && r.round === semiRound
          ? { ...r, loserMatchId: id, loserSlot: r.slot === 0 ? 0 : 1 }
          : r,
      ),
      third,
    ];
  }

  /** A planned knockout as match rows, wired both ways (R5). `withPlate`: keep the Plate and its loser wires. */
  function knockoutRows(
    planned: PlannedMatch[],
    at: { tournamentId: string; eventCategoryId: string; sportId: string },
    withPlate: boolean,
  ): MatchRow[] {
    const kept = withPlate ? planned : planned.filter((m) => m.bracket === 'championship');
    const idByPosition = new Map<string, string>();
    for (const match of kept) idByPosition.set(positionKey(match), newId());

    const wireTo = (wire: Wire | null): { id: string | null; slot: number | null } => {
      if (!wire) return { id: null, slot: null };
      const id = idByPosition.get(wireKey(wire)) ?? null;
      return id ? { id, slot: wire.side } : { id: null, slot: null };
    };

    return kept.map((match: PlannedMatch) => {
      const winner = wireTo(match.winnerTo);
      const loser = wireTo(match.loserTo);
      return {
        id: idByPosition.get(positionKey(match))!,
        ...at,
        bracket: match.bracket,
        round: match.round,
        slot: match.slot,
        groupNo: null,
        tallyA: null,
        tallyB: null,
        sideARegistrationId: match.sideA,
        sideBRegistrationId: match.sideB,
        winnerRegistrationId: null,
        winnerMatchId: winner.id,
        winnerSlot: winner.slot,
        loserMatchId: loser.id,
        loserSlot: loser.slot,
        courtId: null,
        scheduledAt: null,
        status: 'scheduled',
        scoreSeq: 0,
        createdAt: now(),
        completedAt: null,
      };
    });
  }

  /**
   * Every group (or the one league) as round-robin matches. A matchday's slots
   * run across all the groups — group 1's matches first — so the
   * (tournament, bracket, round, slot) key holds for a whole group stage.
   */
  function roundRobinRows(
    groups: string[][],
    bracket: 'league' | 'group',
    at: { tournamentId: string; eventCategoryId: string; sportId: string },
  ): MatchRow[] {
    const nextSlot = new Map<number, number>();
    const rows: MatchRow[] = [];
    for (const [g, members] of groups.entries()) {
      for (const f of roundRobin(members)) {
        const slot = nextSlot.get(f.round) ?? 0;
        nextSlot.set(f.round, slot + 1);
        rows.push({
          id: newId(),
          ...at,
          bracket,
          round: f.round,
          slot,
          groupNo: bracket === 'group' ? g + 1 : null,
          tallyA: null,
          tallyB: null,
          sideARegistrationId: f.a,
          sideBRegistrationId: f.b,
          winnerRegistrationId: null,
          winnerMatchId: null,
          winnerSlot: null,
          loserMatchId: null,
          loserSlot: null,
          courtId: null,
          scheduledAt: null,
          status: 'scheduled',
          scoreSeq: 0,
          createdAt: now(),
          completedAt: null,
        });
      }
    }
    return rows.sort((x, y) => x.round - y.round || x.slot - y.slot);
  }

  /**
   * R2 — the settled rating of the entry, which for a doubles pair is the mean
   * of the partners who have one.
   *
   * A provisional rating is deliberately not used: rating R9 says a number
   * below five settled matches is not fit to rank on, and a seeding is a
   * ranking. An entry nobody can rate seeds last, which is the honest place for
   * a player nobody has seen play.
   */
  async function withRatings(
    entries: DrawRegistration[],
    sportId: string,
  ): Promise<DrawEntry[]> {
    return Promise.all(
      entries.map(async (entry) => {
        const members = await registrations.membersOf(entry.id);
        const userIds = members.length > 0 ? members : [entry.captainUserId];
        const values = (
          await Promise.all(userIds.map((userId) => ratings.settledFor(userId, sportId)))
        ).filter((value): value is number => value !== null);
        return {
          registrationId: entry.id,
          rating:
            values.length === 0
              ? null
              : values.reduce((sum, value) => sum + value, 0) / values.length,
          confirmedAt: entry.confirmedAt ?? entry.createdAt,
        };
      }),
    );
  }

  // --- advancement (R9, R10) -------------------------------------------------

  /**
   * R9, R10 — called by `scoring` when a result is confirmed, and by this
   * module when a bye resolves.
   *
   * The advisory lock is per tournament and transaction-scoped: two courts
   * finishing in the same millisecond serialise here rather than racing for the
   * same next-match slot. A `tx` may be passed so that the caller's result write
   * and this advancement commit together — scoring R8 needs exactly that when a
   * correction reverses an advancement.
   */
  async function advance(
    matchId: string,
    result: MatchOutcome,
    tx?: Tx,
  ): Promise<void> {
    if (tx) return advanceIn(tx, matchId, result);
    await db.$transaction(async (t) => advanceIn(t, matchId, result));
  }

  async function advanceIn(tx: Tx, matchId: string, result: MatchOutcome): Promise<void> {
    const seen = await repo.matchById(tx, matchId);
    if (!seen) throw matchNotFound();

    // R9 — serialise every advancement in this tournament. Transaction-scoped:
    // pg_advisory_lock would leak onto a pooled Neon connection (ADR 0001 §C3).
    await repo.lockTournament(tx, seen.tournamentId);

    // Re-read UNDER the lock. The first read raced; this one cannot.
    const match = await repo.matchById(tx, matchId);
    if (!match) throw matchNotFound();

    // R10 — advancing a completed match is a no-op, not an error. This is
    // reachable from a retried job, and a retry must not double-advance.
    if (RESOLVED.has(match.status)) return;

    const tally = { tallyA: result.tallyA ?? null, tallyB: result.tallyB ?? null };
    if (result.winnerRegistrationId === null) {
      // A draw: only a league or group match may end level, and both sides played.
      if ((match.bracket !== 'league' && match.bracket !== 'group') || result.outcome !== 'played') {
        throw new UserError(TournamentCode.NOT_A_SIDE, 'A knockout match needs a winner.');
      }
      await resolve(tx, match, { winnerId: null, loserId: null, status: 'completed', ...tally });
      return;
    }

    const sides = [match.sideARegistrationId, match.sideBRegistrationId].filter(
      (id): id is string => id !== null,
    );
    if (!sides.includes(result.winnerRegistrationId)) {
      throw new UserError(
        TournamentCode.NOT_A_SIDE,
        'That entry is not playing this match.',
      );
    }
    const loserId =
      result.loserRegistrationId ?? sides.find((id) => id !== result.winnerRegistrationId) ?? null;

    await resolve(tx, match, {
      winnerId: result.winnerRegistrationId,
      loserId,
      status: result.outcome === 'walkover' ? 'walkover' : 'completed',
      ...tally,
    });
  }

  /**
   * scoring R8 (gap #18) — an organizer corrects a result that was already
   * confirmed. Under the tournament lock, in the caller's transaction (the
   * result row changes in the same one).
   *
   * A different winner reverses the advancement: the right player takes the
   * slot in the next match, and the right loser the Plate slot. That is only
   * possible while those matches have not started — once the next round is
   * played, the bracket has moved on and the organizer regenerates instead.
   */
  async function correct(matchId: string, result: MatchOutcome, tx: Tx): Promise<void> {
    const seen = await repo.matchById(tx, matchId);
    if (!seen) throw matchNotFound();
    await repo.lockTournament(tx, seen.tournamentId);
    const match = (await repo.matchById(tx, matchId))!;
    if (match.status !== 'completed' && match.status !== 'walkover') {
      throw new UserError(TournamentCode.MATCH_NOT_READY, 'Only a finished match can be corrected.');
    }

    const sides = [match.sideARegistrationId, match.sideBRegistrationId].filter((id): id is string => id !== null);
    if (result.winnerRegistrationId === null) {
      if ((match.bracket !== 'league' && match.bracket !== 'group') || result.outcome !== 'played') {
        throw new UserError(TournamentCode.NOT_A_SIDE, 'A knockout match needs a winner.');
      }
    } else if (!sides.includes(result.winnerRegistrationId)) {
      throw new UserError(TournamentCode.NOT_A_SIDE, 'That entry is not playing this match.');
    }
    const winnerId = result.winnerRegistrationId;
    const loserId =
      winnerId === null ? null : (result.loserRegistrationId ?? sides.find((id) => id !== winnerId) ?? null);

    // A group table that has already produced its knockout cannot change under it.
    if (match.bracket === 'group') {
      const all = await repo.matchesFor(tx, match.tournamentId);
      if (all.some((m) => m.bracket === 'championship')) {
        throw new UserError(
          TournamentCode.DRAW_LOCKED,
          'The knockout has already been drawn from these groups. Regenerate the draw instead.',
        );
      }
    }

    if (winnerId !== match.winnerRegistrationId) {
      const moves: [string | null, number | null, string | null][] = [
        [match.winnerMatchId, match.winnerSlot, winnerId],
        [match.loserMatchId, match.loserSlot, loserId],
      ];
      for (const [target, , ] of moves) {
        if (!target) continue;
        const down = await repo.matchById(tx, target);
        if (down && (!['scheduled', 'ready'].includes(down.status) || down.scoreSeq > 0)) {
          throw new UserError(
            TournamentCode.DRAW_LOCKED,
            'The next round has already started, so this result can no longer be corrected.',
          );
        }
      }
      for (const [target, slot, entry] of moves) {
        if (target && slot !== null && entry) {
          await repo.placeSide(tx, target, slot as 0 | 1, entry);
          await settle(tx, target);
        }
      }
    }

    await repo.finish(tx, match.id, {
      status: result.outcome === 'walkover' ? 'walkover' : 'completed',
      winnerRegistrationId: winnerId,
      completedAt: match.completedAt ?? now(),
      tallyA: result.tallyA ?? null,
      tallyB: result.tallyB ?? null,
    });
    await outboxWrite(tx, {
      topic: 'match.corrected',
      payload: { matchId, tournamentId: match.tournamentId, eventCategoryId: match.eventCategoryId },
    });
  }

  /**
   * The one write that finishes a match and moves both players. Everything that
   * completes a match — a confirmed result, a bye, a Plate walkover — goes
   * through here, which is why there is no `if (bye)` in this module.
   */
  async function resolve(
    tx: Tx,
    match: MatchRow,
    outcome: {
      /** Null for a draw (league and group matches only, which wire nowhere). */
      winnerId: string | null;
      loserId: string | null;
      status: MatchStatus;
      tallyA?: number | null;
      tallyB?: number | null;
    },
  ): Promise<void> {
    await repo.finish(tx, match.id, {
      status: outcome.status,
      winnerRegistrationId: outcome.winnerId,
      completedAt: now(),
      tallyA: outcome.tallyA,
      tallyB: outcome.tallyB,
    });

    if (outcome.winnerId !== null && match.winnerMatchId !== null && match.winnerSlot !== null) {
      await placeInto(tx, match.winnerMatchId, match.winnerSlot as 0 | 1, outcome.winnerId);
    }

    if (match.loserMatchId !== null && match.loserSlot !== null) {
      if (outcome.loserId) {
        await placeInto(tx, match.loserMatchId, match.loserSlot as 0 | 1, outcome.loserId);
      } else {
        // No loser to send. Cut the wire first: a Plate slot fed by nothing is
        // a bye, and leaving the wire in place would make it look like a side
        // that has simply not arrived yet.
        await repo.cutLoserWire(tx, match.id);
        await settle(tx, match.loserMatchId);
      }
    }

    await outboxWrite(tx, {
      topic: 'match.completed',
      payload: {
        matchId: match.id,
        tournamentId: match.tournamentId,
        eventCategoryId: match.eventCategoryId,
        bracket: match.bracket,
        round: match.round,
        winnerRegistrationId: outcome.winnerId,
        loserRegistrationId: outcome.loserId,
        outcome: outcome.status,
      },
    });

    await completeTournamentIfFinished(tx, match.tournamentId, match.eventCategoryId);
  }

  async function placeInto(
    tx: Tx,
    matchId: string,
    side: 0 | 1,
    registrationId: string,
  ): Promise<void> {
    await repo.placeSide(tx, matchId, side, registrationId);
    await settle(tx, matchId);
  }

  /**
   * Decide what a match now is, given who is in it and what can still arrive.
   *
   * Both sides filled          → ready to play.
   * One side filled, the other fed by nothing → a walkover; resolve it now.
   * Neither filled or feedable → void; cut the wire and settle downstream.
   * Anything else              → still waiting, and that is not a state change.
   */
  async function settle(tx: Tx, matchId: string): Promise<void> {
    const match = await repo.matchById(tx, matchId);
    if (!match || RESOLVED.has(match.status)) return;

    const a = match.sideARegistrationId;
    const b = match.sideBRegistrationId;
    const aLive = a !== null || (await repo.feedsSlot(tx, matchId, 0));
    const bLive = b !== null || (await repo.feedsSlot(tx, matchId, 1));

    if (a !== null && b !== null) {
      if (match.status !== 'scheduled') return;
      await repo.setStatus(tx, matchId, 'ready');
      await outboxWrite(tx, {
        topic: 'match.ready',
        payload: {
          matchId,
          tournamentId: match.tournamentId,
          eventCategoryId: match.eventCategoryId,
          bracket: match.bracket,
          round: match.round,
        },
      });
      return;
    }

    if (!aLive && !bLive) {
      // Nothing can ever play here. Reachable only from a draw where a whole
      // sub-bracket is byes; it costs one CHECK-free branch to make sure it
      // resolves rather than hangs.
      await repo.cutWinnerWire(tx, matchId);
      await repo.finish(tx, matchId, {
        status: 'void',
        winnerRegistrationId: null,
        completedAt: now(),
      });
      if (match.winnerMatchId) await settle(tx, match.winnerMatchId);
      return;
    }

    if (a !== null && !bLive) {
      await resolve(tx, match, { winnerId: a, loserId: null, status: 'walkover' });
      return;
    }
    if (b !== null && !aLive) {
      await resolve(tx, match, { winnerId: b, loserId: null, status: 'walkover' });
    }
  }

  async function completeTournamentIfFinished(
    tx: Tx,
    tournamentId: string,
    eventCategoryId: string,
  ): Promise<void> {
    const remaining = await tx.match.count({
      where: { tournamentId, status: { notIn: ['completed', 'walkover', 'void'] } },
    });
    if (remaining > 0) return;

    const tournament = await repo.byId(tx, tournamentId);
    if (!tournament || tournament.completedAt) return;

    // A group stage that has just finished is not a finished tournament: its
    // knockout starts now, from the tables.
    if (tournament.drawType === 'groups_knockout') {
      const all = await repo.matchesFor(tx, tournamentId);
      if (!all.some((m) => m.bracket === 'championship')) {
        await startKnockout(tx, tournamentId, eventCategoryId, all);
        return;
      }
    }

    await repo.markCompleted(tx, tournamentId, now());
    await events.markCategoryCompleted(eventCategoryId, tx);
    await outboxWrite(tx, {
      topic: 'tournament.completed',
      payload: { tournamentId, eventId: tournament.eventId, eventCategoryId },
    });
  }

  /** Tables for a league or each group, from its matches. */
  async function tablesOf(matches: MatchRow[]): Promise<LeagueGroup[]> {
    const inTable = matches.filter((m) => m.bracket === 'league' || m.bracket === 'group');
    const byGroup = new Map<number | null, MatchRow[]>();
    for (const m of inTable) byGroup.set(m.groupNo, [...(byGroup.get(m.groupNo) ?? []), m]);
    const out: LeagueGroup[] = [];
    for (const [group, ms] of [...byGroup.entries()].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0))) {
      const ids = [...new Set(ms.flatMap((m) => [m.sideARegistrationId, m.sideBRegistrationId]))].filter(
        (id): id is string => id !== null,
      );
      const seeds = new Map(await Promise.all(ids.map(async (id) => [id, (await registrations.seedOf(id)) ?? 9999] as const)));
      ids.sort((x, y) => seeds.get(x)! - seeds.get(y)! || x.localeCompare(y));
      const played = ms
        .filter((m) => (m.status === 'completed' || m.status === 'walkover') && m.sideARegistrationId && m.sideBRegistrationId)
        .map((m) => ({
          a: m.sideARegistrationId!,
          b: m.sideBRegistrationId!,
          winner: m.winnerRegistrationId,
          tallyA: m.tallyA,
          tallyB: m.tallyB,
        }));
      out.push({ group, table: leagueTable(ids, played), qualify: group === null ? 0 : QUALIFY_PER_GROUP });
    }
    return out;
  }

  /** A league's table, or a group stage's tables. Empty for a knockout draw. */
  async function leagueTableFor(eventCategoryId: string): Promise<LeagueGroup[]> {
    return tablesOf(await repo.matchesForCategory(db, eventCategoryId));
  }

  /**
   * The group stage is over: the top two of every group play a knockout,
   * group winners seeded first and no first-round rematch of a group game.
   * No Plate — the group stage already gave everybody their games.
   */
  async function startKnockout(tx: Tx, tournamentId: string, eventCategoryId: string, all: MatchRow[]): Promise<void> {
    const tables = await tablesOf(all);
    const order = knockoutSeeding(tables.map((g) => g.table));
    // planDraw seeds by rating; hand it the knockout order as one.
    const plan = planDraw(
      order.map((registrationId, i) => ({ registrationId, rating: order.length - i, confirmedAt: new Date(0) })),
    );
    const rows = knockoutRows(plan.matches, { tournamentId, eventCategoryId, sportId: all[0]!.sportId }, false);
    await repo.createMatches(tx, rows);
    for (const row of rows) {
      if (row.round === 1) await settle(tx, row.id);
    }
    await outboxWrite(tx, {
      topic: 'knockout.drawn',
      payload: { tournamentId, eventCategoryId, entries: order.length },
    });
  }

  // --- scheduling (R11, R12, R13) --------------------------------------------

  /**
   * R11, R12 — greedy, re-run whenever a match becomes ready, and idempotent:
   * it only ever places matches that are ready and have no court, so running it
   * twice schedules nothing the second time.
   *
   * R13 — what it produces is ADVISORY. Organizers reassign courts by hand all
   * day and the API lets them; this removes typing, it does not own the day.
   */
  async function schedule(tournamentId: string): Promise<CourtAssignment[]> {
    const tournament = await repo.byId(db, tournamentId);
    if (!tournament) throw notFound();
    const event = await events.byId(tournament.eventId);

    const usable = (await schedulableCourts(event)).filter(
      (court) =>
        court.active && (court.sportIds.length === 0 || court.sportIds.includes(event.sportId)),
    );
    if (usable.length === 0) return [];

    const pending = await repo.readyUnscheduled(db, tournamentId);
    if (pending.length === 0) return [];

    const from = new Date(Math.max(now().getTime(), event.startsAt.getTime()));
    // F14 — the host's match length for this draw, not one number for every sport.
    const category = await events.categoryById(tournament.eventCategoryId);
    const duration = minutesOf(category) * MINUTE;
    const rest = MIN_REST_MINUTES * MINUTE;

    // Everything already on these courts, from any draw at this venue.
    const busy = new Map<string, Interval[]>();
    for (const court of usable) busy.set(court.id, []);
    for (const booking of await repo.bookedWindows(db, [...busy.keys()], from)) {
      busy.get(booking.courtId)?.push({
        from: booking.startsAt.getTime(),
        to: (booking.endsAt ?? new Date(booking.startsAt.getTime() + duration)).getTime(),
      });
    }

    const memberCache = new Map<string, string[]>();
    const membersOfCached = async (registrationId: string | null): Promise<string[]> => {
      if (!registrationId) return [];
      let found = memberCache.get(registrationId);
      if (!found) {
        found = await registrations.membersOf(registrationId);
        memberCache.set(registrationId, found);
      }
      return found;
    };

    // R11 — a player's minimum rest spans the whole event, not one draw: an
    // entry in two categories is still one pair of legs.
    const freeAt = new Map<string, number>();
    const noteBusy = async (registrationId: string | null, endsAt: number): Promise<void> => {
      for (const userId of await membersOfCached(registrationId)) {
        freeAt.set(userId, Math.max(freeAt.get(userId) ?? 0, endsAt + rest));
      }
    };
    for (const booked of await repo.scheduledSidesFor(db, tournament.eventId, from)) {
      const end = booked.startsAt.getTime() + duration;
      await noteBusy(booked.sideA, end);
      await noteBusy(booked.sideB, end);
    }

    const written: CourtAssignment[] = [];

    for (const match of pending) {
      const players = [
        ...(await membersOfCached(match.sideARegistrationId)),
        ...(await membersOfCached(match.sideBRegistrationId)),
      ];
      const playersFreeAt = players.reduce(
        (latest, userId) => Math.max(latest, freeAt.get(userId) ?? 0),
        from.getTime(),
      );

      let best: { courtId: string; startsAt: number } | null = null;
      for (const court of usable) {
        const startsAt = earliestFit(busy.get(court.id) ?? [], playersFreeAt, duration);
        if (!best || startsAt < best.startsAt) best = { courtId: court.id, startsAt };
      }
      if (!best) break;

      const startsAt = new Date(best.startsAt);
      const endsAt = new Date(best.startsAt + duration);
      try {
        await db.$transaction(async (tx) => {
          await repo.assignCourt(tx, {
            matchId: match.id,
            courtId: best!.courtId,
            startsAt,
            endsAt,
            assignedBy: 'scheduler',
          });
          await outboxWrite(tx, {
            topic: 'match.scheduled',
            payload: {
              matchId: match.id,
              tournamentId,
              eventId: tournament.eventId,
              courtId: best!.courtId,
              startsAt: startsAt.toISOString(),
            },
          });
        });
      } catch (err) {
        if (!isCourtOverlap(err)) throw err;
        // Somebody booked that court between the read and the write. The job
        // is retried, and an organizer can always place it by hand (R13).
        logger.warn(
          { matchId: match.id, courtId: best.courtId },
          'court taken while scheduling; leaving the match unassigned',
        );
        continue;
      }

      busy.get(best.courtId)?.push({ from: best.startsAt, to: best.startsAt + duration });
      await noteBusy(match.sideARegistrationId, best.startsAt + duration);
      await noteBusy(match.sideBRegistrationId, best.startsAt + duration);
      written.push({
        matchId: match.id,
        courtId: best.courtId,
        startsAt,
        endsAt,
        assignedBy: 'scheduler',
      });
    }

    return written;
  }

  /**
   * F14 — where the scheduler may put matches: the courts the host declared
   * for this event; failing that, the venue's own courts, but only when the
   * host runs the venue. Booking a venue's courts for someone else's event
   * needs that venue's agreement, which PL4Y does not have.
   */
  async function schedulableCourts(event: { id: string; venueId: string | null; organizerId?: string }) {
    const declared = courts.forEvent ? (await courts.forEvent(event.id)).filter((c) => c.active) : [];
    if (declared.length > 0) return declared;
    if (!event.venueId || !courts.venueOwner) return [];
    const owner = await courts.venueOwner(event.venueId);
    if (!owner || owner !== event.organizerId) return [];
    return courts.forVenue(event.venueId);
  }

  /**
   * #3 — how many courts the scheduler can place this event's matches on: the
   * event's own, else (for a host's own venue) the venue's. Zero means no
   * match gets a time and nobody gets a reminder.
   */
  async function scheduleCourtCount(eventId: string): Promise<number> {
    const event = await events.byId(eventId);
    return (await schedulableCourts(event)).filter(
      (court) => court.active && (court.sportIds.length === 0 || court.sportIds.includes(event.sportId)),
    ).length;
  }

  /** Every court a person may put a match on by hand: the event's own and the venue's. */
  async function assignableCourts(event: { id: string; venueId: string | null }) {
    const declared = courts.forEvent ? await courts.forEvent(event.id) : [];
    const venue = event.venueId ? await courts.forVenue(event.venueId) : [];
    return [...declared, ...venue];
  }

  /**
   * F14 — a time without a court: the host who has no courts on PL4Y can still
   * tell players when they play, and the 30-minute reminder still goes out.
   * Null takes the time (and any court) off.
   */
  async function setMatchTime(actor: Actor, matchId: string, startsAt: Date | null): Promise<Match> {
    const match = await repo.matchById(db, matchId);
    if (!match) throw matchNotFound();
    const tournament = await repo.byId(db, match.tournamentId);
    if (!tournament) throw notFound();
    await events.assertStaff(actor, tournament.eventId);
    if (RESOLVED.has(match.status)) {
      throw new UserError(TournamentCode.MATCH_NOT_READY, 'This match is already over.');
    }
    await db.$transaction(async (tx) => {
      if (startsAt === null) {
        await repo.clearAssignment(tx, matchId);
        return;
      }
      await repo.setScheduledAt(tx, matchId, startsAt);
      await outboxWrite(tx, {
        topic: 'match.scheduled',
        payload: {
          matchId,
          tournamentId: match.tournamentId,
          eventId: tournament.eventId,
          courtId: match.courtId,
          startsAt: startsAt.toISOString(),
        },
      });
    });
    return matchById(matchId);
  }

  /**
   * The same scheduler, run by a person rather than by the job. The job has no
   * actor, so the grant check lives here rather than inside `schedule`.
   */
  async function scheduleAs(actor: Actor, tournamentId: string): Promise<CourtAssignment[]> {
    const tournament = await repo.byId(db, tournamentId);
    if (!tournament) throw notFound();
    await events.assertStaff(actor, tournament.eventId);
    return schedule(tournamentId);
  }

  /**
   * R13 — the manual override. The scheduler is a convenience; this is the
   * thing organizers actually use, and the exclusion constraint is what keeps
   * it honest.
   */
  async function assignCourt(
    actor: Actor,
    input: { matchId: string; courtId: string; startsAt: Date; endsAt?: Date | null },
  ): Promise<Match> {
    const match = await repo.matchById(db, input.matchId);
    if (!match) throw matchNotFound();
    const tournament = await repo.byId(db, match.tournamentId);
    if (!tournament) throw notFound();
    const event = await events.byId(tournament.eventId);
    await events.assertStaff(actor, tournament.eventId);

    const court = (await assignableCourts(event)).find((c) => c.id === input.courtId);
    if (!court || !court.active) {
      throw new UserError(
        TournamentCode.COURT_NOT_FOUND,
        'That court is not part of this event or its venue.',
      );
    }

    const category = await events.categoryById(match.eventCategoryId);
    const endsAt =
      input.endsAt ?? new Date(input.startsAt.getTime() + minutesOf(category) * MINUTE);
    try {
      await db.$transaction(async (tx) => {
        await repo.assignCourt(tx, {
          matchId: input.matchId,
          courtId: input.courtId,
          startsAt: input.startsAt,
          endsAt,
          assignedBy: 'organizer',
        });
        await outboxWrite(tx, {
          topic: 'match.scheduled',
          payload: {
            matchId: input.matchId,
            tournamentId: match.tournamentId,
            eventId: tournament.eventId,
            courtId: input.courtId,
            startsAt: input.startsAt.toISOString(),
          },
        });
      });
    } catch (err) {
      if (!isCourtOverlap(err)) throw err;
      throw new UserError(
        TournamentCode.COURT_DOUBLE_BOOKED,
        'That court is already booked for part of this window.',
      );
    }
    return matchById(input.matchId);
  }

  async function unassignCourt(actor: Actor, matchId: string): Promise<Match> {
    const match = await repo.matchById(db, matchId);
    if (!match) throw matchNotFound();
    const tournament = await repo.byId(db, match.tournamentId);
    if (!tournament) throw notFound();
    await events.assertStaff(actor, tournament.eventId);
    await db.$transaction(async (tx) => repo.clearAssignment(tx, matchId));
    return matchById(matchId);
  }

  async function assignmentsFor(tournamentId: string): Promise<CourtAssignment[]> {
    return (await repo.assignmentsFor(db, tournamentId)).map((row) => ({
      matchId: row.matchId,
      courtId: row.courtId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      assignedBy: row.assignedBy as 'scheduler' | 'organizer',
    }));
  }

  // --- the ports other modules read through ----------------------------------

  /** venues R4. */
  const courtsPort = {
    assignedCourtIds: (input: {
      venueId: string;
      tournamentId: string;
      window: { from: Date; to: Date };
    }) =>
      repo.assignedCourtIds({
        venueId: input.venueId,
        tournamentId: input.tournamentId,
        from: input.window.from,
        to: input.window.to,
      }),
    courtHasScheduledMatches: (courtId: string) => repo.courtHasScheduledMatches(courtId),
  };

  /** F3 — matches in this event that somebody actually started (byes and voids do not count). */
  async function startedMatchCount(eventId: string): Promise<number> {
    return db.match.count({
      where: {
        tournament: { eventId },
        OR: [{ status: { in: ['live', 'awaiting_confirm', 'completed'] } }, { scoreSeq: { gt: 0 } }],
      },
    });
  }

  /** `scoring` starts a match; the status transition belongs to this module. */
  async function markLive(matchId: string, tx?: Tx): Promise<void> {
    const run = async (t: Tx): Promise<void> => {
      const match = await repo.matchById(t, matchId);
      if (!match) throw matchNotFound();
      if (RESOLVED.has(match.status)) return;
      if (match.sideARegistrationId === null || match.sideBRegistrationId === null) {
        throw new SystemError(
          TournamentCode.MATCH_NOT_READY,
          'Both sides of this match are not yet known.',
        );
      }
      if (match.status === 'live') return;
      const draw = await repo.byId(t, match.tournamentId);
      await repo.setStatus(t, matchId, 'live');
      // The event id rides along because the first match of any draw is what
      // flips the whole EVENT into Live Mode (events R: `promote-to-live`).
      await outboxWrite(t, {
        topic: 'match.live',
        payload: {
          matchId,
          tournamentId: match.tournamentId,
          eventId: draw?.eventId ?? null,
        },
      });
    };
    if (tx) return run(tx);
    await db.$transaction(run);
  }

  /**
   * scoring R6 — the last point of a match, or a result entered by hand, moves
   * it to `awaiting_confirm`. Only the opposing side's confirmation (or an
   * organizer override) resolves it, and that goes through `advance`.
   */
  async function markAwaitingConfirm(matchId: string, tx: Tx): Promise<void> {
    const match = await repo.matchById(tx, matchId);
    if (!match) throw matchNotFound();
    if (match.status === 'awaiting_confirm') return;
    if (match.status !== 'live' && match.status !== 'ready') {
      throw illegalTransition(match.status, 'awaiting_confirm');
    }
    await repo.setStatus(tx, matchId, 'awaiting_confirm');
    const draw = await repo.byId(tx, match.tournamentId);
    await outboxWrite(tx, {
      topic: 'match.awaiting_confirm',
      payload: { matchId, tournamentId: match.tournamentId, eventId: draw?.eventId ?? null },
    });
  }

  /** An unconfirmed final point, undone: the match is live again. */
  async function reopen(matchId: string, tx: Tx): Promise<void> {
    const match = await repo.matchById(tx, matchId);
    if (!match) throw matchNotFound();
    if (match.status === 'live') return;
    if (match.status !== 'awaiting_confirm') throw illegalTransition(match.status, 'live');
    await repo.setStatus(tx, matchId, 'live');
  }

  return {
    markAwaitingConfirm,
    reopen,
    generateDraw,
    autoDraw,
    regenerateDraw,
    drawPreview,
    setMatchTime,
    startedMatchCount,
    schedule,
    scheduleAs,
    assignCourt,
    unassignCourt,
    assignmentsFor,
    advance,
    markLive,
    correct,
    bracketFor,
    standingsFor,
    leagueTableFor,
    liveMatches,
    scheduleCourtCount,
    matchById,
    matchesFor,
    byId,
    findById,
    findByCategory,
    courts: courtsPort,
  };
}

export type TournamentService = ReturnType<typeof createTournamentService>;
