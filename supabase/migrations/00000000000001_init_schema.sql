-- MailFlow core schema
-- Single-admin app: RLS policies simply require an authenticated session.
-- Background Edge Functions use the service role key and bypass RLS.

create extension if not exists postgis;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pg_trgm;

-- =========================================================================
-- Enums
-- =========================================================================

create type campaign_status as enum ('draft', 'active', 'paused', 'completed');
create type campaign_member_status as enum ('active', 'paused', 'completed', 'removed');
create type geocode_status as enum ('pending', 'success', 'failed', 'no_match');
create type connected_account_status as enum ('active', 'error', 'disconnected');
create type suppression_reason as enum ('bounce', 'opt_out', 'manual');
create type outbound_send_status as enum ('sent', 'failed');
create type inbound_match_method as enum ('message_id', 'tracking_token', 'sender_email', 'unmatched');
create type inbound_message_type as enum ('reply', 'bounce', 'unknown');
create type reply_category as enum (
  'interested', 'not_interested', 'follow_up', 'ooo', 'opt_out', 'bounce', 'unclear'
);
create type job_status as enum ('pending', 'running', 'completed', 'failed');

-- =========================================================================
-- Lists & contacts
-- =========================================================================

create table lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  created_at timestamptz not null default now()
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  first_name text,
  last_name text,
  email text not null,
  venue text,
  venue_type text,
  city text,
  state text,
  country text,
  notes text,
  source text,
  mobile text,
  phone text,
  website text,
  list_id uuid references lists(id) on delete set null,
  lat double precision,
  lng double precision,
  geom geography(Point, 4326),
  geocode_status geocode_status not null default 'pending',
  geocode_attempts int not null default 0,
  geocoded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index contacts_email_unique_idx on contacts (lower(email));
create index contacts_list_idx on contacts (list_id);
create index contacts_state_idx on contacts (state);
create index contacts_country_idx on contacts (country);
create index contacts_geom_idx on contacts using gist (geom);
create index contacts_venue_trgm_idx on contacts using gin (venue gin_trgm_ops);
create index contacts_city_trgm_idx on contacts using gin (city gin_trgm_ops);
create index contacts_geocode_status_idx on contacts (geocode_status);

-- Keep geom in sync with lat/lng automatically.
create or replace function contacts_sync_geom() returns trigger as $$
begin
  if new.lat is not null and new.lng is not null then
    new.geom := geography(st_setsrid(st_makepoint(new.lng, new.lat), 4326));
  else
    new.geom := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger contacts_sync_geom_trigger
  before insert or update of lat, lng on contacts
  for each row execute function contacts_sync_geom();

