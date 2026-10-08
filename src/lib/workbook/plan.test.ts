import { describe, expect, it } from "vitest";
import { initialsMatch, parseMasterDate, placeLead, readBookings, refreshNote, sameVenue, toWorkbook, type Lead } from "./plan";

/** A 2027 workbook in miniature: header, Jan 1-10 as date serials, then the
 * "no date yet" header at the row after. */
function workbook(extra: Record<number, unknown[]> = {}) {
  const jan1 = 46388; // 2027-01-01
  const grid: unknown[][] = [["Date", "Status", "Venue Name", "City", "State", "Artist Fee", "Notes"]];
  for (let i = 0; i < 10; i++) grid.push([jan1 + i]);
  grid.push(["INTERESTED VENUES — NO DATE YET"], ["Target Window", "Status", "Venue Name"]);
  for (const [row, values] of Object.entries(extra)) grid[Number(row) - 1] = values;
  return toWorkbook("Rakish 2027 Workbook", grid as never);
}

const lead = (over: Partial<Lead> = {}): Lead => ({
  venue: "Musical Instrument Museum",
  city: "Phoenix",
  state: "AZ",
  fee: 5900,
  artists: ["Rakish"],
  dates: [],
  window: null,
  interest: "artist_no_date",
  routingArea: null,
  note: "MIM wants Rakish.",
  nextStep: "Send hold",
  ...over,
});

describe("sameVenue / initialsMatch", () => {
  it("treats one name containing the other as the same venue", () => {
    expect(sameVenue("Roxbury Arts Group", "Roxbury Arts Group (Fiddlers festival)")).toBe(true);
    expect(sameVenue("Pickin Productions", "Pickin’ Productions")).toBe(true);
    expect(sameVenue("Grand Theatre", "Lied Center")).toBe(false);
  });

  it("matches an all-caps short name to its initials", () => {
    expect(initialsMatch("CPAC", "Community Performance Center")).toBe(true);
    expect(initialsMatch("Burr Oak", "T Presents")).toBe(false);
  });
});

describe("parseMasterDate", () => {
  it("reads Master's date shapes", () => {
    expect(parseMasterDate("Mar 17, 2027")).toEqual(["2027-03-17", "2027-03-17"]);
    expect(parseMasterDate("Aug 7-8, 2027")).toEqual(["2027-08-07", "2027-08-08"]);
    expect(parseMasterDate("Sept 12, 2027")).toEqual(["2027-09-12", "2027-09-12"]);
    expect(parseMasterDate("July 30-Aug 2, 2027")).toEqual(["2027-07-30", "2027-08-02"]);
    expect(parseMasterDate("TBD")).toBeNull();
  });
});

describe("placeLead", () => {
  const base = { artist: "Rakish", bookings: [], today: "2026-10-08" };

  it("puts a dated lead on its free day rows, fee and note on the first", () => {
    const wb = workbook();
    const { placement, writes } = placeLead({ ...base, wb, lead: lead({ dates: [{ start: "2027-01-02", end: "2027-01-03", kind: "offered", artist: null }] }) });
    expect(placement).toMatchObject({ kind: "dated", row: 3 });
    expect(writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3", "'Rakish 2027 Workbook'!B4:G4"]);
    expect(writes[0].values[0]).toEqual(["Inquiry", "Musical Instrument Museum", "Phoenix", "AZ", "$5,900", "MIM wants Rakish. Next: Send hold"]);
    expect(writes[1].values[0][4]).toBe("");
  });

  it("sends the whole run to 'no date yet' when any day is taken", () => {
    const wb = workbook({ 4: [46390, "Confirmed", "CPAC"] });
    const { placement, writes } = placeLead({ ...base, wb, lead: lead({ dates: [{ start: "2027-01-02", end: "2027-01-03", kind: "offered", artist: null }] }) });
    expect(placement).toMatchObject({ kind: "undated", row: 14 });
    expect(String(writes[0].values[0][6])).toContain("already taken");
  });

  it("ignores a date the thread ties to another artist", () => {
    const wb = workbook();
    const { placement } = placeLead({ ...base, wb, lead: lead({ artists: ["Rakish", "Samir Langus"], dates: [{ start: "2027-01-05", end: null, kind: "offered", artist: "Samir Langus" }] }) });
    expect(placement.kind).toBe("undated");
  });

  it("leaves the fee off a lead shared by two artists", () => {
    const wb = workbook();
    const { writes } = placeLead({ ...base, wb, lead: lead({ artists: ["Rakish", "Samir Langus"] }) });
    expect(writes[0].values[0][5]).toBe("");
  });

  it("never re-adds a venue already on the sheet", () => {
    const wb = workbook({ 5: [46391, "Hold", "Musical Instrument Museum (Phoenix)"] });
    expect(placeLead({ ...base, wb, lead: lead() })).toEqual({ placement: { artist: "Rakish", kind: "exists", venue: "Musical Instrument Museum" }, writes: [] });
  });

  it("skips a stale lead for a venue already booked in Master (CPAC)", () => {
    const bookings = readBookings([["Confirmed", "Rakish", "Mar 17, 2027", "CPAC", "$3,000", "$450", "Green Valley, AZ"]]);
    const r = placeLead({ ...base, bookings, wb: workbook(), lead: lead({ venue: "Community Performance Center", city: "Green Valley", state: "AZ" }) });
    expect(r.placement.kind).toBe("booked");
  });

  it("keeps a return-booking lead for a booked venue, with the booking noted", () => {
    const bookings = readBookings([["Confirmed", "Rakish", "Mar 17, 2027", "CPAC", "$3,000", "$450", "Green Valley, AZ"]]);
    const r = placeLead({ ...base, bookings, wb: workbook(), lead: lead({ venue: "CPAC", city: "Green Valley", state: "AZ", window: "2028 season" }) });
    expect(r.placement.kind).toBe("undated");
    expect(String(r.writes[0].values[0][6])).toMatch(/^Booked: CPAC Mar 17, 2027/);
  });
});

describe("refreshNote", () => {
  it("updates a note it wrote, and leaves one Jayme edited", () => {
    const wb = workbook({ 3: [46389, "Inquiry", "MIM", "", "", "", "old note"] });
    const p = { artist: "Rakish", tab: wb.tab, row: 3, venue: "MIM", note: "old note", kind: "dated" as const };
    expect(refreshNote(wb, p, "new note")).toEqual({ range: "'Rakish 2027 Workbook'!G3", values: [["new note"]] });

    const edited = workbook({ 3: [46389, "Inquiry", "MIM", "", "", "", "Jayme's own words"] });
    expect(refreshNote(edited, p, "new note")).toBeNull();
  });
});
