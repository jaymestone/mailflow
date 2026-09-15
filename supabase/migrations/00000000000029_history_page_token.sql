-- Lets a history.list traversal resume from where it left off across
-- separate poll ticks, instead of always restarting from the account's
-- last confirmed checkpoint (see MAX_HISTORY_PAGES in gmail/history.ts).
-- Confirmed live, 2026-09-15: stone@jaymestone.com -- by far the
-- highest-volume account, hub for both Reply-To routing and its own
-- bounces -- has enough history accumulated that it never completes a
-- traversal within the page cap, so every tick restarted from the exact
-- same point and re-scanned the same early pages forever, permanently
-- stuck (checkpoint frozen for hours while every other account advanced
-- normally). Storing the page token lets truncated runs pick up on the
-- next page next tick instead of looping the same ground indefinitely.
alter table connected_accounts
  add column history_page_token text;
