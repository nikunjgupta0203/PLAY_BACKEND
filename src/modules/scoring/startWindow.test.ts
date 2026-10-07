import { describe, expect, it } from 'vitest';
import { createScoringService, START_OPENS_BEFORE_MS, type MatchInfo, type ScoringDeps } from './service/index.js';

const startsAt = new Date('2026-10-11T04:30:00Z');
const MIN = 60_000;

const match: MatchInfo = {
  id: 'm1',
  tournamentId: 't1',
  eventId: 'e1',
  eventCategoryId: 'c1',
  sportId: 's1',
  status: 'ready',
  bracket: 'championship',
  eventEndsAt: new Date(startsAt.getTime() + 8 * 60 * MIN),
  sideARegistrationId: 'ra',
  sideBRegistrationId: 'rb',
  eventStatus: 'published',
  scheduledAt: null,
  eventStartsAt: startsAt,
};

/** Only the guard runs: the transaction marks how far a start got. */
function serviceAt(at: Date) {
  let reachedTransaction = false;
  const deps = {
    db: {
      $transaction: async () => {
        reachedTransaction = true;
        return { state: null, seq: 1 };
      },
    },
    repo: {},
    matches: { byId: async () => match },
    ruleFor: async () => ({ kind: 'goals' }),
    roleOn: async () => 'owner' as const,
    membersOf: async () => [],
    now: () => at,
  } as unknown as ScoringDeps;
  const scoring = createScoringService(deps);
  return { scoring, reached: () => reachedTransaction };
}

const actor = { userId: 'u1', sessionId: 's1' };

describe('scoring — when a match may start', () => {
  it('refuses a start days before the event, saying when it opens', async () => {
    const { scoring, reached } = serviceAt(new Date(startsAt.getTime() - 3 * 24 * 60 * MIN));
    await expect(scoring.start(actor, 'm1')).rejects.toMatchObject({
      code: 'MATCH_TOO_EARLY',
      details: { opensAt: new Date(startsAt.getTime() - START_OPENS_BEFORE_MS).toISOString() },
    });
    expect(reached()).toBe(false);
  });

  it('opens an hour before the event begins', async () => {
    const { scoring, reached } = serviceAt(new Date(startsAt.getTime() - 59 * MIN));
    await scoring.start(actor, 'm1');
    expect(reached()).toBe(true);
  });
});
