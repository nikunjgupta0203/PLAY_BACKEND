/** A scripted PayoutProvider. Tests push answers; the network is never touched. */
import type { AccountCheck, PayoutProvider, TransferStatus } from '../../src/platform/payouts/port.js';
import { GatewayError } from '../../src/platform/payouts/port.js';

export class FakePayouts implements PayoutProvider {
  readonly name = 'fake';
  /** Manual payouts — flip to act as PAYOUT_PROVIDER=manual; then nothing below may be called. */
  manual = false;
  /** Every provider call, by name: manual payouts must make none. */
  calls: string[] = [];
  checks: AccountCheck[] = [];
  balance = 1_000_000_000n;
  transferAnswers: ({ accepted: boolean; error: string | null } | 'timeout')[] = [];
  statuses = new Map<string, TransferStatus>();
  verified: { ref: string; accountNumber: string; name: string }[] = [];
  transfers: { ref: string; amountPaise: bigint; accountNumber: string; mode: string }[] = [];

  async verifyAccount(input: { ref: string; accountNumber: string; ifsc: string; name: string }): Promise<AccountCheck> {
    this.calls.push('verifyAccount');
    this.verified.push({ ref: input.ref, accountNumber: input.accountNumber, name: input.name });
    const next = this.checks.shift();
    if (!next) throw new GatewayError(503, 'no scripted check');
    return next;
  }

  async availablePaise(): Promise<bigint> {
    this.calls.push('availablePaise');
    return this.balance;
  }

  async transfer(input: { ref: string; amountPaise: bigint; accountNumber: string; mode: 'IMPS' | 'NEFT' }) {
    this.calls.push('transfer');
    const answer = this.transferAnswers.shift() ?? { accepted: true, error: null };
    // A timeout AFTER RazorpayX took the transfer: the money moves, we never hear.
    this.transfers.push({ ref: input.ref, amountPaise: input.amountPaise, accountNumber: input.accountNumber, mode: input.mode });
    if (answer === 'timeout') throw new GatewayError(503, 'timeout');
    return answer;
  }

  async transferStatus(ref: string): Promise<TransferStatus> {
    this.calls.push('transferStatus');
    return this.statuses.get(ref) ?? { state: 'unknown', providerStatus: null, providerRef: null, message: null };
  }

  refFromWebhook(raw: Buffer): string | null {
    const ref = raw.toString('utf8');
    return ref.length > 0 ? ref : null;
  }

  succeed(ref: string): void {
    this.statuses.set(ref, { state: 'success', providerStatus: 'SUCCESS', providerRef: `PAYOUT-${ref}`, message: null });
  }

  fail(ref: string, state: 'failed' | 'reversed' = 'failed'): void {
    this.statuses.set(ref, { state, providerStatus: state.toUpperCase(), providerRef: null, message: 'bank said no' });
  }
}

export const exists = (nameMatch: number | null): AccountCheck => ({
  outcome: 'exists',
  nameAtBank: 'RAHUL SHARMA',
  nameMatch,
  error: null,
});
