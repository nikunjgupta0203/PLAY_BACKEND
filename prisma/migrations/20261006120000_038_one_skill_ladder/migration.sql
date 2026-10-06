-- 038 — one skill ladder for every sport (issue log 2026-10-06 #5).
-- Every sport now uses pickleball's 2.5–5.0+ ladder (src/modules/sport/seed.ts
-- SKILL_BANDS). Players who picked a qualitative level keep the nearest step,
-- and the old Beginner / Intermediate / Advanced / Open rows go away, so no
-- sport offers two scales at once.

UPDATE "player_sports"
   SET "skill_band" = CASE "skill_band"
         WHEN 'beginner'     THEN '2.5'
         WHEN 'intermediate' THEN '3.5'
         WHEN 'advanced'     THEN '4.0'
         WHEN 'open'         THEN '5.0+'
       END
 WHERE "skill_band" IN ('beginner', 'intermediate', 'advanced', 'open');

DELETE FROM "skill_bands" WHERE "key" IN ('beginner', 'intermediate', 'advanced', 'open');

-- The seed writes these too on every deploy; inserting them here means no
-- sport is left without levels between `migrate deploy` and `seed`.
INSERT INTO "skill_bands" ("id", "sport_id", "key", "label", "lower_bound", "upper_bound", "sort_order")
SELECT gen_random_uuid(), s."id", b.key, b.label, b.lo, b.hi, b.ord
  FROM "sports" s
 CROSS JOIN (VALUES
       ('2.5',  '2.5 · Beginner',     2.50, 2.99, 0),
       ('3.0',  '3.0 · Novice',       3.00, 3.49, 1),
       ('3.5',  '3.5 · Intermediate', 3.50, 3.99, 2),
       ('4.0',  '4.0 · Advanced',     4.00, 4.49, 3),
       ('4.5',  '4.5 · Competitive',  4.50, 4.99, 4),
       ('5.0+', '5.0+ · Pro',         5.00, NULL, 5)
     ) AS b(key, label, lo, hi, ord)
ON CONFLICT ("sport_id", "key") DO NOTHING;
