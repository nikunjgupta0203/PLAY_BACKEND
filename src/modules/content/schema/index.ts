/**
 * content — GraphQL surface (Floodlight §4.1). Players read; PL4Y staff write
 * and publish in the portal.
 */
import { builder } from '../../../graphql/builder.js';
import { requirePlatformStaff } from '../../../graphql/staff.js';
import { attempt, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { newId } from '../../../platform/ids.js';
import { SportRef } from '../../sport/schema/index.js';
import { MediaUploadPayload } from '../../venues/schema/index.js';
import { content } from '../index.js';
import type { ContentItem, ContentKind, ContentStatus, HomeShelf } from '../index.js';

const KindEnum = builder.enumType('ContentKind', {
  values: {
    STORY: { value: 'story', description: 'An article.' },
    SHORT: { value: 'short', description: 'A vertical video, played in a web view.' },
    EXPLAINER: { value: 'explainer', description: '"Explained · 60 sec".' },
    ORIGINAL: { value: 'original', description: 'A PL4Y Originals feature: the Home hero.' },
    LINK: { value: 'link', description: 'content R5 — an outside headline. Opens sourceUrl in the in-app browser; there is no body.' },
  } as const,
});

const StatusEnum = builder.enumType('ContentStatus', {
  values: { DRAFT: { value: 'draft' }, PUBLISHED: { value: 'published' }, ARCHIVED: { value: 'archived' } } as const,
});

export const ContentItemRef = builder.objectRef<ContentItem>('ContentItem').implement({
  description: 'Something PL4Y published. `body` is plain text with blank-line paragraphs: render as text, never markup.',
  fields: (t) => ({
    id: t.exposeID('id'),
    kind: t.field({ type: KindEnum, resolve: (c) => c.kind }),
    title: t.exposeString('title'),
    kicker: t.exposeString('kicker', { nullable: true }),
    summary: t.exposeString('summary', { nullable: true }),
    body: t.exposeString('body', { nullable: true }),
    coverPublicId: t.exposeString('coverPublicId', { nullable: true }),
    // An outside picture (a link's own, or a credited Unsplash / Pexels photo) is used as given.
    coverUrl: t.string({ nullable: true, resolve: (c) => cloudinary.url(c.coverPublicId, TRANSFORMS.eventCover) ?? c.imageUrl }),
    thumbUrl: t.string({ nullable: true, resolve: (c) => cloudinary.url(c.coverPublicId, TRANSFORMS.eventThumb) ?? c.imageUrl }),
    sourceName: t.exposeString('sourceName', { nullable: true, description: 'A link’s publisher: "ESPNcricinfo".' }),
    sourceUrl: t.exposeString('sourceUrl', { nullable: true, description: 'Where a link opens.' }),
    imageCredit: t.exposeString('imageCredit', { nullable: true, description: 'Show under the picture when set: "Photo: Jane Doe on Unsplash".' }),
    imageCreditUrl: t.exposeString('imageCreditUrl', { nullable: true }),
    videoUrl: t.exposeString('videoUrl', { nullable: true }),
    durationSeconds: t.exposeInt('durationSeconds', { nullable: true }),
    status: t.field({ type: StatusEnum, resolve: (c) => c.status }),
    featured: t.exposeBoolean('featured'),
    publishedAt: t.field({ type: 'DateTime', nullable: true, resolve: (c) => c.publishedAt }),
    updatedAt: t.field({ type: 'DateTime', resolve: (c) => c.updatedAt }),
    sport: t.field({
      type: SportRef,
      nullable: true,
      resolve: async (c) => {
        if (!c.sportId) return null;
        const { sport } = await import('../../sport/index.js');
        return sport.byId(c.sportId);
      },
    }),
  }),
});

const PageRef = builder
  .objectRef<{ nodes: ContentItem[]; hasNextPage: boolean; endCursor: string | null }>('ContentPage')
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [ContentItemRef], resolve: (p) => p.nodes }),
      hasNextPage: t.exposeBoolean('hasNextPage'),
      endCursor: t.exposeString('endCursor', { nullable: true }),
    }),
  });

const ShelfRef = builder.objectRef<HomeShelf>('ContentShelf').implement({
  description: 'content R4 — the Home feed’s PL4Y regions. An empty region is left out of the layout.',
  fields: (t) => ({
    hero: t.field({ type: ContentItemRef, nullable: true, resolve: (s) => s.hero }),
    shorts: t.field({ type: [ContentItemRef], resolve: (s) => s.shorts }),
    stories: t.field({ type: [ContentItemRef], resolve: (s) => s.stories }),
    explainer: t.field({ type: ContentItemRef, nullable: true, resolve: (s) => s.explainer }),
  }),
});

