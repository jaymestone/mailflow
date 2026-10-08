import type { SupabaseClient } from "@supabase/supabase-js";
import { batchClear, batchGet, batchUpdate, batchUpdateValues, getSheetTitles, sheetsConfigured, type Cell } from "./sheets";
import { MASTER_SPREADSHEET_ID as SHEET, SHEET_ROSTER, workbookTab } from "./roster";
import {
  eachDay,
  fmtDay,
  fmtRange,
  placeLead,
  readBookings,
  refreshNote,
  sameVenue,
  toWorkbook,
  type Lead,
  type Placement,
  type Workbook,
  type Write,
} from "./plan";

/** Keeps the booking spreadsheet current with Mailflow's conversations.
 *
 * The pipeline Jayme works from now: each artist's 2027 workbook, a Leads
 * tab for interest with no artist named, and a Routing tab of interested
 * venues near every date already on an artist's calendar. Replaced the
 * Notion board, which put every reply in front of him and was too much.
 *
 * Each pass:
 *   1. reads the Leads tab's "Bring into" dropdown and assigns those leads;
 *   2. places conversations the summariser has re-read since the last pass
 *      onto the artist workbooks (placeLead), or refreshes the note on a row
 *      it wrote before (refreshNote) -- only empty rows are ever filled,
 *      and a row Jayme edited or deleted stays his;
 *   3. rebuilds Leads and Routing in full (both are this pass's own tabs).
 *
 * Bounded for cron-job.org's 30-second ceiling: a handful of Sheets calls
 * and one Supabase write per changed conversation. */

const RADIUS_MILES = 150;
const MAX_PER_ANCHOR = 12;
/** Stops this close together (days apart, miles apart) share one Routing block. */
const RUN_GAP_DAYS = 4;
const RUN_MILES = 100;
const OWN = /@(jaymestone\.com|jaymestoneagency\.com)$/i;
const INTEREST_LABEL: Record<string, string> = {
  specific_date: "Date on the table",
  artist_no_date: "Interested, no date",
  if_routing: "If routing nearby",
  general_roster: "General roster interest",
  talk_later: "Talk later",
};
const LEADS_HEADER = ["Venue", "City", "Interest", "Timing", "Near a booked date", "Contact", "Where it stands", "Next step", "Last contact", "Email", "Bring into", "id"];
const PICK_COL = 10; // "Bring into", K
const ID_COL = 11; // hidden conversation id, L
/** A light tint per region for its whole block on the Leads tab; the bar
 * uses a deeper shade of the same colour. */
const REGION_TINT: Record<string, { red: number; green: number; blue: number }> = {
  Northeast: { red: 0.93, green: 0.95, blue: 1 },
  Southeast: { red: 1, green: 0.95, blue: 0.9 },
  Midwest: { red: 0.94, green: 0.98, blue: 0.92 },
  "Mountain West": { red: 0.97, green: 0.94, blue: 1 },
  Southwest: { red: 1, green: 0.97, blue: 0.88 },
  "West Coast": { red: 0.91, green: 0.98, blue: 0.98 },
  Canada: { red: 1, green: 0.93, blue: 0.94 },
  Europe: { red: 0.95, green: 0.95, blue: 0.9 },
  Other: { red: 0.95, green: 0.95, blue: 0.95 },
};
const deeper = (c: { red: number; green: number; blue: number }) => ({ red: c.red * 0.86, green: c.green * 0.86, blue: c.blue * 0.86 });

const INTEREST_COLOR: Record<string, { red: number; green: number; blue: number }> = {
  if_routing: { red: 0.8, green: 0.92, blue: 0.8 },
  specific_date: { red: 0.8, green: 0.88, blue: 0.98 },
  artist_no_date: { red: 0.89, green: 0.85, blue: 0.96 },
  talk_later: { red: 0.99, green: 0.92, blue: 0.75 },
  general_roster: { red: 0.93, green: 0.93, blue: 0.93 },
};
const ROUTING_HEADER = ["Interested venue nearby", "City", "Miles", "Interest", "Contact", "Where it stands", "Email"];
/** One light colour per artist for the Routing section bars, so where one
 * artist's dates end and the next begin is visible at a glance. */
