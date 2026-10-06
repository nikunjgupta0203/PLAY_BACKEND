import { describe, expect, it, vi } from 'vitest';
import { createMatchNotifier, supersededScores } from './matchUpdates.js';

const row = (id: number, topic: string, payload: Record<string, unknown>) => ({
  id: BigInt(id),
  topic,
  payload,
});

describe('supersededScores', () => {
  it('scoring R5: only the newest score per match in a drain is published', () => {
    const rows = [
      row(1, 'match.score', { matchId: 'm1', seq: 4 }),
      row(2, 'match.score', { matchId: 'm2', seq: 9 }),
      row(3, 'registration.confirmed', { registrationId: 'r1' }),
      row(4, 'match.score', { matchId: 'm1', seq: 5 }),
    ];
    expect(supersededScores(rows)).toEqual(new Set([1n]));
  });

  it('never touches other topics', () => {
    expect(supersededScores([row(1, 'match.live', { matchId: 'm1' })]).size).toBe(0);
  });
});

describe('createMatchNotifier', () => {
  const publisher = () => ({ enabled: true, publish: vi.fn(async () => undefined) });

  it('scoring R3: the score goes to the match channel whole', async () => {
    const p = publisher();
    const n = createMatchNotifier({ publisher: p, eventOfTournament: async () => null });
    const state = { games: [], current: { a: 3, b: 1 } };
    await n.score({ matchId: 'm1', eventId: 'e1', seq: 7, state, at: 'now' });
    expect(p.publish).toHaveBeenCalledWith(['private-match-m1'], 'score', { seq: 7, state, at: 'now' });
  });

  it('status goes to the event channel, resolving the event from the draw when needed', async () => {
    const p = publisher();
    const n = createMatchNotifier({ publisher: p, eventOfTournament: async () => 'e9' });
    await n.status('match.completed', { matchId: 'm1', tournamentId: 't1', outcome: 'walkover' });
    expect(p.publish).toHaveBeenCalledWith(['presence-event-e9'], 'match.status', {
      matchId: 'm1',
      status: 'WALKOVER',
    });
  });

  it('a Pusher outage is swallowed, never thrown into the drain', async () => {
    const p = { enabled: true, publish: vi.fn(async () => Promise.reject(new Error('down'))) };
    const n = createMatchNotifier({ publisher: p, eventOfTournament: async () => null });
    await expect(n.score({ matchId: 'm1', seq: 1, state: {} })).resolves.toBeUndefined();
  });
});
