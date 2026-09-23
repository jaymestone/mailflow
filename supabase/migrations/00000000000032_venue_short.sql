-- A shorter, human-sounding name for a venue, used by {{Venue}} in
-- outbound copy when it's set.
--
-- List-building records a venue's full legal or catalogue name, which is
-- the right thing to store and the wrong thing to say. Across the 4,058
-- contacts currently active in US Venues Roster Announce, 88 (2.2%) carry
-- a name that would read as mail-merge output in a sentence: eight with
-- slashes, two with parentheses, and a tail of names that are really two
-- names run together --
--
--   World Music/CRASHarts
--   The Filling Station/The Local/Bozeman BG Fest
--   Greater Uniontown Heritage Consortium The State Theatre Center for the Arts
--   Summer Concert Series - Lebanon (Mt. Lebanon Music in the Park)
--
-- "...could be especially good for The Filling Station/The Local/Bozeman
-- BG Fest" is the sentence that tells a reader they are on a list.
--
-- Deliberately a stored field rather than something derived at send time:
-- choosing which half of "World Music/CRASHarts" is the venue's actual
-- name is a judgement (it's CRASHarts, but nothing in the string says so),
-- and a rule that guesses would be wrong often enough to be worse than the
-- full name. Jayme already shortens these by hand while building lists;
-- this makes that work persist instead of being redone per campaign.
--
-- Nullable on purpose. venue stays the source of truth and {{Venue}} falls
-- back to it, so the ~98% that already read fine need no attention at all.

alter table contacts add column if not exists venue_short text;

comment on column contacts.venue_short is
  'Short conversational venue name for outbound copy. {{Venue}} prefers this over venue when set. Leave null when the full name already reads naturally in a sentence.';

-- The send engine selects an explicit column list, so venue_short has to
-- be added here to reach resolveTemplate at all. Otherwise unchanged from
-- migration 17, which is the latest definition -- the ooo_temporary /
-- resume_at behaviour, the reply blocking rules, and the
-- test_delay_minutes cadence override are all carried over verbatim.
--
-- Worth stating which migration this was rebuilt from, because the first
-- attempt used 15 and would have silently dropped 17's
-- test_delay_minutes override -- the thing that lets a step fire minutes
-- apart instead of days when testing a campaign. Redefining a function
-- means restating ALL of it, so every prior migration that touched it has
-- to be found first; grep the migrations directory rather than assuming
-- the one you remember is the last.
--
-- Wrapped in a transaction with an explicit DROP because adding a column
-- to the RETURNS TABLE changes the function's return type, and postgres
-- refuses that through CREATE OR REPLACE alone (42P13). The drop and
-- recreate must be atomic: the send engine calls this function every five
-- minutes, so a gap between the two statements is a window in which a
-- tick fails outright.
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
    c.email, c.first_name, c.last_name, c.venue, c.venue_short, c.city, c.state, c.venue_type,
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
