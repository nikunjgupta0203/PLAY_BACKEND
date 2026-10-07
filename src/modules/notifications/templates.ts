/**
 * notifications — the template registry (R4).
 *
 * Every string a notification shows is written here, against a typed payload.
 * No call site assembles a message: a producer hands over a key and the facts,
 * and this file decides the words. `TemplatePayloads` is the compile-time
 * exhaustiveness check the checklist asks for — a key with no renderer, or a
 * renderer reading a field its payload does not declare, does not build.
 *
 * Rendering happens on READ, not on write, so a copy fix reaches rows already
 * in the feed.
 *
 * R11 — user-written text (an organizer's broadcast) is a payload FIELD and is
 * returned as plain text. The client renders `body` as text, never markup.
 */

/** R10 — non-entity screens. Closed: adding one is a reviewed code change. */
export const DEEP_LINK_ROUTES = [
  'payment_history',
  'organizer_payouts',
  'organizer_dashboard',
  'support_ticket',
  /** chat — `id` is the conversation. */
  'conversation',
  /** org — `id` is the organisation's slug. */
  'organisation',
  /** bookings — `id` is the court booking. */
  'court_booking',
  /** N2 — an event's draw and schedule; `id` is the event's slug. */
  'event_draw',
] as const;
export type DeepLinkRoute = (typeof DEEP_LINK_ROUTES)[number];

export type TargetKind = 'event' | 'match' | 'player' | 'venue' | 'game' | 'community';

/** R5, R9, R10 — where a tap goes. An event is reached by slug on every client. */
export type Target =
  | { kind: 'event'; id: string; slug: string }
  | { kind: Exclude<TargetKind, 'event'>; id: string }
  | { kind: 'route'; route: DeepLinkRoute; id?: string };

