/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { config } from '../../platform/config.js';
import { email } from '../../platform/email.js';
import { logger } from '../../platform/logging/index.js';
import { consumeAll } from '../../platform/rateLimit.js';
import { confirmationEmail, teamEmail } from './emails.js';
import { createVendorService } from './service/index.js';

/** vendors R4 — falls back to the partnership list when no shop list is set. */
const teamInbox = () => (config.VENDOR_NOTIFY_EMAILS.length > 0 ? config.VENDOR_NOTIFY_EMAILS : config.PARTNERSHIP_NOTIFY_EMAILS);

/** vendors — the PL4Y Shop vendor form and its review in the portal. */
export const vendors = createVendorService({
  db,
  limiter: { consumeAll: (checks) => consumeAll(checks) },
  mail: {
    async confirmation(application) {
      try {
        await email.send({ to: application.contactEmail, ...confirmationEmail(application) });
        return true;
      } catch (err) {
        logger.warn({ err, applicationId: application.id }, 'vendor confirmation email failed');
        return false;
      }
    },
    async team(application) {
      const rendered = teamEmail(application, config.PORTAL_URL);
      for (const to of teamInbox()) {
        await email
          .send({ to, ...rendered })
          .catch((err: unknown) => logger.warn({ err, applicationId: application.id }, 'vendor team email failed'));
      }
    },
  },
});

export { FULFILMENT, PRODUCTS, SELLER, SELLER_TYPE_TITLES, SELLER_TYPES, SPORTS, STEP_TITLES, STEPS } from './service/form.js';
export type { SellerType, Sport, StepKey } from './service/form.js';
export { displayName, VENDOR_STATUSES, VendorCode } from './service/index.js';
export type { Filter, Receipt, StatusChange, VendorApplication, VendorNote, VendorStatus } from './service/index.js';
