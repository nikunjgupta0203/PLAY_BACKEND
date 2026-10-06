import { describe, expect, it, vi } from 'vitest';
import type { RealtimePublisher } from '../pusher.js';
import {
  REGISTRATION_UPDATE_TOPICS,
  createRegistrationNotifier,
  recipientsOf,
  type RegistrationEntry,
} from './registrationUpdates.js';

function fakePublisher() {
  const publish = vi.fn(async () => {});
  const publisher: RealtimePublisher = { enabled: true, publish };
  return { publisher, publish };
}

const doubles: RegistrationEntry = {
  captainUserId: 'captain',
  team: { members: [{ userId: 'captain' }, { userId: 'partner' }] },
};
// M9 — the captain does NOT come first among team members, so de-duplication
// (rather than list order) is what this fixture actually exercises.
const doublesOutOfOrder: RegistrationEntry = {
  captainUserId: 'captain',
  team: { members: [{ userId: 'partner' }, { userId: 'captain' }, { userId: 'partner' }] },
};
const singles: RegistrationEntry = { captainUserId: 'solo', team: null };

describe('registration realtime notifier', () => {
  it('recipients: captain plus every team member, de-duplicated', () => {
    expect(recipientsOf(doubles)).toEqual(['captain', 'partner']);
    expect(recipientsOf(doublesOutOfOrder)).toEqual(['captain', 'partner']);
    expect(recipientsOf(singles)).toEqual(['solo']);
  });

  it('publishes an invalidation to each entrant’s private-user channel', async () => {
    const { publisher, publish } = fakePublisher();
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => doubles });
    await notifier.notify('registration.confirmed', { registrationId: 'r1', paymentId: 'p1' });
    expect(publish).toHaveBeenCalledWith(
      ['private-user-captain', 'private-user-partner'],
      'registration.updated',
      { registrationId: 'r1', topic: 'registration.confirmed' },
    );
  });

  it('carries no status, money or QR — invalidation only', async () => {
    const { publisher, publish } = fakePublisher();
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => singles });
    await notifier.notify('hold.created', {
      holdId: 'h', registrationId: 'r2', eventCategoryId: 'c', expiresAt: '2026-01-01T00:00:00Z',
    });
    const data = (publish.mock.calls[0] as unknown[])[2];
    expect(Object.keys(data as object).sort()).toEqual(['registrationId', 'topic']);
  });

  it('payment.captured and payment.failed publish nothing (registration.* follows)', async () => {
    const { publisher, publish } = fakePublisher();
    const loadEntry = vi.fn(async () => singles);
    const notifier = createRegistrationNotifier({ publisher, loadEntry });
    await notifier.notify('payment.captured', { registrationId: 'r3' });
    await notifier.notify('payment.failed', { registrationId: 'r3' });
    expect(publish).not.toHaveBeenCalled();
    expect(loadEntry).not.toHaveBeenCalled();
    expect(REGISTRATION_UPDATE_TOPICS).not.toContain('payment.captured');
  });

  it('a missing or null registration id, or an unknown registration, publishes nothing', async () => {
    const { publisher, publish } = fakePublisher();
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => null });
    await notifier.notify('refund.processed', { refundId: 'x', registrationId: null });
    await notifier.notify('invite.declined', { inviteId: 'i' });
    await notifier.notify('registration.expired', { registrationId: 'gone' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('a publish failure is logged and swallowed — realtime never blocks the outbox', async () => {
    const publisher: RealtimePublisher = {
      enabled: true,
      publish: vi.fn(async () => {
        throw new Error('HTTP 500');
      }),
    };
    const notifier = createRegistrationNotifier({ publisher, loadEntry: async () => singles });
    await expect(
      notifier.notify('registration.cancelled', { registrationId: 'r4' }),
    ).resolves.toBeUndefined();
  });

  it('a loadEntry rejection is also swallowed — realtime never blocks the outbox', async () => {
    const { publisher, publish } = fakePublisher();
    const loadEntry = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const notifier = createRegistrationNotifier({ publisher, loadEntry });
    await expect(
      notifier.notify('registration.confirmed', { registrationId: 'r5' }),
    ).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it('covers exactly the nine topics in the spec', () => {
    expect([...REGISTRATION_UPDATE_TOPICS].sort()).toEqual([
      'hold.created',
      'invite.created',
      'invite.declined',
      'refund.processed',
      'registration.cancelled',
      'registration.checked_in',
      'registration.confirmed',
      'registration.expired',
      'registration.payment_failed',
    ]);
  });
});
