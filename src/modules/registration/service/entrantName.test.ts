import { describe, expect, it } from 'vitest';
import { entrantName } from './entrantName.js';

describe('entrantName', () => {
  it('names a player, a pair, and a team by its captain', () => {
    expect(entrantName(['Asha'])).toBe('Asha');
    expect(entrantName(['Asha', 'Meera'])).toBe('Asha & Meera');
    expect(entrantName(['Asha', 'Meera', 'Ravi', 'Kiran', 'Dev'])).toBe('Asha + 4');
    expect(entrantName([])).toBe('');
  });
});
