/**
 * bookings — the booking emails (058): the player's confirmation and payment
 * receipt, and the venue's notice of a new booking. Pure: the service gathers
 * the facts, these lay them out.
 */
import { button, clock, day, divider, esc, eyebrow, layout, lead, link, para, plain, rows, rupees, title, type RenderedEmail } from '../../../platform/emailKit.js';

export interface BookingFacts {
  bookingCode: string;
  venueName: string;
  courtName: string;
  startsAt: Date;
  endsAt: Date;
  playerName: string;
  /** The price before any discount. */
  basePaise: bigint;
  venueDiscountPaise: bigint;
  venueOfferTitle: string | null;
  platformDiscountPaise: bigint;
  platformOfferTitle: string | null;
  /** PL4Y's reward (welcome / referral), taken at checkout. */
  rewardDiscountPaise: bigint;
  platformFeePaise: bigint;
  taxPaise: bigint;
  /** The booking's total before the reward: what is due at the venue, or was charged before the reward. */
  amountPaise: bigint;
  paymentMode: 'online' | 'at_venue' | 'offline' | 'comp';
  /** paid | due | … */
  paymentStatus: string;
  collectedBy: 'pl4y' | 'venue' | null;
  reference: string | null;
  paidAt: Date | null;
}

const when = (at: Date) => `${day(at)}, ${clock(at)}`;
const span = (f: BookingFacts) => `${day(f.startsAt)}, ${clock(f.startsAt)}–${clock(f.endsAt)}`;
const minutes = (f: BookingFacts) => Math.round((f.endsAt.getTime() - f.startsAt.getTime()) / 60_000);

/** The breakdown every booking email shows: original price, each discount and who gives it, the total. */
export function priceLines(f: BookingFacts): [string, string][] {
  const lines: [string, string][] = [['Price', rupees(f.basePaise)]];
  if (f.venueDiscountPaise > 0n) lines.push([`Venue offer${f.venueOfferTitle ? ` · ${esc(f.venueOfferTitle)}` : ''}`, `−${rupees(f.venueDiscountPaise)}`]);
  if (f.platformDiscountPaise > 0n) lines.push([`PL4Y offer${f.platformOfferTitle ? ` · ${esc(f.platformOfferTitle)}` : ''}`, `−${rupees(f.platformDiscountPaise)}`]);
  if (f.platformFeePaise > 0n) lines.push(['Booking fee', rupees(f.platformFeePaise)]);
  if (f.taxPaise > 0n) lines.push(['Taxes', rupees(f.taxPaise)]);
  if (f.rewardDiscountPaise > 0n) lines.push(['PL4Y reward', `−${rupees(f.rewardDiscountPaise)}`]);
  return lines;
}

export const payable = (f: BookingFacts): bigint => f.amountPaise - f.rewardDiscountPaise;

