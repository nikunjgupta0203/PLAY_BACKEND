/**
 * sport — GraphQL surface (docs/modules/02-sport.md).
 *
 * The module doc writes `type Sport implements Node`. conventions.md §4 says
 * Node is implemented by exactly four types — Event, Match, PlayerProfile and
 * Game — and that a module doc losing to conventions.md is the module doc being
 * wrong. Sport is a registry entry, not a deep-link target, so it is a plain
 * object type here.
 */
import { builder } from '../../../graphql/builder.js';
import { sport } from '../index.js';
import type { Format, SkillBand, Sport } from '../index.js';

export const FormatRef = builder.objectRef<Format>('Format').implement({
  description: 'A way a sport is played. Its team size drives registration.',
  fields: (t) => ({
    id: t.exposeID('id'),
    key: t.exposeString('key', {
      description: 'singles | doubles | mixed_doubles | team',
    }),
    name: t.exposeString('name'),
    teamSize: t.exposeInt('teamSize'),
    ruleKind: t.string({
      description:
        'F21 — how this format is scored: rally | sets | goals | innings | series | bouts | performance | scorecard. ' +
        'Decides which numbers a host may change (RuleTweaksInput).',
      resolve: async (f) => (await sport.scoringRuleFor(f.sportId, f.id)).kind,
    }),
    ruleDefinition: t.string({
      description: 'F21 — the default rule for this format, as JSON, so a host sees what they are changing.',
      resolve: async (f) => JSON.stringify(await sport.scoringRuleFor(f.sportId, f.id)),
    }),
  }),
});

export const SkillBandRef = builder.objectRef<SkillBand>('SkillBand').implement({
  description:
    'A self-declared skill tier, defined per sport (sport R2). Pickleball uses the ' +
    'DUPR-style 2.5–5.0+ ladder; another sport will not, and no client may assume it.',
  fields: (t) => ({
    id: t.exposeID('id'),
    key: t.exposeString('key'),
    label: t.exposeString('label'),
    lowerBound: t.float({ nullable: true, resolve: (b) => b.lowerBound }),
    upperBound: t.float({ nullable: true, resolve: (b) => b.upperBound }),
    sortOrder: t.exposeInt('sortOrder'),
  }),
});

export const SportRef = builder.objectRef<Sport>('Sport').implement({
  fields: (t) => ({
    id: t.exposeID('id'),
    slug: t.exposeString('slug'),
    name: t.exposeString('name'),
    formats: t.field({
      type: [FormatRef],
      resolve: (s) => sport.formatsFor(s.id),
    }),
    skillBands: t.field({
      type: [SkillBandRef],
      resolve: (s) => sport.skillBandsFor(s.id),
    }),
  }),
});

builder.queryFields((t) => ({
  sports: t.field({
    type: [SportRef],
    description: 'Active sports, in display order. Retired sports are hidden (sport R3).',
    resolve: () => sport.list(),
  }),

  sport: t.field({
    type: SportRef,
    nullable: true,
    args: { slug: t.arg.string({ required: true }) },
    // Null, not SPORT_NOT_FOUND: a nullable field already says "no such sport",
    // and a query has no payload type to carry a user error (conventions.md §3).
    resolve: (_root, args) => sport.findBySlug(args.slug),
  }),
}));
