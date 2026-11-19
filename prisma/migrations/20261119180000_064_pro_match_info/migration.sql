-- Match Centre Info and Squads tabs (2026-11-19): facts such as the format and
-- the toss, and each side's squad, both filled by the feeds (CricAPI first).
ALTER TABLE pro_matches ADD COLUMN facts JSONB NOT NULL DEFAULT '[]';
ALTER TABLE pro_matches ADD COLUMN squads JSONB NOT NULL DEFAULT '[]';
