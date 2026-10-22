/**
 * communities — clubs, groups and teams (docs/modules/17-communities.md).
 *
 * Two independent choices at creation, visibility and access, give four
 * types: free public, free private, paid public, paid private. Who can find a
 * community, how they join and what they see all follow from those two.
 *
 * Rules, as the tests name them:
 *   R1  visibility and access are chosen at creation and fixed; paid ⇔ a price and a period
 *   R2  Discover lists public communities and private ones the creator listed
 *   R3  free public: join at once · private: request, an admin decides · invite link: free private joins, paid private skips approval
 *   R4  one open request per person; a request waits 30 days; an approval to pay waits 7
 *   R5  exactly one owner; the owner hands over before leaving; admins run members and requests
 *   R6  posts, chat and (private) the member list are for active members; a removed member stays out
 *   R7  caps: 5,000 members, 10 owned communities, ₹10 to ₹50,000
 *   R8  paid memberships (payments R20) — a later phase; paid joins refuse until then
 */
import { randomBytes } from 'node:crypto';
import type { Db, Tx } from '../../../platform/db.js';
import { UserError, forbidden, illegalTransition } from '../../../platform/errors/index.js';
import { cityVariants } from '../../../platform/city.js';
import { newId } from '../../../platform/ids.js';
import type { LimitResult, Window } from '../../../platform/rateLimit.js';
import { containsPattern } from '../../../platform/search.js';
import type {
  Access,
  Billing,
  CommunitiesRepo,
  CommunityRow,
  MemberStatus,
  RequestStatus,
  Role,
  SortKey,
  Visibility,
} from '../repo/index.js';

export type { Access, Billing, MemberStatus, RequestStatus, Role, SortKey, Visibility };
export type Community = CommunityRow;

export const CommunityCode = {
  COMMUNITY_NOT_FOUND: 'COMMUNITY_NOT_FOUND',
  INVALID_COMMUNITY: 'INVALID_COMMUNITY',
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  REQUEST_REQUIRED: 'REQUEST_REQUIRED',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  JOIN_REQUEST_PENDING: 'JOIN_REQUEST_PENDING',
  REQUEST_NOT_FOUND: 'REQUEST_NOT_FOUND',
  REMOVED_FROM_COMMUNITY: 'REMOVED_FROM_COMMUNITY',
  NOT_A_MEMBER: 'NOT_A_MEMBER',
  OWNER_MUST_TRANSFER: 'OWNER_MUST_TRANSFER',
  COMMUNITY_FULL: 'COMMUNITY_FULL',
  COMMUNITY_LIMIT: 'COMMUNITY_LIMIT',
  REQUEST_LIMIT: 'REQUEST_LIMIT',
} as const;

export interface Actor {
  userId: string;
}

export interface Membership {
  communityId: string;
  userId: string;
  role: Role;
  status: MemberStatus;
  paidUntil: Date | null;
  joinedAt: Date;
}

export interface JoinRequest {
  id: string;
  communityId: string;
  userId: string;
  status: RequestStatus;
  note: string | null;
  decidedAt: Date | null;
  approvalExpiresAt: Date | null;
  createdAt: Date;
}

/** What the card and the page decide their one button from. */
export type ViewerState = 'none' | 'requested' | 'approved_to_pay' | 'member' | 'expired' | 'removed';

export interface Viewer {
  state: ViewerState;
  role: Role | null;
  membership: Membership | null;
  /** The open request: waiting, or approved and waiting for the payment. */
  request: JoinRequest | null;
}

export interface CommunityInput {
  name: string;
  description?: string | null;
  sportId: string;
  city?: string | null;
  visibility: Visibility;
  discoverable?: boolean | null;
  access: Access;
  pricePaise?: number | null;
  billing?: Billing | null;
  benefits?: string[] | null;
}

/** R1 — visibility and access are not in here: they are fixed at creation. */
export interface CommunityPatch {
  name?: string;
  description?: string | null;
  sportId?: string;
  city?: string | null;
  coverPublicId?: string | null;
  discoverable?: boolean;
  pricePaise?: number;
  billing?: Billing;
  benefits?: string[];
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

type Template =
  | 'community.join_request'
  | 'community.request_approved'
  | 'community.request_rejected'
  | 'community.member_joined'
  | 'community.renewal_due'
  | 'community.membership_expired';

/** communities R8 — one period of one paid membership: the payment subject (payments R20). */
export interface CommunityPayment {
  id: string;
  communityId: string;
  userId: string;
  billing: Billing;
  pricePaise: bigint;
  commissionPaise: bigint;
  status: 'held' | 'paid' | 'expired' | 'refunded';
  holdExpiresAt: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  paidAt: Date | null;
}

export interface Earnings {
  paidCount: number;
  grossPaise: bigint;
  commissionPaise: bigint;
  netPaise: bigint;
  refundedCount: number;
}

export interface CommunitiesDeps {
  db: Db;
  repo: CommunitiesRepo;
  sport: { findById(sportId: string): Promise<{ id: string; name: string; active: boolean } | null> };
  users: { namesByIds(ids: string[]): Promise<Map<string, string>> };
  limiter: { consume(key: string, window: Window): Promise<LimitResult> };
  /** Best-effort: a notice that fails never fails the change it reports. */
  notify?(userIds: string[], template: Template, payload: Record<string, unknown>, communityId: string): Promise<void>;
  now?: () => Date;
}

export const NAME_MIN = 3;
export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 1000;
export const CITY_MAX = 60;
export const NOTE_MAX = 300;
export const BENEFITS_MAX = 6;
export const BENEFIT_MAX = 80;
/** R7 */
export const MAX_MEMBERS = 5000;
export const MAX_OWNED = 10;
export const PRICE_MIN_PAISE = 1_000;
export const PRICE_MAX_PAISE = 5_000_000;
/** R4 */
export const REQUEST_TTL_MS = 30 * 86_400_000;
export const APPROVAL_TTL_MS = 7 * 86_400_000;
export const REQUEST_WINDOW: Window = { seconds: 86_400, max: 30 };
/** R8 — PL4Y's share of each membership payment, in basis points. */
export const COMMISSION_BPS = 500n;
/** R8 — how long a checkout holds its price. Long enough for a UPI app round trip. */
export const PAYMENT_HOLD_MS = 30 * 60_000;
/** R8 — a member may renew in the last 7 days of a period, not before. */
export const RENEW_WINDOW_MS = 7 * 86_400_000;
/** R8 — the renewal reminder goes out this long before the period ends. */
export const RENEWAL_REMINDER_MS = 3 * 86_400_000;

/** R8 — 5% of the price, rounded up to the paisa; the creator keeps the rest. */
export const commissionOf = (pricePaise: bigint): bigint => (pricePaise * COMMISSION_BPS + 9_999n) / 10_000n;

/** One calendar month or year on, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function periodEndOf(start: Date, billing: Billing): Date | null {
  if (billing === 'one_time') return null;
  const months = billing === 'monthly' ? 1 : 12;
  const end = new Date(start.getTime());
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, last));
  return end;
}

/** R8 — active, and (for a paid period) not past its end, whether or not the sweep has run. */
export const isLive = (m: { status: string; paidUntil: Date | null } | null, at: Date): boolean =>
  m?.status === 'active' && (m.paidUntil === null || m.paidUntil > at);

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

const notFound = () => new UserError(CommunityCode.COMMUNITY_NOT_FOUND, 'That community could not be found.');
const invalid = (message: string) => new UserError(CommunityCode.INVALID_COMMUNITY, message);
const removed = () => new UserError(CommunityCode.REMOVED_FROM_COMMUNITY, 'An admin removed you from this community.');
const already = () => new UserError(CommunityCode.ALREADY_MEMBER, 'You are already a member.');
const requestGone = () => new UserError(CommunityCode.REQUEST_NOT_FOUND, 'That request has already been answered.');

/** "Delhi Football Lovers" → "delhi-football-lovers-k3x9". The suffix keeps two clubs of one name apart. */
export function slugFor(name: string, suffix = randomBytes(3).toString('hex').slice(0, 4)): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'community';
  return `${base}-${suffix}`;
}

