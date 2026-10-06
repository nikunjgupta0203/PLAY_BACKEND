/**
 * Manual payouts (PAYOUT_PROVIDER=manual). For a PL4Y that cannot use
 * RazorpayX: staff review every bank account in the portal, and a due payout
 * waits in "Ready to pay" until someone sends it from PL4Y's bank and records
 * the UTR (markPayoutPaid). Nothing here talks to a bank, so every call the
 * service is not meant to make fails loudly.
 */
import { GatewayError, type PayoutProvider } from './port.js';

const byHand = (): never => {
  throw new GatewayError(503, 'Manual payouts: a person does this in the admin portal');
};

export function createManualPayouts(): PayoutProvider {
  return {
    name: 'manual',
    manual: true,
    verifyAccount: async () => byHand(),
    availablePaise: async () => byHand(),
    transfer: async () => byHand(),
    transferStatus: async () => byHand(),
    refFromWebhook: () => null,
  };
}
