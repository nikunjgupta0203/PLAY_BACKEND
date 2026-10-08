/**
 * events — GraphQL surface (docs/modules/05-events.md).
 *
 * `Event` is one of the four Node types (conventions.md §4) — it is the deep
 * link an organizer shares. `EventCategory` is not: the module doc writes
 * `implements Node` for it, and conventions.md §4 fixes the list at four, which
 * makes the module doc the thing that is wrong.
 *
 * The doc also types `format: MatchFormat!` as an enum. Formats are per-sport
 * DATA (sport R5's sibling — a second sport is a row, never a branch), so an
 * enum here would bake pickleball's formats into the schema and force a client
 * release to add a sport. The field is the sport module's `Format` object, and
 * the filter takes its `key`.
 *
 * Two fields from the doc are absent rather than stubbed:
 *   · `viewerRegistration` needs `registration` (Sprint 4).
 *   · `tournament` needs `tournament` (Sprint 8).
 */
import { builder, clampFirst } from '../../../graphql/builder.js';
import type { Ctx } from '../../../graphql/context.js';
import { GeoPointInput, GeoPointRef } from '../../../graphql/geo.js';
import { audited, requirePlatformStaff, requireReason } from '../../../graphql/staff.js';
import { attempt, requireActor, UserErrorRef } from '../../../graphql/userError.js';
import type { UserErrorShape } from '../../../graphql/userError.js';
import { recordAudit } from '../../../platform/audit.js';
import { cloudinary, TRANSFORMS } from '../../../platform/cloudinary.js';
import { db } from '../../../platform/db.js';
import { SystemError, UserError } from '../../../platform/errors/index.js';
import { sport } from '../../sport/index.js';
import { FormatRef, SportRef } from '../../sport/schema/index.js';
import { MediaUploadPayload, VenueRef } from '../../venues/schema/index.js';
import { EventCode, events } from '../index.js';
import { hostEarnings, priceQuote as computeQuote } from '../service/priceQuote.js';
import type {
  Availability,
  Capacity,
  Event,
  EventCategory,
  EventKind,
  EventStatus,
  PriceQuote,
} from '../index.js';
import type { ClosePreviewRow, EventCourt, EventReport, RefundPolicy, ReportReason } from '../service/index.js';

// --- enums -------------------------------------------------------------------

const EventStatusEnum = builder.enumType('EventStatus', {
  description:
    'LIVE is what flips the Event Detail screen into Live Mode. Live Mode is a ' +
    'state, not a separate route.',
  values: {
    DRAFT: { value: 'draft' as EventStatus },
    PUBLISHED: { value: 'published' as EventStatus },
    LIVE: { value: 'live' as EventStatus },
    COMPLETED: { value: 'completed' as EventStatus },
    CANCELLED: { value: 'cancelled' as EventStatus },
  },
});

const EventKindEnum = builder.enumType('EventKind', {
  description: 'events R11 — what discovery calls tournaments and what it calls leagues.',
  values: {
    TOURNAMENT: { value: 'tournament' as EventKind },
    LEAGUE_SEASON: { value: 'league_season' as EventKind },
  },
});

const AvailabilityEnum = builder.enumType('Availability', {
  description:
    'Derived, never stored (events R4). CLOSED wins over FULL: past the ' +
    'registration deadline the seats are no longer for sale either way.',
  values: {
    OPEN: { value: 'OPEN' as Availability },
    ALMOST_FULL: { value: 'ALMOST_FULL' as Availability },
    FULL: { value: 'FULL' as Availability },
    CLOSED: { value: 'CLOSED' as Availability },
  },
});

const RefundPolicyEnum = builder.enumType('RefundPolicy', {
  description:
    'F27 — STANDARD: a full refund until the cutoff, nothing after. FLEXIBLE: full until the ' +
    'cutoff, half until the start. Once players have paid, a policy may only get kinder.',
  values: {
    STANDARD: { value: 'standard' as RefundPolicy },
    FLEXIBLE: { value: 'flexible' as RefundPolicy },
  },
});

const ReportReasonEnum = builder.enumType('EventReportReason', {
  values: {
    DID_NOT_HAPPEN: { value: 'did_not_happen' as ReportReason },
    DIFFERENT_FROM_LISTING: { value: 'different_from_listing' as ReportReason },
    UNFAIR_RESULTS: { value: 'unfair_results' as ReportReason },
    HOST_CONDUCT: { value: 'host_conduct' as ReportReason },
    OTHER: { value: 'other' as ReportReason },
  },
});

const ReportStatusEnum = builder.enumType('EventReportStatus', {
  values: {
    OPEN: { value: 'open' as const },
    RESOLVED: { value: 'resolved' as const },
    DISMISSED: { value: 'dismissed' as const },
  },
});

const MediaKind = builder.enumType('EventMediaKind', {
  values: { COVER: { value: 'cover' }, GALLERY: { value: 'gallery' }, SPONSOR: { value: 'sponsor' } },
});

// --- money -------------------------------------------------------------------

/**
 * Paise as Int. The service works in bigint and nothing rounds on the way here
 * (conventions.md §2 — no float touches money). Int tops out at ₹21,47,483.64,
 * which is two orders of magnitude above any amateur entry fee; if that ever
 * stops being true the field becomes a String, not a Float.
 */
const paise = (v: bigint): number => Number(v);

