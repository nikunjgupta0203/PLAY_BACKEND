/**
 * `pnpm seed:fixtures <step> [--apply]` — the team's seed fixtures for 29–31 Oct
 * 2026 (scripts/data/seed-fixtures-oct29-31-2026.json, from the sheet
 * PL4Y_seed_fixtures_29-31_Oct.xlsx), played by real players who agreed to it.
 *
 *   check      step 1: match every player to one account, confirm sports, scores, venues. Writes nothing.
 *   open       step 2: OG-01..04, open casual games with only the host joined.
 *   upcoming   step 3: FX-10..13, both sides joined.
 *   completed  step 4: FX-01..09, finished, with a confirmed result each. Stats, badges and
 *              the provisional rating move like any confirmed result; nothing is reset.
 *   rollback   removes every seeded game and result and puts stats, ratings and badges back.
 *
 * Without --apply a step only reports what it would do.
 *
 * The seed tag is the id: every seeded game and result has an id starting
 * SEED_PREFIX, made from its fixture id. That keys re-runs (a fixture already
 * there is skipped) and finds every seeded row, including the match history and
 * rating rows that carry a result's id, in one query.
 *
 * Silent by construction: rows are written directly, not through the services
 * that notify; badges are awarded quietly; the provisional rating sends nothing
 * (notify skips provisional moves); the one-hour reminder is marked as sent. No
 * chats, invites or message requests are made.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db, disconnectDb } from '../src/platform/db.js';
import { effectiveRuleOf, formatOf, matchRuleOf } from '../src/modules/games/index.js';
import { casualWinnerOf, checkFormat } from '../src/modules/scoring/index.js';
import { profile } from '../src/modules/profile/index.js';
import { rating } from '../src/modules/rating/index.js';
import { badgesFromHistory } from '../src/modules/profile/service/badges.js';

const DATA_FILE = new URL('./data/seed-fixtures-oct29-31-2026.json', import.meta.url);
export const SEED_PREFIX = '5eed1031-2026-4000-8000-';
const MATCH_BADGES = ['first_win', 'five_wins', 'ten_wins', 'streak_3', 'streak_5', 'first_tournament'];

type Kind = 'completed' | 'upcoming' | 'open';
interface Fixture {
  id: string;
  kind: Kind;
  sport: string;
  date: string;
  start: string;
  minutes: number;
  city: string;
  host: string;
  sideA?: string[];
  sideB?: string[];
  maxPlayers: number;
  score?: string;
  scoreIsTally?: boolean;
  format?: { pointsToWin: number | null; games: number; bestOf: boolean };
  winner?: 'a' | 'b';
}
interface PlayerRow {
  name: string;
  city: string;
  email?: string;
}

const data = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as { players: PlayerRow[]; fixtures: Fixture[] };
const step = process.argv[2] as 'check' | Kind | 'rollback' | undefined;
const apply = process.argv.includes('--apply');
const STEPS = ['check', 'open', 'upcoming', 'completed', 'rollback'];
if (!step || !STEPS.includes(step)) throw new Error(`usage: pnpm seed:fixtures <${STEPS.join('|')}> [--apply]`);

// --- ids (the seed tag) ------------------------------------------------------

/** FX-07 → game 5eed…-100000000007, result 5eed…-200000000007; OG-02 → 5eed…-100000000402. */
function seedId(fixtureId: string, what: 'game' | 'result'): string {
  const m = /^(FX|OG)-(\d{2})$/.exec(fixtureId);
  if (!m) throw new Error(`bad fixture id ${fixtureId}`);
  return `${SEED_PREFIX}${what === 'game' ? '1' : '2'}00000000${m[1] === 'FX' ? '0' : '4'}${m[2]}`;
}
const LIKE_SEED = `${SEED_PREFIX}%`;

// --- small helpers -----------------------------------------------------------

const ALIASES: Record<string, string> = { gurgaon: 'gurugram', 'delhi ncr': 'delhi', 'new delhi': 'delhi' };
const cityKey = (c: string | null | undefined): string => {
  const k = (c ?? '').trim().toLowerCase();
  return ALIASES[k] ?? k;
};
/** "2026-10-29" + "18:00" in IST → the instant. */
const ist = (date: string, time: string): Date => new Date(`${date}T${time}:00+05:30`);
const addMin = (d: Date, m: number): Date => new Date(d.getTime() + m * 60_000);
const fmt = (d: Date): string =>
  d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const CENTRES: Record<string, { lat: number; lng: number }> = {
  delhi: { lat: 28.6139, lng: 77.209 },
  gurugram: { lat: 28.4595, lng: 77.0266 },
  faridabad: { lat: 28.4089, lng: 77.3178 },
};

