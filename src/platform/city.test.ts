import { describe, expect, it } from 'vitest';
import { cityKey, cityVariants } from './city.js';

describe('city matching', () => {
  it('ignores case and stray spaces', () => {
    expect(cityKey('  New   Delhi ')).toBe('new delhi');
    expect(cityVariants('PUNE ')).toEqual(['pune']);
  });

  it('treats old and new names as one city', () => {
    expect(cityVariants('Bangalore')).toContain('bengaluru');
    expect(cityVariants('bengaluru')).toContain('bangalore');
    expect(cityVariants('Gurgaon')).toContain('gurugram');
    expect(cityVariants('New Delhi')).toContain('delhi');
  });

  it('does not merge different cities', () => {
    expect(cityVariants('Noida')).not.toContain('delhi');
    expect(cityVariants('Delhi')).not.toContain('noida');
  });
});
