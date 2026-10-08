/**
 * `pnpm backfill:badges` — profile R11. Awards the match badges every player
 * has already earned, for history played before badges were awarded. The
 * worker does this after each new match. Quiet: no push for old badges.
 * Idempotent, so safe to re-run.
 */
import { db, disconnectDb } from '../src/platform/db.js';
import { profile } from '../src/modules/profile/index.js';

const players = await db.playerMatchHistory.findMany({ distinct: ['playerId'], select: { playerId: true } });
let awarded = 0;
for (const p of players) awarded += await profile.awardMatchBadges(p.playerId, { quiet: true });
console.log(`Checked ${players.length} player(s); awarded ${awarded} badge(s).`);
await disconnectDb();
process.exit(0);
