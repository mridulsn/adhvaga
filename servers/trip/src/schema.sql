-- Adhvaga: one Postgres database (plan section 6). Money in integer paise.
-- Versions are immutable plan snapshots; observations (status, locks, bookings) live at trip level by leg_key.
-- No PNR, names, phone numbers, card details or documents are stored anywhere.

CREATE TABLE IF NOT EXISTS trips (
  id              text PRIMARY KEY,
  owner_session   text NOT NULL,
  title           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  trip_end_date   date,
  auto_fix_local  boolean NOT NULL DEFAULT false,
  rules           jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_version integer
);

CREATE TABLE IF NOT EXISTS budgets (
  trip_id               text PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  hard_ceiling_paise    bigint CHECK (hard_ceiling_paise IS NULL OR hard_ceiling_paise >= 0),
  target_paise          bigint CHECK (target_paise IS NULL OR target_paise >= 0),
  refund_pending_paise  bigint NOT NULL DEFAULT 0 CHECK (refund_pending_paise >= 0),
  refund_received_paise bigint NOT NULL DEFAULT 0 CHECK (refund_received_paise >= 0)
);

CREATE TABLE IF NOT EXISTS versions (
  trip_id     text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  number      integer NOT NULL,
  status      text NOT NULL CHECK (status IN ('draft','proposed','approved','rejected','superseded')),
  parent      integer,
  reason      text,
  created_by  text NOT NULL CHECK (created_by IN ('user','agent','system','test')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, number)
);

CREATE TABLE IF NOT EXISTS legs (
  trip_id           text NOT NULL,
  version           integer NOT NULL,
  leg_key           text NOT NULL,
  kind              text NOT NULL,
  from_name         text NOT NULL,
  to_name           text NOT NULL,
  depart_at         timestamptz NOT NULL,
  arrive_at         timestamptz NOT NULL,
  operator          text,
  service_no        text,
  source            text NOT NULL,
  label             text NOT NULL CHECK (label IN ('live','timetable','estimated','simulated','user_entered','unavailable')),
  min_gap_after_min integer,
  estimated_paise   bigint,
  quoted_paise      bigint,
  quoted_source     text,
  quoted_at         timestamptz,
  PRIMARY KEY (trip_id, version, leg_key),
  FOREIGN KEY (trip_id, version) REFERENCES versions(trip_id, number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leg_links (
  trip_id     text NOT NULL,
  version     integer NOT NULL,
  from_leg    text NOT NULL,
  to_leg      text NOT NULL,
  PRIMARY KEY (trip_id, version, from_leg, to_leg),
  FOREIGN KEY (trip_id, version) REFERENCES versions(trip_id, number) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leg_locks (
  trip_id   text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  leg_key   text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, leg_key)
);

CREATE TABLE IF NOT EXISTS leg_status (
  trip_id    text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  leg_key    text NOT NULL,
  status     text NOT NULL,
  delay_min  integer NOT NULL DEFAULT 0,
  checked_at timestamptz NOT NULL,
  source     text NOT NULL,
  label      text NOT NULL,
  is_test    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (trip_id, leg_key)
);

CREATE TABLE IF NOT EXISTS bookings (
  id          text PRIMARY KEY,
  trip_id     text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  leg_key     text NOT NULL,
  operator    text NOT NULL,
  service_no  text,
  travel_date date NOT NULL,
  price_paise bigint NOT NULL CHECK (price_paise >= 0),
  fees        jsonb NOT NULL DEFAULT '[]'::jsonb,
  fees_paise  bigint NOT NULL DEFAULT 0 CHECK (fees_paise >= 0),
  state       text NOT NULL DEFAULT 'booked' CHECK (state IN ('booked','cancelled','completed')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id               text PRIMARY KEY,
  trip_id          text NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  base_version     integer NOT NULL,
  proposed_version integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  reasons          jsonb NOT NULL,
  cost_diff_paise  bigint NOT NULL,
  summary          jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  result           text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  trip_id  text,
  at       timestamptz NOT NULL DEFAULT now(),
  event    text NOT NULL,
  actor    text NOT NULL,
  nature   text NOT NULL CHECK (nature IN ('fact','system_decision','ai_explanation')),
  detail   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_trip_idx ON audit_log (trip_id, id);

CREATE TABLE IF NOT EXISTS idempotency (
  key        text PRIMARY KEY,
  tool       text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Used from Phase 2: provider answers are cached to protect the 100-requests-a-month free plans.
CREATE TABLE IF NOT EXISTS provider_cache (
  provider   text NOT NULL,
  cache_key  text NOT NULL,
  label      text NOT NULL,
  fetched_at timestamptz NOT NULL,
  payload    jsonb NOT NULL,
  PRIMARY KEY (provider, cache_key)
);
CREATE TABLE IF NOT EXISTS provider_usage (
  provider     text NOT NULL,
  period_start date NOT NULL,
  requests     integer NOT NULL DEFAULT 0,
  quota        integer,
  PRIMARY KEY (provider, period_start)
);

CREATE TABLE IF NOT EXISTS test_runs (
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  app_version text NOT NULL,
  model       text,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  results     jsonb NOT NULL
);
