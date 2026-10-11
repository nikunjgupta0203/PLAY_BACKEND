/**
 * TEMPORARY smoke test (not for commit): drives the new resolvers through the
 * real executable schema against a real Postgres, as the app will.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { startTestDb, stopTestDb, truncateAll } from './helpers/testDb.js';

let prisma: PrismaClient;
let run: (userId: string | null, source: string, variables?: Record<string, unknown>) => Promise<Record<string, any>>;
let sportId: string;

async function player(name: string, phone: string | null = null): Promise<{ userId: string; playerId: string }> {
  const { newId } = await import('../src/platform/ids.js');
  const userId = newId();
  const playerId = newId();
  await prisma.user.create({ data: { id: userId, email: `${name.toLowerCase()}@example.com`, displayName: name, phoneE164: phone } });
  await prisma.playerProfile.create({ data: { id: playerId, userId, city: 'Ahmedabad' } });
  return { userId, playerId };
}

beforeAll(async () => {
  const started = await startTestDb();
  prisma = started.prisma;
  // The production singletons read these when first imported, so they are set first.
  process.env.DATABASE_URL = started.url;
  process.env.DIRECT_DATABASE_URL = started.url;
  await truncateAll(prisma);

  const { graphql } = await import('graphql');
  const { schema } = await import('../src/schema.js');
  const { buildContext } = await import('../src/graphql/context.js');
  const { signAccessToken } = await import('../src/platform/auth/tokens.js');
  const { withRequestCache } = await import('../src/platform/requestCache.js');
  const { seedSport, PICKLEBALL } = await import('../src/modules/sport/seed.js');
  const { sport } = await import('../src/modules/sport/index.js');
  sportId = await seedSport(prisma as never, PICKLEBALL);
  sport.refresh();

  run = async (userId, source, variables) => {
    const token = userId ? await signAccessToken({ sub: userId, sid: 'smoke', ver: 0, client: 'app' }) : null;
    const req = { get: (h: string) => (h.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined), ip: '127.0.0.1' };
    const contextValue = await buildContext({ req: req as never });
    const result = await withRequestCache(() => graphql({ schema, source, variableValues: variables, contextValue }));
    if (result.errors?.length) throw new Error(result.errors.map((e) => `${e.message} @ ${e.path?.join('.')}`).join('\n'));
    return result.data as Record<string, any>;
  };
}, 240_000);

afterAll(async () => {
  await stopTestDb();
});

const DETAIL = `
  id status startsAt endsAt timezone placeName city maxPlayers minPlayers playerCount spotsLeft gameOn skillBand distanceKm notes cancelReason
  sport { id slug name } venue { id name city } location { lat lng }
  host { id displayName avatarUrl(size: sm) }
  players { id displayName } invited { id displayName }
  viewerIsHost viewerHasJoined viewerIsInvited hostPhone
  comments { id body mine author { id displayName } }
`;

it('casual games and deactivation work end to end through GraphQL', async () => {
  const asha = await player('Asha', '+91 98765 43210');
  const bina = await player('Bina', '9000000002');
  const chirag = await player('Chirag');
  const startsAt = new Date(Date.now() + 26 * 3_600_000).toISOString();
  const endsAt = new Date(Date.now() + 27.5 * 3_600_000).toISOString();

  // --- create, with an invite ---------------------------------------------------
  const created = await run(
    asha.userId,
    `mutation($input: CreateGameInput!) { createGame(input: $input) { game { ${DETAIL} } userError { code message } } }`,
    {
      input: {
        sportId, location: { lat: 23.0225, lng: 72.5714 }, placeName: 'Law Garden courts', city: 'Ahmedabad',
        startsAt, endsAt, maxPlayers: 3, minPlayers: 2, skillBand: null, notes: 'Bring water', inviteUserIds: [chirag.playerId],
      },
    },
  );
  expect(created.createGame.userError).toBeNull();
  const game = created.createGame.game;
  expect(game).toMatchObject({
    status: 'OPEN', placeName: 'Law Garden courts', playerCount: 1, spotsLeft: 2, gameOn: false,
    viewerIsHost: true, viewerHasJoined: true, hostPhone: null,
    host: { id: asha.playerId, displayName: 'Asha' },
    players: [{ id: asha.playerId }], invited: [{ id: chirag.playerId }],
    location: { lat: 23.0225, lng: 72.5714 }, venue: null, sport: { slug: 'pickleball' },
  });
  // The invite reached Chirag's feed and points at the game.
  const feed = await run(chirag.userId, `{ notifications(first: 5) { edges { node { title body target { kind id } } } } }`);
  expect(feed.notifications.edges[0].node).toMatchObject({ title: 'Asha invited you to play', target: { kind: 'GAME', id: game.id } });

  // --- discover, as someone else ------------------------------------------------
  const list = await run(
    bina.userId,
    `query($near: GeoPointInput) { games(first: 10, near: $near, radiusKm: 10) { edges { cursor node { id playerCount distanceKm viewerHasJoined viewerIsInvited host { displayName } } } pageInfo { hasNextPage endCursor } } }`,
    { near: { lat: 23.03, lng: 72.57 } },
  );
  expect(list.games.edges).toHaveLength(1);
  expect(list.games.edges[0].node).toMatchObject({ id: game.id, playerCount: 1, viewerHasJoined: false, host: { displayName: 'Asha' } });
  expect(list.games.edges[0].node.distanceKm).toBeLessThan(2);
  // Not joined: no phone, no thread.
  const outside = await run(bina.userId, `query($id: ID!) { game(id: $id) { ${DETAIL} } }`, { id: game.id });
  expect(outside.game).toMatchObject({ hostPhone: null, comments: [], invited: [], viewerIsInvited: false });

  // --- join: game on at the minimum, phone and thread unlock ---------------------
  const joined = await run(bina.userId, `mutation($id: ID!) { joinGame(gameId: $id) { game { ${DETAIL} } userError { code } } }`, { id: game.id });
  expect(joined.joinGame.game).toMatchObject({ playerCount: 2, gameOn: true, status: 'OPEN', viewerHasJoined: true, hostPhone: '+91 98765 43210' });
  const said = await run(bina.userId, `mutation($id: ID!) { addGameComment(gameId: $id, body: "Running late") { comment { body mine author { displayName } } userError { code } } }`, { id: game.id });
  expect(said.addGameComment.comment).toEqual({ body: 'Running late', mine: true, author: { displayName: 'Bina' } });
  const hostView = await run(asha.userId, `query($id: ID!) { game(id: $id) { comments { body mine } players { displayName } } myNextGame { id } myGames { id } }`, { id: game.id });
  expect(hostView.game.comments).toEqual([{ body: 'Running late', mine: false }]);
  expect(hostView.game.players.map((p: { displayName: string }) => p.displayName)).toEqual(['Asha', 'Bina']);
  expect(hostView.myNextGame.id).toBe(game.id);
  expect(hostView.myGames.map((g: { id: string }) => g.id)).toEqual([game.id]);

  // --- the last place fills it; a fourth is refused --------------------------------
  const full = await run(chirag.userId, `mutation($id: ID!) { joinGame(gameId: $id) { game { status spotsLeft viewerIsInvited } userError { code } } }`, { id: game.id });
  expect(full.joinGame.game).toEqual({ status: 'FULL', spotsLeft: 0, viewerIsInvited: false });
  const dev = await player('Dev');
  const refused = await run(dev.userId, `mutation($id: ID!) { joinGame(gameId: $id) { game { id } userError { code } } }`, { id: game.id });
  expect(refused.joinGame).toEqual({ game: null, userError: { code: 'GAME_FULL' } });

  // --- host controls: remove, edit, invite by phone lookup, cancel -------------------
  const removed = await run(asha.userId, `mutation($id: ID!, $p: ID!) { removeGamePlayer(gameId: $id, playerId: $p) { game { status playerCount } userError { code } } }`, { id: game.id, p: chirag.playerId });
  expect(removed.removeGamePlayer.game).toEqual({ status: 'OPEN', playerCount: 2 });
  const edited = await run(asha.userId, `mutation($input: UpdateGameInput!) { updateGame(input: $input) { game { maxPlayers notes minPlayers placeName } userError { code message } } }`, {
    input: { gameId: game.id, maxPlayers: 6, notes: null, minPlayers: null },
  });
  expect(edited.updateGame).toEqual({ game: { maxPlayers: 6, notes: null, minPlayers: null, placeName: 'Law Garden courts' }, userError: null });
  const found = await run(asha.userId, `{ playerByPhone(phone: "090000 00002") { player { id displayName } userError { code } } }`);
  expect(found.playerByPhone).toEqual({ player: { id: bina.playerId, displayName: 'Bina' }, userError: null });
  const nobody = await run(asha.userId, `{ playerByPhone(phone: "9111111111") { player { id } userError { code } } }`);
  expect(nobody.playerByPhone).toEqual({ player: null, userError: null });
  const invited = await run(asha.userId, `mutation($id: ID!, $p: [ID!]!) { inviteToGame(gameId: $id, playerIds: $p) { invitedCount game { invited { displayName } } userError { code } } }`, { id: game.id, p: [dev.playerId, bina.playerId, chirag.playerId] });
  // Bina is in, Chirag was removed: only Dev is invited.
  expect(invited.inviteToGame).toEqual({ invitedCount: 1, game: { invited: [{ displayName: 'Dev' }] }, userError: null });
  const cancelled = await run(asha.userId, `mutation($id: ID!) { cancelGame(gameId: $id, reason: "Rain") { game { status cancelReason } userError { code } } }`, { id: game.id });
  expect(cancelled.cancelGame.game).toEqual({ status: 'CANCELLED', cancelReason: 'Rain' });
  expect((await run(bina.userId, `{ games(first: 5) { edges { node { id } } } myNextGame { id } }`))).toEqual({ games: { edges: [] }, myNextGame: null });

  // --- deactivation: hidden everywhere, and back when reactivated ----------------------
  const visible = await run(asha.userId, `query($id: ID!) { playerProfile(id: $id) { displayName } players(query: "Bina", first: 5) { edges { node { id } } } recommendedPlayers(first: 10) { id } }`, { id: bina.playerId });
  expect(visible.playerProfile).toEqual({ displayName: 'Bina' });
  expect(visible.players.edges).toHaveLength(1);
  expect(visible.recommendedPlayers.map((p: { id: string }) => p.id)).toContain(bina.playerId);

  expect((await run(bina.userId, `mutation { deactivateAccount { ok } }`)).deactivateAccount).toEqual({ ok: true });
  expect((await prisma.user.findUniqueOrThrow({ where: { id: bina.userId } })).status).toBe('deactivated');
  const hidden = await run(asha.userId, `query($id: ID!) { playerProfile(id: $id) { displayName } players(query: "Bina", first: 5) { edges { node { id } } } recommendedPlayers(first: 10) { id } playerByPhone(phone: "9000000002") { player { id } } }`, { id: bina.playerId });
  expect(hidden.playerProfile).toBeNull();
  expect(hidden.players.edges).toHaveLength(0);
  expect(hidden.recommendedPlayers.map((p: { id: string }) => p.id)).not.toContain(bina.playerId);
  expect(hidden.playerByPhone.player).toBeNull();
  const message = await run(asha.userId, `mutation($p: ID!) { sendMessage(input: { playerId: $p, body: "Hi" }) { userError { code } } }`, { p: bina.playerId }).catch((e: Error) => ({ error: e.message }));
  expect(JSON.stringify(message)).toMatch(/CANNOT_MESSAGE/);
}, 240_000);
