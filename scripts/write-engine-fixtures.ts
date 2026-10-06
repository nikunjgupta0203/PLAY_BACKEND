/**
 * Writes the engine's golden fixtures (scoring R4 parity with the app's copy).
 * Run after any engine change: `npx tsx scripts/write-engine-fixtures.ts`.
 */
import { writeFileSync } from 'node:fs';
import { applyEvent, drawable, initialState, type ScoreEvent } from '../src/modules/scoring/engine.js';
import { LAUNCH_SPORTS } from '../src/modules/sport/seed.js';

const p = (side: 'a' | 'b', n = 1): ScoreEvent[] => Array.from({ length: n }, () => ({ type: 'point', side }));
const end: ScoreEvent = { type: 'period_end' };
/** `league`: a league or group match, where a level score is a draw (drawable). */
const cases: { name: string; sport: string; events: ScoreEvent[]; league?: boolean }[] = [
  { name: 'pickleball deciding game to 15', sport: 'pickleball', events: [...p('a', 11), ...p('b', 11), ...p('a', 15)] },
  { name: 'badminton cap at 30', sport: 'badminton', events: [...Array.from({ length: 29 }, () => [...p('a'), ...p('b')]).flat(), ...p('b')] },
  { name: 'tennis deuce and a set tiebreak', sport: 'tennis', events: [...Array.from({ length: 6 }, () => [...p('a', 4), ...p('b', 4)]).flat(), ...p('a', 7)] },
  { name: 'padel golden point', sport: 'padel', events: ['a', 'b', 'a', 'b', 'a', 'b', 'b'].flatMap((s) => p(s as 'a' | 'b')) },
  { name: 'volleyball five sets', sport: 'volleyball', events: [...p('a', 25), ...p('b', 25), ...p('a', 25), ...p('b', 25), ...p('a', 15)] },
  { name: 'basketball overtime', sport: 'basketball', events: [end, end, end, end, { type: 'score', side: 'b', action: 'three' }, end] },
  { name: 'football extra time then penalties', sport: 'football', events: [end, end, end, end, ...['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'].map((s, i) => ({ type: 'shootout_kick' as const, side: s as 'a' | 'b', scored: i % 4 !== 3 }))] },
  // B wins the toss: B 3 of 4, A 0 of 3 — decided on B's fourth kick.
  { name: 'football shootout with B kicking first', sport: 'football', events: [end, end, end, end, ...(['b', 'a', 'b', 'a', 'b', 'a', 'b'] as const).map((side, i) => ({ type: 'shootout_kick' as const, side, scored: side === 'b' && i !== 4 }))] },
  { name: 'kabaddi level goes to a shootout', sport: 'kabaddi', events: [{ type: 'score', side: 'a', action: 'raid_2' }, { type: 'score', side: 'b', action: 'all_out' }, end, end, { type: 'shootout_kick', side: 'a', scored: true }, { type: 'shootout_kick', side: 'b', scored: false }, { type: 'shootout_kick', side: 'a', scored: true }, { type: 'shootout_kick', side: 'b', scored: false }, { type: 'shootout_kick', side: 'a', scored: true }, { type: 'shootout_kick', side: 'b', scored: false }] },
  // T20: all out for 4 (a wide, a bye, a single, nine bowled and a run out off the free hit after a no-ball); the chase wins with a six.
  { name: 'cricket chase won by wickets', sport: 'cricket', events: [
    { type: 'ball', runs: 0, extra: 'wide', wicket: null },
    { type: 'ball', runs: 1, extra: 'bye', wicket: null },
    { type: 'ball', runs: 1, extra: null, wicket: null },
    ...Array.from({ length: 9 }, () => ({ type: 'ball' as const, runs: 0, extra: null, wicket: 'bowled' as const })),
    { type: 'ball', runs: 0, extra: 'no_ball', wicket: null },
    { type: 'ball', runs: 0, extra: null, wicket: 'run_out' },
    { type: 'ball', runs: 6, extra: null, wicket: null },
  ] },
  { name: 'snooker frame closed on points', sport: 'snooker', events: [
    { type: 'score', side: 'a', action: 'red' }, { type: 'score', side: 'a', action: 'black' }, { type: 'points', side: 'b', value: 4 },
    { type: 'unit_end' }, { type: 'score', side: 'b', action: 'pink' }, { type: 'unit_end' },
  ] },
  { name: 'chess game drawn', sport: 'chess', events: [{ type: 'unit_drawn' }] },
  { name: 'esports best of three maps', sport: 'esports', events: [
    { type: 'unit_won', side: 'b', score: { a: 7, b: 13 } }, { type: 'unit_won', side: 'a', score: { a: 14, b: 12 } },
    { type: 'unit_won', side: 'a', score: { a: 13, b: 11 } },
  ] },
  { name: 'boxing split decision', sport: 'boxing', events: [
    { type: 'round_cards', cards: [{ a: 10, b: 9 }, { a: 10, b: 9 }, { a: 9, b: 10 }] },
    { type: 'round_cards', cards: [{ a: 10, b: 9 }, { a: 9, b: 10 }, { a: 9, b: 10 }] },
    { type: 'round_cards', cards: [{ a: 9, b: 10 }, { a: 10, b: 9 }, { a: 10, b: 9 }] },
  ] },
  { name: 'taekwondo rounds and a gap', sport: 'taekwondo', events: [
    { type: 'score', side: 'b', action: 'head' }, { type: 'penalty', side: 'b' }, { type: 'round_end' },
    { type: 'score', side: 'b', action: 'spin_head' }, { type: 'score', side: 'b', action: 'spin_head' }, { type: 'score', side: 'b', action: 'body' },
    { type: 'score', side: 'b', action: 'punch' },
  ] },
  { name: 'football league match drawn', sport: 'football', league: true, events: [
    { type: 'score', side: 'a', action: 'goal' }, { type: 'score', side: 'b', action: 'goal' }, end, end,
  ] },
  { name: 'cricket league match tied', sport: 'cricket', league: true, events: [
    // One run then all out, twice: level, and with no super over in a league, a tie.
    ...[0, 1].flatMap(() => [
      { type: 'ball' as const, runs: 1, extra: null, wicket: null },
      ...Array.from({ length: 10 }, () => ({ type: 'ball' as const, runs: 0, extra: null, wicket: 'bowled' as const })),
    ]),
  ] },
  { name: 'padel super tiebreak to 10', sport: 'padel', events: [...Array.from({ length: 6 }, () => p('a', 4)).flat(), ...Array.from({ length: 6 }, () => p('b', 4)).flat(), ...p('a', 9), ...p('b', 9), ...p('a', 2)] },
];

const out = cases.map((c) => {
  const seed = LAUNCH_SPORTS.find((s) => s.slug === c.sport)!;
  const rule = c.league ? drawable(seed.scoringRule) : seed.scoringRule;
  const final = c.events.reduce((s, e) => applyEvent(s, e, rule), initialState(rule));
  return { ...c, rule, final };
});
writeFileSync('src/modules/scoring/fixtures/engine-fixtures.json', JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.length} cases`);
