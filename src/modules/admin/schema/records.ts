/**
 * The portal's read-only records (PLAY_FRONTEND/apps/admin/docs/portal-gaps.md,
 * phase 2): what one player has done, casual games, an event's entries with
 * their money, and the platform's numbers.
 *
 * Portal sessions only (portal R2). Nothing here writes, so nothing here is
 * audited. Each list is capped; these are for answering "what happened to this
 * person", not for exports.
 */
import { Prisma } from '@prisma/client';
import DataLoader from 'dataloader';
import { builder, clampFirst } from '../../../graphql/builder.js';
import { requirePlatformStaff } from '../../../graphql/staff.js';
import { db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { notifications } from '../../notifications/index.js';
import { NotificationRef } from '../../notifications/schema/index.js';
import { AdminUserRef } from './index.js';

const paise = (v: bigint | null | undefined): number => Number(v ?? 0n);
const RECORD_ROWS = 50;

async function namesOf(userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
  return new Map(rows.map((u) => [u.id, u.displayName]));
}

async function sportNames(ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.sport.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(rows.map((s) => [s.id, s.name]));
}

async function venueNames(ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.venue.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
  return new Map(rows.map((v) => [v.id, v.name]));
}

async function joinedCounts(gameIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await db.gameParticipant.groupBy({
    by: ['gameId'],
    where: { gameId: { in: [...new Set(gameIds)] }, status: 'joined' },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.gameId, r._count._all]));
}

/**
 * Speed — one query per kind of lookup for a whole page of rows, not one per row.
 * Loaders live with the request (the context object) and die with it.
 */
const perRequest = new WeakMap<object, Map<string, DataLoader<string, unknown>>>();
function batched<V>(ctx: object, name: string, load: (ids: readonly string[]) => Promise<Map<string, V>>): DataLoader<string, V | null> {
  let mine = perRequest.get(ctx);
  if (!mine) perRequest.set(ctx, (mine = new Map()));
  let loader = mine.get(name) as DataLoader<string, V | null> | undefined;
  if (!loader) {
    loader = new DataLoader<string, V | null>(async (ids) => {
      const found = await load(ids);
      return ids.map((id) => found.get(id) ?? null);
    });
    mine.set(name, loader as DataLoader<string, unknown>);
  }
  return loader;
}

// --- a player's record (gap A6) ---------------------------------------------------------

interface UserSportRow {
  sportName: string;
  skillBand: string;
  rating: number | null;
  isProvisional: boolean;
  matchesPlayed: number;
}

const UserSportRef = builder.objectRef<UserSportRow>('AdminUserSport').implement({
  fields: (t) => ({
    sportName: t.exposeString('sportName'),
    skillBand: t.exposeString('skillBand'),
    rating: t.float({ nullable: true, description: 'Null until they have a rated match.', resolve: (s) => s.rating }),
    isProvisional: t.exposeBoolean('isProvisional'),
    matchesPlayed: t.exposeInt('matchesPlayed'),
  }),
});

interface UserEntryRow {
  id: string;
  status: string;
  paymentMode: string;
  amountPaise: number;
  createdAt: Date;
  eventTitle: string;
  eventSlug: string;
  drawName: string;
  /** False: they are a partner on someone else's entry. */
  paidByThem: boolean;
}

const UserEntryRef = builder.objectRef<UserEntryRow>('AdminUserEntry').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    status: t.exposeString('status'),
    paymentMode: t.exposeString('paymentMode'),
    amountPaise: t.exposeInt('amountPaise'),
    createdAt: t.field({ type: 'DateTime', resolve: (e) => e.createdAt }),
    eventTitle: t.exposeString('eventTitle'),
    eventSlug: t.exposeString('eventSlug'),
    drawName: t.exposeString('drawName'),
    paidByThem: t.exposeBoolean('paidByThem', { description: 'False: a partner on someone else’s entry.' }),
  }),
});

interface UserBookingRow {
  id: string;
  venueId: string;
  venueName: string;
  courtName: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  paymentMode: string;
  amountPaise: number;
}

const UserBookingRef = builder.objectRef<UserBookingRow>('AdminUserCourtBooking').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    venueId: t.exposeID('venueId'),
    venueName: t.exposeString('venueName'),
    courtName: t.exposeString('courtName'),
    startsAt: t.field({ type: 'DateTime', resolve: (b) => b.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (b) => b.endsAt }),
    status: t.exposeString('status'),
    paymentMode: t.exposeString('paymentMode'),
    amountPaise: t.exposeInt('amountPaise'),
  }),
});

interface UserPaymentRow {
  id: string;
  gatewayPaymentId: string;
  status: string;
  method: string | null;
  amountPaise: number;
  entryFeePaise: number;
  platformFeePaise: number;
  taxPaise: number;
  refundedPaise: number;
  capturedAt: Date | null;
  createdAt: Date;
  /** "Sunday Smash · Men’s doubles" or "Court at Smash Arena". */
  paidFor: string;
  eventSlug: string | null;
}

const UserPaymentRef = builder.objectRef<UserPaymentRow>('AdminUserPayment').implement({
  description: 'One payment as its receipt reads: what it was for, how it splits, what went back.',
  fields: (t) => ({
    id: t.exposeID('id'),
    gatewayPaymentId: t.exposeString('gatewayPaymentId', { description: 'The gateway’s own id, to find it in Razorpay.' }),
    status: t.exposeString('status'),
    method: t.string({ nullable: true, resolve: (p) => p.method }),
    amountPaise: t.exposeInt('amountPaise'),
    entryFeePaise: t.exposeInt('entryFeePaise', { description: 'The entry fee, or the court price.' }),
    platformFeePaise: t.exposeInt('platformFeePaise'),
    taxPaise: t.exposeInt('taxPaise'),
    refundedPaise: t.exposeInt('refundedPaise'),
    capturedAt: t.field({ type: 'DateTime', nullable: true, resolve: (p) => p.capturedAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (p) => p.createdAt }),
    paidFor: t.exposeString('paidFor'),
    eventSlug: t.string({ nullable: true, resolve: (p) => p.eventSlug }),
  }),
});

