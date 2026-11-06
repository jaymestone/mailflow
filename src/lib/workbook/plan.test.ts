import { describe, expect, it } from "vitest";
import { cityStateFromAddress, initialsMatch, parseMasterDate, placeLead, promoteLead, readBookings, withdrawLead, refreshNote, sameVenue, toWorkbook, type Lead } from "./plan";

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

describe("cityStateFromAddress", () => {
  it("reads both Jayme's and Contract Engine's address forms", () => {
    expect(cityStateFromAddress("Medical Lake, WA")).toEqual({ city: "Medical Lake", state: "WA" });
    expect(cityStateFromAddress("12 Main St, Mars Hill, North Carolina 28754")).toEqual({ city: "Mars Hill", state: "NC" });
    expect(cityStateFromAddress("218 Franklin Ave, Nashville, TN 37206")).toEqual({ city: "Nashville", state: "TN" });
    expect(cityStateFromAddress("Goderich, ON, Canada")).toEqual({ city: "Goderich", state: "ON" });
  });
});

describe("toWorkbook", () => {
  it("treats only the rows above the no-date section as the calendar", () => {
    const wb = workbook({ 14: [45126, "Prospective", "Somewhere"] }); // 2023-07-19, in "no date yet"
    expect(wb.rowOfIso.has("2023-07-19")).toBe(false);
    expect(wb.rowOfIso.get("2027-01-01")).toBe(2);
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

  it("marks an interested venue with no date as Inquiry, never Prospective", () => {
    const { writes } = placeLead({ ...base, wb: workbook(), lead: lead() });
    expect(writes[0].values[0][1]).toBe("Inquiry");
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

describe("promoteLead", () => {
  const base = { artist: "Rakish", bookings: [], today: "2026-11-06" };
  // Row 14 is the first "no date yet" row (header row 13).
  const undated = (note = "MIM wants Rakish.") => ({ artist: "Rakish", tab: "Rakish 2027 Workbook", row: 14, venue: "Musical Instrument Museum", note, kind: "undated" as const });
  const bottom = (note = "MIM wants Rakish.") => ({ 14: ["No date yet", "Inquiry", "Musical Instrument Museum", "Phoenix", "AZ", "", note] });

  it("moves a bottom-row lead onto its days once an offer arrives, and clears the old row", () => {
    const wb = workbook(bottom());
    const r = promoteLead({ ...base, wb, prior: undated(), lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "hold", artist: null }] }) })!;
    expect(r.placement).toMatchObject({ kind: "dated", row: 3 });
    expect(r.writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3", "'Rakish 2027 Workbook'!A14:G14"]);
    expect(r.writes[0].values[0][0]).toBe("Hold");
  });

  it("leaves a row Jayme edited, a long open window, and taken days alone", () => {
    expect(promoteLead({ ...base, wb: workbook(bottom("his own words")), prior: undated(), lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "hold", artist: null }] }) })).toBeNull();
    expect(promoteLead({ ...base, wb: workbook(bottom()), prior: undated(), lead: lead({ dates: [{ start: "2027-01-02", end: "2027-01-09", kind: "offered", artist: null }] }) })).toBeNull();
    const menu = ["2027-01-02", "2027-01-04", "2027-01-06", "2027-01-08"].map((start) => ({ start, end: null, kind: "offered", artist: null }));
    expect(promoteLead({ ...base, wb: workbook(bottom()), prior: undated(), lead: lead({ dates: menu }) })).toBeNull();
    const wb = workbook({ ...bottom(), 3: [46389, "Confirmed", "Lied Center"] });
    expect(promoteLead({ ...base, wb, prior: undated(), lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "offered", artist: null }] }) })).toBeNull();
    expect(wb.grid[13][2]).toBe("Musical Instrument Museum");
  });
});

describe("placeLead and a menu of dates", () => {
  it("keeps a venue offering four or more alternative dates in 'no date yet'", () => {
    const menu = ["2027-01-02", "2027-01-04", "2027-01-06", "2027-01-08"].map((start) => ({ start, end: null, kind: "offered", artist: null }));
    const r = placeLead({ artist: "Rakish", bookings: [], today: "2026-11-06", wb: workbook(), lead: lead({ dates: menu }) });
    expect(r.placement.kind).toBe("undated");
    expect(r.writes).toHaveLength(1);
  });
});

describe("placeLead and another venue's booking", () => {
  it("ignores a 'confirmed' date that is really the anchor booked elsewhere", () => {
    const bookings = readBookings([["Confirmed", "Rakish", "Jan 2, 2027", "Blue Waters", "", "", "Medical Lake, WA"]] as never);
    const r = placeLead({ artist: "Rakish", bookings, today: "2026-11-06", wb: workbook(), lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "confirmed", artist: null }] }) });
    expect(r.placement.kind).toBe("undated");
    expect(r.writes[0].values[0][6]).not.toMatch(/already taken/);
  });
});

describe("withdrawLead", () => {
  it("clears every day row of a passed venue, but not a row Jayme edited", () => {
    const note = "Lake City wants Jan 2 or 4.";
    const wb = workbook({ 3: [46389, "Inquiry", "Lake City Arts", "Lake City", "CO", "", note], 5: [46391, "Inquiry", "Lake City Arts", "Lake City", "CO", "", ""] });
    const w = withdrawLead(wb, { artist: "Rakish", tab: "Rakish 2027 Workbook", row: 3, venue: "Lake City Arts", note, kind: "dated" });
    expect(w.map((x) => x.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3", "'Rakish 2027 Workbook'!B5:G5"]);
    const edited = workbook({ 3: [46389, "Hold", "Lake City Arts", "", "", "", "Jayme: still talking"] });
    expect(withdrawLead(edited, { artist: "Rakish", tab: "Rakish 2027 Workbook", row: 3, venue: "Lake City Arts", note, kind: "dated" })).toEqual([]);
  });
});