const PriceQuoteRef = builder.objectRef<PriceQuote>('PriceQuote').implement({
  description:
    'events R3 — computed by the one function `registration` and `payments` also ' +
    'call. The client never calculates a total.',
  fields: (t) => ({
    entryFeePaise: t.int({ resolve: (q) => paise(q.entryFeePaise) }),
    platformFeePaise: t.int({ resolve: (q) => paise(q.platformFeePaise) }),
    taxPaise: t.int({ resolve: (q) => paise(q.taxPaise) }),
    totalPaise: t.int({ resolve: (q) => paise(q.totalPaise) }),
    currency: t.exposeString('currency'),
  }),
});

const CapacityRef = builder.objectRef<Capacity>('Capacity').implement({
  description: 'events R5 — `held` is live seat holds. They count against capacity.',
  fields: (t) => ({
    capacity: t.exposeInt('capacity'),
    taken: t.exposeInt('taken'),
    held: t.exposeInt('held'),
    remaining: t.exposeInt('remaining'),
  }),
});

// --- types -------------------------------------------------------------------

const EventCategoryRef = builder
  .objectRef<EventCategory>('EventCategory')
  .implement({
    description:
      'What a player actually registers for. Capacity, fee and format live here ' +
      'and not on the event, because one tournament sells eight draws at eight prices.',
    fields: (t) => ({
      id: t.exposeID('id'),
      name: t.exposeString('name', { description: '"Men’s Doubles 3.5"' }),
      format: t.field({
        type: FormatRef,
        resolve: async (c) => {
          const formats = await sport.formatsFor(c.sportId);
          const found = formats.find((f) => f.key === c.format);
          if (!found) {
            // The category was written against a format the sport has since
            // dropped. That is a seed problem, not something a player can fix.
            throw new SystemError('INTERNAL', `Unknown format ${c.format}`);
          }
          return found;
        },
      }),
      teamSize: t.exposeInt('teamSize'),
      drawType: t.exposeString('drawType'),
      skillMin: t.float({ nullable: true, resolve: (c) => c.skillMin }),
      skillMax: t.float({ nullable: true, resolve: (c) => c.skillMax }),
      capacity: t.exposeInt('capacity'),
      minEntries: t.exposeInt('minEntries', {
        description: 'Below this at registration close, the draw is cancelled and refunded (events R9).',
      }),
      entriesRemaining: t.int({
        description: 'Subtracts live holds as well as confirmed entries (events R5).',
        resolve: async (c, _args, ctx) => (await ctx.loaders.capacity.load(c)).remaining,
      }),
      capacityDetail: t.field({
        type: CapacityRef,
        resolve: (c, _args, ctx) => ctx.loaders.capacity.load(c),
      }),
      availability: t.field({
        type: AvailabilityEnum,
        // Speed — every card lists its categories; the category is in hand, and the
        // event and the seat counts are read once per request for every card together.
        resolve: async (c, _args, ctx) =>
          (
            await events.availabilityOf(c.id, {
              category: c,
              event: ctx.loaders.event.load(c.eventId),
              capacity: ctx.loaders.capacity.load(c),
            })
          ).availability,
      }),
      // A pure function of the category's own prices — no read needed.
      priceQuote: t.field({ type: PriceQuoteRef, resolve: (c) => computeQuote(c) }),
      commissionBps: t.exposeInt('commissionBps', {
        description: "The platform's share of the entry fee, server-set. 1000 = 10%.",
      }),
      hostReceivesPaise: t.int({
        description: 'What the host keeps per entry: the entry fee less the commission.',
        resolve: (c) => Number(hostEarnings(c).hostReceivesPaise),
      }),
      status: t.exposeString('status'),
      matchMinutes: t.int({
        nullable: true,
        description: 'F14 — how long one match takes, for the schedule. Null = 45.',
        resolve: (c) => c.matchMinutes,
      }),
      thirdPlace: t.boolean({
        description: 'F23 — a knockout without a Plate plays a match for third place.',
        resolve: (c) => c.thirdPlace,
      }),
      prizes: t.string({ nullable: true, description: 'F24', resolve: (c) => c.prizes }),
      rulesNote: t.string({ nullable: true, description: 'F24 — the host’s format notes.', resolve: (c) => c.rulesNote }),
      formatSummary: t.string({
        nullable: true,
        description:
          'F21 — how a match is played, in a few words ("1 game to 21", "best of 3 sets", ' +
          '"2 × 20 min"). Null when the rule has no short form.',
        resolve: async (c) => {
          const rule = (c.scoringRule ??
            (await sport.scoringRuleFor(
              c.sportId,
              (await sport.formatsFor(c.sportId)).find((f) => f.key === c.format)?.id,
            ))) as Record<string, unknown>;
          return formatSummary(rule);
        },
      }),
    }),
  });

/** F21 — a rule in a few words, for the category sheet and the host's form. */
function formatSummary(rule: Record<string, unknown>): string | null {
  const n = (k: string) => (typeof rule[k] === 'number' ? (rule[k] as number) : null);
  switch (rule['kind']) {
    case 'rally': {
      const games = n('gamesToWin') ?? 1;
      const points = n('pointsToWin');
      return games === 1 ? `1 game to ${points}` : `Best of ${games * 2 - 1} games to ${points}`;
    }
    case 'sets': {
      const sets = n('setsToWin') ?? 1;
      return sets === 1 ? '1 set' : `Best of ${sets * 2 - 1} sets`;
    }
    case 'goals':
      return `${n('periods')} × ${n('periodMinutes')} min`;
    case 'innings':
      return `${n('oversPerInnings')} overs a side`;
    default:
      return null;
  }
}

