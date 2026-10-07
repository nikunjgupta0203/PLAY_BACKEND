import { describe, expect, it } from 'vitest';
import { configSchema, silentTransports } from './config.js';

const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  DIRECT_DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_PRIVATE_KEY: 'x',
  JWT_PUBLIC_KEY: 'y',
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_abc',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
};

const issuesFor = (env: Record<string, string>) => {
  const r = configSchema.safeParse({ ...BASE, ...env });
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('config — Razorpay in production', () => {
  it('accepts a test key over http outside production', () => {
    expect(issuesFor({ NODE_ENV: 'development', PUBLIC_API_URL: 'http://10.0.2.2:4000' })).toEqual([]);
  });

  it('refuses a test key in production', () => {
    expect(issuesFor({ NODE_ENV: 'production', PUBLIC_API_URL: 'https://api.pl4y.app' })).toContain(
      'RAZORPAY_KEY_ID',
    );
  });

  it('refuses a non-https PUBLIC_API_URL in production', () => {
    expect(
      issuesFor({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_abc', PUBLIC_API_URL: 'http://api.pl4y.app' }),
    ).toContain('PUBLIC_API_URL');
  });

  it('accepts a live key over https in production', () => {
    expect(
      issuesFor({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_abc', PUBLIC_API_URL: 'https://api.pl4y.app' }),
    ).toEqual([]);
  });

  it('needs the webhook secret', () => {
    expect(issuesFor({ RAZORPAY_WEBHOOK_SECRET: '', PUBLIC_API_URL: 'http://10.0.2.2:4000' })).toContain(
      'PAYMENT_PROVIDER',
    );
  });

  it('does not constrain production when Razorpay is not the provider', () => {
    expect(
      issuesFor({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'none', RAZORPAY_KEY_ID: '', PUBLIC_API_URL: '' }),
    ).toEqual([]);
  });
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const PAYOUTS = {
  PAYOUT_PROVIDER: 'razorpayx',
  RAZORPAYX_KEY_ID: 'rzp_live_x',
  RAZORPAYX_KEY_SECRET: 'secret',
  RAZORPAYX_ACCOUNT_NUMBER: '7878780080316316',
  RAZORPAYX_WEBHOOK_SECRET: 'whsec',
  PAYOUT_DATA_KEY: KEY,
  PUBLIC_API_URL: 'https://api.pl4y.app',
  RAZORPAY_KEY_ID: 'rzp_live_abc',
};

describe('config — payouts', () => {
  it('accepts RazorpayX payouts in development without tax rates', () => {
    expect(issuesFor({ ...PAYOUTS, NODE_ENV: 'development' })).toEqual([]);
  });

  it('pays hosts in production with no GST or TDS unless they are set (PL4Y is unregistered)', () => {
    expect(issuesFor({ ...PAYOUTS, NODE_ENV: 'production' })).toEqual([]);
    expect(configSchema.parse({ ...BASE, ...PAYOUTS, NODE_ENV: 'production' })).toMatchObject({
      COMMISSION_GST_BPS: 0,
      HOST_TDS_BPS: 0,
    });
  });

  it('refuses a RazorpayX test key in production', () => {
    expect(
      issuesFor({
        ...PAYOUTS,
        NODE_ENV: 'production',
        COMMISSION_GST_BPS: '0',
        HOST_TDS_BPS: '0',
        RAZORPAYX_KEY_ID: 'rzp_test_x',
      }),
    ).toContain('RAZORPAYX_KEY_ID');
  });

  it('needs the payout credentials and source account for razorpayx', () => {
    expect(issuesFor({ ...PAYOUTS, RAZORPAYX_KEY_SECRET: '' })).toContain('PAYOUT_PROVIDER');
    expect(issuesFor({ ...PAYOUTS, RAZORPAYX_ACCOUNT_NUMBER: '' })).toContain('PAYOUT_PROVIDER');
    expect(issuesFor({ ...PAYOUTS, RAZORPAYX_WEBHOOK_SECRET: '' })).toContain('PAYOUT_PROVIDER');
  });

  it('needs a 32-byte data key whenever payouts are on', () => {
    expect(issuesFor({ ...PAYOUTS, PAYOUT_DATA_KEY: 'c2hvcnQ=' })).toContain('PAYOUT_DATA_KEY');
    expect(issuesFor({ PAYOUT_PROVIDER: 'mock', PAYOUT_DATA_KEY: '', PUBLIC_API_URL: 'http://10.0.2.2:4000' })).toContain(
      'PAYOUT_DATA_KEY',
    );
  });

  it('allows manual payouts in production with only the data key — no RazorpayX keys', () => {
    const live = { NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_abc', PUBLIC_API_URL: 'https://api.pl4y.app' };
    expect(issuesFor({ ...live, PAYOUT_PROVIDER: 'manual', PAYOUT_DATA_KEY: KEY })).toEqual([]);
    expect(issuesFor({ ...live, PAYOUT_PROVIDER: 'manual', PAYOUT_DATA_KEY: '' })).toContain('PAYOUT_DATA_KEY');
  });

  it('refuses the mock provider in production', () => {
    expect(
      issuesFor({
        NODE_ENV: 'production',
        PAYOUT_PROVIDER: 'mock',
        PAYOUT_DATA_KEY: KEY,
        RAZORPAY_KEY_ID: 'rzp_live_abc',
        PUBLIC_API_URL: 'https://api.pl4y.app',
      }),
    ).toContain('PAYOUT_PROVIDER');
  });
});

describe('config — the mock payment gateway', () => {
  it('is allowed in development', () => {
    expect(issuesFor({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'mock' })).toEqual([]);
  });

  it('is refused in production', () => {
    expect(issuesFor({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'mock', RAZORPAY_KEY_ID: '', PUBLIC_API_URL: '' })).toContain(
      'PAYMENT_PROVIDER',
    );
  });
});

describe('config — silent transports in production', () => {
  it('names push and email left on console in production', () => {
    const off = silentTransports({ NODE_ENV: 'production', PUSH_TRANSPORT: 'console', EMAIL_TRANSPORT: 'console' });
    expect(off).toHaveLength(2);
    expect(off[0]).toContain('PUSH_TRANSPORT');
    expect(off[1]).toContain('EMAIL_TRANSPORT');
  });

  it('is quiet when both deliver, and outside production', () => {
    expect(silentTransports({ NODE_ENV: 'production', PUSH_TRANSPORT: 'expo', EMAIL_TRANSPORT: 'resend' })).toEqual([]);
    expect(silentTransports({ NODE_ENV: 'development', PUSH_TRANSPORT: 'console', EMAIL_TRANSPORT: 'console' })).toEqual([]);
  });
});
