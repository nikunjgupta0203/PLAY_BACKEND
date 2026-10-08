/**
 * chat — GraphQL surface (docs/superpowers/specs/2026-09-29-chat-design.md).
 *
 * Resolvers never touch Prisma (conventions.md §1). Every read is scoped to the
 * signed-in player: a conversation the viewer is not in, or has hidden (a
 * declined request, a blocked player), resolves to null rather than an error.
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { SystemError } from '../../../platform/errors/index.js';
import { PlayerProfileRef } from '../../profile/schema/index.js';
import { chat, EDIT_WINDOW_MS } from '../index.js';
import type { ChatMessage, ConversationView, Messaging, QuotedMessage } from '../index.js';

type ChatMessageNode = ChatMessage & { viewerId: string };
type QuotedMessageNode = QuotedMessage & { viewerId: string };

const ConversationStatusEnum = builder.enumType('ConversationStatus', {
  description:
    'chat R3 — a request becomes active when the other player accepts or replies. ' +
    'DECLINED is only ever shown to the sender (chat R10).',
  values: {
    REQUEST: { value: 'request' as const },
    ACTIVE: { value: 'active' as const },
    DECLINED: { value: 'declined' as const },
  },
});

const QuotedMessageRef = builder.objectRef<QuotedMessageNode>('QuotedMessage').implement({
  description: 'chat R13 — what a reply shows of the message it answers.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.string({ description: 'Empty once deleted (R12).', resolve: (m) => (m.deletedAt ? '' : m.body) }),
    fromViewer: t.boolean({ resolve: (m) => m.senderId === m.viewerId }),
    deleted: t.boolean({ resolve: (m) => m.deletedAt !== null }),
  }),
});

const MessageRef = builder.objectRef<ChatMessageNode>('Message').implement({
  description:
    'chat R9 — `body` is the sender’s own words: render as text, never markup. ' +
    'R11 — the sender may edit it for 15 minutes; R12 — or delete it for everyone.',
  fields: (t) => ({
    id: t.exposeID('id'),
    body: t.string({
      description: 'Empty once deleted (R12).',
      resolve: (m) => (m.deletedAt ? '' : m.body),
    }),
    sentAt: t.field({ type: 'DateTime', resolve: (m) => m.createdAt }),
    fromViewer: t.boolean({ resolve: (m) => m.senderId === m.viewerId }),
    editedAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'R11 — when the sender last edited it. Null when never edited, and once deleted.',
      resolve: (m) => (m.deletedAt ? null : m.editedAt),
    }),
    deleted: t.boolean({ description: 'R12 — deleted for everyone.', resolve: (m) => m.deletedAt !== null }),
    replyTo: t.field({
      type: QuotedMessageRef,
      nullable: true,
      description: 'R13 — the message this one answers.',
      resolve: async (m) => {
        const q = m.replyTo !== undefined ? m.replyTo : m.replyToId ? await chat.quoted(m.replyToId) : null;
        return q ? { ...q, viewerId: m.viewerId } : null;
      },
    }),
    editableUntil: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'R11 — your own message, not deleted: when editing closes. Null otherwise.',
      resolve: (m) =>
        m.senderId === m.viewerId && !m.deletedAt ? new Date(m.createdAt.getTime() + EDIT_WINDOW_MS) : null,
    }),
  }),
});

const MessageConnectionRef = builder.connectionObject(
  { type: MessageRef, name: 'MessageConnection' },
  { name: 'MessageEdge' },
);

const ConversationRef = builder.objectRef<ConversationView>('Conversation').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    other: t.field({
      type: PlayerProfileRef,
      nullable: true,
      resolve: (c, _args, ctx) => ctx.loaders.publicProfile.load(c.otherId),
    }),
    status: t.field({ type: ConversationStatusEnum, resolve: (c) => c.status }),
    isIncomingRequest: t.exposeBoolean('isIncomingRequest', {
      description: 'You are being asked. Accept, decline, or reply (which accepts).',
    }),
    canSend: t.exposeBoolean('canSend'),
    canResendAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'chat R10 — when you may send a new request after a decline. Null otherwise.',
      resolve: (c) => c.canResendAt,
    }),
    unreadCount: t.int({ resolve: (c, _args, ctx) => ctx.loaders.chatUnread.load(c) }),
    lastMessage: t.field({
      type: MessageRef,
      nullable: true,
      resolve: async (c, _args, ctx) => {
        const m = await ctx.loaders.chatLastMessage.load(c.id);
        return m ? { ...m, viewerId: c.viewerId } : null;
      },
    }),
    lastMessageAt: t.field({ type: 'DateTime', nullable: true, resolve: (c) => c.lastMessageAt }),
    messages: t.connection(
      {
        type: MessageRef,
        description: 'Newest first. Forward pagination only.',
        resolve: async (c, args, ctx) => {
          if (args.last != null || args.before != null) {
            throw new SystemError('BAD_USER_INPUT', 'messages supports forward pagination only');
          }
          requireActor(ctx);
          // The view already proves the viewer may read it — no second check.
          const page = await chat.messagesIn(c, {
            first: clampFirst(args.first, 30),
            after: args.after ?? null,
          });
          const edges = page.nodes.map((m, i) => ({
            cursor: page.cursors[i] ?? '',
            node: { ...m, viewerId: c.viewerId },
          }));
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
      MessageConnectionRef,
    ),
  }),
});

const ConversationConnectionRef = builder.connectionObject(
  { type: ConversationRef, name: 'ConversationConnection' },
  { name: 'ConversationEdge' },
);

const MessagingRef = builder.objectRef<Messaging>('Messaging').implement({
  description: 'What the viewer can do about messaging a player (chat R1–R4, R6).',
  fields: (t) => ({
    canMessage: t.exposeBoolean('canMessage'),
    isRequest: t.exposeBoolean('isRequest', {
      description: 'Sending is (or was) a message request, not an open chat.',
    }),
    conversationId: t.exposeID('conversationId', { nullable: true }),
    blocked: t.exposeBoolean('blocked', { description: 'You have blocked this player.' }),
    requestDeclined: t.exposeBoolean('requestDeclined', {
      description: 'chat R10 — your message request to this player was declined.',
    }),
    canResendAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'chat R10 — when you may send a new request. Null when not declined.',
      resolve: (m) => m.canResendAt,
    }),
  }),
});

builder.objectField(PlayerProfileRef, 'viewerMessaging', (t) =>
  t.field({
    type: MessagingRef,
    nullable: true,
    description: 'Null on your own profile and when signed out.',
    resolve: (p, _args, ctx) => chat.messagingWith(ctx.actor?.userId ?? null, p.id),
  }),
);

// --- payloads ----------------------------------------------------------------

const SendMessagePayload = builder
  .objectRef<{
    conversation: ConversationView | null;
    message: ChatMessageNode | null;
    userError: UserErrorShape | null;
  }>('SendMessagePayload')
  .implement({
    fields: (t) => ({
      conversation: t.field({ type: ConversationRef, nullable: true, resolve: (p) => p.conversation }),
      message: t.field({ type: MessageRef, nullable: true, resolve: (p) => p.message }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const ConversationPayload = builder
  .objectRef<{ conversation: ConversationView | null; userError: UserErrorShape | null }>('ConversationPayload')
  .implement({
    fields: (t) => ({
      conversation: t.field({
        type: ConversationRef,
        nullable: true,
        description: 'Null after you decline: the request left your inbox.',
        resolve: (p) => p.conversation,
      }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const BlockPayload = builder
  .objectRef<{ messaging: Messaging | null; userError: UserErrorShape | null }>('BlockPayload')
  .implement({
    fields: (t) => ({
      messaging: t.field({ type: MessagingRef, nullable: true, resolve: (p) => p.messaging }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const MessagePayload = builder
  .objectRef<{ message: ChatMessageNode | null; userError: UserErrorShape | null }>('MessagePayload')
  .implement({
    fields: (t) => ({
      message: t.field({ type: MessageRef, nullable: true, resolve: (p) => p.message }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const SendMessageInput = builder.inputType('SendMessageInput', {
  fields: (t) => ({
    playerId: t.id({ required: true }),
    body: t.string({ required: true }),
    replyToId: t.id({ required: false, description: 'chat R13 — a message of this conversation to answer.' }),
  }),
});

// --- queries -----------------------------------------------------------------

builder.queryFields((t) => ({
  conversations: t.connection(
    {
      type: ConversationRef,
      description: 'chat R3 — your chats and requests either way, newest activity first.',
      resolve: async (_root, args, ctx) => {
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'conversations supports forward pagination only');
        }
        const actor = requireActor(ctx);
        const page = await chat.list(actor.userId, {
          first: clampFirst(args.first, 20),
          after: args.after ?? null,
        });
        const edges = page.nodes.map((node, i) => ({ cursor: page.cursors[i] ?? '', node }));
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
    ConversationConnectionRef,
  ),

  conversation: t.field({
    type: ConversationRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => chat.byId(requireActor(ctx).userId, args.id),
  }),

  unreadConversationCount: t.int({
    description: 'chat R7 — conversations with something unread. The inbox badge.',
    resolve: (_root, _args, ctx) => chat.unreadConversationCount(requireActor(ctx).userId),
  }),
}));

// --- mutations ---------------------------------------------------------------

builder.mutationFields((t) => ({
  sendMessage: t.field({
    type: SendMessagePayload,
    description: 'Opens the conversation when there is none (chat R2, R3).',
    args: { input: t.arg({ type: SendMessageInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        chat.send(actor, {
          playerId: args.input.playerId,
          body: args.input.body,
          replyToId: args.input.replyToId ?? null,
        }),
      );
      return {
        conversation: data?.conversation ?? null,
        message: data ? { ...data.message, viewerId: data.conversation.viewerId } : null,
        userError,
      };
    },
  }),

  editMessage: t.field({
    type: MessagePayload,
    description: 'chat R11 — your own message, within 15 minutes of sending. The other side is not notified.',
    args: { messageId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        chat.edit(actor, { messageId: args.messageId, body: args.body }),
      );
      return { message: data ? { ...data, viewerId: data.senderId } : null, userError };
    },
  }),

  deleteMessage: t.field({
    type: MessagePayload,
    description: 'chat R12 — deletes your own message for everyone. It shows as deleted in the thread.',
    args: { messageId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => chat.remove(actor, args.messageId));
      return { message: data ? { ...data, viewerId: data.senderId } : null, userError };
    },
  }),

  setTyping: t.boolean({
    description:
      'chat R14 — you are typing in this conversation; the other side sees "typing…" for a few seconds. ' +
      'Best-effort and silent: always true. Send at most every 3 seconds.',
    args: { conversationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await chat.typing(requireActor(ctx), args.conversationId);
      return true;
    },
  }),

  acceptMessageRequest: t.field({
    type: ConversationPayload,
    args: { conversationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => chat.accept(actor, args.conversationId));
      return { conversation: data, userError };
    },
  }),

  declineMessageRequest: t.field({
    type: ConversationPayload,
    args: { conversationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => chat.decline(actor, args.conversationId));
      return { conversation: null, userError };
    },
  }),

  markConversationRead: t.field({
    type: ConversationPayload,
    args: { conversationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => chat.markRead(actor, args.conversationId));
      return { conversation: data, userError };
    },
  }),

  blockPlayer: t.field({
    type: BlockPayload,
    args: { playerId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => chat.block(actor, args.playerId));
      return { messaging: userError ? null : await chat.messagingWith(actor.userId, args.playerId), userError };
    },
  }),

  unblockPlayer: t.field({
    type: BlockPayload,
    args: { playerId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => chat.unblock(actor, args.playerId));
      return { messaging: userError ? null : await chat.messagingWith(actor.userId, args.playerId), userError };
    },
  }),
}));