const ARTIST_COLOR: Record<string, { red: number; green: number; blue: number }> = {
  "The Little Mercies": { red: 0.85, green: 0.93, blue: 0.83 },
  Rakish: { red: 0.81, green: 0.89, blue: 0.97 },
  "Amanda Pascali": { red: 0.99, green: 0.89, blue: 0.8 },
  "Sam Reider": { red: 0.89, green: 0.85, blue: 0.96 },
  "Jorge Glem & Sam Reider": { red: 0.8, green: 0.93, blue: 0.92 },
  "Lily Henley": { red: 0.98, green: 0.85, blue: 0.9 },
  "Samir Langus": { red: 0.99, green: 0.95, blue: 0.78 },
  "Charlie & The Tropicales": { red: 0.98, green: 0.84, blue: 0.8 },
  "Summer Camargo": { red: 0.88, green: 0.88, blue: 0.97 },
};

export type WorkbookTickResult = {
  skipped?: string;
  assigned: number;
  placed: number;
  notesRefreshed: number;
  leads: number;
  routingRows: number;
  errors: string[];
};

type Conv = {
  id: string;
  thread_key: string;
  venue: string | null;
  region: string | null;
  fee_amount: number | null;
  last_message_at: string | null;
  contact_id: string | null;
  gmail_thread_ids: string[] | null;
  summarized_at: string | null;
  sheet_artists: string[] | null;
  sheet_dates: Lead["dates"] | null;
  sheet_window: string | null;
  sheet_interest: string | null;
  sheet_routing_area: string | null;
  sheet_note: string | null;
  sheet_next_step: string | null;
  sheet_assigned_artist: string | null;
  sheet_placements: Placement[] | null;
  sheet_synced_at: string | null;
};
type Contact = { id: string; first_name: string | null; last_name: string | null; email: string; venue: string | null; city: string | null; state: string | null; lat: number | null; lng: number | null };
type Coord = { lat: number; lng: number };

/** A run's dates without weekdays: "Mar 17", "May 21–23", "Apr 30–May 2". */
export function compactRange(start: string, end: string): string {
  const md = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  if (start === end) return md(start);
  return start.slice(0, 7) === end.slice(0, 7) ? `${md(start)}–${Number(end.slice(8, 10))}` : `${md(start)}–${md(end)}`;
}

/** Open days without weekdays, grouped by month: "Apr 13, 14, 15 · May 1, 2". */
export function compactDays(isos: string[]): string {
  const byMonth = new Map<string, number[]>();
  for (const iso of isos) {
    const m = new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    byMonth.set(m, [...(byMonth.get(m) ?? []), Number(iso.slice(8, 10))]);
  }
  return [...byMonth].map(([m, d]) => `${m} ${d.join(", ")}`).join(" · ");
}

const miles = (a: Coord, b: Coord) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
};
const key = (city: string | null | undefined, state: string | null | undefined) => `${String(city ?? "").trim().toLowerCase()}|${String(state ?? "").trim().toLowerCase()}`;

