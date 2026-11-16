-- migrate:foreign-keys-off
-- 0006_journeys_pulse
-- Journeys (trips), sharing with Guardian Circles, Walk Together, community incident reports and
-- Community Pulse. Also rebuilds community_channels to allow the private 'walk_together' kind
-- (SQLite cannot alter a CHECK constraint in place; see the directive above).

-- ─── community_channels rebuild (adds kind 'walk_together') ───────────────────
CREATE TABLE community_channels_new (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('neighbourhood', 'journey_room', 'guardian_circle', 'walk_together')),
  provider              TEXT NOT NULL CHECK (provider IN ('nexconn', 'dev-relay')),
  provider_channel_id   TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  neighbourhood_id      TEXT REFERENCES neighbourhoods (id),
  from_area_type        TEXT CHECK (from_area_type IN ('neighbourhood', 'district')),
  from_area_id          TEXT,
  to_area_type          TEXT CHECK (to_area_type IN ('neighbourhood', 'district')),
  to_area_id            TEXT,
  window_start          TEXT,
  window_end            TEXT,
  expires_at            TEXT,
  max_members           INTEGER NOT NULL,
  created_by            TEXT REFERENCES users (id),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  archived_at           TEXT,
  archive_reason        TEXT,
  last_activity_at      TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  CHECK (kind != 'neighbourhood' OR neighbourhood_id IS NOT NULL),
  CHECK (kind != 'journey_room' OR (from_area_id IS NOT NULL AND to_area_id IS NOT NULL AND window_start IS NOT NULL AND expires_at IS NOT NULL))
);
INSERT INTO community_channels_new SELECT * FROM community_channels;
DROP TABLE community_channels;
ALTER TABLE community_channels_new RENAME TO community_channels;
CREATE UNIQUE INDEX uq_neighbourhood_channel ON community_channels (neighbourhood_id) WHERE kind = 'neighbourhood' AND status = 'active';
CREATE INDEX idx_channels_kind_status ON community_channels (kind, status, expires_at);

