/**
 * Live scores for the watch sports (2026-11-17): API-Sports (basketball, NFL,
 * baseball, hockey, rugby, MMA), Jolpica F1, Lichess chess, PandaScore
 * esports, and the system's own "Who wins?" questions (predictions R10).
 * Jolpica and Lichess shapes are cut from real responses of 2026-11-17.
 */
import { describe, expect, it } from 'vitest';
import {
  apiSportsFollows,
  apiSportsStatus,
  chessName,
  parseApiSportsGame,
  parseF1Leaders,
  parseF1Races,
  parseF1Result,
  parseLichessGame,
  parsePandaMatch,
} from '../src/modules/pro/feeds/index.js';
import { autoQuestionFor } from '../src/modules/predictions/service/index.js';

const team = { path: 'games' as const, draws: false };

describe('API-Sports, the other sports', () => {
  it('maps every status family', () => {
    expect(apiSportsStatus('NS', 'Not Started').status).toBe('scheduled');
    expect(apiSportsStatus('POST', 'Postponed')).toEqual({ status: 'scheduled', detail: 'Postponed' });
    expect(apiSportsStatus('CANC', 'Cancelled').status).toBe('abandoned');
    expect(apiSportsStatus('Q3', 'Quarter 3')).toEqual({ status: 'live', detail: 'Quarter 3' });
    expect(apiSportsStatus('P2', 'Second Period').status).toBe('live');
    expect(apiSportsStatus('IN7', 'Inning 7').status).toBe('live');
    expect(apiSportsStatus('HT', 'Halftime').status).toBe('break');
    expect(apiSportsStatus('AOT', 'After Over Time').status).toBe('finished');
    expect(apiSportsStatus('FT', 'Game Finished')).toEqual({ status: 'finished', detail: 'Full time' });
  });

  it('a basketball game: quarter totals, the winner', () => {
    const g = {
      id: 412345,
      date: '2026-11-17T00:30:00+00:00',
      timestamp: 1794875400,
      status: { long: 'Game Finished', short: 'FT' },
      league: { id: 12, name: 'NBA' },
      teams: { home: { id: 141, name: 'Boston Celtics' }, away: { id: 147, name: 'Los Angeles Lakers' } },
      scores: { home: { quarter_1: 30, total: 112 }, away: { quarter_1: 25, total: 104 } },
    };
    const m = parseApiSportsGame(g, team, 'NBA')!;
    expect(m).toMatchObject({ ref: '412345', league: 'NBA', home: { ref: '141', name: 'Boston Celtics' }, away: { ref: '147' } });
    expect(m.startsAt?.toISOString()).toBe('2026-11-17T00:30:00.000Z');
    expect(m.live).toMatchObject({ status: 'finished', homeScore: '112', awayScore: '104', winner: 'home', note: 'Boston Celtics win' });
    expect(apiSportsFollows(g, team, { ref: '12' })).toBe(true);
    expect(apiSportsFollows(g, team, { ref: '13' })).toBe(false);
    expect(apiSportsFollows(g, team, { ref: '*' })).toBe(true);
  });

  it('an ice hockey game in play: plain number scores', () => {
    const g = { id: 9, date: '2026-11-17T01:00:00+00:00', status: { long: 'Second Period', short: 'P2' }, league: { id: 57, name: 'NHL' }, teams: { home: { id: 1, name: 'Toronto Maple Leafs' }, away: { id: 2, name: 'Montreal Canadiens' } }, scores: { home: 2, away: 1 } };
    expect(parseApiSportsGame(g, team, null)!.live).toEqual({ status: 'live', statusDetail: 'Second Period', homeScore: '2', awayScore: '1' });
  });

  it('an NFL game: everything under `game`, a tie is a draw', () => {
    const g = {
      game: { id: 777, stage: 'Regular Season', week: 'Week 11', date: { date: '2026-11-16', time: '18:00', timestamp: 1794852000 }, venue: { name: 'Arrowhead Stadium', city: 'Kansas City' }, status: { short: 'FT', long: 'Finished' } },
      league: { id: 1, name: 'NFL' },
      teams: { home: { id: 20, name: 'Kansas City Chiefs' }, away: { id: 21, name: 'Buffalo Bills' } },
      scores: { home: { total: 24 }, away: { total: 24 } },
    };
    const m = parseApiSportsGame(g, { path: 'games', draws: true }, 'NFL')!;
    expect(m).toMatchObject({ ref: '777', stage: 'Regular Season · Week 11', venueName: 'Arrowhead Stadium', city: 'Kansas City' });
    expect(m.live).toMatchObject({ status: 'finished', winner: 'draw', note: 'Draw' });
  });

  it('an MMA fight: fighters as sides, the winner flag, followed by event name', () => {
    const f = {
      id: 5001,
      date: '2026-11-15T03:00:00+00:00',
      slug: 'UFC 322: Della Maddalena vs. Makhachev',
      category: 'Welterweight',
      is_main: true,
      status: { long: 'Finished', short: 'FT' },
      fighters: { first: { id: 11, name: 'Jack Della Maddalena', winner: false }, second: { id: 12, name: 'Islam Makhachev', winner: true } },
    };
    const m = parseApiSportsGame(f, { path: 'fights', draws: true }, null)!;
    expect(m).toMatchObject({ league: 'UFC 322: Della Maddalena vs. Makhachev', stage: 'Welterweight · Main event', home: { ref: 'f:11' }, away: { ref: 'f:12' } });
    expect(m.live).toMatchObject({ status: 'finished', winner: 'away', homeScore: 'L', awayScore: 'W', note: 'Islam Makhachev wins' });
    expect(apiSportsFollows(f, { path: 'fights' }, { ref: 'ufc' })).toBe(true);
    expect(apiSportsFollows(f, { path: 'fights' }, { ref: 'PFL' })).toBe(false);
  });

  it('a game without both teams is not imported', () => {
    expect(parseApiSportsGame({ id: 1, status: { short: 'NS' }, teams: { home: { id: 1, name: 'A' } } }, team, null)!.away).toBeNull();
  });
});

