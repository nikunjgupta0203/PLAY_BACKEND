import { describe, expect, it } from 'vitest';
import { isQuietHours, offerExpiresAt } from './waitlist.js';

const TTL = 30 * 60_000;
/** An IST wall-clock time, as the UTC instant it is. */
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe('registration R17: waitlist offer expiry', () => {
  it('an offer made in the day lives for the TTL', () => {
    const now = ist('2026-09-13T15:00:00');
    expect(offerExpiresAt(now, TTL)).toEqual(ist('2026-09-13T15:30:00'));
  });

  it('an offer made before midnight in quiet hours expires at 08:00 IST tomorrow', () => {
    expect(offerExpiresAt(ist('2026-09-13T23:10:00'), TTL)).toEqual(ist('2026-09-14T08:00:00'));
  });

  it('an offer made after midnight in quiet hours expires at 08:00 IST today', () => {
    expect(offerExpiresAt(ist('2026-09-14T02:45:00'), TTL)).toEqual(ist('2026-09-14T08:00:00'));
  });

  it('quiet hours are 22:00 to 07:00 IST, whatever the server timezone', () => {
    expect(isQuietHours(ist('2026-09-13T21:59:00'))).toBe(false);
    expect(isQuietHours(ist('2026-09-13T22:00:00'))).toBe(true);
    expect(isQuietHours(ist('2026-09-14T06:59:00'))).toBe(true);
    expect(isQuietHours(ist('2026-09-14T07:00:00'))).toBe(false);
  });

  it('handles the month boundary', () => {
    expect(offerExpiresAt(ist('2026-09-30T22:30:00'), TTL)).toEqual(ist('2026-10-01T08:00:00'));
  });
});
