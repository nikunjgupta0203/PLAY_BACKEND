/**
 * R12 — the player-facing payment emails, and the staff payout alert. Pure:
 * the service gathers the facts, these only lay them out.
 */
import {
  C,
  button,
  day,
  divider,
  esc,
  eyebrow,
  layout,
  lead,
  link,
  note,
  para,
  plain,
  rows,
  rupees,
  secondaryPair,
  steps,
  strong,
  ticket,
  title,
  type RenderedEmail,
  type TicketEvent,
} from '../../../platform/emailKit.js';

export type PaymentEmailKind = 'confirmed' | 'failed' | 'refunded';

export interface PaymentEmailFacts {
  to: string;
  kind: PaymentEmailKind;
  amountPaise: bigint;
  event: TicketEvent;
  /** upi | card | netbanking | wallet, when the gateway said. */
  method?: string | null;
  /** The gateway's id for the payment or refund — what support asks for. */
  reference?: string | null;
  /** When the refund was issued, for the tracker. */
  at?: Date;
}

const METHOD: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net banking', wallet: 'Wallet' };
const methodLabel = (m?: string | null) => (m ? (METHOD[m] ?? m) : null);

/** Banks quote 5–7 working days; this is the far end, skipping weekends. */
function addWorkingDays(from: Date, n: number): Date {
  const d = new Date(from);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n--;
  }
  return d;
}

export function paymentEmail(f: PaymentEmailFacts): RenderedEmail {
  if (f.kind === 'confirmed') return confirmed(f);
  if (f.kind === 'failed') return failed(f);
  return refunded(f);
}

function confirmed(f: PaymentEmailFacts): RenderedEmail {
  const { event: ev } = f;
  const amount = rupees(f.amountPaise);
  const subject = `You’re in: ${ev.title}`;
  const method = methodLabel(f.method);
  const when = `${day(ev.startsAt, ev.timezone)}`;

  const receipt: [string, string][] = [['Entry', esc(ev.title)]];
  if (method) receipt.push(['Paid with', esc(method)]);
  if (f.reference) receipt.push(['Reference', esc(f.reference)]);

  const body =
    eyebrow('Entry confirmed') +
    title('You’re in') +
    lead('Your spot is locked. Bring your gear and check in at the desk before your first match.') +
    ticket(ev, { text: 'Confirmed', tone: 'brand' }) +
    rows(receipt, ['Paid', amount]) +
    button('View my entry', link('/app/registrations')) +
    secondaryPair(['Add to calendar', calendarLink(ev)], ['Get directions', mapsLink(ev)]) +
    divider() +
    para('Can’t make it? Withdraw from the app before the cutoff and you’ll get a refund under the host’s policy.');

  const text = plain([
    `You're in: ${ev.title}`,
    '',
    `${when}`,
    ...(ev.place ? [ev.place] : []),
    '',
    `Paid: ${amount}${method ? ` (${method})` : ''}`,
    ...(f.reference ? [`Reference: ${f.reference}`] : []),
    '',
    `View your entry: ${link('/app/registrations')}`,
    '',
    'See you on court.',
  ]);

  return {
    subject,
    text,
    html: layout({ subject, preheader: `${amount} paid. ${when}. See you on court.`, to: f.to, body }),
  };
}

function failed(f: PaymentEmailFacts): RenderedEmail {
  const { event: ev } = f;
  const amount = rupees(f.amountPaise);
  const subject = `Payment didn’t go through: ${ev.title}`;
  const retry = link('/app/registrations');

  const body =
    eyebrow('Payment failed', 'red') +
    title('Not charged') +
    lead(
      `Your payment of ${strong(amount)} didn’t go through. If money did leave your account, it comes back automatically within 5–7 working days.`,
    ) +
    ticket(ev, { text: 'Held', tone: 'amber' }) +
    note('Your spot is held for a few more minutes.', 'Finish payment before then or it goes to the next player in line.') +
    button('Try payment again', retry) +
    divider() +
    para('Common fixes: approve the request in your UPI app, try a different card, or switch to net banking.');

  const text = plain([
    `Your payment of ${amount} for ${ev.title} didn't go through.`,
    '',
    'Your spot is held for a few more minutes. Open PL4Y and try again:',
    retry,
    '',
    'If money left your account, it comes back automatically within 5–7 working days.',
  ]);

  return {
    subject,
    text,
    html: layout({ subject, preheader: 'Your spot is held for a few more minutes. Try again in the app.', to: f.to, body }),
  };
}

function refunded(f: PaymentEmailFacts): RenderedEmail {
  const { event: ev } = f;
  const amount = rupees(f.amountPaise);
  const subject = `Refund on its way: ${amount}`;
  const issued = f.at ?? new Date();
  const by = day(addWorkingDays(issued, 7), ev.timezone);
  const method = methodLabel(f.method);

  const detail: [string, string][] = [['Event', esc(ev.title)]];
  if (method) detail.push(['Refund to', esc(method)]);
  if (f.reference) detail.push(['Refund ID', esc(f.reference)]);

  const body =
    eyebrow('Refund issued', 'blue') +
    title('Money’s coming back') +
    lead(`We’ve sent ${strong(amount)} back for ${esc(ev.title)}. You don’t need to do anything.`) +
    rows(detail, ['Refunded', amount]) +
    steps([
      { label: 'Refund issued by PL4Y', when: day(issued, ev.timezone), state: 'done' },
      { label: 'Bank processing', when: '5–7 working days', state: 'now' },
      { label: 'In your account', when: `By ${by}`, state: 'todo' },
    ]) +
    button('View my payments', link('/app/registrations'), 'blue') +
    divider() +
    para(
      `Not there by ${esc(by)}? Reply to this email${f.reference ? ' with the refund ID' : ''} and we’ll chase it with your bank.`,
    );

  const text = plain([
    `${amount} for ${ev.title} is on its way back to you.`,
    '',
    ...(f.reference ? [`Refund ID: ${f.reference}`] : []),
    ...(method ? [`Refund to: ${method}`] : []),
    `Banks usually take 5–7 working days, so expect it by ${by}.`,
  ]);

  return {
    subject,
    text,
    html: layout({ subject, preheader: `${amount} for ${ev.title} is heading back to your account.`, to: f.to, body }),
  };
}

// Calendar and maps links need no server: both providers take the details in
// the URL.
function calendarLink(ev: TicketEvent): string {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const end = new Date(ev.startsAt.getTime() + 3 * 3_600_000);
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${stamp(ev.startsAt)}/${stamp(end)}`,
    ...(ev.place ? { location: ev.place } : {}),
    details: 'Your PL4Y entry is confirmed.',
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

function mapsLink(ev: TicketEvent): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.place ?? ev.title)}`;
}

/** payouts R12 — staff only. Same frame, so it is recognisably ours in an inbox. */
export function payoutAlertEmail(args: { to: string; subject: string; text: string }): RenderedEmail {
  const { to, subject, text } = args;
  const headline = text.split('\n')[0] || subject;
  const body =
    eyebrow('Ops alert · payouts', 'red') +
    title('Action needed') +
    lead(esc(subject)) +
    `<pre style="margin:0 0 24px;padding:14px 16px;border-radius:12px;background:${C.raised};border:1px solid ${C.line};color:${C.ink};font-family:'DM Mono',Menlo,Consolas,monospace;font-size:12.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;">${esc(text)}</pre>` +
    para('Alerts are rate-limited to one email an hour. Every occurrence is in the logs.');
  return {
    subject: `[PL4Y payouts] ${subject}`,
    text,
    html: layout({ subject, preheader: headline, to, body }),
  };
}
