-- send_counters was written via a read-once-per-tick, upsert-with-
-- absolute-value pattern: tick.ts read each account's count at the start
-- of a tick, incremented it in a local JS variable per send, then upserted
-- that computed absolute number back (SET sent_count = <computed>, not an
-- increment). Any gap between that in-tick snapshot and the row's real
-- state -- a stale read, an overlapping tick, a transient fetch hiccup --
-- gets silently baked in as "the truth" for the rest of the day, since the
-- write REPLACES the row instead of adding to it.
--
-- Confirmed live: outbound_sends (append-only, immune to this) showed real
-- per-account totals of ~114-122 for a day where send_counters showed only
-- ~69-70 for the same accounts, and a separate day where one account's real
-- total (156) had already passed its 150/day cap without send_counters
-- ever reflecting it.
--
-- Fix: a single atomic UPDATE/INSERT that adds 1 to whatever's actually in
-- the row right now, rather than overwriting it with a value computed from
-- a point-in-time snapshot.
create or replace function increment_send_counter(p_account_id uuid, p_date date)
returns int
language plpgsql
as $$
declare
  new_count int;
begin
  insert into send_counters (connected_account_id, date, sent_count)
  values (p_account_id, p_date, 1)
  on conflict (connected_account_id, date)
  do update set sent_count = send_counters.sent_count + 1
  returning sent_count into new_count;
  return new_count;
end;
$$;

revoke all on function increment_send_counter(uuid, date) from public, anon, authenticated;
grant execute on function increment_send_counter(uuid, date) to service_role;
