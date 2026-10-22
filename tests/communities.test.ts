/**
 * communities — service tests against a real Postgres (conventions.md §5).
 * Every numbered rule has a test that names it: `grep 'R3:'` finds communities R3.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';
import { buildModules } from './helpers/modules.js';
import type { Db } from '../src/platform/db.js';
import { isUserError } from '../src/platform/errors/index.js';
import { newId } from '../src/platform/ids.js';
import { createCommunitiesRepo } from '../src/modules/communities/repo/index.js';
import {
  APPROVAL_TTL_MS,
  CommunityCode,
  createCommunitiesService,
  MAX_OWNED,
  REQUEST_TTL_MS,
  inviteCodeFor,
  slugFor,
  type CommunitiesService,
  type CommunityInput,
} from '../src/modules/communities/service/index.js';
import { FOOTBALL, PICKLEBALL, seedSport } from '../src/modules/sport/seed.js';
import { createCommunityFeed, FeedCode } from '../src/modules/communities/service/feed.js';

let prisma: PrismaClient;
let modules: ReturnType<typeof buildModules>;
let svc: CommunitiesService;
let clock: Date;
let football: string;
let pickleball: string;
const notices: { userId: string; template: string; payload: Record<string, unknown> }[] = [];


async function user(name: string): Promise<{ userId: string }> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, email: `${name}-${userId}@example.com`.toLowerCase(), displayName: name },
  });
  return { userId };
}

const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    if (isUserError(e)) return e.code;
    return (e as { extensions?: { code?: string } }).extensions?.code ?? `THREW: ${String(e)}`;
  }
  return 'NO_ERROR';
};

function input(over: Partial<CommunityInput> = {}): CommunityInput {
  return { name: 'Delhi Football Lovers', sportId: football, city: 'Delhi', visibility: 'public', access: 'free', ...over };
}

const paidInput = (over: Partial<CommunityInput> = {}) =>
  input({ name: 'Delhi Football Training Club', access: 'paid', pricePaise: 49_900, billing: 'monthly', ...over });

const sentTo = (template: string): string[] => notices.filter((n) => n.template === template).map((n) => n.userId);

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  modules = buildModules(prisma);
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await truncateAll(prisma);
  modules.sport.refresh();
  notices.length = 0;
  clock = new Date('2026-10-22T04:30:00.000Z');
  football = await seedSport(prisma, FOOTBALL);
  pickleball = await seedSport(prisma, PICKLEBALL);
  modules.sport.refresh();
  const db = prisma as unknown as Db;
  svc = createCommunitiesService({
    db,
    repo: createCommunitiesRepo(db),
    sport: { findById: (id) => modules.sport.byId(id).catch(() => null) },
    users: {
      async namesByIds(ids) {
        const rows = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
        return new Map(rows.map((r) => [r.id, r.displayName]));
      },
    },
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
    async notify(userIds, template, payload) {
      for (const userId of userIds) notices.push({ userId, template, payload });
    },
    now: () => clock,
  });
});

describe('creating', () => {
  it('R1: a paid community needs a price in range and a period; a free one keeps neither', async () => {
    const owner = await user('Asha');
    expect(await codeOf(() => svc.create(owner, input({ access: 'paid' })))).toBe(CommunityCode.INVALID_COMMUNITY);
    expect(await codeOf(() => svc.create(owner, paidInput({ billing: null })))).toBe(CommunityCode.INVALID_COMMUNITY);
    expect(await codeOf(() => svc.create(owner, paidInput({ pricePaise: 500 })))).toBe(CommunityCode.INVALID_COMMUNITY);
    expect(await codeOf(() => svc.create(owner, paidInput({ pricePaise: 6_000_000 })))).toBe(CommunityCode.INVALID_COMMUNITY);

    const paid = await svc.create(owner, paidInput({ benefits: ['Weekly coaching', '  ', 'Kit discount'] }));
    expect(paid.pricePaise).toBe(49_900n);
    expect(paid.billing).toBe('monthly');
    expect(paid.benefits).toEqual(['Weekly coaching', 'Kit discount']);

    const free = await svc.create(owner, input({ pricePaise: 49_900, billing: 'monthly' }));
    expect(free.pricePaise).toBeNull();
    expect(free.billing).toBeNull();
  });

  it('R1: visibility and access stay as created; a public community cannot be unlisted', async () => {
    const owner = await user('Asha');
    const c = await svc.create(owner, input());
    expect(await codeOf(() => svc.update(owner, c.id, { discoverable: false }))).toBe(CommunityCode.INVALID_COMMUNITY);
    expect(await codeOf(() => svc.update(owner, c.id, { pricePaise: 10_000 }))).toBe(CommunityCode.INVALID_COMMUNITY);
    const renamed = await svc.update(owner, c.id, { name: '  Delhi   Football Fans ', city: 'New Delhi' });
    expect(renamed.name).toBe('Delhi Football Fans');
    expect(renamed.city).toBe('New Delhi');
  });

  it('R5: the creator is the owner and first member', async () => {
    const owner = await user('Asha');
    const c = await svc.create(owner, input());
    expect(c.memberCount).toBe(1);
    expect(c.ownerUserId).toBe(owner.userId);
    expect((await svc.viewerOf(c.id, owner.userId)).role).toBe('owner');
    expect((await svc.listForUser(owner.userId)).map((x) => x.id)).toEqual([c.id]);
  });

  it('R7: a user owns at most 10 communities', async () => {
    const owner = await user('Asha');
    for (let i = 0; i < MAX_OWNED; i += 1) await svc.create(owner, input({ name: `Club number ${i}` }));
    expect(await codeOf(() => svc.create(owner, input({ name: 'One too many' })))).toBe(CommunityCode.COMMUNITY_LIMIT);
  });

  it('slugs and invite codes are readable and distinct', () => {
    expect(slugFor('Délhi  Football Lovers!', 'ab12')).toBe('delhi-football-lovers-ab12');
    expect(slugFor('🔥🔥', 'ab12')).toBe('community-ab12');
    expect(inviteCodeFor()).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });
});

describe('discover', () => {
  it('R2: lists public and listed private communities, never unlisted, hidden or deleted ones', async () => {
    const owner = await user('Asha');
    const pub = await svc.create(owner, input({ name: 'Public club' }));
    const listed = await svc.create(owner, input({ name: 'Listed private', visibility: 'private' }));
    await svc.create(owner, input({ name: 'Unlisted private', visibility: 'private', discoverable: false }));
    const hidden = await svc.create(owner, input({ name: 'Hidden club' }));
    await prisma.community.update({ where: { id: hidden.id }, data: { hiddenAt: clock } });
    const gone = await svc.create(owner, input({ name: 'Deleted club' }));
    await svc.remove(owner, gone.id);

    const page = await svc.search({}, { first: 20 });
    expect(page.nodes.map((c) => c.id).sort()).toEqual([pub.id, listed.id].sort());
  });

  it('R2: filters by sport, city spelling, free or paid, and name; popular pages by member count', async () => {
    const owner = await user('Asha');
    const a = await svc.create(owner, input({ name: 'Gurgaon Pickleball Club', sportId: pickleball, city: 'Gurgaon' }));
    const b = await svc.create(owner, paidInput({ city: 'delhi' }));
    const c = await svc.create(owner, input({ name: 'Saket Sunday Football', city: 'Delhi' }));
    for (const name of ['Ravi', 'Meera']) await svc.join(await user(name), c.id);

    expect((await svc.search({ sportId: pickleball }, { first: 20 })).nodes.map((x) => x.id)).toEqual([a.id]);
    expect((await svc.search({ city: 'Gurugram' }, { first: 20 })).nodes.map((x) => x.id)).toEqual([a.id]);
    expect((await svc.search({ city: 'New Delhi' }, { first: 20 })).nodes.map((x) => x.id).sort()).toEqual([b.id, c.id].sort());
    expect((await svc.search({ access: 'paid' }, { first: 20 })).nodes.map((x) => x.id)).toEqual([b.id]);
    expect((await svc.search({ text: 'sunday' }, { first: 20 })).nodes.map((x) => x.id)).toEqual([c.id]);

    const first = await svc.search({ sort: 'popular' }, { first: 1 });
    expect(first.nodes.map((x) => x.id)).toEqual([c.id]);
    expect(first.hasNextPage).toBe(true);
    const rest = await svc.search({ sort: 'popular' }, { first: 5, after: first.endCursor });
    expect(rest.nodes.map((x) => x.id)).not.toContain(c.id);
    expect(rest.nodes).toHaveLength(2);
  });

  it('R2: notJoined leaves out communities the viewer is in', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const a = await svc.create(owner, input({ name: 'Club A' }));
    const b = await svc.create(owner, input({ name: 'Club B' }));
    await svc.join(ravi, a.id);
    expect((await svc.search({ notJoinedBy: ravi.userId }, { first: 20 })).nodes.map((x) => x.id)).toEqual([b.id]);
  });

  it('R2: an unlisted private community is found by its invite code, or by someone it knows', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input({ visibility: 'private', discoverable: false }));
    expect(await svc.lookup({ id: c.id }, ravi.userId)).toBeNull();
    expect(await svc.lookup({ slug: c.slug }, ravi.userId)).toBeNull();
    expect((await svc.lookup({ inviteCode: c.inviteCode.toLowerCase() }, ravi.userId))?.id).toBe(c.id);
    expect((await svc.lookup({ id: c.id }, owner.userId))?.id).toBe(c.id);
    expect(await codeOf(() => svc.requestToJoin(ravi, c.id))).toBe(CommunityCode.COMMUNITY_NOT_FOUND);
  });
});

describe('joining', () => {
  it('R3: a free public community lets anyone in at once and tells the owner', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input());
    const after = await svc.join(ravi, c.id);
    expect(after.memberCount).toBe(2);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('member');
    expect(sentTo('community.member_joined')).toEqual([owner.userId]);
    expect(await codeOf(() => svc.join(ravi, c.id))).toBe(CommunityCode.ALREADY_MEMBER);
  });

  it('R3: a private community takes a request, and a paid one a payment', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const priv = await svc.create(owner, input({ visibility: 'private' }));
    const paid = await svc.create(owner, paidInput());
    expect(await codeOf(() => svc.join(ravi, priv.id))).toBe(CommunityCode.REQUEST_REQUIRED);
    expect(await codeOf(() => svc.join(ravi, paid.id))).toBe(CommunityCode.PAYMENT_REQUIRED);
    expect(await codeOf(() => svc.requestToJoin(ravi, paid.id))).toBe(CommunityCode.INVALID_COMMUNITY);
  });

  it('R3: a request reaches the owner and admins; approving a free one makes a member', async () => {
    const owner = await user('Asha');
    const admin = await user('Kabir');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input({ visibility: 'private' }));
    await svc.requestToJoin(admin, c.id, { inviteCode: c.inviteCode });
    await svc.setRole(owner, c.id, admin.userId, 'admin');

    const { request } = await svc.requestToJoin(ravi, c.id, { note: 'I play Sundays' });
    expect(request?.status).toBe('pending');
    expect(sentTo('community.join_request').sort()).toEqual([owner.userId, admin.userId].sort());
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('requested');
    expect(await svc.pendingCount(c.id)).toBe(1);
    expect((await svc.joinRequests(ravi, c.id))).toEqual([]);

    const decided = await svc.respond(admin, request!.id, true);
    expect(decided.status).toBe('joined');
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('member');
    expect(sentTo('community.request_approved')).toEqual([ravi.userId]);
    expect(notices.find((n) => n.template === 'community.request_approved')?.payload.mustPay).toBe(false);
    expect(await codeOf(() => svc.respond(owner, request!.id, false))).toBe(CommunityCode.REQUEST_NOT_FOUND);
  });

  it('R3: a declined request tells the asker, who may ask again', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input({ visibility: 'private' }));
    const { request } = await svc.requestToJoin(ravi, c.id);
    await svc.respond(owner, request!.id, false);
    expect(sentTo('community.request_rejected')).toEqual([ravi.userId]);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('none');
    expect((await svc.requestToJoin(ravi, c.id)).request?.status).toBe('pending');
  });

  it('R3: with the invite code, a free private community lets you in and a paid one counts as approved', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const free = await svc.create(owner, input({ visibility: 'private', discoverable: false }));
    const paid = await svc.create(owner, paidInput({ visibility: 'private', discoverable: false }));

    const inFree = await svc.requestToJoin(ravi, free.id, { inviteCode: free.inviteCode });
    expect(inFree.request).toBeNull();
    expect((await svc.viewerOf(free.id, ravi.userId)).state).toBe('member');

    const inPaid = await svc.requestToJoin(ravi, paid.id, { inviteCode: paid.inviteCode });
    expect(inPaid.request?.status).toBe('approved');
    expect(inPaid.request?.approvalExpiresAt?.getTime()).toBe(clock.getTime() + APPROVAL_TTL_MS);
    expect((await svc.viewerOf(paid.id, ravi.userId)).state).toBe('approved_to_pay');
    expect(sentTo('community.join_request')).toEqual([]);
  });

  it('R4: approving a paid private request waits 7 days for the payment', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, paidInput({ visibility: 'private' }));
    const { request } = await svc.requestToJoin(ravi, c.id);
    const decided = await svc.respond(owner, request!.id, true);
    expect(decided.status).toBe('approved');
    expect(decided.approvalExpiresAt?.getTime()).toBe(clock.getTime() + APPROVAL_TTL_MS);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('approved_to_pay');
    expect(notices.find((n) => n.template === 'community.request_approved')?.payload.mustPay).toBe(true);
    expect((await svc.findById(c.id))?.memberCount).toBe(1);
  });

  it('R4: one open request per person; it can be withdrawn', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input({ visibility: 'private' }));
    const { request } = await svc.requestToJoin(ravi, c.id);
    expect(await codeOf(() => svc.requestToJoin(ravi, c.id))).toBe(CommunityCode.JOIN_REQUEST_PENDING);
    await svc.cancelRequest(ravi, request!.id);
    expect((await svc.viewerOf(c.id, ravi.userId)).state).toBe('none');
    expect(await codeOf(() => svc.cancelRequest(ravi, request!.id))).toBe(CommunityCode.REQUEST_NOT_FOUND);
    expect(await codeOf(() => svc.cancelRequest(owner, request!.id))).toBe(CommunityCode.REQUEST_NOT_FOUND);
  });

  it('R4: the sweep lapses requests after 30 days and approvals after 7', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const meera = await user('Meera');
    const priv = await svc.create(owner, input({ visibility: 'private' }));
    const paid = await svc.create(owner, paidInput({ visibility: 'private' }));
    await svc.requestToJoin(ravi, priv.id);
    await svc.requestToJoin(meera, paid.id, { inviteCode: paid.inviteCode });

    clock = new Date(clock.getTime() + APPROVAL_TTL_MS + 1000);
    expect(await svc.sweep()).toMatchObject({ expiredRequests: 0, expiredApprovals: 1 });
    clock = new Date(clock.getTime() + REQUEST_TTL_MS);
    expect(await svc.sweep()).toMatchObject({ expiredRequests: 1, expiredApprovals: 0 });
    expect(await svc.requestsForUser(ravi.userId)).toEqual([]);
  });
});

describe('roles and leaving', () => {
  it('R5: the owner cannot leave without handing over; after a transfer there is still one owner', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input());
    await svc.join(ravi, c.id);
    expect(await codeOf(() => svc.leave(owner, c.id))).toBe(CommunityCode.OWNER_MUST_TRANSFER);

    const after = await svc.transferOwnership(owner, c.id, ravi.userId);
    expect(after.ownerUserId).toBe(ravi.userId);
    expect((await svc.viewerOf(c.id, owner.userId)).role).toBe('admin');
    expect((await svc.viewerOf(c.id, ravi.userId)).role).toBe('owner');
    expect(await prisma.communityMember.count({ where: { communityId: c.id, role: 'owner', status: 'active' } })).toBe(1);

    const left = await svc.leave(owner, c.id);
    expect(left.memberCount).toBe(1);
  });

  it('R5: only the owner sets roles; an admin removes members but not another admin', async () => {
    const owner = await user('Asha');
    const kabir = await user('Kabir');
    const meera = await user('Meera');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input());
    for (const u of [kabir, meera, ravi]) await svc.join(u, c.id);
    await svc.setRole(owner, c.id, kabir.userId, 'admin');
    await svc.setRole(owner, c.id, meera.userId, 'admin');
    expect(await codeOf(() => svc.setRole(kabir, c.id, ravi.userId, 'admin'))).toBe('FORBIDDEN');
    expect(await codeOf(() => svc.removeMember(kabir, c.id, meera.userId))).toBe('FORBIDDEN');
    expect(await codeOf(() => svc.removeMember(kabir, c.id, owner.userId))).toBe('FORBIDDEN');
    expect(await codeOf(() => svc.removeMember(ravi, c.id, kabir.userId))).toBe('FORBIDDEN');
    const after = await svc.removeMember(kabir, c.id, ravi.userId);
    expect(after.memberCount).toBe(3);
  });

  it('R6: a removed member stays out — no join, no request', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const pub = await svc.create(owner, input());
    const priv = await svc.create(owner, input({ name: 'Private crew', visibility: 'private' }));
    await svc.join(ravi, pub.id);
    await svc.requestToJoin(ravi, priv.id, { inviteCode: priv.inviteCode });
    await svc.removeMember(owner, pub.id, ravi.userId);
    await svc.removeMember(owner, priv.id, ravi.userId);
    expect((await svc.viewerOf(pub.id, ravi.userId)).state).toBe('removed');
    expect(await codeOf(() => svc.join(ravi, pub.id))).toBe(CommunityCode.REMOVED_FROM_COMMUNITY);
    expect(await codeOf(() => svc.requestToJoin(ravi, priv.id))).toBe(CommunityCode.REMOVED_FROM_COMMUNITY);
  });

  it('R6: a private member list is for members; a public one for anyone', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const pub = await svc.create(owner, input());
    const priv = await svc.create(owner, input({ name: 'Private crew', visibility: 'private' }));
    expect((await svc.members(pub, ravi.userId, { first: 10 })).nodes.map((m) => m.userId)).toEqual([owner.userId]);
    expect((await svc.members(priv, ravi.userId, { first: 10 })).nodes).toEqual([]);
    expect((await svc.members(priv, owner.userId, { first: 10 })).nodes.map((m) => m.role)).toEqual(['owner']);
  });

  it('R6: members are listed owner first, then admins, then by join date, a page at a time', async () => {
    const owner = await user('Asha');
    const c = await svc.create(owner, input());
    const names = ['Ravi', 'Meera', 'Kabir'];
    const ids: string[] = [];
    for (const name of names) {
      const u = await user(name);
      clock = new Date(clock.getTime() + 60_000);
      await svc.join(u, c.id);
      ids.push(u.userId);
    }
    await svc.setRole(owner, c.id, ids[2]!, 'admin');
    const fresh = (await svc.findById(c.id))!;
    const one = await svc.members(fresh, owner.userId, { first: 2 });
    expect(one.nodes.map((m) => m.userId)).toEqual([owner.userId, ids[2]]);
    const two = await svc.members(fresh, owner.userId, { first: 2, after: one.endCursor });
    expect(two.nodes.map((m) => m.userId)).toEqual([ids[0], ids[1]]);
    expect(two.hasNextPage).toBe(false);
  });

  it('a deleted community is gone for everyone, and only its owner can delete it', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input());
    await svc.join(ravi, c.id);
    expect(await codeOf(() => svc.remove(ravi, c.id))).toBe('FORBIDDEN');
    await svc.remove(owner, c.id);
    expect(await svc.lookup({ id: c.id }, owner.userId)).toBeNull();
    expect(await svc.listForUser(ravi.userId)).toEqual([]);
    const meera = await user('Meera');
    expect(await codeOf(() => svc.join(meera, c.id))).toBe(CommunityCode.COMMUNITY_NOT_FOUND);
  });

  it('a new invite code retires the old one', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const c = await svc.create(owner, input({ visibility: 'private', discoverable: false }));
    const after = await svc.resetInvite(owner, c.id);
    expect(after.inviteCode).not.toBe(c.inviteCode);
    expect(await svc.lookup({ inviteCode: c.inviteCode }, ravi.userId)).toBeNull();
    expect(await codeOf(() => svc.resetInvite(ravi, c.id))).toBe('FORBIDDEN');
  });
});

describe('caps', () => {
  it('R7: the member count is recounted with every join and leave', async () => {
    const owner = await user('Asha');
    const c = await svc.create(owner, input());
    const people = await Promise.all(['Ravi', 'Meera', 'Kabir'].map(user));
    await Promise.all(people.map((p) => svc.join(p, c.id)));
    expect((await svc.findById(c.id))?.memberCount).toBe(4);
    await svc.leave(people[0]!, c.id);
    expect((await svc.findById(c.id))?.memberCount).toBe(3);
  });
});

describe('feed and chat', () => {
  const feedFor = () =>
    createCommunityFeed({
      db: prisma as unknown as Db,
      limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }) },
      roleOf: (id, userId) => svc.roleOf(id, userId),
      now: () => clock,
    });

  it('R9: members post and read the feed newest first; non-members see nothing and cannot post', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const meera = await user('Meera');
    const c = await svc.create(owner, input());
    await svc.join(ravi, c.id);
    const feed = feedFor();
    await feed.createPost(owner, c.id, 'Sunday 7am at Siri Fort');
    clock = new Date(clock.getTime() + 60_000);
    await feed.createPost(ravi, c.id, '  I am in  ');

    const page = await feed.posts(c.id, ravi.userId, { first: 1 });
    expect(page.nodes.map((p) => p.body)).toEqual(['I am in']);
    const next = await feed.posts(c.id, ravi.userId, { first: 5, after: page.endCursor });
    expect(next.nodes.map((p) => p.body)).toEqual(['Sunday 7am at Siri Fort']);

    expect((await feed.posts(c.id, meera.userId, { first: 5 })).nodes).toEqual([]);
    expect(await codeOf(() => feed.createPost(meera, c.id, 'hi'))).toBe('FORBIDDEN');
    expect(await codeOf(() => feed.createPost(ravi, c.id, '   '))).toBe(FeedCode.INVALID_POST);
  });

  it('R9: admins pin one post at a time and remove anyone’s; a member removes only their own', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const meera = await user('Meera');
    const c = await svc.create(owner, input());
    await svc.join(ravi, c.id);
    await svc.join(meera, c.id);
    const feed = feedFor();
    const a = await feed.createPost(owner, c.id, 'Rules');
    const b = await feed.createPost(ravi, c.id, 'Fixtures');

    await feed.pinPost(owner, a.id, true);
    await feed.pinPost(owner, b.id, true);
    expect((await feed.pinnedPost(c.id, meera.userId))?.id).toBe(b.id);
    expect(await codeOf(() => feed.pinPost(ravi, a.id, true))).toBe('FORBIDDEN');

    expect(await codeOf(() => feed.deletePost(meera, b.id))).toBe('FORBIDDEN');
    await feed.deletePost(owner, b.id);
    expect(await feed.pinnedPost(c.id, meera.userId)).toBeNull();
    await feed.deletePost(owner, a.id);
    expect((await feed.posts(c.id, meera.userId, { first: 5 })).nodes).toEqual([]);
    expect(await codeOf(() => feed.deletePost(owner, a.id))).toBe(FeedCode.POST_NOT_FOUND);
  });

  it('R9: the chat is for members; a removed message keeps no body for players', async () => {
    const owner = await user('Asha');
    const ravi = await user('Ravi');
    const outsider = await user('Meera');
    const c = await svc.create(owner, input({ visibility: 'private' }));
    await svc.requestToJoin(ravi, c.id, { inviteCode: c.inviteCode });
    const feed = feedFor();
    const first = await feed.sendMessage(ravi, c.id, 'Who has a spare ball?');
    clock = new Date(clock.getTime() + 1000);
    await feed.sendMessage(owner, c.id, 'Me');

    const latest = await feed.messages(c.id, ravi.userId, { first: 1 });
    expect(latest.nodes.map((m) => m.body)).toEqual(['Me']);
    const older = await feed.messages(c.id, ravi.userId, { first: 10, before: latest.endCursor });
    expect(older.nodes.map((m) => m.body)).toEqual(['Who has a spare ball?']);

    expect((await feed.messages(c.id, outsider.userId, { first: 10 })).nodes).toEqual([]);
    expect(await codeOf(() => feed.sendMessage(outsider, c.id, 'hello'))).toBe('FORBIDDEN');

    const gone = await feed.deleteMessage(owner, first.id);
    expect(gone).toMatchObject({ deleted: true, body: '' });
    expect((await prisma.communityMessage.findUnique({ where: { id: first.id } }))?.body).toBe('Who has a spare ball?');

    // R6 — a member who leaves loses the thread.
    await svc.leave(ravi, c.id);
    expect((await feed.messages(c.id, ravi.userId, { first: 10 })).nodes).toEqual([]);
  });
});
