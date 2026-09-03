-- With only one item processed per daily run (batch size dropped to 1 to
-- fit cron-job.org's short client timeout), the query always picks the
-- oldest pending row first — if that one item deterministically fails
-- (e.g. a search that reliably needs more time than the timeout allows),
-- it would block every other queued venue behind it forever. Tracking
-- attempts lets the tick give up on a stuck item after a few tries
-- instead of retrying it every single day at the expense of the rest of
-- the queue.
alter table replacement_queue add column research_attempts int not null default 0;
