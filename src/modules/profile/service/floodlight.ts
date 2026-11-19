/**
 * profile — the Floodlight additions (redesign §4.13 Profile).
 *
 * profile R20 — the athlete label is self-declared ("State-level shuttler")
 *   and never verified. It is shown as the player wrote it, as an ATHLETE
 *   label; 1–40 characters; blank clears it.
 * profile R21 — "My records, added by you": the player's own claims (a title,
 *   a detail, a year). Shown on their profile marked as added by them,
 *   never mixed with records PL4Y computed from matches. At most 20.
 */
import type { Db } from '../../../platform/db.js';
import { UserError } from '../../../platform/errors/index.js';
import { newId } from '../../../platform/ids.js';

export const RecordCode = {
  INVALID_LABEL: 'INVALID_ATHLETE_LABEL',
  INVALID_RECORD: 'INVALID_RECORD',
  TOO_MANY: 'TOO_MANY_RECORDS',
  NO_PROFILE: 'PROFILE_NOT_FOUND',
} as const;

export const ATHLETE_LABEL_MAX = 40;
export const MAX_RECORDS = 20;

export interface ProfileRecord {
  id: string;
  playerId: string;
  sportId: string | null;
  title: string;
  detail: string | null;
  year: number | null;
  createdAt: Date;
}

export function createProfileExtras(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function ownProfileId(userId: string): Promise<string> {
    const row = await db.playerProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!row) throw new UserError(RecordCode.NO_PROFILE, 'Set up your profile first.');
    return row.id;
  }

  async function userIdOf(profileId: string): Promise<string | null> {
    return (await db.playerProfile.findUnique({ where: { id: profileId }, select: { userId: true } }))?.userId ?? null;
  }

  async function athleteLabels(profileIds: readonly string[]): Promise<Map<string, string | null>> {
    if (profileIds.length === 0) return new Map();
    const rows = await db.playerProfile.findMany({ where: { id: { in: [...profileIds] } }, select: { id: true, athleteLabel: true } });
    return new Map(rows.map((r) => [r.id, r.athleteLabel]));
  }

  /** profile R20. */
  async function setAthleteLabel(userId: string, raw: string | null): Promise<string | null> {
    const id = await ownProfileId(userId);
    const label = raw?.trim().replace(/\s+/g, ' ') || null;
    if (label && label.length > ATHLETE_LABEL_MAX) {
      throw new UserError(RecordCode.INVALID_LABEL, `Keep the athlete label under ${ATHLETE_LABEL_MAX} characters.`);
    }
    await db.playerProfile.update({ where: { id }, data: { athleteLabel: label, updatedAt: now() } });
    return label;
  }

  /**
   * "Athletes to follow" on Explore — never the viewer themself. Players who
   * call themselves athletes come first, newest label first; while few have
   * set a label (prod had none, 2026-11-19, so the row never showed), the list
   * is topped up with other public players who play a sport, most recently
   * active first.
   */
  async function athletes(filter: { sportId?: string | null; q?: string | null; first?: number; excludeUserId?: string | null }): Promise<string[]> {
    const q = filter.q?.trim();
    const take = Math.min(Math.max(filter.first ?? 10, 1), 30);
    const base = {
      visibility: { not: 'private' },
      ...(filter.excludeUserId ? { userId: { not: filter.excludeUserId } } : {}),
      ...(filter.sportId ? { sports: { some: { sportId: filter.sportId } } } : {}),
    };
    const labelled = await db.playerProfile.findMany({
      where: {
        ...base,
        athleteLabel: { not: null },
        ...(q ? { OR: [{ athleteLabel: { contains: q, mode: 'insensitive' } }, { user: { displayName: { contains: q, mode: 'insensitive' } } }] } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take,
      select: { id: true },
    });
    if (labelled.length >= take) return labelled.map((r) => r.id);
    const others = await db.playerProfile.findMany({
      where: {
        ...base,
        athleteLabel: null,
        ...(filter.sportId ? {} : { sports: { some: {} } }),
        ...(q ? { user: { displayName: { contains: q, mode: 'insensitive' } } } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: take - labelled.length,
      select: { id: true },
    });
    return [...labelled, ...others].map((r) => r.id);
  }

  async function records(profileId: string): Promise<ProfileRecord[]> {
    return db.profileRecord.findMany({ where: { playerId: profileId }, orderBy: [{ year: 'desc' }, { createdAt: 'desc' }] });
  }

  /** profile R21. */
  async function addRecord(userId: string, input: { sportId?: string | null; title: string; detail?: string | null; year?: number | null }): Promise<ProfileRecord> {
    const playerId = await ownProfileId(userId);
    const title = input.title.trim();
    if (title.length < 1 || title.length > 80) throw new UserError(RecordCode.INVALID_RECORD, 'A record is 1 to 80 characters.');
    const detail = input.detail?.trim() || null;
    if (detail && detail.length > 160) throw new UserError(RecordCode.INVALID_RECORD, 'The detail is at most 160 characters.');
    const year = input.year ?? null;
    const thisYear = now().getUTCFullYear();
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > thisYear)) {
      throw new UserError(RecordCode.INVALID_RECORD, `The year is between 1950 and ${thisYear}.`);
    }
    if ((await db.profileRecord.count({ where: { playerId } })) >= MAX_RECORDS) {
      throw new UserError(RecordCode.TOO_MANY, `Keep it to your best ${MAX_RECORDS} records.`);
    }
    return db.profileRecord.create({ data: { id: newId(), playerId, sportId: input.sportId ?? null, title, detail, year } });
  }

  /** The owner only; another player's record id is ignored. */
  async function deleteRecord(userId: string, recordId: string): Promise<void> {
    const playerId = await ownProfileId(userId);
    await db.profileRecord.deleteMany({ where: { id: recordId, playerId } });
  }

  return { userIdOf, athleteLabels, setAthleteLabel, athletes, records, addRecord, deleteRecord };
}

export type ProfileExtras = ReturnType<typeof createProfileExtras>;