export interface TemplatePayloads {
  'registration.confirmed': { eventTitle: string; categoryName: string };
  'partner.invite': { eventTitle: string; categoryName: string };
  /** The captain hears that the invited partner said no. */
  'partner.declined': { eventTitle: string; categoryName: string };
  'match.starting_soon': { eventTitle: string; courtName: string | null; startsAt: string };
  /** A later-round match now has both sides: the player's next opponent is known. */
  'match.ready': { eventTitle: string; opponentName: string };
  /** The other side is asked to confirm (scoring R6). Null minutes: a person must confirm (R12). */
  'match.result_pending': { eventTitle: string; autoConfirmMinutes?: number | null };
  /** scoring R14 — sent once, half-way through the window. */
  'match.result_reminder': { eventTitle: string; autoConfirmMinutes: number | null };
  /** scoring R13 — to owners and managers, once per result. */
  'match.results_waiting': { eventTitle: string; count: number };
  /** `league`: a league or group match — a win is points, not a next round. `drawn`: it ended level. */
  /** `last` — the winner has no next match here (a final, a third-place match). */
  'match.result': { eventTitle: string; won: boolean; auto?: boolean; drawn?: boolean; league?: boolean; last?: boolean };
  /**
   * Players: the side whose score was disputed. Organizer: asked to settle it.
   * `reviewer: 'pl4y'` — no neutral organizer, so PL4Y settles it (F4).
   */
  'match.result_disputed': { eventTitle: string; audience: 'player' | 'organizer'; reviewer?: 'organizer' | 'pl4y' };
  'ranking.changed': { sportName: string; rank: number; movement: number };
  /** Settled ratings only (rating R2). */
  'rating.changed': { sportName: string; rating: number; delta: number };
  'payment.updated': { eventTitle: string; state: 'failed' | 'refunded'; amountPaise: string | null };
  /** chat R3 — someone with no shared play asked to talk. */
  'chat.request': { fromName: string };
  /** chat R8 — the first unread message in a conversation. `preview` is the sender's own words. */
  'chat.message': { fromName: string; preview: string };
  'achievement.earned': { title: string };
  'registration.expired': {
    eventTitle: string;
    reason: 'hold_expired' | 'invite_expired' | 'waitlist_offer_expired' | 'registration_closed';
  };
  /** F19 — the host's reason, in their words, when they gave one. */
  'event.cancelled': { eventTitle: string; reason?: string | null };
  /** F18 — the place or dates changed after they entered; they may withdraw in full for 48 hours. */
  'event.changed': { eventTitle: string; datesChanged: boolean; placeChanged: boolean };
  /** F25 — a draw finished: who won it. */
  'draw.finished': { eventTitle: string; categoryName: string; winnerName: string };
  /** F3 — PL4Y looked at the player's report. */
  'event.report_resolved': { eventTitle: string; outcome: 'resolved' | 'dismissed' };
  /** F12 — to the host: someone entered. */
  'host.new_entry': { eventTitle: string; categoryName: string; entrantName: string };
  /** F12 — to the host: a day before close, a draw is short of its minimum. */
  'host.draw_short': { eventTitle: string; categoryName: string; confirmed: number; minEntries: number };
  /** F12 — to the host: a draw missed its minimum and was cancelled and refunded. */
  'host.draw_cancelled': { eventTitle: string; categoryName: string };
  /** F12 — to the host: registration closed; make the draw. */
  /** `heats` — a race or a scorecard (N11): it is run as heats, there is no draw to make. */
  'host.ready_to_draw': { eventTitle: string; categoryName: string; heats?: boolean };
  /** The app made the draw (or the heats) itself when registration closed. `heats`: how many; 0 for a draw. */
  'host.draw_made': { eventTitle: string; categoryName: string; heats: number };
  /** F12 — to the host: the event is over; when the payout is due, if there is one. */
  'host.event_completed': { eventTitle: string; payoutDueAt: string | null };
  /** events R9 — one draw missed its minimum entries. */
  'category.cancelled': { eventTitle: string; categoryName: string };
  'draw.generated': { eventTitle: string; categoryName: string };
  'waitlist.offer': { eventTitle: string; categoryName: string };
  /** R11 — `message` is the organizer's own words. */
  'organizer.message': { eventTitle: string; message: string };
  /** payouts R3, R6 — the host's bank details were checked or reviewed. */
  'payout_account.status': { status: 'checking' | 'verified' | 'needs_review' | 'rejected' | 'suspended'; reason: string | null };
  /** payouts R13 — money sent, or a transfer that failed. */
  'payout.status': {
    eventTitle: string;
    state: 'paid' | 'failed';
    amountPaise: string;
    /** Manual payouts — the bank reference staff recorded. */
    utr?: string | null;
  };
  /** admin R7 — PL4Y support answered a ticket. */
  'support.reply': { subject: string };
  /** bookings R2 — a court is booked and paid. */
  'booking.confirmed': { venueName: string; courtName: string; startsAt: string };
  /** bookings R6 — a booking was cancelled; `by: 'venue'` refunds everything. */
  'booking.cancelled': { venueName: string; courtName: string; startsAt: string; by: 'player' | 'venue'; refundPaise: string | null };
  /** org — someone was added to an organisation, made its owner, or removed from it. */
  'organisation.membership': {
    organisationName: string;
    change: 'added' | 'owner' | 'removed' | 'suspended' | 'reinstated';
    role?: 'owner' | 'admin' | 'member' | null;
  };
}

export type TemplateKey = keyof TemplatePayloads;

interface Template<P> {
  render(p: P): { title: string; body: string };
  /** R3 — only a player standing on a court outranks quiet hours. */
  overridesQuietHours?: boolean;
}