describe('Formula 1 (Jolpica)', () => {
  const schedule = { MRData: { RaceTable: { Races: [
    { season: '2026', round: '20', raceName: 'Brazilian Grand Prix', date: '2026-11-08', time: '17:00:00Z', Circuit: { circuitName: 'Autódromo José Carlos Pace', Location: { locality: 'São Paulo' } } },
    { season: '2026', round: '21', raceName: 'Las Vegas Grand Prix', date: '2026-11-22', time: '04:00:00Z', Circuit: { circuitName: 'Las Vegas Strip Street Circuit', Location: { locality: 'Las Vegas' } } },
  ] } } };
  const standings = { MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [
    { position: '1', Driver: { driverId: 'antonelli', code: 'ANT', givenName: 'Andrea Kimi', familyName: 'Antonelli' } },
    { position: '2', Driver: { driverId: 'norris', code: 'NOR', givenName: 'Lando', familyName: 'Norris' } },
    { position: '3', Driver: { driverId: 'piastri', code: 'PIA', givenName: 'Oscar', familyName: 'Piastri' } },
  ] }] } } };
  const result = { MRData: { RaceTable: { Races: [{ raceName: 'Brazilian Grand Prix', Results: [
    { position: '1', positionText: '1', points: '25', grid: '1', Driver: { driverId: 'norris', givenName: 'Lando', familyName: 'Norris' }, Constructor: { name: 'McLaren' }, Time: { time: '1:35:23.504' }, status: 'Finished' },
    { position: '2', positionText: '2', points: '18', grid: '3', Driver: { driverId: 'piastri', givenName: 'Oscar', familyName: 'Piastri' }, Constructor: { name: 'McLaren' }, Time: { time: '+2.104' }, status: 'Finished' },
    { position: '21', positionText: 'R', points: '0', grid: '2', Driver: { driverId: 'antonelli', givenName: 'Andrea Kimi', familyName: 'Antonelli' }, Constructor: { name: 'Mercedes' }, status: 'Retired' },
  ] }] } } };

  it('reads the schedule and the title fight', () => {
    const races = parseF1Races(schedule);
    expect(races[1]).toMatchObject({ season: '2026', round: '21', name: 'Las Vegas Grand Prix', circuit: 'Las Vegas Strip Street Circuit', city: 'Las Vegas' });
    expect(races[1]!.startsAt?.toISOString()).toBe('2026-11-22T04:00:00.000Z');
    expect(parseF1Leaders(standings).map((s) => s.ref)).toEqual(['antonelli', 'norris']);
  });

  it('a result: places of the two sides, a retirement is DNF, the top 10 in the scorecard', () => {
    const p = parseF1Result(result, { home: 'antonelli', away: 'norris' })!;
    expect(p).toMatchObject({ status: 'finished', homeScore: 'DNF', awayScore: 'P1', winner: 'away', note: 'Winner: Lando Norris (McLaren)' });
    const card = (p.scorecard as { rows: { name: string; cells: string[] }[] }[])[0]!;
    expect(card.rows[0]).toMatchObject({ name: '1. Lando Norris', cells: ['1', '25'] });
    expect(parseF1Result({ MRData: { RaceTable: { Races: [] } } }, { home: 'a', away: 'b' })).toBeNull();
  });
});

