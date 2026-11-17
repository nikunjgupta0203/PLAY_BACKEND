/**
 * Chess from Lichess broadcasts (Floodlight watch sports, 2026-11-17). Free,
 * no key. Shapes checked against the live API, 2026-11-17.
 *
 *   · A follow's `ref` is the broadcast tournament id (the 8 characters in
 *     lichess.org/broadcast/<slug>/<id>). Fixtures: `/api/broadcast/{id}`
 *     lists its rounds; each round that is on now or starts within a
 *     fortnight gives its games from `/api/broadcast/-/-/{roundId}`.
 *   · Each game is a match: White at home, Black away. Only the top boards
 *     come in (BOARDS): a round of a big open has hundreds of games.
 *   · Live: one call per watched round refreshes every game in it.
 *
 * Match ref: `<roundId>:<gameId>`. A player's ref is their FIDE id.
 */
import type { FeedHttp } from '../../../platform/feeds.js';
import type { LivePatch, ProMatch, Winner } from '../service/index.js';
import { arr, cut, num, obj, str, type FeedFollow, type FeedMatch, type FeedSide, type ScoreAdapter } from './types.js';

const BASE = 'https://lichess.org/api/broadcast';
const BOARDS = 8;
const HORIZON_MS = 14 * 86_400_000;

/** "Giri, Anish" → "Anish Giri". */
export function chessName(raw: string): string {
  const [last, first] = raw.split(',').map((s) => s.trim());
  return first ? `${first} ${last}` : raw.trim();
}

function side(p: Record<string, unknown>): FeedSide | null {
  const raw = str(p['name']);
  if (!raw) return null;
  const name = chessName(raw);
  const last = raw.includes(',') ? raw.split(',')[0]!.trim() : (name.split(' ').pop() ?? name);
  const title = str(p['title']);
  return {
    ref: `fide:${str(p['fideId']) ?? raw.toLowerCase()}`,
    name: cut(title ? `${title} ${name}` : name, 60)!,
    code: last.replace(/[^\p{L}]/gu, '').slice(0, 3).toUpperCase() || 'TBC',
  };
}

/** One broadcast game. Pure. */
export function parseLichessGame(raw: unknown, round: { id: string; name: string | null; startsAt: Date | null; ongoing: boolean }, league: string | null): FeedMatch | null {
  const g = obj(raw);
  const id = str(g['id']);
  const players = arr(g['players']).map(obj);
  if (!id || players.length < 2) return null;
  const white = side(players[0]!);
  const black = side(players[1]!);
  const result = str(g['status']) ?? '*';
  const finished = result !== '*';
  const live: LivePatch = { status: finished ? 'finished' : round.ongoing ? 'live' : 'scheduled' };
  if (finished) {
    const [w, b] = result.replace(/½/g, '0.5').split('-');
    const winner: Winner | null = result === '1-0' ? 'home' : result === '0-1' ? 'away' : /½|0\.5/.test(result) ? 'draw' : null;
    live.homeScore = w === '0.5' ? '½' : (w ?? null);
    live.awayScore = b === '0.5' ? '½' : (b ?? null);
    live.winner = winner;
    live.statusDetail = 'Result';
    live.note = winner === 'draw' ? 'Draw' : winner ? `${winner === 'home' ? white?.name : black?.name} wins` : null;
  } else if (round.ongoing) {
    // FEN field 6 is the move number.
    const move = num((str(g['fen']) ?? '').split(' ')[5]);
    live.statusDetail = move ? `Move ${move}` : 'In play';
    const rating = (p: Record<string, unknown>) => num(p['rating']);
    live.homeDetail = rating(players[0]!) ? String(rating(players[0]!)) : null;
    live.awayDetail = rating(players[1]!) ? String(rating(players[1]!)) : null;
  }
  return {
    ref: `${round.id}:${id}`,
    startsAt: round.startsAt,
    league: cut(league, 60),
    stage: cut(round.name, 60),
    venueName: null,
    city: null,
    home: white,
    away: black,
    live,
    moments: [],
  };
}

const roundOf = (r: Record<string, unknown>) => {
  const ms = num(r['startsAt']);
  return { id: str(r['id'])!, name: str(r['name']), startsAt: ms ? new Date(ms) : null, ongoing: r['ongoing'] === true, finished: r['finished'] === true };
};

export function lichessAdapter(): ScoreAdapter {
  const roundGames = async (http: FeedHttp, roundId: string) => {
    const j = obj(await http.json(`${BASE}/-/-/${encodeURIComponent(roundId)}`));
    return { round: roundOf(obj(j['round'])), games: arr(j['games']).slice(0, BOARDS) };
  };
  return {
    provider: 'lichess',
    sportSlug: 'chess',
    pollMinutes: 3,
    configured: () => true,
    async fixtures(follow: FeedFollow, http: FeedHttp, now: Date) {
      const tour = obj(await http.json(`${BASE}/${encodeURIComponent(follow.ref.trim())}`));
      const name = follow.name || str(obj(tour['tour'])['name']);
      const rounds = arr(tour['rounds']).map(obj).map(roundOf).filter((r) => r.id);
      const wanted = rounds.filter((r) => r.ongoing || (!r.finished && r.startsAt !== null && r.startsAt.getTime() <= now.getTime() + HORIZON_MS && r.startsAt.getTime() >= now.getTime() - 86_400_000));
      // The latest finished round too, with its results.
      const lastDone = rounds.filter((r) => r.finished).at(-1);
      if (lastDone && !wanted.some((r) => r.id === lastDone.id)) wanted.unshift(lastDone);
      const out: FeedMatch[] = [];
      for (const r of wanted.slice(0, 4)) {
        const { round, games } = await roundGames(http, r.id);
        for (const g of games) {
          const m = parseLichessGame(g, { ...round, id: r.id, startsAt: round.startsAt ?? r.startsAt }, name);
          // A finished round brings only its results, not boards left unplayed.
          if (r.finished && m?.live.status !== 'finished') continue;
          if (m && m.home && m.away && m.startsAt) out.push(m);
        }
      }
      return out;
    },
    async live(watch: ProMatch[], http: FeedHttp) {
      const rounds = new Set(watch.map((w) => (w.providerRef ?? '').split(':')[0] ?? '').filter((r): r is string => r !== ''));
      const wanted = new Set(watch.map((w) => w.providerRef).filter((r): r is string => !!r));
      const out: FeedMatch[] = [];
      for (const roundId of rounds) {
        const { round, games } = await roundGames(http, roundId);
        for (const g of games) {
          const m = parseLichessGame(g, { ...round, id: roundId }, null);
          if (m && wanted.has(m.ref)) out.push({ ...m, league: null, stage: null });
        }
      }
      return out;
    },
  };
}
