import { describe, expect, it } from 'vitest';
import { referenceFor } from './index.js';

describe('referenceFor (R27)', () => {
  it('reads PL4Y-XXXX-XXXX from the random tail of the id', () => {
    expect(referenceFor('01a19ce9-9728-75bd-8aaf-15f05062146a')).toBe('PL4Y-5062-146A');
  });

  it('two entries made in the same minute get different references', () => {
    // UUIDv7: same timestamp prefix, different random tails.
    const a = referenceFor('01a19ce9-9728-75bd-8aaf-15f05062146a');
    const b = referenceFor('01a19ce9-a001-7c11-9e2b-7d3c11aa90f4');
    expect(a).not.toBe(b);
  });
});
