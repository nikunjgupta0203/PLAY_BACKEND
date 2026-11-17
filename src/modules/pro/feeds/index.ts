/**
 * The feeds (migrations 060, 062): the budget and the score adapters. The
 * runner is composed in ../index.ts, next to the pro service it writes through
 * (built here it would import that file back: a cycle).
 */
import { config } from '../../../platform/config.js';
import { db } from '../../../platform/db.js';
import { createFeedBudget } from '../../../platform/feeds.js';
import { apiFootballAdapter } from './apiFootball.js';
import { API_SPORTS, apiSportsAdapter } from './apiSports.js';
import { jolpicaAdapter } from './jolpica.js';
import { lichessAdapter } from './lichess.js';
import { pandascoreAdapter } from './pandascore.js';
import { cricapiAdapter } from './cricapi.js';
import { snookerAdapter } from './snooker.js';

export const feedBudget = createFeedBudget({
  db,
  limits: {
    cricapi: config.CRICAPI_DAILY_LIMIT,
    api_football: config.API_SPORTS_DAILY_LIMIT,
    // API-Sports gives each sport its own free 100 a day on the one key.
    api_basketball: config.API_SPORTS_DAILY_LIMIT,
    api_nfl: config.API_SPORTS_DAILY_LIMIT,
    api_baseball: config.API_SPORTS_DAILY_LIMIT,
    api_hockey: config.API_SPORTS_DAILY_LIMIT,
    api_rugby: config.API_SPORTS_DAILY_LIMIT,
    api_mma: config.API_SPORTS_DAILY_LIMIT,
    jolpica: config.JOLPICA_DAILY_LIMIT,
    lichess: config.LICHESS_DAILY_LIMIT,
    pandascore: config.PANDASCORE_DAILY_LIMIT,
    snooker_org: config.SNOOKER_DAILY_LIMIT,
    google_news: config.NEWS_RSS_DAILY_LIMIT,
    newsdata: config.NEWSDATA_DAILY_LIMIT,
    unsplash: config.UNSPLASH_DAILY_LIMIT,
    pexels: config.PEXELS_DAILY_LIMIT,
  },
  configured: {
    cricapi: config.CRICAPI_KEY !== '',
    api_football: config.API_SPORTS_KEY !== '',
    api_basketball: config.API_SPORTS_KEY !== '',
    api_nfl: config.API_SPORTS_KEY !== '',
    api_baseball: config.API_SPORTS_KEY !== '',
    api_hockey: config.API_SPORTS_KEY !== '',
    api_rugby: config.API_SPORTS_KEY !== '',
    api_mma: config.API_SPORTS_KEY !== '',
    jolpica: true,
    lichess: true,
    pandascore: config.PANDASCORE_KEY !== '',
    snooker_org: config.SNOOKER_API_ID !== '',
    google_news: config.NEWS_RSS_ENABLED,
    newsdata: config.NEWSDATA_KEY !== '',
    unsplash: config.UNSPLASH_KEY !== '',
    pexels: config.PEXELS_KEY !== '',
  },
});

export const scoreAdapters = () => [
  cricapiAdapter(),
  apiFootballAdapter(),
  ...API_SPORTS.map((spec) => apiSportsAdapter(spec)),
  jolpicaAdapter(),
  lichessAdapter(),
  pandascoreAdapter(),
  snookerAdapter(),
];

export { cricapiAdapter } from './cricapi.js';
export { apiFootballAdapter } from './apiFootball.js';
export { snookerAdapter } from './snooker.js';
export { API_SPORTS, apiSportsAdapter, apiSportsFollows, apiSportsStatus, parseApiSportsGame } from './apiSports.js';
export { jolpicaAdapter, parseF1Leaders, parseF1Races, parseF1Result } from './jolpica.js';
export { chessName, lichessAdapter, parseLichessGame } from './lichess.js';
export { pandascoreAdapter, parsePandaMatch } from './pandascore.js';
export { createFeedRunner, feedPatch, FOLLOW_PROVIDERS, type FeedRunner, type RunSummary } from './runner.js';
export { parseCricMatch, parseCricScorecard } from './cricapi.js';
export { parseFootballFixture } from './apiFootball.js';
export { parseSnookerMatch, parseSnookerPlayers, parseSnookerRounds } from './snooker.js';
export { codeFor } from './types.js';
export type { FeedFollow, FeedMatch, ScoreAdapter } from './types.js';
