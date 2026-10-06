/**
 * Payout provider port (spec 2026-10-02-host-payouts). The ONLY place a payout
 * provider is spoken to and its secrets used, like paymentGateway.ts for
 * collection. Amounts are bigint paise; a provider's payloads never leave its
 * adapter.
 *
 * A webhook is a hint: `refFromWebhook` only says WHICH transfer to ask about,
 * and only once its signature verifies. The state always comes from
 * `transferStatus` (payouts R13): one path decides, however the news arrived.
 */
import { GatewayError } from '../gatewayError.js';

export { GatewayError };

export interface AccountCheck {
  outcome: 'exists' | 'missing' | 'pending';
  nameAtBank: string | null;
  /** The provider's 0–100 name match score, rounded. Null when it did not score. */
  nameMatch: number | null;
  error: string | null;
}

export type TransferState = 'pending' | 'success' | 'failed' | 'reversed' | 'unknown';

export interface TransferStatus {
  state: TransferState;
  providerStatus: string | null;
  providerRef: string | null;
  message: string | null;
}

export interface BankDetails {
  accountNumber: string;
  ifsc: string;
  name: string;
}

export interface PayoutProvider {
  readonly name: string;
  /**
   * PAYOUT_PROVIDER=manual — a person checks bank accounts and sends the
   * money from PL4Y's bank, then records the UTR. The service never calls
   * verifyAccount, availablePaise, transfer or transferStatus on it.
   */
  readonly manual?: boolean;
  verifyAccount(input: BankDetails & { ref: string }): Promise<AccountCheck>;
  availablePaise(): Promise<bigint>;
  /** Accepted means the provider took it; the outcome comes from transferStatus. */
  transfer(
    input: BankDetails & { ref: string; amountPaise: bigint; mode: 'IMPS' | 'NEFT'; purpose: string },
  ): Promise<{ accepted: boolean; error: string | null }>;
  transferStatus(ref: string): Promise<TransferStatus>;
  /**
   * The transfer ref a webhook is about, or null when the signature does not
   * verify or it names none. Never trusted beyond that.
   */
  refFromWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): string | null;
}

const notConfigured = (): never => {
  throw new GatewayError(503, 'No payout provider is configured');
};

/** What runs with PAYOUT_PROVIDER=none: nothing can verify or pay. */
export const unconfiguredPayouts: PayoutProvider = {
  name: 'none',
  verifyAccount: async () => notConfigured(),
  availablePaise: async () => notConfigured(),
  transfer: async () => notConfigured(),
  transferStatus: async () => notConfigured(),
  refFromWebhook: () => null,
};
