import { describe, expect, it } from 'vitest';
import {
  checkinKeysFrom,
  checkinTokenHash,
  signCheckinToken,
  verifyCheckinToken,
} from './checkinToken.js';

const ID = '0192f3a0-1c2d-7e4f-8a9b-0c1d2e3f4a5b';
const keys = { currentKeyId: 'k2', secrets: { k2: 'current-secret' } };

describe('registration R13: check-in token', () => {
  it('round-trips the registration id', () => {
    const token = signCheckinToken(keys, ID);
    expect(verifyCheckinToken(keys, token)).toBe(ID);
  });

  it('is deterministic, so rendering a QR needs no stored row', () => {
    expect(signCheckinToken(keys, ID)).toBe(signCheckinToken(keys, ID));
  });

  it('rejects a token whose registration id was swapped', () => {
    const token = signCheckinToken(keys, ID);
    const [, keyId, sig] = Buffer.from(token, 'base64url').toString('utf8').split('.');
    const forged = Buffer.from(
      `0192f3a0-1c2d-7e4f-8a9b-000000000000.${keyId}.${sig}`,
      'utf8',
    ).toString('base64url');
    expect(verifyCheckinToken(keys, forged)).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    expect(verifyCheckinToken(keys, '')).toBeNull();
    expect(verifyCheckinToken(keys, 'not-a-token')).toBeNull();
    expect(verifyCheckinToken(keys, 'x'.repeat(2000))).toBeNull();
  });

  it('rotation: a token signed with the previous key still verifies while it is listed', () => {
    const old = { currentKeyId: 'k1', secrets: { k1: 'old-secret' } };
    const token = signCheckinToken(old, ID);

    const rotated = checkinKeysFrom({ secret: 'current-secret', keyId: 'k2', previous: 'k1:old-secret' });
    expect(verifyCheckinToken(rotated, token)).toBe(ID);

    const retired = checkinKeysFrom({ secret: 'current-secret', keyId: 'k2', previous: '' });
    expect(verifyCheckinToken(retired, token)).toBeNull();
  });

  it('refuses to sign without a configured secret', () => {
    expect(() => signCheckinToken({ currentKeyId: 'k1', secrets: {} }, ID)).toThrow();
  });

  it('does not treat prototype keys as secrets', () => {
    const raw = Buffer.from(`${ID}.__proto__.abc`, 'utf8').toString('base64url');
    expect(verifyCheckinToken(keys, raw)).toBeNull();
  });

  it('the roster hash is not the token', () => {
    const token = signCheckinToken(keys, ID);
    expect(checkinTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(checkinTokenHash(token)).not.toContain(token);
  });
});
