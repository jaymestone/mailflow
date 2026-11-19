import { describe, expect, it } from "vitest";
import { cityStateFromAddress, initialsMatch, parseMasterDate, placeLead, promoteLead, readBookings, withdrawLead, refreshNote, sameVenue, tableColumns, toWorkbook, type Lead } from "./plan";

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
    expect(writes[0].values[0]).toEqual(["Inquiry", "Musical Instrument Museum", "Phoenix", "AZ", "$5,900", "MIM wants Rakish. · next: Send hold"]);
    expect(writes[1].values[0][4]).toBe("");
  });

  it("sends the whole run to 'no date yet' when any day is taken", () => {
    const wb = workbook({ 4: [46390, "Confirmed", "CPAC"] });
    const { placement, writes } = placeLead({ ...base, wb, lead: lead({ dates: [{ start: "2027-01-02", end: "2027-01-03", kind: "offered", artist: null }] }) });
    expect(placement).toMatchObject({ kind: "undated", row: 14 });
    expect(String(writes[0].values[0][6])).toContain("taken: ");
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
    const wb = workbook({ ...bottom(), 3: [46389, "Confirmed", "Lied Center"] });
    expect(promoteLead({ ...base, wb, prior: undated(), lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "offered", artist: null }] }) })).toBeNull();
    expect(wb.grid[13][2]).toBe("Musical Instrument Museum");
  });
});

describe("placeLead and a menu of dates", () => {
  it("fills only the free days with a venue's alternative dates, marked as options (Falcon Bowl, Nov 14)", () => {
    const menu = ["2027-01-02", "2027-01-04", "2027-01-06", "2027-01-08"].map((start) => ({ start, end: null, kind: "offered", artist: null }));
    const wb = workbook({ 5: [46391, "Hold", "Grand Theater"] }); // Jan 4 taken
    const r = placeLead({ artist: "Rakish", bookings: [], today: "2026-11-06", wb, lead: lead({ dates: menu }) });
    expect(r.placement.kind).toBe("dated");
    expect(r.writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3", "'Rakish 2027 Workbook'!B7:G7", "'Rakish 2027 Workbook'!B9:G9"]);
    expect(String(r.writes[0].values[0][5])).toMatch(/1 of 4 dates/);
    expect(wb.grid[4][2]).toBe("Grand Theater");
  });
});

describe("placeLead and another venue's booking", () => {
  it("ignores a 'confirmed' date that is really the anchor booked elsewhere", () => {
    const bookings = readBookings([["Confirmed", "Rakish", "Jan 2, 2027", "Blue Waters", "", "", "Medical Lake, WA"]] as never);
    const r = placeLead({ artist: "Rakish", bookings, today: "2026-11-06", wb: workbook(), lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "confirmed", artist: null }] }) });
    expect(r.placement.kind).toBe("undated");
    expect(r.writes[0].values[0][6]).not.toMatch(/taken: /);
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

describe("Jayme's \"Fill in\" days", () => {
  it("are open days a lead can take", () => {
    const wb = workbook({ 3: [46389, "", "Fill in"] }); // Jan 2
    const res = placeLead({ artist: "Rakish", wb, lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "offered" }] }), bookings: [], today: "2026-11-10" });
    expect(res.placement.kind).toBe("dated");
    expect(res.writes[0].range).toBe("'Rakish 2027 Workbook'!B3:G3");
  });
});

describe("tableColumns", () => {
  it("lists every other venue on each day, and the ones that passed", () => {
    const wb = workbook({ 3: [46389, "Hold", "Muddy Creek"] }); // Jan 2
    const w = tableColumns(wb, [
      { venue: "Muddy Creek", start: "2027-01-02", end: null, kind: "hold", fee: null, off: false as const },
      { venue: "Surry Arts", start: "2027-01-02", end: "2027-01-03", kind: "asked_about", fee: null, off: false as const },
      { venue: "Folkmoot", start: "2027-01-02", end: null, kind: "offered", fee: 600, off: false as const },
      { venue: "Thomasville", start: "2027-01-03", end: null, kind: "asked_about", fee: null, off: "passed" as const },
      { venue: "All April", start: "2027-01-01", end: "2027-01-30", kind: "asked_about", fee: null, off: false as const },
    ]);
    expect(w.range).toBe("'Rakish 2027 Workbook'!K1:L11");
    expect(w.values[0]).toEqual(["On the table", "Off the table"]);
    expect(w.values[2]).toEqual(["Surry Arts (asked) · Folkmoot (open for them, $600)", ""]);
    expect(w.values[3]).toEqual(["Surry Arts (asked)", "Thomasville (passed)"]);
    expect(w.values[1]).toEqual(["", ""]);
  });
});

