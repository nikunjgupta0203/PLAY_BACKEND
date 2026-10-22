/**
 * partnerships R4 — the applicant's confirmation and the team's heads-up.
 * Pure: data in, `{ subject, text, html }` out (ADR 0002).
 */
import { button, day, divider, esc, eyebrow, layout, lead, note, para, plain, rows, title, type RenderedEmail } from '../../platform/emailKit.js';
import { CATEGORY_TITLES } from './service/form.js';
import { displayName, type PartnershipApplication } from './service/index.js';

const categoryList = (a: PartnershipApplication) => a.categories.map((c) => CATEGORY_TITLES[c]);

/** To the applicant. Says it arrived and will be reviewed — never that it was accepted. */
export function confirmationEmail(a: PartnershipApplication): RenderedEmail {
  const name = displayName(a);
  const subject = `We received your PL4Y partnership application (${a.reference})`;
  const cats = categoryList(a);
  const html = layout({
    subject,
    preheader: `Reference ${a.reference}. The PL4Y team will review it and be in touch.`,
    to: a.contactEmail,
    body: [
      eyebrow('Partnership application'),
      title('Thank you'),
      lead(
        `Hi ${esc(a.contactName.split(' ')[0] ?? a.contactName)}, your partnership application for <b style="color:#F5F5EF;">${esc(name)}</b> ` +
          'reached us. The PL4Y team will review your details and contact you about the next steps.',
      ),
      rows([
        ['Reference', esc(a.reference)],
        ['Organisation', esc(name)],
        ['Submitted', esc(day(a.createdAt))],
      ]),
      para(`<b style="color:#F5F5EF;">You applied as</b><br>${cats.map(esc).join('<br>')}`),
      divider(),
      note('Not a confirmation of partnership.', 'Every application is reviewed by a person before anything is agreed.', 'blue'),
      para('Quote your reference if you write to us. To add anything, reply to this email.'),
    ].join('\n'),
  });
  const text = plain([
    `Hi ${a.contactName},`,
    '',
    `Your PL4Y partnership application for ${name} reached us. The PL4Y team will review your details and contact you about the next steps.`,
    '',
    `Reference: ${a.reference}`,
    `Submitted: ${day(a.createdAt)}`,
    `You applied as: ${cats.join(', ')}`,
    '',
    'This is not a confirmation of partnership: every application is reviewed by a person before anything is agreed.',
  ]);
  return { subject, text, html };
}

/** To the PL4Y team. Who, what for, and where to read the whole thing. */
export function teamEmail(a: PartnershipApplication, portalUrl: string): RenderedEmail {
  const name = displayName(a);
  const cats = categoryList(a);
  const subject = `New partnership application: ${name} (${cats.join(', ')})`;
  const href = portalUrl ? `${portalUrl.replace(/\/$/, '')}/partnerships/${a.id}` : null;
  const html = layout({
    subject,
    preheader: `${name} · ${a.city} · ${a.reference}`,
    to: 'the PL4Y team',
    body: [
      eyebrow('New partnership application', 'blue'),
      title(esc(name)),
      lead(cats.map(esc).join(' · ')),
      rows([
        ['Reference', esc(a.reference)],
        ['Contact', esc(a.contactName)],
        ['Email', esc(a.contactEmail)],
        ['Phone', esc(a.contactPhone)],
        ['City', esc(`${a.city}, ${a.state}`)],
      ]),
      href ? button('Open in the portal', href) : para('Open the Partnerships page in the admin portal to read it.'),
    ].join('\n'),
  });
  const text = plain([
    `New partnership application: ${name}`,
    `Categories: ${cats.join(', ')}`,
    `Reference: ${a.reference}`,
    `Contact: ${a.contactName} · ${a.contactEmail} · ${a.contactPhone}`,
    `City: ${a.city}, ${a.state}`,
    '',
    href ? `Open it: ${href}` : 'Open the Partnerships page in the admin portal to read it.',
  ]);
  return { subject, text, html };
}
