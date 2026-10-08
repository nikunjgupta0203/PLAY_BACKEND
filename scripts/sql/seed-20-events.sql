-- ─────────────────────────────────────────────────────────────────────────────
-- 20 published, FREE events across Indian cities — paste into the Neon SQL editor.
--
-- Does what the app does when a host creates, adds categories to and publishes
-- an event: the event row (with its map pin), an `owner` row in event_staff so
-- the host can manage it in the app, and categories whose scoring rule is
-- frozen from the sport's default, exactly as publish does (F22).
--
-- Every category is FREE (entry fee 0): no money moves, no payout account is
-- needed, and a player who enters is confirmed straight away.
--
-- It writes NO outbox row, so publishing these sends no "new event" pushes.
--
-- All-or-nothing: if anything is wrong (unknown email, missing sport) the whole
-- block rolls back and nothing is written.
--
-- Every id starts with 5eed, so the cleanup at the bottom finds exactly these.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  -- ▼▼ EDIT THESE TWO ▼▼
  organizer_email text := 'YOUR_ACCOUNT_EMAIL@example.com';  -- the host account; must already exist
  contact_phone   text := '9876543210';                      -- 10-digit Indian mobile, shown to entrants
  -- ▲▲ ▲▲

  organizer uuid;
  created int;
