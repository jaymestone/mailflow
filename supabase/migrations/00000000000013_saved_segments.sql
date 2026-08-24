-- Bespoke, reusable contact selections ("segments"), separate from the
-- import-time `lists` (which give each contact exactly one list_id). A
-- contact can belong to any number of segments without disturbing their
-- original list membership.

create table saved_segments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table saved_segment_contacts (
  segment_id uuid not null references saved_segments(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (segment_id, contact_id)
);

create index saved_segment_contacts_contact_idx on saved_segment_contacts (contact_id);

alter table saved_segments enable row level security;
create policy saved_segments_authenticated_all on saved_segments
  for all to authenticated using (true) with check (true);

alter table saved_segment_contacts enable row level security;
create policy saved_segment_contacts_authenticated_all on saved_segment_contacts
  for all to authenticated using (true) with check (true);
