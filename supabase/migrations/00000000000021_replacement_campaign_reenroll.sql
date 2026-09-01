-- Captures which campaigns the deleted contact was actively enrolled in,
-- so a found replacement can be re-enrolled in the same ones (starting
-- fresh at step 1 — they've never received any of the sequence) instead of
-- just sitting on the list unenrolled.
alter table replacement_queue add column campaign_ids uuid[] not null default '{}';
