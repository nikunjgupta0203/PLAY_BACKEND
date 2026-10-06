/**
 * Host analytics (docs/modules/14-organizers.md `eventAnalytics`,
 * `organizerAnalytics`). An event's owner or manager sees its numbers; any
 * member of an organisation sees the organisation's; PL4Y staff on a portal
 * session see both.
 */
import { builder } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { requireActor } from '../../../graphql/userError.js';
import { forbidden } from '../../../platform/errors/index.js';
import { identity } from '../../identity/index.js';
import { analytics, organisations } from '../index.js';
import type { CategoryStats, EventAnalytics, OrganiserAnalytics } from '../index.js';

const paise = (v: bigint): number => Number(v);

async function isPortalStaff(ctx: Ctx): Promise<boolean> {
  const actor = requireActor(ctx);
  return actor.client === 'portal' && (await ctx.loaders.platformRole.load(actor.userId)) !== null;
}

const CategoryAnalyticsRef = builder.objectRef<CategoryStats>('CategoryAnalytics').implement({
  fields: (t) => ({
    categoryId: t.exposeID('categoryId'),
    name: t.exposeString('name'),
    capacity: t.exposeInt('capacity'),
    begun: t.exposeInt('begun', { description: 'Entries started, whatever became of them.' }),
    confirmed: t.exposeInt('confirmed'),
    checkedIn: t.exposeInt('checkedIn'),
    withdrawn: t.exposeInt('withdrawn'),
    abandoned: t.exposeInt('abandoned', { description: 'Started but never paid (hold expired or payment failed).' }),
    waitlisted: t.exposeInt('waitlisted'),
    offline: t.exposeInt('offline', { description: 'Walk-ins and cash entries the desk added.' }),
    onlinePaid: t.exposeInt('onlinePaid', { description: 'Entries paid through PL4Y — the ones a host payout is made of.' }),
  }),
});

const EventAnalyticsRef = builder.objectRef<EventAnalytics>('EventAnalytics').implement({
  description: '14-organizers — how an event did. Money from the ledger (payments R6).',
  fields: (t) => ({
    eventId: t.exposeID('eventId'),
    title: t.exposeString('title'),
    slug: t.exposeString('slug'),
    startsAt: t.field({ type: 'DateTime', resolve: (e) => e.startsAt }),
    status: t.exposeString('status'),
    begun: t.exposeInt('begun'),
    confirmed: t.exposeInt('confirmed'),
    capacity: t.exposeInt('capacity'),
    fillRate: t.exposeFloat('fillRate', { description: 'confirmed / capacity, 0 to 1.' }),
    checkedIn: t.exposeInt('checkedIn'),
    noShows: t.exposeInt('noShows', {
      description: 'Confirmed but never checked in, counted once the event has finished. Not proof they did not play: shown as "not checked in".',
    }),
    withdrawn: t.exposeInt('withdrawn'),
    offline: t.exposeInt('offline'),
    refunds: t.exposeInt('refunds'),
    grossPaise: t.int({ resolve: (e) => paise(e.grossPaise) }),
    refundedPaise: t.int({ resolve: (e) => paise(e.refundedPaise) }),
    platformFeePaise: t.int({ resolve: (e) => paise(e.platformFeePaise) }),
    netPaise: t.int({ description: 'Paid less refunded.', resolve: (e) => paise(e.netPaise) }),
    byCategory: t.field({ type: [CategoryAnalyticsRef], resolve: (e) => e.byCategory }),
    asOf: t.field({ type: 'DateTime', resolve: (e) => e.asOf }),
  }),
});

type Totals = OrganiserAnalytics['totals'];

const AnalyticsTotalsRef = builder.objectRef<Totals>('OrganisationAnalyticsTotals').implement({
  fields: (t) => ({
    eventCount: t.exposeInt('eventCount'),
    begun: t.exposeInt('begun'),
    confirmed: t.exposeInt('confirmed'),
    capacity: t.exposeInt('capacity'),
    fillRate: t.exposeFloat('fillRate'),
    checkedIn: t.exposeInt('checkedIn'),
    noShows: t.exposeInt('noShows'),
    withdrawn: t.exposeInt('withdrawn'),
    offline: t.exposeInt('offline'),
    refunds: t.exposeInt('refunds'),
    grossPaise: t.int({ resolve: (e) => paise(e.grossPaise) }),
    refundedPaise: t.int({ resolve: (e) => paise(e.refundedPaise) }),
    platformFeePaise: t.int({ resolve: (e) => paise(e.platformFeePaise) }),
    netPaise: t.int({ resolve: (e) => paise(e.netPaise) }),
  }),
});

const OrganisationAnalyticsRef = builder.objectRef<OrganiserAnalytics>('OrganisationAnalytics').implement({
  fields: (t) => ({
    events: t.field({ type: [EventAnalyticsRef], resolve: (a) => a.events }),
    totals: t.field({ type: AnalyticsTotalsRef, resolve: (a) => a.totals }),
    from: t.field({ type: 'DateTime', resolve: (a) => a.from }),
    to: t.field({ type: 'DateTime', resolve: (a) => a.to }),
    asOf: t.field({ type: 'DateTime', resolve: (a) => a.asOf }),
  }),
});

const DAY = 86_400_000;

builder.queryFields((t) => ({
  eventAnalytics: t.field({
    type: EventAnalyticsRef,
    nullable: true,
    description: '14-organizers — entries, check-ins and money for one event. Owners and managers.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const eventId = String(args.eventId);
      const grant = await identity.grantsFor(actor.userId, eventId);
      if (!(grant && (grant.role === 'owner' || grant.role === 'manager')) && !(await isPortalStaff(ctx))) {
        throw forbidden();
      }
      return analytics.eventAnalytics(eventId);
    },
  }),

  organisationAnalytics: t.field({
    type: OrganisationAnalyticsRef,
    description: '14-organizers — every event of an organisation that starts in the range (default: the last 90 days and the next 90).',
    args: {
      organisationId: t.arg.id({ required: true }),
      from: t.arg({ type: 'DateTime' }),
      to: t.arg({ type: 'DateTime' }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const organisationId = String(args.organisationId);
      const role = await organisations.roleOf(organisationId, actor.userId);
      if (!role && !(await isPortalStaff(ctx))) throw forbidden();
      const now = Date.now();
      return analytics.organisationAnalytics(organisationId, {
        from: args.from ?? new Date(now - 90 * DAY),
        to: args.to ?? new Date(now + 90 * DAY),
      });
    },
  }),
}));
