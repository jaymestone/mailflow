-- Heartbeat table so the health dashboard can show "last run" for each cron
-- job and flag if one has silently stopped firing, rather than only
-- discovering that when someone notices no venues are being contacted.
create table cron_health (
  job_name text primary key,
  last_run_at timestamptz not null default now(),
  last_result jsonb
);

alter table cron_health enable row level security;
create policy cron_health_authenticated_all on cron_health for all to authenticated using (true) with check (true);