/** To the player: the booking is confirmed (pay at venue) or paid (receipt). */
export function playerBookingEmail(to: string, f: BookingFacts): RenderedEmail {
  const paid = f.paymentStatus === 'paid';
  const subject = paid ? `Receipt ${f.bookingCode}: ${f.venueName}` : `Booked: ${f.venueName}, ${day(f.startsAt)}`;
  const lines: [string, string][] = [
    ['Booking', esc(f.bookingCode)],
    ['Venue', esc(f.venueName)],
    ['Table', esc(f.courtName)],
    ['When', esc(span(f))],
    ...priceLines(f),
  ];
  if (paid && f.reference) lines.push(['Reference', esc(f.reference)]);
  if (paid && f.paidAt) lines.push(['Paid', `${esc(when(f.paidAt))}${f.collectedBy === 'venue' ? ' at the venue' : ' through PL4Y'}`]);

  const body =
    eyebrow(paid ? 'Payment receipt' : 'Booking confirmed') +
    title(paid ? 'All paid' : 'Your table is booked') +
    lead(
      paid
        ? `Your booking at ${esc(f.venueName)} is paid. Show booking ${esc(f.bookingCode)} or its QR in the app at the desk.`
        : `Pay ${rupees(payable(f))} at ${esc(f.venueName)} when you arrive, or pay now in the app. Show booking ${esc(f.bookingCode)} at the desk.`,
    ) +
    rows(lines, [paid ? 'Total paid' : 'To pay at the venue', rupees(payable(f))]) +
    button('View booking', link('/app/bookings')) +
    divider() +
    para('Need to cancel? You can from the booking in the app. Something wrong? Reply to this email or contact support from the app.');

  const text = plain([
    paid ? `Receipt ${f.bookingCode}: ${f.venueName}` : `Booked: ${f.venueName}`,
    '',
    `${f.courtName} · ${span(f)}`,
    `Price: ${rupees(f.basePaise)}`,
    ...(f.venueDiscountPaise > 0n ? [`Venue offer: −${rupees(f.venueDiscountPaise)}`] : []),
    ...(f.platformDiscountPaise > 0n ? [`PL4Y offer: −${rupees(f.platformDiscountPaise)}`] : []),
    ...(f.platformFeePaise > 0n ? [`Booking fee: ${rupees(f.platformFeePaise)}`] : []),
    ...(f.taxPaise > 0n ? [`Taxes: ${rupees(f.taxPaise)}`] : []),
    ...(f.rewardDiscountPaise > 0n ? [`PL4Y reward: −${rupees(f.rewardDiscountPaise)}`] : []),
    `${paid ? 'Total paid' : 'To pay at the venue'}: ${rupees(payable(f))}`,
    ...(paid && f.reference ? [`Reference: ${f.reference}`] : []),
  ]);
  return { subject, text, html: layout({ subject, preheader: `${f.bookingCode} · ${f.courtName} · ${span(f)}`, to, body }) };
}

/** To the venue's owner and managers: a new booking, and how it is paid. */
export function operatorBookingEmail(to: string, f: BookingFacts, commissionBps: number): RenderedEmail {
  const atVenue = f.paymentMode === 'at_venue' && f.paymentStatus !== 'paid';
  const subject = `New booking ${f.bookingCode} at ${f.venueName}`;
  const lines: [string, string][] = [
    ['Player', esc(f.playerName)],
    ['Table', esc(f.courtName)],
    ['When', esc(span(f))],
    ['Duration', `${minutes(f)} min`],
    ['Price', rupees(f.basePaise)],
  ];
  if (f.venueDiscountPaise > 0n) lines.push(['Your offer', `−${rupees(f.venueDiscountPaise)}`]);
  if (f.platformDiscountPaise > 0n) lines.push(['PL4Y offer (paid by PL4Y)', `−${rupees(f.platformDiscountPaise)}`]);
  lines.push(['Payment', atVenue ? `Collect ${rupees(f.basePaise - f.venueDiscountPaise - f.platformDiscountPaise)} at the desk` : 'Paid online through PL4Y']);
  const pct = `${(commissionBps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

  const body =
    eyebrow('Table booking') +
    title('New booking') +
    lead(`${esc(f.playerName)} booked ${esc(f.courtName)} at ${esc(f.venueName)}. It is on your venue dashboard.`) +
    rows(lines, ['You earn', rupees(f.basePaise - f.venueDiscountPaise)]) +
    button('Open the venue dashboard', link('/app/venue-desk')) +
    divider() +
    para(
      `PL4Y’s commission on this booking is ${pct}. PL4Y pays for its own offers, so they never come out of your earnings. ` +
        'Online payments reach your bank in the monthly payout.',
    );

  const text = plain([
    `${f.playerName} booked ${f.courtName} at ${f.venueName}: ${span(f)}.`,
    `Booking ${f.bookingCode}. ${atVenue ? 'To be paid at the desk.' : 'Paid online.'}`,
    `You earn ${rupees(f.basePaise - f.venueDiscountPaise)} before PL4Y's ${pct} commission.`,
  ]);
  return { subject, text, html: layout({ subject, preheader: `${f.playerName} · ${f.courtName} · ${span(f)}`, to, body }) };
}