// --- casual games (gaps A1, A2) ---------------------------------------------------------

export interface GameRow {
  id: string;
  hostUserId: string;
  sportId: string;
  venueId: string | null;
  placeName: string | null;
  city: string;
  startsAt: Date;
  endsAt: Date;
  maxPlayers: number;
  skillBand: string | null;
  notes: string | null;
  status: string;
  cancelReason: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  /** Set on a player's record: how they took part. */
  role?: string;
}

export const GAME_SELECT = {
  id: true,
  hostUserId: true,
  sportId: true,
  venueId: true,
  placeName: true,
  city: true,
  startsAt: true,
  endsAt: true,
  maxPlayers: true,
  skillBand: true,
  notes: true,
  status: true,
  cancelReason: true,
  cancelledAt: true,
  createdAt: true,
} as const;

const GameStatusEnum = builder.enumType('AdminGameStatus', {
  values: { OPEN: { value: 'open' }, FULL: { value: 'full' }, CANCELLED: { value: 'cancelled' }, COMPLETED: { value: 'completed' } } as const,
});

const GamePlayerRef = builder
  .objectRef<{ userId: string; name: string; status: string; joinedAt: Date }>('AdminGamePlayer')
  .implement({
    fields: (t) => ({
      userId: t.exposeID('userId'),
      name: t.exposeString('name'),
      status: t.exposeString('status', { description: 'joined, or how they left.' }),
      joinedAt: t.field({ type: 'DateTime', resolve: (p) => p.joinedAt }),
    }),
  });

const GameCommentRef = builder
  .objectRef<{ id: string; userId: string; name: string; body: string; createdAt: Date }>('AdminGameComment')
  .implement({
    fields: (t) => ({
      id: t.exposeID('id'),
      userId: t.exposeID('userId'),
      name: t.exposeString('name'),
      body: t.exposeString('body'),
      createdAt: t.field({ type: 'DateTime', resolve: (c) => c.createdAt }),
    }),
  });

interface GameResultRow {
  id: string;
  sideA: string[];
  sideB: string[];
  score: string;
  winner: string | null;
  status: string;
  enteredBy: string;
  playedAt: Date;
  confirmedAt: Date | null;
  disputedBy: string | null;
  disputedAt: Date | null;
}

const GameResultRef = builder.objectRef<GameResultRow>('AdminGameResult').implement({
  description: 'games — a result players entered. Unranked: it counts for no rating.',
  fields: (t) => ({
    id: t.exposeID('id'),
    sideA: t.exposeStringList('sideA', { description: 'Names.' }),
    sideB: t.exposeStringList('sideB'),
    score: t.exposeString('score', { description: '"21–15, 18–21, 21–19"' }),
    winner: t.string({ nullable: true, description: 'A | B; null is a draw.', resolve: (r) => r.winner }),
    status: t.exposeString('status', { description: 'pending | confirmed | disputed' }),
    enteredBy: t.exposeString('enteredBy'),
    playedAt: t.field({ type: 'DateTime', resolve: (r) => r.playedAt }),
    confirmedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.confirmedAt }),
    disputedBy: t.string({ nullable: true, description: 'Who said it is not right.', resolve: (r) => r.disputedBy }),
    disputedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.disputedAt }),
  }),
});

const scoreline = (games: unknown): string =>
  Array.isArray(games)
    ? games
        .map((g) => (g && typeof g === 'object' && 'a' in g && 'b' in g ? `${String(g.a)}–${String(g.b)}` : ''))
        .filter(Boolean)
        .join(', ')
    : '';

export const AdminGameRef = builder.objectRef<GameRow>('AdminGame').implement({
  description: 'portal — a casual game, any status.',
  fields: (t) => ({
    id: t.exposeID('id'),
    hostId: t.exposeID('hostUserId'),
    hostName: t.string({ resolve: async (g, _a, ctx) => (await batched(ctx, 'userName', namesOf).load(g.hostUserId)) ?? 'Player' }),
    sportName: t.string({ resolve: async (g, _a, ctx) => (await batched(ctx, 'sportName', sportNames).load(g.sportId)) ?? '' }),
    venueId: t.id({ nullable: true, resolve: (g) => g.venueId }),
    place: t.string({
      description: 'The venue’s name, else what the host typed.',
      resolve: async (g, _a, ctx) =>
        (g.venueId ? ((await batched(ctx, 'venueName', venueNames).load(g.venueId)) ?? g.placeName) : g.placeName) ?? '',
    }),
    city: t.exposeString('city'),
    startsAt: t.field({ type: 'DateTime', resolve: (g) => g.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (g) => g.endsAt }),
    maxPlayers: t.exposeInt('maxPlayers'),
    joinedCount: t.int({ resolve: async (g, _a, ctx) => (await batched(ctx, 'joinedCount', joinedCounts).load(g.id)) ?? 0 }),
    skillBand: t.string({ nullable: true, resolve: (g) => g.skillBand }),
    notes: t.string({ nullable: true, resolve: (g) => g.notes }),
    status: t.exposeString('status', { description: 'open | full | cancelled | completed' }),
    cancelReason: t.string({ nullable: true, resolve: (g) => g.cancelReason }),
    cancelledAt: t.field({ type: 'DateTime', nullable: true, resolve: (g) => g.cancelledAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (g) => g.createdAt }),
    role: t.string({ nullable: true, description: 'On a player’s record: host, joined, or how they left.', resolve: (g) => g.role ?? null }),
    players: t.field({
      type: [GamePlayerRef],
      description: 'Everyone who joined, including those who left.',
      resolve: async (g) => {
        const rows = await db.gameParticipant.findMany({ where: { gameId: g.id }, orderBy: { joinedAt: 'asc' } });
        const names = await namesOf(rows.map((r) => r.userId));
        return rows.map((r) => ({ userId: r.userId, name: names.get(r.userId) ?? 'Player', status: r.status, joinedAt: r.joinedAt }));
      },
    }),
    comments: t.field({
      type: [GameCommentRef],
      description: 'The game’s thread, oldest first.',
      resolve: async (g) => {
        const rows = await db.gameComment.findMany({ where: { gameId: g.id }, orderBy: { createdAt: 'asc' }, take: 200 });
        const names = await namesOf(rows.map((r) => r.userId));
        return rows.map((r) => ({ id: r.id, userId: r.userId, name: names.get(r.userId) ?? 'Player', body: r.body, createdAt: r.createdAt }));
      },
    }),
    results: t.field({
      type: [GameResultRef],
      resolve: async (g) => {
        const rows = await db.gameResult.findMany({ where: { gameId: g.id }, orderBy: { playedAt: 'asc' } });
        const names = await namesOf(rows.flatMap((r) => [...r.sideA, ...r.sideB, r.enteredBy, ...(r.disputedBy ? [r.disputedBy] : [])]));
        const name = (id: string) => names.get(id) ?? 'Player';
        return rows.map((r) => ({
          id: r.id,
          sideA: r.sideA.map(name),
          sideB: r.sideB.map(name),
          score: scoreline(r.games),
          winner: r.winner,
          status: r.status,
          enteredBy: name(r.enteredBy),
          playedAt: r.playedAt,
          confirmedAt: r.confirmedAt,
          disputedBy: r.disputedBy ? name(r.disputedBy) : null,
          disputedAt: r.disputedAt,
        }));
      },
    }),
  }),
});