describe('chess (Lichess broadcasts)', () => {
  const game = {
    id: 'Ou6X1Ckj',
    fen: '3r4/B3pk1p/b1p1qpp1/8/P3P3/2Q2P1P/6P1/1r1R2K1 w - - 0 24',
    players: [
      { name: 'Giri, Anish', title: 'GM', rating: 2636, fideId: 24116068, fed: 'NED' },
      { name: 'Vachier-Lagrave, Maxime', title: 'GM', rating: 2734, fideId: 623539, fed: 'FRA' },
    ],
    status: '*',
  };
  const round = { id: 'M965QsFx', name: 'Game 3 | Blitz', startsAt: new Date(1794925800000), ongoing: true };

  it('a game in play: White at home, the move number, FIDE ids', () => {
    expect(chessName('Giri, Anish')).toBe('Anish Giri');
    const m = parseLichessGame(game, round, 'Total Chess Semifinals')!;
    expect(m).toMatchObject({ ref: 'M965QsFx:Ou6X1Ckj', stage: 'Game 3 | Blitz', home: { ref: 'fide:24116068', name: 'GM Anish Giri', code: 'GIR' }, away: { code: 'VAC' } });
    expect(m.live).toMatchObject({ status: 'live', statusDetail: 'Move 24', homeDetail: '2636', awayDetail: '2734' });
  });

  it('results: 1-0, 0-1 and a draw', () => {
    const done = (status: string) => parseLichessGame({ ...game, status }, { ...round, ongoing: false }, null)!.live;
    expect(done('1-0')).toMatchObject({ status: 'finished', homeScore: '1', awayScore: '0', winner: 'home' });
    expect(done('0-1')).toMatchObject({ winner: 'away' });
    expect(done('½-½')).toMatchObject({ homeScore: '½', awayScore: '½', winner: 'draw', note: 'Draw' });
  });
});

describe('esports (PandaScore)', () => {
  it('a running best-of-3, then the result', () => {
    const raw = {
      id: 1100,
      status: 'running',
      begin_at: '2026-11-17T12:00:00Z',
      number_of_games: 3,
      opponents: [{ opponent: { id: 1, name: 'Team Liquid', acronym: 'TL' } }, { opponent: { id: 2, name: 'Fnatic', acronym: 'FNC' } }],
      results: [{ team_id: 1, score: 1 }, { team_id: 2, score: 0 }],
      league: { name: 'VCT' },
      tournament: { name: 'Playoffs' },
      videogame: { name: 'Valorant' },
    };
    const m = parsePandaMatch(raw, null)!;
    expect(m).toMatchObject({ ref: '1100', league: 'VCT', stage: 'Valorant · Playoffs · Bo3', home: { code: 'TL' }, away: { code: 'FNC' } });
    expect(m.live).toMatchObject({ status: 'live', homeScore: '1', awayScore: '0', statusDetail: 'Best of 3 · game 2' });
    expect(parsePandaMatch({ ...raw, status: 'finished', winner_id: 2, results: [{ team_id: 1, score: 1 }, { team_id: 2, score: 2 }] }, null)!.live).toMatchObject({ status: 'finished', winner: 'away', note: 'Fnatic win' });
  });
});

describe('predictions R10 — the system question', () => {
  it('football and chess offer a draw; a Test does, a T20 does not; F1 asks who finishes ahead', () => {
    expect(autoQuestionFor({ sport: 'football', league: 'ISL', stage: null, home: 'Mumbai City', away: 'FC Goa' }).options.map((o) => o.outcome)).toEqual(['home', 'draw', 'away']);
    expect(autoQuestionFor({ sport: 'basketball', league: 'NBA', stage: null, home: 'A', away: 'B' }).options).toHaveLength(2);
    expect(autoQuestionFor({ sport: 'cricket', league: 'Bangladesh tour of South Africa', stage: '1st Test', home: 'SA', away: 'BAN' }).options).toHaveLength(3);
    expect(autoQuestionFor({ sport: 'cricket', league: "Women's Big Bash League", stage: '26th Match', home: 'A', away: 'B' }).options).toHaveLength(2);
    expect(autoQuestionFor({ sport: 'formula-1', league: 'F1', stage: null, home: 'Lando Norris', away: 'Oscar Piastri' }).prompt).toBe('Who finishes ahead: Lando Norris or Oscar Piastri?');
    expect(autoQuestionFor({ sport: 'chess', league: 'x', stage: null, home: 'A', away: 'B' }).prompt).toBe('Who wins this game?');
  });
});
