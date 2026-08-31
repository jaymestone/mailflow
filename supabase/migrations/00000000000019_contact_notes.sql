-- Manual, timestamped notes a user logs against a contact (e.g. "called,
-- left a voicemail") — separate from the single overwritable contacts.notes
-- field, and from the automatic send/reply history already shown elsewhere.
create table contact_notes (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index contact_notes_contact_idx on contact_notes (contact_id, created_at desc);

alter table contact_notes enable row level security;
create policy contact_notes_authenticated_all on contact_notes
  for all to authenticated using (true) with check (true);