const AdminGamePage = builder.objectRef<{ nodes: GameRow[]; hasNextPage: boolean }>('AdminGamePage').implement({
  fields: (t) => ({
    nodes: t.field({ type: [AdminGameRef], resolve: (p) => p.nodes }),
    hasNextPage: t.exposeBoolean('hasNextPage'),
  }),
});

// The record hangs off the person staff already found (adminUser).
builder.objectFields(AdminUserRef, (t) => ({
  city: t.string({
    nullable: true,
    resolve: async (u) => (await db.playerProfile.findUnique({ where: { userId: u.id }, select: { city: true } }))?.city ?? null,
  }),
  sports: t.field({
    type: [UserSportRef],
    description: 'The sports on their profile, with the rating in each.',
    resolve: async (u) => {
      const rows = await db.playerSport.findMany({
        where: { player: { userId: u.id } },
        include: { sport: { select: { name: true } } },
        orderBy: { matchesPlayed: 'desc' },
      });
      return rows.map((r) => ({
        sportName: r.sport.name,
        skillBand: r.skillBand,
        rating: r.rating === null ? null : Number(r.rating),
        isProvisional: r.isProvisional,
        matchesPlayed: r.matchesPlayed,
      }));
    },
  }),
  entries: t.field({
    type: [UserEntryRef],
    description: 'Event entries they made or are a partner on, newest first.',
    resolve: async (u) => {
      const rows = await db.registration.findMany({
        where: { OR: [{ captainUserId: u.id }, { team: { members: { some: { userId: u.id } } } }] },
        include: { event: { select: { title: true, slug: true } }, eventCategory: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: RECORD_ROWS,
      });
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        paymentMode: r.paymentMode,
        amountPaise: paise(r.amountPaise),
        createdAt: r.createdAt,
        eventTitle: r.event.title,
        eventSlug: r.event.slug,
        drawName: r.eventCategory.name,
        paidByThem: r.captainUserId === u.id,
      }));
    },
  }),
  courtBookings: t.field({
    type: [UserBookingRef],
    description: 'Courts they booked, newest first.',
    resolve: async (u) => {
      const rows = await db.courtBooking.findMany({ where: { userId: u.id }, orderBy: { startsAt: 'desc' }, take: RECORD_ROWS });
      const [venues, courts] = await Promise.all([
        venueNames(rows.map((r) => r.venueId)),
        db.venueCourt.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.courtId))] } }, select: { id: true, name: true } }),
      ]);
      const courtName = new Map(courts.map((c) => [c.id, c.name]));
      return rows.map((r) => ({
        id: r.id,
        venueId: r.venueId,
        venueName: venues.get(r.venueId) ?? 'A venue',
        courtName: courtName.get(r.courtId) ?? 'Court',
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        status: r.status,
        paymentMode: r.paymentMode,
        amountPaise: paise(r.amountPaise),
      }));
    },
  }),
  games: t.field({
    type: [AdminGameRef],
    description: 'Casual games they hosted or joined, newest first.',
    resolve: async (u) => {
      const joined = await db.gameParticipant.findMany({ where: { userId: u.id }, select: { gameId: true, status: true } });
      const how = new Map(joined.map((j) => [j.gameId, j.status]));
      const rows = await db.game.findMany({
        where: { OR: [{ hostUserId: u.id }, { id: { in: [...how.keys()] } }] },
        select: GAME_SELECT,
        orderBy: { startsAt: 'desc' },
        take: RECORD_ROWS,
      });
      return rows.map((g) => ({ ...g, role: g.hostUserId === u.id ? 'host' : (how.get(g.id) ?? 'joined') }));
    },
  }),
  notifications: t.field({
    type: [NotificationRef],
    description: 'What PL4Y sent them, as their own feed shows it, newest first. Reading it here does not mark anything read.',
    resolve: async (u) => (await notifications.feed({ userId: u.id }, { first: RECORD_ROWS, after: null })).edges.map((e) => e.node),
  }),
  payments: t.field({
    type: [UserPaymentRef],
    description: 'What they paid in the app, for entries and for courts, newest first.',
    resolve: async (u) => {
      const bookingIds = (await db.courtBooking.findMany({ where: { userId: u.id }, select: { id: true, venueId: true } }));
      const bookingVenue = new Map(bookingIds.map((b) => [b.id, b.venueId]));
      const rows = await db.payment.findMany({
        where: {
          paymentOrder: { OR: [{ registration: { captainUserId: u.id } }, { bookingId: { in: [...bookingVenue.keys()] } }] },
        },
        include: {
          refunds: { select: { amountPaise: true, processedAt: true } },
          paymentOrder: {
            include: {
              registration: { select: { event: { select: { title: true, slug: true } }, eventCategory: { select: { name: true } } } },
            },
          },
        },
        orderBy: { paymentOrder: { createdAt: 'desc' } },
        take: RECORD_ROWS,
      });
      const venues = await venueNames([...bookingVenue.values()]);
      return rows.map((p) => {
        const o = p.paymentOrder;
        const venueId = o.bookingId ? bookingVenue.get(o.bookingId) : undefined;
        return {
          id: p.id,
          gatewayPaymentId: p.gatewayPaymentId,
          status: p.status,
          method: p.method,
          amountPaise: paise(p.amountPaise),
          entryFeePaise: paise(o.entryFeePaise),
          platformFeePaise: paise(o.platformFeePaise),
          taxPaise: paise(o.taxPaise),
          refundedPaise: paise(p.refunds.filter((r) => r.processedAt !== null).reduce((n, r) => n + r.amountPaise, 0n)),
          capturedAt: p.capturedAt,
          createdAt: o.createdAt,
          paidFor: o.registration
            ? `${o.registration.event.title} · ${o.registration.eventCategory.name}`
            : `Court at ${venueId ? (venues.get(venueId) ?? 'a venue') : 'a venue'}`,
          eventSlug: o.registration?.event.slug ?? null,
        };
      });
    },
  }),
}));

