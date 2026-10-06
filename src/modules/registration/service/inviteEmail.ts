/**
 * R12 — the email a partner gets when a captain invites them. The button
 * deep-links to the invite; the token is printed too, for anyone whose client
 * mangles links or who would rather type it into the app.
 */
import {
  button,
  clock,
  day,
  divider,
  eyebrow,
  fallbackCode,
  layout,
  link,
  note,
  para,
  person,
  plain,
  ticket,
  title,
  type RenderedEmail,
  type TicketEvent,
} from '../../../platform/emailKit.js';

export function inviteEmail(args: {
  to: string;
  captainName: string;
  token: string;
  expiresAt: Date;
  event: TicketEvent | null;
}): RenderedEmail {
  const { to, captainName, token, expiresAt, event } = args;
  const tz = event?.timezone;
  const expires = `${day(expiresAt, tz)}, ${clock(expiresAt, tz)}`;
  const href = link(`/invite/${encodeURIComponent(token)}`);

  const subject = `${captainName} wants you as their partner`;

  const text = plain([
    `${captainName} has invited you as their partner.`,
    '',
    ...(event
      ? [event.title, `${day(event.startsAt, tz)}, ${clock(event.startsAt, tz)}`, ...(event.place ? [event.place] : []), '']
      : []),
    `Accept: ${href}`,
    `Or open PL4Y and enter code ${token}`,
    '',
    `The invite expires ${expires}.`,
  ]);

  const body =
    eyebrow('Partner invite') +
    title('You’ve been picked') +
    person(captainName, 'invited you to play as their partner') +
    (event ? ticket(event, { text: 'Invite', tone: 'brand' }) : '') +
    button('Accept invite', href) +
    fallbackCode('Or open PL4Y and enter code', token) +
    divider() +
    note(`Expires ${expires}.`, 'After that the spot goes back to the captain and they can invite someone else.') +
    para(
      'No PL4Y account yet? Accepting signs you up with this email in under a minute. Not interested? Ignore this and nothing happens.',
    );

  const preheader = event
    ? `${event.title} · ${day(event.startsAt, tz)}. Accept before ${expires}.`
    : `Accept before ${expires}.`;

  return { subject, text, html: layout({ subject, preheader, to, body }) };
}
