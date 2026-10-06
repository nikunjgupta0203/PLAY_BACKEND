/**
 * registration R11 — the ONE guard every status change goes through.
 *
 * There is no other write path to `registrations.status`. The repo exposes a
 * single `transition()` that calls this first, and a disallowed move throws
 * ILLEGAL_TRANSITION rather than silently no-opping — a state machine that
 * quietly ignores an impossible move is a state machine that will one day
 * refund a player who never paid.
 *
 * The table below is the one in docs/modules/06-registration.md § State
 * machine, transcribed. When they disagree, this file is what runs, so change
 * both.
 */
import { illegalTransition } from '../../../platform/errors/index.js';

export const REGISTRATION_STATUSES = [
  'draft',
  'awaiting_partner',
  'waitlisted',
  'payment_pending',
  'confirmed',
  'checked_in',
  'withdrawn',
  'expired',
  'payment_failed',
  'refunded',
] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/**
 * The statuses that occupy a slot in the draw. Exactly the list in the unique
 * partial index `reg_one_live_per_player` (R1) — if these two ever drift, the
 * constraint stops meaning what the service thinks it means.
 *
 * `draft` is deliberately absent: a draft has no hold (R2) and no team, so it
 * costs the draw nothing. `waitlisted` is present (R17): it holds no seat, but
 * it is still the player's one live entry in this draw.
 */
export const LIVE_STATUSES: RegistrationStatus[] = [
  'awaiting_partner',
  'waitlisted',
  'payment_pending',
  'confirmed',
  'checked_in',
];

/**
 * The statuses the capacity query counts as `taken` — R4: "counts confirmed
 * entries plus unexpired holds".
 *
 * `payment_pending` is deliberately ABSENT. A pending entry is already
 * represented by its live seat hold, so counting the row as well charges one
 * player two seats: a ten-entry draw seats five, and the player retrying a
 * failed payment is told their own seat is taken. Whatever counts here must
 * NOT also be counted by `countLiveHoldSeats`, and vice versa — the two
 * numbers are added, never maxed.
 *
 * It is also why R5 works: an entry whose hold expired stops blocking capacity
 * immediately, because neither half of the sum still counts it.
 *
 * `waitlisted` is absent for the same reason it takes no hold (R17).
 */
export const SEATED_STATUSES: RegistrationStatus[] = ['confirmed', 'checked_in'];

const ALLOWED: Record<RegistrationStatus, RegistrationStatus[]> = {
  // A draft either invites a partner or, for singles, goes straight to payment.
  // A singles draft for a full draw joins the waitlist (R17).
  draft: ['awaiting_partner', 'payment_pending', 'waitlisted', 'expired', 'withdrawn'],
  // The partner accepts and the team becomes real — that is when a seat is
  // taken (R2), or, if the draw filled meanwhile, when the team is queued
  // (R17). Invite expiry drops it.
  awaiting_partner: ['payment_pending', 'waitlisted', 'expired', 'withdrawn'],
  // R17 — promotion acquires a hold through the R4 query. Leaving releases the
  // position; a draw that closes with the entry still queued expires it.
  waitlisted: ['payment_pending', 'withdrawn', 'expired'],
  payment_pending: ['confirmed', 'payment_failed', 'expired', 'withdrawn'],
  // R8 — a failed payment may be retried against the SAME hold while it lives.
  // `confirmed` is the payment path only: a provider that retries on the same
  // order id (Razorpay's checkout retries in place) can capture after the
  // failure notice already landed.
  // confirmFromPayment allows it only while the seat hold is still live.
  payment_failed: ['payment_pending', 'confirmed', 'expired', 'withdrawn'],
  confirmed: ['checked_in', 'refunded', 'withdrawn'],
  // A checked-in player has walked onto a court, so nothing THEY do moves
  // this. Only an organizer cancelling the event or the draw does (gap #2),
  // and it refunds them like everyone else.
  checked_in: ['refunded', 'withdrawn'],
  withdrawn: [],
  expired: [],
  refunded: [],
};

export const canTransition = (from: RegistrationStatus, to: RegistrationStatus): boolean =>
  ALLOWED[from].includes(to);

export function assertTransition(from: RegistrationStatus, to: RegistrationStatus): void {
  if (!canTransition(from, to)) throw illegalTransition(from, to);
}
