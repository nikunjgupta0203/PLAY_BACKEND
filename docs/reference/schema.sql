-- =============================================================================
-- PL4Y — consolidated schema reference
--
-- This file is DOCUMENTATION, not the migration source of truth. Prisma owns
-- migrations; this is the whole schema in one place, in dependency order, so a
-- reviewer can read it without opening twenty files.
--
-- Regenerate after a schema change:  pnpm db:dump-schema
--
-- Conventions (see ../conventions.md §2):
--   · UUIDv7 primary keys
--   · money as bigint in paise, column suffix _paise
--   · timestamptz, stored UTC
--   · sport_id NOT NULL on every competitive row
--   · status as text + CHECK, never a Postgres enum
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- court_assignments exclusion constraint
CREATE EXTENSION IF NOT EXISTS postgis;      -- VERIFY ON NEON FIRST — ADR 0001 §C1


-- =============================================================================
-- 000 — platform
-- =============================================================================

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  request_id    text,
  claimed_at    timestamptz,
  processed_at  timestamptz,
  attempts      smallint NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE processed_at IS NULL;


-- =============================================================================
-- 001 — identity
-- =============================================================================

CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            citext UNIQUE NOT NULL,       -- the identity (ADR 0002)
  phone_e164       text,                         -- optional contact only, never auth
  email_status     text NOT NULL DEFAULT 'ok'
                   CHECK (email_status IN ('ok','bounced','complained')),
  display_name     text NOT NULL,
  avatar_public_id text,                         -- Cloudinary public_id (ADR 0003)
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','deleted')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- profile.search() matches display names with ILIKE '%q%'; only a trigram index
-- serves that. The column stays owned by identity.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX users_display_name_idx ON users USING gin (display_name gin_trgm_ops);

