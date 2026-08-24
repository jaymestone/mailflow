-- A per-step testing override for cadence, so a sequence can be exercised
-- end-to-end without waiting real days between steps. Separate from
-- days_after_previous (left untouched) so turning it off just means
-- clearing this column — the real production cadence is never overwritten.
alter table campaign_templates add column test_delay_minutes int;
