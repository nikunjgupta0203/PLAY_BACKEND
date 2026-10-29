/**
 * `pnpm backfill:ranked-games` — games R19, "every match is ranked". Run once
 * after migration 053 is deployed.
 *
 * 1. Every confirmed casual result goes into player_match_history (analytics,
 *    stats, badges), as the worker now does for each new one.
 * 2. Ratings are replayed from the first casual result, so the weeks already
 *    settled are settled again with those results in them (rating R8). The
 *    replay also picks up tournament matches that the old draw-size rule left
 *    unrated.
 * 3. Every board is rebuilt.
 *
 * Idempotent, so safe to re-run.
 */
import { db, disconnectDb } from '../src/platform/db.js';
import { profile } from '../src/modules/profile/index.js';
import { gameResults } from '../src/modules/games/index.js';
import { rating } from '../src/modules/rating/index.js';

const ids = await gameResults.allConfirmedIds();
// A result past its hour that the sweep has not reached yet is confirmed in its own right.
await gameResults.sweep();
for (const id of ids) await profile.projectMatch(id);
console.log(`Projected ${ids.length} casual result(s) into match history.`);

const earliest = await db.gameResult.groupBy({
  by: ['sportId'],
  where: { status: 'confirmed' },
  _min: { confirmedAt: true },
});
const tournamentSports = await db.matchResult.findMany({
  where: { confirmedAt: { not: null } },
  select: { match: { select: { sportId: true } }, confirmedAt: true },
  orderBy: { confirmedAt: 'asc' },
});
const from = new Map<string, Date>();
for (const e of earliest) if (e._min.confirmedAt) from.set(e.sportId, e._min.confirmedAt);
for (const t of tournamentSports) {
  const at = t.confirmedAt!;
  const seen = from.get(t.match.sportId);
  if (!seen || at < seen) from.set(t.match.sportId, at);
}

for (const [sportId, at] of from) {
  const replayed = await rating.replay(sportId, at);
  const boards = await rating.rebuildAll(sportId);
  console.log(`Sport ${sportId}: replayed ${replayed.periods} period(s), ${replayed.playersUpdated} rating row(s); ${boards.boards} board(s).`);
}

await disconnectDb();
process.exit(0);