const rupees = (paise: string | null): string =>
  paise === null ? '' : ` ₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const REASONS: Record<TemplatePayloads['registration.expired']['reason'], string> = {
  hold_expired: 'Your seat hold ran out before payment finished.',
  invite_expired: 'Your partner did not accept in time.',
  waitlist_offer_expired: 'The waitlist offer ran out before payment.',
  registration_closed: 'Registration closed before your entry was complete.',
};

export const TEMPLATES: { [K in TemplateKey]: Template<TemplatePayloads[K]> } = {
  'registration.confirmed': {
    render: (p) => ({
      title: "You're in",
      body: `${p.eventTitle} · ${p.categoryName}. Your check-in code is in My PL4Y.`,
    }),
  },
  'partner.invite': {
    render: (p) => ({
      title: 'You have a partner invite',
      body: `${p.eventTitle} · ${p.categoryName}. Open the email we sent to accept.`,
    }),
  },
  'partner.declined': {
    render: (p) => ({
      title: 'Partner declined',
      body: `${p.eventTitle} · ${p.categoryName}. Invite someone else to keep your entry.`,
    }),
  },
  'match.starting_soon': {
    overridesQuietHours: true,
    render: (p) => ({
      title: 'Your match starts soon',
      body: p.courtName ? `${p.eventTitle} · ${p.courtName}` : p.eventTitle,
    }),
  },
  'match.ready': {
    render: (p) => ({
      title: 'Your next match is set',
      body: `${p.eventTitle}. You play ${p.opponentName} next — we'll tell you the court and time.`,
    }),
  },
  'match.result_pending': {
    render: (p) => ({
      title: 'Confirm your result',
      body: p.autoConfirmMinutes
        ? `${p.eventTitle}. The other side entered a score — confirm or dispute it. It confirms automatically in ${p.autoConfirmMinutes} minutes.`
        : `${p.eventTitle}. The other side entered a score — check it and confirm.`,
    }),
  },
  'match.result_reminder': {
    render: (p) => ({
      title: 'Your result is waiting',
      body: p.autoConfirmMinutes
        ? `${p.eventTitle}. Confirm or dispute — it confirms automatically in ${p.autoConfirmMinutes} minutes.`
        : `${p.eventTitle}. Confirm or dispute your result.`,
    }),
  },
  'match.results_waiting': {
    render: (p) => ({
      title: p.count === 1 ? '1 result is waiting' : `${p.count} results are waiting`,
      body: `${p.eventTitle}. Nobody has confirmed them yet — you can confirm them now.`,
    }),
  },
  'match.result': {
    render: (p) => ({
      title: p.drawn ? 'It’s a draw' : p.won ? 'You won' : 'Result confirmed',
      body:
        (p.drawn
          ? `${p.eventTitle}. A point each.`
          : p.won
            ? `${p.eventTitle}. ${p.league ? 'Three points.' : p.last ? 'Well played.' : 'On to the next round.'}`
            : `${p.eventTitle}. Good game.`) + (p.auto ? ' Confirmed automatically.' : ''),
    }),
  },
  'match.result_disputed': {
    render: (p) =>
      p.audience === 'organizer'
        ? { title: 'A result is disputed', body: `${p.eventTitle}. Review the score and settle it.` }
        : {
            title: 'Your result was disputed',
            body: `${p.eventTitle}. ${p.reviewer === 'pl4y' ? 'PL4Y will review the score.' : 'The organizer will review the score.'}`,
          },
  },
  'rating.changed': {
    render: (p) => ({
      title:
        p.delta > 0
          ? `Rating up ${Math.round(p.delta)} in ${p.sportName}`
          : `Rating down ${Math.round(-p.delta)} in ${p.sportName}`,
      body: `Your PL4Y rating is now ${Math.round(p.rating)}.`,
    }),
  },
  'ranking.changed': {
    render: (p) => ({
      title: p.movement > 0 ? `Up ${p.movement} in ${p.sportName}` : `Down ${-p.movement} in ${p.sportName}`,
      body: `You're now #${p.rank}.`,
    }),
  },
  'payment.updated': {
    render: (p) =>
      p.state === 'refunded'
        ? { title: 'Refund on its way', body: `${p.eventTitle}.${rupees(p.amountPaise)} back to your account.` }
        : { title: 'Payment failed', body: `${p.eventTitle}. Nothing was charged. Try again from My PL4Y.` },
  },
  'chat.request': {
    render: (p) => ({ title: 'Message request', body: `${p.fromName} wants to chat.` }),
  },
  'chat.message': {
    render: (p) => ({ title: p.fromName, body: p.preview }),
  },
  'achievement.earned': {
    render: (p) => ({ title: 'Achievement unlocked', body: p.title }),
  },
  'registration.expired': {
    render: (p) => ({ title: 'Entry not completed', body: `${p.eventTitle}. ${REASONS[p.reason]}` }),
  },
  'event.cancelled': {
    render: (p) => ({
      title: 'Event cancelled',
      body: p.reason
        ? `${p.eventTitle} was cancelled: “${p.reason}”. Paid entries are refunded in full.`
        : `${p.eventTitle} was cancelled. Paid entries are refunded in full.`,
    }),
  },
  'event.changed': {
    render: (p) => {
      const what = p.datesChanged && p.placeChanged ? 'date and place' : p.datesChanged ? 'date' : 'place';
      return {
        title: `The ${what} changed`,
        body: `${p.eventTitle}. Check the new ${what}. If it no longer works for you, withdraw in the next 48 hours for a full refund.`,
      };
    },
  },
  'draw.finished': {
    render: (p) => ({ title: `${p.winnerName} won ${p.categoryName}`, body: `${p.eventTitle}. See the final standings.` }),
  },
  'event.report_resolved': {
    render: (p) => ({
      title: 'We looked at your report',
      body:
        p.outcome === 'resolved'
          ? `${p.eventTitle}. We acted on it. Thank you for telling us.`
          : `${p.eventTitle}. We checked and found nothing to act on. Contact support if you disagree.`,
    }),
  },
  'host.new_entry': {
    render: (p) => ({ title: 'New entry', body: `${p.entrantName} entered ${p.categoryName} · ${p.eventTitle}.` }),
  },
  'host.draw_short': {
    render: (p) => ({
      title: `${p.categoryName} is short of players`,
      body: `${p.eventTitle}. ${p.confirmed} of ${p.minEntries} entered, and registration closes within a day. Share it, or lower the minimum.`,
    }),
  },
  'host.draw_cancelled': {
    render: (p) => ({
      title: `${p.categoryName} was cancelled`,
      body: `${p.eventTitle}. It did not reach its minimum entries, so everyone in it was refunded.`,
    }),
  },
  'host.ready_to_draw': {
    render: (p) =>
      p.heats
        ? { title: 'Set up the heats', body: `${p.eventTitle} · ${p.categoryName}. Registration is closed, but the heats couldn't be made by themselves — set them up in Draws & schedule.` }
        : { title: 'Make the draw', body: `${p.eventTitle} · ${p.categoryName}. Registration is closed, but the draw couldn't be made by itself — make it in Draws & schedule.` },
  },
  'host.draw_made': {
    render: (p) => ({
      title: p.heats > 0 ? 'Your heats are ready' : 'Your draw is ready',
      body:
        p.heats > 0
          ? `${p.eventTitle} · ${p.categoryName}. ${p.heats === 1 ? 'One heat' : `${p.heats} heats`} made from the entries. You can change them before scoring starts.`
          : `${p.eventTitle} · ${p.categoryName}. Made from the entries and seeded by rating. You can redo it in Draws & schedule until the first match starts.`,
    }),
  },
  'host.event_completed': {
    render: (p) => ({
      title: 'Your event is over',
      body: p.payoutDueAt
        ? `${p.eventTitle}. Thanks for hosting. Your payout is due ${new Date(p.payoutDueAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`
        : `${p.eventTitle}. Thanks for hosting.`,
    }),
  },
  'category.cancelled': {
    render: (p) => ({
      title: 'Draw cancelled',
      body: `${p.eventTitle} · ${p.categoryName} did not reach its minimum entries. Paid entries are refunded in full.`,
    }),
  },
  'draw.generated': {
    render: (p) => ({ title: 'The draw is out', body: `${p.eventTitle} · ${p.categoryName}. See who you play.` }),
  },
  'waitlist.offer': {
    render: (p) => ({
      title: 'A place opened up',
      body: `${p.eventTitle} · ${p.categoryName}. It's held for you — pay to keep it.`,
    }),
  },
  'organizer.message': {
    render: (p) => ({ title: p.eventTitle, body: p.message }),
  },
  'payout_account.status': {
    render: (p) => {
      switch (p.status) {
        case 'verified':
          return { title: "You're set to get paid", body: 'Your bank account is verified. You can publish paid events.' };
        case 'needs_review':
          return { title: "We're checking your details", body: 'Our team is reviewing your bank details. This usually takes a day.' };
        case 'rejected':
          return { title: 'Check your bank details', body: p.reason ?? 'We could not verify your bank account.' };
        case 'suspended':
          return { title: 'Payouts paused', body: p.reason ?? 'Payouts to your account are paused. Contact support.' };
        default:
          return { title: 'Checking your bank details', body: 'This usually takes under a minute.' };
      }
    },
  },
  'payout.status': {
    render: (p) => {
      const rupees = `₹${(Number(p.amountPaise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
      return p.state === 'paid'
        ? {
            title: `${rupees} sent to your bank`,
            body: p.utr ? `Your earnings from ${p.eventTitle}. Bank reference (UTR): ${p.utr}.` : `Your earnings from ${p.eventTitle}.`,
          }
        : { title: 'Payout failed', body: `We couldn't send your earnings from ${p.eventTitle}. We're looking into it.` };
    },
  },
  'support.reply': {
    render: (p) => ({ title: 'PL4Y support replied', body: p.subject }),
  },
  'booking.confirmed': {
    render: (p) => ({
      title: `Court booked at ${p.venueName}`,
      body: `${p.courtName} · ${istWhen(p.startsAt)}. Show your booking QR at the desk.`,
    }),
  },
  'booking.cancelled': {
    render: (p) => {
      const refund =
        p.refundPaise && p.refundPaise !== '0'
          ? ` ₹${(Number(p.refundPaise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })} is on its way back to you.`
          : '';
      return p.by === 'venue'
        ? { title: `${p.venueName} cancelled your booking`, body: `${p.courtName} · ${istWhen(p.startsAt)}.${refund}` }
        : { title: 'Booking cancelled', body: `${p.courtName} at ${p.venueName} · ${istWhen(p.startsAt)}.${refund}` };
    },
  },
  'organisation.membership': {
    render: (p) => {
      switch (p.change) {
        case 'owner':
          return {
            title: `You now own ${p.organisationName}`,
            body: 'Host events as the organisation from the Hosting tab, and add its bank account to get paid.',
          };
        case 'removed':
          return { title: `You left ${p.organisationName}`, body: 'Its events are no longer in your Hosting tab.' };
        case 'suspended':
          return {
            title: `${p.organisationName} is suspended`,
            body: 'It cannot publish events or take entries until PL4Y lifts this. Contact support for details.',
          };
        case 'reinstated':
          return { title: `${p.organisationName} is active again`, body: 'It can publish events and take entries.' };
        default:
          return {
            title: `You joined ${p.organisationName}`,
            body: `You're ${p.role === 'admin' ? 'an admin' : 'a member'}. Host events as the organisation from the Hosting tab.`,
          };
      }
    },
  },
};