const ClosePreviewRef = builder.objectRef<ClosePreviewRow>('RegistrationClosePreview').implement({
  description: 'F8 — what closing registration now does to one draw.',
  fields: (t) => ({
    categoryId: t.exposeID('categoryId'),
    name: t.exposeString('name'),
    confirmed: t.exposeInt('confirmed'),
    minEntries: t.exposeInt('minEntries'),
    paying: t.exposeInt('paying', { description: 'Players part-way through paying; they are let finish.' }),
    willCancel: t.exposeBoolean('willCancel', { description: 'Below its minimum: cancelled and refunded.' }),
  }),
});

const EventCourtRef = builder.objectRef<EventCourt>('EventCourt').implement({
  description: 'F14 — a court the host declared for this event.',
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
  }),
});

const EventReportRef = builder.objectRef<EventReport>('EventReport').implement({
  description: 'F3 — a player’s report that the event did not happen as promised.',
  fields: (t) => ({
    id: t.exposeID('id'),
    eventId: t.exposeID('eventId'),
    reason: t.field({ type: ReportReasonEnum, resolve: (r) => r.reason }),
    details: t.string({ nullable: true, resolve: (r) => r.details }),
    status: t.field({ type: ReportStatusEnum, resolve: (r) => r.status }),
    resolutionNote: t.string({ nullable: true, resolve: (r) => r.resolutionNote }),
    createdAt: t.field({ type: 'DateTime', resolve: (r) => r.createdAt }),
    resolvedAt: t.field({ type: 'DateTime', nullable: true, resolve: (r) => r.resolvedAt }),
    event: t.field({ type: EventRef, nullable: true, resolve: (r) => events.findById(r.eventId) }),
    reporterName: t.string({
      resolve: async (r) => {
        const { identity } = await import('../../identity/index.js');
        const [user] = await identity.contactsByIds([r.reporterUserId]);
        return user?.displayName ?? '';
      },
    }),
  }),
});

interface OrganizerSummary {
  /** The host's user id, or the organisation's id (org R4). */
  id: string;
  displayName: string;
  avatarPublicId: string | null;
  /** org R4 — set when the event is hosted as an organisation. */
  organisation: { slug: string; verification: string } | null;
}

const OrganizerKindEnum = builder.enumType('OrganizerKind', {
  values: { PERSON: { value: 'person' }, ORGANISATION: { value: 'organisation' } } as const,
});

const OrganizerSummaryRef = builder
  .objectRef<OrganizerSummary>('OrganizerSummary')
  .implement({
    fields: (t) => ({
      id: t.exposeID('id'),
      kind: t.field({
        type: OrganizerKindEnum,
        description: 'org R4 — a person hosting, or an organisation PL4Y verified.',
        resolve: (o) => (o.organisation ? 'organisation' : 'person'),
      }),
      organisationSlug: t.string({
        nullable: true,
        description: 'org R8 — opens the organisation’s page. Null for a person.',
        resolve: (o) => o.organisation?.slug ?? null,
      }),
      displayName: t.exposeString('displayName'),
      avatarUrl: t.string({
        nullable: true,
        resolve: (o) => cloudinary.url(o.avatarPublicId, TRANSFORMS.avatarSm),
      }),
      verified: t.boolean({
        description:
          'F3 — the host’s bank account and PAN are verified by PL4Y; for an organisation, PL4Y verified it (org R4).',
        resolve: async (o) => {
          if (o.organisation) return o.organisation.verification === 'verified';
          const { payouts } = await import('../../payments/index.js');
          return (await payouts.myAccount(o.id))?.status === 'verified';
        },
      }),
      eventsHosted: t.int({
        description: 'F3 — events this host (or organisation) has run to the end on PL4Y.',
        resolve: async (o) => {
          if (!o.organisation) return events.hostedCount(o.id);
          const { organisations } = await import('../../organizers/index.js');
          return organisations.hostedCount(o.id);
        },
      }),
    }),
  });

const EventRef = builder.objectRef<Event>('Event');

