/**
 * registration — service layer (docs/modules/06-registration.md).
 *
 * The five-step flow from the brief, as one state machine. Three failure modes
 * here cost real money: OVERSELLING a draw with physical courts,
 * DOUBLE-CHARGING a player, and a PARTNER WHO NEVER ACCEPTS.
 *
 * The first is handled by the FOR UPDATE query in repo/index.ts (R4) and by the
 * unique partial index (R1). The second is handled by confirmFromPayment being
 * idempotent and by every status write going through one conditional UPDATE
 * (R11). The third is handled by not taking a seat hold while a registration
 * awaits a partner (R2).
 *
 * Nothing in here trusts a client-supplied amount: the quote is recomputed from
 * `events.priceQuote` and frozen onto the row (events R3).
 */
import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../../platform/db.js';
import {
  forbidden,
  illegalTransition,
  isUserError,
  SharedCode,
  SystemError,
  UserError,
} from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import { write as outboxWrite } from '../../../platform/outbox.js';
import { logger } from '../../../platform/logging/index.js';
import type { InviteRow, RegistrationRepo, RegistrationRow } from '../repo/index.js';
import {
  checkinTokenHash,
  signCheckinToken,
  verifyCheckinToken,
  type CheckinKeys,
} from './checkinToken.js';
import type { TicketEvent } from '../../../platform/emailKit.js';
import { inviteEmail } from './inviteEmail.js';
import { maskEmail } from './maskEmail.js';
import {
  LIVE_STATUSES,
  assertTransition,
  canTransition,
  type RegistrationStatus,
} from './transitions.js';
import { offerExpiresAt } from './waitlist.js';
import { memo } from '../../../platform/requestCache.js';

export { LIVE_STATUSES, REGISTRATION_STATUSES, SEATED_STATUSES, canTransition } from './transitions.js';
export type { RegistrationStatus } from './transitions.js';
export type { CheckinKeys } from './checkinToken.js';
export { maskEmail } from './maskEmail.js';

/** I1(b), M2 — the shape `playerId` must have before it is worth a lookup. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RegistrationCode = {
  CATEGORY_FULL: 'CATEGORY_FULL',
  HOLD_EXPIRED: 'HOLD_EXPIRED',
  ALREADY_REGISTERED: 'ALREADY_REGISTERED',
  PARTNER_ALREADY_ENTERED: 'PARTNER_ALREADY_ENTERED',
  /** R7 — skill band. See the note on age in `assertPartnerEligible`. */
  PARTNER_INELIGIBLE: 'PARTNER_INELIGIBLE',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  /** Somebody already accepted this invite (a shared link is good for one player). */
  INVITE_USED: 'INVITE_USED',
  /** The invite was declined, or the captain cancelled it. */
  INVITE_CLOSED: 'INVITE_CLOSED',
  CHECKIN_WINDOW_CLOSED: 'CHECKIN_WINDOW_CLOSED',
  NO_SPORT_SELECTED: 'NO_SPORT_SELECTED',
  REGISTRATION_NOT_FOUND: 'REGISTRATION_NOT_FOUND',
  /** A doubles draw needs a partner before it can take a seat. */
  PARTNER_REQUIRED: 'PARTNER_REQUIRED',
  CANNOT_INVITE_SELF: 'CANNOT_INVITE_SELF',
  /** Plan 3b — every spot on the team is already taken or has an open invite. */
  TEAM_COMPLETE: 'TEAM_COMPLETE',
  /** R13 — the red scan screen. */
  CHECKIN_TOKEN_INVALID: 'CHECKIN_TOKEN_INVALID',
  /** R17 — offer to rejoin the waitlist. */
  WAITLIST_OFFER_EXPIRED: 'WAITLIST_OFFER_EXPIRED',
  /** gap #4 — the draw is made or the event is under way; the organizer handles withdrawals. */
  CANCELLATION_CLOSED: 'CANCELLATION_CLOSED',
  /** gap #28 — a partner asks the captain, who paid, to withdraw the team. */
  CAPTAIN_ONLY: 'CAPTAIN_ONLY',
  /** gap #33 — organizer tools refuse once the draw exists. */
  DRAW_ALREADY_MADE: 'DRAW_ALREADY_MADE',
  /** gap #33 — offline entries are for singles draws for now. */
  OFFLINE_ENTRY_SINGLES_ONLY: 'OFFLINE_ENTRY_SINGLES_ONLY',
  /** F13 — self check-in from further away than the event. */
  CHECKIN_TOO_FAR: 'CHECKIN_TOO_FAR',
  /** F13 — self check-in at an event with a known place needs the phone's location. */
  CHECKIN_LOCATION_REQUIRED: 'CHECKIN_LOCATION_REQUIRED',
  /** F20 — a walk-in is an email or a name, and a doubles walk-in needs both players. */
  WALK_IN_INCOMPLETE: 'WALK_IN_INCOMPLETE',
  /** R23 — past the invite deadline or the roster lock, or the event is over. */
  TEAM_CHANGES_CLOSED: 'TEAM_CHANGES_CLOSED',
  /** R21 — the host asks every team for a name. */
  TEAM_NAME_REQUIRED: 'TEAM_NAME_REQUIRED',
  TEAM_NAME_INVALID: 'TEAM_NAME_INVALID',
  /** R24, R25 — that player is not on this entry. */
  NOT_ON_TEAM: 'NOT_ON_TEAM',
  /** R25 — the host does not allow replacing a teammate. */
  REPLACEMENTS_OFF: 'REPLACEMENTS_OFF',
  /** R25 — a player already checked in cannot be replaced. */
  MEMBER_CHECKED_IN: 'MEMBER_CHECKED_IN',
  /** R22 — a resend a moment after the last one. */
  RESEND_TOO_SOON: 'RESEND_TOO_SOON',
  /** R26 — a manual change by staff needs a reason. */
  REASON_REQUIRED: 'REASON_REQUIRED',
} as const;

/** R22 — the least time between two resends of one invite. */
export const RESEND_INTERVAL_MS = 60_000;
/** R21 — a team name's longest. */
export const TEAM_NAME_MAX = 40;

/** R27 — a payment's state, kept apart from the entry's (a paid entry may still wait for its teammate). */
export type PaymentStatus = 'not_due' | 'pending' | 'failed' | 'paid' | 'free' | 'offline' | 'refund_pending' | 'refunded';
/** R24 */
export type CheckInState = 'none' | 'partial' | 'all';

/** R24, R27 — one player on an entry, as the team card shows them. */
export interface RegistrationMember {
  userId: string;
  isCaptain: boolean;
  checkedInAt: Date | null;
}

/** R26 — one line of an entry's history. */
export interface HistoryEntry {
  id: string;
  registrationId: string;
  kind: string;
  actorUserId: string | null;
  subjectUserId: string | null;
  reason: string | null;
  data: unknown;
  createdAt: Date;
}

/** R11 (organizer dashboard) — the team numbers for one event. */
export interface TeamStats {
  teamSlots: number;
  paidEntries: number;
  completeTeams: number;
  awaitingTeammates: number;
  declinedInvites: number;
  cancelled: number;
  refundPending: number;
  refunded: number;
  participants: number;
  checkedInTeams: number;
  partiallyCheckedInTeams: number;
  checkedInParticipants: number;
}

/** F13 — how close to the event a player must be to check themselves in. */
export const SELF_CHECKIN_RADIUS_M = 1_000;
/** F27 — the flexible policy's refund between the cutoff and the start. */
export const FLEXIBLE_LATE_REFUND_BPS = 5_000;
/** F18 — after the place or dates change, entrants may withdraw in full for this long. */
export const TERMS_CHANGE_WINDOW_MS = 48 * 3_600_000;

/** R14 — how the entry was paid for. */
export type PaymentMode = 'online' | 'offline' | 'comp';

export interface Actor {
  userId: string;
}

export interface Registration {
  id: string;
  eventId: string;
  eventCategoryId: string;
  sportId: string;
  captainUserId: string;
  teamId: string | null;
  status: RegistrationStatus;
  seed: number | null;
  amountPaise: bigint;
  createdAt: Date;
  confirmedAt: Date | null;
  paymentMode: PaymentMode;
  /** R13 — the original check-in time; a re-scan never moves it. */
  checkedInAt: Date | null;
  checkedInBy: string | null;
  withdrawnReason: string | null;
  /** Non-null while a live hold exists — what the countdown on screen reads. */
  holdExpiresAt: Date | null;
  /** R17 — 1-based, non-null only while waitlisted. */
  waitlistPosition: number | null;
}

export interface Invite {
  id: string;
  registrationId: string;
  /** Null for a shareable link (R22), which is addressed to nobody. */
  invitedEmail: string | null;
  invitedUserId: string | null;
  /** Returned to the captain so the app can share the deep link (R12). */
  token: string;
  status: string;
  expiresAt: Date;
  /** R25 — accepting takes this member's place. */
  replacesUserId?: string | null;
  sentCount?: number;
  lastSentAt?: Date | null;
  createdAt?: Date;
}

/** R22 — what the invited player sees before deciding. Nothing about payment. */
export interface InviteDetails {
  inviteId: string;
  token: string;
  status: string;
  expiresAt: Date;
  registrationId: string;
  eventId: string;
  eventCategoryId: string;
  captainUserId: string;
  teamName: string | null;
  /** The entry's own state, so the screen can say "confirmed, waiting for you". */
  registrationStatus: RegistrationStatus;
  replacesUserId: string | null;
  /** Whether this viewer may accept it (the right account, still open). */
  canAccept: boolean;
}

/** R13 — one row of the offline check-in roster. Never carries the token itself. */
export interface RosterEntry {
  registrationId: string;
  eventCategoryId: string;
  status: RegistrationStatus;
  /** sha256 of the entry's QR token; the staff device hashes a scan and looks it up. */
  tokenHash: string;
  players: { userId: string; displayName: string; checkedInAt?: Date | null }[];
  checkedInAt: Date | null;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

// --- ports -------------------------------------------------------------------

export interface EventsPort {
  byId(eventId: string): Promise<{
    id: string;
    startsAt: Date;
    cancellationCutoffAt: Date | null;
    status: string;
    /** F13 — check-in stays open until the end of a multi-day event. */
    endsAt?: Date;
    /** F18 */
    termsChangedAt?: Date | null;
    /** F27 — standard | flexible */
    refundPolicy?: string;
  }>;
  /** F13 — where the event is (its pin, else its venue's). Absent or null: not known. */
  locationOf?(eventId: string): Promise<{ lat: number; lng: number } | null>;
  /** The title, start and place that the invite email shows. */
  forEmail(eventId: string): Promise<TicketEvent>;
  categoryById(categoryId: string): Promise<{
    id: string;
    eventId: string;
    sportId: string;
    teamSize: number;
    skillMin: number | null;
    skillMax: number | null;
    ageMin: number | null;
    ageMax: number | null;
    /** open | full | closed | drawn | completed | cancelled */
    status: string;
    capacity?: number;
    /** R21 — absent on older fakes: the old flow (every teammate accepts before payment). */
    teammatesAfterPayment?: boolean;
    teamNameRule?: string;
    minTeamSize?: number;
    maxTeamSize?: number;
    inviteDeadlineAt?: Date | null;
    rosterLockAt?: Date | null;
    allowReplacements?: boolean;
    waitlistEnabled?: boolean;
  }>;
  priceQuote(categoryId: string): Promise<{ totalPaise: bigint }>;
  assertRegistrationOpen(categoryId: string): Promise<void>;
  /** Emits category.full / reopens the draw after a release (events R4). */
  refreshCategoryFullness(categoryId: string): Promise<string>;
  assertStaff(actor: Actor, eventId: string, roles?: string[]): Promise<unknown>;
}

export interface ProfilePort {
  /** profile R2 — enforced again here, on the server, not only in onboarding. */
  assertHasSport(playerId: string): Promise<void>;
  findByUserId(userId: string): Promise<{
    id: string;
    sports: { sportId: string; skillBand: string }[];
  } | null>;
  /**
   * R12 — search hands the app a profile id; invites are addressed to users.
   *
   * I1 — must resolve only a profile whose visibility is not `private`
   * (profile R4: a private profile is not distinguishable from a missing
   * one). Implementations return null for a private profile exactly as they
   * do for an unknown id.
   */
  userIdForPlayer(playerId: string): Promise<string | null>;
}

export interface SportPort {
  skillBandsFor(
    sportId: string,
  ): Promise<{ key: string; lowerBound: number | null; upperBound: number | null }[]>;
}

export interface UsersPort {
  byIds(ids: string[]): Promise<{ id: string; displayName: string; email: string }[]>;
  findByEmail(email: string): Promise<{ id: string; displayName: string } | null>;
  /** F20 — a walk-in with no account: a user who can never sign in and is never emailed. */
  createGuest?(displayName: string): Promise<{ id: string }>;
}

/**
 * `payments` owns the refund state machine. registration decides WHETHER money
 * goes back (R9 — the policy is a registration concern); payments decides how.
 */
export interface PaymentsPort {
  refundForRegistration(input: {
    registrationId: string;
    reason: string;
    /** False after the cancellation cutoff: slot returns, money does not (R9). */
    refundAmount: boolean;
    /** An organizer's decision gives back everything, platform fee included. */
    includePlatformFee?: boolean;
    /** F27 — a share of the entry fee only (basis points). Absent: all of it. */
    fractionBps?: number;
  }): Promise<void>;
  /** R27 — the latest refund for each entry that has one: pending | processed | failed. */
  refundStates?(registrationIds: string[]): Promise<Map<string, string>>;
}

export interface EmailPort {
  send(msg: { to: string; subject: string; text: string; html?: string }): Promise<unknown>;
}

export interface RegistrationDeps {
  db: Db;
  repo: RegistrationRepo;
  events: EventsPort;
  profile: ProfilePort;
  sport: SportPort;
  users: UsersPort;
  payments: PaymentsPort;
  email: EmailPort;
  /** registration R3 — TTLs are config, not literals. */
  holdTtlSeconds: number;
  inviteTtlSeconds: number;
  checkinWindowMs: number;
  /** R17 — how long a promoted entry has to pay, outside quiet hours. */
  waitlistOfferTtlSeconds: number;
  /** R13 — the key ring the check-in QR is signed and verified with. */
  checkinKeys: CheckinKeys;
  now?: () => Date;
}

// --- helpers -----------------------------------------------------------------

/** R13 — any grant on the event may run the check-in desk. */
const DESK_ROLES = ['owner', 'manager', 'scorer'];

const notFound = () =>
  new UserError(
    RegistrationCode.REGISTRATION_NOT_FOUND,
    'That registration could not be found.',
  );

const categoryFull = () =>
  new UserError(RegistrationCode.CATEGORY_FULL, 'This draw is full.');

/** Why an invite that is no longer pending can't be accepted, in the player's words. */
const inviteSettled = (status: string) =>
  status === 'accepted'
    ? new UserError(RegistrationCode.INVITE_USED, 'That invite has already been used.')
    : status === 'declined' || status === 'revoked'
      ? new UserError(RegistrationCode.INVITE_CLOSED, 'That invite is no longer open. Ask your captain for a new one.')
      : new UserError(RegistrationCode.INVITE_EXPIRED, 'That invite has expired. Ask your partner to send a new one.');

const invalidCheckinToken = () =>
  new UserError(RegistrationCode.CHECKIN_TOKEN_INVALID, 'This QR code is not a valid entry.');

/** 256 bits, url-safe. It is a bearer credential for one seat in a draw. */
const inviteToken = (): string => randomBytes(32).toString('base64url');

const encodeCursor = (createdAt: Date, id: string): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const at = raw.lastIndexOf('|');
    if (at < 0) return null;
    const createdAt = new Date(raw.slice(0, at));
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: raw.slice(at + 1) };
  } catch {
    return null;
  }
}

