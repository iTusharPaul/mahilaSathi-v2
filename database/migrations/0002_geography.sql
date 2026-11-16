-- 0002_geography
-- NCR geographic registry. Reference data, loaded and versioned by the geography seeder from
-- database/geodata/. Geometries are GeoJSON MultiPolygon coordinate arrays with bounding-box
-- columns for indexed prefiltering; they map directly to PostGIS geometry columns later.
-- Sensitivity: PUBLIC (administrative boundaries and named areas; no user data).

CREATE TABLE boundary_datasets (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  publisher         TEXT NOT NULL,
  source_url        TEXT NOT NULL,
  license           TEXT NOT NULL,
  version           TEXT NOT NULL,
  source_sha256     TEXT,
  retrieved_on      TEXT,
  manifest_json     TEXT NOT NULL CHECK (json_valid(manifest_json)),
  loaded_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE ncr_boundaries (
  id                    TEXT PRIMARY KEY,
  dataset_id            TEXT NOT NULL REFERENCES boundary_datasets (id),
  name                  TEXT NOT NULL,
  constituents_source   TEXT NOT NULL,
  constituents_checked  TEXT NOT NULL,
  district_ids_json     TEXT NOT NULL CHECK (json_valid(district_ids_json)),
  min_lat REAL NOT NULL, min_lng REAL NOT NULL, max_lat REAL NOT NULL, max_lng REAL NOT NULL,
  area_km2              REAL NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE states (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  code         TEXT NOT NULL UNIQUE,
  official_ncr_area_km2 REAL,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE districts (
  id                 TEXT PRIMARY KEY,
  state_id           TEXT NOT NULL REFERENCES states (id),
  dataset_id         TEXT NOT NULL REFERENCES boundary_datasets (id),
  name               TEXT NOT NULL,
  aliases_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  includes_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(includes_json)),
  source_name        TEXT NOT NULL,
  source_feature_id  TEXT NOT NULL,
  geometry_json      TEXT NOT NULL CHECK (json_valid(geometry_json)),
  min_lat REAL NOT NULL, min_lng REAL NOT NULL, max_lat REAL NOT NULL, max_lng REAL NOT NULL,
  area_km2           REAL NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_districts_state ON districts (state_id);
CREATE INDEX idx_districts_bbox ON districts (min_lat, max_lat, min_lng, max_lng);

-- Cities are either a union of whole districts (Delhi) or an approximate circle.
CREATE TABLE cities (
  id               TEXT PRIMARY KEY,
  state_id         TEXT NOT NULL REFERENCES states (id),
  district_id      TEXT REFERENCES districts (id),
  name             TEXT NOT NULL,
  aliases_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  kind             TEXT NOT NULL CHECK (kind IN ('districts', 'circle')),
  district_ids_json TEXT CHECK (district_ids_json IS NULL OR json_valid(district_ids_json)),
  center_lat REAL, center_lng REAL, radius_m INTEGER,
  source           TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((kind = 'circle' AND center_lat IS NOT NULL AND center_lng IS NOT NULL AND radius_m > 0)
      OR (kind = 'districts' AND district_ids_json IS NOT NULL))
);
CREATE INDEX idx_cities_state ON cities (state_id);

-- Neighbourhoods give community identity. Their shape is an approximate circle until
-- authoritative locality polygons exist; the district is derived by point-in-polygon at load.
CREATE TABLE neighbourhoods (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  aliases_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  kind          TEXT NOT NULL DEFAULT 'neighbourhood' CHECK (kind IN ('neighbourhood', 'locality')),
  state_id      TEXT NOT NULL REFERENCES states (id),
  district_id   TEXT NOT NULL REFERENCES districts (id),
  city_id       TEXT REFERENCES cities (id),
  center_lat    REAL NOT NULL,
  center_lng    REAL NOT NULL,
  radius_m      INTEGER NOT NULL CHECK (radius_m > 0),
  source        TEXT NOT NULL,
  source_version TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_neighbourhoods_district ON neighbourhoods (district_id);
CREATE INDEX idx_neighbourhoods_city ON neighbourhoods (city_id);
CREATE INDEX idx_neighbourhoods_center ON neighbourhoods (center_lat, center_lng);

-- Data-coverage assessments, kept separate from any score. A missing row means "unknown":
-- never assessed, which must not be read as negative.
CREATE TABLE coverage_assessments (
  area_type    TEXT NOT NULL CHECK (area_type IN ('district', 'neighbourhood')),
  area_id      TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('high', 'medium', 'low', 'unknown')),
  basis_json   TEXT NOT NULL CHECK (json_valid(basis_json)),
  source       TEXT NOT NULL,
  assessed_at  TEXT NOT NULL,
  PRIMARY KEY (area_type, area_id)
);