-- ─── Journeys ─────────────────────────────────────────────────────────────────
-- Sensitivity: RESTRICTED (exact origin/destination). Owner, and Guardian Circle members through an
-- active share, only. Retention: precise columns are cleared 30 days after the journey ends.
CREATE TABLE trips (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK (status IN ('CREATED', 'ACTIVE', 'DELAYED', 'ARRIVED', 'CANCELLED', 'ESCALATED')),
  mode                 TEXT NOT NULL CHECK (mode IN ('walk', 'drive')),
  origin_lat           REAL,
  origin_lng           REAL,
  destination_lat      REAL,
  destination_lng      REAL,
  origin_label         TEXT,
  destination_label    TEXT,
  destination_area     TEXT,
  departure_time       TEXT NOT NULL,
  expected_duration_s  INTEGER NOT NULL,
  started_at           TEXT,
  expected_arrival_at  TEXT,
  delayed_at           TEXT,
  escalated_at         TEXT,
  arrived_at           TEXT,
  ended_at             TEXT,
  last_checkin_at      TEXT,
  next_checkin_due_at  TEXT,
  location_sharing     INTEGER NOT NULL DEFAULT 0 CHECK (location_sharing IN (0, 1)),
  feedback             TEXT CHECK (feedback IN ('comfortable', 'uneasy')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_trips_user ON trips (user_id, created_at);
CREATE INDEX idx_trips_status ON trips (status, expected_arrival_at);

-- The route chosen for the journey (copied from the plan). Sensitivity: RESTRICTED.
CREATE TABLE trip_routes (
  trip_id        TEXT PRIMARY KEY REFERENCES trips (id) ON DELETE CASCADE,
  plan_route_id  TEXT NOT NULL,
  label          TEXT NOT NULL,
  distance_m     REAL NOT NULL,
  duration_s     REAL NOT NULL,
  score          INTEGER,
  confidence     TEXT NOT NULL,
  geometry_json  TEXT NOT NULL CHECK (json_valid(geometry_json))
);

-- Sensitivity: PERSONAL. Optional coordinates only when the user shared location at the time.
CREATE TABLE trip_checkins (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('start', 'manual', 'arrival')),
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_trip_checkins_trip ON trip_checkins (trip_id, created_at);

-- Shares with a Guardian Circle. Revoked automatically when the journey ends. Sensitivity: PERSONAL.
CREATE TABLE trip_shares (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  circle_id   TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  level       TEXT NOT NULL CHECK (level IN ('status', 'approximate', 'precise')),
  created_at  TEXT NOT NULL,
  revoked_at  TEXT,
  UNIQUE (trip_id, circle_id)
);
CREATE INDEX idx_trip_shares_circle ON trip_shares (circle_id, revoked_at);

CREATE TABLE trip_share_acks (
  share_id         TEXT NOT NULL REFERENCES trip_shares (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  acknowledged_at  TEXT NOT NULL,
  PRIMARY KEY (share_id, user_id)
);

-- Live location while sharing is on. Sensitivity: RESTRICTED. Retention: deleted 24 h after the
-- journey ends; only the latest point is ever shown.
CREATE TABLE trip_locations (
  id           TEXT PRIMARY KEY,
  trip_id      TEXT NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  accuracy_m   REAL,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX idx_trip_locations_trip ON trip_locations (trip_id, recorded_at);

-- Corridor identity: H3 res-8 cells along the route, with ~300 m trimmed from each end so they never
-- reveal the exact start or destination. Sensitivity: PERSONAL (coarse). Deleted with the trip.
CREATE TABLE corridor_segments (
  trip_id  TEXT NOT NULL REFERENCES trips (id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  cell     TEXT NOT NULL,
  PRIMARY KEY (trip_id, seq)
);
CREATE INDEX idx_corridor_cell ON corridor_segments (cell);

-- ─── Walk Together ────────────────────────────────────────────────────────────
CREATE TABLE walk_together_requests (
  id            TEXT PRIMARY KEY,
  trip_id       TEXT NOT NULL UNIQUE REFERENCES trips (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mode          TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  window_end    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled', 'expired')),
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_wt_requests_status ON walk_together_requests (status, window_start);

-- A pair of requests. user_a/request_a is always the lexically smaller request id, so a pair is unique.
CREATE TABLE walk_together_matches (
  id              TEXT PRIMARY KEY,
  request_a       TEXT NOT NULL REFERENCES walk_together_requests (id) ON DELETE CASCADE,
  request_b       TEXT NOT NULL REFERENCES walk_together_requests (id) ON DELETE CASCADE,
  user_a          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  overlap_pct     INTEGER NOT NULL,
  shared_areas_json TEXT NOT NULL CHECK (json_valid(shared_areas_json)),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'cancelled')),
  a_accepted_at   TEXT,
  b_accepted_at   TEXT,
  channel_id      TEXT REFERENCES community_channels (id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (request_a, request_b),
  CHECK (request_a < request_b)
);
CREATE INDEX idx_wt_matches_user_a ON walk_together_matches (user_a, status);
CREATE INDEX idx_wt_matches_user_b ON walk_together_matches (user_b, status);

CREATE TABLE walk_together_members (
  match_id   TEXT NOT NULL REFERENCES walk_together_matches (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

-- ─── Community reports & Pulse ────────────────────────────────────────────────
-- Incident reports. Location is stored only as an H3 cell plus a point rounded to ~100 m.
-- Sensitivity: PERSONAL (reporter never shown to others). Retention: expire (14 days for
-- infrastructure, 30 days for verified incidents); expired rows are kept for moderation history.
CREATE TABLE community_reports (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  description   TEXT NOT NULL,
  cell          TEXT NOT NULL,
  approx_lat    REAL NOT NULL,
  approx_lng    REAL NOT NULL,
  area_name     TEXT,
  occurred_at   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'verified', 'rejected', 'expired')),
  review_note   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_community_reports_cell ON community_reports (cell, status);
CREATE INDEX idx_community_reports_user ON community_reports (user_id, created_at);

-- Raw, attributable signals; never exposed. Aggregates below are what the product reads.
CREATE TABLE community_pulse_signals (
  id              TEXT PRIMARY KEY,
  cell            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('journey_completed', 'route_feedback', 'infra_report', 'incident_verified')),
  polarity        INTEGER NOT NULL CHECK (polarity IN (-1, 1)),
  weight          REAL NOT NULL CHECK (weight > 0),
  contributor_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_pulse_signals_cell ON community_pulse_signals (cell, expires_at);
CREATE INDEX idx_pulse_signals_source ON community_pulse_signals (source_id);

-- Per-cell decayed aggregate. Sensitivity: PUBLIC (aggregated, minimum 3 contributors to count).
CREATE TABLE community_aggregates (
  cell           TEXT PRIMARY KEY,
  positive       REAL NOT NULL,
  negative       REAL NOT NULL,
  contributors   INTEGER NOT NULL,
  value          REAL NOT NULL,
  updated_at     TEXT NOT NULL
);
