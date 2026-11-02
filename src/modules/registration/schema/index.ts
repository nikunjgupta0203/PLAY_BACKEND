/**
 * registration — GraphQL surface (docs/modules/06-registration.md).
 *
 * Every mutation here returns a payload with a typed `userError`
 * (conventions.md §3): "this draw is full" and "that invite expired" are things
 * the player can act on, so they are DATA rather than GraphQL errors. Only
 * ILLEGAL_TRANSITION comes back as an error, because it is a bug.
 */
import { GeoPointInput } from '../../../graphql/geo.js';
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import type { Ctx } from '../../../graphql/context.js';
import { auditedWhenStaff } from '../../../graphql/staff.js';
import { forbidden, SystemError, UserError } from '../../../platform/errors/index.js';
import { memo } from '../../../platform/requestCache.js';
import { events } from '../../events/index.js';
import { EventCategoryRef, EventRef } from '../../events/schema/index.js';
import { RegistrationCode, registration } from '../index.js';
import { entrantName } from '../service/entrantName.js';
import { referenceFor } from '../service/index.js';
import type {
  CheckInState,
  HistoryEntry,
  InviteDetails,
  PaymentStatus,
  RegistrationMember,
  TeamStats,
} from '../service/index.js';
import type {
  Invite,
  PaymentMode,
  Registration,
  RegistrationStatus,
  RosterEntry,
} from '../index.js';

// --- enums -------------------------------------------------------------------

const RegistrationStatusEnum = builder.enumType('RegistrationStatus', {
  description: 'The state machine in docs/modules/06-registration.md.',
  values: {
    DRAFT: { value: 'draft' as RegistrationStatus },
    AWAITING_PARTNER: { value: 'awaiting_partner' as RegistrationStatus },
    WAITLISTED: { value: 'waitlisted' as RegistrationStatus },
    PAYMENT_PENDING: { value: 'payment_pending' as RegistrationStatus },
    CONFIRMED: { value: 'confirmed' as RegistrationStatus },
    CHECKED_IN: { value: 'checked_in' as RegistrationStatus },
    WITHDRAWN: { value: 'withdrawn' as RegistrationStatus },
    EXPIRED: { value: 'expired' as RegistrationStatus },
    PAYMENT_FAILED: { value: 'payment_failed' as RegistrationStatus },
    REFUNDED: { value: 'refunded' as RegistrationStatus },
  },
});

const PaymentModeEnum = builder.enumType('PaymentMode', {
  description: 'registration R14 — how the entry was paid for.',
  values: {
    ONLINE: { value: 'online' as PaymentMode },
    OFFLINE: { value: 'offline' as PaymentMode },
    COMP: { value: 'comp' as PaymentMode },
  },
});

// --- types -------------------------------------------------------------------

interface TeamMemberShape {
  userId: string;
  isCaptain: boolean;
}

const TeamMemberRef = builder.objectRef<TeamMemberShape>('TeamMember').implement({
  fields: (t) => ({
    userId: t.exposeID('userId'),
    isCaptain: t.exposeBoolean('isCaptain', {
      description: 'The captain pays for the whole team (registration R6).',
    }),
  }),
});

const TeamRef = builder
  .objectRef<{ id: string; members: TeamMemberShape[] }>('Team')
  .implement({
    fields: (t) => ({
      id: t.exposeID('id'),
      members: t.field({ type: [TeamMemberRef], resolve: (team) => team.members }),
    }),
  });

const RegistrationRef = builder.objectRef<Registration>('Registration');

