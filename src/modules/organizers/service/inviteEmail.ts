/**
 * org — the email someone gets when PL4Y, or an organisation's owner, adds
 * them before they have a PL4Y account. Signing up with this address claims
 * the place: there is no code to type.
 */
import { button, day, divider, esc, eyebrow, layout, link, note, para, plain, title, type RenderedEmail } from '../../../platform/emailKit.js';

const ROLE_WORDS: Record<'owner' | 'admin' | 'member', string> = {
  owner: 'the owner',
  admin: 'an admin',
  member: 'a member',
};

export function organisationInviteEmail(args: {
  to: string;
  organisationName: string;
  role: 'owner' | 'admin' | 'member';
  expiresAt: Date;
}): RenderedEmail {
  const { to, organisationName, role, expiresAt } = args;
  const href = link('/');
  const as = ROLE_WORDS[role];
  const subject = `You've been added to ${organisationName} on PL4Y`;

  const text = plain([
    `You've been added to ${organisationName} on PL4Y as ${as}.`,
    '',
    `Get the PL4Y app and sign in with ${to} to take your place: ${href}`,
    '',
    `This invite expires ${day(expiresAt)}.`,
  ]);

  const body =
    eyebrow('Organisation invite') +
    title(esc(`Join ${organisationName}`)) +
    para(`You&#39;ve been added to ${esc(organisationName)} as ${as}. Members host events under the organisation's name from the Hosting tab.`) +
    button('Get PL4Y', href) +
    divider() +
    note(`Sign in with ${to}`, `Use this email address and the invite is claimed for you. It expires ${day(expiresAt)}.`) +
    para('Not expecting this? Ignore it and nothing happens.');

  return { subject, text, html: layout({ subject, preheader: `Sign in with ${to} to join.`, to, body }) };
}
