/**
 * The draw makes itself. When a category's registration closes, the app
 * draws it — a bracket, a league or groups for a match sport (the draw type
 * the host chose, seeded by rating), heats for a race or a lift (as many as
 * the sport's lanes or flights need). The host is told it is done and can
 * still redo it before play starts.
 *
 * Composition, like notify.ts: it needs events, sport, registration,
 * tournament and scoring, which only the worker holds together.
 */
import { isUserError } from './platform/errors/index.js';
import { events } from './modules/events/index.js';
import { registration } from './modules/registration/index.js';
import { heatCountFor, sport } from './modules/sport/index.js';
import { field } from './modules/scoring/index.js';
import { tournament } from './modules/tournament/index.js';

/** Players still paying hold their seat for a few minutes: try again this often, this many times. */
export const AUTO_DRAW_RETRY_MS = 10 * 60_000;
export const AUTO_DRAW_ATTEMPTS = 6;

export type AutoDrawOutcome =
  /** The bracket, league or groups were made. */
  | { kind: 'drawn' }
  /** The heats were made. */
  | { kind: 'heats'; count: number }
  /** Someone is still paying: run again later. */
  | { kind: 'retry' }
  /** It cannot be made by itself; the host is asked to (the old flow). */
  | { kind: 'manual'; reason: string }
  /** Nothing to do: already drawn, cancelled, or not closed. */
  | { kind: 'skip' };

const FIELD_KINDS = new Set(['performance', 'scorecard']);

export async function autoDrawCategory(categoryId: string, attempt: number): Promise<AutoDrawOutcome> {
  const category = await events.categoryById(categoryId).catch(() => null);
  if (!category || category.status !== 'closed') return { kind: 'skip' };
  const rule = await sport.ruleForCategory(category);

  try {
    if (FIELD_KINDS.has(rule.kind)) {
      const entrants = (await registration.confirmedForCategory(categoryId)).length;
      const { slug } = await sport.byId(category.sportId);
      const heats = await field.autoHeats(categoryId, heatCountFor(slug, entrants));
      return heats ? { kind: 'heats', count: heats.length } : { kind: 'skip' };
    }
    return (await tournament.autoDraw(categoryId)) ? { kind: 'drawn' } : { kind: 'skip' };
  } catch (err) {
    if (!isUserError(err)) throw err;
    if (err.code === 'PLAYERS_STILL_PAYING' && attempt < AUTO_DRAW_ATTEMPTS) return { kind: 'retry' };
    return { kind: 'manual', reason: err.code };
  }
}