function units(f: Fixture): { a: number; b: number }[] {
  if (!f.score) return [];
  const pairs = f.score.split(',').map((s) => {
    const [a, b] = s.trim().split('-').map((n) => Number(n.trim()));
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`${f.id}: cannot read score "${f.score}"`);
    return { a: a!, b: b! };
  });
  if (!f.scoreIsTally) return pairs;
  // "3-1" racks/frames won → one unit per win, as the app's Add result sends a race (unitsFromTally).
  const { a, b } = pairs[0]!;
  return [...Array.from({ length: a }, () => ({ a: 1, b: 0 })), ...Array.from({ length: b }, () => ({ a: 0, b: 1 }))];
}

// --- step 1: resolve and check ----------------------------------------------

interface Resolved {
  userId: string;
  profileId: string;
  displayName: string;
  city: string | null;
}

const problems: string[] = [];
const notes: string[] = [];

async function resolvePlayers(): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  for (const p of data.players) {
    const rows = await db.user.findMany({
      where: p.email
        ? { email: p.email }
        : { displayName: { equals: p.name, mode: 'insensitive' }, isGuest: false },
      select: { id: true, displayName: true, status: true, deactivatedAt: true, profile: { select: { id: true, city: true } } },
    });
    const live = rows.filter((r) => r.status === 'active' && !r.deactivatedAt && r.profile);
    if (p.email) {
      const u = live[0];
      if (!u) problems.push(`${p.name}: no active account for ${p.email}`);
      else out.set(p.name, { userId: u.id, profileId: u.profile!.id, displayName: u.displayName, city: u.profile!.city });
      continue;
    }
    const exact = live.filter((r) => r.displayName === p.name);
    const inCity = exact.filter((r) => cityKey(r.profile!.city) === cityKey(p.city));
    if (inCity.length === 1) {
      const u = inCity[0]!;
      out.set(p.name, { userId: u.id, profileId: u.profile!.id, displayName: u.displayName, city: u.profile!.city });
    } else if (inCity.length > 1) {
      problems.push(`${p.name} (${p.city}): AMBIGUOUS — ${inCity.length} accounts: ${inCity.map((u) => u.id).join(', ')}`);
    } else {
      const near = live.map((u) => `"${u.displayName}" in ${u.profile!.city ?? 'no city'} (${u.id})`);
      problems.push(`${p.name} (${p.city}): NOT FOUND${near.length ? ` — similar: ${near.join('; ')}` : ''}`);
    }
  }
  return out;
}

const sportIds = new Map((await db.sport.findMany({ select: { id: true, slug: true, name: true } })).map((s) => [s.slug, s]));