/** "Sat 12 Oct, 6:00 pm" in India time, for booking notices. */
function istWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function isTemplateKey(key: string): key is TemplateKey {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, key);
}

/** Renders a stored row. A key this build does not know is a deploy problem, not a crash. */
export function render(key: string, payload: unknown): { title: string; body: string } | null {
  if (!isTemplateKey(key)) return null;
  const template = TEMPLATES[key] as Template<unknown>;
  try {
    return template.render(payload);
  } catch {
    return null;
  }
}

export function overridesQuietHours(key: TemplateKey): boolean {
  return (TEMPLATES[key] as Template<unknown>).overridesQuietHours === true;
}

/**
 * R3 — 22:00–07:00 in India. India has one offset and no daylight saving, so
 * this is arithmetic on UTC rather than a timezone database lookup.
 */
export function inQuietHours(at: Date): boolean {
  const istMinutes = (at.getUTCHours() * 60 + at.getUTCMinutes() + 330) % (24 * 60);
  return istMinutes >= 22 * 60 || istMinutes < 7 * 60;
}

/** The next 07:00 IST (01:30 UTC) strictly after `at` — when a push held by R3 goes out. */
export function quietHoursEnd(at: Date): Date {
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 1, 30));
  if (end.getTime() <= at.getTime()) end.setUTCDate(end.getUTCDate() + 1);
  return end;
}