builder.node(EventRef, {
  id: { resolve: (e) => e.id },
  loadOne: (id) => events.findById(id),
  fields: (t) => ({
    id: t.exposeID('id'),
    slug: t.exposeString('slug', {
      description: 'Permanent once published — it is a deep link that outlives us (events R8).',
    }),
    title: t.exposeString('title'),
    description: t.string({ nullable: true, resolve: (e) => e.description }),
    sport: t.field({ type: SportRef, resolve: (e) => sport.byId(e.sportId) }),
    venue: t.field({
      type: VenueRef,
      nullable: true,
      resolve: (e, _args, ctx) => (e.venueId ? ctx.loaders.venue.load(e.venueId) : null),
    }),
    city: t.exposeString('city'),
    timezone: t.exposeString('timezone', {
      description: 'Times are UTC; this is how "Saturday 9am" survives a multi-zone future.',
    }),
    startsAt: t.field({ type: 'DateTime', resolve: (e) => e.startsAt }),
    endsAt: t.field({ type: 'DateTime', resolve: (e) => e.endsAt }),
    registrationClosesAt: t.field({ type: 'DateTime', resolve: (e) => e.registrationClosesAt }),
    cancellationCutoffAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'A cancellation before this instant is refunded in full.',
      resolve: (e) => e.cancellationCutoffAt,
    }),
    status: t.field({ type: EventStatusEnum, resolve: (e) => e.status }),
    kind: t.field({ type: EventKindEnum, resolve: (e) => e.kind }),
    contactPhone: t.string({
      nullable: true,
      description: "The host's number. Null unless the viewer is staff or holds a seat.",
      resolve: async (e, _args, ctx) =>
        (await events.canSeeContact(ctx.actor?.userId ?? null, e.id)) ? e.contactPhone : null,
    }),
    locationNote: t.string({ nullable: true, resolve: (e) => e.locationNote }),
    hostTermsAccepted: t.boolean({ resolve: (e) => e.hostTermsAcceptedAt !== null }),
    refundPolicy: t.field({ type: RefundPolicyEnum, resolve: (e) => e.refundPolicy }),
    termsChangedAt: t.field({
      type: 'DateTime',
      nullable: true,
      description: 'F18 — when the place or dates last changed after people entered. Entrants may withdraw in full for 48 hours.',
      resolve: (e) => e.termsChangedAt,
    }),
    location: t.field({
      type: GeoPointRef,
      nullable: true,
      description: 'F17 — the event’s pin, else its venue’s. Null when neither is known.',
      // Speed — a page of cards reads every pin in one query; the venue loader is shared with `venue`.
      resolve: async (e, _args, ctx) =>
        (await ctx.loaders.eventLocation.load(e.id)) ??
        (e.venueId ? ((await ctx.loaders.venue.load(e.venueId))?.location ?? null) : null),
    }),
    courts: t.field({
      type: [EventCourtRef],
      description: 'F14 — courts the host declared for this event.',
      resolve: (e) => events.courtsOf(e.id),
    }),
    viewerRole: t.string({
      nullable: true,
      description: 'owner | manager | scorer — the viewer’s grant on this event, or null.',
      resolve: async (e, _args, ctx) => {
        if (!ctx.actor) return null;
        return (await ctx.loaders.grant.load({ userId: ctx.actor.userId, eventId: e.id }))?.role ?? null;
      },
    }),
    viewerReport: t.field({
      type: EventReportRef,
      nullable: true,
      description: 'F3 — what the viewer reported about this event, if anything.',
      resolve: (e, _args, ctx) => (ctx.actor ? events.myReport(ctx.actor.userId, e.id) : null),
    }),
    viewerIsHost: t.boolean({
      description: 'True when the viewer is owner or manager of this event.',
      resolve: async (e, _args, ctx) => {
        if (!ctx.actor) return false;
        const grant = await ctx.loaders.grant.load({ userId: ctx.actor.userId, eventId: e.id });
        return grant?.role === 'owner' || grant?.role === 'manager';
      },
    }),
    categories: t.field({
      type: [EventCategoryRef],
      resolve: (e, _args, ctx) => {
        // The event is in hand — its categories' availability must not read it again.
        ctx.loaders.event.prime(e.id, e);
        return ctx.loaders.categories.load(e.id);
      },
    }),
    organizer: t.field({
      type: OrganizerSummaryRef,
      resolve: async (e) => {
        // org R4 — an organisation's event shows the organisation, not a person.
        if (e.organizerProfileId) {
          const { organisations } = await import('../../organizers/index.js');
          const org = await organisations.findById(e.organizerProfileId);
          if (org) {
            return {
              id: org.id,
              displayName: org.name,
              avatarPublicId: org.logoPublicId,
              organisation: { slug: org.slug, verification: org.verification },
            };
          }
        }
        const { identity } = await import('../../identity/index.js');
        const [user] = await identity.usersByIds([e.organizerId]);
        return {
          id: e.organizerId,
          displayName: user?.displayName ?? '',
          avatarPublicId: user?.avatarPublicId ?? null,
          organisation: null,
        };
      },
    }),
    /** ADR 0003 §C1 — built at render from a named transformation. */
    coverUrl: t.string({
      nullable: true,
      resolve: (e) => cloudinary.url(e.coverPublicId, TRANSFORMS.eventCover),
    }),
    galleryUrls: t.stringList({
      resolve: async (e) => {
        const media = await events.mediaFor(e.id);
        return media
          .filter((m) => m.kind === 'gallery')
          .map((m) => cloudinary.url(m.publicId, TRANSFORMS.eventThumb))
          .filter((url): url is string => url !== null);
      },
    }),
  }),
});

// --- payloads ----------------------------------------------------------------

