-- Backoff state for conversations whose summary call keeps failing.
--
-- Nothing recorded a failed attempt, so a thread that could not be
-- summarised stayed a candidate and was retried on every tick forever.
-- With MAX_PER_TICK at 3 and candidates ordered by most recent activity,
-- three permanently-failing threads near the top of that order consume the
-- entire per-tick budget indefinitely: every tick pays for three Opus
-- calls, writes nothing, and no other thread is ever reached.
--
-- summarize_attempts counts consecutive failures and resets to 0 on the
-- first success. summarize_blocked_until holds the thread out of the
-- candidate list until it elapses, on a widening schedule, so a transient
-- timeout costs one retry a quarter of an hour later while a thread that
-- is genuinely unsummarisable settles at one attempt a day.
alter table conversations add column if not exists summarize_attempts integer not null default 0;
alter table conversations add column if not exists summarize_blocked_until timestamptz;

-- Partial index: the tick only ever asks about rows that are actually
-- held back, and in steady state almost none are.
create index if not exists conversations_summarize_blocked_until_idx
  on conversations (summarize_blocked_until)
  where summarize_blocked_until is not null;
