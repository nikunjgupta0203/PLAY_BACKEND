/**
 * Session tokens (identity R5, R6, R7).
 *
 *   access  — RS256 JWT, 15 min, claims sub/sid/ver and NO role or grant claim.
 *             An organizer's permission is per-event and revocable; baked into
 *             a 15-minute token a revoked grant stays live for 15 minutes, on a
 *             screen that can rewrite match results.
 *   refresh — opaque 256-bit value, stored hashed, rotating, 60 days.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI, type KeyLike } from 'jose';
import { config } from '../config.js';

const ALG = 'RS256';
const ISSUER = 'pl4y';
/** portal R6 — the app and the staff portal hold different tokens; neither accepts the other's refresh. */
export type AuthClient = 'app' | 'portal';
const AUDIENCE: Record<AuthClient, string> = { app: 'pl4y-app', portal: 'pl4y-portal' };

/**
 * Keys are supplied base64-encoded so they survive any shell, .env parser and
 * CI secret store without newline mangling. A raw PEM (or one with literal \n
 * escapes) is also accepted, so an operator pasting a PEM still works.
 */
function pem(value: string): string {
  const v = value.trim();
  if (v.includes('-----BEGIN')) return v.replace(/\\n/g, '\n').trim();
  return Buffer.from(v, 'base64').toString('utf8').trim();
}

let privateKey: KeyLike | undefined;
let publicKey: KeyLike | undefined;

async function keys(): Promise<{ priv: KeyLike; pub: KeyLike }> {
  privateKey ??= await importPKCS8(pem(config.JWT_PRIVATE_KEY), ALG);
  publicKey ??= await importSPKI(pem(config.JWT_PUBLIC_KEY), ALG);
  return { priv: privateKey, pub: publicKey };
}

export interface AccessClaims {
  /** user id */
  sub: string;
  /** session (refresh-token family) id */
  sid: string;
  /** token version, for a future global invalidation */
  ver: number;
  /** Which client the session belongs to. Absent means the app. */
  client?: AuthClient;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const { priv } = await keys();
  return new SignJWT({ sid: claims.sid, ver: claims.ver })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE[claims.client ?? 'app'])
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(priv);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { pub } = await keys();
  const { payload } = await jwtVerify(token, pub, {
    issuer: ISSUER,
    audience: [AUDIENCE.app, AUDIENCE.portal],
    algorithms: [ALG],
  });
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return {
    sub: String(payload.sub),
    sid: String(payload.sid),
    ver: Number(payload.ver ?? 0),
    client: aud.includes(AUDIENCE.portal) ? 'portal' : 'app',
  };
}

/** 256 bits, base64url. Returned to the client once; only the hash is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare, so a lookup cannot be turned into an oracle. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** portal R6 — a portal session ends 12 hours after sign-in, however busy it is. */
export const PORTAL_SESSION_MS = 12 * 3_600_000;

export function refreshExpiry(now = new Date(), client: AuthClient = 'app'): Date {
  if (client === 'portal') return new Date(now.getTime() + PORTAL_SESSION_MS);
  return new Date(now.getTime() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}
