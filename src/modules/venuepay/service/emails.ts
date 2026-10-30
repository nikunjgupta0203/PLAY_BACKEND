/**
 * pay at venue — the two confirmation emails: the player's receipt and the
 * venue's notice. Pure: the service gathers the facts, these lay them out.
 */
import { button, clock, day, divider, esc, eyebrow, layout, lead, link, para, plain, rows, rupees, title, type RenderedEmail } from '../../../platform/emailKit.js';

export interface VenuePaymentFacts {
  venueName: string;
  label: string;
  minutes: number;
  ratePerHourPaise: bigint;
  /** The price of the time. */
  amountPaise: bigint;
  /** PL4Y's reward; the player paid amount − discount. */
  discountPaise: bigint;
  playerName: string;
  /** The gateway's id for the payment — what support asks for. */
  reference: string | null;
  paidAt: Date;
}

export const durationText = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
};

const when = (at: Date) => `${day(at)}, ${clock(at)}`;

export function playerReceiptEmail(to: string, f: VenuePaymentFacts): RenderedEmail {
  const paid = f.amountPaise - f.discountPaise;
  const subject = `Payment confirmed: ${f.venueName}`;
  const lines: [string, string][] = [
    ['Venue', esc(f.venueName)],
    ['Activity', esc(f.label)],
    ['Duration', durationText(f.minutes)],
    ['Rate', `${rupees(f.ratePerHourPaise)} / hour`],
    ['Amount', rupees(f.amountPaise)],
  ];
  if (f.discountPaise > 0n) lines.push(['PL4Y reward', `−${rupees(f.discountPaise)}`]);
  if (f.reference) lines.push(['Reference', esc(f.reference)]);
  lines.push(['Paid', esc(when(f.paidAt))]);

  const body =
    eyebrow('Payment confirmed') +
    title('All paid') +
    lead(`You paid ${esc(f.venueName)} through PL4Y. Show this email or the receipt in the app at the desk if they ask.`) +
    rows(lines, ['Total paid', rupees(paid)]) +
    button('View receipt', link('/app/payments')) +
    divider() +
    para('Something wrong with this payment? Reply to this email or contact support from the app.');

  const text = plain([
    `Payment confirmed: ${f.venueName}`,
    '',
    `${f.label} · ${durationText(f.minutes)} at ${rupees(f.ratePerHourPaise)} / hour`,
    `Amount: ${rupees(f.amountPaise)}`,
    ...(f.discountPaise > 0n ? [`PL4Y reward: −${rupees(f.discountPaise)}`] : []),
    `Total paid: ${rupees(paid)}`,
    ...(f.reference ? [`Reference: ${f.reference}`] : []),
    `Paid: ${when(f.paidAt)}`,
  ]);
  return { subject, text, html: layout({ subject, preheader: `${rupees(paid)} paid for ${durationText(f.minutes)} of ${f.label}.`, to, body }) };
}

export function operatorNoticeEmail(to: string, f: VenuePaymentFacts): RenderedEmail {
  const subject = `${rupees(f.amountPaise)} paid at ${f.venueName}`;
  const lines: [string, string][] = [
    ['Player', esc(f.playerName)],
    ['Activity', esc(f.label)],
    ['Duration', durationText(f.minutes)],
    ['Rate', `${rupees(f.ratePerHourPaise)} / hour`],
  ];
  if (f.reference) lines.push(['Reference', esc(f.reference)]);
  lines.push(['Paid', esc(when(f.paidAt))]);

  const body =
    eyebrow('Pay at venue') +
    title('Payment received') +
    lead(`${esc(f.playerName)} paid for their time at ${esc(f.venueName)} through PL4Y. It is in your venue desk and in this month’s payout.`) +
    rows(lines, ['Amount', rupees(f.amountPaise)]) +
    button('Open the venue desk', link('/app/venue-desk')) +
    divider() +
    para('PL4Y pays the month’s payments to your bank account early next month, less the 10% commission.');

  const text = plain([
    `${f.playerName} paid ${rupees(f.amountPaise)} at ${f.venueName}.`,
    '',
    `${f.label} · ${durationText(f.minutes)} at ${rupees(f.ratePerHourPaise)} / hour`,
    ...(f.reference ? [`Reference: ${f.reference}`] : []),
    `Paid: ${when(f.paidAt)}`,
    '',
    'It is in your venue desk and in this month’s payout.',
  ]);
  return { subject, text, html: layout({ subject, preheader: `${f.playerName} · ${f.label} · ${durationText(f.minutes)}`, to, body }) };
}
