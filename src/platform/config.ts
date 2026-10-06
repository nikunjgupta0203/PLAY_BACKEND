/**
 * The ONLY file in the codebase that reads process.env (platform R1).
 * An eslint rule enforces that; CI greps for it too.
 *
 * Validation happens at boot and the process EXITS on failure (platform R2).
 * A missing JWT key must stop a deploy, not surface as a failed sign-in three
 * hours into a tournament.
 *
 * Nothing here loads a .env file, and nothing should. Every entrypoint script
 * passes `--env-file-if-exists=.env` instead — do not remove that flag. Without
 * it the app boots only by accident: `@prisma/client` loads .env as an import
 * side effect, so whether this file sees a populated process.env depends on
 * whether the entrypoint's module graph happens to reach Prisma first. Under
 * that regime `pnpm dev` exits on a missing DATABASE_URL while `pnpm seed`
 * works, and reordering two imports flips it.
 */
import { z } from 'zod';

const int = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

/** Exported for its own tests; everything else reads `config`. */
export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(1, 65535).default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  // ── Database (ADR 0001 §C2) ──────────────────────────────────────────────
  // url is Neon's POOLED endpoint; directUrl the DIRECT one. Both required.
  DATABASE_URL: z.string().url(),
  DIRECT_DATABASE_URL: z.string().url(),
  // Interactive transaction timeout. 5000 is Prisma's own default.
  DB_TX_TIMEOUT_MS: int(1000, 120_000).default(5000),

  // ── Auth ─────────────────────────────────────────────────────────────────
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: int(60, 3600).default(900), // identity R5
  REFRESH_TOKEN_TTL_DAYS: int(1, 365).default(60), // identity R6
  OTP_TTL_MINUTES: int(1, 60).default(10), // identity R1
  OTP_MAX_ATTEMPTS: int(1, 10).default(5), // identity R2
  // Local development only. These addresses sign in with DEV_OTP_CODE and no
  // challenge, and `pnpm seed` creates their accounts. Refused in production
  // below, so a copied .env cannot open a backdoor on a deploy.
  DEV_OTP_BYPASS_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    ),
  DEV_OTP_CODE: z.string().regex(/^\d{6}$/).default('000000'),
  // Test / store-review accounts. Unlike the dev list these work in
  // production, so the code must be set explicitly and cannot be the dev
  // default (refined below). `pnpm seed` creates the accounts. Empty = off.
  TEST_LOGIN_EMAILS: z
    .string()
    .default('')
    .transform((v) =>
      new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    ),
  TEST_LOGIN_CODE: z.string().regex(/^\d{6}$/).or(z.literal('')).default(''),

  // ── Registration (registration R3) ───────────────────────────────────────
  // Both are config rather than literals because both WILL be tuned: ten
  // minutes is a guess about how long UPI takes on a bad network, and 48 hours
  // is a guess about how fast a partner reads their email.
  HOLD_TTL_MINUTES: int(1, 120).default(10),
  INVITE_TTL_HOURS: int(1, 336).default(48),
  // registration R10 — check-in opens this long before the event starts and
  // closes the same span after it.
  CHECKIN_WINDOW_HOURS: int(1, 24).default(2),
  // registration R17 — how long a promoted waitlist entry has to pay. An offer
  // made during quiet hours runs to 08:00 IST instead.
  WAITLIST_OFFER_TTL_MINUTES: int(5, 720).default(30),
  // registration R13 — the check-in QR is an HMAC over the registration id.
  // The token names its key id, so the secret rotates: set the new pair as
  // current and move the old one to PREVIOUS ("keyId:secret") until every
  // printed QR has been used.
  CHECKIN_TOKEN_SECRET: z.string().default(''),
  CHECKIN_TOKEN_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,16}$/)
    .default('k1'),
  CHECKIN_TOKEN_PREVIOUS: z.string().default(''),

  // ── Email — Resend (ADR 0002) ────────────────────────────────────────────
  EMAIL_TRANSPORT: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().default(''),
  RESEND_FROM: z.string().default('PL4Y <support@getpl4y.com>'),
  RESEND_WEBHOOK_SECRET: z.string().default(''),
  /** Where buttons in emails point. Paths under it must redirect into the app. */
  EMAIL_LINK_BASE: z.string().url().default('https://getpl4y.com'),
  /** Replies to transactional email land here (the refund email invites one). */
  EMAIL_REPLY_TO: z.string().default(''),

  // ── Later sprints. Optional here so Sprint 1 boots without them, but each
  //    module's own loader asserts its keys before first use.
  // payments — the provider behind platform/paymentGateway.ts. `none` keeps
  // the unconfigured gateway: free entries confirm, paid checkout is
  // GATEWAY_UNAVAILABLE. `mock` (development only) pays every order the
  // moment it is asked about and processes every refund (platform/mockGateway.ts).
  PAYMENT_PROVIDER: z.enum(['none', 'razorpay', 'mock']).default('none'),
  // Test or live is the key itself: rzp_test_… never moves money.
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  // The secret set on the webhook in the Razorpay dashboard — not the key secret.
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  // The backend's public origin. The app opens checkout at
  // `${PUBLIC_API_URL}/payments/razorpay/checkout` and Razorpay posts the
  // player back to `/payments/razorpay/return`, so it must be reachable from a phone.
  PUBLIC_API_URL: z.string().default(''),

  // payouts — hosts are paid through RazorpayX (spec 2026-10-02-host-payouts).
  // `none` leaves paid publishing staff-only; `mock` is the dev provider.
  // `manual` — staff verify bank accounts in the portal and pay hosts from
  // PL4Y's bank, recording the UTR there. No RazorpayX keys.
  PAYOUT_PROVIDER: z.enum(['none', 'mock', 'razorpayx', 'manual']).default('none'),
  // RazorpayX API keys. Often the same pair as RAZORPAY_KEY_*; set both anyway.
  RAZORPAYX_KEY_ID: z.string().default(''),
  RAZORPAYX_KEY_SECRET: z.string().default(''),
  // The RazorpayX account payouts are debited from (its account number in the
  // X dashboard), not a host's bank account.
  RAZORPAYX_ACCOUNT_NUMBER: z.string().default(''),
  // The secret set on the payouts webhook in the RazorpayX dashboard.
  RAZORPAYX_WEBHOOK_SECRET: z.string().default(''),
  // payouts R2 — 32 random bytes, base64. Encrypts PAN and account number.
  PAYOUT_DATA_KEY: z.string().default(''),
  // payouts R3 — Razorpay's name_match_score at or above which a host verifies alone.
  PAYOUT_NAME_MATCH_AUTO: int(0, 100).default(80),
  // payouts R9 — PL4Y is an unregistered business (2026-10-03): it charges no
  // GST and withholds no TDS, so a host receives the entry fees less the 10%
  // commission and nothing else. Set these only if that changes.
  COMMISSION_GST_BPS: int(0, 10_000).default(0),
  HOST_TDS_BPS: int(0, 10_000).default(0),
  PAYOUT_IMPS_MAX_PAISE: z.coerce.bigint().default(50_000_000n),
  // payouts R12 — where "top up the payouts account" goes.
  PAYOUT_ALERT_EMAIL: z.string().default(''),
  // events R3 — PL4Y's platform fee on each paid entry, and the tax rate on
  // what the player pays. Ours to set, never the host's (gap #7). PL4Y is
  // unregistered for GST, so the player pays exactly the entry fee: no
  // platform fee, no tax. PL4Y's income is the 10% host commission.
  PLATFORM_FEE_PAISE: z.coerce.bigint().default(0n),
  ENTRY_TAX_BPS: int(0, 10_000).default(0),

  PUSHER_APP_ID: z.string().default(''),
  PUSHER_KEY: z.string().default(''),
  PUSHER_SECRET: z.string().default(''),
  PUSHER_CLUSTER: z.string().default('ap2'),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  CLOUDINARY_UPLOAD_PRESET: z.string().default(''),
  // notifications — push goes through Expo's push service (the app is Expo);
  // `console` logs instead of sending, so dev and CI never page a real phone.
  PUSH_TRANSPORT: z.enum(['console', 'expo']).default('console'),
  // Only needed once "enhanced push security" is switched on in the Expo project.
  EXPO_ACCESS_TOKEN: z.string().default(''),

  // identity R14 — refund-fraud prevention, not spam prevention.
  DISPOSABLE_EMAIL_DOMAINS: z
    .string()
    .default(
      'mailinator.com,10minutemail.com,guerrillamail.com,tempmail.com,yopmail.com,trashmail.com,sharklasers.com,getnada.com,dispostable.com,maildrop.cc',
    )
    .transform((v) =>
      new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    ),
}).refine((c) => c.NODE_ENV !== 'production' || c.DEV_OTP_BYPASS_EMAILS.size === 0, {
  path: ['DEV_OTP_BYPASS_EMAILS'],
  message: 'must be empty in production',
}).refine(
  (c) => c.TEST_LOGIN_EMAILS.size === 0 || (c.TEST_LOGIN_CODE !== '' && c.TEST_LOGIN_CODE !== '000000'),
  { path: ['TEST_LOGIN_CODE'], message: 'must be set, and not 000000, when TEST_LOGIN_EMAILS is' },
).refine(
  (c) =>
    c.PAYMENT_PROVIDER !== 'razorpay' ||
    (c.RAZORPAY_KEY_ID !== '' &&
      c.RAZORPAY_KEY_SECRET !== '' &&
      c.RAZORPAY_WEBHOOK_SECRET !== '' &&
      /^https?:\/\//.test(c.PUBLIC_API_URL)),
  {
    path: ['PAYMENT_PROVIDER'],
    message: 'razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET and PUBLIC_API_URL',
  },
).refine(
  // A production deploy must never take real players to a test-mode checkout.
  (c) => c.NODE_ENV !== 'production' || c.PAYMENT_PROVIDER !== 'razorpay' || c.RAZORPAY_KEY_ID.startsWith('rzp_live_'),
  { path: ['RAZORPAY_KEY_ID'], message: 'must be a live key (rzp_live_…) in production when PAYMENT_PROVIDER=razorpay' },
).refine(
  // The app opens checkout here, and Razorpay posts the player back here.
  (c) => c.NODE_ENV !== 'production' || c.PAYMENT_PROVIDER !== 'razorpay' || c.PUBLIC_API_URL.startsWith('https://'),
  { path: ['PUBLIC_API_URL'], message: 'must be https:// in production when PAYMENT_PROVIDER=razorpay' },
).refine(
  (c) =>
    c.PAYOUT_PROVIDER !== 'razorpayx' ||
    (c.RAZORPAYX_KEY_ID !== '' &&
      c.RAZORPAYX_KEY_SECRET !== '' &&
      c.RAZORPAYX_ACCOUNT_NUMBER !== '' &&
      c.RAZORPAYX_WEBHOOK_SECRET !== ''),
  {
    path: ['PAYOUT_PROVIDER'],
    message: 'razorpayx needs RAZORPAYX_KEY_ID, _KEY_SECRET, _ACCOUNT_NUMBER and _WEBHOOK_SECRET',
  },
).refine(
  (c) => c.NODE_ENV !== 'production' || c.PAYOUT_PROVIDER !== 'razorpayx' || c.RAZORPAYX_KEY_ID.startsWith('rzp_live_'),
  { path: ['RAZORPAYX_KEY_ID'], message: 'must be a live key (rzp_live_…) in production when PAYOUT_PROVIDER=razorpayx' },
).refine(
  (c) => c.PAYOUT_PROVIDER === 'none' || Buffer.from(c.PAYOUT_DATA_KEY, 'base64').length === 32,
  { path: ['PAYOUT_DATA_KEY'], message: 'must be 32 bytes, base64, when payouts are on' },
).refine(
  (c) => c.NODE_ENV !== 'production' || c.PAYMENT_PROVIDER !== 'mock',
  { path: ['PAYMENT_PROVIDER'], message: 'mock is for development only' },
).refine(
  (c) => c.NODE_ENV !== 'production' || c.PAYOUT_PROVIDER !== 'mock',
  { path: ['PAYOUT_PROVIDER'], message: 'mock is for development only' },
);

export type Config = z.infer<typeof configSchema>;

function load(): Config {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately console, not the logger: the logger needs config to exist.
    console.error(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = load();

export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

/**
 * Assert that a later-sprint integration has its keys before first use.
 * Keeps Sprint 1 booting without every provider's credentials while still failing
 * loudly the moment something actually reaches for them.
 */
export function requireKeys(feature: string, keys: (keyof Config)[]): void {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length > 0) {
    throw new Error(
      `${feature} is not configured. Missing: ${missing.join(', ')}`,
    );
  }
}