describe("relocateLead", () => {
  it("moves an untouched dated lead to the date the venue settled on", async () => {
    const { relocateLead } = await import("./plan");
    const note = "Yasmin asked Apr 1-3.";
    const wb = workbook({ 3: [46389, "Inquiry", "Kennedy Center", "", "", "", note], 4: [46390, "Inquiry", "Kennedy Center"] }); // Jan 2-3
    const prior = { artist: "Rakish", tab: wb.tab, row: 3, venue: "Kennedy Center", note, kind: "dated" as const };
    const res = relocateLead({ artist: "Rakish", wb, prior, lead: lead({ venue: "Kennedy Center", note: "Settled", nextStep: null, dates: [{ start: "2027-01-08", end: null, kind: "offered" }] }), bookings: [], today: "2026-11-14" });
    expect(res?.placement.kind).toBe("dated");
    expect(res!.writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3", "'Rakish 2027 Workbook'!B4:G4", "'Rakish 2027 Workbook'!B9:G9"]);
  });
  it("leaves rows Jayme edited alone", async () => {
    const { relocateLead } = await import("./plan");
    const wb = workbook({ 3: [46389, "Hold", "Kennedy Center", "", "", "", "Jayme's own note"] });
    const prior = { artist: "Rakish", tab: wb.tab, row: 3, venue: "Kennedy Center", note: "pipeline note", kind: "dated" as const };
    expect(relocateLead({ artist: "Rakish", wb, prior, lead: lead({ venue: "Kennedy Center", dates: [{ start: "2027-01-08", end: null, kind: "hold" }] }), bookings: [], today: "2026-11-14" })).toBeNull();
  });
});

// Jayme, Nov 19 2026: "Stop putting in interest and offers in the workbook on
// dates where the band is already booked or has their own show" (Little
// Mercies Apr 8 and Apr 10, where COCA and Folkmoot hid the own shows).
describe("days the band is already booked", () => {
  const own = (serial: number) => [serial, "", "", "", "", "", "", "Booked (own show)", "Elkton FL", "Gamble Rogers Fest"];
  it("never takes a lead onto an own-show day; the lead goes to 'no date yet' naming the show", () => {
    const wb = workbook({ 3: own(46389) }); // Jan 2
    const res = placeLead({ artist: "Rakish", wb, lead: lead({ dates: [{ start: "2027-01-02", end: null, kind: "offered" }] }), bookings: [], today: "2026-11-19" });
    expect(res.placement.kind).toBe("undated");
    expect(res.placement.kind === "undated" && res.placement.note).toMatch(/taken: /);
  });
  it("skips a Confirmed or Unavailable day in a menu of dates, filling the free ones", () => {
    const wb = workbook({ 3: [46389, "Confirmed", "Barre Opera House"], 4: [46390, "", "", "", "", "", "", "Unavailable"] }); // Jan 2-3
    const dates = ["2027-01-02", "2027-01-03", "2027-01-05", "2027-01-06"].map((start) => ({ start, end: null, kind: "offered" }));
    const res = placeLead({ artist: "Rakish", wb, lead: lead({ dates }), bookings: [], today: "2026-11-19" });
    expect(res.writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B6:G6", "'Rakish 2027 Workbook'!B7:G7"]);
  });
  it("leaves booked days out of 'On the table'", () => {
    const wb = workbook({ 3: own(46389) });
    const w = tableColumns(wb, [{ venue: "Folkmoot", start: "2027-01-02", end: "2027-01-03", kind: "offered", fee: 600, off: false as const }]);
    expect(w.values[2]).toEqual(["", ""]);
    expect(w.values[3]).toEqual(["Folkmoot (open for them, $600)", ""]);
  });
  it("moves an earlier placement off a day the artist later marked, keeping its other days (COCA)", async () => {
    const { evictBlocked } = await import("./plan");
    const note = "COCA menu";
    const wb = workbook({ 2: [46388, "Inquiry", "COCA", "", "", "", note], 3: [...own(46389)] });
    wb.grid[2][1] = "Inquiry"; wb.grid[2][2] = "COCA";
    const prior = { artist: "Rakish", tab: wb.tab, row: 2, venue: "COCA", note, kind: "dated" as const };
    const res = evictBlocked({ artist: "Rakish", wb, prior, lead: lead({ venue: "COCA" }), bookings: [], today: "2026-11-19" });
    expect(res!.writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3"]);
    expect(res!.placement).toMatchObject({ row: 2, kind: "dated" });
  });
  it("sends a lead with no day left to 'no date yet' (Folkmoot)", async () => {
    const { evictBlocked } = await import("./plan");
    const note = "Folkmoot offered";
    const wb = workbook({ 3: [...own(46389)] });
    wb.grid[2][1] = "Inquiry"; wb.grid[2][2] = "Folkmoot"; wb.grid[2][6] = note;
    const prior = { artist: "Rakish", tab: wb.tab, row: 3, venue: "Folkmoot", note, kind: "dated" as const };
    const res = evictBlocked({ artist: "Rakish", wb, prior, lead: lead({ venue: "Folkmoot", note, nextStep: null, dates: [{ start: "2027-01-02", end: null, kind: "offered" }] }), bookings: [], today: "2026-11-19" });
    expect(res!.placement.kind).toBe("undated");
    expect(res!.writes[0].range).toBe("'Rakish 2027 Workbook'!B3:G3");
    expect("note" in res!.placement && res!.placement.note).toMatch(/taken: /);
  });
  it("leaves a row Jayme put there himself", async () => {
    const { evictBlocked } = await import("./plan");
    const wb = workbook({ 3: [...own(46389)] });
    wb.grid[2][1] = "Hold"; wb.grid[2][2] = "Folkmoot"; wb.grid[2][6] = "Jayme's note";
    const prior = { artist: "Rakish", tab: wb.tab, row: 3, venue: "Folkmoot", note: "pipeline note", kind: "dated" as const };
    expect(evictBlocked({ artist: "Rakish", wb, prior, lead: lead({ venue: "Folkmoot" }), bookings: [], today: "2026-11-19" })).toBeNull();
  });
});

describe("relocateLead and a confirmed date", () => {
  it("moves an Inquiry to the confirmed day even while the earlier offer is still in the thread (Marigny, Nov 19)", async () => {
    const { relocateLead } = await import("./plan");
    const note = "Marigny offered Jan 2.";
    const wb = workbook({ 3: [46389, "Inquiry", "Marigny Opera House", "", "", "", note] }); // Jan 2
    const prior = { artist: "Rakish", tab: wb.tab, row: 3, venue: "Marigny Opera House", note, kind: "dated" as const };
    const dates = [{ start: "2027-01-06", end: null, kind: "confirmed" }, { start: "2027-01-02", end: null, kind: "offered" }];
    const res = relocateLead({ artist: "Rakish", wb, prior, lead: lead({ venue: "Marigny Opera House", note: "Confirmed Jan 6", nextStep: null, dates }), bookings: [], today: "2026-11-19" });
    expect(res!.writes.map((w) => w.range)).toEqual(["'Rakish 2027 Workbook'!B3:G3", "'Rakish 2027 Workbook'!B7:G7"]);
    expect(res!.writes[1].values[0][0]).toBe("Confirmed");
  });
});

describe("confirmStatus", () => {
  it("raises an untouched Inquiry to Confirmed on the confirmed day (Blue Strawberry, Nov 19)", async () => {
    const { confirmStatus } = await import("./plan");
    const note = "Blue Strawberry confirmed Jan 2.";
    const wb = workbook({ 3: [46389, "Inquiry", "Blue Strawberry", "", "", "", note] });
    const prior = { artist: "Rakish", tab: wb.tab, row: 3, venue: "Blue Strawberry", note, kind: "dated" as const };
    expect(confirmStatus({ artist: "Rakish", wb, prior, lead: lead({ venue: "Blue Strawberry", dates: [{ start: "2027-01-02", end: null, kind: "confirmed" }] }) })).toEqual([{ range: "'Rakish 2027 Workbook'!B3", values: [["Confirmed"]] }]);
    const edited = workbook({ 3: [46389, "Inquiry", "Blue Strawberry", "", "", "", "Jayme's note"] });
    expect(confirmStatus({ artist: "Rakish", wb: edited, prior, lead: lead({ venue: "Blue Strawberry", dates: [{ start: "2027-01-02", end: null, kind: "confirmed" }] }) })).toEqual([]);
  });
});

describe("tableDropdowns", () => {
  it("shows a count in K with each option listed in its dropdown", async () => {
    const { tableDropdowns } = await import("./plan");
    const w = { range: "'Rakish 2027 Workbook'!K1:L3", values: [["On the table", "Off the table"], ["", ""], ["Surry Arts (asked) · Folkmoot (open for them, $600)", "Thomasville (passed)"]] };
    const res = tableDropdowns(w, 7);
    expect(res.write.values[2]).toEqual(["2 options", "Thomasville (passed)"]);
    expect(res.write.values[1]).toEqual(["", ""]);
    expect(res.requests).toHaveLength(2);
    expect((res.requests[1] as any).setDataValidation.rule.condition.values.map((v: any) => v.userEnteredValue)).toEqual(["2 options", "Surry Arts (asked)", "Folkmoot (open for them, $600)"]);
  });
});

describe("dayChoices / venueDropdowns", () => {
  it("lists each competing venue with what the row would show, strongest first, in a Venue Name dropdown", async () => {
    const { dayChoices, venueDropdowns } = await import("./plan");
    const wb = workbook({ 3: [46389, "Inquiry", "Muddy Creek"], 4: [46390, "", "", "", "", "", "", "Booked (own show)", "Elkton FL", "Gamble Rogers Fest"] });
    const choices = dayChoices(wb, [
      { venue: "Surry Arts", start: "2027-01-02", end: null, kind: "asked_about", fee: null, off: false, city: "Mount Airy", state: "NC", note: "asked" },
      { venue: "Folkmoot", start: "2027-01-02", end: "2027-01-03", kind: "offered", fee: 600, off: false, city: "Waynesville", state: "NC", note: "Robin offered" },
      { venue: "Thomasville", start: "2027-01-02", end: null, kind: "offered", fee: 900, off: "passed" },
      { venue: "Muddy Creek", start: "2027-01-02", end: null, kind: "hold", fee: null, off: false },
    ]);
    expect(choices.get(3)).toEqual([
      { row: 3, venue: "Folkmoot", status: "Inquiry", city: "Waynesville", state: "NC", fee: "$600", note: "Robin offered" },
      { row: 3, venue: "Surry Arts", status: "Inquiry", city: "Mount Airy", state: "NC", fee: "", note: "asked" },
    ]);
    expect(choices.has(4)).toBe(false); // own show
    const reqs = venueDropdowns(wb, choices, 9) as any[];
    expect(reqs[0].setDataValidation.rule).toBeUndefined();
    expect(reqs[1].setDataValidation.rule.condition.values.map((v: any) => v.userEnteredValue)).toEqual(["Muddy Creek", "Folkmoot", "Surry Arts"]);
  });
});

describe("repairSwitchedRows", () => {
  const entries = [
    { venue: "Folkmoot", start: "2027-01-02", end: null, kind: "offered", fee: 600, off: false as const, city: "Waynesville", state: "NC", note: "$600 offer" },
    { venue: "Surry Arts", start: "2027-01-02", end: null, kind: "hold", fee: null, off: false as const, city: "Mount Airy", state: "NC", note: "No fee yet" },
  ];
  it("refills a row whose venue shows another option's city (a half-done switch)", async () => {
    const { repairSwitchedRows } = await import("./plan");
    const wb = workbook({ 3: [46389, "Inquiry", "Surry Arts", "Waynesville", "NC", "$600", "$600 offer"] });
    const w = repairSwitchedRows(wb, entries);
    expect(w).toEqual([
      { range: "'Rakish 2027 Workbook'!B3", values: [["Hold"]] },
      { range: "'Rakish 2027 Workbook'!D3:G3", values: [["Mount Airy", "NC", "", "No fee yet"]] },
    ]);
  });
  it("leaves rows that match, or whose city is nobody else's (his own correction)", async () => {
    const { repairSwitchedRows } = await import("./plan");
    expect(repairSwitchedRows(workbook({ 3: [46389, "Inquiry", "Folkmoot", "Waynesville", "NC"] }), entries)).toEqual([]);
    expect(repairSwitchedRows(workbook({ 3: [46389, "Inquiry", "Folkmoot", "Asheville", "NC"] }), entries)).toEqual([]);
  });
});
