import { describe, expect, it } from 'vitest';
import { nextRun, parseCron } from './cron.js';

const at = (iso: string) => new Date(iso);

describe('nextRun', () => {
  it('steps: */5 lands on the next multiple of five', () => {
    expect(nextRun('*/5 * * * *', at('2026-09-29T10:02:30Z'))).toEqual(at('2026-09-29T10:05:00Z'));
  });
  it('is strictly after: a pattern matching `after` itself moves on', () => {
    expect(nextRun('0 * * * *', at('2026-09-29T10:00:00Z'))).toEqual(at('2026-09-29T11:00:00Z'));
  });
  it('every minute rounds up to the next whole minute', () => {
    expect(nextRun('* * * * *', at('2026-09-29T10:00:59.999Z'))).toEqual(at('2026-09-29T10:01:00Z'));
  });
  it('daily at a fixed time rolls to tomorrow once passed', () => {
    expect(nextRun('15 3 * * *', at('2026-09-29T03:15:00Z'))).toEqual(at('2026-09-30T03:15:00Z'));
  });
  it('weekly: rating R4 period, Sunday 21:30 UTC', () => {
    // 2026-09-28 is a Monday.
    expect(nextRun('30 21 * * 0', at('2026-09-28T00:00:00Z'))).toEqual(at('2026-10-04T21:30:00Z'));
  });
  it('lists and ranges', () => {
    expect(nextRun('0 9-10,14 * * *', at('2026-09-29T10:30:00Z'))).toEqual(at('2026-09-29T14:00:00Z'));
  });
  it('day-of-month and day-of-week both restricted: either matches (standard cron)', () => {
    // 2026-10-01 is a Thursday; the 5th is the first Monday after it.
    expect(nextRun('0 0 1 * 1', at('2026-09-29T00:00:00Z'))).toEqual(at('2026-10-01T00:00:00Z'));
  });
});

describe('parseCron', () => {
  it.each(['61 * * * *', '* * *', '*/0 * * * *', 'a * * * *', '* * * * 7', '5-1 * * * *'])(
    'rejects %s',
    (bad) => {
      expect(() => parseCron(bad)).toThrow(/cron/);
    },
  );
});
