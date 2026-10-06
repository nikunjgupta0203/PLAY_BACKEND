/**
 * scoring R11–R14 — when a result becomes final on its own.
 *
 * Pure: no database, no clock. The service computes `auto_confirm_at` once, at
 * submission, from these rules and stores it, so the sweep is a plain indexed
 * comparison and the client can show the same countdown the server will honour.
 */

export type ResultSource = 'live' | 'typed';
export type SubmitterRole = 'player' | 'staff';
/** `default` — gap #20: a dispute PL4Y never settled, closed on the submitted result. */
export type ConfirmedVia = 'opponent' | 'staff' | 'auto' | 'default';

/** R11 — how long the other side has, at most. */
export const AUTO_CONFIRM_AFTER_MS = 60 * 60_000;
/** R11 — how long the other side has, at least: the organizer override's own window (R6). */
export const AUTO_CONFIRM_FLOOR_MS = 15 * 60_000;
/** R14 — reminder for a result that will not confirm itself. */
export const REMINDER_AFTER_MS = 30 * 60_000;

/**
 * R12 — somebody neutral saw it: the organizer's own staff, not playing in
 * the match (the service already counts staff who play as `player`).
 *
 * gap #17 — a point log alone is not neutral. A player can tap their own
 * match through to a win, so a player's live score, like a player's typed
 * one, waits for the other side or the organizer to confirm it.
 */
export function isAutoEligible(_source: ResultSource, role: SubmitterRole): boolean {
  return role === 'staff';
}

/** R11 — max(submitted + 15 min, min(submitted + 60 min, event end)), or null. */
export function autoConfirmAt(input: {
  submittedAt: Date;
  eventEndsAt: Date;
  eligible: boolean;
}): Date | null {
  if (!input.eligible) return null;
  const submitted = input.submittedAt.getTime();
  const capped = Math.min(submitted + AUTO_CONFIRM_AFTER_MS, input.eventEndsAt.getTime());
  return new Date(Math.max(submitted + AUTO_CONFIRM_FLOOR_MS, capped));
}

/** F5 — how long the other side has on a player's own result before it confirms itself. */
export const PLAYER_AUTO_CONFIRM_AFTER_MS = 2 * 60 * 60_000;
/** F5 — never sooner than this after it was submitted, even long after the event ended. */
export const PLAYER_AUTO_CONFIRM_FLOOR_MS = 30 * 60_000;

/**
 * F5 — a player's result that nobody answered. Without this a result the loser
 * ignores never becomes final, the bracket stops, and the event "completes"
 * with no winner. The other side was told when it was submitted and reminded
 * half-way; silence after that is consent. gap #17 still holds where it
 * matters: a result confirmed this way is not rated (rating R7, F26).
 *
 * max(submitted + 30 min, min(submitted + 2 h, event end + 2 h)).
 */
export function playerAutoConfirmAt(input: { submittedAt: Date; eventEndsAt: Date }): Date {
  const submitted = input.submittedAt.getTime();
  const capped = Math.min(
    submitted + PLAYER_AUTO_CONFIRM_AFTER_MS,
    input.eventEndsAt.getTime() + PLAYER_AUTO_CONFIRM_AFTER_MS,
  );
  return new Date(Math.max(submitted + PLAYER_AUTO_CONFIRM_FLOOR_MS, capped));
}

/** When a result confirms itself: the staff window (R11), or a player's (F5). */
export function autoConfirmFor(input: { submittedAt: Date; eventEndsAt: Date; role: SubmitterRole }): Date {
  return input.role === 'staff'
    ? autoConfirmAt({ submittedAt: input.submittedAt, eventEndsAt: input.eventEndsAt, eligible: true })!
    : playerAutoConfirmAt(input);
}

/**
 * F5, F26 — whether a confirmed result says anything about how the players
 * play. One a player submitted that confirmed only because nobody answered
 * was never witnessed by anyone neutral.
 */
export function isRatable(result: { confirmedVia: string | null; submitterRole: string }): boolean {
  // gap #20 — a dispute closed by default was never decided by anyone.
  if (result.confirmedVia === 'default') return false;
  return !(result.confirmedVia === 'auto' && result.submitterRole === 'player');
}

/** R14 — half the window, so the reminder always leaves time to act on it. */
export function reminderDueAt(input: { submittedAt: Date; autoConfirmAt: Date | null }): Date {
  const submitted = input.submittedAt.getTime();
  if (!input.autoConfirmAt) return new Date(submitted + REMINDER_AFTER_MS);
  return new Date(submitted + (input.autoConfirmAt.getTime() - submitted) / 2);
}
