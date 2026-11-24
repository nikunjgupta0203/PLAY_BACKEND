/**
 * `pnpm exec tsx --env-file-if-exists=.env scripts/cup-smoke.ts [--apply | cleanup]`
 *
 * Smoke test for the last release (Campus Cup + 067 crowd scoring) against the
 * database the env points at — production included. It runs the real
 * competitions service end to end:
 *
 *   join with a code (wrong code refused, one group per season), crowd % before
 *   any pick (50/50, a third each), the % locked at the pick (own pick left out,
 *   re-tap keeps it, a switch re-prices), exact score football only (25 / 8),
 *   settle + void, players and groups boards.
 *
 * Everything it makes is temporary and removed at the end, even when a check
 * fails: one competition (slug `cup-smoke-…`, LIVE but NOT on Home, so no real
 * player sees it) and three users (`cup-smoke-…@example.invalid`). Nothing is
 * notified: the service is built without a notifier.
 *
 *   (no flag)  says what it would do. Writes nothing.
 *   --apply    runs the test, prints PASS/FAIL per check, cleans up.
 *   cleanup    removes anything a crashed run left behind.
 *
 * Exit code 0 = every check passed.
 */
import { db, disconnectDb } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createCompetitionsService } from '../src/modules/competitions/service/index.js';

const SLUG_PREFIX = 'cup-smoke-';
const EMAIL_PREFIX = 'cup-smoke-';
const EMAIL_DOMAIN = '@example.invalid';
const H = 3_600_000;

const cups = createCompetitionsService({
  db,
  match: async () => null,
  upcomingMatches: async () => [],
});

let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`}`);
}
async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    throw e;
  }
  return 'NO_ERROR';
}
const pct = (n: number | undefined) => (n === undefined ? null : Math.round(n * 1000) / 10);

async function cleanup(): Promise<void> {
  const comps = await db.competition.findMany({ where: { slug: { startsWith: SLUG_PREFIX } }, select: { id: true } });
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: EMAIL_DOMAIN } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  // The competition first: it cascades to groups, codes, members, questions, picks and points.
  if (comps.length) await db.competition.deleteMany({ where: { id: { in: comps.map((c) => c.id) } } });
  if (userIds.length) {
    await db.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.playerProfile.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  console.log(`cleanup: removed ${comps.length} test competition(s), ${userIds.length} test user(s)`);
}

async function tempUser(tag: string, label: string): Promise<string> {
  const id = newId();
  await db.user.create({ data: { id, email: `${EMAIL_PREFIX}${tag}-${label.toLowerCase()}${EMAIL_DOMAIN}`, displayName: `Cup Smoke ${label}` } });
  await db.playerProfile.create({ data: { id: newId(), userId: id } });
  return id;
}

