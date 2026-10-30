/** The ONLY surface other modules may import (conventions.md §1). */
import { config } from '../../platform/config.js';
import { db } from '../../platform/db.js';
import { consume } from '../../platform/rateLimit.js';
import { createRewardsService } from './service/index.js';

export const rewards = createRewardsService({
  db,
  limiter: { consume },
  async notify(userId, template, payload) {
    const { notifications } = await import('../notifications/index.js');
    await notifications.emit(userId, template, payload as never, { kind: 'route', route: 'rewards' });
  },
  async recordSignal(input) {
    const { admin } = await import('../admin/index.js');
    return admin.recordSignal(input);
  },
  async alert(subject, text) {
    const { opsAlert } = await import('../payments/index.js');
    await opsAlert(subject, text);
  },
});

/** The link a player shares: the website opens the app, or the store, with the code. */
export const referralLink = (code: string): string => `${config.EMAIL_LINK_BASE.replace(/\/$/, '')}/r/${encodeURIComponent(code)}`;

export { MIN_CHARGE_PAISE, RewardCode, discountOf, makeCode, normaliseCode, pickDiscount } from './service/index.js';
export type {
  Discount,
  OrderFacts,
  Referral,
  ReferralStatus,
  Reward,
  RewardKind,
  RewardStatus,
  RewardsService,
  Settings as RewardSettings,
  SettingsPatch as RewardSettingsPatch,
  WelcomeOffer,
} from './service/index.js';
