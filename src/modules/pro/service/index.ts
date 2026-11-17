/**
 * pro — professional matches for the Match Centre (Floodlight redesign §4.3).
 *
 * There is no data feed yet, so PL4Y staff enter matches by hand in the
 * portal: teams, the score line, the over in play, key moments and the
 * scorecard. `provider` stays 'manual'; a feed later writes its own name and
 * `provider_ref`, through the same `saveMatch` (the adapter seam).
 *
 * pro R1 — scores are text ("182/4", "2", "21-17"): every sport writes them
 *   differently and nothing here does arithmetic on them.
 * pro R2 — stats, the current over and the scorecard are JSON with a checked
 *   shape: a bad shape is refused, never stored.
 * pro R3 — the board shows live matches first, then upcoming soonest, then
 *   the latest results.
 * pro R4 — one public chat room per match, for signed-in players. 500
 *   characters, rate limited, closed when staff close it or the match is
 *   abandoned. A hidden message keeps its body for moderation and is never
 *   sent to players.
 * pro R5 — every change to a match is published on `private-pro-match-{id}`
 *   so an open Match Centre refreshes without polling.
 * pro R6 — favourite teams: at most 10 per player.
 * pro R8 (060) — a feed and staff share one match. A field staff edit by hand
 *   on a feed's match is locked (`feed_locked`): the feed leaves it alone
 *   until staff hand it back. Staff always win.
 * pro R9 (060) — a match that finishes asks predictions for settle
 *   suggestions; one that is abandoned voids its open questions.
 */
import { z } from 'zod';
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';

export const ProCode = {
  NOT_FOUND: 'PRO_MATCH_NOT_FOUND',
  TEAM_NOT_FOUND: 'PRO_TEAM_NOT_FOUND',
  INVALID_MATCH: 'INVALID_PRO_MATCH',
  INVALID_TEAM: 'INVALID_PRO_TEAM',
  CHAT_CLOSED: 'MATCH_CHAT_CLOSED',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  TOO_FAST: 'POSTING_TOO_FAST',
  TOO_MANY_TEAMS: 'TOO_MANY_FAVOURITE_TEAMS',
} as const;

export const MESSAGE_MAX = 500;
export const MAX_FAVOURITE_TEAMS = 10;
const CHAT_WINDOW: Window = { seconds: 30, max: 6 };

export type ProStatus = 'scheduled' | 'live' | 'break' | 'finished' | 'abandoned';
export const PRO_STATUSES: readonly ProStatus[] = ['scheduled', 'live', 'break', 'finished', 'abandoned'];
export type MomentKind = 'six' | 'four' | 'wicket' | 'milestone' | 'goal' | 'card' | 'point' | 'other';
export const MOMENT_KINDS: readonly MomentKind[] = ['six', 'four', 'wicket', 'milestone', 'goal', 'card', 'point', 'other'];
export type Winner = 'home' | 'away' | 'draw';
export const WINNERS: readonly Winner[] = ['home', 'away', 'draw'];
/** pro R8 — staff-only switches a feed never sets, so they never lock. */
const NEVER_LOCKED = new Set(['featured', 'chatOpen']);

// --- pro R2: the JSON shapes -------------------------------------------------------

const short = (max: number) => z.string().trim().min(1).max(max);
export const StatSchema = z.object({ label: short(30), value: short(20) });
export const BallSchema = short(4);
export const ScoreRowSchema = z.object({
  name: short(60),
  detail: z.string().trim().max(80).nullable().optional(),
  /** Free cells in column order: cricket batting R B 4s 6s SR; bowling O M R W. */
  cells: z.array(z.string().trim().max(10)).max(8),
});
export const InningsSchema = z.object({
  team: short(10),
  title: short(40),
  columns: z.array(z.string().trim().max(6)).max(8),
  rows: z.array(ScoreRowSchema).max(30),
  footer: z.string().trim().max(120).nullable().optional(),
});

export type Stat = z.infer<typeof StatSchema>;
export type Innings = z.infer<typeof InningsSchema>;

