-- The booking pipeline moved from Notion into the [MASTER] Tour Dates
-- spreadsheet (artist 2027 workbooks, Leads, Routing). The summariser now
-- also reads which artist(s), dates, timing and kind of interest a thread
-- holds; the workbook tick places it on the sheet and remembers where, so
-- it updates its own rows and never re-adds one Jayme deleted.
alter table conversations
  add column if not exists sheet_artists text[],
  add column if not exists sheet_dates jsonb,
  add column if not exists sheet_window text,
  add column if not exists sheet_interest text,
  add column if not exists sheet_routing_area text,
  add column if not exists sheet_note text,
  add column if not exists sheet_next_step text,
  -- Set from the Leads tab's "Bring into" dropdown.
  add column if not exists sheet_assigned_artist text,
  -- [{artist, tab, row, venue, note}] -- the rows this pipeline wrote.
  add column if not exists sheet_placements jsonb not null default '[]'::jsonb,
  add column if not exists sheet_synced_at timestamptz;
