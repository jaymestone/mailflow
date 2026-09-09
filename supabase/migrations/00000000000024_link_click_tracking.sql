-- Click tracking for links inside outbound campaign emails (e.g. each
-- artist's link in the roster pitch) -- lets Jayme see which artist a
-- venue is actually gravitating toward, from a silent click, not just from
-- a reply. One link_tokens row is minted per markdown link per send (see
-- src/lib/send/clickTracking.ts), and the outbound email's URL for that
-- link is rewritten to /api/r/{token}; link_clicks logs every time that
-- token is actually visited, kept as an append-only log (not a single
-- counter) since a token can be clicked more than once and the timing of
-- each click matters for telling a real click apart from an email-security
-- scanner's near-instant "click everything" prefetch.

create table link_tokens (
  token text primary key,
  campaign_id uuid references campaigns(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  step_number int not null,
  label text not null,
  destination_url text not null,
  created_at timestamptz not null default now()
);

create index link_tokens_contact_idx on link_tokens (contact_id);
create index link_tokens_campaign_idx on link_tokens (campaign_id);

create table link_clicks (
  id uuid primary key default gen_random_uuid(),
  token text not null references link_tokens(token) on delete cascade,
  clicked_at timestamptz not null default now(),
  ip text,
  user_agent text,
  -- Security scanners (Outlook Safe Links, Proofpoint, Mimecast, etc.)
  -- routinely "click" every link in an email within seconds of delivery to
  -- scan for malware, well before a human opens it -- left unflagged, that
  -- noise would swamp real engagement signal. Computed at click time (see
  -- src/lib/send/botDetection.ts) from the user-agent and how soon after
  -- the token was minted (≈ send time) the click happened.
  is_likely_bot boolean not null default false
);

create index link_clicks_token_idx on link_clicks (token);

alter table link_tokens enable row level security;
create policy link_tokens_authenticated_all on link_tokens
  for all to authenticated using (true) with check (true);

alter table link_clicks enable row level security;
create policy link_clicks_authenticated_all on link_clicks
  for all to authenticated using (true) with check (true);
