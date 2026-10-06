/**
 * The one-time-code email (ADR 0002), one per purpose. Built from the shared
 * frame in platform/emailKit.
 */
import {
  button,
  strong,
  caption,
  codeBox,
  divider,
  eyebrow,
  layout,
  lead,
  link,
  para,
  plain,
  title,
  type RenderedEmail,
} from '../../../platform/emailKit.js';
import type { OtpPurpose } from './index.js';

const COPY: Record<OtpPurpose, { label: string; title: string; lead: string; ignore: string }> = {
  login: {
    label: 'Sign-in code',
    title: 'Back on court',
    lead: 'Enter this code in the PL4Y app to sign in.',
    ignore: 'Didn’t try to sign in? Ignore this email. Nobody can get in without this code.',
  },
  signup: {
    label: 'Verify your email',
    title: 'Welcome to PL4Y',
    lead: 'Enter this code in the app to confirm your email and finish signing up. You’re one step from your first match.',
    ignore: 'Didn’t sign up for PL4Y? Ignore this email and no account will be created.',
  },
  payout_change: {
    label: 'Confirm bank change',
    title: 'Confirm it’s you',
    lead: 'Enter this code in the PL4Y app to change the bank account your hosting money is paid into.',
    ignore: 'Didn’t try to change your bank details? Don’t share this code, and contact PL4Y support now.',
  },
  email_change: {
    label: 'Confirm new email',
    title: 'Confirm it’s you',
    lead: 'Enter this code in the app to move your PL4Y account to this address.',
    ignore: 'Didn’t ask to change your email? Ignore this and your account stays as it is.',
  },
};

export function otpEmail(args: {
  code: string;
  ttlMinutes: number;
  to: string;
  purpose: OtpPurpose;
}): RenderedEmail {
  const { code, ttlMinutes, to, purpose } = args;
  const copy = COPY[purpose];

  // The code is in the subject too: many clients preview it, which saves the
  // user from opening the mail at all. Tests read it from there as well.
  const subject = `${code} is your PL4Y code`;

  const text = plain([
    copy.title,
    '',
    copy.lead,
    '',
    `    ${code}`,
    '',
    `It expires in ${ttlMinutes} minutes and works once.`,
    '',
    `${copy.ignore} PL4Y will never ask you to share it.`,
  ]);

  const body =
    eyebrow(copy.label) +
    title(copy.title) +
    lead(copy.lead) +
    codeBox(code) +
    caption(`Expires in ${ttlMinutes} minutes &middot; Works once`) +
    button('Open PL4Y', link('/app')) +
    divider() +
    para(`${copy.ignore} ${strong('PL4Y will never ask you to share this code.')}`);

  const html = layout({
    subject,
    preheader: `Your code is ${code}. It expires in ${ttlMinutes} minutes.`,
    to,
    body,
  });

  return { subject, text, html };
}
