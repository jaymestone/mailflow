-- A conversation's stable identity across Jayme's mailboxes: the Message-ID
-- of its first message, taken from the References header every reply
-- carries (falls back to "<account>:<gmail thread id>"). Written by the
-- build pass and pushed to Notion as Thread ID. See threadRootId in
-- src/lib/conversations/threadKey.ts.
alter table conversations add column if not exists thread_id text;
create index if not exists conversations_thread_id_idx on conversations (thread_id);
