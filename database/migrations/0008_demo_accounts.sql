-- 0008_demo_accounts
-- Fictional demo accounts (created only by `npm run demo:seed`, which refuses unless DEMO_MODE=true).
-- Anything they do is labelled as demo in the product, never counted as community intelligence, and their
-- SOS alerts say "DEMO, not a real emergency".
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
ALTER TABLE sos_events ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
ALTER TABLE community_reports ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1));
