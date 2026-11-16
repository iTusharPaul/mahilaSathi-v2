-- 0004_community
-- Community channels, Guardian Circles, blocking, reports and moderation.
-- Message bodies live with the chat provider (Nexconn). Only the development relay stores them here.

-- Each user's identity at the chat provider. chat_user_id is also the user's public id in APIs:
-- other members see it together with the pseudonym, never the phone number.
-- Sensitivity: PERSONAL.
CREATE TABLE chat_identities (
  user_id               TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  chat_user_id          TEXT NOT NULL UNIQUE,
  provider              TEXT NOT NULL CHECK (provider IN ('nexconn', 'dev-relay')),
  registered_at         TEXT NOT NULL,
  last_token_issued_at  TEXT
);

-- Sensitivity: PUBLIC metadata (names are neighbourhood/area names, never addresses).
-- Journey rooms hold area ids only: never coordinates.
CREATE TABLE community_channels (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('neighbourhood', 'journey_room', 'guardian_circle')),
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
-- At most one active channel per neighbourhood: provisioning can never create duplicates.
CREATE UNIQUE INDEX uq_neighbourhood_channel ON community_channels (neighbourhood_id) WHERE kind = 'neighbourhood' AND status = 'active';
CREATE INDEX idx_channels_kind_status ON community_channels (kind, status, expires_at);

-- Sensitivity: PERSONAL.
CREATE TABLE community_memberships (
  channel_id   TEXT NOT NULL REFERENCES community_channels (id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'owner', 'moderator')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left', 'removed')),
  joined_at    TEXT NOT NULL,
  left_at      TEXT,
  removed_by   TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_memberships_user ON community_memberships (user_id, status);

-- Guardian Circles. Sensitivity: PERSONAL (who protects whom).
CREATE TABLE circles (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  channel_id  TEXT NOT NULL REFERENCES community_channels (id),
  created_at  TEXT NOT NULL
);

CREATE TABLE circle_members (
  circle_id   TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'guardian')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'left')),
  joined_at   TEXT NOT NULL,
  ended_at    TEXT,
  PRIMARY KEY (circle_id, user_id)
);
CREATE INDEX idx_circle_members_user ON circle_members (user_id, status);

-- Single-use invite codes, stored hashed. Optionally bound to one phone number (also hashed).
-- Sensitivity: RESTRICTED. Retention: purged 30 days after expiry.
CREATE TABLE circle_invites (
  id                  TEXT PRIMARY KEY,
  circle_id           TEXT NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  code_hash           TEXT NOT NULL UNIQUE,
  bound_phone_hash    TEXT,
  created_by          TEXT NOT NULL REFERENCES users (id),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  accepted_by         TEXT REFERENCES users (id),
  accepted_at         TEXT,
  revoked_at          TEXT
);
CREATE INDEX idx_circle_invites_circle ON circle_invites (circle_id, expires_at);

-- Sensitivity: PERSONAL. Never revealed to the blocked user.
CREATE TABLE user_blocks (
  blocker_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id != blocked_id)
);
CREATE INDEX idx_user_blocks_blocked ON user_blocks (blocked_id);

-- Sensitivity: RESTRICTED. Reporter identity is never shown to the reported user.
CREATE TABLE message_reports (
  id                    TEXT PRIMARY KEY,
  channel_id            TEXT NOT NULL REFERENCES community_channels (id),
  provider_message_id   TEXT NOT NULL,
  reporter_id           TEXT NOT NULL REFERENCES users (id),
  reported_user_id      TEXT REFERENCES users (id),
  reason                TEXT NOT NULL,
  details               TEXT,
  snapshot_text         TEXT,
  snapshot_source       TEXT NOT NULL CHECK (snapshot_source IN ('server', 'reporter')),
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  resolution            TEXT,
  UNIQUE (reporter_id, channel_id, provider_message_id)
);
CREATE INDEX idx_message_reports_status ON message_reports (status, created_at);
CREATE INDEX idx_message_reports_reported ON message_reports (reported_user_id, created_at);

CREATE TABLE user_reports (
  id                  TEXT PRIMARY KEY,
  reporter_id         TEXT NOT NULL REFERENCES users (id),
  reported_user_id    TEXT NOT NULL REFERENCES users (id),
  reason              TEXT NOT NULL,
  details             TEXT,
  context_channel_id  TEXT REFERENCES community_channels (id),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at          TEXT NOT NULL,
  resolved_at         TEXT,
  resolution          TEXT
);
CREATE INDEX idx_user_reports_reported ON user_reports (reported_user_id, created_at);

-- Sensitivity: RESTRICTED. Append-only record of moderation decisions (also mirrored in audit_events).
CREATE TABLE moderation_actions (
  id               TEXT PRIMARY KEY,
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('admin', 'system')),
  action           TEXT NOT NULL CHECK (action IN ('dismiss_report', 'warn', 'remove_from_channel', 'suspend', 'unsuspend', 'auto_suspend')),
  target_user_id   TEXT REFERENCES users (id),
  channel_id       TEXT REFERENCES community_channels (id),
  report_id        TEXT,
  reason           TEXT NOT NULL,
  expires_at       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_moderation_actions_target ON moderation_actions (target_user_id, created_at);

ALTER TABLE users ADD COLUMN community_suspended_until TEXT;

-- Development relay only (used when Nexconn is not configured). Sensitivity: PERSONAL.
-- Retention: purged after 30 days.
CREATE TABLE dev_chat_messages (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES community_channels (id) ON DELETE CASCADE,
  sender_user_id  TEXT REFERENCES users (id),
  message_type    TEXT NOT NULL,
  content_json    TEXT NOT NULL CHECK (json_valid(content_json)),
  sent_at         TEXT NOT NULL,
  seq             INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_dev_chat_messages_seq ON dev_chat_messages (seq);
CREATE INDEX idx_dev_chat_messages_channel ON dev_chat_messages (channel_id, seq);
