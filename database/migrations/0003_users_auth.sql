-- 0003_users_auth
-- Users, phone OTP authentication, sessions, preferences and emergency contacts.

-- Sensitivity: RESTRICTED (phone_e164); PERSONAL (other columns).
-- phone_e164 is never returned by community-facing APIs. On account deletion the row is kept as a
-- tombstone (status 'deleted', phone and display name cleared) so audit references stay valid.
CREATE TABLE users (
  id                       TEXT PRIMARY KEY,
  phone_e164               TEXT UNIQUE,
  display_name             TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 2 AND 40),
  community_handle         TEXT NOT NULL UNIQUE,
  home_district_id         TEXT REFERENCES districts (id),
  home_neighbourhood_id    TEXT REFERENCES neighbourhoods (id),
  onboarding_completed_at  TEXT,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at               TEXT,
  CHECK (status = 'deleted' OR phone_e164 IS NOT NULL)
);
CREATE INDEX idx_users_home_neighbourhood ON users (home_neighbourhood_id);

-- Sensitivity: RESTRICTED. Codes are stored only as keyed hashes. Retention: rows older than
-- 24 hours are purged at startup and hourly.
CREATE TABLE otp_sessions (
  id            TEXT PRIMARY KEY,
  phone_e164    TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  provider      TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT,
  invalidated_at TEXT
);
CREATE INDEX idx_otp_sessions_phone_created ON otp_sessions (phone_e164, created_at);

-- Sensitivity: RESTRICTED. Only a hash of the session token is stored; the raw token exists only
-- in the user's httpOnly cookie.
CREATE TABLE user_sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX idx_user_sessions_user ON user_sessions (user_id);

-- Sensitivity: PERSONAL.
CREATE TABLE user_preferences (
  user_id                    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  location_sharing_default   TEXT NOT NULL DEFAULT 'off'
                               CHECK (location_sharing_default IN ('off', 'guardians_approximate', 'guardians_precise')),
  notify_journey_updates     INTEGER NOT NULL DEFAULT 1 CHECK (notify_journey_updates IN (0, 1)),
  notify_community           INTEGER NOT NULL DEFAULT 0 CHECK (notify_community IN (0, 1)),
  notify_sos                 INTEGER NOT NULL DEFAULT 1 CHECK (notify_sos IN (0, 1)),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Sensitivity: RESTRICTED (third parties' names and phone numbers). Owner-only access.
CREATE TABLE emergency_contacts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  phone_e164    TEXT NOT NULL,
  relationship  TEXT CHECK (relationship IS NULL OR length(relationship) <= 40),
  priority      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, phone_e164)
);
CREATE INDEX idx_emergency_contacts_user ON emergency_contacts (user_id, priority);
