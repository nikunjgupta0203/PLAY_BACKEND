import { describe, expect, it } from 'vitest';
import { otpEmail } from '../modules/identity/service/otpEmail.js';
import { inviteEmail } from '../modules/registration/service/inviteEmail.js';
import { payoutAlertEmail, paymentEmail } from '../modules/payments/service/paymentEmail.js';
import { clock, day, rupees } from './emailKit.js';

const EVENT = {
  title: 'Sunday <Smash> Doubles',
  startsAt: new Date('2026-10-12T01:30:00Z'), // 7:00 AM IST
  timezone: 'Asia/Kolkata',
  place: 'Koramangala Indoor Arena, Bengaluru',
};

describe('emailKit formatting', () => {
  it('formats rupees with Indian grouping', () => {
    expect(rupees(12345678n)).toBe('₹1,23,456.78');
  });

  it('shows dates and times in the event timezone', () => {
    expect(day(EVENT.startsAt, EVENT.timezone)).toBe('Mon, 12 Oct 2026');
    expect(clock(EVENT.startsAt, EVENT.timezone)).toBe('7:00 AM IST');
  });
});

describe('templates', () => {
  it('OTP keeps the code in the subject and has one copy per purpose', () => {
    const login = otpEmail({ code: '482913', ttlMinutes: 10, to: 'a@b.co', purpose: 'login' });
    const signup = otpEmail({ code: '482913', ttlMinutes: 10, to: 'a@b.co', purpose: 'signup' });
    expect(login.subject).toBe('482913 is your PL4Y code');
    expect(login.html).toContain('482913');
    expect(login.html).toContain('Back on court');
    expect(signup.html).toContain('Welcome to PL4Y');
    expect(login.text).toContain('expires in 10 minutes');
  });

  it('invite links to the token and escapes user-supplied names', () => {
    const m = inviteEmail({
      to: 'p@b.co',
      captainName: 'Arjun <script>',
      token: 'SMASH-7KQ2',
      expiresAt: new Date('2026-10-07T15:00:00Z'),
      event: EVENT,
    });
    expect(m.html).toContain('/invite/SMASH-7KQ2');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<Smash>');
    expect(m.text).toContain('Wed, 7 Oct 2026, 8:30 PM IST');
  });

  it('invite still renders without event details', () => {
    const m = inviteEmail({ to: 'p@b.co', captainName: 'A', token: 'T', expiresAt: new Date(), event: null });
    expect(m.html).toContain('Accept invite');
  });

  it('payment emails carry the subjects the app and tests rely on', () => {
    const base = { to: 'p@b.co', amountPaise: 49900n, event: EVENT };
    const ok = paymentEmail({ ...base, kind: 'confirmed', method: 'upi', reference: 'pay_1' });
    expect(ok.subject).toBe('You’re in: Sunday <Smash> Doubles');
    expect(ok.html).toContain('₹499.00');
    expect(ok.html).toContain('calendar.google.com');
    expect(ok.html).toContain('UPI');

    expect(paymentEmail({ ...base, kind: 'failed' }).subject).toMatch(/^Payment didn’t go through/);

    const refund = paymentEmail({ ...base, kind: 'refunded', reference: 'rfnd_1', at: new Date('2026-10-03T04:00:00Z') });
    expect(refund.subject).toBe('Refund on its way: ₹499.00');
    // Seven working days from Sat 3 Oct is Tue 13 Oct.
    expect(refund.text).toContain('Tue, 13 Oct 2026');
  });

  it('payout alert is tagged for filtering', () => {
    const m = payoutAlertEmail({ to: 'ops@b.co', subject: 'Payout failed', text: 'po_1 reversed' });
    expect(m.subject).toBe('[PL4Y payouts] Payout failed');
    expect(m.html).toContain('po_1 reversed');
  });
});
