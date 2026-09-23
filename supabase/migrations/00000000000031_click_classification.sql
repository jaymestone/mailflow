-- Records WHY a click was judged real or automated, alongside the existing
-- is_likely_bot flag.
--
-- is_likely_bot is decided at click time from that one click in isolation
-- (src/lib/send/botDetection.ts) and cannot see what else the same contact
-- did. Measured against production on 2026-09-23 it caught 379 of 22,745
-- clicks on US Venues Roster Announce -- 1.7% -- while the real automated
-- share was 87%. Corporate scanners spoof ordinary browser user-agents and
-- arrive ~60s after send rather than the ~10s that flag assumed, so
-- nothing about a single click gives them away. Looking at a contact's
-- clicks together does: ten artist links hit 0.6s apart is not a person.
--
-- src/lib/clicks/classify.ts does that group-level pass and writes its
-- verdict here. class_reason exists because the verdict now rests on
-- pattern rather than on a self-identifying user-agent, and a surprising
-- call on a real venue needs to be auditable after the fact rather than
-- taken on trust.
--
-- is_likely_bot is kept in step with click_class rather than retired: the
-- campaign page, contact click history and venue search all filter on it
-- (see src/app/(app)/campaigns/[id]/page.tsx, src/lib/venues/searchContacts.ts),
-- so keeping it as the single flag everyone reads makes those views
-- correct without touching them, with click_class/class_reason as the
-- detail behind it.

alter table link_clicks add column if not exists click_class text
  check (click_class in ('human', 'scanner', 'uncertain'));
alter table link_clicks add column if not exists class_reason text;
alter table link_clicks add column if not exists classified_at timestamptz;

-- Step 3 of the roster campaigns selects the genuinely-interested contacts
-- out of a table that is ~87% automated traffic, so this filter is on the
-- hot path for that feature rather than incidental.
create index if not exists link_clicks_class_idx on link_clicks (click_class);
