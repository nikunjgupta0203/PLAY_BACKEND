/**
 * communities — Prisma queries and raw SQL (conventions.md §1).
 *
 * Discover is raw SQL: its filters (city variants, a name search) and its two
 * orders with keyset cursors read better as one statement than as Prisma's
 * nested ORs.
 */
import { Prisma } from '@prisma/client';
import type { Db, Tx } from '../../../platform/db.js';

export type Visibility = 'public' | 'private';
export type Access = 'free' | 'paid';
export type Billing = 'one_time' | 'monthly' | 'yearly';
export type Role = 'owner' | 'admin' | 'member';
export type MemberStatus = 'active' | 'left' | 'removed' | 'expired';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'joined';
export type SortKey = 'recent' | 'popular';

export interface CommunityRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sportId: string;
  city: string;
  coverPublicId: string | null;
  visibility: Visibility;
  discoverable: boolean;
  access: Access;
  pricePaise: bigint | null;
  billing: Billing | null;
  benefits: string[];
  inviteCode: string;
  memberCount: number;
  ownerUserId: string;
  lastActivityAt: Date;
  hiddenAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface SearchFilter {
  sportId: string | null;
  /** Every stored spelling of the city (platform/city.ts). */
  cityKeys: string[] | null;
  access: Access | null;
  /** An ILIKE pattern from platform/search.ts. */
  pattern: string | null;
  sort: SortKey;
  /** Leave out communities this user is an active member of. */
  notJoinedBy: string | null;
  /** The last row of the previous page: its sort value and id. */
  after: { key: string; id: string } | null;
  limit: number;
}

const COLUMNS = Prisma.sql`
  c.id, c.slug, c.name, c.description, c.sport_id AS "sportId", c.city,
  c.cover_public_id AS "coverPublicId", c.visibility, c.discoverable, c.access,
  c.price_paise AS "pricePaise", c.billing, c.benefits, c.invite_code AS "inviteCode",
  c.member_count AS "memberCount", c.owner_user_id AS "ownerUserId",
  c.last_activity_at AS "lastActivityAt", c.hidden_at AS "hiddenAt",
  c.deleted_at AS "deletedAt", c.created_at AS "createdAt"`;

export function createCommunitiesRepo(db: Db) {
  return {
    /** R2 — public, or private and listed; never hidden or deleted. */
    async search(f: SearchFilter): Promise<CommunityRow[]> {
      const where: Prisma.Sql[] = [
        Prisma.sql`c.hidden_at IS NULL`,
        Prisma.sql`c.deleted_at IS NULL`,
        Prisma.sql`(c.visibility = 'public' OR c.discoverable)`,
      ];
      if (f.sportId) where.push(Prisma.sql`c.sport_id = ${f.sportId}::uuid`);
      if (f.cityKeys && f.cityKeys.length > 0) {
        where.push(Prisma.sql`lower(regexp_replace(trim(c.city), '\\s+', ' ', 'g')) IN (${Prisma.join(f.cityKeys)})`);
      }
      if (f.access) where.push(Prisma.sql`c.access = ${f.access}`);
      if (f.pattern) where.push(Prisma.sql`c.name ILIKE ${f.pattern}`);
      if (f.notJoinedBy) {
        where.push(Prisma.sql`NOT EXISTS (
          SELECT 1 FROM community_members m
          WHERE m.community_id = c.id AND m.user_id = ${f.notJoinedBy}::uuid AND m.status = 'active')`);
      }
      if (f.after) {
        where.push(
          f.sort === 'popular'
            ? Prisma.sql`(c.member_count, c.id) < (${Number(f.after.key)}::int, ${f.after.id}::uuid)`
            : Prisma.sql`(c.last_activity_at, c.id) < (${new Date(f.after.key)}::timestamptz, ${f.after.id}::uuid)`,
        );
      }
      const order =
        f.sort === 'popular' ? Prisma.sql`c.member_count DESC, c.id DESC` : Prisma.sql`c.last_activity_at DESC, c.id DESC`;
      return db.$queryRaw<CommunityRow[]>`
        SELECT ${COLUMNS} FROM communities c
        WHERE ${Prisma.join(where, ' AND ')}
        ORDER BY ${order}
        LIMIT ${f.limit}`;
    },

    /** Serialises joins, approvals and role changes on one community. */
    async lock(tx: Tx, communityId: string): Promise<CommunityRow | null> {
      const rows = await tx.$queryRaw<CommunityRow[]>`
        SELECT ${COLUMNS} FROM communities c WHERE c.id = ${communityId}::uuid FOR UPDATE`;
      return rows[0] ?? null;
    },

    /** member_count is the active members, recounted inside the change that moved it. */
    async recount(tx: Tx, communityId: string): Promise<number> {
      const rows = await tx.$queryRaw<{ memberCount: number }[]>`
        UPDATE communities SET
          member_count = (SELECT count(*)::int FROM community_members
                          WHERE community_id = ${communityId}::uuid AND status = 'active'),
          last_activity_at = now(),
          updated_at = now()
        WHERE id = ${communityId}::uuid
        RETURNING member_count AS "memberCount"`;
      return rows[0]?.memberCount ?? 0;
    },
  };
}

export type CommunitiesRepo = ReturnType<typeof createCommunitiesRepo>;
