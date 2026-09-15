-- Tracks whether a message's Gmail label was actually successfully
-- applied, separately from whether it's been classified and recorded.
-- Before this, "the row exists in inbound_messages" was treated as
-- equivalent to "fully handled" -- but classification/DB-insert happens
-- BEFORE the Gmail label call in processOneMessage, so if labeling itself
-- failed (e.g. a transient API error, or the Gmail rate-limit incident on
-- 2026-09-15), the row would exist with a real classification_category yet
-- never actually get labeled in Gmail, and the existing-row check meant no
-- future poll would ever retry it -- permanently stuck, invisible both to
-- Jayme (no label in his inbox) and to Mailflow (no error surfaced after
-- the one poll that hit it, since cron_health only keeps the latest run).
alter table inbound_messages
  add column label_applied_at timestamptz;
