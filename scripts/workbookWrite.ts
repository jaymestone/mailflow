// Writes the one-time extraction (scripts/workbookExtract.ts) into the
// [MASTER] Tour Dates spreadsheet:
//
//   - each artist's "<Artist> 2027 Workbook": dated leads onto that day's
//     row, undated ones into the "Interested venues -- no date yet" section.
//     Only EMPTY rows are ever written; anything Jayme typed stays put.
//   - "Leads": every live conversation with no artist named.
//   - "Routing": for each date on an artist's calendar, the interested
//     venues within ~150 miles and the open days around it.
//
// Dry run by default (prints what it would write). --apply writes.
//
//   npx tsx --env-file=.env.local scripts/workbookWrite.ts [--apply]

import { createRequire } from "module";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import type { Extract } from "./workbookExtract";

const APPLY = process.argv.includes("--apply");
const MASTER = "1xcDRCQt0jsh2zq9UCO2ujltM8kVaFZ5rBJFQ3oty7Sc";
const RADIUS_MILES = 150;
const MAX_PER_ANCHOR = 12;

// Google access is Contract Engine's (jayme@jaymestone.com, full Drive +
// Sheets), the same credentials that already append to this spreadsheet.
const CE = "/Users/jaymestone/Projects/contract-engine";
const req = createRequire(CE + "/package.json");
const { OAuth2Client } = req("google-auth-library");
const { sheets: sheetsApi } = req("@googleapis/sheets");
const client = JSON.parse(readFileSync(CE + "/secrets/google-oauth-client.json", "utf8"));
const k = client.installed ?? client.web;
const auth = new OAuth2Client(k.client_id, k.client_secret, (k.redirect_uris ?? [])[0]);
auth.setCredentials(JSON.parse(readFileSync(CE + "/secrets/google-oauth-tokens.json", "utf8")));
const sheets = sheetsApi({ version: "v4", auth });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WORKBOOK: Record<string, string> = {
  "The Little Mercies": "Little Mercies 2027 Workbook",
  Rakish: "Rakish 2027 Workbook",
  "Amanda Pascali": "Amanda Pascali 2027 Workbook",
  "Sam Reider": "Sam Reider 2027 Workbook",
  "Jorge Glem & Sam Reider": "Jorge Glem & Sam Reider 2027 Workbook",
  "Lily Henley": "Lily Henley 2027 Workbook",
  "Samir Langus": "Samir Langus 2027 Workbook",
  "Charlie & The Tropicales": "Charlie & The Tropicales 2027 Workbook",
  "Summer Camargo": "Summer Camargo 2027 Workbook",
};
const STATUS: Record<string, string> = { confirmed: "Confirmed", hold: "Hold", offered: "Inquiry", asked_about: "Inquiry" };
const INTEREST_LABEL: Record<string, string> = {
  specific_date: "Date on the table",
  artist_no_date: "Interested, no date",
  if_routing: "If routing nearby",
  general_roster: "General roster interest",
  talk_later: "Talk later",
};

type Conv = {
  id: string;
  thread_key: string;
  venue: string | null;
  region: string | null;
  fee_amount: number | null;
  last_message_at: string | null;
  contact_id: string | null;
  gmail_thread_ids: string[];
};
type Contact = { id: string; first_name: string | null; last_name: string | null; email: string; venue: string | null; city: string | null; state: string | null; lat: number | null; lng: number | null };

const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
/** Same venue under two spellings: "Roxbury Arts Group" and "Roxbury Arts
 * Group (Fiddlers festival)". One name containing the other counts. */
const sameVenue = (a: string | null | undefined, b: string | null | undefined) => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)));
};
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|mac|comcast|verizon|att|live|msn|protonmail|ymail)\./i;
/** "CPAC" for "Community Performance Center" / "Community Performing Arts
 * Center": an all-caps short name whose letters are the other's initials. */
