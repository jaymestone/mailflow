-- Booking-deal tracking.
--
-- Mailflow could see what venues said to Jayme and almost nothing of what
-- he said back: the reply tick skips any message carrying the SENT label,
-- and separately skips anything from one of his own addresses (that second
-- check catches mail between two connected accounts, where SENT only
-- exists in the sending mailbox). Both skips are correct for
-- classification -- without them his own follow-ups came back as phantom
-- leads -- but they meant Mailflow held his side of 11 of 458 live threads.
-- Any tracker built on that is a one-sided snapshot that goes stale the
-- moment he replies, which is exactly what happened to the first one.
--
-- manual_sends records those messages as thread activity without letting
-- them near the classifier. conversations is the per-thread deal state
-- computed from inbound_messages + outbound_sends + manual_sends.

create table manual_sends (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references connected_accounts(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  from_email text not null,
  to_email text,
  subject text,
  body_text text,
  sent_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index manual_sends_message_idx on manual_sends (connected_account_id, gmail_message_id);
create index manual_sends_thread_idx on manual_sends (gmail_thread_id);
create index manual_sends_sent_at_idx on manual_sends (sent_at);

create type conversation_status as enum (
  'needs_reply',       -- they wrote last
  'awaiting_them',     -- he wrote last
  'numbers_on_table',  -- a fee has been named by either side
  'confirmed',         -- agreed, needs contracting
  'parked'             -- under ~$1k, door split, or rental
);

create table conversations (
  id uuid primary key default gen_random_uuid(),

  -- NOT keyed on gmail_thread_id. One real conversation routinely spans
  -- several Gmail threads: campaigns send from whichever account
  -- round-robin picks but set Reply-To elsewhere, so a venue's reply can
  -- land in two mailboxes, each minting its own thread id (often differing
  -- by a single character: 1a0ca67d421dff24 / 1a0ca67e1ebaa1cb are both
  -- Carey Eyer's Blue Waters thread). Measured over the live interest
  -- corpus: 42 of 333 thread ids are a second copy of a conversation
  -- already counted. Keying on the thread id would list those deals twice
  -- and split each one's messages across the copies, so the key is the
  -- counterpart plus the normalised subject, and every underlying thread
  -- id is kept alongside.
  thread_key text not null,
  gmail_thread_ids text[] not null default '{}',

  contact_id uuid references contacts(id) on delete set null,

  -- Denormalised so a thread whose contact never matched (39% of interest
  -- messages have no matched_contact_id, usually a colleague replying after
  -- an internal forward) still carries a venue and a region. Derived from
  -- the contact where there is one, from the subject line where there
  -- isn't.
  venue text,
  artist text,
  region text,

  status conversation_status not null default 'needs_reply',
  -- Set by Jayme in Notion, never by the sync. When present it wins over
  -- the computed status, so correcting a wrong call in Notion sticks
  -- instead of being overwritten on the next pass.
  status_override conversation_status,

  fee_amount numeric,
  fee_note text,

  -- One line on where things got left. Written from the WHOLE thread, both
  -- directions: the previous build collapsed each thread to its newest
  -- message and lost the actual deal (dates, sets, the real agreed figure)
  -- that was stated in the first one.
  gist text,
  next_action text,

  last_message_at timestamptz,
  last_direction text check (last_direction in ('inbound', 'outbound')),
  first_inbound_at timestamptz,

  -- Hash of the message ids the gist was written from, so the summariser
  -- re-reads a thread only when it has actually changed. Without it every
  -- pass would re-summarise all 333 live threads.
  summary_source_hash text,
  summarized_at timestamptz,

  -- A thread leaves the board when nothing has happened either way for 30
  -- days AND no fee was ever named. A thread with a number on it stays
  -- regardless of age. Kept as a column rather than deleted so the history
  -- survives and the Notion row can be archived rather than orphaned.
  is_live boolean not null default true,

  notion_page_id text,
  notion_synced_at timestamptz,
  -- Bumped whenever a synced field changes; the Notion sync pushes only
  -- rows where this is ahead of notion_synced_revision, which keeps each
  -- incremental pass small enough for a 30-second tick.
  revision bigint not null default 1,
  notion_synced_revision bigint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index conversations_thread_key_idx on conversations (thread_key);
create index conversations_thread_ids_idx on conversations using gin (gmail_thread_ids);
create index conversations_contact_idx on conversations (contact_id);
create index conversations_live_status_idx on conversations (is_live, status);
create index conversations_sync_idx on conversations (is_live, revision, notion_synced_revision);

alter table manual_sends enable row level security;
create policy manual_sends_authenticated_all on manual_sends
  for all to authenticated using (true) with check (true);

alter table conversations enable row level security;
create policy conversations_authenticated_all on conversations
  for all to authenticated using (true) with check (true);
