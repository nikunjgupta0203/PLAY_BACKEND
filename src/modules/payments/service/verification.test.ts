import { describe, expect, it } from 'vitest';
import { decideVerification, rejectionText } from './verification.js';

const exists = (nameMatch: number | null) => ({ outcome: 'exists' as const, nameAtBank: 'RAHUL SHARMA', nameMatch, error: null });

describe('payouts R3, R4 — decideVerification', () => {
  it('verifies a strong match with a matching surname', () => {
    expect(decideVerification(exists(96), true, 80)).toEqual({ status: 'verified' });
    expect(decideVerification(exists(80), true, 80)).toEqual({ status: 'verified' });
  });

  it('sends a weak bank match to review', () => {
    expect(decideVerification(exists(22), true, 80)).toEqual({ status: 'needs_review', reason: 'bank_name_mismatch' });
  });

  it('sends a surname mismatch to review even on a perfect bank match', () => {
    expect(decideVerification(exists(100), false, 80)).toEqual({ status: 'needs_review', reason: 'pan_surname_mismatch' });
  });

  it('sends an unscored match to review', () => {
    expect(decideVerification(exists(null), true, 80)).toEqual({ status: 'needs_review', reason: 'bank_check_inconclusive' });
  });

  it('retries a pending check', () => {
    expect(decideVerification({ outcome: 'pending', nameAtBank: null, nameMatch: null, error: null }, true, 80)).toEqual({
      status: 'retry',
    });
  });

  it('rejects a missing account with plain words', () => {
    expect(
      decideVerification({ outcome: 'missing', nameAtBank: null, nameMatch: null, error: 'Invalid account' }, true, 80),
    ).toEqual({ status: 'rejected', reason: rejectionText('Invalid account') });
  });

  it('says what to fix', () => {
    expect(rejectionText('Invalid IFSC code')).toMatch(/IFSC/);
    expect(rejectionText(null)).toMatch(/account number and IFSC/);
  });
});
