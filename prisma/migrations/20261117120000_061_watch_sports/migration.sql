-- Floodlight watch sports (2026-11-17): American Football, Baseball, Ice Hockey,
-- Rugby and Formula 1, followed for matches, news and predictions. Production
-- never runs `pnpm seed`, so the rows land here; the seed (sport/seed.ts) holds
-- the same sports with their play settings and skips a slug that exists.
-- Not offered for play: sport/service/offered.ts keeps them out of every picker.
INSERT INTO "sports" ("id", "slug", "name", "active", "sort_order") VALUES
    ('01a1e9e3-ac82-7760-9464-3a619d398720', 'american-football', 'American Football', true, 33),
    ('01a1e9e3-ac83-7acd-a557-187b13a3ce17', 'baseball', 'Baseball', true, 34),
    ('01a1e9e3-ac83-70ce-a03b-51fdf35f9e9a', 'ice-hockey', 'Ice Hockey', true, 35),
    ('01a1e9e3-ac83-7412-a3b8-9b2bf784fab1', 'rugby', 'Rugby', true, 36),
    ('01a1e9e3-ac83-7a0e-9040-990a6b2b18f7', 'formula-1', 'Formula 1', true, 37)
ON CONFLICT ("slug") DO NOTHING;
