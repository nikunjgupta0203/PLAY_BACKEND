import { describe, expect, it } from 'vitest';
import { createSecretBox } from './secretBox.js';

const key = Buffer.alloc(32, 1).toString('base64');

describe('secretBox', () => {
  it('round-trips', () => {
    const box = createSecretBox(key);
    expect(box.open(box.seal('ABCPS1234K'))).toBe('ABCPS1234K');
  });

  it('never produces the same bytes twice for the same input', () => {
    const box = createSecretBox(key);
    expect(box.seal('51234567890').equals(box.seal('51234567890'))).toBe(false);
  });

  it('refuses a tampered box', () => {
    const box = createSecretBox(key);
    const sealed = box.seal('51234567890');
    sealed[sealed.length - 1]! ^= 0xff;
    expect(() => box.open(sealed)).toThrow();
  });

  it('refuses the wrong key', () => {
    const sealed = createSecretBox(key).seal('x');
    expect(() => createSecretBox(Buffer.alloc(32, 2).toString('base64')).open(sealed)).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => createSecretBox('c2hvcnQ=')).toThrow('PAYOUT_DATA_KEY');
  });
});
