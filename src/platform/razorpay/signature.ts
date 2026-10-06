/**
 * Razorpay's signatures and the small pure helpers both adapters share
 * (collection in ./adapter.ts, payouts in ../payouts/razorpayx.ts). No config,
 * no network: secrets are passed in by the adapter that holds them.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256, hex — the form of every Razorpay signature. */
export function hmacHex(secret: string, message: string | Buffer): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Timing-safe comparison of a signature we computed with one we were given.
 * Razorpay sends lowercase hex; anything else simply fails to match.
 */
export function signatureMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  const x = Buffer.from(expected, 'utf8');
  const y = Buffer.from(given, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * A stable short token derived from one of our keys, for Razorpay fields with
 * a length or charset limit (a refund's receipt, a payout's idempotency key).
 * Deterministic, so a retry of the same request sends the same token.
 */
export function shortToken(key: string, length: number): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, length);
}

/** One header's value, whatever shape Node handed it over in. */
export function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Paise → the integer Razorpay wants. Refuses what a JSON number cannot hold exactly. */
export function toInt(paise: bigint): number {
  if (paise < 0n || paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`amount out of range: ${paise}`);
  }
  return Number(paise);
}

/** Razorpay's integer paise → bigint. Throws on anything that is not one. */
export function toPaise(v: unknown): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d{1,15}$/.test(v)) return BigInt(v);
  throw new TypeError(`not a Razorpay amount: ${String(v)}`);
}

/** Whitespace collapsed and cut to a field's limit. */
export function clean(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}
