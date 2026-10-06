/**
 * `pnpm backfill:match-history` — profile R12 and venues R6. Projects every
 * completed match into player_match_history (refreshing the R8 stats it drives)
 * and into venue_visits. The worker does both for each new `match.completed`;
 * this is for matches that finished before the projections existed.
 * Idempotent, so safe to re-run.
 */
import { db, disconnectDb } from '../src/platform/db.js';
import { profile } from '../src/modules/profile/index.js';
import { venues } from '../src/modules/venues/index.js';

const done = await db.match.findMany({
  where: { completedAt: { not: null } },
  select: { id: true },
  orderBy: { completedAt: 'asc' },
});
for (const m of done) {
  await profile.projectMatch(m.id);
  await venues.recordMatchVisit(m.id);
}
console.log(
  `Projected ${done.length} completed match(es): ${await db.playerMatchHistory.count()} history row(s), ` +
    `${await db.venueVisit.count()} venue visit(s).`,
);
await disconnectDb();
process.exit(0);
