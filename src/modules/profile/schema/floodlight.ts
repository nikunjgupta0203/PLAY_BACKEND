/**
 * profile — Floodlight GraphQL additions: the self-declared athlete label,
 * the player's own records, and Explore's "Athletes to follow".
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requestLoader } from '../../../graphql/requestLoader.js';
import { attempt, requireActor, UserErrorRef, type UserErrorShape } from '../../../graphql/userError.js';
import { SportRef } from '../../sport/schema/index.js';
import { profileExtras } from '../index.js';
import type { ProfileRecord, PublicProfile } from '../index.js';
import { PlayerProfileRef } from './index.js';

const labelOf = (ctx: Ctx, profileId: string) =>
  requestLoader<string, string | null>(ctx, 'athleteLabel', async (ids) => {
    const found = await profileExtras.athleteLabels(ids);
    return ids.map((id) => found.get(id) ?? null);
  }).load(profileId);

const RecordRef = builder.objectRef<ProfileRecord>('ProfileRecord').implement({
  description: 'profile R21 — a record the player added themselves. Show it as "Added by you / by them".',
  fields: (t) => ({
    id: t.exposeID('id'),
    title: t.exposeString('title'),
    detail: t.exposeString('detail', { nullable: true }),
    year: t.exposeInt('year', { nullable: true }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    sport: t.field({
      type: SportRef,
      nullable: true,
      resolve: async (r) => {
        if (!r.sportId) return null;
        const { sport } = await import('../../sport/index.js');
        return sport.byId(r.sportId);
      },
    }),
  }),
});

builder.objectFields(PlayerProfileRef, (t) => ({
  athleteLabel: t.string({
    nullable: true,
    description: 'profile R20 — self-declared, never verified. Shown as an ATHLETE label.',
    resolve: (p, _a, ctx) => labelOf(ctx, p.id),
  }),
  records: t.field({
    type: [RecordRef],
    description: 'profile R21 — records the player added. Hidden with the rest of the details when the profile is not visible.',
    resolve: (p: PublicProfile) => (p.detailsVisible ? profileExtras.records(p.id) : []),
  }),
}));

const LabelPayload = builder
  .objectRef<{ athleteLabel: string | null; userError: UserErrorShape | null }>('SetAthleteLabelPayload')
  .implement({
    fields: (t) => ({
      athleteLabel: t.exposeString('athleteLabel', { nullable: true }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const RecordPayload = builder
  .objectRef<{ record: ProfileRecord | null; userError: UserErrorShape | null }>('ProfileRecordPayload')
  .implement({
    fields: (t) => ({
      record: t.field({ type: RecordRef, nullable: true, resolve: (p) => p.record }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  athletes: t.field({
    type: [PlayerProfileRef],
    description: 'Explore — players who call themselves athletes (profile R20).',
    args: { sportId: t.arg.id(), q: t.arg.string(), first: t.arg.int({ defaultValue: 10 }) },
    resolve: async (_root, args, ctx) => {
      const ids = await profileExtras.athletes({ sportId: args.sportId ? String(args.sportId) : null, q: args.q ?? null, first: args.first ?? 10, excludeUserId: ctx.actor?.userId ?? null });
      const loaded = await Promise.all(ids.map((id) => ctx.loaders.publicProfile.load(id)));
      return loaded.filter((p): p is PublicProfile => p !== null);
    },
  }),
}));

builder.mutationFields((t) => ({
  setAthleteLabel: t.field({
    type: LabelPayload,
    description: 'profile R20 — up to 40 characters; blank clears it.',
    args: { label: t.arg.string() },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => profileExtras.setAthleteLabel(actor.userId, args.label ?? null));
      return { athleteLabel: data ?? null, userError };
    },
  }),
  addProfileRecord: t.field({
    type: RecordPayload,
    args: {
      title: t.arg.string({ required: true }),
      detail: t.arg.string(),
      year: t.arg.int(),
      sportId: t.arg.id(),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        profileExtras.addRecord(actor.userId, {
          title: args.title,
          detail: args.detail ?? null,
          year: args.year ?? null,
          sportId: args.sportId ? String(args.sportId) : null,
        }),
      );
      return { record: data, userError };
    },
  }),
  deleteProfileRecord: t.field({
    type: RecordPayload,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => profileExtras.deleteRecord(actor.userId, String(args.id)));
      return { record: null, userError };
    },
  }),
}));
