-- Records the message set the summariser actually last read.
--
-- conversations.summary_source_hash already describes a thread's CURRENT
-- message set -- buildTick recomputes it on every pass, and its comment
-- there says "changing the hash is what tells the summariser this thread
-- has moved". But nothing ever stored the previous value, so there was
-- nothing to compare against, and summarizeTick fell back to asking
-- whether summarized_at was older than last_message_at. That is a proxy
-- for the question rather than the question itself: anything that disturbs
-- either timestamp makes every thread look stale, and re-summarising the
-- live board costs an Opus call per thread. On 2026-10-02 all 306 live
-- conversations were rewritten between 00:24 and 01:00.
--
-- Keeping the hash as of the last summary lets the guard answer the real
-- question: the prompt is byte-identical, so the summary would be too.
alter table conversations add column if not exists summarized_source_hash text;

-- Summaries that already exist were written from the hash currently on the
-- row, so adopt it. Without this backfill every already-summarised thread
-- would read as stale exactly once and buy one more full pass to produce
-- the same gists it already has.
update conversations
   set summarized_source_hash = summary_source_hash
 where summarized_at is not null
   and summarized_source_hash is null;