async function checkFixture(f: Fixture, players: Map<string, Resolved>): Promise<void> {
  const sport = sportIds.get(f.sport);
  if (!sport) {
    problems.push(`${f.id}: sport "${f.sport}" is not in the app`);
    return;
  }
  const names = [f.host, ...(f.sideA ?? []), ...(f.sideB ?? [])];
  for (const name of new Set(names)) {
    const p = players.get(name);
    if (!p) continue; // already reported
    const has = await db.playerSport.findUnique({ where: { playerId_sportId: { playerId: p.profileId, sportId: sport.id } } });
    if (!has) problems.push(`${f.id}: ${name} does not have ${sport.name} on their profile`);
  }
  if (f.kind === 'completed') {
    const rule = await matchRuleOf(sport.id);
    if (!rule) {
      problems.push(`${f.id}: ${sport.name} has no match results in the app`);
      return;
    }
    try {
      if (f.format) checkFormat(rule, f.format);
      const played = await formatOf(sport.id, f.format ?? null);
      const winner = casualWinnerOf(units(f), (await effectiveRuleOf(sport.id, played)) ?? rule, played);
      if (winner !== f.winner) problems.push(`${f.id}: score ${f.score} gives winner ${winner ?? 'draw'}, sheet says ${f.winner}`);
    } catch (err) {
      problems.push(`${f.id}: score ${f.score} is not valid for ${sport.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Any live venue in the city, one with a court for the sport first; picked by the fixture id so a re-run picks the same. */
async function venueFor(f: Fixture): Promise<{ id: string; name: string; city: string } | null> {
  const sport = sportIds.get(f.sport)!;
  const city = cityKey(f.city);
  const withSport = await db.$queryRaw<{ id: string; name: string; city: string }[]>(Prisma.sql`
    SELECT v.id, v.name, v.city FROM venues v
     WHERE v.deleted_at IS NULL AND lower(v.city) = ${city}
       AND EXISTS (SELECT 1 FROM venue_courts c WHERE c.venue_id = v.id AND c.active AND ${sport.id}::uuid = ANY(c.sport_ids))
     ORDER BY v.id`);
  const pool =
    withSport.length > 0
      ? withSport
      : await db.$queryRaw<{ id: string; name: string; city: string }[]>(Prisma.sql`
          SELECT v.id, v.name, v.city FROM venues v WHERE v.deleted_at IS NULL AND lower(v.city) = ${city} ORDER BY v.id`);
  if (pool.length === 0) return null;
  const n = createHash('sha1').update(f.id).digest().readUInt32BE(0);
  return pool[n % pool.length]!;
}

// --- steps 2–4: insert -------------------------------------------------------

async function insertGame(f: Fixture, players: Map<string, Resolved>, now: Date): Promise<'inserted' | 'exists'> {
  const id = seedId(f.id, 'game');
  if (await db.game.findUnique({ where: { id }, select: { id: true } })) return 'exists';
  const sport = sportIds.get(f.sport)!;
  const startsAt = ist(f.date, f.start);
  const endsAt = addMin(startsAt, f.minutes);
  const venue = await venueFor(f);
  const centre = CENTRES[cityKey(f.city)];
  if (!venue && !centre) throw new Error(`${f.id}: no venue and no known centre for ${f.city}`);
  const host = players.get(f.host)!;
  const joined = f.kind === 'open' ? [host.userId] : [...(f.sideA ?? []), ...(f.sideB ?? [])].map((n) => players.get(n)!.userId);
  // Finished and booked games were made a day ahead; open games are made now.
  const createdAt = f.kind === 'open' ? now : addMin(startsAt, -26 * 60);
  const status = f.kind === 'completed' ? 'completed' : f.kind === 'upcoming' ? 'full' : 'open';
  // The one-hour reminder counts as sent, so the sweep tells no one about a game they did not make.
  const reminderSentAt = f.kind === 'completed' ? addMin(startsAt, -60) : now;
  const city = venue?.city ?? (cityKey(f.city) === 'delhi' ? 'Delhi' : f.city);
  const geo = venue ? Prisma.sql`NULL` : Prisma.sql`ST_SetSRID(ST_MakePoint(${centre!.lng}::double precision, ${centre!.lat}::double precision), 4326)::geography`;

  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO games (id, host_user_id, sport_id, venue_id, geo, place_name, city, starts_at, ends_at,
                         max_players, min_players, skill_band, notes, status, completed_at, reminder_sent_at,
                         match_format, created_at, updated_at)
      VALUES (${id}::uuid, ${host.userId}::uuid, ${sport.id}::uuid, ${venue?.id ?? null}::uuid, ${geo},
              ${venue ? null : city}, ${city}, ${startsAt}, ${endsAt}, ${f.maxPlayers}::smallint, NULL, NULL, NULL,
              ${status}, ${f.kind === 'completed' ? endsAt : null}, ${reminderSentAt},
              ${f.format ? JSON.stringify(f.format) : null}::jsonb, ${createdAt}, ${now})
      ON CONFLICT (id) DO NOTHING`;
    await tx.gameParticipant.createMany({
      data: joined.map((userId, i) => ({ gameId: id, userId, joinedAt: addMin(createdAt, i * 7), updatedAt: addMin(createdAt, i * 7) })),
      skipDuplicates: true,
    });
    if (f.kind === 'completed') {
      const sideA = f.sideA!.map((n) => players.get(n)!.userId);
      const sideB = f.sideB!.map((n) => players.get(n)!.userId);
      const entered = addMin(endsAt, 10);
      await tx.gameResult.createMany({
        data: [
          {
            id: seedId(f.id, 'result'),
            gameId: id,
            sportId: sport.id,
            sideA,
            sideB,
            games: units(f) as Prisma.InputJsonValue,
            winner: f.winner!,
            method: null,
            status: 'confirmed',
            enteredBy: host.userId,
            autoConfirmAt: addMin(entered, 60),
            confirmedAt: addMin(entered, 20),
            confirmedVia: 'opponent',
            playedAt: startsAt,
            createdAt: entered,
            matchFormat: f.format ? (f.format as Prisma.InputJsonValue) : Prisma.DbNull,
          },
        ],
        skipDuplicates: true,
      });
    }
  });
  return 'inserted';
}

/** What a confirmed result sets off, run here so it is quiet: history, stats, badges, provisional rating. */
async function rankCompleted(fixtures: Fixture[]): Promise<void> {
  const ordered = [...fixtures].sort((x, y) => ist(x.date, x.start).getTime() - ist(y.date, y.start).getTime());
  for (const f of ordered) {
    const resultId = seedId(f.id, 'result');
    await profile.projectMatch(resultId, { quiet: true });
    await rating.applyMatch(resultId);
  }
}

// --- rollback ----------------------------------------------------------------

async function rollback(): Promise<void> {
  const games = await db.$queryRaw<{ id: string; updated_at: Date }[]>`
    SELECT id, updated_at FROM games WHERE id::text LIKE ${LIKE_SEED}`;
  const gameIds = games.map((g) => g.id);
  // A seeded result, or one a real player entered later on a seeded game.
  const results = await db.$queryRaw<{ id: string; sportId: string }[]>`
    SELECT id::text AS id, sport_id::text AS "sportId" FROM game_results
     WHERE id::text LIKE ${LIKE_SEED} OR game_id::text LIKE ${LIKE_SEED}`;
  const resultIds = results.map((r) => r.id);
  const history = await db.playerMatchHistory.findMany({ where: { matchId: { in: resultIds } }, select: { playerId: true } });
  const players = [...new Set(history.map((h) => h.playerId))];
  console.log(`Seeded: ${gameIds.length} game(s), ${resultIds.length} result(s), ${players.length} player(s) with seeded history.`);
  if (!apply) {
    console.log('Re-run with --apply to remove them.');
    return;
  }

  const rated = await db.ratingEvent.findMany({ where: { matchId: { in: resultIds } }, select: { playerId: true, sportId: true } });
  await db.gameResult.deleteMany({ where: { id: { in: resultIds } } });
  for (const id of resultIds) {
    // The result is gone, so these take its history rows and its rating preview back
    // and refresh each player's stats from what is left.
    await profile.projectMatch(id, { quiet: true });
    await rating.reapplyMatch(id);
  }
  // reapplyMatch puts a player on their settled number, which is the starting 1500 for
  // someone never settled. Put back what the profile showed: the latest rating left, or none.
  for (const key of new Set(rated.map((r) => `${r.playerId}|${r.sportId}`))) {
    const [playerId, sportId] = key.split('|') as [string, string];
    const latest = await db.ratingEvent.findFirst({ where: { playerId, sportId }, orderBy: { createdAt: 'desc' } });
    if (latest && !latest.isProvisional) continue;
    await db.playerSport.updateMany({
      where: { playerId, sportId },
      data: latest
        ? { rating: latest.ratingAfter, ratingDev: latest.rdAfter, volatility: latest.volatilityAfter }
        : { rating: null, ratingDev: null, volatility: null, isProvisional: true },
    });
  }
  // Badges the seeded wins earned and the remaining history no longer does.
  let badges = 0;
  for (const playerId of players) {
    const rows = await db.playerMatchHistory.findMany({
      where: { playerId },
      orderBy: [{ completedAt: 'asc' }, { matchId: 'asc' }],
      select: { won: true, sportId: true, eventId: true },
    });
    const keep = new Set(badgesFromHistory(rows).map((b) => b.key));
    const { count } = await db.achievement.deleteMany({
      where: { playerId, eventId: null, key: { in: MATCH_BADGES.filter((k) => !keep.has(k)) } },
    });
    badges += count;
  }
  const { count: notices } = await db.notification.deleteMany({ where: { targetKind: 'game', targetId: { in: gameIds } } });
  const { count: removed } = await db.game.deleteMany({ where: { id: { in: gameIds } } });
  console.log(`Removed ${removed} game(s), ${resultIds.length} result(s), ${badges} badge(s), ${notices} notification(s).`);

  // If the weekly rating job settled a week holding seeded results, those settled rows need a replay.
  const seededAt = games.reduce<Date | null>((m, g) => (!m || g.updated_at < m ? g.updated_at : m), null);
  if (seededAt) {
    const settled = await db.ratingPeriod.findMany({
      where: { sportId: { in: [...new Set(results.map((r) => r.sportId))] }, ranAt: { gt: seededAt } },
      select: { sportId: true, startsAt: true },
    });
    for (const p of settled) {
      console.log(`  NOTE: sport ${p.sportId} week of ${fmt(p.startsAt)} was settled after seeding — run a rating replay for it.`);
    }
  }
}

// --- main --------------------------------------------------------------------

if (step === 'rollback') {
  await rollback();
  await disconnectDb();
  process.exit(0);
}

const players = await resolvePlayers();
const wanted = step === 'check' ? data.fixtures : data.fixtures.filter((f) => f.kind === step);
for (const f of wanted) await checkFixture(f, players);

if (step === 'check') {
  console.log('\nPlayers');
  for (const p of data.players) {
    const r = players.get(p.name);
    console.log(`  ${r ? 'matched  ' : 'UNMATCHED'} ${p.name.padEnd(16)} ${p.city.padEnd(10)} ${r ? `${r.userId}  (profile city: ${r.city ?? '—'})` : ''}`);
  }
  console.log('\nSports');
  for (const slug of [...new Set(data.fixtures.map((f) => f.sport))]) {
    const s = sportIds.get(slug);
    const results = s ? (await matchRuleOf(s.id)) !== null : false;
    console.log(`  ${s ? 'supported' : 'MISSING  '} ${slug}${s && !results ? ' (games only, no match results)' : ''}`);
  }
  console.log('\nVenues ("Dev to assign")');
  for (const f of data.fixtures) {
    const v = await venueFor(f);
    console.log(`  ${f.id}  ${f.city.padEnd(9)} ${v ? `${v.name} (${v.id})` : 'none live — city only'}`);
  }
  const seeded = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM games WHERE id::text LIKE ${LIKE_SEED}`;
  console.log(`\nAlready seeded: ${seeded[0]!.n} game(s).`);
  // The week the finished fixtures fall in: settled already, or still to come on Monday.
  const weekly = await db.ratingPeriod.findMany({
    where: { startsAt: { lte: ist('2026-10-29', '00:00') }, endsAt: { gt: ist('2026-10-30', '23:59') } },
    select: { sportId: true, ranAt: true },
  });
  const ran = weekly.filter((w) => w.ranAt).length;
  notes.push(`Rating week 26 Oct–2 Nov: ${weekly.length} sport period(s) exist, ${ran} already settled.`);
}

for (const n of notes) console.log(`\n${n}`);
if (problems.length > 0) {
  console.log(`\nSTOP — ${problems.length} problem(s), nothing written:`);
  for (const p of problems) console.log(`  - ${p}`);
  await disconnectDb();
  process.exit(1);
}
if (step === 'check') {
  console.log('\nAll checks passed. Nothing written.');
  await disconnectDb();
  process.exit(0);
}

const now = new Date();
let inserted = 0;
let existed = 0;
for (const f of wanted) {
  const startsAt = ist(f.date, f.start);
  if (f.kind !== 'completed' && addMin(startsAt, f.minutes) <= now) {
    console.log(`  ${f.id}: WARNING — ends ${fmt(addMin(startsAt, f.minutes))}, already past; it will show as finished.`);
  }
  if (!apply) {
    const v = await venueFor(f);
    const exists = await db.game.findUnique({ where: { id: seedId(f.id, 'game') }, select: { id: true } });
    console.log(`  ${f.id}: ${exists ? 'already there' : 'would insert'} — ${f.sport}, ${fmt(startsAt)} IST, ${v?.name ?? f.city}`);
    continue;
  }
  const r = await insertGame(f, players, now);
  if (r === 'inserted') inserted += 1;
  else existed += 1;
  console.log(`  ${f.id}: ${r === 'inserted' ? 'inserted' : 'already there, skipped'} (${seedId(f.id, 'game')})`);
}
if (apply && step === 'completed') {
  await rankCompleted(wanted);
  console.log('  Match history, stats, badges (quiet) and provisional ratings updated.');
}
console.log(
  apply
    ? `\n${step}: ${inserted} inserted, ${existed} already there.`
    : `\n${step}: dry run. Re-run with --apply to write.`,
);
console.log(`Rollback: pnpm seed:fixtures rollback --apply`);
await disconnectDb();
process.exit(0);