async function run(): Promise<void> {
  const tag = Date.now().toString(36);
  const now = new Date();
  const [football, cricket] = await Promise.all([
    db.sport.findUnique({ where: { slug: 'football' }, select: { id: true } }),
    db.sport.findUnique({ where: { slug: 'cricket' }, select: { id: true } }),
  ]);
  if (!football || !cricket) throw new Error('football / cricket sports not found in this database');

  // --- setup -------------------------------------------------------------------
  const c = await cups.saveCompetition(null, null, {
    slug: `${SLUG_PREFIX}${tag}`,
    segment: 'campus',
    name: 'Cup Smoke Test',
    seasonLabel: 'Smoke',
    startsAt: new Date(now.getTime() - H),
    endsAt: new Date(now.getTime() + 24 * H),
    status: 'live',
    onHome: false,
    teamSize: 2,
    codeRequired: true,
  });
  check('067 crowd settings saved with defaults (20 / 10 / 5% / 95%)', [c.crowdBase, c.crowdPrior, c.crowdMinPct, c.crowdMaxPct], [20, 10, 5, 95]);
  const g1 = await cups.saveGroup(c.id, null, { name: 'SMK-A' });
  const g2 = await cups.saveGroup(c.id, null, { name: 'SMK-B' });
  const code1 = `SMK-${tag.slice(-5).toUpperCase()}1`;
  const code2 = `SMK-${tag.slice(-5).toUpperCase()}2`;
  await cups.saveCode({ groupId: g1.id, code: code1 });
  await cups.saveCode({ groupId: g2.id, code: code2 });
  const [a, b, d] = [await tempUser(tag, 'A'), await tempUser(tag, 'B'), await tempUser(tag, 'C')];

  // --- joining -----------------------------------------------------------------
  check('wrong code is refused', await errorCode(() => cups.join(a, { code: 'SMK-NOPE-999' })), 'COMPETITION_CODE_INVALID');
  await cups.join(a, { code: code1 });
  await cups.join(b, { code: code1 });
  await cups.join(d, { code: code2 });
  check('one group per season (A tries the other code)', (await errorCode(() => cups.join(a, { code: code2 }))) !== 'NO_ERROR', true);

  // --- crowd scoring on a two-way question ---------------------------------------
  const q1 = await cups.createQuestion(null, {
    competitionId: c.id,
    sportId: football.id,
    eventLabel: 'Smoke FC v Test United',
    kind: 'choice',
    prompt: 'Who wins?',
    startsAt: new Date(now.getTime() + 2 * H),
    options: [{ label: 'Smoke FC' }, { label: 'Test United' }],
  });
  const [x, y] = q1.options.map((o) => o.id) as [string, string];
  const before = (await cups.crowdFor([q1.id], a)).get(q1.id);
  check('no picks yet: 50% / 50%', [pct(before?.get(x)), pct(before?.get(y))], [50, 50]);

  const pA = await cups.pick(a, q1.id, { optionId: x });
  check('A picks Smoke FC at 50% -> locked +10', [pct(pA.crowdShare ?? undefined), pA.basePoints], [50, 10]);

  const seenByB = (await cups.crowdFor([q1.id], b)).get(q1.id);
  check("B sees A's pick: 54.5% / 45.5%", [pct(seenByB?.get(x)), pct(seenByB?.get(y))], [54.5, 45.5]);
  const pB = await cups.pick(b, q1.id, { optionId: x });
  check('B picks Smoke FC at 54.5% -> locked +9', pB.basePoints, 9);

  check('A re-taps the same answer -> lock stays +10', (await cups.pick(a, q1.id, { optionId: x })).basePoints, 10);
  const pA2 = await cups.pick(a, q1.id, { optionId: y });
  check('A switches to Test United (45.5%) -> re-priced +11', pA2.basePoints, 11);

  const pC = await cups.pick(d, q1.id, { optionId: y });
  check('C picks Test United at 50% (own pick left out) -> +10', pC.basePoints, 10);

  // --- three-way question, then void ---------------------------------------------
  const q2 = await cups.createQuestion(null, {
    competitionId: c.id,
    sportId: cricket.id,
    eventLabel: 'Smoke XI v Test XI',
    kind: 'choice',
    prompt: 'Toss?',
    startsAt: new Date(now.getTime() + 2 * H),
    options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Maybe' }],
  });
  check('three answers, nobody picked -> +13', (await cups.pick(a, q2.id, { optionId: q2.options[0]!.id })).basePoints, 13);
  await cups.voidQuestion(q2.id);
  check('voided question pays nothing', (await db.competitionPoint.count({ where: { competitionId: c.id, ref: q2.id } })) , 0);

  // --- exact score ---------------------------------------------------------------
  check(
    'exact score on cricket is refused (football only)',
    await errorCode(() => cups.createQuestion(null, { competitionId: c.id, sportId: cricket.id, eventLabel: 'Smoke XI v Test XI', kind: 'exact_score', startsAt: new Date(now.getTime() + 2 * H) })),
    'COMPETITION_INVALID',
  );
  const q3 = await cups.createQuestion(null, { competitionId: c.id, sportId: football.id, eventLabel: 'Smoke FC v Test United', kind: 'exact_score', startsAt: new Date(now.getTime() + 2 * H) });
  await cups.pick(a, q3.id, { home: 2, away: 1 });
  await cups.pick(b, q3.id, { home: 1, away: 0 });
  await cups.pick(d, q3.id, { home: 0, away: 0 });

  // --- settle + boards -----------------------------------------------------------
  await cups.settle(null, q1.id, { optionId: y });
  await cups.settle(null, q3.id, { home: 2, away: 1 });
  check('settling twice is refused', await errorCode(() => cups.settle(null, q1.id, { optionId: x })), 'COMPETITION_QUESTION_ALREADY_SETTLED');

  const players = await cups.board(c.id, a, 'players');
  const score = (uid: string) => players.rows.find((r) => r.key === uid)?.score ?? null;
  check('A = 11 (right at locked 11) + 25 (exact) = 36', score(a), 36);
  check('B = 0 (wrong) + 8 (right result) = 8', score(b), 8);
  check('C = 10 (right at locked 10) + 0 = 10', score(d), 10);
  check('players board order A, C, B', players.rows.map((r) => r.key), [a, d, b]);

  const groups = await cups.board(c.id, a, 'groups');
  const gscore = (gid: string) => groups.rows.find((r) => r.key === gid)?.score ?? null;
  check('group SMK-A = (36 + 8) / 2 = 22', gscore(g1.id), 22);
  check('group SMK-B = (10 + 0) / 2 = 5', gscore(g2.id), 5);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === 'cleanup') return cleanup();
  if (arg !== '--apply') {
    console.log('Dry run. With --apply this makes one temporary LIVE competition (not on Home) and 3 temporary users,');
    console.log('runs the Cup + crowd scoring checks through the real service, then deletes all of it.');
    console.log('Run:  ... scripts/cup-smoke.ts --apply');
    return;
  }
  try {
    await run();
  } catch (e) {
    failed++;
    console.error('CRASH', e);
  } finally {
    await cleanup();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
}

main().finally(() => void disconnectDb());
