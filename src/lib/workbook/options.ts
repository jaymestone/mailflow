import { eachDay, sameVenue, type Booking, type Workbook } from "./plan";
import type { Cell } from "./sheets";

/** The Date Options tab (Jayme, Nov 14 2026): "Need to be able to see what
 * our inquiries are and what our options are" when several venues want the
 * same days. A workbook day row holds one venue; this lists every venue in
 * play for every date, one row each, grouped by artist and date. Rebuilt in
 * full each pass, like Leads and Routing. */

export type OptionItem = {
  venue: string;
  city: string;
  state: string;
  fee: number | null;
  kind: string; // confirmed | hold | offered | asked_about | declined
  start: string;
  end: string | null;
  note: string;
  next: string;
  last: string; // YYYY-MM-DD of last message
  link: string;
  off: false | "passed" | "not now";
};

export type OptionRow = { iso: string; status: string; venue: string; where: string; fee: string; note: string; next: string; last: string; link: string; rank: number; off: boolean };

const LABEL: Record<string, [string, number]> = {
  booked: ["Booked (own show)", 0],
  confirmed: ["Confirmed", 1],
  hold: ["Hold", 2],
  offered: ["Offer / open for them", 3],
  asked_about: ["Asked", 4],
  passed: ["Passed", 8],
  "not now": ["Not now", 9],
};
/** A season ("April 2027") isn't a date; an asked range is usually the
 * pitch's own window. Same limits as the On the table column. */
const maxDays = (kind: string) => (kind === "asked_about" || kind === "declined" ? 4 : 15);

export function dateOptions(opts: { artist: string; wb: Workbook; items: OptionItem[]; bookings: Booking[]; today: string }): OptionRow[] {
  const { artist, wb, items, bookings, today } = opts;
  const rows: OptionRow[] = [];
  const add = (r: Omit<OptionRow, "rank" | "off" | "status"> & { key: string }) => {
    const [status, rank] = LABEL[r.key] ?? [r.key, 5];
    const same = rows.find((x) => x.iso === r.iso && sameVenue(x.venue, r.venue));
    if (same) {
      // One venue, one row per date: keep the firmest status and fill gaps.
      if (rank < same.rank) Object.assign(same, { status, rank, off: rank >= 8 });
      for (const k of ["where", "fee", "note", "next", "last", "link"] as const) if (!same[k] && r[k]) same[k] = r[k];
      return;
    }
    rows.push({ iso: r.iso, status, venue: r.venue, where: r.where, fee: r.fee, note: r.note, next: r.next, last: r.last, link: r.link, rank, off: rank >= 8 });
  };
  // The calendar itself: column C entries and the artist's own shows.
  for (const [iso, row] of wb.rowOfIso) {
    if (iso < today) continue;
    const r = wb.grid[row - 1] ?? [];
    const venue = String(r[2] ?? "").trim();
    if (venue && !/^(fill( in)?|open|tbd|\?+)$/i.test(venue)) {
      const st = String(r[1] ?? "").trim().toLowerCase();
      add({ key: st === "confirmed" ? "confirmed" : st === "hold" ? "hold" : "asked_about", iso, venue, where: [r[3], r[4]].filter(Boolean).join(", "), fee: String(r[5] ?? ""), note: String(r[6] ?? ""), next: "", last: "", link: "" });
    }
    if (/^booked/i.test(String(r[7] ?? ""))) add({ key: "booked", iso, venue: String(r[9] ?? "").trim() || "Own show", where: String(r[8] ?? ""), fee: "", note: "", next: "", last: "", link: "" });
  }
  for (const b of bookings) {
    if (b.artist !== artist || !b.range) continue;
    for (const iso of eachDay(b.range[0], b.range[1])) if (iso >= today && wb.rowOfIso.has(iso)) add({ key: /confirm/i.test(b.status) ? "confirmed" : "hold", iso, venue: b.venue, where: [b.city, b.state].filter(Boolean).join(", "), fee: "", note: `Master: ${b.status}`, next: "", last: "", link: "" });
  }
  for (const it of items) {
    const days = eachDay(it.start, it.end);
    if (days.length > maxDays(it.kind)) continue;
    const key = it.kind === "declined" ? "passed" : it.off || it.kind;
    for (const iso of days) {
      if (iso < today || !wb.rowOfIso.has(iso)) continue;
      add({ key, iso, venue: it.venue, where: [it.city, it.state].filter(Boolean).join(", "), fee: it.fee == null ? "" : `$${it.fee}`, note: it.note, next: it.next, last: it.last, link: it.link });
    }
  }
  return rows.sort((a, b) => a.iso.localeCompare(b.iso) || a.rank - b.rank || a.venue.localeCompare(b.venue));
}

export const OPTIONS_HEADER = ["Date", "Status", "Venue", "Where", "Fee", "Where it stands", "Next step", "Last contact", "Email"];

const dayLabel = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Rows for the tab: an artist bar, then for each date a date line ("Thu,
 * Sep 30, 2027 · 3 in play") and its venues. Only dates with at least one
 * live option (not just passes) are shown, so the tab stays about choices. */
export function optionsBlock(artist: string, rows: OptionRow[]): { values: Cell[][]; kinds: ("artist" | "date" | "live" | "off")[] } {
  const values: Cell[][] = [];
  const kinds: ("artist" | "date" | "live" | "off")[] = [];
  const byDate = new Map<string, OptionRow[]>();
  for (const r of rows) byDate.set(r.iso, [...(byDate.get(r.iso) ?? []), r]);
  const dates = [...byDate].filter(([, rs]) => rs.some((r) => !r.off));
  if (!dates.length) return { values, kinds };
  values.push([artist.toUpperCase()]);
  kinds.push("artist");
  for (const [iso, rs] of dates) {
    const live = rs.filter((r) => !r.off).length;
    values.push([`${dayLabel(iso)}  ·  ${live} in play`]);
    kinds.push("date");
    for (const r of rs) {
      values.push(["", r.status, r.venue, r.where, r.fee, r.note.slice(0, 300), r.next.slice(0, 150), r.last, r.link]);
      kinds.push(r.off ? "off" : "live");
    }
  }
  values.push([]);
  kinds.push("off");
  return { values, kinds };
}
