-- Lets one step carry several alternative bodies, chosen per contact.
--
-- Step 3 of the roster campaigns says a different thing depending on what
-- the venue actually did with step 1: someone who opened two artists gets
-- those artists named, someone who read the whole roster gets an offer to
-- narrow it down, and someone who never engaged gets a last note asking
-- whether we even have the right person. Three genuinely different emails
-- at the same position in the sequence.
--
-- A campaign can only hold one step 3, so the alternatives have to live
-- side by side under it. The alternative -- three separate campaigns --
-- was rejected because steps 2+ thread as replies onto the original mail
-- (see fetchPriorSends in src/lib/send/tick.ts) and a new campaign starts
-- a fresh thread, which reads as another cold email rather than a
-- follow-up to one the venue already has.
--
-- Deliberately a stored column rather than conditional syntax inside one
-- body: Jayme writes and edits this copy himself, and three clean bodies
-- in the UI are easier to work with -- and to preview -- than one body
-- with branching buried in it.

alter table campaign_templates add column if not exists variant text not null default 'default';

-- The old constraint allowed exactly one row per step, which is precisely
-- what has to change. Variant is part of the identity now.
alter table campaign_templates drop constraint if exists campaign_templates_campaign_id_step_number_key;
alter table campaign_templates add constraint campaign_templates_campaign_step_variant_key
  unique (campaign_id, step_number, variant);

comment on column campaign_templates.variant is
  'Which audience this body is for. "default" is the one the send engine joins and the only one required; step 3 of the roster campaigns also uses "clicked_focused", "clicked_broad" and "no_click", selected per contact in src/lib/send/tick.ts.';

-- send_engine_who_is_due joins campaign_templates to find the next step's
-- body. With variants that join now matches several rows per member, which
-- would return the same contact once per variant and send them the step
-- two or three times over. Constraining the join to 'default' keeps
-- exactly one row per due member; the tick then swaps in whichever variant
-- the contact's own behaviour calls for.
--
-- Choosing the variant in TypeScript rather than here is deliberate. It
-- depends on click classification, which is a judgement with measured
-- thresholds behind it (src/lib/clicks/classify.ts) and real tests -- not
-- something to reimplement in SQL where it cannot be tested and would
-- silently drift from the version that decides everything else.
--
-- Return type is unchanged from migration 32, so CREATE OR REPLACE is
-- enough here and no DROP is needed. Body is otherwise verbatim: the
-- ooo_temporary/resume_at handling, the reply blocking, the
-- test_delay_minutes override from migration 17, and venue_short from 32.
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