builder.objectType(RegistrationRef, {
  fields: (t) => ({
    id: t.exposeID('id'),
    // Speed — a list of entries reads its events and categories in one query each.
    event: t.field({
      type: EventRef,
      resolve: async (r, _args, ctx) => (await ctx.loaders.event.load(r.eventId)) ?? events.byId(r.eventId),
    }),
    category: t.field({
      type: EventCategoryRef,
      resolve: async (r, _args, ctx) =>
        (await ctx.loaders.category.load(r.eventCategoryId)) ?? events.categoryById(r.eventCategoryId),
    }),
    status: t.field({ type: RegistrationStatusEnum, resolve: (r) => r.status }),
    displayName: t.string({
      description: 'How the entry reads on a bracket or standings: "Asha", "Asha & Meera", "Asha + 4".',
      resolve: async (r) => {
        // N14 — a named team reads as its name on the draw.
        const named = r.teamId ? await registration.teamNameFor(r.id) : null;
        if (named) return named;
        const team = await registration.teamFor(r.id);
        const ids = team.length > 0
          ? [...team].sort((x, y) => Number(y.isCaptain) - Number(x.isCaptain)).map((m) => m.userId)
          : [r.captainUserId];
        const { identity } = await import('../../identity/index.js');
        const byId = new Map((await identity.usersByIds(ids)).map((u) => [u.id, u.displayName]));
        return entrantName(ids.map((id) => byId.get(id) ?? '').filter(Boolean));
      },
    }),
    team: t.field({
      type: TeamRef,
      nullable: true,
      resolve: async (r) =>
        r.teamId ? { id: r.teamId, members: await registration.teamFor(r.id) } : null,
    }),
    /** Paise as Int — the same convention as PriceQuote. Never a Float. */
    amountPaise: t.int({ resolve: (r) => Number(r.amountPaise) }),
    paymentMode: t.field({ type: PaymentModeEnum, resolve: (r) => r.paymentMode }),
    holdExpiresAt: t.field({
      type: 'DateTime',
      nullable: true,
      description:
        'Non-null while a seat hold is live. This is the countdown on the checkout screen.',
      resolve: (r) => r.holdExpiresAt,
    }),
    waitlistPosition: t.int({
      nullable: true,
      description: 'registration R17 — 1-based, non-null only while waitlisted.',
      resolve: (r) => r.waitlistPosition,
    }),
    checkInQr: t.string({
      nullable: true,
      description:
        'registration R13 — the payload to render as a QR. Team members only, confirmed ' +
        'entries only. Deterministic, so the app may cache it for offline display.',
      // The entry is in hand — no need to read it again.
      resolve: (r, _args, ctx) => (ctx.actor ? registration.checkInTokenFor(ctx.actor, r) : null),
    }),
    checkedInAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.checkedInAt }),
    seed: t.int({ nullable: true, description: 'Set at draw time.', resolve: (r) => r.seed }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    confirmedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.confirmedAt }),
  }),
});

const InviteRef = builder.objectRef<Invite>('PartnerInvite').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    invitedEmail: t.string({
      nullable: true,
      description: 'R22 — null for a shareable link, which is addressed to nobody.',
      resolve: (i) => i.invitedEmail,
    }),
    invitedUserId: t.id({ nullable: true, resolve: (i) => i.invitedUserId }),
    /**
     * Returned to the CAPTAIN so the app can share the deep link (registration
     * R12). It is a bearer credential for one seat, which is why nothing but a
     * participant of this registration can read it.
     */
    token: t.string({ nullable: true, resolve: (i) => i.token || null }),
    status: t.exposeString('status'),
    expiresAt: t.field({ type: 'DateTime', resolve: (i) => i.expiresAt }),
  }),
});

const RosterPlayerRef = builder
  .objectRef<{ userId: string; displayName: string; checkedInAt?: Date | null }>('RosterPlayer')
  .implement({
    fields: (t) => ({
      userId: t.exposeID('userId'),
      displayName: t.exposeString('displayName'),
      checkedInAt: t.field({
        type: 'DateTime',
        nullable: true,
        description: 'R24 — this player’s own check-in.',
        resolve: (p) => p.checkedInAt ?? null,
      }),
    }),
  });

const RosterEntryRef = builder.objectRef<RosterEntry>('RosterEntry').implement({
  description:
    'registration R13 — one row of the offline check-in roster. Carries a HASH of the QR ' +
    'token, never the token: hash a scan with sha256 and look it up.',
  fields: (t) => ({
    registrationId: t.exposeID('registrationId'),
    eventCategoryId: t.exposeID('eventCategoryId'),
    status: t.field({ type: RegistrationStatusEnum, resolve: (e) => e.status }),
    tokenHash: t.exposeString('tokenHash'),
    players: t.field({ type: [RosterPlayerRef], resolve: (e) => e.players }),
    checkedInAt: t.field({ type: 'DateTime', nullable: true, resolve: (e) => e.checkedInAt }),
  }),
});

// --- payloads ----------------------------------------------------------------

