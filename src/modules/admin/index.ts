/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { email } from '../../platform/email.js';
import { logger } from '../../platform/logging/index.js';
import { createAdminService } from './service/index.js';

export const admin = createAdminService({
  db,
  async setReviewHidden(reviewId, hidden) {
    const { venues } = await import('../venues/index.js');
    return venues.setReviewHidden(reviewId, hidden);
  },
  async notifySupportReply(userId, ticketId, subject) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, 'support.reply', { subject }, { kind: 'route', route: 'support_ticket', id: ticketId });
  },
  async emailSupportReply(userId, subject, body) {
    const { identity } = await import('../identity/index.js');
    const [contact] = await identity.contactsByIds([userId]);
    if (!contact?.email) return;
    try {
      await email.send({
        to: contact.email,
        subject: `PL4Y support: ${subject}`,
        text: `${body}\n\nReply from the PL4Y app: Settings → Help & support.`,
      });
    } catch (err) {
      logger.warn({ err }, 'support reply email failed');
    }
  },
});

export {
  AdminServiceCode,
  AUTO_HIDE_REPORTERS,
  FRAUD_CASE_THRESHOLD,
  RATING_PAIR,
  BOOKING_NO_SHOWS,
  HOST_CANCELLATIONS,
} from './service/index.js';
export type {
  AdminService,
  FraudCase,
  FraudSignal,
  FraudSubject,
  ModerationCase,
  ModerationReport,
  ReportReason,
  ReportStatus,
  ReportTarget,
  SupportMessage,
  SupportTicket,
  TicketLink,
  TicketStatus,
} from './service/index.js';