CREATE TABLE otp_challenges (
  id                uuid PRIMARY KEY,
  email             citext NOT NULL,
  code_hash         text NOT NULL,               -- argon2id; never the plaintext
  purpose           text NOT NULL CHECK (purpose IN ('signup','login','email_change')),
  attempts          smallint NOT NULL DEFAULT 0,
  consumed_at       timestamptz,
  expires_at        timestamptz NOT NULL,
  resend_message_id text,                        -- correlate with delivery events
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_challenges (email, created_at DESC);

CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  token_hash      text NOT NULL UNIQUE,
  family_id       uuid NOT NULL,                 -- rotation lineage
  device_label    text,
  revoked_at      timestamptz,
  replaced_by     uuid REFERENCES refresh_tokens(id),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON refresh_tokens (family_id);

-- Organizer is a grant on an event, not a global role.
-- The events FK is added in 005, after that table exists.
CREATE TABLE event_staff (
  event_id        uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('owner','manager','scorer')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_staff (user_id);


-- =============================================================================
-- 002 — sport
-- =============================================================================

CREATE TABLE sports (
  id            uuid PRIMARY KEY,
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  sort_order    smallint NOT NULL DEFAULT 0
);

CREATE TABLE formats (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  key           text NOT NULL,              -- singles | doubles | mixed_doubles | team
  name          text NOT NULL,
  team_size     smallint NOT NULL CHECK (team_size > 0),
  UNIQUE (sport_id, key)
);

CREATE TABLE skill_bands (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  key           text NOT NULL,              -- '3.5'
  label         text NOT NULL,
  lower_bound   numeric(4,2),
  upper_bound   numeric(4,2),
  sort_order    smallint NOT NULL,
  UNIQUE (sport_id, key),
  CHECK (lower_bound IS NULL OR upper_bound IS NULL OR lower_bound <= upper_bound)
);

CREATE TABLE scoring_rules (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  format_id     uuid REFERENCES formats(id),     -- null = default for the sport
  rule          jsonb NOT NULL,                  -- the ScoringRule shape
  -- NULLS NOT DISTINCT: format_id IS NULL means "the sport default", and two
  -- defaults is a seed bug that would otherwise surface as an arbitrary answer.
  UNIQUE NULLS NOT DISTINCT (sport_id, format_id)
);


-- =============================================================================
-- 003 — profile
-- =============================================================================

CREATE TABLE player_profiles (
  id              uuid PRIMARY KEY,
  user_id         uuid UNIQUE NOT NULL REFERENCES users(id),
  city            text,
  geo             geography(Point,4326),
  bio             text,
  visibility      text NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public','players_only','private')),
  stats           jsonb NOT NULL DEFAULT '{}',   -- materialised snapshot
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON player_profiles (city);

CREATE TABLE player_sports (
  player_id       uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  sport_id        uuid NOT NULL REFERENCES sports(id),
  skill_band      text NOT NULL,                 -- self-declared
  rating          numeric(7,2),                  -- derived; profile.applyRating() only
  rating_dev      numeric(7,2),
  volatility      numeric(7,5),
  is_provisional  boolean NOT NULL DEFAULT true,
  matches_played  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, sport_id)
);
CREATE INDEX ON player_sports (sport_id, rating DESC NULLS LAST);

CREATE TABLE achievements (
  id              uuid PRIMARY KEY,
  player_id       uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  sport_id        uuid REFERENCES sports(id),
  key             text NOT NULL,
  event_id        uuid,
  earned_at       timestamptz NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT: event_id IS NULL is a standing achievement, awarded once.
  UNIQUE NULLS NOT DISTINCT (player_id, key, event_id)
);

CREATE TABLE follows (
  follower_id     uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  followee_id     uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX ON follows (followee_id);


-- =============================================================================
-- 004 — venues
-- =============================================================================

CREATE TABLE venues (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  address       text NOT NULL,
  city          text NOT NULL,
  geo           geography(Point,4326) NOT NULL,
  amenities     text[] NOT NULL DEFAULT '{}',
  photo_public_ids text[] NOT NULL DEFAULT '{}',   -- Cloudinary public_ids
  created_by    uuid NOT NULL REFERENCES users(id),
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venues_geo_idx  ON venues USING gist (geo) WHERE deleted_at IS NULL;
CREATE INDEX venues_city_idx ON venues (city)           WHERE deleted_at IS NULL;

CREATE TABLE venue_courts (
  id            uuid PRIMARY KEY,
  venue_id      uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name          text NOT NULL,
  surface       text,
  indoor        boolean NOT NULL DEFAULT false,
  sport_ids     uuid[] NOT NULL DEFAULT '{}',
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (venue_id, name)
);


-- =============================================================================
-- 005 — events
-- =============================================================================

CREATE TABLE events (
  id              uuid PRIMARY KEY,
  sport_id        uuid NOT NULL REFERENCES sports(id),
  organizer_id    uuid NOT NULL REFERENCES users(id),
  venue_id        uuid REFERENCES venues(id),
  slug            text UNIQUE NOT NULL,          -- permanent once published
  title           text NOT NULL,
  description     text,
  city            text NOT NULL,
  geo             geography(Point,4326),
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  registration_closes_at timestamptz NOT NULL,
  cancellation_cutoff_at timestamptz,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','live','completed','cancelled')),
  cover_public_id text,                            -- Cloudinary public_id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_discovery_idx ON events (sport_id, city, starts_at)
  WHERE status IN ('published','live');
CREATE INDEX events_geo_idx ON events USING gist (geo)
  WHERE status IN ('published','live');

ALTER TABLE event_staff
  ADD CONSTRAINT event_staff_event_fk FOREIGN KEY (event_id) REFERENCES events(id);

CREATE TABLE event_categories (
  id                 uuid PRIMARY KEY,
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sport_id           uuid NOT NULL REFERENCES sports(id),
  name               text NOT NULL,
  format             text NOT NULL,
  team_size          smallint NOT NULL DEFAULT 1,
  draw_type          text NOT NULL DEFAULT 'single_elim_with_plate',
  skill_min          numeric(4,2),
  skill_max          numeric(4,2),
  age_min            smallint,
  age_max            smallint,
  capacity           integer NOT NULL CHECK (capacity > 0),
  min_entries        smallint NOT NULL DEFAULT 4,
  entry_fee_paise    bigint NOT NULL,
  platform_fee_paise bigint NOT NULL DEFAULT 0,
  tax_bps            integer NOT NULL DEFAULT 1800,   -- 18% GST, basis points
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','full','closed','drawn','completed','cancelled'))
);
CREATE INDEX ON event_categories (event_id);

CREATE TABLE event_media (
  id            uuid PRIMARY KEY,
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  public_id     text NOT NULL,                   -- Cloudinary public_id
  kind          text NOT NULL CHECK (kind IN ('cover','gallery','sponsor')),
  sort_order    smallint NOT NULL DEFAULT 0
);


-- =============================================================================
-- 006 — registration
-- =============================================================================

CREATE TABLE teams (
  id                uuid PRIMARY KEY,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  name              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  is_captain      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE registrations (
  id                uuid PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES events(id),
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  sport_id          uuid NOT NULL REFERENCES sports(id),
  captain_user_id   uuid NOT NULL REFERENCES users(id),   -- the payer
  team_id           uuid REFERENCES teams(id),            -- null for singles
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN (
                      'draft','awaiting_partner','payment_pending','confirmed',
                      'checked_in','withdrawn','expired','payment_failed','refunded')),
  seed              integer,
  amount_paise      bigint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  confirmed_at      timestamptz
);

-- registration R1: one live entry per player per category.
CREATE UNIQUE INDEX reg_one_live_per_player
  ON registrations (event_category_id, captain_user_id)
  WHERE status IN ('awaiting_partner','payment_pending','confirmed','checked_in');

CREATE TABLE registration_invites (
  id              uuid PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  invited_email   citext NOT NULL,        -- the partner may have no account yet
  invited_user_id uuid REFERENCES users(id),
  token           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','declined','expired')),
  expires_at      timestamptz NOT NULL,   -- +48h
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON registration_invites (invited_email) WHERE status = 'pending';

-- Correctness lives in Postgres, not Redis: a lost key here means an
-- oversold tournament with physical courts.
CREATE TABLE seat_holds (
  id                uuid PRIMARY KEY,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  registration_id   uuid NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  seats             smallint NOT NULL DEFAULT 1,
  expires_at        timestamptz NOT NULL,
  released_at       timestamptz
);
CREATE INDEX seat_holds_active_idx ON seat_holds (event_category_id)
  WHERE released_at IS NULL;


-- =============================================================================
-- 007 — payments
-- =============================================================================

CREATE TABLE payment_orders (
  id                 uuid PRIMARY KEY,
  registration_id    uuid NOT NULL REFERENCES registrations(id),
  razorpay_order_id  text UNIQUE NOT NULL,
  entry_fee_paise    bigint NOT NULL,
  platform_fee_paise bigint NOT NULL,
  tax_paise          bigint NOT NULL,
  amount_paise       bigint NOT NULL,
  currency           text NOT NULL DEFAULT 'INR',
  status             text NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','attempted','paid','failed','expired')),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payment_orders (registration_id);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  payment_order_id    uuid NOT NULL REFERENCES payment_orders(id),
  razorpay_payment_id text UNIQUE NOT NULL,
  method              text,                    -- upi | card | netbanking | wallet
  amount_paise        bigint NOT NULL,
  status              text NOT NULL CHECK (status IN
                        ('authorized','captured','failed','refunded','partially_refunded')),
  failure_reason      text,
  captured_at         timestamptz,
  raw                 jsonb NOT NULL           -- evidence for disputes
);

CREATE TABLE refunds (
  id                 uuid PRIMARY KEY,
  payment_id         uuid NOT NULL REFERENCES payments(id),
  razorpay_refund_id text UNIQUE,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  reason             text NOT NULL,
  idempotency_key    text UNIQUE NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending','processed','failed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);

-- Razorpay retries; this table is why that is harmless.
CREATE TABLE payment_webhook_events (
  razorpay_event_id  text PRIMARY KEY,
  event_type         text NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  attempts           smallint NOT NULL DEFAULT 0,
  last_error         text
);

-- What actually reconciles against a Razorpay settlement report.
CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  registration_id uuid REFERENCES registrations(id),
  payment_id      uuid REFERENCES payments(id),
  refund_id       uuid REFERENCES refunds(id),
  kind            text NOT NULL CHECK (kind IN
                    ('charge','platform_fee','tax','refund','fee_reversal','tax_reversal')),
  amount_paise    bigint NOT NULL,              -- signed
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (registration_id);


-- =============================================================================
-- 009 — tournament   (008 rating comes later; it references matches)
-- =============================================================================

CREATE TABLE tournaments (
  id                uuid PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES events(id),
  event_category_id uuid UNIQUE NOT NULL REFERENCES event_categories(id),
  draw_type         text NOT NULL DEFAULT 'single_elim_with_plate',
  bracket_size      smallint NOT NULL CHECK (bracket_size >= 4),
  -- R5 — sized to the number of FIRST-ROUND LOSERS, which is the number of
  -- round-1 matches that are a real contest rather than a bye. Sizing it off
  -- the bracket instead would create plate positions nothing can ever fill.
  plate_size        smallint NOT NULL DEFAULT 0,
  drawn_at          timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE TABLE matches (
  id                uuid PRIMARY KEY,
  tournament_id     uuid NOT NULL REFERENCES tournaments(id),
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  sport_id          uuid NOT NULL REFERENCES sports(id),
  bracket           text NOT NULL CHECK (bracket IN ('championship','plate')),
  round             smallint NOT NULL,
  slot              smallint NOT NULL,
  side_a_registration_id uuid REFERENCES registrations(id),
  side_b_registration_id uuid REFERENCES registrations(id),
  -- `match_results` (010) belongs to scoring and records HOW a match was won.
  -- This records THAT it was won, because a final advances nobody and the
  -- champion of a draw has to be derivable from the draw.
  winner_registration_id uuid REFERENCES registrations(id),
  -- Wiring generated at draw time, both directions, so one write advances
  -- the winner AND drops the loser into the plate. A null loser_match_id on a
  -- round-1 match means that match is a bye: it has no loser to send.
  winner_match_id   uuid REFERENCES matches(id),
  winner_slot       smallint CHECK (winner_slot IN (0,1)),
  loser_match_id    uuid REFERENCES matches(id),
  loser_slot        smallint CHECK (loser_slot IN (0,1)),
  court_id          uuid REFERENCES venue_courts(id),
  scheduled_at      timestamptz,
  status            text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                      ('scheduled','ready','live','awaiting_confirm',
                       'completed','walkover','void')),
  current_score     jsonb,                     -- denormalized; owned by scoring
  score_seq         integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CHECK (winner_registration_id IS NULL
      OR winner_registration_id = side_a_registration_id
      OR winner_registration_id = side_b_registration_id),
  -- Wiring is a pair: a destination without a slot places a player nowhere.
  CHECK ((winner_match_id IS NULL) = (winner_slot IS NULL)),
  CHECK ((loser_match_id  IS NULL) = (loser_slot  IS NULL)),
  CHECK (winner_match_id IS DISTINCT FROM id AND loser_match_id IS DISTINCT FROM id),
  UNIQUE (tournament_id, bracket, round, slot)
);
CREATE INDEX matches_live_idx  ON matches (event_category_id, status, scheduled_at);
CREATE INDEX matches_court_idx ON matches (court_id, scheduled_at) WHERE court_id IS NOT NULL;
-- Advancement reads the wiring by TARGET — "what feeds this slot?" — which is
-- how a bye is told apart from a side that has not arrived yet.
CREATE INDEX matches_winner_match_id_idx ON matches (winner_match_id) WHERE winner_match_id IS NOT NULL;
CREATE INDEX matches_loser_match_id_idx  ON matches (loser_match_id)  WHERE loser_match_id  IS NOT NULL;

-- The booked window of an assignment. It is a FUNCTION because an index
-- expression must be IMMUTABLE and `timestamptz + interval` is only STABLE:
-- an interval carrying months or days lands on a different instant depending
-- on the session time zone. '45 minutes' carries neither, so IMMUTABLE here is
-- the truth rather than a promise nobody checks.
CREATE FUNCTION court_booking_window(starts_at timestamptz, ends_at timestamptz)
RETURNS tstzrange LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzrange(starts_at, coalesce(ends_at, starts_at + interval '45 minutes'))
$$;

CREATE TABLE court_assignments (
  match_id      uuid PRIMARY KEY REFERENCES matches(id),
  court_id      uuid NOT NULL REFERENCES venue_courts(id),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  assigned_by   text NOT NULL CHECK (assigned_by IN ('scheduler','organizer')),
  EXCLUDE USING gist (
    court_id WITH =,
    court_booking_window(starts_at, ends_at) WITH &&
  )
);


-- =============================================================================
-- 010 — scoring
-- =============================================================================

-- Append-only. Never updated, never deleted.
CREATE TABLE match_score_events (
  id            bigserial PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id),
  seq           integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN
                  ('point','undo','timeout','game_end','match_end','correction')),
  scoring_side  text CHECK (scoring_side IN ('a','b')),
  state_after   jsonb NOT NULL,               -- full score, not a delta
  recorded_by   uuid NOT NULL REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, seq)
);

CREATE TABLE match_results (
  match_id       uuid PRIMARY KEY REFERENCES matches(id),
  winner_registration_id uuid NOT NULL REFERENCES registrations(id),
  loser_registration_id  uuid REFERENCES registrations(id),
  games          jsonb NOT NULL,              -- [{a:11,b:7},{a:9,b:11},{a:11,b:5}]
  outcome        text NOT NULL CHECK (outcome IN
                   ('played','walkover','retired','forfeit')),
  submitted_by   uuid NOT NULL REFERENCES users(id),
  confirmed_by   uuid REFERENCES users(id),
  confirmed_at   timestamptz,
  rating_applied boolean NOT NULL DEFAULT false
);


-- =============================================================================
-- 008 — rating   (applied after 010: rating_events references matches)
-- =============================================================================

CREATE TABLE rating_periods (
  id            uuid PRIMARY KEY,
  sport_id      uuid NOT NULL REFERENCES sports(id),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  ran_at        timestamptz,
  algo_version  text NOT NULL,
  UNIQUE (sport_id, starts_at)
);

CREATE TABLE rating_events (
  id               bigserial PRIMARY KEY,
  player_id        uuid NOT NULL REFERENCES player_profiles(id),
  sport_id         uuid NOT NULL REFERENCES sports(id),
  match_id         uuid REFERENCES matches(id),
  rating_period_id uuid REFERENCES rating_periods(id),
  algo_version     text NOT NULL,             -- 'glicko2-v1'
  rating_before    numeric(7,2) NOT NULL,
  rating_after     numeric(7,2) NOT NULL,
  rd_before        numeric(7,2) NOT NULL,
  rd_after         numeric(7,2) NOT NULL,
  volatility_after numeric(7,5) NOT NULL,
  is_provisional   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rating_events (player_id, sport_id, created_at DESC);
CREATE UNIQUE INDEX rating_events_settled_uniq
  ON rating_events (player_id, match_id) WHERE is_provisional = false;

CREATE TABLE rankings (
  sport_id       uuid NOT NULL REFERENCES sports(id),
  scope          text NOT NULL,               -- 'national' | 'city:Bengaluru' | 'age:35+'
  player_id      uuid NOT NULL REFERENCES player_profiles(id),
  rank           integer NOT NULL,            -- dense
  rating         numeric(7,2) NOT NULL,
  matches_played integer NOT NULL,
  movement       integer NOT NULL DEFAULT 0,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (sport_id, scope, player_id)
);
CREATE INDEX rankings_board_idx ON rankings (sport_id, scope, rank);


-- =============================================================================
-- 011 — notifications
-- =============================================================================

CREATE TABLE notifications (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  template       text NOT NULL,
  payload        jsonb NOT NULL,
  deep_link_type text,                        -- 'event' | 'match' | 'player' | 'game'
  deep_link_id   uuid,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_feed_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE device_registrations (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         text NOT NULL UNIQUE,
  platform      text NOT NULL CHECK (platform IN ('ios','android','web')),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON device_registrations (user_id);

CREATE TABLE notification_preferences (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled  boolean NOT NULL DEFAULT true,
  muted         text[] NOT NULL DEFAULT '{}',
  quiet_hours   boolean NOT NULL DEFAULT true
);


-- =============================================================================
-- 012 — games        [Phase 2]
-- =============================================================================

CREATE TABLE games (
  id                uuid PRIMARY KEY,
  sport_id          uuid NOT NULL REFERENCES sports(id),
  created_by        uuid NOT NULL REFERENCES player_profiles(id),
  venue_id          uuid REFERENCES venues(id),
  location_note     text,
  geo               geography(Point,4326) NOT NULL,
  city              text NOT NULL,
  starts_at         timestamptz NOT NULL,
  duration_minutes  smallint NOT NULL DEFAULT 90,
  skill_band        text,
  capacity          smallint NOT NULL CHECK (capacity BETWEEN 2 AND 32),
  visibility        text NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public','followers')),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','full','cancelled','past')),
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (venue_id IS NOT NULL OR location_note IS NOT NULL)
);
CREATE INDEX games_geo_idx ON games USING gist (geo) WHERE status IN ('open','full');
CREATE INDEX games_discovery_idx ON games (sport_id, city, starts_at)
  WHERE status IN ('open','full');

CREATE TABLE game_participants (
  game_id       uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES player_profiles(id),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX ON game_participants (player_id);


-- =============================================================================
-- 013 — social       [Phase 2]
-- =============================================================================

CREATE TABLE challenges (
  id              uuid PRIMARY KEY,
  challenger_id   uuid NOT NULL REFERENCES player_profiles(id),
  opponent_id     uuid NOT NULL REFERENCES player_profiles(id),
  sport_id        uuid NOT NULL REFERENCES sports(id),
  venue_id        uuid REFERENCES venues(id),
  proposed_at     timestamptz NOT NULL,
  message         text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','accepted','declined','withdrawn','expired')),
  game_id         uuid REFERENCES games(id),
  expires_at      timestamptz NOT NULL,       -- +72h
  created_at      timestamptz NOT NULL DEFAULT now(),
  responded_at    timestamptz,
  CHECK (challenger_id <> opponent_id)
);
CREATE UNIQUE INDEX challenges_one_pending
  ON challenges (challenger_id, opponent_id) WHERE status = 'pending';
CREATE INDEX ON challenges (opponent_id, status);

CREATE TABLE feed_entries (
  id            bigserial PRIMARY KEY,
  actor_id      uuid NOT NULL REFERENCES player_profiles(id),
  kind          text NOT NULL CHECK (kind IN
                  ('match_won','tournament_entered','rank_changed',
                   'achievement','game_created')),
  subject_type  text,
  subject_id    uuid,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_actor_idx ON feed_entries (actor_id, created_at DESC);


-- =============================================================================
-- FEATURE-COVERAGE ADDITIONS                          see ../feature-coverage.md
--
-- Everything below comes from the spec update that mapped the product feature
-- list onto the modules. Blocks are in dependency order and tagged with the
-- sprint they land in. Once migrated, `pnpm db:dump-schema` folds them into the
-- sections above and this banner goes away.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- discovery search_documents


-- -----------------------------------------------------------------------------
-- 001 identity — additions                              [S7 · S11]
-- -----------------------------------------------------------------------------

ALTER TABLE event_staff
  ADD COLUMN source text NOT NULL DEFAULT 'direct' CHECK (source IN ('direct','organizer')),
  ADD COLUMN organizer_profile_id uuid;                            -- identity R16
ALTER TABLE event_staff DROP CONSTRAINT event_staff_pkey;
ALTER TABLE event_staff ADD PRIMARY KEY (event_id, user_id, source);

ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;    -- identity R18

CREATE TABLE platform_staff (                                      -- identity R15
  user_id         uuid PRIMARY KEY REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('admin','support','finance')),
  granted_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE venue_staff (                                         -- identity R17
  venue_id        uuid NOT NULL REFERENCES venues(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('owner','manager','desk')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, user_id)
);
CREATE INDEX ON venue_staff (user_id);
CREATE UNIQUE INDEX venue_one_owner ON venue_staff (venue_id) WHERE role = 'owner';


-- -----------------------------------------------------------------------------
-- 003 profile — additions                               [S7 · S8 · S11]
-- -----------------------------------------------------------------------------

-- NULL event_id made the old UNIQUE allow duplicate awards. (profile R13)
ALTER TABLE achievements DROP CONSTRAINT achievements_player_id_key_event_id_key;
ALTER TABLE achievements ADD CONSTRAINT achievements_award_uniq
  UNIQUE NULLS NOT DISTINCT (player_id, key, event_id);
ALTER TABLE achievements ADD COLUMN tier smallint;

CREATE TABLE player_preferences (                                  -- profile R11
  player_id           uuid PRIMARY KEY REFERENCES player_profiles(id) ON DELETE CASCADE,
  preferred_formats   text[] NOT NULL DEFAULT '{}',
  availability        jsonb NOT NULL DEFAULT '[]',
  travel_radius_km    smallint NOT NULL DEFAULT 10 CHECK (travel_radius_km BETWEEN 1 AND 50),
  preferred_venue_ids uuid[] NOT NULL DEFAULT '{}',
  looking_for         text[] NOT NULL DEFAULT '{}',
  open_to_matching    boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_match_history (                                -- profile R12 (projection)
  player_id       uuid NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  match_id        uuid NOT NULL,
  sport_id        uuid NOT NULL REFERENCES sports(id),
  event_id        uuid,
  partner_ids     uuid[] NOT NULL DEFAULT '{}',
  opponent_ids    uuid[] NOT NULL DEFAULT '{}',
  won             boolean NOT NULL,
  outcome         text NOT NULL,
  games           jsonb NOT NULL,
  completed_at    timestamptz NOT NULL,
  PRIMARY KEY (player_id, match_id)
);
CREATE INDEX ON player_match_history (player_id, completed_at DESC, match_id);


-- -----------------------------------------------------------------------------
-- 004 venues — additions                                [S11 · Phase 2]
-- -----------------------------------------------------------------------------

ALTER TABLE venues
  ADD COLUMN description   text,
  ADD COLUMN opening_hours jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN contact_phone text,
  ADD COLUMN rating_avg    numeric(3,2),                            -- venues R7
  ADD COLUMN rating_count  integer NOT NULL DEFAULT 0;
ALTER TABLE venue_courts
  ADD COLUMN kind text NOT NULL DEFAULT 'court'
  CHECK (kind IN ('court','turf','ground','pitch','table'));       -- venues R10

CREATE TABLE venue_visits (                                        -- venues R6 (projection)
  venue_id      uuid NOT NULL REFERENCES venues(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  source        text NOT NULL CHECK (source IN ('match','game','booking')),
  source_id     uuid NOT NULL,
  visited_at    timestamptz NOT NULL,
  PRIMARY KEY (source, source_id, user_id)
);
CREATE INDEX ON venue_visits (venue_id, user_id, visited_at DESC);

CREATE TABLE venue_reviews (                                       -- venues R6–R8
  id            uuid PRIMARY KEY,
  venue_id      uuid NOT NULL REFERENCES venues(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  stars         smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body          text CHECK (char_length(body) <= 1000),
  reply_body    text,
  replied_by    uuid REFERENCES users(id),
  replied_at    timestamptz,
  hidden_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, user_id)
);
CREATE INDEX ON venue_reviews (venue_id, created_at DESC) WHERE hidden_at IS NULL;

CREATE TABLE venue_claims (                                        -- venues R9
  id            uuid PRIMARY KEY,
  venue_id      uuid NOT NULL REFERENCES venues(id),
  claimant_id   uuid NOT NULL REFERENCES users(id),
  evidence      jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX venue_claim_one_pending ON venue_claims (venue_id) WHERE status = 'pending';


-- -----------------------------------------------------------------------------
-- 014 — organizers                                      [S7 · Phase 1]
-- -----------------------------------------------------------------------------

CREATE TABLE organizer_profiles (
  id                uuid PRIMARY KEY,
  slug              text UNIQUE NOT NULL,
  name              text NOT NULL,
  bio               text,
  city              text,
  logo_public_id    text,
  contact_email     citext,
  contact_phone     text,
  verification      text NOT NULL DEFAULT 'unverified' CHECK (verification IN
                      ('unverified','pending','verified','rejected','suspended')),
  verification_note text,
  verified_at       timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizer_members (
  organizer_profile_id uuid NOT NULL REFERENCES organizer_profiles(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id),
  role                 text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_profile_id, user_id)
);
CREATE INDEX ON organizer_members (user_id);

ALTER TABLE event_staff
  ADD FOREIGN KEY (organizer_profile_id) REFERENCES organizer_profiles(id);


-- -----------------------------------------------------------------------------
-- 005 events — additions                                [S7 · S13]
-- -----------------------------------------------------------------------------

ALTER TABLE events
  ADD COLUMN kind text NOT NULL DEFAULT 'tournament'
    CHECK (kind IN ('tournament','league_season')),                -- events R11
  ADD COLUMN hidden_at timestamptz,                                -- events R12
  ADD COLUMN organizer_profile_id uuid REFERENCES organizer_profiles(id);  -- events R13

DROP INDEX events_discovery_idx;
DROP INDEX events_geo_idx;
CREATE INDEX events_discovery_idx ON events (sport_id, kind, city, starts_at)
  WHERE status IN ('published','live') AND hidden_at IS NULL;
CREATE INDEX events_geo_idx ON events USING gist (geo)
  WHERE status IN ('published','live') AND hidden_at IS NULL;

ALTER TABLE event_categories DROP CONSTRAINT IF EXISTS event_categories_draw_type_check;
ALTER TABLE event_categories ADD CONSTRAINT event_categories_draw_type_check
  CHECK (draw_type IN ('single_elim_with_plate','round_robin'));

CREATE TABLE event_category_allowlists (                           -- events R14
  event_category_id uuid NOT NULL REFERENCES event_categories(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id),
  until             timestamptz NOT NULL,
  PRIMARY KEY (event_category_id, user_id)
);

-- organizers read models that reference events
CREATE TABLE organizer_broadcasts (                                -- organizers R6, R7
  id              uuid PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES events(id),
  sent_by         uuid NOT NULL REFERENCES users(id),
  audience        text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL CHECK (char_length(body) <= 1000),
  with_email      boolean NOT NULL DEFAULT false,
  recipient_count integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON organizer_broadcasts (event_id, created_at DESC);

CREATE TABLE event_stats_daily (                                   -- organizers R8, R9
  event_id            uuid NOT NULL REFERENCES events(id),
  event_category_id   uuid REFERENCES event_categories(id),
  day                 date NOT NULL,
  views               integer NOT NULL DEFAULT 0,
  registrations_begun integer NOT NULL DEFAULT 0,
  confirmed           integer NOT NULL DEFAULT 0,
  checked_in          integer NOT NULL DEFAULT 0,
  refunds             integer NOT NULL DEFAULT 0,
  UNIQUE NULLS NOT DISTINCT (event_id, event_category_id, day)
);


-- -----------------------------------------------------------------------------
-- 006 registration — additions                          [S4 · S5 · S7 · S11 · S13]
-- -----------------------------------------------------------------------------

ALTER TABLE registrations
  ADD COLUMN payment_mode text NOT NULL DEFAULT 'online'
    CHECK (payment_mode IN ('online','offline','comp')),          -- registration R14
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN checked_in_by uuid REFERENCES users(id),              -- registration R13
  ADD COLUMN source_community_id uuid,                             -- registration R19
  ADD COLUMN withdrawn_reason text;                                -- registration R16
ALTER TABLE registrations DROP CONSTRAINT registrations_status_check;
ALTER TABLE registrations ADD CONSTRAINT registrations_status_check CHECK (status IN (
  'draft','awaiting_partner','waitlisted','payment_pending','confirmed',
  'checked_in','withdrawn','expired','payment_failed','refunded'));

DROP INDEX reg_one_live_per_player;
CREATE UNIQUE INDEX reg_one_live_per_player
  ON registrations (event_category_id, captain_user_id)
  WHERE status IN ('awaiting_partner','waitlisted','payment_pending','confirmed','checked_in');

CREATE TABLE waitlist_entries (                                    -- registration R17
  registration_id   uuid PRIMARY KEY REFERENCES registrations(id) ON DELETE CASCADE,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  offered_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON waitlist_entries (event_category_id, created_at) WHERE offered_at IS NULL;

CREATE TABLE partner_requests (                                    -- registration R20
  id                uuid PRIMARY KEY,
  event_category_id uuid NOT NULL REFERENCES event_categories(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  note              text CHECK (char_length(note) <= 280),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_request_one_open
  ON partner_requests (event_category_id, user_id) WHERE status = 'open';


-- -----------------------------------------------------------------------------
-- 007 payments — additions                              [S7 · S14]
-- -----------------------------------------------------------------------------

CREATE TABLE payout_accounts (                                     -- payments R13
  id                  uuid PRIMARY KEY,
  owner_type          text NOT NULL CHECK (owner_type IN ('organizer','venue')),
  owner_id            uuid NOT NULL,
  razorpay_account_id text UNIQUE,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN
                        ('created','under_review','needs_clarification','active','suspended')),
  raw                 jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE payouts (                                             -- payments R14–R16
  id                   uuid PRIMARY KEY,
  payout_account_id    uuid NOT NULL REFERENCES payout_accounts(id),
  subject_type         text NOT NULL CHECK (subject_type IN ('event','venue_week')),
  subject_key          text NOT NULL,
  amount_paise         bigint NOT NULL CHECK (amount_paise >= 0),
  quote                jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                         ('scheduled','held','processing','processed','failed','reversed')),
  hold_reason          text,
  razorpay_transfer_id text UNIQUE,
  scheduled_for        timestamptz NOT NULL,
  processed_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_key, payout_account_id)
);

CREATE TABLE payment_disputes (                                    -- payments R19
  id                  uuid PRIMARY KEY,
  payment_id          uuid NOT NULL REFERENCES payments(id),
  razorpay_dispute_id text UNIQUE NOT NULL,
  amount_paise        bigint NOT NULL,
  reason_code         text,
  status              text NOT NULL CHECK (status IN ('open','under_review','won','lost','closed')),
  respond_by          timestamptz,
  raw                 jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ledger_entries
  ADD COLUMN payout_id uuid REFERENCES payouts(id),
  DROP CONSTRAINT ledger_entries_kind_check,
  ADD CONSTRAINT ledger_entries_kind_check CHECK (kind IN
    ('charge','platform_fee','tax','refund','fee_reversal','tax_reversal',
     'gateway_fee','payout','payout_reversal','organizer_receivable','dispute_debit'));  -- payments R18


-- -----------------------------------------------------------------------------
-- 009 tournament — additions                            [S13 · Phase 3]
-- -----------------------------------------------------------------------------

ALTER TABLE matches DROP CONSTRAINT matches_bracket_check;
ALTER TABLE matches ADD CONSTRAINT matches_bracket_check
  CHECK (bracket IN ('championship','plate','league'));             -- tournament R14

CREATE TABLE tournament_standings (                                -- tournament R15
  tournament_id     uuid NOT NULL REFERENCES tournaments(id),
  registration_id   uuid NOT NULL REFERENCES registrations(id),
  played            smallint NOT NULL DEFAULT 0,
  won               smallint NOT NULL DEFAULT 0,
  lost              smallint NOT NULL DEFAULT 0,
  games_for         smallint NOT NULL DEFAULT 0,
  games_against     smallint NOT NULL DEFAULT 0,
  points_for        integer  NOT NULL DEFAULT 0,
  points_against    integer  NOT NULL DEFAULT 0,
  league_points     smallint NOT NULL DEFAULT 0,
  position          smallint,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, registration_id)
);


-- -----------------------------------------------------------------------------
-- 011 notifications — additions                         [S9 · S11]
-- -----------------------------------------------------------------------------

ALTER TABLE notifications ADD COLUMN deep_link_route text;         -- notifications R10


-- -----------------------------------------------------------------------------
-- 015 — admin                                           [S7 core · S12 queues]
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (                                           -- admin R2; append-only
  id            bigserial PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  actor_role    text NOT NULL,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text NOT NULL,
  reason        text NOT NULL CHECK (char_length(reason) > 0),
  diff          jsonb NOT NULL DEFAULT '{}',
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (target_type, target_id, created_at DESC);
CREATE INDEX ON audit_log (actor_user_id, created_at DESC);
-- REVOKE UPDATE, DELETE ON audit_log FROM app_role;

CREATE TABLE moderation_reports (                                  -- admin R6
  id            uuid PRIMARY KEY,
  reporter_id   uuid NOT NULL REFERENCES users(id),
  target_type   text NOT NULL CHECK (target_type IN
                  ('player','venue_review','event','game','community','community_announcement')),
  target_id     uuid NOT NULL,
  reason        text NOT NULL CHECK (reason IN
                  ('spam','abuse','fake','unsafe','inaccurate','other')),
  note          text,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX moderation_one_open
  ON moderation_reports (reporter_id, target_type, target_id) WHERE status = 'open';
CREATE INDEX ON moderation_reports (target_type, target_id) WHERE status = 'open';

CREATE TABLE support_tickets (                                     -- admin R7
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id),
  subject           text NOT NULL,
  linked_type       text,
  linked_id         uuid,
  request_id        text,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN
                      ('open','pending_user','resolved','closed')),
  assigned_to       uuid REFERENCES users(id),
  first_response_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON support_tickets (status, created_at);
CREATE INDEX ON support_tickets (user_id, created_at DESC);

CREATE TABLE support_messages (
  id            uuid PRIMARY KEY,
  ticket_id     uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users(id),
  body          text NOT NULL,
  internal      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fraud_signals (                                       -- admin R8
  id            bigserial PRIMARY KEY,
  subject_type  text NOT NULL CHECK (subject_type IN ('user','organizer','venue','device')),
  subject_id    text NOT NULL,
  detector      text NOT NULL,
  score         smallint NOT NULL CHECK (score BETWEEN 1 AND 100),
  evidence      jsonb NOT NULL DEFAULT '{}',
  reviewed_at   timestamptz,
  reviewed_by   uuid REFERENCES users(id),
  outcome       text CHECK (outcome IN ('confirmed','dismissed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fraud_signals (subject_type, subject_id, created_at DESC);

CREATE TABLE platform_metrics_daily (                              -- admin R9
  day           date NOT NULL,
  metric        text NOT NULL,
  dimension     text NOT NULL DEFAULT '',
  value         bigint NOT NULL,
  PRIMARY KEY (day, metric, dimension)
);


-- -----------------------------------------------------------------------------
-- 017 — communities                                     [S11 · Phase 2]
-- -----------------------------------------------------------------------------

CREATE TABLE communities (
  id              uuid PRIMARY KEY,
  slug            text UNIQUE NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('club','group','team')),
  name            text NOT NULL,
  sport_id        uuid REFERENCES sports(id),
  city            text,
  geo             geography(Point,4326),
  description     text,
  logo_public_id  text,
  home_venue_id   uuid REFERENCES venues(id),
  join_policy     text NOT NULL DEFAULT 'approval'
                  CHECK (join_policy IN ('open','approval','invite_only')),
  visibility      text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  member_count    integer NOT NULL DEFAULT 0,
  hidden_at       timestamptz,
  created_by      uuid NOT NULL REFERENCES player_profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'team' OR sport_id IS NOT NULL)
);
CREATE INDEX communities_geo_idx ON communities USING gist (geo)
  WHERE visibility = 'public' AND hidden_at IS NULL;

CREATE TABLE community_members (
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES player_profiles(id),
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  is_captain      boolean NOT NULL DEFAULT false,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, player_id)
);
CREATE INDEX ON community_members (player_id);
CREATE UNIQUE INDEX community_one_owner ON community_members (community_id) WHERE role = 'owner';

CREATE TABLE community_join_requests (
  id              uuid PRIMARY KEY,
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES player_profiles(id),
  kind            text NOT NULL CHECK (kind IN ('request','invite')),
  note            text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX community_one_pending
  ON community_join_requests (community_id, player_id) WHERE status = 'pending';

CREATE TABLE community_announcements (
  id              uuid PRIMARY KEY,
  community_id    uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES player_profiles(id),
  title           text NOT NULL,
  body            text NOT NULL CHECK (char_length(body) <= 2000),
  hidden_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON community_announcements (community_id, created_at DESC);

ALTER TABLE registrations
  ADD FOREIGN KEY (source_community_id) REFERENCES communities(id);   -- registration R19


-- -----------------------------------------------------------------------------
-- 012 games — additions                                 [S11 · Phase 2]
-- -----------------------------------------------------------------------------

CREATE TABLE game_series (                                         -- games R10, R11
  id                 uuid PRIMARY KEY,
  created_by         uuid NOT NULL REFERENCES player_profiles(id),
  template           jsonb NOT NULL,
  weekdays           smallint[] NOT NULL CHECK (array_length(weekdays, 1) BETWEEN 1 AND 7),
  start_time         time NOT NULL,
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata',
  interval_weeks     smallint NOT NULL DEFAULT 1 CHECK (interval_weeks BETWEEN 1 AND 4),
  starts_on          date NOT NULL,
  ends_on            date NOT NULL CHECK (ends_on <= starts_on + 182),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','ended')),
  materialized_until date,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE game_series_members (
  series_id       uuid NOT NULL REFERENCES game_series(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES player_profiles(id),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, player_id)
);

ALTER TABLE games
  ADD COLUMN kind text NOT NULL DEFAULT 'pickup' CHECK (kind IN ('pickup','open_play')),  -- games R8
  ADD COLUMN courts_count smallint,
  ADD COLUMN series_id uuid REFERENCES game_series(id),
  ADD COLUMN community_id uuid REFERENCES communities(id),          -- games R12
  DROP CONSTRAINT games_capacity_check,
  ADD CONSTRAINT games_capacity_check CHECK (
    (kind = 'pickup'    AND capacity BETWEEN 2 AND 32) OR
    (kind = 'open_play' AND capacity BETWEEN 4 AND 64)),
  DROP CONSTRAINT games_visibility_check,
  ADD CONSTRAINT games_visibility_check CHECK (visibility IN ('public','followers','community')),
  ADD CONSTRAINT games_community_visibility CHECK (visibility <> 'community' OR community_id IS NOT NULL);
CREATE UNIQUE INDEX games_series_instance ON games (series_id, starts_at) WHERE series_id IS NOT NULL;

ALTER TABLE game_participants
  ADD COLUMN status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined','waitlisted'));  -- games R9
CREATE INDEX ON game_participants (game_id, joined_at) WHERE status = 'waitlisted';


-- -----------------------------------------------------------------------------
-- 013 social — additions                                [S11 · Phase 2]
-- -----------------------------------------------------------------------------

ALTER TABLE feed_entries
  DROP CONSTRAINT feed_entries_kind_check,
  ADD CONSTRAINT feed_entries_kind_check CHECK (kind IN
    ('match_won','tournament_entered','rank_changed','achievement','game_created',
     'game_joined','community_joined','league_entered'));          -- social R9


-- -----------------------------------------------------------------------------
-- 016 — discovery                                       [S11 · Phase 2]
-- -----------------------------------------------------------------------------

CREATE TABLE search_documents (                                    -- discovery R1 (projection)
  kind          text NOT NULL CHECK (kind IN
                  ('event','league','game','venue','player','community')),
  subject_id    uuid NOT NULL,
  sport_id      uuid REFERENCES sports(id),
  title         text NOT NULL,
  city          text,
  geo           geography(Point,4326),
  starts_at     timestamptz,
  visibility    text NOT NULL,
  listed        boolean NOT NULL DEFAULT true,
  attrs         jsonb NOT NULL DEFAULT '{}',
  tsv           tsvector NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject_id)
);
CREATE INDEX search_tsv_idx    ON search_documents USING gin (tsv) WHERE listed;
CREATE INDEX search_title_trgm ON search_documents USING gin (title gin_trgm_ops) WHERE listed;
CREATE INDEX search_geo_idx    ON search_documents USING gist (geo) WHERE listed;
CREATE INDEX search_facet_idx  ON search_documents (kind, sport_id, city, starts_at) WHERE listed;

CREATE TABLE recommendation_dismissals (                           -- discovery R9
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, subject_type, subject_id)
);


-- -----------------------------------------------------------------------------
-- 018 — leagues                                         [S13 · Phase 3]
-- -----------------------------------------------------------------------------

CREATE TABLE leagues (
  id                   uuid PRIMARY KEY,
  organizer_profile_id uuid NOT NULL REFERENCES organizer_profiles(id),
  sport_id             uuid NOT NULL REFERENCES sports(id),
  slug                 text UNIQUE NOT NULL,
  name                 text NOT NULL,
  city                 text NOT NULL,
  description          text,
  logo_public_id       text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE league_seasons (
  id               uuid PRIMARY KEY,
  league_id        uuid NOT NULL REFERENCES leagues(id),
  event_id         uuid UNIQUE NOT NULL REFERENCES events(id),
  name             text NOT NULL,
  config           jsonb NOT NULL,
  config_frozen_at timestamptz,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN
                     ('draft','registration','in_progress','completed','cancelled')),
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE league_divisions (
  id                uuid PRIMARY KEY,
  season_id         uuid NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
  event_category_id uuid UNIQUE NOT NULL REFERENCES event_categories(id),
  level             smallint NOT NULL CHECK (level >= 1),
  name              text NOT NULL,
  UNIQUE (season_id, level)
);

CREATE TABLE league_movements (
  season_id        uuid NOT NULL REFERENCES league_seasons(id),
  division_id      uuid NOT NULL REFERENCES league_divisions(id),
  registration_id  uuid NOT NULL REFERENCES registrations(id),
  movement         text NOT NULL CHECK (movement IN ('promoted','relegated','stayed')),
  next_level       smallint NOT NULL,
  PRIMARY KEY (season_id, registration_id)
);

CREATE TABLE league_final_standings (
  season_id        uuid NOT NULL REFERENCES league_seasons(id),
  division_id      uuid NOT NULL REFERENCES league_divisions(id),
  registration_id  uuid NOT NULL REFERENCES registrations(id),
  position         smallint NOT NULL,
  row              jsonb NOT NULL,
  PRIMARY KEY (season_id, division_id, registration_id)
);

CREATE TABLE fixture_reschedule_requests (
  id            uuid PRIMARY KEY,
  match_id      uuid NOT NULL REFERENCES matches(id),
  proposed_by   uuid NOT NULL REFERENCES users(id),
  proposed_at   timestamptz NOT NULL,
  note          text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','declined','expired')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reschedule_one_pending
  ON fixture_reschedule_requests (match_id) WHERE status = 'pending';


-- -----------------------------------------------------------------------------
-- 019 — bookings                                        [S14 · Phase 3]
-- -----------------------------------------------------------------------------

CREATE TABLE venue_booking_policies (
  venue_id              uuid PRIMARY KEY REFERENCES venues(id),
  bookable              boolean NOT NULL DEFAULT false,
  advance_days          smallint NOT NULL DEFAULT 14 CHECK (advance_days BETWEEN 1 AND 60),
  min_slot_minutes      smallint NOT NULL DEFAULT 60 CHECK (min_slot_minutes >= 30),
  full_refund_hours     smallint NOT NULL DEFAULT 24,
  partial_refund_hours  smallint NOT NULL DEFAULT 6,
  partial_refund_bps    integer  NOT NULL DEFAULT 5000,
  platform_fee_paise    bigint   NOT NULL DEFAULT 0,
  tax_bps               integer  NOT NULL DEFAULT 1800,
  timezone              text     NOT NULL DEFAULT 'Asia/Kolkata'
);

CREATE TABLE court_availability_rules (
  id                   uuid PRIMARY KEY,
  court_id             uuid NOT NULL REFERENCES venue_courts(id),
  weekday              smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at             time NOT NULL,
  closes_at            time NOT NULL CHECK (closes_at > opens_at),
  price_per_hour_paise bigint NOT NULL CHECK (price_per_hour_paise >= 0),
  sport_ids            uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX ON court_availability_rules (court_id, weekday);

CREATE TABLE court_blackouts (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL REFERENCES venues(id),
  court_id        uuid REFERENCES venue_courts(id),
  kind            text NOT NULL CHECK (kind IN ('maintenance','event','private','holiday')),
  event_id        uuid REFERENCES events(id),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL CHECK (ends_at > starts_at),
  note            text,
  created_by      uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX court_blackouts_range_idx ON court_blackouts
  USING gist (venue_id, tstzrange(starts_at, ends_at));

CREATE TABLE court_bookings (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL REFERENCES venues(id),
  court_id        uuid NOT NULL REFERENCES venue_courts(id),
  user_id         uuid REFERENCES users(id),
  walk_in_name    text,
  walk_in_phone   text,
  kind            text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','open_play')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL CHECK (ends_at > starts_at),
  status          text NOT NULL DEFAULT 'held' CHECK (status IN
                    ('held','confirmed','checked_in','cancelled','expired','no_show','payment_failed')),
  payment_mode    text NOT NULL DEFAULT 'online' CHECK (payment_mode IN ('online','offline','comp')),
  hold_expires_at timestamptz,
  amount_paise    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR walk_in_name IS NOT NULL),
  EXCLUDE USING gist (                                             -- bookings R1
    court_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('held','confirmed','checked_in'))
);
CREATE INDEX ON court_bookings (user_id, starts_at DESC);
CREATE INDEX ON court_bookings (venue_id, starts_at);


-- -----------------------------------------------------------------------------
-- 020 — ticketing                                       [S15 · Phase 3]
-- -----------------------------------------------------------------------------

CREATE TABLE ticket_types (
  id                 uuid PRIMARY KEY,
  event_id           uuid NOT NULL REFERENCES events(id),
  name               text NOT NULL,
  price_paise        bigint NOT NULL CHECK (price_paise >= 0),
  platform_fee_paise bigint NOT NULL DEFAULT 0,
  tax_bps            integer NOT NULL DEFAULT 1800,
  quantity           integer NOT NULL CHECK (quantity > 0),
  max_per_order      smallint NOT NULL DEFAULT 4 CHECK (max_per_order BETWEEN 1 AND 10),
  refundable         boolean NOT NULL DEFAULT true,
  sales_open_at      timestamptz NOT NULL,
  sales_close_at     timestamptz NOT NULL CHECK (sales_close_at > sales_open_at),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ticket_types (event_id);

CREATE TABLE ticket_orders (
  id              uuid PRIMARY KEY,
  ticket_type_id  uuid NOT NULL REFERENCES ticket_types(id),
  buyer_user_id   uuid NOT NULL REFERENCES users(id),
  quantity        smallint NOT NULL CHECK (quantity > 0),
  amount_paise    bigint NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','paid','failed','expired','cancelled','refunded')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ticket_holds (
  id              uuid PRIMARY KEY,
  ticket_type_id  uuid NOT NULL REFERENCES ticket_types(id),
  ticket_order_id uuid NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
  quantity        smallint NOT NULL,
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz
);
CREATE INDEX ticket_holds_active_idx ON ticket_holds (ticket_type_id) WHERE released_at IS NULL;

CREATE TABLE tickets (
  id              uuid PRIMARY KEY,
  ticket_order_id uuid NOT NULL REFERENCES ticket_orders(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  holder_email    citext NOT NULL,
  holder_user_id  uuid REFERENCES users(id),
  attendee_name   text NOT NULL,
  code_hash       text UNIQUE NOT NULL,
  code_version    smallint NOT NULL DEFAULT 1,
  transferred     boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','used','refunded','void')),
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tickets (event_id);
CREATE INDEX ON tickets (holder_user_id);

CREATE TABLE ticket_scans (
  id              bigserial PRIMARY KEY,
  ticket_id       uuid REFERENCES tickets(id),
  event_id        uuid NOT NULL REFERENCES events(id),
  scanned_by      uuid NOT NULL REFERENCES users(id),
  device_id       text NOT NULL,
  scanned_at      timestamptz NOT NULL,
  result          text NOT NULL CHECK (result IN ('admitted','already_used','invalid','duplicate_offline')),
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

-- Order subjects (payments R20), once both subject tables exist.
ALTER TABLE payment_orders
  ALTER COLUMN registration_id DROP NOT NULL,
  ADD COLUMN booking_id uuid REFERENCES court_bookings(id),
  ADD COLUMN ticket_order_id uuid REFERENCES ticket_orders(id),
  ADD CONSTRAINT payment_orders_one_subject CHECK (
    num_nonnulls(registration_id, booking_id, ticket_order_id) = 1);
