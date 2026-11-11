-- Replies matched by subject line: Gmail rewrites the Message-ID we stamp on
-- each send, so In-Reply-To rarely finds the outbound row, and a reply from a
-- second address (Barbès: sent to BarbesBookings@, answered from the
-- booker's own gmail, Nov 3 2026) fell through to unmatched and kept getting
-- follow-ups. See reply/matching.ts, step 4.
alter type inbound_match_method add value if not exists 'subject';
