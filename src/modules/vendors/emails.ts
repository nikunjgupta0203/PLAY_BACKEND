/**
 * vendors R4 — the seller's confirmation and the team's heads-up.
 * Pure: data in, `{ subject, text, html }` out (ADR 0002).
 */
import { button, day, divider, esc, eyebrow, layout, lead, note, para, plain, rows, title, type RenderedEmail } from '../../platform/emailKit.js';
import { SELLER_TYPE_TITLES } from './service/form.js';
import { displayName, type VendorApplication } from './service/index.js';

/** To the seller. Says it arrived and will be reviewed — never that it was accepted. */
export function confirmationEmail(a: VendorApplication): RenderedEmail {
  const name = displayName(a);
  const subject = `We received your PL4Y Shop seller application (${a.reference})`;
  const html = layout({
    subject,
    preheader: `Reference ${a.reference}. The PL4Y Shop team will review it and message you.`,
    to: a.contactEmail,
    body: [
      eyebrow('PL4Y Shop seller application'),
      title('Thank you'),
      lead(
        `Hi ${esc(a.contactName.split(' ')[0] ?? a.contactName)}, your application to sell <b style="color:#F5F5EF;">${esc(name)}</b> ` +
          'on PL4Y Shop reached us. Our team reviews every seller by hand and will contact you on WhatsApp or email.',
      ),
      rows([
        ['Reference', esc(a.reference)],
        ['Store', esc(name)],
        ['Submitted', esc(day(a.createdAt))],
      ]),
      divider(),
      note('Not an approval yet.', 'We never ask for bank details or documents until you are approved.', 'blue'),
      para('Quote your reference if you write to us. To add anything, reply to this email.'),
    ].join('\n'),
  });
  const text = plain([
    `Hi ${a.contactName},`,
    '',
    `Your application to sell ${name} on PL4Y Shop reached us. Our team reviews every seller by hand and will contact you on WhatsApp or email.`,
    '',
    `Reference: ${a.reference}`,
    `Submitted: ${day(a.createdAt)}`,
    '',
    'This is not an approval yet. We never ask for bank details or documents until you are approved.',
  ]);
  return { subject, text, html };
}

/** To the PL4Y team. Who, what, and where to read the whole thing. */
export function teamEmail(a: VendorApplication, portalUrl: string): RenderedEmail {
  const name = displayName(a);
  const subject = `New PL4Y Shop seller: ${name} (${SELLER_TYPE_TITLES[a.sellerType]})`;
  const href = portalUrl ? `${portalUrl.replace(/\/$/, '')}/vendors/${a.id}` : null;
  const html = layout({
    subject,
    preheader: `${name} · ${a.city} · ${a.reference}`,
    to: 'the PL4Y team',
    body: [
      eyebrow('New shop seller application', 'blue'),
      title(esc(name)),
      lead(esc(SELLER_TYPE_TITLES[a.sellerType])),
      rows([
        ['Reference', esc(a.reference)],
        ['Contact', esc(a.contactName)],
        ['Email', esc(a.contactEmail)],
        ['WhatsApp', esc(a.contactPhone)],
        ['City', esc(a.city)],
      ]),
      href ? button('Open in the portal', href) : para('Open the Vendors page in the admin portal to read it.'),
    ].join('\n'),
  });
  const text = plain([
    `New PL4Y Shop seller: ${name} (${SELLER_TYPE_TITLES[a.sellerType]})`,
    `Reference: ${a.reference}`,
    `Contact: ${a.contactName} · ${a.contactEmail} · ${a.contactPhone}`,
    `City: ${a.city}`,
    '',
    href ? `Open it: ${href}` : 'Open the Vendors page in the admin portal to read it.',
  ]);
  return { subject, text, html };
}
