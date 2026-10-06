/**
 * Registration state → `registration.updated` on every entrant's
 * private-user-{id} channel.
 *
 * Invalidation only: the payload names the registration and the topic, and the
 * client refetches `registration(id)` over GraphQL. A missed or reordered
 * message cannot put a client in a wrong state (architecture.md: Pusher is a
 * cache-invalidation transport).
 *
 * Publishing is BEST-EFFORT (C1): a `loadEntry` or `publisher.publish` failure
 * is logged at `warn` and swallowed. It is never retried, because clients poll
 * (frontend checkout R2) and a retry would pin the oldest outbox rows in
 * place — claimBatch orders by id, and markFailed only clears the claim, it
 * does not move the row. The outbox row this runs inside of must never fail
 * because a third party is down.
 *
 * Lives in platform/ and reads tables through `db` directly rather than calling
 * the registration module, because platform/ may not import modules/.
 */
import { db } from '../db.js';
import { logger } from '../logging/index.js';
import { realtime, type RealtimePublisher } from '../pusher.js';

export const REGISTRATION_UPDATE_TOPICS: readonly string[] = [
  'hold.created',
  'invite.created',
  'invite.declined',
  'registration.confirmed',
  'registration.payment_failed',
  'registration.expired',
  'registration.cancelled',
  'registration.checked_in',
  'refund.processed',
];

export const REGISTRATION_UPDATED_EVENT = 'registration.updated';

export interface RegistrationEntry {
  captainUserId: string;
  team: { members: { userId: string }[] } | null;
}

export function recipientsOf(entry: RegistrationEntry): string[] {
  const ids = [entry.captainUserId, ...(entry.team?.members.map((m) => m.userId) ?? [])];
  return [...new Set(ids)];
}

export function createRegistrationNotifier(deps: {
  publisher: RealtimePublisher;
  loadEntry: (registrationId: string) => Promise<RegistrationEntry | null>;
}) {
  return {
    async notify(topic: string, payload: Record<string, unknown>): Promise<void> {
      if (!REGISTRATION_UPDATE_TOPICS.includes(topic)) return;
      const registrationId = payload['registrationId'];
      if (typeof registrationId !== 'string' || registrationId === '') return;

      // C1 — best-effort. Pusher is an invalidation hint and clients already
      // poll (frontend checkout R2); the outbox row must never fail, and must
      // never be retried, because of Pusher. A retry would pin the oldest
      // outbox rows in place: claimBatch orders by id, and markFailed clears
      // the claim so the same rows are claimed again on the next drain.
      try {
        const entry = await deps.loadEntry(registrationId);
        if (!entry) return;

        await deps.publisher.publish(
          recipientsOf(entry).map((userId) => `private-user-${userId}`),
          REGISTRATION_UPDATED_EVENT,
          { registrationId, topic },
        );
      } catch (err) {
        logger.warn({ topic, registrationId, err }, 'realtime publish failed — dropped, never retried');
      }
    },
  };
}

export const registrationNotifier = createRegistrationNotifier({
  publisher: realtime,
  loadEntry: (registrationId) =>
    db.registration.findUnique({
      where: { id: registrationId },
      select: { captainUserId: true, team: { select: { members: { select: { userId: true } } } } },
    }),
});
