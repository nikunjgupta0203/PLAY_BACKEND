/**
 * careers R4 — the applicant's confirmation and the team's heads-up.
 * Pure: data in, `{ subject, text, html }` out (ADR 0002).
 */
import { button, day, divider, esc, eyebrow, layout, lead, note, para, plain, rows, title, type RenderedEmail } from '../../platform/emailKit.js';
import { OPPORTUNITY_TITLES } from './service/form.js';
import type { CareerApplication } from './service/index.js';

const first = (name: string) => name.split(' ')[0] ?? name;

/** To the applicant. Says it arrived and will be reviewed — never that it was accepted. */
export function confirmationEmail(a: CareerApplication): RenderedEmail {
  const role = OPPORTUNITY_TITLES[a.opportunity];
  const subject = `We received your PL4Y application (${a.reference})`;
  const html = layout({
    subject,
    preheader: `Reference ${a.reference}. We’ll review your details and contact you if your profile matches.`,
    to: a.email,
    body: [
      eyebrow('PL4Y careers'),
      title('You’re on your way to PL4Y'),
      lead(
        `Hi ${esc(first(a.fullName))}, thank you for applying to the <b style="color:#F5F5EF;">${esc(role)}</b>. ` +
          'We’ve received your application and will review your details.',
      ),
      rows([
        ['Reference', esc(a.reference)],
        ['Opportunity', esc(role)],
        ['Submitted', esc(day(a.createdAt))],
      ]),
      divider(),
      note('What happens next', 'If your profile matches our requirements, our team will contact you using the details you gave.', 'blue'),
      para('Quote your reference if you write to us.'),
    ].join('\n'),
  });
  const text = plain([
    `Hi ${first(a.fullName)},`,
    '',
    `Thank you for applying to the ${role}. We’ve received your application and will review your details.`,
    'If your profile matches our requirements, our team will contact you using the details you gave.',
    '',
    `Reference: ${a.reference}`,
    `Submitted: ${day(a.createdAt)}`,
  ]);
  return { subject, text, html };
}

/** To the PL4Y team. Who, for what, and where to read the whole thing. */
export function teamEmail(a: CareerApplication, portalUrl: string): RenderedEmail {
  const role = OPPORTUNITY_TITLES[a.opportunity];
  const subject = `New ${role} application: ${a.fullName}`;
  const href = portalUrl ? `${portalUrl.replace(/\/$/, '')}/careers/${a.id}` : null;
  const html = layout({
    subject,
    preheader: `${a.fullName} · ${a.organisation} · ${a.city} · ${a.reference}`,
    to: 'the PL4Y team',
    body: [
      eyebrow(`New ${role} application`, 'blue'),
      title(esc(a.fullName)),
      lead(esc(a.organisation)),
      rows([
        ['Reference', esc(a.reference)],
        ['Email', esc(a.email)],
        ['Mobile', esc(a.phone)],
        ['City', esc(a.city)],
        ['Resume', a.resume ? 'Uploaded' : 'None'],
      ]),
      href ? button('Open in the portal', href) : para('Open the Careers page in the admin portal to read it.'),
    ].join('\n'),
  });
  const text = plain([
    subject,
    `Reference: ${a.reference}`,
    `${a.organisation} · ${a.city}`,
    `${a.email} · ${a.phone}`,
    `Resume: ${a.resume ? 'uploaded' : 'none'}`,
    '',
    href ? `Open it: ${href}` : 'Open the Careers page in the admin portal to read it.',
  ]);
  return { subject, text, html };
}
