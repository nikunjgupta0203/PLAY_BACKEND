/**
 * notifications — GraphQL surface (docs/modules/11-notifications.md).
 *
 * The doc types `Notification.deepLink` as `Node`. It is `target` here — a
 * kind, an id, and the slug an event is actually routed by — for two reasons:
 * the player app routes events by slug, not id, so a bare Node id cannot open
 * the screen without a second query; and Venue does not implement Node (G16),
 * so a venue notification would have nowhere to point. The closed enum of
 * route targets (R10) is kept exactly.
 *
 * R8 — every read and write is the actor's own. There is no user id argument
 * anywhere in this file.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { SystemError } from '../../../platform/errors/index.js';
import { notifications, TEMPLATES } from '../index.js';
import type { DeepLinkRoute, Notification, Preferences, Target, TemplateKey } from '../index.js';

const TargetKindEnum = builder.enumType('NotificationTargetKind', {
  values: {
    EVENT: { value: 'event' },
    MATCH: { value: 'match' },
    PLAYER: { value: 'player' },
    VENUE: { value: 'venue' },
    GAME: { value: 'game' },
    COMMUNITY: { value: 'community' },
    ROUTE: { value: 'route' },
  } as const,
});

const DeepLinkRouteEnum = builder.enumType('DeepLinkRoute', {
  description: 'R10 — non-entity screens. Closed: a new route is a reviewed schema change.',
  values: {
    PAYMENT_HISTORY: { value: 'payment_history' as DeepLinkRoute },
    ORGANIZER_PAYOUTS: { value: 'organizer_payouts' as DeepLinkRoute },
    ORGANIZER_DASHBOARD: { value: 'organizer_dashboard' as DeepLinkRoute },
    SUPPORT_TICKET: { value: 'support_ticket' as DeepLinkRoute },
    CONVERSATION: { value: 'conversation' as DeepLinkRoute },
    ORGANISATION: { value: 'organisation' as DeepLinkRoute },
    COURT_BOOKING: { value: 'court_booking' as DeepLinkRoute },
    EVENT_DRAW: { value: 'event_draw' as DeepLinkRoute },
  },
});

const TemplateKeyEnum = builder.enumType('NotificationKind', {
  description: 'What a notification is about. Muting one silences its push, never its feed row (R2).',
  values: Object.fromEntries(
    (Object.keys(TEMPLATES) as TemplateKey[]).map((k) => [k.replace(/[.]/g, '_').toUpperCase(), { value: k }]),
  ) as Record<string, { value: TemplateKey }>,
});

const TargetRef = builder.objectRef<Target>('NotificationTarget').implement({
  description: 'Where tapping the notification goes. A client that does not know the kind renders the row untappable.',
  fields: (t) => ({
    kind: t.field({ type: TargetKindEnum, resolve: (x) => x.kind }),
    id: t.id({ nullable: true, resolve: (x) => (x.kind === 'route' ? (x.id ?? null) : x.id) }),
    slug: t.string({
      nullable: true,
      description: 'Events are routed by slug.',
      resolve: (x) => (x.kind === 'event' ? x.slug : null),
    }),
    route: t.field({
      type: DeepLinkRouteEnum,
      nullable: true,
      resolve: (x) => (x.kind === 'route' ? x.route : null),
    }),
  }),
});

const NotificationRef = builder.objectRef<Notification>('Notification').implement({
  description:
    'R4 — `title` and `body` are rendered on the server from versioned templates. ' +
    'R11 — `body` may carry user-written text: render it as plain text, never markup.',
  fields: (t) => ({
    id: t.exposeID('id'),
    kind: t.string({ resolve: (n) => n.template }),
    title: t.exposeString('title'),
    body: t.exposeString('body'),
    target: t.field({ type: TargetRef, nullable: true, resolve: (n) => n.target }),
    readAt: t.field({ type: 'DateTime', nullable: true, resolve: (n) => n.readAt }),
    createdAt: t.field({ type: 'DateTime', resolve: (n) => n.createdAt }),
  }),
});

const PreferencesRef = builder.objectRef<Preferences>('NotificationPreferences').implement({
  description:
    'R2 — these gate PUSH only. The feed row is written whatever they say. R3 — quiet hours are ' +
    '22:00–07:00 IST; a match starting soon is pushed through them.',
  fields: (t) => ({
    pushEnabled: t.exposeBoolean('pushEnabled'),
    muted: t.field({ type: [TemplateKeyEnum], resolve: (p) => p.muted }),
    quietHours: t.exposeBoolean('quietHours'),
  }),
});

// --- queries -----------------------------------------------------------------

builder.queryFields((t) => ({
  notifications: t.connection(
    {
      type: NotificationRef,
      args: {},
      resolve: async (_root, args, ctx) => {
        const actor = requireActor(ctx);
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'notifications supports forward pagination only');
        }
        const page = await notifications.feed(actor, {
          first: clampFirst(args.first, 20),
          after: args.after ?? null,
        });
        return {
          edges: page.edges,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            hasPreviousPage: args.after != null,
            startCursor: page.edges[0]?.cursor ?? null,
            endCursor: page.edges.at(-1)?.cursor ?? null,
          },
        };
      },
    },
    { name: 'NotificationConnection' },
    { name: 'NotificationEdge' },
  ),

  unreadNotificationCount: t.int({
    description: 'The badge. Never derive it from the feed, which is only ever the first page.',
    resolve: (_root, _args, ctx) => notifications.unreadCount(requireActor(ctx)),
  }),

  notificationPreferences: t.field({
    type: PreferencesRef,
    resolve: (_root, _args, ctx) => notifications.preferences(requireActor(ctx)),
  }),
}));

// --- payloads & inputs -------------------------------------------------------

const MarkReadPayload = builder
  .objectRef<{ unreadCount: number; userError: UserErrorShape | null }>('MarkReadPayload')
  .implement({
    fields: (t) => ({
      unreadCount: t.exposeInt('unreadCount'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RegisterDevicePayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('RegisterDevicePayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const PreferencesPayload = builder
  .objectRef<{ preferences: Preferences | null; userError: UserErrorShape | null }>('PreferencesPayload')
  .implement({
    fields: (t) => ({
      preferences: t.field({ type: PreferencesRef, nullable: true, resolve: (p) => p.preferences }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const DevicePlatformEnum = builder.enumType('DevicePlatform', {
  values: { IOS: { value: 'ios' }, ANDROID: { value: 'android' }, WEB: { value: 'web' } } as const,
});

const RegisterDeviceInput = builder.inputType('RegisterDeviceInput', {
  fields: (t) => ({
    token: t.string({ required: true, description: 'An Expo push token.' }),
    platform: t.field({ type: DevicePlatformEnum, required: true }),
  }),
});

const PreferencesInput = builder.inputType('NotificationPreferencesInput', {
  description: 'Omitted fields are left as they are.',
  fields: (t) => ({
    pushEnabled: t.boolean(),
    muted: t.field({ type: [TemplateKeyEnum] }),
    quietHours: t.boolean(),
  }),
});

// --- mutations ---------------------------------------------------------------

builder.mutationFields((t) => ({
  markNotificationsRead: t.field({
    type: MarkReadPayload,
    description: 'At most 100 ids. Ids that are not the viewer’s are ignored (R8).',
    args: { ids: t.arg.idList({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const unreadCount = await notifications.markRead(actor, args.ids.map(String));
      return { unreadCount, userError: null };
    },
  }),

  markAllNotificationsRead: t.field({
    type: MarkReadPayload,
    resolve: async (_root, _args, ctx) => {
      const unreadCount = await notifications.markAllRead(requireActor(ctx));
      return { unreadCount, userError: null };
    },
  }),

  registerDevice: t.field({
    type: RegisterDevicePayload,
    description: 'Idempotent. Clients call it on every cold start with permission granted — tokens rotate.',
    args: { input: t.arg({ type: RegisterDeviceInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        notifications.registerDevice(actor, { token: args.input.token, platform: args.input.platform }),
      );
      return { ok: userError === null, userError };
    },
  }),

  unregisterDevice: t.field({
    type: RegisterDevicePayload,
    description: 'Sign-out calls this so the next user of the phone does not get this user’s pushes.',
    args: { token: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await notifications.unregisterDevice(requireActor(ctx), args.token);
      return { ok: true, userError: null };
    },
  }),

  setNotificationPreferences: t.field({
    type: PreferencesPayload,
    args: { input: t.arg({ type: PreferencesInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        notifications.setPreferences(actor, {
          pushEnabled: args.input.pushEnabled ?? undefined,
          muted: args.input.muted ?? undefined,
          quietHours: args.input.quietHours ?? undefined,
        }),
      );
      return { preferences: data, userError };
    },
  }),
}));
