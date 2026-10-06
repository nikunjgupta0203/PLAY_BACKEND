/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { email } from '../../platform/email.js';
import { consumeAll } from '../../platform/rateLimit.js';
import { profile } from '../profile/index.js';
import { createIdentityService } from './service/index.js';

export const identity = createIdentityService({
  db,
  email,
  limiter: { consumeAll },
  profile,
  // identity R18 — what must finish before an account can be deleted. Reached
  // lazily: registration imports identity back, and identity sits at L0.
  deletionGuards: [
    async (userId) => {
      const { registration } = await import('../registration/index.js');
      return (await registration.hasUpcomingConfirmedEntry(userId))
        ? ['UPCOMING_CONFIRMED_ENTRY']
        : [];
    },
    // payouts R16 — owed a payout, or owing a receivable back.
    async (userId) => {
      const { payoutsDeletionGuard } = await import('../payments/service/payouts.js');
      const { db } = await import('../../platform/db.js');
      return payoutsDeletionGuard(db)(userId);
    },
  ],
});

export { IdentityCode, OTP_WINDOWS, highestGrant, normaliseEmail } from './service/index.js';
export type {
  DeletionGuard,
  Grant,
  GrantSource,
  OtpPurpose,
  PlatformRole,
  SessionPair,
  StaffRole,
} from './service/index.js';
