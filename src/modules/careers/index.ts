/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { cloudinary } from '../../platform/cloudinary.js';
import { config } from '../../platform/config.js';
import { email } from '../../platform/email.js';
import { logger } from '../../platform/logging/index.js';
import { consumeAll } from '../../platform/rateLimit.js';
import { confirmationEmail, teamEmail } from './emails.js';
import { createCareerService } from './service/index.js';

/** careers R4 — falls back to the partnership list when no careers list is set. */
const teamInbox = () => (config.CAREER_NOTIFY_EMAILS.length > 0 ? config.CAREER_NOTIFY_EMAILS : config.PARTNERSHIP_NOTIFY_EMAILS);

/** careers — the Campus Ambassador / Sales Internship form and its review in the portal. */
export const careers = createCareerService({
  db,
  limiter: { consumeAll: (checks) => consumeAll(checks) },
  files: {
    root: (clientToken) => cloudinary.folders.careerRoot(clientToken),
    signUpload: (opts) => cloudinary.signPrivateUpload(opts),
    bytes: (publicId) => cloudinary.privateFileBytes(publicId),
    downloadUrl: (publicId) => cloudinary.privateDownloadUrl(publicId, { ttlSeconds: 300 }),
    destroy: (publicId) => cloudinary.destroyPrivate(publicId),
  },
  mail: {
    async confirmation(application) {
      try {
        await email.send({ to: application.email, ...confirmationEmail(application) });
        return true;
      } catch (err) {
        logger.warn({ err, applicationId: application.id }, 'career confirmation email failed');
        return false;
      }
    },
    async team(application) {
      const rendered = teamEmail(application, config.PORTAL_URL);
      for (const to of teamInbox()) {
        await email
          .send({ to, ...rendered })
          .catch((err: unknown) => logger.warn({ err, applicationId: application.id }, 'career team email failed'));
      }
    },
  },
});

export { AMBASSADOR, BASIC, HEARD_FROM, OPPORTUNITIES, OPPORTUNITY_TITLES, QUESTIONS, SALES, SECTION_TITLES } from './service/form.js';
export type { Opportunity } from './service/form.js';
export { CAREER_STATUSES, CareerCode, RESUME_MAX_BYTES, RETENTION_DAYS } from './service/index.js';
export type { CareerApplication, CareerNote, CareerStatus, Filter, Receipt, ResumeUpload, StatusChange } from './service/index.js';
