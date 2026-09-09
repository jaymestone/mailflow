-- Replaces the session-level advisory lock (pg_try_advisory_lock) with a
-- plain, self-expiring row lock.
--
-- Why: pg_try_advisory_lock/pg_advisory_unlock are strictly tied to the
-- Postgres *session* (connection) that acquired them -- they release
-- automatically only when that exact connection closes. Called via
-- PostgREST RPC from a serverless function, "acquire" and "release" are
-- two separate HTTP requests with no guarantee PostgREST hands them the
-- same underlying pooled connection, and a request that gets cut off
-- (a Vercel function timeout, a crashed invocation) never runs its
-- `finally` block at all. Confirmed live: send-engine-tick's lock got
-- stuck holding "another tick is already running" for 30+ minutes with
-- nothing actually running, silently stalling a real 4,283-recipient
-- campaign mid-send. A plain table row instead: acquiring is one atomic
-- UPDATE ... WHERE (ordinary Postgres row-level locking makes two
-- concurrent callers safe, same guarantee advisory locks gave), it doesn't
-- care which connection touches it, and a stale lock (nothing legitimate
-- runs anywhere close to 5 minutes; the route's own maxDuration is 60s)
-- self-clears on its own next-acquire attempt rather than needing a human
-- to notice and manually intervene.

create table send_lock (
  id boolean primary key default true,
  locked_at timestamptz,
  constraint send_lock_singleton check (id)
);

insert into send_lock (id, locked_at) values (true, null);

create or replace function try_acquire_send_lock() returns boolean
language plpgsql
as $$
declare
  rows_updated integer;
begin
  update send_lock
  set locked_at = now()
  where id = true
    and (locked_at is null or locked_at < now() - interval '5 minutes');
  get diagnostics rows_updated = row_count;
  return rows_updated > 0;
end;
$$;

create or replace function release_send_lock() returns void
language sql
as $$
  update send_lock set locked_at = null where id = true;
$$;

revoke all on function try_acquire_send_lock() from public, anon, authenticated;
revoke all on function release_send_lock() from public, anon, authenticated;
grant execute on function try_acquire_send_lock() to service_role;
grant execute on function release_send_lock() to service_role;

revoke all on send_lock from public, anon, authenticated;
grant select on send_lock to authenticated; -- read-only, for a status indicator on /settings/health

alter table send_lock enable row level security;
create policy send_lock_authenticated_read on send_lock
  for select to authenticated using (true);
