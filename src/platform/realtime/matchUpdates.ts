/**
 * Match state → Pusher (docs/modules/10-scoring.md § Realtime contract).
 *
 *   private-match-{id}   "score"         the complete score, for that match's viewers
 *   presence-event-{id}  "match.status"  status transitions, for the event's viewers
 *
 * The split is the cost decision the contract describes: point-level detail
 * never goes to the event-wide channel.
 *
 * Best-effort, exactly as registrationUpdates.ts is (C1): a publish failure is
 * logged and swallowed, never retried. Every score payload is the whole score
 * (scoring R3) and clients refetch on a seq gap, so a dropped message costs a
 * refetch, while a retried outbox row pins the drain.
 *
 * Lives in platform/ and reads `tournaments` through `db` directly, because
 * platform/ may not import modules/.
 */
import { db } from '../db.js';
import { logger } from '../logging/index.js';
import { realtime, type RealtimePublisher } from '../pusher.js';

export const MATCH_STATUS_TOPICS: Record<string, string | null> = {
  'match.ready': 'READY',
  'match.live': 'LIVE',
  'match.awaiting_confirm': 'AWAITING_CONFIRM',
  // Carries its own status in `outcome`: COMPLETED or WALKOVER.
  'match.completed': null,
};

/**
 * scoring R5 — coalesce per match within one drain. Only the newest
 * `match.score` row for each match is published; the older ones are marked
 * processed without a publish. Nothing is lost, because the newest row carries
 * the complete score.
 *
 * The drain runs every 250 ms, which is what makes this the 250 ms window.
 */
export function supersededScores(
  rows: { id: bigint; topic: string; payload: unknown }[],
): Set<bigint> {
  const newest = new Map<string, bigint>();
  for (const row of rows) {
    if (row.topic !== 'match.score') continue;
    const matchId = (row.payload as Record<string, unknown> | null)?.['matchId'];
    if (typeof matchId !== 'string') continue;
    const seen = newest.get(matchId);
    if (seen === undefined || row.id > seen) newest.set(matchId, row.id);
  }
  const superseded = new Set<bigint>();
  for (const row of rows) {
    if (row.topic !== 'match.score') continue;
    const matchId = (row.payload as Record<string, unknown> | null)?.['matchId'];
    if (typeof matchId === 'string' && newest.get(matchId) !== row.id) superseded.add(row.id);
  }
  return superseded;
}

export function createMatchNotifier(deps: {
  publisher: RealtimePublisher;
  eventOfTournament: (tournamentId: string) => Promise<string | null>;
}) {
  return {
    async score(payload: Record<string, unknown>): Promise<void> {
      const matchId = payload['matchId'];
      if (typeof matchId !== 'string') return;
      try {
        await deps.publisher.publish([`private-match-${matchId}`], 'score', {
          seq: payload['seq'],
          state: payload['state'],
          at: payload['at'],
        });
      } catch (err) {
        logger.warn({ matchId, err }, 'score publish failed — dropped, never retried');
      }
    },

    /**
     * Plans 7, 8 — a heat changed. Invalidation only, on the event's channel:
     * viewers refetch the heat; the payload is never the standings.
     */
    async heat(payload: Record<string, unknown>): Promise<void> {
      const heatId = payload['heatId'];
      const eventId = payload['eventId'];
      if (typeof heatId !== 'string' || typeof eventId !== 'string') return;
      try {
        await deps.publisher.publish([`presence-event-${eventId}`], 'heat.score', { heatId, seq: payload['seq'] });
      } catch (err) {
        logger.warn({ heatId, err }, 'heat publish failed — dropped, never retried');
      }
    },

    async status(topic: string, payload: Record<string, unknown>): Promise<void> {
      if (!(topic in MATCH_STATUS_TOPICS)) return;
      const matchId = payload['matchId'];
      if (typeof matchId !== 'string') return;
      try {
        let eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
        const tournamentId = payload['tournamentId'];
        if (!eventId && typeof tournamentId === 'string') {
          eventId = await deps.eventOfTournament(tournamentId);
        }
        if (!eventId) return;
        const status =
          MATCH_STATUS_TOPICS[topic] ?? String(payload['outcome'] ?? 'completed').toUpperCase();
        await deps.publisher.publish([`presence-event-${eventId}`], 'match.status', {
          matchId,
          status,
        });
      } catch (err) {
        logger.warn({ topic, matchId, err }, 'match status publish failed — dropped, never retried');
      }
    },
  };
}

export const matchNotifier = createMatchNotifier({
  publisher: realtime,
  eventOfTournament: async (tournamentId) =>
    (await db.tournament.findUnique({ where: { id: tournamentId }, select: { eventId: true } }))
      ?.eventId ?? null,
});
