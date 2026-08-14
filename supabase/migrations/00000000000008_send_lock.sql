-- Postgres built-ins like pg_try_advisory_lock live in pg_catalog, which
-- PostgREST doesn't expose over RPC — these wrap them in `public` so the
-- send-engine tick (manual button or cron) can't run twice concurrently.
create or replace function try_acquire_send_lock() returns boolean
language sql
as $$
  select pg_try_advisory_lock(918273645);
$$;

create or replace function release_send_lock() returns void
language sql
as $$
  select pg_advisory_unlock(918273645);
$$;

revoke all on function try_acquire_send_lock() from public, anon, authenticated;
revoke all on function release_send_lock() from public, anon, authenticated;
grant execute on function try_acquire_send_lock() to service_role;
grant execute on function release_send_lock() to service_role;
