-- Two inputs the replacement research needed but never received.
--
-- The research procedure (see the SYSTEM prompt in
-- src/lib/research/findReplacement.ts, which encodes how Jayme finds
-- these by hand) begins by going straight to the venue's own staff page.
-- We frequently already know that website from the contact we're
-- replacing, but the queue row didn't carry it, so every lookup started
-- by re-discovering a URL we had on file.
--
-- The departed person's name matters for a subtler reason. The research
-- infers the venue's email convention from their address in order to
-- construct a likely address for whoever replaced them -- but
-- "jsmith@venue.org" is ambiguous on its own (first-initial + surname,
-- or simply someone named Jsmith?). Paired with "Jane Smith" the pattern
-- is unambiguous, which is what makes the inference trustworthy enough
-- to then verify.
--
-- Both are nullable: rows queued before this migration, and contacts
-- that genuinely had no website on file, simply won't have them, and the
-- research falls back to its previous behaviour.

alter table replacement_queue add column if not exists venue_website text;
alter table replacement_queue add column if not exists removed_contact_name text;
