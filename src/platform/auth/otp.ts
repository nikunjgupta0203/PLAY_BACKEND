/**
 * OTP codes (identity R1, R2).
 * Six digits, argon2id-hashed at rest. The plaintext is never stored or logged.
 */
import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export function generateCode(): string {
  // randomInt is cryptographically secure; padStart keeps leading zeros.
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export async function hashCode(code: string): Promise<string> {
  return hash(code, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyCode(codeHash: string, code: string): Promise<boolean> {
  try {
    return await verify(codeHash, code);
  } catch {
    return false;
  }
}

/**
 * A hash of a code nobody holds. Verified against when the email is unknown, so
 * the request costs the same work whether or not the account exists (R4).
 */
let decoyHash: string | undefined;
export async function decoy(): Promise<string> {
  decoyHash ??= await hashCode(generateCode());
  return decoyHash;
}
