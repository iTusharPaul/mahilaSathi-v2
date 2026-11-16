-- 0005_routing
-- Route planning: provider caches (with freshness), provider health, and per-user route plans.

-- Cached routing responses keyed by mode/variant and rounded endpoints. Sensitivity: RESTRICTED
-- (contains coordinates). Retention: expired rows purged hourly.
CREATE TABLE route_cache (
  cache_key      TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  response_json  TEXT NOT NULL CHECK (json_valid(response_json)),
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_route_cache_expires ON route_cache (expires_at);

-- Place and camera data per ~2 km grid cell. Public map data. Sensitivity: PUBLIC.
CREATE TABLE places_cache (
  cell_id        TEXT NOT NULL,
  layer          TEXT NOT NULL CHECK (layer IN ('amenities', 'transit', 'cameras')),
  provider       TEXT NOT NULL,
  payload_json   TEXT NOT NULL CHECK (json_valid(payload_json)),
  truncated      INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  fetched_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  PRIMARY KEY (cell_id, layer)
);
CREATE INDEX idx_places_cache_expires ON places_cache (expires_at);

-- Last success/failure per external provider, for status display and diagnosis. Sensitivity: INTERNAL.
CREATE TABLE provider_cache_metadata (
  provider              TEXT PRIMARY KEY,
  last_success_at       TEXT,
  last_failure_at       TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT
);

-- A user's planned routes. Sensitivity: RESTRICTED (exact origin and destination).
-- Owner-only access. Retention: purged 24 hours after creation.
CREATE TABLE route_plans (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  origin_lat        REAL NOT NULL,
  origin_lng        REAL NOT NULL,
  destination_lat   REAL NOT NULL,
  destination_lng   REAL NOT NULL,
  departure_time    TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('walk', 'drive')),
  preferences_json  TEXT NOT NULL CHECK (json_valid(preferences_json)),
  result_json       TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL
);
CREATE INDEX idx_route_plans_user ON route_plans (user_id, created_at);
CREATE INDEX idx_route_plans_expires ON route_plans (expires_at);
