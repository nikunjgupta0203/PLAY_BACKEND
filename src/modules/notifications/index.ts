/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { logger } from '../../platform/logging/index.js';
import { push } from '../../platform/push.js';
import { realtime } from '../../platform/pusher.js';
import { QUEUES, defaultJobOptions, queue } from '../../platform/queue.js';
import { createNotificationsService } from './service/index.js';

export const notifications = createNotificationsService({
  db,
  push,
  async enqueuePush(notificationIds, opts) {
    // The push is a separate, failable job (R1). Final failure: DROP — the
    // feed row already exists. `at` is a push held by quiet hours (R3).
    const delay = opts?.at ? Math.max(opts.at.getTime() - Date.now(), 0) : 0;
    await queue(QUEUES.notify).add('send-push', { notificationIds }, { ...defaultJobOptions, delay });
  },
  async enqueueReceiptCheck(tickets) {
    // Expo publishes receipts within about fifteen minutes of the send.
    await queue(QUEUES.notify).add('check-push-receipts', { tickets }, { ...defaultJobOptions, delay: 15 * 60_000 });
  },
  async announce(userIds) {
    // The badge hint (client notifications R9). Invalidation only: the app
    // refetches `unreadNotificationCount`. Best-effort, like every publish.
    try {
      for (let i = 0; i < userIds.length; i += 100) {
        await realtime.publish(
          userIds.slice(i, i + 100).map((id) => `private-user-${id}`),
          'notification.created',
          {},
        );
      }
    } catch (err) {
      logger.warn({ err }, 'notification badge publish failed — dropped');
    }
  },
});

export { BULK_CHUNK, NotificationCode } from './service/index.js';
export { DEEP_LINK_ROUTES, TEMPLATES, inQuietHours, render } from './templates.js';
export type {
  Delivery,
  Notification,
  NotificationsService,
  Preferences,
} from './service/index.js';
export type { DeepLinkRoute, Target, TemplateKey, TemplatePayloads } from './templates.js';