async function readAll<T>(supabase: SupabaseClient, table: string, cols: string, filter?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    let q = supabase.from(table).select(cols).range(off, off + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`workbook: reading ${table} -- ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) return out;
  }
}

export async function runWorkbookTick(supabase: SupabaseClient, opts: { now?: Date } = {}): Promise<WorkbookTickResult> {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const result: WorkbookTickResult = { assigned: 0, placed: 0, notesRefreshed: 0, leads: 0, routingRows: 0, errors: [] };
  if (!sheetsConfigured()) return { ...result, skipped: "GOOGLE_SHEETS_* env vars are not set" };

  // ---- Read the sheet ------------------------------------------------------
  const titles = await getSheetTitles(SHEET);
  const sheetIdOf = new Map(titles.map((t) => [t.title, t.sheetId]));
  const years = [...new Set(titles.map((t) => (t.title.match(/ (\d{4}) Workbook$/) ?? [])[1]).filter(Boolean))].sort();
  const targets = SHEET_ROSTER.flatMap((artist) => years.map((y) => ({ artist: artist as string, tab: workbookTab(artist, y) }))).filter((t) => sheetIdOf.has(t.tab));
  // Formatted for Master and Leads (text as Jayme sees it), unformatted for
  // the workbooks so column A comes back as date serials.
  const [[masterRows, leadPicks], grids] = await Promise.all([
    batchGet(SHEET, ["Master!A2:G3000", "Leads!K2:L3000"]),
    batchGet(SHEET, targets.map((t) => `'${t.tab}'!A1:J1000`), "UNFORMATTED_VALUE"),
  ]);
  const bookings = readBookings(masterRows);
  const books = new Map<string, Workbook>(); // artist -> its (current-year-first) workbook
  targets.forEach((t, i) => {
    if (!books.has(t.artist)) books.set(t.artist, toWorkbook(t.tab, grids[i]));
  });

  // ---- 1. "Bring into" picks from the Leads tab ---------------------------
  for (const [artist, id] of leadPicks.filter((r) => r[0] && r[1]) as [string, string][]) {
    if (!books.has(artist)) continue;
    const { error } = await supabase.from("conversations").update({ sheet_assigned_artist: artist, sheet_synced_at: null }).eq("id", id);
    if (error) result.errors.push(`assign ${id}: ${error.message}`);
    else result.assigned++;
  }

  // ---- Mailflow's side -------------------------------------------------------
  const convs = (
    await readAll<Conv>(
      supabase,
      "conversations",
      "id, thread_key, venue, region, fee_amount, last_message_at, contact_id, gmail_thread_ids, summarized_at, sheet_artists, sheet_dates, sheet_window, sheet_interest, sheet_routing_area, sheet_note, sheet_next_step, sheet_assigned_artist, sheet_placements, sheet_synced_at",
      (q) => q.eq("is_live", true),
    )
  ).filter((c) => c.sheet_interest && c.sheet_interest !== "declined" && !OWN.test(c.thread_key.split("::")[0]));
  const contactIds = [...new Set(convs.map((c) => c.contact_id).filter(Boolean))] as string[];
  const contactById = new Map<string, Contact>();
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data } = await supabase.from("contacts").select("id, first_name, last_name, email, venue, city, state, lat, lng").in("id", contactIds.slice(i, i + 200));
    for (const c of (data ?? []) as Contact[]) contactById.set(c.id, c);
  }
  // A place with no coordinates of its own borrows any geocoded contact in
  // the same city -- plenty for a 150-mile radius.
  const cityCoord = new Map<string, Coord>();
  for (const c of await readAll<Contact>(supabase, "contacts", "city, state, lat, lng", (q) => q.not("lat", "is", null)))
    if (c.city) cityCoord.set(key(c.city, c.state), { lat: c.lat!, lng: c.lng! });
  const { data: accts } = await supabase.from("connected_accounts").select("id, email_address");
  const acctEmail = new Map((accts ?? []).map((a) => [a.id as string, a.email_address as string]));
  const firstThreads = convs.map((c) => c.gmail_thread_ids?.[0]).filter(Boolean) as string[];
  const threadAcct = new Map<string, string>();
  for (let i = 0; i < firstThreads.length; i += 200) {
    const { data } = await supabase.from("inbound_messages").select("gmail_thread_id, connected_account_id").in("gmail_thread_id", firstThreads.slice(i, i + 200));
    for (const m of data ?? []) threadAcct.set(m.gmail_thread_id, acctEmail.get(m.connected_account_id) ?? "");
  }

  const view = convs.map((c) => {
    const ct = c.contact_id ? contactById.get(c.contact_id) : undefined;
    const email = c.thread_key.split("::")[0];
    const venue = c.venue || ct?.venue || (/@(gmail|yahoo|hotmail|outlook|aol|icloud|me|mac|comcast|verizon|att|live|msn)\./i.test(email) ? email : email.split("@")[1]);
    const t = c.gmail_thread_ids?.[0];
    const acct = t ? threadAcct.get(t) : undefined;
    const lead: Lead = {
      venue,
      city: ct?.city ?? "",
      state: ct?.state ?? "",
      fee: c.fee_amount,
      artists: [...new Set([...(c.sheet_artists ?? []), ...(c.sheet_assigned_artist ? [c.sheet_assigned_artist] : [])])],
      dates: c.sheet_dates ?? [],
      window: c.sheet_window,
      interest: c.sheet_interest!,
      routingArea: c.sheet_routing_area,
      note: c.sheet_note ?? "",
      nextStep: c.sheet_next_step,
    };
    return {
      c,
      lead,
      contactName: [ct?.first_name, ct?.last_name].filter((s) => s && s !== "Folks").join(" "),
      email,
      coord: ct?.lat != null ? { lat: ct.lat, lng: ct.lng! } : ct?.city ? cityCoord.get(key(ct.city, ct.state)) : undefined,
      link: acct && t ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(acct)}#all/${t}` : "",
    };
  });

  // ---- 2. Place or refresh what moved ---------------------------------------
  const writes: Write[] = [];
  for (const v of view) {
    const changed = !v.c.sheet_synced_at || (v.c.summarized_at && v.c.summarized_at > v.c.sheet_synced_at);
    if (!changed || !v.lead.artists.length) continue;
    const placements = [...(v.c.sheet_placements ?? [])];
    for (const artist of v.lead.artists) {
      const wb = books.get(artist);
      if (!wb) continue;
      const prior = placements.find((p) => p.artist === artist);
      if (prior) {
        if ("row" in prior && prior.tab === wb.tab) {
          const note = `${prior.note.match(/^Booked: [^)]*\)\. /)?.[0] ?? ""}${v.lead.note}${v.lead.nextStep ? ` Next: ${v.lead.nextStep}` : ""}`;
          const w = refreshNote(wb, prior, note);
          if (w) {
            writes.push(w);
            prior.note = note;
            result.notesRefreshed++;
          }
        }
        continue;
      }
      const { placement, writes: w } = placeLead({ artist, wb, lead: v.lead, bookings, today });
      placements.push(placement);
      writes.push(...w);
      if (w.length) result.placed++;
    }
    v.c.sheet_placements = placements;
  }
  if (writes.length) await batchUpdateValues(SHEET, writes, "RAW");
  for (const v of view) {
    const changed = !v.c.sheet_synced_at || (v.c.summarized_at && v.c.summarized_at > v.c.sheet_synced_at);
    if (!changed) continue;
    const { error } = await supabase.from("conversations").update({ sheet_placements: v.c.sheet_placements ?? [], sheet_synced_at: now.toISOString() }).eq("id", v.c.id);
    if (error) result.errors.push(`${v.c.thread_key.slice(0, 40)}: ${error.message}`);
  }

  // ---- 3b. Routing: interested venues near every date on a calendar ---------
  // Laid out in blocks, one per date on an artist's calendar: a coloured bar
  // naming the stop and its open days, the interested venues under it, then
  // a blank row. A flat table repeated the same stop on every row, which
  // Jayme found hard to read.
  const routing: Cell[][] = [];
  const routingLinks: Cell[][] = [];
  type Segment = { text: string; style: "artist" | "dates" | "venue" | "status" | "city" | "sep" | "open" };
  const bars: { row: number; artist: string; segments: Segment[] }[] = [];
  const routingHot: number[] = []; // rows whose venue said "if you're routing nearby"
  // Every run on every calendar, for the Leads tab's "Near a booked date".
  const runIndex: { artist: string; when: string; coords: Coord[]; confirmed: boolean }[] = [];
  for (const [artist, wb] of books) {
    type Day = { venue: string; status: string; city: string; state: string };
    const cal = new Map<string, Day>();
    const unavailable = new Set<string>();
    for (const [iso, row] of wb.rowOfIso) {
      const r = wb.grid[row - 1] ?? [];
      const venue = String(r[2] ?? "").trim();
      if (venue) cal.set(iso, { venue, status: String(r[1] ?? "").trim() || "—", city: String(r[3] ?? ""), state: String(r[4] ?? "") });
      const avail = String(r[7] ?? "").trim();
      if (avail === "Unavailable") unavailable.add(iso);
      if (/^booked/i.test(avail) && !cal.has(iso)) {
        const [c = "", st = ""] = String(r[8] ?? "").split(",").map((x) => x.trim());
        cal.set(iso, { venue: "Artist's own show", status: "Booked by artist", city: c, state: st });
      }
    }
    for (const b of bookings.filter((b) => b.artist === artist && b.range))
      for (const iso of eachDay(b.range![0], b.range![1])) if (wb.rowOfIso.has(iso) && !cal.has(iso)) cal.set(iso, { venue: b.venue, status: b.status, city: b.city, state: b.state });

    const isos = [...wb.rowOfIso.keys()].sort();
    // Stops: consecutive days at one venue.
    type Stop = { i: number; j: number; day: Day; where: Coord };
    const stops: Stop[] = [];
    for (let i = 0; i < isos.length; i++) {
      const day = cal.get(isos[i]);
      if (!day || (i > 0 && cal.get(isos[i - 1]) && sameVenue(cal.get(isos[i - 1])!.venue, day.venue))) continue;
      let j = i;
      while (j + 1 < isos.length && cal.get(isos[j + 1]) && sameVenue(cal.get(isos[j + 1])!.venue, day.venue)) j++;
      // The day's own city first: a fuzzy name match can land on a venue's
      // agent elsewhere (Old Settlers in Austin matched an agent in Colorado).
      const where = cityCoord.get(key(day.city, day.state)) ?? (day.city ? undefined : view.find((v) => sameVenue(v.lead.venue, day.venue))?.coord);
      if (where) stops.push({ i, j, day, where });
    }
    // Runs: stops within RUN_GAP_DAYS and RUN_MILES of the one before are one
    // block. Cottonwood (Fort Collins) then two Chautauqua nights (Boulder)
    // each listed the same Colorado venues; as one run they list them once.
    const runs: Stop[][] = [];
    for (const st of stops) {
      const last = runs[runs.length - 1]?.at(-1);
      if (last && st.i - last.j <= RUN_GAP_DAYS && miles(last.where, st.where) <= RUN_MILES) runs[runs.length - 1].push(st);
      else runs.push([st]);
    }
    for (const run of runs) {
      const i = run[0].i;
      const j = run[run.length - 1].j;
      const openIsos: string[] = [];
      for (let k = Math.max(0, i - 3); k <= Math.min(isos.length - 1, j + 3); k++) if (!cal.has(isos[k]) && !unavailable.has(isos[k])) openIsos.push(isos[k]);
      const near = view
        .filter((v) => v.coord && !run.some((st) => sameVenue(v.lead.venue, st.day.venue)) && (v.lead.artists.length === 0 || v.lead.artists.includes(artist)))
        .map((v) => ({ v, d: Math.min(...run.map((st) => miles(st.where, v.coord!))) }))
        .filter((n) => n.d <= RADIUS_MILES)
        .sort(
          (a, b) =>
            Number(b.v.lead.interest === "if_routing") - Number(a.v.lead.interest === "if_routing") ||
            Number(b.v.lead.artists.includes(artist)) - Number(a.v.lead.artists.includes(artist)) ||
            a.d - b.d,
        )
        .slice(0, MAX_PER_ANCHOR);
      runIndex.push({
        artist,
        when: compactRange(isos[i], isos[j]),
        coords: run.map((st) => st.where),
        // A run is confirmed if any of its shows is: a Confirmed row (Jayme's
        // or from Master) or a show the artist booked themselves.
        confirmed: run.some((st) => /^confirmed|booked by artist/i.test(st.day.status)),
      });
      if (!near.length) continue;
      const when = i === j ? fmtDay(isos[i]) : `${fmtDay(isos[i])} – ${fmtDay(isos[j])}`;
      // Each piece in its own style (see the bar formatting below): artist,
      // dates, venue and status, city, then the open days without weekdays.
      const segments: Segment[] = [
        { text: artist.toUpperCase(), style: "artist" },
        { text: "   ", style: "sep" },
        { text: when, style: "dates" },
      ];
      run.forEach((st, n) => {
        segments.push({ text: n === 0 ? "   " : "   /   ", style: "sep" });
        segments.push({ text: st.day.venue, style: "venue" });
        const label = [st.day.status === "—" ? "" : st.day.status, run.length > 1 ? fmtDay(isos[st.i]) : ""].filter(Boolean).join(", ");
        if (label) segments.push({ text: ` (${label})`, style: "status" });
        const place = [st.day.city, st.day.state].filter(Boolean).join(", ");
        if (place) segments.push({ text: `  ${place}`, style: "city" });
      });
      segments.push({ text: openIsos.length ? `\nOpen nearby: ${compactDays(openIsos)}` : "\nNo open days within 3 days either side", style: "open" });
      // Sheet row numbers: row 1 is the header, so routing[k] lands on row k + 2.
      bars.push({ row: routing.length + 2, artist, segments });
      routing.push([""]);
      routingLinks.push([""]);
      for (const n of near) {
        if (n.v.lead.interest === "if_routing") routingHot.push(routing.length + 2);
        routing.push([
          n.v.lead.venue,
          [n.v.lead.city, n.v.lead.state].filter(Boolean).join(", "),
          String(Math.round(n.d)),
          INTEREST_LABEL[n.v.lead.interest] ?? n.v.lead.interest,
          [n.v.contactName, n.v.email].filter(Boolean).join(" · "),
          n.v.lead.note,
        ]);
        routingLinks.push([n.v.link ? `=HYPERLINK("${n.v.link}","Open email")` : ""]);
        result.routingRows++;
      }
      routing.push([""]);
      routingLinks.push([""]);
    }
  }

  // ---- 3b. Leads: interest with no artist yet, by region ----------------------
  // Sections per region with a summary bar, the "if routing" venues first,
  // and for each venue the nearest dates already on any artist's calendar --
  // the connection Jayme would otherwise have to work out in his head.
  const order = ["if_routing", "specific_date", "artist_no_date", "talk_later", "general_roster"];
  const leads = view
    .filter((v) => !v.lead.artists.length)
    .sort(
      (a, b) =>
        (a.c.region ?? "zz").localeCompare(b.c.region ?? "zz") ||
        order.indexOf(a.lead.interest) - order.indexOf(b.lead.interest) ||
        a.lead.state.localeCompare(b.lead.state) ||
        a.lead.city.localeCompare(b.lead.city),
    );
  result.leads = leads.length;
  const leadRows: Cell[][] = [];
  const leadLinks: Cell[][] = [];
  const leadIds: Cell[][] = [];
  const regionBars: { row: number; end: number; region: string; text: string; split: number }[] = [];
  const leadRowAt: { row: number; interest: string }[] = [];
  const nearCells: { row: number; parts: { text: string; confirmed: boolean }[] }[] = [];
  for (const region of [...new Set(leads.map((v) => v.c.region ?? "Other"))]) {
    const group = leads.filter((v) => (v.c.region ?? "Other") === region);
    const count = (k: string) => group.filter((v) => v.lead.interest === k).length;
    const tally = [`${group.length} venue${group.length === 1 ? "" : "s"}`, ...order.filter((k) => count(k)).map((k) => `${count(k)} ${(INTEREST_LABEL[k] ?? k).toLowerCase()}`)].join(" · ");
    const title = region.toUpperCase();
    regionBars.push({ row: leadRows.length + 2, end: leadRows.length + 1 + group.length, region, text: `${title}   ${tally}`, split: title.length });
    leadRows.push([""]);
    leadLinks.push([""]);
    leadIds.push([""]);
    for (const v of group) {
      // ✓ confirmed, ○ prospective (inquiry, hold, offer); confirmed first.
      const parts = v.coord
        ? runIndex
            .map((r) => ({ r, d: Math.min(...r.coords.map((c) => miles(c, v.coord!))) }))
            .filter((n) => n.d <= RADIUS_MILES)
            .sort((a, b) => Number(b.r.confirmed) - Number(a.r.confirmed) || a.d - b.d)
            .slice(0, 3)
            .map((n) => ({ text: `${n.r.confirmed ? "✓" : "○"} ${n.r.artist} · ${n.r.when} · ${Math.round(n.d)} mi`, confirmed: n.r.confirmed }))
        : [];
      const near = parts.map((x) => x.text).join("\n");
      if (parts.length) nearCells.push({ row: leadRows.length + 2, parts });
      leadRowAt.push({ row: leadRows.length + 2, interest: v.lead.interest });
      leadRows.push([
        v.lead.venue,
        [v.lead.city, v.lead.state].filter(Boolean).join(", "),
        INTEREST_LABEL[v.lead.interest] ?? v.lead.interest,
        [v.lead.routingArea ? `Near ${v.lead.routingArea}` : "", ...v.lead.dates.map(fmtRange), v.lead.window ?? ""].filter(Boolean).join(" · "),
        near,
        [v.contactName, v.email].filter(Boolean).join("\n"),
        v.lead.note,
        v.lead.nextStep ?? "",
        (v.c.last_message_at ?? "").slice(0, 10),
      ]);
      leadLinks.push([v.link ? `=HYPERLINK("${v.link}","Open email")` : ""]);
      leadIds.push([v.c.id]);
    }
    leadRows.push([""]);
    leadLinks.push([""]);
    leadIds.push([""]);
  }

  // ---- Write Leads and Routing ----------------------------------------------
  // RAW, not USER_ENTERED: Sheets otherwise reads "Fri, May 21" as a date in
  // the current year and redraws its weekday. Only the links are formulas.
  await batchClear(SHEET, ["Leads!A1:N3000", "Routing!A1:L3000"]);
  await batchUpdateValues(
    SHEET,
    [
      { range: "Leads!A1", values: [LEADS_HEADER, ...leadRows] },
      { range: "Leads!L2", values: leadIds },
      { range: "Routing!A1", values: [ROUTING_HEADER, ...routing] },
    ],
    "RAW",
  );
  await batchUpdateValues(
    SHEET,
    [
      { range: "Leads!J2", values: leadLinks },
      { range: "Routing!G2", values: routingLinks },
    ],
    "USER_ENTERED",
  );
  // Routing blocks: reset last run's merges and colours, then draw this run's.
  const routingId = sheetIdOf.get("Routing");
  if (routingId !== undefined) {
    const all = { sheetId: routingId, startRowIndex: 0, endRowIndex: 3000, startColumnIndex: 0, endColumnIndex: 12 };
    const rowRange = (row: number, c0 = 0, c1 = ROUTING_HEADER.length) => ({ sheetId: routingId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: c0, endColumnIndex: c1 });
    await batchUpdate(SHEET, [
      { clearBasicFilter: { sheetId: routingId } },
      { unmergeCells: { range: all } },
      { repeatCell: { range: all, cell: { userEnteredFormat: { verticalAlignment: "TOP", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat" } },
      { updateSheetProperties: { properties: { sheetId: routingId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: rowRange(1), cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 }, verticalAlignment: "TOP" } }, fields: "userEnteredFormat(textFormat,backgroundColor,verticalAlignment)" } },
      ...[230, 140, 55, 150, 240, 460, 95].map((w, i) => ({
        updateDimensionProperties: { range: { sheetId: routingId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: "pixelSize" },
      })),
      ...bars.flatMap((b) => {
        const bg = ARTIST_COLOR[b.artist] ?? { red: 0.92, green: 0.92, blue: 0.92 };
        const deep = { red: bg.red * 0.42, green: bg.green * 0.42, blue: bg.blue * 0.42 };
        const STYLE: Record<Segment["style"], object> = {
          artist: { bold: true, fontSize: 12, foregroundColor: deep },
          dates: { bold: true, fontSize: 11, foregroundColor: { red: 0.1, green: 0.25, blue: 0.62 } },
          venue: { bold: true, fontSize: 11, foregroundColor: { red: 0.1, green: 0.1, blue: 0.1 } },
          status: { bold: false, fontSize: 10, foregroundColor: { red: 0.3, green: 0.3, blue: 0.3 } },
          city: { italic: true, fontSize: 10, foregroundColor: { red: 0.38, green: 0.38, blue: 0.38 } },
          sep: { fontSize: 11 },
          open: { bold: false, fontSize: 10, foregroundColor: { red: 0.25, green: 0.25, blue: 0.25 } },
        };
        let at = 0;
        const runs = b.segments.map((seg) => {
          const r = { startIndex: at, format: STYLE[seg.style] };
          at += seg.text.length;
          return r;
        });
        return [
          { mergeCells: { range: rowRange(b.row), mergeType: "MERGE_ALL" } },
          {
            updateCells: {
              range: rowRange(b.row, 0, 1),
              rows: [{ values: [{ userEnteredValue: { stringValue: b.segments.map((x) => x.text).join("") }, textFormatRuns: runs }] }],
              fields: "userEnteredValue,textFormatRuns",
            },
          },
          {
            repeatCell: {
              range: rowRange(b.row),
              cell: { userEnteredFormat: { backgroundColor: bg, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE", padding: { top: 6, bottom: 6, left: 6, right: 6 } } },
              fields: "userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment,padding)",
            },
          },
        ];
      }),
      ...routingHot.map((row) => ({
        repeatCell: {
          range: rowRange(row, 3, 4),
          cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 0.1, green: 0.45, blue: 0.2 } } } },
          fields: "userEnteredFormat.textFormat",
        },
      })),
    ]);
  }

  // Leads layout: region bars, interest chips, bold venues, italic next
  // steps, a "Bring into" dropdown on every venue row, the id column hidden.
  const leadsId = sheetIdOf.get("Leads");
  if (leadsId !== undefined) {
    const all = { sheetId: leadsId, startRowIndex: 0, endRowIndex: 3000, startColumnIndex: 0, endColumnIndex: 14 };
    const cells = (row: number, c0: number, c1: number) => ({ sheetId: leadsId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: c0, endColumnIndex: c1 });
    const col = (c: number) => ({ sheetId: leadsId, startRowIndex: 1, endRowIndex: 3000, startColumnIndex: c, endColumnIndex: c + 1 });
    const picks = { condition: { type: "ONE_OF_LIST", values: [...books.keys()].map((a) => ({ userEnteredValue: a })) }, strict: true, showCustomUi: true };
    await batchUpdate(SHEET, [
      { clearBasicFilter: { sheetId: leadsId } },
      { unmergeCells: { range: all } },
      { setDataValidation: { range: all } },
      { repeatCell: { range: all, cell: { userEnteredFormat: { verticalAlignment: "TOP", wrapStrategy: "WRAP", textFormat: { fontSize: 10 } } }, fields: "userEnteredFormat" } },
      { updateSheetProperties: { properties: { sheetId: leadsId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: cells(1, 0, LEADS_HEADER.length), cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
      ...[210, 130, 140, 170, 270, 210, 380, 230, 90, 90, 190, 60].map((w, i) => ({
        updateDimensionProperties: { range: { sheetId: leadsId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: "pixelSize" },
      })),
      { updateDimensionProperties: { range: { sheetId: leadsId, dimension: "COLUMNS", startIndex: ID_COL, endIndex: ID_COL + 1 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
      { repeatCell: { range: col(0), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 10 } } }, fields: "userEnteredFormat.textFormat" } },
      // Region tint first, so the interest chips and bars below paint over it.
      ...regionBars.map((b) => ({
        repeatCell: {
          range: { sheetId: leadsId, startRowIndex: b.row, endRowIndex: b.end + 1, startColumnIndex: 0, endColumnIndex: PICK_COL + 1 },
          cell: { userEnteredFormat: { backgroundColor: REGION_TINT[b.region] ?? REGION_TINT.Other } },
          fields: "userEnteredFormat.backgroundColor",
        },
      })),
      ...nearCells.map(({ row, parts }) => {
        let at = 0;
        const runs = parts.map((p, n) => {
          const r = {
            startIndex: at,
            format: p.confirmed
              ? { bold: true, fontSize: 10, foregroundColor: { red: 0.1, green: 0.45, blue: 0.2 } }
              : { bold: false, fontSize: 10, foregroundColor: { red: 0.42, green: 0.42, blue: 0.42 } },
          };
          at += p.text.length + (n < parts.length - 1 ? 1 : 0);
          return r;
        });
        return {
          updateCells: {
            range: cells(row, 4, 5),
            rows: [{ values: [{ userEnteredValue: { stringValue: parts.map((p) => p.text).join("\n") }, textFormatRuns: runs }] }],
            fields: "userEnteredValue,textFormatRuns",
          },
        };
      }),
      { repeatCell: { range: col(7), cell: { userEnteredFormat: { textFormat: { italic: true, fontSize: 10, foregroundColor: { red: 0.3, green: 0.3, blue: 0.3 } } } }, fields: "userEnteredFormat.textFormat" } },
      ...leadRowAt.flatMap(({ row, interest }) => [
        { repeatCell: { range: cells(row, 2, 3), cell: { userEnteredFormat: { backgroundColor: INTEREST_COLOR[interest] ?? INTEREST_COLOR.general_roster, textFormat: { bold: interest === "if_routing", fontSize: 10 } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
        { setDataValidation: { range: cells(row, PICK_COL, PICK_COL + 1), rule: picks } },
      ]),
      ...regionBars.flatMap((b) => [
        { mergeCells: { range: cells(b.row, 0, PICK_COL + 1), mergeType: "MERGE_ALL" } },
        {
          updateCells: {
            range: cells(b.row, 0, 1),
            rows: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: b.text },
                    textFormatRuns: [
                      { startIndex: 0, format: { bold: true, fontSize: 12, foregroundColor: { red: 0.12, green: 0.2, blue: 0.35 } } },
                      { startIndex: b.split, format: { bold: false, fontSize: 10, foregroundColor: { red: 0.3, green: 0.3, blue: 0.3 } } },
                    ],
                  },
                ],
              },
            ],
            fields: "userEnteredValue,textFormatRuns",
          },
        },
        {
          repeatCell: {
            range: cells(b.row, 0, PICK_COL + 1),
            cell: { userEnteredFormat: { backgroundColor: deeper(REGION_TINT[b.region] ?? REGION_TINT.Other), verticalAlignment: "MIDDLE", padding: { top: 6, bottom: 6, left: 6, right: 6 } } },
            fields: "userEnteredFormat(backgroundColor,verticalAlignment,padding)",
          },
        },
      ]),
    ]);
  }
  return result;
}
