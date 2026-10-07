import { describe, expect, it } from 'vitest';
import { heatCountFor } from './service/heatSize.js';

describe('heats by sport — made by the app when registration closes', () => {
  it('fills a pool or a track eight lanes at a time', () => {
    expect(heatCountFor('swimming', 8)).toBe(1);
    expect(heatCountFor('swimming', 9)).toBe(2);
    expect(heatCountFor('athletics', 20)).toBe(3);
  });
  it('splits lifters into flights of fourteen', () => {
    expect(heatCountFor('powerlifting', 14)).toBe(1);
    expect(heatCountFor('weightlifting', 30)).toBe(3);
  });
  it('starts a road race or a golf round together', () => {
    expect(heatCountFor('running', 400)).toBe(1);
    expect(heatCountFor('golf', 60)).toBe(1);
    expect(heatCountFor('unknown-sport', 10)).toBe(1);
  });
});
