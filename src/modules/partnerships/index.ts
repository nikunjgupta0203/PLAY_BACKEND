/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { cloudinary } from '../../platform/cloudinary.js';
import { config } from '../../platform/config.js';
import { email } from '../../platform/email.js';
import { logger } from '../../platform/logging/index.js';
import { consumeAll } from '../../platform/rateLimit.js';
import { confirmationEmail, teamEmail } from './emails.js';
import { createPartnershipService } from './service/index.js';

/** partnerships — the shareable partnership form and its review in the portal. */
export const partnerships = createPartnershipService({
  db,
  limiter: { consumeAll: (checks) => consumeAll(checks) },
  media: {
    signUpload: (opts) => cloudinary.signUpload(opts),
    root: (clientToken) => cloudinary.folders.partnershipRoot(clientToken),
  },
  mail: {
    async confirmation(application) {
      try {
        await email.send({ to: application.contactEmail, ...confirmationEmail(application) });
        return true;
      } catch (err) {
        logger.warn({ err, applicationId: application.id }, 'partnership confirmation email failed');
        return false;
      }
    },
    async team(application) {
      const rendered = teamEmail(application, config.PORTAL_URL);
      for (const to of config.PARTNERSHIP_NOTIFY_EMAILS) {
        await email
          .send({ to, ...rendered })
          .catch((err: unknown) => logger.warn({ err, applicationId: application.id }, 'partnership team email failed'));
      }
    },
  },
});

export { flatten, read, MAX_ENTRIES, MAX_IMAGES } from './service/answers.js';
export type { Answer, Answers } from './service/answers.js';
export { APPLICANT_TYPES, BASIC, CATEGORIES, CATEGORY_TITLES, SECTIONS } from './service/form.js';
export type { ApplicantType, Category, Field } from './service/form.js';
export { displayName, PARTNERSHIP_STATUSES, PartnershipCode } from './service/index.js';
export type {
  Filter,
  PartnershipApplication,
  PartnershipNote,
  PartnershipService,
  PartnershipStatus,
  Receipt,
  StatusChange,
} from './service/index.js';
