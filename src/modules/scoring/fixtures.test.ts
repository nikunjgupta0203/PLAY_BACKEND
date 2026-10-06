/** scoring R4 — the engine meets its own golden fixtures; the app runs the same file. */
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/engine-fixtures.json' with { type: 'json' };
import { applyEvent, initialState, type ScoreEvent, type ScoreState } from './engine.js';
import type { ScoringRule } from '../sport/index.js';

describe('engine golden fixtures', () => {
  for (const f of fixtures as unknown as { name: string; rule: ScoringRule; events: ScoreEvent[]; final: ScoreState }[]) {
    it(`scoring R4: ${f.name}`, () => {
      const final = f.events.reduce((s, e) => applyEvent(s, e, f.rule), initialState(f.rule));
      expect(final).toEqual(f.final);
    });
  }
});
