-- Determines which campaign members are due to receive their next step:
-- active campaign + active member, not suppressed, no reply/bounce logged
-- against this (campaign, contact) pair yet, a template exists for the next
-- step, and cadence is satisfied (step 1 is always due; later steps wait
-- days_after_previous since the last send).
create or replace function send_engine_who_is_due(batch_limit int default 100)
returns table (
  campaign_member_id uuid,
  campaign_id uuid,
  contact_id uuid,
  current_step int,
  next_step int,
  email text,
  first_name text,
  last_name text,
  venue text,
  city text,
  state text,
  venue_type text,
  recipient_domain text,
  subject text,
  body text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    cm.id, cm.campaign_id, cm.contact_id, cm.current_step, cm.current_step + 1,
    c.email, c.first_name, c.last_name, c.venue, c.city, c.state, c.venue_type,
    lower(split_part(c.email, '@', 2)),
    ct.subject, ct.body
  from campaign_members cm
  join campaigns camp on camp.id = cm.campaign_id and camp.status = 'active'
  join contacts c on c.id = cm.contact_id
  join campaign_templates ct on ct.campaign_id = cm.campaign_id and ct.step_number = cm.current_step + 1
  where cm.member_status = 'active'
    and not exists (select 1 from suppression s where lower(s.email) = lower(c.email))
    and not exists (
      select 1 from inbound_messages im
      where im.matched_campaign_id = cm.campaign_id and im.matched_contact_id = cm.contact_id
    )
    and (
      cm.current_step = 0
      or (cm.last_sent_at is not null and cm.last_sent_at + (ct.days_after_previous || ' days')::interval <= now())
    )
  order by cm.added_at
  limit batch_limit;
$$;

revoke all on function send_engine_who_is_due(int) from public, anon, authenticated;
grant execute on function send_engine_who_is_due(int) to service_role;
