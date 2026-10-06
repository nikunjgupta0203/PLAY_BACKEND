import { describe, expect, it } from 'vitest';
import { autoConfirmAt, autoConfirmFor, isAutoEligible, isRatable, playerAutoConfirmAt, reminderDueAt } from './finality.js';

const MIN = 60_000;
const t0 = new Date('2026-10-03T10:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

describe('scoring — finality rules', () => {
  it('scoring R12 (gap #17): only staff-submitted results are auto-eligible; a player’s own, live or typed, is not', () => {
    expect(isAutoEligible('live', 'player')).toBe(false);
    expect(isAutoEligible('typed', 'staff')).toBe(true);
    expect(isAutoEligible('live', 'staff')).toBe(true);
    expect(isAutoEligible('typed', 'player')).toBe(false);
  });

  it('scoring R11: 60 minutes when the event runs on', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(600 * MIN), eligible: true })).toEqual(plus(60 * MIN));
  });

  it('scoring R11: shortened to the event end', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(30 * MIN), eligible: true })).toEqual(plus(30 * MIN));
  });

  it('scoring R11: never shorter than 15 minutes, even after the event ended', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(5 * MIN), eligible: true })).toEqual(plus(15 * MIN));
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(-120 * MIN), eligible: true })).toEqual(plus(15 * MIN));
  });

  it('scoring R11: an ineligible result never auto-confirms', () => {
    expect(autoConfirmAt({ submittedAt: t0, eventEndsAt: plus(600 * MIN), eligible: false })).toBeNull();
  });

  it('scoring R14: the reminder is due at half the window, or at 30 minutes without one', () => {
    expect(reminderDueAt({ submittedAt: t0, autoConfirmAt: plus(60 * MIN) })).toEqual(plus(30 * MIN));
    expect(reminderDueAt({ submittedAt: t0, autoConfirmAt: plus(16 * MIN) })).toEqual(plus(8 * MIN));
    expect(reminderDueAt({ submittedAt: t0, autoConfirmAt: null })).toEqual(plus(30 * MIN));
  });

  it('F5: a player’s result confirms itself 2 hours after submission while the event runs', () => {
    expect(playerAutoConfirmAt({ submittedAt: t0, eventEndsAt: plus(600 * MIN) })).toEqual(plus(120 * MIN));
  });

  it('F5: shortened to 2 hours after the event ends, never under 30 minutes', () => {
    expect(playerAutoConfirmAt({ submittedAt: t0, eventEndsAt: plus(-30 * MIN) })).toEqual(plus(90 * MIN));
    expect(playerAutoConfirmAt({ submittedAt: t0, eventEndsAt: plus(-600 * MIN) })).toEqual(plus(30 * MIN));
  });

  it('F5: staff keep the R11 window; players get theirs', () => {
    expect(autoConfirmFor({ submittedAt: t0, eventEndsAt: plus(600 * MIN), role: 'staff' })).toEqual(plus(60 * MIN));
    expect(autoConfirmFor({ submittedAt: t0, eventEndsAt: plus(600 * MIN), role: 'player' })).toEqual(plus(120 * MIN));
  });

  it('F26: a player’s result confirmed by silence is not rated; anything a person or staff confirmed is', () => {
    expect(isRatable({ confirmedVia: 'auto', submitterRole: 'player' })).toBe(false);
    expect(isRatable({ confirmedVia: 'auto', submitterRole: 'staff' })).toBe(true);
    expect(isRatable({ confirmedVia: 'opponent', submitterRole: 'player' })).toBe(true);
    expect(isRatable({ confirmedVia: 'staff', submitterRole: 'player' })).toBe(true);
  });
});
