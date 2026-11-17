-- Floodlight watch sports, live scores (2026-11-17): the feeds a follow may name.
-- API-Sports' other sports (one key, a budget each), Jolpica F1 and Lichess
-- chess (no key), PandaScore esports. pro_feed_providers takes any provider.
ALTER TABLE "pro_feed_follows" DROP CONSTRAINT "pro_feed_follows_provider_check";
ALTER TABLE "pro_feed_follows" ADD CONSTRAINT "pro_feed_follows_provider_check" CHECK ("provider" IN (
    'cricapi', 'api_football', 'api_basketball', 'api_nfl', 'api_baseball', 'api_hockey', 'api_rugby', 'api_mma',
    'jolpica', 'lichess', 'pandascore', 'snooker_org', 'google_news', 'newsdata'
));
