-- The smaller room at a venue that has a big hall and a small one (Jayme,
-- 2026-11-05: "Some of these have smaller rooms, in which case we should
-- actually mention that"). Feeds the {{Room}} merge field: "in <room>" when
-- set, otherwise "at <venue>", so one campaign can name the right room for
-- the venues that have one and read naturally for everyone else.
alter table contacts add column if not exists room text;

-- send_engine_who_is_due restated in full from migration 33, with room added
-- to RETURNS TABLE and the select. A RETURNS TABLE change needs drop + create.
begin;
drop function if exists send_engine_who_is_due(int);
create function send_engine_who_is_due(batch_limit int default 100)
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
  venue_short text,
  room text,
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
    c.email, c.first_name, c.last_name, c.venue, c.venue_short, c.room, c.city, c.state, c.venue_type,
    lower(split_part(c.email, '@', 2)),
    ct.subject, ct.body
  from campaign_members cm
  join campaigns camp on camp.id = cm.campaign_id and camp.status = 'active'
  join contacts c on c.id = cm.contact_id
  join campaign_templates ct
    on ct.campaign_id = cm.campaign_id
   and ct.step_number = cm.current_step + 1
   and ct.variant = 'default'
  where cm.member_status = 'active'
    and not exists (select 1 from suppression s where lower(s.email) = lower(c.email))
    and not exists (
      select 1 from inbound_messages im
      where im.matched_campaign_id = cm.campaign_id and im.matched_contact_id = cm.contact_id
        and not (im.message_type = 'reply' and im.classification_category = 'ooo_temporary')
    )
    and (
      cm.current_step = 0
      or (
        cm.last_sent_at is not null
        and greatest(cm.last_sent_at, coalesce(cm.resume_at, cm.last_sent_at))
          + coalesce(ct.test_delay_minutes || ' minutes', ct.days_after_previous || ' days')::interval <= now()
      )
    )
  order by cm.added_at
  limit batch_limit;
$$;
grant execute on function send_engine_who_is_due(int) to service_role;
commit;