/** Eight characters a person can read out: no 0/O, no 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function inviteCodeFor(bytes = randomBytes(8)): string {
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Cursor on (sort value, id) — conventions.md §4. Opaque to the client. */
export function communityCursor(c: { memberCount: number; lastActivityAt: Date; id: string }, sort: SortKey): string {
  const key = sort === 'popular' ? String(c.memberCount) : c.lastActivityAt.toISOString();
  return Buffer.from(`${sort}|${key}|${c.id}`).toString('base64url');
}

function decodeCursor(cursor: string, sort: SortKey): { key: string; id: string } | null {
  const [s, key, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (s !== sort || !key || !id) return null;
  if (sort === 'popular' ? !/^\d+$/.test(key) : Number.isNaN(new Date(key).getTime())) return null;
  return { key, id };
}

/**
 * R6, R8 — the state a viewer is in, from their membership row and their open
 * request. A paid period that has ended reads as expired at once, before the
 * daily sweep writes it.
 */
export function viewerStateOf(membership: Membership | null, request: JoinRequest | null, at: Date = new Date()): ViewerState {
  if (isLive(membership, at)) return 'member';
  if (membership?.status === 'removed') return 'removed';
  if (request?.status === 'approved') return 'approved_to_pay';
  if (request?.status === 'pending') return 'requested';
  if (membership?.status === 'expired' || membership?.status === 'active') return 'expired';
  return 'none';
}

const asMembership = (m: {
  communityId: string;
  userId: string;
  role: string;
  status: string;
  paidUntil: Date | null;
  joinedAt: Date;
}): Membership => ({ ...m, role: m.role as Role, status: m.status as MemberStatus });

const asRequest = (r: {
  id: string;
  communityId: string;
  userId: string;
  status: string;
  note: string | null;
  decidedAt: Date | null;
  approvalExpiresAt: Date | null;
  createdAt: Date;
}): JoinRequest => ({
  id: r.id,
  communityId: r.communityId,
  userId: r.userId,
  status: r.status as RequestStatus,
  note: r.note,
  decidedAt: r.decidedAt,
  approvalExpiresAt: r.approvalExpiresAt,
  createdAt: r.createdAt,
});

const asCommunity = (c: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sportId: string;
  city: string;
  coverPublicId: string | null;
  visibility: string;
  discoverable: boolean;
  access: string;
  pricePaise: bigint | null;
  billing: string | null;
  benefits: string[];
  inviteCode: string;
  memberCount: number;
  ownerUserId: string;
  lastActivityAt: Date;
  hiddenAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}): Community => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  description: c.description,
  sportId: c.sportId,
  city: c.city,
  coverPublicId: c.coverPublicId,
  visibility: c.visibility as Visibility,
  discoverable: c.discoverable,
  access: c.access as Access,
  pricePaise: c.pricePaise,
  billing: c.billing as Billing | null,
  benefits: c.benefits,
  inviteCode: c.inviteCode,
  memberCount: c.memberCount,
  ownerUserId: c.ownerUserId,
  lastActivityAt: c.lastActivityAt,
  hiddenAt: c.hiddenAt,
  deletedAt: c.deletedAt,
  createdAt: c.createdAt,
});

const OPEN: RequestStatus[] = ['pending', 'approved'];