// --- an event's entries (gap C5) --------------------------------------------------------

interface EntryRow {
  id: string;
  status: string;
  paymentMode: string;
  amountPaise: number;
  drawName: string;
  captainId: string;
  captainName: string;
  partners: string[];
  invitesPending: string[];
  waitlistPlace: number | null;
  createdAt: Date;
  confirmedAt: Date | null;
  checkedInAt: Date | null;
  withdrawnReason: string | null;
  ledger: { kind: string; amountPaise: number; createdAt: Date }[];
}

const EntryLedgerRef = builder
  .objectRef<{ kind: string; amountPaise: number; createdAt: Date }>('AdminEntryLedgerLine')
  .implement({
    fields: (t) => ({
      kind: t.exposeString('kind'),
      amountPaise: t.exposeInt('amountPaise'),
      createdAt: t.field({ type: 'DateTime', resolve: (l) => l.createdAt }),
    }),
  });

const AdminEntryRef = builder.objectRef<EntryRow>('AdminEventEntry').implement({
  description: 'portal — one entry on an event: who, where it stands, and every money movement against it.',
  fields: (t) => ({
    id: t.exposeID('id'),
    status: t.exposeString('status'),
    paymentMode: t.exposeString('paymentMode'),
    amountPaise: t.exposeInt('amountPaise'),
    drawName: t.exposeString('drawName'),
    captainId: t.exposeID('captainId'),
    captainName: t.exposeString('captainName'),
    partners: t.exposeStringList('partners', { description: 'Team-mates who have joined, by name.' }),
    invitesPending: t.exposeStringList('invitesPending', { description: 'Partners invited who have not answered, by masked email.' }),
    waitlistPlace: t.int({ nullable: true, description: '1 is next. Null when not waiting.', resolve: (e) => e.waitlistPlace }),
    createdAt: t.field({ type: 'DateTime', resolve: (e) => e.createdAt }),
    confirmedAt: t.field({ type: 'DateTime', nullable: true, resolve: (e) => e.confirmedAt }),
    checkedInAt: t.field({ type: 'DateTime', nullable: true, resolve: (e) => e.checkedInAt }),
    withdrawnReason: t.string({ nullable: true, resolve: (e) => e.withdrawnReason }),
    ledger: t.field({ type: [EntryLedgerRef], description: 'Oldest first.', resolve: (e) => e.ledger }),
  }),
});

const maskInvite = (email: string): string => {
  const [name = '', domain = ''] = email.split('@');
  return `${name.slice(0, 1)}***@${domain}`;
};

// --- platform numbers (gap A9) ----------------------------------------------------------

interface DayNumbers {
  date: string;
  signups: number;
  entries: number;
  games: number;
  bookings: number;
  activePlayers: number;
  paidPaise: number;
  eventPaidPaise: number;
  bookingPaidPaise: number;
  refundedPaise: number;
  platformFeePaise: number;
  commissionPaise: number;
  payoutsPaise: number;
}

interface CityNumbers {
  city: string;
  signups: number;
  entries: number;
  games: number;
  bookings: number;
}

interface Funnel {
  signedUp: number;
  onboarded: number;
  active: number;
  paid: number;
}

interface SportNumbers {
  sport: string;
  entries: number;
  games: number;
  players: number;
}

interface TopEvent {
  slug: string;
  title: string;
  city: string;
  startsAt: Date;
  entries: number;
  paidPaise: number;
}

interface TopHost {
  userId: string;
  name: string;
  events: number;
  entries: number;
  games: number;
}

interface TopVenue {
  venueId: string;
  name: string;
  city: string;
  bookings: number;
  paidPaise: number;
}

type Range = { from: string; to: string };