BEGIN
  SELECT id INTO organizer FROM users WHERE email = lower(organizer_email) AND status = 'active';
  IF organizer IS NULL THEN
    RAISE EXCEPTION 'No active user with email %. Sign in to the app once with it, or fix the email.', organizer_email;
  END IF;
  IF contact_phone !~ '^[6-9][0-9]{9}$' THEN
    RAISE EXCEPTION 'contact_phone must be 10 digits starting 6-9, got %', contact_phone;
  END IF;

  CREATE TEMP TABLE seed_events ON COMMIT DROP AS
  SELECT
    ('5eed' || substr(md5(random()::text || clock_timestamp()::text || v.n), 1, 28))::uuid AS id,
    v.*,
    s.id AS sport_id,
    -- Local start time in IST, stored as UTC like every other event.
    ((current_date + v.days_ahead) + make_time(v.start_hour, 0, 0)) AT TIME ZONE 'Asia/Kolkata' AS starts_at
  FROM (VALUES
    ( 1, 'Lucknow Pickleball Open',          'pickleball',   'Lucknow',    26.8467, 80.9462,  6,  8, 'singles', 'doubles'),
    ( 2, 'Bengaluru Smash Badminton Cup',    'badminton',    'Bengaluru',  12.9716, 77.5946,  7,  9, 'singles', 'doubles'),
    ( 3, 'Mumbai Padel Masters',             'padel',        'Mumbai',     19.0760, 72.8777,  9, 17, 'doubles', 'mixed_doubles'),
    ( 4, 'Delhi Table Tennis Championship',  'table-tennis', 'Delhi',      28.6139, 77.2090, 10, 10, 'singles', 'doubles'),
    ( 5, 'Pune Weekend Tennis Classic',      'tennis',       'Pune',       18.5204, 73.8567, 12,  7, 'singles', 'doubles'),
    ( 6, 'Hyderabad Squash Series',          'squash',       'Hyderabad',  17.3850, 78.4867, 13,  9, 'singles', NULL),
    ( 7, 'Gurugram Pickleball Doubles Bash', 'pickleball',   'Gurugram',   28.4595, 77.0266, 14,  8, 'doubles', 'mixed_doubles'),
    ( 8, 'Chennai Shuttle Showdown',         'badminton',    'Chennai',    13.0827, 80.2707, 16,  9, 'singles', 'mixed_doubles'),
    ( 9, 'Jaipur Pickleball Premier',        'pickleball',   'Jaipur',     26.9124, 75.7873, 17,  8, 'singles', 'doubles'),
    (10, 'Kolkata Table Tennis Open',        'table-tennis', 'Kolkata',    22.5726, 88.3639, 19, 10, 'singles', NULL),
    (11, 'Lucknow Badminton Night Cup',      'badminton',    'Lucknow',    26.8467, 80.9462, 20, 18, 'doubles', 'mixed_doubles'),
    (12, 'Bengaluru Padel Social',           'padel',        'Bengaluru',  12.9716, 77.5946, 21, 16, 'doubles', NULL),
    (13, 'Mumbai Tennis Open',               'tennis',       'Mumbai',     19.0760, 72.8777, 23,  7, 'singles', 'doubles'),
    (14, 'Ahmedabad Pickleball Championship','pickleball',   'Ahmedabad',  23.0225, 72.5714, 24,  8, 'singles', 'doubles'),
    (15, 'Noida Badminton Open',             'badminton',    'Noida',      28.5355, 77.3910, 26,  9, 'singles', 'doubles'),
    (16, 'Delhi Pickleball Challenge',       'pickleball',   'Delhi',      28.6139, 77.2090, 28,  8, 'doubles', 'mixed_doubles'),
    (17, 'Pune Table Tennis Cup',            'table-tennis', 'Pune',       18.5204, 73.8567, 30, 10, 'singles', 'doubles'),
    (18, 'Hyderabad Pickleball Fiesta',      'pickleball',   'Hyderabad',  17.3850, 78.4867, 33,  8, 'singles', 'mixed_doubles'),
    (19, 'Chandigarh Tennis Doubles Open',   'tennis',       'Chandigarh', 30.7333, 76.7794, 35,  7, 'doubles', 'mixed_doubles'),
    (20, 'Lucknow Squash Championship',      'squash',       'Lucknow',    26.8467, 80.9462, 40,  9, 'singles', NULL)
  ) AS v(n, title, sport_slug, city, lat, lng, days_ahead, start_hour, format1, format2)
  JOIN sports s ON s.slug = v.sport_slug AND s.active;

  IF (SELECT count(*) FROM seed_events) <> 20 THEN
    RAISE EXCEPTION 'Only % of 20 events matched an active sport — check the sports table.', (SELECT count(*) FROM seed_events);
  END IF;

  INSERT INTO events (
    id, sport_id, organizer_id, slug, title, description, city, geo, timezone,
    starts_at, ends_at, registration_closes_at, cancellation_cutoff_at,
    status, kind, contact_phone, host_terms_accepted_at, refund_policy, updated_at
  )
  SELECT
    e.id, e.sport_id, organizer,
    -- slugify(title) plus a 4-hex suffix, as the app does on a clash.
    left(trim(both '-' from regexp_replace(lower(e.title), '[^a-z0-9]+', '-', 'g')), 55)
      || '-' || substr(md5(e.id::text), 1, 4),
    e.title,
    'A friendly ' || e.city || ' tournament. Free to enter — bring your own racket and water.',
    e.city,
    ST_SetSRID(ST_MakePoint(e.lng, e.lat), 4326)::geography,   -- longitude first
    'Asia/Kolkata',
    e.starts_at,
    e.starts_at + interval '8 hours',
    e.starts_at - interval '1 day',
    e.starts_at - interval '2 days',
    'published', 'tournament', contact_phone, now(), 'standard', now()
  FROM seed_events e;

  -- The host runs their own event (what events.create writes).
  INSERT INTO event_staff (event_id, user_id, role)
  SELECT id, organizer, 'owner' FROM seed_events;

  -- One or two free draws per event, rule frozen from the sport (format rule, else sport default).
  INSERT INTO event_categories (
    id, event_id, sport_id, name, format, team_size, draw_type, capacity, min_entries,
    entry_fee_paise, platform_fee_paise, tax_bps, commission_bps, status, third_place, scoring_rule
  )
  SELECT
    ('5eed' || substr(md5(random()::text || clock_timestamp()::text || e.id::text || c.format_key), 1, 28))::uuid,
    e.id, e.sport_id,
    'Open ' || f.name,
    f.key, f.team_size, 'single_elim_with_plate',
    CASE WHEN f.team_size = 1 THEN 16 ELSE 12 END,
    4,
    0, 0, 0, 0, 'open', false,
    COALESCE(
      (SELECT r.rule FROM scoring_rules r WHERE r.sport_id = e.sport_id AND r.format_id = f.id),
      (SELECT r.rule FROM scoring_rules r WHERE r.sport_id = e.sport_id AND r.format_id IS NULL)
    )
  FROM seed_events e
  CROSS JOIN LATERAL (VALUES (e.format1), (e.format2)) AS c(format_key)
  JOIN formats f ON f.sport_id = e.sport_id AND f.key = c.format_key;

  IF EXISTS (
    SELECT 1 FROM seed_events e
    WHERE NOT EXISTS (SELECT 1 FROM event_categories c WHERE c.event_id = e.id)
  ) THEN
    RAISE EXCEPTION 'An event got no category — a format key does not exist for its sport.';
  END IF;
  IF EXISTS (SELECT 1 FROM event_categories c JOIN seed_events e ON e.id = c.event_id WHERE c.scoring_rule IS NULL) THEN
    RAISE EXCEPTION 'A sport has no scoring rule seeded — fix the sport before seeding events.';
  END IF;

  SELECT count(*) INTO created FROM seed_events;
  RAISE NOTICE 'Created % events.', created;
END $$;

-- What was created:
SELECT e.title, e.city, s.name AS sport,
       e.starts_at AT TIME ZONE 'Asia/Kolkata' AS starts_ist,
       e.slug,
       (SELECT string_agg(c.name, ', ' ORDER BY c.name) FROM event_categories c WHERE c.event_id = e.id) AS categories
  FROM events e JOIN sports s ON s.id = e.sport_id
 WHERE e.id::text LIKE '5eed%'
 ORDER BY e.starts_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLEANUP — removes exactly these events. Uncomment and run on its own.
-- It refuses if anyone has registered for one (that is a real entry now).
-- ─────────────────────────────────────────────────────────────────────────────
-- DO $$
-- BEGIN
--   IF EXISTS (SELECT 1 FROM registrations WHERE event_id::text LIKE '5eed%') THEN
--     RAISE EXCEPTION 'Players have registered for these events — cancel them in the app instead.';
--   END IF;
--   DELETE FROM event_staff      WHERE event_id::text LIKE '5eed%';
--   DELETE FROM event_categories WHERE event_id::text LIKE '5eed%';
--   DELETE FROM events           WHERE id::text       LIKE '5eed%';
-- END $$;
