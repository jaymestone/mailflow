-- When a reply is classified as a bounce or ooo_departed, the contact is
-- now deleted outright (suppression already prevents recontact, so this is
-- about keeping the database free of dead contacts) — but that loses the
-- venue info needed to go find a replacement. This table captures what was
-- removed so a separate research pass can look for a new contact at the
-- same venue.
create table replacement_queue (
  id uuid primary key default gen_random_uuid(),
  venue text,
  venue_type text,
  city text,
  state text,
  country text,
  list_id uuid references lists(id) on delete set null,
  removed_contact_email text not null,
  removed_reason text not null,
  removed_at timestamptz not null default now(),
  status text not null default 'pending',
  researched_at timestamptz,
  notes text,
  constraint replacement_queue_reason_check check (removed_reason in ('bounce', 'ooo_departed')),
  constraint replacement_queue_status_check check (status in ('pending', 'replaced', 'no_replacement_found', 'skipped'))
);

create index replacement_queue_status_idx on replacement_queue (status);

alter table replacement_queue enable row level security;
create policy replacement_queue_authenticated_all on replacement_queue
  for all to authenticated using (true) with check (true);