const DayNumbersRef = builder.objectRef<DayNumbers>('AdminDayNumbers').implement({
  fields: (t) => ({
    date: t.exposeString('date', { description: 'The India day, YYYY-MM-DD.' }),
    signups: t.exposeInt('signups'),
    entries: t.exposeInt('entries', { description: 'Event entries confirmed that day.' }),
    games: t.exposeInt('games', { description: 'Casual games created.' }),
    bookings: t.exposeInt('bookings', { description: 'Court bookings made that went ahead or still stand.' }),
    activePlayers: t.exposeInt('activePlayers', {
      description: 'Players who entered an event, hosted or joined a game, or booked a court that day. Each counted once.',
    }),
    paidPaise: t.exposeInt('paidPaise', { description: 'Captured in the app.' }),
    eventPaidPaise: t.exposeInt('eventPaidPaise', { description: 'Captured in the app for event entries.' }),
    bookingPaidPaise: t.exposeInt('bookingPaidPaise', { description: 'Captured in the app for court bookings.' }),
    refundedPaise: t.exposeInt('refundedPaise'),
    platformFeePaise: t.exposeInt('platformFeePaise', { description: 'Platform fees charged, less fees given back with a full refund.' }),
    commissionPaise: t.exposeInt('commissionPaise', { description: 'Commission kept from host payouts worked out that day.' }),
    payoutsPaise: t.exposeInt('payoutsPaise', { description: 'Owed to hosts by payouts worked out that day.' }),
  }),
});

const CityNumbersRef = builder.objectRef<CityNumbers>('AdminCityNumbers').implement({
  fields: (t) => ({
    city: t.exposeString('city'),
    signups: t.exposeInt('signups'),
    entries: t.exposeInt('entries'),
    games: t.exposeInt('games'),
    bookings: t.exposeInt('bookings'),
  }),
});

const FunnelRef = builder.objectRef<Funnel>('AdminFunnel').implement({
  description: 'portal — what the people who signed up in the range have done since.',
  fields: (t) => ({
    signedUp: t.exposeInt('signedUp'),
    onboarded: t.exposeInt('onboarded', { description: 'Picked a sport and a city.' }),
    active: t.exposeInt('active', { description: 'Entered an event, hosted or joined a game, or booked a court.' }),
    paid: t.exposeInt('paid', { description: 'Paid for an entry or a booking in the app.' }),
  }),
});

const SportNumbersRef = builder.objectRef<SportNumbers>('AdminSportNumbers').implement({
  fields: (t) => ({
    sport: t.exposeString('sport'),
    entries: t.exposeInt('entries'),
    games: t.exposeInt('games'),
    players: t.exposeInt('players', { description: 'Different players in those entries and games.' }),
  }),
});

const TopEventRef = builder.objectRef<TopEvent>('AdminTopEvent').implement({
  fields: (t) => ({
    slug: t.exposeString('slug'),
    title: t.exposeString('title'),
    city: t.exposeString('city'),
    startsAt: t.expose('startsAt', { type: 'DateTime' }),
    entries: t.exposeInt('entries', { description: 'Confirmed in the range.' }),
    paidPaise: t.exposeInt('paidPaise', { description: 'Captured in the app for this event in the range.' }),
  }),
});

const TopHostRef = builder.objectRef<TopHost>('AdminTopHost').implement({
  fields: (t) => ({
    userId: t.exposeID('userId'),
    name: t.exposeString('name'),
    events: t.exposeInt('events', { description: 'Their events with an entry confirmed in the range.' }),
    entries: t.exposeInt('entries'),
    games: t.exposeInt('games', { description: 'Casual games they set up in the range.' }),
  }),
});

const TopVenueRef = builder.objectRef<TopVenue>('AdminTopVenue').implement({
  fields: (t) => ({
    venueId: t.exposeID('venueId'),
    name: t.exposeString('name'),
    city: t.exposeString('city'),
    bookings: t.exposeInt('bookings'),
    paidPaise: t.exposeInt('paidPaise', { description: 'Booked value, paid in the app or at the desk.' }),
  }),
});

