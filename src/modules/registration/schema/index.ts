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
import { SystemError, UserError } from '../../../platform/errors/index.js';
import { events } from '../../events/index.js';
import { EventCategoryRef, EventRef } from '../../events/schema/index.js';
import { RegistrationCode, registration } from '../index.js';
import { entrantName } from '../service/entrantName.js';
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
    event: t.field({ type: EventRef, resolve: (r) => events.byId(r.eventId) }),
    category: t.field({
      type: EventCategoryRef,
      resolve: (r) => events.categoryById(r.eventCategoryId),
    }),
    status: t.field({ type: RegistrationStatusEnum, resolve: (r) => r.status }),
    displayName: t.string({
      description: 'How the entry reads on a bracket or standings: "Asha", "Asha & Meera", "Asha + 4".',
      resolve: async (r) => {
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
      resolve: (r, _args, ctx) => (ctx.actor ? registration.checkInToken(ctx.actor, r.id) : null),
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
    invitedEmail: t.exposeString('invitedEmail'),
    invitedUserId: t.id({ nullable: true, resolve: (i) => i.invitedUserId }),
    /**
     * Returned to the CAPTAIN so the app can share the deep link (registration
     * R12). It is a bearer credential for one seat, which is why nothing but a
     * participant of this registration can read it.
     */
    token: t.exposeString('token'),
    status: t.exposeString('status'),
    expiresAt: t.field({ type: 'DateTime', resolve: (i) => i.expiresAt }),
  }),
});

const RosterPlayerRef = builder
  .objectRef<{ userId: string; displayName: string }>('RosterPlayer')
  .implement({
    fields: (t) => ({
      userId: t.exposeID('userId'),
      displayName: t.exposeString('displayName'),
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
      return mine.some((r) => r.id === found.id) ? found : null;
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
        registration.begin(actor, { eventCategoryId: args.input.eventCategoryId }),
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
        }),
      );
      return { invite: data, userError };
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
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.removeEntry(actor, String(args.registrationId), { refund: args.refund }),
      );
      return { registration: data, userError };
    },
  }),

  addOfflineRegistration: t.field({
    type: RegistrationPayload,
    description:
      'Owner or manager. Seats a player who paid at the desk (OFFLINE) or plays free (COMP), ' +
      'until the draw is made. F20 — by account email, or by name with no account (a guest); ' +
      'a doubles walk-in names both players. No money moves through PL4Y for it.',
    args: {
      eventCategoryId: t.arg.id({ required: true }),
      email: t.arg.string(),
      guestName: t.arg.string(),
      partnerEmail: t.arg.string(),
      partnerName: t.arg.string(),
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
    args: { registrationId: t.arg.id({ required: true }), at: t.arg({ type: GeoPointInput }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        registration.checkIn(actor, args.registrationId, args.at ? { lat: args.at.lat, lng: args.at.lng } : null),
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

export { PaymentModeEnum, RegistrationRef, RegistrationStatusEnum };
