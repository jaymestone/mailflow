-- Splits the generic "ooo" reply category into two signals with different
-- automation: a temporary absence (sequence auto-pauses and resumes on its
-- own) vs a departure/closure (contact is stale, needs a human to update
-- the venue's record). The old 'ooo' enum value is left in place — Postgres
-- can't drop enum values — but the classifier stops emitting it.
alter type reply_category add value if not exists 'ooo_temporary';
alter type reply_category add value if not exists 'ooo_departed';

alter type suppression_reason add value if not exists 'departed';

-- Extracted return date, when a temporary OOO reply states or clearly
-- implies one (e.g. "back March 10th").
alter table inbound_messages add column ooo_return_date date;

-- When set, this member is snoozed until this timestamp — the send engine
-- treats the next step's cadence as anchored to resume_at instead of
-- last_sent_at, so a temporary OOO delays the sequence without skipping or
-- duplicating a step.
alter table campaign_members add column resume_at timestamptz;
