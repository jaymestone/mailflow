-- Reusable template library: a step's subject/body can be saved under a
-- name and recalled into any other step, independent of any one campaign.

create table saved_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

alter table saved_templates enable row level security;
create policy saved_templates_authenticated_all on saved_templates
  for all to authenticated using (true) with check (true);
