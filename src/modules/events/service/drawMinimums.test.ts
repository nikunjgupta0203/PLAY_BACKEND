import { describe, expect, it } from 'vitest';
import { MIN_ENTRIES } from '../../tournament/draw.js';
import { MIN_GROUP_ENTRIES, MIN_LEAGUE_ENTRIES } from '../../tournament/league.js';
import { DRAW_MIN_ENTRIES } from './index.js';

describe('events DRAW_MIN_ENTRIES (gap #8, #30)', () => {
  it('matches the floors the tournament module refuses to draw below', () => {
    expect(DRAW_MIN_ENTRIES).toEqual({
      single_elim_with_plate: MIN_ENTRIES,
      // F23 — a plain knockout is drawn by the same planner.
      single_elim: MIN_ENTRIES,
      league: MIN_LEAGUE_ENTRIES,
      groups_knockout: MIN_GROUP_ENTRIES,
    });
  });
});