const initialsMatch = (short: string, long: string) => {
  const [a, b] = short.length <= long.length ? [short, long] : [long, short];
  if (!/^[A-Z&]{2,6}$/.test(a.replace(/\s/g, ""))) return sameVenue(a, b);
  const initials = b.split(/[^A-Za-z]+/).filter((w) => w && !/^(the|of|and|at|for)$/i.test(w)).map((w) => w[0].toUpperCase()).join("");
  const letters = a.replace(/[^A-Z]/g, "");
  return initials.startsWith(letters.slice(0, 2)) && letters.length >= 3;
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Master's date text: "Mar 17, 2027", "Aug 7-8, 2027", "Mar 31-Apr 2, 2027". */
function parseMasterDate(t: string): [string, string] | null {
  const m = t.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}))?,?\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  const mo2 = m[3] ? MONTHS.indexOf(m[3].toLowerCase()) : mo;
  if (mo < 0 || mo2 < 0) return null;
  const iso = (y: string, mi: number, d: string) => `${y}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
  return [iso(m[5], mo, m[2]), iso(m[5], mo2, m[4] ?? m[2])];
}
const money = (n: number | null) => (n == null ? "" : `$${n.toLocaleString("en-US")}`);
const miles = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
};
/** Row of a date in a 2027 workbook: row 2 is Jan 1, one row per day. */
const rowOf = (iso: string) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(2027, 0, 1)) / 864e5) + 2;
const isoOfRow = (row: number) => new Date(Date.UTC(2027, 0, 1) + (row - 2) * 864e5).toISOString().slice(0, 10);
const days = (start: string, end: string | null) => {
  const out: string[] = [];
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse((end ?? start) + "T00:00:00Z") && out.length < 14; t += 864e5)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const fmtDay = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const fmtRange = (d: { start: string; end: string | null }) => (d.end && d.end !== d.start ? `${fmtDay(d.start)} – ${fmtDay(d.end)}, ${d.start.slice(0, 4)}` : `${fmtDay(d.start)}, ${d.start.slice(0, 4)}`);

async function readAll<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase.from(table).select(cols).range(off, off + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) return out;
  }
}

async function main() {
  const extracts: Record<string, Extract> = JSON.parse(readFileSync("scripts/.workbook-extract.json", "utf8"));
  const convs = (await readAll<Conv>("conversations", "id, thread_key, venue, region, fee_amount, last_message_at, contact_id, gmail_thread_ids, is_live")).filter(
    (c) => (c as unknown as { is_live: boolean }).is_live && extracts[c.id],
  );
  const contacts = await readAll<Contact>("contacts", "id, first_name, last_name, email, venue, city, state, lat, lng");
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  // A place with no coordinates of its own borrows any geocoded contact in
  // the same city -- enough for a 150-mile radius.
  const cityCoord = new Map<string, { lat: number; lng: number }>();
  for (const c of contacts) if (c.lat != null && c.city) cityCoord.set(`${norm(c.city)}|${norm(c.state)}`, { lat: c.lat, lng: c.lng! });
  const coordOf = (city: string | null, state: string | null, contact?: Contact) =>
    contact?.lat != null ? { lat: contact.lat, lng: contact.lng! } : city ? cityCoord.get(`${norm(city)}|${norm(state)}`) : undefined;

  // Gmail link: the mailbox the venue wrote to, opened on that thread.
  const { data: accts } = await supabase.from("connected_accounts").select("id, email_address");
  const acctEmail = new Map((accts ?? []).map((a) => [a.id, a.email_address]));
  const firstThreadIds = convs.map((c) => c.gmail_thread_ids[0]).filter(Boolean);
  const threadAcct = new Map<string, string>();
  for (let i = 0; i < firstThreadIds.length; i += 200) {
    const { data } = await supabase.from("inbound_messages").select("gmail_thread_id, connected_account_id").in("gmail_thread_id", firstThreadIds.slice(i, i + 200));
    for (const m of data ?? []) threadAcct.set(m.gmail_thread_id, acctEmail.get(m.connected_account_id) ?? "");
  }

  const leads = convs.map((c) => {
    const x = extracts[c.id];
    const ct = c.contact_id ? contactById.get(c.contact_id) : undefined;
    const email = c.thread_key.split("::")[0];
    const t = c.gmail_thread_ids[0];
    const acct = threadAcct.get(t);
    return {
      c,
      x,
      venue: c.venue || ct?.venue || (FREE_MAIL.test(email) ? email : email.split("@")[1]),
      city: ct?.city ?? "",
      state: ct?.state ?? "",
      contactName: [ct?.first_name, ct?.last_name].filter((s) => s && s !== "Folks").join(" "),
      email,
      coord: coordOf(ct?.city ?? null, ct?.state ?? null, ct),
      link: acct ? `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(acct)}#all/${t}` : "",
    };
  });
  // Rows keyed to one of Jayme's own addresses are duplicates the old board
  // keying left behind (listed for him to delete), not venues.
  const live = leads.filter((l) => l.x.interest !== "declined" && !/@(jaymestone\.com|jaymestoneagency\.com)$/i.test(l.email));
  console.log(`${convs.length} conversations extracted; ${convs.length - live.length} declined (left out); ${live.length} live`);

  // ---- Artist workbooks ----------------------------------------------------
  const wbRead = await sheets.spreadsheets.values.batchGet({ spreadsheetId: MASTER, ranges: Object.values(WORKBOOK).map((t) => `'${t}'!A1:J1000`) });
  const wb = new Map<string, string[][]>(Object.values(WORKBOOK).map((t, i) => [t, (wbRead.data.valueRanges[i].values ?? []) as string[][]]));
  // Master: every booking Jayme has recorded, by artist. A lead for a venue
  // already booked is either stale (an older "holding pattern" thread for a
  // show that has since been confirmed -- CPAC in Green Valley) or a genuine
  // return booking. Upcoming bookings skip the lead unless the reply looks
  // past it (a later window, or "talk later"); past ones are kept and noted.
  const masterRows = ((await sheets.spreadsheets.values.get({ spreadsheetId: MASTER, range: "Master!A2:G1500" })).data.values ?? []) as string[][];
  const bookings = masterRows
    .filter((r) => r[0] && !/cancel/i.test(r[0]))
    .map((r) => {
      const [city = "", state = ""] = (r[6] ?? "").split(",").map((x) => x.trim());
      return { status: r[0], artist: r[1], dateText: r[2] ?? "", range: parseMasterDate(r[2] ?? ""), venue: r[3] ?? "", city, state };
    });
  const today = new Date().toISOString().slice(0, 10);
  const bookedFor = (artist: string, l: { venue: string; city: string; state: string }) =>
    bookings.find(
      (b) => b.artist === artist && (sameVenue(b.venue, l.venue) || (l.city && norm(b.city) === norm(l.city) && norm(b.state) === norm(l.state) && initialsMatch(b.venue, l.venue))),
    );

  const writes: { range: string; values: string[][] }[] = [];
  const summary: Record<string, { dated: number; undated: number; skipped: number }> = {};
  // Rows taken by an earlier lead in this same run, so two leads never share a date row.
  const claimed = new Map<string, string>();

  for (const [artist, tab] of Object.entries(WORKBOOK)) {
    const grid = wb.get(tab)!;
    const cell = (row: number, col: number) => (grid[row - 1]?.[col] ?? "").trim();
    const venuesPresent: string[] = grid.map((r) => r[2]).filter(Boolean);
    let nextBottom = Math.max(370, grid.length + 1);
    const s = (summary[artist] = { dated: 0, undated: 0, skipped: 0 });
    for (const l of live.filter((l) => l.x.artists.includes(artist))) {
      // Already on this artist's sheet under the same name: Jayme's entry wins.
      if (venuesPresent.some((v) => sameVenue(v, l.venue))) {
        if (process.env.SHOW_SKIPS) console.log(`  skip ${artist}: "${l.venue}" ~ "${venuesPresent.find((v) => sameVenue(v, l.venue))}"`);
        s.skipped++;
        continue;
      }
      const booked = bookedFor(artist, l);
      if (booked && booked.range && booked.range[1] >= today && !l.x.target_window && l.x.interest !== "talk_later") {
        if (process.env.SHOW_SKIPS) console.log(`  skip ${artist}: "${l.venue}" already booked ${booked.dateText}`);
        s.skipped++;
        continue;
      }
      const bookedNote = booked ? `Booked: ${booked.venue} ${booked.dateText} (Master). ` : "";
      venuesPresent.push(l.venue);
      // A fee on a thread about two artists is the thread's total, not this
      // artist's -- the note carries the split.
      const fee = l.x.artists.length > 1 ? "" : money(l.c.fee_amount);
      // A date tied to another artist in the same thread is theirs, not this one's.
      const mine = l.x.dates.filter((d) => !d.artist || d.artist === artist);
      const in2027 = mine.filter((d) => d.start.startsWith("2027"));
      const taken: string[] = [];
      let placed = false;
      for (const d of in2027) {
        const ds = days(d.start, d.end).filter((iso) => iso.startsWith("2027"));
        const busy = ds.filter((iso) => cell(rowOf(iso), 2) || claimed.has(`${tab}!${rowOf(iso)}`));
        // Any day already spoken for sends the whole run to "no date yet":
        // a festival half on its dates and half below reads as two leads.
        if (busy.length) {
          taken.push(...busy.map((iso) => `${fmtDay(iso)} (${cell(rowOf(iso), 2) || claimed.get(`${tab}!${rowOf(iso)}`)})`));
          continue;
        }
        const free = ds;
        free.forEach((iso) => claimed.set(`${tab}!${rowOf(iso)}`, l.venue));
        free.forEach((iso, i) =>
          writes.push({
            range: `'${tab}'!B${rowOf(iso)}:G${rowOf(iso)}`,
            values: [[STATUS[d.kind] ?? "Inquiry", l.venue, l.city, l.state, i === 0 ? fee : "", i === 0 ? `${bookedNote}${l.x.note} Next: ${l.x.next_step}` : ""]],
          }),
        );
        if (free.length) placed = true;
      }
      if (placed) {
        s.dated++;
        continue;
      }
      // No 2027 date, or its date is already taken: the bottom section.
      const window = [
        ...mine.map(fmtRange),
        l.x.target_window ?? "",
        l.x.interest === "if_routing" ? `If routing near ${l.x.routing_area ?? l.city}` : "",
      ].filter(Boolean).join(" · ");
      const clash = taken.length ? ` Asked for ${taken.join(", ")} -- already taken.` : "";
      writes.push({
        range: `'${tab}'!A${nextBottom}:G${nextBottom}`,
        values: [[window || "No date yet", "Inquiry", l.venue, l.city, l.state, fee, `${bookedNote}${l.x.note}${clash} Next: ${l.x.next_step}`]],
      });
      nextBottom++;
      s.undated++;
    }
  }

  // ---- Leads -----------------------------------------------------------------
  const order = ["if_routing", "specific_date", "artist_no_date", "talk_later", "general_roster"];
  const leadRows = live
    .filter((l) => !l.x.artists.length)
    .sort((a, b) => (a.c.region ?? "zz").localeCompare(b.c.region ?? "zz") || a.state.localeCompare(b.state) || a.city.localeCompare(b.city) || order.indexOf(a.x.interest) - order.indexOf(b.x.interest))
    .map((l) => [
      l.c.region ?? "",
      l.city,
      l.state,
      l.venue,
      INTEREST_LABEL[l.x.interest] ?? l.x.interest,
      [l.x.routing_area ? `Near ${l.x.routing_area}` : "", ...l.x.dates.map(fmtRange), l.x.target_window ?? ""].filter(Boolean).join(" · "),
      money(l.c.fee_amount),
      [l.contactName, l.email].filter(Boolean).join(" · "),
      l.x.note,
      l.x.next_step,
      (l.c.last_message_at ?? "").slice(0, 10),
      l.link ? `=HYPERLINK("${l.link}","Open email")` : "",
    ]);
  const leadsHeader = ["Region", "City", "State", "Venue", "Interest", "Timing", "Fee", "Contact", "Where it stands", "Next step", "Last contact", "Email"];

  // ---- Routing ---------------------------------------------------------------
  // Each artist's 2027 calendar, from three places: the workbook's date rows
  // (including this run's writes), Master's recorded bookings, and shows the
  // artist marked "Booked (own show)" on their page. Consecutive days at one
  // place are one stop. Days the artist marked Unavailable are never offered
  // as open days.
  const pending = new Map<string, string[]>(); // "tab!row" -> values B..G
  for (const w of writes) {
    const m = w.range.match(/^'(.+)'!B(\d+):G\d+$/);
    if (m) pending.set(`${m[1]}!${m[2]}`, w.values[0]);
  }
  type Day = { venue: string; status: string; city: string; state: string };
  const routingRows: string[][] = [];
  let anchors = 0;
  for (const [artist, tab] of Object.entries(WORKBOOK)) {
    const grid = wb.get(tab)!;
    const cal = new Map<number, Day>();
    const unavailable = new Set<number>();
    for (let row = 2; row <= 366; row++) {
      const [status = "", venue = "", city = "", state = ""] = (pending.get(`${tab}!${row}`) ?? (grid[row - 1] ?? []).slice(1, 5)).map((v) => (v ?? "").trim());
      if (venue) cal.set(row, { venue, status: status || "—", city, state });
      const avail = (grid[row - 1]?.[7] ?? "").trim();
      const where = (grid[row - 1]?.[8] ?? "").trim();
      if (avail === "Unavailable") unavailable.add(row);
      if (/^booked/i.test(avail) && !cal.has(row)) {
        const [c = "", st = ""] = where.split(",").map((x) => x.trim());
        cal.set(row, { venue: "Artist's own show", status: "Booked by artist", city: c, state: st });
      }
    }
    for (const b of bookings.filter((b) => b.artist === artist && b.range && b.range[0].startsWith("2027")))
      for (const iso of days(b.range![0], b.range![1])) if (iso.startsWith("2027") && !cal.has(rowOf(iso))) cal.set(rowOf(iso), { venue: b.venue, status: `${b.status} (Master)`, city: b.city, state: b.state });

    for (let row = 2; row <= 366; row++) {
      const day = cal.get(row);
      if (!day || (cal.get(row - 1) && sameVenue(cal.get(row - 1)!.venue, day.venue))) continue;
      let last = row;
      while (last < 366 && cal.get(last + 1) && sameVenue(cal.get(last + 1)!.venue, day.venue)) last++;
      const fromLead = live.find((l) => sameVenue(l.venue, day.venue));
      // The row's own city first: a fuzzy name match can land on the
      // venue's agent elsewhere (Old Settlers in Austin matched Tico Time,
      // whose contact is in Colorado).
      const where = coordOf(day.city, day.state) ?? (day.city ? undefined : fromLead?.coord);
      if (!where) continue;
      anchors++;
      const open: string[] = [];
      for (let r = Math.max(2, row - 3); r <= Math.min(366, last + 3); r++) if ((r < row || r > last) && !cal.has(r) && !unavailable.has(r)) open.push(fmtDay(isoOfRow(r)));
      const near = live
        .filter((l) => l.coord && !sameVenue(l.venue, day.venue) && (l.x.artists.length === 0 || l.x.artists.includes(artist)))
        .map((l) => ({ l, d: miles(where, l.coord!) }))
        .filter((n) => n.d <= RADIUS_MILES)
        .sort((a, b) => Number(b.l.x.interest === "if_routing") - Number(a.l.x.interest === "if_routing") || Number(b.l.x.artists.includes(artist)) - Number(a.l.x.artists.includes(artist)) || a.d - b.d)
        .slice(0, MAX_PER_ANCHOR);
      const when = row === last ? fmtDay(isoOfRow(row)) : `${fmtDay(isoOfRow(row))} – ${fmtDay(isoOfRow(last))}`;
      for (const n of near)
        routingRows.push([
          artist,
          when,
          `${day.venue} (${day.status})`,
          [day.city, day.state].filter(Boolean).join(", "),
          open.join(", "),
          n.l.venue,
          [n.l.city, n.l.state].filter(Boolean).join(", "),
          String(Math.round(n.d)),
          INTEREST_LABEL[n.l.x.interest] ?? n.l.x.interest,
          [n.l.contactName, n.l.email].filter(Boolean).join(" · "),
          n.l.x.note,
          n.l.link ? `=HYPERLINK("${n.l.link}","Open email")` : "",
        ]);
    }
  }
  const routingHeader = ["Artist", "Date", "Booked / pending", "Where", "Open days nearby", "Interested venue nearby", "City", "Miles", "Interest", "Contact", "Where it stands", "Email"];

  // ---- Report ----------------------------------------------------------------
  console.log("\nArtist workbooks (empty rows only):");
  for (const [a, s] of Object.entries(summary)) console.log(`  ${a.padEnd(26)} ${s.dated} on a date row, ${s.undated} in "no date yet", ${s.skipped} already on the sheet`);
  console.log(`  ${writes.length} row writes in total`);
  console.log(`Leads tab: ${leadRows.length} venues with no artist named`);
  console.log(`  by interest: ${JSON.stringify(leadRows.reduce((m, r) => ((m[r[4]] = (m[r[4]] ?? 0) + 1), m), {} as Record<string, number>))}`);
  console.log(`Routing tab: ${anchors} calendar dates with a location, ${routingRows.length} nearby-venue rows`);
  for (const r of routingRows.slice(0, 8)) console.log(`  ${r[0]} | ${r[1]} | ${r[2]} | ${r[5]} (${r[6]}, ${r[7]} mi, ${r[8]})`);
  console.log("\nSample workbook writes:");
  for (const w of writes.slice(0, 10)) console.log(`  ${w.range}  ${w.values[0].slice(0, 4).join(" | ")}`);

  if (!APPLY) {
    console.log("\nDry run: nothing written. Re-run with --apply.");
    return;
  }

  // ---- Write -----------------------------------------------------------------
  const meta = await sheets.spreadsheets.get({ spreadsheetId: MASTER, fields: "sheets.properties(title,sheetId,index)" });
  const ids = new Map<string, number>(meta.data.sheets.map((s: { properties: { title: string; sheetId: number } }) => [s.properties.title, s.properties.sheetId]));
  const add = ["Leads", "Routing"].filter((t) => !ids.has(t)).map((title, i) => ({ addSheet: { properties: { title, index: 1 + i } } }));
  if (add.length) {
    const r = await sheets.spreadsheets.batchUpdate({ spreadsheetId: MASTER, requestBody: { requests: add } });
    for (const rep of r.data.replies) ids.set(rep.addSheet.properties.title, rep.addSheet.properties.sheetId);
  }
  await sheets.spreadsheets.values.batchClear({ spreadsheetId: MASTER, requestBody: { ranges: ["Leads!A:Z", "Routing!A:Z"] } });
  writeFileSync("scripts/.workbook-writes.json", JSON.stringify(writes.map((w) => w.range), null, 1));
  for (let i = 0; i < writes.length; i += 400)
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: MASTER, requestBody: { valueInputOption: "USER_ENTERED", data: writes.slice(i, i + 400) } });
  // RAW, not USER_ENTERED: Sheets otherwise reads a label like "Fri, May 21"
  // as a date in the CURRENT year and redraws its weekday for that year
  // (it showed Cottonwood's Fri May 21, 2027 as "Thu, May 21"). Only the
  // email-link column is a formula, so it goes in separately.
  const text = (rows: string[][]) => rows.map((r) => r.slice(0, -1));
  const links = (rows: string[][]) => rows.map((r) => [r[r.length - 1]]);
  const col = (n: number) => String.fromCharCode(64 + n);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: MASTER,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: "Leads!A1", values: [leadsHeader, ...text(leadRows)] },
        { range: "Routing!A1", values: [routingHeader, ...text(routingRows)] },
      ],
    },
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: MASTER,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `Leads!${col(leadsHeader.length)}2`, values: links(leadRows) },
        { range: `Routing!${col(routingHeader.length)}2`, values: links(routingRows) },
      ],
    },
  });
  const fmt = (tab: string, widths: number[]) => {
    const sheetId = ids.get(tab)!;
    return [
      { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" } },
      { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.94, blue: 0.9 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
      { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: widths.length } } } },
      ...widths.map((w, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: "pixelSize" } })),
    ];
  };
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: MASTER,
    requestBody: {
      requests: [
        ...fmt("Leads", [110, 120, 55, 220, 160, 200, 70, 230, 420, 260, 95, 90]),
        ...fmt("Routing", [170, 150, 230, 130, 220, 220, 130, 55, 150, 230, 400, 90]),
      ],
    },
  });
  console.log("\nWritten.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