function parseJson<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UserError(ProCode.INVALID_MATCH, `The ${what} is not in the right shape: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
  }
  return parsed.data;
}

/** Read back defensively: a row written before a shape change still renders. */
function readJson<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

// --- domain ----------------------------------------------------------------------

export interface Team {
  id: string;
  sportId: string;
  name: string;
  shortCode: string;
  tint: string;
  provider: string;
}

export interface ProMatch {
  id: string;
  sportId: string;
  league: string;
  stage: string | null;
  homeTeamId: string;
  awayTeamId: string;
  venueName: string | null;
  city: string | null;
  startsAt: Date;
  status: ProStatus;
  statusDetail: string | null;
  homeScore: string | null;
  awayScore: string | null;
  homeDetail: string | null;
  awayDetail: string | null;
  note: string | null;
  stats: Stat[];
  currentOver: string[];
  scorecard: Innings[];
  featured: boolean;
  chatOpen: boolean;
  provider: string;
  providerRef: string | null;
  /** pro R8 — the LivePatch keys staff own on this feed match. */
  feedLocked: string[];
  feedCheckedAt: Date | null;
  winner: Winner | null;
  updatedAt: Date;
}

export interface Moment {
  id: string;
  matchId: string;
  atLabel: string | null;
  kind: MomentKind;
  title: string;
  detail: string | null;
  createdAt: Date;
}

export interface ChatMessage {
  id: string;
  matchId: string;
  userId: string;
  /** Empty once hidden, except to staff. */
  body: string;
  hidden: boolean;
  createdAt: Date;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface MatchInput {
  sportId: string;
  league: string;
  stage?: string | null;
  homeTeamId: string;
  awayTeamId: string;
  venueName?: string | null;
  city?: string | null;
  startsAt: Date;
  featured?: boolean;
  provider?: string;
  providerRef?: string | null;
}

/** Everything that changes during play. Undefined leaves a field as it is. */
export interface LivePatch {
  status?: ProStatus;
  statusDetail?: string | null;
  homeScore?: string | null;
  awayScore?: string | null;
  homeDetail?: string | null;
  awayDetail?: string | null;
  note?: string | null;
  stats?: unknown;
  currentOver?: unknown;
  scorecard?: unknown;
  featured?: boolean;
  chatOpen?: boolean;
  startsAt?: Date;
  league?: string;
  stage?: string | null;
  venueName?: string | null;
  city?: string | null;
  winner?: Winner | null;
}

export interface ProDeps {
  db: Db;
  limiter: { consume(key: string, window: Window): Promise<LimitResult> };
  /** pro R5 — never throws; a lost publish only costs a refresh. */
  publish?(matchId: string, event: string, data: Record<string, unknown>): Promise<void>;
  /** A match went live: tell the fans of either team. */
  wentLive?(match: ProMatch, fanUserIds: string[], teams: { home: Team; away: Team }): Promise<void>;
  /** pro R9 — finished (or its result corrected): suggest answers. Never throws into the update. */
  finished?(match: ProMatch): Promise<void>;
  /** pro R9 — abandoned: void the open questions. */
  abandoned?(match: ProMatch): Promise<void>;
  now?: () => Date;
}

type MatchRow = Awaited<ReturnType<Db['proMatch']['findFirstOrThrow']>>;
type TeamRow = Awaited<ReturnType<Db['proTeam']['findFirstOrThrow']>>;

const toTeam = (r: TeamRow): Team => ({ id: r.id, sportId: r.sportId, name: r.name, shortCode: r.shortCode, tint: r.tint, provider: r.provider });

const toMatch = (r: MatchRow): ProMatch => ({
  id: r.id,
  sportId: r.sportId,
  league: r.league,
  stage: r.stage,
  homeTeamId: r.homeTeamId,
  awayTeamId: r.awayTeamId,
  venueName: r.venueName,
  city: r.city,
  startsAt: r.startsAt,
  status: r.status as ProStatus,
  statusDetail: r.statusDetail,
  homeScore: r.homeScore,
  awayScore: r.awayScore,
  homeDetail: r.homeDetail,
  awayDetail: r.awayDetail,
  note: r.note,
  stats: readJson(z.array(StatSchema), r.stats, []),
  currentOver: readJson(z.array(BallSchema), r.currentOver, []),
  scorecard: readJson(z.array(InningsSchema), r.scorecard, []),
  featured: r.featured,
  chatOpen: r.chatOpen,
  provider: r.provider,
  providerRef: r.providerRef,
  feedLocked: r.feedLocked,
  feedCheckedAt: r.feedCheckedAt,
  winner: (WINNERS as readonly string[]).includes(r.winner ?? '') ? (r.winner as Winner) : null,
  updatedAt: r.updatedAt,
});

const cursorOf = (r: { createdAt: Date; id: string }): string =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');

function decode(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

const olderThan = (c: { createdAt: Date; id: string } | null) =>
  c ? { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] } : {};

const LIVE: ProStatus[] = ['live', 'break'];

/** pro R3 — live first, then upcoming soonest, then latest results. Pure. */
export function boardOrder(a: ProMatch, b: ProMatch): number {
  const rank = (m: ProMatch) => (LIVE.includes(m.status) ? 0 : m.status === 'scheduled' ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const t = a.startsAt.getTime() - b.startsAt.getTime();
  return ra === 2 ? -t : t;
}

function clean(raw: string | null | undefined, max: number, what: string): string | null {
  if (raw === undefined || raw === null) return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > max) throw new UserError(ProCode.INVALID_MATCH, `${what} is at most ${max} characters.`);
  return v;
}

function required(raw: string, max: number, what: string, code: string = ProCode.INVALID_MATCH): string {
  const v = raw.trim();
  if (v.length < 1 || v.length > max) throw new UserError(code, `${what} is 1 to ${max} characters.`);
  return v;
}

export function createProService(deps: ProDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const publish = async (matchId: string, event: string, data: Record<string, unknown> = {}) => {
    try {
      await deps.publish?.(matchId, event, { matchId, ...data });
    } catch {
      // pro R5 — dropped; the client refreshes on focus anyway.
    }
  };

  // --- teams -----------------------------------------------------------------------

  async function teams(sportId: string | null): Promise<Team[]> {
    const rows = await db.proTeam.findMany({ where: sportId ? { sportId } : {}, orderBy: [{ name: 'asc' }] });
    return rows.map(toTeam);
  }

  async function teamsByIds(ids: readonly string[]): Promise<Map<string, Team>> {
    if (ids.length === 0) return new Map();
    const rows = await db.proTeam.findMany({ where: { id: { in: [...new Set(ids)] } } });
    return new Map(rows.map((r) => [r.id, toTeam(r)]));
  }

  function teamFields(input: { name: string; shortCode: string; tint?: string | null }) {
    const tint = (input.tint ?? '#2C2C24').trim();
    if (!/^#[0-9A-Fa-f]{6}$/.test(tint)) throw new UserError(ProCode.INVALID_TEAM, 'The colour is a hex code like #1E3A6B.');
    return {
      name: required(input.name, 80, 'A team name', ProCode.INVALID_TEAM),
      shortCode: required(input.shortCode, 5, 'The short code', ProCode.INVALID_TEAM).toUpperCase(),
      tint: tint.toUpperCase(),
    };
  }

  async function saveTeam(id: string | null, input: { sportId: string; name: string; shortCode: string; tint?: string | null }): Promise<Team> {
    const fields = teamFields(input);
    try {
      const row = id
        ? await db.proTeam.update({ where: { id }, data: fields })
        : await db.proTeam.create({ data: { id: newId(), sportId: input.sportId, ...fields } });
      return toTeam(row);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') throw new UserError(ProCode.TEAM_NOT_FOUND, 'That team is no longer there.');
      if ((e as { code?: string }).code === 'P2002' || /pro_teams_sport_name_key/.test(String(e))) {
        throw new UserError(ProCode.INVALID_TEAM, 'A team with that name already exists in this sport.');
      }
      throw e;
    }
  }

  // --- matches ---------------------------------------------------------------------

  async function match(id: string): Promise<ProMatch | null> {
    const row = await db.proMatch.findUnique({ where: { id } });
    return row ? toMatch(row) : null;
  }

  async function requireMatch(id: string): Promise<ProMatch> {
    const m = await match(id);
    if (!m) throw new UserError(ProCode.NOT_FOUND, 'That match is no longer there.');
    return m;
  }

  async function matchesByIds(ids: readonly string[]): Promise<Map<string, ProMatch>> {
    if (ids.length === 0) return new Map();
    const rows = await db.proMatch.findMany({ where: { id: { in: [...new Set(ids)] } } });
    return new Map(rows.map((r) => [r.id, toMatch(r)]));
  }

  /**
   * pro R3 — the Matches board. `window` is how far either side of now to look:
   * results from the last 3 days, fixtures up to 14 days out, live always.
   */
  async function board(filter: { sportId?: string | null; status?: 'live' | 'upcoming' | 'finished' | null; first?: number; q?: string | null }): Promise<ProMatch[]> {
    const t = now();
    const first = Math.min(Math.max(filter.first ?? 30, 1), 50);
    const past = new Date(t.getTime() - 3 * 86_400_000);
    // The Results tab reaches further back: F1 and fight cards are a week or more apart.
    const resultsSince = new Date(t.getTime() - 14 * 86_400_000);
    const ahead = new Date(t.getTime() + 14 * 86_400_000);
    // A fixture 12 hours past its start that nobody moved to live is not "upcoming": hide it.
    const stale = new Date(t.getTime() - 12 * 3_600_000);
    const status =
      filter.status === 'live'
        ? { status: { in: LIVE } }
        : filter.status === 'upcoming'
          ? { status: 'scheduled', startsAt: { lte: ahead, gte: stale } }
          : filter.status === 'finished'
            ? { status: { in: ['finished', 'abandoned'] }, startsAt: { gte: resultsSince } }
            : {
                OR: [
                  { status: { in: LIVE } },
                  { status: 'scheduled', startsAt: { lte: ahead, gte: stale } },
                  { status: { in: ['finished', 'abandoned'] }, startsAt: { gte: past } },
                ],
              };
    const q = filter.q?.trim();
    const search = q
      ? {
          AND: [
            {
              OR: [
                { league: { contains: q, mode: 'insensitive' as const } },
                { homeTeam: { name: { contains: q, mode: 'insensitive' as const } } },
                { awayTeam: { name: { contains: q, mode: 'insensitive' as const } } },
                { homeTeam: { shortCode: { equals: q.toUpperCase() } } },
                { awayTeam: { shortCode: { equals: q.toUpperCase() } } },
              ],
            },
          ],
        }
      : {};
    const rows = await db.proMatch.findMany({
      where: { ...(filter.sportId ? { sportId: filter.sportId } : {}), ...status, ...search },
      orderBy: [{ startsAt: 'asc' }],
      take: 200,
    });
    return rows.map(toMatch).sort(boardOrder).slice(0, first);
  }

  /** Portal — every match, newest start first. */
  async function staffList(first = 100): Promise<ProMatch[]> {
    const rows = await db.proMatch.findMany({ orderBy: [{ startsAt: 'desc' }], take: Math.min(Math.max(first, 1), 300) });
    return rows.map(toMatch);
  }

  async function createMatch(staffUserId: string | null, input: MatchInput): Promise<ProMatch> {
    if (input.homeTeamId === input.awayTeamId) throw new UserError(ProCode.INVALID_MATCH, 'Pick two different teams.');
    const found = await teamsByIds([input.homeTeamId, input.awayTeamId]);
    const home = found.get(input.homeTeamId);
    const away = found.get(input.awayTeamId);
    if (!home || !away) throw new UserError(ProCode.TEAM_NOT_FOUND, 'Pick two teams that exist.');
    if (home.sportId !== input.sportId || away.sportId !== input.sportId) {
      throw new UserError(ProCode.INVALID_MATCH, 'Both teams play the match’s sport.');
    }
    if (Number.isNaN(input.startsAt.getTime())) throw new UserError(ProCode.INVALID_MATCH, 'Give a start time.');
    const row = await db.proMatch.create({
      data: {
        id: newId(),
        sportId: input.sportId,
        league: required(input.league, 60, 'The league'),
        stage: clean(input.stage, 60, 'The stage'),
        homeTeamId: input.homeTeamId,
        awayTeamId: input.awayTeamId,
        venueName: clean(input.venueName, 80, 'The venue'),
        city: clean(input.city, 60, 'The city'),
        startsAt: input.startsAt,
        featured: input.featured ?? false,
        provider: input.provider ?? 'manual',
        providerRef: input.providerRef ?? null,
        createdBy: staffUserId,
      },
    });
    return toMatch(row);
  }

  /**
   * The adapter seam: staff in the portal and the data feeds both write here.
   * pro R8 — a feed's patch skips the fields staff locked; a staff edit on a
   * feed's match locks what it touched.
   */
  async function updateMatch(id: string, raw: LivePatch, opts: { source?: 'staff' | 'feed' } = {}): Promise<ProMatch> {
    const before = await requireMatch(id);
    const source = opts.source ?? 'staff';
    const patch: LivePatch = { ...raw };
    if (source === 'feed') {
      for (const key of before.feedLocked) delete (patch as Record<string, unknown>)[key];
    }
    if (patch.status !== undefined && !PRO_STATUSES.includes(patch.status)) {
      throw new UserError(ProCode.INVALID_MATCH, 'That is not a match status.');
    }
    if (patch.winner !== undefined && patch.winner !== null && !WINNERS.includes(patch.winner)) {
      throw new UserError(ProCode.INVALID_MATCH, 'The winner is home, away or a draw.');
    }
    const data: Record<string, unknown> = { updatedAt: now() };
    if (source === 'feed') data.feedCheckedAt = now();
    if (patch.winner !== undefined) data.winner = patch.winner;
    if (source === 'staff' && before.provider !== 'manual') {
      // Only what the edit changed: the live desk sends the whole form on every save.
      const same = (a: unknown, b: unknown) =>
        a instanceof Date || b instanceof Date ? new Date(a as Date).getTime() === new Date(b as Date).getTime() : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const touched = Object.keys(patch).filter((k) => {
        const v = (patch as Record<string, unknown>)[k];
        if (v === undefined || NEVER_LOCKED.has(k)) return false;
        const cur = (before as unknown as Record<string, unknown>)[k];
        return !same(typeof v === 'string' ? v.trim() || null : v, cur);
      });
      const locked = [...new Set([...before.feedLocked, ...touched])].sort();
      if (locked.length !== before.feedLocked.length) data.feedLocked = locked;
    }
    const text: [keyof LivePatch, number, string][] = [
      ['statusDetail', 40, 'The status line'],
      ['homeScore', 30, 'A score'],
      ['awayScore', 30, 'A score'],
      ['homeDetail', 30, 'A score detail'],
      ['awayDetail', 30, 'A score detail'],
      ['note', 120, 'The note'],
      ['stage', 60, 'The stage'],
      ['venueName', 80, 'The venue'],
      ['city', 60, 'The city'],
    ];
    for (const [key, max, what] of text) {
      if (patch[key] !== undefined) data[key] = clean(patch[key] as string | null, max, what);
    }
    if (patch.league !== undefined) data.league = required(patch.league, 60, 'The league');
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.featured !== undefined) data.featured = patch.featured;
    if (patch.chatOpen !== undefined) data.chatOpen = patch.chatOpen;
    if (patch.startsAt !== undefined) data.startsAt = patch.startsAt;
    if (patch.stats !== undefined) data.stats = parseJson(z.array(StatSchema).max(6), patch.stats, 'stats row');
    if (patch.currentOver !== undefined) data.currentOver = parseJson(z.array(BallSchema).max(12), patch.currentOver, 'over');
    if (patch.scorecard !== undefined) data.scorecard = parseJson(z.array(InningsSchema).max(4), patch.scorecard, 'scorecard');

    const after = toMatch(await db.proMatch.update({ where: { id }, data }));
    await publish(id, 'pro.match.updated', { updatedAt: after.updatedAt.toISOString() });

    // pro R9 — a result in (or corrected) asks for suggestions; abandoned voids.
    const resultChanged =
      before.status !== after.status || before.homeScore !== after.homeScore || before.awayScore !== after.awayScore || before.winner !== after.winner;
    try {
      if (after.status === 'finished' && resultChanged) await deps.finished?.(after);
      if (after.status === 'abandoned' && before.status !== 'abandoned') await deps.abandoned?.(after);
    } catch {
      // Predictions catch up when staff open the question; the score update stands.
    }

    if (!LIVE.includes(before.status) && after.status === 'live' && deps.wentLive) {
      const fans = await db.proTeamFan.findMany({ where: { teamId: { in: [after.homeTeamId, after.awayTeamId] } }, select: { userId: true } });
      const teamMap = await teamsByIds([after.homeTeamId, after.awayTeamId]);
      const home = teamMap.get(after.homeTeamId);
      const away = teamMap.get(after.awayTeamId);
      if (home && away && fans.length) {
        try {
          await deps.wentLive(after, [...new Set(fans.map((f) => f.userId))], { home, away });
        } catch {
          // A failed push never fails the score update.
        }
      }
    }
    return after;
  }

  async function deleteMatch(id: string): Promise<void> {
    await requireMatch(id);
    // Deleting cascades to its questions and picks, but points already written stay:
    // players' records would stop adding up. Once anything is settled, abandon instead.
    const settled = await db.predictionQuestion.count({ where: { matchId: id, status: 'settled' } });
    if (settled > 0) {
      throw new UserError(ProCode.INVALID_MATCH, 'This match has settled predictions. Mark it abandoned instead of deleting it.');
    }
    await db.proMatch.delete({ where: { id } });
  }

  /** pro R8 — hands fields back to the feed (all of them when none are named). */
  async function releaseFeed(id: string, fields?: string[] | null): Promise<ProMatch> {
    const m = await requireMatch(id);
    const keep = fields && fields.length ? m.feedLocked.filter((k) => !fields.includes(k)) : [];
    return toMatch(await db.proMatch.update({ where: { id }, data: { feedLocked: keep, updatedAt: now() } }));
  }

  // --- feeds (060) -------------------------------------------------------------------

  async function matchByProvider(provider: string, providerRef: string): Promise<ProMatch | null> {
    const row = await db.proMatch.findFirst({ where: { provider, providerRef } });
    return row ? toMatch(row) : null;
  }

  /** The feed's matches still worth polling: due within `aheadMs`, live, or on a break. */
  async function feedWatchList(provider: string, aheadMs: number): Promise<ProMatch[]> {
    const t = now().getTime();
    const rows = await db.proMatch.findMany({
      where: {
        provider,
        providerRef: { not: null },
        OR: [
          // A match stuck at live (a feed that stopped answering) is dropped after six
          // days, the longest a Test runs: every poll of it would spend a call.
          { status: { in: LIVE }, startsAt: { gte: new Date(t - 6 * 86_400_000) } },
          // A fixture that never went live stops being polled 18 hours after its start.
          { status: 'scheduled', startsAt: { lte: new Date(t + aheadMs), gte: new Date(t - 18 * 3_600_000) } },
        ],
      },
      orderBy: [{ startsAt: 'asc' }],
      take: 50,
    });
    return rows.map(toMatch);
  }

  /** A poll that found nothing new still says the score is current (G9). */
  async function touchFeedChecked(ids: string[]): Promise<void> {
    if (ids.length) await db.proMatch.updateMany({ where: { id: { in: ids } }, data: { feedCheckedAt: now() } });
  }

  /**
   * The team a feed names: by the feed's own id first, then by name in the
   * sport (a team staff already made is claimed, not duplicated), else new.
   */
  async function feedTeam(sportId: string, provider: string, providerRef: string, name: string, shortCode: string): Promise<Team> {
    const byRef = await db.proTeam.findFirst({ where: { provider, providerRef } });
    if (byRef) return toTeam(byRef);
    const cleanName = name.trim().slice(0, 80) || providerRef.slice(0, 80);
    const byName = await db.proTeam.findFirst({ where: { sportId, name: { equals: cleanName, mode: 'insensitive' } } });
    if (byName) {
      if (byName.providerRef) return toTeam(byName);
      return toTeam(await db.proTeam.update({ where: { id: byName.id }, data: { provider, providerRef } }));
    }
    const code = shortCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5) || cleanName.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TBC';
    try {
      return toTeam(await db.proTeam.create({ data: { id: newId(), sportId, name: cleanName, shortCode: code, provider, providerRef } }));
    } catch (e) {
      // Two polls raced to make the same team: the other one won.
      const again = await db.proTeam.findFirst({ where: { provider, providerRef } });
      if (again) return toTeam(again);
      throw e;
    }
  }

  /** A feed's moment, written once (unique on match + the feed's id for it). */
  async function addFeedMoment(matchId: string, providerRef: string, input: { atLabel?: string | null; kind: MomentKind; title: string; detail?: string | null }): Promise<boolean> {
    const title = input.title.trim().slice(0, 80);
    if (!title) return false;
    const res = await db.proMatchMoment.createMany({
      data: [
        {
          id: newId(),
          matchId,
          providerRef: providerRef.slice(0, 120),
          atLabel: input.atLabel ? input.atLabel.trim().slice(0, 12) || null : null,
          kind: MOMENT_KINDS.includes(input.kind) ? input.kind : 'other',
          title,
          detail: input.detail ? input.detail.trim().slice(0, 160) || null : null,
          createdAt: now(),
        },
      ],
      skipDuplicates: true,
    });
    if (res.count > 0) await publish(matchId, 'pro.match.updated', {});
    return res.count > 0;
  }

  // --- moments ---------------------------------------------------------------------

  async function moments(matchId: string, first = 30): Promise<Moment[]> {
    const rows = await db.proMatchMoment.findMany({
      where: { matchId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(first, 1), 100),
    });
    return rows.map((r) => ({ id: r.id, matchId: r.matchId, atLabel: r.atLabel, kind: r.kind as MomentKind, title: r.title, detail: r.detail, createdAt: r.createdAt }));
  }

  async function addMoment(matchId: string, input: { atLabel?: string | null; kind: MomentKind; title: string; detail?: string | null }): Promise<Moment> {
    await requireMatch(matchId);
    if (!MOMENT_KINDS.includes(input.kind)) throw new UserError(ProCode.INVALID_MATCH, 'That is not a moment kind.');
    const row = await db.proMatchMoment.create({
      data: {
        id: newId(),
        matchId,
        atLabel: clean(input.atLabel, 12, 'The time'),
        kind: input.kind,
        title: required(input.title, 80, 'The moment'),
        detail: clean(input.detail, 160, 'The detail'),
      },
    });
    await db.proMatch.update({ where: { id: matchId }, data: { updatedAt: now() } });
    await publish(matchId, 'pro.match.updated', {});
    return { id: row.id, matchId: row.matchId, atLabel: row.atLabel, kind: row.kind as MomentKind, title: row.title, detail: row.detail, createdAt: row.createdAt };
  }

  async function deleteMoment(momentId: string): Promise<void> {
    const row = await db.proMatchMoment.findUnique({ where: { id: momentId } });
    if (!row) return;
    await db.proMatchMoment.delete({ where: { id: momentId } });
    await publish(row.matchId, 'pro.match.updated', {});
  }

  // --- pro R4: the match chat -----------------------------------------------------

  const asMessage = (r: { id: string; matchId: string; userId: string; body: string; hiddenAt: Date | null; createdAt: Date }, staff = false): ChatMessage => ({
    id: r.id,
    matchId: r.matchId,
    userId: r.userId,
    body: r.hiddenAt && !staff ? '' : r.body,
    hidden: r.hiddenAt !== null,
    createdAt: r.createdAt,
  });

  /** Newest first. Players never see hidden messages; staff see them marked. */
  async function chat(matchId: string, page: { first?: number; before?: string | null }, opts: { staff?: boolean } = {}): Promise<Page<ChatMessage>> {
    const first = Math.min(Math.max(page.first ?? 30, 1), 100);
    const rows = await db.proMatchMessage.findMany({
      where: { matchId, ...(opts.staff ? {} : { hiddenAt: null }), ...olderThan(decode(page.before)) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: first + 1,
    });
    const nodes = rows.slice(0, first).map((r) => asMessage(r, opts.staff));
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > first, endCursor: last ? cursorOf(last) : null };
  }

  /** Everyone who has said something in the room — the "fans in chat" count. */
  async function chatterCount(matchId: string): Promise<number> {
    const rows = await db.proMatchMessage.groupBy({ by: ['userId'], where: { matchId, hiddenAt: null } });
    return rows.length;
  }

  async function sendMessage(userId: string, matchId: string, raw: string): Promise<ChatMessage> {
    const m = await requireMatch(matchId);
    if (!m.chatOpen || m.status === 'abandoned') throw new UserError(ProCode.CHAT_CLOSED, 'The chat for this match is closed.');
    const body = raw.trim();
    if (body.length < 1 || body.length > MESSAGE_MAX) {
      throw new UserError(ProCode.INVALID_MESSAGE, `A message is 1 to ${MESSAGE_MAX} characters.`);
    }
    const limit = await deps.limiter.consume(`pro:chat:${userId}`, CHAT_WINDOW);
    if (!limit.allowed) {
      throw new UserError(ProCode.TOO_FAST, 'You’re sending too quickly. Try again in a moment.', { retryAfterSeconds: limit.retryAfterSeconds });
    }
    const row = await db.proMatchMessage.create({ data: { id: newId(), matchId, userId, body } });
    await publish(matchId, 'pro.chat.message', { messageId: row.id });
    return asMessage(row);
  }

  async function hideMessage(staffUserId: string, messageId: string): Promise<ChatMessage> {
    const row = await db.proMatchMessage.findUnique({ where: { id: messageId } });
    if (!row) throw new UserError(ProCode.INVALID_MESSAGE, 'That message is no longer there.');
    if (row.hiddenAt) return asMessage(row, true);
    const updated = await db.proMatchMessage.update({ where: { id: messageId }, data: { hiddenAt: now(), hiddenBy: staffUserId } });
    await publish(row.matchId, 'pro.chat.hidden', { messageId });
    return asMessage(updated, true);
  }

  // --- pro R6: favourite teams ----------------------------------------------------

  async function favouriteTeams(userId: string): Promise<Team[]> {
    const rows = await db.proTeamFan.findMany({ where: { userId }, include: { team: true }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => toTeam(r.team));
  }

  async function setFavouriteTeams(userId: string, teamIds: string[]): Promise<Team[]> {
    const ids = [...new Set(teamIds)];
    if (ids.length > MAX_FAVOURITE_TEAMS) {
      throw new UserError(ProCode.TOO_MANY_TEAMS, `Pick up to ${MAX_FAVOURITE_TEAMS} teams.`);
    }
    const found = await teamsByIds(ids);
    if (found.size !== ids.length) throw new UserError(ProCode.TEAM_NOT_FOUND, 'One of those teams is no longer there.');
    await db.$transaction([
      db.proTeamFan.deleteMany({ where: { userId, teamId: { notIn: ids } } }),
      db.proTeamFan.createMany({ data: ids.map((teamId) => ({ userId, teamId })), skipDuplicates: true }),
    ]);
    return favouriteTeams(userId);
  }

  return {
    teams,
    teamsByIds,
    saveTeam,
    match,
    requireMatch,
    matchesByIds,
    board,
    staffList,
    createMatch,
    updateMatch,
    releaseFeed,
    matchByProvider,
    feedWatchList,
    touchFeedChecked,
    feedTeam,
    addFeedMoment,
    deleteMatch,
    moments,
    addMoment,
    deleteMoment,
    chat,
    chatterCount,
    sendMessage,
    hideMessage,
    favouriteTeams,
    setFavouriteTeams,
  };
}

export type ProService = ReturnType<typeof createProService>;