const NumbersRef = builder.objectRef<Range>('AdminNumbers').implement({
  description: 'portal — the platform by day, by city, by sport, and who led it. Computed on request; ask only for what you show.',
  fields: (t) => ({
    from: t.exposeString('from'),
    to: t.exposeString('to'),
    days: t.field({ type: [DayNumbersRef], description: 'Every day in the range, oldest first.', resolve: (r) => dayNumbers(r) }),
    cities: t.field({ type: [CityNumbersRef], description: 'Busiest first.', resolve: (r) => cityNumbers(r) }),
    activePlayers: t.int({
      description: 'Different players active across the whole range (not the sum of the days).',
      resolve: async (r) => Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(DISTINCT uid) AS n FROM (${activity(r)}) a`)[0]?.n ?? 0n),
    }),
    funnel: t.field({ type: FunnelRef, resolve: (r) => funnel(r) }),
    sports: t.field({ type: [SportNumbersRef], description: 'Busiest first.', resolve: (r) => sportNumbers(r) }),
    topEvents: t.field({ type: [TopEventRef], description: 'Most entries confirmed in the range.', resolve: (r) => topEvents(r) }),
    topHosts: t.field({ type: [TopHostRef], description: 'Event entries plus games set up, most first.', resolve: (r) => topHosts(r) }),
    topVenues: t.field({ type: [TopVenueRef], description: 'Most court bookings in the range.', resolve: (r) => topVenues(r) }),
  }),
});

const MAX_NUMBER_DAYS = 92;
const TOP_ROWS = 8;
const BOOKED = Prisma.sql`('confirmed', 'checked_in', 'completed', 'no_show')`;

type Counted = { key: string; n: bigint }[];

/** The rows of `table` whose `at` falls in the range, counted by `key`. India days. */
const inRange = (at: Prisma.Sql, from: string, to: string): Prisma.Sql =>
  Prisma.sql`${at} >= (${from}::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND ${at} < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
const dayOf = (at: Prisma.Sql): Prisma.Sql => Prisma.sql`to_char(${at} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;
const cityOf = (col: Prisma.Sql): Prisma.Sql => Prisma.sql`coalesce(nullif(trim(${col}), ''), 'Not given')`;

/**
 * One row per thing a player did in the range: (uid, at). Entering counts
 * the captain and every teammate; a game counts its host and who joined.
 */
function activity({ from, to }: Range): Prisma.Sql {
  const r = Prisma.sql`r.confirmed_at`;
  return Prisma.sql`
    SELECT r.captain_user_id AS uid, r.confirmed_at AS at FROM registrations r WHERE ${inRange(r, from, to)}
    UNION ALL SELECT tm.user_id, r.confirmed_at FROM registrations r JOIN team_members tm ON tm.team_id = r.team_id WHERE ${inRange(r, from, to)}
    UNION ALL SELECT g.host_user_id, g.created_at FROM games g WHERE ${inRange(Prisma.sql`g.created_at`, from, to)}
    UNION ALL SELECT p.user_id, p.joined_at FROM game_participants p WHERE p.status = 'joined' AND ${inRange(Prisma.sql`p.joined_at`, from, to)}
    UNION ALL SELECT b.user_id, b.created_at FROM court_bookings b
      WHERE b.user_id IS NOT NULL AND b.status IN ${BOOKED} AND ${inRange(Prisma.sql`b.created_at`, from, to)}`;
}

async function dayNumbers(range: Range): Promise<DayNumbers[]> {
  const { from, to } = range;
  const u = Prisma.sql`u.created_at`;
  const r = Prisma.sql`r.confirmed_at`;
  const g = Prisma.sql`g.created_at`;
  const b = Prisma.sql`b.created_at`;
  const p = Prisma.sql`p.captured_at`;
  const f = Prisma.sql`f.processed_at`;
  const l = Prisma.sql`l.created_at`;
  const [signups, entries, games, bookings, active, eventPaid, bookingPaid, refunded, platformFees, commission, payouts] = await Promise.all([
    db.$queryRaw<Counted>`SELECT ${dayOf(u)} AS key, count(*) AS n FROM users u WHERE NOT u.is_guest AND ${inRange(u, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(r)} AS key, count(*) AS n FROM registrations r WHERE ${inRange(r, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(g)} AS key, count(*) AS n FROM games g WHERE ${inRange(g, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(b)} AS key, count(*) AS n FROM court_bookings b WHERE b.status IN ${BOOKED} AND ${inRange(b, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(Prisma.sql`a.at`)} AS key, count(DISTINCT a.uid) AS n FROM (${activity(range)}) a GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(p)} AS key, coalesce(sum(p.amount_paise), 0) AS n FROM payments p JOIN payment_orders o ON o.id = p.payment_order_id
      WHERE p.status = 'captured' AND o.booking_id IS NULL AND ${inRange(p, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(p)} AS key, coalesce(sum(p.amount_paise), 0) AS n FROM payments p JOIN payment_orders o ON o.id = p.payment_order_id
      WHERE p.status = 'captured' AND o.booking_id IS NOT NULL AND ${inRange(p, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(f)} AS key, coalesce(sum(f.amount_paise), 0) AS n FROM refunds f WHERE ${inRange(f, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(l)} AS key, coalesce(sum(l.amount_paise), 0) AS n FROM ledger_entries l
      WHERE l.kind IN ('platform_fee', 'fee_reversal') AND ${inRange(l, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(l)} AS key, coalesce(sum(l.amount_paise), 0) AS n FROM ledger_entries l
      WHERE l.kind = 'host_commission' AND ${inRange(l, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${dayOf(l)} AS key, coalesce(-sum(l.amount_paise), 0) AS n FROM ledger_entries l
      WHERE l.kind = 'host_payout' AND ${inRange(l, from, to)} GROUP BY 1`,
  ]);
  const by = (rows: Counted) => new Map(rows.map((x) => [x.key, Number(x.n)]));
  const [s, e, ga, bo, ac, ep, bp, re, pf, co, po] = [signups, entries, games, bookings, active, eventPaid, bookingPaid, refunded, platformFees, commission, payouts].map(by) as Map<string, number>[];

  const days: DayNumbers[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const at = (m: Map<string, number> | undefined) => m?.get(date) ?? 0;
    days.push({
      date,
      signups: at(s),
      entries: at(e),
      games: at(ga),
      bookings: at(bo),
      activePlayers: at(ac),
      paidPaise: at(ep) + at(bp),
      eventPaidPaise: at(ep),
      bookingPaidPaise: at(bp),
      refundedPaise: at(re),
      platformFeePaise: at(pf),
      commissionPaise: at(co),
      payoutsPaise: at(po),
    });
  }
  return days;
}

async function cityNumbers({ from, to }: Range): Promise<CityNumbers[]> {
  const u = Prisma.sql`u.created_at`;
  const r = Prisma.sql`r.confirmed_at`;
  const g = Prisma.sql`g.created_at`;
  const b = Prisma.sql`b.created_at`;
  const [signupCity, entryCity, gameCity, bookingCity] = await Promise.all([
    db.$queryRaw<Counted>`SELECT ${cityOf(Prisma.sql`pp.city`)} AS key, count(*) AS n FROM users u LEFT JOIN player_profiles pp ON pp.user_id = u.id WHERE NOT u.is_guest AND ${inRange(u, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${cityOf(Prisma.sql`e.city`)} AS key, count(*) AS n FROM registrations r JOIN events e ON e.id = r.event_id WHERE ${inRange(r, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${cityOf(Prisma.sql`g.city`)} AS key, count(*) AS n FROM games g WHERE ${inRange(g, from, to)} GROUP BY 1`,
    db.$queryRaw<Counted>`SELECT ${cityOf(Prisma.sql`v.city`)} AS key, count(*) AS n FROM court_bookings b JOIN venues v ON v.id = b.venue_id WHERE b.status IN ${BOOKED} AND ${inRange(b, from, to)} GROUP BY 1`,
  ]);

  // "Bengaluru" and "bengaluru" are one city; the first spelling seen names it.
  const cities = new Map<string, CityNumbers>();
  const add = (rows: Counted, field: 'signups' | 'entries' | 'games' | 'bookings') => {
    for (const row of rows) {
      const id = row.key.toLowerCase();
      const city = cities.get(id) ?? { city: row.key, signups: 0, entries: 0, games: 0, bookings: 0 };
      city[field] += Number(row.n);
      cities.set(id, city);
    }
  };
  add(signupCity, 'signups');
  add(entryCity, 'entries');
  add(gameCity, 'games');
  add(bookingCity, 'bookings');
  const weight = (c: CityNumbers) => c.signups + c.entries + c.games + c.bookings;
  return [...cities.values()].sort((a, c) => weight(c) - weight(a));
}

/** Signed up in the range, then (at any time since) onboarded, did something, paid. */
async function funnel({ from, to }: Range): Promise<Funnel> {
  const u = Prisma.sql`u.created_at`;
  const [row] = await db.$queryRaw<{ signed_up: bigint; onboarded: bigint; active: bigint; paid: bigint }[]>`
    SELECT
      count(*) AS signed_up,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM player_profiles pp WHERE pp.user_id = u.id AND nullif(trim(pp.city), '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM player_sports ps WHERE ps.player_id = pp.id))) AS onboarded,
      count(*) FILTER (WHERE
        EXISTS (SELECT 1 FROM registrations r WHERE r.captain_user_id = u.id AND r.confirmed_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM team_members tm JOIN registrations r ON r.team_id = tm.team_id WHERE tm.user_id = u.id AND r.confirmed_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM games g WHERE g.host_user_id = u.id)
        OR EXISTS (SELECT 1 FROM game_participants p WHERE p.user_id = u.id AND p.status = 'joined')
        OR EXISTS (SELECT 1 FROM court_bookings b WHERE b.user_id = u.id AND b.status IN ${BOOKED})) AS active,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM payments p JOIN payment_orders o ON o.id = p.payment_order_id
          LEFT JOIN registrations r ON r.id = o.registration_id
          LEFT JOIN court_bookings b ON b.id = o.booking_id
        WHERE p.status = 'captured' AND (r.captain_user_id = u.id OR b.user_id = u.id))) AS paid
    FROM users u WHERE NOT u.is_guest AND ${inRange(u, from, to)}`;
  return {
    signedUp: Number(row?.signed_up ?? 0n),
    onboarded: Number(row?.onboarded ?? 0n),
    active: Number(row?.active ?? 0n),
    paid: Number(row?.paid ?? 0n),
  };
}

async function sportNumbers({ from, to }: Range): Promise<SportNumbers[]> {
  const r = Prisma.sql`r.confirmed_at`;
  const g = Prisma.sql`g.created_at`;
  const rows = await db.$queryRaw<{ sport: string; entries: bigint; games: bigint; players: bigint }[]>`
    WITH acts AS (
      SELECT r.sport_id, 'entry' AS what, r.id AS item, r.captain_user_id AS uid FROM registrations r WHERE ${inRange(r, from, to)}
      UNION ALL SELECT r.sport_id, 'entry', r.id, tm.user_id FROM registrations r JOIN team_members tm ON tm.team_id = r.team_id WHERE ${inRange(r, from, to)}
      UNION ALL SELECT g.sport_id, 'game', g.id, g.host_user_id FROM games g WHERE ${inRange(g, from, to)}
      UNION ALL SELECT g.sport_id, 'game', g.id, p.user_id FROM games g JOIN game_participants p ON p.game_id = g.id AND p.status = 'joined' WHERE ${inRange(g, from, to)}
    )
    SELECT s.name AS sport,
      count(DISTINCT a.item) FILTER (WHERE a.what = 'entry') AS entries,
      count(DISTINCT a.item) FILTER (WHERE a.what = 'game') AS games,
      count(DISTINCT a.uid) AS players
    FROM acts a JOIN sports s ON s.id = a.sport_id
    GROUP BY s.name ORDER BY players DESC, s.name`;
  return rows.map((x) => ({ sport: x.sport, entries: Number(x.entries), games: Number(x.games), players: Number(x.players) }));
}

async function topEvents({ from, to }: Range): Promise<TopEvent[]> {
  const r = Prisma.sql`r.confirmed_at`;
  const p = Prisma.sql`p.captured_at`;
  const rows = await db.$queryRaw<{ slug: string; title: string; city: string; starts_at: Date; entries: bigint; paid: bigint }[]>`
    SELECT e.slug, e.title, e.city, e.starts_at, x.entries,
      coalesce((SELECT sum(p.amount_paise) FROM payments p JOIN payment_orders o ON o.id = p.payment_order_id
        JOIN registrations rr ON rr.id = o.registration_id
        WHERE rr.event_id = e.id AND p.status = 'captured' AND ${inRange(p, from, to)}), 0) AS paid
    FROM (SELECT r.event_id, count(*) AS entries FROM registrations r WHERE ${inRange(r, from, to)} GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP_ROWS}) x
    JOIN events e ON e.id = x.event_id
    ORDER BY x.entries DESC, e.starts_at`;
  return rows.map((x) => ({ slug: x.slug, title: x.title, city: x.city, startsAt: x.starts_at, entries: Number(x.entries), paidPaise: Number(x.paid) }));
}

async function topHosts({ from, to }: Range): Promise<TopHost[]> {
  const r = Prisma.sql`r.confirmed_at`;
  const g = Prisma.sql`g.created_at`;
  const rows = await db.$queryRaw<{ uid: string; name: string; events: bigint; entries: bigint; games: bigint }[]>`
    WITH hosted AS (
      SELECT e.organizer_id AS uid, count(DISTINCT e.id) AS events, count(*) AS entries, 0::bigint AS games
        FROM registrations r JOIN events e ON e.id = r.event_id WHERE ${inRange(r, from, to)} GROUP BY 1
      UNION ALL
      SELECT g.host_user_id, 0, 0, count(*) FROM games g WHERE ${inRange(g, from, to)} GROUP BY 1
    )
    SELECT h.uid, u.display_name AS name, sum(h.events)::bigint AS events, sum(h.entries)::bigint AS entries, sum(h.games)::bigint AS games
    FROM hosted h JOIN users u ON u.id = h.uid
    GROUP BY h.uid, u.display_name
    ORDER BY sum(h.entries) + sum(h.games) DESC, u.display_name
    LIMIT ${TOP_ROWS}`;
  return rows.map((x) => ({ userId: x.uid, name: x.name, events: Number(x.events), entries: Number(x.entries), games: Number(x.games) }));
}

async function topVenues({ from, to }: Range): Promise<TopVenue[]> {
  const b = Prisma.sql`b.created_at`;
  const rows = await db.$queryRaw<{ id: string; name: string; city: string; bookings: bigint; paid: bigint }[]>`
    SELECT v.id, v.name, v.city, count(*) AS bookings, coalesce(sum(b.amount_paise), 0) AS paid
    FROM court_bookings b JOIN venues v ON v.id = b.venue_id
    WHERE b.status IN ${BOOKED} AND ${inRange(b, from, to)}
    GROUP BY v.id, v.name, v.city
    ORDER BY count(*) DESC, v.name
    LIMIT ${TOP_ROWS}`;
  return rows.map((x) => ({ venueId: x.id, name: x.name, city: x.city, bookings: Number(x.bookings), paidPaise: Number(x.paid) }));
}

const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// --- queries ----------------------------------------------------------------------------

builder.queryFields((t) => ({
  adminGames: t.field({
    type: AdminGamePage,
    description: 'portal — casual games, any status, newest start first. Search matches the place, the city or the host’s name.',
    args: {
      search: t.arg.string(),
      status: t.arg({ type: GameStatusEnum }),
      sportId: t.arg.id(),
      hostId: t.arg.id(),
      first: t.arg.int(),
      offset: t.arg.int(),
    },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const first = clampFirst(args.first, 50);
      const q = args.search?.trim() ?? '';
      const hosts =
        q.length >= 2
          ? (await db.user.findMany({ where: { displayName: { contains: q, mode: 'insensitive' } }, select: { id: true }, take: 200 })).map((u) => u.id)
          : [];
      const rows = await db.game.findMany({
        where: {
          ...(args.status ? { status: args.status } : {}),
          ...(args.sportId ? { sportId: String(args.sportId) } : {}),
          ...(args.hostId ? { hostUserId: String(args.hostId) } : {}),
          ...(q.length >= 2
            ? {
                OR: [
                  { placeName: { contains: q, mode: 'insensitive' } },
                  { city: { contains: q, mode: 'insensitive' } },
                  { hostUserId: { in: hosts } },
                  ...(/^[0-9a-f-]{36}$/i.test(q) ? [{ id: q }] : []),
                ],
              }
            : {}),
        },
        select: GAME_SELECT,
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        skip: Math.max(args.offset ?? 0, 0),
        take: first + 1,
      });
      return { nodes: rows.slice(0, first), hasNextPage: rows.length > first };
    },
  }),

  adminGame: t.field({
    type: AdminGameRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const id = String(args.id);
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      return db.game.findUnique({ where: { id }, select: GAME_SELECT });
    },
  }),

  adminEventEntries: t.field({
    type: [AdminEntryRef],
    description: 'portal — every entry on an event, newest first, with its partners, its place on the waitlist and its money.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const eventId = String(args.eventId);
      const rows = await db.registration.findMany({
        where: { eventId, status: { not: 'draft' } },
        include: {
          eventCategory: { select: { name: true } },
          captain: { select: { displayName: true } },
          team: { select: { members: { select: { userId: true, user: { select: { displayName: true } } } } } },
          invites: { where: { status: 'pending' }, select: { invitedEmail: true } },
          ledgerEntries: { select: { kind: true, amountPaise: true, createdAt: true }, orderBy: { id: 'asc' } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
      });
      // The waitlist is first come, first served within a draw.
      const waiting = await db.waitlistEntry.findMany({
        where: { registration: { eventId, status: 'waitlisted' } },
        select: { registrationId: true, eventCategoryId: true },
        orderBy: { createdAt: 'asc' },
      });
      const place = new Map<string, number>();
      const seen = new Map<string, number>();
      for (const w of waiting) {
        const n = (seen.get(w.eventCategoryId) ?? 0) + 1;
        seen.set(w.eventCategoryId, n);
        place.set(w.registrationId, n);
      }
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        paymentMode: r.paymentMode,
        amountPaise: paise(r.amountPaise),
        drawName: r.eventCategory.name,
        captainId: r.captainUserId,
        captainName: r.captain.displayName,
        partners: (r.team?.members ?? []).filter((m) => m.userId !== r.captainUserId).map((m) => m.user.displayName),
        invitesPending: r.invites.map((i) => maskInvite(i.invitedEmail)),
        waitlistPlace: place.get(r.id) ?? null,
        createdAt: r.createdAt,
        confirmedAt: r.confirmedAt,
        checkedInAt: r.checkedInAt,
        withdrawnReason: r.withdrawnReason,
        ledger: r.ledgerEntries.map((l) => ({ kind: l.kind, amountPaise: paise(l.amountPaise), createdAt: l.createdAt })),
      }));
    },
  }),

  adminNumbers: t.field({
    type: NumbersRef,
    description: `portal — the platform by day and by city. Dates are India days (YYYY-MM-DD), at most ${MAX_NUMBER_DAYS} of them.`,
    args: { from: t.arg.string({ required: true }), to: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      const { from, to } = args;
      if (!isDay(from) || !isDay(to) || to < from) throw new UserError('INVALID_RANGE', 'Pick a first and a last day, the first no later than the last.');
      if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 >= MAX_NUMBER_DAYS) {
        throw new UserError('INVALID_RANGE', `Pick ${MAX_NUMBER_DAYS} days or fewer.`);
      }
      return { from, to };
    },
  }),
}));