builder.queryFields((t) => ({
  contentFeed: t.field({
    type: PageRef,
    args: {
      kind: t.arg({ type: KindEnum }),
      sportId: t.arg.id(),
      q: t.arg.string(),
      first: t.arg.int({ defaultValue: 20 }),
      after: t.arg.string(),
    },
    resolve: (_root, args) =>
      content.feed({
        kind: (args.kind as ContentKind | null | undefined) ?? null,
        sportId: args.sportId ? String(args.sportId) : null,
        q: args.q ?? null,
        first: args.first ?? 20,
        after: args.after ?? null,
      }),
  }),
  contentItem: t.field({
    type: ContentItemRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: (_root, args) => content.item(String(args.id)),
  }),
  contentShelf: t.field({
    type: ShelfRef,
    args: { sportId: t.arg.id() },
    resolve: (_root, args) => content.homeShelf(args.sportId ? String(args.sportId) : null),
  }),
}));

// --- PL4Y staff -------------------------------------------------------------------

const EDITORS = ['admin', 'support'] as const;

const ContentInput = builder.inputType('ContentInput', {
  fields: (t) => ({
    kind: t.field({ type: KindEnum, required: true }),
    sportId: t.id(),
    title: t.string({ required: true }),
    kicker: t.string(),
    summary: t.string(),
    body: t.string(),
    coverPublicId: t.string({ description: '`folder/publicId` from adminContentCoverUploadSignature.' }),
    videoUrl: t.string({ description: 'https only. A short needs one to publish.' }),
    durationSeconds: t.int(),
    featured: t.boolean(),
    sourceName: t.string({ description: 'A link only: its publisher.' }),
    sourceUrl: t.string({ description: 'A link only: its address.' }),
  }),
});

const ItemPayload = builder
  .objectRef<{ item: ContentItem | null; userError: UserErrorShape | null }>('ContentItemPayload')
  .implement({
    fields: (t) => ({
      item: t.field({ type: ContentItemRef, nullable: true, resolve: (p) => p.item }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  adminContent: t.field({
    type: [ContentItemRef],
    description: 'Portal — every item, last edited first.',
    args: { status: t.arg({ type: StatusEnum }), kind: t.arg({ type: KindEnum }), first: t.arg.int({ defaultValue: 100 }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return content.staffList({
        status: (args.status as ContentStatus | null | undefined) ?? null,
        kind: (args.kind as ContentKind | null | undefined) ?? null,
        first: args.first ?? 100,
      });
    },
  }),
  adminContentItem: t.field({
    type: ContentItemRef,
    nullable: true,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return content.item(String(args.id), { staff: true });
    },
  }),
}));

builder.mutationFields((t) => ({
  adminSaveContent: t.field({
    type: ItemPayload,
    description: 'Portal — create (no `id`) or edit. Saving never publishes.',
    args: { id: t.arg.id(), input: t.arg({ type: ContentInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, [...EDITORS]);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        content.save(staff.userId, args.id ? String(args.id) : null, {
          kind: i.kind as ContentKind,
          sportId: i.sportId ? String(i.sportId) : null,
          title: i.title,
          kicker: i.kicker ?? null,
          summary: i.summary ?? null,
          body: i.body ?? null,
          coverPublicId: i.coverPublicId ?? null,
          videoUrl: i.videoUrl ?? null,
          durationSeconds: i.durationSeconds ?? null,
          featured: i.featured ?? false,
          sourceName: i.sourceName ?? null,
          sourceUrl: i.sourceUrl ?? null,
        }),
      );
      return { item: data, userError };
    },
  }),
  adminSetContentStatus: t.field({
    type: ItemPayload,
    description: 'content R2, R3 — publish, unpublish to draft, or archive.',
    args: { id: t.arg.id({ required: true }), status: t.arg({ type: StatusEnum, required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(() => content.setStatus(String(args.id), args.status as ContentStatus));
      return { item: data, userError };
    },
  }),
  adminDeleteContent: t.field({
    type: ItemPayload,
    description: 'Portal — deletes a draft or archived item. A published one must be archived first.',
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { userError } = await attempt(() => content.remove(String(args.id)));
      return { item: null, userError };
    },
  }),
  adminContentCoverUploadSignature: t.field({
    type: MediaUploadPayload,
    description: 'ADR 0003 §C2 — upload under this signature, then save `folder/publicId` as coverPublicId.',
    args: { itemId: t.arg.id({ description: 'Omit for an item not saved yet.' }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx, [...EDITORS]);
      const { data, userError } = await attempt(async () =>
        cloudinary.signUpload({ publicId: `cover-${newId()}`, folder: cloudinary.folders.contentRoot(args.itemId ? String(args.itemId) : 'new') }),
      );
      return { upload: data, userError };
    },
  }),
}));
