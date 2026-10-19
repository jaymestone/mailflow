import { describe, expect, it } from "vitest";
import { findPuzzles, stopsNear, type PuzzleLead, type Stop } from "./clusters";

const TAMPA = { lat: 27.95, lng: -82.46 };
const ORLANDO = { lat: 28.54, lng: -81.38 };
const SARASOTA = { lat: 27.34, lng: -82.53 };
const DENVER = { lat: 39.74, lng: -104.99 };
const lead = (id: string, coord: typeof TAMPA, o: Partial<PuzzleLead> = {}): PuzzleLead => ({ id, venue: `V${id}`, city: "X", state: "FL", coord, interest: "if_routing", artists: [], window: null, fee: null, ...o });

describe("findPuzzles", () => {
  const fl = [lead("1", TAMPA), lead("2", ORLANDO), lead("3", SARASOTA), lead("4", TAMPA, { interest: "talk_later" })];
  it("groups nearby 'in the area' venues and ignores weak interest", () => {
    const p = findPuzzles([...fl, lead("5", DENVER, { state: "CO" })], [], "2026-10-18");
    expect(p).toHaveLength(1);
    expect(p[0].venues.map((v) => v.id).sort()).toEqual(["1", "2", "3"]);
    expect(p[0].move).toMatch(/no anchor yet/);
  });
  it("uses a nearby future date as the anchor", () => {
    const stops: Stop[] = [
      { artist: "Lily Henley", start: "2027-03-05", end: "2027-03-05", venue: "Straz", city: "Tampa", state: "FL", status: "Confirmed", coord: TAMPA },
      { artist: "Lily Henley", start: "2026-01-01", end: "2026-01-01", venue: "Old", city: "Tampa", state: "FL", status: "Confirmed", coord: TAMPA },
    ];
    const p = findPuzzles(fl, stops, "2026-10-18");
    expect(p[0].anchors).toHaveLength(1);
    expect(p[0].move).toMatch(/Lily Henley around Straz/);
  });
  it("suggests an anchor ask when one artist is wanted twice", () => {
    const p = findPuzzles([lead("1", TAMPA, { artists: ["Rakish"], fee: 3000 }), lead("2", ORLANDO, { artists: ["Rakish"] }), lead("3", SARASOTA)], [], "2026-10-18");
    expect(p[0].move).toMatch(/2 want Rakish.*Ask V1/);
  });
});

describe("stopsNear", () => {
  it("lists future stops within range", () => {
    const s: Stop[] = [{ artist: "A", start: "2027-01-01", end: "2027-01-02", venue: "X", city: "Orlando", state: "FL", status: "Hold", coord: ORLANDO }];
    expect(stopsNear(s, TAMPA, "2026-10-18")).toHaveLength(1);
    expect(stopsNear(s, DENVER, "2026-10-18")).toHaveLength(0);
  });
});
