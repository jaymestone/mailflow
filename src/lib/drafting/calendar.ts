// What the reply drafter must know before it proposes a date or asks for a
// fee (Jayme, Nov 19 2026: drafts offered Sierragrass Apr 23–25 and Blue Moon
// a "New Orleans" window when the artists were busy, and asked Tahlsound for
// an offer after the fee was already deep in negotiation — "reviewing drafts
// that I need to delete is a waste of my time").
//
// - Busy days come from each "<Artist> <year> Workbook" tab in [MASTER] Tour
//   Dates: own shows / Booked / Unavailable (column H) and Confirmed / Hold
//   rows (column B).
// - Deal state comes from the conversation's summary across every inbox
//   (gist, sheet_note, sheet_dates), not just the stone@ thread.
import { batchGet, getSheetTitles } from "@/lib/workbook/sheets";

export const WORKBOOK_ID = "1xcDRCQt0jsh2zq9UCO2ujltM8kVaFZ5rBJFQ3oty7Sc";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type BusyDay = { artist: string; date: string; what: string };
export type Calendars = Map<string, BusyDay[]>; // artist (lower case) → busy days

/** "Thu, Sep, 30" / "Thu, Sep 30" + year → "2027-09-30" (null if not a day row). */
export function dayOf(a: string, year: number): string | null {
  const m = String(a).match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+([A-Z][a-z]{2}),?\s+(\d{1,2})$/);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1]);
  if (mo < 0) return null;
  return `${year}-${String(mo + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** One workbook tab's rows (A..I) → the days the artist is not available. */
export function busyDays(artist: string, year: number, rows: unknown[][]): BusyDay[] {
  const out: BusyDay[] = [];
  for (const r of rows) {
    const date = dayOf(String(r[0] ?? ""), year);
    if (!date) continue;
    const [status, venue, city, state, , , avail, where] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => String(r[i] ?? "").trim());
    const place = [city, state].filter(Boolean).join(" ") || where;
    if (/booked|own show/i.test(avail)) out.push({ artist, date, what: `own show${place ? `, ${place}` : ""}` });
    else if (/unavailable|off/i.test(avail)) out.push({ artist, date, what: `unavailable${where ? ` (${where})` : ""}` });
    else if (/^(confirmed|hold)$/i.test(status)) out.push({ artist, date, what: `${status.toLowerCase()}${venue ? `: ${venue}` : ""}${place ? `, ${place}` : ""}` });
  }
  return out;
}

export async function loadCalendars(sheetId = WORKBOOK_ID): Promise<Calendars> {
  const tabs = (await getSheetTitles(sheetId)).map((t) => t.title).filter((t) => / \d{4} Workbook$/.test(t));
  const grids = await batchGet(sheetId, tabs.map((t) => `'${t.replace(/'/g, "''")}'!A1:I500`));
  const cal: Calendars = new Map();
  tabs.forEach((t, i) => {
    const m = t.match(/^(.*) (\d{4}) Workbook$/)!;
    const key = m[1].toLowerCase();
    cal.set(key, [...(cal.get(key) || []), ...busyDays(m[1], Number(m[2]), grids[i] || [])]);
  });
  return cal;
}

/** Busy days for every roster artist named in the thread (or the conversation's artist). */
export function calendarFor(cal: Calendars | null, text: string, today = new Date().toISOString().slice(0, 10)): string {
  if (!cal) return "";
  const hay = text.toLowerCase().replace(/\band\b/g, "&");
  const named = [...cal.keys()].filter((k) => hay.includes(k) || hay.includes(k.replace(/^the /, "")));
  if (!named.length) return "";
  const blocks = named.map((k) => {
    const days = (cal.get(k) || []).filter((d) => d.date >= today);
    const name = cal.get(k)?.[0]?.artist ?? k;
    return `${name}: ${days.length ? days.map((d) => `${d.date} ${d.what}`).join("; ") : "nothing booked yet"}`;
  });
  return `\n\nArtist calendars (from Jayme's workbook). These days are NOT available. Never propose, suggest or ask to hold any of them, and don't offer a window that includes one:\n${blocks.join("\n")}`;
}

type Deal = { gist?: string | null; sheet_note?: string | null; sheet_next_step?: string | null; sheet_dates?: { start: string; end: string | null; kind: string; artist: string | null }[] | null };

/** Where the deal stands across all of Jayme's inboxes (calls and jayme@ included). */
export function dealFor(c: Deal | null | undefined): string {
  if (!c) return "";
  const dates = (c.sheet_dates || []).map((d) => `${d.artist ?? "?"} ${d.start}${d.end ? `–${d.end}` : ""} (${d.kind})`).join("; ");
  const parts = [c.gist && `Summary: ${c.gist}`, c.sheet_note && `Money/terms so far: ${c.sheet_note}`, c.sheet_next_step && `Jayme's next step: ${c.sheet_next_step}`, dates && `Dates in play: ${dates}`].filter(Boolean);
  if (!parts.length) return "";
  return `\n\nWhere this deal stands (Mailflow's summary of ALL correspondence, including jayme@ emails and phone calls the stone@ thread doesn't show). Trust it over the thread when they differ:\n${parts.join("\n")}`;
}
