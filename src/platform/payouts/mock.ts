/**
 * Dev-only payout provider (PAYOUT_PROVIDER=mock; refused in production by
 * config). Every account exists and matches 95; every transfer succeeds; the
 * balance is a crore. Enough to click through the app without RazorpayX.
 */
import type { PayoutProvider } from './port.js';

export function createMockPayouts(): PayoutProvider {
  return {
    name: 'mock',
    verifyAccount: async (input) => ({ outcome: 'exists', nameAtBank: input.name.toUpperCase(), nameMatch: 95, error: null }),
    availablePaise: async () => 1_000_000_000n,
    transfer: async () => ({ accepted: true, error: null }),
    transferStatus: async (ref) => ({ state: 'success', providerStatus: 'SUCCESS', providerRef: `MOCK-${ref}`, message: null }),
    refFromWebhook: () => null,
  };
}
