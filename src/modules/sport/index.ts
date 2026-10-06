/** The ONLY surface other modules may import (conventions.md §1). */
import { db } from '../../platform/db.js';
import { createSportService } from './service/index.js';

export const sport = createSportService({ db });

export { SportCode, parseScoringRule, RuleTweakError, scoringRuleSchema, TWEAK_LIMITS, tweakRule } from './service/index.js';
export type {
  Format,
  RuleTweaks,
  ScoringRule,
  SkillBand,
  Sport,
  SportService,
} from './service/index.js';
