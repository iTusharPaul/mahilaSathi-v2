-- 0007_sos
-- Durable SOS: events, recipients, delivery jobs with retry state, an append-only log of every delivery
-- try, acknowledgements, per-user escalation rules, and the development SMS outbox.

-- Escalation rules and location detail, set by the user. Sensitivity: PERSONAL.
CREATE TABLE sos_settings (
  user_id                 TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  location_detail         TEXT NOT NULL DEFAULT 'precise' CHECK (location_detail IN ('precise', 'approximate', 'none')),
  emergency_contacts      TEXT NOT NULL DEFAULT 'if_unacknowledged' CHECK (emergency_contacts IN ('immediately', 'if_unacknowledged', 'never')),
  escalate_after_minutes  INTEGER NOT NULL DEFAULT 3 CHECK (escalate_after_minutes BETWEEN 1 AND 15),
  shortcut                TEXT NOT NULL DEFAULT 'hold' CHECK (shortcut IN ('hold', 'countdown')),
  updated_at              TEXT NOT NULL
);

-- One row per SOS. Sensitivity: RESTRICTED (location). Settings are snapshotted at activation so later
-- changes never alter an SOS in progress. Retention: coordinates cleared 30 days after the SOS ends.
CREATE TABLE sos_events (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key         TEXT NOT NULL,
  trip_id                 TEXT REFERENCES trips (id) ON DELETE SET NULL,
  status                  TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RESOLVED', 'CANCELLED')),
  outcome                 TEXT CHECK (outcome IN ('safe', 'false_alarm')),
  note                    TEXT,
  location_detail         TEXT NOT NULL CHECK (location_detail IN ('precise', 'approximate', 'none')),
  contacts_policy         TEXT NOT NULL CHECK (contacts_policy IN ('immediately', 'if_unacknowledged', 'never')),
  escalate_after_minutes  INTEGER NOT NULL,
  location_sharing        INTEGER NOT NULL DEFAULT 1 CHECK (location_sharing IN (0, 1)),
  lat                     REAL,
  lng                     REAL,
  accuracy_m              REAL,
  location_recorded_at    TEXT,
  location_source         TEXT CHECK (location_source IN ('device', 'journey')),
  area_name               TEXT,
  escalation_stage        INTEGER NOT NULL DEFAULT 0,
  next_escalation_at      TEXT,
  activated_at            TEXT NOT NULL,
  ended_at                TEXT,
  updated_at              TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key),
  CHECK ((status = 'ACTIVE') = (ended_at IS NULL))
);
-- At most one active SOS per person: a second activation returns the first.
CREATE UNIQUE INDEX uq_sos_one_active ON sos_events (user_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_sos_escalation ON sos_events (status, next_escalation_at);

-- Who was alerted, snapshotted at activation. Sensitivity: RESTRICTED (phone numbers of contacts).
CREATE TABLE sos_recipients (
  id              TEXT PRIMARY KEY,
  sos_id          TEXT NOT NULL REFERENCES sos_events (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('guardian', 'emergency_contact')),
  user_id         TEXT REFERENCES users (id) ON DELETE CASCADE,
  contact_id      TEXT,
  name            TEXT NOT NULL,
  phone_e164      TEXT,
  location_level  TEXT NOT NULL CHECK (location_level IN ('precise', 'approximate', 'none')),
  created_at      TEXT NOT NULL,
  CHECK ((kind = 'guardian' AND user_id IS NOT NULL) OR (kind = 'emergency_contact' AND phone_e164 IS NOT NULL))
);
CREATE INDEX idx_sos_recipients_sos ON sos_recipients (sos_id);
CREATE UNIQUE INDEX uq_sos_recipient_user ON sos_recipients (sos_id, user_id) WHERE user_id IS NOT NULL;

-- A delivery job: one message on one channel for one purpose, with its retry state. The worker claims
-- rows with a lease, so a crash mid-send is retried after the lease expires (recovery after restart).
CREATE TABLE sos_deliveries (
  id                   TEXT PRIMARY KEY,
  sos_id               TEXT NOT NULL REFERENCES sos_events (id) ON DELETE CASCADE,
  recipient_id         TEXT REFERENCES sos_recipients (id) ON DELETE CASCADE,
  channel              TEXT NOT NULL CHECK (channel IN ('in_app', 'circle_chat', 'sms')),
  purpose              TEXT NOT NULL CHECK (purpose IN ('alert', 'escalation', 'update', 'ended')),
  status               TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'accepted', 'delivered', 'failed', 'unavailable', 'skipped')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL,
  next_attempt_at      TEXT,
  lease_expires_at     TEXT,
  last_error           TEXT,
  provider_message_id  TEXT,
  dev_adapter          INTEGER NOT NULL DEFAULT 0 CHECK (dev_adapter IN (0, 1)),
  accepted_at          TEXT,
  delivered_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (channel = 'circle_chat' OR recipient_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_sos_delivery_recipient ON sos_deliveries (sos_id, recipient_id, channel, purpose) WHERE recipient_id IS NOT NULL;
CREATE UNIQUE INDEX uq_sos_delivery_circle ON sos_deliveries (sos_id, channel, purpose) WHERE recipient_id IS NULL;
CREATE INDEX idx_sos_deliveries_due ON sos_deliveries (status, next_attempt_at);
CREATE INDEX idx_sos_deliveries_sos ON sos_deliveries (sos_id);

-- Every try, append-only (no updates or deletes except by cascade). Sensitivity: INTERNAL.
CREATE TABLE sos_delivery_attempts (
  id           TEXT PRIMARY KEY,
  delivery_id  TEXT NOT NULL REFERENCES sos_deliveries (id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  outcome      TEXT CHECK (outcome IN ('accepted', 'retryable_error', 'permanent_error', 'unavailable', 'skipped')),
  error        TEXT,
  UNIQUE (delivery_id, attempt_no)
);
CREATE TRIGGER sos_delivery_attempts_no_update BEFORE UPDATE OF delivery_id, attempt_no, started_at ON sos_delivery_attempts
BEGIN SELECT RAISE(ABORT, 'sos_delivery_attempts is append-only'); END;

-- A guardian's response. Latest response per person. Sensitivity: PERSONAL.
CREATE TABLE sos_acknowledgements (
  sos_id           TEXT NOT NULL REFERENCES sos_events (id) ON DELETE CASCADE,
  recipient_id     TEXT NOT NULL REFERENCES sos_recipients (id) ON DELETE CASCADE,
  response         TEXT NOT NULL CHECK (response IN ('seen', 'calling', 'on_my_way')),
  acknowledged_at  TEXT NOT NULL,
  PRIMARY KEY (sos_id, recipient_id)
);

-- Development SMS adapter only (SMS_PROVIDER=mock): what would have been sent. Nothing leaves the server.
-- Sensitivity: RESTRICTED. Retention: 7 days.
CREATE TABLE dev_sms_outbox (
  id          TEXT PRIMARY KEY,
  to_e164     TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
