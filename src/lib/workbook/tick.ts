import type { SupabaseClient } from "@supabase/supabase-js";
import { batchClear, batchGet, batchUpdate, batchUpdateValues, getSheetTitles, sheetsConfigured, type Cell } from "./sheets";
import { MASTER_SPREADSHEET_ID as SHEET, SHEET_ROSTER, workbookTab } from "./roster";
import {
  eachDay,
  fmtDay,
  fmtRange,
  money,
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
const OWN = /@(jaymestone\.com|jaymestoneagency\.com)$/i;
const INTEREST_LABEL: Record<string, string> = {
  specific_date: "Date on the table",
  artist_no_date: "Interested, no date",
  if_routing: "If routing nearby",
  general_roster: "General roster interest",
  talk_later: "Talk later",
};
const LEADS_HEADER = ["Region", "City", "State", "Venue", "Interest", "Timing", "Fee", "Contact", "Where it stands", "Next step", "Last contact", "Email", "Bring into", "id"];
const ROUTING_HEADER = ["Artist", "Date", "Booked / pending", "Where", "Open days nearby", "Interested venue nearby", "City", "Miles", "Interest", "Contact", "Where it stands", "Email"];

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
    batchGet(SHEET, ["Master!A2:G3000", "Leads!M2:N2000"]),
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

  // ---- 3a. Leads: interest with no artist yet -------------------------------
  const order = ["if_routing", "specific_date", "artist_no_date", "talk_later", "general_roster"];
  const leads = view
    .filter((v) => !v.lead.artists.length)
    .sort(
      (a, b) =>
        (a.c.region ?? "zz").localeCompare(b.c.region ?? "zz") ||
        a.lead.state.localeCompare(b.lead.state) ||
        a.lead.city.localeCompare(b.lead.city) ||
        order.indexOf(a.lead.interest) - order.indexOf(b.lead.interest),
    );
  const leadText = leads.map((v) => [
    v.c.region ?? "",
    v.lead.city,
    v.lead.state,
    v.lead.venue,
    INTEREST_LABEL[v.lead.interest] ?? v.lead.interest,
    [v.lead.routingArea ? `Near ${v.lead.routingArea}` : "", ...v.lead.dates.map(fmtRange), v.lead.window ?? ""].filter(Boolean).join(" · "),
    money(v.c.fee_amount),
    [v.contactName, v.email].filter(Boolean).join(" · "),
    v.lead.note,
    v.lead.nextStep ?? "",
    (v.c.last_message_at ?? "").slice(0, 10),
  ]);
  result.leads = leads.length;

  // ---- 3b. Routing: interested venues near every date on a calendar ---------
  const routing: Cell[][] = [];
  const routingLinks: Cell[][] = [];
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
    for (let i = 0; i < isos.length; i++) {
      const day = cal.get(isos[i]);
      if (!day || (i > 0 && cal.get(isos[i - 1]) && sameVenue(cal.get(isos[i - 1])!.venue, day.venue))) continue;
      let j = i;
      while (j + 1 < isos.length && cal.get(isos[j + 1]) && sameVenue(cal.get(isos[j + 1])!.venue, day.venue)) j++;
      // The day's own city first: a fuzzy name match can land on a venue's
      // agent elsewhere (Old Settlers in Austin matched an agent in Colorado).
      const where = cityCoord.get(key(day.city, day.state)) ?? (day.city ? undefined : view.find((v) => sameVenue(v.lead.venue, day.venue))?.coord);
      if (!where) continue;
      const open: string[] = [];
      for (let k = Math.max(0, i - 3); k <= Math.min(isos.length - 1, j + 3); k++) if ((k < i || k > j) && !cal.has(isos[k]) && !unavailable.has(isos[k])) open.push(fmtDay(isos[k]));
      const near = view
        .filter((v) => v.coord && !sameVenue(v.lead.venue, day.venue) && (v.lead.artists.length === 0 || v.lead.artists.includes(artist)))
        .map((v) => ({ v, d: miles(where, v.coord!) }))
        .filter((n) => n.d <= RADIUS_MILES)
        .sort(
          (a, b) =>
            Number(b.v.lead.interest === "if_routing") - Number(a.v.lead.interest === "if_routing") ||
            Number(b.v.lead.artists.includes(artist)) - Number(a.v.lead.artists.includes(artist)) ||
            a.d - b.d,
        )
        .slice(0, MAX_PER_ANCHOR);
      const when = i === j ? fmtDay(isos[i]) : `${fmtDay(isos[i])} – ${fmtDay(isos[j])}`;
      for (const n of near) {
        routing.push([
          artist,
          when,
          `${day.venue} (${day.status})`,
          [day.city, day.state].filter(Boolean).join(", "),
          open.join(", "),
          n.v.lead.venue,
          [n.v.lead.city, n.v.lead.state].filter(Boolean).join(", "),
          String(Math.round(n.d)),
          INTEREST_LABEL[n.v.lead.interest] ?? n.v.lead.interest,
          [n.v.contactName, n.v.email].filter(Boolean).join(" · "),
          n.v.lead.note,
        ]);
        routingLinks.push([n.v.link ? `=HYPERLINK("${n.v.link}","Open email")` : ""]);
      }
    }
  }
  result.routingRows = routing.length;

  // ---- Write Leads and Routing ----------------------------------------------
  // RAW, not USER_ENTERED: Sheets otherwise reads "Fri, May 21" as a date in
  // the current year and redraws its weekday. Only the links are formulas.
  await batchClear(SHEET, ["Leads!A2:N3000", "Routing!A2:L3000"]);
  await batchUpdateValues(
    SHEET,
    [
      { range: "Leads!A1", values: [LEADS_HEADER, ...leadText] },
      { range: "Leads!N2", values: leads.map((v) => [v.c.id]) },
      { range: "Routing!A1", values: [ROUTING_HEADER, ...routing] },
    ],
    "RAW",
  );
  await batchUpdateValues(
    SHEET,
    [
      { range: "Leads!L2", values: leads.map((v) => [v.link ? `=HYPERLINK("${v.link}","Open email")` : ""]) },
      { range: "Routing!L2", values: routingLinks },
    ],
    "USER_ENTERED",
  );
  // "Bring into": one dropdown per lead row; the id column stays hidden.
  const leadsId = sheetIdOf.get("Leads");
  if (leadsId !== undefined && leads.length)
    await batchUpdate(SHEET, [
      {
        setDataValidation: {
          range: { sheetId: leadsId, startRowIndex: 1, endRowIndex: 1 + leads.length, startColumnIndex: 12, endColumnIndex: 13 },
          rule: { condition: { type: "ONE_OF_LIST", values: [...books.keys()].map((a) => ({ userEnteredValue: a })) }, strict: true, showCustomUi: true },
        },
      },
      { setDataValidation: { range: { sheetId: leadsId, startRowIndex: 1 + leads.length, endRowIndex: 3000, startColumnIndex: 12, endColumnIndex: 13 } } },
      { updateDimensionProperties: { range: { sheetId: leadsId, dimension: "COLUMNS", startIndex: 13, endIndex: 14 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } },
      { updateDimensionProperties: { range: { sheetId: leadsId, dimension: "COLUMNS", startIndex: 12, endIndex: 13 }, properties: { pixelSize: 190 }, fields: "pixelSize" } },
      {
        repeatCell: {
          range: { sheetId: leadsId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: LEADS_HEADER.length },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.94, blue: 0.9 } } },
          fields: "userEnteredFormat(textFormat,backgroundColor)",
        },
      },
    ]);
  return result;
}
