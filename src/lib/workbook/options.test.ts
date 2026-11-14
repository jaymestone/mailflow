import { describe, expect, it } from "vitest";
import { dateOptions, optionsBlock } from "./options";
import { toWorkbook } from "./plan";

function workbook(extra: Record<number, unknown[]> = {}) {
  const jan1 = 46388; // 2027-01-01
  const grid: unknown[][] = [["Date", "Status", "Venue Name", "City", "State", "Artist Fee", "Notes", "Avail", "Where", "Artist notes"]];
  for (let i = 0; i < 10; i++) grid.push([jan1 + i]);
  for (const [row, values] of Object.entries(extra)) grid[Number(row) - 1] = values;
  return toWorkbook("Rakish 2027 Workbook", grid as never);
}
const item = (over = {}) => ({ venue: "Falcon Bowl", city: "Milwaukee", state: "WI", fee: 500, kind: "offered", start: "2027-01-02", end: null, note: "Ben offered", next: "Reply", last: "2026-11-13", link: "", off: false as const, ...over });

describe("dateOptions", () => {
  it("lists every venue on a date, firmest first, without duplicating the day-row venue", () => {
    const wb = workbook({ 3: [46389, "Hold", "Grand Theater", "Wausau", "WI", "", "note"] }); // Jan 2
    const rows = dateOptions({
      artist: "Rakish", wb, bookings: [], today: "2026-11-14",
      items: [item(), item({ venue: "Grand Theater", kind: "offered" }), item({ venue: "Cedar", kind: "asked_about" }), item({ venue: "Lopez", kind: "declined" })],
    });
    expect(rows.map((r) => [r.venue, r.status])).toEqual([["Grand Theater", "Hold"], ["Falcon Bowl", "Offer / open for them"], ["Cedar", "Asked"], ["Lopez", "Passed"]]);
  });
  it("includes the artist's own shows and skips past dates and long windows", () => {
    const wb = workbook({ 4: [46390, "", "", "", "", "", "", "Booked (own show)", "Chicago IL", "Residency"] }); // Jan 3
    const rows = dateOptions({ artist: "Rakish", wb, bookings: [], today: "2027-01-02", items: [item({ start: "2027-01-01" }), item({ venue: "Season", kind: "offered", start: "2027-01-01", end: "2027-01-30" })] });
    expect(rows.map((r) => [r.iso, r.venue, r.status])).toEqual([["2027-01-03", "Residency", "Booked (own show)"]]);
  });
  it("shows only dates with a live option", () => {
    const wb = workbook();
    const rows = dateOptions({ artist: "Rakish", wb, bookings: [], today: "2026-11-14", items: [item({ kind: "declined", venue: "Lopez" }), item({ start: "2027-01-05" })] });
    const { values, kinds } = optionsBlock("Rakish", rows);
    expect(values[0]).toEqual(["RAKISH"]);
    expect(String(values[1][0])).toMatch(/Jan 5, 2027 {2}· {2}1 in play/);
    expect(kinds).toEqual(["artist", "date", "live", "off"]);
  });
});
