-- migrate:foreign-keys-off
-- 0010_google_sign_in
-- Sign in with Google: an account is identified by a verified phone number OR a Google account.
-- Adding the alternative needs a new table-level CHECK, which SQLite can only change by rebuilding the
-- table (https://www.sqlite.org/lang_altertable.html#otheralter). Foreign keys are re-checked before commit.

-- Sensitivity: RESTRICTED (phone_e164, email), PERSONAL (other columns).
-- google_sub is Google's stable, opaque account id (never shown to anyone). email is shown only to the owner,
-- masked. Both are cleared when the account is deleted, like the phone number.
CREATE TABLE users_new (
  id                         TEXT PRIMARY KEY,
  phone_e164                 TEXT UNIQUE,
  google_sub                 TEXT UNIQUE,
  email                      TEXT CHECK (email IS NULL OR length(email) <= 254),
  display_name               TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 2 AND 40),
  community_handle           TEXT NOT NULL UNIQUE,
  home_district_id           TEXT REFERENCES districts (id),
  home_neighbourhood_id      TEXT REFERENCES neighbourhoods (id),
  onboarding_completed_at    TEXT,
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at                 TEXT,
  community_suspended_until  TEXT,
  is_demo                    INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  CHECK (status = 'deleted' OR phone_e164 IS NOT NULL OR google_sub IS NOT NULL)
);

INSERT INTO users_new (id, phone_e164, display_name, community_handle, home_district_id, home_neighbourhood_id,
                       onboarding_completed_at, status, created_at, updated_at, deleted_at, community_suspended_until, is_demo)
SELECT id, phone_e164, display_name, community_handle, home_district_id, home_neighbourhood_id,
       onboarding_completed_at, status, created_at, updated_at, deleted_at, community_suspended_until, is_demo
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE INDEX idx_users_home_neighbourhood ON users (home_neighbourhood_id);
