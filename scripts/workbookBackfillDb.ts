// One-time, after migration 41: loads the 2026-10-08 extraction pass
// (scripts/.workbook-extract.json) into the conversations' sheet_* columns
// and records where each lead already sits on the artist workbooks, so the
// workbook tick picks up from there instead of placing everything again.
//
// A row counts as the pipeline's own (and its note may be refreshed later)
// only when its note is the one the pass wrote; anything else is Jayme's.
//
//   npx tsx --env-file=.env.local scripts/workbookBackfillDb.ts [--apply]

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { batchGet, getSheetTitles } from "../src/lib/workbook/sheets";
import { MASTER_SPREADSHEET_ID, SHEET_ROSTER, workbookTab } from "../src/lib/workbook/roster";
import { sameVenue, type Placement } from "../src/lib/workbook/plan";
import type { Extract } from "./workbookExtract";

const APPLY = process.argv.includes("--apply");
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const FREE = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|mac|comcast|verizon|att|live|msn)\./i;

async function main() {
  const extracts: Record<string, Extract> = JSON.parse(readFileSync("scripts/.workbook-extract.json", "utf8"));
  const titles = new Set((await getSheetTitles(MASTER_SPREADSHEET_ID)).map((t) => t.title));
  const artists = SHEET_ROSTER.filter((a) => titles.has(workbookTab(a, 2027)));
  const grids = await batchGet(MASTER_SPREADSHEET_ID, artists.map((a) => `'${workbookTab(a, 2027)}'!A1:G1000`));
  const gridOf = new Map(artists.map((a, i) => [a as string, grids[i]]));

  const { data: convs } = await supabase.from("conversations").select("id, thread_key, venue, contact_id, summarized_at").in("id", Object.keys(extracts));
  const contactIds = (convs ?? []).map((c) => c.contact_id).filter(Boolean);
  const venueOfContact = new Map<string, string>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data } = await supabase.from("contacts").select("id, venue").in("id", contactIds.slice(i, i + 200));
    for (const c of data ?? []) if (c.venue) venueOfContact.set(c.id, c.venue);
  }

  let owned = 0;
  let theirs = 0;
  let none = 0;
  const now = new Date().toISOString();
  for (const c of convs ?? []) {
    const x = extracts[c.id];
    const email = c.thread_key.split("::")[0];
    const venue = c.venue || venueOfContact.get(c.contact_id) || (FREE.test(email) ? email : email.split("@")[1]);
    const placements: Placement[] = [];
    for (const artist of x.artists) {
      const grid = gridOf.get(artist);
      if (!grid) continue;
      const idx = grid.findIndex((r, i) => i > 0 && sameVenue(r[2], venue));
      if (idx < 0) {
        none++;
        continue;
      }
      const note = String(grid[idx][6] ?? "");
      if (note.includes(x.note.slice(0, 40))) {
        placements.push({ artist, tab: workbookTab(artist, 2027), row: idx + 1, venue: String(grid[idx][2]), note, kind: idx + 1 <= 366 ? "dated" : "undated" });
        owned++;
      } else {
        placements.push({ artist, kind: "exists", venue });
        theirs++;
      }
    }
    if (!APPLY) continue;
    const { error } = await supabase
      .from("conversations")
      .update({
        sheet_artists: x.artists,
        sheet_dates: x.dates,
        sheet_window: x.target_window,
        sheet_interest: x.interest,
        sheet_routing_area: x.routing_area,
        sheet_note: x.note,
        sheet_next_step: x.next_step,
        sheet_placements: placements,
        // Synced as of now: the tick only revisits a thread once the
        // summariser has re-read it after this.
        sheet_synced_at: now,
      })
      .eq("id", c.id);
    if (error) throw new Error(`${c.thread_key}: ${error.message}`);
  }
  console.log(`${convs?.length} conversations: ${owned} rows the pass wrote (notes kept current), ${theirs} rows Jayme already had (left alone), ${none} artist leads with no row (booked, declined or own-address)`);
  console.log(APPLY ? "Written." : "Dry run: nothing written. Re-run with --apply.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
