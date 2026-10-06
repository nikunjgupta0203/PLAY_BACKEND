/**
 * registration R13 — the check-in QR.
 *
 *   base64url( registrationId ‖ keyId ‖ HMAC-SHA256(secret[keyId], registrationId) )
 *
 * Rendering a QR writes no row: the token is a pure function of the
 * registration id and the current key, so the app can show it offline and a
 * staff device can verify a scan against a downloaded roster of token hashes.
 * The key id is what lets the secret rotate without invalidating every QR a
 * player already saved.
 *
 * Pure and synchronous, like priceQuote: callable from a resolver, a service
 * or a test without owning any state.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckinKeys {
  /** The key new tokens are signed with. */
  currentKeyId: string;
  /** Every key a scan may still be verified with, current one included. */
  secrets: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEPARATOR = '.';

const mac = (secret: string, registrationId: string): string =>
  createHmac('sha256', secret).update(registrationId, 'utf8').digest('base64url');

const secretFor = (keys: CheckinKeys, keyId: string): string | null =>
  Object.hasOwn(keys.secrets, keyId) && keys.secrets[keyId] ? keys.secrets[keyId]! : null;

/** Throws when no current secret is configured — a deploy error, not a user one. */
export function signCheckinToken(keys: CheckinKeys, registrationId: string): string {
  const secret = secretFor(keys, keys.currentKeyId);
  if (!secret) throw new Error('CHECKIN_TOKEN_SECRET is not configured');
  const raw = [registrationId, keys.currentKeyId, mac(secret, registrationId)].join(SEPARATOR);
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * The registration id the token was issued for, or null. Null covers every
 * failure alike — malformed, unknown key, bad signature — because a scan
 * screen has one red state and an attacker should learn nothing from which
 * check failed.
 */
export function verifyCheckinToken(keys: CheckinKeys, token: string): string | null {
  if (!token || token.length > 512) return null;
  const raw = Buffer.from(token, 'base64url').toString('utf8');
  const parts = raw.split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [registrationId, keyId, signature] = parts as [string, string, string];
  if (!UUID.test(registrationId)) return null;

  const secret = secretFor(keys, keyId);
  if (!secret) return null;

  const expected = Buffer.from(mac(secret, registrationId), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return registrationId.toLowerCase();
}

/**
 * What the offline roster carries instead of the token itself: a lost staff
 * phone must not be a stack of valid tickets.
 */
export const checkinTokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Builds the key ring from config values. `previous` is "keyId:secret". */
export function checkinKeysFrom(input: {
  secret: string;
  keyId: string;
  previous: string;
}): CheckinKeys {
  const secrets: Record<string, string> = {};
  const at = input.previous.indexOf(':');
  if (at > 0) secrets[input.previous.slice(0, at)] = input.previous.slice(at + 1);
  if (input.secret) secrets[input.keyId] = input.secret;
  return { currentKeyId: input.keyId, secrets };
}
