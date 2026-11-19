-- Team logos (founder list 2026-11-19 #1): the badge the feed sends (CricAPI
-- teamInfo.img, API-Football / API-Sports team.logo, PandaScore image_url),
-- or one staff set. Null shows the code circle as before.
ALTER TABLE pro_teams ADD COLUMN logo_url TEXT;

-- Match Centre Graphs, Overs and Commentary (2026-11-19). `progress`: one
-- point per innings per over seen, written by every poll — the worm chart,
-- on any plan. `balls`: the latest ball-by-ball events (CricAPI match_bbb,
-- paid plans only) — the Overs and Commentary tabs.
ALTER TABLE pro_matches ADD COLUMN progress JSONB NOT NULL DEFAULT '[]';
ALTER TABLE pro_matches ADD COLUMN balls JSONB NOT NULL DEFAULT '[]';
