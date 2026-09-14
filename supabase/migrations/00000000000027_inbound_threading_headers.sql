-- Records the raw In-Reply-To / References headers on every inbound
-- message at ingestion time, alongside the match result they produced.
-- Before this, matchInboundMessage() used these headers transiently to
-- attempt a match but never persisted them -- when a reply failed to
-- match (see the Maria Camillo / Wintergrass Festival case, 2026-09),
-- there was no way afterward to tell whether the headers were missing,
-- malformed, or simply didn't reference a known outbound_sends row.
-- Kept nullable and additive -- every existing row and every other
-- insert path (e.g. the "Gmail returned 404" placeholder) is unaffected.
alter table inbound_messages
  add column in_reply_to text,
  add column references_header text;
