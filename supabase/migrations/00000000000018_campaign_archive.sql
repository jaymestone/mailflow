-- Archiving a campaign hides it from the default list without touching its
-- history (members, sends, replies all stay intact and it can be restored).
-- Kept as a separate nullable column rather than a new campaign_status enum
-- value: status still means "workflow state" (draft/active/paused/completed)
-- and continues to drive the send engine's `status = 'active'` check
-- unmodified; archived_at is an orthogonal "hidden from view" flag.
alter table campaigns add column archived_at timestamptz;
