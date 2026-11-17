/**
 * `pnpm seed:floodlight` — local sample data for the Floodlight redesign:
 * pro teams and matches (one live, with an over, stats, moments and a
 * scorecard), open prediction questions, and published content (an
 * original, stories, a short and an explainer), so Home, Matches, the Match
 * Centre and Predict have something to show.
 *
 * Local-only (refuses NODE_ENV=production) and safe to re-run: teams match
 * by name, matches by league + teams, content by title.
 */
import { isProd } from '../src/platform/config.js';
import { db, disconnectDb } from '../src/platform/db.js';
import { createContentService } from '../src/modules/content/service/index.js';
import { createPredictionsService } from '../src/modules/predictions/service/index.js';
import { createProService } from '../src/modules/pro/service/index.js';

if (isProd) {
  console.error('seed-floodlight refuses to run with NODE_ENV=production.');
  process.exit(1);
}

const HOUR = 3_600_000;
const at = (ms: number) => new Date(Date.now() + ms);
const allow = { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) };

const pro = createProService({ db, limiter: allow });
const predictions = createPredictionsService({
  db,
  matchSport: async (id) => (await pro.match(id))?.sportId ?? null,
  friendsOf: async () => [],
  communityMembers: async () => [],
  cityPeers: async () => ({ city: null, userIds: [] }),
});
const content = createContentService({ db });

async function sportId(slug: string): Promise<string | null> {
  return (await db.sport.findUnique({ where: { slug }, select: { id: true } }))?.id ?? null;
}

async function team(sport: string, name: string, shortCode: string, tint: string): Promise<string> {
  const found = await db.proTeam.findFirst({ where: { sportId: sport, name } });
  return found ? found.id : (await pro.saveTeam(null, { sportId: sport, name, shortCode, tint })).id;
}

async function match(input: Parameters<typeof pro.createMatch>[1]): Promise<string> {
  const found = await db.proMatch.findFirst({ where: { league: input.league, homeTeamId: input.homeTeamId, awayTeamId: input.awayTeamId } });
  return found ? found.id : (await pro.createMatch(null, input)).id;
}

async function main(): Promise<void> {
  const football = await sportId('football');
  const badminton = await sportId('badminton');
  if (!football) throw new Error('Seed the sports first (pnpm seed).');

  const mci = await team(football, 'Mumbai City', 'MCI', '#1E3A6B');
  const bfc = await team(football, 'Bengaluru FC', 'BFC', '#1F4FA8');
  const kbfc = await team(football, 'Kerala Blasters', 'KBFC', '#C9A227');
  const mbsg = await team(football, 'Mohun Bagan', 'MBSG', '#7A1F2B');

  const live = await match({ sportId: football, league: 'ISL', stage: 'Matchweek 9', homeTeamId: mci, awayTeamId: bfc, venueName: 'Mumbai Football Arena', city: 'Mumbai', startsAt: at(-HOUR), featured: true });
  await pro.updateMatch(live, {
    status: 'live',
    statusDetail: "67'",
    homeScore: '2',
    awayScore: '1',
    note: 'Mumbai lead after Chhangte’s second',
    stats: [
      { label: 'Possession', value: '54%' },
      { label: 'Shots', value: '11 – 7' },
      { label: 'Corners', value: '5 – 3' },
    ],
    scorecard: [{ team: 'MCI', title: 'Attack', columns: ['G', 'Sh', 'On'], rows: [{ name: 'L Chhangte', detail: 'Forward', cells: ['2', '4', '3'] }], footer: null }],
  });
  if ((await pro.moments(live)).length === 0) {
    await pro.addMoment(live, { atLabel: "12'", kind: 'goal', title: 'GOAL — Chhangte finishes low', detail: 'MCI 1–0' });
    await pro.addMoment(live, { atLabel: "38'", kind: 'goal', title: 'GOAL — Chhetri heads in', detail: '1–1' });
    await pro.addMoment(live, { atLabel: "61'", kind: 'goal', title: 'GOAL — Chhangte again', detail: 'MCI 2–1' });
  }
  const next = await match({ sportId: football, league: 'ISL', stage: 'Matchweek 9', homeTeamId: kbfc, awayTeamId: mbsg, venueName: 'JLN Stadium', city: 'Kochi', startsAt: at(26 * HOUR), featured: false });

  if (badminton) {
    const a = await team(badminton, 'L Sen', 'SEN', '#0E5A44');
    const b = await team(badminton, 'V Axelsen', 'AXE', '#8A2B2B');
    await match({ sportId: badminton, league: 'BWF World Tour', stage: 'Quarter-final', homeTeamId: a, awayTeamId: b, venueName: 'KD Jadhav Hall', city: 'New Delhi', startsAt: at(4 * HOUR), featured: false });
  }

  if ((await db.predictionQuestion.count({ where: { matchId: { in: [live, next] } } })) === 0) {
    await predictions.createQuestion(null, { matchId: live, kind: 'choice', prompt: 'Next goal?', live: true, points: 30, locksAt: at(20 * 60_000), options: [{ label: 'Mumbai City' }, { label: 'No more goals' }, { label: 'Bengaluru FC' }] });
    await predictions.createQuestion(null, { matchId: next, kind: 'choice', prompt: 'Who wins in Kochi?', locksAt: at(26 * HOUR), options: [{ label: 'Kerala Blasters' }, { label: 'Draw' }, { label: 'Mohun Bagan' }] });
    await predictions.createQuestion(null, { matchId: next, kind: 'exact_score', prompt: 'Call the final score', points: 30, locksAt: at(26 * HOUR) });
  }

  const items: Parameters<typeof content.save>[2][] = [
    { kind: 'original', sportId: football, title: 'The Kochi roar: inside India’s loudest stadium', kicker: 'Big read', summary: 'Forty thousand fans, one yellow wall, and the club that built it.', body: 'Kochi on match night…\n\nThe Manjappada started as a WhatsApp group.', featured: true },
    { kind: 'story', sportId: football, title: 'Five things we learned from Matchweek 8', kicker: 'ISL', summary: 'Mumbai’s press, Bengaluru’s bench and a breakout winger.', body: 'Mumbai’s press is the league’s best.\n\nBengaluru’s bench changed the game again.' },
    { kind: 'story', sportId: badminton, title: 'Lakshya Sen’s quiet comeback', kicker: 'Badminton', summary: 'A new coach, a new serve, the same fight.', body: 'Six months ago…' },
    { kind: 'short', sportId: football, title: 'Top 5 goals of the week', videoUrl: 'https://videos.example.com/top-5-goals.mp4', durationSeconds: 58 },
    { kind: 'explainer', sportId: football, title: 'What is the ISL Shield, and how is it different from the Cup?', summary: 'The league table winner gets the Shield; the playoffs decide the Cup.' },
  ];
  for (const input of items) {
    const found = await db.contentItem.findFirst({ where: { title: input.title } });
    const saved = found ?? (await content.save(null, null, input));
    if (saved.status !== 'published') await content.setStatus(saved.id, 'published');
  }

  console.log('Floodlight sample data is in: ISL live match, upcoming fixtures, questions and published content.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