/** Statuses a player may still be moving through toward a seat. */
const IN_PROGRESS: RegistrationStatus[] = [
  'draft',
  'awaiting_partner',
  'waitlisted',
  'payment_pending',
  'payment_failed',
];

/**
 * R21 — statuses in which the entry already has its seat (or is paying for
 * it). An invite accepted here only adds a player; the entry's status stays.
 */
const SEATED_OR_PAYING: RegistrationStatus[] = ['payment_pending', 'payment_failed', 'confirmed', 'checked_in'];

type Category = Awaited<ReturnType<EventsPort['categoryById']>>;

/**
 * R27 — a short reference a player can read out at the desk: PL4Y-3F9A-12C0.
 * Ids are UUIDv7: the first 12 hex digits are a timestamp (entries made in the
 * same minute share their first 8), so the reference takes the random tail.
 */
export const referenceFor = (registrationId: string): string => {
  const hex = registrationId.replace(/-/g, '').toUpperCase();
  return `PL4Y-${hex.slice(-8, -4)}-${hex.slice(-4)}`;
};

/** F13 — great-circle distance, in metres. Close enough at venue scale. */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function createRegistrationService(deps: RegistrationDeps) {
  const { db, repo, events, profile, sport, users, payments, email } = deps;
  const now = deps.now ?? (() => new Date());

  const hydrate = async (row: RegistrationRow): Promise<Registration> => {
    const [hold, waitlistPosition] = await Promise.all([
      repo.liveHoldFor(db, row.id),
      row.status === 'waitlisted' ? repo.waitlistPosition(row.id) : Promise.resolve(null),
    ]);
    return {
      ...row,
      status: row.status as RegistrationStatus,
      paymentMode: row.paymentMode as PaymentMode,
      holdExpiresAt: hold?.expiresAt ?? null,
      waitlistPosition,
    };
  };

  /** Speed — `hydrate` for a list: every row's live hold in one query, not one read per row. */
  const hydrateMany = async (rows: RegistrationRow[]): Promise<Registration[]> => {
    if (rows.length === 0) return [];
    const [holds, positions] = await Promise.all([
      repo.liveHoldsFor(rows.map((r) => r.id)),
      Promise.all(rows.map((r) => (r.status === 'waitlisted' ? repo.waitlistPosition(r.id) : null))),
    ]);
    return rows.map((row, i) => ({
      ...row,
      status: row.status as RegistrationStatus,
      paymentMode: row.paymentMode as PaymentMode,
      holdExpiresAt: holds.get(row.id)?.expiresAt ?? null,
      waitlistPosition: positions[i] ?? null,
    }));
  };

  async function byId(registrationId: string): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    return hydrate(row);
  }

  async function findById(registrationId: string): Promise<Registration | null> {
    const row = await repo.byId(registrationId);
    return row ? hydrate(row) : null;
  }

  /** Speed — many entries in one read, for request-scoped loaders. Missing ids are absent. */
  async function findByIds(registrationIds: readonly string[]): Promise<Map<string, Registration>> {
    const rows = await repo.byIds([...new Set(registrationIds)]);
    return new Map((await hydrateMany(rows)).map((r) => [r.id, r]));
  }

  async function isParticipant(actor: Actor, row: RegistrationRow): Promise<boolean> {
    if (row.captainUserId === actor.userId) return true;
    if (!row.teamId) return false;
    const teamId = row.teamId;
    const members = await memo(`team:members:${teamId}`, () => repo.teamMembers(teamId));
    return members.some((m) => m.userId === actor.userId);
  }

  /** The captain, or a team member. Nobody else may read a registration. */
  async function assertParticipant(actor: Actor, row: RegistrationRow): Promise<void> {
    if (!(await isParticipant(actor, row))) throw forbidden();
  }

  /**
   * gap #28 — withdrawing the entry is the captain's call: they paid for the
   * team, and after the cutoff a withdrawal costs them the fee. A partner is
   * told who to ask rather than refused with a bare FORBIDDEN.
   */
  async function assertCaptain(actor: Actor, row: RegistrationRow): Promise<void> {
    if (row.captainUserId === actor.userId) return;
    await assertParticipant(actor, row);
    throw new UserError(
      RegistrationCode.CAPTAIN_ONLY,
      'Only your team captain can withdraw this entry. Ask them to do it.',
    );
  }

  // --- R21–R26: team helpers ---------------------------------------------------

  /** R21 — a team is complete at min and can never exceed max. Singles: 1. */
  const minTeam = (c: Category): number => (c.teamSize > 1 ? (c.minTeamSize ?? c.teamSize) : 1);
  const maxTeam = (c: Category): number =>
    c.teamSize > 1 ? (c.maxTeamSize ?? Math.max(c.teamSize, minTeam(c))) : 1;
  /** R21 — the captain pays first and invites teammates after. */
  const paysFirst = (c: Category): boolean => c.teamSize > 1 && c.teammatesAfterPayment === true;

  /** R26 — one line of history, in the caller's transaction when there is one. */
  async function record(
    client: Tx | Db,
    entry: {
      registrationId: string;
      kind: string;
      actorUserId?: string | null;
      subjectUserId?: string | null;
      reason?: string | null;
      data?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await repo.addHistory(client, {
      id: newId(),
      registrationId: entry.registrationId,
      kind: entry.kind,
      actorUserId: entry.actorUserId ?? null,
      subjectUserId: entry.subjectUserId ?? null,
      reason: entry.reason ?? null,
      data: (entry.data ?? null) as never,
    });
  }

  /**
   * R23 — when a team may still change. Players: until the roster lock (or
   * the start). Accepting an invite also stops at the invite deadline. Staff
   * may fix a team until the event is over.
   */
  function assertTeamChangesOpen(
    category: Category,
    event: Awaited<ReturnType<EventsPort['byId']>>,
    what: 'invite' | 'roster',
    opts: { staff?: boolean } = {},
  ): void {
    const closed = () =>
      new UserError(RegistrationCode.TEAM_CHANGES_CLOSED, 'This team can no longer be changed for this event.');
    if (event.status === 'cancelled' || event.status === 'completed' || category.status === 'cancelled') throw closed();
    const at = now().getTime();
    if (opts.staff) {
      const end = event.endsAt ?? event.startsAt;
      if (at > end.getTime()) throw closed();
      return;
    }
    const lock = (category.rosterLockAt ?? event.startsAt).getTime();
    if (at >= lock) throw closed();
    if (what === 'invite' && category.inviteDeadlineAt && at >= category.inviteDeadlineAt.getTime()) throw closed();
  }

  /** R3, R23 — an invite lives 48 hours, or until the invite deadline when that is sooner. */
  function inviteExpiry(category: Category, event: Awaited<ReturnType<EventsPort['byId']>>): Date {
    const ttl = now().getTime() + deps.inviteTtlSeconds * 1000;
    const deadline = Math.min(
      (category.inviteDeadlineAt ?? event.startsAt).getTime(),
      (category.rosterLockAt ?? event.startsAt).getTime(),
      event.startsAt.getTime(),
    );
    return new Date(Math.min(ttl, deadline));
  }

  /** Everyone on the entry: the team's members, or the one player of a singles entry. */
  async function rosterOf(row: RegistrationRow, client?: Tx): Promise<string[]> {
    if (!row.teamId) return [row.captainUserId];
    const members = client
      ? await client.teamMember.findMany({ where: { teamId: row.teamId }, select: { userId: true } })
      : await repo.teamMembers(row.teamId);
    return members.length > 0 ? members.map((m) => m.userId) : [row.captainUserId];
  }

  function cleanTeamName(raw: string | null | undefined): string | null {
    const name = raw?.trim().replace(/\s+/g, ' ') ?? '';
    if (!name) return null;
    if (name.length < 2 || name.length > TEAM_NAME_MAX) {
      throw new UserError(RegistrationCode.TEAM_NAME_INVALID, `A team name is 2 to ${TEAM_NAME_MAX} letters.`);
    }
    return name;
  }

  const needReason = (reason: string | null | undefined): string => {
    const r = reason?.trim() ?? '';
    if (r.length < 3) throw new UserError(RegistrationCode.REASON_REQUIRED, 'Give a reason for this change.');
    return r.slice(0, 500);
  };

  // --- holds -----------------------------------------------------------------

  /**
   * R4 — a seat, or null when the draw is full. The empty result IS the "full"
   * answer; there is no retry loop, because a retry loop against a lock turns a
   * full draw into a stalled one.
   *
   * Writes no outbox row: a free entry consumes its hold in the same
   * transaction (R18), and scheduling a release for it would be noise.
   */
  async function tryHold(
    tx: Tx,
    row: RegistrationRow,
    ttlSeconds = deps.holdTtlSeconds,
    allowClosed = false,
  ): Promise<{ id: string; expiresAt: Date } | null> {
    return repo.acquireHold(tx, {
      holdId: newId(),
      eventCategoryId: row.eventCategoryId,
      registrationId: row.id,
      ttlSeconds,
      allowClosed,
    });
  }

  /**
   * The worker turns this into a delayed release job. Written in the same
   * transaction as the hold, so a crash between the two cannot leave a hold
   * nothing will ever release (platform R5).
   */
  async function announceHold(
    tx: Tx,
    row: RegistrationRow,
    hold: { id: string; expiresAt: Date },
  ): Promise<void> {
    await outboxWrite(tx, {
      topic: 'hold.created',
      payload: {
        holdId: hold.id,
        registrationId: row.id,
        eventCategoryId: row.eventCategoryId,
        expiresAt: hold.expiresAt.toISOString(),
      },
    });
  }

  /**
   * A registration that already holds a live seat keeps it: a payment retry
   * must not queue behind its own hold (R8).
   */
  async function takeHold(
    tx: Tx,
    row: RegistrationRow,
  ): Promise<{ id: string; expiresAt: Date }> {
    const existing = await repo.liveHoldFor(tx, row.id);
    if (existing) return { id: existing.id, expiresAt: existing.expiresAt };

    const hold = await tryHold(tx, row);
    if (!hold) throw categoryFull();
    await announceHold(tx, row, hold);
    return hold;
  }

  /**
   * R18 — a zero-total entry is confirmed in the transaction that took its
   * seat. No payment order exists for it, and capacity was still decided by R4.
   */
  async function confirmFreeInTx(tx: Tx, row: RegistrationRow, holdId: string): Promise<void> {
    assertTransition('payment_pending', 'confirmed');
    const moved = await repo.transition(tx, row.id, 'payment_pending', 'confirmed', {
      confirmedAt: now(),
    });
    if (!moved) throw notFound();
    await repo.releaseHold(tx, holdId);

    await outboxWrite(tx, {
      topic: 'registration.confirmed',
      payload: {
        registrationId: row.id,
        eventId: row.eventId,
        eventCategoryId: row.eventCategoryId,
        captainUserId: row.captainUserId,
        paymentId: null,
        free: true,
      },
    });
    await outboxWrite(tx, {
      topic: 'capacity.changed',
      payload: { eventCategoryId: row.eventCategoryId, eventId: row.eventId },
    });
  }

  /**
   * The shared end of `begin`, `joinWaitlist` and `acceptInvite`: the moment an
   * entry either takes a seat or, when the draw is full, joins the queue.
   *
   * Call it under the category lock (repo.lockCategory), because the waitlist
   * check below is only meaningful there. While anybody is queued, a seat that
   * frees up belongs to the head of the queue — not to whoever taps "register"
   * in the seconds before `promote-waitlist` runs (R17).
   */
  async function seatOrQueue(
    tx: Tx,
    row: RegistrationRow,
    from: 'draft' | 'awaiting_partner',
    opts: { queueIfFull: boolean; teamId?: string },
  ): Promise<'seated' | 'waitlisted'> {
    const extra = opts.teamId ? { teamId: opts.teamId } : {};
    const queued = await repo.hasWaiting(tx, row.eventCategoryId);
    const hold = queued ? null : await tryHold(tx, row);

    if (hold) {
      assertTransition(from, 'payment_pending');
      if (!(await repo.transition(tx, row.id, from, 'payment_pending', extra))) throw notFound();
      if (row.amountPaise === 0n) await confirmFreeInTx(tx, row, hold.id);
      else await announceHold(tx, row, hold);
      return 'seated';
    }

    if (!opts.queueIfFull) throw categoryFull();
    // R17 — no hold. The entry waits for capacity to return.
    assertTransition(from, 'waitlisted');
    if (!(await repo.transition(tx, row.id, from, 'waitlisted', extra))) throw notFound();
    await repo.enqueueWaitlist(tx, {
      registrationId: row.id,
      eventCategoryId: row.eventCategoryId,
    });
    return 'waitlisted';
  }

  /**
   * events' early, friendly refusal. The authoritative decision is still the
   * FOR UPDATE in acquireHold. `allowFull` lets the waitlist paths through a
   * full draw; a closed draw is closed for everybody.
   */
  async function assertOpen(
    categoryId: string,
    opts: { allowFull: boolean; previous?: RegistrationRow[] },
  ): Promise<void> {
    try {
      await events.assertRegistrationOpen(categoryId);
    } catch (e) {
      if (!isUserError(e) || e.code !== RegistrationCode.CATEGORY_FULL) throw e;
      if (opts.allowFull) return;
      // R17 — a player whose offer lapsed is told so, which is what lets the
      // app offer the queue again instead of a dead end.
      for (const earlier of opts.previous ?? []) {
        if (earlier.status === 'expired' && (await repo.wasOffered(earlier.id))) {
          throw new UserError(
            RegistrationCode.WAITLIST_OFFER_EXPIRED,
            'Your waitlist offer expired. You can join the waitlist again.',
          );
        }
      }
      throw categoryFull();
    }
  }

  // --- begin -----------------------------------------------------------------

  /**
   * Step one. Freezes the price onto the registration (events R3) and, for a
   * singles draw, takes the seat immediately. A doubles draw stays `draft` with
   * NO HOLD until a partner accepts (R2) — a 48-hour hold would let one player
   * park a slot in a popular draw for two days.
   *
   * A full draw is refused with CATEGORY_FULL; the app then offers
   * `joinWaitlist` (R17). A free draw confirms here and now (R18).
   *
   * Idempotent by design: a second call from a flaky mobile network returns the
   * in-progress registration rather than creating a second one.
   */
  async function begin(
    actor: Actor,
    input: { eventCategoryId: string; teamName?: string | null },
  ): Promise<Registration> {
    return start(actor, input, { queueIfFull: false });
  }

  /**
   * R17 — the same first step, for a draw that is full. A singles entry joins
   * the queue at once. A doubles team may queue only once the partner has
   * accepted, so for doubles this creates the ordinary draft: the captain
   * invites as usual, and `acceptInvite` routes the team to the waitlist if the
   * draw is still full at that moment.
   *
   * If the draw turns out to have a seat after all, the player gets the seat.
   * Nobody should be queued for something they could have had.
   */
  async function joinWaitlist(
    actor: Actor,
    input: { eventCategoryId: string; teamName?: string | null },
  ): Promise<Registration> {
    return start(actor, input, { queueIfFull: true });
  }

  async function start(
    actor: Actor,
    input: { eventCategoryId: string; teamName?: string | null },
    opts: { queueIfFull: boolean },
  ): Promise<Registration> {
    const category = await events.categoryById(input.eventCategoryId);
    // R21 — a host who turned the waitlist off gets a plain "full".
    const queueIfFull = opts.queueIfFull && category.waitlistEnabled !== false;
    const team = category.teamSize > 1;
    const payFirst = paysFirst(category);
    const teamName = team ? cleanTeamName(input.teamName) : null;
    const me = await profile.findByUserId(actor.userId);
    if (!me) throw notFound();
    await profile.assertHasSport(me.id);

    // Whether this player already has an entry is settled BEFORE capacity is
    // consulted. They are not competing for a seat — they are holding one, and
    // their own hold is part of the number that says the draw is full. Asking
    // first is how a payment retry gets told the draw is full by its own seat
    // (R8), and how a flaky network turns an idempotent re-tap into an error.
    let existing = await repo.forCaptainInCategory(actor.userId, input.eventCategoryId);
    // R5 — an entry whose hold ran out, before the release job reached it, is
    // dead. Release it now so "Start over" begins a new entry rather than
    // handing back the lapsed one. A failed payment keeps its R8 retry instead.
    const pending = existing.find((r) => r.status === 'payment_pending');
    if (pending && !(await repo.liveHoldFor(db, pending.id))) {
      const lapsed = await repo.lapsedHoldsFor(pending.id);
      for (const hold of lapsed) await expireHold(hold.id);
      if (lapsed.length) existing = await repo.forCaptainInCategory(actor.userId, input.eventCategoryId);
    }
    const live = existing.find((r) => IN_PROGRESS.includes(r.status as RegistrationStatus));
    const settled = existing.find((r) =>
      (['confirmed', 'checked_in'] as string[]).includes(r.status),
    );
    if (settled) {
      throw new UserError(
        RegistrationCode.ALREADY_REGISTERED,
        'You are already entered in this draw.',
        { details: { registrationId: settled.id } },
      );
    }
    if (live) {
      // R8 — a failed payment retries against the same hold while it lives.
      if (live.status === 'payment_failed') return retryPayment(live);
      return hydrate(live);
    }
    // gap #27 — the rows above are only the ones this player captains. Being
    // somebody's partner in this draw is an entry too.
    if (await repo.playerHasLiveEntry(actor.userId, input.eventCategoryId, LIVE_STATUSES)) {
      throw new UserError(RegistrationCode.ALREADY_REGISTERED, 'You are already entered in this draw.');
    }

    // R21 — a host who asks every team for a name gets one before anybody pays.
    if (team && !teamName && category.teamNameRule === 'required') {
      throw new UserError(RegistrationCode.TEAM_NAME_REQUIRED, 'Give your team a name to register.');
    }

    // Only a NEW entry has to fit.
    await assertOpen(input.eventCategoryId, {
      allowFull: queueIfFull,
      previous: existing,
    });

    const quote = await events.priceQuote(input.eventCategoryId);
    const id = newId();
    // R21 — the captain's team exists from the start when they pay first (so
    // the team card has its captain) or when it already has a name.
    const teamId = team && (payFirst || teamName) ? newId() : null;
    const seatsNow = !team || payFirst;

    await db.$transaction(async (tx) => {
      // Before the insert, not after it: `registrations` references the
      // category, so inserting first and locking second is a lock upgrade and
      // a deadlock under load (repo.lockCategory).
      if (seatsNow) await repo.lockCategory(tx, category.id);

      if (teamId) {
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: category.id,
          name: teamName,
          members: [{ userId: actor.userId, isCaptain: true }],
        });
      }

      const row = await repo.insert(tx, {
        id,
        eventId: category.eventId,
        eventCategoryId: category.id,
        sportId: category.sportId,
        captainUserId: actor.userId,
        teamId,
        status: 'draft',
        seed: null,
        amountPaise: quote.totalPaise,
      });
      await record(tx, {
        registrationId: id,
        kind: 'registration_started',
        actorUserId: actor.userId,
        data: { payFirst, teamName },
      });

      // A singles draw has nobody to wait for, so it takes its seat now. So
      // does a team whose host lets the captain pay first (R21). Otherwise a
      // team waits for its players — R2.
      if (seatsNow) {
        await seatOrQueue(tx, row, 'draft', { queueIfFull });
      }
    });

    return byId(id);
  }

  /** R8 — a payment retry reuses the live hold, or takes a new one if it expired. */
  async function retryPayment(row: RegistrationRow): Promise<Registration> {
    await db.$transaction(async (tx) => {
      assertTransition('payment_failed', 'payment_pending');
      await repo.lockCategory(tx, row.eventCategoryId);
      await takeHold(tx, row);
      await repo.transition(tx, row.id, 'payment_failed', 'payment_pending');
    });
    return byId(row.id);
  }

  // --- waitlist (R17) --------------------------------------------------------

  /**
   * Moves the head of the queue to `payment_pending` by acquiring a hold
   * through the R4 query. Returns null when there is nobody to promote or no
   * seat to promote them into — the worker calls this until it does.
   *
   * The offer lives for the configured TTL, or until 08:00 IST when it is made
   * during quiet hours. A lapsed offer is an ordinary expired hold: the release
   * job expires the entry and writes `capacity.changed`, which promotes the
   * next one.
   */
  async function promoteWaitlist(categoryId: string): Promise<Registration | null> {
    // A closed or cancelled draw promotes nobody. A full one has no seat to give.
    try {
      await events.assertRegistrationOpen(categoryId);
    } catch (e) {
      if (isUserError(e)) return null;
      throw e;
    }

    const at = now();
    const expiresAt = offerExpiresAt(at, deps.waitlistOfferTtlSeconds * 1000);
    const ttlSeconds = Math.max(Math.ceil((expiresAt.getTime() - at.getTime()) / 1000), 60);

    const promotedId = await db.$transaction(async (tx) => {
      await repo.lockCategory(tx, categoryId);
      const head = await repo.waitlistHead(tx, categoryId);
      if (!head) return null;

      const hold = await tryHold(tx, head, ttlSeconds);
      if (!hold) return null;

      assertTransition('waitlisted', 'payment_pending');
      if (!(await repo.transition(tx, head.id, 'waitlisted', 'payment_pending'))) {
        // Impossible under the category lock (leaveWaitlist takes it too), so
        // roll the hold back rather than strand it.
        throw notFound();
      }
      await repo.markOffered(tx, head.id, at);

      if (head.amountPaise === 0n) {
        await confirmFreeInTx(tx, head, hold.id);
      } else {
        await announceHold(tx, head, hold);
        await outboxWrite(tx, {
          topic: 'waitlist.offered',
          payload: {
            registrationId: head.id,
            eventId: head.eventId,
            eventCategoryId: head.eventCategoryId,
            captainUserId: head.captainUserId,
            expiresAt: hold.expiresAt.toISOString(),
          },
        });
      }
      return head.id;
    });

    if (!promotedId) return null;
    await events.refreshCategoryFullness(categoryId).catch((err: unknown) => {
      logger.error({ err, categoryId }, 'category fullness refresh failed after promotion');
    });
    return byId(promotedId);
  }

  /**
   * Gives up a place in the queue. An entry that has already been offered a
   * seat is past the queue; leaving it is a cancellation, and that releases
   * the hold to the next in line.
   */
  async function leaveWaitlist(actor: Actor, registrationId: string): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    await assertCaptain(actor, row);
    if (row.status === 'withdrawn') return hydrate(row);
    if (row.status !== 'waitlisted') return cancel(actor, registrationId);

    await db.$transaction(async (tx) => {
      // The same lock promotion takes, so a promotion cannot pick this entry
      // in the instant it is leaving.
      await repo.lockCategory(tx, row.eventCategoryId);
      const moved = await repo.transition(tx, row.id, 'waitlisted', 'withdrawn');
      if (!moved) return;
      await repo.removeFromWaitlist(tx, row.id);
      await outboxWrite(tx, {
        topic: 'registration.cancelled',
        payload: {
          registrationId: row.id,
          captainUserId: row.captainUserId,
          refunded: false,
          reason: 'left_waitlist',
        },
      });
    });
    return byId(row.id);
  }

  // --- partner invites -------------------------------------------------------

  /**
   * R12 — the partner may be an existing player picked from in-app search, or
   * an email address typed in when they have no account yet.
   *
   * Typing an email you may not know is the friction most likely to cost a
   * doubles registration (ADR 0002), so `playerId` is the path the app should
   * offer first and `email` is the fallback.
   *
   * No seat hold is taken here. That is R2, and it is the whole reason the
   * invite TTL can be 48 hours.
   */
  async function invitePartner(
    actor: Actor,
    input: {
      registrationId: string;
      email?: string | null;
      playerUserId?: string | null;
      playerId?: string | null;
      /** R25 — accepting takes this member's place on the team. */
      replacesUserId?: string | null;
    },
  ): Promise<Invite> {
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (row.captainUserId !== actor.userId) throw forbidden();

    // M3 — playerId wins over playerUserId when both are given, matching the
    // documented order of preference (playerId, then playerUserId, then
    // email — docs/modules/06-registration.md R12).
    let invitedUserId: string | null = null;
    // I1(d) — true whenever the invitee was resolved from an account id
    // rather than an email the captain typed; the returned invite masks the
    // email in that case.
    let resolvedFromAccountId = false;
    if (input.playerId) {
      // M2 — a non-UUID playerId would otherwise reach a `@db.Uuid` column
      // and surface as a 500. Treat it the same as an id nothing resolves to.
      if (!UUID_RE.test(input.playerId)) throw notFound();
      // I1 — private returns null here, same as unknown (profile R4).
      invitedUserId = await profile.userIdForPlayer(input.playerId);
      if (!invitedUserId) throw notFound();
      resolvedFromAccountId = true;
    } else if (input.playerUserId) {
      invitedUserId = input.playerUserId;
      resolvedFromAccountId = true;
    }
    let invitedEmail = input.email?.trim().toLowerCase() ?? '';

    if (invitedUserId) {
      const [user] = await users.byIds([invitedUserId]);
      if (!user) throw notFound();
      invitedEmail = user.email;
    } else if (invitedEmail) {
      // Bind the invite to an account when one already exists, so accepting is
      // one tap rather than a signup.
      const found = await users.findByEmail(invitedEmail);
      invitedUserId = found?.id ?? null;
    } else {
      throw new UserError(
        RegistrationCode.PARTNER_INELIGIBLE,
        'Choose a player or enter an email address.',
      );
    }

    if (invitedUserId === actor.userId) {
      throw new UserError(
        RegistrationCode.CANNOT_INVITE_SELF,
        'You cannot invite yourself as your own partner.',
      );
    }

    // Eligibility is checked at ACCEPT, not here (R7) — the partner may not
    // have an account yet, so there may be nothing to check. What we can check
    // now is that they are not already entered, because that is a wasted
    // invite and the captain should hear about it immediately.
    if (
      invitedUserId &&
      (await repo.playerHasLiveEntry(invitedUserId, row.eventCategoryId, LIVE_STATUSES))
    ) {
      throw new UserError(
        RegistrationCode.PARTNER_ALREADY_ENTERED,
        'That player is already entered in this draw.',
      );
    }

    const invite = await createInvite(actor, row, {
      invitedEmail,
      invitedUserId,
      replacesUserId: input.replacesUserId ?? null,
      kind: 'invite_sent',
    });

    // After the commit, and best effort: the outbox row is the durable record,
    // and a bounced invite must not roll back a registration.
    await sendInviteEmail(row, actor.userId, invite);

    return {
      ...invite,
      // I1(d) — the real address is stored on the row as always; only the
      // object handed back to the captain is masked, and only when they did
      // not type it themselves.
      invitedEmail:
        resolvedFromAccountId && invite.invitedEmail ? maskEmail(invite.invitedEmail) : invite.invitedEmail,
    };
  }

  /**
   * R22 — a link the captain shares on WhatsApp, addressed to nobody. The
   * first signed-in player to accept it joins (the accept is conditional on
   * the invite still being pending, so two people cannot both take it).
   */
  async function createInviteLink(
    actor: Actor,
    input: { registrationId: string; replacesUserId?: string | null },
  ): Promise<Invite> {
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (row.captainUserId !== actor.userId) throw forbidden();
    // A captain tapping "Share link" twice gets the same open link back.
    if (!input.replacesUserId) {
      const open = (await repo.invitesFor(row.id)).find(
        (i) => i.status === 'pending' && !i.invitedEmail && !i.invitedUserId && !i.replacesUserId && i.expiresAt > now(),
      );
      if (open) return toInvite(open);
    }
    return createInvite(actor, row, {
      invitedEmail: null,
      invitedUserId: null,
      replacesUserId: input.replacesUserId ?? null,
      kind: 'invite_link_created',
    });
  }

  const toInvite = (i: InviteRow): Invite => ({
    id: i.id,
    registrationId: i.registrationId,
    invitedEmail: i.invitedEmail,
    invitedUserId: i.invitedUserId,
    token: i.token,
    status: i.status,
    expiresAt: i.expiresAt,
    replacesUserId: i.replacesUserId,
    sentCount: i.sentCount,
    lastSentAt: i.lastSentAt,
    createdAt: i.createdAt,
  });

  /**
   * The shared middle of every invite (R12, R22, R25): checks the entry can
   * still take a player, counts the open spots, writes the invite and its
   * outbox row. Before payment it moves a draft to `awaiting_partner`; after
   * payment the entry's status does not change (R21).
   */
  async function createInvite(
    actor: Actor,
    row: RegistrationRow,
    who: {
      invitedEmail: string | null;
      invitedUserId: string | null;
      replacesUserId: string | null;
      kind: 'invite_sent' | 'invite_link_created';
      staff?: boolean;
    },
  ): Promise<Invite> {
    const status = row.status as RegistrationStatus;
    const seated = SEATED_OR_PAYING.includes(status);
    if (!seated && status !== 'draft' && status !== 'awaiting_partner') {
      assertTransition(status, 'awaiting_partner');
    }

    const [category, event] = await Promise.all([
      events.categoryById(row.eventCategoryId),
      events.byId(row.eventId),
    ]);
    if (category.teamSize < 2) throw forbidden();
    assertTeamChangesOpen(category, event, 'invite', { staff: who.staff });

    const members = row.teamId ? await repo.teamMembers(row.teamId) : [];
    const replacing = who.replacesUserId;
    if (replacing) await assertReplaceable(row, category, members, replacing, { staff: who.staff });

    // Plan 3b — a pair has one open spot; a bigger team has one per teammate.
    const max = maxTeam(category);
    const pair = max === 2;
    const existing = await repo.invitesFor(row.id);
    const pending = existing.filter((i) => i.status === 'pending' && i.expiresAt > now());
    const joined = Math.max(members.length - 1, 0);
    if (!pair) {
      // An invite that replaces a player takes that player's spot, not a new one.
      const open = max - 1 - joined - pending.filter((i) => !i.replacesUserId).length;
      if (!replacing && open <= 0) {
        throw new UserError(RegistrationCode.TEAM_COMPLETE, 'Every spot on this team is taken or invited.');
      }
    } else if (!replacing && joined >= 1) {
      throw new UserError(RegistrationCode.TEAM_COMPLETE, 'Your team is complete.');
    }

    const token = inviteToken();
    const expiresAt = inviteExpiry(category, event);
    const inviteId = newId();

    const created = await db.$transaction(async (tx) => {
      // A pair's earlier pending invite is superseded: a captain who re-invites
      // has changed their mind, and two live tokens for one seat is one too many.
      // A bigger team keeps every open invite — each is for a different spot,
      // except an earlier invite to replace the same player.
      for (const old of pending) {
        if (pair || (replacing && old.replacesUserId === replacing)) await repo.settleInvite(tx, old.id, 'revoked');
      }
      const invite = await repo.createInvite(tx, {
        id: inviteId,
        registrationId: row.id,
        invitedEmail: who.invitedEmail,
        invitedUserId: who.invitedUserId,
        token,
        status: 'pending',
        expiresAt,
        replacesUserId: replacing,
      });
      if (status === 'draft') {
        assertTransition('draft', 'awaiting_partner');
        await repo.transition(tx, row.id, 'draft', 'awaiting_partner');
      }
      await record(tx, {
        registrationId: row.id,
        kind: who.kind,
        actorUserId: actor.userId,
        subjectUserId: who.invitedUserId,
        data: { inviteId, replacesUserId: replacing, link: !who.invitedEmail && !who.invitedUserId },
      });
      await outboxWrite(tx, {
        topic: 'invite.created',
        payload: {
          inviteId,
          registrationId: row.id,
          invitedEmail: who.invitedEmail,
          invitedUserId: who.invitedUserId,
          expiresAt: expiresAt.toISOString(),
        },
      });
      return invite;
    });
    return toInvite(created);
  }

  /** R25 — who may be replaced: a teammate (never the captain), not yet checked in. */
  async function assertReplaceable(
    row: RegistrationRow,
    category: Category,
    members: { userId: string; isCaptain: boolean }[],
    userId: string,
    opts: { staff?: boolean } = {},
  ): Promise<void> {
    if (!opts.staff && category.allowReplacements === false) {
      throw new UserError(RegistrationCode.REPLACEMENTS_OFF, 'The organiser does not allow replacing a teammate here.');
    }
    const member = members.find((m) => m.userId === userId);
    if (!member || member.isCaptain) {
      throw new UserError(RegistrationCode.NOT_ON_TEAM, 'That player is not a teammate on this entry.');
    }
    const checkins = await repo.checkinsFor([row.id]);
    if (checkins.some((c) => c.userId === userId)) {
      throw new UserError(RegistrationCode.MEMBER_CHECKED_IN, 'That player is already checked in, so they cannot be replaced.');
    }
  }

  async function sendInviteEmail(row: RegistrationRow, captainUserId: string, invite: Invite): Promise<void> {
    if (!invite.invitedEmail) return;
    const to = invite.invitedEmail;
    const [[captain], event] = await Promise.all([
      users.byIds([captainUserId]),
      events.forEmail(row.eventId).catch(() => null),
    ]);
    await email
      .send({
        to,
        ...inviteEmail({
          to,
          captainName: captain?.displayName ?? 'A player',
          token: invite.token,
          expiresAt: invite.expiresAt,
          event,
        }),
      })
      .catch((err: unknown) => {
        logger.error({ err, inviteId: invite.id }, 'partner invite email failed');
      });
  }

  /**
   * R22 — the captain (or staff) sends an open invite again: the push and the
   * email go out once more and the expiry is left alone. An invite that has
   * expired is replaced by a new one to the same player.
   */
  async function resendInvite(actor: Actor, inviteId: string, opts: { reason?: string | null } = {}): Promise<Invite> {
    const invite = await repo.inviteById(inviteId);
    if (!invite) throw notFound();
    const row = await repo.byId(invite.registrationId);
    if (!row) throw notFound();
    const staff = row.captainUserId !== actor.userId;
    if (staff) await events.assertStaff(actor, row.eventId, ['owner', 'manager']);
    const reason = staff ? needReason(opts.reason) : null;

    const lapsed = invite.status === 'expired' || (invite.status === 'pending' && invite.expiresAt <= now());
    if (lapsed) {
      if (invite.status === 'pending') {
        await db.$transaction((tx) => repo.settleInvite(tx, invite.id, 'expired'));
      }
      const fresh = await createInvite(actor, row, {
        invitedEmail: invite.invitedEmail,
        invitedUserId: invite.invitedUserId,
        replacesUserId: invite.replacesUserId,
        kind: invite.invitedEmail || invite.invitedUserId ? 'invite_sent' : 'invite_link_created',
        staff,
      });
      await sendInviteEmail(row, row.captainUserId, fresh);
      return fresh;
    }
    if (invite.status !== 'pending') {
      throw new UserError(RegistrationCode.INVITE_EXPIRED, 'That invite has already been answered.');
    }
    if (invite.lastSentAt && now().getTime() - invite.lastSentAt.getTime() < RESEND_INTERVAL_MS) {
      throw new UserError(RegistrationCode.RESEND_TOO_SOON, 'You just sent this invite. Try again in a minute.', {
        retryAfterSeconds: 60,
      });
    }
    if (!(await repo.markInviteResent(invite.id, now()))) {
      throw new UserError(RegistrationCode.INVITE_EXPIRED, 'That invite has already been answered.');
    }
    await db.$transaction(async (tx) => {
      await record(tx, {
        registrationId: row.id,
        kind: 'invite_resent',
        actorUserId: actor.userId,
        subjectUserId: invite.invitedUserId,
        reason,
        data: { inviteId: invite.id },
      });
      // notify only — the worker's expiry job for this invite is already queued.
      await outboxWrite(tx, {
        topic: 'invite.resent',
        payload: { inviteId: invite.id, registrationId: row.id, invitedUserId: invite.invitedUserId },
      });
    });
    const refreshed = (await repo.inviteById(invite.id))!;
    await sendInviteEmail(row, row.captainUserId, toInvite(refreshed));
    return toInvite(refreshed);
  }

  /** R22 — the captain takes back an invite nobody has answered. */
  async function revokeInvite(actor: Actor, inviteId: string): Promise<Invite> {
    const invite = await repo.inviteById(inviteId);
    if (!invite) throw notFound();
    const row = await repo.byId(invite.registrationId);
    if (!row) throw notFound();
    if (row.captainUserId !== actor.userId) throw forbidden();
    await db.$transaction(async (tx) => {
      if (!(await repo.settleInvite(tx, invite.id, 'revoked'))) return;
      await record(tx, {
        registrationId: row.id,
        kind: 'invite_revoked',
        actorUserId: actor.userId,
        subjectUserId: invite.invitedUserId,
        data: { inviteId: invite.id },
      });
      // A pre-payment entry stays `awaiting_partner` (the guard has no way
      // back to draft); the captain invites someone else from there.
    });
    return toInvite((await repo.inviteById(invite.id))!);
  }

  /**
   * R22 — what the invite link shows before the player decides: the event,
   * the team and its captain. A token is a bearer credential, so anybody
   * holding it may read this much; an invite addressed to another account
   * reads as not found.
   */
  async function inviteDetails(actor: Actor, token: string): Promise<InviteDetails | null> {
    const invite = await repo.inviteByToken(token.trim());
    if (!invite) return null;
    // A shared link that someone else already used still reads as used, so the
    // next person to tap it hears "already used" rather than "not for you".
    const usedLink = invite.status === 'accepted' && !invite.invitedEmail;
    if (invite.invitedUserId && invite.invitedUserId !== actor.userId && !usedLink) return null;
    const row = await repo.byId(invite.registrationId);
    if (!row) return null;
    const names = row.teamId ? await repo.teamNames([row.teamId]) : new Map<string, string | null>();
    const open = invite.status === 'pending' && invite.expiresAt > now();
    const live = !['withdrawn', 'refunded', 'expired'].includes(row.status);
    return {
      inviteId: invite.id,
      token: invite.token,
      status: open ? 'pending' : invite.status === 'pending' ? 'expired' : invite.status,
      expiresAt: invite.expiresAt,
      registrationId: row.id,
      eventId: row.eventId,
      eventCategoryId: row.eventCategoryId,
      captainUserId: row.captainUserId,
      teamName: row.teamId ? (names.get(row.teamId) ?? null) : null,
      registrationStatus: row.status as RegistrationStatus,
      replacesUserId: invite.replacesUserId,
      canAccept: open && live && row.captainUserId !== actor.userId,
    };
  }

  /** R22 — the invites waiting for this player's answer, for My PL4Y. */
  async function myPendingInvites(actor: Actor): Promise<InviteDetails[]> {
    const invites = await repo.pendingInvitesForUser(actor.userId);
    const out: InviteDetails[] = [];
    for (const i of invites) {
      const d = await inviteDetails(actor, i.token);
      if (d && d.canAccept) out.push(d);
    }
    return out;
  }

  /** R21 — the captain names (or renames) the team until the roster locks. */
  async function setTeamName(actor: Actor, registrationId: string, rawName: string | null): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    const staff = row.captainUserId !== actor.userId;
    if (staff) await events.assertStaff(actor, row.eventId, ['owner', 'manager']);
    const [category, event] = await Promise.all([events.categoryById(row.eventCategoryId), events.byId(row.eventId)]);
    if (category.teamSize < 2) throw forbidden();
    assertTeamChangesOpen(category, event, 'roster', { staff });
    const name = cleanTeamName(rawName);
    if (!name && category.teamNameRule === 'required') {
      throw new UserError(RegistrationCode.TEAM_NAME_REQUIRED, 'This event asks every team for a name.');
    }
    await db.$transaction(async (tx) => {
      // The team may not exist yet (a pre-payment pair with nobody accepted).
      let teamId = row.teamId;
      if (!teamId) {
        await repo.lockCategory(tx, row.eventCategoryId);
        teamId = newId();
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: row.eventCategoryId,
          name,
          members: [{ userId: row.captainUserId, isCaptain: true }],
        });
        await repo.attachTeam(tx, row.id, teamId);
      } else {
        await repo.setTeamName(tx, teamId, name);
      }
      await record(tx, { registrationId: row.id, kind: 'team_renamed', actorUserId: actor.userId, data: { name } });
    });
    return byId(row.id);
  }

  /**
   * R7 — the partner must satisfy the category's constraints, checked HERE and
   * not at invite time, because at invite time they may not have had an
   * account.
   *
   * Skill is checked against their declared band. AGE IS NOT: no date of birth
   * is stored anywhere in the schema, so `age_min`/`age_max` have no data to
   * check against in Phase 1. That is a gap in the data model rather than a
   * shortcut here, and adding a birth date to `player_profiles` is what closes
   * it — silently passing every player is the honest behaviour until then.
   */
  async function assertPartnerEligible(
    partnerUserId: string,
    category: Awaited<ReturnType<EventsPort['categoryById']>>,
  ): Promise<void> {
    if (category.skillMin === null && category.skillMax === null) return;

    const partner = await profile.findByUserId(partnerUserId);
    const declared = partner?.sports.find((s) => s.sportId === category.sportId);
    if (!declared) {
      throw new UserError(
        RegistrationCode.PARTNER_INELIGIBLE,
        'Your partner has not chosen this sport yet.',
      );
    }

    const bands = await sport.skillBandsFor(category.sportId);
    const band = bands.find((b) => b.key === declared.skillBand);
    if (!band) {
      throw new UserError(
        RegistrationCode.PARTNER_INELIGIBLE,
        'Your partner’s skill level is not one this sport recognises.',
      );
    }

    // The band is a range and so is the category. They must overlap; a 3.5
    // player is eligible for a 3.0–4.0 draw even though neither bound matches.
    const lower = band.lowerBound ?? Number.NEGATIVE_INFINITY;
    const upper = band.upperBound ?? Number.POSITIVE_INFINITY;
    const min = category.skillMin ?? Number.NEGATIVE_INFINITY;
    const max = category.skillMax ?? Number.POSITIVE_INFINITY;
    if (upper < min || lower > max) {
      throw new UserError(
        RegistrationCode.PARTNER_INELIGIBLE,
        'Your partner’s skill level is outside this draw.',
      );
    }
  }

  /**
   * The moment the team becomes real, and therefore the moment a seat is taken
   * (R2). Everything below happens in one transaction: settle the invite, write
   * the team, take the hold, move the status.
   *
   * If the draw filled while the partner was reading their email, the team is
   * written and QUEUED instead (R17) — a team that has done everything right
   * keeps its place in line rather than being bounced back to square one.
   */
  async function acceptInvite(actor: Actor, token: string): Promise<Registration> {
    const invite = await repo.inviteByToken(token);
    if (!invite) throw notFound();
    if (invite.status !== 'pending') throw inviteSettled(invite.status);
    if (invite.expiresAt <= now()) {
      throw new UserError(
        RegistrationCode.INVITE_EXPIRED,
        'That invite has expired. Ask your partner to send a new one.',
      );
    }

    const row = await repo.byId(invite.registrationId);
    if (!row) throw notFound();
    if (row.captainUserId === actor.userId) {
      throw new UserError(
        RegistrationCode.CANNOT_INVITE_SELF,
        'You cannot accept your own invite.',
      );
    }
    // gap #29 — an invite addressed to an account is that account's. A link
    // forwarded to a group chat must not hand the seat to whoever taps first.
    // An invite to an email with no account yet, or a shareable link (R22),
    // stays a bearer link.
    if (invite.invitedUserId && invite.invitedUserId !== actor.userId) throw forbidden();

    const [category, event] = await Promise.all([
      events.categoryById(row.eventCategoryId),
      events.byId(row.eventId),
    ]);
    const status = row.status as RegistrationStatus;
    // R21 — an entry that already has its seat (the captain paid first) only
    // gains a player; it is not competing for capacity, so a closed or full
    // draw does not matter. Its window is the invite deadline (R23).
    const seated = SEATED_OR_PAYING.includes(status);
    if (seated) {
      assertTeamChangesOpen(category, event, 'invite');
    } else {
      if (status !== 'draft' && status !== 'awaiting_partner') {
        throw new UserError(RegistrationCode.INVITE_EXPIRED, 'That entry is no longer open.');
      }
      assertTeamChangesOpen(category, event, 'invite');
      await assertOpen(row.eventCategoryId, { allowFull: category.waitlistEnabled !== false });
    }

    const partner = await profile.findByUserId(actor.userId);
    if (!partner) throw notFound();
    await profile.assertHasSport(partner.id);
    await assertPartnerEligible(actor.userId, category);

    if (await repo.playerHasLiveEntry(actor.userId, row.eventCategoryId, LIVE_STATUSES)) {
      throw new UserError(
        RegistrationCode.PARTNER_ALREADY_ENTERED,
        'You are already entered in this draw.',
      );
    }

    let teamComplete = false;
    let replaced: string | null = null;
    await db.$transaction(async (tx) => {
      // Ahead of createTeam, which references the category — repo.lockCategory.
      // It also serialises every accept in the draw, so the team read below is
      // the one the previous accept committed.
      await repo.lockCategory(tx, row.eventCategoryId);

      // gap #27 — asked again under the category lock, so two invites to the
      // same player in one draw, accepted at once, cannot both succeed.
      if (await repo.playerHasLiveEntry(actor.userId, row.eventCategoryId, LIVE_STATUSES, tx)) {
        throw new UserError(RegistrationCode.PARTNER_ALREADY_ENTERED, 'You are already entered in this draw.');
      }

      // Conditional on `pending`, so two taps on the accept button — or two
      // people with the same shareable link (R22) — cannot both join.
      const settled = await repo.settleInvite(tx, invite.id, 'accepted');
      if (!settled) {
        // Lost a race: somebody else took the link, or the captain cancelled it.
        const latest = await tx.registrationInvite.findUnique({ where: { id: invite.id }, select: { status: true } });
        throw inviteSettled(latest?.status ?? 'expired');
      }
      const current = (await tx.registration.findUnique({ where: { id: row.id } })) ?? row;
      const from = current.status as RegistrationStatus;
      if (['withdrawn', 'refunded', 'expired'].includes(from)) {
        throw new UserError(RegistrationCode.INVITE_EXPIRED, 'That entry is no longer open.');
      }
      if (current.captainUserId !== actor.userId && invite.invitedUserId === null) {
        // Bind a bearer link to whoever took it, for the record.
        await tx.registrationInvite.update({ where: { id: invite.id }, data: { invitedUserId: actor.userId } });
      }

      let teamId = current.teamId;
      if (!teamId) {
        teamId = newId();
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: row.eventCategoryId,
          name: null,
          members: [
            { userId: row.captainUserId, isCaptain: true },
            { userId: actor.userId, isCaptain: false },
          ],
        });
      } else {
        // R25 — a replacement takes the other player's place, unless that
        // player was checked in meanwhile (then the invite fails, untouched).
        if (invite.replacesUserId) {
          const inAlready = await tx.registrationCheckin.count({
            where: { registrationId: row.id, userId: invite.replacesUserId },
          });
          if (inAlready > 0) {
            throw new UserError(RegistrationCode.MEMBER_CHECKED_IN, 'The player you would replace is already checked in.');
          }
          if (await repo.removeTeamMember(tx, teamId, invite.replacesUserId)) replaced = invite.replacesUserId;
        }
        if ((await repo.countTeamMembers(tx, teamId)) >= maxTeam(category)) {
          throw new UserError(RegistrationCode.TEAM_COMPLETE, 'This team is already complete.');
        }
        await repo.addTeamMember(tx, teamId, actor.userId);
      }

      const count = await repo.countTeamMembers(tx, teamId);
      teamComplete = count >= minTeam(category);
      await record(tx, {
        registrationId: row.id,
        kind: replaced ? 'member_replaced' : 'invite_accepted',
        actorUserId: actor.userId,
        subjectUserId: actor.userId,
        data: { inviteId: invite.id, replacedUserId: replaced, teamComplete },
      });
      await outboxWrite(tx, {
        topic: 'invite.accepted',
        payload: {
          inviteId: invite.id,
          registrationId: row.id,
          captainUserId: row.captainUserId,
          userId: actor.userId,
          replacedUserId: replaced,
          teamComplete,
          // Before payment the team's confirmation push covers the teammate; after it, this does.
          seated: SEATED_OR_PAYING.includes(from),
        },
      });

      // R2 — before payment, the seat is taken when the team is complete (plan 3b).
      if (from === 'draft' || from === 'awaiting_partner') {
        if (teamComplete) {
          await seatOrQueue(tx, current, from, {
            queueIfFull: category.waitlistEnabled !== false,
            teamId,
          });
        } else if (!current.teamId) {
          await repo.attachTeam(tx, row.id, teamId);
        }
      } else if (!current.teamId) {
        await repo.attachTeam(tx, row.id, teamId);
      }
    });

    return byId(row.id);
  }

  /**
   * Teammate registration — the captain enters a teammate directly and pays
   * for both, with no invite to accept. The teammate must already have a
   * PL4Y account (picked from in-app search), so the entry, and once paid its
   * QR ticket, shows on their own login. A teammate with no account still
   * goes through `invitePartner` by email.
   *
   * Everything `acceptInvite` checks for the partner is checked here instead,
   * because here is the only moment we see them: eligibility (R7), not already
   * entered (gap #27), and a free spot on the team (plan 3b). When the team is
   * whole the seat is taken (R2) — or the team queues if the draw filled (R17).
   */
  async function addTeammate(
    actor: Actor,
    input: { registrationId: string; playerId: string },
  ): Promise<Registration> {
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (row.captainUserId !== actor.userId) throw forbidden();
    const status = row.status as RegistrationStatus;
    if (status !== 'draft' && status !== 'awaiting_partner') {
      throw new UserError(RegistrationCode.TEAM_COMPLETE, 'This entry already has its team.');
    }

    // I1 — a private or unknown profile reads the same: not found.
    if (!UUID_RE.test(input.playerId)) throw notFound();
    const teammateId = await profile.userIdForPlayer(input.playerId);
    if (!teammateId) throw notFound();
    if (teammateId === actor.userId) {
      throw new UserError(RegistrationCode.CANNOT_INVITE_SELF, 'You are already on this entry.');
    }

    const category = await events.categoryById(row.eventCategoryId);
    if (category.teamSize < 2) throw forbidden();
    await assertOpen(row.eventCategoryId, { allowFull: true });

    const teammate = await profile.findByUserId(teammateId);
    if (!teammate || teammate.sports.length === 0) {
      throw new UserError(RegistrationCode.PARTNER_INELIGIBLE, 'That player has not chosen a sport yet.');
    }
    await assertPartnerEligible(teammateId, category);

    const alreadyEntered = () =>
      new UserError(RegistrationCode.PARTNER_ALREADY_ENTERED, 'That player is already entered in this draw.');
    if (await repo.playerHasLiveEntry(teammateId, row.eventCategoryId, LIVE_STATUSES)) throw alreadyEntered();

    const spots = maxTeam(category) - 1;

    await db.$transaction(async (tx) => {
      // Ahead of createTeam, which references the category — repo.lockCategory.
      // It also serialises this against an invite being accepted in the draw.
      await repo.lockCategory(tx, row.eventCategoryId);
      if (await repo.playerHasLiveEntry(teammateId, row.eventCategoryId, LIVE_STATUSES, tx)) throw alreadyEntered();

      const current = (await repo.byId(row.id)) ?? row;
      const from = current.status as RegistrationStatus;
      if (from !== 'draft' && from !== 'awaiting_partner') {
        throw new UserError(RegistrationCode.TEAM_COMPLETE, 'This entry already has its team.');
      }

      const pending = (await repo.invitesFor(row.id)).filter((i) => i.status === 'pending');
      // A pair has one seat for a partner: adding one directly supersedes any
      // open invite, the same as re-inviting does.
      if (spots === 1) {
        for (const old of pending) await repo.settleInvite(tx, old.id, 'revoked');
      }
      const joined = current.teamId ? (await repo.countTeamMembers(tx, current.teamId)) - 1 : 0;
      const open = spots === 1 ? 0 : pending.length;
      if (joined + open >= spots) {
        throw new UserError(RegistrationCode.TEAM_COMPLETE, 'Every spot on this team is taken or invited.');
      }

      let teamId = current.teamId;
      if (!teamId) {
        teamId = newId();
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: row.eventCategoryId,
          name: null,
          members: [
            { userId: row.captainUserId, isCaptain: true },
            { userId: teammateId, isCaptain: false },
          ],
        });
      } else {
        await repo.addTeamMember(tx, teamId, teammateId);
      }

      await record(tx, {
        registrationId: row.id,
        kind: 'member_added',
        actorUserId: actor.userId,
        subjectUserId: teammateId,
        data: { direct: true },
      });
      await outboxWrite(tx, {
        topic: 'teammate.added',
        payload: { registrationId: row.id, teammateUserId: teammateId, captainUserId: row.captainUserId },
      });

      // R2 — the seat is taken when the team is whole, not before (plan 3b).
      if ((await repo.countTeamMembers(tx, teamId)) >= minTeam(category)) {
        await seatOrQueue(tx, current, from, { queueIfFull: category.waitlistEnabled !== false, teamId });
      } else {
        if (!current.teamId) await repo.attachTeam(tx, row.id, teamId);
        // A draft is not a live entry, so the teammate would not count as
        // entered (gap #27) and could be put on a second team meanwhile.
        if (from === 'draft') {
          assertTransition('draft', 'awaiting_partner');
          await repo.transition(tx, row.id, 'draft', 'awaiting_partner');
        }
      }
    });

    return byId(row.id);
  }

  async function declineInvite(actor: Actor, token: string): Promise<void> {
    const invite = await repo.inviteByToken(token);
    if (!invite) throw notFound();
    if (invite.invitedUserId && invite.invitedUserId !== actor.userId) throw forbidden();
    const row = await repo.byId(invite.registrationId);
    if (row?.captainUserId === actor.userId) {
      throw new UserError(RegistrationCode.CANNOT_INVITE_SELF, 'You cannot answer your own invite.');
    }

    await db.$transaction(async (tx) => {
      // R9 (team) — a no changes nothing else: a paid entry stays paid and
      // its seat stays held; the captain invites somebody else.
      if (!(await repo.settleInvite(tx, invite.id, 'declined'))) return;
      await record(tx, {
        registrationId: invite.registrationId,
        kind: 'invite_declined',
        actorUserId: actor.userId,
        subjectUserId: actor.userId,
        data: { inviteId: invite.id },
      });
      await outboxWrite(tx, {
        topic: 'invite.declined',
        payload: { inviteId: invite.id, registrationId: invite.registrationId },
      });
    });
  }

  /**
   * The 48-hour TTL (or the invite deadline), run by the job. Before payment
   * an entry with nobody left to wait for expires and the captain gets a
   * re-invite prompt; after payment the entry is untouched and the captain is
   * told the invite lapsed (R21).
   */
  async function expireInvite(inviteId: string): Promise<void> {
    const row = await repo.inviteById(inviteId);
    if (!row || row.status !== 'pending') return;
    if (row.expiresAt > now()) return;

    const registration = await repo.byId(row.registrationId);
    await db.$transaction(async (tx) => {
      const settled = await repo.settleInvite(tx, inviteId, 'expired');
      if (!settled) return;
      if (!registration) return;
      await record(tx, {
        registrationId: registration.id,
        kind: 'invite_expired',
        subjectUserId: row.invitedUserId,
        data: { inviteId },
      });
      if (SEATED_OR_PAYING.includes(registration.status as RegistrationStatus)) {
        await outboxWrite(tx, {
          topic: 'invite.expired',
          payload: { inviteId, registrationId: registration.id, captainUserId: registration.captainUserId },
        });
        return;
      }
      // Plan 3b — a bigger team keeps waiting while another invite is still open.
      const stillOpen = (await repo.invitesFor(registration.id)).some((i) => i.id !== inviteId && i.status === 'pending');
      if (registration.status === 'awaiting_partner' && !stillOpen) {
        await repo.transition(tx, registration.id, 'awaiting_partner', 'expired');
        await outboxWrite(tx, {
          topic: 'registration.expired',
          payload: { registrationId: registration.id, reason: 'invite_expired' },
        });
      }
    });
  }

  // --- payment callbacks -----------------------------------------------------

  /**
   * payments calls this, and ONLY payments calls this (R5 over there: nothing
   * else confirms a registration).
   *
   * The module doc writes `confirmFromPayment(paymentId)`. registration may not
   * read the payments tables to resolve that id into a registration
   * (conventions.md §1 — table ownership is exclusive), so payments passes both.
   *
   * IDEMPOTENT. Five duplicate `payment.captured` deliveries must produce one
   * confirmed registration, one push and one ledger entry; the conditional
   * UPDATE is what makes the first of those true, and it is why this returns
   * quietly instead of throwing when the work is already done.
   */
  async function confirmFromPayment(input: {
    registrationId: string;
    paymentId: string;
  }): Promise<{ registration: Registration; confirmedNow: boolean }> {
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (row.status === 'confirmed' || row.status === 'checked_in') {
      return { registration: await hydrate(row), confirmedNow: false };
    }

    const status = row.status as RegistrationStatus;
    assertTransition(status, 'confirmed');

    // gap #3 — a payment that lands after the draw was cancelled (or the whole
    // event), or after the bracket was made, has no draw to confirm into. The
    // throw is ILLEGAL_TRANSITION, which payments turns into a full refund.
    const [event, category] = await Promise.all([
      events.byId(row.eventId),
      events.categoryById(row.eventCategoryId),
    ]);
    if (
      event.status === 'cancelled' ||
      event.status === 'completed' ||
      ['cancelled', 'drawn', 'completed'].includes(category.status)
    ) {
      throw illegalTransition(status, 'confirmed');
    }

    const moved = await db.$transaction(async (tx) => {
      const hold = await repo.liveHoldFor(tx, row.id);
      // R8 — a capture that lands after the failure notice (same order id
      // retried on the provider's page) confirms only while the seat is still
      // held. Once the hold is gone the seat may be someone else's.
      //
      // gap #14 — the same for a payment that was merely slow: a hold that has
      // run out stopped counting against capacity the instant it expired, so
      // the seat may already be somebody else's even before the release job
      // marks this entry expired. The hold is extended while an order is open
      // (gap #22), so an honest payer does not get here.
      if ((status === 'payment_failed' || status === 'payment_pending') && !hold) {
        throw new SystemError(
          SharedCode.ILLEGAL_TRANSITION,
          `Illegal transition ${status} -> confirmed: the seat hold has lapsed`,
        );
      }

      const ok = await repo.transition(tx, row.id, status, 'confirmed', {
        confirmedAt: now(),
      });
      // Somebody else won the race. Their transaction wrote the outbox rows;
      // writing a second set is exactly the duplicate push this rule exists
      // to prevent.
      if (!ok) return false;

      // The hold has done its job: the seat is now held by the registration
      // itself, which `taken` counts.
      if (hold) await repo.releaseHold(tx, hold.id);

      await outboxWrite(tx, {
        topic: 'registration.confirmed',
        payload: {
          registrationId: row.id,
          eventId: row.eventId,
          eventCategoryId: row.eventCategoryId,
          captainUserId: row.captainUserId,
          paymentId: input.paymentId,
        },
      });
      await outboxWrite(tx, {
        topic: 'capacity.changed',
        payload: { eventCategoryId: row.eventCategoryId, eventId: row.eventId },
      });
      return true;
    });

    const after = await byId(row.id);
    // Lost a race to something other than a confirmation (expiry, withdrawal):
    // the entry is not confirmed, and the caller must know that.
    if (!moved && after.status !== 'confirmed' && after.status !== 'checked_in') {
      throw illegalTransition(after.status, 'confirmed');
    }
    return { registration: after, confirmedNow: moved };
  }

  /**
   * R8 — a failed payment leaves the hold ALIVE until its TTL, so a retry does
   * not lose the slot. Only expiry releases it.
   */
  async function failFromPayment(input: {
    registrationId: string;
    paymentId: string;
    reason: string;
  }): Promise<Registration> {
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (row.status !== 'payment_pending') return hydrate(row);

    await db.$transaction(async (tx) => {
      const moved = await repo.transition(tx, row.id, 'payment_pending', 'payment_failed');
      if (!moved) return;
      await outboxWrite(tx, {
        topic: 'registration.payment_failed',
        payload: {
          registrationId: row.id,
          captainUserId: row.captainUserId,
          paymentId: input.paymentId,
          reason: input.reason,
        },
      });
    });

    return byId(row.id);
  }

  // --- expiry ----------------------------------------------------------------

  /**
   * The release job. R5 — this is NOT what makes capacity correct; the count
   * predicate already ignores an expired hold. This flips `released_at`, moves
   * the registration to `expired` and tells the world capacity changed — which
   * is also what promotes the next waitlisted entry when this was an offer
   * (R17).
   *
   * Idempotent, and safe to run early: a hold that has not actually expired is
   * left alone.
   */
  async function expireHold(holdId: string): Promise<void> {
    const hold = await repo.holdById(holdId);
    if (!hold || hold.releasedAt !== null) return;
    if (hold.expiresAt > now()) return;

    const row = await repo.byId(hold.registrationId);
    const lapsedOffer = row ? await repo.wasOffered(row.id) : false;

    await db.$transaction(async (tx) => {
      const released = await repo.releaseHold(tx, holdId);
      if (!released) return;

      if (row) {
        const status = row.status as RegistrationStatus;
        // A confirmed registration whose hold is being tidied up is normal:
        // confirmFromPayment already released it, or a retry raced. Only an
        // unfinished one expires.
        if (status === 'payment_pending' || status === 'payment_failed') {
          await repo.transition(tx, row.id, status, 'expired');
          await outboxWrite(tx, {
            topic: 'registration.expired',
            payload: {
              registrationId: row.id,
              captainUserId: row.captainUserId,
              reason: lapsedOffer ? 'waitlist_offer_expired' : 'hold_expired',
            },
          });
        }
        await outboxWrite(tx, {
          topic: 'capacity.changed',
          payload: { eventCategoryId: hold.eventCategoryId, eventId: row.eventId },
        });
      }
    });

    await events.refreshCategoryFullness(hold.eventCategoryId).catch((err: unknown) => {
      logger.error({ err, holdId }, 'category fullness refresh failed after hold release');
    });
  }

  /** R5's safety net. A delayed job that was lost must not strand a seat. */
  async function sweepStaleHolds(): Promise<number> {
    const stale = await repo.staleHolds();
    for (const hold of stale) await expireHold(hold.id);
    return stale.length;
  }

  async function sweepStaleInvites(): Promise<number> {
    const stale = await repo.staleInvites();
    for (const invite of stale) await expireInvite(invite.id);
    return stale.length;
  }

  // --- cancellation and check-in ---------------------------------------------

  /**
   * R9 — cancelling after `cancellation_cutoff_at` refunds nothing but STILL
   * returns the slot and reopens the draw. Punishing the player should not
   * punish the draw.
   *
   * Only money that passed through the platform can go back through it: a free
   * entry (R18) or one paid offline (R14) is withdrawn, never "refunded".
   */
  async function cancel(actor: Actor, registrationId: string): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    await assertCaptain(actor, row);

    const status = row.status as RegistrationStatus;
    if (status === 'refunded' || status === 'withdrawn' || status === 'expired') {
      return hydrate(row);
    }
    if (status === 'waitlisted') return leaveWaitlist(actor, registrationId);

    const [event, category] = await Promise.all([
      events.byId(row.eventId),
      events.categoryById(row.eventCategoryId),
    ]);
    // gap #4 — once the bracket exists (or the event is under way) a
    // withdrawal is a walkover in somebody's match, which is the organizer's
    // to record. And it is never a refund.
    if (
      ['drawn', 'completed'].includes(category.status) ||
      ['live', 'completed', 'cancelled'].includes(event.status)
    ) {
      throw new UserError(
        RegistrationCode.CANCELLATION_CLOSED,
        'The draw has been made, so you can no longer withdraw here. Contact the organizer.',
      );
    }
    // gap #4 — no cutoff set means refunds stop when the event starts, not never.
    const cutoff = event.cancellationCutoffAt ?? event.startsAt;
    const paidOnline =
      status === 'confirmed' && row.paymentMode === 'online' && row.amountPaise > 0n;
    const at = now();
    // F18 — the host moved the place or the dates after this player entered:
    // they may leave with everything back for 48 hours, cutoff or not.
    const termsChanged =
      !!event.termsChangedAt && at.getTime() < event.termsChangedAt.getTime() + TERMS_CHANGE_WINDOW_MS;
    const beforeCutoff = at < cutoff;
    // F27 — the flexible policy gives half back between the cutoff and the start.
    const lateHalf = !beforeCutoff && !termsChanged && event.refundPolicy === 'flexible' && at < event.startsAt;
    const refundable = paidOnline && (beforeCutoff || termsChanged || lateHalf);
    const next: RegistrationStatus = refundable && !lateHalf ? 'refunded' : 'withdrawn';
    assertTransition(status, next);

    await db.$transaction(async (tx) => {
      const moved = await repo.transition(tx, row.id, status, next);
      if (!moved) return;

      const hold = await repo.liveHoldFor(tx, row.id);
      if (hold) await repo.releaseHold(tx, hold.id);
      // Nobody can join an entry that is gone.
      for (const invite of await repo.invitesFor(row.id)) {
        if (invite.status === 'pending') await repo.settleInvite(tx, invite.id, 'revoked');
      }
      await record(tx, {
        registrationId: row.id,
        kind: 'cancelled',
        actorUserId: actor.userId,
        data: { refunded: refundable && !lateHalf, lateHalf, status: next },
      });

      await outboxWrite(tx, {
        topic: 'registration.cancelled',
        payload: {
          registrationId: row.id,
          captainUserId: row.captainUserId,
          refunded: refundable && !lateHalf,
        },
      });
      await outboxWrite(tx, {
        topic: 'capacity.changed',
        payload: { eventCategoryId: row.eventCategoryId, eventId: row.eventId },
      });
    });

    if (paidOnline) {
      // The slot returns either way; only the money is conditional (R9).
      await payments.refundForRegistration({
        registrationId: row.id,
        reason: termsChanged
          ? 'event_changed'
          : lateHalf
            ? 'player_cancelled_late_half'
            : refundable
              ? 'player_cancelled'
              : 'player_cancelled_after_cutoff',
        refundAmount: refundable,
        ...(termsChanged ? { includePlatformFee: true } : {}),
        ...(lateHalf ? { fractionBps: FLEXIBLE_LATE_REFUND_BPS } : {}),
      });
    }

    await events.refreshCategoryFullness(row.eventCategoryId).catch((err: unknown) => {
      logger.error({ err, registrationId }, 'category fullness refresh failed after cancel');
    });

    return byId(row.id);
  }

  /**
   * The one check-in path (R10, R11, R24). Self check-in, a staff tap on the
   * entry list and a QR scan (R13) all end here, so the window and the
   * transition guard cannot differ between them.
   *
   * R24 — players are checked in one by one, because a pair may arrive at
   * different times. `who` is the players to check in (`all` = everyone on the
   * entry). The entry moves to `checked_in` with the first of them; a player
   * already in is left alone, with their ORIGINAL time — so a second scan is
   * never a second check-in.
   */
  async function performCheckIn(
    byUserId: string,
    row: RegistrationRow,
    method: 'self' | 'staff' | 'qr',
    who: 'all' | string[] = 'all',
  ): Promise<Registration> {
    const status = row.status as RegistrationStatus;
    if (status !== 'checked_in') assertTransition(status, 'checked_in');

    const roster = await rosterOf(row);
    const targets = who === 'all' ? roster : [...new Set(who)];
    if (targets.some((id) => !roster.includes(id))) {
      throw new UserError(RegistrationCode.NOT_ON_TEAM, 'That player is not on this entry.');
    }
    const already = new Set((await repo.checkinsFor([row.id])).map((c) => c.userId));
    if (status === 'checked_in' && targets.every((id) => already.has(id))) return hydrate(row);

    const event = await events.byId(row.eventId);
    // F13 — opens two hours before the start and stays open until the end
    // (at least two hours after the start), so day two of an event checks in too.
    const at = now().getTime();
    const opens = event.startsAt.getTime() - deps.checkinWindowMs;
    const closes = Math.max(event.endsAt?.getTime() ?? 0, event.startsAt.getTime() + deps.checkinWindowMs);
    if (at < opens || at > closes) {
      throw new UserError(
        RegistrationCode.CHECKIN_WINDOW_CLOSED,
        'Check-in opens two hours before the event starts and closes when it ends.',
      );
    }

    await db.$transaction(async (tx) => {
      if (status !== 'checked_in') {
        const moved = await repo.transition(tx, row.id, status, 'checked_in', {
          checkedInAt: now(),
          checkedInBy: byUserId,
        });
        // Somebody else checked the entry in a moment ago; the players below
        // are still added, idempotently.
        if (!moved) {
          const fresh = await tx.registration.findUnique({ where: { id: row.id }, select: { status: true } });
          if (fresh?.status !== 'checked_in') return;
        }
      }
      const added = await repo.insertCheckins(tx, {
        registrationId: row.id,
        userIds: targets,
        by: byUserId,
        method,
        at: now(),
      });
      if (added.length === 0) return;
      for (const userId of added) {
        await record(tx, { registrationId: row.id, kind: 'checked_in', actorUserId: byUserId, subjectUserId: userId, data: { method } });
      }
      await outboxWrite(tx, {
        topic: 'registration.checked_in',
        payload: {
          registrationId: row.id,
          eventId: row.eventId,
          eventCategoryId: row.eventCategoryId,
          checkedInBy: byUserId,
          method,
          userIds: added,
        },
      });
    });
    return byId(row.id);
  }

  /**
   * R10 — within the configured window either side of the start, confirmed
   * only. A participant checks THEMSELVES in; staff on the event may check in
   * anybody from the entry list (everyone on the entry, or `userIds`).
   */
  async function checkIn(
    actor: Actor,
    registrationId: string,
    at?: { lat: number; lng: number } | null,
    userIds?: string[] | null,
  ): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    // Staff first: a player who also helps run the event checks people in at the desk.
    const staff = await events.assertStaff(actor, row.eventId, DESK_ROLES).then(() => true, () => false);
    if (staff) return performCheckIn(actor.userId, row, 'staff', userIds && userIds.length > 0 ? userIds : 'all');
    if (!(await isParticipant(actor, row))) throw forbidden();
    // F13 — checking yourself in means being there. When the event has a
    // known place, the phone's location must be within a kilometre of it.
    const place = events.locationOf ? await events.locationOf(row.eventId) : null;
    if (place) {
      if (!at) {
        throw new UserError(
          RegistrationCode.CHECKIN_LOCATION_REQUIRED,
          'Turn on location to check in, or ask the organizer to check you in.',
        );
      }
      if (metresBetween(place, at) > SELF_CHECKIN_RADIUS_M) {
        throw new UserError(
          RegistrationCode.CHECKIN_TOO_FAR,
          'You need to be at the venue to check in. Ask the organizer if you are there.',
        );
      }
    }
    // R24 — your own arrival, not your partner's.
    return performCheckIn(actor.userId, row, 'self', [actor.userId]);
  }

  /**
   * R13 — the QR payload for a confirmed entry. Null for anybody who is not on
   * the team, and for an entry that is not (or no longer) a ticket.
   */
  async function checkInToken(actor: Actor, registrationId: string): Promise<string | null> {
    const row = await repo.byId(registrationId);
    return row ? checkInTokenFor(actor, row) : null;
  }

  /** `checkInToken` for an entry already read. */
  async function checkInTokenFor(actor: Actor, row: RegistrationRow): Promise<string | null> {
    if (row.status !== 'confirmed' && row.status !== 'checked_in') return null;
    if (!(await isParticipant(actor, row))) return null;
    return signCheckinToken(deps.checkinKeys, row.id);
  }

  /** R13 — the entry a scanned QR names, for staff. Anything else reads as invalid. */
  async function entryForToken(actor: Actor, token: string): Promise<RegistrationRow> {
    const registrationId = verifyCheckinToken(deps.checkinKeys, token.trim());
    if (!registrationId) throw invalidCheckinToken();
    const row = await repo.byId(registrationId);
    if (!row) throw invalidCheckinToken();
    // Staff first: somebody without a grant learns nothing about the entry.
    await events.assertStaff(actor, row.eventId, DESK_ROLES);
    if (row.status !== 'confirmed' && row.status !== 'checked_in') throw invalidCheckinToken();
    return row;
  }

  /**
   * R13 — a staff scan that checks in everyone on the entry. Kept for offline
   * replay and older staff apps; the desk now looks the entry up first
   * (`checkInLookup`) and checks players in one by one (R24).
   */
  async function checkInByToken(actor: Actor, token: string): Promise<Registration> {
    const row = await entryForToken(actor, token);
    return performCheckIn(actor.userId, row, 'qr', 'all');
  }

  /** R24 — a scan that only reads: the entry, its players and who is already in. */
  async function checkInLookup(actor: Actor, token: string): Promise<Registration> {
    return hydrate(await entryForToken(actor, token));
  }

  /** R24 — staff check in some (or all) of an entry's players. Idempotent. */
  async function checkInMembers(
    actor: Actor,
    registrationId: string,
    userIds: string[] | null,
    opts: { method?: 'staff' | 'qr' } = {},
  ): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    await events.assertStaff(actor, row.eventId, DESK_ROLES);
    if (row.status !== 'confirmed' && row.status !== 'checked_in') throw invalidCheckinToken();
    return performCheckIn(actor.userId, row, opts.method ?? 'staff', userIds && userIds.length > 0 ? userIds : 'all');
  }

  /**
   * R13 — what a staff device downloads to scan offline: token HASHES, names
   * and category. Check-ins made offline are replayed through
   * `checkInByToken`, which is idempotent.
   */
  async function checkInRoster(actor: Actor, eventId: string): Promise<RosterEntry[]> {
    await events.assertStaff(actor, eventId, DESK_ROLES);
    const rows = await repo.rosterFor(eventId);

    const [members, checkins] = await Promise.all([
      repo.membersOfTeams(rows.flatMap((r) => (r.teamId ? [r.teamId] : []))),
      repo.checkinsFor(rows.map((r) => r.id)),
    ]);
    const userIds = new Set(rows.map((r) => r.captainUserId));
    for (const m of members) userIds.add(m.userId);
    const names = new Map(
      (await users.byIds([...userIds])).map((u) => [u.id, u.displayName] as const),
    );
    const arrived = new Map(checkins.map((c) => [`${c.registrationId}:${c.userId}`, c.checkedInAt] as const));

    return rows.map((r) => {
      const teamIds = r.teamId ? members.filter((m) => m.teamId === r.teamId).map((m) => m.userId) : [];
      const playerIds = teamIds.length > 0 ? teamIds : [r.captainUserId];
      return {
        registrationId: r.id,
        eventCategoryId: r.eventCategoryId,
        status: r.status as RegistrationStatus,
        tokenHash: checkinTokenHash(signCheckinToken(deps.checkinKeys, r.id)),
        players: playerIds.map((userId) => ({
          userId,
          displayName: names.get(userId) ?? '',
          checkedInAt: arrived.get(`${r.id}:${userId}`) ?? null,
        })),
        checkedInAt: r.checkedInAt,
      };
    });
  }

  // --- R24, R26, R27: what the team card shows ----------------------------------

  /** Everyone on each entry with their check-in, in one read per table. */
  async function membersFor(rows: Registration[]): Promise<Map<string, RegistrationMember[]>> {
    const teamIds = [...new Set(rows.flatMap((r) => (r.teamId ? [r.teamId] : [])))];
    const [members, checkins] = await Promise.all([
      repo.membersOfTeams(teamIds),
      repo.checkinsFor(rows.map((r) => r.id)),
    ]);
    const arrived = new Map(checkins.map((c) => [`${c.registrationId}:${c.userId}`, c.checkedInAt] as const));
    const out = new Map<string, RegistrationMember[]>();
    for (const r of rows) {
      const team = r.teamId ? members.filter((m) => m.teamId === r.teamId) : [];
      const list = team.length > 0 ? team : [{ userId: r.captainUserId, isCaptain: true }];
      out.set(
        r.id,
        list.map((m) => ({
          userId: m.userId,
          isCaptain: m.isCaptain,
          checkedInAt: arrived.get(`${r.id}:${m.userId}`) ?? null,
        })),
      );
    }
    return out;
  }

  /** R24 — nobody, some, or everyone on the entry has arrived. */
  function checkInStateOf(r: Registration, members: RegistrationMember[]): CheckInState {
    const inCount = members.filter((m) => m.checkedInAt).length;
    if (inCount === 0) return r.status === 'checked_in' ? 'all' : 'none';
    return inCount >= members.length ? 'all' : 'partial';
  }

  /**
   * R27 — the money's state, apart from the entry's: an entry paid for can
   * still be waiting for its teammate. `refundState` is the latest refund's
   * status from payments, when there is one.
   */
  function paymentStatusOf(r: Registration, refundState: string | null): PaymentStatus {
    if (r.paymentMode === 'comp' || (r.amountPaise === 0n && r.paymentMode === 'online')) return 'free';
    switch (r.status) {
      case 'draft':
      case 'awaiting_partner':
      case 'waitlisted':
        return 'not_due';
      case 'payment_pending':
        return 'pending';
      case 'payment_failed':
        return 'failed';
      case 'expired':
        return 'not_due';
      case 'confirmed':
      case 'checked_in':
        return r.paymentMode === 'offline' ? 'offline' : 'paid';
      case 'refunded':
      case 'withdrawn':
        if (r.paymentMode !== 'online') return r.paymentMode === 'offline' ? 'offline' : 'free';
        if (refundState === 'processed') return 'refunded';
        if (refundState === 'pending' || refundState === 'failed') return 'refund_pending';
        return r.status === 'refunded' ? 'refund_pending' : 'paid';
      default:
        return 'not_due';
    }
  }

  async function refundStatesFor(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0 || !payments.refundStates) return new Map();
    return payments.refundStates(ids);
  }

  /** R26 — the entry's history. The captain, the team and the event's staff may read it. */
  async function historyOf(actor: Actor, registrationId: string, opts: { platformStaff?: boolean } = {}): Promise<HistoryEntry[]> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    if (!opts.platformStaff && !(await isParticipant(actor, row))) {
      await events.assertStaff(actor, row.eventId, DESK_ROLES);
    }
    return (await repo.historyFor(registrationId)).map((h) => ({ ...h, data: h.data ?? null }));
  }

  /** R11 — the dashboard numbers for an event's team draws. */
  async function teamStats(actor: Actor, eventId: string, opts: { platformStaff?: boolean } = {}): Promise<TeamStats> {
    if (!opts.platformStaff) await events.assertStaff(actor, eventId, DESK_ROLES);
    const rows = await repo.teamStatsRows(eventId);
    const refunds = await refundStatesFor(rows.filter((r) => r.status === 'refunded' || r.status === 'withdrawn').map((r) => r.id));
    const categoryIds = [...new Set(rows.map((r) => r.eventCategoryId))];
    const categories = await Promise.all(categoryIds.map((id) => events.categoryById(id)));
    const minById = new Map(categories.map((c) => [c.id, minTeam(c)] as const));
    const seated = rows.filter((r) => r.status === 'confirmed' || r.status === 'checked_in');
    const size = (r: (typeof rows)[number]) => (r.teamId ? Math.max(r.members, 1) : 1);
    const stats: TeamStats = {
      teamSlots: 0,
      paidEntries: seated.filter((r) => r.paymentMode === 'online' && r.amountPaise > 0n).length,
      completeTeams: seated.filter((r) => size(r) >= (minById.get(r.eventCategoryId) ?? 1)).length,
      awaitingTeammates: seated.filter((r) => size(r) < (minById.get(r.eventCategoryId) ?? 1)).length,
      declinedInvites: rows.filter((r) => r.declined > 0 && r.status !== 'withdrawn' && r.status !== 'refunded').length,
      cancelled: rows.filter((r) => r.status === 'withdrawn' || r.status === 'refunded').length,
      refundPending: 0,
      refunded: 0,
      participants: seated.reduce((n, r) => n + size(r), 0),
      checkedInTeams: 0,
      partiallyCheckedInTeams: 0,
      checkedInParticipants: seated.reduce((n, r) => n + r.checkins, 0),
    };
    for (const c of categories) stats.teamSlots += c.capacity ?? 0;
    for (const r of seated) {
      if (r.checkins === 0) continue;
      if (r.checkins >= size(r)) stats.checkedInTeams += 1;
      else stats.partiallyCheckedInTeams += 1;
    }
    for (const r of rows) {
      if (r.status !== 'refunded' && r.status !== 'withdrawn') continue;
      const s = refunds.get(r.id);
      if (s === 'processed') stats.refunded += 1;
      else if (s === 'pending' || s === 'failed' || (r.status === 'refunded' && r.paymentMode === 'online')) stats.refundPending += 1;
    }
    return stats;
  }

  // --- R25, R26: staff fix a team -------------------------------------------------

  /**
   * An owner or manager (or PL4Y staff) puts a player on a team directly, with
   * no invite — a teammate who has no phone with them, a mix-up at the desk.
   * With `replacesUserId` the player takes that teammate's place. The reason
   * is kept in the history with who made the change.
   */
  async function staffAddMember(
    actor: Actor,
    input: {
      registrationId: string;
      playerId?: string | null;
      email?: string | null;
      replacesUserId?: string | null;
      reason: string;
    },
    opts: { platformStaff?: boolean } = {},
  ): Promise<Registration> {
    const reason = needReason(input.reason);
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (!opts.platformStaff) await events.assertStaff(actor, row.eventId, ['owner', 'manager']);
    if (!SEATED_OR_PAYING.includes(row.status as RegistrationStatus) && row.status !== 'awaiting_partner' && row.status !== 'draft') {
      throw new UserError(RegistrationCode.TEAM_CHANGES_CLOSED, 'This entry is no longer live.');
    }
    const [category, event] = await Promise.all([events.categoryById(row.eventCategoryId), events.byId(row.eventId)]);
    if (category.teamSize < 2) throw forbidden();
    assertTeamChangesOpen(category, event, 'roster', { staff: true });

    let userId: string | null = null;
    if (input.playerId) {
      if (!UUID_RE.test(input.playerId)) throw notFound();
      userId = await profile.userIdForPlayer(input.playerId);
    } else if (input.email?.trim()) {
      userId = (await users.findByEmail(input.email.trim().toLowerCase()))?.id ?? null;
    }
    if (!userId) {
      throw new UserError(RegistrationCode.REGISTRATION_NOT_FOUND, 'Nobody on PL4Y matches that player.');
    }
    if (await repo.playerHasLiveEntry(userId, row.eventCategoryId, LIVE_STATUSES)) {
      throw new UserError(RegistrationCode.PARTNER_ALREADY_ENTERED, 'That player is already entered in this draw.');
    }
    const members = row.teamId ? await repo.teamMembers(row.teamId) : [];
    if (input.replacesUserId) await assertReplaceable(row, category, members, input.replacesUserId, { staff: true });

    const newUser = userId;
    await db.$transaction(async (tx) => {
      await repo.lockCategory(tx, row.eventCategoryId);
      if (await repo.playerHasLiveEntry(newUser, row.eventCategoryId, LIVE_STATUSES, tx)) {
        throw new UserError(RegistrationCode.PARTNER_ALREADY_ENTERED, 'That player is already entered in this draw.');
      }
      const current = (await tx.registration.findUnique({ where: { id: row.id } })) ?? row;
      let teamId = current.teamId;
      if (!teamId) {
        teamId = newId();
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: row.eventCategoryId,
          name: null,
          members: [{ userId: row.captainUserId, isCaptain: true }],
        });
        await repo.attachTeam(tx, row.id, teamId);
      }
      if (input.replacesUserId) await repo.removeTeamMember(tx, teamId, input.replacesUserId);
      if ((await repo.countTeamMembers(tx, teamId)) >= maxTeam(category)) {
        throw new UserError(RegistrationCode.TEAM_COMPLETE, 'This team is already complete.');
      }
      await repo.addTeamMember(tx, teamId, newUser);
      // An open invite for the same spot is no longer needed.
      for (const i of await repo.invitesFor(row.id)) {
        if (i.status === 'pending' && (maxTeam(category) === 2 || (input.replacesUserId && i.replacesUserId === input.replacesUserId))) {
          await repo.settleInvite(tx, i.id, 'revoked');
        }
      }
      const count = await repo.countTeamMembers(tx, teamId);
      await record(tx, {
        registrationId: row.id,
        kind: input.replacesUserId ? 'member_replaced' : 'member_added',
        actorUserId: actor.userId,
        subjectUserId: newUser,
        reason,
        data: { replacedUserId: input.replacesUserId ?? null, byStaff: true },
      });
      await outboxWrite(tx, {
        topic: 'teammate.added',
        payload: { registrationId: row.id, teammateUserId: newUser, captainUserId: row.captainUserId, byStaff: true },
      });
      const from = current.status as RegistrationStatus;
      if ((from === 'draft' || from === 'awaiting_partner') && count >= minTeam(category)) {
        await seatOrQueue(tx, current, from, { queueIfFull: category.waitlistEnabled !== false, teamId });
      }
    });
    return byId(row.id);
  }

  /** Staff take a player off a team (never the captain). The entry and its payment stay. */
  async function staffRemoveMember(
    actor: Actor,
    input: { registrationId: string; userId: string; reason: string },
    opts: { platformStaff?: boolean } = {},
  ): Promise<Registration> {
    const reason = needReason(input.reason);
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (!opts.platformStaff) await events.assertStaff(actor, row.eventId, ['owner', 'manager']);
    const [category, event] = await Promise.all([events.categoryById(row.eventCategoryId), events.byId(row.eventId)]);
    assertTeamChangesOpen(category, event, 'roster', { staff: true });
    const members = row.teamId ? await repo.teamMembers(row.teamId) : [];
    await assertReplaceable(row, category, members, input.userId, { staff: true });
    await db.$transaction(async (tx) => {
      if (!row.teamId || !(await repo.removeTeamMember(tx, row.teamId, input.userId))) return;
      await record(tx, {
        registrationId: row.id,
        kind: 'member_removed',
        actorUserId: actor.userId,
        subjectUserId: input.userId,
        reason,
        data: { byStaff: true },
      });
    });
    return byId(row.id);
  }

  /**
   * R25 — the captain takes a teammate who can no longer play off the team,
   * so the spot opens for somebody else. Same window and limits as a
   * replacement; the entry, its payment and its QR stay.
   */
  async function removeTeammate(actor: Actor, input: { registrationId: string; userId: string }): Promise<Registration> {
    const row = await repo.byId(input.registrationId);
    if (!row) throw notFound();
    if (row.captainUserId !== actor.userId) throw forbidden();
    const [category, event] = await Promise.all([events.categoryById(row.eventCategoryId), events.byId(row.eventId)]);
    assertTeamChangesOpen(category, event, 'roster');
    // Only after payment: before it, the team is still forming and the seat
    // was taken because it was whole (R2).
    if (!SEATED_OR_PAYING.includes(row.status as RegistrationStatus) || !paysFirst(category)) {
      throw new UserError(RegistrationCode.REPLACEMENTS_OFF, 'Use "Replace" to swap this teammate for someone else.');
    }
    const members = row.teamId ? await repo.teamMembers(row.teamId) : [];
    await assertReplaceable(row, category, members, input.userId);
    await db.$transaction(async (tx) => {
      if (!row.teamId || !(await repo.removeTeamMember(tx, row.teamId, input.userId))) return;
      await record(tx, { registrationId: row.id, kind: 'member_removed', actorUserId: actor.userId, subjectUserId: input.userId });
    });
    return byId(row.id);
  }

  /**
   * identity R18 — a player with a confirmed place in an event that has not
   * finished cannot delete their account: their partner and the draw depend on
   * it. Pending and waitlisted entries do not block; they simply lapse.
   */
  async function hasUpcomingConfirmedEntry(userId: string): Promise<boolean> {
    const rows = (await repo.forUser(userId)).filter(
      (r) => r.status === 'confirmed' || r.status === 'checked_in',
    );
    for (const row of rows) {
      const event = await events.byId(row.eventId);
      if (event.status === 'published' || event.status === 'live') return true;
    }
    return false;
  }

  // --- reads -----------------------------------------------------------------

  async function listForUser(userId: string): Promise<Registration[]> {
    const rows = await repo.forUser(userId);
    return hydrateMany(rows);
  }

  /**
   * home R4/R6 — seated entries only, and whether the user ever entered at all.
   * Speed: history is counted, not hydrated (a hold read per row), so an
   * account with a long record opens Home as fast as a new one.
   */
  async function committedForUser(userId: string): Promise<{ committed: Registration[]; everEntered: boolean }> {
    const rows = await repo.forUser(userId);
    const seated = rows.filter((r) => r.status === 'confirmed' || r.status === 'checked_in');
    return { committed: await hydrateMany(seated), everEntered: rows.length > 0 };
  }

  /** Organizer view. Gated on the event's staff grant, freshly read. */
  async function listForEvent(
    actor: Actor,
    eventId: string,
    filter: { status?: RegistrationStatus[]; categoryId?: string | null },
    page: { first: number; after?: string | null },
    /** F9 — PL4Y staff read any event's entries (the caller checked the platform role). */
    opts: { platformStaff?: boolean } = {},
  ): Promise<Page<Registration>> {
    // Scorers work the check-in desk, so they read the list too.
    if (!opts.platformStaff) await events.assertStaff(actor, eventId, DESK_ROLES);
    const first = Math.min(Math.max(page.first, 1), 50);
    const rows = await repo.forEvent(eventId, filter, {
      after: page.after ? decodeCursor(page.after) : null,
      limit: first + 1,
    });
    const nodes = await hydrateMany(rows.slice(0, first));
    const last = nodes.at(-1);
    return {
      nodes,
      hasNextPage: rows.length > first,
      endCursor: last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /** `tournament` calls this to build a draw. */
  async function confirmedForCategory(categoryId: string): Promise<Registration[]> {
    const rows = await repo.confirmedForCategory(categoryId);
    return hydrateMany(rows);
  }

  /**
   * `registrations.seed` is filled in by `tournament` at draw time — through
   * here, because this module owns the table (conventions.md §1).
   *
   * It takes the caller's transaction so that a seeding and the bracket it
   * describes commit together (tournament R6). Seeding an entry that is not
   * in this draw is not possible: the ids come from `confirmedForCategory`.
   */
  async function applySeeds(
    tx: Tx,
    seeds: { registrationId: string; seed: number }[],
  ): Promise<void> {
    for (const { registrationId, seed } of seeds) {
      await tx.registration.update({ where: { id: registrationId }, data: { seed } });
    }
  }

  /** N14 — a team's own name ("Thunder FC"), when it was given one. */
  async function teamNameFor(registrationId: string): Promise<string | null> {
    const row = await repo.byId(registrationId);
    if (!row?.teamId) return null;
    return (await db.team.findUnique({ where: { id: row.teamId }, select: { name: true } }))?.name ?? null;
  }

  async function teamFor(registrationId: string): Promise<{ userId: string; isCaptain: boolean }[]> {
    const row = await repo.byId(registrationId);
    if (!row?.teamId) return [];
    return repo.teamMembers(row.teamId);
  }

  /** chat R2 — the two users are partners on an entry that is still live. */
  async function areTeammates(userA: string, userB: string): Promise<boolean> {
    return repo.shareTeam(userA, userB, LIVE_STATUSES);
  }

  async function invitesFor(actor: Actor, registrationId: string): Promise<Invite[]> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    await assertParticipant(actor, row);
    return (await repo.invitesFor(registrationId)).map(toInvite);
  }

  /** R11 — the invites on an entry, for the event's staff (the caller checked the grant). */
  async function invitesForStaff(registrationId: string): Promise<Invite[]> {
    return (await repo.invitesFor(registrationId)).map(toInvite);
  }

  // --- gap #22: the seat stays held while the player pays --------------------

  /**
   * Called by payments when it opens an order. Moves only a live hold, only
   * forward; an expired hold is not revived (its seat may be someone else's).
   * The release job already queued for the old time finds the hold unexpired
   * and leaves it; the stale-hold sweep releases it at the new time.
   */
  async function extendHold(registrationId: string, minutes: number): Promise<Date | null> {
    return repo.extendHold(registrationId, new Date(now().getTime() + minutes * 60_000));
  }

  // --- gap #2, #3: a draw that closed or was cancelled ------------------------

  /** Moves one entry and lets go of anything it was holding. */
  async function closeOutEntry(
    tx: Tx,
    row: RegistrationRow,
    to: RegistrationStatus,
    reason: string,
  ): Promise<boolean> {
    const from = row.status as RegistrationStatus;
    if (!canTransition(from, to)) return false;
    const moved = await repo.transition(tx, row.id, from, to, { withdrawnReason: reason });
    if (!moved) return false;
    const hold = await repo.liveHoldFor(tx, row.id);
    if (hold) await repo.releaseHold(tx, hold.id);
    await repo.removeFromWaitlist(tx, row.id);
    for (const invite of await repo.invitesFor(row.id)) {
      if (invite.status === 'pending') await repo.settleInvite(tx, invite.id, 'expired');
    }
    return true;
  }

  /**
   * gap #2 — the organizer cancelled the event, or the draw missed its
   * minimum. Every confirmed entry becomes `refunded` (or `withdrawn` if no
   * money went through us), so nobody is still "in" an event that is not
   * happening. Every unfinished entry expires, so a payment that lands later
   * cannot confirm into it (gap #3). The money itself is payments' job: it
   * refunds every captured payment on the draw, whatever the entry's status.
   *
   * Idempotent: entries already moved are skipped.
   */
  async function closeOutCancelled(categoryId: string): Promise<number> {
    const rows = await repo.inCategoryWithStatus(categoryId, [
      'confirmed',
      'checked_in',
      'draft',
      'awaiting_partner',
      'waitlisted',
      'payment_pending',
      'payment_failed',
    ]);
    let moved = 0;
    for (const row of rows) {
      const seated = row.status === 'confirmed' || row.status === 'checked_in';
      const paidOnline = row.paymentMode === 'online' && row.amountPaise > 0n;
      const to: RegistrationStatus = seated ? (paidOnline ? 'refunded' : 'withdrawn') : 'expired';
      const done = await db.$transaction((tx) => closeOutEntry(tx, row, to, 'organizer_cancelled'));
      if (done) moved += 1;
    }
    return moved;
  }

  /**
   * Registration closed and the draw goes ahead. Nobody still queued, and no
   * doubles team still waiting for its partner, can take a seat any more
   * (acquireHold refuses a closed draw), so they are told now rather than
   * left waiting forever. Entries mid-payment keep their seat hold and may
   * still finish.
   */
  async function closeOutClosed(categoryId: string): Promise<number> {
    const rows = await repo.inCategoryWithStatus(categoryId, ['draft', 'awaiting_partner', 'waitlisted']);
    let moved = 0;
    for (const row of rows) {
      const done = await db.$transaction(async (tx) => {
        const ok = await closeOutEntry(tx, row, 'expired', 'registration_closed');
        if (ok && row.status !== 'draft') {
          await outboxWrite(tx, {
            topic: 'registration.expired',
            payload: { registrationId: row.id, captainUserId: row.captainUserId, reason: 'registration_closed' },
          });
        }
        return ok;
      });
      if (done) moved += 1;
    }
    return moved;
  }

  // --- gap #33: organizer tools -------------------------------------------------

  /**
   * An organizer takes one entry out of a draw before it is made — an injury,
   * a no-show, a mistake. A player who paid online gets back everything they
   * paid, platform fee included, because it is the organizer's decision (F2:
   * whatever `refund` says). `refund` is kept for older clients.
   */
  async function removeEntry(
    actor: Actor,
    registrationId: string,
    _opts: { refund: boolean },
  ): Promise<Registration> {
    const row = await repo.byId(registrationId);
    if (!row) throw notFound();
    await events.assertStaff(actor, row.eventId);
    const category = await events.categoryById(row.eventCategoryId);
    if (['drawn', 'completed'].includes(category.status)) {
      throw new UserError(
        RegistrationCode.DRAW_ALREADY_MADE,
        'The draw is already made. Record a walkover for this player’s match instead.',
      );
    }
    const status = row.status as RegistrationStatus;
    if (status === 'refunded' || status === 'withdrawn' || status === 'expired') return hydrate(row);

    const seated = status === 'confirmed' || status === 'checked_in';
    const paidOnline = seated && row.paymentMode === 'online' && row.amountPaise > 0n;
    // F2 — a host who removes a player who paid PL4Y gives the money back,
    // always. Keeping a fee is never the host's call (staffRefundRegistration
    // is PL4Y's); `refund` only decides cash and comp entries' records.
    const to: RegistrationStatus = seated ? (paidOnline ? 'refunded' : 'withdrawn') : 'expired';
    await db.$transaction(async (tx) => {
      const ok = await closeOutEntry(tx, row, to, 'removed_by_organizer');
      if (!ok) return;
      await outboxWrite(tx, {
        topic: 'registration.cancelled',
        payload: {
          registrationId: row.id,
          captainUserId: row.captainUserId,
          refunded: to === 'refunded',
          reason: 'removed_by_organizer',
        },
      });
      await outboxWrite(tx, {
        topic: 'capacity.changed',
        payload: { eventCategoryId: row.eventCategoryId, eventId: row.eventId },
      });
    });
    if (to === 'refunded') {
      await payments.refundForRegistration({
        registrationId: row.id,
        reason: 'removed_by_organizer',
        refundAmount: true,
        includePlatformFee: true,
      });
    }
    await events.refreshCategoryFullness(row.eventCategoryId).catch((err: unknown) => {
      logger.error({ err, registrationId }, 'category fullness refresh failed after removal');
    });
    return byId(row.id);
  }

  /**
   * An organizer seats a walk-in who paid cash (`offline`) or a guest who
   * pays nothing (`comp`). The seat goes through the same capacity query as
   * every other entry. No money passes through PL4Y, so none ever comes back
   * through it (R9). Singles draws only for now: a team needs its partners
   * to have accepted.
   */
  /**
   * F20 — who a walk-in is: an existing account by email, or a guest by name
   * (no account needed; a guest can never sign in and is never emailed).
   */
  async function walkInUser(person: { email?: string | null; name?: string | null }): Promise<string> {
    const email = person.email?.trim().toLowerCase() ?? '';
    if (email) {
      const player = await users.findByEmail(email);
      if (!player) {
        throw new UserError(
          RegistrationCode.REGISTRATION_NOT_FOUND,
          'Nobody has a PL4Y account with that email. Add them by name instead.',
        );
      }
      return player.id;
    }
    const name = person.name?.trim() ?? '';
    if (name.length < 2 || name.length > 60) {
      throw new UserError(RegistrationCode.WALK_IN_INCOMPLETE, 'Give the player’s email, or their name (2 to 60 letters).');
    }
    if (!users.createGuest) throw new Error('registration: no guest port wired');
    return (await users.createGuest(name)).id;
  }

  async function addOfflineEntry(
    actor: Actor,
    input: {
      eventCategoryId: string;
      email?: string | null;
      guestName?: string | null;
      /** F20 — the second player of a doubles walk-in. */
      partnerEmail?: string | null;
      partnerName?: string | null;
      /** N14 — a team walk-in (5-a-side, cricket…): its name, and any teammates known at the desk. */
      teamName?: string | null;
      /** Each an account email, or just a name. The captain is `email`/`guestName`. */
      teammates?: string[] | null;
      mode: 'offline' | 'comp';
    },
  ): Promise<Registration> {
    const category = await events.categoryById(input.eventCategoryId);
    await events.assertStaff(actor, category.eventId);
    const team = category.teamSize > 2;
    const teamName = input.teamName?.trim() || null;
    if (teamName && teamName.length > 40) {
      throw new UserError(RegistrationCode.WALK_IN_INCOMPLETE, 'A team name is 40 letters at most.');
    }
    const teammates = (input.teammates ?? []).map((t) => t.trim()).filter(Boolean);
    if (team && teammates.length > category.teamSize - 1) {
      throw new UserError(
        RegistrationCode.WALK_IN_INCOMPLETE,
        `A team here has ${category.teamSize} players: the captain and up to ${category.teamSize - 1} more.`,
      );
    }
    // F20 — walk-ins arrive on the morning, after registration has closed and
    // before the draw is made. Once the draw exists, it is too late.
    if (!['open', 'full', 'closed'].includes(category.status)) {
      throw new UserError(RegistrationCode.DRAW_ALREADY_MADE, 'The draw is already made, so no more entries can join.');
    }
    const doubles = category.teamSize === 2;
    if (doubles && !input.partnerEmail?.trim() && !input.partnerName?.trim()) {
      throw new UserError(RegistrationCode.WALK_IN_INCOMPLETE, 'A doubles walk-in needs both players.');
    }
    const userId = await walkInUser({ email: input.email, name: input.guestName });
    const partnerId = doubles ? await walkInUser({ email: input.partnerEmail, name: input.partnerName }) : null;
    if (partnerId === userId) {
      throw new UserError(RegistrationCode.WALK_IN_INCOMPLETE, 'The two players must be different people.');
    }
    // N14 — a team's other players: an email finds their account, anything else is a guest by name.
    const otherIds: string[] = [];
    if (team) {
      for (const t of teammates) {
        otherIds.push(await walkInUser(t.includes('@') ? { email: t } : { name: t }));
      }
      if (new Set([userId, ...otherIds]).size !== otherIds.length + 1) {
        throw new UserError(RegistrationCode.WALK_IN_INCOMPLETE, 'Each player on the team must be a different person.');
      }
    }
    for (const id of [userId, partnerId, ...otherIds]) {
      if (id && (await repo.playerHasLiveEntry(id, category.id, LIVE_STATUSES))) {
        throw new UserError(RegistrationCode.ALREADY_REGISTERED, 'That player is already entered in this draw.');
      }
    }
    const quote = await events.priceQuote(category.id);
    const id = newId();
    await db.$transaction(async (tx) => {
      await repo.lockCategory(tx, category.id);
      let teamId: string | null = null;
      if (team) {
        teamId = newId();
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: category.id,
          name: teamName,
          members: [{ userId, isCaptain: true }, ...otherIds.map((id) => ({ userId: id, isCaptain: false }))],
        });
      } else if (partnerId) {
        teamId = newId();
        await repo.createTeam(tx, {
          id: teamId,
          eventCategoryId: category.id,
          name: null,
          members: [
            { userId, isCaptain: true },
            { userId: partnerId, isCaptain: false },
          ],
        });
      }
      const row = await repo.insert(tx, {
        id,
        eventId: category.eventId,
        eventCategoryId: category.id,
        sportId: category.sportId,
        captainUserId: userId,
        teamId,
        status: 'draft',
        seed: null,
        // What they paid at the desk (nothing for a comp), for the organizer's records.
        amountPaise: input.mode === 'comp' ? 0n : quote.totalPaise,
        paymentMode: input.mode,
      });
      const hold = await tryHold(tx, row, deps.holdTtlSeconds, true);
      if (!hold) throw categoryFull();
      assertTransition('draft', 'payment_pending');
      await repo.transition(tx, row.id, 'draft', 'payment_pending');
      await confirmFreeInTx(tx, row, hold.id);
    });
    await events.refreshCategoryFullness(category.id).catch((err: unknown) => {
      logger.error({ err, categoryId: category.id }, 'category fullness refresh failed after offline entry');
    });
    return byId(id);
  }

  /** The EntriesPort `events` reads for R5. Seats, not rows. */
  const entries = {
    confirmedCount: (categoryId: string) => repo.countConfirmed(categoryId),
    liveHoldCount: (categoryId: string) => repo.countLiveHoldSeats(categoryId),
    /** Speed — both counts for many categories at once. */
    seatCounts: (categoryIds: string[]) => repo.countSeatsMany(categoryIds),
    isSeatedEntrant: async (eventId: string, userId: string) =>
      (await repo.forUser(userId)).some(
        (r) => r.eventId === eventId && (r.status === 'confirmed' || r.status === 'checked_in'),
      ),
    /** F3 — entered at all: seated, or seated once and since withdrawn or refunded. */
    participated: async (eventId: string, userId: string) =>
      (await repo.forUser(userId)).some(
        (r) => r.eventId === eventId && ['confirmed', 'checked_in', 'withdrawn', 'refunded'].includes(r.status),
      ),
    /** F3 — players checked in at this event. */
    checkInCount: (eventId: string) => db.registration.count({ where: { eventId, status: 'checked_in' } }),
    /** F19 — any row at all in this category. */
    anyIn: async (categoryId: string) =>
      (await db.registration.count({ where: { eventCategoryId: categoryId } })) > 0,
  };

  /**
   * Doubles entries that reach `awaiting_partner` and never reach
   * `payment_pending`. The doc asks for this metric by name: if it degrades
   * against singles, the answer is to revisit ADR 0002, not to blame the funnel.
   */
  async function partnerFunnel(eventId?: string): Promise<{
    awaitingPartner: number;
    expiredAwaitingPartner: number;
    reachedPayment: number;
  }> {
    const where = eventId ? { eventId } : {};
    const [awaitingPartner, expiredAwaitingPartner, reachedPayment] = await Promise.all([
      db.registration.count({ where: { ...where, status: 'awaiting_partner' } }),
      db.registration.count({
        where: { ...where, status: 'expired', teamId: null, invites: { some: { status: 'expired' } } },
      }),
      db.registration.count({
        where: {
          ...where,
          teamId: { not: null },
          status: { in: ['payment_pending', 'confirmed', 'checked_in'] },
        },
      }),
    ]);
    return { awaitingPartner, expiredAwaitingPartner, reachedPayment };
  }

  return {
    statsForEvents: (eventIds: string[]) => repo.statsForEvents(eventIds),
    extendHold,
    closeOutCancelled,
    closeOutClosed,
    removeEntry,
    addOfflineEntry,
    begin,
    joinWaitlist,
    leaveWaitlist,
    promoteWaitlist,
    invitePartner,
    acceptInvite,
    addTeammate,
    declineInvite,
    expireInvite,
    confirmFromPayment,
    failFromPayment,
    expireHold,
    sweepStaleHolds,
    sweepStaleInvites,
    cancel,
    checkIn,
    checkInToken,
    checkInTokenFor,
    findByIds,
    checkInByToken,
    checkInRoster,
    byId,
    findById,
    listForEvent,
    listForUser,
    committedForUser,
    confirmedForCategory,
    applySeeds,
    teamNameFor,
    teamFor,
    areTeammates,
    invitesFor,
    entries,
    partnerFunnel,
    hasUpcomingConfirmedEntry,
    createInviteLink,
    invitesForStaff,
    resendInvite,
    revokeInvite,
    inviteDetails,
    myPendingInvites,
    setTeamName,
    checkInLookup,
    checkInMembers,
    membersFor,
    checkInStateOf,
    paymentStatusOf,
    refundStatesFor,
    historyOf,
    teamStats,
    staffAddMember,
    staffRemoveMember,
    removeTeammate,
    teamSizesFor: (c: Category) => ({ min: minTeam(c), max: maxTeam(c), paysFirst: paysFirst(c) }),
  };
}

export type RegistrationService = ReturnType<typeof createRegistrationService>;