const EventPayload = builder
  .objectRef<{ event: Event | null; userError: UserErrorShape | null }>('EventPayload')
  .implement({
    fields: (t) => ({
      event: t.field({ type: EventRef, nullable: true, resolve: (p) => p.event }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const EventCategoryPayload = builder
  .objectRef<{ category: EventCategory | null; userError: UserErrorShape | null }>(
    'EventCategoryPayload',
  )
  .implement({
    fields: (t) => ({
      category: t.field({ type: EventCategoryRef, nullable: true, resolve: (p) => p.category }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

// --- inputs ------------------------------------------------------------------

const RuleTweaksInput = builder.inputType('RuleTweaksInput', {
  description:
    'F21 — the few numbers a host may change about how a match is played. Each applies ' +
    'only to sports scored that way; anything else is refused.',
  fields: (t) => ({
    pointsToWin: t.int({ description: 'Rally sports: points in a game (5–30).' }),
    gamesToWin: t.int({ description: 'Rally sports: games to win (1 = one game, 2 = best of 3).' }),
    setsToWin: t.int({ description: 'Set sports: sets to win (1 = one set, 2 = best of 3).' }),
    periodMinutes: t.int({ description: 'Timed sports: minutes a period (5–60).' }),
    oversPerInnings: t.int({ description: 'Cricket: overs a side (1–50).' }),
  }),
});

const EventCategoryInput = builder.inputType('EventCategoryInput', {
  fields: (t) => ({
    name: t.string({ required: true }),
    format: t.string({ required: true, description: 'A `Format.key` for this event’s sport.' }),
    drawType: t.string(),
    skillMin: t.float(),
    skillMax: t.float(),
    ageMin: t.int(),
    ageMax: t.int(),
    capacity: t.int({ required: true }),
    minEntries: t.int(),
    // The platform fee and the tax rate are not here on purpose: PL4Y sets
    // them from config (gap #7). A host prices the entry fee, nothing else.
    entryFeePaise: t.int({ required: true }),
    matchMinutes: t.int(),
    thirdPlace: t.boolean(),
    prizes: t.string(),
    rulesNote: t.string(),
    tweaks: t.field({ type: RuleTweaksInput }),
  }),
});

const CreateEventInput = builder.inputType('CreateEventInput', {
  fields: (t) => ({
    sportId: t.id({ required: true }),
    title: t.string({ required: true }),
    description: t.string(),
    city: t.string({ description: 'Ignored when `venueId` is given — the venue decides.' }),
    venueId: t.id(),
    location: t.field({ type: GeoPointInput }),
    timezone: t.string(),
    startsAt: t.field({ type: 'DateTime', required: true }),
    endsAt: t.field({ type: 'DateTime', required: true }),
    registrationClosesAt: t.field({ type: 'DateTime', required: true }),
    cancellationCutoffAt: t.field({ type: 'DateTime' }),
    contactPhone: t.string({ description: 'A 10-digit Indian mobile; +91 allowed.' }),
    locationNote: t.string(),
    acceptHostTerms: t.boolean(),
    refundPolicy: t.field({ type: RefundPolicyEnum }),
    organisationId: t.id({
      description: 'org R3 — host as this organisation (you must be a member). Absent: host as yourself.',
    }),
  }),
});

function createInputOf(i: typeof CreateEventInput.$inferInput): Parameters<typeof events.create>[1] {
  return {
    sportId: String(i.sportId),
    title: i.title,
    description: i.description ?? null,
    city: i.city ?? null,
    venueId: i.venueId ? String(i.venueId) : null,
    location: i.location ? { lat: i.location.lat, lng: i.location.lng } : null,
    timezone: i.timezone ?? undefined,
    startsAt: i.startsAt,
    endsAt: i.endsAt,
    registrationClosesAt: i.registrationClosesAt,
    cancellationCutoffAt: i.cancellationCutoffAt ?? null,
    contactPhone: i.contactPhone ?? null,
    locationNote: i.locationNote ?? null,
    acceptHostTerms: i.acceptHostTerms ?? false,
    refundPolicy: i.refundPolicy ?? undefined,
    organisationId: i.organisationId ? String(i.organisationId) : null,
  };
}

/**
 * Portal staff (admin, support) run any event as its owner would (events
 * Actor.platformStaff). Anyone else, and staff on their phone, is themselves.
 */
async function eventActor(ctx: Ctx) {
  const actor = requireActor(ctx);
  if (actor.client !== 'portal') return actor;
  const role = await ctx.loaders.platformRole.load(actor.userId);
  return { ...actor, platformStaff: role === 'admin' || role === 'support' };
}

const UpdateEventInput = builder.inputType('UpdateEventInput', {
  description:
    'Only the fields present are written. After people have entered, a change of dates or ' +
    'place is allowed until a draw is made: entrants are told and may withdraw in full for ' +
    '48 hours (F18).',
  fields: (t) => ({
    title: t.string(),
    description: t.string(),
    city: t.string(),
    venueId: t.id(),
    location: t.field({ type: GeoPointInput }),
    timezone: t.string(),
    startsAt: t.field({ type: 'DateTime' }),
    endsAt: t.field({ type: 'DateTime' }),
    registrationClosesAt: t.field({ type: 'DateTime' }),
    cancellationCutoffAt: t.field({ type: 'DateTime' }),
    contactPhone: t.string(),
    locationNote: t.string(),
    acceptHostTerms: t.boolean(),
    refundPolicy: t.field({ type: RefundPolicyEnum }),
  }),
});

const UpdateEventCategoryInput = builder.inputType('UpdateEventCategoryInput', {
  fields: (t) => ({
    name: t.string(),
    drawType: t.string(),
    skillMin: t.float(),
    skillMax: t.float(),
    ageMin: t.int(),
    ageMax: t.int(),
    capacity: t.int(),
    minEntries: t.int({ description: 'F16 — may go down at any time before close; up only before anyone enters.' }),
    entryFeePaise: t.int(),
    matchMinutes: t.int(),
    thirdPlace: t.boolean(),
    prizes: t.string(),
    rulesNote: t.string(),
    tweaks: t.field({ type: RuleTweaksInput }),
  }),
});

const EventFilterInput = builder.inputType('EventFilter', {
  fields: (t) => ({
    query: t.string({
      description: 'discovery R1 — free text, matched against the title and the venue name.',
    }),
    kind: t.field({ type: EventKindEnum }),
    sportId: t.id(),
    city: t.string(),
    near: t.field({ type: GeoPointInput }),
    radiusKm: t.float({ description: 'Capped at 50 (events R6).' }),
    from: t.field({ type: 'DateTime' }),
    to: t.field({ type: 'DateTime' }),
    skillBand: t.string({ description: 'A `SkillBand.key`. Needs `sportId` to mean anything.' }),
    format: t.string({ description: 'A `Format.key`.' }),
    maxPricePaise: t.int(),
  }),
});

// --- queries -----------------------------------------------------------------

/** Same (starts_at, id) key the service pages on (conventions.md §4). */
const cursorFor = (e: Event): string =>
  Buffer.from(`${e.startsAt.toISOString()}|${e.id}`, 'utf8').toString('base64url');

builder.queryFields((t) => ({
  registrationClosePreview: t.field({
    type: [ClosePreviewRef],
    description: 'F8 — what "close registration now" would do to each draw still taking entries.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => events.closePreview(requireActor(ctx), String(args.eventId)),
  }),

  eventReports: t.field({
    type: [EventReportRef],
    description: 'F9 — PL4Y staff only: players’ reports, oldest first.',
    args: { status: t.arg({ type: ReportStatusEnum }) },
    resolve: async (_root, args, ctx) => {
      await requirePlatformStaff(ctx);
      return events.reports(args.status ?? 'open');
    },
  }),

  myHostedEvents: t.field({
    type: [EventRef],
    description: 'Events the viewer helps run (any grant), drafts included, newest start first.',
    resolve: (_root, _args, ctx) => events.hostedBy(requireActor(ctx).userId),
  }),

  event: t.field({
    type: EventRef,
    nullable: true,
    args: { slug: t.arg.string({ required: true }) },
    // A draft or cancelled event reads as null to anyone but its own staff
    // (events R6) — the same "not distinguishable from missing" rule the rest
    // of the graph follows.
    resolve: async (_root, args, ctx) => {
      // F9 — PL4Y staff, in the portal, see drafts and cancelled events too:
      // refunds and reports are about them. On the app they are players.
      const staff =
        ctx.actor?.client === 'portal' ? (await ctx.loaders.platformRole.load(ctx.actor.userId)) !== null : false;
      return staff ? events.findBySlugForStaff(args.slug) : events.findBySlug(args.slug, ctx.actor?.userId ?? null);
    },
  }),

  events: t.connection(
    {
      type: EventRef,
      description:
        'Explore. Only published and live events appear, ordered by start time (events R6).',
      args: { filter: t.arg({ type: EventFilterInput }) },
      resolve: async (_root, args) => {
        if (args.last != null || args.before != null) {
          throw new SystemError('BAD_USER_INPUT', 'events supports forward pagination only');
        }
        const f = args.filter;
        const page = await events.search(
          {
            sportId: f?.sportId ?? null,
            city: f?.city ?? null,
            near: f?.near ? { lat: f.near.lat, lng: f.near.lng } : null,
            radiusKm: f?.radiusKm ?? null,
            from: f?.from ?? null,
            to: f?.to ?? null,
            skillBand: f?.skillBand ?? null,
            format: f?.format ?? null,
            maxPricePaise: f?.maxPricePaise != null ? BigInt(f.maxPricePaise) : null,
            query: f?.query ?? null,
            kind: f?.kind ?? null,
          },
          { first: clampFirst(args.first, 20), after: args.after ?? null },
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
    // The doc's names. Without them Pothos derives `QueryEventsConnection`, and
    // the committed SDL is the client contract (conventions.md §4).
    { name: 'EventConnection' },
    { name: 'EventEdge' },
  ),
}));

// --- staff (gap #26) ---------------------------------------------------------

const StaffRoleEnum = builder.enumType('EventStaffRole', {
  values: {
    MANAGER: { value: 'manager' as const },
    SCORER: { value: 'scorer' as const },
  },
});

interface StaffMember {
  userId: string;
  role: string;
}

const EventStaffMemberRef = builder.objectRef<StaffMember>('EventStaffMember').implement({
  description: 'Somebody who helps run the event. `role` is owner, manager or scorer.',
  fields: (t) => ({
    userId: t.exposeID('userId'),
    role: t.exposeString('role'),
    displayName: t.string({
      resolve: async (m) => {
        const { identity } = await import('../../identity/index.js');
        const [user] = await identity.contactsByIds([m.userId]);
        return user?.displayName ?? '';
      },
    }),
  }),
});

const EventStaffPayload = builder
  .objectRef<{ member: StaffMember | null; userError: UserErrorShape | null }>('EventStaffPayload')
  .implement({
    fields: (t) => ({
      member: t.field({ type: EventStaffMemberRef, nullable: true, resolve: (p) => p.member }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.queryFields((t) => ({
  eventStaff: t.field({
    type: [EventStaffMemberRef],
    description: 'Owners and managers only: everyone who helps run the event.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: (_root, args, ctx) => events.staffOf(requireActor(ctx), String(args.eventId)),
  }),
}));

// --- mutations ---------------------------------------------------------------

const MessagePlayersPayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('MessageEventPlayersPayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  messageEventPlayers: t.field({
    type: MessagePlayersPayload,
    description:
      'Organizer staff only. Sends `message` (1–500 characters, plain text) to every confirmed ' +
      'entrant as a notification — feed row and push. At most 5 an hour per event.',
    args: {
      eventId: t.arg.id({ required: true }),
      message: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        events.messagePlayers(actor, String(args.eventId), args.message),
      );
      return { ok: userError === null, userError };
    },
  }),


  createEvent: t.field({
    type: EventPayload,
    description: 'Creates a draft. Publishing is the validation gate (events R1). PL4Y staff use adminCreateEvent.',
    args: { input: t.arg({ type: CreateEventInput, required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() => events.create(actor, createInputOf(args.input)));
      return { event: data, userError };
    },
  }),

  adminCreateEvent: t.field({
    type: EventPayload,
    description:
      'portal — PL4Y staff create a draft hosted by an organisation (required). Its draws, ' +
      'edits and publishing then go through the usual mutations, which staff may call on any event.',
    args: {
      input: t.arg({ type: CreateEventInput, required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx, ['admin', 'support']);
      const { data, userError } = await attempt(async () => {
        const reason = requireReason(args.reason);
        if (!args.input.organisationId) {
          throw new UserError(EventCode.INVALID_EVENT_FIELD, 'Choose the organisation that hosts it.');
        }
        const created = await events.create(
          { userId: staff.userId, platformStaff: true },
          createInputOf(args.input),
        );
        // Recorded against the id it was just given.
        await recordAudit(db, {
          actorUserId: staff.userId,
          action: 'event.create',
          targetType: 'event',
          targetId: created.id,
          reason,
          details: { organisationId: String(args.input.organisationId), title: created.title },
        });
        return created;
      });
      return { event: data, userError };
    },
  }),

  updateEvent: t.field({
    type: EventPayload,
    args: {
      eventId: t.arg.id({ required: true }),
      input: t.arg({ type: UpdateEventInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        events.update(actor, args.eventId, {
          title: i.title ?? undefined,
          description: i.description === undefined ? undefined : i.description,
          city: i.city ?? undefined,
          venueId: i.venueId === undefined ? undefined : i.venueId,
          location: i.location === undefined
            ? undefined
            : i.location === null
              ? null
              : { lat: i.location.lat, lng: i.location.lng },
          timezone: i.timezone ?? undefined,
          startsAt: i.startsAt ?? undefined,
          endsAt: i.endsAt ?? undefined,
          registrationClosesAt: i.registrationClosesAt ?? undefined,
          cancellationCutoffAt:
            i.cancellationCutoffAt === undefined ? undefined : i.cancellationCutoffAt,
          contactPhone: i.contactPhone === undefined ? undefined : i.contactPhone,
          locationNote: i.locationNote === undefined ? undefined : i.locationNote,
          acceptHostTerms: i.acceptHostTerms ?? undefined,
          refundPolicy: i.refundPolicy ?? undefined,
        }),
      );
      return { event: data, userError };
    },
  }),

  eventCoverUploadSignature: t.field({
    type: MediaUploadPayload,
    description:
      'ADR 0003 §C2 — upload the cover straight to Cloudinary under this signature, ' +
      'then report `folder/publicId` through addEventMedia(kind: COVER).',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        events.coverUploadSignature(actor, String(args.eventId)),
      );
      return { upload: data, userError };
    },
  }),

  publishEvent: t.field({
    type: EventPayload,
    description:
      'events R1 — needs at least one category, a city or venue, a registration window ' +
      'that closes by the start, a future start, a contact phone and accepted hosting ' +
      'terms. A paid category also needs a verified host (ORGANIZER_NOT_VERIFIED).',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const { data, userError } = await attempt(() => events.publish(actor, args.eventId));
      return { event: data, userError };
    },
  }),

  cancelEvent: t.field({
    type: EventPayload,
    description:
      'events R7 — irreversible, and every confirmed registration is refunded in ' +
      'full, platform fee included.',
    args: {
      eventId: t.arg.id({ required: true }),
      reason: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        events.cancel(actor, args.eventId, args.reason),
      );
      return { event: data, userError };
    },
  }),

  addEventCategory: t.field({
    type: EventCategoryPayload,
    args: {
      eventId: t.arg.id({ required: true }),
      input: t.arg({ type: EventCategoryInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        events.addCategory(actor, args.eventId, {
          name: i.name,
          format: i.format,
          drawType: i.drawType ?? undefined,
          skillMin: i.skillMin ?? null,
          skillMax: i.skillMax ?? null,
          ageMin: i.ageMin ?? null,
          ageMax: i.ageMax ?? null,
          capacity: i.capacity,
          minEntries: i.minEntries ?? undefined,
          entryFeePaise: BigInt(i.entryFeePaise),
          matchMinutes: i.matchMinutes ?? null,
          thirdPlace: i.thirdPlace ?? false,
          prizes: i.prizes ?? null,
          rulesNote: i.rulesNote ?? null,
          tweaks: i.tweaks ?? null,
        }),
      );
      return { category: data, userError };
    },
  }),

  updateEventCategory: t.field({
    type: EventCategoryPayload,
    args: {
      categoryId: t.arg.id({ required: true }),
      input: t.arg({ type: UpdateEventCategoryInput, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const i = args.input;
      const { data, userError } = await attempt(() =>
        events.updateCategory(actor, args.categoryId, {
          name: i.name ?? undefined,
          drawType: i.drawType ?? undefined,
          skillMin: i.skillMin === undefined ? undefined : i.skillMin,
          skillMax: i.skillMax === undefined ? undefined : i.skillMax,
          ageMin: i.ageMin === undefined ? undefined : i.ageMin,
          ageMax: i.ageMax === undefined ? undefined : i.ageMax,
          capacity: i.capacity ?? undefined,
          minEntries: i.minEntries ?? undefined,
          entryFeePaise: i.entryFeePaise != null ? BigInt(i.entryFeePaise) : undefined,
          matchMinutes: i.matchMinutes === undefined ? undefined : i.matchMinutes,
          thirdPlace: i.thirdPlace ?? undefined,
          prizes: i.prizes === undefined ? undefined : i.prizes,
          rulesNote: i.rulesNote === undefined ? undefined : i.rulesNote,
          tweaks: i.tweaks ?? undefined,
        }),
      );
      return { category: data, userError };
    },
  }),

  closeEventRegistration: t.field({
    type: EventPayload,
    description:
      'Owner or manager. Closes registration now so the draws can be made. Draws below ' +
      'their minimum entries are cancelled and refunded, exactly as at the deadline.',
    args: { eventId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() => events.closeRegistrationNow(actor, String(args.eventId)));
      return { event: await events.findById(String(args.eventId)), userError };
    },
  }),

  addEventStaff: t.field({
    type: EventStaffPayload,
    description:
      'Adds a helper to the event by their account email. The owner adds managers and ' +
      'scorers; a manager adds scorers. Scorers can check players in and score matches.',
    args: {
      eventId: t.arg.id({ required: true }),
      email: t.arg.string({ required: true }),
      role: t.arg({ type: StaffRoleEnum, required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        events.addStaffMember(actor, String(args.eventId), { email: args.email, role: args.role }),
      );
      return { member: data, userError };
    },
  }),

  removeEventStaff: t.field({
    type: EventStaffPayload,
    args: {
      eventId: t.arg.id({ required: true }),
      userId: t.arg.id({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        events.removeStaffMember(actor, String(args.eventId), String(args.userId)),
      );
      return { member: null, userError };
    },
  }),

  addEventMedia: t.field({
    type: EventPayload,
    description: 'A Cloudinary public_id, never a URL (ADR 0003 §C3).',
    args: {
      eventId: t.arg.id({ required: true }),
      publicId: t.arg.string({ required: true }),
      kind: t.arg({ type: MediaKind, required: true }),
      sortOrder: t.arg.int(),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { userError } = await attempt(() =>
        events.addMedia(actor, args.eventId, {
          publicId: args.publicId,
          kind: args.kind as 'cover' | 'gallery' | 'sponsor',
          sortOrder: args.sortOrder ?? 0,
        }),
      );
      return { event: await events.findById(args.eventId), userError };
    },
  }),
}));

// --- the organizer section and PL4Y staff (2026-10-04 flow review) -------------

const OkPayload = builder
  .objectRef<{ ok: boolean; userError: UserErrorShape | null }>('OrganizerOkPayload')
  .implement({
    fields: (t) => ({
      ok: t.exposeBoolean('ok'),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const EventCourtPayload = builder
  .objectRef<{ court: EventCourt | null; userError: UserErrorShape | null }>('EventCourtPayload')
  .implement({
    fields: (t) => ({
      court: t.field({ type: EventCourtRef, nullable: true, resolve: (p) => p.court }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

const EventReportPayload = builder
  .objectRef<{ report: EventReport | null; userError: UserErrorShape | null }>('EventReportPayload')
  .implement({
    fields: (t) => ({
      report: t.field({ type: EventReportRef, nullable: true, resolve: (p) => p.report }),
      userError: t.field({ type: UserErrorRef, nullable: true, resolve: (p) => p.userError }),
    }),
  });

builder.mutationFields((t) => ({
  removeEventCategory: t.field({
    type: OkPayload,
    description: 'F19 — deletes a draw nobody has entered. A published event keeps at least one.',
    args: { categoryId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const { userError } = await attempt(() => events.removeCategory(actor, String(args.categoryId)));
      return { ok: userError === null, userError };
    },
  }),

  addEventCourt: t.field({
    type: EventCourtPayload,
    description: 'F14 — a court the host has for this event ("Court 1"). The scheduler uses these first.',
    args: { eventId: t.arg.id({ required: true }), name: t.arg.string({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const { data, userError } = await attempt(() => events.addCourt(actor, String(args.eventId), args.name));
      return { court: data, userError };
    },
  }),

  removeEventCourt: t.field({
    type: OkPayload,
    description: 'F14 — retires one of the event’s courts. Matches already on it keep it.',
    args: { eventId: t.arg.id({ required: true }), courtId: t.arg.id({ required: true }) },
    resolve: async (_root, args, ctx) => {
      const actor = await eventActor(ctx);
      const { userError } = await attempt(() =>
        events.retireCourt(actor, String(args.eventId), String(args.courtId)),
      );
      return { ok: userError === null, userError };
    },
  }),

  reportEvent: t.field({
    type: EventReportPayload,
    description:
      'F3 — a player who entered says the event did not happen as promised. Open from the ' +
      'start until two weeks after the end. Holds the host’s payout until PL4Y staff look.',
    args: {
      eventId: t.arg.id({ required: true }),
      reason: t.arg({ type: ReportReasonEnum, required: true }),
      details: t.arg.string(),
    },
    resolve: async (_root, args, ctx) => {
      const actor = requireActor(ctx);
      const { data, userError } = await attempt(() =>
        events.report(actor, String(args.eventId), { reason: args.reason, details: args.details ?? null }),
      );
      return { report: data, userError };
    },
  }),

  resolveEventReport: t.field({
    type: EventReportPayload,
    description: 'F9 — PL4Y staff close a report: RESOLVED (acted on) or DISMISSED.',
    args: {
      reportId: t.arg.id({ required: true }),
      outcome: t.arg({ type: ReportStatusEnum, required: true }),
      note: t.arg.string({ required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const staff = await requirePlatformStaff(ctx);
      const reportId = String(args.reportId);
      const { data, userError } = await attempt(async () => {
        if (args.outcome === 'open') throw new UserError(EventCode.INVALID_EVENT_FIELD, 'Pick resolved or dismissed.');
        const outcome = args.outcome;
        // portal R3 — the note the reporter reads is the reason on record.
        return audited(
          staff,
          { action: `event_report.${outcome}`, targetType: 'event_report', targetId: reportId },
          args.note,
          (note) => events.resolveReport(staff.userId, reportId, outcome, note),
        );
      });
      return { report: data, userError };
    },
  }),
}));

export { EventRef, EventCategoryRef, PriceQuoteRef, AvailabilityEnum, EventStatusEnum, OkPayload as OrganizerOkPayload };
