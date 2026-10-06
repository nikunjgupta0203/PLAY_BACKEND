/**
 * payouts R2 — PAN and bank account numbers at rest. AES-256-GCM, a fresh IV
 * per seal, and a one-byte version so the key can rotate without a migration:
 * a v2 key is added beside v1 and rows are re-sealed lazily.
 *
 * Layout: [version 1][iv 12][tag 16][ciphertext].
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  seal(plain: string): Buffer;
  open(sealed: Uint8Array): string;
}

export function createSecretBox(keyBase64: string): SecretBox {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('PAYOUT_DATA_KEY must be 32 bytes, base64');

  return {
    seal(plain) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    open(bytes) {
      const sealed = Buffer.from(bytes);
      if (sealed[0] !== VERSION) throw new Error(`unknown secret box version ${sealed[0]}`);
      const iv = sealed.subarray(1, 1 + IV_BYTES);
      const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}