export function createCommunitiesService(deps: CommunitiesDeps) {
  const { db, repo } = deps;
  const now = deps.now ?? (() => new Date());

  async function tell(userIds: string[], template: Template, payload: Record<string, unknown>, communityId: string): Promise<void> {
    if (!deps.notify || userIds.length === 0) return;
    await deps.notify([...new Set(userIds)], template, payload, communityId).catch(() => undefined);
  }

  async function nameOf(userId: string): Promise<string> {
    return (await deps.users.namesByIds([userId])).get(userId) ?? 'A player';
  }

  // --- validation ----------------------------------------------------------------

  async function checkSport(sportId: string): Promise<string> {
    const sport = await deps.sport.findById(sportId);
    if (!sport || !sport.active) throw invalid('Choose a sport.');
    return sport.id;
  }

  function checkName(raw: string): string {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (name.length < NAME_MIN || name.length > NAME_MAX) throw invalid(`A name is ${NAME_MIN} to ${NAME_MAX} characters.`);
    return name;
  }

  function checkDescription(raw: string | null | undefined): string | null {
    const text = raw?.trim() || null;
    if (text && text.length > DESCRIPTION_MAX) throw invalid(`The description can be up to ${DESCRIPTION_MAX} characters.`);
    return text;
  }

  function checkCity(raw: string | null | undefined): string {
    const city = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (city.length > CITY_MAX) throw invalid(`The city can be up to ${CITY_MAX} characters.`);
    return city;
  }

  /** R1, R7 — a paid community has a whole-rupee-or-paise price in range and a period. */
  function checkPrice(pricePaise: number | null | undefined): bigint {
    if (pricePaise == null || !Number.isInteger(pricePaise)) throw invalid('Set a membership price.');
    if (pricePaise < PRICE_MIN_PAISE || pricePaise > PRICE_MAX_PAISE) {
      throw invalid(`A membership costs ₹${PRICE_MIN_PAISE / 100} to ₹${(PRICE_MAX_PAISE / 100).toLocaleString('en-IN')}.`);
    }
    return BigInt(pricePaise);
  }

  function checkBilling(billing: Billing | null | undefined): Billing {
    if (billing !== 'one_time' && billing !== 'monthly' && billing !== 'yearly') {
      throw invalid('Choose one-time, monthly or yearly.');
    }
    return billing;
  }

  function checkBenefits(raw: string[] | null | undefined): string[] {
    const list = (raw ?? []).map((b) => b.trim().replace(/\s+/g, ' ')).filter((b) => b.length > 0);
    if (list.length > BENEFITS_MAX) throw invalid(`List up to ${BENEFITS_MAX} benefits.`);
    if (list.some((b) => b.length > BENEFIT_MAX)) throw invalid(`A benefit can be up to ${BENEFIT_MAX} characters.`);
    return list;
  }

  // --- reads -----------------------------------------------------------------------

  /** Deleted communities do not exist. Hidden ones are filtered by `visibleTo`. */
  async function findById(communityId: string): Promise<Community | null> {
    const row = await db.community.findFirst({ where: { id: communityId, deletedAt: null } });
    return row ? asCommunity(row) : null;
  }

  async function byIds(ids: string[]): Promise<Community[]> {
    if (ids.length === 0) return [];
    const rows = await db.community.findMany({ where: { id: { in: ids }, deletedAt: null } });
    const byId = new Map(rows.map((r) => [r.id, asCommunity(r)]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  async function membershipOf(communityId: string, userId: string): Promise<Membership | null> {
    const row = await db.communityMember.findUnique({ where: { communityId_userId: { communityId, userId } } });
    return row ? asMembership(row) : null;
  }

  /** One query each for memberships and open requests, however many communities a list holds. */
  async function viewers(communityIds: string[], userId: string | null): Promise<Map<string, Viewer>> {
    const out = new Map<string, Viewer>();
    if (!userId || communityIds.length === 0) {
      for (const id of communityIds) out.set(id, { state: 'none', role: null, membership: null, request: null });
      return out;
    }
    const [members, requests] = await Promise.all([
      db.communityMember.findMany({ where: { userId, communityId: { in: communityIds } } }),
      db.communityJoinRequest.findMany({ where: { userId, communityId: { in: communityIds }, status: { in: OPEN } } }),
    ]);
    const m = new Map(members.map((r) => [r.communityId, asMembership(r)]));
    const q = new Map(requests.map((r) => [r.communityId, asRequest(r)]));
    for (const id of communityIds) {
      const membership = m.get(id) ?? null;
      const request = q.get(id) ?? null;
      out.set(id, {
        state: viewerStateOf(membership, request, now()),
        role: isLive(membership, now()) ? membership!.role : null,
        membership,
        request,
      });
    }
    return out;
  }

  async function viewerOf(communityId: string, userId: string | null): Promise<Viewer> {
    return (await viewers([communityId], userId)).get(communityId)!;
  }

  /**
   * R2, R6 — whether this viewer may know the community exists. A private
   * community that is not listed is reached through its invite code, or by
   * someone it already knows (a member, or someone with a request in).
   */
  async function visibleTo(c: Community, userId: string | null, inviteCode?: string | null): Promise<boolean> {
    if (c.deletedAt) return false;
    if (c.hiddenAt) {
      // A hidden community stays readable to its own members, so they can see why.
      return userId ? (await membershipOf(c.id, userId))?.status === 'active' : false;
    }
    if (c.visibility === 'public' || c.discoverable) return true;
    if (inviteCode && inviteCode.toUpperCase() === c.inviteCode) return true;
    if (!userId) return false;
    const v = await viewerOf(c.id, userId);
    return v.state !== 'none';
  }

  /** The community page: by id, slug or invite code. Null for anyone it is not visible to. */
  async function lookup(
    by: { id?: string | null; slug?: string | null; inviteCode?: string | null },
    viewerUserId: string | null,
  ): Promise<Community | null> {
    const code = by.inviteCode?.trim().toUpperCase() || null;
    const row = by.id
      ? await db.community.findFirst({ where: { id: by.id, deletedAt: null } })
      : by.slug
        ? await db.community.findFirst({ where: { slug: by.slug, deletedAt: null } })
        : code
          ? await db.community.findFirst({ where: { inviteCode: code, deletedAt: null } })
          : null;
    if (!row) return null;
    const c = asCommunity(row);
    return (await visibleTo(c, viewerUserId, code)) ? c : null;
  }

  /** R6 — posts, chat and the like are for active members only, in every type. */
  async function isMember(communityId: string, userId: string | null): Promise<boolean> {
    if (!userId) return false;
    return isLive(await membershipOf(communityId, userId), now());
  }

  async function roleOf(communityId: string, userId: string | null): Promise<Role | null> {
    if (!userId) return null;
    const m = await membershipOf(communityId, userId);
    return isLive(m, now()) ? m!.role : null;
  }

  /** Discover: `sort` popular is most members first, recent is most recently active first. */
  async function search(
    filter: {
      text?: string | null;
      sportId?: string | null;
      city?: string | null;
      access?: Access | null;
      sort?: SortKey | null;
      notJoinedBy?: string | null;
    },
    page: { first: number; after?: string | null },
  ): Promise<Page<Community>> {
    const first = Math.min(Math.max(page.first, 1), 50);
    const sort = filter.sort ?? 'recent';
    const city = filter.city?.trim() ? cityVariants(filter.city) : null;
    const rows = await repo.search({
      sportId: filter.sportId ?? null,
      cityKeys: city,
      access: filter.access ?? null,
      pattern: containsPattern(filter.text),
      sort,
      notJoinedBy: filter.notJoinedBy ?? null,
      after: page.after ? decodeCursor(page.after, sort) : null,
      limit: first + 1,
    });
    const nodes = rows.slice(0, first);
    const last = nodes.at(-1);
    return { nodes, hasNextPage: rows.length > first, endCursor: last ? communityCursor(last, sort) : null };
  }

  /** Communities the user is an active member of, most recently active first. */
  async function listForUser(userId: string): Promise<Community[]> {
    const rows = await db.communityMember.findMany({ where: { userId, status: 'active' }, select: { communityId: true } });
    const list = await byIds(rows.map((r) => r.communityId));
    return list.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
  }

  /** The user's open requests, newest first. */
  async function requestsForUser(userId: string): Promise<JoinRequest[]> {
    const rows = await db.communityJoinRequest.findMany({
      where: { userId, status: { in: OPEN } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
    return rows.map(asRequest);
  }

  /** R6 — the member list: owner, admins, then members by join date. Members only for a private community. */
  async function members(
    c: Community,
    viewerUserId: string | null,
    page: { first: number; after?: string | null },
  ): Promise<Page<Membership>> {
    if (c.visibility === 'private' && !(await isMember(c.id, viewerUserId))) {
      return { nodes: [], hasNextPage: false, endCursor: null };
    }
    const first = Math.min(Math.max(page.first, 1), 50);
    const offset = page.after ? Math.max(Number.parseInt(Buffer.from(page.after, 'base64url').toString('utf8'), 10) || 0, 0) : 0;
    const rows = await db.communityMember.findMany({ where: { communityId: c.id, status: 'active' } });
    const sorted = rows
      .map(asMembership)
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.joinedAt.getTime() - b.joinedAt.getTime());
    const nodes = sorted.slice(offset, offset + first);
    const end = offset + nodes.length;
    return {
      nodes,
      hasNextPage: end < sorted.length,
      endCursor: nodes.length > 0 ? Buffer.from(String(end)).toString('base64url') : null,
    };
  }

  /** R5 — waiting requests, oldest first, and approvals waiting for a payment. Admins only. */
  async function joinRequests(actor: Actor, communityId: string): Promise<JoinRequest[]> {
    if (!isAdminRole(await roleOf(communityId, actor.userId))) return [];
    const rows = await db.communityJoinRequest.findMany({
      where: { communityId, status: { in: OPEN } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return rows.map(asRequest);
  }

  async function pendingCount(communityId: string): Promise<number> {
    return db.communityJoinRequest.count({ where: { communityId, status: 'pending' } });
  }

  async function requestById(requestId: string): Promise<JoinRequest | null> {
    const row = await db.communityJoinRequest.findUnique({ where: { id: requestId } });
    return row ? asRequest(row) : null;
  }

  // --- create and edit ---------------------------------------------------------------

  async function create(actor: Actor, input: CommunityInput): Promise<Community> {
    const name = checkName(input.name);
    const description = checkDescription(input.description);
    const sportId = await checkSport(input.sportId);
    const city = checkCity(input.city);
    if (input.visibility !== 'public' && input.visibility !== 'private') throw invalid('Choose public or private.');
    if (input.access !== 'free' && input.access !== 'paid') throw invalid('Choose free or paid.');
    const paid = input.access === 'paid';
    const pricePaise = paid ? checkPrice(input.pricePaise) : null;
    const billing = paid ? checkBilling(input.billing) : null;
    const benefits = checkBenefits(input.benefits);
    // R2 — a public community is always listed; the switch is for private ones.
    const discoverable = input.visibility === 'public' ? true : input.discoverable !== false;

    const owned = await db.community.count({ where: { ownerUserId: actor.userId, deletedAt: null } });
    if (owned >= MAX_OWNED) {
      throw new UserError(CommunityCode.COMMUNITY_LIMIT, `You can run up to ${MAX_OWNED} communities. Hand one over or delete one first.`);
    }

    const id = newId();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.$transaction(async (tx) => {
          await tx.community.create({
            data: {
              id,
              slug: slugFor(name),
              name,
              description,
              sportId,
              city,
              visibility: input.visibility,
              discoverable,
              access: input.access,
              pricePaise,
              billing,
              benefits,
              inviteCode: inviteCodeFor(),
              ownerUserId: actor.userId,
            },
          });
          // R5 — the creator is the owner and the first member.
          await tx.communityMember.create({ data: { communityId: id, userId: actor.userId, role: 'owner' } });
          await repo.recount(tx, id);
        });
        break;
      } catch (err) {
        // A slug or invite code collision: draw again, a few times.
        if (attempt < 3 && (err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
    }
    return (await findById(id))!;
  }

  function isAdminRole(role: Role | null): boolean {
    return role === 'owner' || role === 'admin';
  }

  async function requireAdmin(actor: Actor, communityId: string): Promise<Community> {
    const c = await findById(communityId);
    if (!c) throw notFound();
    if (!isAdminRole(await roleOf(communityId, actor.userId))) throw forbidden();
    return c;
  }

  async function requireOwner(actor: Actor, communityId: string): Promise<Community> {
    const c = await findById(communityId);
    if (!c) throw notFound();
    if ((await roleOf(communityId, actor.userId)) !== 'owner') throw forbidden();
    return c;
  }

  /** Admins edit. R1 — visibility and access stay as they were created. */
  async function update(actor: Actor, communityId: string, patch: CommunityPatch): Promise<Community> {
    const before = await requireAdmin(actor, communityId);
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = checkName(patch.name);
    if (patch.description !== undefined) data.description = checkDescription(patch.description);
    if (patch.sportId !== undefined) data.sportId = await checkSport(patch.sportId);
    if (patch.city !== undefined) data.city = checkCity(patch.city);
    if (patch.coverPublicId !== undefined) data.coverPublicId = patch.coverPublicId;
    if (patch.discoverable !== undefined) {
      if (before.visibility === 'public' && !patch.discoverable) throw invalid('A public community is always listed in Discover.');
      data.discoverable = before.visibility === 'public' ? true : patch.discoverable;
    }
    if (patch.pricePaise !== undefined || patch.billing !== undefined) {
      if (before.access !== 'paid') throw invalid('A free community has no price.');
      // A new price is what the next payment costs; nobody already paid is charged again.
      if (patch.pricePaise !== undefined) data.pricePaise = checkPrice(patch.pricePaise);
      if (patch.billing !== undefined) data.billing = checkBilling(patch.billing);
    }
    if (patch.benefits !== undefined) data.benefits = checkBenefits(patch.benefits);
    if (Object.keys(data).length > 0) {
      await db.community.update({ where: { id: communityId }, data: { ...data, updatedAt: now() } });
    }
    return (await findById(communityId))!;
  }

  /** R5 — the owner only. Gone from Discover and from every member's list. */
  async function remove(actor: Actor, communityId: string): Promise<void> {
    await requireOwner(actor, communityId);
    await db.community.update({ where: { id: communityId }, data: { deletedAt: now(), updatedAt: now() } });
  }

  async function resetInvite(actor: Actor, communityId: string): Promise<Community> {
    await requireAdmin(actor, communityId);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.community.update({ where: { id: communityId }, data: { inviteCode: inviteCodeFor(), updatedAt: now() } });
        break;
      } catch (err) {
        if (attempt < 3 && (err as { code?: string }).code === 'P2002') continue;
        throw err;
      }
    }
    return (await findById(communityId))!;
  }

  // --- join, request, leave ---------------------------------------------------------

  /** Makes the user an active member inside `tx`. The caller has the community locked. */
  async function admit(tx: Tx, c: Community, userId: string): Promise<number> {
    const count = await tx.communityMember.count({ where: { communityId: c.id, status: 'active' } });
    if (count >= MAX_MEMBERS) throw new UserError(CommunityCode.COMMUNITY_FULL, 'This community is full.');
    await tx.communityMember.upsert({
      where: { communityId_userId: { communityId: c.id, userId } },
      create: { communityId: c.id, userId, role: 'member' },
      update: { status: 'active', role: 'member', joinedAt: now(), updatedAt: now() },
    });
    await tx.communityJoinRequest.updateMany({
      where: { communityId: c.id, userId, status: { in: OPEN } },
      data: { status: 'joined', updatedAt: now() },
    });
    return repo.recount(tx, c.id);
  }

  async function lockLive(tx: Tx, communityId: string): Promise<Community> {
    const c = await repo.lock(tx, communityId);
    if (!c || c.deletedAt || c.hiddenAt) throw notFound();
    return c;
  }

  /**
   * R3 — a free public community, or a free private one opened with its invite
   * code: membership at once. A private community without the code takes a
   * request; a paid one takes a payment (R8).
   */
  async function join(actor: Actor, communityId: string, inviteCode?: string | null): Promise<Community> {
    const code = inviteCode?.trim().toUpperCase() || null;
    const { c, memberCount } = await db.$transaction(async (tx) => {
      const c = await lockLive(tx, communityId);
      const mine = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId, userId: actor.userId } } });
      if (mine?.status === 'active') throw already();
      if (mine?.status === 'removed') throw removed();
      const invited = code !== null && code === c.inviteCode;
      if (c.visibility === 'private' && !c.discoverable && !invited) throw notFound();
      if (c.access === 'paid') {
        throw new UserError(CommunityCode.PAYMENT_REQUIRED, 'This community is paid. Pay to join.');
      }
      if (c.visibility === 'private' && !invited) {
        throw new UserError(CommunityCode.REQUEST_REQUIRED, 'This community is private. Ask to join and an admin will decide.');
      }
      return { c, memberCount: await admit(tx, c, actor.userId) };
    });
    await tell(
      [c.ownerUserId].filter((u) => u !== actor.userId),
      'community.member_joined',
      { communityName: c.name, playerName: await nameOf(actor.userId), memberCount },
      c.id,
    );
    return (await findById(communityId))!;
  }

  /**
   * R3, R4 — ask to join a private community. With the invite code, a free one
   * lets you straight in and a paid one counts as approved: pay to join.
   */
  async function requestToJoin(
    actor: Actor,
    communityId: string,
    opts: { note?: string | null; inviteCode?: string | null } = {},
  ): Promise<{ community: Community; request: JoinRequest | null }> {
    const note = opts.note?.trim() || null;
    if (note && note.length > NOTE_MAX) throw invalid(`A note can be up to ${NOTE_MAX} characters.`);
    const code = opts.inviteCode?.trim().toUpperCase() || null;

    const pre = await findById(communityId);
    if (!pre || pre.hiddenAt) throw notFound();
    if (pre.visibility === 'public') {
      throw invalid(pre.access === 'paid' ? 'This community is open to everyone: pay to join.' : 'This community is open to everyone: join it.');
    }
    if (code !== null && code === pre.inviteCode && pre.access === 'free') {
      return { community: await join(actor, communityId, code), request: null };
    }
    const limit = await deps.limiter.consume(`communities:request:${actor.userId}`, REQUEST_WINDOW);
    if (!limit.allowed) {
      throw new UserError(CommunityCode.REQUEST_LIMIT, 'You have sent a lot of requests today. Try again tomorrow.', {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const { c, request } = await db.$transaction(async (tx) => {
      const c = await lockLive(tx, communityId);
      const invited = code !== null && code === c.inviteCode;
      if (!c.discoverable && !invited) throw notFound();
      const mine = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId, userId: actor.userId } } });
      if (mine?.status === 'active') throw already();
      if (mine?.status === 'removed') throw removed();
      const open = await tx.communityJoinRequest.findFirst({ where: { communityId, userId: actor.userId, status: { in: OPEN } } });
      if (open) {
        throw new UserError(CommunityCode.JOIN_REQUEST_PENDING, open.status === 'approved' ? 'You are approved. Pay to join.' : 'Your request is waiting for an admin.');
      }
      // The invite stands in for an admin's yes; the payment still makes the member.
      const approved = invited && c.access === 'paid';
      const row = await tx.communityJoinRequest.create({
        data: {
          id: newId(),
          communityId,
          userId: actor.userId,
          note,
          status: approved ? 'approved' : 'pending',
          decidedAt: approved ? now() : null,
          approvalExpiresAt: approved ? new Date(now().getTime() + APPROVAL_TTL_MS) : null,
        },
      });
      return { c, request: asRequest(row) };
    });

    if (request.status === 'pending') {
      const admins = await db.communityMember.findMany({
        where: { communityId, status: 'active', role: { in: ['owner', 'admin'] } },
        select: { userId: true },
      });
      await tell(
        admins.map((a) => a.userId),
        'community.join_request',
        { communityName: c.name, playerName: await nameOf(actor.userId) },
        c.id,
      );
    }
    return { community: (await findById(communityId))!, request };
  }

  /** The asker withdraws a waiting request, or an approval they will not pay for. */
  async function cancelRequest(actor: Actor, requestId: string): Promise<Community | null> {
    const req = await requestById(requestId);
    if (!req || req.userId !== actor.userId) throw requestGone();
    const moved = await db.communityJoinRequest.updateMany({
      where: { id: requestId, status: { in: OPEN } },
      data: { status: 'cancelled', updatedAt: now() },
    });
    if (moved.count === 0) throw requestGone();
    return findById(req.communityId);
  }

  /** R3, R4, R5 — an admin decides. A paid community's yes waits 7 days for the payment. */
  async function respond(actor: Actor, requestId: string, approve: boolean): Promise<JoinRequest> {
    const req = await requestById(requestId);
    if (!req) throw requestGone();
    const before = await requireAdmin(actor, req.communityId);

    const result = await db.$transaction(async (tx) => {
      const c = await lockLive(tx, req.communityId);
      const fresh = await tx.communityJoinRequest.findUnique({ where: { id: requestId } });
      if (!fresh || fresh.status !== 'pending') throw requestGone();
      const decided = { decidedBy: actor.userId, decidedAt: now(), updatedAt: now() };
      if (!approve) {
        await tx.communityJoinRequest.update({ where: { id: requestId }, data: { status: 'rejected', ...decided } });
        return 'rejected' as const;
      }
      if (c.access === 'paid') {
        await tx.communityJoinRequest.update({
          where: { id: requestId },
          data: { status: 'approved', approvalExpiresAt: new Date(now().getTime() + APPROVAL_TTL_MS), ...decided },
        });
        return 'approved_to_pay' as const;
      }
      const mine = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId: c.id, userId: req.userId } } });
      if (mine?.status === 'removed') {
        await tx.communityJoinRequest.update({ where: { id: requestId }, data: { status: 'rejected', ...decided } });
        return 'rejected' as const;
      }
      await tx.communityJoinRequest.update({ where: { id: requestId }, data: decided });
      await admit(tx, c, req.userId);
      return 'joined' as const;
    });

    if (result === 'rejected') {
      await tell([req.userId], 'community.request_rejected', { communityName: before.name }, before.id);
    } else {
      await tell([req.userId], 'community.request_approved', { communityName: before.name, mustPay: result === 'approved_to_pay' }, before.id);
    }
    return (await requestById(requestId))!;
  }

  /** R5 — anyone but the owner, who hands over first. */
  async function leave(actor: Actor, communityId: string): Promise<Community> {
    await db.$transaction(async (tx) => {
      await lockLive(tx, communityId);
      const mine = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId, userId: actor.userId } } });
      if (!mine || mine.status !== 'active') throw new UserError(CommunityCode.NOT_A_MEMBER, 'You are not a member of this community.');
      if (mine.role === 'owner') {
        throw new UserError(CommunityCode.OWNER_MUST_TRANSFER, 'You own this community. Hand it over to another member first, or delete it.');
      }
      await tx.communityMember.update({
        where: { communityId_userId: { communityId, userId: actor.userId } },
        data: { status: 'left', role: 'member', updatedAt: now() },
      });
      await repo.recount(tx, communityId);
    });
    return (await findById(communityId))!;
  }

  /** R5, R6 — admins remove members; only the owner removes an admin; nobody removes the owner. */
  async function removeMember(actor: Actor, communityId: string, userId: string): Promise<Community> {
    await requireAdmin(actor, communityId);
    if (userId === actor.userId) throw invalid('Leave the community instead.');
    await db.$transaction(async (tx) => {
      await lockLive(tx, communityId);
      const actorRole = (await tx.communityMember.findUnique({ where: { communityId_userId: { communityId, userId: actor.userId } } }))?.role;
      const target = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId, userId } } });
      if (!target || target.status !== 'active') throw new UserError(CommunityCode.NOT_A_MEMBER, 'That player is not a member.');
      if (target.role === 'owner' || (target.role === 'admin' && actorRole !== 'owner')) throw forbidden();
      await tx.communityMember.update({
        where: { communityId_userId: { communityId, userId } },
        data: { status: 'removed', role: 'member', updatedAt: now() },
      });
      await tx.communityJoinRequest.updateMany({
        where: { communityId, userId, status: { in: OPEN } },
        data: { status: 'cancelled', updatedAt: now() },
      });
      await repo.recount(tx, communityId);
    });
    return (await findById(communityId))!;
  }

  /** R5 — the owner makes members admins and back. */
  async function setRole(actor: Actor, communityId: string, userId: string, role: 'admin' | 'member'): Promise<Community> {
    await requireOwner(actor, communityId);
    const target = await membershipOf(communityId, userId);
    if (!target || target.status !== 'active') throw new UserError(CommunityCode.NOT_A_MEMBER, 'That player is not a member.');
    if (target.role === 'owner') throw invalid('Hand over ownership to change your own role.');
    await db.communityMember.update({ where: { communityId_userId: { communityId, userId } }, data: { role, updatedAt: now() } });
    return (await findById(communityId))!;
  }

  /** R5 — exactly one owner: the old owner becomes an admin in the same transaction. */
  async function transferOwnership(actor: Actor, communityId: string, userId: string): Promise<Community> {
    await requireOwner(actor, communityId);
    if (userId === actor.userId) return (await findById(communityId))!;
    await db.$transaction(async (tx) => {
      await lockLive(tx, communityId);
      const target = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId, userId } } });
      if (!target || target.status !== 'active') throw new UserError(CommunityCode.NOT_A_MEMBER, 'That player is not a member.');
      // The old owner steps down first: the one-owner index would refuse two at once.
      await tx.communityMember.update({
        where: { communityId_userId: { communityId, userId: actor.userId } },
        data: { role: 'admin', updatedAt: now() },
      });
      // R8 — the owner never pays for their own community: a paid period stops mattering.
      await tx.communityMember.update({
        where: { communityId_userId: { communityId, userId } },
        data: { role: 'owner', paidUntil: null, renewalRemindedAt: null, updatedAt: now() },
      });
      await tx.community.update({ where: { id: communityId }, data: { ownerUserId: userId, updatedAt: now() } });
    });
    return (await findById(communityId))!;
  }

  // --- paid memberships (R8) ---------------------------------------------------------

  const asPayment = (r: {
    id: string;
    communityId: string;
    userId: string;
    billing: string;
    pricePaise: bigint;
    commissionPaise: bigint;
    status: string;
    holdExpiresAt: Date;
    periodStart: Date | null;
    periodEnd: Date | null;
    paidAt: Date | null;
  }): CommunityPayment => ({
    id: r.id,
    communityId: r.communityId,
    userId: r.userId,
    billing: r.billing as Billing,
    pricePaise: r.pricePaise,
    commissionPaise: r.commissionPaise,
    status: r.status as CommunityPayment['status'],
    holdExpiresAt: r.holdExpiresAt,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    paidAt: r.paidAt,
  });

  /**
   * R8 — the checkout's subject: a held period at the community's price now.
   * Paid public: anyone. Paid private: someone an admin approved (or who came
   * with the invite), or a past member renewing. A live member may renew only
   * in the last 7 days of a period. One held checkout per member, reused.
   */
  async function startPayment(actor: Actor, communityId: string): Promise<CommunityPayment> {
    const c = await findById(communityId);
    if (!c || c.hiddenAt) throw notFound();
    if (c.access !== 'paid' || c.pricePaise === null || c.billing === null) throw invalid('This community is free: join it.');
    const at = now();
    const mine = await membershipOf(communityId, actor.userId);
    if (mine?.status === 'removed') throw removed();
    if (isLive(mine, at)) {
      if (mine!.paidUntil === null) throw already();
      if (mine!.paidUntil.getTime() - at.getTime() > RENEW_WINDOW_MS) {
        throw new UserError(CommunityCode.ALREADY_MEMBER, 'Your membership is paid up. You can renew in its last 7 days.');
      }
    } else {
      const pastMember = mine !== null && (mine.status === 'active' || mine.status === 'expired');
      if (c.visibility === 'private' && !pastMember) {
        const approved = await db.communityJoinRequest.findFirst({
          where: { communityId, userId: actor.userId, status: 'approved', approvalExpiresAt: { gt: at } },
        });
        if (!approved) throw new UserError(CommunityCode.REQUEST_REQUIRED, 'This community is private. Ask to join first.');
      }
      if (c.memberCount >= MAX_MEMBERS) throw new UserError(CommunityCode.COMMUNITY_FULL, 'This community is full.');
    }

    const held = await db.communityPayment.findFirst({ where: { communityId, userId: actor.userId, status: 'held' } });
    if (held && held.holdExpiresAt > at && held.pricePaise === c.pricePaise && held.billing === c.billing) {
      return asPayment(held);
    }
    if (held) await db.communityPayment.update({ where: { id: held.id }, data: { status: 'expired', updatedAt: at } });
    try {
      const row = await db.communityPayment.create({
        data: {
          id: newId(),
          communityId,
          userId: actor.userId,
          billing: c.billing,
          pricePaise: c.pricePaise,
          commissionPaise: commissionOf(c.pricePaise),
          holdExpiresAt: new Date(at.getTime() + PAYMENT_HOLD_MS),
        },
      });
      return asPayment(row);
    } catch (err) {
      // Two taps at once: the other one's held row is the checkout.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      const other = await db.communityPayment.findFirst({ where: { communityId, userId: actor.userId, status: 'held' } });
      if (!other) throw err;
      return asPayment(other);
    }
  }

  /** payments R20 — what payments needs to open an order for a held period. */
  async function forPayments(communityPaymentId: string): Promise<CommunityPayment & { communityName: string }> {
    const row = await db.communityPayment.findUnique({ where: { id: communityPaymentId }, include: { community: { select: { name: true } } } });
    if (!row) throw illegalTransition('missing', 'paid');
    return { ...asPayment(row), communityName: row.community.name };
  }

  /** While the gateway sheet is open, the price stays held. */
  async function extendHold(communityPaymentId: string, minutes: number): Promise<void> {
    const until = new Date(now().getTime() + minutes * 60_000);
    await db.communityPayment.updateMany({
      where: { id: communityPaymentId, status: 'held', holdExpiresAt: { lt: until } },
      data: { holdExpiresAt: until, updatedAt: now() },
    });
  }

  /**
   * payments R20 — a verified capture makes the member. Idempotent: a second
   * delivery for a paid period changes nothing. A capture that cannot become a
   * membership (the community deleted or hidden, the payer removed, the
   * community full) throws an illegal transition, and payments refunds it.
   */
  async function confirmFromPayment(input: { communityPaymentId: string; paymentId: string }): Promise<{ confirmedNow: boolean }> {
    const row0 = await db.communityPayment.findUnique({ where: { id: input.communityPaymentId } });
    if (!row0) throw illegalTransition('missing', 'paid');
    const result = await db.$transaction(async (tx) => {
      const c = await repo.lock(tx, row0.communityId);
      if (!c || c.deletedAt || c.hiddenAt) throw illegalTransition('gone', 'paid');
      const row = await tx.communityPayment.findUnique({ where: { id: input.communityPaymentId } });
      if (!row) throw illegalTransition('missing', 'paid');
      if (row.status === 'paid') return { confirmedNow: false, joined: false, c };
      if (row.status === 'refunded') throw illegalTransition('refunded', 'paid');
      const at = now();
      const mine = await tx.communityMember.findUnique({ where: { communityId_userId: { communityId: c.id, userId: row.userId } } });
      if (mine?.status === 'removed') throw illegalTransition('removed', 'paid');
      const live = isLive(mine, at);
      if (!live && (await tx.communityMember.count({ where: { communityId: c.id, status: 'active' } })) >= MAX_MEMBERS) {
        throw illegalTransition('full', 'paid');
      }
      // A renewal starts where the current period ends; anything else starts now.
      const start = live && mine!.paidUntil && mine!.paidUntil > at ? mine!.paidUntil : at;
      const end = periodEndOf(start, row.billing as Billing);
      await tx.communityMember.upsert({
        where: { communityId_userId: { communityId: c.id, userId: row.userId } },
        create: { communityId: c.id, userId: row.userId, role: 'member', paidUntil: end },
        update: {
          status: 'active',
          paidUntil: end,
          renewalRemindedAt: null,
          updatedAt: at,
          ...(live ? {} : { role: 'member', joinedAt: at }),
        },
      });
      await tx.communityPayment.update({
        where: { id: row.id },
        data: { status: 'paid', paymentId: input.paymentId, paidAt: at, periodStart: start, periodEnd: end, updatedAt: at },
      });
      await tx.communityJoinRequest.updateMany({
        where: { communityId: c.id, userId: row.userId, status: { in: OPEN } },
        data: { status: 'joined', updatedAt: at },
      });
      const memberCount = await repo.recount(tx, c.id);
      return { confirmedNow: true, joined: !live, c, memberCount, userId: row.userId };
    });
    if (result.joined && 'userId' in result) {
      await tell(
        [result.c.ownerUserId].filter((u) => u !== result.userId),
        'community.member_joined',
        { communityName: result.c.name, playerName: await nameOf(result.userId!), memberCount: result.memberCount },
        result.c.id,
      );
    }
    return { confirmedNow: result.confirmedNow };
  }

  // --- PL4Y staff (R10) ----------------------------------------------------------------

  /** Staff hide a community (it leaves Discover; members still see it, flagged) or show it again. */
  async function setHiddenByStaff(communityId: string, hidden: boolean): Promise<Community> {
    const row = await db.community.findFirst({ where: { id: communityId, deletedAt: null } });
    if (!row) throw notFound();
    await db.community.update({ where: { id: communityId }, data: { hiddenAt: hidden ? (row.hiddenAt ?? now()) : null, updatedAt: now() } });
    return (await findById(communityId))!;
  }

  /** Staff take a post out of a feed. Null when it was already gone. */
  async function hidePostByStaff(postId: string): Promise<{ id: string; communityId: string } | null> {
    const row = await db.communityPost.findUnique({ where: { id: postId } });
    if (!row || row.deletedAt || row.hiddenAt) return null;
    await db.communityPost.update({ where: { id: postId }, data: { hiddenAt: now(), pinnedAt: null } });
    return { id: row.id, communityId: row.communityId };
  }

  /** Staff: every community, hidden and unlisted ones too, by name; newest first. */
  async function searchForStaff(text: string | null, first: number): Promise<Community[]> {
    const term = text?.trim() || null;
    const rows = await db.community.findMany({
      where: { deletedAt: null, ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(first, 1), 100),
    });
    return rows.map(asCommunity);
  }

  /** A failed attempt changes nothing: the held period lapses by itself, and a retry reuses it. */
  async function failFromPayment(_input: { communityPaymentId: string; paymentId: string; reason: string }): Promise<void> {}

  /** The viewer's latest checkout for this community, for the app's "did it go through?" refresh. */
  async function latestPaymentOf(communityId: string, userId: string): Promise<CommunityPayment | null> {
    const row = await db.communityPayment.findFirst({
      where: { communityId, userId, status: { in: ['held', 'paid'] } },
      orderBy: { createdAt: 'desc' },
    });
    return row ? asPayment(row) : null;
  }

  /** The viewer's own paid membership: until when it runs. Null for free memberships and owners. */
  async function paidUntilOf(communityId: string, userId: string | null): Promise<Date | null> {
    if (!userId) return null;
    return (await membershipOf(communityId, userId))?.paidUntil ?? null;
  }

  /** R8 — the creator's earnings: what members paid, PL4Y's 5%, and the rest. The owner only. */
  async function earnings(actor: Actor, communityId: string): Promise<Earnings | null> {
    if ((await roleOf(communityId, actor.userId)) !== 'owner') return null;
    const [paid, refundedCount] = await Promise.all([
      db.communityPayment.aggregate({
        where: { communityId, status: 'paid' },
        _count: { _all: true },
        _sum: { pricePaise: true, commissionPaise: true },
      }),
      db.communityPayment.count({ where: { communityId, status: 'refunded' } }),
    ]);
    const gross = paid._sum.pricePaise ?? 0n;
    const commission = paid._sum.commissionPaise ?? 0n;
    return { paidCount: paid._count._all, grossPaise: gross, commissionPaise: commission, netPaise: gross - commission, refundedCount };
  }

  // --- the sweep (R4, R8) ---------------------------------------------------------------

  /**
   * Daily. Waiting requests lapse after 30 days; approvals to pay after 7.
   * Unpaid checkouts lapse; paid periods that ended expire the membership;
   * periods ending within 3 days get one reminder, claimed before it is sent.
   */
  async function sweep(): Promise<{
    expiredRequests: number;
    expiredApprovals: number;
    expiredHolds: number;
    expiredMembers: number;
    reminded: number;
  }> {
    const at = now();
    const { count: expiredRequests } = await db.communityJoinRequest.updateMany({
      where: { status: 'pending', createdAt: { lte: new Date(at.getTime() - REQUEST_TTL_MS) } },
      data: { status: 'expired', updatedAt: at },
    });
    const { count: expiredApprovals } = await db.communityJoinRequest.updateMany({
      where: { status: 'approved', approvalExpiresAt: { lte: at } },
      data: { status: 'expired', updatedAt: at },
    });
    const { count: expiredHolds } = await db.communityPayment.updateMany({
      where: { status: 'held', holdExpiresAt: { lte: at } },
      data: { status: 'expired', updatedAt: at },
    });

    const ended = await db.communityMember.findMany({
      where: { status: 'active', paidUntil: { lte: at }, role: { not: 'owner' } },
      include: { community: { select: { name: true } } },
      take: 1000,
    });
    let expiredMembers = 0;
    for (const m of ended) {
      const moved = await db.$transaction(async (tx) => {
        const r = await tx.communityMember.updateMany({
          where: { communityId: m.communityId, userId: m.userId, status: 'active', paidUntil: { lte: at } },
          data: { status: 'expired', role: 'member', updatedAt: at },
        });
        if (r.count > 0) await repo.recount(tx, m.communityId);
        return r.count;
      });
      if (moved === 0) continue;
      expiredMembers += 1;
      await tell([m.userId], 'community.membership_expired', { communityName: m.community.name }, m.communityId);
    }

    const due = await db.communityMember.findMany({
      where: { status: 'active', renewalRemindedAt: null, paidUntil: { gt: at, lte: new Date(at.getTime() + RENEWAL_REMINDER_MS) } },
      include: { community: { select: { name: true } } },
      take: 1000,
    });
    let reminded = 0;
    for (const m of due) {
      const claimed = await db.communityMember.updateMany({
        where: { communityId: m.communityId, userId: m.userId, renewalRemindedAt: null },
        data: { renewalRemindedAt: at },
      });
      if (claimed.count === 0) continue;
      reminded += 1;
      await tell([m.userId], 'community.renewal_due', { communityName: m.community.name, endsAt: m.paidUntil!.toISOString() }, m.communityId);
    }
    return { expiredRequests, expiredApprovals, expiredHolds, expiredMembers, reminded };
  }

  return {
    findById,
    byIds,
    lookup,
    visibleTo,
    viewers,
    viewerOf,
    isMember,
    roleOf,
    search,
    listForUser,
    requestsForUser,
    members,
    joinRequests,
    pendingCount,
    requestById,
    create,
    update,
    remove,
    resetInvite,
    join,
    requestToJoin,
    cancelRequest,
    respond,
    leave,
    removeMember,
    setRole,
    transferOwnership,
    startPayment,
    forPayments,
    extendHold,
    confirmFromPayment,
    failFromPayment,
    setHiddenByStaff,
    hidePostByStaff,
    searchForStaff,
    latestPaymentOf,
    paidUntilOf,
    earnings,
    sweep,
  };
}

export type CommunitiesService = ReturnType<typeof createCommunitiesService>;