const RegistrationPayload = builder
  .objectRef<{ registration: Registration | null; userError: UserErrorShape | null }>(
    'RegistrationPayload',
  )
  .implement({
    fields: (t) => ({
      registration: t.field({
        type: RegistrationRef,
        nullable: true,
        resolve: (p) => p.registration,
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const InvitePayload = builder
  .objectRef<{ invite: Invite | null; userError: UserErrorShape | null }>('InvitePartnerPayload')
  .implement({
    fields: (t) => ({
      invite: t.field({ type: InviteRef, nullable: true, resolve: (p) => p.invite }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ------------------------------------------------------------------

const BeginRegistrationInput = builder.inputType('BeginRegistrationInput', {
  fields: (t) => ({
    eventCategoryId: t.id({ required: true }),
    teamName: t.string({ description: 'R21 — a team draw: the team’s name (2–40 letters), when the host asks for one.' }),
  }),
});

const InvitePartnerInput = builder.inputType('InvitePartnerInput', {
  description:
    'registration R12 — prefer `playerId` (a PlayerProfile id, straight from in-app search). ' +
    '`playerUserId` is kept for callers that already hold a user id. `email` is the fallback ' +
    'for a partner with no account, and it is the friction most likely to cost a doubles entry.',
  fields: (t) => ({
    registrationId: t.id({ required: true }),
    playerId: t.id(),
    playerUserId: t.id(),
    email: t.string(),
    replacesUserId: t.id({ description: 'R25 — accepting takes this teammate’s place on the team.' }),
  }),
});

// --- queries -----------------------------------------------------------------

const cursorFor = (r: Registration): string =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`, 'utf8').toString('base64url');

builder.queryFields((t) => ({
  myRegistrations: t.field({
    type: [RegistrationRef],
    description: 'Everything the viewer has entered, as captain or as partner.',
    resolve: (_root, _args, ctx) => registration.listForUser(requireActor(ctx).userId),
  }),

  registration: t.field({
    type: RegistrationRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const found = await registration.findById(args.id);
      if (!found) return null;
      // Reading somebody else's entry is FORBIDDEN, not "not found": by this
      // point we already know it exists, and pretending otherwise would make
      // the organizer view lie to its own staff.
      const mine = await registration.listForUser(actor.userId);
      if (mine.some((r) => r.id === found.id)) return found;
      // The event's staff open an entry from the desk or the entry list.
      const staff = await staffActor(ctx);
      const ok = await events
        .assertStaff(staff, found.eventId, ['owner', 'manager', 'scorer'])
        .then(() => true, () => false);
      return ok ? found : null;
    },
  }),

  checkInRoster: t.field({
    type: [RosterEntryRef],
    description:
      'registration R13 — every confirmed entry, for scanning offline. Any staff grant on ' +
      'the event. Check-ins made offline replay through `checkInByToken`.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => registration.checkInRoster(requireActor(ctx), args.eventId),
  }),

  eventRegistrations: t.connection(
    {
      type: RegistrationRef,
      description: 'The organizer entry list. Requires a staff grant on the event.',
      args: {
        eventId: t.arg.id({ required: true }),
        categoryId: t.arg.id(),
        status: t.arg({ type: [RegistrationStatusEnum] }),
      },
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError(
            'BAD_USER_INPUT',
            'eventRegistrations supports forward pagination only',
          );
        }
        // F9 — PL4Y staff look up any event's entries (to refund one by hand).
        const platformStaff = (await ctx.loaders.platformRole.load(actor.userId)) !== null;
        const page = await registration.listForEvent(
          actor,
          args.eventId,
          {
            categoryId: args.categoryId ?? null,
            ...(args.status ? { status: args.status } : {}),
          },
          { first: clampFirst(args.first, 20), after: args.after ?? null },
          { platformStaff },
        );
        const edges = page.nodes.map((node) => ({ cursor: cursorFor(node), node }));
        return {
          edges,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: edges[0]?.cursor ?? null,
            endCursor: page.endCursor,
          },
        };
      },
    },
    { name: 'RegistrationConnection' },
    { name: 'RegistrationEdge' },
  ),
}));

// --- mutations ---------------------------------------------------------------

builder.mutationFields((t) => ({
  beginRegistration: t.field({
    type: RegistrationPayload,
    description:
      'Freezes the price and, for a singles draw, takes the seat. A doubles draw ' +
      'takes NO hold until a partner accepts (registration R2). A free draw is ' +
      'confirmed immediately (R18). CATEGORY_FULL means: offer `joinWaitlist` (R17).',
    args: { input: t.arg({ type: BeginRegistrationInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.begin(actor, {
          eventCategoryId: args.input.eventCategoryId,
          teamName: args.input.teamName ?? null,
        }),
      );
      return { registration: data, userError };
    },
  }),

  joinWaitlist: t.field({
    type: RegistrationPayload,
    description:
      'registration R17 — queue for a full draw. Holds no seat. A doubles team is queued ' +
      'when the partner accepts, so for doubles this returns a DRAFT to invite from.',
    args: { eventCategoryId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.joinWaitlist(actor, { eventCategoryId: args.eventCategoryId }),
      );
      return { registration: data, userError };
    },
  }),

  leaveWaitlist: t.field({
    type: RegistrationPayload,
    args: { registrationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.leaveWaitlist(actor, args.registrationId),
      );
      return { registration: data, userError };
    },
  }),

  invitePartner: t.field({
    type: InvitePayload,
    args: { input: t.arg({ type: InvitePartnerInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.invitePartner(actor, {
          registrationId: args.input.registrationId,
          playerId: args.input.playerId ?? null,
          playerUserId: args.input.playerUserId ?? null,
          email: args.input.email ?? null,
          replacesUserId: args.input.replacesUserId ?? null,
        }),
      );
      return { invite: data, userError };
    },
  }),

  addTeammate: t.field({
    type: RegistrationPayload,
    description:
      'Teammate registration — the captain enters a teammate who has a PL4Y account (a ' +
      'PlayerProfile id from in-app search) and pays for the team; no invite to accept. ' +
      'When the team is whole the seat is held for payment (PAYMENT_PENDING), or the team ' +
      'joins the waitlist if the draw is full. Once paid, the QR ticket shows on every ' +
      'teammate’s own login. A teammate with no account is still invited by email.',
    args: {
      registrationId: t.arg.id({ required: true }),
      playerId: t.arg.id({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.addTeammate(actor, {
          registrationId: String(args.registrationId),
          playerId: String(args.playerId),
        }),
      );
      return { registration: data, userError };
    },
  }),

  acceptPartnerInvite: t.field({
    type: RegistrationPayload,
    description:
      'Where the team becomes real, and therefore where a seat is taken — or, when the ' +
      'draw filled meanwhile, where the team joins the waitlist (R17).',
    args: { token: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.acceptInvite(actor, args.token),
      );
      return { registration: data, userError };
    },
  }),

  declinePartnerInvite: t.field({
    type: RegistrationPayload,
    args: { token: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => registration.declineInvite(actor, args.token));
      return { registration: null, userError };
    },
  }),

  cancelRegistration: t.field({
    type: RegistrationPayload,
    description:
      'registration R9 — after the cancellation cutoff this refunds nothing but ' +
      'still returns the slot to the draw.',
    args: { registrationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.cancel(actor, args.registrationId),
      );
      return { registration: data, userError };
    },
  }),

  removeRegistration: t.field({
    type: RegistrationPayload,
    description:
      'Owner or manager, before the draw is made. Takes one entry out of its draw; with ' +
      '`refund: true` the player gets back everything they paid, platform fee included.',
    args: {
      registrationId: t.arg.id({ required: true }),
      refund: t.arg.boolean({ required: true }),
      reason: t.arg.string({ description: 'PL4Y staff in the portal must give one; it goes in the audit log.' }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(async () => {
        const found = await registration.findById(String(args.registrationId));
        const what = {
          action: 'registration.remove',
          targetType: 'event',
          targetId: found?.eventId ?? '',
          details: { registrationId: String(args.registrationId) },
        } as const;
        return auditedWhenStaff(actor, what, args.reason, () =>
          registration.removeEntry(actor, String(args.registrationId), { refund: args.refund }),
        );
      });
      return { registration: data, userError };
    },
  }),

  addOfflineRegistration: t.field({
    type: RegistrationPayload,
    description:
      'Owner or manager. Seats a player who paid at the desk (OFFLINE) or plays free (COMP), ' +
      'until the draw is made. F20 — by account email, or by name with no account (a guest); ' +
      'a doubles walk-in names both players; a team walk-in names its captain, and optionally ' +
      'its name and teammates (N14). No money moves through PL4Y for it.',
    args: {
      eventCategoryId: t.arg.id({ required: true }),
      email: t.arg.string(),
      guestName: t.arg.string(),
      partnerEmail: t.arg.string(),
      partnerName: t.arg.string(),
      teamName: t.arg.string({ description: 'N14 — a team walk-in: the team’s name (optional).' }),
      teammates: t.arg.stringList({
        description: 'N14 — a team walk-in: the other players, each an account email or a name. Up to team size − 1.',
      }),
      mode: t.arg({ type: PaymentModeEnum, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(async () => {
        if (args.mode === 'online') {
          throw new UserError(RegistrationCode.REGISTRATION_NOT_FOUND, 'Choose cash or free.');
        }
        return registration.addOfflineEntry(actor, {
          eventCategoryId: String(args.eventCategoryId),
          email: args.email ?? null,
          guestName: args.guestName ?? null,
          partnerEmail: args.partnerEmail ?? null,
          partnerName: args.partnerName ?? null,
          teamName: args.teamName ?? null,
          teammates: args.teammates ?? null,
          mode: args.mode,
        });
      });
      return { registration: data, userError };
    },
  }),

  checkIn: t.field({
    type: RegistrationPayload,
    description:
      'registration R10, F13 — open from two hours before the start until the end. Staff on ' +
      'the event check anyone in; an entrant checks themselves in only within a kilometre ' +
      'of the event (send `at`, the phone location).',
    args: {
      registrationId: t.arg.id({ required: true }),
      at: t.arg({ type: GeoPointInput }),
      userIds: t.arg.idList({ description: 'R24 — staff only: which players. Omitted: everyone on the entry.' }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.checkIn(
          actor,
          args.registrationId,
          args.at ? { lat: args.at.lat, lng: args.at.lng } : null,
          args.userIds ? args.userIds.map(String) : null,
        ),
      );
      return { registration: data, userError };
    },
  }),

  checkInByToken: t.field({
    type: RegistrationPayload,
    description:
      'registration R13 — a staff scan of an entrant’s QR. Idempotent: a re-scan returns ' +
      'the entry with its original check-in time.',
    args: { token: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.checkInByToken(actor, args.token),
      );
      return { registration: data, userError };
    },
  }),
}));

// --- R21–R27: teams, per-player check-in, history ------------------------------

const PaymentStatusEnum = builder.enumType('RegistrationPaymentStatus', {
  description: 'R27 — the money, apart from the entry: a paid entry can still be waiting for its teammate.',
  values: {
    NOT_DUE: { value: 'not_due' as PaymentStatus },
    PENDING: { value: 'pending' as PaymentStatus },
    FAILED: { value: 'failed' as PaymentStatus },
    PAID: { value: 'paid' as PaymentStatus },
    FREE: { value: 'free' as PaymentStatus },
    OFFLINE: { value: 'offline' as PaymentStatus, description: 'Paid at the desk, not through PL4Y.' },
    REFUND_PENDING: { value: 'refund_pending' as PaymentStatus },
    REFUNDED: { value: 'refunded' as PaymentStatus },
  },
});

const CheckInStateEnum = builder.enumType('CheckInState', {
  values: {
    NONE: { value: 'none' as CheckInState },
    PARTIAL: { value: 'partial' as CheckInState, description: 'R24 — some players on the entry have arrived.' },
    ALL: { value: 'all' as CheckInState },
  },
});

const TeamStatusEnum = builder.enumType('TeamStatus', {
  values: {
    SOLO: { value: 'solo' as const, description: 'A singles entry.' },
    TEAMMATE_PENDING: { value: 'teammate_pending' as const, description: 'Fewer players than the team needs.' },
    COMPLETE: { value: 'complete' as const },
  },
});

const RegistrationMemberRef = builder.objectRef<RegistrationMember>('RegistrationMember').implement({
  description: 'R24, R27 — one player on an entry.',
  fields: (t) => ({
    userId: t.exposeID('userId'),
    isCaptain: t.exposeBoolean('isCaptain'),
    displayName: t.string({
      resolve: async (m, _args, ctx) => (await ctx.loaders.userBrief.load(m.userId))?.displayName ?? 'Player',
    }),
    checkedInAt: t.field({ type: 'DateTime', nullable: true, resolve: (m) => m.checkedInAt }),
  }),
});

const HistoryEntryRef = builder.objectRef<HistoryEntry>('RegistrationHistoryEntry').implement({
  description: 'R26 — one change to an entry: who made it, when and why.',
  fields: (t) => ({
    id: t.exposeID('id'),
    kind: t.exposeString('kind'),
    actorName: t.string({
      nullable: true,
      resolve: async (h, _args, ctx) => (h.actorUserId ? ((await ctx.loaders.userBrief.load(h.actorUserId))?.displayName ?? null) : null),
    }),
    subjectName: t.string({
      nullable: true,
      resolve: async (h, _args, ctx) =>
        h.subjectUserId ? ((await ctx.loaders.userBrief.load(h.subjectUserId))?.displayName ?? null) : null,
    }),
    reason: t.string({ nullable: true, resolve: (h) => h.reason }),
    createdAt: t.field({ type: 'DateTime', resolve: (h) => h.createdAt }),
  }),
});

const TeamStatsRef = builder.objectRef<TeamStats>('TeamRegistrationStats').implement({
  description: 'R11 — the organiser dashboard numbers for an event.',
  fields: (t) => ({
    teamSlots: t.exposeInt('teamSlots'),
    paidEntries: t.exposeInt('paidEntries'),
    completeTeams: t.exposeInt('completeTeams'),
    awaitingTeammates: t.exposeInt('awaitingTeammates'),
    declinedInvites: t.exposeInt('declinedInvites'),
    cancelled: t.exposeInt('cancelled'),
    refundPending: t.exposeInt('refundPending'),
    refunded: t.exposeInt('refunded'),
    participants: t.exposeInt('participants'),
    checkedInTeams: t.exposeInt('checkedInTeams'),
    partiallyCheckedInTeams: t.exposeInt('partiallyCheckedInTeams'),
    checkedInParticipants: t.exposeInt('checkedInParticipants'),
  }),
});

const InviteDetailsRef = builder.objectRef<InviteDetails>('PartnerInviteDetails').implement({
  description: 'R22 — what an invited player sees before deciding. Nothing about payment.',
  fields: (t) => ({
    id: t.exposeID('inviteId'),
    token: t.exposeString('token'),
    status: t.exposeString('status', { description: 'pending | accepted | declined | expired | revoked' }),
    expiresAt: t.field({ type: 'DateTime', resolve: (d) => d.expiresAt }),
    canAccept: t.exposeBoolean('canAccept'),
    registrationId: t.exposeID('registrationId'),
    registrationStatus: t.field({ type: RegistrationStatusEnum, resolve: (d) => d.registrationStatus }),
    teamName: t.string({ nullable: true, resolve: (d) => d.teamName }),
    captainName: t.string({
      resolve: async (d, _args, ctx) => (await ctx.loaders.userBrief.load(d.captainUserId))?.displayName ?? 'A player',
    }),
    replacesName: t.string({
      nullable: true,
      description: 'R25 — the teammate this player would take the place of.',
      resolve: async (d, _args, ctx) =>
        d.replacesUserId ? ((await ctx.loaders.userBrief.load(d.replacesUserId))?.displayName ?? null) : null,
    }),
    event: t.field({
      type: EventRef,
      resolve: async (d, _args, ctx) => (await ctx.loaders.event.load(d.eventId)) ?? events.byId(d.eventId),
    }),
    category: t.field({
      type: EventCategoryRef,
      resolve: async (d, _args, ctx) =>
        (await ctx.loaders.category.load(d.eventCategoryId)) ?? events.categoryById(d.eventCategoryId),
    }),
  }),
});

/** Request-scoped: a registration's players, read once however many fields ask. */
const membersOf = (r: Registration): Promise<RegistrationMember[]> =>
  memo(`reg:members:${r.id}`, async () => (await registration.membersFor([r])).get(r.id) ?? []);

const teamStatusOf = async (r: Registration): Promise<'solo' | 'teammate_pending' | 'complete'> => {
  const category = await events.categoryById(r.eventCategoryId);
  if (category.teamSize <= 1) return 'solo';
  const { min } = registration.teamSizesFor(category);
  return (await membersOf(r)).length >= min ? 'complete' : 'teammate_pending';
};

builder.objectFields(RegistrationRef, (t) => ({
  reference: t.string({
    description: 'R27 — a short reference to read out at the desk (PL4Y-3F9A-12C0). Not a credential.',
    resolve: (r) => referenceFor(r.id),
  }),
  teamName: t.string({
    nullable: true,
    resolve: (r) => (r.teamId ? memo(`reg:teamname:${r.id}`, () => registration.teamNameFor(r.id)) : null),
  }),
  members: t.field({
    type: [RegistrationMemberRef],
    description: 'R24 — everyone on the entry, captain first, each with their own check-in.',
    resolve: async (r) => [...(await membersOf(r))].sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain)),
  }),
  teamStatus: t.field({ type: TeamStatusEnum, resolve: (r) => teamStatusOf(r) }),
  openSpots: t.int({
    description: 'R21 — players the team can still add before it is full.',
    resolve: async (r) => {
      const category = await events.categoryById(r.eventCategoryId);
      if (category.teamSize <= 1) return 0;
      return Math.max(registration.teamSizesFor(category).max - (await membersOf(r)).length, 0);
    },
  }),
  checkInState: t.field({
    type: CheckInStateEnum,
    resolve: async (r) => registration.checkInStateOf(r, await membersOf(r)),
  }),
  paymentStatus: t.field({
    type: PaymentStatusEnum,
    resolve: async (r) => {
      const needsRefund = r.status === 'refunded' || r.status === 'withdrawn';
      const state = needsRefund ? ((await registration.refundStatesFor([r.id])).get(r.id) ?? null) : null;
      return registration.paymentStatusOf(r, state);
    },
  }),
  invites: t.field({
    type: [InviteRef],
    description:
      'R22 — the entry’s invites, newest first. The captain sees the links (`token`); the team and the ' +
      'event’s staff see who was asked and what they said.',
    resolve: async (r, _args, ctx) => {
      const actor = requireActor(ctx);
      const isCaptain = r.captainUserId === actor.userId;
      try {
        const list = await registration.invitesFor(actor, r.id);
        return isCaptain ? list : list.map((i) => ({ ...i, token: '' }));
      } catch {
        // Not on the team: the event's staff still see the invite states.
        const staff = await staffActor(ctx);
        await events.assertStaff(staff, r.eventId, ['owner', 'manager', 'scorer']).catch(() => {
          throw forbidden();
        });
        return (await registration.invitesForStaff(r.id)).map((i) => ({ ...i, token: '' }));
      }
    },
  }),
  history: t.field({
    type: [HistoryEntryRef],
    description: 'R26 — every change to this entry, oldest first. The team and the event’s staff.',
    resolve: async (r, _args, ctx) => {
      const actor = await staffActor(ctx);
      return registration.historyOf(actor, r.id, { platformStaff: actor.platformStaff });
    },
  }),
}));

builder.objectFields(InviteRef, (t) => ({
  invitedName: t.string({
    nullable: true,
    resolve: async (i, _args, ctx) =>
      i.invitedUserId ? ((await ctx.loaders.userBrief.load(i.invitedUserId))?.displayName ?? null) : null,
  }),
  isLink: t.boolean({
    description: 'R22 — a shareable link, addressed to nobody until somebody accepts it.',
    resolve: (i) => !i.invitedEmail && !i.invitedUserId,
  }),
  replacesUserId: t.id({ nullable: true, resolve: (i) => i.replacesUserId ?? null }),
  sentCount: t.int({ resolve: (i) => i.sentCount ?? 1 }),
  lastSentAt: t.field({ type: 'DateTime', nullable: true, resolve: (i) => i.lastSentAt ?? null }),
  createdAt: t.field({ type: 'DateTime', nullable: true, resolve: (i) => i.createdAt ?? null }),
}));

/**
 * Portal staff (admin, support) act on any event as its owner would; anyone
 * else, and staff on their phone, is themselves.
 */
async function staffActor(ctx: Ctx): Promise<{ userId: string; platformStaff: boolean }> {
  const actor = requireActor(ctx);
  if (actor.client !== 'portal') return { userId: actor.userId, platformStaff: false };
  const role = await ctx.loaders.platformRole.load(actor.userId);
  return { userId: actor.userId, platformStaff: role === 'admin' || role === 'support' };
}

const STAFF_REASON = 'PL4Y staff in the portal must give one (5 characters or more); it goes in the audit log.';

const CheckInLookupPayload = builder
  .objectRef<{ registration: Registration | null; userError: UserErrorShape | null }>('CheckInLookupPayload')
  .implement({
    fields: (t) => ({
      registration: t.field({ type: RegistrationRef, nullable: true, resolve: (p) => p.registration }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  partnerInvite: t.field({
    type: InviteDetailsRef,
    nullable: true,
    description: 'R22 — the invite a link carries: event, team and captain. Null when it is not for this account.',
    args: { token: t.arg.string({ required: true }) },
    resolve: (_root, args, ctx) => registration.inviteDetails(requireActor(ctx), args.token),
  }),
  myPartnerInvites: t.field({
    type: [InviteDetailsRef],
    description: 'R22 — invites waiting for the viewer’s answer.',
    resolve: (_root, _args, ctx) => registration.myPendingInvites(requireActor(ctx)),
  }),
  checkInLookup: t.field({
    type: CheckInLookupPayload,
    description:
      'R24 — a staff scan that only reads: the entry, its players and who has arrived. Then check players ' +
      'in with `checkInPlayers`. Any staff grant on the event.',
    args: { token: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(() => registration.checkInLookup(actor, args.token));
      return { registration: data, userError };
    },
  }),
  teamRegistrationStats: t.field({
    type: TeamStatsRef,
    description: 'R11 — the dashboard numbers for an event’s entries and teams. Staff on the event.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      return registration.teamStats(actor, String(args.eventId), { platformStaff: actor.platformStaff });
    },
  }),
}));

builder.mutationFields((t) => ({
  createInviteLink: t.field({
    type: InvitePayload,
    description:
      'R22 — a link to share on WhatsApp, addressed to nobody: the first signed-in player to accept it ' +
      'joins. Asking again returns the same open link. With `replacesUserId`, accepting takes that ' +
      'teammate’s place (R25).',
    args: { registrationId: t.arg.id({ required: true }), replacesUserId: t.arg.id() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.createInviteLink(actor, {
          registrationId: String(args.registrationId),
          replacesUserId: args.replacesUserId ? String(args.replacesUserId) : null,
        }),
      );
      return { invite: data, userError };
    },
  }),

  resendPartnerInvite: t.field({
    type: InvitePayload,
    description: 'R22 — send an open invite again (once a minute). An expired one is replaced by a new invite.',
    args: { inviteId: t.arg.id({ required: true }), reason: t.arg.string({ description: STAFF_REASON }) },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.resendInvite(actor, String(args.inviteId), { reason: args.reason ?? null }),
      );
      return { invite: data, userError };
    },
  }),

  revokePartnerInvite: t.field({
    type: InvitePayload,
    description: 'R22 — the captain takes back an invite nobody has answered.',
    args: { inviteId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => registration.revokeInvite(actor, String(args.inviteId)));
      return { invite: data, userError };
    },
  }),

  setTeamName: t.field({
    type: RegistrationPayload,
    description: 'R21 — the captain names the team (2–40 letters) until the roster locks. Null clears it.',
    args: { registrationId: t.arg.id({ required: true }), name: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.setTeamName(actor, String(args.registrationId), args.name ?? null),
      );
      return { registration: data, userError };
    },
  }),

  removeTeammate: t.field({
    type: RegistrationPayload,
    description:
      'R25 — the captain takes a teammate who cannot play off a paid team, so the spot opens again. ' +
      'The entry, its payment and its QR stay.',
    args: { registrationId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.removeTeammate(actor, { registrationId: String(args.registrationId), userId: String(args.userId) }),
      );
      return { registration: data, userError };
    },
  }),

  checkInPlayers: t.field({
    type: RegistrationPayload,
    description:
      'R24 — staff check in some of an entry’s players (`userIds`), or all of them (omit it). A player ' +
      'already in keeps their original time; nobody is checked in twice.',
    args: {
      registrationId: t.arg.id({ required: true }),
      userIds: t.arg.idList(),
      viaQr: t.arg.boolean({ description: 'The desk found this entry by scanning its QR.' }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.checkInMembers(
          actor,
          String(args.registrationId),
          args.userIds ? args.userIds.map(String) : null,
          { method: args.viaQr ? 'qr' : 'staff' },
        ),
      );
      return { registration: data, userError };
    },
  }),

  staffAddTeamMember: t.field({
    type: RegistrationPayload,
    description:
      'R25, R26 — an owner or manager (or PL4Y staff) puts a PL4Y player on a team directly, optionally ' +
      'in place of a teammate (`replacesUserId`). A reason is required and kept in the history.',
    args: {
      registrationId: t.arg.id({ required: true }),
      playerId: t.arg.id(),
      email: t.arg.string(),
      replacesUserId: t.arg.id(),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(async () => {
        const found = await registration.findById(String(args.registrationId));
        const what = {
          action: 'registration.member_add',
          targetType: 'event',
          targetId: found?.eventId ?? '',
          details: { registrationId: String(args.registrationId), replacesUserId: args.replacesUserId ?? null },
        } as const;
        return auditedWhenStaff(actor, what, args.reason, () =>
          registration.staffAddMember(
            actor,
            {
              registrationId: String(args.registrationId),
              playerId: args.playerId ? String(args.playerId) : null,
              email: args.email ?? null,
              replacesUserId: args.replacesUserId ? String(args.replacesUserId) : null,
              reason: args.reason,
            },
            { platformStaff: actor.platformStaff },
          ),
        );
      });
      return { registration: data, userError };
    },
  }),

  staffRemoveTeamMember: t.field({
    type: RegistrationPayload,
    description: 'R25, R26 — staff take a teammate (never the captain) off a team. The entry and its payment stay.',
    args: {
      registrationId: t.arg.id({ required: true }),
      userId: t.arg.id({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await staffActor(ctx);
      const { data, userError } = await attempt(async () => {
        const found = await registration.findById(String(args.registrationId));
        const what = {
          action: 'registration.member_remove',
          targetType: 'event',
          targetId: found?.eventId ?? '',
          details: { registrationId: String(args.registrationId), userId: String(args.userId) },
        } as const;
        return auditedWhenStaff(actor, what, args.reason, () =>
          registration.staffRemoveMember(
            actor,
            { registrationId: String(args.registrationId), userId: String(args.userId), reason: args.reason },
            { platformStaff: actor.platformStaff },
          ),
        );
      });
      return { registration: data, userError };
    },
  }),
}));

export { PaymentModeEnum, RegistrationRef, RegistrationStatusEnum };
