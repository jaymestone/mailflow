-- A contact can also be removed because it was simply the wrong person for
-- the venue -- not a bounce and not a departure. That still leaves the venue
-- worth researching, so 'manual' joins the automatic reasons. The column
-- only feeds the provenance string on a found replacement
-- (src/lib/research/replacementTick.ts), so widening it is additive: the
-- research tick selects on status, never on reason.
--
-- 'opt_out' is listed because one real row already carries it (a Sept 2026
-- opt-out reply for a festival that has not run since 2016, queued by hand
-- and already resolved to status 'skipped'). No code path writes it, but the
-- value is accurate, so the constraint widens to accept the history rather
-- than the row being relabelled to fit the constraint.
alter table replacement_queue drop constraint replacement_queue_reason_check;
alter table replacement_queue add constraint replacement_queue_reason_check
  check (removed_reason in ('bounce', 'ooo_departed', 'manual', 'opt_out'));
