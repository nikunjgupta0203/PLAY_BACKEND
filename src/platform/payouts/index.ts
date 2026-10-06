/** Selects the payout provider from config (spec 2026-10-02-host-payouts). */
import { config } from '../config.js';
import { createManualPayouts } from './manual.js';
import { createMockPayouts } from './mock.js';
import { createRazorpayXPayouts } from './razorpayx.js';
import { unconfiguredPayouts, type PayoutProvider } from './port.js';

export * from './port.js';

export const payoutProvider: PayoutProvider =
  config.PAYOUT_PROVIDER === 'razorpayx'
    ? createRazorpayXPayouts({
        keyId: config.RAZORPAYX_KEY_ID,
        keySecret: config.RAZORPAYX_KEY_SECRET,
        accountNumber: config.RAZORPAYX_ACCOUNT_NUMBER,
        webhookSecret: config.RAZORPAYX_WEBHOOK_SECRET,
      })
    : config.PAYOUT_PROVIDER === 'manual'
      ? createManualPayouts()
      : config.PAYOUT_PROVIDER === 'mock'
        ? createMockPayouts()
        : unconfiguredPayouts;

export const payoutsConfigured = (): boolean => payoutProvider !== unconfiguredPayouts;
