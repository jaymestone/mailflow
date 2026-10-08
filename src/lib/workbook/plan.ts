/** Pure decisions for the booking spreadsheet: where a lead goes on an
 * artist's workbook, how dates and venue names compare, and what a Master
 * booking says. No I/O here, so every rule is testable. See tick.ts for the
 * pass that reads the sheet, applies these, and writes back. */

import type { Cell } from "./sheets";

export const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const norm = (s: unknown) =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");

/** One venue under two spellings: "Roxbury Arts Group" and "Roxbury Arts
 * Group (Fiddlers festival)" -- one name containing the other counts. */
export function sameVenue(a: unknown, b: unknown): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)));
}

/** "CPAC" for "Community Performing Arts Center": an all-caps short name
 * made of the other's initials. Only ever used together with a matching
 * city, never on its own. */
export function initialsMatch(a: string, b: string): boolean {
  if (sameVenue(a, b)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const letters = short.replace(/\s/g, "");
  if (!/^[A-Z&]{3,6}$/.test(letters)) return false;
  const initials = long.split(/[^A-Za-z]+/).filter((w) => w && !/^(the|of|and|at|for)$/i.test(w)).map((w) => w[0].toUpperCase()).join("");
  return initials.startsWith(letters.replace(/[^A-Z]/g, "").slice(0, 2));
}

/** Master's date text -> [startISO, endISO]: "Mar 17, 2027", "Aug 7-8, 2027",
 * "Sept 12, 2027", "July 30-Aug 2, 2027". Null when unreadable. */
export function parseMasterDate(text: string): [string, string] | null {
  const m = text.trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:\s*[-–]\s*(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}))?,?\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  const mo2 = m[3] ? MONTHS.indexOf(m[3].toLowerCase()) : mo;
  if (mo < 0 || mo2 < 0) return null;
  const iso = (mi: number, d: string) => `${m[5]}-${String(mi + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
  return [iso(mo, m[2]), iso(mo2, m[4] ?? m[2])];
}

export function eachDay(start: string, end: string | null): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse((end ?? start) + "T00:00:00Z") && out.length < 21; t += 864e5)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Sheets date serial (days since 1899-12-30) <-> ISO date. */
export const serialToIso = (n: number) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5).toISOString().slice(0, 10);

export const fmtDay = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export const fmtRange = (d: { start: string; end: string | null }) =>
  d.end && d.end !== d.start ? `${fmtDay(d.start)} – ${fmtDay(d.end)}, ${d.start.slice(0, 4)}` : `${fmtDay(d.start)}, ${d.start.slice(0, 4)}`;
export const money = (n: number | null | undefined) => (n == null ? "" : `$${n.toLocaleString("en-US")}`);

export const STATUS_FOR_KIND: Record<string, string> = { confirmed: "Confirmed", hold: "Hold", offered: "Inquiry", asked_about: "Inquiry" };

export type Booking = { status: string; artist: string; dateText: string; range: [string, string] | null; venue: string; city: string; state: string };

export function readBookings(masterRows: Cell[][]): Booking[] {
  return masterRows
    .filter((r) => r[0] && !/cancel/i.test(String(r[0])) && r[1] && r[3])
    .map((r) => {
      const [city = "", state = ""] = String(r[6] ?? "").split(",").map((x) => x.trim());
      return { status: String(r[0]), artist: String(r[1]).trim(), dateText: String(r[2] ?? ""), range: parseMasterDate(String(r[2] ?? "")), venue: String(r[3]).trim(), city, state };
    });
}

/** An artist's workbook tab, as the plan sees it: its rows, and where each
 * day of the year lives (found by the date in column A, so a row Jayme
 * inserts never shifts a lead onto the wrong day). Mutated as leads are
 * placed, so two leads in one pass never share a row. */
export type Workbook = { tab: string; grid: Cell[][]; rowOfIso: Map<string, number> };

export function toWorkbook(tab: string, grid: Cell[][]): Workbook {
  // Only the calendar above the "no date yet" section: a lead's timing down
  // there can itself be a date ("Sun, Oct 10, 2027", or a past year), and
  // read as a day row it turned into a phantom Routing stop.
  const rowOfIso = new Map<string, number>();
  for (let i = 1; i < grid.length; i++) {
    const a = grid[i]?.[0];
    if (typeof a === "string" && /INTERESTED VENUES|^Target Window$/i.test(a.trim())) break;
    if (typeof a === "number") rowOfIso.set(serialToIso(a), i + 1);
  }
  return { tab, grid, rowOfIso };
}

const cell = (wb: Workbook, row: number, col: number) => String(wb.grid[row - 1]?.[col] ?? "").trim();

/** The first row of the "no date yet" section that is free. */
function nextBottomRow(wb: Workbook): number {
  const header = wb.grid.findIndex((r) => /^Target Window$/i.test(String(r[0] ?? "").trim()));
  let row = header >= 0 ? header + 2 : Math.max(...[...wb.rowOfIso.values(), 1]) + 4;
  while (wb.grid[row - 1]?.some((v) => String(v ?? "").trim())) row++;
  return row;
}

function setRow(wb: Workbook, row: number, fromCol: number, values: Cell[]) {
  while (wb.grid.length < row) wb.grid.push([]);
  const r = wb.grid[row - 1];
  values.forEach((v, i) => (r[fromCol + i] = v));
}

export type Lead = {
  venue: string;
  city: string;
  state: string;
  fee: number | null;
  artists: string[];
  dates: { start: string; end: string | null; kind: string; artist?: string | null }[];
  window: string | null;
  interest: string;
  routingArea: string | null;
  note: string;
  nextStep: string | null;
};

export type Placement =
  | { artist: string; tab: string; row: number; venue: string; note: string; kind: "dated" | "undated" }
  | { artist: string; kind: "exists" | "booked"; venue: string };

export type Write = { range: string; values: Cell[][] };

/** Where one lead goes on one artist's workbook, the first time.
 *
 * - A venue already on the sheet under any spelling stays Jayme's entry.
 * - A venue with an upcoming booking in Master is a stale thread (CPAC's
 *   "holding pattern" email after the show was confirmed), unless the
 *   reply plainly looks past that booking.
 * - Dates go on their day rows only if every day is free; otherwise the
 *   whole lead goes to "no date yet" with a note saying which days clash.
 */
export function placeLead(opts: { artist: string; wb: Workbook; lead: Lead; bookings: Booking[]; today: string }): { placement: Placement; writes: Write[] } {
  const { artist, wb, lead, bookings, today } = opts;
  const present = wb.grid.find((r, i) => i > 0 && sameVenue(r[2], lead.venue));
  if (present) return { placement: { artist, kind: "exists", venue: lead.venue }, writes: [] };

  const booked = bookings.find(
    (b) =>
      b.artist === artist &&
      (sameVenue(b.venue, lead.venue) || (lead.city && norm(b.city) === norm(lead.city) && norm(b.state) === norm(lead.state) && initialsMatch(b.venue, lead.venue))),
  );
  if (booked && booked.range && booked.range[1] >= today && !lead.window && lead.interest !== "talk_later")
    return { placement: { artist, kind: "booked", venue: lead.venue }, writes: [] };
  const bookedNote = booked ? `Booked: ${booked.venue} ${booked.dateText} (Master). ` : "";

  // A fee on a thread about two artists is the thread's total, not this one's.
  const fee = lead.artists.length > 1 ? "" : money(lead.fee);
  const note = `${bookedNote}${lead.note}${lead.nextStep ? ` Next: ${lead.nextStep}` : ""}`;
  const mine = lead.dates.filter((d) => !d.artist || d.artist === artist);
  const taken: string[] = [];
  const writes: Write[] = [];
  let firstRow = 0;
  for (const d of mine) {
    const days = eachDay(d.start, d.end).filter((iso) => wb.rowOfIso.has(iso));
    if (!days.length) continue;
    const busy = days.filter((iso) => cell(wb, wb.rowOfIso.get(iso)!, 2));
    if (busy.length) {
      taken.push(...busy.map((iso) => `${fmtDay(iso)} (${cell(wb, wb.rowOfIso.get(iso)!, 2)})`));
      continue;
    }
    days.forEach((iso, i) => {
      const row = wb.rowOfIso.get(iso)!;
      const values: Cell[] = [STATUS_FOR_KIND[d.kind] ?? "Inquiry", lead.venue, lead.city, lead.state, i === 0 && !firstRow ? fee : "", i === 0 && !firstRow ? note : ""];
      setRow(wb, row, 1, values);
      writes.push({ range: `'${wb.tab}'!B${row}:G${row}`, values: [values] });
      if (!firstRow) firstRow = row;
    });
  }
  if (firstRow) return { placement: { artist, tab: wb.tab, row: firstRow, venue: lead.venue, note, kind: "dated" }, writes };

  const when = [...mine.map(fmtRange), lead.window ?? "", lead.interest === "if_routing" ? `If routing near ${lead.routingArea ?? lead.city}` : ""]
    .filter(Boolean)
    .join(" · ");
  const fullNote = taken.length ? `${note.replace(/ Next: .*$/, "")} Asked for ${taken.join(", ")} -- already taken.${lead.nextStep ? ` Next: ${lead.nextStep}` : ""}` : note;
  const row = nextBottomRow(wb);
  // Inquiry, not Prospective: the venue has expressed interest. Prospective
  // is Jayme's own word for a possibility he spotted, with no interest
  // expressed yet (his definitions, 2026-10-08), so this never writes it.
  const values: Cell[] = [when || "No date yet", "Inquiry", lead.venue, lead.city, lead.state, fee, fullNote];
  setRow(wb, row, 0, values);
  return {
    placement: { artist, tab: wb.tab, row, venue: lead.venue, note: fullNote, kind: "undated" },
    writes: [{ range: `'${wb.tab}'!A${row}:G${row}`, values: [values] }],
  };
}

/** Refreshes the note on a row this pipeline wrote earlier -- but only while
 * the row still holds that venue and the note is exactly what was written.
 * Anything Jayme changed, moved or deleted is his, and stays. */
export function refreshNote(wb: Workbook, p: Extract<Placement, { row: number }>, newNote: string): Write | null {
  if (newNote === p.note) return null;
  const row = wb.grid[p.row - 1] ?? [];
  if (!sameVenue(row[2], p.venue) || String(row[6] ?? "") !== p.note) return null;
  row[6] = newNote;
  return { range: `'${wb.tab}'!G${p.row}`, values: [[newNote]] };
}
