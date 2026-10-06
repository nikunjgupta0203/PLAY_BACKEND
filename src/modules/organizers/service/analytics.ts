/**
 * organizers — host analytics (docs/modules/14-organizers.md `eventAnalytics`,
 * `organizerAnalytics`).
 *
 * Counts come from `registration`, money from the `payments` ledger (payments
 * R6: the ledger is the only source of truth for money). Each figure is read
 * through the owning module's service, never its tables, and every answer
 * carries `asOf`.
 *
 * Deviation from R8, on purpose: these are computed on request rather than
 * projected into `event_stats_daily`. A host's own events are a few dozen rows
 * each; a read model is worth building when a dashboard reads thousands. Page
 * views (R9) are not tracked yet, so there is no views figure.
 */

export interface CategoryStats {
  categoryId: string;
  name: string;
  capacity: number;
  begun: number;
  confirmed: number;
  checkedIn: number;
  withdrawn: number;
  abandoned: number;
  waitlisted: number;
  offline: number;
  /** Paid through PL4Y. Cash and free entries never reach a payout. */
  onlinePaid: number;
}

export interface EventAnalytics {
  eventId: string;
  title: string;
  slug: string;
  startsAt: Date;
  status: string;
  begun: number;
  confirmed: number;
  capacity: number;
  /** confirmed / capacity across the draws, 0..1. */
  fillRate: number;
  checkedIn: number;
  /** Confirmed entries never checked in, once the event has finished. */
  noShows: number;
  withdrawn: number;
  offline: number;
  refunds: number;
  grossPaise: bigint;
  refundedPaise: bigint;
  platformFeePaise: bigint;
  /** What players paid less what went back. The host's payout is this less PL4Y's commission. */
  netPaise: bigint;
  byCategory: CategoryStats[];
  asOf: Date;
}

export interface OrganiserAnalytics {
  events: EventAnalytics[];
  totals: Omit<EventAnalytics, 'eventId' | 'title' | 'slug' | 'startsAt' | 'status' | 'byCategory' | 'asOf'> & {
    eventCount: number;
  };
  from: Date;
  to: Date;
  asOf: Date;
}

export interface AnalyticsDeps {
  events: {
    byIds(ids: string[]): Promise<{ id: string; title: string; slug: string; startsAt: Date; status: string }[]>;
    categoriesFor(eventId: string): Promise<{ id: string; name: string; capacity: number }[]>;
  };
  registration: {
    statsForEvents(eventIds: string[]): Promise<
      {
        eventId: string;
        categoryId: string;
        begun: number;
        confirmed: number;
        checkedIn: number;
        withdrawn: number;
        abandoned: number;
        waitlisted: number;
        offline: number;
        onlinePaid: number;
      }[]
    >;
  };
  payments: {
    ledgerSummary(eventIds: string[]): Promise<
      { eventId: string; grossPaise: bigint; refundedPaise: bigint; platformFeePaise: bigint; refunds: number }[]
    >;
  };
  eventIdsOfOrganisation(organisationId: string): Promise<string[]>;
  now?: () => Date;
}

const FINISHED = new Set(['completed']);

export function createAnalyticsService(deps: AnalyticsDeps) {
  const now = deps.now ?? (() => new Date());

  async function forEvents(eventIds: string[]): Promise<EventAnalytics[]> {
    if (eventIds.length === 0) return [];
    const [events, stats, money] = await Promise.all([
      deps.events.byIds(eventIds),
      deps.registration.statsForEvents(eventIds),
      deps.payments.ledgerSummary(eventIds),
    ]);
    const asOf = now();
    return Promise.all(
      events.map(async (e) => {
        const categories = await deps.events.categoriesFor(e.id);
        const byCategory: CategoryStats[] = categories.map((c) => {
          const s = stats.find((r) => r.categoryId === c.id);
          return {
            categoryId: c.id,
            name: c.name,
            capacity: c.capacity,
            begun: s?.begun ?? 0,
            confirmed: s?.confirmed ?? 0,
            checkedIn: s?.checkedIn ?? 0,
            withdrawn: s?.withdrawn ?? 0,
            abandoned: s?.abandoned ?? 0,
            waitlisted: s?.waitlisted ?? 0,
            offline: s?.offline ?? 0,
            onlinePaid: s?.onlinePaid ?? 0,
          };
        });
        const sum = (k: keyof Omit<CategoryStats, 'categoryId' | 'name'>) => byCategory.reduce((n, c) => n + c[k], 0);
        const m = money.find((r) => r.eventId === e.id);
        const confirmed = sum('confirmed');
        const capacity = sum('capacity');
        const checkedIn = sum('checkedIn');
        const grossPaise = m?.grossPaise ?? 0n;
        const refundedPaise = m?.refundedPaise ?? 0n;
        return {
          eventId: e.id,
          title: e.title,
          slug: e.slug,
          startsAt: e.startsAt,
          status: e.status,
          begun: sum('begun'),
          confirmed,
          capacity,
          fillRate: capacity > 0 ? Math.min(1, confirmed / capacity) : 0,
          checkedIn,
          noShows: FINISHED.has(e.status) ? Math.max(0, confirmed - checkedIn) : 0,
          withdrawn: sum('withdrawn'),
          offline: sum('offline'),
          refunds: m?.refunds ?? 0,
          grossPaise,
          refundedPaise,
          platformFeePaise: m?.platformFeePaise ?? 0n,
          netPaise: grossPaise - refundedPaise,
          byCategory,
          asOf,
        };
      }),
    );
  }

  async function eventAnalytics(eventId: string): Promise<EventAnalytics | null> {
    return (await forEvents([eventId]))[0] ?? null;
  }

  /** Every event of the organisation starting inside [from, to), soonest first, plus totals. */
  async function organisationAnalytics(organisationId: string, range: { from: Date; to: Date }): Promise<OrganiserAnalytics> {
    const ids = await deps.eventIdsOfOrganisation(organisationId);
    const all = await forEvents(ids);
    const events = all
      .filter((e) => e.startsAt >= range.from && e.startsAt < range.to && e.status !== 'draft')
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const totals = {
      eventCount: events.length,
      begun: 0,
      confirmed: 0,
      capacity: 0,
      fillRate: 0,
      checkedIn: 0,
      noShows: 0,
      withdrawn: 0,
      offline: 0,
      refunds: 0,
      grossPaise: 0n,
      refundedPaise: 0n,
      platformFeePaise: 0n,
      netPaise: 0n,
    };
    for (const e of events) {
      totals.begun += e.begun;
      totals.confirmed += e.confirmed;
      totals.capacity += e.capacity;
      totals.checkedIn += e.checkedIn;
      totals.noShows += e.noShows;
      totals.withdrawn += e.withdrawn;
      totals.offline += e.offline;
      totals.refunds += e.refunds;
      totals.grossPaise += e.grossPaise;
      totals.refundedPaise += e.refundedPaise;
      totals.platformFeePaise += e.platformFeePaise;
      totals.netPaise += e.netPaise;
    }
    totals.fillRate = totals.capacity > 0 ? Math.min(1, totals.confirmed / totals.capacity) : 0;
    return { events, totals, from: range.from, to: range.to, asOf: now() };
  }

  return { eventAnalytics, organisationAnalytics };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
