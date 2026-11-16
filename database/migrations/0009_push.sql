-- 0009_push
-- Web Push subscriptions (one per browser/device a user turned notifications on for).
-- Sensitivity: PERSONAL. The endpoint is a capability URL at the browser's push service; the keys let the
-- server encrypt payloads so the push service can't read them. Deleted on unsubscribe, when the push
-- service reports the subscription gone (404/410), and with the account.
CREATE TABLE push_subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TEXT NOT NULL,
  last_success_at  TEXT,
  failures         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);
