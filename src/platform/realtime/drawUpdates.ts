/**
 * N1 — a draw was made or redone, or a match got a time or a court:
 * `draw.changed` on presence-event-{id}, so the draw, the schedule and the
 * host's screens refetch instead of waiting out their cache.
 *
 * Invalidation only and best-effort, exactly as registrationUpdates.ts (C1):
 * a failure is logged and dropped, never retried, because the outbox row this
 * runs inside of must never fail because Pusher is down.
 */
import { db } from '../db.js';
import { logger } from '../logging/index.js';
import { realtime, type RealtimePublisher } from '../pusher.js';

export const DRAW_CHANGED_EVENT = 'draw.changed';

export function createDrawNotifier(deps: {
  publisher: RealtimePublisher;
  eventOfTournament: (tournamentId: string) => Promise<string | null>;
  eventOfMatch: (matchId: string) => Promise<string | null>;
}) {
  return {
    async changed(topic: string, payload: Record<string, unknown>): Promise<void> {
      const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
      try {
        const eventId =
          str(payload['eventId']) ??
          (str(payload['tournamentId']) ? await deps.eventOfTournament(str(payload['tournamentId'])!) : null) ??
          (str(payload['matchId']) ? await deps.eventOfMatch(str(payload['matchId'])!) : null);
        if (!eventId) return;
        await deps.publisher.publish([`presence-event-${eventId}`], DRAW_CHANGED_EVENT, { topic });
      } catch (err) {
        logger.warn({ topic, err }, 'draw publish failed — dropped, never retried');
      }
    },
  };
}

export const drawNotifier = createDrawNotifier({
  publisher: realtime,
  eventOfTournament: async (tournamentId) =>
    (await db.tournament.findUnique({ where: { id: tournamentId }, select: { eventId: true } }))?.eventId ?? null,
  eventOfMatch: async (matchId) =>
    (
      await db.match.findUnique({
        where: { id: matchId },
        select: { tournament: { select: { eventId: true } } },
      })
    )?.tournament?.eventId ?? null,
});