-- Geocode cache keyed on the (city, state, country) triple so contacts
-- share lookups instead of one geocode call each.
create table geo_locations (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  state text,
  country text,
  lat double precision,
  lng double precision,
  status geocode_status not null default 'pending',
  attempts int not null default 0,
  last_error text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index geo_locations_key_idx on geo_locations (
  lower(city), lower(coalesce(state, '')), lower(coalesce(country, ''))
);
create index geo_locations_status_idx on geo_locations (status);

-- =========================================================================
-- Campaigns
-- =========================================================================

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  artists text,
  status campaign_status not null default 'draft',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table campaign_templates (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  step_number int not null,
  days_after_previous int not null default 0,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  unique (campaign_id, step_number)
);

create table campaign_members (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  current_step int not null default 0,
  last_sent_at timestamptz,
  last_sent_from_account_id uuid,
  member_status campaign_member_status not null default 'active',
  consecutive_failures int not null default 0,
  added_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);

create index campaign_members_campaign_idx on campaign_members (campaign_id, member_status);
create index campaign_members_contact_idx on campaign_members (contact_id);

-- =========================================================================
-- Sending accounts
-- =========================================================================

create table connected_accounts (
  id uuid primary key default gen_random_uuid(),
  email_address text not null unique,
  display_name text,
  can_send boolean not null default true,
  oauth_refresh_token_id uuid, -- reference into Supabase Vault secret store
  scopes text[] not null default '{}',
  ramp_schedule jsonb not null default '[
    {"after_days": 0, "cap": 40},
    {"after_days": 3, "cap": 75},
    {"after_days": 7, "cap": 120},
    {"after_days": 14, "cap": 150}
  ]'::jsonb,
  ramp_started_at date not null default current_date,
  last_history_id text,
  status connected_account_status not null default 'active',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table campaign_members
  add constraint campaign_members_last_sent_from_fkey
  foreign key (last_sent_from_account_id) references connected_accounts(id) on delete set null;

create table send_counters (
  connected_account_id uuid not null references connected_accounts(id) on delete cascade,
  date date not null default current_date,
  sent_count int not null default 0,
  primary key (connected_account_id, date)
);

-- =========================================================================
-- Suppression
-- =========================================================================

create table suppression (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  reason suppression_reason not null,
  source_campaign_id uuid references campaigns(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create unique index suppression_email_unique_idx on suppression (lower(email));

-- =========================================================================
-- Outbound / inbound message log
-- =========================================================================

create table outbound_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_member_id uuid not null references campaign_members(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  step_number int not null,
  connected_account_id uuid not null references connected_accounts(id),
  subject_resolved text not null,
  body_resolved text not null,
  gmail_message_id text,
  rfc_message_id text not null,
  gmail_thread_id text,
  tracking_token text not null,
  sent_at timestamptz,
  status outbound_send_status not null default 'sent',
  error_message text,
  created_at timestamptz not null default now()
);

create unique index outbound_sends_rfc_message_id_idx on outbound_sends (rfc_message_id);
create unique index outbound_sends_tracking_token_idx on outbound_sends (tracking_token);
create index outbound_sends_contact_idx on outbound_sends (contact_id);
create index outbound_sends_campaign_idx on outbound_sends (campaign_id);

create table inbound_messages (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references connected_accounts(id),
  gmail_message_id text not null,
  gmail_thread_id text,
  from_email text not null,
  from_name text,
  subject text,
  body_text text,
  received_at timestamptz not null,
  matched_campaign_id uuid references campaigns(id) on delete set null,
  matched_contact_id uuid references contacts(id) on delete set null,
  matched_outbound_send_id uuid references outbound_sends(id) on delete set null,
  match_method inbound_match_method not null default 'unmatched',
  message_type inbound_message_type not null default 'unknown',
  classification_category reply_category,
  raw_llm_response jsonb,
  classified_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index inbound_messages_gmail_message_id_idx on inbound_messages (connected_account_id, gmail_message_id);
create index inbound_messages_contact_idx on inbound_messages (matched_contact_id);
create index inbound_messages_campaign_idx on inbound_messages (matched_campaign_id);
create index inbound_messages_category_idx on inbound_messages (classification_category);

-- =========================================================================
-- Settings & job tracking
-- =========================================================================

create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value) values
  ('reply_to_account_id', 'null'),
  ('round_robin_cursor', '0'),
  ('send_window', '{"days": ["mon","tue","wed","thu","fri"], "start_hour": 9, "end_hour": 17, "timezone": "America/Los_Angeles"}'),
  ('default_ramp_schedule', '[
    {"after_days": 0, "cap": 40},
    {"after_days": 3, "cap": 75},
    {"after_days": 7, "cap": 120},
    {"after_days": 14, "cap": 150}
  ]');

create table geocode_jobs (
  id uuid primary key default gen_random_uuid(),
  status job_status not null default 'pending',
  total int not null default 0,
  processed int not null default 0,
  failed int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  status job_status not null default 'pending',
  filename text,
  total int not null default 0,
  processed int not null default 0,
  inserted int not null default 0,
  skipped int not null default 0,
  failed int not null default 0,
  errors jsonb not null default '[]',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

-- =========================================================================
-- Row Level Security — single admin app, any authenticated user is the admin
-- =========================================================================

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'lists', 'contacts', 'geo_locations', 'campaigns', 'campaign_templates',
      'campaign_members', 'connected_accounts', 'send_counters', 'suppression',
      'outbound_sends', 'inbound_messages', 'app_settings', 'geocode_jobs', 'import_jobs'
    ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t
    );
  end loop;
end $$;
