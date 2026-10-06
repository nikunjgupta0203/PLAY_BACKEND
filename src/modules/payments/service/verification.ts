/**
 * payouts R3, R4 — what one penny-test answer means for an account. Pure, so
 * every row of the spec's tables is a unit test.
 */
import type { AccountCheck } from '../../../platform/payouts/port.js';

export type VerifyDecision =
  | { status: 'verified' }
  | { status: 'needs_review'; reason: 'bank_name_mismatch' | 'pan_surname_mismatch' | 'bank_check_inconclusive' }
  | { status: 'rejected'; reason: string }
  | { status: 'retry' };

export function decideVerification(check: AccountCheck, panSurnameOk: boolean, autoThreshold: number): VerifyDecision {
  if (check.outcome === 'pending') return { status: 'retry' };
  if (check.outcome === 'missing') return { status: 'rejected', reason: rejectionText(check.error) };
  // A surname flag stops auto-verification even on a perfect bank match: the
  // bank proves the account is the host's, not that the PAN is.
  if (!panSurnameOk) return { status: 'needs_review', reason: 'pan_surname_mismatch' };
  if (check.nameMatch === null) return { status: 'needs_review', reason: 'bank_check_inconclusive' };
  if (check.nameMatch < autoThreshold) return { status: 'needs_review', reason: 'bank_name_mismatch' };
  return { status: 'verified' };
}

/** What the host reads. The provider's own words are a hint, never shown raw. */
export function rejectionText(providerError: string | null): string {
  if (providerError && /ifsc/i.test(providerError)) {
    return "That IFSC code didn't match a bank branch. Check it and save again.";
  }
  return "We couldn't find this bank account. Check the account number and IFSC, then save again.";
}
