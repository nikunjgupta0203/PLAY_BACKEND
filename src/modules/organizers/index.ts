/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { email } from '../../platform/email.js';
import { identity } from '../identity/index.js';
import { createAnalyticsService } from './service/analytics.js';
import { createOrganisationService } from './service/index.js';
import { organisationInviteEmail } from './service/inviteEmail.js';

export const organisations = createOrganisationService({
  db,
  identity: {
    findByEmail: (address) => identity.findByEmail(address),
    syncOrganizerGrants: (tx, input) => identity.syncOrganizerGrants(tx, input),
  },
  async notify(userId, organisation, change, role) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(
      userId,
      'organisation.membership',
      { organisationName: organisation.name, change, role },
      { kind: 'route', route: 'organisation', id: organisation.slug },
    );
  },
  async sendInvite(to, organisation, role, expiresAt) {
    await email.send({ to, ...organisationInviteEmail({ to, organisationName: organisation.name, role, expiresAt }) });
  },
  payouts: {
    async setOrganisationAccountHolder(organisationId, userId, tx) {
      const { payouts } = await import('../payments/index.js');
      await payouts.setOrganisationAccountHolder(organisationId, userId, tx);
    },
  },
});

/** organizers — host analytics, read through each owning module's service. */
export const analytics = createAnalyticsService({
  events: {
    async byIds(ids) {
      const { events } = await import('../events/index.js');
      const found = await Promise.all(ids.map((id) => events.findById(id)));
      return found
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => ({ id: e.id, title: e.title, slug: e.slug, startsAt: e.startsAt, status: e.status }));
    },
    async categoriesFor(eventId) {
      const { events } = await import('../events/index.js');
      return (await events.categoriesFor(eventId)).map((c) => ({ id: c.id, name: c.name, capacity: c.capacity }));
    },
  },
  registration: {
    async statsForEvents(eventIds) {
      const { registration } = await import('../registration/index.js');
      return registration.statsForEvents(eventIds);
    },
  },
  payments: {
    async ledgerSummary(eventIds) {
      const { payments } = await import('../payments/index.js');
      return payments.ledgerSummary(eventIds);
    },
  },
  eventIdsOfOrganisation: (organisationId) => organisations.eventIdsOf(organisationId),
});

// org — an invite sent before its person had an account is claimed at their
// first sign-in, with nothing to type.
identity.registerSignInHook((user) => organisations.claimInvites(user).then(() => undefined));

export { OrgCode, INVITE_TTL_MS, slugifyName } from './service/index.js';
export type { Invite, Member, Organisation, OrganisationService, OrgRole, Verification } from './service/index.js';
export type { CategoryStats, EventAnalytics, OrganiserAnalytics } from './service/analytics.js';
